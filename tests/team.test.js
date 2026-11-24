'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BOT_NAMES } = require('../src/config');
const { TeamMemory } = require('../src/team/teamMemory');
const { TaskBoard } = require('../src/team/taskBoard');
const { scoreTaskForBot, assignBotsToTasks } = require('../src/team/allocation');
const { ResourceLedger } = require('../src/team/resourceLedger');
const { Leadership } = require('../src/team/leadership');
const { computeSlots, separation, slotOffsets } = require('../src/team/formations');
const { EmergencyManager, classifyEmergency } = require('../src/team/emergencies');
const { TeamCoordinator } = require('../src/team/teamCoordinator');
const { createSurvivalBasePlan, createCollectPlan, splitQuota } = require('../src/team/plans');

function clock(start = 1000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('bot identities are exact and frozen', () => {
  assert.deepEqual([...BOT_NAMES], ['________', '10101000', '01010100', '11001100', '00110000', '11101000', '11101010', '10001000', '11001010', '11101001']);
  assert.throws(() => BOT_NAMES.push('extra'));
});

test('shared memory requires attribution, position and valid type', () => {
  const c = clock();
  const mem = new TeamMemory({ now: c.now, defaultTtlMs: 1000 });
  assert.equal(mem.observe({ type: 'ORE_DEPOSIT', position: { x: 1, y: 2, z: 3 } }).ok, false);
  assert.equal(mem.observe({ type: 'ORE_DEPOSIT', reportedBy: '10101000' }).ok, false);
  assert.equal(mem.observe({ type: 'NOT_A_TYPE', reportedBy: '10101000', position: { x: 0, y: 0, z: 0 } }).ok, false);
  const res = mem.observe({ type: 'ORE_DEPOSIT', reportedBy: '10101000', position: { x: 10, y: 24, z: -8 }, resource: 'iron_ore', confidence: 0.98 });
  assert.equal(res.ok, true);
  assert.equal(res.observation.reportedBy, '10101000');
  assert.equal(res.observation.confidence, 0.98);
});

test('shared memory expires observations and merges duplicates', () => {
  const c = clock();
  const mem = new TeamMemory({ now: c.now, defaultTtlMs: 5000 });
  mem.observe({ type: 'TREE', reportedBy: '10101000', position: { x: 5, y: 64, z: 5 }, resource: 'oak_log', confidence: 0.5 });
  const dup = mem.observe({ type: 'TREE', reportedBy: '01010100', position: { x: 5, y: 64, z: 5 }, resource: 'oak_log', confidence: 0.9 });
  assert.equal(dup.updated, true);
  assert.equal(mem.query({ type: 'TREE' }).length, 1);
  assert.equal(mem.query({ type: 'TREE' })[0].reportedBy, '01010100');
  c.advance(6000);
  assert.equal(mem.query({ type: 'TREE' }).length, 0);
  assert.equal(mem.query({ type: 'TREE', includeExpired: true }).length, 1);
});

test('stale shared observations are rejected before travel', async () => {
  const mem = new TeamMemory();
  const { observation } = mem.observe({ type: 'ORE_DEPOSIT', reportedBy: '10101000', position: { x: 0, y: 12, z: 0 }, resource: 'diamond_ore' });
  const bad = await mem.verify(observation.id, () => false);
  assert.equal(bad.ok, false);
  assert.equal(mem.get(observation.id).status, 'STALE');
  const good = mem.observe({ type: 'ORE_DEPOSIT', reportedBy: '10101000', position: { x: 1, y: 12, z: 0 }, resource: 'diamond_ore' });
  assert.equal((await mem.verify(good.observation.id, () => true)).ok, true);
});

test('task claims prevent duplicate work and honour locks/regions', () => {
  const c = clock();
  const board = new TaskBoard({ now: c.now });
  const obj = board.createObjective({ title: 'Test' });
  const { task } = board.addTask({ objectiveId: obj.id, type: 'MINE_ORE', params: { ore: 'iron_ore' }, units: { target: 10 }, lockKeys: ['ore:10,20,30'] });
  assert.equal(board.claim(task.id, '10101000').ok, true);
  const second = board.claim(task.id, '01010100');
  assert.equal(second.ok, false);
  assert.equal(second.heldBy, '10101000');
  assert.equal(board.claim(task.id, '01010100', { force: true }).ok, true);
  assert.equal(board.getTask(task.id).claimedBy, '01010100');
  assert.equal(board.locksHeldBy('10101000').length, 0);
});

test('task claims expire and become claimable again', () => {
  const c = clock();
  const board = new TaskBoard({ now: c.now, claimTtlMs: 1000 });
  const obj = board.createObjective({ title: 'T' });
  const { task } = board.addTask({ objectiveId: obj.id, type: 'CHOP_WOOD' });
  board.claim(task.id, '10101000');
  c.advance(1500);
  const expired = board.expire();
  assert.equal(expired.length, 1);
  assert.equal(board.getTask(task.id).status, 'PENDING');
  assert.equal(board.claim(task.id, '01010100').ok, true);
});

test('dependencies gate task claims and objective progress follows real units', () => {
  const board = new TaskBoard();
  const obj = board.createObjective({ title: 'Base', progress: { current: 0, target: 2, unit: 'tasks' } });
  const a = board.addTask({ objectiveId: obj.id, type: 'FIND_SITE', units: { target: 1 } }).task;
  const b = board.addTask({ objectiveId: obj.id, type: 'BUILD_PHASE', dependsOn: [a.id], units: { target: 5 } }).task;
  assert.equal(board.claim(b.id, '10101000').ok, false);
  board.claim(a.id, '10101000');
  assert.equal(board.complete(a.id, { by: '10101000', verified: true }).ok, true);
  assert.equal(board.claim(b.id, '10101000').ok, true);
  board.start(b.id, '10101000');
  board.updateProgress(b.id, { current: 5 });
  assert.equal(board.getObjective(obj.id).progress.current, 6);
  assert.equal(board.complete(b.id, { by: '10101000', verified: false }).ok, false);
  assert.equal(board.complete(b.id, { by: '10101000', verified: true }).ok, true);
  assert.equal(board.getObjective(obj.id).status, 'COMPLETED');
});

test('spatial reservations stop overlapping excavation regions', () => {
  const board = new TaskBoard();
  const boxA = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 8, z: 15 } };
  const boxB = { min: { x: 8, y: 0, z: 0 }, max: { x: 24, y: 8, z: 15 } };
  assert.equal(board.reserveRegion('10101000', boxA).ok, true);
  const conflict = board.reserveRegion('01010100', boxB);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict.owner, '10101000');
  assert.equal(board.reserveRegion('01010100', { min: { x: 16, y: 0, z: 0 }, max: { x: 31, y: 8, z: 15 } }).ok, true);
});

