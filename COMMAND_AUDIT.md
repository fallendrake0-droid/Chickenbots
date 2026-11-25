# Chickenbots V6 — command audit

All commands were sent through the dashboard's real `POST /api/command`
(`{"line":"..."}`) against a fresh deterministic simulation. The command registry
is the same one used by the CLI and internal automation.

## Round 37 re-audit (47 commands)

`goto` is now a top-level command (`goto <x> <y> <z> [bot]`,
`goto <bot|all> <x> <y> <z>`) in addition to `bot <name> goto`.
`npm run commands:audit` covers **46/47** (`stop` is the deliberate skip) with
**0 failures**. The safe probe is `goto 0 65 0`; bot-first, bot-last and `all`
forms are covered by `tests/goto-command.test.js`.

## Round 33 re-audit (46 commands)

The registry is unchanged at 46 commands. `mine` now accepts `stop`, ores and
minable block targets (`mine [bot|all] [ore|block|stop]`) and `doctor`
includes a `work-zone` check. `npm run commands:audit` still covers **45/46**
(`stop` is the deliberate skip) with **0 failures**. The deterministic mock
world has no ore near spawn, so `bot all mine iron` remains an honest
UNVERIFIED row rather than a fake success. A separate runtime probe with
placed iron/coal/diamond ore verified `mine diamonds` end to end (see
`V6_ROUND_33_REPORT.md`).

## Round 32 re-audit (46 commands)

`npm run commands:audit` now resolves every command and alias, runs
`<command> --help` for every entry, and performs a real safe invocation in the
deterministic simulation for 45/46 commands. `stop` is the only deliberate
skip because it shuts the runtime down. Result: **45/46 covered (stop skipped), 0 failures**
(`duel` correctly returns `CONFIRMATION_REQUIRED`).

The audit found and fixed real command defects:

| Command | Defect | Fix |
|---|---|---|
| `team leader` | `services.leadership.status is not a function` | Return the actual leader, preferred name, succession order and election history |
| `fish all stop` | `casts must be an integer (got stop)` | Accept both `fish stop all` and `fish all stop` |
| `explore all stop` | `steps must be an integer (got stop)` | Accept both `explore stop all` and `explore all stop` |
| `inventory all` | `unknown bot all` | Fleet rows with per-bot inventory |
| `diagnostics` | Reported 10,000/10,001 unique after a custom design existed | Compare manifest hashes with manifest count, report custom designs separately |
| `site status` / `materials status` | Failed when no project existed | Status returns an inactive state instead of an execution error |
| `players follow Alex nope` | Silently fell back to the leader | Unknown bot/fleet target is a clear argument error |
| `players follow Alex all 999` | Silently clamped | Out-of-range distance/radius is rejected |
| `players stop nope` | Silently stopped all | Unknown target is rejected |
| `players follow Alex *` | `unknown bot *` | `targetActions` now recognises the full fleet word set |

## Captured results

| Command | Actual result | Verdict |
|---|---|---|
| `help` | command catalogue returned | PASS |
| `status` | `total:10, online:10, ready:10, authRequiredManual:0` | PASS |
| `bot all status` | 10 rows, all `online/ready/gameplayReady:true` | PASS |
| `bot all inventory` | 10/10; e.g. 34/36 slots, 653 items | PASS |
| `bot all defend` | 10/10 dispatched, all IDLE with `remaining:0` | PASS (no threats) |
| `batch all eat then return home` | 2/2 steps; 10/10 bots per step | PASS |
| `bot all chop oak` | repeated runs: 10/10 once, 8/10 twice and 9/10 once; misses report `no trees nearby` | PARTIAL |
| `bot all collect` (round 26 capture) | 10/10 dispatched, `collected:0` | PASS-DISPATCH / NO DROPS |
| `explore all 1` (round 26 capture) | 10/10, real discoveries returned | PASS-SIM |
| `bot all mine iron` | **not claimed** on untouched mock terrain | UNVERIFIED |

Repeated runs returned 10/10 once, 9/10 once and 8/10 twice. The misses were
`no trees nearby` after the earlier bots harvested the nearby set, with
`partial:true` and the per-bot reason. This is a real tree-allocation limitation,
not a proven fix, and it is not rounded up (BUG-27-09).

## Command system checks

Covered by existing tests and the runtime:

- One registry shared by CLI/dashboard/internal commands.
- Quoted arguments, batch syntax, no `eval`, no shell execution.
- Fleet fan-out is bounded (`FLEET_CONCURRENCY=4` by default).
- Not-ready bots are skipped with `BOT_NOT_READY`.
- Batch steps wait for the previous step and report each step.
- Results include per-bot `ok`, error/code and progress where available.
- `bot all status` is a status command; other `bot all <action>` commands reach
  their action handlers rather than being reinterpreted as status.

## Not tested here

- Interactive CLI commands (the CLI starts and exits; see `SCRIPT_AUDIT.md`).
- Browser clicks. The HTTP API was exercised; no browser automation is
  available in this sandbox.
- `bot all mine iron` success. The mock terrain does not contain a reachable
  deposit for every bot; round-26 explicitly refused to fabricate this result.
- Live server command side effects (building, chest transfers, combat kills).
