'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InventoryManager } = require('../src/actions/inventory');
const { ResourceLedger } = require('../src/team/resourceLedger');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');

test('a stored bed is withdrawn and verified before PLACE_BED can use it', async () => {
  const world = new MockWorld({ flat: true, seed: 77 });
  const surface = world.surfaceY(2, 0) + 1;
  const chest = { x: 2, y: surface, z: 0 };
  world.setBlock(chest, 'chest');
  const bot = new MockBot({ name: '10101000', world, inventory: {}, position: { x: 0, y: surface, z: 0 } });
  bot.containers.set(bot._chestStorageKey(chest), { white_bed: 2 });
  const ledger = new ResourceLedger();
  ledger.updateStorage('home:test', { position: chest, counts: { white_bed: 2 } });
  const inventory = new InventoryManager({ bot, ledger, home: { x: 0, y: surface, z: 0 } });
  assert.equal(bot.hasBed(), null);
  const acquired = await inventory.ensureBedFromStorage();
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  assert.equal(acquired.item, 'white_bed');
  assert.equal(acquired.source, 'home storage');
  assert.equal(bot.countItem('white_bed'), 1);
  assert.equal(bot.hasBed(), 'white_bed');
  assert.equal(ledger.storages.get('home:test').counts.white_bed, 1, 'the ledger reflects the withdrawal');
});

test('a bed is withdrawn from any registered storage, not only the nearest chest', async () => {
  const world = new MockWorld({ flat: true, seed: 77 });
  const surface = world.surfaceY(0, 0) + 1;
  const near = { x: 2, y: surface, z: 0 };
  const far = { x: 9, y: surface, z: 0 };
  world.setBlock(near, 'chest');
  world.setBlock(far, 'chest');
  const bot = new MockBot({ name: '10101000', world, inventory: {}, position: { x: 0, y: surface, z: 0 } });
  bot.containers.set(bot._chestStorageKey(near), { cobblestone: 32 });
  bot.containers.set(bot._chestStorageKey(far), { white_bed: 1 });
  const ledger = new ResourceLedger();
  ledger.updateStorage('near:empty', { position: near, counts: { cobblestone: 32 } });
  ledger.updateStorage('far:beds', { position: far, counts: { white_bed: 1 } });
  const inventory = new InventoryManager({ bot, ledger, home: { x: 0, y: surface, z: 0 } });

  const acquired = await inventory.ensureBedFromStorage();

  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  assert.equal(acquired.storage.x, far.x, 'the chest that actually holds a bed is searched');
  assert.equal(acquired.source, 'home storage');
  assert.equal(bot.countItem('white_bed'), 1);
  assert.equal(ledger.storages.get('far:beds').counts.white_bed, undefined);
  assert.equal(ledger.storages.get('near:empty').counts.cobblestone, 32, 'the empty chest keeps its contents');
});

test('a container inside Minecraft reach still accepts a deposit after a short arrival', async () => {
  const world = new MockWorld({ flat: true, seed: 77 });
  const surface = world.surfaceY(0, 0) + 1;
  const chest = { x: 2, y: surface, z: 0 };
  world.setBlock(chest, 'chest');
  const bot = new MockBot({ name: '10101000', world, inventory: { cobblestone: 5 }, position: { x: 0, y: surface, z: 0 } });
  const ledger = new ResourceLedger();
  ledger.updateStorage('home:test', { position: chest, counts: {} });
  const inventory = new InventoryManager({ bot, ledger, home: { x: 0, y: surface, z: 0 } });

  bot.goTo = async () => ({
    ok: false,
    code: 'ARRIVAL_UNVERIFIED',
    error: 'pathfinder reported success but the bot is not within 3 blocks of the destination',
    position: { ...bot.position }
  });

  const result = await inventory.deposit('cobblestone', 5);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.count, 5);
  assert.equal(bot.countItem('cobblestone'), 0);
  const window = await bot.openContainer(chest);
  assert.equal(window.items().cobblestone, 5);
  await window.close();
});
