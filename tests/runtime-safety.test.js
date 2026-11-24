'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TeamRuntime } = require('../src/runtime');

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
