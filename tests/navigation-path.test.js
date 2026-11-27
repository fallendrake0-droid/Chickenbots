'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntime } = require('../src/runtime');
const { FleetCongestion } = require('../src/navigation/congestion');
const { planRoute } = require('../src/navigation/planner');
const { NavigationManager } = require('../src/navigation/manager');

test('path plans a route without moving the bot', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const bot = runtime.bots.get(runtime.bots.keys().next().value);
    const before = { ...bot.position };
    const result = await runtime.commands.execute('path 12 65 12', { source: 'internal' });
    assert.equal(result.result.ok, true, JSON.stringify(result.result).slice(0, 500));
    assert.equal(result.result.reachable, true);
    assert.ok(result.result.steps > 0);
    assert.equal(result.result.moved, false);
    assert.deepEqual({ x: bot.position.x, y: bot.position.y, z: bot.position.z }, before);
    assert.deepEqual(result.result.target, { x: 12, y: 65, z: 12 });
    assert.ok(Array.isArray(result.result.path));
  } finally {
    await runtime.shutdown('test');
  }
});

test('path accepts a leading or trailing bot name and reports navigation state', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const name = runtime.bots.keys().next().value;
    for (const line of [`path ${name} 4 65 4`, `path 4 65 4 ${name}`, `path ${name}`]) {
      const result = await runtime.commands.execute(line, { source: 'internal' });
      assert.equal(result.result.ok, true, `${line}: ${JSON.stringify(result.result).slice(0, 400)}`);
      assert.equal(result.result.bot, name);
    }
    const status = await runtime.commands.execute(`path ${name}`, { source: 'internal' });
    assert.ok(status.result.navigation, 'navigation status must be exposed');
    assert.equal(typeof status.result.navigation.telemetry.attempts, 'number');
  } finally {
    await runtime.shutdown('test');
  }
});

test('fleet congestion relocates a second claim and still reports the conflict', () => {
  const now = { at: 1000 };
  const fleet = new FleetCongestion({ now: () => now.at, radius: 1.5, ttlMs: 5000 });
  const first = fleet.claim('A', { x: 0, y: 64, z: 0 }, { kind: 'task' });
  assert.equal(first.relocated, false);
  const second = fleet.claim('B', { x: 0, y: 64, z: 0 }, { kind: 'task' });
  assert.equal(second.conflicts.length, 1);
  assert.equal(second.relocated, true);
  assert.notDeepEqual(second.position, { x: 0, y: 64, z: 0 });
  const operator = fleet.claim('C', { x: 0, y: 64, z: 0 }, { kind: 'operator', mayRelocate: false });
  assert.equal(operator.relocated, false);
  assert.ok(operator.conflicts.length >= 1, 'operator moves report but do not yield');
  assert.equal(fleet.snapshot().relocations, 1);
  now.at += 6000;
  assert.equal(fleet.snapshot().active.length, 0);
});

function flatReader(groundY = 63) {
  return {
    getBlock(pos) {
      if (pos.y === groundY) return { name: 'stone' };
      return { name: 'air' };
    }
  };
}

test('planner stops at its wall-clock deadline instead of the node limit', () => {
  const result = planRoute({
    reader: flatReader(),
    from: { x: 0, y: 64, z: 0 },
    to: { x: 40, y: 64, z: 40 },
    maxNodes: 100000,
    deadline: Date.now() - 1
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'time-budget');
  assert.equal(result.expanded, 0, 'the deadline is checked before the first expansion');
});

test('planner without a deadline still returns an open-ground route', () => {
  const result = planRoute({
    reader: flatReader(),
    from: { x: 0, y: 64, z: 0 },
    to: { x: 12, y: 64, z: 12 }
  });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.ok(result.path.length > 0);
  assert.equal(result.reason, 'path');
});

test('a short arrival gets one re-path before reporting ARRIVAL_UNVERIFIED', async () => {
  const bot = { name: 'A', position: { x: 0, y: 65, z: 0 }, health: 20 };
  const reader = {
    getBlock(pos) {
      if (pos.y === 64) return { name: 'stone' };
      return { name: 'air' };
    }
  };
  const nav = new NavigationManager({ bot, reader, settings: { recoveryDelayMs: 0 } });
  let calls = 0;
  const result = await nav.navigate({ x: 5, y: 65, z: 0 }, { range: 1, timeoutMs: 5000, attempts: 1, verifyArrival: true }, async () => {
    calls++;
    // The first attempt claims success without moving: exactly the transient
    // "stopped short of home storage" case. The retry moves the bot and is
    // verified normally.
    if (calls === 2) bot.position = { x: 5, y: 65, z: 0 };
    return { ok: true, path: [], steps: 0 };
  });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
  assert.equal(result.arrived, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});
