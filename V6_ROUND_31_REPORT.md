# Chickenbots V6 — Round 31

**Branch:** `arena/de11bd2d-chickenbots`
**Starting head:** `d16458d`
**Date:** 2026-11-22 (sandbox clock: 2026-11-25 UTC)
**Evidence boundary:** no live connection to `EmpiSMP.aternos.me:32990` was
possible from this sandbox. Every result below is unit, deterministic
simulation or local HTTP evidence. **Nothing here claims live acceptance.**

## What changed

### 1. Fleet roster is five bots

The fixed roster in `src/config.js` is now exactly:

```
________, 10101000, 01010100, 11001100, 00110000
```

The previous last five names were removed. The roster guard in
`RealBot` still refuses any other username, and the runtime still creates
exactly the configured roster. Updated expectations:

* `scripts/deploy-check.js` — five names, five live bots/combat controllers.
* `scripts/validate-all.js` — five fixed team names.
* `tests/{team,controllers,combat,dashboard-status,survival,audit-regressions,serverVersion,fleet-commands,v4-features}.test.js`
  — roster-length and per-bot counts now use `BOT_NAMES.length` / `config.team.names.length`
  or the explicit five-name list.
* User-facing branding, README, package description, dashboard copy and the
  `home status` expectation now say five.

No feature was removed to make this pass. Every controller, command and
dashboard route still runs for all five bots.

### 2. Woodcutting / `chop` actually removes logs

Two real defects were found and fixed:

1. **Top-down chopping was unreachable.** `chopTree` started at the crown and
   called `goTo(topLog, { range: 4 })`. A tree taller than mining reach cannot
   satisfy that goal; the first failure aborted the whole tree, so the command
   honestly reported `no tree was chopped`. It now chops the lowest log upward,
   moves beside the trunk once when a log is outside 4.5 blocks, and stops at
   the first genuinely unreachable upper log. A partially harvested trunk still
   returns the logs that were really removed.
2. **No-tree results had no recovery.** `chop` returned `no trees nearby` and
   never searched farther. `woodcutting.tick()` now widens the scan from 24 to
   48 blocks, and `chop` passes `relocate: true`; each bot walks to its own
   bearing around home, scans a 32-block patch, and reports the relocation
   honestly if that patch has no trees. `performTask('CHOP_WOOD')` keeps its
   existing surface/forest relocation path.

Every counted log is verified through `getBlock()` after the dig; a dig result
alone is not evidence. Failed or already-air blocks are not counted as
harvested.

**Simulation evidence** (`node` against the default `MockWorld`):

```
bot all chop  -> ok true, completed 5, failed 0
per bot       -> chopped 2, 5, 5, 9, 2
```

**Regression tests:**

* `chopping starts at the base ...` — tall trunk yields 6 reachable logs
  instead of failing at the crown.
* `tick widens the search to 48 blocks ...` — tree at 30 blocks is harvested.
* `relocate walks to a fresh forest site ...` — relocation is real and honestly
  reports `no trees at the fresh forest site` when none exist.
* existing `woodcutting-safety.test.js` tests still pass (null block, failed dig,
  navigation failure).

### 3. Players section and player-directed controls

New shared pieces:

* `src/players/registry.js` — a bounded seen-player directory. It merges
  `entitiesNear` sightings with the server player list (`RealBot.serverPlayers()`),
  excludes the five team bots, validates names and positions, tracks `seenBy`,
  nearest bot, distance, health, gamemode, ping, first/last seen and online
  window, and prunes stale entries. It has **no PvP authority**.
* `src/players/controller.js` — per-bot follow, guard, escort, come, greet,
  give-item, drop-loot and message controls. Follow/guard run through
  `BotActions.safetyTick()` after the threat/recovery gates, so lava, creepers
  and low health still win. `dropLoot` verifies the inventory actually
  decreased, protects tools/armour/totems/shields/ranged gear, and preserves
  the configured reserves (`oak_log`, `iron_ingot`, `torch`, food,
  building blocks, water buckets).
