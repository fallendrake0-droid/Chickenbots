'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

/**
 * A second live runtime would log in with the same ten usernames and make the
 * server kick the first instance (duplicate login), which surfaces as a raw
 * EPIPE/ECONNRESET rather than a readable kick message. The dashboard and the
 * CLI both acquire this lock so one process owns the roster at a time.
 */
function acquireLiveLock({ root = ROOT } = {}) {
  const dir = path.join(root, 'data', 'runtime');
  const file = path.join(dir, 'live.pid');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const pid = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return { ok: false, pid, file };
      } catch (err) {
        if (err.code === 'EPERM') return { ok: false, pid, file };
        if (err.code !== 'ESRCH') throw err;
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, String(process.pid));
  const release = () => {
    try {
      if (String(fs.readFileSync(file, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(file);
    } catch (_) { /* already gone */ }
  };
  process.once('exit', release);
  return { ok: true, file, release };
}

module.exports = { acquireLiveLock };
