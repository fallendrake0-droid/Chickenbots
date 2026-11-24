# V6 connection-lifecycle report

**Branch:** `arena/de11bd2d-chickenbots`  
**Head:** `f63ebee` (pushed)  
**Scope:** five-bot disconnect root causes, lifecycle hardening, diagnostics, tests, audit.  
**Live status:** not claimed. No live ten-minute idle run and no five-bot live-server run were performed in this environment. The local `mc.createServer` 26.1 harness stopped at `socketClosed` before `login`, so it was not used as a join test.

## 1. Executive summary

The strongest reproducible cause was not a timeout value. During the recorded 17:25 run the event loop was blocked for **40,869 ms** (p99 293 ms). The client ticker had completed 128 ticks and 128 `client_tick_end` packets over 48.8 s, but while the loop was blocked neither the 20 tps tick loop nor `minecraft-protocol`'s 30 s keep-alive reply could run. The last `keep_alive` was received 37.9 s before the failure; an `EPIPE` followed 0.4 s later. The block came from `minecraft-protocol` 1.68.0 decompressing each compressed frame with synchronous `zlib.unzipSync` inside its stream `_transform`, while the framing splitter drains all frames in a socket read in one turn. Five chunk bursts could therefore monopolise the loop long enough for the server to time the session out.

The fix makes decompression asynchronous, keeps the inbound socket yielding between reads, and reduces the requested view distance. The remaining five bugs were lifecycle/evidence defects: a join-time respawn treated as real, cleanup overwriting the pre-teardown booleans, a login stall pausing the whole fleet, and timer writes able to throw `EPIPE` out of a callback. Those are now bounded, generation-scoped, and covered by tests.

## 2. Observed evidence

- Lifecycle stage budgets were already stage-specific: DNS 10 s, TCP 45 s, login 30 s, configuration 15 s, spawn 45 s, auth 12 s, keep-alive warning 120 s.
- The 40.8 s stall was not disk I/O. The previous run had 128 tick ends; the loop then stopped servicing timers.
- `minecraft-data('26.1')` reports protocol **775** and `sendsClientTickEndPacket: true`.
- `minecraft-protocol` 1.68.0 and `mineflayer` 4.39.0 are installed. The latter predates the upstream tick-end fix, so Chickenbots runs its own scheduler.
- `minecraft-protocol` arms a **30 s** keep-alive timer per received `keep_alive` and replies internally. The bot's 120 s warning does not extend that deadline.
- The 26.1 wire packet ids used by tests are `tick_end 0x0d`, `keep_alive 0x1c`, `position 0x1e`, `respawn 0x52`, `update_health 0x68`.

## 3. Root causes and fixes

### BUG 1 — Bot 1 "Timed out" after READY

**Cause:** synchronous inflate of a chunk burst. The event loop could not run the tick loop, keep-alive auto-reply, or lifecycle timers. A stalled loop makes a healthy socket look dead, then raises `EPIPE` when it resumes.

**Fixes:**

- `src/protocol/asyncDecompress.js` replaces only `minecraft-protocol/src/transforms/compression`'s `createDecompressor` with a stream Transform that uses asynchronous `zlib.unzip`. Order is preserved by the stream; invalid frames now fail the connection instead of silently desynchronising it.
- `src/bot/realBot.js` installs the transform in `_loadMineflayer()` before `createBot`, so the library's real client pipeline uses it.
- `MC_INBOUND_YIELD=true` pauses the inbound socket between kernel reads.
- `MC_VIEW_DISTANCE=tiny` (6) is the default, with `short`/`normal`/`far` and 2–32 available.
- No duplicate heartbeat was added. The library still owns the keep-alive reply; the bot only counts it after the library's write returns.

### BUG 2 — respawn 368 ms after READY

**Cause:** the respawn guard keyed on a death that could belong to an earlier session; `spawnAt` resets but `lastDeath` is retained for diagnostics. A previous death could therefore make a join-time respawn look real. A respawn before spawn was also allowed to fall through into a transition attempt.

**Fix:** `deathSinceSpawn` now requires `spawnAt > 0` and a death at or after the current spawn. A respawn without that evidence is recorded as `respawn_ignored`; it cannot print `respawned`, reset the session clock, or move `READY` backwards. Covered by three lifecycle tests including a cross-session death.

