'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RealBot } = require('../src/bot/realBot');
const { config } = require('../src/config');

function skinBot() {
  const lines = [];
  const real = new RealBot({
    name: '________', createBot: () => null,
    authEnabled: false, loginPassword: '', registerPassword: ''
  });
  real.bot = { chat: (line) => lines.push(String(line)), entity: {} };
  real.connected = true;
  real.spawned = true;
  real.authenticated = true;
  return { real, lines };
}

test('the configured join skin is applied once after the session is ready', async () => {
  assert.equal(config.server.skinOnJoin, true);
  assert.equal(config.server.skinCommand, '/skin uH3WR2v0ti0uTHJ');
  const { real, lines } = skinBot();
  const first = await real._sendJoinSkin();
  assert.equal(first.ok, true);
  assert.equal(first.command, '/skin uH3WR2v0ti0uTHJ');
  assert.deepEqual(lines, ['/skin uH3WR2v0ti0uTHJ']);
  const second = await real._sendJoinSkin();
  assert.equal(second.already, true);
  assert.deepEqual(lines, ['/skin uH3WR2v0ti0uTHJ'], 'a reconnect must not spam the command');

  const summary = real.summary().joinSkin;
  assert.equal(summary.enabled, true);
  assert.equal(summary.sent, true);
  assert.equal(summary.command, '/skin uH3WR2v0ti0uTHJ');
  assert.ok(summary.at > 0);
});

test('a not-ready session never sends the cosmetic join command', async () => {
  const { real, lines } = skinBot();
  real.bot = null;
  const result = await real._sendJoinSkin();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_READY');
  assert.deepEqual(lines, []);
});

test('join skin scheduling is non-blocking and exposes its delay', () => {
  const { real } = skinBot();
  const scheduled = real._scheduleJoinSkin();
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.scheduled, true);
  assert.equal(scheduled.delayMs, config.server.skinDelayMs);
  assert.ok(real._joinSkinTimer, 'a timer should hold the delayed send');
  clearTimeout(real._joinSkinTimer);
  real._joinSkinTimer = null;
});
