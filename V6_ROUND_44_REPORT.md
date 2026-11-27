# Round 44 — suspended-clock truth, reachable storage and visible construction arming

**Branch:** `arena/de11bd2d-chickenbots`
**Base:** `7764c41` (`main`)
**Preceding shipped round:** `315ec05` (round 43)
**Live simulator observed after restart:** `6.0.0+315ec05.cc079c2a46b4.3d60d5c1af15`

---

## A. Scope

The instruction for this round was simply "fix all bugs". Triage therefore started
from the live five-bot simulation and from the first dashboard load after the
sandbox resumed, not from the test suite. Five concrete defects were reproduced:

1. `/api/state` and `/api/build` disagreed about uptime by almost an hour.
2. Container trips aborted with `ARRIVAL_UNVERIFIED` even when the chest could be
   opened, producing the repeated `home storage failed: pathfinder reported
   success but the bot is not within 3 blocks of the destination` warning.
3. `PLACE_BED` failed with `no bed in inventory or home storage` while the team
   owned five starter beds: the bed lookup only inspected the nearest registered
   chest, not the chest that actually held them.
4. A construction project sat at `PLANNING` / `ANALYSIS` with `autonomyEnabled:
   false`, and the Builder page offered no way to see that or to arm it.
5. A single failed task inside an already completed base objective raised a
   permanent `1 failed task(s)` dashboard warning.

A sixth symptom — a `2278.7s` safety task, a `38 minute` stale status cache and a
`2.2s` event-loop warning immediately after resume — was traced to work durations
being measured with the wall clock. That is fixed for durations; uptime is
deliberately still wall-clock (see B1).

Out of scope: new gameplay loops, a dashboard redesign, changing the
objective re-planning cadence, or making construction arm itself automatically.

---

## B. What was actually wrong

### B1. Two uptimes, two clocks

At 19:18 UTC the live process reported:

```
/api/state   uptimeMs 4149357   (69m 09s)
/api/build   uptimeMs  814383   (13m 34s)
builtAt      2026-11-27T18:08:51.605Z
```

`runtime.state()` used `Date.now() - startedAt`; `/api/build` and `/healthz` used
`process.uptime() * 1000`. Node's process uptime is based on a monotonic clock and
does not include host suspension, while the runtime's uptime and `builtAt` do. The
sandbox had been suspended, so one endpoint looked like an hour and the other like
fourteen minutes.

The dashboard now has one definition: `buildUptimeMs(build)` returns
`Date.now() - Date.parse(build.builtAt)`, and runtime uptime stays wall-clock
(`this.now() - this.startedAt`). After the restart the two endpoints agreed:

```
stateUptime 23209 ms
buildUptime 23231 ms
difference      22 ms
```

### B2. Work durations were inflated by suspension

The same suspension produced these false alarms:

```
WARN  [00110000] safety task took 2278.7s (budget 6000ms)
WARN  action status cache is stale (max age 2286942ms)
```

A safety pass and a controller status refresh are process work. Time during which
the process did not run must not count. `src/util/clock.js` now exposes
`monotonicMs()` (`performance.now()`), and it is used for:

- `_startBotSafety`, `_recordSafetyStages` and `BotActions.safetyTick` stage and
  total durations;
- the status-cache age used by `runtimeState` freshness (`monoAt` per entry);
- runtime tick/sync/team-dispatch/join/library warm-up durations that feed the
  dashboard performance panel.

The stale threshold was also too tight for a live sweep. Twelve controllers are
refreshed one per bot per tick; with a 750ms tick and scans that can take a few
hundred milliseconds, a full sweep takes 12–20s. A 12s threshold therefore raised
`action status cache is stale` on a healthy process. It is now 30s: still short
enough to expose a refresh that has genuinely stopped, long enough to ignore
ordinary scheduling jitter. A regression test ages the cache to 25s (fresh) and
31s (stale).

Wall-clock timestamps (`at`, `builtAt`, `refreshedAt`, claim TTLS, damage windows)
stay on `Date.now()`. Uptime is a calendar interval and stays wall-clock, matching
`/api/build` and OS uptime.

### B3. A short arrival is not an unreachable container

`InventoryManager` treated any failed `goTo(..., { range: 3 })` as "cannot reach the
container". The navigation manager has a specific honest code for "the route
completed but the entity settled short": `ARRIVAL_UNVERIFIED`. The live log showed
it six times per run, and each time the overflow trip abandoned the deposit.

`_reachContainer()` now lets `ARRIVAL_UNVERIFIED` continue to `openContainer()`.
The open result is the verification: a real client refuses a chest outside reach,
while a narrow corridor that ends five blocks out can still have an openable chest.
`deposit()`, `withdraw()`, `ensureBedFromStorage()` and `_depositSurplusAt()` all use
the helper, so the old three-block assumption is gone from every container path.

### B4. Beds were searched in the nearest chest, not the home chest

