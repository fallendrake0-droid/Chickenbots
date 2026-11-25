# Chickenbots V6 — bug ledger

**Branch:** `arena/de11bd2d-chickenbots`
**Baseline:** `00c3dc9`
**Scope:** platform-compatibility/auth/connection/command audit pass
**Evidence boundary:** no live server was reachable from this sandbox. A status
of `FIXED` means the code path and regression tests were executed here, not that
a live server accepted it.

| ID | Sev | Component | Symptom / reproduction | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| BUG-27-01 | P0 | Auth sender | One `/login` could be re-sent every ~250–4000 ms until the timeout | `_sendAuthCommand` armed an open-ended retry interval | Attempts are capped by the profile (2 for AuthMe/SimpleAuth, 3 legacy generic, never above 5) | `auth attempts are bounded by the profile` | FIXED (unit) |
| BUG-27-02 | P0 | Auth architecture | Every profile was hard-locked to `disabled`; operators could not select offline/microsoft/AuthMe/SimpleAuth | One legacy boolean and a validation rule that rejected all auth | Added explicit `MC_AUTH_PROFILE` profiles with validation; default remains `none` | `auth profiles are explicit...`, config profile test | FIXED (unit) |
| BUG-27-03 | P0 | Auth challenge | A configured profile would have sent a password on spawn without proving the server asked | No challenge gate; prompt text only raised a manual flag when auth was off | `_waitForAuthChallenge` blocks until the server prompt; no prompt returns `AUTH_PROMPT_TIMEOUT` with no command sent | `authme waits for a real challenge...` | FIXED (unit) |
| BUG-27-04 | P1 | Credentials | Only one fleet-wide password existed; per-bot passwords could leak through chat/errors, including a server echo of `/login secret` | Single global `loginPassword`; redaction only knew global values; auth failure stored raw server text | Added ignored `.mc-auth.json` loader, per-bot credentials, and redaction of every stored auth reply | `per-bot credentials are redacted...`; echoed-command test | FIXED (unit) |
| BUG-27-05 | P1 | Kick classification | Bans, whitelist, duplicate login, movement, version, auth, full and network errors were collapsed into generic/operator/protocol | `classifyKick` had four broad branches | Explicit categories with retry/pause policy and labels | classifier assertions in `audit-regressions` | FIXED (unit) |
| BUG-27-06 | P1 | Movement diagnostics | A movement kick logged “set MC_VERSION”, although version 26.1/protocol 775 was already validated | Historical warning assumed a version mismatch | Logs generation, movement owner/priority and version; states it is not a version guess | source audit; movement tests | FIXED (code) |
| BUG-27-07 | P1 | Plugin compatibility | No capability report existed; a guessed plugin list could have been mistaken for detection | No adapter/capability layer | Added conservative detector: brand/protocol/prompt are evidence; Via/Geyser/Floodgate/anti-cheat stay UNKNOWN unless exposed | `capability detection never guesses...` | FIXED (unit) |
| BUG-27-08 | P1 | Manual auth | A `manual` profile would have failed the connect path or been reported ready | Auth had only “send” or “disabled” outcomes | Added a pending auth result; the spawned socket stays open, gameplay is gated, no reconnect loop | `manual auth stays pending...` | FIXED (unit) |
| BUG-27-15 | P1 | Movement retries | Repeated `invalid_player_movement` kicks could reopen the join queue forever | Movement was categorised as retryable with no strike limit | Three consecutive movement rejections across sessions pause retries until an explicit dashboard reconnect; a ready session clears the count | `three consecutive movement rejections...` | FIXED (unit) |
| BUG-27-16 | P1 | Registration | A `not registered` login reply could auto-send `/register` even when registration was disabled | The recovery branch ignored the registration flag | Auto-create now requires `MC_AUTH_REGISTRATION_ENABLED`; otherwise the result is `AUTH_NOT_REGISTERED` | `a not-registered reply does not auto-create...` | FIXED (unit) |
| BUG-27-17 | P1 | Auth retry loop | `AUTH_REJECTED`, `AUTH_NOT_REGISTERED`, `AUTH_MISSING_CREDENTIAL` and a missing challenge could be retried by the supervisor | Only `AUTH_FAILED` was recognised as permanent | Central `shouldPauseAuthRetry` pauses those codes; a transient confirmation timeout still retries | `permanent auth failures pause retries...` | FIXED (unit) |
| BUG-27-09 | P1 | Fleet chop | Repeated `bot all chop oak` runs returned 10/10, 9/10, 8/10 and 8/10; misses report `no trees nearby` | Tree allocation exhausts nearby trees for the last bots | Round 31: per-bot search widens to 48 blocks and relocates to a distinct forest bearing | round-31 chop/relocation tests | FIXED (unit) |
| BUG-27-10 | P2 | Long simulation | An 89-minute simulation logged one 1,155.5 ms event-loop block at `MINE_ORE`; the final-build simulation hit 1,433.4 ms (p99 62.7 ms) | Large block/scan work inside an action phase | Not fixed in this pass; bounded-stage instrumentation remains | metrics in `V6_ROUND_27_REPORT.md` | OPEN |
| BUG-27-11 | P0 | Live movement | Real `invalid_player_movement` kicks were reported on the live server | Cannot reproduce without a reachable server | Packet-order fixes from round 26 remain; new category/diagnostics added | round-26 tests; live still untested | UNVERIFIED LIVE |
| BUG-27-12 | P0 | Live survival | Repeated zombie deaths and `NaNm` were reported live | Mock-world tests cannot prove live threat timing | Round-26 spawn/recovery fixes remain; no new live claim | round-26 tests | UNVERIFIED LIVE |
| BUG-27-13 | P0 | Native Bedrock | A Java Mineflayer client cannot join a Bedrock UDP endpoint | No Bedrock transport exists | Reported as `NOT_SUPPORTED` in capabilities; no fake adapter | capability test asserts NOT_SUPPORTED | NOT IMPLEMENTED |
| BUG-27-14 | P1 | AuthMe/SimpleAuth integration | No live AuthMe or SimpleAuth server was available | Sandbox/network limitation | Adapters are configuration profiles with unit tests only | `plugin-compat.test.js` | UNVERIFIED LIVE |

