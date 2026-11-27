# Round 43 — planning budgets, build verification and a real player-follow watch

**Branch:** `arena/de11bd2d-chickenbots`
**Base:** `7764c41` (`main`)
**Preceding shipped round:** `c94755e` (round 42 report)
**Build observed in the live simulator:** `6.0.0+c94755e` before this round; the new backend hash after restart

---

## A. Scope

This round started from four live-simulator symptoms and one follow-command gap:

1. A single fleet movement could block the event loop for tens of seconds while A*
   expanded several stance trials and up to 32 segments.
2. Every build task failed with five air blocks missing. The log said only
   `BUILD_PHASE produced no verified result`; the actual error was hidden per block.
3. A verified arrival could still be rejected as `ARRIVAL_UNVERIFIED` after one attempt,
   which made home-storage trips look like pathfinder failures.
4. The round-42 bed decision (`held` was a hard claim gate) deadlocked the base: every
   bot deposited its starter beds into the shared chest, then no bot could claim
   `PLACE_BED`, leaving the objective PENDING forever.
5. `follow <player>` still routed a raw username into `CombatController`. It chased a
   visible entity, backed off after a failure, and had no Players-page state. A player
   walking just past render distance froze the watch, and `follow stop` did not clear a
   `PlayerController` watch.

Out of scope: new gameplay loops, dashboard redesign, and changing the mineflayer
pathfinder itself.

---

## B. What was actually wrong

### B1. Planner work was unbounded per move

`MockBot._walkNavigationPath()` could run twelve stance trials and then 32 route
segments. Each call received the full `maxNodes` budget and its own deadline. With five
bots sharing one Node event loop, those synchronous calls added up to the 99 s
`phase safety` block seen in round 42. The same cells were also re-read from the world
for every trial and segment.

### B2. A temporal-dead-zone error broke every build placement

`withBlockCache()` was called late in `_walkNavigationPath()`, but the new footing tests
near the top of the method used `standableAt(scan, …)` and
`standableCandidates(scan, …)`. `const scan` had not been initialised yet:

```text
Cannot access 'scan' before initialization
```

The builder caught that per block, counted five missing blocks, and reported one FAILED
task plus sixteen CANCELLED dependants. The fleet was not pathfinding badly; it was
throwing before planning started.

### B3. `ARRIVAL_UNVERIFIED` had no retry

`NavigationManager.navigate()` verified the final position. A pathfinder that reported
success one or two blocks short produced `ARRIVAL_UNVERIFIED`, and a caller with
`maxAttempts: 1` abandoned the move immediately. Home storage was the visible victim.

### B4. `requires.held` deadlocked `PLACE_BED`

The round-42 fix correctly stopped an empty-handed bot from taking the task, but it made
the task unclaimable once the overflow pass deposited the starter beds. The live board
showed:

```text
PENDING  PLACE_BED  0/5  claimedBy: null  attempts: 0/3
```

Every bot had zero beds in inventory and the beds were in the home chest. The plan had
no withdrawal step, so the objective could never complete.

### B5. Follow had no motion data and no player-watch routing

`BotAdapter.entitiesNear()` and `RealBot.entitiesNear()` copied position, health and
equipment but dropped `velocity`. `PlayerController._interceptPoint()` therefore always
saw a stationary target. Its positional fallback was also overwritten before use: the
tick wrote the new sighting into `lastTargetPosition` and then asked for a delta against
that same value. Finally, `follow <player>` never reached `PlayerController` at all.

---

## C. Implementation

### C1. Planner cost controls (`src/navigation/planner.js`, `src/bot/mockBot.js`, `src/config.js`)

- Added `withBlockCache(reader)`: a per-move read-through `Map` that injects
  `getBlock()` and `blockAt()` over the caller's reader. It is deliberately **per move**;
  a global cache would hide a block dug earlier in the same job.
- `planRoute()` accepts a wall-clock `deadline`. It returns
  `{ ok: false, reason: 'time-budget', timedOut: true }` when the budget is spent rather
  than continuing the expansion.
- Added `heuristicWeight` (default `1.2`, clamped to `1…2`) to trade a small amount of
  route optimality for fewer expansions.
- `MockBot._walkNavigationPath()` now shares one `scan` across footing checks, stance
  selection, every trial and every segment. Trials use
  `trialNodes = max(1500, floor(maxNodes / min(4, stances)))`, and decisions stop at the
  first `time-budget` failure.
- Long routes yield every 64 committed steps so dashboard state and safety timers can
  run.
- All mock bots share a 100 ms planning window: once one movement has planned for its
  budget slice, other bots wait for the next event-loop turn instead of stacking
  synchronous searches.
- `config.navigation.planBudgetMs` is validated at `50…60000` ms and defaults to 350.

### C2. Build fix (`src/bot/mockBot.js`)

