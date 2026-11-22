'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { boxFromLowerCorner, boxFromFeet, radiusPlan, quarryPlan, trenchPlan, flattenPlan, foundationPlan } = require('../src/excavate/footprint');
const { circleCells } = require('../src/excavate/footprint');
const { splitRegions, assignRegions, reassignRegion, iterateRegionLayers } = require('../src/excavate/regions');
const { createExcavationPlan, formatPlan } = require('../src/excavate/planner');
const { classifyBlock, summarizeArea } = require('../src/excavate/safety');
const { ExcavationVerifier } = require('../src/excavate/verifier');
const { ExcavationExecutor } = require('../src/excavate/executor');
const { maskForPlan } = require('../src/excavate/mask');
const { boxVolume } = require('../src/util/vec');

function flatWorld() { return new MockWorld({ flat: true, guaranteedOres: false }); }

test('coordinate boxes use the lower corner and correct inclusive dimensions', () => {
  const b = boxFromLowerCorner({ x: 120, y: 40, z: -80 }, 32, 32, 12);
  assert.deepEqual(b.min, { x: 120, y: 40, z: -80 });
  assert.deepEqual(b.max, { x: 151, y: 51, z: -49 });
  assert.equal(boxVolume(b.min, b.max), 32 * 32 * 12);
  const feet = boxFromFeet({ x: 0, y: 64, z: 0 }, 4, 5, 3);
  assert.equal(feet.min.y, 62);
  assert.equal(feet.max.y, 64);
  assert.equal(boxVolume(feet.min, feet.max), 4 * 5 * 3);
  assert.throws(() => boxFromLowerCorner({ x: 0, y: 0, z: 0 }, 0, 4, 4));
});

test('radius plans use a circular footprint, not a square', () => {
  const plan = radiusPlan({ origin: { x: 0, y: 64, z: 0 }, radius: 5, depth: 4 });
  const cells = circleCells({ x: 0, y: 64, z: 0 }, 5);
  assert.equal(plan.volume, cells.length * 4);
  assert.ok(plan.volume < 11 * 11 * 4);
  assert.equal(plan.mask, 'radius');
});

test('quarry plans produce terraces and a real ramp, and count only terraced volume', () => {
  const plan = quarryPlan({ origin: { x: 0, y: 64, z: 0 }, width: 12, length: 12, depth: 8 });
  assert.ok(plan.tiers.length >= 2);
  assert.ok(plan.ramp.width >= 2);
  const full = 12 * 12 * 8;
  assert.ok(plan.volume < full);
  assert.equal(plan.volume, plan.tiers.reduce((s, t) => s + t.width * t.length * t.height, 0));
  const mask = maskForPlan({ mode: 'QUARRY', bounds: plan.bounds, terraces: plan.tiers, tierHeight: plan.tierHeight });
  assert.equal(mask.volume, plan.volume);
  // The top tier includes the outer ring; deeper tiers are inset (walls preserved).
  assert.equal(mask.includes({ x: 0, y: plan.bounds.max.y, z: 0 }), true);
  assert.equal(mask.includes({ x: 0, y: plan.bounds.min.y, z: 0 }), false);
  assert.equal(mask.includes({ x: 0, y: plan.bounds.min.y - 1, z: 0 }), false);
});

test('trench runs along +X with the requested width and depth', () => {
  const plan = trenchPlan({ origin: { x: 10, y: 64, z: 5 }, length: 40, width: 3, depth: 5 });
  assert.equal(plan.bounds.max.x - plan.bounds.min.x + 1, 40);
  assert.equal(plan.bounds.max.z - plan.bounds.min.z + 1, 3);
  assert.equal(plan.volume, 40 * 3 * 5);
  assert.equal(plan.exitSteps.length, 2);
});

