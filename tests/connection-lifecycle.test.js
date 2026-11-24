'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ConnectionStateMachine, STATES } = require('../src/bot/connectionState');
const { ClientTickScheduler } = require('../src/bot/clientTicker');
const { JoinScheduler } = require('../src/bot/joinScheduler');
const { RealBot } = require('../src/bot/realBot');
const { connectionStatus } = require('../src/bot/status');
const { TeamRuntime } = require('../src/runtime');
const { isJoinStallError } = require('../src/bot/connection');
const { config } = require('../src/config');

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.state = 'play';
    this.socket = null;
    this.write = (name, packet) => { this.writes.push({ name, packet }); return true; };
  }
}

class FakeBot extends EventEmitter {
  constructor({ version = '26.1' } = {}) {
    super();
    this.version = version;
    this.protocolVersion = 775;
    this.physicsEnabled = true;
    this.entity = {
      position: { x: 1, y: 64, z: 1, toFixed: () => '1' },
      yaw: 0,
      pitch: 0,
      onGround: true,
      velocity: { x: 0, y: 0, z: 0 }
    };
    this.health = 20;
    this.food = 20;
    this.foodSaturation = 5;
    this.oxygenLevel = 20;
    this.game = { dimension: 'overworld' };
    this.entities = {};
    this.inventory = { items: () => [], slots: [] };
    this._client = new FakeClient();
    this.supportFeature = () => true;
    this.quitCalls = 0;
  }

  quit() { this.quitCalls += 1; }
  chat() {}
  clearControlStates() {}
  blockAt() { return { name: 'air', boundingBox: 'empty' }; }
  setControlState() {}
}

function newReal(name = '________', extra = {}) {
  let fake = null;
  let options = null;
  const real = new RealBot({
    name,
    createBot: (opts) => {
      options = opts;
      fake = new FakeBot();
      return fake;
    },
    loginPassword: '',
    registerPassword: '',
    authEnabled: false,
    connectTimeoutMs: 500,
    dnsTimeoutMs: 500,
    loginTimeoutMs: 500,
    configurationTimeoutMs: 500,
    spawnTimeoutMs: 500,
    ...extra
  });
  return { real, fake: () => fake, options: () => options };
}

test('the lifecycle machine assigns a generation, validates transitions and keeps a timeline', () => {
  let now = 1000;
  const machine = new ConnectionStateMachine({ now: () => now, maxTimeline: 32 });
  assert.equal(machine.state, STATES.IDLE);
  assert.equal(machine.transition(STATES.READY), false, 'idle cannot jump straight to ready');
  assert.equal(machine.invalidTransitions, 1);

  const first = machine.begin({ host: 'example.test', port: 25565 });
  assert.equal(first.generation, 1);
  assert.equal(first.state, STATES.RESOLVING);
  now += 10;
  assert.equal(machine.transition(STATES.TCP_CONNECTING, { stage: 'tcp' }), true);
  now += 20;
  assert.equal(machine.transition(STATES.HANDSHAKING, { stage: 'handshake' }), true);
  now += 30;
  assert.equal(machine.transition(STATES.CONFIGURATION, { stage: 'configuration' }), true);
  now += 40;
  assert.equal(machine.transition(STATES.AWAITING_SPAWN, { stage: 'spawn' }), true);
  now += 50;
  assert.equal(machine.transition(STATES.READY, { stage: 'ready' }), true);
  assert.equal(machine.transition(STATES.HANDSHAKING), false, 'ready cannot go backwards');
  assert.equal(machine.invalidTransitions, 2);
  assert.ok(machine.snapshot().timeline.length >= 7);
  assert.equal(machine.snapshot().stage, 'ready');
  assert.equal(machine.snapshot().elapsedMs, 150);

  const failed = machine.fail('KICKED', 'Timed out', { stage: 'ready' });
  assert.equal(failed.state, STATES.FAILED);
  assert.equal(failed.failure.code, 'KICKED');
  assert.equal(machine.isCurrent(1), false);

  const second = machine.begin({ host: 'example.test', port: 25565 });
  assert.equal(second.generation, 2);
  assert.equal(second.timeline.length, 1, 'a new session starts a fresh timeline');
  assert.equal(machine.isCurrent(2), true);
  assert.equal(machine.isCurrent(1), false);
});

