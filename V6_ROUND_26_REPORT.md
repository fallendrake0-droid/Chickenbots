# Chickenbots V6 — round 26 report (Sections A–M)

**Branch:** `arena/de11bd2d-chickenbots`
**Round-26 commits:** `d9dc9a8`, `65405ee`, `8b06acd` (pushed), plus this report commit
**Scope:** movement authority and wire validity, emergency spawn survival, recovery
pre-emption, safety-pass performance, feasible base planning, then the phase 6–17
audit items from the master directive.

> **Evidence boundary:** this sandbox cannot reach `EmpiSMP.aternos.me:32990`.
> Nothing in this report claims a live-server run. Live connection, anti-cheat and
> 30-minute idle acceptance remain unverified and are listed in Section M.

## A. Repository and baseline

| Item | Value |
|---|---|
| Repository | `fallendrake0-droid/Chickenbots` |
| Branch | `arena/de11bd2d-chickenbots` |
| Base commit | `7764c410934a71bc22d69bb1ef1fad5647e0e640` (`main`) |
| Round-25 head | `a71daa2` |
| Round-26 head | this report commit (after `8b06acd`) |
| Runtime | Node `>=18.17`, CommonJS |
| Server target | `EmpiSMP.aternos.me:32990` |
| Server version observed by earlier live run | `26.1`, protocol `775` |

The round-25 baseline gates were 293 tests, lint over 148 files, and a passing
`validate`. Round 26 adds 16 tests and fixes defects found while exercising the
fleet in deterministic simulation.

## B. Root-cause bug register

Severity is the user-visible impact under the reported live symptoms.

| ID | Sev | Symptom / repro | Root cause | Fix | Test |
|---|---|---|---|---|---|
| BUG-26-01 | P0 | Paper kicks with `invalid_player_movement`; two position packets can precede one `tick_end` | A position deferred during the current tick was flushed at the start of that same tick, before its `tick_end` | `ClientTickScheduler` records `_pendingTick`; only a packet deferred on an earlier tick may open the next tick, then exactly one `tick_end` | `tests/connection-lifecycle.test.js` deferred-position tests |
| BUG-26-02 | P0 | `NaNm away` and malformed movement on the wire | No finite/range validation before the client write, and the last server anchor could be overwritten with `undefined` | `_movementPayloadValid` rejects non-finite/out-of-world coordinates and angles; malformed packets are dropped, counted and re-anchored | malformed-payload test; `summary().movement.invalidDrops` |
| BUG-26-03 | P0 | Recovery retreat replaced by a task path, or vice versa; “Path was stopped” noise | Every `goTo` caller competed freely; no owner/priority and no caught rejection path | `goTo` now has one owner and a priority ladder (`routine < task < recovery < operator < emergency`); lower priority is rejected, higher priority cancels cleanly, rejections are returned | priority-preemption, emergency-preemption and stopped-path tests |
| BUG-26-04 | P0 | Server teleport/correction produces a wrong local anchor, then a huge movement correction | The raw position packet contains deltas when relative flags are set; yaw was stored in Notchian degrees but written into a radians field | `_captureServerPosition` reads the post-physics entity, stores metres/radians, and refuses an anchor without finite coordinates | new relative-teleport anchor test |
| BUG-26-05 | P0 | Safety passes took 10.0–22.5 s and blocked the runtime tick | Ten per-bot `safetyTick()` calls were awaited inside `_tick` | Safety work is launched non-blocking with one in-flight pass per bot and a released slot | `tests/runtime-safety.test.js` (tick <150 ms with a 250 ms safety pass) |
| BUG-26-06 | P0 | A first join into a zombie pack stood still; `unsafe spawn` appeared only after damage | Spawn safety was assessed only on a respawn, not on first join | `recordSpawn` on first join and respawn; guard from `config.survival.spawnGuardMs` (default 8000 ms, `SPAWN_GUARD_MS`) | recovery tests for first-spawn zombie pack and unsafe spawn |
| BUG-26-07 | P0 | `recovery retreat failed: Path was stopped before it could be completed!`; bot stayed in danger | One retreat vector, and a stopped path was treated as an attempt rather than checked for displacement | Three escape vectors at ±60°, range 2, 2200 ms; success requires real displacement and opened threat distance; armed last stand otherwise | first-spawn zombie-pack retreat test (position actually changes) |
| BUG-26-08 | P1 | One bot sat in `RECOVERING` for the whole run after a healthy spawn | A non-air head block was called “suffocation risk”, and that stale assessment was never re-evaluated | Passable foliage is excluded; hazards are re-assessed after the guard; a solid-block spawn gets a real escape target; non-death-loop recovery uses the short hold | recovery tests for re-assessment, short hold and escape target |
| BUG-26-09 | P1 | One `PLACE_BED` owned an autonomy slot for 1,802 s; event-loop block 1,988 ms | `ensureBed` tried 120 ring positions, each with its own path request, and ignored the watchdog | Six nearest valid candidates, hard 8 s budget, 2.5 s path budgets; watchdog now also stops mining/woodcutting/farming loops; dig/place calls have timeouts | existing bed tests; simulation run below |
| BUG-26-10 | P0 | `automatic plan failed` every 60–120 s; the base plan restarted forever at 433/449 | The plan required ten beds although one executing bot could own at most five; the impossible task exhausted three attempts and failed the objective | Bed quota is capped at the largest real single-bot bed stock; zero stock omits the bed task and the bed requirement | new plan-feasibility test; simulation objective completed |
| BUG-26-11 | P1 | Creepers were met in melee when the bot held a sword | Threat response decided purely on `outmatched` and distance | Creepers (and `profile.avoid` entities such as the Warden) force an escape regardless of weapon | creeper-at-melee-range test |
| BUG-26-12 | P1 | A hung mineflayer `dig`/`placeBlock` could hold a slot indefinitely | Only pathfinding had a timeout | `_withTimeout` bounds dig and placement; the action watchdog also stops controller loops | action-stop test; runtime watchdog coverage |

