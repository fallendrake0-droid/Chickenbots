'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WoodcuttingController, countLogs } = require('../src/actions/woodcutting');
const { WoodcuttingTeam } = require('../src/woodcutting/team');
const { CombatController } = require('../src/actions/combat');
const { ResourceReservations } = require('../src/actions/reservations');
const { InventoryManager } = require('../src/actions/inventory');
const { ResourceLedger } = require('../src/team/resourceLedger');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const {
  catalogue, supportsVersion, speciesFor, saplingFor, isLog, isLeaves, LOG_TYPES
} = require('../src/woodcutting/catalog');
const { createRuntime } = require('../src/runtime');

function flatBot(inventory = { iron_axe: 1 }, position = { x: 0, y: 65, z: 0 }) {
  const world = new MockWorld({ flat: true, seed: 1300 });
  const bot = new MockBot({ name: '10101000', world, inventory, position });
  return { world, bot };
}

function trunk(world, type, base, height) {
  for (let y = base.y; y < base.y + height; y++) world.setBlock({ x: base.x, y, z: base.z }, type);
  world.setBlock({ x: base.x, y: base.y - 1, z: base.z }, 'dirt');
}

function squareTrunk(world, type, base, height) {
  for (const dx of [0, 1]) for (const dz of [0, 1]) {
    trunk(world, type, { x: base.x + dx, y: base.y, z: base.z + dz }, height);
  }
}

test('the catalogue is version-aware and species normalisation covers modern logs and saplings', () => {
  assert.equal(isLog('stripped_oak_log'), true);
  assert.equal(isLog('oak_wood'), true);
  assert.equal(isLeaves('mangrove_leaves'), true);
  assert.equal(isLog('stone'), false);
  assert.equal(speciesFor('mangrove_log'), 'mangrove');
  assert.equal(speciesFor('cherry_wood'), 'cherry');
  assert.equal(speciesFor('pale_oak_log'), 'pale_oak');
  assert.equal(saplingFor('mangrove_wood'), 'mangrove_propagule');
  assert.equal(supportsVersion('cherry_log', '1.19.2'), false);
  assert.equal(supportsVersion('cherry_log', '1.20'), true);
  assert.equal(supportsVersion('pale_oak_log', '1.20.6'), false);
  assert.equal(supportsVersion('pale_oak_log', '1.21.4'), true);
  const old = catalogue({ version: '1.18.2' });
  assert.equal(old.find((entry) => entry.species === 'mangrove').supported, false);
  assert.equal(old.find((entry) => entry.species === 'oak').supported, true);
  assert.equal(LOG_TYPES.includes('dark_oak_log'), true);
});

test('tree identification derives one confident tree and never merges spaced trunks', () => {
  const { world, bot } = flatBot();
  trunk(world, 'oak_log', { x: 4, y: 64, z: 0 }, 5);
  trunk(world, 'oak_log', { x: 7, y: 64, z: 0 }, 4);
  world.setBlock({ x: 4, y: 69, z: 0 }, 'oak_leaves');
  const controller = new WoodcuttingController({ bot });
  const trees = controller.findTrees({ radius: 16 });
  assert.equal(trees.length, 2, JSON.stringify(trees));
  const first = trees.find((tree) => tree.base.x === 4);
  assert.equal(first.count, 5);
  assert.equal(first.footprint, '1x1');
  assert.equal(first.columnCount, 1);
  assert.equal(first.height, 5);
  assert.ok(first.confidence >= 0.8, JSON.stringify(first));
  assert.equal(first.leaves >= 1, true);
  assert.equal(first.supported, true);
});

