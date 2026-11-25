#!/usr/bin/env node
'use strict';

/**
 * Deterministic dashboard-snapshot benchmark.
 *
 * Run: npm run perf:status
 *
 * Reports the cold first snapshot (the cost the runtime pays before its
 * startup warm-up), the one-shot warm-up, and routine warm snapshots. This is
 * simulation evidence only; a live result requires a live server and is not
 * implied by this script.
 */
const { createRuntime } = require('../src/runtime');
const { statusSnapshot } = require('../src/runtimeState');

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

(async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const coldStarted = Date.now();
    const cold = statusSnapshot(runtime.services);
    const coldMs = Date.now() - coldStarted;
    const warmMs = await runtime._warmStatusCaches();
    const samples = [];
    let last = null;
    for (let i = 0; i < 15; i++) {
      const started = Date.now();
      last = statusSnapshot(runtime.services);
      samples.push(Date.now() - started);
    }
    const report = {
      mode: 'simulation',
      bots: runtime.bots.size,
      cold: { totalMs: coldMs, sections: cold.performance.sections },
      warmUpMs: warmMs,
      warm: {
        samples,
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        max: Math.max(...samples),
        sections: last.performance.sections
      },
      targetMs: 50,
      pass: percentile(samples, 95) < 50 && Math.max(...samples) < 50
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await runtime.shutdown('bench-status');
  }
})().catch((err) => {
  process.stderr.write(`bench-status failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
