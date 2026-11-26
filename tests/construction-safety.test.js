'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { BuildEngine, STATUS, isUnknownWorldName, isSolidName } = require('../src/building/engine');
const { SitePreparer } = require('../src/construction/sitePreparer');
const { classifySiteBlock } = require('../src/construction/siteSurvey');
const { splitRegions, assignRegions, reassignRegion } = require('../src/excavate/regions');
const { TeamMemory } = require('../src/team/teamMemory');
const { BOT_NAMES } = require('../src/config');

function singleBlockSchematic(y = 0) {
  return {
    palette: ['stone'],
    blocks: [[0, y, 0, 0, 0]],
    dimensions: { width: 1, height: y + 1, length: 1 }
  };
}

function fakeBot(world, extra = {}) {
  const calls = { dig: 0, place: 0 };
  return {
    name: '________',
    position: { x: 0, y: 1, z: 0 },
    countItem: () => 4,
    getBlock: (pos) => world.getBlock(pos),
    async goTo() { return { ok: true }; },
    async digBlock() { calls.dig++; return { ok: true }; },
    async placeBlock() { calls.place++; return { ok: true }; },
    calls,
    ...extra
  };
}

test('unloaded world names are unknown, never air and never solid support', () => {
  assert.equal(isUnknownWorldName('unloaded'), true);
  assert.equal(isUnknownWorldName('unknown'), true);
  assert.equal(isUnknownWorldName('air'), false);
  assert.equal(isSolidName('unloaded'), false);
  assert.equal(isSolidName('stone'), true);
  assert.equal(classifySiteBlock('unloaded'), 'unknown');
  assert.equal(classifySiteBlock('stone'), 'terrain');
});

