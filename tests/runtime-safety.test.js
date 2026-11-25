'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TeamRuntime } = require('../src/runtime');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { config } = require('../src/config');

test('ready bots run safety ticks while the team is still joining', async () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  const calls = [];
  const readyBot = { name: '________', ready: true, connected: true, spawned: true, authenticated: true, health: 20 };
  const joiningBot = { name: '10101000', ready: false, connected: false, spawned: false, authenticated: false, health: 20 };
  const names = ['________', '10101000', '01010100', '11001100', '00110000'];
  runtime.bots = new Map(names.map((name) => [name, name === readyBot.name ? readyBot : joiningBot]));
  runtime.actions = {
    list: () => [
      { bot: readyBot, safetyTick: async () => { calls.push('ready'); } },
      { bot: joiningBot, safetyTick: async () => { calls.push('joining'); } }
    ]
  };
  runtime.ticking = false;
  runtime.running = true;
  await runtime._tick();
  assert.deepEqual(calls, ['ready']);
  // The team view must not keep four disconnected bots green while the gate is
  // closed; coordinator state is synchronised before the autonomy check.
  const team = runtime.coordinator.getState();
  assert.equal(team.team.online, 1);
  assert.equal(team.bots.find((bot) => bot.name === '________').online, true);
  assert.equal(team.bots.find((bot) => bot.name === '10101000').online, false);
  const stats = runtime.eventLoopStats();
  assert.ok(stats && Number.isInteger(stats.samples), 'event loop delays must be measurable');
  runtime.eventLoopDelay.disable();
});

test('pausing autonomy never stops reconnect supervision', async () => {
  const runtime = new TeamRuntime({ simulate: false, connect: true, dashboard: false });
  runtime.bots = new Map();
  runtime.actions = { list: () => [] };
  runtime.running = true;
  runtime.paused = true;
  runtime.supervisorTicks = 1;
  runtime._syncBots = () => {};
  let recovered = 0;
  runtime._recoverDisconnected = async () => { recovered++; };
  await runtime._tick();
  assert.equal(recovered, 1, 'a paused runtime must still restore dropped bots');
  assert.equal(runtime.ticking, false);
});

test('live autonomy waits for spawn chunks to settle before starting ten pathfinders', () => {
  const runtime = new TeamRuntime({ simulate: false, connect: false, dashboard: false });
  Object.defineProperty(runtime, 'allBotsReady', { configurable: true, get: () => true });
  runtime.autonomyArmed = true;
  runtime.autonomyArmedAt = runtime.now() - 1000;
  assert.equal(runtime.autonomySettled, false);
  assert.equal(runtime.autonomyAllowed, false);
  assert.ok(runtime.autonomyWarmupRemainingMs > 0);
  runtime.autonomyArmedAt = runtime.now() - config.autonomy.warmupMs - 1;
  assert.equal(runtime.autonomySettled, true);
  assert.equal(runtime.autonomyAllowed, true);
});

test('a slow controller action never blocks the autonomy tick or the next bot', async () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const bot = { name: '________', connected: true, spawned: true, health: 20 };
  runtime.actions = {
    list: () => [{
      bot,
      recovery: { canWork: () => true },
      safetyTick: async () => {},
      step: async () => { started.push(bot.name); await gate; }
    }]
  };
  runtime.coordinator = { getAssignment: () => ({ type: 'MINE_ORE' }) };
  runtime.ticks = 20;
  const before = Date.now();
  const result = runtime._launchBotWork();
  assert.ok(Date.now() - before < 500, 'launching work must not await the action');
  assert.equal(result.launched, 1);
  assert.equal(runtime.botSteps.size, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1);
  // A second launch cannot duplicate the same bot's step.
  runtime._launchBotWork();
  assert.equal(started.length, 1);
  release();
  await runtime.drainBotWork(1000);
  assert.equal(runtime.botSteps.size, 0);
});