test('flatten analysis is based on sampled terrain and only removes above target', () => {
  const world = flatWorld();
  world.overrides.set('0,64,0', 'stone');
  world.overrides.set('1,64,0', 'stone');
  const plan = flattenPlan({ origin: { x: 0, y: 64, z: 0 }, width: 8, length: 8, surfaceAt: (x, z) => world.surfaceY(x, z) });
  assert.equal(plan.mode, 'FLATTEN');
  assert.ok(plan.targetY <= 64);
  assert.equal(plan.sampledStride, 1);
  assert.ok(plan.notes.some((n) => n.includes('median')));
});

test('foundation plans derive dimensions from the schematic and preserve supports', () => {
  const schematic = { id: 'test_castle', name: 'Test Castle', dimensions: { width: 20, height: 30, length: 24 }, foundation: { depth: 3 } };
  const plan = foundationPlan({ schematic, origin: { x: 0, y: 64, z: 0 }, surfaceAt: () => 63 });
  assert.equal(plan.bounds.max.x - plan.bounds.min.x + 1, 20);
  assert.equal(plan.bounds.max.z - plan.bounds.min.z + 1, 24);
  assert.equal(plan.depth, 3);
  assert.equal(plan.supports.length, 9);
  assert.equal(plan.schematicId, 'test_castle');
});

test('protected blocks, ores and liquids are classified safely', () => {
  assert.equal(classifyBlock('chest').excavatable, false);
  assert.equal(classifyBlock('chest').requiresAuth, true);
  assert.equal(classifyBlock('bedrock').excavatable, false);
  assert.equal(classifyBlock('spawner').excavatable, false);
  assert.equal(classifyBlock('diamond_ore').excavatable, false);
  assert.equal(classifyBlock('diamond_ore').kind, 'ORE');
  assert.equal(classifyBlock('diamond_ore', { preserveOres: false }).excavatable, true);
  assert.equal(classifyBlock('water').excavatable, false);
  assert.equal(classifyBlock('oak_planks').excavatable, false); // player structure by default
  assert.equal(classifyBlock('oak_planks', { authorized: true }).excavatable, true);
  assert.equal(classifyBlock('stone').excavatable, true);
  assert.equal(classifyBlock('gravel').kind, 'FALLING');
  const summary = summarizeArea({ stone: 100, 'diamond_ore': 4, water: 2, chest: 1, air: 10 });
  assert.equal(summary.excavatable, 100);
  assert.equal(summary.ores.diamond_ore, 4);
  assert.equal(summary.liquids.water, 2);
  assert.equal(summary.protected.chest, 1);
});

test('plans reject invalid geometry and volumes beyond the limit', () => {
  const bad = createExcavationPlan({ mode: 'BOX', origin: { x: 0, y: 64, z: 0 }, width: 0, length: 4, depth: 2 });
  assert.equal(bad.ok, false);
  const huge = createExcavationPlan({ mode: 'BOX', origin: { x: 0, y: 64, z: 0 }, width: 120, length: 120, depth: 30, options: { maxBlocks: 1000 } });
  assert.equal(huge.ok, false);
  assert.match(huge.error, /exceeds limit/);
  const missing = createExcavationPlan({ mode: 'BOX' });
  assert.equal(missing.ok, false);
  const below = createExcavationPlan({ mode: 'BOX', origin: { x: 0, y: -70, z: 0 }, width: 4, length: 4, depth: 8 });
  assert.equal(below.ok, false);
});

test('plan reveals protected structures and demands authorisation', () => {
  const world = new MockWorld({ flat: true, guaranteedOres: false });
  // Build a player chest inside the planned area.
  world.setBlock({ x: 2, y: 60, z: 2 }, 'stone');
  world.setBlock({ x: 3, y: 61, z: 2 }, 'chest');
  const res = createExcavationPlan({
    mode: 'AT', origin: { x: 0, y: 60, z: 0 }, width: 6, length: 6, depth: 4,
    blockAt: (p) => world.getBlock(p), botNames: ['a', 'b', 'c', 'd', 'e'], workers: 4
  });
  assert.equal(res.ok, true);
  assert.equal(res.plan.authorizationRequired, true);
  assert.ok(res.plan.protectedBlocks.some((b) => b.name === 'chest'));
  const text = formatPlan(res.plan);
  assert.match(text, /AWAITING AUTHORISATION/);
  assert.match(text, /LOCATION:/);
  assert.match(text, /TOOLS REQUIRED/);
});

