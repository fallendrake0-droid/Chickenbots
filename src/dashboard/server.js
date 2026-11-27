'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { config } = require('../config');
const { statusSnapshot } = require('../runtimeState');
const { toSpongeSchematic, toJSON } = require('../schematics/format');
const { exportSchematic } = require('../building/schematicIO');
const logStore = require('../logStore');
const { worldSnapshot } = require('./worldView');
const { buildInfo } = require('./buildInfo');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SHELL_ROUTES = Object.freeze(new Set([
  'overview', 'world', 'activity', 'notifications',
  'bots', 'players', 'team', 'profiles', 'connections',
  'survival', 'inventory', 'mining', 'excavation', 'woodcutting', 'farming',
  'fishing', 'exploration', 'sleep',
  'combat', 'combat-team', 'combat-gear', 'combat-supplies', 'combat-targets',
  'operations', 'builder-projects', 'site-survey', 'site-prep', 'lighting',
  'material-plan', 'warehouse', 'crew', 'qa', 'home', 'building', 'builder',
  'schematics', 'projects', 'history', 'tasks', 'logs', 'settings'
]));

/**
 * Download names come from route parameters or custom-catalogue ids. Strip
 * quotes, controls and separators so a crafted id cannot break the header
 * (Node rejects it, turning a download into a 500) or suggest a second file.
 */
function attachmentFilename(value, extension = '') {
  const base = String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 120);
  const ext = String(extension || '').replace(/[^A-Za-z0-9._-]/g, '');
  return `${base || 'schematic'}${ext}`;
}

/**
 * The dashboard can issue commands, so a non-loopback bind without a token is
 * only allowed when the operator explicitly accepts the risk. Returning a
 * message instead of hiding the decision keeps startup errors actionable.
 */
function dashboardBindProblem({ host, token, allowInsecure } = {}) {
  if (token) return null;
  if (LOOPBACK_HOSTS.has(String(host || '').toLowerCase())) return null;
  if (allowInsecure === true) return null;
  return `refusing to expose the unauthenticated control plane on ${host}; bind 127.0.0.1, set DASHBOARD_TOKEN, or set DASHBOARD_ALLOW_INSECURE=true for a trusted local preview`;
}

/**
 * Dashboard server. Binds loopback by default because it can issue commands;
 * a non-loopback bind needs a token or an explicit allow-insecure opt-in. All
 * client URLs are relative. Commands go through the same validated registry as
 * the terminal (chat is never an execution source).
 */
