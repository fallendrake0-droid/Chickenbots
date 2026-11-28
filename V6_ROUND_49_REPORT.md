# V6 Round 49 — beds, spawn points, crops and the live-log defects

**Evidence:** 561/561 tests, `npm run lint` 208 files (0 errors), `npm run
validate` 10/10 consistency and 36/36 pages, `npm run commands:audit` 48/49
with 0 failures, a deterministic five-bot simulator run, and a headless
Chromium pass against `http://127.0.0.1:4179`. The operator's live server
(`EmpiSMP.aternos.me:32990`) was not reachable from this sandbox, so every
live-server claim below is **UNVERIFIED**.

## The operator's report

> also fix the nearby beds thing and nearby crops the bots cant detect the
> crops even when its nearby and they don't auto replant and auto break crops
> when fully grown and they don't detect the nearby beds to set their spawn
> point

The 80-minute log from build `6.0.0+adafca5` also showed event-loop blocks up
to 15.7 s, 4–16 s inbound gaps, dozens of tick-late recoveries per bot, the
safety stage overrunning its 6000 ms budget, phantom/zombie/skeleton deaths,
`player come/follow Bobthechicken` never completing, `BUILD_PHASE produced no
verified result` three times, and one bot drowning while escaping a player.

## What was actually wrong

### Nearby beds were invisible

`SleepController.status()` scanned a 17×25×17 cube with a **2 ms** budget and
the shared `findBlocks()` deliberately refused the index whenever a budget was
set. The scan therefore stopped after a few hundred cells near the bot's feet.
A bed 10–16 blocks away — the normal distance in the base — was never read, so
`nearbyBeds` stayed empty and the sleep page said no beds existed.

The same helper backed crops at a 6-block status radius and `harvestAll()` at a
24-block action radius with a 6 ms budget. Adjacent seedlings could fill the
budget, and `harvestAll()` then applied `limit` **before** filtering for
maturity, so sixteen seedlings could hide one ripe crop one block farther away.

### Nothing ever set a spawn point

There was no `setSpawnPoint` on either adapter and no path from detection to
`bot.spawnPoint`. Sleeping sets a vanilla respawn anchor, but sleeping requires
night and a free bed; the daytime tick returned `{ idle: true, reason:
'daytime' }` without even looking. The `PLACE_BED` action placed furniture and
never clicked it. With the planner off, `_idleWork` returned before any sleep
code ran at all.

### The live-log defects

| Log line | Cause |
|---|---|
| `event loop blocked for up to 15695.1ms` | unbounded/budgeted fallback cube scans (beds, crops, wood) ran on the same thread; the fix routes indexed world searches through Mineflayer's palette index and keeps the interruptible fallback for large non-indexed scans |
| `client tick loop was Xms late … (recoveries 63)` | recovery cancelled the nav arbiter, so every in-flight operator move was superseded and reissued; each stale `goTo()` counted another recovery |
| `safety budget 6000ms exceeded` / `safety stages 15720ms` | recovery stages ignored the pass deadline and kept eating/healing/walking after it expired |
| `unsafe spawn: suffocation risk` | `head: unloaded` and `below: unloaded` were treated as solid blocks during chunk streaming |
| `inbound packet gap 11239ms … (5 bytes)` | the warning threshold was 1000 ms and the rate limit 5 s, so normal lag flooded the log |
| `01010100 drowned while trying to escape Bobthechicken` | the retreat vector was chosen without checking water/lava/ground |
| `player come/follow … movement request was superseded` | a tick stall cancelled the movement claim instead of stopping only the path |
| `BUILD_PHASE produced no verified result` | `buildBasePhase()` returned only a free-text error; failures had no typed code/reason |
| `password authentication: configured` with `MC_AUTH_PROFILE=none` | the startup line reported credentials as active although no `/login` is sent |

## Fixes

