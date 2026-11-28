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


## Round 33 — fleet claims, 100x100 work zone and tool self-service

**Starting head:** `8fc01cb`
**Evidence:** 406 unit tests, deterministic two-bot and zone simulations, a
runtime `mine diamonds` command probe, lint, command audit, validation and
deploy checks. No live server was reached.

| ID | Sev | Component | Symptom / reproduction | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| BUG-33-01 | P0 | Logging teamwork | `bot all chop` sent several bots at the same nearby trunk; repeated runs exhausted the same tree | No shared claim registry; each controller filtered only its own state | `ResourceReservations` shared by the runtime; atomic `treeKey` leases, reserved trunks skipped, `releaseOwner` on disconnect | two-controller no-shared-trunk simulation; `tests/mining-teamwork.test.js` | FIXED (unit) |
| BUG-33-02 | P0 | Mining teamwork | Two bots could path to and dig the same vein | Ores had no lease at all | `oreKey` lease before pathing; `ORE_RESERVED` with holder; `mineNearby` reports reserved count | reservation semantics and second-bot `ORE_RESERVED` tests | FIXED (unit) |
| BUG-33-03 | P0 | Work boundary | A bot could chase a tree or ore out of the intended area and get lost | No geographic boundary; relocation was unbounded | 100x100 home-centred `workZone`; `OUTSIDE_WORK_ZONE` on chop/mine, tunnelling, relocation and shaft entry; `doctor` work-zone check | zone geometry, chop refusal, ore refusal, relocation-in-zone tests | FIXED (unit) |
| BUG-33-04 | P0 | Tool prerequisite | `mine diamonds` stopped at `need pickaxe tier 3`; the operator had to hand-feed an iron pick | Only the block-level tool check existed | `ensurePickaxeFor()` ladder for every ore/block: wood/sticks -> stone -> iron (mine iron + coal, smelt 3) -> diamond; honest step chain on failure | diamond bootstrap test; runtime `mine diamonds` probe; stone/dirt block tests | FIXED (unit) |
| BUG-33-05 | P1 | Tool bootstrap | A bot with no wood could not make sticks for a wooden pick | The chain assumed logs/planks existed | `_ensureSticks` bootstraps one tree through the same zone + lease rules | diamond bootstrap test from logs; runtime probe with depleted pickaxes | FIXED (unit) |
| BUG-33-06 | P1 | Catalog aliases | `requiredPickaxeTier('diamond')` returned 0 and skipped the gate | Alias lookup compared the wrong table | Normalise aliases first; tier 3 returned for `diamond` | catalog test | FIXED (unit) |
| BUG-33-07 | P1 | Coal/fuel | Iron smelting could fail after mining because no coal was gathered | The chain assumed coal/fuel existed | Mine coal when neither coal nor charcoal is held; planks/charcoal remain a fallback; explicit fuel error otherwise | diamond bootstrap test with `coal:1`; runtime probe | FIXED (unit) |
| BUG-33-08 | P2 | Lease lifecycle | A disconnected bot could leave a lease until TTL expiry | Disconnect did not release reservations | `runtime.disconnectBot()` calls `reservations.releaseOwner(name)` | disconnect safety test / reservation release | FIXED (unit) |
| BUG-33-09 | P2 | Mining speed | Repeated goTo/collect calls dominated each ore | Pathing and collection ran per ore | In-reach ores skip pathing; collection batched after a run; breakdown logs | mining-teamwork tests | FIXED (unit) |
| BUG-27-10 | P1 | Runtime performance | Supplied live log shows multi-second event-loop blocks at `MINE_BLOCK` | Synchronous action/chunk work still exceeds budget | Reduced redundant scans/paths this round; core block remains | live log; open | OPEN |

The supplied live log shows no disconnect/kick, and this sandbox still cannot
reach the server. The new tests prove teamwork and boundaries in simulation,
not live Mineflayer behaviour.

## Round 34 — startup blocking, safety budgets and planner loops

**Evidence:** 414/414 tests, lint 169 files, `commands:audit` 45/46
(0 failures), `validate` 10/10, `deploy:check` 13/13, `check:secrets` 210
files, and `npm run perf:status` in simulation. **No live result.**

