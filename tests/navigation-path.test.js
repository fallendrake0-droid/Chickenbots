'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntime } = require('../src/runtime');
const { FleetCongestion } = require('../src/navigation/congestion');

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