test('dependency deadlocks are detected and broken by preemption', () => {
  const c = clock();
  const board = new TaskBoard({ now: c.now });
  const obj = board.createObjective({ title: 'cycle' });
  const t1 = board.addTask({ objectiveId: obj.id, type: 'BUILD_PHASE', priority: 10 }).task;
  const t2 = board.addTask({ objectiveId: obj.id, type: 'BUILD_PHASE', priority: 90 }).task;
  // Manually create a circular dependency (as a planner bug recovery case).
  board.claim(t1.id, '10101000');
  board.claim(t2.id, '01010100');
  t1.dependsOn = [t2.id];
  t2.dependsOn = [t1.id];
  const cycles = board.detectDeadlocks();
  assert.ok(cycles.length >= 1);
  const resolved = board.resolveDeadlocks();
  assert.ok(resolved.length >= 1);
  assert.equal(board.getTask(resolved[0].taskId).claimedBy, null);
});

test('mutual lock waits are detected as deadlocks', () => {
  const board = new TaskBoard();
  assert.equal(board.acquireLock('chest:1', '10101000').ok, true);
  assert.equal(board.acquireLock('chest:2', '01010100').ok, true);
  // A single wait is not a deadlock.
  assert.equal(board.acquireLock('chest:1', '01010100').ok, false);
  assert.equal(board.detectDeadlocks().length, 0);
  // Mutual wait is a deadlock.
  assert.equal(board.acquireLock('chest:2', '10101000').ok, false);
  const cycles = board.detectDeadlocks();
  assert.ok(cycles.length >= 1);
  board.releaseLock('chest:1', '10101000');
  board.releaseLock('chest:2', '01010100');
  assert.equal(board.acquireLock('chest:1', '01010100').ok, true);
});

