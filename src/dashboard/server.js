'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { config } = require('../config');
const { statusSnapshot } = require('../runtimeState');
const { toSpongeSchematic, toJSON } = require('../schematics/format');
const logStore = require('../logStore');

/**
 * Dashboard server. Binds 0.0.0.0:3000 by default so the sandbox preview can
 * reach it; all client URLs are relative. Commands go through the same
 * validated registry as the terminal (chat is never an execution source).
 */
function createDashboard(services, { port = config.dashboard.port, host = config.dashboard.host } = {}) {
  const app = express();
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
  app.use(express.static(publicDir, {
    index: 'index.html',
    setHeaders(res, file) {
      // A running dashboard is frequently updated during commissioning; force
      // browsers to revalidate JS/CSS/HTML instead of showing an old roster.
      if (/\.(?:html|js|css)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  // Snapshot assembly takes a few tens of milliseconds. Keep only a very
  // short coalescing cache for concurrent callers, and always force a fresh
  // build for the state endpoint and the SSE stream: a stale "online" card is
  // worse than spending the milliseconds.
  const SNAPSHOT_CACHE_MS = 500;
  let snapshotCache = { at: 0, value: null };
  const invalidate = () => { snapshotCache = { at: 0, value: null }; };
  const snapshot = (force = false) => {
    if (!force && snapshotCache.value && Date.now() - snapshotCache.at < SNAPSHOT_CACHE_MS) return snapshotCache.value;
    snapshotCache = { at: Date.now(), value: statusSnapshot(services) };
    return snapshotCache.value;
  };
  const eventClients = new Set();
  let eventTimer = null;
  const startEventTimer = () => {
    if (eventTimer) return;
    // One second keeps the browser close enough to the real connection state
    // that a kicked bot no longer reads as online for several seconds.
    eventTimer = setInterval(() => {
      if (!eventClients.size) return;
      let payload;
      try {
        payload = `event: state\ndata: ${JSON.stringify(snapshot(true))}\n\n`;
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
    }, 1000);
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
    res.json({ ok: true, uptimeMs: process.uptime() * 1000, mode: services.mode || 'live' });
  });

  app.get('/api/state', (req, res) => {
    try {
      res.json({ ok: true, state: snapshot(true) });
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
    res.json({
      ok: true,
      settings: {
        server: { host: config.server.host, port: config.server.port, version: config.server.version, auth: config.server.auth, joinIntervalMs: config.server.joinIntervalMs, joinJitterMs: config.server.joinJitterMs, rejoinDelayMs: config.server.rejoinDelayMs },
        dashboard: { host: config.dashboard.host, port: config.dashboard.port },
        security: { tokenRequired: Boolean(accessToken), passwordConfigured: Boolean(config.server.loginPassword || config.server.registerPassword) },
        roster: config.team.names,
        pvp: config.autonomy.pvp,
        ai: { enabled: config.autonomy.ai.enabled, provider: config.autonomy.ai.provider || null },
        autonomy: { tickMs: config.autonomy.tickMs, enabled: services.runtime ? services.runtime.state().running : false, paused: services.runtime ? services.runtime.state().paused : false },
        excavation: { maxBlocks: config.excavation ? config.excavation.maxBlocks : null },
        reserves: config.reserves,
        limits: { commandRatePerMinute: 120, requestBodyMb: 2 }
      }
    });
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

  app.get('/api/commands', (req, res) => {
    if (!services.commands) return res.status(503).json({ ok: false, error: 'commands unavailable' });
    res.json({
      ok: true,
      commands: services.commands.list(),
      history: services.commands.recent(30),
      taskTypes: services.commands.taskTypes || []
    });
  });

  app.post('/api/command', sameOrigin, rateLimit, async (req, res) => {
    if (!services.commands) return res.status(503).json({ ok: false, error: 'commands unavailable' });
    const { line, confirm } = req.body || {};
    if (!line) return res.status(400).json({ ok: false, error: 'missing command line' });
    try {
      const result = await services.commands.execute(line, { source: 'dashboard', operator: (req.body && req.body.operator) || 'dashboard', confirmed: confirm === true });
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
    let filtered = services.library.list({ tier, category, q, limit: 5000 });
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
    res.json({ ok: true, count: services.library.count, total: filtered.length, offset: start, limit: size, designs });
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
    res.setHeader('Content-Disposition', `attachment; filename="${design.id}.schem"`);
    res.send(buffer);
  });

  app.get('/api/schematics/:id.json', (req, res) => {
    if (!services.library || !services.library.loaded) return res.status(503).json({ ok: false, error: 'library not generated' });
    const design = services.library.get(req.params.id);
    if (!design) return res.status(404).json({ ok: false, error: 'unknown schematic' });
    res.json({ ok: true, schematic: toJSON(services.library.build(design.id)) });
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
      res.write(`event: state\ndata: ${JSON.stringify(snapshot(true))}\n\n`);
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

  app.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  // Never return Express's default HTML stack trace (which includes local
  // filesystem paths) to a network client.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = Number(err.status || err.statusCode) || 500;
    const message = status === 413 ? 'request body too large' : status >= 500 ? 'internal server error' : (err.message || 'request failed');
    if (status >= 500) services.logger?.error(`dashboard request failed: ${err.message}`);
    if (res.headersSent) return res.end();
    return res.status(status).json({ ok: false, error: message });
  });

  if (!accessToken && !['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase())) {
    services.logger?.warn(`dashboard is bound to ${host}:${port} without DASHBOARD_TOKEN; anyone who can reach this port can issue commands`);
  }

  const server = http.createServer(app);
  return {
    app,
    server,
    snapshot,
    invalidate,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ ok: true, host: address.address, port: address.port, url: `http://${host}:${address.port}` });
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

module.exports = { createDashboard };
