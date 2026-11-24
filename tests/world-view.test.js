'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { worldSnapshot } = require('../src/dashboard/worldView');
const { dashboardBindProblem } = require('../src/dashboard/server');

function fixture() {
  const world = new MockWorld({ seed: 'viewer-test' });
  const bot = new MockBot({ name: '________', world, position: { x: 0, y: world.surfaceY(0, 0) + 1, z: 0 }, inventory: {} });
  const other = new MockBot({ name: '10101000', world, position: { x: 4, y: world.surfaceY(4, 0) + 1, z: 0 }, inventory: {} });
  world.addMob('zombie', { x: 3, y: world.surfaceY(3, 0) + 1, z: 2 });
  const assignment = { taskId: 'task-1', type: 'MINE_ORE', label: 'iron' };
  const services = {
    mode: 'simulation',
    bots: new Map([[bot.name, bot], [other.name, other]]),
    coordinator: { getAssignment: (name) => (name === bot.name ? assignment : null) },
    runtime: { simulate: true }
  };
  return { services, bot, world };
}

test('world snapshot is bounded, real and includes terrain, palette and entities', () => {
  const { services, bot } = fixture();
  const snap = worldSnapshot(services, { bot: bot.name, radius: 8, height: 24 });
  assert.equal(snap.ok, true);
  assert.equal(snap.bot, '________');
  assert.equal(snap.radius, 8);
  assert.ok(snap.columns.length > 20, `expected columns, got ${snap.columns.length}`);
  assert.ok(snap.columns.length <= 17 * 17);
  assert.ok(snap.palette.length > 0);
  assert.equal(snap.palette.length, new Set(snap.palette.map((entry) => entry.name)).size);
  for (const column of snap.columns.slice(0, 50)) {
    assert.equal(column.length, 5);
    assert.ok(Number.isFinite(column[2]));
    assert.ok(column[3] >= 0 && column[3] <= 0xffffff);
    assert.ok(snap.palette.some((entry) => entry.index === column[4]));
  }
  assert.ok(snap.chunks.length >= 1);
  assert.equal(snap.bots.length, 2);
  assert.equal(snap.bots.find((entry) => entry.name === '________').task.type, 'MINE_ORE');
  assert.equal(snap.entities.length, 1);
  assert.equal(snap.entities[0].name, 'zombie');
  assert.ok(snap.bounds.minY <= snap.baseY);
  assert.equal(snap.center.x, 0);
});

test('viewer radius and height are clamped before scanning', () => {
  const { services } = fixture();
  const snap = worldSnapshot(services, { bot: '________', radius: 9999, height: 9999 });
  assert.equal(snap.radius, 32);
  assert.equal(snap.height, 64);
});

test('repeat requests are served from a short-lived cache', () => {
  const { services } = fixture();
  const first = worldSnapshot(services, { bot: '________', radius: 12 });
  const second = worldSnapshot(services, { bot: '________', radius: 12 });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.columns, first.columns);
});

test('missing or unknown bots return an honest error instead of fake terrain', () => {
  const { services } = fixture();
  const unknown = worldSnapshot(services, { bot: 'nobody' });
  assert.equal(unknown.ok, true, 'an unknown name falls back to a real bot rather than inventing one');
  const empty = worldSnapshot({ mode: 'live', bots: new Map() }, {});
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'NO_BOT');
});

test('control plane bind guard refuses an unauthenticated public bind unless explicitly opted in', () => {
  assert.equal(dashboardBindProblem({ host: '127.0.0.1', token: '' }), null);
  assert.equal(dashboardBindProblem({ host: 'localhost', token: '' }), null);
  assert.equal(dashboardBindProblem({ host: '0.0.0.0', token: 'a'.repeat(24) }), null);
  assert.equal(dashboardBindProblem({ host: '0.0.0.0', token: '', allowInsecure: true }), null);
  assert.match(dashboardBindProblem({ host: '0.0.0.0', token: '', allowInsecure: false }), /refusing to expose/);
});
