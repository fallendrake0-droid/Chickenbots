'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { MiningController } = require('../src/actions/mining');
const { WoodcuttingController } = require('../src/actions/woodcutting');
const { InventoryManager } = require('../src/actions/inventory');
const { ResourceReservations } = require('../src/actions/reservations');
const { workZone, inWorkZone, clampToWorkZone } = require('../src/world/workZone');
const {
  ORE_TIERS, BLOCK_TIERS, normalizeMineTarget, requiredPickaxeTier
} = require('../src/actions/miningCatalog');

function flatWorld() {
  return new MockWorld({ flat: true, guaranteedOres: false });
}

function tree(world, x, z = 0) {
  for (let y = 64; y <= 67; y++) world.setBlock({ x, y, z }, 'oak_log');
  world.setBlock({ x, y: 63, z }, 'dirt');
  world.setBlock({ x, y: 68, z }, 'oak_leaves');
}

function exposedOre(world, x, z, name) {
  world.setBlock({ x, y: 63, z }, 'stone');
  world.setBlock({ x, y: 64, z }, name);
}

test('the shared work zone is exactly 100x100 blocks and clamps with a margin', () => {
  const zone = workZone({ x: 0, z: 0 }, { size: 100 });
  assert.equal(zone.enabled, true);
  assert.equal(zone.size, 100);
  assert.equal(zone.maxX - zone.minX + 1, 100);
  assert.equal(zone.maxZ - zone.minZ + 1, 100);
  assert.equal(inWorkZone({ x: 49, z: 49 }, { x: 0, z: 0 }), true);
  assert.equal(inWorkZone({ x: 50, z: 0 }, { x: 0, z: 0 }), false);
  assert.equal(inWorkZone({ x: -51, z: 0 }, { x: 0, z: 0 }), false);
  const clamped = clampToWorkZone({ x: 500, z: -500 }, { x: 0, z: 0 }, { margin: 2 });
  assert.equal(clamped.x, 47);
  assert.equal(clamped.z, -48);
});

test('every catalog target has an explicit pickaxe tier', () => {
  for (const name of Object.keys(ORE_TIERS)) {
    assert.equal(requiredPickaxeTier(name), ORE_TIERS[name], name);
  }
  for (const name of Object.keys(BLOCK_TIERS)) {
    assert.equal(requiredPickaxeTier(name), BLOCK_TIERS[name], name);
  }
  assert.equal(normalizeMineTarget('diamonds'), 'diamond_ore');
  assert.equal(requiredPickaxeTier('diamond'), 3);
  assert.equal(requiredPickaxeTier('obsidian'), 4);
  assert.equal(requiredPickaxeTier('dirt'), 0);
});

test('reservations are owner-checked, reentrant and releasable', () => {
  const now = { at: 1000 };
  const reservations = new ResourceReservations({ now: () => now.at, defaultTtlMs: 5000 });
  assert.equal(reservations.claim('tree:1,1', '________').ok, true);
  assert.equal(reservations.claim('tree:1,1', '________').reentrant, true);
  const held = reservations.claim('tree:1,1', '10101000');
  assert.equal(held.ok, false);
  assert.equal(held.owner, '________');
  assert.equal(reservations.release('tree:1,1', '10101000').ok, false);
  assert.equal(reservations.release('tree:1,1', '________').released, true);
  assert.equal(reservations.claim('tree:1,1', '10101000').ok, true);
  now.at += 6000;
  assert.equal(reservations.holder('tree:1,1'), null);
});

