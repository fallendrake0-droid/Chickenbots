'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { createCommandHandler } = require('../src/commands');
const { TEAM_COMBAT_MODES, TeamCombatCoordinator } = require('../src/combat/team');
const { TARGET_MODES } = require('../src/combat/players');
const { ROLES: WOODCUTTING_ROLES } = require('../src/actions/woodcutting');
const { SURVIVAL_FEATURES } = require('../src/actions/survival');
const { FORMATIONS } = require('../src/team/formations');
const { createRuntime } = require('../src/runtime');
const { createDashboard } = require('../src/dashboard/server');
const { normalizeMineTarget, isMineableTarget } = require('../src/actions/miningCatalog');

function handler() {
  return createCommandHandler({});
}

test('every registered command has an enforced argument schema and semantics', () => {
  const commands = handler();
  const list = commands.list();
  assert.equal(list.length, 49, 'the command surface changed; update the metadata table and this count together');
  for (const command of list) {
    assert.ok(Array.isArray(command.args), `${command.name}: args must be an array`);
    assert.deepEqual(command.argumentSchema, command.args, `${command.name}: argumentSchema must alias args`);
    assert.ok(['none', 'bot', 'fleet', 'botOrFleet'].includes(command.scope), `${command.name}: invalid scope`);
    assert.equal(typeof command.readOnly, 'boolean', `${command.name}: readOnly flag missing`);
    assert.equal(typeof command.mutates, 'boolean', `${command.name}: mutates flag missing`);
    assert.equal(typeof command.cancellable, 'boolean', `${command.name}: cancellable flag missing`);
    assert.ok(['never', 'conditional', 'always'].includes(command.confirmation), `${command.name}: invalid confirmation policy`);
    assert.ok(command.page === null || typeof command.page === 'string', `${command.name}: invalid page owner`);
    const positions = command.args.map((entry) => entry.position);
    assert.equal(new Set(positions).size, positions.length, `${command.name}: duplicate argument position`);
    const subNames = command.subcommands.map((entry) => (typeof entry === 'string' ? entry : entry.name));
    assert.equal(new Set(subNames).size, subNames.length, `${command.name}: duplicate subcommand metadata`);
    for (const entry of command.subcommands) {
      if (typeof entry === 'string') continue;
      const subPositions = (entry.args || []).map((arg) => arg.position);
      assert.equal(new Set(subPositions).size, subPositions.length, `${command.name} ${entry.name}: duplicate argument position`);
    }
    if (command.mutates) assert.equal(command.readOnly, false, `${command.name}: a mutating command cannot be read-only`);
  }
});

test('mining metadata is the single source for grammar, targets and safety limits', () => {
  const commands = handler();
  const mine = commands.list().find((entry) => entry.name === 'mine');
  assert.ok(mine, 'mine must be registered');
  assert.equal(mine.targetSource, 'miningCatalog');
  assert.equal(mine.page, 'mining');
  assert.ok(mine.cancellable, 'mining must be cancellable');
  const variants = Object.fromEntries(mine.variants.map((entry) => [entry.name, entry]));
  for (const name of ['leader-default', 'bot-target', 'fleet-target', 'stop-bot', 'stop-fleet']) {
    assert.ok(variants[name], `missing mine variant ${name}`);
  }
  assert.deepEqual(variants['bot-target'].args.map((entry) => entry.type), ['botOrFleet', 'mineTarget']);
  assert.deepEqual(variants['stop-bot'].args.map((entry) => entry.type), ['botOrFleet', 'enum']);
  const catalogue = commands.targets();
  assert.equal(catalogue.source, 'src/actions/miningCatalog.js');
  assert.equal(catalogue.ores.length, 10);
  assert.ok(catalogue.blocks.length >= 40);
  assert.equal(catalogue.choices.length, catalogue.ores.length + catalogue.blocks.length);
  const ids = new Set();
  for (const choice of catalogue.choices) {
    assert.ok(choice.id && !ids.has(choice.id), `duplicate target id ${choice.id}`);
    ids.add(choice.id);
    assert.ok(normalizeMineTarget(choice.id), `${choice.id}: does not normalise`);
    assert.equal(isMineableTarget(choice.id), true, `${choice.id}: catalogue advertises an unmineable target`);
    assert.ok(Number.isInteger(choice.tier) && choice.tier >= 0 && choice.tier <= 4, `${choice.id}: invalid pickaxe tier`);
  }
  assert.ok(catalogue.choices.some((entry) => entry.id === 'diamond' && entry.target === 'diamond_ore'));
  assert.ok(catalogue.choices.some((entry) => entry.id === 'debris' && entry.target === 'ancient_debris'));
});