| ID | Priority | Area | Symptom | Root cause | Fix | Evidence | Status |
|---|---|---|---|---|---|---|---|
| BUG-34-01 | P0 | Death attribution | A `chicken (5.8m)` was blamed for a death; a nearby zombie was treated as proof | `_recordDeath` inferred the killer from the nearest hostile when no damage evidence existed | Only `lastDeath.attacker`/death-message evidence may name a killer; otherwise `cause: UNKNOWN_CAUSE`, `confidence: unknown`. Threat context is retained but not promoted to a cause | `tests/recovery.test.js` nearest-entity and explicit-skeleton tests | FIXED (unit) |
| BUG-34-02 | P0 | Dashboard cold start | First snapshot 622 ms; actions 580 ms | First `homeBase.status()` parsed the 20 MB manifest; `library.count` constructed/scanned `CustomSchematicStore`; builder status could run its first analysis | `loadedInMemory`/`knownCount`; status never lazily loads; `_warmStatusCaches()` parses manifest/custom store, every controller status and builder status before `dashboard.start()`, yielding every four calls | `dashboard-status.test.js`, `dashboard-performance.test.js`, `perf:status` p95 5 ms warm | FIXED (simulation) |
| BUG-34-03 | P0 | `launch-actions` block | Supplied live log showed 9–18 s blocks labelled `launch-actions` | Controller synchronous prefixes ran inside `_launchBotWork`; team rescue/healing were awaited by `_tick` for up to 20 s | Start per-bot work on the next event-loop turn; dispatch team rescue/healing as tracked background work with 8 s/5 s budgets; include dispatches in drain/shutdown | `runtime-safety.test.js` | FIXED (unit); live timing UNVERIFIED |
| BUG-34-04 | P0 | Safety duration | Safety stages 23.8–61.1 s; `action cancelled: exceeded 60000ms` | No safety deadline; combat engagement looped without a time bound; path calls could use 20 s defaults | `EMERGENCY_BUDGET_MS` (6000) becomes an absolute deadline through safety, retreat, recovery and combat; moves capped by remaining budget; watchdog cancels at budget+750 ms | `combat.test.js`, `recovery.test.js` | FIXED (unit) |
| BUG-34-05 | P0 | Cancellation | A command could still wait behind combat or a player watch | `cancelCurrent()` stopped only mining/woodcutting/farming/players; `runExclusive` cancelled motion but not controller stop flags | `cancelCurrent()` stops combat too; `runExclusive` calls `_cancelBotWork` (controller stop + motion cancel) before the bounded drain | `recovery.test.js`, `runtime-safety.test.js` | FIXED (unit) |
| BUG-34-06 | P0 | Zombie deaths at 0.8 m | Failed close-range escape started a 1.2 s cooldown and tried 9–13 m paths while already in melee | Rate limit applied to failures; first escape target too far to path under attack | Short first hops (4/7/10 m, 900/1400/1800 ms) and retry on the next 750 ms safety pass when the previous response failed | `recovery.test.js` failed-escape retry test | FIXED (unit); live timing UNVERIFIED |
| BUG-34-07 | P1 | Auto-planner | Planner recreated the same doomed objective on a 60 s loop; planning state always said `stopped:false` | Failure evidence was not retained; no terminal stop condition | Objective stores `blockedReason`/`failure`; three consecutive failures enter a 30-minute paused state with the exact reason, exposed as `team.planning.{stopped,blockedUntil,blockedReason,lastFailure}` | `audit-regressions.test.js` three-failure test | FIXED (unit) |
| BUG-34-08 | P0 | Process resilience | A missed rejection killed the process and all five sessions | `unhandledRejection` was wired to the fatal shutdown path | Rejections are logged with stack and the runtime continues; uncaught synchronous exceptions remain fatal | `src/index.js` | FIXED (code) |
| BUG-34-09 | P1 | Team rescue | Rescue/healing held the autonomy tick | Awaited by `_tick`; goNear used defaults | Independent dispatch with one-per-kind guard and 8 s/5 s deadlines; bounded move in `protectTeammate`/`assistHealing` | `runtime-safety.test.js` | FIXED (unit) |
| BUG-34-10 | P1 | Reports | Required performance/plugin/auth reports were absent | No artifact | Added `PERFORMANCE_REPORT.md`, `PLUGIN_COMPATIBILITY.md`, `AUTHENTICATION_REPORT.md`; updated live acceptance counts and conditions | files in repo | DONE |
| BUG-34-11 | P0 | Event-loop p99 | Simulation p99 367–446 ms (max 648 ms); phase reported `launch-actions` | Mine/chop action scans were unbudgeted, checked the deadline only every 32 lookups, scanned bottom-up, and fast adapters ran whole quotas as microtasks | `ACTION_SCAN_BUDGET_MS=6`, `STATUS_SCAN_BUDGET_MS=2`, near-first axis scan, deadline before every lookup, `setImmediate` yield per target; routine event-loop counters reset after startup with `startupEventLoop` retained | `dashboard-performance.test.js`; 8 s simulation window p99 41.5 ms, max 52.6 ms | FIXED (simulation) |

