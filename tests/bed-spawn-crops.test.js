'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { BotActions } = require('../src/actions');
const { SleepController } = require('../src/actions/sleep');
const { FarmingController } = require('../src/actions/farming');

function worldBot({ name = '00110000', inventory = {}, position = null } = {}) {
  const world = new MockWorld();
  const y = world.surfaceY(0, 0) + 1;
  const bot = new MockBot({ name, world, inventory, position: position || { x: 0, y, z: 0 } });
  return { world, bot, y };
}

test('a status scan with a 2ms budget still finds a bed through the world index', () => {
  const { bot } = worldBot({ position: { x: 5, y: 65, z: 0 } });
  const sleep = new SleepController({ bot });
  const beds = sleep.findBeds({ radius: 16, limit: 10, budgetMs: 2 });
  assert.ok(beds.length >= 1, 'the deterministic world contains a bed near home');
  const status = sleep.status();
  assert.equal(status.nearbyBeds.length, beds.length);
  assert.ok(status.nearbyBeds.every((bed) => Number.isFinite(bed.distance)));
  assert.ok(status.nearbyBeds.every((bed) => bed.foot && Number.isFinite(bed.foot.x)));
});

test('a nearby bed becomes the verified spawn point and the dashboard sees it', async () => {
  const { bot } = worldBot({ position: { x: 5, y: 65, z: 0 } });
  const sleep = new SleepController({ bot });
  const before = sleep.status();
  assert.equal(before.spawnSet, false);

  const claimed = await sleep.ensureSpawnPoint({ radius: 16 });
  assert.equal(claimed.ok, true, claimed.error);
  assert.equal(claimed.verified, true);
  assert.ok(claimed.spawnPoint, 'the adapter must report a spawn position');

  const after = sleep.status();
  assert.equal(after.spawnSet, true);
  assert.deepEqual(after.spawnPoint, claimed.spawnPoint);
  assert.equal(after.nearbyBeds.filter((bed) => bed.spawn).length, 1, 'exactly the claimed bed is marked as the spawn');

  const again = await sleep.ensureSpawnPoint({ radius: 16 });
  assert.equal(again.already, true, 'a second call must not re-click a bed that already owns the spawn');
});

test('the daytime idle tick sets a spawn point instead of returning early', async () => {
  const { bot } = worldBot({ position: { x: 5, y: 65, z: 0 } });
  const sleep = new SleepController({ bot });
  const result = await sleep.tick();
  assert.equal(result.night !== true, true);
  assert.equal(result.spawn.ok, true, result.spawn && result.spawn.error);
  assert.equal(bot.spawnPoint !== null, true);
});

test('the work limit is applied after maturity, so ripe crops behind seedlings are harvested', async () => {
  const { world, bot, y } = worldBot({ inventory: { wheat_seeds: 8 } });
  // Sixteen seedlings closest to the bot, one ripe crop further away.
  for (let i = 0; i < 16; i++) {
    const x = 1 + (i % 4);
    const z = 1 + Math.floor(i / 4);
    world.setBlock({ x, y: y - 1, z }, 'farmland');
    world.setBlock({ x, y, z }, 'wheat', { age: 2 });
  }
  const ripe = { x: 9, y, z: 9 };
  world.setBlock({ x: ripe.x, y: y - 1, z: ripe.z }, 'farmland');
  world.setBlock(ripe, 'wheat', { age: 7 });

  const farming = new FarmingController({ bot });
  const scan = farming.scanCrops({ crop: 'wheat', budgetMs: 2 });
  assert.equal(scan.length, 17, 'the indexed scan sees every crop at any distance inside the radius');
  assert.equal(scan.filter((crop) => crop.mature).length, 1);

  const harvest = await farming.harvestAll({ crop: 'wheat', limit: 2 });
  assert.equal(harvest.harvested, 1, JSON.stringify(harvest));
  assert.equal(harvest.mature, 1);
  assert.equal(harvest.immature, 16);
  assert.deepEqual(
    { x: harvest.results[0].replantPosition.x, y: harvest.results[0].replantPosition.y, z: harvest.results[0].replantPosition.z },
    ripe
  );
  assert.equal(world.getBlock(ripe).name, 'wheat');
  assert.equal(Number(world.getBlock(ripe).properties.age), 0, 'the harvested crop was replanted immediately');
});

test('unloaded spawn blocks are not reported as suffocation or unsupported ground', () => {
  const { bot } = worldBot();
  bot.getBlock = () => ({ name: 'unloaded', properties: {} });
  const actions = new BotActions({ bot });
  assert.deepEqual(actions._spawnHazards(), []);
});

test('sleep spawn <bot> is an explicit, verified bed claim command', async () => {
  const { createRuntime } = require('../src/runtime');
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  runtime.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const result = await runtime.executeCommand('sleep spawn 00110000', { source: 'dashboard' });
    assert.equal(result.ok, true, JSON.stringify(result.result));
    const entry = result.result.results.find((row) => row.bot === '00110000');
    assert.ok(entry, 'the command reports the named bot');
    assert.equal(entry.ok, true, entry.error);
    assert.ok(entry.spawnPoint, 'the adapter acknowledged a spawn point');
    assert.equal(runtime.actions.get('00110000').sleep.status().spawnSet, true);
  } finally {
    await runtime.shutdown('bed spawn command test');
  }
});
