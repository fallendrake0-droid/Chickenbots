'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findBlocks, statusJitter, STATUS_SCAN_BUDGET_MS, ACTION_SCAN_BUDGET_MS } = require('../src/actions/common');
const { MiningController } = require('../src/actions/mining');
const { TeamCombatCoordinator } = require('../src/combat/team');
const { statusSnapshot } = require('../src/runtimeState');
const { createRuntime } = require('../src/runtime');
const { config } = require('../src/config');

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('status scans are hard-bounded instead of walking the whole cube', () => {
  let lookups = 0;
  const bot = {
    ready: true,
    position: { x: 0, y: 64, z: 0 },
    getBlock() { throw new Error('the name-only path must be used'); },
    world: {
      blockNameAt() {
        lookups += 1;
        sleepMs(1);
        return 'dirt';
      }
    }
  };
  const started = Date.now();
  const found = findBlocks(bot, ['diamond_ore'], { radius: 64, limit: 5, budgetMs: STATUS_SCAN_BUDGET_MS });
  const elapsed = Date.now() - started;
  assert.deepEqual(found, []);
  assert.ok(lookups > 0, 'the scan must have started');
  // A full 129^3 cube with a 1ms lookup would take minutes. The budget check
  // runs every 32 positions, so allow generous headroom for a loaded runner.
  assert.ok(elapsed < 500, `bounded status scan took ${elapsed}ms`);
});

test('findBlocks prefers the indexed world search and filters the y window', () => {
  let calls = 0;
  const bot = {
    ready: true,
    position: { x: 0, y: 64, z: 0 },
    getBlock() { throw new Error('indexed world search must be used'); },
    world: {
      findBlocks(names, near, radius, limit, yFrom, yTo) {
        calls += 1;
        assert.deepEqual(names, ['red_bed']);
        assert.equal(radius, 8);
        assert.equal(limit, 5);
        assert.equal(yFrom, 52);
        assert.equal(yTo, 76);
        return [
          { x: 0, y: 200, z: 0, name: 'red_bed' },
          { x: 1, y: 64, z: 0, name: 'red_bed' },
          { x: 2, y: 65, z: 0, name: 'stone' }
        ];
      }
    }
  };
  const found = findBlocks(bot, ['red_bed'], { radius: 8, limit: 5 });
  assert.equal(calls, 1);
  assert.deepEqual(found, [{ x: 1, y: 64, z: 0, name: 'red_bed' }]);
});

test('status cache jitter is spread across the configured roster', () => {
  const roster = [...config.team.names];
  // The old first-character jitter produced only two buckets because all names
  // start with 0 or 1; every cache then expired in the same snapshot.
  const buckets = new Set(roster.map((name) => statusJitter(name)));
  assert.ok(buckets.size >= Math.min(5, roster.length), `expected the roster to use at least five TTL buckets, got ${buckets.size}`);
  assert.equal(statusJitter(roster[0]), statusJitter(roster[0]));
  assert.notEqual(statusJitter(roster[0], 1), statusJitter(roster[0]));
});

test('the mining status panel passes its hard budget to the ore scan', () => {
  const bot = {
    name: '10101000',
    ready: true,
    position: { x: 0, y: 64, z: 0 },
    inventory: {},
    bestToolFor: () => null,
    getBlock: () => ({ name: 'stone' })
  };
  const mining = new MiningController({ bot });
  let options = null;
  mining.findOres = (opts) => { options = opts; return []; };
  mining.status();
  assert.equal(options.budgetMs, STATUS_SCAN_BUDGET_MS);
  assert.equal(options.radius, 5);
});

test('team status reuses a provided controller snapshot instead of rescanning', () => {
  const coordinator = new TeamCombatCoordinator({
    controllers: [{
      bot: { name: '10101000', position: { x: 0, y: 64, z: 0 } },
      state: 'IDLE',
      status() { throw new Error('controller status must not be recomputed'); }
    }]
  });
  const cached = { state: 'ENGAGING', health: 19, armorPoints: 7, weapon: { name: 'iron_sword' }, offhand: 'shield', totems: 1, goldenApples: 2, target: null };
  const status = coordinator.status({ controllerStatus: new Map([['10101000', cached]]) });
  assert.equal(status.bots.length, 1);
  assert.equal(status.bots[0].state, 'ENGAGING');
  assert.equal(status.bots[0].health, 19);
  assert.equal(status.bots[0].weapon, 'iron_sword');
});

