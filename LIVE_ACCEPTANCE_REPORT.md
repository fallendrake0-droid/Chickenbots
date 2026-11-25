# Chickenbots V6 — live acceptance report

**Status: NOT RUN. No live result is claimed.**

The Arena sandbox has outbound access only to package registries and GitHub. It
cannot reach `EmpiSMP.aternos.me:32990`. All live criteria below remain open.

## What *was* run

- 327 unit/regression tests.
- Lint over 151 files.
- `npm run validate`, `deploy:check`, `check:secrets`.
- A fresh 10-bot deterministic simulation with real command dispatch.
- HTTP exercise of the dashboard, state/settings/logs/world/diagnostics endpoints.
- CLI one-shot simulation status.

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

1. Ten staggered joins, no duplicate sessions.
2. `bot all status` → ten ready, with auth state truthful.
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
