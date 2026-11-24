'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { config, BOT_NAMES } = require('../src/config');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { TaskBoard } = require('../src/team/taskBoard');
const { TeamMemory } = require('../src/team/teamMemory');
const { ResourceLedger } = require('../src/team/resourceLedger');
const { SurvivalController } = require('../src/actions/survival');
const { CombatController } = require('../src/actions/combat');
const { MiningController } = require('../src/actions/mining');
const { WoodcuttingController } = require('../src/actions/woodcutting');
const { FarmingController } = require('../src/actions/farming');
const { SleepController } = require('../src/actions/sleep');
const { ExplorationController } = require('../src/actions/exploration');
const { InventoryManager } = require('../src/actions/inventory');

function flatBot(name = '________', inventory = {}, y = 64) {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name, world, inventory });
  bot.position = { x: 0, y, z: 0 };
  return { bot, world };
}

test('configuration preserves the five usernames, server defaults and safety switches', () => {
  assert.deepEqual(config.team.names, ['________', '10101000', '01010100', '11001100', '00110000']);
  assert.deepEqual(BOT_NAMES, config.team.names);
  assert.equal(config.server.host, 'cr3xlol.aternos.me');
  assert.equal(config.server.port, 55742);
  assert.equal(config.server.version, 'auto');
  assert.equal(config.dashboard.port, 3000);
  assert.equal(config.dashboard.host, '0.0.0.0');
  assert.equal(config.autonomy.pvp, false);
  assert.equal(config.autonomy.ai.enabled, false);
  assert.equal(config.autonomy.ai.apiKey, '');
  assert.ok(config.team.requireSpawnBeforeAutonomy);
});

test('survival eats real food, heals and equips armour', async () => {
  const { bot } = flatBot('________', { bread: 4, golden_apple: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 });
  bot.food = 6;
  bot.health = 6;
  const survival = new SurvivalController({ bot });
  const result = await survival.tick();
  assert.ok(result.actions.some((a) => a.action === 'eat'));
  assert.ok(bot.food > 6);
  assert.ok(result.actions.some((a) => a.action === 'emergency-heal'));
  assert.equal(bot.countItem('golden_apple'), 0);
  assert.ok(survival.stats.armourEquipped >= 4);
  const status = survival.status();
  assert.equal(status.armour > 0, true);
});

test('survival routines are real per-bot toggles and safety stays enforced', async () => {
  const { bot } = flatBot('01010100', { bread: 4 });
  bot.food = 5;
  const survival = new SurvivalController({ bot });
  assert.equal(survival.status().features.eat, true);
  const disabled = survival.setFeature('eat', false);
  assert.equal(disabled.ok, true);
  assert.equal(survival.status().features.eat, false);
  const skipped = await survival.tick();
  assert.ok(!skipped.actions.some((action) => action.action === 'eat'));
  assert.equal(bot.food, 5);
  const invalid = survival.setFeature('teleport', true);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.available.includes('eat'));
  survival.setFeature('eat', true);
  const enabled = await survival.tick();
  assert.ok(enabled.actions.some((action) => action.action === 'eat'));
  assert.ok(bot.food > 5);
});

test('survival refuses to pretend it ate without food and crafts a tool when able', async () => {
  const { bot } = flatBot('10101000', { cobblestone: 6, stick: 4 });
  bot.food = 4;
  const survival = new SurvivalController({ bot });
  const eat = await survival.eat();
  assert.equal(eat.ok, false);
  assert.ok(eat.error.includes('no food'));
  const tool = await survival.ensureTool();
  assert.ok(tool);
  assert.equal(tool.ok, true);
  assert.ok(bot.countItem('stone_pickaxe') >= 1);
  assert.equal(bot.countItem('cobblestone'), 3);
});

test('lava clutch places water instead of dying', async () => {
  const { bot, world } = flatBot('01010100', { water_bucket: 1 });
  bot.inLava = true;
  const survival = new SurvivalController({ bot });
  const result = await survival.clutch();
  assert.ok(result);
  assert.equal(result.kind, 'water');
  assert.ok(['water'].includes(world.getBlock({ x: 0, y: 64, z: 0 }).name) || world.getBlock({ x: 0, y: 63, z: 0 }).name === 'water');
  assert.equal(survival.stats.clutches, 1);
});

