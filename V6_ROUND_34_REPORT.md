# Chickenbots V6 — round 34 report

**Scope:** implement the P0 reliability work that was still open after round 33.
No live server was reachable from this sandbox; every live criterion remains
unverified.

## Implemented

1. **Death attribution** — `_recordDeath` no longer promotes the nearest hostile
   to killer. With no attacker/death-message evidence the cause is
   `UNKNOWN_CAUSE`, confidence `unknown`; explicit evidence is `likely`.
2. **Cold dashboard start** — `homeBase.status()` no longer parses the manifest
   or scans the custom store. `Runtime._warmStatusCaches()` pays manifest,
   custom-store, every controller status and builder analysis before the
   dashboard starts, yielding every four calls. Snapshot readers use
   `loadedInMemory`.
3. **Launch phase** — per-bot steps/safety start on the next event-loop turn;
   team rescue and healing are dispatched instead of awaited, with 8 s/5 s
   deadlines and one-in-flight guards.
4. **Safety budget** — `EMERGENCY_BUDGET_MS` (default 6000) is a real absolute
   deadline through survival/retreat/recovery/combat. Path moves are capped by
   remaining time; a watchdog cancels at budget + 750 ms.
5. **Cancellation** — `cancelCurrent()` reaches combat as well as mining,
   woodcutting, farming and player watch; `runExclusive` stops controller loops
   and motion before draining.
6. **Close-range zombie deaths** — failed escapes retry on the next safety pass
   instead of waiting 1.2 s; the first escape hop is 4 m (900 ms), then 7 m and
   10 m.
7. **Planner loops** — three consecutive automatic plan failures pause planning
   for 30 minutes and expose the signed reason; a failed objective stores its
   task failure. No more one-minute recreation of the same impossible plan.
8. **Process resilience** — an unhandled rejection is logged and the runtime
   keeps running; uncaught synchronous exceptions remain fatal.
9. **Reports** — added `PERFORMANCE_REPORT.md`, `PLUGIN_COMPATIBILITY.md`,
   `AUTHENTICATION_REPORT.md`; updated `LIVE_ACCEPTANCE_REPORT.md` and
   `BUG_LEDGER.md`.
10. **Event-loop p99** — action scans were unbounded and scanned bottom-up.
    `ACTION_SCAN_BUDGET_MS=6`, near-first ordering, a deadline check before every
    lookup and a macrotask yield per target bring the 8 s simulation window from
    **p99 367–446 ms / max 648 ms to p99 41.5 ms / max 52.6 ms**. The routine
    event-loop histogram is reset after startup; the startup histogram is kept
    as `diagnostics.startupEventLoop`.
11. **Tooling** — `npm run perf:status` reproduces the snapshot benchmark.

## Evidence

| Gate | Result |
|---|---|
| `npm test` | **414/414 pass** |
| `npm run lint` | **PASSED, 169 files** |
| `npm run commands:audit` | **45/46, 0 failures** |
| `npm run validate` | **10/10, PASSED** |
| `npm run deploy:check` | **13/13** |
| `npm run check:secrets` | **PASSED, 210 files** |
| `npm run perf:status` | cold 117 ms; warm p50/p95/max **4/5/5 ms**; target <50 ms PASS in simulation |
| 8 s steady simulation event loop | p50 **20.2 ms**, p95 **25.7 ms**, p99 **41.5 ms**, max 52.6 ms |

The first snapshot after the production startup warm-up measured **18 ms** in a
separate run. The warm-up itself is a one-shot **370 ms** before the dashboard
binds, and it yields every four status calls.

## Explicitly not claimed

- No live connection, join, AuthMe/SimpleAuth challenge, Geyser/ViaVersion or
  GrimAC test.
- No live `launch-actions` timing; the supplied live log remains the evidence
  that the bug exists, not proof that it is gone.
- No live zombie survival result and no browser test.
- The cold 117 ms figure is measured **before** warm-up; production warms before
  the dashboard listens. A caller that bypasses `start()` can still see the cold
  cost.

## Files changed

Code: `src/actions/index.js`, `src/actions/combat.js`, `src/actions/homeBase.js`,
`src/combat/team.js`, `src/config.js`,
`src/index.js`, `src/runtime.js`, `src/runtimeState.js`, `src/schematics/library.js`,
`src/team/teamCoordinator.js`, `src/team/taskBoard.js`.

Tests: `tests/audit-regressions.test.js`, `tests/combat.test.js`,
`tests/controllers.test.js`, `tests/dashboard-performance.test.js`,
`tests/dashboard-status.test.js`, `tests/recovery.test.js`,
`tests/runtime-safety.test.js`.

Docs/tooling: `PERFORMANCE_REPORT.md`, `PLUGIN_COMPATIBILITY.md`,
`AUTHENTICATION_REPORT.md`, `LIVE_ACCEPTANCE_REPORT.md`, `BUG_LEDGER.md`,
`README.md`, `.env.example`, `scripts/bench-status.js`, `package.json`.