test('builder assignment keeps the role grammar and exposes phase as an explicit flag', () => {
  const builder = handler().list().find((entry) => entry.name === 'builder');
  const assign = builder.subcommands.find((entry) => entry.name === 'assign');
  assert.deepEqual(assign.args.map((entry) => entry.position), [0, 1, 2]);
  assert.equal(assign.args[0].type, 'botOrFleet');
  assert.equal(assign.args[1].name, 'role');
  assert.equal(assign.args[2].name, 'phase');
  assert.equal(assign.args[2].flag, '--phase');
  assert.ok(builder.usage.includes('--phase'), 'usage must advertise the phase flag');
});

test('combat and PvP mode enums come from the backend controllers, not the page', () => {
  const commands = handler();
  const combat = commands.list().find((entry) => entry.name === 'combat');
  const combatModes = combat.subcommands.find((entry) => entry.name === 'mode').args[0].values;
  assert.deepEqual(combatModes, [...TEAM_COMBAT_MODES]);
  assert.ok(combatModes.includes('BOSS'), 'BOSS is accepted by the coordinator and must be advertised');
  assert.ok(combatModes.includes('FOLLOW'), 'FOLLOW is accepted by the coordinator and must be advertised');
  const coordinator = new TeamCombatCoordinator();
  for (const mode of combatModes) assert.equal(coordinator.setMode(mode).ok, true, `${mode} must be accepted by setMode`);
  const woodcutting = commands.list().find((entry) => entry.name === 'woodcutting');
  assert.deepEqual(woodcutting.values.role, [...WOODCUTTING_ROLES], 'woodcutting roles come from the action module');
  const survival = commands.list().find((entry) => entry.name === 'survival');
  assert.deepEqual(survival.values.feature, [...SURVIVAL_FEATURES], 'survival routines come from the action module');
  assert.deepEqual(survival.args[1].values, [...SURVIVAL_FEATURES], 'the survival feature enum is the same list');
  const team = commands.list().find((entry) => entry.name === 'team');
  const formations = team.subcommands.find((entry) => entry.name === 'formation').args[0].values;
  assert.deepEqual(formations, Object.keys(FORMATIONS), 'team formations come from the coordinator');
  const players = commands.list().find((entry) => entry.name === 'players');
  const targetModes = players.subcommands.find((entry) => entry.name === 'mode').args[0].values;
  assert.deepEqual(targetModes, [...TARGET_MODES]);
});

test('structured invocation serialises exactly like the tokenizer reads it', async () => {
  const commands = handler();
  assert.equal(commands.serialize('mine', ['10101000', 'diamonds']), 'mine 10101000 diamonds');
  assert.equal(commands.serialize('mine', ['10101000', 'a target']), 'mine 10101000 "a target"');
  assert.equal(commands.serialize('state', []), 'status', 'aliases resolve to the canonical command');
  assert.throws(() => commands.serialize('mine', ['iron; rm -rf /']), /illegal characters/);
  assert.throws(() => commands.serialize('mine', ['"quoted"']), /double quote/);
  assert.throws(() => commands.serialize('launch', []), /unknown command/);
  const invalid = commands.validate('mine', 'diamonds');
  assert.equal(invalid.ok, false, 'a non-array argument list must be rejected');
  const accepted = commands.validate('mine', ['10101000', 'diamonds']);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.command, 'mine');
});

test('structured execution reaches the same handler as the CLI line', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const line = await runtime.executeCommand('status', { source: 'dashboard' });
    const structured = await runtime.services.commands.executeStructured({ name: 'status', args: [], source: 'dashboard' });
    assert.equal(structured.ok, true);
    assert.equal(structured.result.ok, line.result.ok);
    assert.equal(structured.line, line.line);
    const unknown = await runtime.services.commands.executeStructured({ name: 'launch', args: [], source: 'dashboard' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.result.code, 'UNKNOWN_COMMAND');
    assert.throws(() => runtime.services.commands.serialize('status', ['x;sh']), /illegal characters/,
      'serialize must throw rather than invent a line');
    const injection = await runtime.services.commands.executeStructured({ name: 'status', args: ['x;sh'], source: 'dashboard' });
    assert.equal(injection.ok, false, 'structured execution must reject the same forbidden argument');
    assert.equal(injection.result.code, 'ARGS');
  } finally {
    await runtime.shutdown('test');
  }
});

