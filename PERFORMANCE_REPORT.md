# Chickenbots V6 — performance report (rounds 34–36)

**Scope: simulation only.** The Arena sandbox cannot reach
`EmpiSMP.aternos.me:32990`, so no live event-loop, tick-latency or join-time
number is claimed here. Live measurements belong in
`LIVE_ACCEPTANCE_REPORT.md` and remain **UNVERIFIED**.

## Reproduce

```bash
npm run perf:status
```

The script creates the deterministic five-bot runtime without a dashboard,
takes one cold snapshot, runs the production startup warm-up, then measures 15
routine snapshots. It prints JSON and exits non-zero only on an exception.

## Result after round 35

Node 22.22.3, five `MockBot`s, no dashboard, this sandbox:

| Measurement | Result |
|---|---|
| Cold first snapshot, **before** warm-up | **96 ms** (`actions` 46, `builds` 40 — one-time custom-store scan) |
| Startup warm-up (`_warmStatusCaches`, yields every four calls) | **5 ms** (schematic summary replaced the 20 MB parse) |
| Routine snapshot p50 / p95 / max (15 samples) | **2 / 7 / 7 ms** |
| Acceptance target | p95 < **50 ms** — **PASS in simulation** |

Per-section cost in the routine snapshot: `actions` **0 ms**, `bots` 0 ms,
`builds` 0 ms, `runtime` 0 ms; all sections 0 ms at millisecond resolution.

### Result after round 36

`perf:status` now measures the cache-only cold contract directly:

| Measurement | Result |
|---|---|
| Cold snapshot before warm-up | **63 ms**; `actions` **0 ms** (empty cache), `builds` **49 ms** |
| Startup warm-up | **64 ms** |
| Routine snapshot p50 / p95 / max | **2 / 3 / 3 ms** |
| Acceptance target | p95 < **50 ms** — **PASS in simulation** |

The drop from 96 ms to 63 ms is not a benchmark trick: the cold snapshot no
longer runs twelve controller status methods. It returns `statusCache.empty`
and the dashboard renders freshness null until startup warm-up fills it.

### Round 36 correction: cold is not a snapshot path

`BotActions.status()` is now cache-only. The 96 ms cold number above is
`perf:status` filling the cache for the first time via `refreshStatus`; it is
not a dashboard request. A cold dashboard returns null sections with
`statusCache.empty: true` instead of running twelve live scans. This removes
the last way a first HTTP/SSE request could reproduce the capture's
`actions=4237 ms` block. A new regression test poisons every controller and
asserts zero calls from a cold `status()`.

Task pre-emption adds one 500 ms interval per running task. It only reads scalar
bot fields and the coordinator assignment; it performs no world scan. When it
fires, it cancels the task and returns the bot to the existing safety path, so
the safety budget and movement arbiter are unchanged.

### Round 35 live-evidence fixes (simulation measurements)

The supplied live log showed dashboard snapshots of **5208 ms** (`actions=4237`)
and a **7236 ms** startup library parse. Round 35 moved every controller status
behind a cache refreshed off the request and off `_syncBots`, and replaced the
startup manifest parse with `data/schematics/summary.json`.

| Measurement (local simulation/HTTP) | Result |
|---|---|
| `/api/state`, 10 requests 500 ms apart | **4.9–18.9 ms** wall |
| `snapshot.performance.snapshotMs` | **2–12 ms** |
| `sections.actions` | **0–1 ms** |
| Status cache max age | **8.7 s** (12 controllers, one refresh per bot per 750 ms), fresh flag true |
| 8 s event-loop window | p50 20.2, p95 21.7–23.5, p99 **43.5–46.6**, max **242.2 ms** |
| Startup event-loop histogram | p99 **22.8 ms** |
| Library ready | **38 ms** using the 3.3 KB summary (live was 7236 ms) |

The max 242.2 ms is a simulation outlier (a cold status/custom-store path), not
a percentile; it is reported rather than filtered. No live number is claimed.

### Event-loop delay (simulation, 8-second steady-state window)

The event-loop histogram is reset after `start()` finishes its one-shot warm-up;
the startup histogram is retained as `diagnostics.startupEventLoop` so it is
visible without deciding the routine p99. After a five-second settle, an
eight-second window with `/api/state` every 500 ms measured:

| Metric | Before action-scan bounding | After |
|---|---|---|
| p50 | 20.2 ms | 20.2 ms |
| p95 | 22.6–32.6 ms | **24.5 ms** |
| p99 | **367–446 ms** | **41.5 ms** |
| max | 648–748 ms | 52.6 ms |

**PASS in simulation against p99 < 50 ms.** The max 52.6 ms sample is below the
250 ms investigation threshold. This is not a live measurement.

Root cause found with a CPU profile and a 10 ms event-loop probe: action scans
were not bounded (mining `findExposed`, woodcutting `findTrees`), checked their
deadline only every 32 positions, and scanned a cube bottom-up. With several
bots' immediates running in one turn, a cold simulation column could block for
hundreds of milliseconds while the phase label still said `launch-actions`.
`ACTION_SCAN_BUDGET_MS = 6` now bounds mine/chop scans; status scans use
`STATUS_SCAN_BUDGET_MS = 2`. Scans are near-first and check the deadline before
every world lookup; each mined block/tree yields a macrotask so fast adapters
cannot run an entire quota as microtasks.

