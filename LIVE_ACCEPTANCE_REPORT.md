# Chickenbots V6 — live acceptance report

**Status: NOT RUN. No live result is claimed.**

_Round 35 update: the second supplied live log (18:27–19:39 UTC) is addressed in
`V6_ROUND_35_REPORT.md`; simulation-only performance numbers are in
`PERFORMANCE_REPORT.md`; plugin/auth evidence is in `PLUGIN_COMPATIBILITY.md`
and `AUTHENTICATION_REPORT.md`. None of that substitutes for a live run._

The Arena sandbox has outbound access only to package registries and GitHub. It
cannot reach `EmpiSMP.aternos.me:32990`. All live criteria below remain open.

## What *was* run

- 420 unit/regression tests (round 35).
- Lint over 171 files.
- `npm run validate`, `deploy:check`, `check:secrets`.
- A fresh five-bot deterministic simulation with real command dispatch.
- HTTP exercise of the dashboard (`/api/state` ten times plus `status` and
  `chop all` commands); state/settings/logs/world/diagnostics endpoints.
- CLI one-shot simulation status.
- `perf:status`: cold 96 ms, warm-up 5 ms, warm p50/p95/max 2/7/7 ms.
- A status-cache freshness check (`maxActionStatusAgeMs` 8.7 s, fresh true).

## What was **not** run

- Any TCP connection to a Minecraft server.
- Any AuthMe, SimpleAuth, Geyser, ViaVersion, Velocity/BungeeCord or GrimAC test.
- Any live `invalid_player_movement`, EPIPE, ECONNRESET or kick reproduction.
- Any live block placement, mining, chopping, combat or death/respawn result.
- Any browser interaction or 3D canvas render.

## Live procedure

Run on a host that can reach the target server:

```bash
node src/index.js --host 0.0.0.0 --port 3000 2>&1 | tee V6_LIVE_RUN.log
```

Then follow `V6_LIVE_ACCEPTANCE.md` (the detailed checklist) and record:

1. Five staggered joins, no duplicate sessions.
2. `bot all status` → five ready, with auth state truthful.
3. Authentication profile: `none` or an explicitly configured challenge-driven
   profile. Confirm no `/login`/`/register` is sent without a prompt.
4. 30-minute idle/ordinary-movement soak.
5. `keepAlive.maxGapMs` and last-packet age per bot.
6. `invalid_player_movement`, `EPIPE`, `ECONNRESET` counts before/after.
7. A deliberate disconnect/reconnect.
8. A bot death and respawn; equipment re-scan.
9. `bot all chop oak`, `bot all mine iron`, inventory, batch commands with real
   world-verification evidence.
10. Dashboard `/api/state`, `/api/settings`, `/api/world`, SSE reconnect and the
    3D canvas.

## Pass/fail rule

A simulation result may not be pasted into a live field. A live criterion is
PASS only with the actual server log/diagnostic export attached. Until then the
status is UNVERIFIED.