No fabricated fix was used. In particular: the server protocol was not changed,
physics was not disabled, `/register` and `/login` remain impossible to enable
through configuration, and no movement retry/backoff was added for
`invalid_player_movement` (the malformed/ordered packet is prevented instead).

## C. Movement: one authoritative owner

`RealBot.goTo(pos, { range, timeoutMs, priority, owner })` is the only arbiter.

```text
routine 0 < task 1 < recovery 2 < operator 3 < emergency 4
```

- A lower-priority request returns
  `{ ok:false, superseded:true, owner, priority }` before loading the pathfinder.
- A higher-priority request cancels the old owner, stops the old path and lets the
  old caller return `superseded` instead of reporting success.
- A generation/token mismatch after the await cannot clear or overwrite the new
  owner.
- Owners used by the action layer: `recovery`, `recovery-home`,
  `recovery-spawn-escape`, `combat-retreat`, `survival-clutch`,
  `operator-goto`, `operator-come`, `operator-return`.
- `disconnect()`, server teleport, client-tick stall, action timeout and a task
  pre-emption all cancel motion.
- Teleport corrections are authoritative across a session because the anchor is
  captured through the owning client's packet handler and the reconnect
  generation rejects old callbacks.
- The fleet card shows `Movement owner: <owner> · priority <n> · <n> malformed dropped`
  from `summary().movement`.

Wire validity is enforced before the client write guard:

- `position` / `position_look`: finite `x/y/z`, world bounds, finite `yaw/pitch`
  for the look variants.
- `flying` and plain `look` remain accepted where the protocol permits them.
- A rejected packet increments `invalidDrops`, re-anchors the entity to the last
  server position and logs at most once per 10 s.

## D. Survival and recovery

- First join and respawn both produce a spawn assessment. Hostiles within 16
  blocks during `spawnGuardMs` trigger the emergency response immediately.
- A threat response is non-blocking relative to task work: while the bot is in
  `RECOVERING`, `step()` refuses new work.
- An emergency retreat uses three vectors opposite the threat (±60°), verifies
  actual displacement ≥1.5 blocks and threat distance opened >1 block. A path
  that stopped is not success.
- Creepers and avoided bosses are never meleed. A single distant hostile outside
  the guard does not abandon work; a group, low health or a melee threat does.
- Death evidence keeps position, cause, health/food, last attacker, task,
  navigation state and equipment; unknown distance renders `at unknown distance`,
  never `NaN`.
- A spawn inside a solid block gets a bounded escape to a real standing position.
  Passable foliage is no longer misreported as suffocation.
