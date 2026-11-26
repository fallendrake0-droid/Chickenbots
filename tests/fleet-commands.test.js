'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntime } = require('../src/runtime');
const { RealBot } = require('../src/bot/realBot');
const { connectionStatus } = require('../src/bot/status');
const { config } = require('../src/config');

test('automatic /login and /register are never sent, even with credentials configured', async () => {
  const commands = [];
  const fake = {
    entity: {},
    chat(line) { commands.push(line); },
    clearControlStates() {},
    quit() {}
  };
  const real = new RealBot({ name: '________', createBot: () => fake, loginPassword: 'secret', registerPassword: 'secret', registerOnFirstJoin: true });
  real.bot = fake;
  real.connected = true;
  real.spawned = true;

  assert.equal(real.authCommandsEnabled, false);
  assert.equal(real.passwordRequired, false);
  const handled = await real._handleLoginCommands();
  assert.equal(handled.ok, true);
  assert.equal(handled.mode, 'disabled');
  assert.deepEqual(commands, [], 'no password command may be sent on startup/spawn');

  const direct = await real._sendAuthCommand('/login secret', 'login');
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'AUTH_DISABLED');
  assert.deepEqual(commands, [], 'there is no hidden sender behind _handleLoginCommands');
  assert.equal(connectionStatus(real).online, true);
  assert.equal(connectionStatus(real).gameplayReady, true);
  await real.disconnect('test');
});

test('a server manual-auth prompt keeps the session online but blocks gameplay', async () => {
  const commands = [];
  const fake = { entity: {}, chat(line) { commands.push(line); }, clearControlStates() {}, quit() {} };
  const real = new RealBot({ name: '10101000', createBot: () => fake, loginPassword: 'secret' });
  real.bot = fake;
  real.connected = true;
  real.spawned = true;
  await real._handleLoginCommands();
  real._ingestChatText('Please login with /login before playing', 'test');

  const status = connectionStatus(real);
  assert.equal(real.authRequiredManual, true);
  assert.equal(status.online, true, 'the server still has this player');
  assert.equal(status.gameplayReady, false, 'gameplay is blocked until an operator resolves auth');
  assert.equal(status.status, 'auth_required_manual');
  assert.deepEqual(commands, [], 'recording a prompt must not send /login');
  await real.disconnect('test');
});

test('configuration refuses any attempt to re-enable automatic auth', () => {
  const broken = JSON.parse(JSON.stringify(config));
  broken.server.authEnabled = true;
  broken.server.authCommandsEnabled = true;
  const { validateConfig } = require('../src/config');
  const result = validateConfig(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /authCommandsEnabled/.test(error)));
});

test('one command fans out the same real action to the whole fleet with per-bot results', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const status = await runtime.commands.execute('bot all status', { source: 'internal' });
    assert.equal(status.result.ok, true);
    assert.equal(status.result.count, config.team.names.length);
    assert.equal(status.result.bots.length, config.team.names.length);
    assert.equal(status.result.online, config.team.names.length);
    assert.equal(status.result.ready, config.team.names.length);
    assert.ok(status.result.results.every((row) => row.ok === true && row.online === true));

    const eat = await runtime.commands.execute('eat all', { source: 'internal' });
    assert.equal(eat.result.ok, true, JSON.stringify(eat.result).slice(0, 400));
    assert.equal(eat.result.bots, config.team.names.length);
    assert.equal(eat.result.completed, config.team.names.length);
    assert.deepEqual(eat.result.results.map((row) => row.bot), config.team.names);

    const home = await runtime.commands.execute('return home all', { source: 'internal' });
    assert.equal(home.result.ok, true, JSON.stringify(home.result).slice(0, 400));
    assert.equal(home.result.completed, config.team.names.length);

    const inventory = await runtime.commands.execute('bot all inventory', { source: 'internal' });
    assert.equal(inventory.result.completed, config.team.names.length, JSON.stringify(inventory.result).slice(0, 400));
    assert.ok(inventory.result.results.every((row) => row.inventory && row.inventory.capacity));

    const collect = await runtime.commands.execute('bot all collect', { source: 'internal' });
    assert.equal(collect.result.completed, config.team.names.length, JSON.stringify(collect.result).slice(0, 400));

    const defend = await runtime.commands.execute('bot all defend', { source: 'internal' });
    assert.equal(defend.result.bots, config.team.names.length, JSON.stringify(defend.result).slice(0, 400));
    assert.equal(defend.result.results.length, config.team.names.length);

    const explore = await runtime.commands.execute('explore all 1', { source: 'internal' });
    assert.equal(explore.result.bots, config.team.names.length, JSON.stringify(explore.result).slice(0, 400));
    assert.equal(explore.result.results.length, config.team.names.length);
  } finally {
    await runtime.shutdown('test');
  }
});

