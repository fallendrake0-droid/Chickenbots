'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntime } = require('../src/runtime');
const { config } = require('../src/config');
const { RealBot } = require('../src/bot/realBot');

function near(actual, expected, tolerance = 3) {
  return Math.abs(actual - expected) <= tolerance;
}

test('top-level goto moves the leader to x/y/z', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const result = await runtime.commands.execute('goto 20 66 20', { source: 'internal' });
    assert.equal(result.result.ok, true, JSON.stringify(result.result).slice(0, 400));
    assert.ok(near(result.result.position.x, 20), `x was ${result.result.position.x}`);
    assert.ok(near(result.result.position.z, 20), `z was ${result.result.position.z}`);
    assert.ok(result.result.position.y >= 60, 'the bot must end up in the loaded world, not above it');
  } finally {
    await runtime.shutdown('test');
  }
});

test('top-level goto accepts a leading or trailing bot name', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const name = config.team.names[1];
    for (const line of [`goto ${name} 12 66 12`, `goto 12 66 12 ${name}`]) {
      const result = await runtime.commands.execute(line, { source: 'internal' });
      assert.equal(result.result.ok, true, `${line}: ${JSON.stringify(result.result).slice(0, 400)}`);
      const bot = runtime.bots.get(name);
      assert.ok(near(bot.position.x, 12), `${line}: bot x was ${bot.position.x}`);
      assert.ok(near(bot.position.z, 12), `${line}: bot z was ${bot.position.z}`);
    }
  } finally {
    await runtime.shutdown('test');
  }
});

test('goto all fans out and reports every bot', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const result = await runtime.commands.execute('goto all 0 65 0', { source: 'internal' });
    assert.equal(result.result.ok, true, JSON.stringify(result.result).slice(0, 400));
    assert.equal(result.result.bots, config.team.names.length);
    assert.equal(result.result.completed, config.team.names.length);
    assert.equal(result.result.failed, 0);
  } finally {
    await runtime.shutdown('test');
  }
});

test('goto rejects missing or extra coordinates with a usable message', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    for (const line of ['goto', 'goto 1 2', 'goto 1 2 3 4']) {
      const result = await runtime.commands.execute(line, { source: 'internal' });
      assert.equal(result.result.ok, false, line);
      assert.match(String(result.result.error), /usage: goto/);
    }
  } finally {
    await runtime.shutdown('test');
  }
});

test('operator goto lifts a block Y into a standable feet position', () => {
  const real = new RealBot({ name: config.team.names[0], createBot: () => ({}) });
  real.getBlock = (pos) => ({ name: pos.y === 64 ? 'grass_block' : 'air' });
  assert.equal(real._standableY({ x: 0, y: 64, z: 0 }), 65);
  assert.equal(real._standableY({ x: 0, y: 65, z: 0 }), 65);
  real.getBlock = () => ({ name: 'unloaded' });
  assert.equal(real._standableY({ x: 0, y: 64, z: 0 }), 64, 'unloaded chunks must not move the target');
});