- Recovery holds are death-loop-aware: a real loop uses the 90 s hold plus
  `SAFE_HOLD`; a bad-spawn false positive uses the 30 s suspect hold and returns
  to `ACTIVE` without a second 60 s hold.

## E. Connection stability

Round 25 already supplied the lifecycle state machine, asynchronous inflate,
view-distance clamp, per-generation write guard, keep-alive/stale windows and
reconnect supervisor. Round 26 changes only the parts that caused movement
kicks or false “online” states:

- Deferred positions obey `tick_end` ordering.
- Server teleports cancel the active path and hold movement for 400 ms.
- A client-tick stall cancels motion, re-anchors to the authoritative server
  position and holds movement for `CLIENT_STALL_RESUME_MS`.
- A dead transport is offline immediately; a stale `bot.connected` boolean cannot
  suppress reconnect.
- `disconnect()` cancels motion and is generation-scoped.
- Malformed movement is dropped instead of sent.

Connection evidence is unit-level only: 37 lifecycle tests, 17 connection tests
and 14 runtime-safety tests pass. The live 30-minute connection acceptance is
still open (Section M).

## F. Performance before and after

| Measurement | Before (live 03:19 log / round 25) | After (round-26 simulation) |
|---|---|---|
| Event-loop max block | 2,342.5 ms | 470.8 ms |
| Event-loop p99 | 330.6 ms | 41.2 ms |
| Event-loop mean | not reported | 21.0 ms |
| Worst safety pass | 22,491 ms | bounded; `_tick` returns <150 ms while a 250 ms pass is in flight |
| Longest observed controller ownership | 1,802.2 s (`PLACE_BED`) | bed task 5/5 in 120 s; objective completed in ~7.4 min |
| Repeated plan failures | `automatic plan failed` 1, 2, 3 … | none in the 7.5-minute run after the bed-quota fix |

These are **not** the same workload. The “before” numbers come from the reported
live server run; the “after” numbers are ten deterministic simulated bots on this
sandbox. The comparison shows the direction and magnitude of the event-loop fix,
not a live-server benchmark. No hardware-improvement claim is made.

The simulation also showed the remaining cost honestly: the first full audit run
takes ~17 minutes for 10,001 designs, and the event-loop max is still hundreds of
milliseconds during large block scans. It is not claimed to be zero.

## G. Commands

- `bot all status` → 10 rows, 10 online, 10 ready.
- `eat all` → 10/10.
- `return home all` → 10/10.
- `bot all inventory` → 10 rows with real capacity.
- `bot all collect` → 10/10.
- `bot all defend` → 10 rows.
- `explore all 1` → 10 rows.
- `bot all mine iron` (test fixture with a real reachable deposit per bot) → at
  least 8 bots mined >0 and at least 8 iron-ore blocks disappeared from the world.
- A not-ready bot is skipped by fleet commands and cannot execute a direct
  gameplay action (`BOT_NOT_READY`).
- Operator `goto`/`come`/`return` use the `operator` priority and cannot be
  pre-empted by routine work.

The command audit did not invent results: the mining assertion is on
`world.blockNameAt()` before/after, not on a returned `ok` flag.

## H. Task and objective system

- `batch all eat then return home` runs two ordered steps and reports both.
- `task fleet CHOP_WOOD types=oak` creates ten tasks and assigns ten bots.
- Tasks have dependencies, TTL claims, heartbeats, retry budgets and a
  no-progress release window.
- Completion requires `verified:true` and an owner identity; an unverified
  completion is rejected by `TaskBoard.complete`.
- The simulation objective completed its foundation, walls, roof, storage, five
  beds and perimeter, and the planner created a replacement without a failure
  warning. The previous impossible ten-bed task is now a feasible five-bed task
  because one bot owned five beds.

## I. Building engine

The building engine validates, plans dependencies and verifies blocks by
position. The independent audit is Section J. It does not place blocks; block
placement/verification is covered by the building and construction tests.

## J. Schematic library: genuine counts

`npm run schematics:stats`:

```text
DESIGNS: 10000
UNIQUE: 10000
MINIMUM: 10000 (met)
BLOCKS: total 27,821,660, average 2,782, largest 79,436
LARGEST DIMENSIONS: 124 x 92 x 94
```

Custom imports: **1** (`custom_smoke3`, Sponge `.schem`), validated, 0 invalid
blocks, 0 duplicates. Total loaded library: **10,001** including the custom design.

