# Chickenbots V6 — round 35 report

**Scope:** the operator supplied a second live log (25 Nov 2026, 18:27–19:39
UTC, `EmpiSMP.aternos.me:32990`, five bots) after round 34. Round 35 turns the
remaining live evidence into bounded code paths. The sandbox still cannot reach
that server, so every live criterion below remains **UNVERIFIED**; the numbers
in the simulation table are not live measurements.

## What the supplied live log proved

| Observation | Value |
|---|---|
| Dashboard snapshot blocks | **5208 ms** (`actions=4237`), 1828 ms (`actions=1709`), 1173 ms (`actions=1112`) |
| Event-loop blocks | 30601.6 ms and 11827.9 ms at `dashboard-snapshot`, 5691.7 ms at `launch-actions`, 4441.8 ms at `action:00110000:FARM_CROP`, 1041.8 ms at `state-sync` |
| Client tick lateness | up to 30797 ms; `10101000` logged 229 stall recoveries |
| Safety | `threat` 18.1 s and 60.3 s (`action cancelled: exceeded 60000ms`); `defend` 19.5 / 13.3 / 9.5 / 8.4 s |
| Death attribution | `[01010100] died … (cause: item (1.3m))` |
| Planner | `automatic plan failed (1…)` then `(2…)`, with the same `BUILD A PERMANENT SURVIVAL BASE` objective recreated at 19:26:05, 19:35:17 and 19:39:56 |
| Startup | schematic library 10000 designs in **7236 ms** |
| Transport | two `EPIPE` disconnects and one `kicked (Connection timed out)`; reconnect generations 2 and 3 succeeded |

## Repairs in this round

1. **Dashboard status is cache-only.** `BotActions` keeps one cached status per
   controller. The runtime refreshes one controller per bot per tick on a
   `setImmediate`, outside `_syncBots` and outside the HTTP/SSE request. The
   snapshot returns the cache plus `freshness.actionStatus` and
   `maxActionStatusAgeMs`; a stale cache raises a visible dashboard alert.
   A cold caller (CLI/tests) still fills the cache once.
2. **`launch-actions` is no longer the attribution bucket.** Combat role
   assignment, construction auto-advance and dispatched team work start on a
   macrotask instead of a promise microtask or inline call. AssignRoles uses a
   new lightweight `CombatController.summary()` (no threat/gear scan) rather
   than five full `status()` calls, which alone fit the observed 5.7 s.
3. **A safety pass has a hard ceiling.** `BotActions.safetyTick()` races its
   body against `EMERGENCY_BUDGET_MS + 250 ms`, calls `cancelCurrent()` and
   `bot.cancelAction()`, and releases the per-bot safety slot even if an adapter
   await never settles. The live 60.3 s `threat` stage cannot hold a slot for a
   minute again.
4. **Planner retries in place.** A failed objective is re-opened by
   `TaskBoard.reopenObjective()` under the same id; no new near-identical
   objective is minted. Three consecutive failures still enter the 30-minute
   pause and the long-backoff retry also targets the same id.
5. **Death attribution rejects objects.** A health drop no longer promotes an
   arbitrary nearby entity. Only a player or hostile mob within 4.5 m is
   recorded (`evidence: proximity`, confidence `likely`), the server death
   message wins when present, and `item`/`object` causes become
   `UNKNOWN_CAUSE` with confidence `unknown`.
6. **Farming scans are bounded.** `harvestAll()` uses
   `ACTION_SCAN_BUDGET_MS`; farm-site/soil scans use a 25 ms action budget, visit
   the bot's own level and nearby columns first, and yield between cells. The
   49×49×17 `_localSoil` cube that could block inside `FARM_CROP` is gone.
7. **Startup no longer parses 20 MB.** `npm run schematics:summary` writes
   `data/schematics/summary.json` (3.3 KB). Runtime startup, status, diagnostics
   and dashboard library counts use it; the full manifest stays lazy for
   individual designs. Live 7236 ms → **38 ms** in the equivalent sandbox run.
8. **State sync does not rescan entities.** The safety pass records its real
   threat assessment on the adapter; `summary()` reuses it for 5 s. This removes
   the O(all entities) scan that produced the 1041.8 ms `state-sync` block.
9. **Budgeted scanning cannot half-chop a tree.** `findTrees()` may stop
   mid-trunk on its 6 ms budget; `chopTree()` now walks down to the real stump
   before cutting. A cold regression run cut 3 of 4 logs before this fix.
10. **Event-loop bounds carried forward.** `ACTION_SCAN_BUDGET_MS = 6`,
   `STATUS_SCAN_BUDGET_MS = 2`, near-first scans and a deadline check before
   each world lookup remain in force.

## Evidence actually run (simulation / local HTTP only)

| Gate | Result |
|---|---|
| `npm test` | **420/420 pass, 0 fail** |
| `npm run lint` | **PASSED, 171 files** |
| `npm run commands:audit` | **45/46 executed or help-audited, 0 failures** |
| `npm run deploy:check` | **13/13** |
| `npm run check:secrets` | **PASSED, 213 tracked files** |
| `npm run validate` | **VALIDATION PASSED**, consistency **10/10**, manifest 10000/10000 unique |
| `npm run perf:status` | cold **96 ms** (`actions` 46, `builds` 40); warm-up **5 ms**; warm p50 **2 ms**, p95 **7 ms**, max **7 ms**; target < 50 ms PASS |
| 8 s simulation event loop with `/api/state` every 500 ms | p50 **20.2 ms**, p95 **21.7–23.5 ms**, p99 **43.5–46.6 ms**, max **242.2 ms** |
| Startup event-loop histogram | p99 **22.8 ms** (2 samples; previous live startup included a 7236 ms library parse) |
| Local `/api/state` (10 requests, 500 ms apart) | **4.9–18.9 ms** wall; `snapshotMs` **2–12 ms**; `sections.actions` **0–1 ms** |
| Status cache freshness | max age **8.7 s** (12 controllers per bot at one per 750 ms tick), `actionStatusFresh: true` |
| Command path | `POST /api/command {"line":"status"}` → 2 ms, five ready; `{"line":"chop all"}` → 115 ms, 5/5 completed, 6 logs verified for the first bot |

## Explicitly not claimed

- No connection to the live server from this sandbox; no join, AuthMe,
  SimpleAuth, Geyser, ViaVersion, GrimAC, EPIPE or kick result.
- No live `launch-actions`, `FARM_CROP`, safety-stage or reconnect timing.
- The 242.2 ms event-loop max is a simulation outlier and is above the 50 ms
  p99 target line only as a max, not a percentile; it is not hidden.
- No browser interaction or 3D canvas test was performed.
- The startup 38 ms is the sandbox reading the generated summary, not the live
  Aternos host.
