# Chickenbots V6 — round 27 report (platform/auth/command audit)

**Branch:** `arena/de11bd2d-chickenbots`
**Starting commit:** `00c3dc9`
**Final commit:** this document's commit
**Push:** `origin/arena/de11bd2d-chickenbots`

> **Evidence boundary:** this sandbox cannot reach any Minecraft server. No live
> connection, AuthMe/SimpleAuth test, anti-cheat test or 30-minute soak is
> claimed. Everything below is code inspection, unit tests or deterministic
> simulation.

## A. Repository

| Item | Value |
|---|---|
| Repository | `fallendrake0-droid/Chickenbots` |
| Branch | `arena/de11bd2d-chickenbots` |
| Starting head | `00c3dc9` |
| Working tree at start | clean |
| Server target | `EmpiSMP.aternos.me:32990` |
| Requested fix branch | `fix/v6-platform-compatibility` — **not created**; this session is platform-pinned to the current branch |

Modules added:

- `src/bot/authProfiles.js` — pure profile/command/classification layer.
- `src/plugins/capabilities.js` — conservative capability detection.
- `tests/plugin-compat.test.js` — 15 auth/compat tests, plus a movement-strike test in `tests/connection.test.js` (16 new).
- `BUG_LEDGER.md`, `COMPATIBILITY_MATRIX.md`, `AUTHENTICATION_PROFILES.md`,
  `CONNECTION_RELIABILITY_REPORT.md`, `COMMAND_AUDIT.md`, `DASHBOARD_AUDIT.md`,
  `SCRIPT_AUDIT.md`, `LIVE_ACCEPTANCE_REPORT.md`.

Modules changed:

- `src/bot/realBot.js`, `src/bot/connection.js`, `src/config.js`,
  `src/runtime.js`, `src/runtimeState.js`, `src/util/redact.js`,
  `src/dashboard/server.js`, `src/dashboard/public/js/pages/fleet.js`,
  `.env.example`, `tests/audit-regressions.test.js`.

## B. Bugs found and fixed

| ID | Severity | Root cause | Fix | Test |
|---|---|---|---|---|
| BUG-27-01 | P0 | Auth retry interval re-sent a password until timeout | Bounded by profile `maxAttempts` (1–5) | bounded-attempts test |
| BUG-27-02 | P0 | Auth was hard-locked to disabled; no profiles | Explicit validated `MC_AUTH_PROFILE`; default `none` | profile/config tests |
| BUG-27-03 | P0 | No proof the server requested auth before sending | Challenge wait; timeout sends nothing | challenge-timeout/success tests |
| BUG-27-04 | P1 | One fleet password; per-bot secrets not redacted | Ignored `.mc-auth.json`; per-bot redaction | redaction test |
| BUG-27-05 | P1 | Kick categories collapsed | Explicit ban/whitelist/operator/duplicate/movement/version/auth/full/throttle/restart/timeout/network/protocol | classifier assertions |
| BUG-27-06 | P1 | Movement kick told operators to “set MC_VERSION” | Logs generation/owner/priority/version, explicitly not a version guess | code audit |
| BUG-27-07 | P1 | No capability report; plugin names could be guessed | Conservative evidence-based detector | capability tests |
| BUG-27-08 | P1 | Manual auth would fail or look ready | Pending result keeps socket open, blocks gameplay | manual-pending test |
| BUG-27-15 | P1 | Repeated movement kicks reopened the join queue forever | Three strikes pause until an explicit reconnect; a ready session clears them | movement-strike test |
| BUG-27-16 | P1 | `/register` could auto-fire with registration disabled | Auto-create now requires the registration opt-in | not-registered test |
| BUG-27-17 | P1 | Permanent auth codes were retried by the supervisor | `shouldPauseAuthRetry` pauses rejected/not-registered/missing-credential/no-challenge outcomes | permanent-auth-pause test |

Open: BUG-27-09 (`bot all chop oak` intermittently 9/10 when trees run out;
the final run was 10/10), BUG-27-10 (one 1,155 ms
event-loop block at `MINE_ORE` in an 89-minute simulation), all live-only bugs.

