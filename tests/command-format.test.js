'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandRegistry } = require('../src/commands/registry');
const { summarizeResult, commandReport } = require('../src/commands/format');

test('a goto report shows the route timing split and queue wait', () => {
  const lines = summarizeResult({
    ok: true, arrived: true, attempts: 1, steps: 42,
    from: { x: 0, y: 64, z: 0 }, target: { x: 20, y: 66, z: 20 },
    position: { x: 20.2, y: 65, z: 19.8 },
    timings: { totalMs: 2400, setupMs: 12, planMs: 380, followMs: 2008, thinkTimeoutMs: 8000, tickTimeoutMs: 25 },
    scheduling: { queuedMs: 0, cancelWaitMs: 120, execMs: 2510 }
  });
  const text = lines.join('\n');
  assert.match(text, /plan=380ms/);
  assert.match(text, /think-budget=8000ms/);
  assert.match(text, /queued=0ms/);
  assert.match(text, /from=0\.0,64\.0,0\.0/);
  assert.match(text, /position=20\.2,65\.0,19\.8/);
});

test('a failed fleet report names each failed bot and the typed code', () => {
  const report = commandReport({
    id: 'cmd-9', line: 'goto all 20 66 20', source: 'dashboard', operator: 'dashboard',
    durationMs: 800, ok: false,
    result: {
      ok: false, command: 'goto', code: 'PATH_NOT_FOUND', error: 'No path to the goal!',
      results: [
        { bot: '10101000', ok: true, arrived: true },
        { bot: '00110000', ok: false, code: 'PATH_NOT_FOUND', error: 'No path to the goal!' }
      ]
    }
  });
  const text = report.join('\n');
  assert.match(text, /FAILED goto in 800ms/);
  assert.match(text, /code=PATH_NOT_FOUND/);
  assert.match(text, /#2 00110000 FAILED/);
});

test('the registry logs a successful command with its detailed result', async () => {
  const messages = [];
  const logger = { info: (msg) => messages.push(msg), warn: (msg) => messages.push(msg), error: (msg) => messages.push(msg) };
  const registry = new CommandRegistry({ logger });
  registry.register({
    name: 'demo', summary: 'demo', execute: async () => ({
      ok: true, moved: true,
      position: { x: 2, y: 65, z: 3 },
      timings: { totalMs: 10, planMs: 4, followMs: 6 }
    })
  });
  await registry.execute('demo', { source: 'dashboard', operator: 'tester' });
  const text = messages.join('\n');
  assert.match(text, /ok demo in \d+ms \[dashboard\/tester\]/);
  assert.match(text, /position=2\.0,65\.0,3\.0/);
});