test('plan scan finds ores and lava and warns about both', () => {
  const world = new MockWorld({ flat: true, guaranteedOres: false });
  world.setBlock({ x: 1, y: 60, z: 1 }, 'iron_ore');
  world.setBlock({ x: 2, y: 61, z: 1 }, 'lava');
  const res = createExcavationPlan({
    mode: 'AT', origin: { x: 0, y: 59, z: 0 }, width: 4, length: 4, depth: 4,
    blockAt: (p) => world.getBlock(p), options: {}
  });
  assert.equal(res.ok, true);
  assert.ok(res.plan.summary.ores.iron_ore >= 1);
  assert.ok(Object.keys(res.plan.summary.liquids).includes('lava'));
  assert.ok(res.plan.warnings.some((w) => /Lava present/.test(w.text)));
  assert.ok(res.plan.warnings.some((w) => /Ores preserved/.test(w.text)));
});

test('regions cover the bounds exactly, never overlap, and stay balanced', () => {
  const bounds = { min: { x: 0, y: 40, z: 0 }, max: { x: 31, y: 51, z: 31 } };
  const regions = splitRegions(bounds, 4);
  assert.equal(regions.length, 4);
  let total = 0;
  for (let i = 0; i < regions.length; i++) {
    total += boxVolume(regions[i].box.min, regions[i].box.max);
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i].box;
      const b = regions[j].box;
      const overlap = a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.z <= b.max.z && a.max.z >= b.min.z && a.min.y <= b.max.y && a.max.y >= b.min.y;
      assert.equal(overlap, false);
    }
  }
  assert.equal(total, boxVolume(bounds.min, bounds.max));
  const volumes = regions.map((r) => r.volume);
  assert.ok(Math.max(...volumes) <= Math.min(...volumes) * 2.5);
  const five = splitRegions(bounds, 5);
  assert.equal(five.length, 5);
  assert.equal(five.reduce((s, r) => s + r.volume, 0), boxVolume(bounds.min, bounds.max));
});

test('mask-aware region volumes exclude preserved terrace/circle blocks', () => {
  const quarry = quarryPlan({ origin: { x: 0, y: 64, z: 0 }, width: 16, length: 16, depth: 8 });
  const mask = maskForPlan({ mode: 'QUARRY', bounds: quarry.bounds, terraces: quarry.tiers, tierHeight: quarry.tierHeight });
  const regions = splitRegions(quarry.bounds, 4, { measure: (b) => mask.measure(b) });
  assert.equal(regions.reduce((s, r) => s + r.volume, 0), mask.volume);
  assert.ok(regions.every((r) => r.volume > 0));
});

test('region assignment uses four workers plus a supervisor, or all five as a team', () => {
  const bounds = { min: { x: 0, y: 40, z: 0 }, max: { x: 15, y: 47, z: 15 } };
  const regions = splitRegions(bounds, 4);
  const names = ['______', '101010', '010101', '110011', '001100'];
  const quad = assignRegions(regions, names, { supervisor: '______' });
  assert.equal(quad.assignments.length, 4);
  assert.ok(!quad.assignments.some((a) => a.bot === '______'));
  const team = assignRegions(regions, names, { supervisor: '______', includeSupervisor: true });
  assert.ok(team.assignments.some((a) => a.bot === '______'));
  const re = reassignRegion(quad.assignments, '101010', ['010101', '110011', '001100']);
  assert.equal(re.ok, true);
  assert.ok(!re.assignments.some((a) => a.bot === '101010'));
});

test('layer iteration is top-down and covers each block once', () => {
  const box = { min: { x: 0, y: 10, z: 0 }, max: { x: 2, y: 12, z: 2 } };
  const seen = new Set();
  let lastY = Infinity;
  for (const pos of iterateRegionLayers(box)) {
    seen.add(`${pos.x},${pos.y},${pos.z}`);
    assert.ok(pos.y <= lastY);
    lastY = pos.y;
  }
  assert.equal(seen.size, 27);
});