| ID | Priority | Area | Fix | Evidence | Status |
|---|---|---|---|---|---|
| BUG-49-01 | P0 | Bed detection | `common.findBlocks()` uses the world index whenever the adapter advertises `indexedSearch` (RealBot) or the radius is small; the budget now applies only to the bounded fallback. Beds scan 16 blocks and cache for 8 blocks of movement, not 24. Team-memory beds are verified against the live block. Two halves collapse into one entry with `foot`, `head`, `distance`, `occupied`, `reservedBy` | unit: 2 ms status scan finds the bed; simulator: 5 bots each report the bed at 12–16 m | FIXED (unit/sim); live UNVERIFIED |
| BUG-49-02 | P0 | Spawn point | New `RealBot.setSpawnPoint()` finds the foot half and right-clicks it with `activateBlock`, then waits for the `spawn_position` acknowledgement. `MockBot` mirrors it. `SleepController.claimSpawn()` / `ensureSpawnPoint()` verify the anchor and never claim a bed that is not there. Daytime `tick()` claims; the idle loop runs it even with the planner off; `PLACE_BED` claims an existing bed; a new `sleep spawn [bot|all]` command and **Set spawn** buttons expose it | unit: claim → `spawnSet`, second call is `already`; command test; simulator `sleep spawn all` → 5/5 `verified: true`; Chromium: sleep table shows `9, 65, 14` and “5 bot(s) with a spawn point” | FIXED (unit/sim/browser); live UNVERIFIED |
| BUG-49-03 | P0 | Crop detection | `scanCrops()` now reaches the world index within the status/action budget; status radius 10, cache invalidated after 8 blocks of movement | unit: 17 crops at 1–13 blocks found with a 2 ms budget | FIXED (unit) |
| BUG-49-04 | P0 | Harvest only when ripe | `harvestAll()` filters maturity **before** applying `limit`; it returns `mature`, `immature`, `standing` and the full skipped list | unit: 16 seedlings + 1 ripe crop → exactly the ripe one harvested and replanted | FIXED (unit) |
| BUG-49-05 | P0 | Auto replant | Harvest waits up to ~480 ms for the server to remove the crop block before deciding the harvest failed (the old immediate check skipped replanting). Harvest is part of idle maintenance even when the planner is off, so a fully grown crop is taken and the seed put straight back | simulator: 10 harvested / 10 replanted; Chromium Farming page reports `HARVESTED 10` / `REPLANTED 10`; crop count returns to the planted count with age 0 | FIXED (sim/browser); live UNVERIFIED |
| BUG-49-06 | P1 | False suffocation | `unloaded`/`unknown`/`void_air` are absences of evidence, not hazards, for head/feet/ground | unit: all-unloaded reads return `[]` hazards | FIXED (unit) |
| BUG-49-07 | P0 | Operator movement | `_onClientStall()` stops the path but keeps the navigation claim; the manager retries the same token after `stallResumeMs`; duplicate stalls within 750 ms coalesce. Safety no longer starts combat-follow on top of the operator watcher, and `followTick()` respects the pass deadline | unit suite unchanged; live command completion UNVERIFIED | FIXED (unit); live UNVERIFIED |
| BUG-49-08 | P1 | Log flood | inbound gaps warn at ≥5 s, at most once a minute (or immediately at ≥15 s) | code inspection; no packet-gap spam in the simulator | FIXED (code); live UNVERIFIED |
| BUG-49-09 | P1 | Safety budget | recovery propagates `deadlineAt` to survival, skips heal/home once expired, and the follow path gets the remaining budget | recovery/safety tests | FIXED (unit); live UNVERIFIED |
| BUG-49-10 | P0 | Drowning retreat | each retreat candidate checks feet/head/ground; wet or unsupported vectors are skipped instead of walked | recovery tests | FIXED (unit); live UNVERIFIED |
| BUG-49-11 | P1 | BUILD_PHASE diagnostics | typed `code` (`NO_SITE`, `MATERIALS_SHORT`, `UNREACHABLE`, `BLOCKS_MISSING`) plus a human reason and `missingCount`; a failed phase now names its cause in the task error | action/team tests | FIXED (unit); live UNVERIFIED |
| BUG-49-12 | P2 | Auth log honesty | credentials with `MC_AUTH_PROFILE=none` now log “no /login or /register command is sent” instead of “configured” | config/logging tests | FIXED (code) |
| BUG-49-14 | P0 | Unclimbable shafts | A straight 1×1 shaft has no return path; miners stalled at y=33 with `no path … to -1,64,4` | Access shafts are now 1×2 staircases (one sideways, one down per step, floor kept) and the same route walks back up | mining suite + a mine-then-climb regression | FIXED (unit); live UNVERIFIED |
| BUG-49-13 | P0 | Long mining actions | `mineBlocks()`, `mineNearby()`, `mineOresDeep()`, `branchMine()` and `mineOre()` take one action deadline (action watchdog minus 8 s). Every move/dig timeout is clamped to the remaining budget, so the action returns the blocks it mined instead of being killed at 60 s | mining/audit suites 35/35 | FIXED (unit); live UNVERIFIED |

## Verification

- `npm test` → **561/561**.
- `npm run lint` → 208 files, 0 errors (5 pre-existing warnings).
- `npm run validate` → PASSED (10/10 consistency, 36/36 pages, 142 files clean).
- `npm run commands:audit` → 48/49, 0 failures (`stop` skipped by design).
- Simulator: `node src/index.js --simulate --host 0.0.0.0 --allow-insecure --port 4179`.
  - `farm 00110000 plant wheat 4` planted 4 verified crops.
  - After growth the idle maintenance harvested 3 ripe crops and replanted 3;
    the standing count returned to 4.
  - `sleep spawn all` returned `verified: true` for 5/5 bots and every sleep
    row reported `spawnSet: true`.
  - `mine 00110000 stone 3` cut a climbable staircase (`shaft: true,
    climbable: true`) to y=57; `bot 00110000 come` climbed it and
    `bot 00110000 return` reached the surface at y=64 (`verified: true`).
- Headless Chromium (`/tmp/browser/sleep-crop.mjs`):
  - `#/sleep` headers include **Spawn point**; every row shows `9, 65, 14`;
    the screen reader text includes “5 bot(s) with a spawn point” and the bed
    list marks every bed **Spawn**.
  - `#/farming` reports harvested/replanted counters; crop rows show the
    replanted crop as growing.
  - 0 page errors, 0 console errors.
  - Screenshots: `/tmp/sleep-spawn.png`, `/tmp/farm-crops.png`.

## Still open (honest)

- **Live server:** all of the above is simulation/browser evidence. The real
  Aternos server must be re-run to confirm `spawn_position` acknowledgements,
  real bed block states and crop growth.
- **Event-loop starvation:** the indexed scans remove the biggest fallback
  scans on the status path, but a live 15 s block still needs profiling of
  construction site surveys and chunk parsing on the real host.
- **Death loop:** the retreat/drowning and safety deadline fixes are real, but
  a live five-bot night under phantoms has not been observed here.
- **Climbable mine shafts:** the staircase fix is proven in the simulator
  (`mine 00110000 stone 3`: staircase rows to y=57, then `bot 00110000 return`
  arrived at the surface, y=64); the live pathfinder still needs one
  descending-and-returning run.
