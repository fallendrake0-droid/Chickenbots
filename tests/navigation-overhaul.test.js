'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyBlock } = require('../src/navigation/blocks');
const { standableAt } = require('../src/navigation/standability');
const { planRoute, planCandidates, fallTrajectorySafe } = require('../src/navigation/planner');
const { StuckDetector } = require('../src/navigation/stuck');
const { recoveryGoal } = require('../src/navigation/recovery');
const { NavigationManager } = require('../src/navigation/manager');
const { FleetCongestion } = require('../src/navigation/congestion');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');

function flatWorld(size = 32) {
  return new MockWorld({ size, flat: true });
}

function flatBot(position = { x: 0, y: 65, z: 0 }) {
  const world = flatWorld();
  return { world, bot: new MockBot({ name: '________', world, position }) };
}

test('closed doors and gates are walls; only an actual open state is passable', () => {
  const closed = classifyBlock({ name: 'oak_door', properties: { open: false } });
  assert.equal(closed.kind, 'door-closed');
  assert.equal(closed.solid, true);
  assert.equal(closed.passable, false);
  const open = classifyBlock({ name: 'oak_door', properties: { open: true } });
  assert.equal(open.kind, 'door-open');
  assert.equal(open.passable, true);
  // A door with no readable state is not assumed open.
  const unknown = classifyBlock({ name: 'oak_door' });
  assert.equal(unknown.passable, false);
  // An operator policy that allows opening doors does not make the closed door
  // air: the live pathfinder still has to interact with it.
  const openable = classifyBlock({ name: 'oak_door' }, { canOpenDoors: true });
  assert.equal(openable.openable, true);
  assert.equal(openable.passable, false);
  assert.equal(classifyBlock({ name: 'iron_door', properties: { open: false } }, { canOpenDoors: true }).openable, false);
  assert.equal(classifyBlock({ name: 'iron_door', properties: { open: true } }).passable, true);
  assert.equal(classifyBlock({ name: 'oak_fence_gate', properties: { open: false } }).passable, false);
  assert.equal(classifyBlock({ name: 'oak_fence_gate', properties: { open: true } }).passable, true);
});

test('closed and open trapdoors are distinguishable even though both are walkable', () => {
  const closed = classifyBlock({ name: 'oak_trapdoor', properties: { open: false } });
  const open = classifyBlock({ name: 'oak_trapdoor', properties: { open: true } });
  assert.equal(closed.kind, 'trapdoor-closed');
  assert.equal(open.kind, 'trapdoor-open');
  assert.ok(closed.collisionHeight > open.collisionHeight);
  assert.equal(closed.passable, true);
  assert.equal(open.passable, true);
  // A closed trapdoor is a low body cell but still a floor for the stance above.
  const world = flatWorld(16);
  const y = world.surfaceY(0, 0) + 1;
  world.setBlock({ x: 2, y: y - 1, z: 2 }, 'oak_trapdoor', { open: false, half: 'top' });
  const above = standableAt(world, { x: 2, y, z: 2 });
  assert.equal(above.ok, true, JSON.stringify(above));
  assert.equal(above.support.reason, 'supported');
});

test('a closed door blocks a deterministic route until its state is open', () => {
  const world = flatWorld(24);
  const y = world.surfaceY(0, 0) + 1;
  // Wall across x=5 except a door at z=0.
  for (let z = -6; z <= 6; z++) {
    if (z !== 0) for (let dy = 0; dy <= 1; dy++) world.setBlock({ x: 5, y: y + dy, z }, 'stone');
  }
  world.setBlock({ x: 5, y, z: 0 }, 'oak_door', { open: false, half: 'lower' });
  world.setBlock({ x: 5, y: y + 1, z: 0 }, 'oak_door', { open: false, half: 'upper' });
  const bot = new MockBot({ name: 'A', world, position: { x: 0, y, z: 0 } });
  const closed = planRoute({ reader: bot, from: bot.position, to: { x: 10, y, z: 0 }, range: 1, maxNodes: 4000 });
  assert.ok(!closed.path.some((point) => point.x === 5 && point.z === 0), 'a closed door must not be treated as air');
  world.setBlock({ x: 5, y, z: 0 }, 'oak_door', { open: true, half: 'lower' });
  world.setBlock({ x: 5, y: y + 1, z: 0 }, 'oak_door', { open: true, half: 'upper' });
  const open = planRoute({ reader: bot, from: bot.position, to: { x: 10, y, z: 0 }, range: 1, maxNodes: 4000 });
  assert.equal(open.ok, true, JSON.stringify(open).slice(0, 300));
  assert.ok(open.path.some((point) => point.x === 5 && point.z === 0), 'the open doorway is the shortest route');
});