test('allocation prefers equipped, healthy, close bots', () => {
  const task = { id: 't1', type: 'MINE_ORE', priority: 80, requires: { tool: 'pickaxe', tier: 3 }, params: { position: { x: 0, y: 20, z: 0 } } };
  const miner = { name: '10101000', position: { x: 4, y: 20, z: 0 }, health: 20, food: 20, equipment: { pickaxe: 4 }, inventory: {}, capabilities: ['mine'] };
  const woodcutter = { name: '01010100', position: { x: 4, y: 20, z: 0 }, health: 20, food: 20, equipment: { pickaxe: 0 }, inventory: { stone_axe: 1 }, capabilities: ['chop'] };
  const injured = { name: '11001100', position: { x: 1, y: 20, z: 0 }, health: 5, food: 20, equipment: { pickaxe: 3 }, inventory: {}, capabilities: ['mine'] };
  const a = scoreTaskForBot(task, miner);
  const b = scoreTaskForBot(task, woodcutter);
  const d = scoreTaskForBot(task, injured);
  assert.ok(a.score > b.score);
  assert.ok(a.score > d.score);
  const assigned = assignBotsToTasks([task], [woodcutter, miner, injured]);
  assert.equal(assigned[0].bot, '10101000');
});

test('allocation refuses disconnected and dying bots', () => {
  const task = { id: 't', type: 'CHOP_WOOD', priority: 50 };
  assert.equal(scoreTaskForBot(task, { name: 'x', connected: false }).score, -Infinity);
  assert.equal(scoreTaskForBot(task, { name: 'y', spawned: false }).score, -Infinity);
  assert.ok(scoreTaskForBot(task, { name: 'z', health: 2, food: 2, inventory: {} }).score < 0);
});

test('resource ledger tracks real inventories, reserves and shortages', () => {
  const ledger = new ResourceLedger({ reserves: { oak_log: 128, iron_ingot: 32, food: 64 } });
  ledger.updateBotInventory('10101000', { oak_log: 100, iron_ingot: 8, bread: 10 });
  ledger.updateBotInventory('01010100', { oak_log: 100, iron_ingot: 8, cooked_beef: 5 });
  ledger.updateStorage('home-chest', { position: { x: 0, y: 64, z: 0 }, counts: { oak_log: 112, iron_ingot: 16, bread: 20 } });
  assert.equal(ledger.total('oak_log'), 312);
  assert.equal(ledger.total('food'), 35);
  const res = ledger.reserve('oak_log', 240, { purpose: 'walls', owner: 'builder' });
  assert.equal(res.ok, true);
  assert.equal(ledger.available('oak_log'), 72);
  assert.equal(ledger.reserve('oak_log', 100).ok, false);
  const shortages = ledger.shortages();
  assert.equal(ledger.total('iron_ingot'), 32);
  assert.ok(!shortages.find((s) => s.item === 'iron_ingot')); // 32/32 is met
  ledger.setReserveTarget('iron_ingot', 64);
  assert.ok(ledger.shortages().find((s) => s.item === 'iron_ingot'));
  assert.ok(shortages.find((s) => s.item === 'food'));
  const rows = ledger.summary();
  assert.equal(rows.find((r) => r.item === 'oak_log').status, 'DEFICIT');
});

test('transfer plans move real items from donor bots only', () => {
  const ledger = new ResourceLedger({ reserves: {} });
  const donors = [
    { name: '10101000', counts: { bread: 20 }, distance: 3 },
    { name: '01010100', counts: { bread: 4 }, distance: 10 },
    { name: '00110000', counts: { bread: 0 }, distance: 1 }
  ];
  const { plan, fulfilled, remaining } = ledger.transferPlan('food', 16, donors, '11001100');
  assert.equal(fulfilled, 16);
  assert.equal(remaining, 0);
  assert.deepEqual(plan[0], { from: '10101000', to: '11001100', item: 'food', count: 16 });
});

