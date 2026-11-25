# Chickenbots V6 — round 30 report (dashboard event-loop starvation)

**Branch:** `arena/de11bd2d-chickenbots`
**Starting head:** `48bab31` (round 29)
**Server target:** `EmpiSMP.aternos.me:32990`
**Live evidence:** one operator-supplied runtime log, 2026-11-25 16:32:53 → 16:41:22 UTC

> **Evidence boundary:** this sandbox cannot reach `EmpiSMP.aternos.me:32990`.
> The pasted log is the only live evidence; everything below was reproduced
> analytically and exercised with the Node test suite and deterministic
> simulation. `FIXED (unit)` is not a live acceptance claim.

## A. Gate

| Item | Value |
|---|---|
| Repository | `fallendrake0-droid/Chickenbots` |
| Branch | `arena/de11bd2d-chickenbots` |
| Starting head | `48bab31` |
| Tests | **376 / 376 pass**, 0 fail |
| Lint | **PASSED**, 159 files |
| Consistency | **PASSED (10/10)** |
| Deploy check | **12/12** |
| Secret leak check | **PASSED**, 192 tracked files |
| Schematic catalogue | unchanged, 10,001 designs |

No feature was disabled and no test was skipped to obtain this gate.

## B. What the live log showed

The fleet never stabilised. The dominant symptom was not a Minecraft protocol
problem; it was a synchronous dashboard snapshot owning the Node event loop:

- `dashboard state snapshot took …` every 10–25 s, ranging from **1,684 ms to
  38,305 ms** (34 samples).
- `event loop blocked for up to 38856ms (p99 16215.2ms) at phase state-sync`.
- Because the loop was blocked, every bot's `client_tick_end` was 3.5–38.9 s
  late. The tick scheduler correctly paused movement and re-anchored, producing
  dozens of `client tick loop was … late; paused movement, re-anchored` lines.
- Inbound packet gaps reached 27–65 s, eight bots were dropped together at
  16:38:07 (`socketClosed` / `EPIPE`), and one bot (`00110000`) died.
- Join stages were declared timed out while the loop was frozen:
  `LOGIN_TIMEOUT` (30 s) for `11101001` and `10101000`, `SPAWN_TIMEOUT` (45 s)
  for `01010100`.

`state-sync` was a red herring: the watchdog reports the last phase recorded by
the tick loop, while the block was actually inside the dashboard timer. The
snapshot warning is emitted *after* the block, so its elapsed time is the
blocking time.

## C. Root cause

Every dashboard snapshot rebuilt all ten `BotActions.status()` objects. Four
controllers performed synchronous world scans from inside `status()`:

| Controller | Status scan | Positions per bot |
|---|---|---|
| Mining | `findOres({ radius: 5 })`, 11³ cube plus six neighbour probes per ore | 1,331 + probes |
| Farming | `scanCrops({ radius: 8 })` with the surface y-window | 25 × 17 × 17 = 7,225 |
| Fishing | `findBlocks(WATER, { radius: 8 })` with the surface y-window | 7,225 |
| Sleep | `findBeds({ radius: 12 })` with the surface y-window | 25 × 25 × 25 = 15,625 |

The generic scanner used its **slow path** for all surface scans: supplying a
y-window bypassed `world.findBlocks()`. Each position called the adapter's
`getBlock()`, which constructs a full block object (properties and state id) and
went through mineflayer's `blockAt()`. A single fleet snapshot therefore issued
roughly **300,000 object-returning block reads**, which is consistent with the
observed 8–38 s blocks on the live server.

Three multipliers made it continuous rather than occasional:

1. `findBlocks` had no deadline, so one bad scan could not be interrupted.
2. Cache jitter used `String(bot.name).charCodeAt(0)`; every roster name starts
   with `0` or `1`, so all ten bots shared only **two** TTL buckets and expired
   together. Movement thresholds (6/8/12 blocks) also invalidated caches while
   the bots were being re-anchored by the stall recovery.
3. Every SSE tick, `/api/state` request and stream open called
   `snapshot(true)`, bypassing the 500 ms coalescing cache. Ten bots, several
   status calls and JSON serialisation repeated for every reader.
4. One snapshot also computed team combat status twice or three times (once for
   `combatTeam`, once through `runtime.state()`, once inside
   `TeamCombatCoordinator.status()`), each pass re-assessing entities and
   equipment. Excavation status, task-board statistics and deadlock detection
   were each computed twice.

## D. Fix