## Round 29 — large hardening pass

**Starting head:** `62f1650`
**Evidence:** unit tests only. No live server was reached.
**Gate:** 370/370 tests, lint 158 files, consistency 10/10, deploy 12/12,
secret check 190 files.

| ID | Sev | Component | Symptom / reproduction | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| BUG-29-01 | P0 | Schematic import | A huge import could exhaust memory | No input/inflated/block caps | `src/schematics/limits.js`; 64 MB input and inflated, 2 M blocks, 4 M volume, 4096 dimension, 65 536 palette | `schematic-safety.test.js` | FIXED (unit) |
| BUG-29-02 | P0 | Gzip import | A gzip bomb inflated without a bound | `gunzipSync` had no output cap | `safeGunzip` with `maxOutputLength` | `schematic-safety.test.js` | FIXED (unit) |
| BUG-29-03 | P0 | Sponge import | `BlockData` length/stride was trusted | Out-of-bounds decoding | Validate length before decode | `schematic-safety.test.js` | FIXED (unit) |
| BUG-29-04 | P0 | Async decompression | The async path dropped the length check | Two decompressors diverged | Shared cap; oversized output rejected | `protocol-compression.test.js` | FIXED (unit) |
| BUG-29-05 | P1 | Task board locks | Expired reentrant locks leaked; heartbeat renewed only the task lock | Expiry skipped when `reentrant > 1` | Expiry authoritative; heartbeat renews owned locks/regions | `team.test.js` | FIXED (unit) |
| BUG-29-06 | P1 | World viewer | Malformed entity coordinates crashed the snapshot | `NaN`/`Infinity` trusted | Validate and skip malformed entities | `world-view.test.js` | FIXED (unit) |
| BUG-29-07 | P2 | Command history | `logStore.recent` with a bad `since` | Invalid timestamp comparison | Parse/validate; invalid falls back | `log-store.test.js` | FIXED (unit) |
| BUG-29-08 | P1 | Command params | `--params` could set prototype keys | No key filtering | Reject `__proto__`/prototype keys | `command-params.test.js` | FIXED (unit) |
| BUG-29-09 | P1 | Home command | `setHome` accepted `NaN`/out-of-world positions | No coordinate validation | Finite in-world coordinates required | `runtime-home.test.js` | FIXED (unit) |
| BUG-29-10 | P1 | Dashboard download | Crafted filename injected `Content-Disposition` | Unsanitised filename | Sanitise and quote filename | `dashboard-filenames.test.js` | FIXED (unit) |
| BUG-29-11 | P1 | Custom library | Custom schematic reads had no size bound | Missing cap | Same input cap as importer | `schematic-safety.test.js` | FIXED (unit) |
| BUG-29-12 | P1 | Resource ledger | `commit` could exceed a reservation and release it | No `remaining` clamp | Clamp to remaining, report excess | `team.test.js` | FIXED (unit) |
| BUG-29-13 | P1 | Plan quotas | `splitQuota` crashed on 0/NaN/negative parts | Unclamped array length | Parts 1…1000; quota non-negative integer | `team.test.js` | FIXED (unit) |
| BUG-29-14 | P1 | Site survey | Invalid footprint produced `Infinity`/`NaN` stats | No dimension validation | Finite positive dimensions required | `construction.test.js` | FIXED (unit) |
| BUG-29-15 | P1 | Woodcutting | Null block threw; failed digs counted as harvested | Unchecked block read/result | Clean error; only verified digs count | `woodcutting-safety.test.js` | FIXED (unit) |
| BUG-29-16 | P1 | Schematic validation | Malformed/missing `knownBlocks` threw | No defaults | Defensive defaults and dimension checks | `schematic-safety.test.js` | FIXED (unit) |
| BUG-29-17 | P1 | Imported geometry | Non-finite coordinates entered the schematic | No finite filter | Filter/validate coordinates | `schematic-safety.test.js` | FIXED (unit) |
| BUG-29-18 | P1 | Sponge import | Truncated `BlockData` gave a silent 0-block design | Truncation treated as empty | Explicit truncation error | `schematic-safety.test.js` | FIXED (unit) |
| BUG-29-19 | P1 | Excavation regions | A 1×1 region was split into two identical boxes, double-counting volume | `size < 2` branch pushed a duplicate | Stop splitting when the longer axis is 1 | `excavation.test.js` | FIXED (unit) |
| BUG-29-20 | P1 | Excavation regions | Empty roster produced `bot: undefined` | Pool indexed with `NaN` | Structured empty-pool error | `excavation.test.js` | FIXED (unit) |
| BUG-29-21 | P2 | Excavation executor | `progressEvery` 0/NaN disabled progress | `% NaN` comparison | Positive integer at construction | `excavation-exec.test.js` | FIXED (unit) |
| BUG-29-22 | P1 | Excavation executor | Stopped executor could be relabelled running | `resume()` ignored token state | Terminal token state respected | `excavation-exec.test.js` | FIXED (unit) |
| BUG-29-23 | P1 | Excavation manager | Terminal excavation accepted pause/resume/stop | No status preconditions | Terminal calls return `ok:false` + summary | `excavation-exec.test.js` | FIXED (unit) |
| BUG-29-24 | P1 | Builder/construction lifecycle | `pause()` left `state='RUNNING'`; resume impossible; cancel reversible; completed projects accepted pause/cancel | Boolean-only pause and no terminal guards | Real `PAUSED` state, start/resume guards, terminal project guards | `v4-features.test.js`, `construction.test.js` | FIXED (unit) |
| BUG-29-25 | P1 | Task board transitions | Late `fail`/`cancel` resurrected terminal tasks | No terminal check | Terminal transitions rejected; repeated complete idempotent | `team.test.js` | FIXED (unit) |
| BUG-29-26 | P1 | Task board claims | `claim/start/heartbeat` restarted terminal tasks | No terminal check | All three reject terminal status | `team.test.js` | FIXED (unit) |
| BUG-29-27 | P2 | Task progress | `NaN`/`Infinity` progress poisoned objective totals | No finite validation | Return `null`, leave task unchanged | `team.test.js` | FIXED (unit) |
| BUG-29-28 | P2 | Builder chunking | 0/NaN chunk size created one giant task and a spread RangeError | `Math.max(8, NaN)` is `NaN` | Finite default 96, minimum 8 | `v4-features.test.js` | FIXED (unit) |
| BUG-29-29 | P1 | Dashboard snapshot | One throwing subsystem blanked the snapshot | Unguarded `status()` calls | Per-subsystem error rows | `dashboard-status.test.js` | FIXED (unit) |
| BUG-29-30 | P2 | Library statistics | Empty manifest gave `Infinity`/`NaN` stats | `Math.min(...[])` and divide by zero | Zeroed empty statistics | `schematics.test.js` | FIXED (unit) |
| BUG-29-31 | P1 | Construction materials | Partial reservation stayed held after a shortage | No rollback | All-or-nothing reservation release | `construction.test.js` | FIXED (unit) |
| BUG-29-32 | P0 | Excavation verification | Sampled scans could claim complete; blocked access/missing ores ignored | Completion derived from an estimate and partial checks | `provisionalComplete`; access/ore/dimension gate | `excavation.test.js` | FIXED (unit) |
| BUG-29-33 | P0 | Excavation planner | Huge radius enumerated billions of cells before limit check | Geometry generated before validation | Validate finite/≤4096 and pre-check volume | `excavation.test.js` | FIXED (unit) |
| BUG-29-34 | P2 | Flatten planning | No finite heights produced a null target | Empty sample accepted | Explicit error | `excavation.test.js` | FIXED (unit) |
| BUG-29-35 | P1 | Weapon selection | `switchTo` recommended another low-durability weapon | Wrong variable semantics | Healthy replacement only when chosen weapon is at risk | `combat.test.js` | FIXED (unit) |
| BUG-29-36 | P1 | Combat status | Dashboard polling committed focus, reset hysteresis, inflated stats; positionless focus crashed planning | `status()` called mutating `assess()` | Read-only status path; positionless focus returns no offset | `combat.test.js` | FIXED (unit) |
| BUG-29-37 | P1 | Construction phases | `runPhase()` restarted COMPLETE/CANCELLED projects | No terminal guard | Terminal projects refuse phase execution | `construction.test.js` | FIXED (unit) |
| BUG-29-38 | P2 | Construction summary | Missing optional fields crashed `summary()`; zero phases divided by zero | Unguarded access | Safe defaults; 100% for zero phases | `construction.test.js` | FIXED (unit) |
| BUG-29-39 | P1 | Excavation lighting | Torches placed above the cleared cell with no support | Wrong torch cell | Place in cleared cell only with solid floor | `excavation-exec.test.js` | FIXED (unit) |
| BUG-29-40 | P2 | Woodcutting | Navigation failure silently truncated a tree | No error field | `partial` + concrete error | `woodcutting-safety.test.js` | FIXED (unit) |
| BUG-29-41 | P2 | Plan labels | Degraded parts produced `(1/0)` labels | Label used raw `parts` | Use real quota count | `team.test.js` | FIXED (unit) |
| BUG-29-42 | P1 | Block scanning | `findBlocks(null)` threw; unbounded radius hung a sync scan | Default evaluated `bot.position`; no clamp | Null/non-finite returns `[]`; radius ≤128, limit ≤2000 | `connection.test.js` | FIXED (unit) |
| BUG-29-43 | P2 | Exploration | `Infinity` steps created an unbounded navigation loop | No step clamp | Steps clamped to 1…64 | `v4-features.test.js` | FIXED (unit) |

