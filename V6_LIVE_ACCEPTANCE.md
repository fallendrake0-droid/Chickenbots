# Chickenbots V6 — live acceptance checklist

**Status: not executed.** The Arena sandbox cannot reach
`EmpiSMP.aternos.me:32990`, so every item below is open. This file is the
procedure for a host that can reach the server; it is not evidence that the run
happened.

Round-25 acceptance rationale is in `V6_ROUND_25_REPORT.md`. Round-26 code
evidence and the simulation measurements are in `V6_ROUND_26_REPORT.md`.

## 1. Preflight

- [ ] Node version satisfies `package.json`; `npm ci` completed.
- [ ] `npm test` passes (round-26 baseline: 311/311).
- [ ] `npm run lint` passes.
- [ ] `npm run validate` passes.
- [ ] `config.server.host`/`port` are `EmpiSMP.aternos.me`/`32990`.
- [ ] `authCommandsEnabled` is `false`; no `/register`/`/login` path is enabled.
- [ ] Dashboard token is set, or the run is on a trusted host with
      `DASHBOARD_ALLOW_INSECURE=true` and the port is not public.
- [ ] Ten roster names are the intended accounts; no duplicate login is running.
- [ ] Start from an empty log capture: `V6_LIVE_RUN.log`.

## 2. Start and join

```bash
node src/index.js --host 0.0.0.0 --port 3000 2>&1 | tee V6_LIVE_RUN.log
```

- [ ] All ten sessions reach `spawned:true` and `gameplayReady:true`; `online`
      alone is not readiness.
- [ ] Join spacing is at least 2 s; no burst of ten simultaneous logins.
- [ ] No `invalid_player_movement`, `EPIPE`, `ECONNRESET` or duplicate-login kick
      in the first five minutes.
- [ ] Dashboard `/api/state` shows ten `ready` bots and a non-null `keepAlive`
      per bot.
- [ ] Record the first five minutes of `keepAlive.maxGapMs`; a gap of 10 s or
      more is a failure.

## 3. Per-bot checks

- [ ] `00110000`, `01010100`, `10101000`, `11001100`: no
      `invalid_player_movement` after a teleport, a client-tick stall and a
      reconnect.
- [ ] No bot stands still with health below 6; `emergencyHeal`/retreat appears in
      the log with the bot name.
- [ ] A bot that dies respawns, re-scans equipment and does not assume the old
      sword/armour survived death.
- [ ] A first join into a hostile spawn logs `recordSpawn`, retreats with real
      displacement, and either escapes or performs an armed last stand.
- [ ] No `Path was stopped before it could be completed!` without a caught
      priority pre-emption and a follow-up action.

## 4. Commands

Run each through the dashboard or CLI, record the exact JSON:

- [ ] `bot all status` — ten rows, ten ready.
- [ ] `eat all` — ten completed.
- [ ] `return home all` — ten completed or an explained safe refusal.
- [ ] `bot all inventory` — real slot counts and item names.
- [ ] `bot all collect` — report the actual `collected` count; zero is allowed.
- [ ] `bot all defend` — ten rows; IDLE is a valid result when no threat exists.
- [ ] `explore all 1` — ten rows with real discoveries or an explained stop.
- [ ] `bot all mine iron` — only pass if at least eight bots mined iron and at
      least eight iron-ore blocks disappeared from the world. Do not accept an
      `ok:true` without the block check.

## 5. Building and bed semantics

- [ ] Start the base plan; every `PLACE_BED` completes or is explicitly skipped.
- [ ] Bed quota equals the largest single-bot bed stock, never the fleet sum.
- [ ] `place()` evidence contains `observed` and `apiResult`; a placement is
      `VERIFIED` only after a world re-read.
- [ ] A deliberately wrong block at a planned position is repaired, not counted
      as complete.
- [ ] No single action owns an autonomy slot for more than 60 s without a
      watchdog stop.

## 6. Thirty-minute soak

- [ ] Leave the fleet running for 30 minutes after the last command.
- [ ] No `invalid_player_movement` kick.
- [ ] No `EPIPE`/`ECONNRESET` storm.
- [ ] `keepAlive.maxGapMs` stays below 10 s for every bot.
- [ ] A deliberate disconnect/reconnect restores the same bot once, without a
      duplicate session.
- [ ] No `automatic plan failed`; if the objective completes, a replacement is
      feasible.
- [ ] Event loop `p99` and `max` are recorded; `max` above 1 s needs an
      explanation.
- [ ] Process CPU, RSS, heap, state-snapshot time, tick time and sync time are
      recorded from `/api/state` → `overview.autonomy.performance`.
- [ ] Safety-stage breakdown is non-null per bot in
      `/api/state` → `diagnostics.bots[].safety`; record the slowest stage.

## 7. Dashboard

- [ ] `/api/state` and `/api/diagnostics/export` return valid JSON.
- [ ] The fleet page renders the new Runtime load / Snapshot / Safety stages
      rows.
- [ ] The 3D viewer loads real chunk data for at least one bot and shows its
      position; a blank canvas is a failure.
- [ ] No uncaught browser error while switching bot pages.

## 8. Pass criteria

The run passes only when Sections 1–7 are all checked and the log contains no
unexplained kick, death loop or stalled action. A partial run must be reported as
partial; simulation evidence must not be substituted for a live item.
