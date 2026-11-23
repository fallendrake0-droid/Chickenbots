'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isThrottleError, reconnectDelay, staggerDelay, sleep } = require('../src/bot/connection');
const { RealBot } = require('../src/bot/realBot');

test('join throttling is detected and retried behind a longer jittered backoff', () => {
  const throttled = 'Connection throttled! Please wait before reconnecting.';
  assert.equal(isThrottleError(throttled), true);
  assert.equal(isThrottleError('ECONNREFUSED'), false);
  const delay = reconnectDelay({
    attempt: 1, error: throttled, baseDelayMs: 5000, maxDelayMs: 120000,
    throttleDelayMs: 30000, jitterMs: 4000, random: () => 0.5
  });
  assert.equal(delay, 32000);
  const generic = reconnectDelay({
    attempt: 2, error: 'socket closed', baseDelayMs: 5000, maxDelayMs: 120000,
    throttleDelayMs: 30000, jitterMs: 4000, random: () => 0
  });
  assert.equal(generic, 7500);
});

test('join and recovery starts are staggered so bots do not retry in lockstep', () => {
  assert.equal(staggerDelay({ staggerMs: 7000, jitterMs: 2000, random: () => 0 }), 7000);
  assert.equal(staggerDelay({ staggerMs: 7000, jitterMs: 2000, random: () => 0.5 }), 8000);
  assert.equal(staggerDelay({ staggerMs: 0, jitterMs: 0, random: () => 1 }), 0);
});

test('kick reasons are flattened into readable chat text', () => {
  const bot = new RealBot({ name: '_______' });
  const reason = {
    type: 'compound',
    value: {
      extra: { type: 'list', value: { type: 'string', value: ['Invalid move player packet received'] } },
      text: { type: 'string', value: '' }
    }
  };
  assert.equal(bot._formatKickReason(reason), 'Invalid move player packet received');
  assert.equal(bot._formatKickReason('plain reason'), 'plain reason');
  assert.equal(bot._formatKickReason(null), 'null');
});

function authHarness({ loginPassword = 'secret', registerPassword = null, reply = null } = {}) {
  const real = new RealBot({ name: '_______', loginPassword, registerPassword, authDelayMs: 0, authTimeoutMs: 500 });
  const commands = [];
  const fake = {
    entity: {},
    physicsEnabled: true,
    chat(line) {
      commands.push(line);
      const text = reply ? reply(line) : (line.startsWith('/register') ? 'Successfully registered!' : 'Successfully logged in!');
      setImmediate(() => real._testChat(text));
    },
    clearControlStates() {},
    quit() {}
  };
  real.bot = fake;
  real.connected = true;
  real.spawned = true;
  real.onChat = (listener) => { real._testChat = listener; return () => {}; };
  return { real, commands, fake };
}

test('shutdown abort wakes a reconnect sleep immediately', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = sleep(60000, controller.signal);
  controller.abort();
  await pending;
  assert.ok(Date.now() - started < 1000);
});

test('a bot with a password stays unauthenticated until the server confirms login', async () => {
  const { real, commands } = authHarness({ loginPassword: 'secret' });
  assert.equal(real.ready, false);
  assert.equal(real.authenticated, false);
  const result = await real._handleLoginCommands();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(real.authenticated, true);
  assert.equal(real.authConfirmed, true);
  assert.equal(real.ready, true);
  assert.deepEqual(commands, ['/login secret']);
});

test('registration is confirmed before the login step and a failure blocks the bot', async () => {
  const { real, commands } = authHarness({ registerPassword: 'secret', loginPassword: 'secret' });
  const ok = await real._handleLoginCommands();
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(commands, ['/register secret secret', '/login secret']);
  assert.equal(real.authenticated, true);

  const failed = authHarness({
    registerPassword: 'secret', loginPassword: 'secret',
    reply: (line) => line.startsWith('/register') ? 'Successfully registered!' : 'Wrong password. Try again.'
  });
  const denied = await failed.real._handleLoginCommands();
  assert.equal(denied.ok, false);
  assert.match(denied.error, /wrong password/i);
  assert.equal(failed.real.authenticated, false);
});

test('status scans are skipped until a live bot is ready', () => {
  const { findBlocks } = require('../src/actions/common');
  const fake = {
    ready: false,
    position: { x: 0, y: 64, z: 0 },
    getBlock() { throw new Error('world not loaded'); }
  };
  assert.deepEqual(findBlocks(fake, ['stone']), []);
  const real = new RealBot({ name: '_______' });
  real.bot = {};
  real.connected = true;
  real.spawned = true;
  assert.equal(real._blockAt({ x: 0, y: 64, z: 0 }), null);
});

test('password auth can be disabled for a server without a plugin', () => {
  const real = new RealBot({ name: '_______', authEnabled: false, loginPassword: 'secret', registerPassword: 'secret' });
  assert.equal(real.passwordRequired, false);
});

test('registration is sent on the first join and only login is used afterwards', async () => {
  const { real, commands } = authHarness({ registerPassword: 'secret', loginPassword: 'secret' });
  const first = await real._handleLoginCommands();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(commands, ['/register secret secret', '/login secret']);

  commands.length = 0;
  real.authenticated = false;
  const second = await real._handleLoginCommands();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(commands, ['/login secret']);
});