test('a bot whose spawn column is still streaming does safety work, not pathfinding', async () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  const calls = [];
  const bot = { name: '________', connected: true, spawned: true, health: 20, isChunkReady: () => false };
  runtime.actions = {
    list: () => [{
      bot,
      recovery: { canWork: () => true },
      safetyTick: async () => { calls.push('safety'); },
      step: async () => { calls.push('step'); }
    }]
  };
  runtime.coordinator = { getAssignment: () => ({ type: 'CHOP_WOOD' }) };
  runtime.ticks = 20;
  const result = runtime._launchBotWork();
  assert.equal(result.launched, 0);
  await runtime.drainBotWork(1000);
  assert.deepEqual(calls, ['safety'], 'no pathfinder may start before the local column exists');
});

test('a terminal kick is reconnected even if the legacy connected flag is stale', async () => {
  const runtime = new TeamRuntime({ simulate: false, connect: true, dashboard: false });
  runtime.serverVersion = '26.1';
  const started = [];
  runtime._startConnection = (bot) => { started.push(bot.name); return Promise.resolve({ ok: true }); };
  runtime.bots = new Map([['________', {
    name: '________',
    connected: true,
    _transportDead: true,
    ready: false,
    lastSessionEndedAt: 0,
    connection: { snapshot: () => ({ generation: 1, state: 'failed', open: false, spawned: true, authenticated: true }) }
  }]]);
  await runtime._recoverDisconnected();
  assert.deepEqual(started, ['________'], 'a dead transport must not be skipped because connected=true');
});

test('connect() reopens a socket after a terminal kick left connected=true', async () => {
  const { RealBot } = require('../src/bot/realBot');
  const real = new RealBot({ name: '________', createBot: () => ({}) });
  let opened = 0;
  real.connected = true;
  real._transportDead = true;
  real._connectOnce = async () => { opened++; return { ok: true }; };
  const result = await real.connect();
  assert.equal(result.ok, true);
  assert.equal(opened, 1);
});

test('reconnect supervision is callable even while a bot action is in flight', async () => {
  const runtime = new TeamRuntime({ simulate: false, connect: true, dashboard: false });
  runtime.serverVersion = '26.1';
  let recovered = 0;
  runtime._recoverDisconnected = async () => { recovered++; };
  await runtime._superviseConnections();
  assert.equal(recovered, 1);
  assert.equal(runtime.supervisorBusy, false);
});

test('bots wait for the version probe instead of burning attempts on VERSION_UNRESOLVED', async () => {
  const runtime = new TeamRuntime({ simulate: false, connect: true, dashboard: false });
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  runtime._ensureServerVersion = async () => {
    await gate;
    runtime.serverVersion = '26.1';
    return true;
  };
  runtime._acquireJoinSlot = async () => () => {};
  runtime._markJoinSuccess = () => ({ strikes: 0, maxStrikes: 10 });
  runtime._anchorHomeToSpawn = () => {};
  const connects = [];
  const bot = {
    name: '________', ready: false, retryPaused: false, lastSessionEndedAt: 0,
    version: 'auto', passwordRequired: false,
    connect: async () => { connects.push('connect'); bot.ready = true; return { ok: true }; }
  };
  runtime.bots = new Map([[bot.name, bot]]);
  const task = runtime._connectWithRetry(bot);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(connects, [], 'no socket may be opened before the version is resolved');
  releaseGate();
  const result = await task;
  assert.equal(result.ok, true);
  assert.equal(connects.length, 1);
  runtime.eventLoopDelay.disable();
});

test('the supervisor only claims it restored a bot that had a previous session', async () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  const logs = [];
  runtime.logger = { info: (message) => logs.push(String(message)), warn() {}, error() {}, debug() {} };
  const initial = {
    name: '________', connected: false, ready: false, spawned: false,
    authenticated: false, lastSessionEndedAt: 0
  };
  runtime.bots = new Map([[initial.name, initial]]);
  let starts = 0;
  runtime._startConnection = () => { starts++; return Promise.resolve({ ok: true }); };
  await runtime._recoverDisconnected();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.ok(!logs.some((line) => line.includes('reconnect supervisor restored')), 'an initial join is not a restoration');

  const returning = { ...initial, lastSessionEndedAt: Date.now() - 1000 };
  runtime.bots = new Map([[returning.name, returning]]);
  await runtime._recoverDisconnected();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  assert.ok(logs.some((line) => line.includes('reconnect supervisor restored')), 'a real reconnect is reported');
  runtime.eventLoopDelay.disable();
});

