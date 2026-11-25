'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createRuntime } = require('../src/runtime');
const { statusSnapshot } = require('../src/runtimeState');
const { connectionStatus } = require('../src/bot/status');
const { createDashboard } = require('../src/dashboard/server');

const NAMES = ['________', '10101000', '01010100', '11001100', '00110000'];

function request(port, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('connection status is a single honest verdict for every lifecycle state', () => {
  const base = { connected: true, spawned: true, authenticated: true, ready: true, health: 20, lastEventAt: Date.now() };
  assert.equal(connectionStatus(base).status, 'online');
  assert.equal(connectionStatus(base).online, true);

  const kicked = connectionStatus({ ...base, connected: false, spawned: false, authenticated: false, ready: false, lastError: 'Timed out' });
  assert.equal(kicked.status, 'offline');
  assert.equal(kicked.online, false);

  const joining = connectionStatus({ ...base, spawned: false, authenticated: false, ready: false });
  assert.equal(joining.status, 'joining');
  assert.equal(joining.online, false);

  const auth = connectionStatus({ ...base, authenticated: false, ready: false, lastError: 'wrong password' });
  assert.equal(auth.status, 'auth_failed');
  // The server still has this player in its world. Online and ready are
  // separate verdicts; an auth problem must never be painted as offline.
  assert.equal(auth.online, true);
  assert.equal(auth.gameplayReady, false);

  // A ready entity proves the session is live even when a legacy boolean or a
  // stale auth error is still hanging around from an earlier attempt.
  const readyWithStaleAuth = connectionStatus({ ...base, authenticated: false, lastError: 'no login confirmation' });
  assert.equal(readyWithStaleAuth.status, 'online');
  assert.equal(readyWithStaleAuth.online, true);

  const dead = connectionStatus({ ...base, health: 0 });
  assert.equal(dead.status, 'dead');
  assert.equal(dead.online, true, 'a dead but spawned bot is still online');
  assert.equal(dead.gameplayReady, false);

  const stale = connectionStatus({ ...base, lastEventAt: Date.now() - 120000 }, { staleAfterMs: 90000 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.online, true, 'presence survives a silent packet gap');
  assert.equal(stale.gameplayReady, false);

  const initialising = connectionStatus({ ...base, ready: false });
  assert.equal(initialising.status, 'online_not_ready');
  assert.equal(initialising.online, true);
  assert.equal(initialising.gameplayReady, false);
});

test('the snapshot never reports a kicked or failed bot as online', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    let snapshot = statusSnapshot(runtime.services);
    assert.equal(snapshot.overview.online, 5);
    assert.ok(snapshot.bots.every((bot) => bot.online === true && bot.status === 'online'));

    const kicked = runtime.bots.get('________');
    kicked.connected = false;
    kicked.spawned = false;
    kicked.authenticated = false;
    snapshot = statusSnapshot(runtime.services);
    assert.equal(snapshot.overview.online, 4);
    const row = snapshot.bots.find((bot) => bot.name === '________');
    assert.equal(row.online, false);
    assert.equal(row.status, 'offline');
    assert.ok(snapshot.overview.alerts.some((alert) => alert.bot === '________'));
    assert.equal(snapshot.diagnostics.bots.find((bot) => bot.name === '________').online, false);

    const auth = runtime.bots.get('10101000');
    auth.authenticated = false;
    auth.lastError = 'Incorrect password';
    snapshot = statusSnapshot(runtime.services);
    const authRow = snapshot.bots.find((bot) => bot.name === '10101000');
    assert.equal(authRow.online, true, 'server presence outranks a local auth flag');
    assert.equal(authRow.authPending, true);
    assert.equal(authRow.ready, false);
    assert.equal(authRow.status, 'auth_failed');
    assert.equal(snapshot.overview.online, 4);
  } finally {
    await runtime.shutdown('test');
  }
});

test('a throwing bot summary degrades to offline instead of blanking the dashboard', () => {
  const broken = {
    name: '________', connected: true, spawned: true, authenticated: true, ready: true,
    summary() { throw new Error('adapter exploded'); }
  };
  const snapshot = statusSnapshot({ bots: new Map([['________', broken]]) });
  assert.equal(snapshot.bots.length, 1);
  assert.equal(snapshot.overview.online, 0);
  assert.equal(snapshot.bots[0].online, false);
  assert.equal(snapshot.bots[0].status, 'offline');
  assert.match(snapshot.bots[0].lastError, /adapter exploded/);
});