`node scripts/buildings-audit.js` (full, 1,501 s timeout; completed in
1,028.9 s):

```text
audited: 10001 / available: 10001
blocks: 27,821,669
issues: 0
invalidBlocks: 0
cycles: 0
failures: 0
ok: true
warnings: 20001
```

The 20,001 warnings are aggregate, not invalid blocks:

- 10,001 × `VERSION_COMPATIBILITY` — the audit did not request a version, so the
  registry used 26.1.
- 10,000 × `STATE_NOT_SPECIFIED` — generated palette states omit optional
  properties; comparison is only where the blueprint specifies them.

No design was counted twice by renaming; `UNIQUE` is geometry-unique and the audit
reconstructed every design. The earlier 100/100 sample was not used as the final
claim.

## K. Compatibility

- `minecraft-data('26.1')` resolves protocol **775** and says the version sends
  client tick ends.
- The wire ids used by the compression/protocol tests remain the 26.1 ids
  (`tick_end 0x0d`, `keep_alive 0x1c`, `position 0x1e`, `respawn 0x52`,
  `update_health 0x68`).
- No version was guessed or changed to “fix” movement. The live detector remains
  `serverVersion: 'auto'`; the observed live value is unchanged.
- `validate` preserves `EmpiSMP.aternos.me:32990`, disables AI/keyless mode, and
  rejects any configuration that tries to enable automatic `/login` or
  `/register`.
- The 26.1 protocol support is not a claim of 26.3/776/777 support.

## L. Tests and validation

```text
npm test             309 passed, 0 failed, 0 cancelled, 0 skipped
npm run lint         LINT PASSED (148 files checked)
npm run validate     VALIDATION PASSED
                     secret leak check PASS
                     lint PASS
                     tests PASS 309/309
                     schematics validation PASS
                     consistency 10/10
```

Focused suites:

```text
tests/connection-lifecycle.test.js   37/37
tests/connection.test.js             17/17
tests/runtime-safety.test.js         14/14
tests/recovery.test.js               14/14
tests/task-pipeline.test.js          18/18
tests/team.test.js                   24/24 (with task-pipeline run: 42/42)
tests/fleet-commands.test.js         powering the fleet fan-out/batch assertions
```

New tests in this round cover: deferred position ordering, malformed payload
rejection, priority pre-emption both ways, post-physics relative teleport anchor,
non-blocking safety, action-stop flags, unsafe spawn, spawn re-assessment, short
non-loop recovery, spawn escape, creeper escape, plan bed feasibility and action
stop. The flaky “never-resolving promise” unit test was removed rather than
weakened with a ref hack; `_withTimeout` remains covered indirectly by the
bounded action path.

Simulation run (10 bots, deterministic, `node src/index.js --simulate`):

- first objective completed after ~7.4 minutes; replacement objective created;
- no `automatic plan failed`;
- no `NaN`;
- no `Path was stopped before it could be completed!` after the fix;
- no `invalid_player_movement`;
- one initial `unsafe spawn: suffocation risk` on a mock spawn inside a tree, then
  `unsafe spawn cleared; no deaths in window`;
- bed task `5/5 COMPLETED`;
- event loop `max 470.8 ms`, `p99 41.2 ms`, `mean 21.0 ms` at the sampled point.

## M. Git and remaining risk

Commits (pushed to `arena/de11bd2d-chickenbots`):

```text
d9dc9a8 fix(movement): single authoritative owner and valid packet ordering
65405ee fix(survival): act on spawn threats immediately and bound recovery work
8b06acd fix(team): make base planning feasible and anchor on post-physics teleports
<next>   test/perf: bound dig/place and document round 26
```

Not verified, and not claimed:

1. Ten live sessions staying connected for 30 minutes on EmpiSMP.
2. No `invalid_player_movement`, `EPIPE` or `ECONNRESET` after a real spawn burst.
3. A real kick/duplicate-login reconnect on the live server.
4. Real threat response against live zombies/creepers (the tests use mock worlds).
5. The host's CPU absorbing ten live bots at the configured chunk view.
6. Live building against server block-update latency; the audit validates plans
   against the block registry, not a live world.
7. A full live test of the dashboard 3D viewer with real chunk data.

The sandbox limitation is a network limitation, not a code result. The correct
next step is the live acceptance checklist in
`V6_ROUND_25_REPORT.md`, run on a host that can reach EmpiSMP.