Open from previous rounds: **BUG-27-09** (fleet chop exhausts nearby trees;
fixed in round 31), **BUG-27-10** (maximum event-loop block, previously 1,433.4 ms at `MINE_ORE`),
and all live-only items. Full detail: `V6_ROUND_29_REPORT.md`.


## Round 30 — dashboard event-loop starvation

**Starting head:** `48bab31`
**Evidence:** operator log 2026-11-25 16:32:53–16:41:22 UTC; unit tests and
deterministic simulation only. No live server was reached.
**Gate:** 376/376 tests, lint 159 files, consistency 10/10, deploy 12/12,
secret check 192 files.
**Symptom:** dashboard snapshots blocked the event loop for 1.7–38.3 s;
client ticks ran 3.5–38.9 s late, packet gaps reached 27–65 s, eight bots were
dropped at once and join stages hit 30 s/45 s timeouts.

| ID | Sev | Component | Symptom / reproduction | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| BUG-30-01 | P0 | Dashboard snapshot | `dashboard state snapshot took` 8–38 s; watchdog reported a 38.8 s block and every client tick was late | Mining/farming/fishing/sleep `status()` synchronously scanned ~300 k world positions per fleet snapshot with no deadline | Roster/controller-staggered TTLs, long-displacement thresholds, 8 ms per-scan budget (`STATUS_SCAN_BUDGET_MS`) | `dashboard-performance.test.js` | FIXED (unit) |
| BUG-30-02 | P0 | Block scanning | Surface scans bypassed the indexed world search and built a block object per position; fallback could not be interrupted | `world.findBlocks` was skipped when `yFrom`/`yTo` was set; no `blockNameAt` on the real world view | Indexed `RealBot.findBlocks`, name-only `blockNameAt`, y-outward bounded fallback | `dashboard-performance.test.js` | FIXED (unit) |
| BUG-30-03 | P1 | Status caches | All ten bots rescanned in the same snapshot; farming re-counted animals on every poll | Jitter used `charCodeAt(0)` (only `0`/`1`); animals outside the cache | Whole-name hash, 11 slots, controller offsets; animals cached with crops | `dashboard-performance.test.js` | FIXED (unit) |
| BUG-30-04 | P1 | Dashboard transport | Every SSE tick/request rebuilt the full snapshot | `snapshot(true)` on all readers defeated the 500 ms cache | Coalesced snapshot for readers; explicit invalidation after commands | `dashboard-status.test.js` | FIXED (unit) |
| BUG-30-05 | P1 | Snapshot assembly | Team combat status built 2–3× per snapshot; excavation, board stats and deadlocks twice; each pass rescanned entities/equipment | No reuse between `combatTeam.status()`, `runtime.state()` and per-controller statuses | Reuse action combat objects and pass team status to `runtime.state`; single excavation/board computation | `dashboard-performance.test.js` | FIXED (unit) |
| BUG-30-06 | P2 | Diagnostics | Slow snapshots named no subsystem; watchdog blamed `state-sync` for a timer block | No section timings; `_lastPhase` only tracks the tick | Per-section timings in the snapshot; warning breakdown; `recordExternalWork('dashboard-snapshot')` | `dashboard-performance.test.js`, `dashboard-status.test.js` | FIXED (unit) |
| BUG-30-07 | P2 | Status scan ordering | A bounded scan could spend its budget on deep buried layers | `findBlocks` iterated y bottom-up | Walk y outward from the bot | `dashboard-performance.test.js` | FIXED (unit) |

