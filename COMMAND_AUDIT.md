# Chickenbots V6 — command audit

All commands were sent through the dashboard's real `POST /api/command`
(`{"line":"..."}`) against a fresh deterministic simulation. The command registry
is the same one used by the CLI and internal automation.

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
