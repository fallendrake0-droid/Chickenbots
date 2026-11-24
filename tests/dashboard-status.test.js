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
  assert.equal(auth.online, false);

  // A ready entity proves the session is live even when a legacy boolean or a
  // stale auth error is still hanging around from an earlier attempt.
  const readyWithStaleAuth = connectionStatus({ ...base, authenticated: false, lastError: 'no login confirmation' });
  assert.equal(readyWithStaleAuth.status, 'online');
  assert.equal(readyWithStaleAuth.online, true);

  const dead = connectionStatus({ ...base, health: 0 });
  assert.equal(dead.status, 'dead');
  assert.equal(dead.online, false);

  const stale = connectionStatus({ ...base, lastEventAt: Date.now() - 120000 }, { staleAfterMs: 90000 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.online, false);

  const initialising = connectionStatus({ ...base, ready: false });
  assert.equal(initialising.status, 'initialising');
  assert.equal(initialising.online, false);
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
    assert.equal(authRow.online, false);
    assert.equal(authRow.status, 'auth_failed');
    assert.equal(snapshot.overview.online, 3);
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
    assert.equal(state.body.state.diagnostics.config.server.joinIntervalMs, 10000);
    assert.match(String(state.headers['cache-control']), /no-store/);
    const settings = await request(port, '/api/settings');
    assert.deepEqual(settings.body.settings.roster, NAMES);
    assert.equal(settings.body.settings.server.joinIntervalMs, 10000);
    assert.match(String(settings.headers['cache-control']), /no-store/);

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
