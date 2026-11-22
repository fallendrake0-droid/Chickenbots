'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { config } = require('../config');
const { statusSnapshot } = require('../runtimeState');
const { toSpongeSchematic, toJSON } = require('../schematics/format');

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
  app.use('/', express.static(publicDir, { index: 'index.html' }));

  const snapshot = () => statusSnapshot(services);

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

  app.get('/api/commands', (req, res) => {
    if (!services.commands) return res.status(503).json({ ok: false, error: 'commands unavailable' });
    res.json({ ok: true, commands: services.commands.list(), history: services.commands.recent(30) });
  });

  app.post('/api/command', async (req, res) => {
    if (!services.commands) return res.status(503).json({ ok: false, error: 'commands unavailable' });
    const { line, confirm } = req.body || {};
    if (!line) return res.status(400).json({ ok: false, error: 'missing command line' });
    const result = await services.commands.execute(line, { source: 'dashboard', operator: (req.body && req.body.operator) || 'dashboard', confirmed: Boolean(confirm) });
    res.json(result);
  });

  app.get('/api/schematics', (req, res) => {
    if (!services.library || !services.library.loaded) return res.status(503).json({ ok: false, error: 'library not generated' });
    const { tier = null, category = null, q = null, limit = 40 } = req.query;
    const designs = services.library.list({ tier, category, q, limit: Math.min(200, Number(limit) || 40) });
    res.json({ ok: true, count: services.library.count, designs });
  });

  app.get('/api/schematics/:id', (req, res) => {
    if (!services.library || !services.library.loaded) return res.status(503).json({ ok: false, error: 'library not generated' });
    const design = services.library.get(req.params.id);
    if (!design) return res.status(404).json({ ok: false, error: 'unknown schematic' });
    res.json({ ok: true, design, materials: Object.entries(design.materials).sort((a, b) => b[1] - a[1]).slice(0, 40) });
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
    const send = () => {
      try {
        res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      } catch (_) {
        /* client disconnected */
      }
    };
    send();
    const timer = setInterval(send, 2500);
    req.on('close', () => clearInterval(timer));
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
      return new Promise((resolve) => server.close(() => resolve({ ok: true })));
    },
    get url() { return `http://${host}:${port}`; }
  };
}

module.exports = { createDashboard };