### BUG 3 — authenticated/spawned flipping true → false in the snapshot

**Cause:** the `kicked`/`end` pair could run after another callback had already projected terminal booleans, so the snapshot lost the state the operator was diagnosing.

**Fix:** `_lastValidState` records the last open, spawned, non-terminal snapshot for the current generation. `_captureDisconnectSnapshot` recovers from it when live booleans were already reset, and labels the result `stateSource: 'live' | 'last-valid'`. The live transport is separately marked `_transportDead`; `connectionStatus()` reports offline immediately when the socket is unusable, so a dead bot cannot be presented as online merely because the lifecycle projection has not run.

### BUG 4 — Bot 2 "timed out after 30000ms waiting for protocol login"

**Cause:** a 30 s stage timer cannot fire while the loop is blocked. The fix above removes the block. The login timeout was not increased, and a timeout is not converted into a success.

**Fix:** the exact stage remains in `stageTimings`, `connection.stage` and the failure snapshot. A login timeout stays a per-bot retry; it is visible as `retry` metadata and in the timeline. If a server genuinely accepts TCP but never completes login, the diagnostics will now show the stage and last inbound packet instead of charging it to the whole fleet.

### BUG 5 — one bot's failure triggering a 90 s fleet cooldown

**Cause:** every join failure went through the fleet strike scheduler; a join stall was treated like a server throttle.

**Fix:** `TeamRuntime._registerJoinFailure(bot, result)` routes **only** `isThrottleError()` to the fleet scheduler. `isJoinStallError()` logs a per-bot join stall and returns `'stalled'`; it does not close the fleet join queue. The 10 s stagger remains. A test asserts one stalled bot leaves the other four sessions and `joinCooldownUntil` untouched.

### BUG 6 — EPIPE after disconnect

**Cause:** queued Mineflayer/ticker callbacks could write to a closed socket; a synchronous throw from a timer would escape as an uncaught exception.

**Fix:**

- The client write wrapper refuses writes when the generation is stale, the bot was replaced, the socket is closed, or `_transportDead` is set.
- The wrapper catches synchronous write errors, redacts them, marks the transport dead, and schedules bounded cleanup in a `setImmediate`.
- The client ticker write callback has the same guard and stops the loop on failure.
- `disconnect()` is idempotent per generation and accepts an expected generation, so a stale cleanup cannot close a replacement session.
- The library's keep-alive reply is never synthesised by Chickenbots; only successful automatic replies are counted.

## 4. Lifecycle guarantees

- `ConnectionStateMachine` remains the only authoritative manager; no second connection manager was introduced.
- Every session has a monotonically increasing generation. Old socket callbacks, old login/tcp/auth waiters and old cleanup are rejected by generation.
- Session-scoped values are reset in `_beginSession`; the pre-teardown snapshot is captured before cleanup.
- Cleanup is exactly once per generation (`_cleanupGeneration`), with `already`/`stale` results.
- Auth and spawn are projected from the lifecycle state; a respawn cannot reset `READY` to an earlier state without evidence.
- A dead transport is offline immediately; a kicked/ended session cannot stay green in the team view.
- Automatic reconnection does not depend on AI or an external model.

## 5. Server version and dependency findings

- The observed production advertisement remains **26.1**, protocol **775**. This report does **not** claim 26.3 or protocol 776/777 compatibility.
- `minecraft-data('26.1').supportFeature('sendsClientTickEndPacket')` returns `true`.
- `client_tick_end` is sent once at the end of every client tick, after that tick's movement packet; a second position-bearing packet is deferred. No duplicate `tick_end` is added after movement, and `player_loaded` is left to Mineflayer.
- `set_ticking_state` / `step_tick` are honoured, including camelCase aliases.
- No new dependency was added; `package-lock.json` is unchanged.

## 6. Pre-teardown diagnostic snapshot

Captured before transport cleanup, with redaction:

`generation/sessionId`, lifecycle state and stage, connected/spawned/authenticated/ready, `lastValidState`, `stateSource`, last error, kick kind, position/server position, last spawn, stage timings, keep-alive received/replies/last times/max gap, ticker counters, `lastEventAt`/age, last inbound packet, last client packet, pending socket bytes, login/spawn timestamps, client protocol state, server ticking state, and the bounded lifecycle timeline.