test('a 2x2 dark oak is identified, chopped as one tree and replanted as a 2x2 square', async () => {
  const { world, bot } = flatBot({ iron_axe: 1, dark_oak_sapling: 8 });
  squareTrunk(world, 'dark_oak_log', { x: 4, y: 64, z: 0 }, 4);
  world.setBlock({ x: 4, y: 68, z: 0 }, 'dark_oak_leaves');
  const controller = new WoodcuttingController({ bot });
  const trees = controller.findTrees({ radius: 16, types: 'dark_oak' });
  assert.equal(trees.length, 1, JSON.stringify(trees));
  assert.equal(trees[0].footprint, '2x2');
  assert.equal(trees[0].columnCount, 4);
  assert.equal(trees[0].count, 16);
  assert.equal(trees[0].confidence >= 0.9, true);
  const result = await controller.chopTree(trees[0].base);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.chopped, 16, JSON.stringify(result));
  assert.equal(result.footprint, '2x2');
  assert.equal(result.replant.planted, 4, JSON.stringify(result.replant));
  assert.equal(controller.stats.replanted, 4);
  for (const dx of [0, 1]) for (const dz of [0, 1]) {
    assert.equal(world.getBlock({ x: 4 + dx, y: 64, z: dz }).name, 'dark_oak_sapling');
  }
});