test('an unloaded chunk is unknown, never air', () => {
  const reader = { getBlock: () => null };
  const verdict = standableAt(reader, { x: 0, y: 64, z: 0 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.unknown, true);
  assert.equal(verdict.reason, 'unloaded');
});

test('a fall is validated through every intermediate body cell', () => {
  const blocks = new Map();
  const set = (x, y, z, name) => blocks.set(`${x},${y},${z}`, { name, properties: {} });
  set(0, 65, 0, 'air'); set(0, 66, 0, 'air');
  set(0, 64, 0, 'lava');
  set(0, 63, 0, 'air'); set(0, 64, 1, 'air'); set(0, 62, 0, 'stone');
  const reader = { getBlock: (pos) => blocks.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || null };
  const bad = fallTrajectorySafe(reader, { x: 0, y: 65, z: 0 }, { x: 0, y: 63, z: 0 }, { maxDrop: 3, allowWater: true });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /lava|trajectory/);
  set(0, 64, 0, 'air');
  const good = fallTrajectorySafe(reader, { x: 0, y: 65, z: 0 }, { x: 0, y: 63, z: 0 }, { maxDrop: 3, allowWater: true });
  assert.equal(good.ok, true);
  set(0, 64, 0, null);
  blocks.delete('0,64,0');
  const unknown = fallTrajectorySafe(reader, { x: 0, y: 65, z: 0 }, { x: 0, y: 63, z: 0 }, { maxDrop: 3, allowWater: true });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'trajectory-unloaded');
});

test('route modes change the safety envelope and report terrain composition', () => {
  const { bot } = flatBot();
  const safe = planRoute({ reader: bot, from: bot.position, to: { x: 8, y: 65, z: 8 }, range: 1, mode: 'safe' });
  const fast = planRoute({ reader: bot, from: bot.position, to: { x: 8, y: 65, z: 8 }, range: 1, mode: 'fast' });
  assert.equal(safe.ok, true);
  assert.equal(fast.ok, true);
  assert.equal(safe.mode, 'SAFE');
  assert.equal(fast.mode, 'FAST');
  assert.ok(safe.terrain && safe.terrain.steps === safe.path.length);
  assert.ok(fast.terrain && fast.terrain.steps === fast.path.length);
  assert.ok(safe.cost >= fast.cost, 'SAFE must not be cheaper than FAST on the same terrain');
});

test('candidate goals are scored by real route cost', () => {
  const { world, bot } = flatBot({ x: 0, y: 64, z: 0 });
  world.setBlock({ x: 4, y: 64, z: 0 }, 'stone');
  world.setBlock({ x: 4, y: 65, z: 0 }, 'stone');
  const result = planCandidates({
    reader: bot,
    from: bot.position,
    candidates: [
      { position: { x: 4, y: 64, z: 0 }, score: 0 },
      { position: { x: 3, y: 64, z: 2 }, score: 2 },
      { position: { x: 3, y: 64, z: -2 }, score: 3 }
    ],
    range: 0,
    maxNodes: 5000
  });
  assert.equal(result.ok, true);
  assert.notDeepEqual(result.plan.candidate.position, { x: 4, y: 64, z: 0 });
  assert.ok(result.trials.length >= 2);
});

test('the planner adds a soft cost around a teammate claim instead of forbidding it', () => {
  const { bot } = flatBot({ x: 0, y: 64, z: 0 });
  const plain = planRoute({ reader: bot, from: bot.position, to: { x: 10, y: 64, z: 0 }, range: 1 });
  const avoided = planRoute({
    reader: bot, from: bot.position, to: { x: 10, y: 64, z: 0 }, range: 1,
    avoid: [{ position: { x: 5, y: 64, z: 0 }, radius: 1.5, weight: 50 }]
  });
  assert.equal(plain.ok, true);
  assert.equal(avoided.ok, true);
  assert.ok(!avoided.path.some((point) => point.x === 5 && point.z === 0), 'route should detour around the claimed cell');
});

