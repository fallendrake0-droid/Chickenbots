# Chickenbots V6 — round 25: the fleet must not leave EmpiSMP

**Branch:** `arena/de11bd2d-chickenbots`
**Base:** `7764c410934a71bc22d69bb1ef1fad5647e0e640` (`main`)
**Scope:** stability first. No new gameplay feature in this round.

> **Honest boundary:** this sandbox can reach package/GitHub hosts, not
> `EmpiSMP.aternos.me:32990`. No live ten-bot run is claimed below. The live
> acceptance procedure is at the end; `V6_FINAL_REPORT.md` is deliberately not
> rewritten from simulation evidence.

## What the 03:19 live run actually showed

The previous round's logs recorded four sessions dropping in under two minutes:

```text
ECONNRESET
EPIPE ×3
Kick: invalid_player_movement
inbound packet gap 31,773 ms
event loop blocked 1,139.8 ms
```

Four separate faults line up with those symptoms, and each has a code fix below:

1. Ten bots at view distance 6 forced one process to hold 1,690 chunk columns.
2. Autonomy started pathfinders in the same second as the last spawn chunk burst.
3. Ten controller actions were awaited inside one interval tick, so keep-alive and
   `tick_end` waited behind a pathfinder.
4. A terminal kick left `bot.connected === true`; `connect()` then short-circuited
   with `already: true`, so the supervisor could not open a new session.

## Changes in this round

### 1. Chunk load is capped and no path starts on an unloaded column

- `MC_VIEW_DISTANCE` defaults to **2** (25 columns per bot). An older `.env`
  saying `tiny` (6) is accepted but capped by `MC_VIEW_DISTANCE_MAX=2`; startup
  logs the clamp instead of replaying the 26s freeze.
- Live autonomy waits `AUTONOMY_WARMUP_MS=20000` after the tenth bot is ready.
- `RealBot.isChunkReady()` checks the block under the entity. The runtime gives a
  bot safety-only work until that column exists, so no pathfinder runs against a
  half-streamed world.

### 2. The autonomy tick no longer awaits ten pathfinders

- `_launchBotWork()` gives each ready bot at most one in-flight step and caps the
  fleet at `AUTONOMY_CONCURRENCY=4`. The remaining bots still run safety work.
- `ACTION_TIMEOUT_MS=60000` watchdog: `RealBot.cancelAction()` stops the path,
  stops digging, clears control states and holds movement for 500ms, so a hung
  controller cannot own a slot forever.
- Pathfinder budgets are cooperative: 2,500ms total, 10ms per turn, radius 64.

### 3. Freeze recovery prevents the movement kick instead of retrying it

- `src/bot/clientTicker.js` reports a late 20 tps loop. At
  `CLIENT_STALL_GUARD_MS=2500` the bot stops the stale path, re-anchors its entity
  to the last server position, zeros velocity and holds movement for
  `CLIENT_STALL_RESUME_MS=1500`.
- The outgoing write guard drops position-bearing packets while the ticker is
  stale or the resume window is open.
- A freeze of 5s or more schedules one real `swingArm()` write. If the socket
  outlived the server session, that write surfaces `EPIPE` and triggers the
  existing reconnect path instead of a zombie “online”.
- A server `forcedMove` (teleport/correction) stops the current path and holds
  movement for 400ms, so the next plan is built from the server's position.
- No retry/backoff was added for `invalid_player_movement`; the movement is
  prevented. Paper's snake_case kick is now classified as a retryable protocol
  rejection, not a moderation kick.

### 4. A kicked bot can actually reconnect

- `connect()` short-circuits only when `connected && !_transportDead`. A terminal
  kick sets `_transportDead`, so the supervisor can open a fresh session.
- The zombie socket is closed before the new session, avoiding the “logged in
  from another location” duplicate-login kick.
- `_recoverDisconnected()` trusts `status.transportConnected`, not the legacy
  `bot.connected` boolean.
- The reconnect supervisor has its own 1.5s timer, independent of long actions.
- `MC_KEEPALIVE_MS=60000` and `MC_STALE_AFTER_MS=45000` are three missed
  keep-alives, not 6–8. A silent NAT/proxy drop is reconnected in under a minute.
- The PID lock is now `src/liveLock.js` and is shared by the dashboard **and** the
  CLI. A second live process would log in the same ten usernames and cause the
  duplicate-login kick this round is trying to eliminate.

### 5. No operator command races autonomy

