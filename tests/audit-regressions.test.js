'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { config, validateConfig } = require('../src/config');
const { redactString, redactValue } = require('../src/util/redact');
const { Logger } = require('../src/logger');
const { classifyKick } = require('../src/bot/connection');
const { TaskBoard } = require('../src/team/taskBoard');
const { ResourceLedger } = require('../src/team/resourceLedger');
const { TeamMemory } = require('../src/team/teamMemory');
const { createRuntime } = require('../src/runtime');
const { createDashboard } = require('../src/dashboard/server');

function request(port, path, { method = 'GET', headers = {}, auth = null } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (auth) finalHeaders.Authorization = auth;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: finalHeaders }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('the repository ships no default credential and config validation is explicit', () => {
  assert.equal(config.server.loginPassword, '');
  assert.equal(config.server.registerPassword, '');
  assert.equal(validateConfig(config).ok, true);

  const noPassword = validateConfig(config, { requireCredentials: true });
  assert.equal(noPassword.ok, false);
  assert.ok(noPassword.errors.some((error) => /MC_LOGIN_PASSWORD/.test(error)));

  const broken = JSON.parse(JSON.stringify(config));
  broken.server.port = 0;
  broken.dashboard.token = 'short';
  broken.autonomy.ai.enabled = true;
  const invalid = validateConfig(broken);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes('server.port')));
  assert.ok(invalid.errors.some((error) => error.includes('dashboard.token')));
  assert.ok(invalid.errors.some((error) => error.includes('autonomy.ai.enabled')));
});

test('log messages and metadata are redacted before any sink sees them', () => {
  const previous = config.server.loginPassword;
  config.server.loginPassword = 'test-only-password-42';
  const entries = [];
  const logger = new Logger({ level: 'debug' });
  logger.addSink((entry) => entries.push(entry));
  try {
    logger.info('connecting with /login test-only-password-42');
    logger.info('request', { password: 'test-only-password-42', nested: { token: 'abc123' } });
    const text = JSON.stringify(entries);
    assert.doesNotMatch(text, /test-only-password-42/);
    assert.doesNotMatch(text, /abc123/);
    assert.match(text, /\[redacted\]/);
    assert.doesNotMatch(redactString('/register a b'), /a b/);
    assert.match(redactString('/register a b'), /\[redacted\]/);
  } finally {
    config.server.loginPassword = previous;
  }
});

test('operator and ban kicks pause retries while throttling remains retryable', () => {
  assert.equal(classifyKick('Kicked by an operator: stop building here').pauseRetries, true);
  assert.equal(classifyKick('You are banned from this server').pauseRetries, true);
  const throttle = classifyKick('Connection throttled! Please wait before reconnecting.');
  assert.equal(throttle.kind, 'throttle');
  assert.equal(throttle.pauseRetries, false);
  assert.equal(classifyKick('socket hang up').pauseRetries, false);
});

test('a failed multi-lock claim rolls back every lock it acquired', () => {
  const board = new TaskBoard();
  assert.equal(board.acquireLock('chest:b', '10101000').ok, true);
  const { task } = board.addTask({ type: 'STORE_ITEMS', lockKeys: ['chest:a', 'chest:b'] });
  const claim = board.claim(task.id, '________');
  assert.equal(claim.ok, false);
  assert.equal(board.locksHeldBy('________').length, 0);
  assert.equal(board.locksHeldBy('10101000').length, 1);

  // The same owner re-claiming is idempotent and does not inflate locks.
  assert.equal(board.releaseLock('chest:b', '10101000'), true);
  assert.equal(board.claim(task.id, '________').ok, true);
  const again = board.claim(task.id, '________');
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(board.locksHeldBy('________').length, 2);
  assert.equal(board.complete(task.id, { by: '10101000', verified: true }).ok, false);
  assert.equal(board.complete(task.id, { verified: true }).ok, false);
  assert.equal(board.complete(task.id, { by: '________', verified: true }).ok, true);
});