test('stuck detection distinguishes no progress from low displacement', () => {
  let now = 0;
  const stuck = new StuckDetector({ now: () => now, windowMs: 1000, graceMs: 0, minSamples: 3 });
  for (let i = 0; i < 8; i++) { now += 200; stuck.sample({ x: 0, y: 65, z: 0 }, now, { target: { x: 10, y: 65, z: 0 } }); }
  assert.equal(stuck.sample({ x: 0, y: 65, z: 0 }, now).stuck, true);

  now = 0;
  const moving = new StuckDetector({ now: () => now, windowMs: 1000, graceMs: 0, minSamples: 3 });
  let last = null;
  for (let i = 0; i < 8; i++) {
    now += 200;
    last = moving.sample({ x: i * 0.2, y: 65, z: 0 }, now, { target: { x: 10, y: 65, z: 0 } });
  }
  assert.equal(last.stuck, false, 'slow but genuine goal progress is not stuck');

  now = 0;
  const oscillating = new StuckDetector({ now: () => now, windowMs: 1000, graceMs: 0, minSamples: 3 });
  let osc = null;
  for (let i = 0; i < 10; i++) {
    now += 200;
    osc = oscillating.sample({ x: i % 2 === 0 ? 0 : 0.8, y: 65, z: 0 }, now, { target: { x: 10, y: 65, z: 0 } });
  }
  assert.equal(osc.stuck, true);
  assert.equal(osc.kind, 'oscillating');
});

test('the recovery ladder has deterministic levels and skips failed cells', () => {
  const { bot } = flatBot();
  const target = { x: 6, y: 64, z: 6 };
  assert.equal(recoveryGoal({ attempt: 0, reader: bot, target }).action, 'restart');
  const offset = recoveryGoal({ attempt: 1, reader: bot, target, range: 1 });
  assert.equal(offset.action, 'offset');
  assert.ok(offset.position);
  const avoided = recoveryGoal({ attempt: 1, reader: bot, target, range: 1, avoid: [offset.position] });
  assert.equal(avoided.action, 'offset');
  assert.notDeepEqual(avoided.position, offset.position);
  assert.equal(recoveryGoal({ attempt: 2, reader: bot, target, start: { x: 0, y: 64, z: 0 } }).action, 'previous');
  assert.equal(recoveryGoal({ attempt: 3, reader: bot, target, start: { x: 0, y: 64, z: 0 } }).action, 'midpoint');
  assert.equal(recoveryGoal({ attempt: 4, reader: bot, target, start: { x: 0, y: 64, z: 0 } }).action, 'abort');
});