test('a single bot login stall does not trigger the fleet-wide join pause', () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  const backs = [];
  runtime._registerJoinBackoff = (kind, error) => backs.push({ kind, error });
  runtime.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const bot = { name: '10101000' };
  const healthy = ['________', '01010100', '11001100', '00110000'].map((name) => ({
    name, ready: true, connected: true, spawned: true, authenticated: true
  }));
  runtime.bots = new Map([[bot.name, bot], ...healthy.map((entry) => [entry.name, entry])]);
  assert.equal(runtime._registerJoinFailure(bot, { ok: false, error: 'timed out after 30000ms waiting for protocol login' }), 'stalled');
  assert.deepEqual(backs, [], 'a login timeout must stay per-bot');
  assert.equal(runtime.joinCooldownUntil, 0, 'one bot stalling must not close the fleet join queue');
  assert.ok(healthy.every((entry) => entry.ready && entry.connected), 'the other four sessions remain untouched');
  assert.equal(runtime._registerJoinFailure(bot, { ok: false, error: 'Connection throttled! Please wait before reconnecting' }), 'throttled');
  assert.equal(backs.length, 1);
  assert.equal(backs[0].kind, 'throttled');
  runtime.eventLoopDelay.disable();
});

test('the dashboard state exposes the per-bot retry attempt without a fleet pause', () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  const bot = { name: '10101000', ready: false, connected: false, spawned: false, authenticated: false };
  runtime.bots = new Map([[bot.name, bot]]);
  const retry = { attempt: 3, nextRetryAt: Date.now() + 30000, lastError: 'timed out after 30000ms waiting for protocol login', since: Date.now() };
  runtime.retryMeta.set(bot.name, retry);
  const row = runtime.state().bots.find((entry) => entry.name === bot.name);
  assert.deepEqual(row.retry, retry);
  assert.equal(runtime.joinCooldownUntil, 0);
  runtime.eventLoopDelay.disable();
});

test('an operator command takes an exclusive slot and cancels the autonomous step', async () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  const cancelled = [];
  runtime.bots = new Map([['________', { name: '________', cancelAction: (reason) => cancelled.push(reason) }]]);
  let finishPrior;
  const prior = new Promise((resolve) => { finishPrior = resolve; });
  runtime.botSteps.set('________', prior);
  let ran = false;
  const command = runtime.runExclusive('________', async () => {
    ran = true;
    assert.equal(runtime.commandLocks.has('________'), true, 'the lock is held while the command runs');
    return { ok: true };
  });
  assert.equal(runtime.commandLocks.has('________'), true);
  assert.deepEqual(cancelled, ['operator command']);
  finishPrior();
  const result = await command;
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, true);
  assert.equal(runtime.commandLocks.has('________'), false, 'the lock is released in finally');
});

test('pre-join safety is scheduled per bot and never blocks the runtime tick', async () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  const bot = new MockBot({ name: '________', world: new MockWorld({ flat: true }) });
  runtime.bots = new Map([[bot.name, bot]]);
  let started = 0;
  runtime.actions = {
    list: () => [{
      bot,
      safetyTick: async () => { started++; await new Promise((resolve) => setTimeout(resolve, 250)); }
    }]
  };
  runtime.running = true;
  runtime.ticking = false;
  Object.defineProperty(runtime, 'autonomyAllowed', { configurable: true, get: () => false });
  const began = Date.now();
  await runtime._tick();
  const elapsed = Date.now() - began;
  assert.ok(elapsed < 150, `_tick returned in ${elapsed}ms instead of waiting for the safety action`);
  assert.equal(started, 1, 'the safety action really started');
  assert.equal(runtime.botSafety.has(bot.name), true, 'the per-bot map prevents a second overlapping pass');
  await Promise.allSettled([...runtime.botSafety.values()]);
  assert.equal(runtime.botSafety.has(bot.name), false, 'the slot is released when the action settles');
});

test('per-stage safety timings survive for the dashboard diagnostics', () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  runtime._recordSafetyStages('________', { totalMs: 12, stages: { assess: 1, survival: 8, defend: 3 } }, Date.now() - 12);
  const stored = runtime.safetyStages.get('________');
  assert.equal(stored.totalMs, 12);
  assert.deepEqual(stored.stages, { assess: 1, survival: 8, defend: 3 });
  assert.ok(stored.at > 0);
});