**Still open:** live event-loop p99, live `launch-actions` timing, live zombie
death loop, real AuthMe/SimpleAuth challenge, Geyser/ViaVersion/GrimAC, and all
browser criteria. `BUG-27-10` remains OPEN for live evidence;
`BUG-27-12` remains UNVERIFIED LIVE. The simulation numbers above are not a
substitute for the supplied live log.

## Round 35 — live snapshot cache, safety ceiling and in-place planner retry

**Evidence:** 420/420 tests, lint 171 files, `commands:audit` 45/46
(0 failures), `validate` 10/10, `deploy:check` 13/13, `check:secrets` 213
files, `perf:status` and a local dashboard run. **No live result.**

| ID | Priority | Area | Symptom (live log) | Root cause | Fix | Evidence | Status |
|---|---|---|---|---|---|---|---|
| BUG-35-01 | P0 | Dashboard `actions` | Snapshot 5208 ms with `actions=4237`; two more >1 s | Every snapshot called all twelve `controller.status()` methods for five bots, including live scans | `BotActions` cache; runtime refreshes one controller per bot per tick on `setImmediate`; snapshot is cache-only and exposes `freshness` | `/api/state` `sections.actions` 0–1 ms; cache test forbids controller calls | FIXED (simulation) |
| BUG-35-02 | P0 | `launch-actions` 5691.7 ms | Role assignment/construction prefixes attributed to the action launch phase | `assignRoles()` called full combat status for every bot synchronously; helpers ran as microtasks/inline | Lightweight `CombatController.summary()`; role assignment, team work and construction auto-advance start on `setImmediate` with overlap guards | `combat.test.js`, `runtime-safety.test.js` | FIXED (unit); live timing UNVERIFIED |
| BUG-35-03 | P0 | Safety 60.3 s | `threat` 18.1 s and 60.3 s, `action cancelled: exceeded 60000ms` | A single adapter await could ignore controller deadlines and keep the slot | `safetyTick()` races the pass at `EMERGENCY_BUDGET_MS + 250` and cancels controller/motion; slot is released | hanging-safety regression test; 1 s budget test | FIXED (unit) |
| BUG-35-04 | P0 | Planner duplication | Same `BUILD A PERMANENT SURVIVAL BASE` recreated at 19:26, 19:35, 19:39 | Failed objective was forgotten and `createSurvivalBasePlan()` minted a new id | `planReopen` state plus `TaskBoard.reopenObjective()`; retries and the 30-minute backoff reuse the same objective id | `audit-regressions.test.js` repeated-failure and in-place retry tests | FIXED (unit) |
| BUG-35-05 | P0 | Death attribution | `cause: item (1.3m)` | Health-drop handler named any nearest entity; object causes were accepted | Only player/hostile within 4.5 m, `proximity` evidence, `likely`; message wins; `item`/`object` → `UNKNOWN_CAUSE` | `recovery.test.js` item and nearest-entity cases | FIXED (unit) |
| BUG-35-06 | P1 | `FARM_CROP` 11–26 s | 4441.8 ms event-loop block during FARM_CROP | 49×49×17 soil scans and unbounded harvest scans inside one action | Harvest uses `ACTION_SCAN_BUDGET_MS`; farm scans 25 ms, near-first, yield and stop per cell | `farming.test.js`; no multi-second scan remains | FIXED (simulation); live timing UNVERIFIED |
| BUG-35-07 | P0 | Startup 7236 ms | Schematic library ready in 7236 ms | 20 MB manifest `JSON.parse` before the dashboard binds | Generated 3.3 KB `summary.json`; startup/status/diagnostics/counts use it; manifest stays lazy | startup log 38 ms; `dashboard-status.test.js` asserts no manifest load | FIXED (simulation) |
| BUG-35-08 | P1 | `state-sync` 1041.8 ms | One state-sync block per second under load | `summary()` rescanned all entities for threat count every tick | Safety pass records its assessment; adapter reuses it for 5 s | `controllers.test.js` no-rescan test | FIXED (unit) |
| BUG-35-10 | P1 | Woodcutting | A budgeted tree scan stopped mid-trunk; `tick` cut 3 of 4 logs in a cold run | `findTrees()` uses the 6 ms scan budget, so `base.y` could be an upper log; `chopTree()` only scanned upward from the reported base | `chopTree()` now walks down up to 32 blocks to the true stump before cutting; regression test chops from a middle log | `woodcutting-safety.test.js` (7/7, 20 consecutive cold runs) | FIXED (unit) |
| BUG-35-09 | P1 | Startup warm-up | Warm-up paid a 370 ms manifest parse on every start | Eager cache warm-up walked every controller | Warm-up now fills controller caches only (5 ms) because summary supplies library facts | `perf:status` warm-up 5 ms | FIXED (simulation) |