test('two bots never chop the same tree and each claim is released', async () => {
  const world = flatWorld();
  tree(world, 3);
  tree(world, 8);
  const home = { x: 0, y: 64, z: 0 };
  const reservations = new ResourceReservations();
  const a = new MockBot({ name: '________', world, position: { x: 0, y: 64, z: 0 }, inventory: { iron_axe: 1, oak_sapling: 2 } });
  const b = new MockBot({ name: '10101000', world, position: { x: 1, y: 64, z: 0 }, inventory: { iron_axe: 1, oak_sapling: 2 } });
  const ca = new WoodcuttingController({ bot: a, home, index: 0, reservations });
  const cb = new WoodcuttingController({ bot: b, home, index: 1, reservations });
  const [ra, rb] = await Promise.all([ca.tick({ maxTrees: 1 }), cb.tick({ maxTrees: 1 })]);
  assert.equal(ra.chopped, 4, JSON.stringify(ra));
  assert.equal(rb.chopped, 4, JSON.stringify(rb));
  const bases = [ra.results[0].base, rb.results[0].base].map((base) => `${base.x},${base.z}`);
  assert.equal(new Set(bases).size, 2, `both bots chose ${bases.join(' and ')}`);
  assert.equal(reservations.status().count, 0);
  assert.equal(world.getBlock({ x: 3, y: 64, z: 0 }).name, 'oak_sapling', 'the stump was replanted');
  assert.equal(world.getBlock({ x: 8, y: 64, z: 0 }).name, 'oak_sapling', 'the stump was replanted');
});