The dashboard Connections page renders lifecycle/retry information and a link to `/api/diagnostics/export`. That endpoint returns `{exportedAt, note, state, logs[500]}` as a JSON attachment. Credentials and command-bearing auth text remain redacted; the controllers test checks that a configured password is absent from the export.

## 7. Tests

Current suite: **268 passed, 0 failed**. Lint: **PASSED (146 files)**. Validation: **PASSED**, consistency **10/10**, secret check passed, 1120 schematics.

The 20 requested scenarios are covered by the lifecycle/runtime/protocol/controller tests, including:

1. stale events from a replaced socket;
2. stale-generation disconnect cannot close the new session;
3. cleanup exactly once per generation;
4. failure snapshot keeps the exact stage;
5. kick pre-cleanup snapshot;
6. last-valid READY recovery;
7. respawn without death ignored;
8. real respawn after death still honoured;
9. join-time respawn while auth pending;
10. cross-session death cannot fake a join respawn;
11. exactly one `tick_end` per tick;
12. second movement packet deferred;
13. no duplicate keep-alive reply;
14. dead transport refuses writes / `EPIPE` path;
15. stage-specific timeout classification;
16. one bot stall does not pause the fleet;
17. a real throttle still pauses the fleet;
18. five independent generations and tick loops;
19. version probe gates login sockets;
20. retry metadata and redacted diagnostics export.

Protocol tests also cover the async decompressor: idempotent installation, compressed round-trip, uncompressed frames, and invalid compressed input (**4/4**).

## 8. Live-test limitation

**No live ten-minute stationary idle test of all five bots was run.** No live five-bot Aternos session was conducted from this sandbox. The local 26.1 `mc.createServer` + Mineflayer harness ended with `socketClosed` before `login` and was abandoned; it was not used to claim a join or an idle pass. The fixes are therefore supported by the recorded 40.8 s stall evidence, unit/integration tests and static protocol checks, not by a new live success.

If the server still disconnects a bot, the next diagnostic export should settle whether the remaining cause is a server/proxy timeout or a client stage. A live run should capture `stageTimings`, `lastInboundPacket`, `pendingBytes`, `lastEventAgeMs`, ticker counters and the disconnect timeline.

## 9. Configuration/deployment

- Default server remains `EmpiSMP.aternos.me:32990`; the fixed roster is now ten usernames.
- No new required environment variable.
- `MC_VIEW_DISTANCE=tiny` and `MC_INBOUND_YIELD=true` are defaults; lower the distance to 2–5 only if the event-loop metrics still show pressure.
- `LOG_LEVEL=debug` remains opt-in; packet tracing remains separately gated.
- Dashboard remains loopback-only unless explicitly configured; the bind guard and control-plane auth were not weakened.

## 10. Verification commands

```text
npm run lint        PASSED (146 files)
npm test            268/268 passed
npm run validate    PASSED (secret + lint + tests + 1120 schematics + consistency 10/10)
git checkout -- data/schematics/validation-report.json   # report reverted
```

## 11. Commits

- `ee891b6` — version probe wait, false respawn wording, harder lifecycle.
- `d9e31ae` — tiny view distance, inbound yield, timing instrumentation.
- `a77555a` — ignore death-less respawn outside `RESPAWNING`.
- `0d890c5` — async decompression, BUG 3 snapshot recovery, BUG 5 scope, retry visibility, diagnostics export.
- `3532f03` — timer write guards, per-bot join-stall isolation.
- `4ee7567` — cross-session death evidence and stale cleanup guards.
- `0d7a02a` — socket write failures routed through bounded cleanup.
- `f63ebee` — retry-metadata coverage and this report.

All are pushed to `origin/arena/de11bd2d-chickenbots`.

## 12. Honest conclusion

The synchronous-decompression event-loop block is a real, measured root cause and is now removed. The respawn, snapshot, join-scope and EPIPE defects are fixed at their lifecycle boundaries and covered by tests. The team is still not claimed as live-verified for a ten-minute idle run or a five-bot join. That is the remaining acceptance gap, and it needs a real server run with the redacted diagnostics export.
