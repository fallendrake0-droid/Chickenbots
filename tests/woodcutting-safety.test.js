'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WoodcuttingController } = require('../src/actions/woodcutting');

function fakeBot(overrides = {}) {
  return {
    name: '10101000',
    position: { x: 0, y: 64, z: 0 },
    inventory: { oak_log: 2 },
    health: 20,
    getBlock: () => null,
    bestToolFor: () => null,
    countItem: () => 0,
    goTo: async () => ({ ok: true }),
    digBlock: async () => ({ ok: true }),
    collectDrops: async () => {},
    ...overrides
  };
}

test('a null block read cannot crash chopping', async () => {
  const controller = new WoodcuttingController({ bot: fakeBot() });
  const result = await controller.chopTree({ x: 0, y: 64, z: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /no block/);
  assert.equal(controller.stats.treesChopped, 0);
});

test('failed digs are not recorded as a harvested tree or memory observation', async () => {
  const observations = [];
  const bot = fakeBot({
    getBlock: (pos) => (pos.y === 64 ? { name: 'oak_log' } : null),
    digBlock: async () => ({ ok: false, error: 'too far' })
  });
  const controller = new WoodcuttingController({ bot, memory: { observe: (o) => observations.push(o) } });
  const result = await controller.chopTree({ x: 0, y: 64, z: 0 });
  assert.equal(result.ok, false);
  assert.equal(controller.stats.treesChopped, 0);
  assert.equal(observations.length, 0);
});


test('a navigation failure is reported instead of silently truncating the tree', async () => {
  const bot = fakeBot({
    // The trunk is outside mining reach, so the controller must path to it.
    position: { x: 10, y: 64, z: 0 },
    getBlock: (pos) => (pos.y === 64 && pos.x === 0 && pos.z === 0 ? { name: 'oak_log' } : null),
    goTo: async () => ({ ok: false, error: 'path blocked' })
  });
  const controller = new WoodcuttingController({ bot });
  const result = await controller.chopTree({ x: 0, y: 64, z: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.match(result.error, /path blocked/);
});

test('chopping starts at the base, so a tall trunk yields reachable logs instead of failing at the crown', async () => {
  const dug = new Set();
  const logs = new Map();
  for (let y = 64; y <= 73; y++) logs.set(`${0},${y},0`, 'oak_log');
  const bot = fakeBot({
    position: { x: 0, y: 64, z: 0 },
    getBlock: (pos) => {
      if (dug.has(`${pos.x},${pos.y},${pos.z}`)) return { name: 'air' };
      const name = logs.get(`${pos.x},${pos.y},${pos.z}`);
      return name ? { name } : null;
    },
    digBlock: async (pos) => { dug.add(`${pos.x},${pos.y},${pos.z}`); return { ok: true }; },
    goTo: async (target) => (target.y > 70 ? { ok: false, error: 'above reach' } : { ok: true })
  });
  const controller = new WoodcuttingController({ bot });
  const result = await controller.chopTree({ x: 0, y: 64, z: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.chopped, 6, 'the six logs inside mining reach were removed');
  assert.equal(result.partial, true);
  for (let y = 64; y <= 69; y++) assert.equal(bot.getBlock({ x: 0, y, z: 0 }).name, 'air');
  assert.equal(bot.getBlock({ x: 0, y: 70, z: 0 }).name, 'oak_log');
});

test('a truncated scan still chops the whole trunk from a middle log', async () => {
  const { MockWorld } = require('../src/bot/mockWorld');
  const { MockBot } = require('../src/bot/mockBot');
  const world = new MockWorld({ flat: true, seed: 904 });
  for (let y = 64; y <= 67; y++) world.setBlock({ x: 4, y, z: 0 }, 'oak_log');
  const bot = new MockBot({ name: '10101000', world, inventory: { iron_axe: 1 }, position: { x: 0, y: 65, z: 0 } });
  const controller = new WoodcuttingController({ bot });
  // y=66 is what a scan that ran out of budget might have found first.
  const result = await controller.chopTree({ x: 4, y: 66, z: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.chopped, 4, JSON.stringify(result));
  for (let y = 64; y <= 67; y++) assert.notEqual(world.getBlock({ x: 4, y, z: 0 }).name, 'oak_log');
});

test('tick widens the search to 48 blocks before reporting no trees', async () => {
  const { MockWorld } = require('../src/bot/mockWorld');
  const { MockBot } = require('../src/bot/mockBot');
  const world = new MockWorld({ flat: true, seed: 902 });
  for (let y = 64; y <= 67; y++) world.setBlock({ x: 30, y, z: 0 }, 'oak_log');
  world.setBlock({ x: 30, y: 63, z: 0 }, 'dirt');
  const bot = new MockBot({ name: '10101000', world, inventory: { iron_axe: 1, oak_sapling: 2 }, position: { x: 0, y: 65, z: 0 } });
  const controller = new WoodcuttingController({ bot });
  assert.equal(controller.findTrees({ radius: 24 }).length, 0);
  const result = await controller.tick({ maxTrees: 1, types: 'oak' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.searchedRadius, 48);
  assert.equal(result.results.reduce((sum, row) => sum + row.chopped, 0), 4);
});

test('relocate walks to a fresh forest site and reports it honestly when no tree is found', async () => {
  const { MockWorld } = require('../src/bot/mockWorld');
  const { MockBot } = require('../src/bot/mockBot');
  const world = new MockWorld({ flat: true, seed: 903 });
  const bot = new MockBot({ name: '10101000', world, inventory: { iron_axe: 1 }, position: { x: 0, y: 65, z: 0 } });
  const controller = new WoodcuttingController({ bot });
  const result = await controller.tick({ relocate: true, maxRelocations: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.idle, true);
  assert.equal(result.relocations.length, 1);
  assert.equal(result.relocations[0].ok, true);
  assert.equal(result.relocations[0].moved, true);
  assert.match(result.reason, /fresh forest/);
  assert.ok(Math.hypot(bot.position.x, bot.position.z) > 20, 'the bot actually moved away from its old site');
});
