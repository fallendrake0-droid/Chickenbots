'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createRuntime } = require('../src/runtime');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { TeamMemory } = require('../src/team/teamMemory');
const { ResourceLedger } = require('../src/team/resourceLedger');
const { TaskBoard } = require('../src/team/taskBoard');
const { FishingController } = require('../src/actions/fishing');
const { ExplorationController } = require('../src/actions/exploration');
const { SleepController } = require('../src/actions/sleep');
const { SchematicLibrary } = require('../src/schematics/library');
const { SchematicBuilder } = require('../src/builder/builder');

function flatBot(name = '_______', inventory = {}, position = { x: 0, y: 64, z: 0 }) {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name, world, inventory });
  bot.position = { ...position };
  return { bot, world };
}

function addWaterAt(world, position) {
  const { x, y, z } = position;
  world.setBlock({ x, y: y - 1, z }, 'stone');
  world.setBlock({ x, y, z }, 'water');
  world.setBlock({ x, y: y + 1, z }, 'air');
}

async function simulation() {
  return createRuntime({ simulate: true, dashboard: false });
}

test('fishing requires a rod and water, counts a real catch and honours stop', async () => {
  const { bot, world } = flatBot('_______', { fishing_rod: 1 });
  const ledger = new ResourceLedger();
  const memory = new TeamMemory();
  addWaterAt(world, { x: 2, y: 64, z: 0 });
  const fishing = new FishingController({ bot, ledger, memory });
  const status = fishing.status();
  assert.equal(status.rod, true);
  assert.ok(status.water >= 1);
  const cast = await fishing.cast({ timeoutMs: 10 });
  assert.equal(cast.ok, true, cast.error);
  assert.ok(cast.items.length >= 1);
  assert.ok(Object.values(fishing.caught).reduce((n, count) => n + count, 0) >= 1);
  assert.ok(ledger.inventories.get(bot.name).counts.cod >= 1 || ledger.inventories.get(bot.name).counts.salmon >= 1);
  assert.ok(memory.query({ type: 'RESOURCE' }).length >= 1);
  fishing.stop();
  const stopped = await fishing.cast({ timeoutMs: 10 });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.ok, false);

  const noRod = new FishingController({ bot: flatBot('1010100').bot });
  const rejected = await noRod.cast({ timeoutMs: 10 });
  assert.equal(rejected.ok, false);
  assert.ok(/fishing_rod/.test(rejected.error));
});

test('structure clue search needs three blocks and only then records discovery', () => {
  const { bot, world } = flatBot('0101010');
  const memory = new TeamMemory();
  const exploration = new ExplorationController({ bot, memory, home: { x: 0, y: 64, z: 0 } });
  const empty = exploration.findClue('village', { radius: 12 });
  assert.equal(empty.ok, true);
  assert.equal(empty.found, false);
  world.setBlock({ x: 1, y: 64, z: 0 }, 'bell');
  world.setBlock({ x: 2, y: 64, z: 0 }, 'composter');
  world.setBlock({ x: 3, y: 64, z: 0 }, 'hay_block');
  const found = exploration.findClue('village', { radius: 12 });
  assert.equal(found.ok, true);
  assert.equal(found.found, true);
  assert.ok(found.evidence >= 3);
  assert.ok(found.confidence > 0);
  const observations = memory.query({ type: 'VILLAGE' });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].reportedBy, bot.name);
  const invalid = exploration.findClue('not-a-structure');
  assert.equal(invalid.ok, false);
});

test('automatic sleep can be disabled per bot without affecting manual sleep', async () => {
  const { bot } = flatBot('1100110', { white_bed: 1 });
  const sleep = new SleepController({ bot });
  const off = sleep.setAuto(false);
  assert.equal(off.ok, true);
  assert.equal(sleep.status().auto, false);
  const skipped = await sleep.tick();
  assert.equal(skipped.skipped, true);
  assert.ok(/disabled/.test(skipped.reason));
  sleep.setAuto(true);
  assert.equal(sleep.status().auto, true);
  const day = await sleep.tick();
  assert.equal(day.skipped, undefined);
});

test('a running build can be paused, resumed and cancelled with visible state', () => {
  const library = new SchematicLibrary();
  let design = null;
  let best = Infinity;
  for (const candidate of library.list({ tier: 'Beginner', limit: 40 })) {
    const total = Object.values(candidate.materials || {}).reduce((n, count) => n + count, 0);
    if (total < best) { best = total; design = candidate; }
  }
  const schematic = library.build(design.id);
  const world = new MockWorld({ flat: true });
  const inventory = { ...schematic.materials };
  const bots = ['_______', '1010100', '0101010', '1100110', '0011000'].map((name) => {
    const bot = new MockBot({ name, world, inventory: { ...inventory } });
    bot.position = { x: 8, y: 70, z: 8 };
    return bot;
  });
  const builder = new SchematicBuilder({ schematic, origin: { x: 20, y: 70, z: 20 }, world, bots, taskBoard: new TaskBoard() });
  const started = builder.start({ confirm: true });
  assert.equal(started.ok, true, started.error);
  assert.equal(builder.status().state, 'RUNNING');
  const paused = builder.pause('test pause');
  assert.equal(paused.ok, true);
  assert.equal(builder.status().state, 'PAUSED');
  const resumed = builder.resume();
  assert.equal(resumed.ok, true);
  assert.equal(builder.status().state, 'RUNNING');
  const cancelled = builder.cancel('test cancel');
  assert.equal(cancelled.state, 'CANCELLED');
});

