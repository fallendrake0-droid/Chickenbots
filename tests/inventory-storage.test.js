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