test('woodcutting relocation never leaves the 100x100 zone', async () => {
  const world = flatWorld();
  const bot = new MockBot({ name: '________', world, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  const controller = new WoodcuttingController({ bot, home: { x: 0, y: 64, z: 0 } });
  const result = await controller.tick({ relocate: true, maxRelocations: 3 });
  assert.equal(result.idle, true);
  assert.ok(result.relocations.length > 0);
  for (const move of result.relocations.filter((row) => row.ok)) {
    assert.ok(Math.abs(move.x) <= 48, `relocated to ${move.x}`);
    assert.ok(Math.abs(move.z) <= 48, `relocated to ${move.z}`);
  }
  assert.ok(result.relocations.some((row) => row.code === 'OUTSIDE_WORK_ZONE'), 'the exhausted zone is reported');
  assert.ok(Math.abs(bot.position.x) <= 48 && Math.abs(bot.position.z) <= 48);
});

test('woodcutting refuses a tree outside the 100x100 zone', async () => {
  const world = flatWorld();
  tree(world, 49);
  tree(world, 60);
  const bot = new MockBot({ name: '________', world, position: { x: 0, y: 64, z: 0 }, inventory: { iron_axe: 1 } });
  const controller = new WoodcuttingController({ bot, home: { x: 0, y: 64, z: 0 } });
  assert.deepEqual(controller.findTrees({ radius: 64 }).map((row) => row.base.x), [49]);
  const refused = await controller.chopTree({ x: 60, y: 64, z: 0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'OUTSIDE_WORK_ZONE');
  assert.equal(world.getBlock({ x: 60, y: 64, z: 0 }).name, 'oak_log');
});

test('mining ores outside the work zone is refused, not silently skipped', async () => {
  const world = flatWorld();
  exposedOre(world, 60, 0, 'iron_ore');
  const bot = new MockBot({ name: '________', world, position: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } });
  const mining = new MiningController({ bot, home: { x: 0, y: 64, z: 0 } });
  assert.deepEqual(mining.findOres({ radius: 64, only: 'iron_ore' }), []);
  const refused = await mining.mineOre({ x: 60, y: 64, z: 0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'OUTSIDE_WORK_ZONE');
  assert.equal(world.getBlock({ x: 60, y: 64, z: 0 }).name, 'iron_ore');
});

test('mine diamonds bootstraps wood -> stone -> iron, smelts ingots, then mines the diamond', async () => {
  const world = flatWorld();
  const home = { x: 0, y: 64, z: 0 };
  // Clear the immediate area so every test ore is exposed and reachable.
  for (let x = 0; x <= 8; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = 63; y <= 65; y++) world.setBlock({ x, y, z }, 'air');
    }
  }
  world.setBlock({ x: 0, y: 63, z: 0 }, 'stone');
  exposedOre(world, 3, 0, 'iron_ore');
  exposedOre(world, 4, 0, 'iron_ore');
  exposedOre(world, 5, 0, 'iron_ore');
  exposedOre(world, 2, 0, 'coal_ore');
  exposedOre(world, 7, 0, 'diamond_ore');
  const bot = new MockBot({
    name: '________', world, position: { x: 0, y: 64, z: 0 },
    inventory: { oak_log: 8, cobblestone: 12, coal: 1 }
  });
  const inventory = new InventoryManager({ bot, home });
  const mining = new MiningController({ bot, home });
  mining.attachHelpers({ inventory });

  const result = await mining.mineOresDeep({ radius: 16, limit: 1, minY: -59, only: 'diamond_ore' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mined, 1);
  assert.equal(result.tool.ok, true);
  assert.equal(result.tool.have, 3);
  assert.deepEqual(result.tool.steps.map((step) => step.tool), ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']);
  assert.equal(bot.countItem('iron_pickaxe'), 1);
  assert.equal(bot.countItem('diamond'), 1);
  assert.equal(bot.countItem('raw_iron'), 0);
  assert.equal(mining.stats.toolBootstraps, 1);
  assert.equal(world.getBlock({ x: 7, y: 64, z: 0 }).name, 'air');
});

test('a block request also bootstraps its tier and hand-diggable blocks need no pick', async () => {
  const world = flatWorld();
  const bot = new MockBot({ name: '________', world, position: { x: 0, y: 64, z: 0 }, inventory: { oak_log: 8 } });
  const inventory = new InventoryManager({ bot, home: { x: 0, y: 64, z: 0 } });
  const mining = new MiningController({ bot, home: { x: 0, y: 64, z: 0 } });
  mining.attachHelpers({ inventory });
  const stone = await mining.mineBlocks({ block: 'stone', limit: 2, minY: -59 });
  assert.equal(stone.ok, true, JSON.stringify(stone).slice(0, 1000));
  assert.ok(stone.mined >= 2);
  assert.equal(bot.countItem('wooden_pickaxe'), 1);

  const dirtBot = new MockBot({ name: '10101000', world, position: { x: 2, y: 64, z: 2 }, inventory: {} });
  const dirtMining = new MiningController({ bot: dirtBot, home: { x: 0, y: 64, z: 0 } });
  const dirt = await dirtMining.mineBlocks({ block: 'dirt', limit: 1, minY: -59 });
  assert.equal(dirt.ok, true, JSON.stringify(dirt).slice(0, 800));
});

test('a second bot cannot mine an ore already reserved by the first', async () => {
  const world = flatWorld();
  exposedOre(world, 3, 0, 'iron_ore');
  const reservations = new ResourceReservations();
  const a = new MockBot({ name: '________', world, position: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } });
  const b = new MockBot({ name: '10101000', world, position: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } });
  const ma = new MiningController({ bot: a, reservations, home: { x: 0, y: 64, z: 0 } });
  const mb = new MiningController({ bot: b, reservations, home: { x: 0, y: 64, z: 0 } });
  const [first, second] = await Promise.all([
    ma.mineOre({ x: 3, y: 64, z: 0 }),
    mb.mineOre({ x: 3, y: 64, z: 0 })
  ]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, false);
  assert.equal(second.code, 'ORE_RESERVED');
  assert.equal(second.holder, '________');
  assert.equal(reservations.status().count, 0);
});

test('mine validates the target and returns an honest empty result for an unknown block', async () => {
  const { createRuntime } = require('../src/runtime');
  const runtime = await createRuntime({ simulate: true, dashboard: false, connect: false });
  try {
    const unknown = await runtime.commands.execute('mine nonsense', { source: 'cli' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.result.code, 'COMMAND_ERROR');
    assert.match(unknown.result.error, /unknown mineable target/);
    const dirt = await runtime.commands.execute('mine dirt', { source: 'cli' });
    assert.equal(dirt.ok, true, JSON.stringify(dirt.result).slice(0, 800));
    assert.equal(dirt.result.verified, true);
  } finally {
    await runtime.shutdown('test');
  }
});

test('the dashboard can stop mining for one bot without touching the fleet', async () => {
  const { createRuntime } = require('../src/runtime');
  const runtime = await createRuntime({ simulate: true, dashboard: false, connect: false });
  try {
    const target = [...runtime.services.bots.keys()][0];
    const stopped = await runtime.commands.execute(`mine ${target} stop`, { source: 'cli' });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.result || stopped).slice(0, 500));
    assert.equal(stopped.result.stopped, true);
    assert.equal(stopped.result.bot, target);
    const status = runtime.services.actions.get(target).mining.status();
    assert.equal(status.stopped, true);
  } finally {
    await runtime.shutdown('test');
  }
});
