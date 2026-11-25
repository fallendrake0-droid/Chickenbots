'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findBlocks, statusJitter, STATUS_SCAN_BUDGET_MS } = require('../src/actions/common');
const { MiningController } = require('../src/actions/mining');
const { TeamCombatCoordinator } = require('../src/combat/team');
const { statusSnapshot } = require('../src/runtimeState');

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

test('status cache jitter is spread across the real binary roster', () => {
  const roster = ['________', '10101000', '01010100', '11001100', '00110000', '11101000', '11101010', '10001000', '11001010', '11101001'];
  // The old first-character jitter produced only two buckets because every
  // name starts with 0 or 1; ten caches then expired in the same snapshot.
  const buckets = new Set(roster.map((name) => statusJitter(name)));
  assert.ok(buckets.size >= 8, `expected the roster to use at least eight TTL buckets, got ${buckets.size}`);
  assert.equal(statusJitter('10101000'), statusJitter('10101000'));
  assert.notEqual(statusJitter('10101000', 1), statusJitter('10101000'));
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
