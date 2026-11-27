'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { acquireLiveLock } = require('../src/liveLock');

test('the live lock names its file, refuses a live owner, and releases cleanly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chickenbots-live-lock-'));
  try {
    const dir = path.join(root, 'data', 'runtime');
    const file = path.join(dir, 'live.pid');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(process.ppid));

    const held = acquireLiveLock({ root });
    assert.equal(held.ok, false);
    assert.equal(held.pid, process.ppid);
    assert.equal(held.file, file, 'the refusal must say where the lock lives');

    fs.unlinkSync(file);
    const owned = acquireLiveLock({ root });
    assert.equal(owned.ok, true);
    assert.equal(owned.file, file);
    assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
    owned.release();
    assert.equal(fs.existsSync(file), false, 'release removes the lock it owns');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