`const scan = withBlockCache(this)` now initialises immediately after
`this._settleToSupport()`, before any footing branch. The duplicate later declaration was
removed. The isolated build reproduced `{ COMPLETED: 0, FAILED: 1, CANCELLED: 16 }`
before the fix and seventeen executed rows with `missingCount: 0` afterwards.

### C3. Arrival retry (`src/navigation/manager.js`)

`navigate()` keeps its response shape, but an `ARRIVAL_UNVERIFIED` result gets at least a
second attempt from the bot's actual position. Other failures keep their configured
budget. The existing six navigation tests remain green.

### C4. Bed acquisition (`src/team/plans.js`, `src/actions/index.js`, `src/actions/inventory.js`)

- `PLACE_BED` now requires the bed item (`items: { 'category:bed': 1 }`) instead of a
  hard `held` gate. A carrier still scores higher, but a bot can claim the task when the
  bed is in shared storage.
- Added `InventoryManager.ensureBedFromStorage()`. It opens the nearest verified
  container, selects a real bed name from its contents, withdraws exactly one, verifies
  `hasBed()` in the bot's own inventory, and updates the ledger with the remaining
  contents.
- `PLACE_BED` calls that acquisition when the bot is empty-handed, then places and
  verifies as before. If no bed exists anywhere, it fails honestly instead of waiting
  forever.

### C5. Player follow (`src/players/controller.js`, `src/commands/index.js`, dashboards)

- Both entity adapters now expose a copied `velocity` vector. `_interceptPoint()` uses
  it in blocks/tick or blocks/second form, falls back to the previous sighting only when
  no usable velocity exists, and caps the lead at four blocks.
- A visible far target uses catch-up: gap `> distance + 6` means a 500 ms cadence and a
  3200 ms move budget; otherwise 800 ms and 2400 ms. A safety budget below 600 ms
  defers instead of launching work the watchdog will cancel.
- A fresh last-known position is pursued when the entity disappears for a tick. A stale
  position still waits; an offline target still auto-stops after 60 s.
- `follow <player>` now starts a persistent `PlayerController` watch on every bot;
  `follow <bot>` keeps the formation/combat follow. `follow stop` clears both layers.
  `PlayerController.follow()` accepts the command's documented 2–16 range (the
  `players follow` UI still exposes 1–8).
- `status()` exposes `lastMoveAt`, `lastMoveResult`, `followLeadMs`, `followCatchUp`,
  `targetVelocityAgeMs` and `lastSeenPursuit`.
- The Combat page now previews the exact `follow` line through a shared
  `followArguments()` / `followPreview()` builder; the Players page uses one
  `playerWatchCommand()` builder for follow, unfollow, guard, escort and observe. The
  watch table adds intercept lead, velocity age, catch-up and last-move result.

---

## D. Post-round behaviour observed in the live simulator

After restarting the dashboard on this branch:

- The survival-base objective completed with **`PLACE_BED 5/5`**, using beds withdrawn
  from the shared home chest. A following objective also completed `PLACE_BED 1/1`.
- `task list` showed `COMPLETED 28 / CANCELLED 4` on the first board and no locked,
  deadlocked or active tasks afterwards.
- A later optional wood quota failed with
  `no verified progress in 45s; released for re-planning`. The objective stayed
  `COMPLETED` with `optionalFailure`, which is the intended degradation.
- No planner or `scan` exception appeared in the operator log.
- `/api/state` served five bots and the new `playerWatch` diagnostics; the real render
  harness passed 52/52.
- The dashboard is running on the new backend at port 4179 for the operator preview.

Residual live warnings are listed in section F; they are not regressions from this round.

---

## E. Verification

| Gate | Result |
| --- | --- |
| `npm test` | **534 / 534 pass**, 0 fail |
| `npm run validate` | **PASS** (secret, lint, tests, schematics, consistency 10/10) |
| `npm run commands:audit` | **48/49** exercised or help-audited, 0 failures (`stop` intentionally skipped) |
| `npm run test:routing` | **3 / 3** |
| `npm run deploy:check` | **13 / 13** |
| `node /tmp/render-real.mjs` | **52 / 52 rendered**, `REAL RENDER OK` |
| `node /tmp/render-empty.mjs` | **41 / 41** pages render before first snapshot |
| `node /tmp/render-partial.mjs` | 43/44; the only failure is the harness's deliberate `#/not-a-page` |
| `tests/navigation-path.test.js` + `tests/controllers.test.js` | **14 / 14** |
| `tests/players.test.js` | **14 / 14** |
| `tests/optional-tasks.test.js` + `tests/inventory-storage.test.js` | **6 / 6** |
| Isolated build repro (`/tmp/build-debug2.mjs`) | 17 executed rows, `placed: 5` then `39`, `missingCount: 0` |
| Live simulation | 5/5 bots ready; base objective completed; `PLACE_BED 5/5` |

