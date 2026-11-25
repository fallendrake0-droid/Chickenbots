'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { auditCommands } = require('../scripts/command-audit');
const { Logger } = require('../src/logger');
const { createRuntime } = require('../src/runtime');

test('every registered command resolves, answers --help and has a real safe invocation', async () => {
  const report = await auditCommands({ logger: new Logger({ level: 'error' }) });
  assert.equal(report.ok, true, report.failures.map((row) => `${row.name}: ${row.execution && row.execution.result && row.execution.result.error}`).join('; '));
  assert.equal(report.total, 47);
  assert.ok(report.covered >= 46, `only ${report.covered}/${report.total} commands were exercised`);
  const stop = report.rows.find((row) => row.name === 'stop');
  assert.equal(stop.status, 'SKIPPED', 'stop is the only command that must not run during the audit');
});

test('help accepts a category and an unknown name fails without throwing', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false, connect: false });
  try {
    const category = await runtime.commands.execute('help players', { source: 'cli' });
    assert.equal(category.ok, true);
    assert.equal(category.result.command.name, 'players');
    const builder = await runtime.commands.execute('help builder', { source: 'cli' });
    assert.equal(builder.ok, true, 'builder is both a command and a category; the command wins');
    const missing = await runtime.commands.execute('help not-a-command', { source: 'cli' });
    assert.equal(missing.ok, false);
    assert.match(missing.result.error, /unknown command or category/);
    const flag = await runtime.commands.execute('players --help', { source: 'cli' });
    assert.equal(flag.ok, true);
    assert.match(flag.result.help.usage, /players/);
  } finally {
    await runtime.shutdown('test');
  }
});

test('players rejects unknown targets and out-of-range values instead of silently defaulting', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false, connect: false });
  try {
    for (const line of [
      'players follow Alex nope',
      'players follow Alex all 999',
      'players stop nope',
      'players unfollow Alex nope',
      'players following nope',
      'players come Alex nope'
    ]) {
      const result = await runtime.commands.execute(line, { source: 'cli' });
      assert.equal(result.ok, false, line);
      assert.match(String(result.error || result.result.error), /unknown bot|out of range|usage/, line);
    }
  } finally {
    await runtime.shutdown('test');
  }
});
