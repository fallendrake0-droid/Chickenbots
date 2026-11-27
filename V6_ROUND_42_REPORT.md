# Round 42 — safety, optional plan work, and base-site selection

**Branch:** `arena/de11bd2d-chickenbots`
**Commit:** `0169270` (`Harden safety watch, degrade optional plan work and replace stale base anchors`)
**Base:** `7764c41` (`main`)
**Build observed in the live simulator:** `6.0.0+29049ea` before this round; `6.0.0+0169270` after a restart

---

## A. Scope

This round followed the live simulator instead of the test suite. Three failures were
visible in the operator log and dashboard:

1. The safety watch could throw while its own watchdog stopped it.
2. A failed optional quota failed an entire survival-base objective, cancelled the
   siblings the plan still needed, and eventually paused automatic planning.
3. The base plan insisted on an anchor without leaves and then rejected perfectly
   usable tree sites, producing long walks and `BUILD_PHASE produced no verified result`.

The round also attacked the repeated player-watch churn (`movement request was
superseded`) and made the event-loop warnings identify the phase that actually blocked.

Out of scope: new gameplay, new commands, dashboard redesign, and changing the
mineflayer pathfinder implementation.

---

## B. What was actually wrong

### B1. Safety tick dereferenced a cleared player watch

The operator log contained:

```text
safety tick failed: Cannot read properties of null (reading 'toLowerCase')
```

`PlayerController.tick()` read `this.mode` and `this.target` *after* awaiting
`goNear()`. The safety watchdog could stop the watch during that await, so the
continuation saw `mode === null` and called `.toLowerCase()` on it. The same race could
move a bot toward a player the operator had already released.

### B2. Player watch consumed its own budget

A follow used `goNear(..., { timeoutMs: 9000 })` inside a safety pass whose budget is
6 s. The pass therefore timed out, the watchdog cancelled the movement, and the next lap
issued the same goal. That is the source of the repeated
`movement request was superseded` lines.

### B3. Optional quotas were objective-fatal

The wood, stone, iron and food quotas are supplies, not the deliverable. When one
failed, `TaskBoard` failed the whole objective, cancelled every remaining task, and the
planner re-opened the objective. After enough attempts it paused automatic planning. A
farm that found no soil could therefore stop base building entirely, even though the
builder had enough materials in inventory to finish the structure.

### B4. The base anchor search demanded a tree-free pocket

`buildBasePhase()` looked for a buildable pocket and then checked the surrounding
radius. The check treated every leaf/log block as an obstruction, so a forest site was
rejected even when the 3×3×4 build pocket itself was clear. The planner then searched
only a short radius and walked the fleet far away; the build phase could not produce a
verified result there, and the planner paused.

### B5. Warnings hid the real stage

Safety stage lines were emitted on every lap for every bot. The phase label was also
written *after* the work, so a block inside a controller was reported as the previous
phase. Both made the 19–39 s live stalls hard to attribute.

---

## C. Implementation

### C1. Snapshot-based player watch (`src/players/controller.js`)

`tick({ deadlineAt })` now snapshots `mode` and `target` at entry and uses those local
values for the whole pass. After every await it verifies that the watch is still the
same watch; otherwise it returns a clean `cancelled` result instead of touching null
state.

The pass also receives the runtime deadline:

* threat approach: at most 3 s, skipped when less than 0.5 s is left;
* follow movement: at most 4 s, and deferred when less than 0.75 s is left;
* every budget leaves a 250 ms bookkeeping margin;
* a failed follow sets a 1.5 s re-issue delay, so the watchdog cannot cause a
  cancel/re-issue loop.

No deadline (`deadlineAt = 0`) retains the previous unbounded behavior for tests and
direct controller use.

### C2. Deadline-aware survival (`src/actions/survival.js`)

`tick({ emergency, deadlineAt })`, `equipArmour({ deadlineAt })` and
`ensureTool({ deadlineAt })` accept the safety deadline. Eating, healing and
emergency responses stay unconditional; armour cycling and tool crafting stop when
the pass is nearly out of time. This prevents four sequential equip awaits plus a
craft from consuming the entire safety budget.

### C3. Optional task semantics (`src/team/taskBoard.js`)

Tasks now accept `optional: true`. The semantics are deliberately narrow:

* an optional task that fails records `task.failed.optional`, appends to
  `objective.degraded` (last 20) and sets `objective.optionalFailure`;
* siblings keep running; the objective is **not** failed;
* a dependency on a failed/cancelled optional task is considered **degraded**, not
  permanently blocked;
* the objective completes when every **required** task is verified;
* remaining optional tasks are then cancelled with
  `required objective work is complete`;