test('dashboard state and bot actions reflect connection truth immediately', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  const dash = createDashboard(runtime.services, { port: 0, host: '127.0.0.1' });
  try {
    const { port } = await dash.start();
    let state = await request(port, '/api/state');
    assert.equal(state.body.state.overview.online, 5);
    assert.deepEqual(state.body.state.bots.map((bot) => bot.name), NAMES);
    // The website must get the configured names from the live runtime, never
    // from a cached /api/settings or a client-side default roster.
    assert.deepEqual(state.body.state.diagnostics.config.roster, NAMES);
    assert.ok(state.body.state.diagnostics.config.server.joinIntervalMs > 0);
    assert.match(String(state.headers['cache-control']), /no-store/);
    const settings = await request(port, '/api/settings');
    assert.deepEqual(settings.body.settings.roster, NAMES);
    assert.ok(settings.body.settings.server.joinIntervalMs > 0);
    assert.match(String(settings.headers['cache-control']), /no-store/);
    const queue = await request(port, '/api/queue');
    assert.equal(queue.body.ok, true);
    assert.ok(Array.isArray(queue.body.joinQueue.waiting));
    assert.equal(queue.body.bots.length, 5);
    const reset = await request(port, '/api/queue/reset-cooldown', 'POST', {});
    assert.equal(reset.body.ok, true);
    assert.equal(reset.body.joinQueue.cooldownUntil, null);

    const kicked = await request(port, '/api/bot/________/disconnect', 'POST', {});
    assert.equal(kicked.body.ok, true);
    assert.equal(kicked.body.bot.online, false);
    assert.equal(kicked.body.bot.status, 'offline');

    // The next state read must not reuse a pre-kick cached snapshot.
    state = await request(port, '/api/state');
    assert.equal(state.body.state.overview.online, 4);
    const row = state.body.state.bots.find((bot) => bot.name === '________');
    assert.equal(row.online, false);
    assert.equal(row.status, 'offline');
  } finally {
    await dash.stop();
    await runtime.shutdown('test');
  }
});

test('the rejoin hold-down is recorded only after a real authenticated session ends', async () => {
  const live = new (require('../src/bot/realBot').RealBot)({ name: '________', loginPassword: '', registerPassword: '', authEnabled: false });
  live.bot = { entity: {}, quit() {} };
  live.connected = true;
  live.spawned = true;
  live.authenticated = true;
  await live.disconnect('test');
  assert.ok(live.lastSessionEndedAt > 0);

  const failed = new (require('../src/bot/realBot').RealBot)({ name: '________', loginPassword: '', registerPassword: '', authEnabled: false });
  failed.bot = { entity: {}, quit() {} };
  failed.connected = true;
  failed.spawned = false;
  failed.authenticated = false;
  await failed.disconnect('test');
  assert.equal(failed.lastSessionEndedAt, 0);
});

test('a throwing builder status degrades to an error row instead of blanking the snapshot', () => {
  const builder = {
    id: 'broken-build',
    schematic: { name: 'Broken design' },
    engine: null,
    status() { throw new Error('builder exploded'); }
  };
  const snapshot = statusSnapshot({ bots: new Map(), builders: new Map([['broken-build', builder]]) });
  assert.equal(snapshot.builder.builds.length, 1);
  assert.equal(snapshot.builder.builds[0].state, 'ERROR');
  assert.match(snapshot.builder.builds[0].error, /builder exploded/);
  assert.equal(snapshot.building.builds[0].state, 'ERROR');
});

test('home-base status never lazily parses the manifest or scans the custom store', () => {
  const { HomeBaseManager } = require('../src/actions/homeBase');
  let lazyReads = 0;
  const library = {
    loadedInMemory: false,
    get loaded() { lazyReads++; return true; },
    get count() { lazyReads++; return 10000; },
    get knownCount() { lazyReads++; return 10000; },
    get customStore() { lazyReads++; return null; }
  };
  const homeBase = new HomeBaseManager({ library, bots: [], world: null });
  const status = homeBase.status();
  assert.equal(status.availableDesigns, 0);
  assert.equal(lazyReads, 0, 'a status poll must not trigger a 250ms manifest/custom-store load');
});

test('the real schematic library exposes a non-loading status count', () => {
  const { SchematicLibrary } = require('../src/schematics/library');
  const library = new SchematicLibrary();
  assert.equal(library.loadedInMemory, false);
  assert.ok(library.knownCount > 0, 'the generated summary supplies the count');
  assert.equal(library.loadedInMemory, false, 'knownCount must not trigger the 20 MB manifest load');
  const stats = library.stats();
  assert.equal(stats.totalIncludingCustom, library.knownCount);
  assert.equal(stats.fromSummary, true);
  assert.equal(library.loadedInMemory, false, 'stats must not trigger the 20 MB manifest load');
  assert.equal(library.loaded, true);
});