test('ledger reservation accounting cannot go negative and history stays bounded', () => {
  const ledger = new ResourceLedger({ maxHistory: 100 });
  ledger.updateBotInventory('________', { dirt: 10 });
  const reserve = ledger.reserve('dirt', 5, { purpose: 'build' });
  assert.equal(reserve.ok, true);
  assert.equal(ledger.reserved('dirt', { excludePurpose: 'build' }), 0);
  assert.equal(ledger.reserved('dirt'), 5);
  assert.equal(ledger.commit(reserve.reservation.id, -5).ok, false);
  assert.equal(ledger.commit(reserve.reservation.id, Number.NaN).ok, false);
  assert.equal(ledger.commit(reserve.reservation.id, 2).reservation.remaining, 3);
  for (let i = 0; i < 500; i++) ledger.setReserveTarget('dirt', i);
  assert.ok(ledger.history.length <= 100);
});

test('team memory rejects observations attributed to a non-roster player', () => {
  const memory = new TeamMemory();
  const rejected = memory.observe({ type: 'ORE_DEPOSIT', reportedBy: 'NotABot', position: { x: 0, y: 0, z: 0 } });
  assert.equal(rejected.ok, false);
  const accepted = memory.observe({ type: 'ORE_DEPOSIT', reportedBy: '10101000', position: { x: 0, y: 12, z: 0 } });
  assert.equal(accepted.ok, true);
});

test('dashboard token protects state and static assets while healthz stays available', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  const oldToken = config.dashboard.token;
  config.dashboard.token = 'audit-test-token-123456';
  const dash = createDashboard(runtime.services, { port: 0, host: '127.0.0.1' });
  try {
    const { port } = await dash.start();
    const health = await request(port, '/healthz');
    assert.equal(health.status, 200);
    const denied = await request(port, '/api/state');
    assert.equal(denied.status, 401);
    assert.match(String(denied.headers['www-authenticate'] || ''), /Basic/);
    assert.match(String(denied.headers['content-security-policy'] || ''), /default-src 'self'/);
    assert.match(String(denied.headers['x-content-type-options'] || ''), /nosniff/);
    const staticDenied = await request(port, '/');
    assert.equal(staticDenied.status, 401);
    const allowed = await request(port, '/api/state', { auth: 'Bearer audit-test-token-123456' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.state.bots.length, 5);
    // Reuse the session cookie, which is what EventSource relies on.
    const cookie = String(allowed.headers['set-cookie'] || '').split(';')[0];
    assert.match(cookie, /^cb_dash=/);
    const cookieAllowed = await request(port, '/api/commands', { headers: { Cookie: cookie } });
    assert.equal(cookieAllowed.status, 200);
  } finally {
    await dash.stop();
    config.dashboard.token = oldToken;
    await runtime.shutdown('test');
  }
});