`runtime.runExclusive(name, fn)` cancels the bot's autonomous step, keeps its
slot closed, and runs the command. `bot <name|all> <action>` uses it; read-only
views (`status`, `where`, `inventory`, `combat`) stay instant. A fleet command
therefore cannot fight a pathfinder on the same bot.

### 6. The other “stuck” bug: a full home chest

The previous round's simulation logged six `home storage failed: no free block
beside the existing home chest` lines and then `automatic plan failed`. Six bots
re-scanned a full anchor chest every 15s. `makeRoomAtHome()` now:

- places the crafted chest on any other clear ground near home when the anchor
  has no adjacent site;
- reports `singleChestFallback` / `singleChestAlternative`;
- tries a newly placed empty chest before the full anchor in the single-half
  fallback.

A boxed-in-anchor test covers the exact failure (anchor full of 1,728 cobblestone,
overflow dirt/planks) and asserts `ok:true`, one placed chest with items, and
`preDeposit.moved > 0`.

### 7. Less event-loop noise during a join

- Status caches in mining/farming/fishing/sleep use per-bot jitter, breaking the
  synchronised expiry that made ten scans land in one turn.
- Inbound-gap warnings are throttled to one per 5s (every >10s gap still logs).
- Packet traces are DEBUG unless `MC_TRACE_PACKETS=true`; a disconnect no longer
  performs 20 synchronous ERROR writes while reconnecting.
- The event-loop WARN names the phase that was executing
  (`state-sync`, `coordinator`, `launch-actions`, `action:<bot>:<type>`).

## Verification performed here

```text
npm test             293 passed, 0 failed
npm run lint         PASSED (148 files)
npm run validate     PASSED
                     secret leak check PASS
                     lint PASS
                     tests PASS 293/293
                     schematics validation PASS
                     consistency 10/10
```

New/updated tests:

- `tests/connection-lifecycle.test.js` — dead transport retries, 5s swing probe,
  freeze re-anchor, `goTo` refuses to start inside the resume window, chunk
  readiness, view clamp, keep-alive/stale defaults.
- `tests/runtime-safety.test.js` — action watchdog, status-cache budget, reconnect
  supervisor independent of pause, exclusive operator slot.
- `tests/home-storage.test.js` — boxed-in chest still stores overflow.
- `tests/audit-regressions.test.js` — `invalid_player_movement` is retryable.

Simulation evidence (`node src/index.js --simulate`, 10 bots):

```text
[11001100] home storage: single chest at 3,65,0; deposited 233 items, kept 20 protected stacks
[11101000] home storage: double chest at 3,65,0; deposited 184 items
[10001000] home storage: double chest at 3,65,0; deposited 530 items
[10101000] home storage: double chest at 3,65,0; deposited 535 items
[11001010] home storage: double chest at 3,65,0; deposited 535 items
[11101001] home storage: double chest at 3,65,0; deposited 564 items
```

Zero `home storage failed` in the run. Fleet fan-out during autonomy returned
`bot all inventory → 10 completed / 0 failed`, and `bot all chop oak → 6 completed
/ 4 honest “no tree” failures` — no result was invented.

## What still requires the real server

The following are **not** proven until the next EmpiSMP run:

- The ten sessions stay connected for at least 30 minutes.
- No `invalid_player_movement` / `EPIPE` / `ECONNRESET` appears after the spawn
  burst.
- A deliberately kicked bot (operator `/kick`) rejoins without a duplicate-login
  kick.
- The host's CPU can absorb view distance 2 for ten bots; check
  `event loop blocked` WARNs and `Freeze guard` on the Connections page.

### Live acceptance checklist

1. Stop any other runtime; confirm `data/runtime/live.pid` belongs to the process
   you intend to run.
2. Start `npm start` (or `node src/index.js --live`). Expect one
   `live protection: chunk view 2, autonomy warm-up 20s, 4 concurrent actions`
   line.
3. Wait for all ten `spawned` lines, then the 20s warm-up line.
4. Watch the Connections page: `Client ticks` should stay near 20 tps, `Freeze
   guard` should show 0 recoveries and 0 held packets.
5. Run `bot all status`, then `bot all inventory`; both must return 10 rows.
6. Have an operator kick one bot. It must return to READY within the reconnect
   backoff, with no second kick for duplicate login.
7. Leave the fleet idle for 30 minutes. A single `inbound packet gap` under 10s is
   not a failure; a kick is.