test('one snapshot computes excavation status once and reuses combat status', () => {
  let excavationCalls = 0;
  const excavationStatus = { active: [], counts: { INCOMPLETE: 1 } };
  let runtimeArgument = null;
  const combatTeamStatus = { enabled: true, mode: 'GUARD', bots: [], roles: {}, focus: null, locks: [] };
  const services = {
    mode: 'simulation',
    bots: new Map(),
    actions: { list: () => [] },
    builders: new Map(),
    imported: new Map(),
    coordinator: { leader: null, getState: () => ({}) },
    taskBoard: {
      stats: () => ({ byStatus: {}, tasks: 0 }),
      detectDeadlocks: () => [],
      listTasks: () => [],
      listObjectives: () => [],
      locks: new Map(),
      regions: new Map()
    },
    excavation: {
      status() { excavationCalls += 1; return excavationStatus; },
      history: [],
      previews: new Map()
    },
    combatTeam: {
      enabled: true,
      mode: 'GUARD',
      roles: {},
      focus: null,
      status: () => combatTeamStatus,
      list: () => []
    },
    library: null,
    ledger: null,
    memory: null,
    comms: null,
    logger: { warn() {} },
    runtime: {
      state(options) { runtimeArgument = options; return { bots: [], uptimeMs: 5, serverVersion: '1.21' }; }
    }
  };
  const snapshot = statusSnapshot(services);
  assert.equal(excavationCalls, 1, 'buildAlerts must reuse the excavation status it was given');
  assert.equal(runtimeArgument.combatTeamStatus, combatTeamStatus, 'runtime.state must not rebuild team combat status');
  assert.ok(Number.isFinite(snapshot.performance.snapshotMs));
  assert.ok(snapshot.performance.sections.actions >= 0);
  assert.equal(snapshot.overview.alerts.some((alert) => /incomplete excavation/.test(alert.message)), true);
});


test('startup warm-up makes the very first dashboard snapshot routine (<50ms)', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  await runtime._warmStatusCaches();
  let snapshot;
  for (let i = 0; i < 3; i++) {
    snapshot = statusSnapshot(runtime.services);
    assert.ok(snapshot.performance.sections.actions < 50, `actions section ${snapshot.performance.sections.actions}ms`);
    assert.ok(snapshot.performance.sections.builds < 50, `builds/library section ${snapshot.performance.sections.builds}ms`);
  }
  assert.ok(snapshot.performance.snapshotMs < 100, `warm snapshot took ${snapshot.performance.snapshotMs}ms`);
});


test('a dashboard snapshot reads the warmed status cache and never calls a live controller', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  await runtime._warmStatusCaches();
  const actions = runtime.actions.list();
  let forbidden = 0;
  for (const entry of actions) {
    for (const name of entry.statusNames()) {
      const controller = entry[name];
      if (controller && typeof controller.status === 'function') {
        controller.status = () => { forbidden++; throw new Error('live controller scan on the snapshot path'); };
      }
    }
  }
  const snapshot = statusSnapshot(runtime.services);
  assert.equal(forbidden, 0, 'the snapshot must use the cache, not controller.status()');
  assert.equal(snapshot.freshness.actionStatusFresh, true);
  assert.ok(snapshot.freshness.maxActionStatusAgeMs >= 0);
  assert.equal(snapshot.freshness.actionStatus.length, actions.length);
  assert.ok(snapshot.performance.sections.actions < 50, `actions section ${snapshot.performance.sections.actions}ms`);
  for (const section of ['survival', 'combat', 'mining', 'farming', 'recovery']) {
    assert.ok(snapshot[section] && snapshot[section].length === actions.length, `${section} is served from cache`);
  }
  assert.equal(snapshot.inventory.bots.length, actions.length, 'inventory is served from the cache');
});

test('action scans are near-first and hard-bounded on a slow world', () => {
  let lookups = 0;
  const bot = {
    ready: true,
    position: { x: 0, y: 64, z: 0 },
    world: {
      blockNameAt(x, y, z) {
        lookups += 1;
        sleepMs(1);
        return x === 1 && y === 64 && z === 0 ? 'oak_log' : 'air';
      }
    }
  };
  const started = Date.now();
  const found = findBlocks(bot, ['oak_log'], { radius: 64, limit: 5, budgetMs: ACTION_SCAN_BUDGET_MS });
  const elapsed = Date.now() - started;
  assert.deepEqual(found, [{ x: 1, y: 64, z: 0, name: 'oak_log' }], 'the nearest block must be visited before the budget expires');
  assert.ok(elapsed < ACTION_SCAN_BUDGET_MS + 150, `action scan took ${elapsed}ms`);
  assert.ok(lookups < 2000, `bounded scan visited ${lookups} positions`);
});