test('exact movement keeps range 0 and rejects an invalid range', async () => {
  const bot = { name: 'A', position: { x: 0, y: 65, z: 0 }, health: 20 };
  const manager = new NavigationManager({
    bot,
    reader: null,
    settings: { strict: false, recoveryDelayMs: 0, maxAttempts: 1 }
  });
  let seen = null;
  const exact = await manager.navigate({ x: 1, y: 65, z: 0 }, {
    range: 0, priority: 'operator', owner: 'test', verifyArrival: true
  }, (goal, context) => {
    seen = context;
    bot.position = { ...goal };
    return { ok: true };
  });
  assert.equal(exact.ok, true, JSON.stringify(exact));
  assert.equal(seen.range, 0);
  assert.equal(exact.mode, 'BALANCED');
  const invalid = await manager.navigate({ x: 1, y: 65, z: 0 }, { range: -1 }, () => ({ ok: true }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_RANGE');
});

test('fleet congestion protects operator claims and records corridors', () => {
  let now = 1000;
  const fleet = new FleetCongestion({ now: () => now, radius: 1.5, ttlMs: 5000 });
  assert.equal(fleet.claim('A', { x: 0, y: 64, z: 0 }, { kind: 'task' }).relocated, false);
  const operator = fleet.claim('B', { x: 0, y: 64, z: 0 }, { kind: 'operator', priority: 'operator' });
  assert.equal(operator.relocated, false);
  assert.ok(operator.conflicts.length >= 1);
  const corridor = fleet.claimRoute('A', [{ x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }], { ttlMs: 5000 });
  assert.ok(corridor.path.length === 2);
  assert.equal(fleet.snapshot().corridors.length, 1);
  assert.ok(fleet.corridorConflicts('B', { x: 3, y: 64, z: 0 }).length >= 1);
  fleet.release('A');
  assert.equal(fleet.snapshot().corridors.length, 0);
  now += 6000;
  assert.equal(fleet.snapshot().active.length, 0);
});

test('the path command reports the route mode and terrain summary', async () => {
  const { createRuntime } = require('../src/runtime');
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const result = await runtime.commands.execute('path 6 65 6', { source: 'internal' });
    assert.equal(result.result.ok, true, JSON.stringify(result.result).slice(0, 400));
    assert.ok(result.result.mode);
    assert.ok(result.result.terrain);
    assert.equal(result.result.terrain.steps, result.result.steps);
    assert.equal(result.result.moved, false);
  } finally {
    await runtime.shutdown('test');
  }
});

test('dimension profiles cap the safe drop and reject targets outside world height', () => {
  const { dimensionProfile, normalizeDimension, withinDimension } = require('../src/navigation/dimension');
  assert.equal(normalizeDimension('minecraft:the_nether'), 'nether');
  assert.equal(normalizeDimension('the_end'), 'end');
  const nether = dimensionProfile('minecraft:the_nether');
  assert.equal(nether.maxDrop, 2);
  assert.equal(nether.lavaHazard, true);
  const end = dimensionProfile('end');
  assert.equal(end.voidDeath, true);
  assert.equal(withinDimension(nether, { x: 0, y: -1, z: 0 }), false);
  assert.equal(withinDimension(nether, { x: 0, y: 64, z: 0 }), true);
  const { world, bot } = flatBot();
  const y = world.surfaceY(0, 0) + 1;
  const outside = planRoute({
    reader: bot, from: bot.position, to: { x: 2, y: 400, z: 2 }, range: 1, dimension: 'nether'
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, 'outside-dimension-bounds');
  assert.equal(outside.dimension, 'nether');
  assert.ok(y > 0);
});

test('an exact destination is never faked by shrinking to a different stance', async () => {
  const world = flatWorld(16);
  const ground = world.surfaceY(0, 0); // y63, stand y64
  // Make a small walkable pocket for the bot at ground level.
  world.setBlock({ x: 0, y: ground, z: 0 }, 'air');
  world.setBlock({ x: 0, y: ground + 1, z: 0 }, 'air');
  // A sealed one-block cell two blocks east: air feet/head, real floor, full
  // roof and walls. It is standable but has no legal route in without digging.
  world.setBlock({ x: 2, y: ground - 1, z: 0 }, 'air');
  world.setBlock({ x: 2, y: ground, z: 0 }, 'air');
  world.setBlock({ x: 2, y: ground + 1, z: 0 }, 'air');
  world.setBlock({ x: 2, y: ground - 2, z: 0 }, 'dirt');
  world.setBlock({ x: 2, y: ground + 2, z: 0 }, 'stone');
  world.setBlock({ x: 1, y: ground, z: 0 }, 'stone');
  world.setBlock({ x: 1, y: ground + 1, z: 0 }, 'stone');
  for (const z of [-1, 1]) {
    world.setBlock({ x: 2, y: ground, z }, 'stone');
    world.setBlock({ x: 2, y: ground + 1, z }, 'stone');
  }
  const bot = new MockBot({ name: 'A', world, position: { x: 0, y: ground, z: 0 } });
  const start = { ...bot.position };
  const target = { x: 2, y: ground - 1, z: 0 };
  assert.equal(standableAt(bot, target).ok, true, 'the sealed cell itself is standable');
  const result = await bot.goTo(target, { range: 0, priority: 'operator', timeoutMs: 8000 });
  assert.equal(result.ok, false, JSON.stringify(result).slice(0, 500));
  assert.deepEqual(bot.position, start, 'a failed exact move must not relocate the bot');
  assert.notDeepEqual(bot.position, target);
});

test('a destination in an unloaded chunk is reached by walking the loaded frontier', async () => {
  const world = flatWorld(128);
  const bot = new MockBot({ name: 'A', world, position: { x: 0, y: 65, z: 0 } });
  const realGetBlock = bot.getBlock.bind(bot);
  // Simulate a server view distance of one chunk: only chunks touching the
  // bot's current chunk are loaded. Walking reveals the next chunk.
  bot.getBlock = (pos) => {
    if (!pos) return null;
    const cx = Math.floor(Number(pos.x) / 16);
    const cz = Math.floor(Number(pos.z) / 16);
    const bx = Math.floor(Number(bot.position.x) / 16);
    const bz = Math.floor(Number(bot.position.z) / 16);
    if (Math.max(Math.abs(cx - bx), Math.abs(cz - bz)) > 1) return null;
    return realGetBlock(pos);
  };
  const target = { x: 40, y: 65, z: 0 };
  const result = await bot.goTo(target, { range: 0, priority: 'operator', timeoutMs: 30000 });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 700));
  assert.ok(result.worldStages > 0, 'the move must stage through at least one loaded frontier');
  assert.ok(bot.navigation.telemetry.summary().worldStages > 0, 'frontier stages must be counted in telemetry');
  assert.ok(Math.abs(bot.position.x - target.x) <= 1, `expected to finish near the target, got ${JSON.stringify(bot.position)}`);
  assert.ok(bot.position.x > 16, 'the bot must actually travel into the previously unloaded chunk');
});