**Still open:** every live criterion in `LIVE_ACCEPTANCE_REPORT.md`; live
`launch-actions`/`FARM_CROP`/safety timing, EPIPE/reconnect, AuthMe/SimpleAuth,
Geyser/ViaVersion/GrimAC, browser/canvas, and `BUG-27-10`/`BUG-27-12`.

## Round 36 — cold-cache contract, task pre-emption and distinct auth adapters

**Evidence:** 428/428 tests, lint 171 files, `commands:audit` 45/46
(0 failures), `validate` 10/10, `deploy:check` 13/13, `check:secrets` 214
files, `perf:status`. **No live result.** The supplied capture was produced by
a tree older than `863145b`; its log strings do not exist in this checkout.

| ID | Priority | Area | Symptom (live log) | Root cause | Fix | Evidence | Status |
|---|---|---|---|---|---|---|---|
| BUG-36-01 | P0 | Cold dashboard | First request after startup could run every live status scan | `BotActions.status()` had a cold fallback that called all twelve controllers synchronously | `status()` is cache-only; `warmStatus()` is the explicit fill path and returns `statusCache.empty` when cold | poisoned-controller cold test; warm snapshot test | FIXED (unit) |
| BUG-36-02 | P0 | Safety during long tasks | A 26 s `FARM_CROP` had no safety pass until it returned; zombie deaths followed | Safety ran only before a task; `_startBotStep` awaited the task with no periodic emergency check | `SAFETY_PREEMPT_MS=500` timer cancels non-combat tasks on damage/hazard/low health, marks the assignment for re-planning and returns the bot to safety; combat tasks ignore ordinary damage | pre-emption reason matrix + real 1.2 s task cancellation test | FIXED (unit); live UNVERIFIED |
| BUG-36-03 | P1 | Auth adapters | AuthMe and SimpleAuth both used the generic single-password registration form | `RealBot` always passed `MC_LOGIN_COMMAND`/`MC_REGISTER_COMMAND` defaults, erasing profile templates | AuthMe defaults to the confirmation form, SimpleAuth to one password; `MC_AUTH_LOGIN_TEMPLATE`/`MC_AUTH_REGISTER_TEMPLATE` override either and are validated before sockets open | `plugin-compat.test.js` three new cases | FIXED (unit) |
| BUG-36-04 | P0 | Movement ownership | A timed-out safety pass could overlap a newly started task | `_startBotStep` continued after `safetyTick()` returned `timedOut` | Return on `timedOut`, `dead`, `notReady` or `recovering`; the next tick re-assesses | timed-out-safety regression test | FIXED (unit) |
| BUG-36-05 | P1 | Farm scan evidence | No regression test guarded the 25 ms soil budget | The fix existed but could regress silently | 1 ms-per-lookup world asserts bounded lookups/elapsed for `_localSoil` | `farming.test.js` 33/33 with runtime-safety | FIXED (test) |

**Still open:** every live criterion in `LIVE_ACCEPTANCE_REPORT.md`; a fresh
five-bot run on `863145b` or later must prove the startup summary, snapshot
sections, task pre-emption, planner re-open and death-cause strings. EPIPE/
reconnect, AuthMe/SimpleAuth against the real server, Geyser/ViaVersion/GrimAC,
browser/canvas and `BUG-27-10`/`BUG-27-12` remain open.

