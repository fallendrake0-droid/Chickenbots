'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { BotActions } = require('../src/actions');
const { FarmingController } = require('../src/actions/farming');
const { TaskBoard } = require('../src/team/taskBoard');
const { CROPS, isMatureCrop, normalizeCrop } = require('../src/world/crops');

function worldBot({ name = '00110000', inventory = {}, position = null } = {}) {
  const world = new MockWorld();
  const y = world.surfaceY(0, 0) + 1;
  const bot = new MockBot({ name, world, inventory, position: position || { x: 0, y, z: 0 } });
  return { world, bot, y };
}

function actionsFor(bot, extras = {}) {
  return new BotActions({ bot, taskBoard: new TaskBoard({ now: () => 1000 }), home: { ...bot.position }, ...extras });
}

test('crop registry uses vanilla age limits and aliases', () => {
  assert.equal(CROPS.wheat.maxAge, 7);
  assert.equal(CROPS.beetroots.maxAge, 3);
  assert.equal(CROPS.torchflower_crop.maxAge, 1);
  assert.equal(CROPS.pitcher_crop.maxAge, 4);
  assert.equal(normalizeCrop('carrot'), 'carrots');
  assert.equal(normalizeCrop('pumpkins'), 'pumpkin_stem');
  assert.equal(normalizeCrop('nonsense'), null);
  assert.equal(isMatureCrop({ name: 'wheat', properties: { age: '7' } }), true);
  assert.equal(isMatureCrop({ name: 'wheat', properties: { age: '6' } }), false);
  assert.equal(isMatureCrop({ name: 'beetroots', properties: { age: '3' } }), true);
  assert.equal(isMatureCrop({ name: 'pitcher_crop', properties: { age: '4', half: 'upper' } }), false);
});

test('scans real block states and harvests only mature crops', async () => {
  const { world, bot, y } = worldBot({ inventory: { wheat_seeds: 3 } });
  world.setBlock({ x: 1, y: y - 1, z: 1 }, 'farmland');
  world.setBlock({ x: 1, y, z: 1 }, 'wheat', { age: 3 });
  world.setBlock({ x: 2, y: y - 1, z: 2 }, 'farmland');
  world.setBlock({ x: 2, y, z: 2 }, 'wheat', { age: 7 });
  world.setBlock({ x: 3, y: y - 1, z: 3 }, 'farmland');
  world.setBlock({ x: 3, y, z: 3 }, 'beetroots', { age: 2 });

  const farming = new FarmingController({ bot });
  const crops = farming.scanCrops({ crop: 'wheat' });
  assert.equal(crops.length, 2);
  assert.deepEqual(crops.map((crop) => crop.age).sort(), [3, 7]);
  assert.equal(crops.filter((crop) => crop.mature).length, 1);
  assert.equal(farming.cropCount({ crop: 'carrot' }), 0, 'aliases must not scan for item names');
  assert.equal(farming.cropCount({ crop: 'beetroot' }), 1, 'plural crop block names resolve from item aliases');

  const immature = await farming.harvest({ x: 1, y, z: 1 });
  assert.equal(immature.ok, false);
  assert.equal(immature.immature, true);
  assert.equal(world.getBlock({ x: 1, y, z: 1 }).name, 'wheat');
  assert.equal(farming.stats.immatureSkipped, 1);

  const mature = await farming.harvest({ x: 2, y, z: 2 });
  assert.equal(mature.ok, true, mature.error);
  assert.equal(mature.replanted, true, mature.replantError);
  assert.equal(world.getBlock({ x: 2, y, z: 2 }).name, 'wheat');
  assert.equal(world.getBlock({ x: 2, y, z: 2 }).properties.age, 0);
  assert.ok(bot.countItem('wheat') >= 1);

  const all = await farming.harvestAll({ crop: 'wheat', limit: 10 });
  assert.equal(all.harvested, 0, 'the remaining planted crop is still immature');
  assert.equal(all.immature, 2, 'the replanted crop plus the original immature crop are still growing');
});

