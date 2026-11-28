# V6 Round 47 — idle-by-default launch

## Problem

A fresh launch immediately created `BUILD A PERMANENT SURVIVAL BASE` and a
board full of tasks. There was no configuration key or operator control for
that behaviour: `TeamCoordinator` defaulted `autoPlan = true`, and the runtime
did not pass an override.

## Change

- `AUTONOMY_AUTO_PLAN` (default **false**) is added to `config.autonomy` and
  validated as a boolean.
- `TeamRuntime` passes the setting into `TeamCoordinator`; direct coordinator
  construction also defaults to `config.autonomy.autoPlan`.
- `TeamCoordinator.setAutoPlan(enabled)` toggles planning at runtime. Enabling
  clears `planRetryAt`/backoff and the next tick plans immediately. Disabling
  does **not** delete existing objectives or tasks — it only stops new plans.
- `TeamRuntime._idleWork()` is skipped while planning is off. Without this gate
  the board said zero tasks while the leader still chopped wood every 20 ticks,
  so the world changed and the fleet was not actually idle.
- `team plan on|off|status` is registered in the command handler and command
  metadata. `on` calls `ensureObjectives()` so the dashboard updates without
  waiting for the next tick.
- Team Management gains a **Task planner** card with a state badge and
  Start/Stop button. Task Manager gains an explicit planner-off callout and
  start action. Empty-state copy now describes the real state.
- README and `.env.example` document the new default and how to opt in.

Safety work (eat, flee, defend) is unchanged. Manually created objectives and
tasks remain available while the planner is off.

## Verification

| Gate | Result |
|---|---|
| `npm test` | 545/545 pass |
| `npm run lint` | 204 files, 0 errors, 5 pre-existing warnings |
| `npm run validate` | PASS, consistency 10/10 |
| `npm run commands:audit` | 48/49, 0 failures (`stop` skipped) |
| Fresh simulation `/api/state` | `autoPlan:false`, `objectives:0`, `tasks:0`, non-leader roles `IDLE`; no chop/farm log for 3.5 minutes |
| Idle-work regression | `tests/autonomy.test.js` asserts `_idleWork` returns `skipped: planner-off` and the log count is unchanged |
| Browser `#/team` | **Task planner off**, **Start planner**; empty board; no console/page errors |
| Browser `#/tasks` | Planner-off callout and **Start planner** |
| Browser click **Start planner** | Badge `planning`, one active objective, 16 tasks, button becomes **Stop planner** |

**Live-server verification is still required** on the target server; all
results above are simulation/browser results.