## Round 37 — first-class goto and a working 3D projection

**Evidence:** 436/436 tests, lint 174 files, `commands:audit` 46/47
(0 failures; `stop` skipped). No browser or live server was available.

| ID | Priority | Area | Symptom | Root cause | Fix | Evidence | Status |
|---|---|---|---|---|---|---|---|
| BUG-37-01 | P0 | `goto` | `goto 20 65 20` returns `UNKNOWN_COMMAND` | Only the `bot <name> goto` subcommand existed | Added a first-class `goto` command with leader default, explicit bot, bot-last and `all` forms; shares the exclusive movement path | `tests/goto-command.test.js` 5 cases; CLI and audit | FIXED (unit/simulation) |
| BUG-37-02 | P0 | Live goto | A 30 s cap stopped long walks; a map block Y could be inside the ground | Fixed timeout and `GoalNear` on a non-standable Y | 0.9 s/block + 15 s bounded at 110 s; operator `adjustY` lifts up to six blocks to clear feet/head, leaves `unloaded` unchanged | `goto-command.test.js` standable-Y and movement tests | FIXED (unit); live UNVERIFIED |
| BUG-37-03 | P0 | 3D world view | Canvas blank; HUD showed triangles and WebGL mode | Column-major matrices multiplied in transposed order, collapsing every vertex to clip-space `w≈0` | Correct `multiply` in `math3d.js`; viewer imports it | `tests/dashboard-math.test.js` camera-target/terrain projection; fake-WebGL draw test | FIXED (unit); browser pixel test still absent |

**Still open:** a real browser screenshot of the Live World page and a live
`goto` on the target server; all live criteria remain UNVERIFIED.

## Round 47 — idle by default: no tasks until the operator asks

**Evidence:** 545/545 tests, lint 204 files (0 errors), `validate` 10/10,
`commands:audit` 48/49 (0 failures; `stop` skipped), and a real headless
Chromium pass against `node src/index.js --simulate --port 4179`. The browser
run confirmed `/api/state` reported `objectives: 0`, `tasks: 0`, four `IDLE`
roles and `planning.autoPlan: false`; clicking **Start planner** changed the
badge to `planning`, created one objective and 16 tasks, and the button became
**Stop planner**. **Live-server result UNVERIFIED** (simulation only).

| ID | Priority | Area | Symptom | Root cause | Fix | Evidence | Status |
|---|---|---|---|---|---|---|---|
| BUG-47-01 | P0 | Launch state | A fresh runtime immediately published `BUILD A PERMANENT SURVIVAL BASE` and scheduled work before the operator did anything | `TeamCoordinator` defaulted `autoPlan = true`; the runtime never passed the option and there was no config key or command to change it | Planning is opt-in (`AUTONOMY_AUTO_PLAN=false` by default). The runtime passes `config.autonomy.autoPlan`; `team plan on|off|status` and `TeamCoordinator.setAutoPlan()` toggle it at runtime; enabling clears retry/backoff and creates the first plan immediately. With planning off, `_idleWork` (background chop/farm/explore every 20 ticks) is skipped too, so the fleet is genuinely idle. Stopping the planner leaves existing objectives/tasks alone | `tests/autonomy.test.js` fresh-launch test; `tests/team.test.js` opt-in toggle test; live `/api/state` and browser click | FIXED (simulation) |
| BUG-47-02 | P1 | Dashboard honesty | Empty objectives read as if the coordinator would plan on its own; there was no visible way to start it | The Team and Task Manager pages did not render `team.planning.autoPlan` | Team page adds a **Task planner** card with on/off state and Start/Stop button; Task Manager adds a planner-off callout with the same action; objective empty state names the actual state | headless screenshots `#/team`, `#/tasks`; no page/console errors | FIXED (browser) |

**Enabling planning:** `team plan on` in the CLI/dashboard, the **Start
planner** button, or `AUTONOMY_AUTO_PLAN=true` from process start. With the
planner off, manually created objectives and tasks still work. Safety
(eat/flee/defend) remains active; only objective generation is paused.

**Still open:** a live five-bot launch must confirm the empty board and the
`team plan on` transition against the real server. All pre-existing live
criteria remain UNVERIFIED.

## Round 48 — honest pathfinding for every task

