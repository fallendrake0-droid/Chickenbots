# V6 Round 48 — pathfinding for every bot and every task

## Problem

Every autonomous action already called `bot.goTo()`, but the movement layer was
lying in several places:

* `config.autonomy.pathfinderSearchRadius` was validated and documented but
  never assigned to `mineflayer-pathfinder`; the live pathfinder kept its own
  `-1`/fixed detour budget. Long walks around a base or ravine gave up while
  short, blocked walks burned the whole search budget.
* The stuck detector measured displacement from the oldest sample in a 32-sample
  ring. One 0.5-block step kept a frozen bot "healthy" for almost five seconds,
  and sampling began during A* thinking (grace 750 ms vs `thinkTimeout` 5000 ms),
  so a perfectly good long route could be declared stuck before it moved.
* `goal_reached` was accepted as success even when the entity settled several
  blocks short. A one-attempt task then abandoned the move instead of retrying.
* Recovery's offset search was centred on a hard-coded `target + (2, 2)` rather
  than the target, so a blocked side exhausted recovery beside a valid stance.
* `MockBot.goTo()` teleported onto air work targets and tree trunks for
  `range >= 2`. Tasks "succeeded" without walking, and the simulator could not
  reproduce a blocked doorway or an unreachable canopy.
* The mock planner's `maxDetour` floor of 24 let a blocked three-block move
  expand thousands of irrelevant nodes until the 350 ms wall clock expired,
  reporting `time-budget` and blocking the event loop for every other bot.
* `configureMovements()` read only global config in the hazard weight: a
  per-call `allowWater:false` was ignored, and `maxDrop:0` was replaced by 3.
* `MockBot._walkNavigationPath()` could accept the bot's current cell as an
  alternate stance after an exact (`range: 0`) plan failed, reporting success
  for a move that never happened. The manager's new arrival check exposed it.
* Tasks defaulted to one attempt, so no task ever entered the recovery ladder.
* The dashboard had no navigation page and simulator bot rows could still say
  "No navigation state reported".

## Change

### One policy, one manager

- New `src/navigation/policy.js` exports `navigationPolicy()` and
  `adaptiveSearchRadius()`. `policy` is serialized in `/api/state` under
  `navigation.policy` and is the same object the Navigation page renders.
- `_executeNavigationPath()` sets `pathfinder.searchRadius` per request:
  `max(64, min(512, ceil(distance × 1.5 + 16)))`.
- `configureMovements()` now honours per-call `allowWater` and `maxDrop`,
  including a real zero drop limit.

### Honest progress, arrival and recovery

- `StuckDetector` keeps a sliding time window (`NAV_STUCK_WINDOW_MS`, 2.5 s) and
  discards older samples. A frozen bot is flagged ~2.5 s after its last real
  movement.
- Live progress sampling arms only after a non-empty `path_update`; A* thinking
  is no longer "stuck". The listener is removed in `finally`.
- On `goal_reached`, the adapter waits 300 ms for the server correction and
  returns `arrived` / `shortBy` / `searchRadius`. A success more than
  `range + 3` blocks short becomes `ARRIVAL_UNVERIFIED` and gets one retry even
  when the caller did not ask for strict verification.
- Recovery searches standable stances around the real target, then the start,
  then aborts. Operator moves get three attempts, tasks get two
  (`NAV_TASK_ATTEMPTS=2`).
- `bot <name> stop` is a first-class command (and a Navigation page action).

### No teleports in normal movement

- A mock work target (tree trunk, air coordinate, planting cell) is resolved to
  a real standable stance and the bot walks there. Exact (`range: 0`) requests
  never accept a nearby stance as success.
- The canopy/high-ledge shortcut that snapped the bot onto a lower block was
  removed; the normal candidate-stance search plans a route.
- Planner detour is now `max(16, straight × 2 + 8)`, not a 24-block floor, so a
  blocked local target fails quickly instead of consuming the planning budget.
- Wood-site relocation aims 40 blocks out (with a 3-block arrival tolerance)
  so it actually leaves the stripped radius.

### Dashboard

- New **Fleet → Navigation** page: live totals, per-bot movement/target/attempts/
  success/stuck/no-path/last failure, route preview through the real `path`
  command, "Walk this route", Home/Stop actions, movement policy, stance claims
  and recent movement events.
- `/api/state` gains `navigation.policy`, `navigation.fleet` and
  `navigation.totals`. Per-bot rows fall back to `navigationStatus()` when the
  summary omits navigation, fixing simulator "No navigation state reported".
- Bot cards show an active movement owner/target; bot Navigation tab shows the
  target, attempts, arrival failures and a Stop button.
- `SHELL_ROUTES`, the validation page list and the routing test were updated
  together (36/36 navigation routes).

## Verification

| Gate | Result |
|---|---|
| `npm test` | **553/553 pass** (was 545; +8 navigation upgrade tests) |
| `npm run lint` | **207 files, 0 errors, 5 pre-existing warnings** |
| `npm run validate` | **PASS**, consistency 10/10, 36/36 pages, 142 files clean |
| `npm run commands:audit` | **48/49, 0 failures** (`stop` is help-audited) |
| `npm run perf:status` | cold snapshot 68 ms; pass |
| Headless Chromium | `#/navigation` renders, 0 page/console errors |

### Simulation evidence

Five bots, `node src/index.js --simulate --host 0.0.0.0 --allow-insecure --port 4179`,
planner enabled with `team plan on`, headless Chromium against the same process:

* Route preview: **28 steps, 504 nodes expanded, 210 ms**, `reachable`, no bot
  movement; "Walk this route" moved the selected bot and recorded one arrival.
* After about 90 s of autonomous chopping/mining: **685 attempts, 620 arrivals,
  63 failures, 90.5% success, 0 stuck, 0 arrival-unverified, p95 678 ms**.
* Before the exact-stance and detour fixes the same runtime reported
  **16 arrival-unverified failures in 12 s**, p95 **1111–1462 ms**, and repeated
  `time-budget` errors on three-block moves. After the fixes: **0
  arrival-unverified**, p95 **678–843 ms**, and fast `no-path` results replaced
  repeated `time-budget` failures (one older `time-budget` remained in a bot's
  last-error field during the longer run).
* The remaining failures are honest `no-path` results for exact stances inside
  a trunk/canopy or an embedded bot; the task relocates or reports partial work
  instead of teleporting or claiming success.

**Live-server result: UNVERIFIED.** No Minecraft server was reachable in this
sandbox. The adaptive radius and arrival settle are exercised by unit tests and
the simulator; they still need a live five-bot run.

## Still open

- A live `goto` and long task route on the real Aternos server (plugin movement,
  server corrections, doors, latency).
- Mock builders deliberately stand in the air beside an elevated schematic;
  that unsupported-builder fallback still uses a mock-only stance correction
  before planning. Normal task movement no longer teleports.
- Task-level scaffolding for genuinely unreachable high trunks/ledges is a task
  decision (`allowScaffold` is still false by default), not a hidden movement
  trick.
- Deep vertical mine shafts are not traversable back to the surface. The
  movement layer now reports that honestly (`no-path`) instead of teleporting,
  but the mining controller still sinks a straight 1x1 shaft. Sinking a
  stair/ladder shaft (or crafting an escape route) is a mining-task change, not
  a pathfinding change, and remains open. A bot that ends a run at y≈-56
  therefore cannot complete a home-storage trip.
