# Chickenbots V6 — Round 32

**Branch:** `arena/de11bd2d-chickenbots`
**Starting head:** `7a69ba4`
**Date:** 2026-11-22 (sandbox clock: 2026-11-25 UTC)
**Evidence boundary:** no live connection to `EmpiSMP.aternos.me:32990` was
possible from this sandbox. Everything below is unit, deterministic simulation
or local HTTP evidence. No live acceptance is claimed.

## The live log

The supplied live log is important: **the five bots did not disconnect**. They
joined between 17:45:40 and 17:45:49 and were still connected 20 minutes later.
There is no `kicked`, `disconnected`, `EPIPE`, `ECONNRESET` or duplicate-login
line in it.

What it does show is a performance defect:

```
17:46:23  event loop blocked for up to 4831.8ms at action:00110000:MINE_BLOCK
17:47:36  event loop blocked for up to 9781.1ms at launch-actions
18:05:12  event loop blocked for up to 11861.5ms at launch-actions
```

and repeated safety-stage lines such as `safety stages 20724ms: follow 20722ms`.
The 20 s formation follow was the default `goTo` timeout. While a bot was in
that path it could not service its next safety pass, and commands had to wait
behind it. This round fixes that command/safety interaction; the larger
event-loop block remains open as **BUG-27-10**.

## 1. Command improvements

### Universal help and category help

Every command now accepts `--help` (or `-h`) without executing:

```text
players --help
team --help
build --help
```

`help <name>` includes category, aliases, examples, argument counts and the
confirmation requirement. `help <category>` falls back to the category list if
there is no command with that name; `help builder` still means the `builder`
command because it exists.

### Reproducible command audit

New `npm run commands:audit` (`scripts/command-audit.js`):

- resolves every command and alias through the shared registry;
- runs `<command> --help` for every command;
- executes a real safe invocation in the deterministic simulation for 45 of 46
  commands;
- deliberately skips only `stop`, which would shut the runtime down;
- treats `duel`'s `CONFIRMATION_REQUIRED` and `sleep`'s honest `not night`
  answer as expected, not as failures.

Result: **45/46 exercised, 0 failures**. `tests/command-audit.test.js` locks
this in.

### Real command defects found and fixed

| Command | Before | After |
|---|---|---|
| `team leader` | crashed: `services.leadership.status is not a function` | returns leader, preferred name, succession order and election history |
| `fish all stop` | `casts must be an integer (got stop)` | accepts both word orders |
| `explore all stop` | `steps must be an integer (got stop)` | accepts both word orders |
| `inventory all` | `unknown bot all` | per-bot fleet inventory rows |
| `diagnostics` | failed `10,000/10,001 unique` after any custom design | compares manifest hashes to the manifest count and reports custom designs separately |
| `site status` | failed when no project existed | `ok:true, active:false, project:null` |
| `materials status` | failed when no project existed | `ok:true, active:false, project:null` |
| `players follow Alex nope` | silently used the leader | clear “unknown bot or fleet target” error |
| `players follow Alex all 999` | silently clamped | clear out-of-range error |
| `players stop nope` | stopped every bot | clear unknown-target error |
| `players follow Alex *` | `unknown bot *` | the wildcard fans out to the fleet |

### Commands no longer race the safety loop

- `runExclusive` now also cancels an in-flight **safety/watch** task, not only
  the autonomous step. A 20 s follow can no longer keep ownership of the
  pathfinder while an operator command starts.
- Commands for the same bot are queued FIFO rather than racing each other.
- Formation follow is bounded to a 4 s move and then backs off exponentially
  (up to 15 s) instead of retrying a blocked leader every safety tick.
- A cancelled safety task is awaited for at most 3 s before the command runs.

## 2. Unfollow players

### Controller

`PlayerController.unfollow(player?)` clears **only** a `FOLLOW` watch:

- no player name: clear that bot's follow;
- player name: clear only if it matches;
- a guard or escort is left untouched;
- an offline bot's stale follow can still be cleared;
- `already`/`stopped` are reported separately; no fake “cancelled”.

### Command

```text
players following [bot|all]
players unfollow [player] [bot|all]
```

Examples:

```text
players following all
players unfollow Alex all
players unfollow Alex ________
players unfollow all
```

`players stop` remains the broader action and clears guard/escort/follow.

### Dashboard

The Players page now has a dedicated **Following players** section above the
watch table:

- one row per bot→player follow;
- distance, visibility and last action;
- per-row **Unfollow** button;
- **Unfollow all** action;
- **Refresh** uses `players following all`;
- the control bar also has **Unfollow all** next to **Stop all watches**.

Per-player cards now show **Unfollow** beside **Follow**. The section is driven
by the existing `playerWatch` snapshot, so it does not invent a second source of
truth.

## Evidence

| Check | Result |
|---|---|
| `npm test` | **395/395** |
| `npm run lint` | **PASSED (165 files)** |
| `npm run commands:audit` | **45/46 exercised, 0 failures** (`stop` skipped) |
| `npm run validate` | **PASSED** (consistency 10/10) |
| `npm run deploy:check` | **13/13** |
| `npm run check:secrets` | **PASSED (200 tracked files)** |

Local dashboard evidence with the players preview:

```text
players follow Alex all 3    -> ok, completed 5
playerWatch FOLLOW rows      -> 5
players unfollow Alex all    -> ok, cancelled 5
playerWatch FOLLOW rows      -> 0
GET /js/pages/players.js     -> 200, contains "Following players" and "players unfollow"
```

## Remaining limitations

- **BUG-27-10** is now observed at 11.9 s on the live server and remains OPEN.
  The follow timeout fix removes one contributor, not the synchronous chunk /
  action burst itself.
- Live commands and the unfollow UI were not exercised against the live server.
  The sandbox cannot reach it.
- `sleep` honestly reports `not night` during the audit; that is not a command
  failure.
- `players following` reports watches only; a player who is server-listed but
  never seen in render distance still has no position.
- The audit is a deterministic simulation. It proves dispatch, validation and
  local state changes, not live server behaviour.
