# Dashboard build identity, cache safety, page audit and join skin

## Summary

This round addressed the report that the dashboard was not showing the latest
version and that hard refreshes still left stale pages. The root causes were
two independent cache problems and one deployment-visibility problem:

1. `index.html` and `/api/*` had no reliable cache policy, and the HTML shell
   was served through `express.static`, so a browser or proxy could pin the
   old shell and its old module graph.
2. There was no way for the frontend or operator to prove which build was
   running. A tab loaded from an older shell looked identical to a current one.
3. The server had no build identity in its startup output or health endpoint.

The dashboard now has a content-derived build id, cache-safe asset URLs,
explicit mismatch detection, a visible build badge and a Settings card with
frontend/backend identities. The fleet also applies the requested skin once
per ready session.

## Build identity and cache policy

New module: `src/dashboard/buildInfo.js`.

- Frontend hash: SHA-256 over every file in `src/dashboard/public/` (sorted by
  relative path, path and contents included).
- Backend hash: SHA-256 over every `src/**/*.js`, `src/**/*.json` and
  `package.json`.
- Git revision: read from `.git/HEAD`, a loose ref or `packed-refs` without
  spawning a process; `GIT_COMMIT`/`GITHUB_SHA` override for packaged builds.
- Build id: `<package version>+<git7>.<frontend12>.<backend12>`.

Server behaviour (`src/dashboard/server.js`):

- Every response carries `X-Chickenbots-Build`.
- `/` and `/index.html` are read from disk, have three `meta` tags injected
  (`chickenbots-build`, `chickenbots-frontend`, `chickenbots-backend`) and are
  served with `Cache-Control: no-store`.
- CSS/JS references are rewritten at serve time to absolute, versioned URLs:
  `/js/app.js?v=<frontendHash>`. Absolute roots are required for nested deep
  links such as `/bots/________`; relative URLs would resolve under `/bots/`.
- Nested ES-module imports are rewritten to the same hash. A current `?v=`
  value is served `public, max-age=31536000, immutable`; an unversioned or
  stale value is revalidated (`no-cache`). There is no service worker.
- `/api/build` reports the running identity plus uptime and mode.
- `/healthz` includes `build`.
- Known route shells are served for typed deep links (`/players`,
  `/woodcutting`, `/bots/<name>`); unknown paths return a branded 404 and
  unknown `/api/` paths return JSON 404. The frontend moves a typed path into
  the hash before its first render, so a refresh opens the intended page.
- Startup logs and the CLI banner print the full build id.

Frontend behaviour:

- The sidebar shows `git · frontend hash`; its tooltip includes both hashes and
  the build time.
- `store.js` reads the injected shell identity. `/api/state` is compared with
  it; a mismatch raises a persistent “Dashboard build changed” banner with a
  **Reload latest** button.
- **Settings → Build & version** shows app version, git revision, both hashes,
  both build ids, match/mismatch state, Node version and the cache policy.

## Join skin

`RealBot.connect()` now schedules `_scheduleJoinSkin()` after spawn,
authentication and the transition to `READY`. It sends one command through
`say()`, never before readiness, and never twice in one session.

Defaults:

```text
MC_SKIN_ON_JOIN=true
MC_SKIN_COMMAND=/skin uH3WR2v0ti0uTHJ
MC_SKIN_DELAY_MS=1500
```

A reconnect creates a new ready session and sends it again. Failure is
non-fatal and is retained in the bot snapshot. Bot profiles show
`Applied`/`Pending`/`Command failed`; Connections shows the command, delay and
send time; Settings shows the active configuration. `/api/settings` exposes
only the non-secret command and delay.

## Page audit and fixes

A DOM-backed render smoke test (happy-dom, all routes, full simulated snapshot,
empty snapshot and `{}` snapshot) rendered every page and caught three real
defects that static review had missed:

- **Live World:** the Fleet card rendered `undefined/5` because it called
  `.length` on an already-counted number.
- **Settings:** two switches rendered `aria-checked="undefined"` for unset
  preferences; they now use booleans.
- **Nested deep links:** relative CSS/JS URLs would resolve under `/bots/…`.
  The server now emits absolute versioned roots.

Mining was also corrected and expanded:

- `oresMined` is a map, not a number. The page previously summed the object and
  showed a meaningless total. Totals, ore-type counts and per-bot breakdowns
  are now derived from the map.
- Per-bot telemetry now reports the cached status-scan age and its honest
  5-block sampling radius, next to the 24-block command scan.
- The form accepts a typed deep target (`diamond`, `stone`, …) instead of only
  offering ores already visible in the status sample.
- Work zone, reservations/conflicts, stopped state, sampled ore distances and
  per-bot stop are visible. `mine <bot> stop` is implemented and tested.
- All hardcoded roster counts (`/10`, `|| 10`, “five usernames”) were removed
  from World, Fleet, Team, Home Base, Fishing, Overview and Construction.

UI polish:

- Command palette sections (Recent, Pages, Commands), command aliases/category
  in search, visible usage text and persisted recent commands.
- The palette remains reachable on mobile as an icon-only button.
- Sidebar live status includes the last telemetry age.
- Stat cards gained tone-coloured top edges, hover elevation and a live pulse;
  OS-level `prefers-reduced-motion` is honoured.
- Branded 404 shell and JSON API 404s.

## Verification

- `npm test`: **498/498 passing**.
- `npm run validate`: **VALIDATION PASSED** (lint, consistency 10/10, secrets,
  schematics).
- `npm run commands:audit`: **47/49 executed/help-audited, 0 failures**.
- `node scripts/lint.js`: **194 files, 0 errors, 5 pre-existing warnings**.
- Live simulated dashboard on `0.0.0.0:4179`:
  - `/` returns `no-store`, `X-Chickenbots-Build`, all three meta tags and
    absolute `?v=<hash>` asset URLs.
  - `/api/build` returns the same build id as the header.
  - `/js/router.js?v=<hash>` is `immutable`, `application/javascript`, and its
    nested imports carry the same `?v=` value.
  - Unversioned JS is `no-cache`.
  - `/players` and `/bots/________` return the shell with absolute assets.
  - `/nope` returns the branded 404; `/api/nope` returns JSON 404.
  - `/api/settings` reports the join-skin command and delay.
- DOM render smoke: 43/44 valid routes rendered from a full simulated snapshot
  without `undefined`, `NaN` or `[object Object]`; 41/41 navigation pages render
  before the first snapshot and with an empty/partial snapshot.

## Remaining limitation

A Chromium binary cannot be installed in this sandbox: Playwright's download
from `cdn.playwright.dev` fails with `ECONNRESET`. Verification therefore uses
HTTP-level assertions plus the happy-dom renderer, not a real browser paint.
The live preview is the visual check. One pre-existing simulator warning
remains: simulator-only synchronous world scans and pathfinding can block the
event loop for 3–26 s while the mock world generates columns (long actions were
observed up to 29 s). It is outside this cache/UI change and happens during
first-time world generation, not on dashboard page requests; after warm-up the
same actions complete in under 200 ms.