test('combat kills hostile mobs, never teammates or players, and retreats when hurt', async () => {
  const { bot, world } = flatBot('11001100', { iron_sword: 1, shield: 1 });
  const zombie = world.addMob('zombie', { x: 2, y: 64, z: 0 });
  const combat = new CombatController({ bot });
  const defended = await combat.defend({ maxAttacks: 6 });
  assert.equal(defended.ok, true);
  assert.ok(defended.results.some((r) => r.action === 'attack' && r.ok));
  assert.equal(world.entities.length, 0);
  assert.equal(combat.stats.kills, 1);

  const teammate = world.addMob('________', { x: 1, y: 64, z: 0 });
  const refused = await combat.attackEntity(teammate);
  assert.equal(refused.ok, false);
  assert.ok(refused.error.includes('teammates'));

  const player = { name: 'SomePlayer', username: 'SomePlayer', type: 'player', position: { x: 1, y: 64, z: 0 }, health: 20 };
  const pvp = await combat.attackEntity(player);
  assert.equal(pvp.ok, false);
  assert.ok(/PvP|players/.test(pvp.error));

  const cow = world.addMob('cow', { x: 1, y: 64, z: 0 });
  const animal = await combat.attackEntity(cow);
  assert.equal(animal.ok, false, 'ordinary animals are not combat targets');

  const second = flatBot('00110000', { iron_sword: 1 });
  second.world.addMob('zombie', { x: 2, y: 64, z: 0 });
  second.bot.health = 5;
  const hurt = new CombatController({ bot: second.bot });
  const retreat = await hurt.defend({ maxAttacks: 2 });
  assert.equal(retreat.action, 'retreat');
  assert.ok(hurt.stats.retreats >= 1);
});

test('mining respects tool tiers, hazards and removes a real ore', async () => {
  const { bot, world } = flatBot('________', { iron_pickaxe: 1, stone_pickaxe: 1, torch: 8 });
  const orePos = { x: 2, y: 64, z: 2 };
  world.setBlock(orePos, 'diamond_ore');
  const mining = new MiningController({ bot });
  const safety = mining.checkSafety(orePos);
  assert.equal(safety.safe, true);
  const mined = await mining.mineOre(orePos);
  assert.equal(mined.ok, true, mined.error);
  assert.equal(world.getBlock(orePos).name, 'air');
  assert.equal(mining.stats.oresMined, 1);

  world.setBlock({ x: -2, y: 64, z: -2 }, 'diamond_ore');
  const poor = flatBot('10101000', { stone_pickaxe: 1 });
  poor.world.setBlock({ x: 2, y: 64, z: 2 }, 'diamond_ore');
  const weakMining = new MiningController({ bot: poor.bot });
  const denied = await weakMining.mineOre({ x: 2, y: 64, z: 2 });
  assert.equal(denied.ok, false);
  assert.ok(denied.error.includes('tier'));

  const lavaOre = { x: 4, y: 64, z: 4 };
  world.setBlock(lavaOre, 'iron_ore');
  world.setBlock({ x: 4, y: 63, z: 4 }, 'lava');
  const unsafe = await mining.mineOre(lavaOre);
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.hazards.some((h) => h.block === 'lava'));
  assert.equal(world.getBlock(lavaOre).name, 'iron_ore');
  assert.ok(mining.stats.hazardsAvoided >= 1);
});

