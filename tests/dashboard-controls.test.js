'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createCommandHandler } = require('../src/commands');

const ROOT = path.join(__dirname, '..');
const PUBLIC_JS = path.join(ROOT, 'src', 'dashboard', 'public', 'js');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  ));
}

function commandNames() {
  const names = new Set();
  for (const command of createCommandHandler({}).list()) {
    names.add(command.name);
    for (const alias of command.aliases) names.add(alias);
  }
  return names;
}

test('every static data-command in the dashboard names a real backend command', () => {
  const names = commandNames();
  const files = walk(PUBLIC_JS).filter((file) => file.endsWith('.js'));
  const failures = [];
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data-command="([^"]*)"/g)) {
      const value = match[1];
      if (value.includes('${')) continue; // covered by the dynamic-control test below
      checked++;
      const name = value.trim().split(/\s+/)[0];
      if (!names.has(name)) failures.push(`${path.relative(ROOT, file)}: '${value}'`);
    }
  }
  assert.ok(checked >= 40, `only ${checked} literal command controls were checked`);
  assert.deepEqual(failures, [], `controls reference unknown commands:\n${failures.join('\n')}`);
});

test('every literal data-command has a valid argument count for its registered command', () => {
  const handler = createCommandHandler({});
  const names = commandNames();
  const files = walk(PUBLIC_JS).filter((file) => file.endsWith('.js'));
  const failures = [];
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data-command="([^"]*)"/g)) {
      const value = match[1];
      if (value.includes('${')) continue;
      const [name, ...args] = value.trim().split(/\s+/);
      if (!names.has(name)) continue; // the first test reports unknown commands
      checked++;
      const check = handler.validate(name, args);
      if (!check.ok) failures.push(`${path.relative(ROOT, file)}: '${value}' — ${check.error}`);
    }
  }
  assert.ok(checked >= 40, `only ${checked} literal command controls were validated`);
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('every data.get field read by a form has a matching named input', () => {
  const files = walk(PUBLIC_JS).filter((file) => file.endsWith('.js'));
  const failures = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data\.get\('([A-Za-z0-9_-]+)'\)/g)) {
      const field = match[1];
      if (!source.includes(`name="${field}"`)) failures.push(`${path.relative(ROOT, file)}: reads '${field}' but no input is named '${field}'`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('every data-fleet-command carries a verb the fleet grammar accepts exactly once', () => {
  const names = commandNames();
  const files = walk(PUBLIC_JS).filter((file) => file.endsWith('.js'));
  const failures = [];
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data-fleet-command="([^"]*)"/g)) {
      const value = match[1];
      if (value.includes('${')) continue;
      checked++;
      const [verb, ...rest] = value.trim().split(/\s+/);
      if (!names.has(verb)) failures.push(`${path.relative(ROOT, file)}: unknown verb '${verb}'`);
      if (rest.length && ['all', 'fleet', 'team'].includes(String(rest[0]).toLowerCase())) {
        failures.push(`${path.relative(ROOT, file)}: '${value}' would become '${verb} all all …'`);
      }
    }
  }
  assert.ok(checked >= 8, `only ${checked} fleet controls were checked`);
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('dynamic command templates use the registry builders instead of hand-built grammar', () => {
  const files = walk(PUBLIC_JS).filter((file) => file.endsWith('.js'));
  const sources = Object.fromEntries(files.map((file) => [path.relative(ROOT, file), fs.readFileSync(file, 'utf8')]));
  const mining = sources[path.join('src', 'dashboard', 'public', 'js', 'pages', 'gameplay.js')];
  assert.ok(mining.includes("from '../commands.js'"), 'gameplay must use the shared command helpers');
  assert.ok(mining.includes('miningChoices()'), 'mining targets must come from the server catalogue');
  assert.ok(mining.includes('findMiningTarget('), 'mining must resolve targets through the catalogue');
  assert.ok(mining.includes('runStructuredCommand(\'mine\''), 'mining must execute structurally, not by string concatenation');
  assert.ok(!/mine \$\{bot\}/.test(mining), 'the old hand-built `mine ${bot}` line must be gone');
  assert.ok(!/const common = \['diamond'/.test(mining), 'the duplicated ore list must be gone');
  assert.ok(mining.includes('data-mining-preview'), 'the mining form must show a command preview');
  assert.ok(mining.includes('miningSnapshot()') && mining.includes('Counter delta') && mining.includes('Item delta'), 'mining must compare live state before and after');

  for (const [file, source] of Object.entries(sources)) {
    assert.ok(!source.includes('data-command="guard 0 64 0"'), `${file}: hard-coded guard coordinate is back`);
    assert.ok(!source.includes('commandButton(\'Guard\', \'guard 0 64 0\''), `${file}: hard-coded guard coordinate is back`);
  }

  const commandsSource = sources[path.join('src', 'dashboard', 'public', 'js', 'commands.js')];
  assert.ok(commandsSource.includes('bot !== leader || stop'), 'a per-bot stop (including the leader) must name the bot; `mine stop` means the whole fleet');
  assert.ok(commandsSource.includes('if (!stop && target)'), 'a stop invocation must never carry a target token');
  assert.ok(commandsSource.includes('fleet && String(fleet)'), 'the shared mining arguments helper must translate fleet selectors explicitly');

  const combatModesSource = sources[path.join('src', 'dashboard', 'public', 'js', 'pages', 'combat.js')];
  assert.ok(combatModesSource.includes("subcommandValues('combat', 'mode')"), 'combat modes must come from command metadata');
  assert.ok(!combatModesSource.includes("['TEAM_FIGHT', 'DEFENSIVE'"), 'combat mode list must not be duplicated in the page');
  const playersModesSource = sources[path.join('src', 'dashboard', 'public', 'js', 'pages', 'players.js')];
  assert.ok(playersModesSource.includes("subcommandValues('players', 'mode')"), 'target modes must come from command metadata');
  assert.ok(!playersModesSource.includes("['EXPLICIT', 'ARENA', 'DEFENSIVE']"), 'target mode list must not be duplicated in the page');
  assert.ok(playersModesSource.includes("data.get('tag')"), 'the tag form must read the field it renders');
  for (const [file, source] of Object.entries(sources)) {
    assert.ok(!/toast\(\s*['"]/.test(source), `${file}: toast() takes an options object, not (message, type)`);
  }

  const woodcuttingRoleSource = sources[path.join('src', 'dashboard', 'public', 'js', 'pages', 'gameplay.js')];
  assert.ok(woodcuttingRoleSource.includes("commandValues('woodcutting', 'role')"), 'woodcutting roles must come from command metadata');
  assert.ok(woodcuttingRoleSource.includes("commandValues('survival', 'feature')"), 'survival routines must come from command metadata');
  assert.ok(!woodcuttingRoleSource.includes("['CHOPPER', 'SCOUT'"), 'woodcutting role list must not be duplicated in the page');

  const fleet = sources[path.join('src', 'dashboard', 'public', 'js', 'pages', 'fleet.js')];
  assert.ok(fleet.includes("commandValues('survival', 'feature')"), 'survival switches must come from command metadata');
  assert.ok(!fleet.includes("const SURVIVAL_TOGGLES = ["), 'the survival routine list must not be duplicated in the page');
  assert.ok(fleet.includes('function assignmentText('), 'task assignments are objects in the live snapshot and must be formatted, not interpolated');
  assert.ok(!fleet.includes("esc(member.assignment ||"), 'raw assignment objects must never reach markup');

  const construction = sources[path.join('src', 'dashboard', 'public', 'js', 'pages', 'construction.js')];
  assert.ok(construction.includes("action === 'repair' && !window.confirm("), 'build repair must confirm before resuming placement');
  assert.ok(construction.includes("api.buildAction(id, action, confirmedAction ? { confirm: true } : {})"), 'the build endpoint must receive explicit confirmation only after the dialog');
  assert.ok(construction.includes('snap.schematics.stats.tiers'), 'home-base tiers must come from the schematic library');
  assert.ok(construction.includes('quoteArg(design)'), 'design names must be quoted before entering the raw line');

  const combat = sources[path.join('src', 'dashboard', 'public', 'js', 'pages', 'combat.js')];
  assert.ok(combat.includes('function guardButton('), 'guard controls must derive coordinates from live bot state');
  assert.ok(/data-combat-form=\\?"duel"/.test(combat), 'duel must be an explicit player form');
  assert.ok(!/commandButton\('Duel…', 'duel'/.test(combat), 'bare `duel` must not be a control');
});

test('rendered mining markup contains a selector per scope and server-provided options', () => {
  const gameplay = fs.readFileSync(path.join(PUBLIC_JS, 'pages', 'gameplay.js'), 'utf8');
  for (const marker of ['id="mine-scope"', 'value="leader"', 'value="all"', 'id="mine-target"', 'targetChoicesHtml()', 'data-mining-result', 'data-mining-quick="stop-all"', 'data-mining-quick="bot"']) {
    assert.ok(gameplay.includes(marker), `mining page is missing ${marker}`);
  }
  assert.ok(!/option value="diamond"/.test(gameplay), 'mining page must not hard-code target options');
});
