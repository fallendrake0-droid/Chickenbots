'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const logStore = require('../src/logStore');

test('an invalid since value means "from the beginning", not "drop every log"', () => {
  const scope = `log-store-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  logStore.record({ level: 'info', scope, msg: 'first' });
  logStore.record({ level: 'warn', scope, msg: 'second' });
  const invalid = logStore.recent({ scope, since: 'not-a-number' });
  assert.equal(invalid.length, 2);
  const negative = logStore.recent({ scope, since: -10 });
  assert.equal(negative.length, 2);
  const filtered = logStore.recent({ scope, level: 'warn' });
  assert.deepEqual(filtered.map((entry) => entry.msg), ['second']);
  assert.equal(logStore.recent({ scope, limit: 1 }).length, 1);
  assert.equal(logStore.recent({ scope, limit: 999999 }).length, 2);
});