test('woodcutting chops a real tree and replants a sapling', async () => {
  const { bot, world } = flatBot('01010100', { iron_axe: 1, oak_sapling: 2 }, 65);
  for (let y = 64; y <= 67; y++) world.setBlock({ x: 3, y, z: 3 }, 'oak_log');
  world.setBlock({ x: 3, y: 63, z: 3 }, 'dirt');
  world.setBlock({ x: 3, y: 68, z: 3 }, 'oak_leaves');
  const wood = new WoodcuttingController({ bot });
  const trees = wood.findTrees({ radius: 12 });
  assert.equal(trees.length, 1);
  const result = await wood.chopTree({ x: 3, y: 64, z: 3 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.chopped, 4);
  assert.equal(world.getBlock({ x: 3, y: 65, z: 3 }).name, 'air');
  assert.equal(world.getBlock({ x: 3, y: 68, z: 3 }).name, 'air');
  assert.equal(result.replanted, true);
  assert.equal(world.getBlock({ x: 3, y: 64, z: 3 }).name, 'oak_sapling');
  assert.equal(wood.stats.treesChopped, 1);
  assert.equal(wood.stats.replanted, 1);
});

test('farming harvests crops and replants seeds', async () => {
  const { bot, world } = flatBot('00110000', { wheat_seeds: 4 }, 65);
  world.setBlock({ x: 2, y: 64, z: 2 }, 'farmland');
  world.setBlock({ x: 2, y: 65, z: 2 }, 'wheat');
  const farming = new FarmingController({ bot });
  const result = await farming.harvest({ x: 2, y: 65, z: 2 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.replanted, true);
  assert.equal(world.getBlock({ x: 2, y: 65, z: 2 }).name, 'wheat_seeds');
  assert.ok(bot.countItem('wheat') >= 1);
  assert.equal(farming.stats.harvested, 1);
});

test('sleep requires night, reserves beds and rejects double reservation', async () => {
  const world = new MockWorld({ flat: true });
  const a = new MockBot({ name: '________', world });
  const b = new MockBot({ name: '10101000', world });
  world.setBlock({ x: 2, y: 64, z: 0 }, 'white_bed');
  world.setTime(14000);
  const board = new TaskBoard();
  const memory = new TeamMemory();
  const sleepA = new SleepController({ bot: a, memory, taskBoard: board });
  const sleepB = new SleepController({ bot: b, memory, taskBoard: board });
  const dayRefused = await (async () => { world.setTime(1000); const r = await sleepA.sleep(); world.setTime(14000); return r; })();
  assert.equal(dayRefused.ok, false);
  assert.ok(dayRefused.error.includes('night'));
  const reserved = sleepA.reserve({ x: 2, y: 64, z: 0 });
  assert.equal(reserved.ok, true);
  const denied = sleepB.reserve({ x: 2, y: 64, z: 0 });
  assert.equal(denied.ok, false);
  assert.ok(denied.error.includes('reserved'));
  const slept = await sleepA.sleep();
  assert.equal(slept.ok, true, slept.error);
  assert.equal(slept.slept, true);
  assert.equal(sleepA.stats.sleeps, 1);
  assert.equal(board.locks.size, 0, 'reservation released after waking');
});

test('exploration walks deterministic waypoints and records discoveries', async () => {
  const { bot, world } = flatBot('11001100', {}, 64);
  const memory = new TeamMemory();
  const exploration = new ExplorationController({ bot, memory, home: { x: 0, y: 64, z: 0 }, radius: 16 });
  const first = exploration.nextWaypoint();
  const second = exploration.nextWaypoint();
  assert.notDeepEqual(first, second);
  world.setBlock({ x: 4, y: 63, z: 4 }, 'water');
  const result = await exploration.explore({ steps: 2 });
  assert.equal(result.ok, true);
  assert.ok(exploration.stats.waypoints >= 2);
  assert.ok(memory.observations.length >= 1, 'discoveries must reach shared memory');
});

test('inventory reserves, deposits, withdraws and shares real items', async () => {
  const { bot, world } = flatBot('________', {}, 64);
  bot.addItem('oak_log', 20);
  bot.addItem('bread', 8);
  const ledger = new ResourceLedger();
  ledger.updateBotInventory(bot.name, bot.inventory);
  const inv = new InventoryManager({ bot, ledger });
  const status = inv.status();
  assert.ok(status.reserves.shortages.length > 0);
  assert.equal(status.reserves.held.oak_log, 20);
  world.setBlock({ x: 3, y: 64, z: 0 }, 'chest');
  ledger.updateStorage('chest-1', { position: { x: 3, y: 64, z: 0 }, counts: {} });
  const deposit = await inv.deposit('oak_log', 10);
  assert.equal(deposit.ok, true, deposit.error);
  assert.equal(bot.countItem('oak_log'), 10);
  assert.equal(ledger.storageTotal('oak_log'), 10);
  const withdraw = await inv.withdraw('oak_log', 4);
  assert.equal(withdraw.ok, true);
  assert.equal(bot.countItem('oak_log'), 14);

  const other = new MockBot({ name: '10101000', world });
  const shared = await inv.share('bread', 3, other);
  assert.equal(shared.ok, true, shared.error);
  assert.equal(other.countItem('bread'), 3);
  assert.equal(bot.countItem('bread'), 5);
  assert.equal(ledger.pendingTransfers().length, 0);
});

test('mining status caches the expensive nearby-ore scan', () => {
  const { bot } = flatBot('10101000', { iron_pickaxe: 1 });
  const mining = new MiningController({ bot });
  let scans = 0;
  mining.findOres = () => {
    scans++;
    return [{ name: 'iron_ore', x: 1, y: 64, z: 1 }];
  };
  mining.status();
  mining.status();
  assert.equal(scans, 1, 'repeated dashboard snapshots must reuse the scan');
  bot.position.x += 20;
  mining.status();
  assert.equal(scans, 2, 'moving far enough must refresh the cached scan');
});