### Local dashboard over HTTP (simulation, not a live MC server)

A temporary `TeamRuntime` with `simulate:true, dashboard:true` was started on
`0.0.0.0:3130`. Ten `GET /api/state` requests, 500 ms apart, returned:

| Request | Wall time | `snapshot.performance.snapshotMs` | `sections.actions` |
|---|---|---|---|
| 1 (first HTTP connection) | 18.9 ms | 12 ms | 1 ms |
| 2–10 | 4.9–9.9 ms | 2–4 ms | 0 ms |

The first local request in round 34 measured 133 ms / `actions` 17 ms; the
cache-only status path removes that serial scan. All routine snapshots are
below the 50 ms target. `POST /api/command` was also exercised: `status` took
2 ms and `chop all` 115 ms with 5/5 bots completing verified work.

This proves the local HTTP/dashboard path, not any live server criterion.

## Before / after

| Symptom | Root cause found in round 34 | Fix | Evidence |
|---|---|---|---|
| First snapshot 622 ms; `sections.actions` 580 ms | The first `homeBase.status()` called `library.loaded`, which parsed the 20 MB manifest (259–329 ms). `library.count` constructed and scanned `CustomSchematicStore`. Builder status could run its first world `analyze()`. These costs were charged to the first dashboard request. | `loadedInMemory` / `knownCount` on the library; `homeBase.status()` never lazily loads or scans. `_warmStatusCaches()` pays manifest, custom store, every controller status and builder analysis **before** `dashboard.start()`, yielding every four calls. | `tests/dashboard-status.test.js`; `tests/dashboard-performance.test.js`; `npm run perf:status` |
| `sections.builds` 316–349 ms | `library.stats()` was first evaluated inside the snapshot. | Same warm-up calls `library.stats()` first. | same |
| Routine p99 367–446 ms and 648 ms max | Action scans were unbounded, checked the deadline every 32 lookups and started at the bottom of the cube. Fast adapters also completed whole quotas as microtasks. | `ACTION_SCAN_BUDGET_MS = 6`; near-first axis walk; deadline before every lookup; `setImmediate` yield per target; event-loop counters reset after startup. | `dashboard-performance.test.js`; 8 s simulation window |
| `launch-actions` blocks of 9–18 s in the supplied live log | Controller `safetyTick()` runs synchronously until its first `await`; `_startBotStep`/`_startBotSafety` invoked it inside `_launchBotWork`, so the phase timer charged that prefix to launch. Team rescue/healing were also **awaited** by `_tick` (up to 20 s). | Start bot work on the next event-loop turn (`setImmediate`), so launch returns immediately. Dispatch team rescue/healing as tracked background work with an 8 s / 5 s budget instead of awaiting them in the tick. | `tests/runtime-safety.test.js` ("team rescue and healing are dispatched…", "pre-join safety…") |
| Safety stages 23.8–61.1 s; `action cancelled: exceeded 60000ms` | `safetyTick()` had no budget; combat `engage()` looped until attacks/ticks without a deadline; path calls could consume Mineflayer's 20 s default. | `EMERGENCY_BUDGET_MS` (default **6000**) becomes an absolute `deadlineAt` propagated through `_threatResponse`, `_emergencyRetreat`, `_recover`, `combat.defend/engage/retreat/protectTeammate`. Moves are capped by the remaining budget. A runtime watchdog cancels movement at `budget + 750 ms`. | `tests/combat.test.js` deadline/bounded-move test; `tests/recovery.test.js` safety deadline test |
| Commands delayed behind a player watch | `cancelCurrent()` never reached combat, and `runExclusive` cancelled the bot but not controller stop flags. | `cancelCurrent()` now stops `combat` as well as mining/woodcutting/farming/players. `runExclusive` calls `_cancelBotWork`, which stops controller loops and cancels motion before waiting for the in-flight task. | `tests/recovery.test.js`; `tests/runtime-safety.test.js` |

## Deliberate non-goals

- The 500 ms dashboard snapshot coalescing cache is **not** removed; it is
  correct and independent of the cold-start cost.
- `construction.preview()` (`analyze({refresh:true})` +
  `planTasks({refresh:true})`) is never called from a status or snapshot path.
- No CPU-heavy work is wrapped in `await` to look asynchronous. The warm-up is
  explicitly a startup cost and yields between calls; routine snapshots do no
  disk I/O, manifest parse or custom-store scan.

## Open performance work

- Cold snapshot is still 117 ms if a caller bypasses `runtime.start()` and
  asks for a snapshot before the warm-up. Production dashboard startup warms
  first; a regression test enforces the warm path.
- No live p99 event-loop sample exists from this sandbox. The supplied live log
  remains the only source for live `launch-actions` timing until a live run is
  attached.