function createDashboard(services, { port = config.dashboard.port, host = config.dashboard.host } = {}) {
  const app = express();
  const build = buildInfo();
  // Absolute asset roots keep a nested deep link such as /bots/name from
  // resolving css/... against /bots/. Hash routes still use the fragment.
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const versioned = (url) => `/${url.replace(/^\.?\//, '')}?v=${build.frontendHash}`;
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Optional control-plane password. Basic auth is used because browsers show
  // a native prompt and EventSource/fetch reuse the cached credentials. An
  // empty token is allowed for the loopback demo, but startup warns loudly
  // when the dashboard is bound beyond loopback.
  const accessToken = String(config.dashboard.token || '');
  const sessionCookie = accessToken ? crypto.createHash('sha256').update(`chickenbots:${accessToken}`).digest('hex') : '';
  const secureEqual = (a, b) => {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  };
  const suppliedToken = (req) => {
    const header = String(req.headers.authorization || '');
    const basic = header.match(/^Basic\s+(.+)$/i);
    if (basic) {
      try {
        const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
        // Username is ignored; the password is the configured token.
        return decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
      } catch (_) { return ''; }
    }
    const bearer = header.match(/^Bearer\s+(.+)$/i);
    if (bearer) return bearer[1];
    const cookies = String(req.headers.cookie || '');
    const match = cookies.match(/(?:^|;\s*)cb_dash=([^;]+)/);
    return match ? match[1] : '';
  };
  app.use((req, res, next) => {
    res.setHeader('X-Chickenbots-Build', build.buildId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'"
    ].join('; '));
    if (req.path === '/healthz' || !accessToken) return next();
    const supplied = suppliedToken(req);
    if (secureEqual(supplied, accessToken) || secureEqual(supplied, sessionCookie)) {
      // Remember the authenticated session so EventSource and static asset
      // requests do not depend on every browser re-sending Basic credentials.
      res.setHeader('Set-Cookie', `cb_dash=${sessionCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Chickenbots control plane", charset="UTF-8"');
    return res.status(401).json({ ok: false, error: 'dashboard authentication required' });
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  // Live telemetry must never be served from a browser or proxy cache: a
  // cached /api/settings response is enough to show a retired roster.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  const publicDir = path.join(__dirname, 'public');
  const indexFile = path.join(publicDir, 'index.html');

  // The application shell is never cached. Every asset URL carries the content
  // hash of the whole frontend, so a source change produces new module URLs
  // instead of leaving old ES modules in the browser's module cache.
  const renderIndex = (req, res) => {
    try {
      let html = fs.readFileSync(indexFile, 'utf8');
      html = html.replace(/\b(href|src)="((?:\.\/)?(?:css|js)\/[^"?#]+)(?:\?[^"]*)?"/g, (match, attribute, url) => `${attribute}="${versioned(url)}"`);
      html = html.replace('<head>', `<head>\n  <meta name="chickenbots-build" content="${build.buildId}" />\n  <meta name="chickenbots-frontend" content="${build.frontendHash}" />\n  <meta name="chickenbots-backend" content="${build.backendHash}" />`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.type('html').send(html);
    } catch (err) {
      res.status(500).type('text').send(`dashboard shell unavailable: ${err.message}`);
    }
  };
  app.get(['/', '/index.html'], renderIndex);

  const assetFile = (urlPath) => {
    let decoded;
    try { decoded = decodeURIComponent(urlPath); } catch (_) { return null; }
    const file = path.resolve(publicDir, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
    return file.startsWith(`${publicDir}${path.sep}`) ? file : null;
  };
  const sendVersionedAsset = (req, res, next, { rewriteModules = false } = {}) => {
    const file = assetFile(req.path);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
    try {
      let body = fs.readFileSync(file);
      if (rewriteModules) {
        // ES modules cache by URL. Rewriting every relative import to the same
        // content hash makes nested modules cache-safe as well.
        body = body.toString('utf8').replace(/(['"])(\.{1,2}\/[^'"]+\.js)\1/g, (match, quote, target) => `${quote}${target}?v=${build.frontendHash}${quote}`);
      }
      const current = req.query.v === build.frontendHash;
      res.setHeader('Cache-Control', current ? 'public, max-age=31536000, immutable' : 'no-cache');
      res.type(rewriteModules ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      res.send(body);
    } catch (err) {
      next(err);
    }
  };
  app.get(/^\/js\/.*\.js$/, (req, res, next) => sendVersionedAsset(req, res, next, { rewriteModules: true }));
  app.get(/^\/css\/.*\.css$/, (req, res, next) => sendVersionedAsset(req, res, next));
  app.use(express.static(publicDir, {
    index: false,
    setHeaders(res, file) {
      // Unversioned fallbacks and the HTML shell must revalidate. Versioned
      // JS/CSS is served above with an immutable one-year policy.
      if (/\.(?:html|js|css)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
  // Hash-routed views use `#/route`, so the browser never requests those
  // paths during navigation. A refresh on a typed-in deep link such as
  // `/players` should still boot the shell, but a genuinely unknown path must
  // stay a 404. Keep this list aligned with NAV_GROUPS in public/js/router.js.
  // Serve the shell for typed deep links and tab refreshes. This is a pathless
  // middleware rather than a string wildcard route: Express 5 routes through
  // path-to-regexp 8, which rejects a bare '*' with "Missing parameter name at
  // index 1" while the route is being registered. A pathless app.use is parsed
  // by neither version and is safe under both Express 4 and 5. It is registered
  // after every API route below, so an API path can never fall through to HTML.
  const serveShell = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path === '/healthz') return next();
    // A missing .js/.css/image/download must remain a 404, never the shell.
    if (req.path.includes('.')) return next();
    const segment = req.path.split('/').filter(Boolean)[0] || '';
    if (!SHELL_ROUTES.has(segment)) return next();
    return renderIndex(req, res);
  };
  // Snapshot assembly takes a few tens of milliseconds. Keep only a very
  // short coalescing cache for concurrent callers, and always force a fresh
  // build for the state endpoint and the SSE stream: a stale "online" card is
  // worse than spending the milliseconds.
  const SNAPSHOT_CACHE_MS = 500;
  let snapshotCache = { at: 0, value: null };
  const invalidate = () => { snapshotCache = { at: 0, value: null }; };
  const snapshot = (force = false) => {
    if (!force && snapshotCache.value && Date.now() - snapshotCache.at < SNAPSHOT_CACHE_MS) return snapshotCache.value;
    const started = Date.now();
    const value = statusSnapshot(services);
    const elapsed = Date.now() - started;
    if (elapsed >= 1000) {
      // Name the section that spent the time. The old message only said the
      // snapshot was slow, which sent this investigation into _syncBots even
      // though the block happened here.
      const sections = value && value.performance && value.performance.sections ? value.performance.sections : {};
      const breakdown = Object.entries(sections)
        .filter(([, ms]) => Number(ms) >= 50)
        .sort((a, b) => b[1] - a[1])
        .map(([name, ms]) => `${name}=${ms}ms`)
        .join(', ');
      services.logger?.warn(`dashboard state snapshot took ${elapsed}ms; it blocked the event loop${breakdown ? ` (${breakdown})` : ''}`);
    }
    // Make the event-loop watchdog blame this timer, not the last tick phase.
    services.runtime?.recordExternalWork?.('dashboard-snapshot', elapsed);
    snapshotCache = { at: Date.now(), value };
    return snapshotCache.value;
  };
  const eventClients = new Set();
  let eventTimer = null;
  const startEventTimer = () => {
    if (eventTimer) return;
    // Two seconds keeps the browser close to the real connection state without
    // rebuilding the full bot/action/library snapshot every second; a large
    // snapshot can otherwise consume a noticeable share of the event loop.
    eventTimer = setInterval(() => {
      if (!eventClients.size) return;
      let payload;
      try {
        payload = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
      } catch (err) {
        // A status-assembly bug must not take down the process or leave the
        // browser showing the previous (possibly all-online) frame.
        services.logger?.error(`dashboard snapshot failed: ${err.message}`);
        payload = `event: error\ndata: ${JSON.stringify({ at: new Date().toISOString(), error: 'state snapshot failed' })}\n\n`;
      }
      for (const client of [...eventClients]) {
        try {
          // Drop a client that cannot keep up instead of growing the socket
          // buffer without bound.
          if (client.writableLength > 1024 * 1024) {
            eventClients.delete(client);
            client.end();
            continue;
          }
          client.write(payload);
        } catch (_) { eventClients.delete(client); }
      }
    }, 2000);
    if (eventTimer.unref) eventTimer.unref();
  };

  // Mutating routes accept same-origin requests only and are rate limited.
  const buckets = new Map();
  const rateLimit = (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'local';
    // Prune expired buckets so a long-lived dashboard cannot be memory-DoSed
    // by many source addresses. The map also has a hard cap.
    if (buckets.size > 2048) {
      for (const [key, entry] of buckets) if (entry.resetAt <= now) buckets.delete(key);
      if (buckets.size > 8192) buckets.clear();
    }
    const bucket = buckets.get(ip) || { count: 0, resetAt: now + 60000 };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60000; }
    bucket.count++;
    buckets.set(ip, bucket);
    if (bucket.count > 120) return res.status(429).json({ ok: false, error: 'rate limit exceeded; try again shortly' });
    return next();
  };
  const sameOrigin = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      // Preview proxies may rewrite Host; trust their forwarded host while
      // still requiring the browser's Origin to match the serving host.
      const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      try {
        if (new URL(origin).host !== (forwarded || req.headers.host)) {
          return res.status(403).json({ ok: false, error: 'cross-origin request refused' });
        }
      } catch (_) {
        return res.status(403).json({ ok: false, error: 'invalid origin' });
      }
    }
    return next();
  };

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, uptimeMs: process.uptime() * 1000, mode: services.mode || 'live', build });
  });

  app.get('/api/build', (req, res) => {
    res.json({ ok: true, build: { ...build, uptimeMs: process.uptime() * 1000, mode: services.mode || 'live' } });
  });

  app.get('/api/state', (req, res) => {
    try {
      res.json({ ok: true, state: snapshot() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/diagnostics/export', (req, res) => {
    try {
      const payload = {
        exportedAt: new Date().toISOString(),
        note: 'Credentials are redacted by the logger and the dashboard state builder.',
        state: snapshot(),
        logs: logStore.recent({ limit: 500 })
      };
      res.setHeader('Content-Disposition', 'attachment; filename="chickenbots-diagnostics.json"');
      res.type('application/json').send(JSON.stringify(payload, null, 2));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/logs', (req, res) => {
    const { limit = 120, level = null, scope = null, q = null, since = 0 } = req.query;
    const logs = logStore.recent({ limit, level, scope, q, since });
    res.json({ ok: true, logs, stats: logStore.stats() });
  });

  app.get('/api/settings', (req, res) => {
    // state() walks every bot and controller; read it once per request.
    const runtimeState = services.runtime ? services.runtime.state() : null;
    res.json({
      ok: true,
      settings: {
        server: { host: config.server.host, port: config.server.port, version: config.server.version, auth: config.server.auth, joinIntervalMs: config.server.joinIntervalMs, joinJitterMs: config.server.joinJitterMs, rejoinDelayMs: config.server.rejoinDelayMs },
        joinSkin: { enabled: Boolean(config.server.skinOnJoin), command: config.server.skinOnJoin ? config.server.skinCommand : null, delayMs: config.server.skinDelayMs },
        authentication: {
          profile: config.server.authProfile,
          mode: config.server.authMode,
          connectionAuth: config.server.auth,
          registrationEnabled: config.server.authRegistrationEnabled === true,
          maxAttempts: config.server.authMaxAttempts,
          credentialsConfigured: Object.keys(config.server.credentials || {}).length,
          credentialFileError: config.server.credentialsError || null
        },
        dashboard: { host: config.dashboard.host, port: config.dashboard.port, allowInsecure: config.dashboard.allowInsecure === true },
        security: { tokenRequired: Boolean(accessToken), passwordConfigured: Boolean(config.server.loginPassword || config.server.registerPassword || Object.keys(config.server.credentials || {}).length), allowInsecure: config.dashboard.allowInsecure === true },
        roster: config.team.names,
        pve: config.autonomy.pve,
        pvp: config.autonomy.pvp,
        ai: { enabled: config.autonomy.ai.enabled, provider: config.autonomy.ai.provider || null },
        autonomy: { tickMs: config.autonomy.tickMs, enabled: runtimeState ? runtimeState.running : false, paused: runtimeState ? runtimeState.paused : false },
        excavation: { maxBlocks: config.excavation ? config.excavation.maxBlocks : null },
        reserves: config.reserves,
        limits: { commandRatePerMinute: 120, requestBodyMb: 2 }
      }
    });
  });

  app.get('/api/queue', (req, res) => {
    if (!services.runtime) return res.status(503).json({ ok: false, error: 'runtime unavailable' });
    const state = services.runtime.state();
    res.json({ ok: true, joinQueue: state.joinQueue, bots: state.bots.map((bot) => ({ name: bot.name, ready: bot.ready, lastSpawn: bot.lastSpawn || null })), connectionErrors: state.connectionErrors });
  });

  app.post('/api/queue/:action', sameOrigin, rateLimit, async (req, res) => {
    if (!services.runtime) return res.status(503).json({ ok: false, error: 'runtime unavailable' });
    const action = req.params.action;
    try {
      if (action === 'reset-cooldown') {
        const cleared = { cooldownUntil: services.runtime.joinCooldownUntil || null, strikes: services.runtime.throttleStrikes || 0 };
        services.runtime.joinCooldownUntil = 0;
        services.runtime.throttleStrikes = 0;
        services.runtime.nextJoinAt = 0;
        if (services.logger) services.logger.warn(`join queue cooldown cleared from dashboard (was ${cleared.cooldownUntil ? new Date(cleared.cooldownUntil).toISOString() : 'none'}, ${cleared.strikes} strike(s))`);
        invalidate();
        return res.json({ ok: true, cleared, joinQueue: services.runtime.state().joinQueue });
      }
      if (action === 'retry-all') {
        const results = [];
        for (const bot of services.runtime.bots.values()) {
          if (bot.ready) continue;
          results.push({ name: bot.name, ...(await services.runtime.reconnectBot(bot.name)) });
        }
        invalidate();
        return res.json({ ok: true, queued: results.length, results });
      }
      return res.status(400).json({ ok: false, error: 'unknown queue action' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot/:name/:action', sameOrigin, rateLimit, async (req, res) => {
    if (!services.runtime) return res.status(503).json({ ok: false, error: 'runtime unavailable' });
    const { name, action } = req.params;
    if (!config.team.names.includes(name)) return res.status(404).json({ ok: false, error: 'unknown bot' });
    if (!['reconnect', 'disconnect', 'state'].includes(action)) return res.status(400).json({ ok: false, error: 'unknown action' });
    try {
      let result;
      if (action === 'reconnect') result = await services.runtime.reconnectBot(name);
      else if (action === 'disconnect') result = await services.runtime.disconnectBot(name, 'dashboard');
      else result = { ok: true, bot: services.runtime.botState(name) };
      // Connection actions change the truth immediately; do not let the next
      // state request reuse a snapshot taken before the action.
      invalidate();
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/world', (req, res) => {
    try {
      const result = worldSnapshot(services, {
        bot: req.query.bot,
        x: req.query.x,
        y: req.query.y,
        z: req.query.z,
        radius: req.query.radius,
        height: req.query.height
      });
      res.json(result);
    } catch (err) {
      services.logger?.warn(`world view failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/commands', (req, res) => {
    if (!services.commands) return res.status(503).json({ ok: false, error: 'commands unavailable' });
    const commands = services.commands.list();
    const targets = services.commands.targets ? services.commands.targets() : null;
    res.json({
      ok: true,
      commands,
      targets,
      catalogue: { commands, targets, taskTypes: services.commands.taskTypes || [] },
      history: services.commands.recent(30),
      taskTypes: services.commands.taskTypes || []
    });
  });

  app.get('/api/commands/targets', (req, res) => {
    if (!services.commands || !services.commands.targets) return res.status(503).json({ ok: false, error: 'target catalogue unavailable' });
    res.json({ ok: true, ...services.commands.targets() });
  });

  /**
   * Single command entry point for every dashboard control. A structured
   * {name, args, confirm} body is validated and serialised by the registry, so
   * the browser never hand-assembles a command line. A raw `line` is retained
   * for the terminal and for backwards compatibility with existing clients.
   */
  app.post('/api/command', sameOrigin, rateLimit, async (req, res) => {
    if (!services.commands) return res.status(503).json({ ok: false, error: 'commands unavailable' });
    const body = req.body || {};
    const { line, confirm } = body;
    const operator = body.operator || 'dashboard';
    const source = ['dashboard', 'chat', 'terminal', 'cli'].includes(body.source) ? body.source : 'dashboard';
    if (body.name !== undefined) {
      const name = String(body.name || '').trim().toLowerCase();
      const args = body.args === undefined ? [] : body.args;
      if (!name) return res.status(400).json({ ok: false, code: 'ARGS', error: 'missing command name' });
      if (!Array.isArray(args)) return res.status(400).json({ ok: false, code: 'ARGS', error: 'command args must be an array' });
      const check = services.commands.validate(name, args);
      if (!check.ok) return res.status(400).json({ ...check, name, args });
      try {
        const result = await services.commands.executeStructured({ name, args, source, operator, confirmed: confirm === true });
        invalidate();
        // Contract rejections (unknown command, unserialisable argument) are a
        // client error even when the registry recorded them instead of throwing.
        const rejection = result && result.ok === false ? result.result : null;
        if (rejection && ['ARGS', 'UNKNOWN_COMMAND'].includes(rejection.code)) {
          return res.status(400).json({ ...result, ok: false, code: rejection.code, error: rejection.error });
        }
        return res.json(result);
      } catch (err) {
        return res.status(400).json({ ok: false, code: err.code || 'ARGS', error: err.message, name, args });
      }
    }
    if (!line) return res.status(400).json({ ok: false, code: 'ARGS', error: 'missing command line' });
    try {
      const result = await services.commands.execute(line, { source, operator, confirmed: confirm === true });
      invalidate();
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/schematics', (req, res) => {
    if (!services.library || !services.library.loaded) return res.status(503).json({ ok: false, error: 'library not generated' });
    const { tier = null, category = null, q = null, difficulty = null, maxWidth = null, maxLength = null, maxHeight = null, material = null, limit = 24, offset = 0 } = req.query;
    const size = Math.min(200, Math.max(1, Number(limit) || 24));
    const start = Math.max(0, Number(offset) || 0);
    const { custom = null, sort = null, tag = null, format = null } = req.query;
    let filtered = services.library.list({ tier, category, q, tag, format, limit: Number.MAX_SAFE_INTEGER, excludeCustom: custom === 'false', sort });
    if (custom === 'true') filtered = filtered.filter((d) => d.custom);
    if (difficulty) filtered = filtered.filter((d) => Number(d.difficulty) === Number(difficulty));
    if (maxWidth) filtered = filtered.filter((d) => d.dimensions.width <= Number(maxWidth));
    if (maxLength) filtered = filtered.filter((d) => d.dimensions.length <= Number(maxLength));
    if (maxHeight) filtered = filtered.filter((d) => d.dimensions.height <= Number(maxHeight));
    if (material) {
      filtered = filtered.filter((d) => {
        const entry = services.library.get(d.id);
        return entry && Object.keys(entry.materials || {}).some((name) => name.includes(material));
      });
    }
    const designs = filtered.slice(start, start + size);
    res.json({ ok: true, count: services.library.knownCount, total: filtered.length, offset: start, limit: size, designs });
  });

  app.get('/api/schematics/:id', (req, res) => {
    if (!services.library || !services.library.loaded) return res.status(503).json({ ok: false, error: 'library not generated' });
    const design = services.library.get(req.params.id);
    if (!design) return res.status(404).json({ ok: false, error: 'unknown schematic' });
    const schematic = services.library.build(design.id);
    res.json({
      ok: true,
      design,
      materials: Object.entries(design.materials).sort((a, b) => b[1] - a[1]).slice(0, 40),
      preview: topDownPreview(schematic)
    });
  });

  app.get('/api/schematics/:id/download.schem', (req, res) => {
    if (!services.library || !services.library.loaded) return res.status(503).json({ ok: false, error: 'library not generated' });
    const design = services.library.get(req.params.id);
    if (!design) return res.status(404).json({ ok: false, error: 'unknown schematic' });
    const schematic = services.library.build(design.id);
    const buffer = toSpongeSchematic(schematic);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${attachmentFilename(design.id, '.schem')}"`);
    res.send(buffer);
  });

  app.get('/api/schematics/:id.json', (req, res) => {
    if (!services.library || !services.library.loaded) return res.status(503).json({ ok: false, error: 'library not generated' });
    const design = services.library.get(req.params.id);
    if (!design) return res.status(404).json({ ok: false, error: 'unknown schematic' });
    res.json({ ok: true, schematic: toJSON(services.library.build(design.id)) });
  });

  // ---------------------------------------------------------------------
  // Custom schematic catalogue (import, edit, export, remove)
  // ---------------------------------------------------------------------
  const customStore = () => services.library && services.library.customStore;
  app.get('/api/building', (req, res) => {
    const store = customStore();
    const builds = [...(services.builders ? services.builders.values() : [])];
    const firstEngine = builds[0] && builds[0].engine ? builds[0].engine : null;
    res.json({
      ok: true,
      config: services.config?.building || {},
      registry: firstEngine ? firstEngine.registry.describe() : null,
      custom: store ? store.statsSummary() : null,
      library: services.library && services.library.loaded ? services.library.stats() : null,
      builds: builds.map((builder) => ({
        id: builder.id, name: builder.schematic.name, state: builder.status().state,
        percent: builder.status().percentComplete, tasks: builder.status().tasks,
        verification: builder.engine ? builder.engine.auditSummary() : null
      })),
      projects: services.construction ? services.construction.list() : []
    });
  });

  app.post('/api/schematics/scan', sameOrigin, rateLimit, (req, res) => {
    const store = customStore();
    if (!store) return res.status(503).json({ ok: false, error: 'custom schematic catalogue unavailable' });
    try {
      const result = store.scan({ persist: true });
      invalidate();
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/schematics/upload', sameOrigin, rateLimit, express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    const store = customStore();
    if (!store) return res.status(503).json({ ok: false, error: 'custom schematic catalogue unavailable' });
    if (!req.body || !req.body.length) return res.status(400).json({ ok: false, error: 'empty upload' });
    const filename = String(req.query.filename || req.get('x-filename') || '').trim();
    const name = req.query.name ? String(req.query.name) : null;
    const licence = req.query.licence ? String(req.query.licence) : 'UNKNOWN';
    const source = req.query.source ? String(req.query.source) : 'upload';
    try {
      const result = store.importFile(req.body, { filename, name, licence, source, tags: ['uploaded'], force: req.query.force === 'true' });
      invalidate();
      if (!result.ok) return res.status(result.duplicate ? 409 : 422).json({ ok: false, error: result.error || result.reason, duplicate: Boolean(result.duplicate), existing: result.existing || null });
      return res.json({ ok: true, entry: result.entry, warnings: result.warnings || [] });
    } catch (err) {
      services.logger?.error(`schematic upload failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/schematics/:id/:action', sameOrigin, rateLimit, (req, res) => {
    const store = customStore();
    if (!store) return res.status(503).json({ ok: false, error: 'custom schematic catalogue unavailable' });
    const id = req.params.id;
    const action = req.params.action;
    try {
      let result;
      if (action === 'rename') result = store.rename(id, req.body?.name);
      else if (action === 'tag') result = store.tag(id, Array.isArray(req.body?.tags) ? req.body.tags : [req.body?.tag]);
      else if (action === 'licence') result = store.setLicence(id, req.body?.licence);
      else if (action === 'duplicate') result = store.duplicate(id, { name: req.body?.name });
      else if (action === 'reimport') result = store.reimport(id);
      else return res.status(404).json({ ok: false, error: `unknown custom schematic action ${action}` });
      invalidate();
      if (!result.ok) return res.status(422).json({ ok: false, error: result.error || result.reason || 'action failed' });
      return res.json({ ok: true, entry: result.entry || null });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/schematics/:id', sameOrigin, rateLimit, (req, res) => {
    const store = customStore();
    if (!store) return res.status(503).json({ ok: false, error: 'custom schematic catalogue unavailable' });
    const result = store.remove(req.params.id);
    invalidate();
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
    return res.json({ ok: true, id: result.id });
  });

  app.get('/api/schematics/:id/export', (req, res) => {
    if (!services.library || !services.library.loaded) return res.status(503).json({ ok: false, error: 'library not generated' });
    const design = services.library.get(req.params.id);
    if (!design) return res.status(404).json({ ok: false, error: 'unknown schematic' });
    const format = String(req.query.format || 'sponge-schem');
    let buffer; let extension; let warnings = [];
    try {
      if (design.custom) {
        const store = customStore();
        if (!store) return res.status(503).json({ ok: false, error: 'custom schematic catalogue unavailable' });
        const result = store.export(req.params.id, format);
        if (!result.ok) return res.status(422).json({ ok: false, error: result.error });
        buffer = result.buffer; extension = result.extension;
      } else {
        const schematic = services.library.build(req.params.id);
        if (!schematic) return res.status(404).json({ ok: false, error: 'schematic data unavailable' });
        const result = exportSchematic(schematic, format);
        if (!result || !result.buffer) return res.status(422).json({ ok: false, error: (result && result.error) || 'export failed' });
        buffer = result.buffer; extension = result.extension; warnings = result.warnings || [];
      }
    } catch (err) {
      return res.status(422).json({ ok: false, error: err.message });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${attachmentFilename(req.params.id, extension)}"`);
    if (warnings.length) res.setHeader('X-Export-Warnings', String(warnings.length));
    res.send(buffer);
  });

  // ---------------------------------------------------------------------
  // Per-build evidence and controls
  // ---------------------------------------------------------------------
  app.get('/api/builds/:id', (req, res) => {
    const builder = services.builders && (services.builders.get(req.params.id)
      || [...services.builders.values()].find((entry) => entry.id.startsWith(req.params.id)));
    if (!builder) return res.status(404).json({ ok: false, error: 'unknown build' });
    const statusFilter = req.query.status ? String(req.query.status).toUpperCase() : null;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 200));
    const all = builder.engine ? builder.engine.blocks : [];
    const filtered = statusFilter ? all.filter((block) => block.status === statusFilter) : all;
    const page = filtered.slice(offset, offset + limit).map((block) => ({
      x: block.x, y: block.y, z: block.z, world: builder.engine.worldPos(block),
      block: block.canonical, phase: block.phase, status: block.status,
      attempts: block.attempts, error: block.lastError,
      observed: block.observed ? block.observed.name : null
    }));
    res.json({
      ok: true,
      build: builder.status(),
      verification: builder.verify(),
      tripleCheck: builder.tripleCheck(),
      analysis: builder.analysis,
      registry: builder.engine ? builder.engine.registry.describe() : null,
      blocks: { total: all.length, filtered: filtered.length, offset, limit, entries: page }
    });
  });

  app.post('/api/builds/:id/action', sameOrigin, rateLimit, async (req, res) => {
    const builder = services.builders && (services.builders.get(req.params.id)
      || [...services.builders.values()].find((entry) => entry.id.startsWith(req.params.id)));
    if (!builder) return res.status(404).json({ ok: false, error: 'unknown build' });
    const action = String(req.body?.action || '').toLowerCase();
    const steps = Math.min(500, Math.max(1, Number(req.body?.steps) || 40));
    const extras = req.body?.includeExtras === true ? ' extras' : '';
    const lines = {
      pause: `build pause ${builder.id}`,
      resume: `build resume ${builder.id}`,
      cancel: `build stop ${builder.id}`,
      stop: `build stop ${builder.id}`,
      verify: `build verify ${builder.id}`,
      repair: `build repair ${builder.id}${extras}`,
      run: `build run ${builder.id} ${steps}`
    };
    const line = lines[action];
    if (!line) return res.status(400).json({ ok: false, error: `unknown action ${action}` });
    if (!services.commands) return res.status(503).json({ ok: false, error: 'commands unavailable' });
    // The domain endpoint is not a confirmation bypass. These actions destroy
    // or place live world state, so the caller must opt in explicitly exactly
    // as the command line does; pause/resume/verify remain safe.
    const needsConfirmation = ['cancel', 'stop', 'repair', 'run'].includes(action);
    if (needsConfirmation && req.body?.confirm !== true) {
      return res.status(400).json({
        ok: false, code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true,
        error: `build ${action} requires explicit confirmation`
      });
    }
    try {
      // Domain endpoint for the build card, but the action still goes through
      // the registry: the CLI and every button resolve to the same handler.
      const entry = await services.commands.execute(line, { source: 'dashboard', operator: 'dashboard', confirmed: needsConfirmation });
      invalidate();
      const payload = entry.result || { ok: false, error: entry.error || 'command failed' };
      if (payload.ok === false) return res.status(400).json({ ...payload, command: entry.line });
      return res.json({ ...payload, command: entry.line });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/events', (req, res) => {
    // Bound the number of live streams; each one holds a socket and a timer
    // reference for as long as the browser keeps it open.
    while (eventClients.size >= 50) {
      const oldest = eventClients.values().next().value;
      eventClients.delete(oldest);
      try { oldest.end(); } catch (_) { /* already gone */ }
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    try {
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    } catch (err) {
      res.end(`event: error\ndata: ${JSON.stringify({ error: 'state snapshot failed' })}\n\n`);
      return;
    }
    eventClients.add(res);
    startEventTimer();
    req.on('close', () => {
      eventClients.delete(res);
      if (!eventClients.size && eventTimer) {
        clearInterval(eventTimer);
        eventTimer = null;
      }
    });
  });

  // Legal SPA navigation that survived every API and static route. The
  // fallback is deliberately the last non-error middleware so a new API route
  // added above can never be swallowed by the HTML shell.
  app.use(serveShell);

  app.use((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const isApi = req.path === '/api' || req.path.startsWith('/api/');
    if (isApi) return res.status(404).json({ ok: false, error: 'not found', path: req.path });
    // A path with a filename extension is an asset/download request. Never
    // smuggle the HTML shell into a missing JavaScript, CSS or image URL.
    const assetLike = /\/[^/]*\.[^/]+$/.test(req.path);
    if (assetLike || !req.accepts('html')) return res.status(404).type('text').send('Not found');
    return res.status(404).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · Chickenbots</title>
<meta name="chickenbots-build" content="${build.buildId}">
<link rel="stylesheet" href="/css/tokens.css?v=${build.frontendHash}">
<link rel="stylesheet" href="/css/components.css?v=${build.frontendHash}">
</head><body style="display:grid;place-items:center;min-height:100vh">
<main class="card" style="max-width:440px;margin:24px;padding:28px">
  <div class="eyebrow">Chickenbots</div>
  <h1 style="font-size:22px;margin:6px 0 4px">Page not found</h1>
  <p class="muted" style="margin-bottom:18px">No dashboard view matches <span class="mono">${escapeHtml(req.path)}</span>.</p>
  <a class="button button--primary" href="/">Return to overview</a>
</main></body></html>`);
  });

  // Never return Express's default HTML stack trace (which includes local
  // filesystem paths) to a network client. Error handling is the final layer
  // so failures in the 404 path are also converted to JSON.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = Number(err.status || err.statusCode) || 500;
    const message = status === 413 ? 'request body too large' : status >= 500 ? 'internal server error' : (err.message || 'request failed');
    if (status >= 500) services.logger?.error(`dashboard request failed: ${err.message}`);
    if (res.headersSent) return res.end();
    return res.status(status).json({ ok: false, error: message });
  });

  const bindProblem = dashboardBindProblem({ host, token: accessToken, allowInsecure: config.dashboard.allowInsecure });
  if (!accessToken && !LOOPBACK_HOSTS.has(String(host).toLowerCase()) && config.dashboard.allowInsecure === true) {
    services.logger?.warn(`dashboard is bound to ${host}:${port} without DASHBOARD_TOKEN because DASHBOARD_ALLOW_INSECURE=true; anyone who can reach this port can issue commands`);
  }

  const server = http.createServer(app);
  return {
    app,
    server,
    snapshot,
    invalidate,
    start() {
      return new Promise((resolve, reject) => {
        if (bindProblem) return reject(new Error(bindProblem));
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ ok: true, host: address.address, port: address.port, url: `http://${host}:${address.port}`, build });
        });
      });
    },
    stop() {
      if (eventTimer) clearInterval(eventTimer);
      eventTimer = null;
      for (const client of eventClients) {
        try { client.end(); } catch (_) { /* already closed */ }
      }
      eventClients.clear();
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({ ok: true });
        };
        try { server.close(finish); } catch (_) { finish(); }
        // SSE and keep-alive browser connections otherwise make server.close()
        // wait forever, which in turn makes Ctrl+C look like it did nothing.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        else if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        const force = setTimeout(finish, 1500);
        if (force.unref) force.unref();
      });
    },
    get url() { return `http://${host}:${port}`; }
  };
}

/** Real top-down height map of the regenerated schematic, used for previews. */
function topDownPreview(schematic) {
  const { width, length } = schematic.dimensions;
  const cells = new Map();
  for (const [x, y, z, index] of schematic.blocks) {
    const name = schematic.palette[index];
    if (!name || name.includes('air')) continue;
    const key = `${x},${z}`;
    const existing = cells.get(key);
    if (!existing || y > existing.y) cells.set(key, { x, z, y, block: name });
  }
  const max = 2500;
  const stride = Math.max(1, Math.ceil(Math.sqrt(cells.size / max)));
  const sampled = [];
  for (const cell of cells.values()) {
    if (cell.x % stride || cell.z % stride) continue;
    sampled.push(cell);
  }
  return { width, length, height: schematic.dimensions.height, stride, cells: sampled };
}

module.exports = { createDashboard, dashboardBindProblem, worldSnapshot, attachmentFilename, SHELL_ROUTES };
