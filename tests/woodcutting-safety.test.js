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
    getBlock: (pos) => (pos.y === 64 && pos.x === 0 && pos.z === 0 ? { name: 'oak_log' } : null),
    goTo: async () => ({ ok: false, error: 'path blocked' })
  });
  const controller = new WoodcuttingController({ bot });
  const result = await controller.chopTree({ x: 0, y: 64, z: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.match(result.error, /path blocked/);
});