* progress counts only required tasks plus completed optional tasks, so a completed
  objective shows 100%, not a misleading partial bar.

Non-optional tasks retain the old hard-failure behavior.

### C4. Which plan steps are optional (`src/team/plans.js`)

The gathering and food quotas use the flag because they are *supplies*, not the
deliverable itself:

* four `CHOP_WOOD` quotas (oak logs);
* two `MINE_BLOCK` stone quotas;
* two `MINE_ORE` iron quotas;
* `FARM_CROP` (16 crops).

`FIND_SITE`, every `BUILD_PHASE`, `STORE_ITEMS` and `PLACE_BED` are **required**.
`STORE_ITEMS` and `PLACE_BED` were briefly optional during development, but that made
the plan self-contradictory: a base could “complete” without storage or a bed, which is
not a survival base. The final plan requires both.

The quotas are dependencies of the build phases. Marking them optional means a failed
quota degrades the dependency instead of cancelling the foundation/walls/roof; the build
phase may still succeed using materials already in the fleet's inventory, and if it
genuinely cannot, the required build failure still fails the objective. What is no
longer possible is a single unlucky wood or farm quota taking down the whole plan
before the builder has tried.

### C5. Base anchor selection (`src/actions/index.js`)

`buildBasePhase()` now:

* accepts a 3×3×4 pocket that is clear and has solid ground;
* allows already-built blocks inside the pocket;
* treats logs, every leaf variant, tall grass, ferns and flowers as workable, not as
  obstructions — they can be cleared or built around;
* revalidates a remembered/stale anchor instead of trusting it blindly;
* widens the site search from radius 8 through 24 in steps of 8;
* reports `…within 24 blocks of home` when it truly cannot find a site.

A cluttered/stale-anchor regression test was added to `tests/autonomy.test.js`.

### C6. Dashboard and coordinator exposure

`objectiveBoard()` in `src/team/teamCoordinator.js` now includes `optionalFailure`,
`degraded` and per-task `optional`. The objective card in
`src/dashboard/public/js/pages/shared.js` renders a small callout for a degraded
optional quota instead of showing a failed objective.

### C7. Log hygiene and phase attribution (`src/runtime.js`)

* `_lastPhase` is written **before** each stage (`state-sync`, `coordinator`,
  `launch-actions`, `safety`, `bot-safety`).
* safety stage warnings are rate-limited to once per 10 s per bot when the budget is
  exceeded, and once per 30 s at debug level for ordinary slow stages;
* the warning text now states the budget and the overrun.

### C8. Operator docs (`README.md`)

The quick-start now documents how to stop a live runtime cleanly, including the fact
that `pkill index.js` matches the process name and that a stale child can keep the
dashboard port. It recommends `pkill -f 'node src/index.js'` and checking the port.

---

## D. Behavior after this round

A five-bot simulated runtime was restarted on the new build and observed through two
complete objective cycles.

* The safety null exception did not recur: `/api/logs` reported **0** matches for
  `toLowerCase` and **0** for `safety tick failed`.
* No planner pause and no `BUILD_PHASE produced no verified result` appeared.
* The survival-base objective completed:

```text
obj-survival_base-1  COMPLETED  412/412 phases
  COMPLETED: 14
  CANCELLED:  2   MINE_ORE — "required objective work is complete" (optional quotas)
  FAILED:     0
```

The completed work included `FIND_SITE`, four `CHOP_WOOD`, `MINE_BLOCK`, `FARM_CROP`,
`STORE_ITEMS`, `PLACE_BED` and all foundation/wall/roof/perimeter build phases. The two
cancelled rows are the optional iron quotas, cancelled *after* the required work was
verified — the intended new behavior.

* The planner reported `failures: 0`, `attempts: 2`, `blockedUntil: null`, and opened
  `obj-survival_base-2` at 17:22:08 rather than pausing.
* `obj-survival_base-2` progressed normally through wood and stone collection.

---

## E. Verification

All commands were run from the repository root on the final tree.

| Check | Result |
| --- | --- |
| `npm test` | **527 / 527 passed** (≈152 s) |
| `npm run validate` | **VALIDATION PASSED** — consistency 10/10, 25 source files, 139 files clean of placeholders, 10 000 designs, lint, secret leak, schematics |
| `npm run commands:audit` | **48 / 49**, 0 failures, 1 skip (`stop`, requires a live running command) |
| `npm run test:routing` | **3 / 3** |
| `npm run deploy:check -- --url http://127.0.0.1:4179` | **17 / 17** — 5 bots, 2 projects, 49 command families |
| `/tmp/render-real.mjs` | **52 / 52** |
| `/tmp/render-empty.mjs` | **41 / 41** |
| `/tmp/mining-harness.mjs` | OK |
| New `tests/optional-tasks.test.js` | **4 / 4** |
| `tests/autonomy.test.js` | **5 / 5** including the cluttered/stale-anchor case |

