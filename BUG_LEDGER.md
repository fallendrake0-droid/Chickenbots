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
| BUG-27-09 | P1 | Fleet chop | `bot all chop oak` returned 9/10 once, one bot reported `no trees nearby`; a later run returned 10/10 | Tree allocation can exhaust nearby trees for the last bot | Reported honestly as a partial fleet result; no fabricated completion | command captures in `COMMAND_AUDIT.md` | OPEN (intermittent, not reproduced) |
| BUG-27-10 | P2 | Long simulation | An 89-minute simulation logged one 1,155.5 ms event-loop block at `MINE_ORE` | Large block/scan work inside an action phase | Not fixed in this pass; bounded-stage instrumentation remains | process log cited in `CONNECTION_RELIABILITY_REPORT.md` | OPEN |
| BUG-27-11 | P0 | Live movement | Real `invalid_player_movement` kicks were reported on the live server | Cannot reproduce without a reachable server | Packet-order fixes from round 26 remain; new category/diagnostics added | round-26 tests; live still untested | UNVERIFIED LIVE |
| BUG-27-12 | P0 | Live survival | Repeated zombie deaths and `NaNm` were reported live | Mock-world tests cannot prove live threat timing | Round-26 spawn/recovery fixes remain; no new live claim | round-26 tests | UNVERIFIED LIVE |
| BUG-27-13 | P0 | Native Bedrock | A Java Mineflayer client cannot join a Bedrock UDP endpoint | No Bedrock transport exists | Reported as `NOT_SUPPORTED` in capabilities; no fake adapter | capability test asserts NOT_SUPPORTED | NOT IMPLEMENTED |
| BUG-27-14 | P1 | AuthMe/SimpleAuth integration | No live AuthMe or SimpleAuth server was available | Sandbox/network limitation | Adapters are configuration profiles with unit tests only | `plugin-compat.test.js` | UNVERIFIED LIVE |

## Preserved fixes

The round-26 movement arbiter, tick scheduler, spawn safety, bed-quota fix,
bounded dig/place, per-stage safety timings and 10,001-design library audit are
unchanged. No feature was disabled to make this pass green.
