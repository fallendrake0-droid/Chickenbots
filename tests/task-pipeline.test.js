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

test('successful plans keep re-planning instead of disabling autonomous planning', () => {
  const c = clock();
  const coordinator = new TeamCoordinator({ now: c.now, autoPlan: true });
  const created = [];
  for (let i = 0; i < 5; i++) {
    let plan = coordinator.ensureObjectives();
    if (!plan || !plan.created) {
      // One tick observes the completed objective and schedules the short quiet
      // period; the next one creates the replacement plan.
      c.advance(16001);
      plan = coordinator.ensureObjectives();
    }
    if (plan && plan.created) {
      created.push(plan.objective.id);
      coordinator.board.getObjective(plan.objective.id).status = 'COMPLETED';
      c.advance(16000);
    }
  }
  assert.equal(created.length, 5, 'planner must keep producing objectives after completed ones');
  assert.equal(coordinator.getState().team.planning.stopped, false);
  assert.equal(coordinator.getState().team.planning.failures, 0);
});

test('an operator command is recorded on the task that it created', async () => {
  const { createCommandHandler } = require('../src/commands');
  const board = new TaskBoard({ now: () => 1000 });
  const handler = createCommandHandler({ taskBoard: board, bots: new Map(), config });
  const entry = await handler.execute('task add RETURN_HOME "return to base"', { source: 'dashboard', operator: 'test-operator' });
  assert.equal(entry.ok, true, JSON.stringify(entry));
  const task = board.listTasks()[0];
  assert.equal(task.sourceCommand, 'task add RETURN_HOME "return to base"');
  assert.equal(task.createdBy, 'test-operator');
  assert.equal(board.listTasks({ limit: 10 })[0].lastUpdateAt, 1000);
});

test('the queue command reports the real join queue and rejects unknown bots', async () => {
  const { createCommandHandler } = require('../src/commands');
  const bots = new Map(BOT_NAMES.map((name) => [name, { name, ready: true }]));
  const runtime = {
    joinCooldownUntil: 0,
    throttleStrikes: 0,
    nextJoinAt: 0,
    state: () => ({ joinQueue: { waiting: ['________'] }, bots: [] }),
    reconnectBot: async (name) => ({ ok: true, bot: { name } })
  };
  const handler = createCommandHandler({ taskBoard: new TaskBoard(), bots, runtime });
  const status = await handler.execute('queue status', { source: 'dashboard', operator: 'test' });
  assert.equal(status.ok, true);
  assert.deepEqual(status.result.joinQueue.waiting, ['________']);
  const bad = await handler.execute('queue retry nobody', { source: 'dashboard', operator: 'test' });
  assert.equal(bad.ok, false);
  assert.match(bad.result.error, /unknown bot|requires a bot name/);
  const retried = await handler.execute('queue retry all', { source: 'dashboard', operator: 'test' });
  assert.equal(retried.ok, true);
  assert.equal(retried.result.results.length, BOT_NAMES.length);
});

test('surface work relocates an underground bot instead of leaving it stalled', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '10101000', world, position: { x: 10, y: 40, z: 10 }, inventory: {} });
  const board = new TaskBoard({ now: () => 1000 });
  const actions = new BotActions({ bot, taskBoard: board, home: { x: 0, y: 65, z: 0 } });
  const task = board.addTask({ type: 'CHOP_WOOD', units: { target: 64 } }).task;
  const result = await actions.performTask(task, {});
  assert.equal(result.verified, false);
  assert.equal(result.relocated, true, JSON.stringify(result));
  assert.equal(bot.position.y, 65);
});

test('an ore search that keeps finding nothing moves to a fresh site, then gives up', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '01010100', world, position: { x: 1, y: 65, z: -1 }, inventory: {} });
  const board = new TaskBoard({ now: () => 1000 });
  const actions = new BotActions({ bot, taskBoard: board, home: { x: 0, y: 65, z: 0 } });
  actions.mining.mineOresDeep = async () => ({ ok: false, mined: 0, skipped: 0, results: [] });
  const task = board.addTask({ type: 'MINE_ORE', units: { target: 32 } }).task;
  const first = await actions.performTask(task, {});
  assert.equal(first.relocated, true, JSON.stringify(first));
  const movedTo = { ...bot.position };
  assert.notDeepEqual(movedTo, { x: 1, y: 65, z: -1 });
  const second = await actions.performTask(task, {});
  assert.equal(second.relocated, true);
  task.relocationAttempts = 3;
  const third = await actions.performTask(task, {});
  assert.equal(third.relocated, undefined, 'the relocation budget is bounded');
});

