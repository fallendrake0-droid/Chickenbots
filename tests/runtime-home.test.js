'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TeamRuntime } = require('../src/runtime');

function bareRuntime() {
  const runtime = Object.create(TeamRuntime.prototype);
  runtime.home = { x: 10, y: 64, z: 10 };
  runtime.homeSource = 'test';
  runtime.homeAnchored = true;
  runtime.actions = { list: () => [] };
  runtime.world = null;
  let writes = 0;
  runtime.memory = { setHome: () => { writes += 1; } };
  return { runtime, writes: () => writes };
}

test('home cannot be moved to NaN or out-of-world coordinates', () => {
  const { runtime, writes } = bareRuntime();
  for (const bad of [
    { x: 'abc', y: 64, z: 10 },
    { x: 10, y: Number.NaN, z: 10 },
    { x: 40_000_000, y: 64, z: 10 },
    { x: 10, y: 10_000, z: 10 }
  ]) {
    const result = runtime.setHome(bad);
    assert.equal(result.ok, false);
    assert.deepEqual(runtime.home, { x: 10, y: 64, z: 10 });
  }
  assert.equal(writes(), 0);
});

test('valid home coordinates are floored and persisted once', () => {
  const { runtime, writes } = bareRuntime();
  const result = runtime.setHome({ x: 1.9, y: 65.2, z: -3.7 }, { snapToSurface: false, source: 'operator' });
  assert.equal(result.ok, true);
  assert.deepEqual(runtime.home, { x: 1, y: 65, z: -4 });
  assert.equal(writes(), 1);
});