Open from previous rounds remain unchanged: **BUG-27-10** (1,433.4 ms
long-simulation maximum at `MINE_ORE`) and all live-only items. Stall-aware
grace for join-stage timeouts is listed as a candidate in
`V6_ROUND_30_REPORT.md` but was not implemented.


## Round 31 — five-bot roster, reachable chopping and player controls

**Starting head:** `d16458d`
**Evidence:** unit tests, deterministic simulation and a local dashboard
served on `0.0.0.0:3000`. No live server was reached.
**Gate:** 387/387 tests, lint 163 files, consistency 10/10, deploy 13/13,
secret check 197 files.

| ID | Sev | Component | Symptom / reproduction | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| BUG-31-01 | P0 | Fleet roster | Operator asked for five bots; the runtime, doctor, deploy check, dashboard copy and tests still required ten names | Fixed ten-name roster in `src/config.js` | Reduced to the first five names (`________`, `10101000`, `01010100`, `11001100`, `00110000`); all roster assertions now use the five-name list or `BOT_NAMES.length` | `team.test.js`, `controllers.test.js`, `dashboard-status.test.js`, `fleet-commands.test.js`, `deploy-check` | FIXED (unit) |
| BUG-31-02 | P0 | Woodcutting reach | `chop` could report `no tree was chopped` on a real trunk | `chopTree` started at the crown and aborted on the first unreachable top log | Chop lowest log upward, stand beside the trunk when needed, stop only at a genuinely unreachable upper log, verify each removal with `getBlock` | `woodcutting-safety.test.js` tall-trunk test | FIXED (unit) |
| BUG-31-03 | P1 | Chop search | Direct `chop`/`bot all chop` returned `no trees nearby` and never looked farther | `woodcutting.tick()` only scanned 24 blocks; the command had no relocation path | Widen to 48 blocks; `chop` passes `relocate: true`; each bot walks its own bearing and honestly reports an empty fresh site | `tick widens the search...`, `relocate walks...`, `bot all chop` simulation | FIXED (unit) |
| BUG-31-04 | P0 | Player interactions | No way to follow, guard, escort, give loot or message a real player from the dashboard | No player directory or per-bot player controller existed | Added `PlayerRegistry`, `PlayerController`, runtime wiring, `playerWatch` snapshot, `players` commands and the Players page | `players.test.js` (follow, guard, give, loot, message, command, snapshot) | FIXED (unit) |
| BUG-31-05 | P0 | Loot drops | A loot drop could strip the team's working reserves or silently drop only one stack | No reserve accounting; one `tossItem` call per item | Protect gear/food/reserves; stack-sized verified toss loop with `partial`/`remaining` | `loot drop keeps tools, totems, food and configured reserves` | FIXED (unit) |
| BUG-31-06 | P1 | Player directory | A server-list player with no entity showed `health: 0` and a fake distance | `Number(null)` passed the finite check; per-bot distances were historical | Ignore null health/ping; clear a bot's distance when it stops seeing the player | `players.test.js` directory test | FIXED (unit) |
| BUG-31-07 | P1 | Player chat | A `players message` could execute a server command or spam the player five times with `--bot all` | Leading `/` was accepted; `all` was rejected/ambiguous | Reject chat-command injection; `--bot all` sends one message from the leader | `message refuses chat-command injection ...` | FIXED (unit) |
| BUG-27-09 | P1 | Fleet chop | Repeated `bot all chop oak` runs returned partial fleets with `no trees nearby` | Tree allocation exhausted the nearby set | Direct command now widens to 48 blocks and relocates to a fresh bearing; per-bot results still report honest failures | round-31 chop/relocation tests | FIXED (unit) |

