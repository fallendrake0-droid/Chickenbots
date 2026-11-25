'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTaskParams } = require('../src/commands/index');

test('task --params rejects prototype-mutating keys', () => {
  assert.throws(
    () => parseTaskParams(['--params', '{"__proto__":{"polluted":true}}']),
    /unsafe task parameter/
  );
  assert.throws(
    () => parseTaskParams(['--params', '{"constructor":{"prototype":{"x":1}}}']),
    /unsafe task parameter/
  );
  assert.equal({}.polluted, undefined);
});

test('task key=value parameters are parsed without a prototype chain', () => {
  const parsed = parseTaskParams(['ore=iron_ore', 'count=4', 'some label words']);
  assert.deepEqual({ ...parsed.params }, { ore: 'iron_ore', count: 4 });
  assert.equal(Object.getPrototypeOf(parsed.params), null);
  assert.equal(parsed.label, 'some label words');
});
