# Chickenbots V6 — round 24 engineering report

**Branch:** `arena/de11bd2d-chickenbots`
**Latest commit:** `73fdb6d` (pushed)
**Base:** `7764c410934a71bc22d69bb1ef1fad5647e0e640` (`main`)
**This report is not a live-server acceptance report.** No connection to
`EmpiSMP.aternos.me:32990` was made in this environment, so `V6_FINAL_REPORT.md`
has deliberately not been rewritten.

## What changed

### Automatic `/register` and `/login` are disabled

- `RealBot.authCommandsEnabled` is false unless a test explicitly constructs the
  legacy parser. The runtime never sets it.
- `_handleLoginCommands()` returns `{ ok: true, required: false, mode: 'disabled' }`
  and sends nothing.
- `_sendAuthCommand()` returns `AUTH_DISABLED` before touching the socket.
- `MC_AUTH_ENABLED`, `MC_LOGIN_PASSWORD` and `MC_REGISTER_PASSWORD` cannot
  re-enable commands; `validateConfig()` refuses any configuration that sets
  `authCommandsEnabled`.
- A server chat demand such as “login with /login” sets
  `authRequiredManual`, keeps the session online, reports
  `AUTH_REQUIRED_MANUAL`, and blocks gameplay commands.

Tests in `tests/fleet-commands.test.js` prove no password command is written on
spawn, on direct `_sendAuthCommand` calls, or when a manual-auth prompt is
recorded.

### Online is separate from ready

`src/bot/status.js` returns one verdict used by the CLI, dashboard, runtime and
coordinator:

- `transportConnected` — the socket is open.
- `serverPlayerListed` — the player is in mineflayer's player collection or has
  a live entity.
- `spawned` — the spawn packet was accepted.
- `authenticated` — no manual-auth block is pending.
- `authPending` / `authRequiredManual` — the server demanded manual auth.
- `gameplayReady` — online + spawned + no auth pending + a live entity.
- `online` — transport open and (`spawned` or server-listed).

A dead, stale, starting or auth-blocked but spawned bot is **online, not ready**.
The dashboard shows every field separately on the bot profile. Fleet status rows
are uniform `{ bot, ok, online, ready, gameplayReady, ... }`.

### One command can task the whole fleet

`bot all <action>` now executes actions; `bot all status` is only a status query.
Supported fleet forms include:

```text
bot all status
bot all chop oak
bot all mine iron
bot all farm wheat
bot all farm maintain
bot all explore [steps]
bot all defend
bot all return
bot all collect
bot all inventory
eat all
return home all
mine all iron
chop all oak
farm all wheat
explore all 1
defend all
```

Fan-out uses bounded concurrency (`FLEET_CONCURRENCY`, default 4) and returns
one structured row per bot with `ok`, `code`, `statusLabel`, `error` or action
fields. A bot that is not gameplay-ready is skipped with `BOT_NOT_READY`, never
counted as a success. `batch all <step> then <step>` runs ordered multi-action
objectives and reports every step. `task fleet` assigns a board task to all ten
bots.

The dashboard’s fleet buttons now submit **one** fleet command, not ten separate
commands.

### Commands

- Added `bot all collect` and `bot all inventory`.
- Added fleet targeting to `defend` and `explore`.
- `bot all status` rows now carry `ok`, so the dashboard does not mark a
  successful status query as ten failures.
- Chopping only reports success when logs were actually removed; idle
  woodcutting is an honest failure.
- Mining only reports success when an ore was reached and removed; a surface
  scan miss is not success.

Observed in the deterministic simulation:

```text
bot all status    10/10 ok, online=true, ready=true
bot all chop oak  8/10 removed logs, 2 honestly failed with "no trees nearby"
bot all mine iron 0/10 removed ore; each row says "no iron ore was reached and removed"
bot all defend    10/10 ok
bot all inventory 10/10 rows with slot/capacity data
bot all collect   10/10 ok
explore all 1     10/10 ok
```

The mining result is a real failure in the mock terrain, not a fabricated
success. The live adapter must be exercised against a server with reachable ore
before mining can be claimed live-tested.

### Performance

- `data/schematics/manifest.json` is loaded lazily once.
- The static half of `library.stats()` and category counts are cached; the
  custom-store half is refreshed per call.
- The runtime preloads the library index before opening the dashboard.
- Dashboard SSE snapshots run every 2 s instead of every second.
- Measured: library preload 280–399 ms at startup; cold `statusSnapshot` 810 ms;
  warm snapshots 4–10 ms (10 iterations). Dashboard `/api/state` measured 0.70 s
  first read, 0.30 s second, 0.01 s third.
- No snapshot exceeded the 1 s warning threshold in the final process.

### Schematic library

- Exactly **10,000** generated designs, **10,000** unique geometry hashes.
- **27,821,660** blocks; average 2,782; largest 79,436.
- 78 categories; 9,731 designs accepted by the planned tier pass plus 269 real
  apprentice refills (numbers 10001+, generated and deduplicated, never renames).
- Full validation: **PASS**, 375,657 ms, 10,000 entries, zero duplicate designs,
  zero duplicate specs, zero unsupported blocks, zero structural problems.
- `scripts/buildings-audit.js --offset 9740 --limit 260` audited the refill tail:
  260/260, 290,306 blocks, zero invalid blocks, zero cycles, zero failures.

The manifest is ~20 MB and remains tracked because it is the actual library.

### Dashboard

- Fleet quick actions: chop oak, mine iron, return home, fleet status.
- Bot profile connection panel shows transport, server player list, spawn,
  manual auth, authenticated, gameplay-ready, last packet, dimension, position.
- Existing 34 navigation pages, 3D world viewer, schematic import/export,
  build controls and task manager remain wired to the real endpoints.

## Verification

```text
npm test            280 passed, 0 failed
npm run lint        PASSED (147 files)
npm run validate    PASSED
                    secret check PASS
                    lint PASS
                    tests PASS 280/280
                    schematics PASS (reused full 10k report)
                    consistency 10/10
```

`npm run validate` reuses a saved full report only when it is newer than the
manifest and has the same entry count; `npm run schematics:validate` was run
once on the current manifest and produced the report.

## Honest limitations

- **No live server connection was performed.** Network access in this sandbox is
  restricted to package/GitHub hosts, so the ten-bot EmpiSMP session and the real
  mineflayer adapter are not proven here.
- **26.3 registry support was not verified.** The target data installed in this
  checkout tops out at 26.1; the code reports `NEAREST_KNOWN` rather than
  pretending 26.3 data exists.
- **Redstone and functional-farm behaviour was not live-tested.**
- **Full 10,000-design `BuildEngine` audit was not run.** All 10,000 pass the
  schematic validator; a 260-design tail sample passed the independent
  `BuildEngine` audit.
- **Mock mining of natural terrain fails honestly** because the guaranteed mock
  ore pockets are not exposed within reach. Unit tests cover ore removal with
  reachable, tool-appropriate ore.
- `V6_FINAL_REPORT.md` remains the earlier unverified live-run report and is not
  updated until a real live run exists.
