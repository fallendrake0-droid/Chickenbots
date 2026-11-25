# Chickenbots V6 — dashboard audit

**Mode:** simulation (`node src/index.js --simulate --host 0.0.0.0 --port 3000`).
No browser automation is available in this sandbox, so visual interaction is
**not** claimed. HTTP responses and the JS bundle were exercised directly.

## Routes exercised

| Route | HTTP | Size | Result |
|---|---|---|---|
| `/` | 200 | 5,392 B | SPA shell |
| `/js/app.js` | 200 | 35,562 B | browser bundle |
| `/js/pages/fleet.js` | 200 | 57,924 B | modified fleet page served |
| `/api/state` | 200 | 367,100 B | 10 bots, diagnostics, capabilities, performance |
| `/api/settings` | 200 | 931 B | new `authentication` profile block, no credentials |
| `/api/logs?limit=5` | 200 | 1,004 B | bounded log store |
| `/api/world?name=11001010` | 200 | 37,170 B | real simulated columns/chunks |
| `/api/diagnostics/export` | 200 | 840,498 B | redacted export |

`/fleet` returns 404 by design: pages are SPA hash routes (`#/connections`,
`#/bots`, etc.). The shell and page modules are served from `/`.

## Repairs / additions

- Fleet connection card now shows **Auth / edition** and **Capabilities**
  (software confidence, protocol status, auth confidence, anti-cheat
  confidence), in addition to the round-26 safety-stage and runtime-load rows.
- `/api/settings` exposes profile name, connection auth, registration state,
  attempt cap, credential count and a credential-file parse error — never a
  password.
- `/api/state` diagnostics include a per-bot `plugins` array with conservative
  capability objects.
- `summary()` exposes `authProfile`, `connectionAuth`, `authPromptSeen`,
  `authAttempts`, `serverBrand` and `compatibilities`.

## Status accuracy

The status page distinguishes online/spawned/ready/auth-pending/manual/stale/
dead/offline through `src/bot/status.js`. A spawned bot awaiting AuthMe or a
manual step is online but not gameplay-ready. Simulation mock bots report no
server brand, so their capability block is `null` rather than invented.

## Remaining issues

- No browser-level test of buttons, modals, SSE reconnect or mobile layout in
  this pass.
- The 3D canvas render is unverified; only `/api/world` payload generation was
  exercised.
- The dashboard remains loopback by default; the sandbox preview deliberately
  opted into `DASHBOARD_ALLOW_INSECURE=true`. No remote control claim is made.
- A 367 KB `/api/state` and 840 KB diagnostics export are large; they are
  bounded but remain a P2 performance target.