Live-only items remain **UNVERIFIED LIVE** because the sandbox cannot reach
`EmpiSMP.aternos.me:32990`.


## Round 32 — command audit, bounded follow and unfollow

**Starting head:** `7a69ba4`
**Evidence:** 395 tests, 165-file lint, `commands:audit` in deterministic
simulation, and a local dashboard. The supplied live log is analysed but was
not produced by this sandbox.

| ID | Sev | Component | Symptom / reproduction | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| BUG-32-01 | P1 | Team command | `team leader` threw `services.leadership.status is not a function` | Command called a method the model does not have | Return actual leader, preferred name, succession and history | `command-audit.test.js` | FIXED (unit) |
| BUG-32-02 | P1 | Fish command | `fish all stop` parsed `stop` as a cast count | Only `fish stop all` was recognised | Accept either word order | command audit | FIXED (unit) |
| BUG-32-03 | P1 | Explore command | `explore all stop` parsed `stop` as a step count | Only `explore stop all` was recognised | Accept either word order | command audit | FIXED (unit) |
| BUG-32-04 | P1 | Inventory command | `inventory all` returned `unknown bot all` | Fleet target was never accepted | Fleet inventory fan-out with per-bot rows | command audit | FIXED (unit) |
| BUG-32-05 | P1 | Diagnostics | Reported `10,000/10,001 unique` after one custom design existed | Compared manifest hashes with the combined manifest+custom count | Compare manifest to manifest, report custom count separately | command audit | FIXED (unit) |
| BUG-32-06 | P2 | Builder status | `site status` and `materials status` failed with no active project | Treated an empty project as an execution error | Return an honest inactive status | command audit | FIXED (unit) |
| BUG-32-07 | P1 | Players arguments | `players follow Alex nope` silently used the leader; `players stop nope` stopped all; `*` was not a fleet word | Loose target parser | Strict target validation; full fleet word set | `players.test.js`, command audit | FIXED (unit) |
| BUG-32-08 | P1 | Safety follow | Live log showed `follow` safety stages of 20 s repeatedly | `goTo` defaulted to a 20 s path and retried every tick | 4 s bound + exponential backoff; no movement claim after failure | `combat.test.js` | FIXED (unit) |
| BUG-32-09 | P1 | Command exclusivity | A command could start while a safety/watch path held the bot; two commands could race | `runExclusive` cancelled only autonomous steps and did not queue | Cancel safety too, FIFO queue per bot, bounded 3 s drain | `runtime-safety.test.js` | FIXED (unit) |
| BUG-32-10 | P2 | Player controls | No way to clear a follow without also stopping guard/escort; no follow list | Only `players stop` existed | `unfollow` + `players following` + Following players dashboard section | `players.test.js`, `controllers.test.js` | FIXED (unit) |
| BUG-27-10 | P1 | Runtime performance | Supplied live log shows 4.8 s, 9.8 s and 11.9 s event-loop blocks at `MINE_BLOCK` / `launch-actions` | Synchronous action/chunk work still exceeds the budget | Follow no longer contributes 20 s; core block remains | live log; open | OPEN |

The supplied live log shows no disconnect/kick. The five bots stayed online for
over 20 minutes. “Bots leaving” was not reproduced in the log; the observed
failure is event-loop starvation and slow safety follow.


## Preserved fixes

The round-26 movement arbiter, tick scheduler, spawn safety, bed-quota fix,
bounded dig/place, per-stage safety timings and 10,001-design library audit are
unchanged. No feature was disabled to make this pass green.