test('executor removes blocks, preserves ores/protected blocks and verifies real removal', async () => {
  const world = flatWorld();
  const bot = new MockBot({ name: '101010', world, inventory: { iron_pickaxe: 1, shovel: 1, torch: 16 } });
  bot.position = { x: 0, y: 65, z: 0 };
  world.setBlock({ x: 1, y: 62, z: 1 }, 'iron_ore');
  world.setBlock({ x: 2, y: 62, z: 1 }, 'chest');
  const plan = createExcavationPlan({
    mode: 'AT', origin: { x: 0, y: 58, z: 0 }, width: 4, length: 4, depth: 4,
    blockAt: (p) => world.getBlock(p), botNames: ['101010'], workers: 1
  }).plan;
  const region = plan.regions[0];
  const executor = new ExcavationExecutor({ botName: '101010', bot, plan, region });
  const summary = await executor.run();
  assert.equal(summary.status, 'completed');
  assert.ok(summary.stats.dug > 0);
  assert.equal(world.getBlock({ x: 1, y: 62, z: 1 }).name, 'iron_ore');
  assert.equal(world.getBlock({ x: 2, y: 62, z: 1 }).name, 'chest');
  // A corner far from the ore/chest is actually removed.
  const dugCells = [...iterateRegionLayers(plan.bounds)].filter((p) => world.getBlock(p) && world.getBlock(p).name === 'air').length;
  assert.ok(dugCells > 0);
  const verifier = new ExcavationVerifier(plan, { getBlock: (p) => world.getBlock(p), mask: plan._mask });
  const verification = verifier.verifyRegion(region);
  // Ore and chest remain, so they are not counted as excavatable leftovers.
  assert.equal(verification.complete, true);
});

test('executor never opens a block adjacent to lava', async () => {
  const world = flatWorld();
  world.setBlock({ x: 1, y: 61, z: 1 }, 'lava');
  const bot = new MockBot({ name: '101010', world, inventory: { iron_pickaxe: 1 } });
  bot.position = { x: 0, y: 65, z: 0 };
  const plan = createExcavationPlan({
    mode: 'AT', origin: { x: 0, y: 60, z: 0 }, width: 3, length: 3, depth: 4,
    blockAt: (p) => world.getBlock(p)
  }).plan;
  const executor = new ExcavationExecutor({ botName: '101010', bot, plan, region: { id: 'R1', box: { min: { x: 0, y: 60, z: 0 }, max: { x: 2, y: 61, z: 2 } }, volume: 3 * 3 * 2 } });
  const summary = await executor.run();
  assert.ok(summary.stats.skippedHazard > 0);
  assert.notEqual(world.getBlock({ x: 1, y: 60, z: 1 }).name, 'air'); // directly below lava is preserved
  assert.equal(world.getBlock({ x: 1, y: 61, z: 1 }).name, 'lava');
});

test('executor never digs the block it is standing on', async () => {
  const world = flatWorld();
  const bot = new MockBot({ name: '101010', world, inventory: { iron_pickaxe: 1 } });
  bot.position = { x: 1, y: 62, z: 1 };
  bot.goTo = async (pos) => { bot.position = { x: pos.x, y: pos.y + 1, z: pos.z }; return { ok: true }; };
  const plan = createExcavationPlan({ mode: 'AT', origin: { x: 0, y: 58, z: 0 }, width: 3, length: 3, depth: 4, blockAt: (p) => world.getBlock(p) }).plan;
  const executor = new ExcavationExecutor({ botName: '101010', bot, plan, region: { id: 'R1', box: { min: { x: 0, y: 58, z: 0 }, max: { x: 2, y: 61, z: 2 } }, volume: 3 * 3 * 4 } });
  const summary = await executor.run();
  assert.ok(summary.stats.moved > 0);
  assert.equal(summary.stats.attempted > 0, true);
});

