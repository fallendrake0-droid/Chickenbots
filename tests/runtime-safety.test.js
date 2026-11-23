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
});