test('a placement in an unloaded chunk waits instead of failing or digging', async () => {
  const world = { getBlock: () => ({ name: 'unloaded' }) };
  const bot = fakeBot(world);
  const engine = new BuildEngine({
    schematic: singleBlockSchematic(), origin: { x: 0, y: 0, z: 0 }, world,
    confirmationAttempts: 2, confirmationDelayMs: 1
  });
  const block = engine.byPosition.get('0,0,0');
  const result = await engine.place(block, bot, { retries: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, STATUS.WAITING_FOR_WORLD_UPDATE);
  assert.equal(result.retryable, true);
  assert.match(result.error, /loaded/);
  assert.equal(bot.calls.dig, 0, 'unknown terrain must not be dug');
  assert.equal(bot.calls.place, 0, 'nothing may be placed from an unknown read');
  assert.equal(block.status, STATUS.WAITING_FOR_WORLD_UPDATE);
});

test('an unloaded support waits for the chunk instead of reporting a missing support', async () => {
  const world = {
    getBlock: (pos) => (pos.y === 1 ? { name: 'air' } : { name: 'unloaded' })
  };
  const bot = fakeBot(world, { position: { x: 0, y: 3, z: 0 } });
  const engine = new BuildEngine({
    schematic: singleBlockSchematic(2), origin: { x: 0, y: 0, z: 0 }, world,
    confirmationAttempts: 2, confirmationDelayMs: 1
  });
  const result = await engine.place(engine.byPosition.get('0,2,0'), bot, { retries: 0 });
  assert.equal(result.status, STATUS.WAITING_FOR_WORLD_UPDATE, result.error);
  assert.equal(result.retryable, true);
  assert.equal(bot.calls.place, 0);
});

test('placeMany reports deferred work and verification counts unloaded blocks as missing', async () => {
  const schematic = { palette: ['stone'], blocks: [[0, 0, 0, 0], [1, 0, 0, 0]], dimensions: { width: 2, height: 1, length: 2 } };
  const world = { getBlock: () => null };
  const bot = fakeBot(world);
  const engine = new BuildEngine({ schematic, origin: { x: 0, y: 0, z: 0 }, world, confirmationAttempts: 1, confirmationDelayMs: 0 });
  const run = await engine.placeMany(bot, { retries: 0 });
  assert.equal(run.placed, 0);
  assert.equal(run.waiting, 2);
  assert.equal(run.deferred, true);
  const audit = engine.verify();
  assert.equal(audit.verified, false);
  assert.equal(audit.missingCount, 2);
  assert.equal(audit.wrongCount, 0);
  assert.equal(audit.unloadedCount, 2);
  assert.equal(audit.missing[0].unloaded, true);
});

test('a confirmation that loses the chunk is retried, not dug back out', async () => {
  let reads = 0;
  const world = {
    getBlock: () => {
      reads++;
      // The first reads see air; after the placement API "succeeds" the chunk is
      // gone. The engine must not delete an unobserved block.
      return reads <= 1 ? { name: 'air' } : { name: 'unloaded' };
    }
  };
  const bot = fakeBot(world);
  const engine = new BuildEngine({
    schematic: singleBlockSchematic(), origin: { x: 0, y: 0, z: 0 }, world,
    confirmationAttempts: 1, confirmationDelayMs: 0
  });
  const result = await engine.place(engine.byPosition.get('0,0,0'), bot, { retries: 0 });
  assert.equal(result.status, STATUS.WAITING_FOR_WORLD_UPDATE, result.error);
  assert.equal(bot.calls.dig, 0);
});

test('levelling vacates a column a lone bot is standing on instead of skipping it', async () => {
  const world = new MockWorld({ flat: true, guaranteedOres: false });
  world.setBlock({ x: 1, y: 64, z: 1 }, 'stone');
  world.setBlock({ x: 1, y: 65, z: 1 }, 'stone');
  const bot = new MockBot({ name: '________', world, inventory: { wooden_pickaxe: 1 }, position: { x: 1, y: 66, z: 1 } });
  const preparer = new SitePreparer({ bots: [bot], world, preserveOres: false });
  const result = await preparer.levelFootprint({ minX: 1, maxX: 1, minZ: 1, maxZ: 1, targetY: 63 });
  assert.equal(result.stoppedReason, null);
  assert.equal(result.ok, true, JSON.stringify(result.results));
  assert.equal(result.actions, 2, JSON.stringify(result.results));
  assert.equal(world.getBlock({ x: 1, y: 65, z: 1 }).name, 'air');
  assert.equal(world.getBlock({ x: 1, y: 64, z: 1 }).name, 'air');
  assert.notDeepEqual({ x: Math.floor(bot.position.x), z: Math.floor(bot.position.z) }, { x: 1, z: 1 });
});

test('missing fill material stops levelling once instead of failing every column', async () => {
  const world = new MockWorld({ flat: true, guaranteedOres: false });
  const bot = new MockBot({ name: '________', world, position: { x: 20, y: 64, z: 20 } });
  const preparer = new SitePreparer({ bots: [bot], world, preserveOres: false });
  const result = await preparer.levelFootprint({ minX: 0, maxX: 2, minZ: 0, maxZ: 2, targetY: 66 });
  assert.equal(result.stoppedReason, 'no fill material');
  assert.equal(result.actions, 0);
  assert.equal(result.results.length, 1, 'one actionable reason, not one per column');
  assert.equal(result.ok, false);
});

test('clearance refuses to dig chunks it has not observed', async () => {
  const world = { getBlock: () => ({ name: 'unloaded' }), surfaceY: () => 63 };
  let digs = 0;
  const bot = {
    name: '________', position: { x: 0, y: 64, z: 0 }, inventory: {},
    countItem: () => 0, getBlock: (pos) => world.getBlock(pos),
    async goTo() { return { ok: true }; },
    async digBlock() { digs++; return { ok: true }; }
  };
  const preparer = new SitePreparer({ bots: [bot], world });
  const preview = preparer.previewClearance({ min: { x: 0, y: 60, z: 0 }, max: { x: 1, y: 70, z: 1 } });
  assert.ok(preview.unknown > 0);
  assert.equal(preview.total, 0);
  const result = await preparer.clearArea({ bounds: { min: { x: 0, y: 60, z: 0 }, max: { x: 1, y: 70, z: 1 } }, targetY: 63 });
  assert.ok(result.unknown > 0);
  assert.equal(digs, 0);
  assert.equal(result.actions, 0);
});

test('region assignment is volume-aware and reassignment spreads lost regions', () => {
  const bounds = { min: { x: 0, y: 40, z: 0 }, max: { x: 15, y: 47, z: 15 } };
  const regions = splitRegions(bounds, 4);
  assert.equal(regions.length, 4);
  const assignment = assignRegions(regions, ['a', 'b'], { supervisor: 'a' });
  assert.equal(assignment.assignments.length, 4);
  assert.ok(!assignment.assignments.some((entry) => entry.bot === 'a'));
  assert.deepEqual(Object.keys(assignment.loads).sort(), ['b']);
  const total = Object.values(assignment.loads).reduce((sum, volume) => sum + volume, 0);
  assert.equal(total, regions.reduce((sum, region) => sum + region.volume, 0));

  const custom = [
    { regionId: 'R1', bot: 'a', volume: 10, box: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } },
    { regionId: 'R2', bot: 'a', volume: 10, box: { min: { x: 2, y: 0, z: 0 }, max: { x: 3, y: 1, z: 1 } } },
    { regionId: 'R3', bot: 'b', volume: 10, box: { min: { x: 4, y: 0, z: 0 }, max: { x: 5, y: 1, z: 1 } } },
    { regionId: 'R4', bot: 'c', volume: 10, box: { min: { x: 6, y: 0, z: 0 }, max: { x: 7, y: 1, z: 1 } } }
  ];
  const re = reassignRegion(custom, 'a', ['a', 'b', 'c']);
  assert.equal(re.ok, true);
  assert.equal(re.moved, 2);
  assert.ok(!re.assignments.some((entry) => entry.bot === 'a'));
  const moved = re.assignments.filter((entry) => entry.reassignedFrom === 'a');
  assert.equal(moved.length, 2);
  assert.equal(new Set(moved.map((entry) => entry.bot)).size, 2, 'two lost regions must not both land on one bot');
  assert.deepEqual(re.distributedTo.sort(), ['b', 'c']);
});

