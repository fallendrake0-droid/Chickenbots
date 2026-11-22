'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');

const { createRuntime } = require('../src/runtime');
const { statusSnapshot } = require('../src/runtimeState');
const { createDashboard } = require('../src/dashboard/server');
const { RealBot } = require('../src/bot/realBot');

const TAB_KEYS = ['bots', 'overview', 'team', 'survival', 'combat', 'inventory', 'mining', 'excavation', 'woodcutting', 'farming', 'sleep', 'exploration', 'builder', 'schematics', 'homeBase', 'taskManager', 'diagnostics'];

function httpGet(port, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function simulation(options = {}) {
  const runtime = await createRuntime({ simulate: true, dashboard: false, ...options });
  return runtime;
}

test('runtime snapshot exposes every dashboard section with live values', async () => {
  const runtime = await simulation();
  try {
    assert.equal(runtime.bots.size, 5);
    assert.equal(runtime.autonomyAllowed, true);
    const snapshot = statusSnapshot(runtime.services);
    for (const key of TAB_KEYS) assert.ok(key in snapshot, `missing dashboard section ${key}`);
    assert.equal(snapshot.bots.length, 5);
    assert.equal(snapshot.overview.online, 5);
    assert.equal(snapshot.overview.total, 5);
    assert.ok(snapshot.schematics.stats.count >= 1100);
    assert.equal(snapshot.diagnostics.config.pvp, false);
    assert.deepEqual(snapshot.diagnostics.config.roster, ['______', '101010', '010101', '110011', '001100']);
  } finally {
    await runtime.shutdown('test');
  }
});

test('command registry rejects malformed and dangerous input before execution', async () => {
  const runtime = await simulation();
  try {
    const unknown = await runtime.executeCommand('launch rockets', { source: 'dashboard' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.result.code, 'UNKNOWN_COMMAND');
    const injection = await runtime.executeCommand('status; rm -rf /', { source: 'dashboard' });
    assert.equal(injection.ok, false);
    assert.ok(/illegal characters/.test(injection.result.error));
    const backticks = await runtime.executeCommand('status `whoami`', { source: 'dashboard' });
    assert.equal(backticks.ok, false);
    const shell = await runtime.executeCommand('exec bash', { source: 'dashboard' });
    assert.equal(shell.ok, false);
    const tooMany = await runtime.executeCommand(`status ${'x '.repeat(60)}`, { source: 'dashboard' });
    assert.equal(tooMany.ok, false);
    const chatStop = await runtime.executeCommand('stop', { source: 'chat' });
    assert.equal(chatStop.ok, false);
    assert.equal(chatStop.result.code, 'CHAT_REFUSED');
    const ai = await runtime.executeCommand('ai enable', { source: 'dashboard' });
    assert.equal(ai.result.ok, false);
    assert.ok(/not implemented/.test(ai.result.error));
    const noConfirm = await runtime.executeCommand('build 0001_beginner_shelter', { source: 'dashboard' });
    assert.equal(noConfirm.ok, false);
    assert.equal(noConfirm.result.code, 'CONFIRMATION_REQUIRED');
  } finally {
    await runtime.shutdown('test');
  }
});

test('excavation commands run the full preview/start/pause/resume/stop lifecycle', async () => {
  const runtime = await simulation();
  try {
    const preview = await runtime.executeCommand('excavate preview radius 0 65 0 3 2', { source: 'dashboard' });
    assert.equal(preview.result.ok, true, preview.result.error);
    assert.ok(preview.result.previewId);
    assert.ok(preview.result.plan.volume > 0);
    const unconfirmed = await runtime.executeCommand('excavate start confirm confirm', { source: 'dashboard' });
    assert.equal(unconfirmed.result.ok, false, 'start without a preview id must not create an excavation');
    const start = await runtime.executeCommand(`excavate start ${preview.result.previewId} confirm`, { source: 'dashboard' });
    assert.equal(start.result.ok, true, start.result.error);
    const id = start.result.excavation.id;
    assert.ok(id);
    const status = await runtime.executeCommand(`excavate status ${id}`, { source: 'dashboard' });
    assert.equal(status.result.ok, true);
    const paused = await runtime.executeCommand(`excavate pause ${id}`, { source: 'dashboard' });
    assert.equal(paused.result.ok, true);
    const resumed = await runtime.executeCommand(`excavate resume ${id}`, { source: 'dashboard' });
    assert.equal(resumed.result.ok, true);
    const team = await runtime.executeCommand(`excavate team ${id}`, { source: 'dashboard' });
    assert.equal(team.result.ok, true);
    const stopped = await runtime.executeCommand(`excavate stop ${id}`, { source: 'dashboard' });
    assert.equal(stopped.result.ok, true);
  } finally {
    await runtime.shutdown('test');
  }
});

test('build command rejects missing materials and completes a real 5-bot build when supplied', async () => {
  const runtime = await simulation();
  try {
    const designs = runtime.library.list({ tier: 'Beginner', limit: 120 });
    const sorted = designs.sort((a, b) => a.blocks - b.blocks);
    const design = sorted[0];
    const empty = await runtime.executeCommand(`build ${design.id} 80 72 80 confirm`);
    assert.equal(empty.result.ok, false);
    assert.ok(/materials missing|no .* available/.test(empty.result.error), empty.result.error);

    for (const bot of runtime.bots.values()) {
      const schematic = runtime.library.build(design.id);
      for (const [item, count] of Object.entries(schematic.materials)) bot.addItem(item, count);
    }
    const result = await runtime.executeCommand(`build ${design.id} 80 72 80 confirm run`, { source: 'dashboard' });
    assert.equal(result.result.ok, true, result.result.error);
    assert.ok(result.result.tasks >= 1);
    const builder = runtime.builders.get(result.result.buildId);
    assert.ok(builder);
    const execution = result.result.execution;
    assert.ok(execution, 'run flag must execute tasks');
    const verification = builder.verify();
    assert.equal(verification.complete, true, JSON.stringify(verification.missing.slice(0, 5)));
    assert.equal(execution.status.tasks.COMPLETED, execution.status.tasks.total);
    const status = await runtime.executeCommand('build status', { source: 'dashboard' });
    assert.ok(status.result.builds.length >= 1);
  } finally {
    await runtime.shutdown('test');
  }
});

test('task manager commands create, assign and cancel real tasks', async () => {
  const runtime = await simulation();
  try {
    const added = await runtime.executeCommand('task add CHOP_WOOD manual wood run', { source: 'dashboard' });
    assert.equal(added.result.ok, true);
    const taskId = added.result.task.id;
    const assigned = await runtime.executeCommand(`task assign ${taskId} 101010`, { source: 'dashboard' });
    assert.equal(assigned.result.ok, true);
    assert.equal(assigned.result.assignedTo, '101010');
    const info = await runtime.executeCommand(`task info ${taskId}`, { source: 'dashboard' });
    assert.equal(info.result.task.claimedBy, '101010');
    const cancelled = await runtime.executeCommand(`task cancel ${taskId}`, { source: 'dashboard' });
    assert.equal(cancelled.result.ok, true);
    const invalid = await runtime.executeCommand('task add EXPLODE_EVERYTHING', { source: 'dashboard' });
    assert.equal(invalid.result.ok, false);
  } finally {
    await runtime.shutdown('test');
  }
});

test('dashboard serves all 16 tabs, state, commands and schematic downloads', async () => {
  const runtime = await simulation();
  const dash = createDashboard(runtime.services, { port: 0, host: '127.0.0.1' });
  try {
    const started = await dash.start();
    const port = started.port;
    const index = await httpGet(port, '/');
    assert.equal(index.status, 200);
    assert.ok(index.body.includes('CHICKENBOTS'));
    const appJs = await httpGet(port, '/app.js');
    for (const label of ['OVERVIEW', 'TEAM CONTROL', 'SURVIVAL', 'COMBAT', 'INVENTORY', 'MINING', 'EXCAVATION', 'WOODCUTTING', 'FARMING', 'SLEEP', 'EXPLORATION', 'BUILDER', 'SCHEMATICS', 'HOME BASE', 'TASK MANAGER', 'DIAGNOSTICS']) {
      assert.ok(appJs.body.includes(label), `missing tab ${label}`);
    }
    const state = await httpGet(port, '/api/state');
    const parsed = JSON.parse(state.body);
    assert.equal(parsed.ok, true);
    for (const key of TAB_KEYS) assert.ok(key in parsed.state);
    const command = await httpGet(port, '/api/command', 'POST', { line: 'status' });
    assert.equal(JSON.parse(command.body).result.ok, true);
    const schematics = await httpGet(port, '/api/schematics?limit=3');
    assert.equal(JSON.parse(schematics.body).designs.length, 3);
    const download = await httpGet(port, '/api/schematics/0001_beginner_shelter/download.schem');
    assert.equal(download.status, 200);
    assert.ok(Number(download.headers['content-length']) > 100);
    const health = await httpGet(port, '/healthz');
    assert.equal(JSON.parse(health.body).ok, true);
    const missing = await httpGet(port, '/nope');
    assert.equal(missing.status, 404);
  } finally {
    await dash.stop();
    await runtime.shutdown('test');
  }
});

class FakeBot extends EventEmitter {
  constructor() {
    super();
    this.entity = { position: { x: 1, y: 64, z: 1 } };
    this.inventory = { items: () => [] };
    this.game = { dimension: 'overworld' };
    this.time = { timeOfDay: 1000, day: 1 };
    this.health = 20;
    this.food = 20;
    this.oxygenLevel = 20;
    this.entities = {};
    this.quitCalls = 0;
  }
  blockAt(pos) { return { name: 'air', boundingBox: 'empty', position: pos }; }
  quit() { this.quitCalls++; }
  chat() { this.chatted = (this.chatted || []).concat(''); }
}

test('RealBot refuses autonomy until login and spawn are both verified', async () => {
  const fake = new FakeBot();
  const real = new RealBot({ name: '______', createBot: () => fake, connectTimeoutMs: 2000 });
  assert.equal(real.ready, false);
  const pre = await real.digBlock({ x: 1, y: 64, z: 1 });
  assert.equal(pre.ok, false);
  assert.ok(pre.error.includes('not ready'));
  const connecting = real.connect({ timeoutMs: 60 });
  const timeout = await connecting;
  assert.equal(timeout.ok, false);
  assert.equal(real.ready, false);

  const second = new RealBot({ name: '101010', createBot: () => fake, connectTimeoutMs: 2000 });
  const pending = second.connect({ timeoutMs: 2000 });
  fake.emit('login');
  fake.emit('spawn');
  const ready = await pending;
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(second.ready, true);
  assert.equal(second.authenticated, true);
  assert.equal(second.spawned, true);
  assert.equal(second.getBlock({ x: 1, y: 64, z: 1 }).name, 'air');

  const teammate = await second.attack({ id: 99, username: '______' });
  assert.equal(teammate.ok, false);
  assert.ok(teammate.error.includes('teammates'));
  const player = await second.attack({ id: 98, username: 'SomePlayer' });
  assert.equal(player.ok, false);
  assert.ok(player.error.includes('PvP'));
  const noItem = await second.placeBlock({ x: 2, y: 64, z: 1 }, 'oak_planks');
  assert.equal(noItem.ok, false);
  assert.ok(noItem.error.includes('no oak_planks'));
  assert.throws(() => new RealBot({ name: 'extraBot', createBot: () => fake }), /fixed team roster/);
  await second.disconnect('test');
  assert.equal(second.ready, false);
});
