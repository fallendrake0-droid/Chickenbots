'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RealBot } = require('../src/bot/realBot');

function position(x, y, z) {
  return { x, y, z, toFixed: () => String(x) };
}

function makeReal({ inventory = {}, blocks = {}, container = null } = {}) {
  const counts = { ...inventory };
  const blockMap = new Map();
  for (const [key, name] of Object.entries(blocks)) blockMap.set(key, { name });
  const fake = {
    version: '1.21.4',
    world: {},
    entity: { position: position(0, 64, 0), yaw: 0, pitch: 0 },
    inventory: {
      items: () => Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count, type: 1, durabilityUsed: 0, maxDurability: 0, enchants: [] })),
      slots: []
    },
    blockAt: (vec) => {
      const key = `${vec.x},${vec.y},${vec.z}`;
      if (!blockMap.has(key)) return null;
      const found = blockMap.get(key);
      return {
        name: found.name,
        diggable: found.diggable !== false,
        boundingBox: found.boundingBox || 'block',
        position: { x: vec.x, y: vec.y, z: vec.z },
        getProperties: () => ({})
      };
    },
    equip: async () => {},
    dig: async () => {},
    placeBlock: async () => {},
    openContainer: async () => container || { containerItems: () => [], withdraw: async () => {}, deposit: async () => {}, close: () => {} },
    recipesFor: () => [{}],
    craft: async () => {}
  };
  fake.inventory.slots = [];
  const real = new RealBot({ name: '________', authProfile: 'none', authEnabled: false });
  real.bot = fake;
  real.connected = true;
  real.spawned = true;
  real.authenticated = true;
  real.position = { x: 0, y: 64, z: 0 };
  real._syncInventory();
  return { real, fake, counts, blockMap };
}

test('block cache uses one normalized key and never caches an unloaded block', () => {
  let reads = 0;
  const { real, fake } = makeReal();
  fake.blockAt = (vec) => {
    reads++;
    return { name: `block-${vec.x}-${vec.y}-${vec.z}`, getProperties: () => ({}), position: vec };
  };
  assert.equal(real._blockAt({ x: 1.8, y: 64.2, z: -2.7 }).name, 'block-1-64--3');
  assert.equal(real._blockAt({ x: 1.1, y: 64.9, z: -2.2 }).name, 'block-1-64--3');
  assert.equal(reads, 1, 'fractional coordinates must share the floor key');
  assert.equal(real._invalidateBlock({ x: 1.2, y: 64.8, z: -2.1 }), true);
  real._blockAt({ x: 1.5, y: 64.1, z: -2.9 });
  assert.equal(reads, 2, 'invalidation must delete the same normalized key');

  fake.blockAt = () => null;
  assert.equal(real._blockAt({ x: 9, y: 60, z: 9 }), null);
  assert.equal(real._blockAt({ x: 9.9, y: 60.9, z: 9.9 }), null);
  assert.equal(real._blockCache.size, 1, 'a miss must not become a permanent cached null');
});

test('digBlock reports only confirmed removal and the measured inventory drops', async () => {
  const { real, fake, counts, blockMap } = makeReal({
    blocks: { '2,64,0': 'oak_log' },
    inventory: { stone_pickaxe: 1 }
  });
  fake.dig = async () => {
    blockMap.set('2,64,0', { name: 'air' });
    counts.oak_log = (counts.oak_log || 0) + 1;
  };
  const result = await real.digBlock({ x: 2, y: 64, z: 0 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.block, 'oak_log');
  assert.deepEqual(result.drops, { oak_log: 1 });
  assert.equal(result.dropCount, 1);
  assert.equal(real.stats.dug, 1);
});

test('digBlock rejects a dig the server did not confirm', async () => {
  const { real, fake } = makeReal({ blocks: { '2,64,0': 'oak_log' }, inventory: {} });
  fake.dig = async () => {};
  const result = await real.digBlock({ x: 2, y: 64, z: 0 }, { timeoutMs: 400 });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not confirm/i);
  assert.equal(real.stats.dug, 0);
});

test('placeBlock distinguishes an already-correct block from an occupied space and verifies placement', async () => {
  const { real, fake, blockMap } = makeReal({
    blocks: { '0,63,0': 'stone', '2,64,0': 'dirt', '4,63,0': 'stone', '4,64,0': 'air' },
    inventory: {
      stone: 8,
      cobblestone: 8,
      dirt: 1
    }
  });
  const occupied = await real.placeBlock({ x: 2, y: 64, z: 0 }, 'cobblestone');
  assert.equal(occupied.ok, false);
  assert.match(occupied.error, /space occupied/);
  const present = await real.placeBlock({ x: 2, y: 64, z: 0 }, 'dirt');
  assert.equal(present.ok, true);
  assert.equal(present.alreadyPresent, true);

  fake.placeBlock = async () => {
    blockMap.set('4,64,0', { name: 'cobblestone' });
  };
  const placed = await real.placeBlock({ x: 4, y: 64, z: 0 }, 'cobblestone');
  assert.equal(placed.ok, true, placed.error);
  assert.equal(placed.block, 'cobblestone');
  assert.equal(placed.verified, true);
});