test('the client tick scheduler emits one tick_end per tick and defers a second position packet', () => {
  const writes = [];
  const scheduler = new ClientTickScheduler({
    write: (name, packet) => writes.push({ name, packet }),
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} }
  });
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false, 'one scheduler per session');

  assert.equal(scheduler.writeMovement('position', { x: 1 }), true);
  assert.equal(scheduler.writeMovement('position', { x: 2 }), false, 'second position is deferred');
  assert.equal(scheduler.writeMovement('look', { yaw: 90 }), true, 'look is not position-bearing');
  scheduler.tick();
  assert.deepEqual(writes.map((entry) => entry.name), ['position', 'look', 'position', 'tick_end']);
  assert.equal(writes.at(-1).name, 'tick_end');

  const before = writes.length;
  scheduler.tick();
  assert.equal(writes.length, before + 1);
  assert.equal(writes.at(-1).name, 'tick_end');
  assert.equal(scheduler.ticks, 2);

  scheduler.setTickingState({ isFrozen: true });
  assert.equal(scheduler.writeMovement('position', { x: 3 }), false, 'frozen clients do not write movement');
  const frozenTicks = writes.length;
  assert.equal(scheduler.stepTicks(2), 2);
  assert.equal(writes.length, frozenTicks + 2);
  assert.deepEqual(writes.slice(-2).map((entry) => entry.name), ['tick_end', 'tick_end']);

  scheduler.stop('test');
  assert.equal(scheduler.running, false);
  const stoppedAt = writes.length;
  scheduler.tick();
  assert.equal(writes.length, stoppedAt, 'a stopped scheduler cannot emit another tick');
});