test('a batch runs multiple fleet actions in order and reports every step', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const batch = await runtime.commands.execute('batch all eat then return home', { source: 'internal' });
    assert.equal(batch.result.ok, true, JSON.stringify(batch.result).slice(0, 500));
    assert.equal(batch.result.steps, 2);
    assert.equal(batch.result.completedSteps, 2);
    assert.deepEqual(batch.result.results.map((step) => step.action), ['eat', 'return home']);

    const tasks = await runtime.commands.execute('task fleet CHOP_WOOD types=oak', { source: 'internal' });
    assert.equal(tasks.result.ok, true);
    assert.equal(tasks.result.tasks, config.team.names.length);
    assert.equal(tasks.result.assigned.filter((row) => row.ok).length, config.team.names.length);
  } finally {
    await runtime.shutdown('test');
  }
});

test('a not-ready bot is skipped by fleet commands and cannot execute a direct gameplay action', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const bot = runtime.bots.get('________');
    bot.authenticated = false;
    bot.lastError = 'manual login required';
    bot.authRequiredManual = true;

    const direct = await runtime.commands.execute('chop ________', { source: 'internal' });
    assert.equal(direct.result.ok, false);
    assert.equal(direct.result.code, 'BOT_NOT_READY');

    const fleet = await runtime.commands.execute('eat all', { source: 'internal' });
    assert.equal(fleet.result.ok, false);
    assert.equal(fleet.result.skipped, 1);
    assert.equal(fleet.result.completed, config.team.names.length - 1);
    assert.equal(fleet.result.results.find((row) => row.bot === '________').code, 'BOT_NOT_READY');
  } finally {
    await runtime.shutdown('test');
  }
});

test('fleet mining removes real ore blocks and reports per-bot evidence', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const targets = [];
    for (const bot of runtime.bots.values()) {
      const x = Math.floor(bot.position.x);
      const z = Math.floor(bot.position.z);
      const y = Math.floor(bot.position.y) - 2;
      // A reachable, exposed deposit: ore, air above it, solid floor.
      runtime.world.overrides.set(`${x},${y},${z}`, 'iron_ore');
      runtime.world.overrides.set(`${x},${y + 1},${z}`, 'air');
      runtime.world.overrides.set(`${x},${y - 1},${z}`, 'stone');
      targets.push({ bot: bot.name, x, y, z });
    }

    const mined = await runtime.commands.execute('bot all mine iron', { source: 'internal' });
    const result = mined.result;
    const expected = Math.max(3, config.team.names.length - 2);
    assert.ok(result.completed >= expected, JSON.stringify(result.results));
    assert.ok(result.results.filter((row) => row.ok && row.mined > 0).length >= expected);
    const removed = targets.filter((target) => runtime.world.blockNameAt(target.x, target.y, target.z) !== 'iron_ore');
    assert.ok(removed.length >= expected, `only ${removed.length} deposits disappeared`);
  } finally {
    await runtime.shutdown('test');
  }
});

test('gear optimise takes the per-bot operator lock before equipping', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    let exclusiveCalls = 0;
    const original = runtime.runExclusive.bind(runtime);
    runtime.runExclusive = async (name, fn) => { exclusiveCalls++; return original(name, fn); };
    const result = await runtime.commands.execute('gear optimise', { source: 'internal' });
    assert.equal(result.result.ok, true, JSON.stringify(result.result));
    assert.ok(exclusiveCalls >= 1, 'gear changes must queue behind the bot command lock');
  } finally {
    await runtime.shutdown('test');
  }
});
