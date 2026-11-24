'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createRuntime } = require('../src/runtime');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { InventoryManager } = require('../src/actions/inventory');
const { BotActions } = require('../src/actions');
const { TaskBoard } = require('../src/team/taskBoard');
const { ResourceLedger } = require('../src/team/resourceLedger');

function fullResourceInventory() {
  // 4 protected stacks + 1 plank stack + 27 cobblestone stacks + 4 dirt stacks
  // = exactly 36 storage slots, but only six distinct item names.
  return {
    iron_pickaxe: 1,
    iron_axe: 1,
    bread: 16,
    torch: 32,
    oak_planks: 16,
    cobblestone: 64 * 27,
    dirt: 64 * 4
  };
}

test('inventory fullness is measured in slots, not distinct item types', () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '10101000', world, inventory: { cobblestone: 64 * 20, dirt: 64 * 16 }, position: { x: 0, y: 65, z: 0 } });
  assert.equal(bot.distinctItems(), 2);
  assert.deepEqual(bot.inventorySlots(), { used: 36, free: 0, capacity: 36, overflow: 0 });
  assert.equal(bot.isInventoryFull(), true);

  const partlyFull = new MockBot({ name: '01010100', world, inventory: { cobblestone: 64 * 34, dirt: 63 }, position: { x: 0, y: 65, z: 0 } });
  assert.equal(partlyFull.isInventoryFull(), false);
  assert.equal(partlyFull.inventorySlots().used, 35, 'the 63 dirt still occupies its own slot');
});

test('a full resource bot crafts and places a double chest at home, keeps gear, and returns to work', async () => {
  const world = new MockWorld({ flat: true });
  const home = { x: 0, y: world.surfaceY(0, 2) + 1, z: 2 };
  const bot = new MockBot({ name: '10101000', world, inventory: fullResourceInventory(), position: { x: 18, y: home.y, z: 18 } });
  const ledger = new ResourceLedger({ now: () => 1000 });
  const inventory = new InventoryManager({ bot, ledger, home });
  const workSite = { x: 18, y: home.y, z: 18 };

  const report = await inventory.makeRoomAtHome({ home, resumeAt: workSite, reason: 'test mining trip' });

  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.doubleChest, true);
  assert.equal(report.placed.length, 2);
  assert.equal(report.crafted.length, 1);
  assert.equal(report.crafted[0].item, 'chest');
  assert.deepEqual(report.dropped, [], 'crafting 16 planks frees a slot, so nothing is discarded');

  const pair = inventory._findDoubleChest(home);
  assert.ok(pair, 'both chest halves must exist in the world');
  assert.equal(Math.abs(pair[0].x - pair[1].x) + Math.abs(pair[0].z - pair[1].z), 1);
  assert.equal(bot.getBlock(pair[0]).name, 'chest');
  assert.equal(bot.getBlock(pair[1]).name, 'chest');

  // Tools, food and light stay with the bot; bulk resources are in the chest.
  assert.equal(bot.countItem('iron_pickaxe'), 1);
  assert.equal(bot.countItem('iron_axe'), 1);
  assert.equal(bot.countItem('bread'), 16);
  assert.equal(bot.countItem('torch'), 32);
  assert.equal(bot.countItem('cobblestone'), 0);
  assert.equal(bot.countItem('dirt'), 0);
  assert.equal(bot.countItem('oak_planks'), 0);
  assert.ok(bot.inventorySlots().free > 0);

  const window = await bot.openContainer(pair[0]);
  const contents = window.items();
  await window.close();
  assert.equal(contents.cobblestone, 64 * 27);
  assert.equal(contents.dirt, 64 * 4);

  const stored = [...ledger.storages.values()];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].counts.cobblestone, 64 * 27);
  assert.equal(inventory.homeStorage.capacity, 54);
  assert.equal(report.resumed, true);
  assert.ok(Math.hypot(bot.position.x - workSite.x, bot.position.z - workSite.z) < 4, 'bot walks back to the work site');
});