**Evidence:** 553/553 tests, lint 207 files (0 errors), `validate` 10/10
(36/36 pages), `commands:audit` 48/49 (0 failures; `stop` help-audited), and a
headless Chromium pass against the simulator. **Live-server result UNVERIFIED.**

| ID | Priority | Area | Symptom | Root cause | Fix | Evidence | Status |
|---|---|---|---|---|---|---|---|
| BUG-48-01 | P0 | Live search budget | Long walks gave up; short blocked walks burned the budget | `config.autonomy.pathfinderSearchRadius` was never assigned to the pathfinder; a fixed detour budget cannot fit both cases | `navigationPolicy()` + per-request `searchRadius = clamp(64, 512, 1.5 × distance + 16)` | policy unit test (100 blocks → 166, 1000 → 512) | FIXED (unit); live UNVERIFIED |
| BUG-48-02 | P0 | Stuck detection | A bot that stopped after one small step stayed "not stuck" for ~4.8 s; long A* thinking was flagged stuck | Displacement measured from the oldest of 32 samples; sampling started before any path existed | Sliding time window (`NAV_STUCK_WINDOW_MS`), samples armed only by a non-empty `path_update`, reset on path start | frozen-bot test flags at ~2.5 s; window stays <40 samples | FIXED (unit) |
| BUG-48-03 | P0 | Arrival evidence | `goal_reached` was accepted while the bot stood several blocks short; a one-attempt task abandoned the move | No settle, no distance evidence, and strict verification was opt-in | 300 ms settle, `shortBy`, gross-short retry (`range + 3`), `ARRIVAL_UNVERIFIED` on the final result | manager test: 12 blocks short retries twice and fails honestly | FIXED (unit) |
| BUG-48-04 | P1 | Recovery | Recovery searched a hard-coded southeast point instead of the target | `target + (2,2)` offset | `nearestStandable(target, maxNearbyRadius 4)`; then start; then abort | recovery test keeps the offset within 5 of the target | FIXED (unit) |
| BUG-48-05 | P0 | Mock task movement | Tree/air targets teleported the bot into place; tall-trunk work counted layers it never reached | `range >= 2` shortcuts assigned `position` directly | Resolve a real stance with `standableCandidates()` and walk it; exact targets reject alternate/current stances | tall-trunk test now reports 5/10 and leaves the unreachable layers; air-target test proves no snap | FIXED (unit/simulation) |
| BUG-48-06 | P0 | Planner budget | Three-block blocked moves returned `time-budget` and blocked the event loop | `maxDetour` floor was 24 blocks regardless of distance | `max(16, straight × 2 + 8)` | simulator: fast `no-path` replaced repeated `time-budget`; p95 1111–1462 ms → 678–843 ms | FIXED (simulation) |
| BUG-48-07 | P1 | Movement weights | `allowWater:false` was ignored and `maxDrop:0` became 3 | Global config read in the hazard function; `Number(x) || 3` | Per-call values reach `exclusionAreasStep`; zero is preserved | movement override test | FIXED (unit) |
| BUG-48-08 | P1 | Task retries | Tasks had exactly one attempt and never entered recovery | Default `NAV_TASK_ATTEMPTS=1` | Default 2; policy exposes it; operator remains 3 | policy test asserts ≥2 | FIXED (unit) |
| BUG-48-09 | P1 | Dashboard | No navigation page; simulator rows said "No navigation state reported"; no Stop action | No `navigation` route or `/api/state` aggregate; `runtime.botState()` omitted navigation | Navigation page + `navigation.policy/fleet/totals`; per-bot `navigationStatus()` fallback; `bot <name> stop`; bot card target line | headless Chromium: page, route preview, walk and tables; 0 console errors | FIXED (browser) |
| BUG-48-10 | P2 | Wood relocation | Relocation stopped inside the stripped radius | Target distance 32 with `range: 3` arrival tolerance | Aim 40 blocks out | task-pipeline relocation test | FIXED (unit) |

**Still open:** live five-bot pathfinding against the real server; scaffold-based
access for genuinely unreachable high work targets; the mock-only unsupported
builder stance fallback; and traversable deep-mine return access. Mining still
sinks a straight 1x1 shaft, which cannot be climbed. The movement layer now
reports `no-path` for the home trip instead of teleporting; changing the mining
shaft to stairs/ladders is a task change. All pre-existing live criteria remain
UNVERIFIED.


## Round 49 — beds, spawn points, crops and the live-log defects

