# Chickenbots startup crash, Express routing and regression report

## 1. Root cause

The crashing route is:

```js
// src/dashboard/server.js:195 (HEAD 9c9d0d4, before this fix)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/healthz' || req.path.includes('.')) return next();
  const segment = req.path.split('/').filter(Boolean)[0] || '';
  if (!SHELL_ROUTES.has(segment)) return next();
  return renderIndex(req, res);
});
```

This is the SPA deep-link fallback. Express 4's router parser accepts a bare `'*'`.
Express 5 uses `router`/`path-to-regexp` 8, which treats `*` as invalid parameter
syntax and throws while the route is registered:

```text
TypeError: Missing parameter name at index 1: *
    at consumeUntil (.../path-to-regexp/dist/index.js)
    at parse (...)
    at pathToRegexp (...)
    at new Layer (...)
    at Function.route (...)
    at app.<computed> [as get] (...)
```

The checkout's lockfile installs `express@4.22.3` with `path-to-regexp@0.1.13`.
The failing deployment clearly had Express 5 / path-to-regexp 8. The exact crash
was reproduced against `express@5.3.0` + `path-to-regexp@8.4.2` in an isolated
copy of `src/`, using the original file. The exception was identical.

No dependency was downgraded, added or removed. The fix is compatible with both
installed families.

## 2. Fix

`app.get('*', ...)` became a pathless middleware:

```js
const serveShell = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/api' || req.path.startsWith('/api/') || req.path === '/healthz') return next();
  if (req.path.includes('.')) return next();
  const segment = req.path.split('/').filter(Boolean)[0] || '';
  if (!SHELL_ROUTES.has(segment)) return next();
  return renderIndex(req, res);
};
...
app.use(serveShell);
```

A pathless `app.use` has no path string for either router to parse, so it cannot
produce this exception. It is also:

- registered after every API route and after the static middleware;
- restricted to `GET`/`HEAD`, so an unsupported method cannot boot the shell;
- restricted to the known `SHELL_ROUTES` first segment;
- prevented from serving HTML for any path containing an extension;
- placed before the terminal 404 and error handlers.

The same wildcard audit found no other incompatible Express routes. All other
route strings registered successfully under Express 5.3.0, including parameter,
extension and regex routes.

## 3. Website routing

Routing order now ends with:

```text
security headers -> dashboard auth -> API no-store -> JSON parser
-> root shell -> versioned JS/CSS -> express.static
-> all API routes -> SSE
-> SPA shell fallback (GET/HEAD, known routes)
-> JSON/plain/HTML 404
-> terminal JSON error handler
```

Behaviour:

- `/`, `/#/mining`, `/players`, `/#/players`, `/woodcutting`, `/team` and every
  other known route serve the same application shell.
- `/bots/________` and other nested deep links serve the shell with absolute
  versioned asset URLs.
- Unknown frontend paths return the branded HTML 404.
- `/api` and `/api/*` always return JSON; `GET`, `POST`, `PUT` and unknown
  methods on unknown API paths never return HTML.
- Missing `.js`, `.css`, `.png` and `.schem` URLs return `404 text/plain`, even
  when the request asks for HTML.
- `HEAD` returns the status and headers with no body.
- Malformed JSON returns `400 application/json`, never an Express HTML stack.
- Encoded traversal attempts return 400/404 and do not expose `package.json`.
- The terminal error handler is last, so exceptions in the 404 path are also
  converted to safe JSON.
- Dashboard authentication still runs before shell/static/API handling;
  `/healthz` remains intentionally unauthenticated.
- Static files are read only from the resolved `src/dashboard/public/` tree.

Cache/freshness audit:

- No service worker, PWA manifest or precache exists.
- HTML is `no-store`.
- Asset URLs are absolute, content-hash versioned and `immutable` only for the
  current hash.
- Unversioned assets revalidate.
- Every response carries `X-Chickenbots-Build`.
- The source is served from disk, not a stale build output. There is only one
  HTTP server implementation (`src/dashboard/server.js`).

## 4. Startup

The real CLI starts successfully with the current Express 4 installation and
with Express 5.3.0.

Simulation:

```text
dashboard listening on http://0.0.0.0:4179
dashboard build 6.0.0+... (frontend ..., backend ...)
Simulation ready: 5/5 bots, home 0,65,2
```

Live mode with `--no-connect` starts the runtime and dashboard without a
Minecraft socket.

A live-mode connection attempt also starts the website and handles the remote
server being unreachable correctly:

```text
server not ready for bots (attempt 1, SERVER_UNREACHABLE): server version probe failed (EPIPE): write EPIPE; probing again in 30s
```