test('an overflow run before a resource task keeps the assignment and resumes it next tick', async () => {
  const world = new MockWorld({ flat: true });
  const home = { x: 0, y: world.surfaceY(0, 2) + 1, z: 2 };
  const bot = new MockBot({ name: '10101000', world, inventory: fullResourceInventory(), position: { x: 20, y: home.y, z: 20 } });
  const board = new TaskBoard({ now: () => Date.now() });
  const actions = new BotActions({ bot, taskBoard: board, home, ledger: new ResourceLedger({ now: () => 1000 }) });
  const task = board.addTask({ type: 'MINE_BLOCK', params: { block: 'stone' }, units: { target: 10 } }).task;
  assert.equal(board.claim(task.id, bot.name).ok, true);
  let cleared = false;
  const coordinator = {
    getAssignment: () => ({ taskId: task.id }),
    clearAssignment: () => { cleared = true; }
  };
  let performed = 0;
  actions.performTask = async () => { performed++; return { ok: true, verified: true, quantity: 10, mined: 10 }; };

  const first = await actions.step({ coordinator });
  assert.equal(first.storing, true);
  assert.equal(first.pending, true);
  assert.equal(first.storage.ok, true);
  assert.equal(performed, 0, 'the tick is spent making storage, not mining');
  assert.equal(cleared, false, 'the assignment must survive the storage run');
  assert.equal(board.getTask(task.id).status, 'ACTIVE');
  assert.equal(board.getTask(task.id).claimedBy, bot.name);

  const second = await actions.step({ coordinator });
  assert.equal(performed, 1, 'the same assignment resumes after storage');
  assert.equal(second.verified, true);
  assert.equal(board.getTask(task.id).status, 'COMPLETED');
  assert.equal(cleared, true);
});

test('a non-full inventory is a no-op for home storage', async () => {
  const world = new MockWorld({ flat: true });
  const home = { x: 0, y: world.surfaceY(0, 0) + 1, z: 0 };
  const bot = new MockBot({ name: '10101000', world, inventory: { iron_pickaxe: 1, cobblestone: 3 }, position: home });
  const inventory = new InventoryManager({ bot, home });
  const result = await inventory.makeRoomAtHome({ home });
  assert.equal(result.attempted, false);
  assert.equal(result.ok, true);
  assert.equal(inventory._chestsNear(home).length, 0);
});

test('home is anchored to the team spawn point and survives reconnects', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  const spawns = [...runtime.bots.values()].map((bot) => bot.position);
  assert.ok(spawns.every((position) => position.z === 2));
  assert.equal(runtime.homeSource, 'spawn');
  assert.equal(runtime.home.z, 2, 'home uses the actual spawn row, not a hardcoded z=0');
  assert.equal(runtime.home.y, spawns[0].y);
  assert.deepEqual(runtime.memory.getHome().position, runtime.home);

  const anchored = { ...runtime.home };
  const bot = runtime.bots.values().next().value;
  bot.spawnPosition = { x: 40, y: 70, z: 40 };
  assert.equal(runtime._anchorHomeToSpawn(bot), false, 'a later respawn must not move home');
  assert.deepEqual(runtime.home, anchored);

  runtime.setHome({ x: 8, y: anchored.y, z: 8 });
  assert.equal(runtime.homeSource, 'operator');
  assert.equal(runtime.home.x, 8);
  assert.equal(runtime.home.z, 8);
  assert.deepEqual(runtime.memory.getHome().position, runtime.home);
});

test('an existing single home chest is extended into a real double chest', async () => {
  const world = new MockWorld({ flat: true });
  const home = { x: 0, y: world.surfaceY(0, 2) + 1, z: 2 };
  const anchor = { x: 2, y: home.y, z: 2 };
  world.setBlock(anchor, 'chest', {});
  const bot = new MockBot({ name: '10101000', world, inventory: fullResourceInventory(), position: { x: 16, y: home.y, z: 16 } });
  const ledger = new ResourceLedger({ now: () => 1000 });
  const inventory = new InventoryManager({ bot, ledger, home });

  const report = await inventory.makeRoomAtHome({ home, resumeAt: { x: 16, y: home.y, z: 16 } });

  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.doubleChest, true);
  assert.equal(report.placed.length, 1, 'only the missing half needs placing');
  assert.ok(report.preDeposit && report.preDeposit.moved > 0, 'the existing chest frees inventory room first');
  const pair = inventory._findDoubleChest(home);
  assert.ok(pair);
  assert.ok(pair.some((half) => half.x === anchor.x && half.z === anchor.z));
  const window = await bot.openContainer(anchor);
  const contents = window.items();
  await window.close();
  assert.equal(contents.cobblestone, 64 * 27);
  assert.equal(bot.countItem('oak_planks'), 0);
  assert.equal(bot.countItem('iron_pickaxe'), 1);
});
