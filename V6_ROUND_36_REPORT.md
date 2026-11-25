# Chickenbots V6 — round 36 report

**Baseline:** `863145b` (round 35), branch `arena/de11bd2d-chickenbots`.
**Scope:** continued repair after the operator supplied a live capture. The
sandbox still cannot reach `EmpiSMP.aternos.me:32990`; every live result remains
**UNVERIFIED** and the numbers below are simulation/local measurements.

## First: the pasted capture predates the pushed round-35 tree

This is not an excuse for the behaviour in the capture; it changes which
failures are still reproducible in the current checkout. The capture's own log
strings do not exist in `863145b`:

| Capture says | Current code says |
|---|---|
| `automatic plan failed (1 consecutive); re-planning in 60s` at 19:34 | `automatic plan failed (…): <reason>; re-opening the same objective in 60s` |
| `new team objective: BUILD A PERMANENT SURVIVAL BASE` recreated at 19:35:17 and 19:39:56 | `TaskBoard.reopenObjective()` keeps the same objective id |
| `schematic library ready: 10000 designs in 7236ms` | `… in 38ms (aggregate summary; manifest stays lazy)` |
| `[01010100] died … (cause: item (1.3m))` | `item`/`object` causes become `UNKNOWN_CAUSE` |

The `git pull` output and the run in the same paste may have been captured out
of order. The current checkout contains the round-35 fixes and its tests; the
live acceptance procedure below must be re-run on **this** commit before any
live criterion is called fixed.

## Repairs added in round 36

1. **A cold status cache can never run a live controller.** `BotActions.status()`
   is now cache-only by contract. A cold cache returns null sections and
   `statusCache.empty: true`; `warmStatus()` is the explicit fill path used by
   startup and tests. Previously the first cold snapshot ran all twelve
   `controller.status()` methods, including world scans, inside the HTTP
   request. That is the mechanism behind the capture's 5.2 s snapshot with
   `actions=4237`.
2. **Long tasks yield to safety.** While a task is running, the runtime checks
   `lastDamageAt`, health, lava, fire and fall state every
   `SAFETY_PREEMPT_MS` (500 ms). Damage cancels a non-combat task and marks the
   old assignment for re-planning; the next tick runs the safety pass before
   any new work. Combat/guard/rescue tasks are not cancelled by ordinary
   damage, but still yield to critical health and hazards. This closes the
   window in which a 26 s `FARM_CROP` or mining step had no safety pass at all.
3. **A timed-out safety pass does not start a task beside its stuck await.**
   `_startBotStep()` returns after `safetyResult.timedOut`, `dead`, `notReady`
   or `recovering` instead of creating a second movement owner.
4. **AuthMe and SimpleAuth are distinct, configurable adapters.**
   - AuthMe registration defaults to `/register {password} {password}`.
   - SimpleAuth registration defaults to `/register {password}` — it is not a
     renamed AuthMe confirmation command.
   - `MC_AUTH_LOGIN_TEMPLATE` / `MC_AUTH_REGISTER_TEMPLATE` override either
     form per server; both are validated for `{password}` before sockets open.
   - Legacy `MC_LOGIN_COMMAND` / `MC_REGISTER_COMMAND` still apply when
     explicitly set.
   - The profile is still challenge-driven; no password is sent without the
     server's prompt, and registration remains an explicit operator opt-in.
5. **Farm scans have a dedicated regression test.** `_localSoil()` is exercised
   against a 1 ms-per-lookup world and must stay bounded rather than walking the
   49×49×17 cube.

## Evidence run in this round

| Gate | Result |
|---|---|
| `npm test` | **428 pass, 0 fail, 0 cancelled** |
| `npm run lint` | **PASSED, 171 files** |
| `npm run commands:audit` | **45/46 executed or help-audited, 0 failures** |
| `npm run deploy:check` | **13/13** |
| `npm run check:secrets` | **PASSED, 214 tracked files** |
| `npm run validate` | **VALIDATION PASSED**, consistency **10/10** |
| `npm run perf:status` | cold **63 ms** (`actions` 0 from the empty cache, `builds` 49), warm-up **64 ms**, warm p50/p95/max **2/3/3 ms**, target < 50 ms PASS |
| Focused regressions | `dashboard-performance` + `runtime-safety` + `plugin-compat` 48/48; `farming` + `runtime-safety` 33/33; `players` 10/10; full suite 428/428 |

Local dashboard probe (simulation, `:3130`, six `/api/state` requests
500 ms apart): snapshot **2–12 ms**, `sections.actions` **0 ms**, all five bots
at 12 cached controller entries, `maxActionStatusAgeMs` ~8.6 s and
`actionStatusFresh: true`. `POST /api/command {"line":"status"}` returned in
**2 ms** with five ready bots. Startup logged the schematic summary in
**39 ms**, not a manifest parse.

New tests:

- cold `BotActions.status()` with every controller poisoned (zero calls);
- pre-emption reason matrix, including the combat-task damage exception;
- a real 500 ms pre-emption timer cancels a 1.2 s task and records
  `safetyPreemption` in runtime state;
- a timed-out safety pass starts no task;
- AuthMe confirmation form, SimpleAuth single-password form and per-server
  template override;
- bounded farm soil scan on a slow world.

## What is still required before calling the live capture fixed

1. Pull `863145b` or later and run the five-bot capture again.
2. Confirm startup logs `(aggregate summary; manifest stays lazy)` and a
   library time near 38 ms.
3. Confirm the first `/api/state` and SSE frame report `sections.actions`
   below 50 ms and `freshness.actionStatusFresh: true`.
4. Confirm a farming step longer than 10 s does **not** prevent a damage event
   from producing `task pre-empted by safety` and a safety pass.
5. Confirm the next planner failure logs `re-opening the same objective` and
   does not create a second `BUILD A PERMANENT SURVIVAL BASE` id.
6. Confirm a death with only an `item`/`object` proximity cause is recorded as
   `UNKNOWN_CAUSE`.
7. Run a 30–60 minute soak and report event-loop p99/max, EPIPE/kick counts,
   reconnects, deaths and command results separately from simulation.

Everything in `LIVE_ACCEPTANCE_REPORT.md` remains open unless that run happens.