test('openContainer measures transfers instead of echoing the requested count', async () => {
  const contents = { cobblestone: 4 };
  let closed = false;
  const window = {
    containerItems: () => {
      if (closed) throw new Error('window closed');
      return Object.entries(contents).map(([name, count]) => ({ name, count, type: 1 }));
    },
    withdraw: async () => {},
    deposit: async () => {},
    close: () => { closed = true; }
  };
  const { real, counts } = makeReal({ blocks: { '0,63,0': 'chest' }, container: window });
  const container = await real.openContainer({ x: 0, y: 63, z: 0 });
  assert.equal(container.ok, true, container.error);
  const failed = await container.withdraw('cobblestone', 2);
  assert.equal(failed.ok, false);
  assert.equal(failed.count, 0);

  window.withdraw = async (type, meta, take) => {
    contents.cobblestone -= take;
    if (contents.cobblestone <= 0) delete contents.cobblestone;
    counts.cobblestone = (counts.cobblestone || 0) + take;
  };
  const taken = await container.withdraw('cobblestone', 2);
  assert.equal(taken.ok, true, taken.error);
  assert.equal(taken.count, 2);
  assert.equal(counts.cobblestone, 2);
  const snapshot = container.items();
  await container.close();
  assert.deepEqual(container.items(), snapshot, 'the last container snapshot must survive close');
  assert.equal((await container.withdraw('cobblestone', 1)).ok, false);
});

test('craft reports the measured output and collectDrops never counts a path as a pickup', async () => {
  const { real, fake, counts } = makeReal({ inventory: { oak_planks: 4 } });
  const noOutput = await real.craft('stick', 1);
  assert.equal(noOutput.ok, false);
  assert.match(noOutput.error, /did not confirm/i);

  fake.craft = async () => { counts.stick = (counts.stick || 0) + 4; };
  const crafted = await real.craft('stick', 1);
  assert.equal(crafted.ok, true, crafted.error);
  assert.equal(crafted.count, 4);

  fake.entities = { item1: { id: 'item1', name: 'item', position: position(1, 64, 0) } };
  real.goTo = async () => ({ ok: true });
  const missed = await real.collectDrops(8);
  assert.equal(missed.ok, false);
  assert.match(missed.error, /no dropped item/i);
  assert.equal(missed.collected, 0);

  real.goTo = async () => {
    counts.oak_log = (counts.oak_log || 0) + 1;
    return { ok: true };
  };
  const picked = await real.collectDrops(8);
  assert.equal(picked.ok, true, picked.error);
  assert.equal(picked.collected, 1);
  assert.deepEqual(picked.items, { oak_log: 1 });
});

test('smelt only reports output that actually reached the inventory', async () => {
  const { real, fake, counts } = makeReal({ inventory: { coal: 2, raw_iron: 2 } });
  fake.findBlock = () => ({ name: 'furnace', position: position(1, 64, 0) });
  fake.openFurnace = async () => ({
    putInput: async () => {},
    putFuel: async () => {},
    outputItem: () => ({ name: 'iron_ingot', count: 1 }),
    takeOutput: async () => { counts.iron_ingot = (counts.iron_ingot || 0) + 1; },
    close: () => {}
  });
  const result = await real.smelt('raw_iron', 1);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.count, 1);
  assert.deepEqual(result.produced, { iron_ingot: 1 });

  fake.openFurnace = async () => ({
    putInput: async () => {},
    putFuel: async () => {},
    outputItem: () => null,
    takeOutput: async () => {},
    close: () => {}
  });
  const empty = await real.smelt('raw_iron', 1);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /produced no output/i);
});

test('armour and hand equips surface server failures instead of swallowing them', async () => {
  const { real, fake } = makeReal({ inventory: { iron_helmet: 1, iron_boots: 1, diamond_sword: 1 } });
  fake.equip = async (item, destination) => {
    if (item.name === 'iron_boots' || destination === 'hand') throw new Error('slot unavailable');
  };
  const armour = await real.equipArmor([{ name: 'iron_helmet', slot: 'head' }, { name: 'iron_boots', slot: 'feet' }]);
  assert.equal(armour.ok, true);
  assert.deepEqual(armour.pieces, ['iron_helmet']);
  assert.deepEqual(armour.failed, [{ item: 'iron_boots', error: 'slot unavailable' }]);

  const missing = await real.equipArmor([{ name: 'diamond_helmet', slot: 'head' }]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not in inventory/);

  const hand = await real.equipItem('diamond_sword');
  assert.equal(hand.ok, false);
  assert.match(hand.error, /slot unavailable/);
});

test('water buckets verify the fluid they actually create', async () => {
  const { real, fake, blockMap } = makeReal({
    blocks: { '5,63,0': 'stone', '5,64,0': 'air' },
    inventory: { water_bucket: 1 }
  });
  fake.placeBlock = async () => { blockMap.set('5,64,0', { name: 'water' }); };
  const result = await real.placeBlock({ x: 5, y: 64, z: 0 }, 'water_bucket');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.block, 'water');
  assert.equal(result.verified, true);
});