* `src/runtime.js` — owns the registry, observes sightings on a 2.25 s cadence,
  and forces a player-watch bot onto the safety path so operator follow/guard
  pre-empts task work.
* `src/runtimeState.js` — `players` and `playerWatch` sections in every snapshot.
* `src/commands/index.js` — the `players` command family.
* `src/dashboard/public/js/pages/players.js` + router/nav — the **Players** page.

Command surface:

```
players [list|near [radius]|info <player>]
players follow <player> [bot|all] [distance]
players guard <player> [bot|all] [radius]
players escort <player> [bot|all]
players come <player> [bot|all]
players stop [bot|all]
players give <player> <item> [count] [bot|all]
players drop <player> [loot|item] [count] [bot|all]
players message <player> <text> [--bot <bot|all>]
players greet <player> [bot|all]
```

Behaviour guarantees:

* A player is **never attacked** by follow, guard, escort or any other players
  action. Guard only attacks hostile mobs that approach the player. PvP still
  requires the separate explicit target list + `PvP` enabled + the server rule.
* `message` strips control characters, refuses a leading `/` (chat command
  injection), and prefixes the player name. `--bot all` means the leader speaks
  for the fleet, not five duplicate messages.
* `stop` clears watches even on a currently offline bot, so a reconnect cannot
  resume a stale follow.
* Loot drops and gifts verify the inventory delta and report partial transfers
  rather than assuming a toss succeeded.

**Simulation evidence:**

```
players follow Alex all  -> completed 5, failed 0
players guard Alex all 8 -> completed 5, failed 0
players give Alex oak_log 2 all -> completed 5, failed 0
players drop Alex loot all     -> completed 5, failed 0
players message ... --bot all  -> completed 1
```

The Players page was served from a local dashboard bound to `0.0.0.0:3000`
with two simulated players:

```
GET /                      200
GET /js/pages/players.js   200
GET /api/state             players = 2 (Alex visible, Steve server-list only)
                           playerWatch = 5 rows, one FOLLOW Alex
```

## Gates

| Gate | Result |
|---|---|
| `npm test` | **387/387** |
| `npm run lint` | **PASSED (163 files)** |
| `npm run validate` | **VALIDATION PASSED** (consistency 10/10) |
| `npm run deploy:check` | **13/13** |
| `npm run check:secrets` | **PASSED (197 tracked files)** |

## Remaining limitations / open items

* **Live chop is still UNVERIFIED LIVE.** The simulation proves the reach and
  relocation defects; it cannot prove the live server's terrain, pathfinder
  latency or plugin behaviour. The operator should run `chop` and inspect the
  returned `chopped`/`verified` fields and the Woodcutting page.
* **Player watch needs a live player in render distance** for movement, gifts
  and loot drops. The directory can list a server-list player with no position,
  but follow/guard cannot navigate to a position it has never observed. The
  page reports `visible: false` rather than inventing one.
* **BUG-27-10** (long-simulation 1,433.4 ms event-loop maximum) remains open.
* Combat findings (a)–(d) and `builder stop|cancel` returning `ok:false`
  remain open from round 30.
* The sandbox cannot reach `EmpiSMP.aternos.me:32990`; no live acceptance is
  claimed anywhere in this report.

## Files

New:

```
src/players/registry.js
src/players/controller.js
src/dashboard/public/js/pages/players.js
tests/players.test.js
```

Modified (primary):

```
src/config.js               five-name roster
src/actions/woodcutting.js  bottom-up reachable chop + search/relocate
src/actions/index.js        player controller wiring + safety stage
src/runtime.js              player registry + watch scheduling
src/runtimeState.js         players/playerWatch snapshot
src/commands/index.js       players command family + chop relocation
src/dashboard/public/js/router.js
README.md
scripts/deploy-check.js
scripts/validate-all.js
```