test('builds a tilled and watered plot, plants verified crops and keeps harvesting for cycles', async () => {
  const { world, bot, y } = worldBot({ inventory: { wheat_seeds: 20, wooden_hoe: 1, water_bucket: 2 } });
  const farming = new FarmingController({ bot, home: { x: 0, y, z: 0 } });

  const planted = await farming.plantCrops({ crop: 'wheat', count: 9 });
  assert.equal(planted.ok, true, planted.error);
  assert.equal(planted.planted, 9, JSON.stringify(planted));
  assert.equal(planted.layout, 'plot');
  assert.equal(planted.verified, true);
  assert.equal(planted.tilled, planted.farm.tilled);
  assert.ok(planted.farm.cells.length >= 9);
  assert.equal(planted.waterPlaced, 1);
  assert.equal(planted.watered, true);
  assert.equal(bot.countItem('water_bucket'), 1);

  const plantedCells = planted.farm.cells.map((pos) => world.getBlock({ x: pos.x, y: pos.y + 1, z: pos.z }));
  assert.equal(plantedCells.filter((block) => block.name === 'wheat' && Number(block.properties.age) === 0).length, 9);

  // Every tilled cell is real farmland and within the vanilla 4-block water
  // square of the irrigation cell. The mock marks that hydration as moisture.
  const waterCells = planted.farm.waterCells;
  assert.equal(waterCells.length, 1);
  assert.equal(world.getBlock(waterCells[0]).name, 'water');
  for (const pos of planted.farm.cells) {
    const block = world.getBlock(pos);
    assert.equal(block.name, 'farmland');
    const near = waterCells.some((water) => Math.abs(water.x - pos.x) <= 4 && Math.abs(water.z - pos.z) <= 4 && Math.abs(water.y - pos.y) <= 1);
    assert.equal(near, true, `farmland ${pos.x},${pos.y},${pos.z} is not hydrated`);
    assert.equal(Number(block.properties.moisture), 7);
  }

  const before = bot.countItem('wheat_seeds');
  const grown = world.advanceCrops(8);
  assert.equal(grown.ok, true);
  assert.equal(grown.grown, 9);
  const harvest = await farming.harvestAll({ crop: 'wheat', limit: 16 });
  assert.equal(harvest.ok, true);
  assert.equal(harvest.harvested, 9, JSON.stringify(harvest));
  assert.equal(harvest.produced, 9);
  assert.equal(harvest.results.filter((result) => result.replanted).length, 9);
  assert.ok(bot.countItem('wheat_seeds') >= before, 'harvest + replant must not consume the seed stock');
  const standing = farming.cropCount({ crop: 'wheat' });
  assert.equal(standing, 9, 'every harvested crop was replanted');

  world.advanceCrops(8);
  const second = await farming.harvestAll({ crop: 'wheat', limit: 16 });
  assert.equal(second.harvested, 9);
  assert.equal(farming.stats.harvested, 18);
  assert.equal(farming.stats.replanted, 18);
  assert.ok(bot.countItem('wheat') >= 18);
});