test('mining stop is scoped exactly as the selector says', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const statuses = () => Object.fromEntries(runtime.actions.list().map((actions) => [actions.bot.name, Boolean(actions.mining.status().stopped)]));
    const before = statuses();
    assert.ok(before['10101000'] !== true, 'the test bot must start active');
    const one = await runtime.services.commands.executeStructured({ name: 'mine', args: ['10101000', 'stop'], source: 'dashboard' });
    assert.equal(one.ok, true);
    assert.equal(one.line, 'mine 10101000 stop');
    const afterOne = statuses();
    assert.equal(afterOne['10101000'], true, 'the named bot must be stopped');
    for (const [name, stopped] of Object.entries(before)) {
      if (name !== '10101000') assert.equal(afterOne[name], stopped, `${name} must not be stopped by a per-bot command`);
    }
    const all = await runtime.services.commands.executeStructured({ name: 'mine', args: ['stop'], source: 'dashboard' });
    assert.equal(all.ok, true);
    assert.equal(all.line, 'mine stop');
    const afterAll = statuses();
    for (const name of Object.keys(afterAll)) assert.equal(afterAll[name], true, `${name} must be stopped by fleet stop`);
  } finally {
    await runtime.shutdown('test');
  }
});

function request(port, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('the dashboard API exposes metadata and only executes validated structured commands', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  const dash = createDashboard(runtime.services, { port: 0, host: '127.0.0.1' });
  try {
    const started = await dash.start();
    const port = started.port;
    const catalogue = await request(port, '/api/commands');
    assert.equal(catalogue.status, 200);
    assert.equal(catalogue.body.ok, true);
    assert.equal(catalogue.body.commands.length, 49);
    const mine = catalogue.body.commands.find((entry) => entry.name === 'mine');
    assert.ok(mine.args.length >= 1);
    assert.ok(mine.variants.length >= 5);
    assert.equal(catalogue.body.targets.source, 'src/actions/miningCatalog.js');
    assert.equal(catalogue.body.targets.choices.length, catalogue.body.targets.ores.length + catalogue.body.targets.blocks.length);
    const targets = await request(port, '/api/commands/targets');
    assert.equal(targets.status, 200);
    assert.ok(targets.body.choices.some((entry) => entry.id === 'diamond'));

    const structured = await request(port, '/api/command', 'POST', { name: 'status', args: [] });
    assert.equal(structured.status, 200);
    assert.equal(structured.body.ok, true);
    assert.equal(structured.body.line, 'status');
    assert.equal(structured.body.result.ok, true);

    const raw = await request(port, '/api/command', 'POST', { line: 'status', confirm: false });
    assert.equal(raw.status, 200);
    assert.equal(raw.body.result.ok, true);

    const badArgs = await request(port, '/api/command', 'POST', { name: 'mine', args: 'diamonds' });
    assert.equal(badArgs.status, 400);
    assert.equal(badArgs.body.code, 'ARGS');
    const unknown = await request(port, '/api/command', 'POST', { name: 'launch', args: [] });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'UNKNOWN_COMMAND');
    const injection = await request(port, '/api/command', 'POST', { name: 'status', args: ['x;sh'] });
    assert.equal(injection.status, 400);
    assert.equal(injection.body.code, 'ARGS');
    const empty = await request(port, '/api/command', 'POST', {});
    assert.equal(empty.status, 400);
  } finally {
    await dash.stop();
    await runtime.shutdown('test');
  }
});

test('the build action endpoint cannot bypass destructive confirmation', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  const dash = createDashboard(runtime.services, { port: 0, host: '127.0.0.1' });
  try {
    const design = runtime.library.list({ limit: 1 })[0];
    const materials = runtime.library.build(design.id).materials;
    for (const bot of runtime.bots.values()) {
      for (const [item, count] of Object.entries(materials)) bot.addItem(item, count);
    }
    const started = await runtime.executeCommand(`build ${design.id} 80 72 80 confirm`, { source: 'dashboard', confirmed: true });
    assert.equal(started.result.ok, true, started.result.error);
    const buildId = started.result.buildId;
    assert.ok(buildId, 'the build must be registered before its controls can target it');

    const server = await dash.start();
    const rejected = await request(server.port, `/api/builds/${encodeURIComponent(buildId)}/action`, 'POST', { action: 'cancel' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'CONFIRMATION_REQUIRED');
    assert.equal(rejected.body.requiresConfirmation, true);

    const accepted = await request(server.port, `/api/builds/${encodeURIComponent(buildId)}/action`, 'POST', { action: 'cancel', confirm: true });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.ok, true);
    assert.equal(accepted.body.status.state, 'CANCELLED');
  } finally {
    await dash.stop();
    await runtime.shutdown('test');
  }
});