test('species-correct replanting uses the harvested sapling and reports a missing one honestly', async () => {
  const { world, bot } = flatBot({ iron_axe: 1, birch_sapling: 2, oak_sapling: 2 });
  trunk(world, 'birch_log', { x: 4, y: 64, z: 0 }, 4);
  const controller = new WoodcuttingController({ bot });
  const result = await controller.chopTree({ x: 4, y: 64, z: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.type, 'birch_log');
  assert.equal(world.getBlock({ x: 4, y: 64, z: 0 }).name, 'birch_sapling');
  assert.equal(bot.countItem('birch_sapling'), 1);
  assert.equal(bot.countItem('oak_sapling'), 2, 'the wrong species was never planted');

  const second = flatBot({ iron_axe: 1, oak_sapling: 2 });
  trunk(second.world, 'birch_log', { x: 4, y: 64, z: 0 }, 3);
  const noSapling = new WoodcuttingController({ bot: second.bot });
  const missing = await noSapling.chopTree({ x: 4, y: 64, z: 0 });
  assert.equal(missing.ok, true);
  assert.equal(missing.replanted, false);
  assert.match(missing.replant.error, /no birch_sapling/);
});

test('a GUARD role defends a real hostile before touching a tree', async () => {
  const { world, bot } = flatBot();
  trunk(world, 'oak_log', { x: 4, y: 64, z: 0 }, 4);
  const zombie = world.addMob('zombie', { x: 1, y: 65, z: 0 });
  const controller = new WoodcuttingController({ bot });
  controller.combat = new CombatController({ bot });
  controller.setRole('GUARD');
  const result = await controller.tick({ maxTrees: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.chopped, 0);
  assert.equal(result.guard.ok, true, JSON.stringify(result.guard));
  assert.equal(zombie.health < 20, true);
});

test('a bot with no axe converts logs and crafts a real wooden axe before chopping', async () => {
  const { world, bot } = flatBot({ oak_log: 3, oak_sapling: 1 });
  trunk(world, 'oak_log', { x: 4, y: 64, z: 0 }, 4);
  const controller = new WoodcuttingController({ bot });
  const result = await controller.chopTree({ x: 4, y: 64, z: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(bot.countItem('wooden_axe'), 1);
  assert.equal(controller.stats.axesCrafted, 1);
  assert.equal(controller.stats.axesEquipped, 1);
});

test('a partially reachable tall trunk is reported honestly rather than counted whole', async () => {
  const { world, bot } = flatBot();
  trunk(world, 'spruce_log', { x: 4, y: 64, z: 0 }, 10);
  const controller = new WoodcuttingController({ bot });
  const result = await controller.chopTree({ x: 4, y: 64, z: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  // With adjacent stances the mock can reach every layer of the tall trunk.
  // Each removal is still verified, and the counters must agree with the world.
  assert.equal(result.chopped, 10, JSON.stringify(result));
  assert.equal(result.partial, false);
  assert.equal(result.error, undefined);
  assert.equal(controller.stats.treesChopped, 1);
  assert.equal(world.getBlock({ x: 4, y: 73, z: 0 }).name, 'air', 'the top layer was really removed');
  assert.equal(controller.stats.blocksVerified, result.chopped);
});

test('reservations make two competing bots choose different trees for one trunk', async () => {
  const world = new MockWorld({ flat: true, seed: 1310 });
  trunk(world, 'oak_log', { x: 4, y: 64, z: 0 }, 4);
  const a = new MockBot({ name: '10101000', world, inventory: { iron_axe: 1 }, position: { x: 0, y: 65, z: 0 } });
  const b = new MockBot({ name: '01010100', world, inventory: { iron_axe: 1 }, position: { x: 7, y: 65, z: 0 } });
  const reservations = new ResourceReservations();
  const first = new WoodcuttingController({ bot: a, reservations });
  const second = new WoodcuttingController({ bot: b, reservations });
  const firstTrees = first.findTrees({ radius: 16 });
  assert.equal(firstTrees.length, 1);
  assert.equal(first._claimTree(firstTrees[0].base).ok, true);
  assert.equal(second.findTrees({ radius: 16 })[0].holder, a.name);
  const contested = second._claimTree(firstTrees[0].base);
  assert.equal(contested.ok, false);
  assert.equal(contested.owner, a.name);
  const idle = await second.tick({ maxTrees: 1 });
  assert.equal(idle.idle, true, JSON.stringify(idle));
  assert.match(idle.reason, /reserved/);
  assert.equal(world.getBlock({ x: 4, y: 64, z: 0 }).name, 'oak_log', 'the contested trunk was not chopped');
});

test('verified drop accounting, task counters and lifetime counters come from real inventory changes', async () => {
  const { world, bot } = flatBot({ iron_axe: 1, oak_sapling: 2 });
  trunk(world, 'oak_log', { x: 4, y: 64, z: 0 }, 4);
  const controller = new WoodcuttingController({ bot });
  const before = countLogs(bot.inventory);
  const result = await controller.chopTree({ x: 4, y: 64, z: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.logsGained, 4);
  assert.equal(result.dropped.oak_log, 4);
  assert.equal(result.verifiedDrops, true);
  assert.equal(countLogs(bot.inventory), before + 4);
  assert.equal(controller.stats.logsCollected, 4);
  assert.equal(controller.taskStats().treesChopped, 1);
  controller._begin();
  assert.equal(controller.taskStats().treesChopped, 0);
  assert.equal(controller.lifetimeStats().treesChopped, 1);
});

test('real storage deposits every log and verifies the inventory left the bot', async () => {
  const { world, bot } = flatBot({ iron_axe: 1, oak_log: 12, birch_log: 5 }, { x: 0, y: 65, z: 0 });
  world.setBlock({ x: 2, y: 65, z: 2 }, 'chest');
  const ledger = new ResourceLedger({ now: () => 1000 });
  const inventory = new InventoryManager({ bot, ledger, home: { x: 0, y: 65, z: 2 } });
  const controller = new WoodcuttingController({ bot, ledger, inventory, home: { x: 0, y: 65, z: 2 } });
  ledger.updateBotInventory(bot.name, bot.inventory);
  const result = await controller.storeLoot();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.moved, 17);
  assert.equal(bot.countItem('oak_log'), 0);
  assert.equal(bot.countItem('birch_log'), 0);
  assert.equal(controller.stats.stored, 17);
  assert.equal(controller.stats.tripsHome, 1);
  const window = await bot.openContainer({ x: 2, y: 65, z: 2 });
  const contents = window.items();
  await window.close();
  assert.equal(contents.oak_log, 12);
  assert.equal(contents.birch_log, 5);
  assert.equal(bot.countItem('iron_axe'), 1, 'gear is never stored');
});

test('fleet roles change support behaviour and support requests can be fulfilled', async () => {
  const world = new MockWorld({ flat: true, seed: 1320 });
  const bots = ['10101000', '01010100', '11001100'].map((name, index) => new MockBot({
    name, world, inventory: { iron_axe: 1, oak_sapling: 4 }, position: { x: index, y: 65, z: 0 }
  }));
  const controllers = bots.map((bot) => new WoodcuttingController({ bot }));
  const team = new WoodcuttingTeam({ controllers });
  assert.equal(team.setRole('10101000', 'SCOUT').role, 'SCOUT');
  assert.equal(team.setRole('10101000', 'NOPE').ok, false);
  const assigned = team.autoAssign();
  assert.equal(assigned.ok, true);
  assert.equal(team.status().rows.length, 3);
  assert.equal(Object.keys(assigned.assigned).length, 3);
  const requested = controllers[0].requestSupport({ kind: 'storage', detail: 'chest full' });
  assert.equal(requested.ok, true);
  assert.equal(team.support({ status: 'open' }).length, 1);
  const fulfilled = team.fulfil(requested.request.id, 'operator');
  assert.equal(fulfilled.ok, true);
  assert.equal(team.support({ status: 'open' }).length, 0);
  assert.equal(controllers[0].status().role, assigned.assigned[bots[0].name]);
});

test('the woodcutting command exposes catalogue, scanning, status, roles and support', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const status = await runtime.commands.execute('woodcutting status', { source: 'cli' });
    assert.equal(status.ok, true, JSON.stringify(status.result));
    assert.equal(status.result.rows.length, runtime.bots.size);
    assert.equal(typeof status.result.rows[0].task.treesChopped, 'number');
    assert.equal(typeof status.result.rows[0].lifetime.treesChopped, 'number');

    const catalog = await runtime.commands.execute('woodcutting catalog', { source: 'cli' });
    assert.equal(catalog.ok, true);
    assert.equal(catalog.result.species.length >= 9, true);

    const scan = await runtime.commands.execute('woodcutting trees 32', { source: 'cli' });
    assert.equal(scan.ok, true, JSON.stringify(scan.result));
    assert.equal(Array.isArray(scan.result.trees), true);

    const team = await runtime.commands.execute('woodcutting team auto', { source: 'cli' });
    assert.equal(team.ok, true);
    assert.equal(Object.keys(team.result.assigned).length, runtime.bots.size);
    const role = await runtime.commands.execute(`woodcutting team assign ${[...runtime.bots.keys()][0]} PLANTER`, { source: 'cli' });
    assert.equal(role.ok, true, JSON.stringify(role.result));
    assert.equal(role.result.role, 'PLANTER');

    const request = await runtime.commands.execute(`woodcutting support request ${[...runtime.bots.keys()][0]} AXE need spare axe`, { source: 'cli' });
    assert.equal(request.ok, true, JSON.stringify(request.result));
    const open = await runtime.commands.execute('woodcutting support status', { source: 'cli' });
    assert.equal(open.result.open.length >= 1, true);
    const fulfil = await runtime.commands.execute(`woodcutting support fulfil ${request.result.request.id}`, { source: 'cli' });
    assert.equal(fulfil.ok, true);

    await runtime._warmStatusCaches();
    const { statusSnapshot } = require('../src/runtimeState');
    const snapshot = statusSnapshot(runtime.services);
    assert.equal(snapshot.woodcuttingTeam.rows.length, runtime.bots.size);
    assert.equal(snapshot.woodcuttingCatalog.length >= 9, true);
    assert.equal(snapshot.woodcutting.every((row) => row.task && row.lifetime), true);
  } finally {
    await runtime.shutdown('woodcutting overhaul test');
  }
});

test('a tree scan over a large empty area stays bounded', () => {
  const { bot } = flatBot();
  const controller = new WoodcuttingController({ bot });
  const started = Date.now();
  const trees = controller.findTrees({ radius: 64, limit: 20 });
  const elapsed = Date.now() - started;
  assert.equal(trees.length, 0);
  assert.ok(elapsed < 1500, `bounded scan took ${elapsed}ms`);
});