The sandbox cannot reach EmpiSMP, but that is separate from local startup and
route registration. The dashboard remained reachable throughout.

If dashboard creation or binding fails, the runtime now:

1. logs the full message and stack;
2. reports `Dashboard unavailable` in the CLI;
3. releases a partially opened dashboard socket;
4. continues initialising and running the five-bot fleet headless.

This prevents a future web-only bug from taking down task, team, mining,
woodcutting, combat or construction systems. It is reported honestly as a
degraded control plane, not as a healthy dashboard.

## 5. Runtime

The five fixed bots remain:

```text
________  10101000  01010100  11001100  00110000
```

Startup initialises the bot adapters, task board, coordinator, action registry,
command registry, team memory, ledger, reservations, construction manager,
combat coordinator, woodcutting team and autonomy timers. No AI provider or key
is required.

Team/task coverage executed explicitly:

```text
tests/team.test.js
tests/mining-teamwork.test.js
tests/woodcutting-overhaul.test.js
tests/construction.test.js
```

Result: **67/67 passing**.

`npm run commands:audit`: **47/49 executed or help-audited, 0 failures**.
Dashboard commands and terminal commands still use the same `CommandRegistry`
and shared runtime state.

## 6. Authentication warning

The warning is accurate and intentional:

```text
server.loginPassword: credentials are present but MC_AUTH_PROFILE=none;
no /login or /register command will be sent.
```

`MC_AUTH_PROFILE=none` is the safe default. The previous live server rejected
`/login` as an unknown command, so credentials must not be sent unless a
challenge-driven plugin profile is explicitly selected. Authentication was not
enabled and no credential value was printed.

The message is now actionable and names `authme`, `simpleauth`, `generic` and
`manual`, plus `MC_CREDENTIALS_FILE` for per-bot passwords. A regression test
proves a sentinel password never appears in the warning. If EmpiSMP actually
requires plugin authentication, the operator must set the matching profile and
provide credentials; otherwise `none` is correct.

## 7. Tests

```text
npm test
# tests 504
# pass 504
# fail 0

npm run test:routing
# tests 3
# pass 3

node scripts/lint.js
# LINT PASSED (195 files checked)
# 0 errors, 5 pre-existing warnings

npm run validate
# PASS secret leak check
# PASS lint
# PASS tests
# PASS schematics validation
# PASS consistency (10/10)
# VALIDATION PASSED

npm run commands:audit
# 47/49 executed or help-audited; 0 failure(s)

npm run deploy:check
# 13/13 checks passed

npm run perf:status
# pass: true, targetMs: 50, p50: 2ms, p95: 8ms, max: 8ms
```

The new routing tests cover:

- absence of legacy `*`, `/*`, array wildcard and legacy `:param?` patterns;
- alignment between frontend `NAV_GROUPS` paths and server `SHELL_ROUTES`;
- all 41 shell routes;
- nested deep links;
- root and hash-root shell;
- JSON API 200/404;
- unknown API methods;
- missing JS/CSS/image/download 404s;
- unsupported methods not returning the shell;
- malformed JSON error shape;
- encoded path traversal;
- HEAD requests.

## 8. Browser verification

No Chromium or Firefox binary is available in the sandbox, and Playwright's
browser download is blocked. No real browser paint or JavaScript console test is
claimed.

Actual HTTP verification was performed against both Express 4 and Express 5.
The strongest available client-side alternative is the happy-dom route render
harness: **43/44 valid routes rendered** and **41/41 pages rendered with a
partial first snapshot**. Hash routing itself is browser-side because the
fragment is never sent to the HTTP server.

## 9. Remaining issues

- The simulator still has synchronous cold-world generation stalls (observed
  around 3s on first tree scans and longer under load). This predates and is
  unrelated to Express routing.
- The simulator can pause autonomous planning after three unverified
  `BUILD_PHASE` attempts. That is the planner's existing guardrail, not a web
  route failure.
- EmpiSMP is unreachable from this sandbox. The live connection retry path was
  observed, but no bot could actually join the remote server here.
- No real browser automation is available.

## 10. Git state

- Branch: `arena/de11bd2d-chickenbots`
- Fix commit: `32bff3e` (`Fix Express 5 startup crash and harden dashboard routing`)
- Working tree: clean; all routing and regression changes are committed and
  pushed to `origin/arena/de11bd2d-chickenbots`.
- Changed: `README.md`, `package.json`, `src/config.js`,
  `src/dashboard/server.js`, `src/index.js`, `src/runtime.js`,
  `tests/audit-regressions.test.js`
- New: `tests/dashboard-routing.test.js`, `EXPRESS_ROUTING_REPORT.md`
- `package-lock.json`: unchanged and consistent; no dependency changes.
