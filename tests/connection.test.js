'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isThrottleError, reconnectDelay, staggerDelay } = require('../src/bot/connection');
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
  const bot = new RealBot({ name: '______' });
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