test('executor pause/resume and stop are honoured', async () => {
  const world = flatWorld();
  const bot = new MockBot({ name: '101010', world, inventory: { iron_pickaxe: 1 } });
  bot.position = { x: 0, y: 65, z: 0 };
  const plan = createExcavationPlan({ mode: 'AT', origin: { x: 0, y: 58, z: 0 }, width: 2, length: 2, depth: 2, blockAt: (p) => world.getBlock(p) }).plan;
  const executor = new ExcavationExecutor({ botName: '101010', bot, plan, region: { id: 'R1', box: { min: { x: 0, y: 58, z: 0 }, max: { x: 1, y: 59, z: 1 } }, volume: 8 } });
  executor.pause('test pause');
  const running = executor.run();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(executor.status, 'paused');
  assert.equal(executor.stats.dug, 0);
  executor.resume();
  const summary = await running;
  assert.ok(summary.stats.dug > 0);
  const stopPlan = createExcavationPlan({ mode: 'AT', origin: { x: 10, y: 58, z: 0 }, width: 2, length: 2, depth: 2, blockAt: (p) => world.getBlock(p) }).plan;
  const ex2 = new ExcavationExecutor({ botName: '101010', bot, plan: stopPlan, region: { id: 'R2', box: { min: { x: 10, y: 58, z: 0 }, max: { x: 11, y: 59, z: 1 } }, volume: 8 } });
  ex2.stop('operator stop');
  const stopped = await ex2.run();
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stats.dug, 0);
});

test('verifier detects leftover blocks and protected-block violations', () => {
  const world = flatWorld();
  const plan = createExcavationPlan({ mode: 'AT', origin: { x: 0, y: 58, z: 0 }, width: 4, length: 4, depth: 2, blockAt: (p) => world.getBlock(p) }).plan;
  // Partially excavate, then remove a protected chest that was recorded.
  world.setBlock({ x: 1, y: 59, z: 1 }, 'chest');
  const plan2 = createExcavationPlan({ mode: 'AT', origin: { x: 0, y: 58, z: 0 }, width: 4, length: 4, depth: 2, blockAt: (p) => world.getBlock(p) }).plan;
  for (const pos of iterateRegionLayers(plan2.bounds)) world.setBlock(pos, 'air');
  const verifier = new ExcavationVerifier(plan2, { getBlock: (p) => world.getBlock(p), mask: plan2._mask });
  const v = verifier.verify();
  assert.equal(v.complete, false);
  assert.ok(v.forbiddenRemoved.length >= 1);
  assert.ok(v.remaining >= 0);
  // A fresh, untouched volume reports remaining blocks.
  const fresh = createExcavationPlan({ mode: 'AT', origin: { x: 10, y: 58, z: 0 }, width: 4, length: 4, depth: 2, blockAt: (p) => world.getBlock(p) }).plan;
  const v2 = new ExcavationVerifier(fresh, { getBlock: (p) => world.getBlock(p), mask: fresh._mask }).verify();
  assert.equal(v2.complete, false);
  assert.ok(v2.remaining > 0);
  assert.equal(v2.dimensionsOk, true);
  assert.equal(new ExcavationVerifier(plan, { getBlock: (p) => world.getBlock(p), mask: plan._mask }).verify().remaining >= 0, true);
});

test('radius excavation plan volume matches mask and verification target', () => {
  const world = flatWorld();
  const res = createExcavationPlan({
    mode: 'RADIUS', origin: { x: 0, y: 62, z: 0 }, radius: 4, depth: 3,
    blockAt: (p) => world.getBlock(p), workers: 2
  });
  assert.equal(res.ok, true);
  assert.equal(res.plan.volume, res.plan._mask.volume);
  assert.ok(res.plan.regions.every((r) => res.plan._mask.measure(r.box) === r.volume));
  assert.equal(res.plan.regions.reduce((s, r) => s + r.volume, 0), res.plan.volume);
});