test('TRANSFER_ITEMS moves real items between bots and verifies the recipient inventory', async () => {
  const runtime = await simulation();
  try {
    const [donor, recipient] = [...runtime.bots.values()];
    donor.addItem('diamond', 3);
    recipient.inventory.diamond = 0;
    const actions = runtime.actions.get(donor.name);
    const result = await actions.performTask({
      id: 'transfer-test', type: 'TRANSFER_ITEMS', params: { item: 'diamond', count: 2, to: recipient.name }
    }, { bots: runtime.bots });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.verified, true);
    assert.equal(recipient.countItem('diamond'), 2);
    assert.equal(donor.countItem('diamond'), 1);
  } finally {
    await runtime.shutdown('test');
  }
});

test('the command surface drives fishing, home, sleep automation, formations and build previews', async () => {
  const runtime = await simulation();
  try {
    const leader = [...runtime.bots.values()][0];
    leader.addItem('fishing_rod', 1);
    addWaterAt(runtime.world, { x: leader.position.x + 2, y: Math.floor(leader.position.y), z: leader.position.z });
    const fished = await runtime.executeCommand(`fish ${leader.name} 1`, { source: 'dashboard' });
    assert.equal(fished.result.ok, true, fished.result.error);
    assert.ok(fished.result.caught >= 1);

    const home = await runtime.executeCommand('home set 12 70 -8', { source: 'dashboard' });
    assert.equal(home.result.ok, true, home.result.error);
    assert.deepEqual(home.result.home, runtime.home);
    const homeStatus = await runtime.executeCommand('home status', { source: 'dashboard' });
    assert.equal(homeStatus.result.ok, true);
    assert.ok(homeStatus.result.actions.length === 5);

    const autoOff = await runtime.executeCommand('sleep auto off', { source: 'dashboard' });
    assert.equal(autoOff.result.ok, true);
    assert.equal(autoOff.result.auto, false);
    assert.ok(runtime.actions.list().every((actions) => actions.sleep.auto === false));
    const manualSleep = await runtime.executeCommand(`sleep ${leader.name}`, { source: 'dashboard' });
    assert.notEqual(manualSleep.result.skipped, true, 'an explicit sleep command must bypass the automatic toggle');
    const autoOn = await runtime.executeCommand('sleep auto on', { source: 'dashboard' });
    assert.equal(autoOn.result.ok, true);
    assert.ok(runtime.actions.list().every((actions) => actions.sleep.auto === true));

    const formation = await runtime.executeCommand('team formation FISHING', { source: 'dashboard' });
    assert.equal(formation.result.ok, true);
    assert.equal(formation.result.formation, 'FISHING');
    assert.equal(runtime.coordinator.formation, 'FISHING');

    const design = runtime.library.list({ tier: 'Beginner', limit: 1 })[0];
    const selected = await runtime.executeCommand(`build select ${design.id}`, { source: 'dashboard' });
    assert.equal(selected.result.ok, true, selected.result.error);
    assert.equal(selected.result.selected.id, design.id);
    const preview = await runtime.executeCommand('build preview', { source: 'dashboard' });
    assert.equal(preview.result.ok, true, preview.result.error);
    assert.ok(preview.result.analysis.totalBlocks > 0);
    assert.equal(preview.result.preview, true);
    const located = await runtime.executeCommand(`build preview ${design.id} 20 70 20`, { source: 'dashboard' });
    assert.equal(located.result.ok, true, located.result.error);
    assert.deepEqual(located.result.origin, { x: 20, y: 70, z: 20 });
    const noBuild = await runtime.executeCommand('build pause', { source: 'dashboard' });
    assert.equal(noBuild.result.ok, false);

    const materials = runtime.library.build(design.id).materials;
    for (const bot of runtime.bots.values()) for (const [item, count] of Object.entries(materials)) bot.addItem(item, count);
    const started = await runtime.executeCommand(`build ${design.id} 80 72 80 confirm`, { source: 'dashboard' });
    assert.equal(started.result.ok, true, started.result.error);
    const buildId = started.result.buildId;
    const paused = await runtime.executeCommand(`build pause ${buildId}`, { source: 'dashboard' });
    assert.equal(paused.result.ok, true, paused.result.error);
    assert.equal(paused.result.status.state, 'PAUSED');
    const resumed = await runtime.executeCommand(`build resume ${buildId}`, { source: 'dashboard' });
    assert.equal(resumed.result.ok, true, resumed.result.error);
    assert.equal(resumed.result.status.state, 'RUNNING');
    const stopped = await runtime.executeCommand(`build stop ${buildId}`, { source: 'dashboard' });
    assert.equal(stopped.result.status.state, 'CANCELLED');

    const teamOff = await runtime.executeCommand('team off', { source: 'dashboard' });
    assert.equal(teamOff.result.ok, true);
    assert.equal(teamOff.result.enabled, false);
    const teamOn = await runtime.executeCommand('team on', { source: 'dashboard' });
    assert.equal(teamOn.result.enabled, true);

    const botStatus = await runtime.executeCommand('bot all status', { source: 'dashboard' });
    assert.equal(botStatus.result.bots.length, 5);
    const stopMining = await runtime.executeCommand('mine stop', { source: 'dashboard' });
    assert.equal(stopMining.result.ok, true);
    const stopExploring = await runtime.executeCommand('explore stop all', { source: 'dashboard' });
    assert.equal(stopExploring.result.ok, true);
    assert.equal(stopExploring.result.stopped.length, 5);
    const stopDefend = await runtime.executeCommand('defend stop all', { source: 'dashboard' });
    assert.equal(stopDefend.result.ok, true);
    assert.equal(stopDefend.result.stopped.length, 5);
    const find = await runtime.executeCommand('find forest', { source: 'dashboard' });
    assert.equal(find.result.ok, true);
  } finally {
    await runtime.shutdown('test');
  }
});
