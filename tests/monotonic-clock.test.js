'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { TeamRuntime } = require('../src/runtime');
const { BotActions } = require('../src/actions');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');

/**
 * Uptime and work duration deliberately use different clocks. Uptime is a
 * calendar interval and must agree with /api/build even after a suspension;
 * a status cache's age measures work the process could have done, so a
 * suspension must not make a just-warmed cache look stale.
 */
test('runtime uptime includes wall time spent suspended, matching /api/build', () => {
  let wall = 1_700_000_000_000;
  let mono = 5_000;
  const runtime = new TeamRuntime({
    simulate: true, connect: false, dashboard: false,
    now: () => wall, monoNow: () => mono
  });
  runtime.running = true;
  runtime.startedAt = wall;

  wall += 38 * 60 * 1000;
  mono += 1_250;
  assert.equal(runtime.state().uptimeMs, 38 * 60 * 1000);
});

test('a status cache stays fresh across a wall-clock jump when the process resumes', () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '________', world, position: { x: 0, y: 65, z: 0 } });
  let mono = 10_000;
  const actions = new BotActions({ bot, monoNow: () => mono });
  actions.warmStatus();
  const before = actions.status().statusCache;
  assert.equal(before.entries, actions.statusNames().length);

  const realNow = Date.now;
  try {
    // The VM was suspended for 38 minutes; only wall time moved.
    Date.now = () => realNow() + 38 * 60 * 1000;
    mono += 250;
    const after = actions.status().statusCache;
    assert.equal(after.maxAgeMs, 250);
    assert.ok(after.maxAgeMs < 12_000, `cache age ${after.maxAgeMs}ms must not include suspension`);
  } finally {
    Date.now = realNow;
  }
});
