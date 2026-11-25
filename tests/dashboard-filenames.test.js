'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachmentFilename } = require('../src/dashboard/server');

test('download names cannot inject header syntax or path separators', () => {
  const name = attachmentFilename('evil"\r\nX-Injected: 1/../../etc/passwd', '.schem');
  assert.doesNotMatch(name, /["\r\n/]/);
  assert.match(name, /^evil_X-Injected_1_+\.\._+\.\._+etc_passwd\.schem$/);
});

test('empty and traversal-only names fall back to a safe filename', () => {
  assert.equal(attachmentFilename('', '.json'), 'schematic.json');
  assert.equal(attachmentFilename('..', '.json'), 'schematic.json');
  assert.equal(attachmentFilename('___', '.schem'), 'schematic.schem');
});