test('planting is honest when there is no hoe, no seed or no soil', async () => {
  const { bot } = worldBot({ inventory: { wheat_seeds: 3 } });
  const farming = new FarmingController({ bot, home: { ...bot.position } });
  const noHoe = await farming.plantCrops({ crop: 'wheat', count: 4 });
  assert.equal(noHoe.ok, false);
  assert.equal(noHoe.planted, 0);
  assert.match(noHoe.error, /hoe/i);
  assert.equal(noHoe.results.length, 0, 'a missing hoe must not be retried for every cell');

  const sandy = new MockWorld({ flat: true });
  const sandY = sandy.surfaceY(0, 0) + 1;
  const sandBot = new MockBot({ name: '00110000', world: sandy, inventory: { wheat_seeds: 4, wooden_hoe: 1, water_bucket: 1 }, position: { x: 0, y: sandY, z: 0 } });
  const noSoil = await new FarmingController({ bot: sandBot, home: { ...sandBot.position } }).plantCrops({ crop: 'wheat', count: 4 });
  assert.equal(noSoil.ok, false);
  assert.equal(noSoil.planted, 0);
  assert.match(noSoil.error, /ground|soil|farmland/i);

  const { bot: noSeed } = worldBot({ inventory: { wooden_hoe: 1, water_bucket: 1 } });
  const noSeedFarming = new FarmingController({ bot: noSeed, home: { ...noSeed.position } });
  const missing = await noSeedFarming.plantCrops({ crop: 'carrots', count: 4 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /carrot/);

  const unknown = await noSeedFarming.plantCrops({ crop: 'dragonfruit', count: 4 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown crop/);
  const invalidHarvest = await noSeedFarming.harvestAll({ crop: 'dragonfruit' });
  assert.equal(invalidHarvest.ok, false);
});

test('a bot crafts a wooden hoe from planks and sticks when it has no hoe', async () => {
  const { world, bot } = worldBot({ inventory: { wheat_seeds: 4, oak_planks: 2, stick: 2 } });
  const farming = new FarmingController({ bot, home: { ...bot.position } });
  const planted = await farming.plantCrops({ crop: 'wheat', count: 4 });
  assert.equal(planted.ok, true, JSON.stringify(planted));
  assert.equal(planted.planted, 4);
  assert.equal(bot.countItem('wooden_hoe'), 1);
  assert.equal(farming.stats.crafted, 1);
  assert.ok(planted.farm.cells.every((pos) => world.getBlock(pos).name === 'farmland'));
});

test('pumpkin and melon stems keep the stem and harvest only the fruit', async () => {
  const { world, bot, y } = worldBot({ inventory: { melon_seeds: 2 } });
  world.setBlock({ x: 5, y: y - 1, z: 5 }, 'farmland');
  world.setBlock({ x: 5, y, z: 5 }, 'pumpkin_stem', { age: 7 });
  world.setBlock({ x: 6, y: y - 1, z: 5 }, 'dirt');
  world.setBlock({ x: 6, y, z: 5 }, 'pumpkin');
  world.setBlock({ x: 8, y: y - 1, z: 8 }, 'farmland');
  world.setBlock({ x: 8, y, z: 8 }, 'melon_stem', { age: 6 });
  world.setBlock({ x: 9, y: y - 1, z: 8 }, 'dirt');
  world.setBlock({ x: 9, y, z: 8 }, 'melon');

  const farming = new FarmingController({ bot });
  const pumpkin = await farming.harvest({ x: 5, y, z: 5 });
  assert.equal(pumpkin.ok, true, pumpkin.error);
  assert.equal(pumpkin.stemKept, true);
  assert.equal(pumpkin.replanted, false);
  assert.equal(world.getBlock({ x: 6, y, z: 5 }).name, 'air');
  assert.equal(world.getBlock({ x: 5, y, z: 5 }).name, 'pumpkin_stem');
  assert.equal(bot.countItem('pumpkin'), 1);

  const immatureStem = await farming.harvest({ x: 8, y, z: 8 });
  assert.equal(immatureStem.ok, false);
  assert.equal(immatureStem.immature, true);
  assert.equal(world.getBlock({ x: 9, y, z: 8 }).name, 'melon', 'immature stems leave their fruit alone');
});

test('carrot and potato harvesting replants the produce itself', async () => {
  const { world, bot, y } = worldBot({ inventory: { carrot: 4, potato: 2 } });
  world.setBlock({ x: 2, y: y - 1, z: -2 }, 'farmland');
  world.setBlock({ x: 2, y, z: -2 }, 'carrots', { age: 7 });
  world.setBlock({ x: 4, y: y - 1, z: -4 }, 'farmland');
  world.setBlock({ x: 4, y, z: -4 }, 'potatoes', { age: 7 });
  const farming = new FarmingController({ bot });

  const carrots = await farming.harvest({ x: 2, y, z: -2 });
  assert.equal(carrots.ok, true, carrots.error);
  assert.equal(carrots.produce, 'carrot');
  assert.equal(carrots.replanted, true);
  assert.equal(world.getBlock({ x: 2, y, z: -2 }).name, 'carrots');
  assert.equal(world.getBlock({ x: 2, y, z: -2 }).properties.age, 0);
  assert.ok(bot.countItem('carrot') >= 4);

  const potatoes = await farming.harvest({ x: 4, y, z: -4 });
  assert.equal(potatoes.replanted, true);
  assert.ok(bot.countItem('potato') >= 2);
  assert.equal(world.getBlock({ x: 4, y, z: -4 }).name, 'potatoes');
});

test('feeding animals consumes real food and respects the per-animal cooldown', async () => {
  const { world, bot, y } = worldBot({ inventory: { wheat: 3, carrot: 2 } });
  world.addMob('cow', { x: 1, y, z: 1 });
  world.addMob('pig', { x: -2, y, z: 1 });
  const farming = new FarmingController({ bot });

  const fed = await farming.feedAnimals({ radius: 8 });
  assert.equal(fed.ok, true, fed.error);
  assert.equal(fed.fed.length, 2, JSON.stringify(fed));
  assert.equal(fed.fed.find((entry) => entry.animal === 'cow').food, 'wheat');
  assert.equal(fed.fed.find((entry) => entry.animal === 'pig').food, 'carrot');
  assert.equal(bot.countItem('wheat'), 2);
  assert.equal(bot.countItem('carrot'), 1);
  assert.equal(farming.stats.animalsFed, 2);

  const again = await farming.feedAnimals({ radius: 8 });
  assert.equal(again.fed.length, 0);
  assert.equal(again.skipped.length, 2);
  assert.equal(bot.countItem('wheat'), 2, 'cooldown must not consume more food');
});

test('FARM_CROP establishes and then collects from the same real plot', async () => {
  const { bot, y } = worldBot({ inventory: { wheat_seeds: 20, wooden_hoe: 1, water_bucket: 1 } });
  const actions = actionsFor(bot);
  const first = await actions.performTask({ id: 't1', type: 'FARM_CROP', params: { crop: 'wheat', count: 9, establish: true } }, {});
  assert.equal(first.ok, true, first.error);
  assert.equal(first.verified, true);
  assert.equal(first.quantity, 9);
  assert.equal(first.cropCount, 9);
  assert.equal(bot.position.y, y);

  bot.world.advanceCrops(8);
  const second = await actions.performTask({ id: 't2', type: 'FARM_CROP', params: { crop: 'wheat', count: 9 } }, {});
  assert.equal(second.ok, true, second.error);
  assert.equal(second.verified, true);
  assert.equal(second.quantity, 9);
  assert.equal(second.harvested, 9);
  assert.ok(bot.countItem('wheat') >= 9);
  assert.equal(actions.farming.cropCount({ crop: 'wheat' }), 9, 'collect re-planted what it harvested');
});

test('the idle farming tick keeps working without stalling once crops are mature', async () => {
  const { world, bot } = worldBot({ inventory: { wheat_seeds: 12, wooden_hoe: 1, water_bucket: 1 } });
  const farming = new FarmingController({ bot, home: { ...bot.position } });
  const planted = await farming.plantCrops({ crop: 'wheat', count: 4 });
  assert.equal(planted.planted, 4);
  const idle = await farming.tick();
  assert.equal(idle.ok, true);
  assert.equal(idle.worked, false, 'nothing is mature yet');
  assert.equal(idle.harvest.harvested, 0);
  world.advanceCrops(8);
  const worked = await farming.tick();
  assert.equal(worked.ok, true);
  assert.equal(worked.worked, true);
  assert.equal(worked.harvest.harvested, 4, JSON.stringify(worked));
});

test('an idle bot with seeds establishes its own farm instead of stalling', async () => {
  const { world, bot } = worldBot({ inventory: { wheat_seeds: 8, wooden_hoe: 1, water_bucket: 1 } });
  const farming = new FarmingController({ bot, home: { ...bot.position } });
  const result = await farming.tick();
  assert.equal(result.ok, true);
  assert.equal(result.worked, true);
  assert.equal(result.plant.planted, 8);
  assert.equal(result.plant.verified, true);
  assert.equal(farming.cropCount({ crop: 'wheat' }), 8);
  const second = await farming.tick();
  assert.equal(second.worked, false, 'a standing farm is not replanted over');
  assert.equal(second.plant, null);
  world.advanceCrops(8);
  const harvest = await farming.tick();
  assert.equal(harvest.worked, true);
  assert.equal(harvest.harvest.harvested, 8);
});

test('two fed adults produce a real baby and babies are not force-fed', async () => {
  const { world, bot, y } = worldBot({ inventory: { wheat: 4 } });
  const cowA = world.addMob('cow', { x: 1, y, z: 1 });
  const cowB = world.addMob('cow', { x: 2, y, z: 1 });
  const farming = new FarmingController({ bot });
  const result = await farming.feedAnimals({ radius: 8 });
  assert.equal(result.fed.length, 2, JSON.stringify(result));
  assert.equal(result.bred, 1);
  assert.equal(result.offspring.length, 1);
  assert.equal(farming.stats.animalsBred, 1);
  assert.equal(bot.countItem('wheat'), 2);
  const baby = world.entities.find((entity) => entity.baby);
  assert.ok(baby, 'breeding creates an actual baby entity');
  assert.equal(cowA.inLove, false);
  assert.equal(cowB.inLove, false);
  const before = bot.countItem('wheat');
  const again = await farming.feedAnimals({ radius: 8 });
  assert.equal(again.fed.length, 0);
  assert.equal(bot.countItem('wheat'), before, 'babies and cooling adults consume nothing');
});

test('the farm soil scan is time-bounded instead of walking the whole cube', () => {
  const { FarmingController } = require('../src/actions/farming');
  let lookups = 0;
  const bot = {
    name: '10101000',
    position: { x: 0, y: 64, z: 0 },
    inventory: {},
    getBlock(pos) {
      lookups++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      return { name: pos.y === 64 ? 'dirt' : 'air' };
    }
  };
  const controller = new FarmingController({ bot });
  const started = Date.now();
  const soil = controller._localSoil({ x: 0, y: 64, z: 0 }, 12, 400, { budgetMs: 25 });
  const elapsed = Date.now() - started;
  assert.ok(Array.isArray(soil));
  assert.ok(lookups < 1000, `budgeted soil scan visited ${lookups} positions`);
  assert.ok(elapsed < 500, `budgeted soil scan took ${elapsed}ms`);
});