**Evidence:** 559/559 tests, lint 208 files (0 errors), `validate` PASSED
(10/10, 36/36), `commands:audit` 48/49 (0 failures; `stop` skipped), a
five-bot simulator run and a headless Chromium pass. **Live-server result
UNVERIFIED.**

| ID | Priority | Area | Symptom | Root cause | Fix | Evidence | Status |
|---|---|---|---|---|---|---|---|
| BUG-49-01 | P0 | Bed detection | `nearbyBeds` empty in a bedroom | Status scans forced the 2 ms bounded fallback and never used the world index | Indexed search whenever `world.indexedSearch` is true; 16-block radius; verified team-memory beds; bed halves collapsed | 2 ms scan unit test; simulator sees the bed 12–16 m away | FIXED (unit/sim); live UNVERIFIED |
| BUG-49-02 | P0 | Spawn point | Bots never set a respawn anchor | No adapter method; daytime tick returned early; `PLACE_BED` never clicked the bed | `setSpawnPoint()` on both adapters with server acknowledgement; idle maintenance; `PLACE_BED` claim; `sleep spawn [bot|all]` + dashboard buttons | claim unit test; command test; 5/5 simulator verified; Chromium “5 bot(s) with a spawn point” | FIXED (unit/sim/browser); live UNVERIFIED |
| BUG-49-03 | P0 | Crop detection | Adjacent crops invisible | `findBlocks` refused the index under a budget | Indexed crops within the status/action budget; radius 10; cache invalidated at 8 blocks | 17 crops found at 1–13 blocks with a 2 ms budget | FIXED (unit) |
| BUG-49-04 | P0 | Harvest selection | Ripe crops reported as “no mature crops” | `limit` applied before maturity filter | Filter maturity first; apply `limit` to ripe crops only | 16 seedlings + 1 ripe → the ripe crop is harvested | FIXED (unit) |
| BUG-49-05 | P0 | Auto replant | Harvest succeeded but no replant followed | Immediate post-dig block check saw the old crop and returned an error | Wait for block removal; harvest maintenance runs while idle even with the planner off | simulator 10 harvested / 10 replanted; Chromium counters | FIXED (sim/browser); live UNVERIFIED |
| BUG-49-06 | P1 | Spawn safety | `unsafe spawn: suffocation risk` on join | `unloaded` treated as a solid head/ground block | Unknown blocks are not hazards | all-unloaded unit test | FIXED (unit) |
| BUG-49-07 | P0 | Operator movement | `come`/`follow` superseded forever | Stall recovery cancelled the nav claim | Keep the claim, retry after the resync pause, coalesce stalls, no duplicate combat follow | unit suites; live UNVERIFIED | FIXED (unit); live UNVERIFIED |
| BUG-49-08 | P1 | Log flood | Packet-gap warning every few seconds | 1 s threshold, 5 s rate limit | 5 s threshold, 60 s rate limit, 15 s immediate | code | FIXED (code); live UNVERIFIED |
| BUG-49-09 | P1 | Safety budget | 15.7 s safety pass | Recovery ignored the deadline between stages | Deadline propagated to survival/home; follow bounded | recovery tests | FIXED (unit); live UNVERIFIED |
| BUG-49-10 | P0 | Drowning | Bot drowned while escaping | Retreat vector ignored water/lava/ground | Land-only candidate check | recovery tests | FIXED (unit); live UNVERIFIED |
| BUG-49-11 | P1 | BUILD_PHASE | “produced no verified result” | Free-text failure only | Typed `code`/`reason`/`missingCount` | action tests | FIXED (unit); live UNVERIFIED |
| BUG-49-12 | P2 | Auth log | “password authentication: configured” with profile none | Startup line ignored the profile | Explicit “no /login is sent” warning | code | FIXED (code) |
| BUG-49-13 | P0 | Long mining actions | `action cancelled: exceeded 60000ms` | Every move/dig used the 12 s/20 s default, so one quota outlived the watchdog | One action deadline; move/dig timeouts and branch/mineOre loops clamp to the remaining budget | 35 mining/audit tests | FIXED (unit); live UNVERIFIED |

**Still open:** live confirmation of every item above; event-loop profiling on
the real host (construction site surveys/chunk parsing); climbable deep-mine
shafts; live night-time death-loop and `MINE_BLOCK` duration. All pre-existing
live criteria remain UNVERIFIED.