test('team memory dedupes by identity and is not quadratic at the bound', () => {
  const memory = new TeamMemory({ maxObservations: 3, now: () => 1000 });
  const bot = BOT_NAMES[0];
  const base = { type: 'ORE_DEPOSIT', reportedBy: bot, position: { x: 1, y: 2, z: 3 }, confidence: 0.5 };
  const first = memory.observe(base);
  assert.equal(first.ok, true);
  const updated = memory.observe({ ...base, confidence: 0.9 });
  assert.equal(updated.updated, true);
  assert.equal(memory.observations.length, 1);
  assert.equal(memory.observations[0].confidence, 0.9);

  const id = first.observation.id;
  assert.equal(memory.setStatus(id, 'RESERVED'), true);
  assert.equal(memory.byIdentity.get(`${first.observation._identity}|AVAILABLE`), undefined);
  assert.equal(memory.byIdentity.get(`${first.observation._identity}|RESERVED`).id, id);

  memory.observe({ ...base, position: { x: 1, y: 2, z: 4 }, confidence: 0.2 });
  memory.observe({ ...base, position: { x: 1, y: 2, z: 5 }, confidence: 0.8 });
  memory.observe({ ...base, position: { x: 1, y: 2, z: 6 }, confidence: 0.4 });
  assert.equal(memory.observations.length, 3);
  assert.equal(memory.observations.some((obs) => obs.position.z === 4), false, 'lowest-confidence entry is evicted');
  for (const obs of memory.observations) {
    assert.equal(memory.byIdentity.get(`${obs._identity}|${obs.status}`), obs);
  }
});
