'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntime } = require('../src/runtime');
const { statusSnapshot } = require('../src/runtimeState');
const { navigationPolicy, adaptiveSearchRadius } = require('../src/navigation/policy');
const { StuckDetector } = require('../src/navigation/stuck');
const { recoveryGoal } = require('../src/navigation/recovery');
const { NavigationManager } = require('../src/navigation/manager');
const { configureMovements } = require('../src/navigation/movements');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');

test('one navigation policy describes the pathfinder budget and scales long searches', () => {
  const policy = navigationPolicy();
  assert.equal(policy.strictDestinations, true);
  assert.ok(policy.taskAttempts >= 2, 'a task route gets at least one recovery retry');
  assert.equal(adaptiveSearchRadius(64, { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 64 }, { enabled: true, max: 512 }), 112);
  assert.equal(adaptiveSearchRadius(0, { x: 0, y: 64, z: 0 }, { x: 100, y: 64, z: 0 }, { enabled: true, scale: 1.5, max: 512 }), 166);
  assert.equal(adaptiveSearchRadius(64, { x: 0, y: 64, z: 0 }, { x: 1000, y: 64, z: 0 }, { enabled: true, scale: 1.5, max: 512 }), 512);
  assert.equal(adaptiveSearchRadius(64, { x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 4 }, { enabled: false }), 64);
});

test('the stuck detector measures the recent window, not the whole sample ring', () => {
  let now = 0;
  const detector = new StuckDetector({ now: () => now, windowMs: 2500 });
  detector.sample({ x: 0, y: 65, z: 0 }, 0);
  let flaggedAt = null;
  for (let at = 150; at <= 5000; at += 150) {
    now = at;
    const sample = detector.sample({ x: 0, y: 65, z: 0 }, at);
    if (sample.stuck && flaggedAt === null) flaggedAt = at;
  }
  assert.ok(flaggedAt !== null && flaggedAt <= 3000, `frozen bot should be flagged near 2.5s, got ${flaggedAt}`);
  assert.ok(detector.snapshot().samples < 40, 'old samples are discarded from the observation window');
});

test('a gross short arrival is retried even without verifyArrival', async () => {
  const bot = { name: 'A', position: { x: 0, y: 65, z: 0 }, health: 20 };
  const reader = {
    getBlock(pos) { return pos.y === 64 ? { name: 'stone' } : { name: 'air' }; }
  };
  const nav = new NavigationManager({ bot, reader, settings: { recoveryDelayMs: 0 } });
  let calls = 0;
  const result = await nav.navigate({ x: 20, y: 65, z: 0 }, { range: 1, timeoutMs: 5000 }, async () => {
    calls++;
    return { ok: true, path: [], steps: 0, shortBy: 12 };
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ARRIVAL_UNVERIFIED');
  assert.equal(result.arrivalUnverified, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  assert.match(result.error, /12\.0 blocks short/);
});

test('recovery searches around the requested target rather than a fixed offset', () => {
  const reader = {
    getBlock(pos) {
      if (pos.y === 64) return { name: 'stone' };
      return { name: 'air' };
    }
  };
  const plan = recoveryGoal({
    attempt: 1, reader, target: { x: 10, y: 65, z: -4 },
    start: { x: 0, y: 65, z: 0 }, range: 1, maxDrop: 3, allowWater: true
  });
  assert.equal(plan.action, 'offset');
  assert.ok(Math.hypot(plan.position.x - 10, plan.position.z + 4) <= 5, `offset must stay near the target: ${JSON.stringify(plan.position)}`);
  assert.ok(plan.position.y >= 64 && plan.position.y <= 66);
});

test('the runtime snapshot exposes one navigation section and per-bot state', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const snapshot = statusSnapshot(runtime.services);
    assert.ok(snapshot.navigation, 'navigation section must exist');
    assert.equal(snapshot.navigation.policy.strictDestinations, true);
    assert.ok(snapshot.navigation.totals.bots >= 1);
    assert.equal(typeof snapshot.navigation.totals.successRate, 'object');
    const first = snapshot.bots[0];
    assert.ok(first.navigation, 'every bot row carries navigation state');
    assert.equal(typeof first.navigation.enabled, 'boolean');
    assert.ok(first.navigation.telemetry, 'telemetry is included');
  } finally {
    await runtime.shutdown('test');
  }
});

test('operator stop is an explicit command and reports the post-state', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const name = runtime.bots.keys().next().value;
    const result = await runtime.commands.execute(`bot ${name} stop`, { source: 'internal' });
    assert.equal(result.result.ok, true, JSON.stringify(result.result));
    assert.equal(result.result.bot, name);
    assert.equal(typeof result.result.cancelled, 'boolean');
    assert.equal(result.result.moving, false);
  } finally {
    await runtime.shutdown('test');
  }
});

test('a mock work target in the air no longer teleports the bot onto it', async () => {
  const world = new MockWorld({ flat: true, seed: 4242 });
  const bot = new MockBot({ name: 'walker', world, inventory: { iron_axe: 1 }, position: { x: 0, y: 65, z: 0 } });
  const target = { x: 6, y: 68, z: 6 };
  const result = await bot.goTo(target, { range: 2, timeoutMs: 8000 });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
  assert.notDeepEqual(
    { x: bot.position.x, y: bot.position.y, z: bot.position.z },
    target,
    'the bot must walk to a standable stance, not snap to the requested air cell'
  );
  assert.ok(bot.position.y <= 66, `a ground walk should stay on the ground, got y=${bot.position.y}`);
  assert.ok(Math.hypot(bot.position.x - target.x, bot.position.z - target.z) <= 4);
});

test('movement overrides reach the pathfinder weights, including a zero drop limit', () => {
  const movements = { blocksToAvoid: new Set() };
  const registry = { blocksByName: { lava: { id: 1 }, water: { id: 2 } }, itemsByName: {} };
  configureMovements(movements, {
    registry,
    settings: { maxDrop: 3, allowWater: true, allowDig: false, allowScaffold: false, sprint: true, openDoors: false },
    options: { maxDrop: 0, allowWater: false }
  });
  assert.equal(movements.maxDropDown, 0);
  assert.equal(movements.canDig, false);
  assert.equal(movements.canOpenDoors, false);
  assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.exclusionAreasStep[0]({ name: 'water', type: 2 }), 1000);
  assert.equal(movements.exclusionAreasStep[0]({ name: 'lava', type: 1, liquid: true }), 1000);
});

test('operator pathfinding gets a larger planning slice than autonomous tasks', () => {
  const { pathfinderBudgets } = require('../src/navigation/policy');
  const task = pathfinderBudgets('task');
  const operator = pathfinderBudgets('operator');
  const retry = pathfinderBudgets('operator', { attempt: 2 });
  assert.equal(task.operator, false);
  assert.equal(operator.operator, true);
  assert.ok(operator.thinkTimeoutMs > task.thinkTimeoutMs, JSON.stringify({ task, operator }));
  assert.ok(operator.tickTimeoutMs > task.tickTimeoutMs, JSON.stringify({ task, operator }));
  assert.ok(retry.thinkTimeoutMs > operator.thinkTimeoutMs, 'a second attempt may plan longer');
});