The render harnesses use a refreshed copy of `src/dashboard/public` in `/tmp/frontend`
and a live `/api/state` snapshot. The partial/smoke harnesses intentionally include an
unknown route; their exit code reflects that single expected failure.

---

## F. Remaining issues (not introduced here)

- The event-loop watchdog still reports intermittent blocks of roughly 1.2–2.2 s at
  `phase safety` and `phase idle`. Planning is bounded now; the remaining time is in
  status/chunk scanning, not A*.
- `home storage failed: no path …` and
  `pathfinder reported success but the bot is not within 3 blocks of destination`
  still occur on long return trips. The new arrival retry reduces the second class but
  does not make an unreachable chest reachable.
- The survival-base objective is replanned immediately after completion. In a four-minute
  live run the board accumulated three objectives, two of them completed. This is the
  existing “base objective re-fires” issue, not a bed regression.
- `ConstructionManager` still reports `project-001-0001_beginner_shelter` at
  `PLANNING / ANALYSIS` while the separate `BUILD_PHASE` objective work completes. That
  is a construction-pipeline issue outside this round.
- A failed optional quota produces a dashboard alert (`1 failed task(s)`) even though
  the objective is completed. The alert is factually correct but visually louder than
  the degradation.
- Pre-existing lint warnings outside this round remain unchanged.

---

## G. Files changed

**Backend**

- `src/navigation/planner.js` — block cache, deadline, heuristic weight
- `src/navigation/manager.js` — `ARRIVAL_UNVERIFIED` retry
- `src/bot/mockBot.js` — shared scan, bounded trials, plan window, TDZ fix, yields
- `src/bot/adapter.js`, `src/bot/realBot.js` — expose entity velocity
- `src/config.js` — `navigation.planBudgetMs`
- `src/runtime.js` — safety stage diagnostics and idle phase
- `src/players/controller.js` — intercept, catch-up, last-known pursuit, move results
- `src/actions/inventory.js` — `ensureBedFromStorage()`
- `src/actions/index.js` — `PLACE_BED` acquisition
- `src/team/plans.js` — bed requirement no longer deadlocks after storage
- `src/team/allocation.js` — explicit `held` gate retained for future task types
- `src/commands/index.js`, `src/commands/metadata.js` — player-watch routing, metadata

**Dashboard**

- `src/dashboard/public/js/commands.js` — shared follow/watch builders
- `src/dashboard/public/js/pages/combat.js` — live follow preview and player-watch text
- `src/dashboard/public/js/pages/players.js` — intercept / catch-up / last-move columns

**Tests and docs**

- `tests/navigation-path.test.js`, `tests/controllers.test.js`
- `tests/players.test.js`, `tests/optional-tasks.test.js`
- `tests/inventory-storage.test.js` (new)
- `README.md`, this report

---

## H. Reproduction

```bash
# full gate
npm test
npm run validate
npm run commands:audit
npm run test:routing
npm run deploy:check

# focused regression groups
node --test tests/navigation-path.test.js tests/controllers.test.js
node --test tests/players.test.js
node --test tests/optional-tasks.test.js tests/inventory-storage.test.js

# live simulator / preview
node src/index.js --simulate --host 0.0.0.0 --allow-insecure --port 4179
curl -s http://127.0.0.1:4179/api/state | head -c 2000
```

For the build repro, `/tmp/build-debug2.mjs` imports
`/home/user/Chickenbots/src/runtime.js`, fills every bot with the schematic materials
and runs `build 0010_beginner_mine_entrance 80 72 80 confirm run`; the important rows
are the first two `BUILD_PHASE` tasks reporting `ok: true`, `placed: 5` / `39` and
`missingCount: 0`.

---

## I. Rollout and rollback

**Rollout**

1. Restart any live or simulated runtime; `planBudgetMs` defaults to 350 ms and needs no
   environment variable.
2. A dashboard refresh picks up the shared follow preview and the new watch columns.
3. Restarting clears in-memory `PlayerController` watches. Existing follow commands must
   be re-issued; that was already true before this round.

**Rollback**

- The planner budget and cache are additive: set `NAV_PLAN_BUDGET_MS` to a larger value
  or revert `src/navigation/planner.js` and `src/bot/mockBot.js` together. Do not revert
  only the cache: `_walkNavigationPath()` now relies on the shared `scan`.
- The `ARRIVAL_UNVERIFIED` retry can be removed from `src/navigation/manager.js`
  without touching the planner.
- The bed fix is split between the plan requirement and the action acquisition. Reverting
  only `plans.js` without restoring a withdrawal path reintroduces the
  `no bed available` failure mode.
- `follow <player>` can be returned to the old combat path by restoring the player branch
  in `src/commands/index.js`; the new controller diagnostics remain harmless.
