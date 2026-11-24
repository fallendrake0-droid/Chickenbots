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