test('logger redacts secret-shaped metadata before sinks or history see it', () => {
  const logger = new Logger('audit', 'debug');
  const seen = [];
  logger.addSink((entry) => seen.push(entry));
  logger.info('login attempt', { password: 'do-not-log', nested: { token: 'abc123', note: 'safe' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].meta.password, '[redacted]');
  assert.equal(seen[0].meta.nested.token, '[redacted]');
  assert.equal(seen[0].meta.nested.note, 'safe');
  assert.equal(logger.history.at(-1).meta.password, '[redacted]');
});

test('simulated adapters disconnect honestly and can tick again after reconnect', async () => {
  const { MockBot } = require('../src/bot/mockBot');
  const bot = new MockBot({ name: '________' });
  assert.equal(bot.ready, true);
  const result = await bot.disconnect('test');
  assert.equal(result.ok, true);
  assert.equal(bot.connected, false);
  assert.equal(bot.spawned, false);
  assert.equal(bot.authenticated, false);
  assert.equal(bot.ready, false);
  bot.connected = true;
  bot.spawned = true;
  bot.authenticated = true;
  bot.startTicking(1000);
  assert.ok(bot._tickHandle);
  bot.stopTicking();
});

test('emergency history and resolved records stay bounded', () => {
  const { EmergencyManager } = require('../src/team/emergencies');
  const manager = new EmergencyManager({ now: () => 1000 });
  for (let i = 0; i < 300; i++) {
    const created = manager.report({ name: '________', connected: true, spawned: true, health: 3, food: 20 });
    assert.equal(created.length, 1);
    manager.resolve(created[0].id, { confirmedSafe: true, reason: 'test' });
  }
  assert.ok(manager.history.length <= 500, `history was ${manager.history.length}`);
  assert.ok(manager.emergencies.size <= 100, `resolved records were ${manager.emergencies.size}`);
  assert.equal(manager.active().length, 0);
});

test('redaction preserves shared references instead of calling them circular', () => {
  const weapon = { name: 'diamond_sword', damage: 7 };
  const redacted = redactValue({ weapons: [weapon], bestWeapon: weapon, secret: { token: 'abc123' } });
  assert.equal(redacted.bestWeapon.name, 'diamond_sword');
  assert.equal(redacted.bestWeapon, redacted.weapons[0]);
  assert.equal(redacted.secret, '[redacted]');
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.equal(redactValue(cyclic).self, '[circular]');
});

test('automatic planning backs off instead of recreating a failed objective every tick', () => {
  const { TeamCoordinator } = require('../src/team/teamCoordinator');
  let now = 1000;
  const coordinator = new TeamCoordinator({ now: () => now, autoPlan: true });
  const first = coordinator.ensureObjectives();
  assert.equal(first.created, true);
  const task = coordinator.board.listTasks({ objectiveId: first.objective.id })[0];
  coordinator.board.fail(task.id, 'test failure', { by: null, retry: false });
  assert.equal(coordinator.board.getObjective(first.objective.id).status, 'FAILED');
  assert.equal(coordinator.ensureObjectives(), null);
  now += coordinator.planRetryMs + 1;
  const second = coordinator.ensureObjectives();
  assert.equal(second.created, true);
  assert.notEqual(second.objective.id, first.objective.id);
});

test('storage installation crafts, places and reports a verified quantity', async () => {
  const { MockBot } = require('../src/bot/mockBot');
  const { MockWorld } = require('../src/bot/mockWorld');
  const { BotActions } = require('../src/actions');
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '________', world, inventory: { oak_planks: 16, oak_log: 8 }, position: { x: 10, y: 64, z: 10 } });
  const board = new TaskBoard({ now: () => 1000 });
  const actions = new BotActions({ bot, taskBoard: board, ledger: new ResourceLedger({ now: () => 1000 }), home: { x: 10, y: 64, z: 10 } });
  const task = board.addTask({ type: 'STORE_ITEMS', params: { containers: 2 }, units: { target: 2 } });
  const result = await actions.performTask(task.task, {});
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.quantity, 2);
  assert.equal(result.placed, 2);
  assert.equal(bot.countItem('chest'), 0);
});

test('a bed task places a new bed every call instead of re-reporting an existing one', async () => {
  const { MockBot } = require('../src/bot/mockBot');
  const { MockWorld } = require('../src/bot/mockWorld');
  const { BotActions } = require('../src/actions');
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '10101000', world, inventory: { white_bed: 4 }, position: { x: 4, y: 64, z: 4 } });
  const actions = new BotActions({ bot, taskBoard: new TaskBoard({ now: () => 1000 }), home: { x: 4, y: 64, z: 4 } });
  const first = await actions.sleep.ensureBed({ placeNew: true });
  const second = await actions.sleep.ensureBed({ placeNew: true });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.placed, true);
  assert.equal(second.placed, true);
  assert.notDeepEqual(first.bed, second.bed);
  assert.equal(bot.countItem('white_bed'), 2);
});

test('farming can establish a crop from bare soil and harvests return seeds', async () => {
  const { MockBot } = require('../src/bot/mockBot');
  const { MockWorld } = require('../src/bot/mockWorld');
  const { BotActions } = require('../src/actions');
  const world = new MockWorld();
  const bot = new MockBot({ name: '00110000', world, inventory: { wheat_seeds: 6, wooden_hoe: 1, water_bucket: 1 }, position: { x: -6, y: 65, z: -6 } });
  const actions = new BotActions({ bot, taskBoard: new TaskBoard({ now: () => 1000 }), home: { x: -6, y: 65, z: -6 } });
  const planted = await actions.farming.plantCrops({ crop: 'wheat', count: 4 });
  assert.ok(planted.planted > 0, JSON.stringify(planted));
  world.advanceCrops(8);
  const harvest = await actions.farming.harvestAll({ crop: 'wheat', limit: 4 });
  assert.ok(harvest.harvested > 0, JSON.stringify(harvest));
  assert.ok(bot.countItem('wheat_seeds') >= 1, 'wheat harvest should drop at least one seed');
});

