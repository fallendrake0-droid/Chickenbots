# V6 Round 50 — detailed command terminal and a responsive goto

**Request:** “make terminal more detailed for commands … and goto command doesn't
work took too long to decide path”.

**Build in the live log:** `6.0.0+0c44adf`. **Live-server result UNVERIFIED** —
the operator's Aternos server is not reachable from this sandbox.

## What was wrong

### The terminal only reported failures

`CommandRegistry._record()` stored the full result and duration, but never
logged a successful command. The CLI's `printResult()` printed a bare
`✓ goto` plus raw JSON. There was no way to see which bot moved, where it
started, how long the pathfinder planned, how long the walk took, or how much
of the total was queue wait behind an autonomous task.

### goto was planned with the autonomous-task budget

Every pathfinder call shared `PATHFINDER_THINK_TIMEOUT_MS=2500` and
`PATHFINDER_TICK_TIMEOUT_MS=10`. Ten milliseconds of A* per event-loop turn is
a deliberately tiny autonomy budget; for a long operator goto it often stopped
with mineflayer-pathfinder's `Took to long to decide path to goal!` before A*
had explored enough of the route. The error was also re-planned up to three
times, and a deterministic `NoPath` spent all three attempts on the same map.

Additionally, `goto` returned no timing breakdown and no command scheduling
information, so a slow command looked identical whether it waited 2.5 s for a
prior task or spent the time in A*.

## Fixes

| ID | Priority | Area | Fix |
|---|---|---|---|
| BUG-50-01 | P0 | goto reliability | Operator movement gets its own A* budget: `PATHFINDER_OPERATOR_THINK_TIMEOUT_MS=8000` and `PATHFINDER_OPERATOR_TICK_TIMEOUT_MS=25`, while autonomous tasks keep 2500/10. A retry scales the wall budget (§ `pathfinderBudgets`). |
| BUG-50-02 | P0 | goto failure latency | A `NoPath`/`PATH_NOT_FOUND` result stops the operator retry ladder immediately. The same map is no longer searched three times. Planning timeouts are typed `PATH_PLAN_TIMEOUT`; an empty path that the bot has not already reached is `PATH_NOT_FOUND` rather than a silent success. |
| BUG-50-03 | P0 | Command terminal | Every non-CLI command logs an accepted/start line immediately, then the finished report with status, duration, source/operator, result fields, up to 12 per-bot rows, navigation timing split and queue/cancel/execution time. The CLI prints the same report before the raw JSON. |
| BUG-50-04 | P1 | goto diagnostics | `_executeNavigationPath()` now measures `setupMs`, `planMs`, `followMs`, total time and the think/slice budgets actually used. `goto` also reports `from`, `requested`, straight-line `distance`, `commandMs` and `scheduling`. |
| BUG-50-05 | P2 | Command queue visibility | `runExclusive()` records `queuedMs`, `cancelWaitMs`, `execMs` and `totalMs` per bot; the command result exposes the last one without changing the runtime's exclusion semantics. |

## Evidence

- `node src/cli.js --simulate "goto 5 65 5"` prints:

```
cmd-1 ok goto in 24ms [cli/cli]
  line: goto 5 65 5
  bot=________
  arrived=true
  verified=true
  attempts=1
  steps=6
  from=-2.0,65.0,2.0
  position=4.0,65.0,5.0
  target=5.0,65.0,5.0
  goal=5.0,65.0,5.0
  scheduling: queued=0ms cancel-wait=0ms exec=24ms
```

- Simulator, dashboard source: `goto 10101000 40 65 -30` (56.4 blocks) returned
  `arrived: true, verified: true, attempts: 1, steps: 59` in 149 ms, and the
  server log showed the full per-bot report.
- Unit coverage:
  - `tests/command-format.test.js` — goto timing/queue fields, failed fleet
    rows, registry success logging.
  - `tests/navigation-path.test.js` — a no-path result is attempted once.
  - `tests/navigation-upgrade.test.js` — operator budget > task budget and
    retries scale it.
  - `tests/connection-lifecycle.test.js` — RealBot applies 8000/25 and returns
    `timings`; a `NoPath` rejection is `PATH_NOT_FOUND`.
- `npm test` → **568/568** (see final run), lint 0 errors, validate PASSED.

## Honest limits

- If the live map genuinely has no legal route (sealed cave, blocked door,
  unloaded destination), `goto` now fails quickly and names `PATH_NOT_FOUND`
  instead of retrying; it does not teleport or dig through a base.
- The 8000 ms operator planning budget trades up to 8 s of planning for a much
  better chance of finding a long route. Set
  `PATHFINDER_OPERATOR_THINK_TIMEOUT_MS` lower if a shorter failure is preferred.
- All live claims remain **UNVERIFIED** until the operator runs this build on
  `EmpiSMP.aternos.me`.
