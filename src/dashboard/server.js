'use strict';

const http = require('http');
const path = require('path');
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
  app.use(express.json({ limit: '2mb' }));
  const publicDir = path.join(__dirname, 'public');
  app.use('/', express.static(publicDir, {
    index: 'index.html',
    setHeaders(res, file) {
      // A running dashboard is frequently updated during commissioning; force
      // browsers to revalidate JS/CSS/HTML instead of showing an old roster.
      if (/\.(?:html|js|css)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  // Snapshot assembly is comparatively expensive (live action scans), so all
  // HTTP and SSE consumers share one freshly-built value per interval.
  let snapshotCache = { at: 0, value: null };
  const snapshot = (force = false) => {
    if (!force && snapshotCache.value && Date.now() - snapshotCache.at < 1500) return snapshotCache.value;
    snapshotCache = { at: Date.now(), value: statusSnapshot(services) };
    return snapshotCache.value;
  };
  const eventClients = new Set();
  let eventTimer = null;
  const startEventTimer = () => {
    if (eventTimer) return;
    eventTimer = setInterval(() => {
      if (!eventClients.size) return;
      const payload = `event: state\ndata: ${JSON.stringify(snapshot(true))}\n\n`;
      for (const client of eventClients) {
        try { client.write(payload); } catch (_) { eventClients.delete(client); }
      }
    }, 2500);
    if (eventTimer.unref) eventTimer.unref();
  };

  // Mutating routes accept same-origin requests only and are rate limited.
  const buckets = new Map();
  const rateLimit = (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'local';
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
      res.json({ ok: true, state: snapshot() });
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
        server: { host: config.server.host, port: config.server.port, version: config.server.version, auth: config.server.auth },
        dashboard: { host: config.dashboard.host, port: config.dashboard.port },
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
    const result = await services.commands.execute(line, { source: 'dashboard', operator: (req.body && req.body.operator) || 'dashboard', confirmed: Boolean(confirm) });
    snapshotCache = { at: 0, value: null };
    res.json(result);
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
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

  const server = http.createServer(app);
  return {
    app,
    server,
    snapshot,
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