| ID | Sev | Area | Root cause and failure mode | Fix | Regression test |
|---|---|---|---|---|---|
| BUG-30-01 | P0 | Dashboard snapshot | Four status panels synchronously scanned 300 k world positions per fleet snapshot, blocking the event loop for 8–38 s and starving client ticks/keepalives | Status scans are now cached with roster/controller-staggered TTLs, only refreshed after a long displacement (16–24 blocks), and hard-bounded by `STATUS_SCAN_BUDGET_MS` (8 ms per scan) | `dashboard-performance.test.js` |
| BUG-30-02 | P0 | Block scanning | `findBlocks` bypassed the indexed world search whenever a y-window was used, and its fallback had no deadline | `RealBot` world view gained `blockNameAt()` and an indexed `findBlocks()` (mineflayer palette skip); `findBlocks` now prefers it and the fallback is time-bounded, checks y outward from the bot and uses name-only lookups | `dashboard-performance.test.js` |
| BUG-30-03 | P1 | Status caches | Jitter hashed only the first character of the binary roster, producing two expiry buckets; all ten bots rescanned in the same snapshot. Farming re-counted animals on every poll even on a cache hit | Whole-name hash with 11 TTL slots and per-controller offsets; animals are cached with the crop scan | `dashboard-performance.test.js` |
| BUG-30-04 | P1 | Dashboard transport | Every SSE tick and API request forced a fresh full snapshot, defeating the coalescing cache and multiplying work per browser tab | Readers use the 500 ms coalescing snapshot; commands/settings still invalidate explicitly | `dashboard-status.test.js` |
| BUG-30-05 | P1 | Snapshot assembly | Team combat status was rebuilt up to three times per snapshot (each pass re-assessing every entity and inventory); excavation status, board stats and deadlocks were computed twice | Status snapshot reuses action combat objects via `controllerStatus`, passes the team status into `runtime.state({ combatTeamStatus })`, reuses excavation status in alerts and computes board stats/deadlocks once | `dashboard-performance.test.js` |
| BUG-30-06 | P2 | Diagnostics | A slow snapshot named no subsystem, and the event-loop watchdog blamed the last tick phase (`state-sync`) for a block that occurred in a timer | Snapshots carry per-section timings; the warning lists sections ≥50 ms; `runtime.recordExternalWork()` attributes the block to `dashboard-snapshot` | `dashboard-performance.test.js`, `dashboard-status.test.js` |
| BUG-30-07 | P2 | Local status scans | Bottom-up y iteration spent a bounded budget on buried layers far below the bot when the deadline interrupted a scan | Y is walked outward from the bot, so partial results describe the neighbourhood the panel is about | `dashboard-performance.test.js` |

## E. Verification

- Full suite: **376 tests, 376 pass, 0 fail** (45.8 s).
- Lint: 159 files clean.
- Consistency: 10/10. Deploy check: 12/12. Secrets: 191 tracked files clean.
- Deterministic simulation (`MC_SIMULATE=true`, ten bots, dashboard on port
  3100): `performance.snapshotMs` was **6 ms** after warm-up; `/api/state`
  served in 13–126 ms wall time including HTTP and JSON. This is a simulation
  measurement, not a live claim.
- Local stress measurement with a 200 µs-per-lookup fake world: all four status
  panels for all ten bots completed in **~398 ms** before caches were warm. The
  previous code would have performed minutes of blocking work in the same
  scenario.
- The hard-budget test drives a 129³ scan with a 1 ms lookup and completes in a
  few tens of milliseconds instead of minutes.

## F. Files changed

`src/actions/common.js`, `src/actions/mining.js`, `src/actions/farming.js`,
`src/actions/fishing.js`, `src/actions/sleep.js`, `src/bot/realBot.js`,
`src/combat/team.js`, `src/dashboard/server.js`, `src/runtime.js`,
`src/runtimeState.js`, `src/team/taskBoard.js`, new
`tests/dashboard-performance.test.js`.

## G. Still open

- **BUG-27-09** — repeated `bot all chop oak` exhausts nearby trees for the last
  bots (10/10, 9/10, 8/10, 8/10). Reported honestly as partial.
- **BUG-27-10** — long-simulation event-loop max (1,433.4 ms at `MINE_ORE`).
  The mining scan is cheaper now (`blockNameAt`, bounded fallbacks) but this
  round did not re-run the 89-minute simulation.
- **Stage timeout grace** — `LOGIN_TIMEOUT`/`SPAWN_TIMEOUT` use wall-clock
  timers. A future multi-second synchronous block can still cause a timer to
  fire immediately after the loop resumes. With the dashboard no longer
  blocking, the observed cascade should disappear; stall-aware timeout
  accounting remains a candidate hardening item.
- All live-only items remain unverified live; the sandbox cannot reach the
  server.
- GitHub authentication recovered during this round: `48bab31` and this
  round's commit are now on `origin/arena/de11bd2d-chickenbots`.