The starter kit gives every bot `white_bed: 5`. An overflow trip deposits them in
the shared home chest. `ensureBedFromStorage()` called `findStorage()`, which
deliberately returns the *nearest* registered storage for generic deposits. With a
construction cache or an empty chest nearer than the home chest, `PLACE_BED` opened
the nearest chest, found no bed, and failed with:

```
no bed in inventory or home storage
```

`_storageCandidates()` now collects every storage the fleet knows about — ledger
entries, the bot's `homeStorage`, and the shared `home_storage` memory fact — and
orders them by recorded bed count, then distance. The action opens candidates until
one really contains a bed, verifies the withdrawal in hand, and reports how many
containers it searched. An empty or unreadable chest no longer ends the trip.

### B5. An unarmed construction project looked like a stuck project

`ConstructionManager.autoAdvance()` correctly refuses world changes until
`project.autonomyEnabled` is true. But `summary()` did not expose that flag, and the
Builder overview rendered `PLANNING` / `ANALYSIS` with no explanation and no start
control. The live project had been in that state since 15:46.

`summary()` now includes `autonomyEnabled` and `paused`. The Builder overview shows
an **Autonomy** row (`not armed` / `armed` / `paused`), appends `· not armed` to the
active-status context, and renders an explicit callout with a **Start pipeline**
button (`builder auto on`) while an active project is unarmed. The project is still
not armed automatically: this makes the safety gate visible and actionable rather
than silently stalled.

### B6. A finished objective kept its failed-task warning forever

`buildAlerts()` counted every `FAILED` task in the board. The autonomous planner
keeps creating a fresh survival-base objective after each completion, so a chop
that stalled during one plan left `1 failed task(s)` on the dashboard after that
objective had already completed and no retry was possible.

The alert now filters failed tasks whose objective is `COMPLETED` or `CANCELLED`.
A failure in an active/pending objective still alerts normally.

---

## C. Files changed

| File | Change |
| --- | --- |
| `src/util/clock.js` | New monotonic clock helper with the suspension rationale |
| `src/runtime.js` | `monoNow` injection; work durations on monotonic time; uptime and CPU sampling stay wall-clock; `monoNow` passed to actions |
| `src/actions/index.js` | `monoNow` on `BotActions`; safety stage/total durations and status-cache ages |
| `src/actions/inventory.js` | `_reachContainer()`, `_storageCandidates()`, bed search, all container moves |
| `src/dashboard/buildInfo.js` | `buildUptimeMs()` from `builtAt` |
| `src/dashboard/server.js` | `/healthz` and `/api/build` use the shared uptime |
| `src/construction/manager.js` | `autonomyEnabled` / `paused` in project summaries |
| `src/dashboard/public/js/pages/operations.js` | Autonomy row, not-armed context, Start pipeline callout |
| `src/runtimeState.js` | Ignore failures in terminal objectives |
| `tests/monotonic-clock.test.js` | New: wall uptime vs monotonic cache age |
| `tests/inventory-storage.test.js` | New: bed in a farther chest; unverified arrival still deposits |
| `tests/dashboard-build.test.js` | New: shared build uptime helper |
| `tests/dashboard-performance.test.js` | New: 25s slow sweep is fresh, 31s stopped sweep alerts |
| `tests/dashboard-status.test.js` | New: terminal-objective failure alert filter |
| `tests/construction.test.js` | Summary reports `autonomyEnabled` |

---

## D. Verification

### Automated gates

| Gate | Result |
| --- | --- |
| `npm test` | **541/541 pass** |
| `npm run lint` | **PASSED** (203 files; 5 pre-existing warnings, 0 errors) |
| `npm run validate` | **VALIDATION PASSED** |
| `npm run commands:audit` | **48/49** executed or help-audited, 0 failures |
| `npm run test:routing` | **3/3** |
| `npm run deploy:check` | **13/13** |
| `render-real.mjs` | **52/52 rendered** |
| `render-empty.mjs` | **41/41 pages** |
| `render-smoke.mjs` / `render-partial.mjs` | **43/44** (the one miss is the intentional not-found route) |

### Live simulator

Restarted at 19:42:04 UTC with a clean runtime:

- build `6.0.0+315ec05.cc079c2a46b4.3d60d5c1af15`, five bots ready;
- `/api/state` and `/api/build` uptimes agree within 25 ms;
- first snapshot has `alerts: []` and `actionStatusFresh: true`;
- the active construction project reports `autonomyEnabled: false` and the Builder
  page renders the Start pipeline control;
- the status cache stays fresh through repeated snapshots (no `action status cache is
  stale` alert after the 30s threshold);
- no `home storage failed`, `no bed in inventory or home storage` or terminal
  `failed task(s)` warning is emitted during the first 2.5 minutes; the preceding
  seven-minute run completed 19 consecutive home-storage deposits with 0 failures.

The only configuration warning is the expected `DASHBOARD_ALLOW_INSECURE=true`
notice. A 2.1s event-loop sample appears once, about 45s after start, on both runs;
it did not repeat in the following minutes and is a cold-start burst, not a
steady-state block.
