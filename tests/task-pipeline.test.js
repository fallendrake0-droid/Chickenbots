'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BOT_NAMES, config } = require('../src/config');
const { TaskBoard } = require('../src/team/taskBoard');
const { TeamCoordinator } = require('../src/team/teamCoordinator');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { BotActions } = require('../src/actions');

function clock(start = 1000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('heartbeat keeps a long task claim alive past the TTL', () => {
  const c = clock();
  const board = new TaskBoard({ claimTtlMs: 1000, now: c.now });
  const task = board.addTask({ type: 'MINE_ORE', label: 'iron' }).task;
  assert.equal(board.claim(task.id, '10101000').ok, true);
  c.advance(800);
  assert.equal(board.heartbeat(task.id, '10101000'), true);
  c.advance(800);
  assert.equal(board.expire().length, 0, 'a heartbeated claim must not expire');
  assert.equal(board.getTask(task.id).claimedBy, '10101000');
  c.advance(1200);
  assert.equal(board.expire().length, 1, 'an abandoned claim still expires');
  assert.equal(board.getTask(task.id).claimedBy, null);
});

test('coordinator clears assignments for cancelled, failed and expired work', () => {
  const c = clock();
  const board = new TaskBoard({ claimTtlMs: 1000, now: c.now });
  const coordinator = new TeamCoordinator({ board, now: c.now, autoPlan: false });
  coordinator.enable();
  for (const name of BOT_NAMES) {
    coordinator.updateBot(name, { connected: true, spawned: true, health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  }
  const a = board.addTask({ type: 'RETURN_HOME', label: 'back', priority: 1 }).task;
  assert.equal(coordinator.assignTask('________', a.id).ok, true);
  assert.equal(coordinator.getAssignment('________').taskId, a.id);
  board.cancel(a.id, 'operator cancel');
  coordinator.tick();
  assert.equal(coordinator.getAssignment('________'), null, 'cancel must clear the assignment');

  const b = board.addTask({ type: 'RETURN_HOME', label: 'again', priority: 1 }).task;
  assert.equal(coordinator.assignTask('________', b.id).ok, true);
  c.advance(1100);
  coordinator.tick(); // expire -> release -> reconciliation -> reallocate
  const reassigned = coordinator.getAssignment('________');
  assert.ok(!reassigned || reassigned.taskId === b.id, 'expired work must be reallocated, not left stale');
  assert.ok(!reassigned || board.getTask(reassigned.taskId).claimExpiresAt > c.now(), 'reallocated claim must have a fresh TTL');
});

test('reassigning a bot releases its previous task instead of orphaning it', () => {
  const c = clock();
  const board = new TaskBoard({ now: c.now });
  const coordinator = new TeamCoordinator({ board, now: c.now, autoPlan: false });
  coordinator.enable();
  const first = board.addTask({ type: 'RETURN_HOME', label: 'first' }).task;
  const second = board.addTask({ type: 'RETURN_HOME', label: 'second' }).task;
  assert.equal(coordinator.assignTask('01010100', first.id).ok, true);
  assert.equal(coordinator.assignTask('01010100', second.id).ok, true);
  assert.equal(board.getTask(first.id).status, 'PENDING');
  assert.equal(board.getTask(first.id).claimedBy, null);
  assert.equal(board.getTask(second.id).claimedBy, '01010100');
});

test('a task with no verified progress is handed back instead of pinning a bot', async () => {
  const c = clock();
  const board = new TaskBoard({ claimTtlMs: 60000, now: c.now });
  const coordinator = new TeamCoordinator({ board, now: c.now, autoPlan: false });
  coordinator.enable();
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '11001100', world, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  coordinator.updateBot(bot.name, { connected: true, spawned: true, health: 20, food: 20, position: bot.position, inventory: {} });
  const actions = new BotActions({ bot, taskBoard: board, team: coordinator });
  actions.performTask = async () => ({ ok: true, pending: true, verified: false, quantity: 0 });
  const task = board.addTask({ type: 'MINE_ORE', label: 'iron', priority: 1 }).task;
  assert.equal(coordinator.assignTask(bot.name, task.id).ok, true);
  task.noProgressSince = c.now() - 100000;
  task.stallCycles = 3;
  const result = await actions.step({ coordinator });
  assert.equal(result.stalled, true);
  assert.ok(String(result.error).includes('no verified progress'));
  assert.equal(board.getTask(task.id).status, 'PENDING');
  assert.equal(coordinator.getAssignment(bot.name), null);
  task.stallCycles = 0;
  task.noProgressSince = null;
});

test('task parameters are parsed and validated from the shared registry', async () => {
  const { createRuntime } = require('../src/runtime');
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  await runtime.start();
  try {
    const added = await runtime.executeCommand('task add MINE_BLOCK stone --params {"block":"iron_ore","limit":8}', { source: 'dashboard' });
    assert.equal(added.result.ok, true);
    assert.equal(added.result.task.params.block, 'iron_ore');
    assert.equal(added.result.task.params.limit, 8);
    assert.ok(/task-/.test(added.result.task.id));

    const keyValue = await runtime.executeCommand('task add STORE_ITEMS deposit item=bread count=8', { source: 'dashboard' });
    assert.equal(keyValue.result.ok, true);
    assert.equal(keyValue.result.task.params.item, 'bread');
    assert.equal(keyValue.result.task.params.count, 8);

    const missing = await runtime.executeCommand('task add TRANSFER_ITEMS send', { source: 'dashboard' });
    assert.equal(missing.result.ok, false);
    assert.ok(/requires item/.test(missing.result.error));

    const badJson = await runtime.executeCommand('task add MINE_BLOCK stone --params {oops}', { source: 'dashboard' });
    assert.equal(badJson.result.ok, false);
    assert.ok(/valid JSON/.test(badJson.result.error));

    const task = added.result.task;
    runtime.board.getTask(task.id).attempts = 3;
    const retried = await runtime.executeCommand(`task retry ${task.id}`, { source: 'dashboard' });
    assert.equal(retried.result.ok, true);
    const after = runtime.board.getTask(task.id);
    assert.equal(after.status, 'PENDING');
    assert.equal(after.attempts, 0);
  } finally {
    await runtime.shutdown('test');
  }
});

test('dashboard-created tasks execute through coordinator -> action step', async () => {
  const { createRuntime } = require('../src/runtime');
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  await runtime.start();
  try {
    // Use a deterministic task that does not depend on world generation.
    const added = await runtime.executeCommand('task add RETURN_HOME go home', { source: 'dashboard' });
    const task = added.result.task;
    const assigned = await runtime.executeCommand(`task assign ${task.id} 00110000`, { source: 'dashboard' });
    assert.equal(assigned.result.ok, true);
    const actions = runtime.actions.get('00110000');
    const result = await actions.step({ coordinator: runtime.coordinator, bots: runtime.bots });
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal(runtime.board.getTask(task.id).status, 'COMPLETED');
    assert.equal(runtime.coordinator.getAssignment('00110000'), null);
  } finally {
    await runtime.shutdown('test');
  }
});

test('a task that exhausted its retry budget is closed instead of staying PENDING forever', () => {
  const c = clock();
  const board = new TaskBoard({ now: c.now });
  const coordinator = new TeamCoordinator({ board, now: c.now, autoPlan: false });
  coordinator.enable();
  for (const name of BOT_NAMES) {
    coordinator.updateBot(name, { connected: true, spawned: true, health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  }
  const task = board.addTask({ type: 'MINE_ORE', label: 'exhausted', maxAttempts: 2 }).task;
  task.attempts = 2;
  coordinator.tick();
  assert.equal(board.getTask(task.id).status, 'FAILED');
  assert.ok((coordinator.tick().failed || []).length === 0, 'a closed task is not reported twice');
});
