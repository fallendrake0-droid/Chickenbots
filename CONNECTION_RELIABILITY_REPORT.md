# Chickenbots V6 — connection reliability report

**Status:** code/unit/simulation evidence only. No live session was possible.

## Existing lifecycle

- One `ConnectionStateMachine` per bot, monotonic generation.
- States: idle, resolving, tcp_connecting, handshaking, configuration,
  awaiting_spawn, authenticating, ready, respawning, stopping, closed, failed.
- Every transition records a timestamp, stage, detail and generation.
- Terminal states ignore late callbacks from an older generation.
- Staggered joins remain `MC_JOIN_INTERVAL_MS=2000` + jitter.
- Reconnect is bounded exponential backoff with jitter and a fleet join slot.
- `live.pid` prevents two runtimes using the same roster.

## Changes in this pass

1. **Authentication no longer fabricates readiness.**
   - Plugin auth is opt-in (`MC_AUTH_PROFILE`).
   - AuthMe/SimpleAuth wait for a real challenge.
   - A missing challenge returns `AUTH_PROMPT_TIMEOUT`, sends no password, and
     does not mark the bot authenticated.
   - A manual profile keeps the socket open with `authPending:true`; the runtime
     does not convert it into a reconnect loop.
2. **Bounded credential retries.** The previous open-ended interval could
   re-send a password until timeout. Attempts are now capped.
3. **Kick classification expanded.** Categories now distinguish ban, whitelist,
   operator, duplicate login, movement, version, auth, full, throttle, restart,
   timeout, network and protocol. Only moderation/ban/whitelist/version/auth
   pause automatic retries; the others retry with backoff.
4. **Movement diagnostics and bounded strikes.** A movement kick no longer tells
   the operator to “set MC_VERSION” when the protocol was already validated. It
   logs the generation, owner, priority and version. Three consecutive movement
   rejections across sessions pause automatic retries; a ready session clears
   the strike count, and a dashboard reconnect resets it.
5. **Permanent auth failures pause.** `AUTH_REJECTED`,
   `AUTH_NOT_REGISTERED`, `AUTH_MISSING_CREDENTIAL` and
   `AUTH_PROMPT_TIMEOUT` pause the supervisor instead of looping. A transient
   confirmation timeout still retries normally.
6. **Conservative capability report.** Server brand is DETECTED; proxies,
   ViaVersion/Backwards, Geyser, Floodgate and anti-cheat are UNKNOWN unless the
   client actually observed evidence. Native Bedrock is NOT_SUPPORTED.

## Simulation evidence

A fresh 10-bot deterministic simulation was started with the updated code:

```text
10/10 ready
bot all status          10/10
bot all inventory       10/10
bot all defend          10/10 (IDLE; no threats)
batch all eat then return home  2/2 steps, 10/10 bots per step
bot all chop oak        9/10 (one bot: "no trees nearby")
```

No live session is claimed. The keep-alive gap is `null` in simulation because
the mock transport has no socket.

A previous 89-minute simulation remained stable enough to complete a base
objective, but logged **one 1,155.5 ms event-loop block at `MINE_ORE`** (p99
64.3 ms at that warning). That remains an open P2 (BUG-27-10), not a solved
performance claim.

## Still unverified

- 30–60 minute live connection on EmpiSMP.
- Real `invalid_player_movement` rate after the round-26 packet-order fixes.
- Real `EPIPE`/`ECONNRESET` causes under a ten-bot join burst.
- Real moderator/ban/whitelist wording.
- Real duplicate-login handling.
- Live keep-alive gap and inbound packet gap.
- AuthMe/SimpleAuth/Geyser/ViaVersion/GrimAC behaviour.
