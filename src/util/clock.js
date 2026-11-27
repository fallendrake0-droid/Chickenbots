'use strict';

const { performance } = require('perf_hooks');

/**
 * Wall-clock time is for timestamps a human reads and for cooldowns that must
 * survive a process restart. Process-local measurements (uptime, how long a
 * safety pass or task took, how old a status cache is) must use the monotonic
 * clock instead.
 *
 * A suspended VM is the reason this distinction matters: `Date.now()` jumps
 * forward by the whole suspension while `performance.now()` does not. A
 * resumed simulation therefore used to report an hour of uptime for a
 * two-minute process, a 2278s safety task, and a "stale" status cache that had
 * just been warmed. Measurements that describe work this process performed
 * must not include time the process was not running.
 */
function monotonicMs() {
  return performance.now();
}

module.exports = { monotonicMs };