test('protected/junk decisions never drop valuable items', () => {
  const ledger = new ResourceLedger();
  const counts = { diamond: 3, diamond_pickaxe: 1, bread: 10, dirt: 64, gravel: 64, cobblestone: 64, emerald: 2 };
  const junk = ledger.junkCandidates(counts, 3).map((j) => j.name);
  assert.ok(!junk.includes('diamond'));
  assert.ok(!junk.includes('bread'));
  assert.ok(!junk.includes('diamond_pickaxe'));
  assert.equal(junk.length, 3);
});

test('leadership keeps the preferred bot, then elects a successor', () => {
  const lead = new Leadership({ preferred: '________', order: BOT_NAMES });
  const states = BOT_NAMES.map((name) => ({ name, connected: true, spawned: true, health: 20, food: 20 }));
  assert.equal(lead.update(states).leader, '________');
  assert.equal(lead.update(states).leader, '________');
  assert.equal(lead.update(states.filter((s) => s.name !== '________')).leader, '10101000');
  assert.equal(lead.update(states.filter((s) => !['________', '10101000'].includes(s.name))).leader, '01010100');
  assert.equal(lead.update(states.map((s) => ({ ...s, connected: false }))).leader, null);
});

test('leadership never elects a dead or unspawned bot', () => {
  const lead = new Leadership({ preferred: '________', order: BOT_NAMES });
  const res = lead.update([
    { name: '________', connected: true, spawned: false, health: 20 },
    { name: '10101000', connected: true, spawned: true, health: 1 },
    { name: '01010100', connected: true, spawned: true, health: 0 }
  ]);
  assert.equal(res.leader, '10101000');
});

test('formation slots are unique and separation avoids stacking', () => {
  const positions = {};
  for (const name of BOT_NAMES) positions[name] = { x: 0, z: 0 };
  const slots = computeSlots({ leader: '________', members: BOT_NAMES, formation: 'DEFENSIVE', heading: 0, positions });
  const unique = new Set(slots.slots.map((s) => `${s.position.x},${s.position.z}`));
  assert.equal(unique.size, 10);
  assert.equal(slots.slots[0].name, '________');
  const seps = separation(positions, { minDistance: 2 });
  assert.ok(Object.values(seps).some((v) => v.x !== 0 || v.z !== 0));
  for (const formation of ['FOLLOW', 'COMPACT', 'EXPLORATION', 'MINING', 'BUILDING', 'RETREAT', 'REGROUP']) {
    const s = computeSlots({ leader: BOT_NAMES[0], members: BOT_NAMES, formation, positions });
    assert.equal(s.slots.length, 10, formation);
    assert.equal(new Set(s.slots.map((x) => `${x.position.x},${x.position.z}`)).size, 10, formation);
  }
});

test('emergency classification covers lava, falls, starvation and swarms', () => {
  const base = { name: '10101000', connected: true, spawned: true, health: 20, food: 20 };
  assert.equal(classifyEmergency({ ...base, inLava: true })[0].severity, 'CRITICAL');
  assert.equal(classifyEmergency({ ...base, fallDistance: 20, velocity: { y: -1.2 } })[0].action, 'CLUTCH');
  assert.equal(classifyEmergency({ ...base, food: 0 })[0].kind, 'STARVATION');
  assert.equal(classifyEmergency({ ...base, threats: 4, nearestThreatDistance: 6 })[0].kind, 'SWARM');
  assert.equal(classifyEmergency({ ...base, health: 3 })[0].kind, 'LOW_HEALTH');
  assert.deepEqual(classifyEmergency({ ...base }), []);
});

test('rescue plans do not send the whole team into danger', () => {
  const em = new EmergencyManager();
  const victim = { name: '10101000', health: 4, food: 10, position: { x: 0, y: 20, z: 0 } };
  em.report(victim);
  const active = em.active();
  assert.equal(active.length, 1);
  const states = [victim, ...BOT_NAMES.slice(1).map((name, i) => ({
    name, connected: true, spawned: true, health: 18, food: 18, position: { x: i + 1, y: 20, z: 0 }, equipment: { sword: 2 }, armor: 4, inventory: { bread: 10 }
  }))];
  const plan = em.planRescue(active[0], states, { teamSize: 5 });
  assert.ok(plan.responders.length <= 2);
  assert.ok(!plan.responders.some((r) => r.name === victim.name));
  const swarm = { name: '01010100', health: 12, food: 15, threats: 6, nearestThreatDistance: 5, position: { x: 0, y: 20, z: 0 } };
  em.report(swarm);
  const swarmEm = em.byBot('01010100').find((e) => e.kind === 'SWARM');
  const weak = states.map((s) => ({ ...s, health: 15, armor: 0 }));
  const weakPlan = em.planRescue(swarmEm, weak, { teamSize: 5 });
  assert.equal(weakPlan.strategy, 'REGROUP_AND_RETREAT');
  assert.equal(weakPlan.responders.length, 0);
  assert.ok(weakPlan.withholdReason);
});