test('a failed objective cancels its remaining work instead of leaving ACTIVE rows behind', () => {
  const board = new TaskBoard({ now: () => 1000 });
  const objective = board.createObjective({ id: 'obj-test', title: 'test' });
  const first = board.addTask({ type: 'RETURN_HOME', objectiveId: objective.id }).task;
  const second = board.addTask({ type: 'RETURN_HOME', objectiveId: objective.id }).task;
  const third = board.addTask({ type: 'RETURN_HOME', objectiveId: objective.id }).task;
  assert.equal(board.claim(second.id, '________').ok, true);
  assert.equal(board.claim(third.id, '01010100').ok, true);
  board.fail(first.id, 'unrecoverable test failure', { retry: false });
  assert.equal(board.getTask(first.id).status, 'FAILED');
  assert.equal(board.getObjective(objective.id).status, 'FAILED');
  assert.equal(board.getTask(second.id).status, 'CANCELLED');
  assert.equal(board.getTask(third.id).status, 'CANCELLED');
  assert.equal(board.getTask(third.id).claimedBy, null);
});

test('a bed task verifies existing beds instead of demanding five new ones every plan', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '10101000', world, inventory: { white_bed: 8 }, position: { x: 4, y: 64, z: 4 } });
  const actions = new BotActions({ bot, taskBoard: new TaskBoard({ now: () => 1000 }), home: { x: 4, y: 64, z: 4 } });
  const first = await actions.sleep.ensureBed({ placeNew: true });
  const second = await actions.sleep.ensureBed({ placeNew: true });
  assert.ok(first.ok && second.ok);
  const before = bot.countItem('white_bed');
  const task = { type: 'PLACE_BED', params: { count: 2 }, units: { target: 2 } };
  const result = await actions.performTask(task, {});
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.quantity, 2);
  assert.equal(bot.countItem('white_bed'), before, 'reusing real beds must not consume inventory');
});

test('ore progress only counts the requested ore, not any ore that happens to be mined', async () => {
  const { MiningController } = require('../src/actions/mining');
  const world = new MockWorld();
  let target = null;
  for (let x = -60; x <= 60 && !target; x += 2) {
    for (let z = -60; z <= 60 && !target; z += 2) {
      for (let y = -20; y < 60; y += 2) {
        if (world.blockNameAt(x, y, z) === 'iron_ore') { target = { x, y, z }; break; }
      }
    }
  }
  assert.ok(target, 'mock world must contain iron ore');
  const bot = new MockBot({ name: '10101000', world, position: target, inventory: { diamond_pickaxe: 1 } });
  const mining = new MiningController({ bot });
  const found = mining.findOres({ radius: 16, limit: 10, only: 'iron_ore' });
  assert.ok(found.length > 0);
  assert.ok(found.every((ore) => ore.name === 'iron_ore' || ore.name === 'deepslate_iron_ore'));
});

test('real excavation work resets the stall timer even before the ore quota moves', async () => {
  const c = clock();
  const board = new TaskBoard({ claimTtlMs: 60000, now: c.now });
  const coordinator = new TeamCoordinator({ board, now: c.now, autoPlan: false });
  coordinator.enable();
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '11001100', world, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  coordinator.updateBot(bot.name, { connected: true, spawned: true, health: 20, food: 20, position: bot.position, inventory: {} });
  const actions = new BotActions({ bot, taskBoard: board, team: coordinator });
  actions.performTask = async () => ({ ok: true, pending: true, verified: false, quantity: 0, worked: true });
  const task = board.addTask({ type: 'MINE_ORE', units: { target: 32 } }).task;
  assert.equal(coordinator.assignTask(bot.name, task.id).ok, true);
  task.noProgressSince = c.now() - 100000;
  task.stallCycles = 5;
  const result = await actions.step({ coordinator });
  assert.notEqual(result.stalled, true, JSON.stringify(result));
  assert.equal(task.stallCycles, 0);
  assert.ok(task.noProgressSince > c.now(), 'the no-progress window restarts from real time');
});

test('woodcutting searches a fresh forest patch when the base is stripped', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '10101000', world, position: { x: 0, y: 65, z: 0 }, inventory: {} });
  const board = new TaskBoard({ now: () => 1000 });
  const actions = new BotActions({ bot, taskBoard: board, home: { x: 0, y: 65, z: 0 } });
  const task = board.addTask({ type: 'CHOP_WOOD', units: { target: 64 } }).task;
  const result = await actions.performTask(task, {});
  assert.equal(result.relocated, true, JSON.stringify(result));
  assert.ok(Math.hypot(bot.position.x, bot.position.z) >= 32, 'the bot must leave the stripped radius');
  assert.equal(task.relocationAttempts, 1);
});