test('the client asks for a bounded chunk radius so five joins cannot block the tick loop', async () => {
  assert.equal(config.server.viewDistance, 'short');
  const { real, fake, options } = newReal('01010100');
  const pending = real.connect();
  for (let i = 0; i < 80 && !fake(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fake(), 'createBot should have been called');
  fake()._client.emit('connect');
  fake().version = '26.1';
  fake()._client.emit('login');
  fake()._client.emit('spawn');
  fake().emit('spawn');
  await pending.catch(() => null);
  assert.equal(options().viewDistance, config.server.viewDistance);
  await real.disconnect('test complete');
});

test('a spawn that arrives before the spawn waiter is not lost when auth is still pending', async () => {
  const real = new RealBot({ name: '________', createBot: () => new FakeBot(), loginPassword: 'secret', registerPassword: '' });
  real.connection.begin({ host: 'example.test', port: 25565 });
  for (const state of [STATES.TCP_CONNECTING, STATES.HANDSHAKING, STATES.CONFIGURATION, STATES.AWAITING_SPAWN]) {
    assert.equal(real.connection.transition(state), true);
  }
  real._spawnedThisSession = true;
  real.spawned = true;
  real.authenticated = false;
  const started = Date.now();
  const result = await real.waitForSpawn({ timeoutMs: 1000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.spawned, true);
  assert.ok(Date.now() - started < 100, 'the waiter must resolve immediately, not after the spawn timeout');
  await real.disconnect('test');
});

test('a failed connection reports the exact stage and keeps the pre-cleanup snapshot', async () => {
  const { real, fake } = newReal();
  const pending = real.connect({ timeoutMs: 25 });
  await new Promise((resolve) => setImmediate(resolve));
  fake()._client.emit('connect');
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOGIN_TIMEOUT');
  assert.equal(result.stage, 'handshake');
  assert.equal(result.sessionId, 1);
  assert.equal(real.connection.state, STATES.FAILED);
  assert.equal(real.lastDisconnect.spawned, false);
  assert.equal(real.lastDisconnect.authenticated, false);
  assert.equal(real.lastDisconnect.generation, 1);
  assert.ok(real.lastDisconnect.timeline.some((entry) => entry.kind === 'stage' && entry.stage === 'handshake'));
  assert.equal(fake().quitCalls, 1);
  await real.disconnect('test cleanup');
});

test('login, spawn and the client tick loop are one validated session', async () => {
  const { real, fake } = newReal();
  const pending = real.connect({ timeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  const bot = fake();
  bot._client.emit('connect');
  bot.emit('login');
  bot.emit('spawn');
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(real.connection.state, STATES.READY);
  assert.equal(real.connection.generation, 1);
  assert.equal(real.ready, true);
  assert.ok(real.stageTimings.tcpMs >= 0);
  assert.ok(real.stageTimings.spawnMs >= 0);
  assert.ok(real._clientTicker, 'the tick loop starts with the play state');
  assert.equal(real._clientTicker.tickRate, 20);
  real._clientTicker.tick();
  assert.ok(bot._client.writes.some((entry) => entry.name === 'tick_end'));
  assert.equal(bot._client.writes.filter((entry) => entry.name === 'player_loaded').length, 0, 'mineflayer already sends player_loaded; do not duplicate it');
  assert.ok(real._connectionSnapshot().ticker.tickEnds >= 1);

  // 26.1 wire names are tick_rate / is_frozen / tick_steps.
  const beforeFrozen = real._clientTicker.tickEnds;
  bot._client.emit('set_ticking_state', { tick_rate: 5, is_frozen: true });
  assert.equal(real._clientTicker.frozen, true);
  assert.equal(real._clientTicker.tickRate, 5);
  assert.equal(real._clientTicker.tick(), false, 'frozen ticks do not advance on their own');
  assert.equal(real._clientTicker.stepTicks(3), 3);
  assert.equal(real._clientTicker.tickEnds, beforeFrozen + 3);
  bot._client.emit('set_ticking_state', { tick_rate: 20, is_frozen: false });
  assert.equal(real._clientTicker.frozen, false);

  const generation = real.connection.generation;
  await real.disconnect('test');
  assert.equal(real.ready, false);
  assert.equal(real.connection.generation, generation);
  assert.equal(real.lastDisconnect.spawned, true);
  assert.equal(real.lastDisconnect.authenticated, true);
});

test('stale events from a replaced socket cannot touch the new session', async () => {
  const fakes = [];
  const real = new RealBot({
    name: '10101000',
    createBot: () => {
      const fake = new FakeBot();
      fakes.push(fake);
      return fake;
    },
    loginPassword: '',
    registerPassword: '',
    authEnabled: false,
    connectTimeoutMs: 500,
    loginTimeoutMs: 500,
    spawnTimeoutMs: 500
  });
  const firstPending = real.connect({ timeoutMs: 20 });
  assert.equal((await firstPending).ok, false);
  const first = fakes[0];

  const secondPending = real.connect({ timeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = fakes[1];
  second._client.emit('connect');
  second.emit('login');
  second.emit('spawn');
  const result = await secondPending;
  assert.equal(result.ok, true, JSON.stringify(result));
  const generation = real.connection.generation;
  const writesBefore = second._client.writes.length;

  // The old socket emits a login/spawn pair after the replacement is ready.
  first.emit('login');
  first.emit('spawn');
  first._client.write('position', { x: 9, y: 64, z: 9 });
  assert.equal(real.connection.generation, generation);
  assert.equal(real.connection.state, STATES.READY);
  assert.equal(second._client.writes.length, writesBefore, 'the stale socket cannot write through the new session');
  await real.disconnect('test');
});

test('a duplicate spawn without a respawn packet is explained and does not rewrite the session', async () => {
  const { real, fake } = newReal();
  const pending = real.connect({ timeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  const bot = fake();
  bot._client.emit('connect');
  bot.emit('login');
  bot.emit('spawn');
  assert.equal((await pending).ok, true);
  const firstSpawnAt = real.lastSpawn.at;

  bot.emit('spawn');
  assert.equal(real.lastSpawn.at, firstSpawnAt, 'duplicate spawn must not reset the spawn clock');
  assert.equal(real.lastSpawn.respawned, false);
  assert.ok(real.connection.snapshot().timeline.some((entry) => entry.event === 'spawn_duplicate'));

  bot._client.emit('respawn');
  assert.equal(real.connection.state, STATES.RESPAWNING);
  bot.emit('spawn');
  assert.equal(real.lastSpawn.respawned, true, 'a server respawn packet is a real respawn');
  assert.equal(real.connection.state, STATES.READY);
  await real.disconnect('test');
});

test('a kick captures the ready state before cleanup resets it', async () => {
  const { real, fake } = newReal();
  const pending = real.connect({ timeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  const bot = fake();
  bot._client.emit('connect');
  bot.emit('login');
  bot.emit('spawn');
  assert.equal((await pending).ok, true);

  bot.emit('kicked', 'Timed out');
  assert.equal(real.connection.state, STATES.FAILED);
  assert.equal(real.connection.failure.code, 'KICKED');
  assert.equal(real.lastDisconnect.state, STATES.READY);
  assert.equal(real.lastDisconnect.spawned, true);
  assert.equal(real.lastDisconnect.authenticated, true);
  assert.equal(real.lastDisconnect.ready, true);
  assert.match(real.lastDisconnect.reason, /Timed out/);

  // The later end event must not overwrite that evidence.
  bot.emit('end', 'socketClosed');
  assert.equal(real.lastDisconnect.state, STATES.READY);
  assert.equal(real.lastDisconnect.spawned, true);
  await real.disconnect('test cleanup');
});

test('keep-alive replies are counted from the library write, never sent twice', async () => {
  const { real, fake } = newReal();
  const pending = real.connect({ timeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  const bot = fake();
  bot._client.emit('connect');
  bot.emit('login');
  bot.emit('spawn');
  assert.equal((await pending).ok, true);

  bot._client.emit('keep_alive', { keepAliveId: 1n });
  assert.equal(real._keepAlive.received, 1);
  assert.equal(real._keepAlive.replies, 0);
  // This is exactly what minecraft-protocol's keepalive plugin does; the
  // adapter must not add a second reply of its own.
  bot._client.write('keep_alive', { keepAliveId: 1n });
  assert.equal(real._keepAlive.replies, 1);
  assert.equal(bot._client.writes.filter((entry) => entry.name === 'keep_alive').length, 1);
  assert.equal(real.summary().connection.keepAlive.received, 1);
  assert.equal(connectionStatus(real, { now: real.now() }).status, 'online');
  bot.emit('kicked', 'Timed out');
  assert.equal(connectionStatus(real, { now: real.now() }).status, 'offline');
  await real.disconnect('test');
});

test('stage-specific timeouts are classified as join stalls, while TCP failures are not', () => {
  assert.equal(isJoinStallError('timed out after 30000ms in handshake stage waiting for protocol login'), true);
  assert.equal(isJoinStallError('timed out after 15000ms in configuration stage waiting for protocol login'), true);
  assert.equal(isJoinStallError('timed out after 45000ms waiting for spawn'), true);
  assert.equal(isJoinStallError('timed out after 45000ms establishing TCP to cr3xlol.aternos.me:55742'), false);
});

test('the runtime scheduler reads a controllable clock and counts one strike for four bot failures', async () => {
  let now = 1000;
  const runtime = new TeamRuntime({
    simulate: true,
    connect: false,
    dashboard: false,
    now: () => now,
    random: () => 0
  });
  runtime._registerJoinBackoff('throttled', 'Connection throttled!');
  assert.equal(runtime.throttleStrikes, 1);
  const firstUntil = runtime.joinCooldownUntil;
  now += 1000;
  runtime._registerJoinBackoff('join stalled', 'timed out waiting for spawn');
  runtime._registerJoinBackoff('join stalled', 'timed out after 30000ms waiting for protocol login');
  runtime._registerJoinBackoff('join stalled', 'timed out waiting for spawn');
  assert.equal(runtime.throttleStrikes, 1, 'all four bots belong to one outage episode');
  assert.equal(runtime.joinCooldownUntil, firstUntil, 'an active pause is not pushed further out');
  assert.equal(runtime.joinScheduler.snapshot().suppressedFailures, 3);

  now = firstUntil + 1;
  runtime.joinScheduler.success();
  runtime._registerJoinBackoff('join stalled', 'a later, separate outage');
  assert.equal(runtime.throttleStrikes, 2);
  assert.ok(runtime.joinCooldownUntil > now);
  await runtime.shutdown('test');
});

test('join backoff records one strike per outage and still escalates separate outages', () => {
  let now = 0;
  const scheduler = new JoinScheduler({
    now: () => now,
    random: () => 0,
    baseDelayMs: 90000,
    maxDelayMs: 600000,
    jitterMs: 250,
    quietResetMs: 600000
  });

  const first = scheduler.strike({ kind: 'join stalled', error: 'spawn timeout', at: now });
  assert.equal(first.strikes, 1);
  assert.equal(first.counted, true);
  assert.equal(first.cooldownUntil, 90000);

  now = 1000;
  const second = scheduler.strike({ kind: 'join stalled', error: 'login timeout', at: now });
  assert.equal(second.strikes, 1, 'another bot in the same outage is not another strike');
  assert.equal(second.counted, false);
  assert.equal(second.cooldownUntil, 90000);

  now = 90000;
  const third = scheduler.strike({ kind: 'join stalled', error: 'spawn timeout', at: now });
  assert.equal(third.strikes, 1);
  assert.equal(third.counted, false, 'the outage is still the same episode');
  assert.equal(third.cooldownUntil, 180000);

  now = 100000;
  const ready = scheduler.success({ at: now });
  assert.equal(ready.episodeOpen, false);
  assert.equal(ready.cooldownUntil, null);

  now = 200000;
  const next = scheduler.strike({ kind: 'join stalled', error: 'new outage', at: now });
  assert.equal(next.strikes, 2, 'a separate outage escalates the bounded backoff');
  assert.equal(next.counted, true);
  assert.equal(next.cooldownUntil, 200000 + 180000);

  now = 200000 + 600001;
  const quiet = scheduler.strike({ kind: 'join stalled', error: 'after quiet period', at: now });
  assert.equal(quiet.strikes, 1, 'a quiet ten minutes resets the ladder');
  assert.equal(quiet.counted, true);
});

test('five independent bots keep five generations and their own tick loops', async () => {
  const bots = [];
  for (const name of ['________', '10101000', '01010100', '11001100', '00110000']) {
    const { real, fake } = newReal(name);
    bots.push({ real, fake });
  }
  const connections = bots.map(({ real }) => real.connect({ timeoutMs: 500 }));
  await new Promise((resolve) => setImmediate(resolve));
  for (const { fake } of bots) {
    const bot = fake();
    bot._client.emit('connect');
    bot.emit('login');
    bot.emit('spawn');
  }
  const results = await Promise.all(connections);
  assert.equal(results.every((result) => result.ok), true, JSON.stringify(results));
  assert.deepEqual(bots.map(({ real }) => real.connection.generation), [1, 1, 1, 1, 1]);
  assert.equal(bots.every(({ real }) => real.connection.state === STATES.READY), true);
  assert.equal(bots.every(({ real }) => real._clientTicker && real._clientTicker.running), true);
  await Promise.all(bots.map(({ real }) => real.disconnect('test')));
  assert.equal(bots.every(({ real }) => real.connection.terminal), true);
});