Lint retains the five known pre-existing warnings (`realBot.js` ×2,
`standability.js` ×3); none were introduced by this round.

---

## F. Remaining issues and risks

1. **Live event-loop blocks are attributed, not eliminated.** The simulator still
   records 19–39 s blocks under heavy action load. The phase labels now point at the
   actual stage instead of the previous tick. The strongest remaining simulator lead is
   `mockBot.goTo()`: with a range it A*-plans up to 12 standable candidates and each
   alternate stance at the full 12 000-node budget, plus up to 32 segments — all inside
   one synchronous move. `farming._preparePlot()` is the second candidate. This is
   simulator-only work and does not change the live mineflayer pathfinder.

2. **`ARRIVAL_UNVERIFIED` for home storage.** `home storage failed: pathfinder
   reported success but the bot is not within 3 blocks of the destination`
   (`manager.js:294`) appeared twice in the run and then cleared. It is a transient
   verification failure, not a stuck bot. Candidate fix: re-path from the current
   position with the relaxed arrival radius already negotiated by the manager.

3. **Long CHOP_WOOD runs (10–32 s).** The fleet still rotates between wood and stone
   because of `runtime.js` idle rotation and per-move planning cost. It did not block
   completion this round.

4. **`builder create` lifecycle.** `builder create` followed by
   `build pause|resume|stop <builderId>` can still answer “no active build”. Not
   touched in this round.

5. **Mining result card.** `[data-mining-result]` still omits the executed line. Not
   touched in this round.

6. **Metadata gaps** remain: `target protect|unprotect` arguments, `players
   target|arena|rule` usage, `batch then|next`, schematic name quoting, `ai on`
   documentation, and `home build [tier]` not enum-restricted.

7. **No real browser validation.** The environment has happy-dom and HTTP checks only;
   dashboard rendering was verified by the render harness, not by a browser engine.

8. **Simulator load.** Reading `/api/state` took 48 s at the end of the run while five
   bots were pathfinding. The HTTP handler itself is cheap; the delay is event-loop
   starvation from the synchronous simulator work in item 1.

---

## G. Files changed

| File | Change |
| --- | --- |
| `src/players/controller.js` | watch snapshot, cancellation guard, deadline budgets, re-issue delay |
| `src/actions/survival.js` | deadline-aware tick / equipArmour / ensureTool |
| `src/actions/index.js` | `{ deadlineAt }` propagation; rewritten `buildBasePhase()` site search |
| `src/team/taskBoard.js` | optional task semantics, degraded dependencies, completion/progress rules |
| `src/team/plans.js` | optional only on `FARM_CROP` + mining quotas; storage and bed required |
| `src/team/teamCoordinator.js` | `optionalFailure` / `degraded` / `optional` in `objectiveBoard()` |
| `src/dashboard/public/js/pages/shared.js` | optional-failure callout |
| `src/runtime.js` | phase labels, rate-limited safety stage logging, deadline propagation |
| `README.md` | clean shutdown of a live runtime |
| `tests/optional-tasks.test.js` | new — optional degradation, required completion, progress |
| `tests/autonomy.test.js` | cluttered/stale-anchor base-site case |
| `tests/players.test.js` | null-mode cancellation and deadline deferral |
| `tests/recovery.test.js` | survival defers when player watch consumes the safety budget |

---

## H. Reproduction

```bash
# Full gate
npm test
npm run validate
npm run commands:audit
npm run test:routing

# Live simulator (bind 0.0.0.0 for the preview host)
node src/index.js --simulate --bots 5 --port 4179

# In another shell
npm run deploy:check -- --url http://127.0.0.1:4179
curl -s http://127.0.0.1:4179/api/state | jq '.state.team.state.team.objectives'
```

Expected after a base objective finishes:

* `status: "COMPLETED"`;
* every required row `COMPLETED`;
* optional rows `CANCELLED` with “required objective work is complete”;
* `planning.failures: 0` and `blockedUntil: null`;
* no `BUILD_PHASE produced no verified result` and no planner pause.

Clean shutdown:

```bash
pkill -f 'node src/index.js'
ss -ltnp | grep 4179   # if a stale child remains, kill -9 its pid
```

---

## I. Rollout and rollback

The change is backward compatible: without a deadline, the player and survival
controllers behave as before, and tasks without `optional` retain hard-failure
semantics.

Rollback is the single commit `0169270`:

```bash
git revert 0169270
```

The plan-level behavior change is intentionally limited to the survival-base plan. Any
future plan can opt in per task by setting `optional: true`; no existing plan does so
silently.