test('survival base plan has real dependencies and quotas', () => {
  const board = new TaskBoard();
  const plan = createSurvivalBasePlan(board, { botNames: BOT_NAMES });
  assert.equal(plan.created, true);
  const tasks = board.listTasks({ objectiveId: plan.objective.id });
  assert.ok(tasks.length >= 10);
  const woodTasks = tasks.filter((t) => t.type === 'CHOP_WOOD');
  assert.equal(woodTasks.reduce((s, t) => s + t.units.target, 0), 256);
  const foundation = tasks.find((t) => t.params.phase === 'FOUNDATION');
  assert.ok(foundation.dependsOn.length >= 2);
  const again = createSurvivalBasePlan(board, { botNames: BOT_NAMES });
  assert.equal(again.created, false);
  assert.deepEqual(splitQuota(256, 4), [64, 64, 64, 64]);
  assert.deepEqual(splitQuota(10, 4), [3, 3, 2, 2]);
});

test('collect plan splits work between four bots', () => {
  const board = new TaskBoard();
  const plan = createCollectPlan(board, { resource: 'iron_ore', count: 128, method: 'mine', parts: 4 });
  assert.equal(plan.ok, true);
  assert.equal(plan.tasks.length, 4);
  assert.equal(plan.tasks.reduce((s, t) => s + t.units.target, 0), 128);
});

test('coordinator assigns, reassigns after disconnect, and preserves objectives', () => {
  const c = clock();
  const coordinator = new TeamCoordinator({ now: c.now, autoPlan: true });
  coordinator.enable();
  for (const name of BOT_NAMES) {
    coordinator.updateBot(name, {
      connected: true, spawned: true, health: 20, food: 20,
      position: { x: 0, y: 64, z: 0 }, inventory: { wooden_axe: 1, wooden_pickaxe: 1, bread: 10 },
      equipment: { axe: 1, pickaxe: 1, sword: 1, armor: 0 }, capabilities: ['chop', 'mine']
    });
  }
  const summary = coordinator.tick();
  assert.equal(coordinator.leader, '________');
  assert.ok(summary.assignments.length >= 1);
  const assignedBot = summary.assignments[0].bot;
  const assignment = coordinator.getAssignment(assignedBot);
  assert.ok(assignment.taskId);
  assert.equal(coordinator.board.getTask(assignment.taskId).claimedBy, assignedBot);
  coordinator.setDisconnected(assignedBot, 'socket reset');
  assert.equal(coordinator.getAssignment(assignedBot), null);
  const state = coordinator.getState();
  assert.equal(state.team.online, 9);
  assert.ok(state.team.objectives.length >= 1);
  // The remaining bots still work: nobody is blocked by the loss.
  coordinator.tick();
  const claimed = coordinator.board.listTasks().filter((t) => t.claimedBy);
  assert.ok(claimed.length >= 1);
});

test('coordinator detects a bot in danger and dispatches one rescuer', () => {
  const coordinator = new TeamCoordinator({ autoPlan: false });
  coordinator.enable();
  const names = BOT_NAMES;
  names.forEach((name, i) => coordinator.updateBot(name, {
    connected: true, spawned: true, health: name === '10101000' ? 4 : 20, food: 20,
    position: { x: i * 3, y: 64, z: 0 }, inventory: { bread: 5, iron_sword: 1 },
    equipment: { sword: 3, armor: 4 }, threats: 0, capabilities: ['mine']
  }));
  const summary = coordinator.tick();
  assert.ok(summary.emergencies.length >= 1);
  assert.ok(summary.rescues.length >= 1);
  assert.ok(summary.rescues.length <= 2);
  assert.ok(summary.rescues.every((r) => r.victim === '10101000'));
});