## C. Movement

No new protocol/movement rewrite was made. The round-26 arbiter, single-owner
priority ladder, tick scheduler, teleport adoption and finite-payload checks are
preserved. This pass only corrects the misleading kick diagnostic and gives the
operator the actual generation/owner/priority. Live movement rejection remains
unverified.

## D. Survival

Round-26 per-bot spawn safety, threat scan, retreat and equipment re-scan are
unchanged and still covered. The fresh simulation had one mock unsafe-spawn
recovery; no live survival claim is made.

## E. Connections and authentication

- Default remains `MC_AUTH_PROFILE=none`: no auth chat command.
- Plugin profiles are challenge-driven; a missing challenge returns
  `AUTH_PROMPT_TIMEOUT` without sending a password.
- A `manual` profile stays online but not gameplay-ready.
- Credential attempts are bounded.
- Credentials are per bot and redacted.
- Kick classification now separates retryable network/movement/throttle errors
  from permanent ban/whitelist/version/auth decisions.
- Native Bedrock is reported `NOT_SUPPORTED`; no fake transport.

## F. Performance (simulation only)

Fresh 10-bot simulation at 253 s uptime:

| Metric | Value |
|---|---|
| Event loop mean | 21.3 ms |
| p99 | 44.2 ms |
| max | 802.7 ms |
| `/api/state` snapshot | 0.9 ms |
| tick / sync | 2 ms / 1 ms |
| CPU | 4.4% |
| RSS | 204.2 MB |
| heap | 117.2 MB |

The 802.7 ms maximum is not a solved-performance claim. An earlier 89-minute
simulation logged one 1,155.5 ms block at `MINE_ORE` (p99 64.3 ms at that point).

## G. Commands actually exercised

| Command | Result |
|---|---|
| `help` | catalogue returned |
| `status` | 10/10 online and ready |
| `bot all status` | 10 rows |
| `bot all inventory` | 10/10 |
| `bot all defend` | 10/10, IDLE |
| `batch all eat then return home` | 2/2 steps, 10/10 per step |
| `bot all chop oak` | final build 10/10 (replant reported); earlier 9/10 `no trees nearby` |
| `bot all mine iron` | not claimed on untouched mock terrain |

See `COMMAND_AUDIT.md`.

## H. Task system and building

No changes to the task board, batch transaction semantics, bed-quota rule,
building placement/verification, triple audit or 10,001-design library in this
pass. These remain as reported in `V6_ROUND_26_REPORT.md`. No live build was
run.

## I. Dashboard and terminal

- Dashboard routes exercised: `/`, `app.js`, fleet page module, `/api/state`,
  `/api/settings`, `/api/logs`, `/api/world`, `/api/diagnostics/export` (all
  HTTP 200).
- Fleet connection card shows auth profile/edition and capability confidence.
- `/api/settings` exposes the profile but never a credential.
- CLI `--help` and one-shot `--simulate status` pass with clean shutdown.
- Browser clicks, SSE reconnect and the 3D canvas were **not** tested.

## J. Validation and remaining issues

```text
npm test              327 passed, 0 failed
npm run lint          LINT PASSED (151 files)
npm run validate      VALIDATION PASSED
npm run deploy:check  12/12
npm run check:secrets PASSED (172 tracked files)
```

Remaining P0/P1:

- No live ten-bot connection or 30-minute soak.
- No live AuthMe/SimpleAuth/Geyser/ViaVersion/GrimAC test.
- No live `invalid_player_movement` or EPIPE/ECONNRESET reproduction.
- Native Bedrock transport is not implemented.
- Live browser dashboard and 3D canvas are unverified.

P2:

- Tree allocation can leave the last bot without a reachable tree.
- A long simulation recorded a ~1.2 s event-loop block at `MINE_ORE`.
- `/api/state` (367 KB) and diagnostics export (840 KB) are large.

The executable live procedure is `V6_LIVE_ACCEPTANCE.md` plus
`LIVE_ACCEPTANCE_REPORT.md`. A simulation is not substituted for any live
criterion.