test('mock movement is clamped to the materialised world and mining honours its depth floor', async () => {
  const { MockBot } = require('../src/bot/mockBot');
  const bot = new MockBot({ name: '11001100' });
  await bot.goTo({ x: 99999, y: 64, z: -99999 }, { range: 1 });
  assert.ok(Math.abs(bot.position.x) <= bot.world.size - 2);
  assert.ok(Math.abs(bot.position.z) <= bot.world.size - 2);
  const actions = new (require('../src/actions').BotActions)({ bot, taskBoard: new TaskBoard({ now: () => 1000 }), home: bot.position });
  const result = await actions.mining.mineOresDeep({ maxDepth: 4, minY: bot.position.y });
  assert.ok(result.results.some((r) => /minimum mining depth/.test(r.error || '')), JSON.stringify(result));
});

test('the join queue spaces starts and records one strike per outage episode', async () => {
  const runtime = await createRuntime({ simulate: true, connect: false, dashboard: false });
  const joinInterval = config.server.joinIntervalMs;
  const joinJitter = config.server.joinJitterMs;
  const throttleDelay = config.server.reconnect.throttleDelayMs;
  try {
    config.server.joinIntervalMs = 80;
    config.server.joinJitterMs = 0;
    config.server.reconnect.throttleDelayMs = 1200;
    runtime.nextJoinAt = 0;
    const releaseFirst = await runtime._acquireJoinSlot();
    releaseFirst();
    const started = Date.now();
    const releaseSecond = await runtime._acquireJoinSlot();
    releaseSecond();
    assert.ok(Date.now() - started >= 60, 'second join slot must wait for the per-IP interval');

    assert.equal(runtime.throttleStrikes, 0);
    runtime._registerJoinBackoff('throttled', 'Connection throttled!');
    const firstCooldown = runtime.joinCooldownUntil - Date.now();
    assert.ok(firstCooldown >= 900 && firstCooldown < 2000, `first cooldown was ${firstCooldown}`);
    runtime._registerJoinBackoff('throttled', 'Connection throttled!');
    const secondCooldown = runtime.joinCooldownUntil - Date.now();
    assert.equal(runtime.throttleStrikes, 1, 'one outage episode records one strike, not one per bot');
    assert.ok(secondCooldown <= firstCooldown + 100, 'an already-running pause is not pushed further out');

    // A ready session closes the episode. A genuinely separate outage then
    // escalates the strike level and the bounded cooldown.
    runtime.joinScheduler.success();
    runtime._registerJoinBackoff('throttled', 'Connection throttled!');
    const thirdCooldown = runtime.joinCooldownUntil - Date.now();
    assert.equal(runtime.throttleStrikes, 2);
    assert.ok(thirdCooldown > firstCooldown, 'a separate outage grows the cooldown');
  } finally {
    config.server.joinIntervalMs = joinInterval;
    config.server.joinJitterMs = joinJitter;
    config.server.reconnect.throttleDelayMs = throttleDelay;
    if (runtime.shutdownController) runtime.shutdownController.abort();
  }
});

test('the pre-join safety tick never overlaps itself while the autonomy gate is closed', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    runtime.running = true;
    Object.defineProperty(runtime, 'autonomyAllowed', { configurable: true, get: () => false });
    let calls = 0;
    let active = 0;
    let peak = 0;
    runtime._safetyOnlyTick = async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active--;
    };
    const first = runtime._tick();
    const second = runtime._tick();
    await Promise.all([first, second]);
    assert.equal(calls, 1, 'a second interval tick must not stack another safety pass');
    assert.equal(peak, 1);
    assert.equal(runtime.ticking, false, 'the guard must be released after the tick');
  } finally {
    await runtime.shutdown('test');
  }
});

test('per-packet traces are opt-in and cannot flood stdout by default', () => {
  const previous = process.env.MC_TRACE_PACKETS;
  const logger = new Logger({ level: 'debug' });
  const seen = [];
  logger.addSink((entry) => seen.push(entry));
  try {
    delete process.env.MC_TRACE_PACKETS;
    logger.debug('lifecycle detail is still visible');
    logger.debug('[________] TRACE out position pos=1,64,1');
    assert.equal(seen.length, 1);
    assert.match(seen[0].msg, /lifecycle detail/);
    process.env.MC_TRACE_PACKETS = 'true';
    logger.debug('[________] TRACE out position pos=2,64,2');
    assert.equal(seen.length, 2);
    assert.match(seen[1].msg, /pos=2/);
  } finally {
    if (previous === undefined) delete process.env.MC_TRACE_PACKETS;
    else process.env.MC_TRACE_PACKETS = previous;
  }
});
