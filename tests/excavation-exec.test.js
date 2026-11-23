'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { TeamCoordinator } = require('../src/team/teamCoordinator');
const { ExcavationManager } = require('../src/excavate/manager');
const { BOT_NAMES } = require('../src/config');

function setup({ flat = true } = {}) {
  const world = new MockWorld({ flat, guaranteedOres: false });
  const bots = new Map();
  for (const name of BOT_NAMES) {
    const bot = new MockBot({
      name,
      world,
      inventory: { iron_pickaxe: 1, stone_shovel: 1, torch: 32, bread: 8, iron_sword: 1 },
      position: { x: 0, y: 65, z: 0 }
    });
    bots.set(name, bot);
  }
  const coordinator = new TeamCoordinator({ autoPlan: false });
  coordinator.enable();
  for (const [name, bot] of bots) coordinator.updateBot(name, bot.summary());
  coordinator.tick();
  const manager = new ExcavationManager({ coordinator });
  for (const [name, bot] of bots) manager.attachBot(name, bot);
  return { world, bots, coordinator, manager };
}

test('excavation requires preview + explicit confirmation', () => {
  const { world, manager } = setup();
  const preview = manager.preview({
    mode: 'AT', origin: { x: 0, y: 58, z: 0 }, width: 6, length: 6, depth: 3,
    blockAt: (p) => world.getBlock(p)
  });
  assert.equal(preview.ok, true);
  assert.match(preview.text, /EXCAVATION PLAN/);
  const refused = manager.start({ previewId: preview.previewId });
  assert.equal(refused.ok, false);
  assert.equal(refused.requiresConfirmation, true);
  const started = manager.start({ previewId: preview.previewId, confirm: true });
  assert.equal(started.ok, true);
  assert.equal(started.excavation.status, 'ACTIVE');
  assert.equal(started.excavation.tasks.length, started.plan.regions.length);
  assert.ok(started.excavation.objectiveId);
  // Assignments never overlap and supervisor is not digging by default.
  const regions = started.excavation.tasks.map((t) => t.region);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]; const b = regions[j];
      const overlap = a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.z <= b.max.z && a.max.z >= b.min.z && a.min.y <= b.max.y && a.max.y >= b.min.y;
      assert.equal(overlap, false);
    }
  }
  assert.equal(started.excavation.supervisor, '________');
  assert.ok(!started.excavation.assignments.some((a) => a.bot === '________'));
});

test('protected blocks block a start until authorised', () => {
  const { world, manager } = setup();
  world.setBlock({ x: 2, y: 60, z: 2 }, 'chest');
  const preview = manager.preview({
    mode: 'AT', origin: { x: 0, y: 58, z: 0 }, width: 6, length: 6, depth: 4,
    blockAt: (p) => world.getBlock(p)
  });
  assert.equal(preview.plan.authorizationRequired, true);
  const noAuth = manager.start({ previewId: preview.previewId, confirm: true });
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.requiresAuthorization, true);
  const okay = manager.start({ previewId: preview.previewId, confirm: true, authorized: true });
  assert.equal(okay.ok, true);
  assert.equal(okay.excavation.confirmations.authorized, true);
});

test('five bots cooperatively excavate a planned volume and verification passes on real blocks', async () => {
  const { world, bots, coordinator, manager } = setup();
  const res = manager.start({
    mode: 'AT', origin: { x: 0, y: 58, z: 0 }, width: 8, length: 8, depth: 4,
    blockAt: (p) => world.getBlock(p), confirm: true, createdBy: 'test'
  });
  assert.equal(res.ok, true);
  const exc = res.excavation;
  assert.equal(exc.tasks.length, 4);
  for (const entry of exc.tasks) {
    const botName = entry.assignedTo;
    assert.ok(botName, 'region must be assigned');
    const task = coordinator.board.getTask(entry.taskId);
    assert.ok(task);
    const result = await manager.executeTask(botName, task);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.verification.complete, true, `region ${entry.regionId}`);
  }
  const active = manager.get(res.excavation.id);
  assert.equal(active.status, 'COMPLETED');
  assert.ok(active.verification.complete);
  assert.equal(active.verification.forbiddenRemoved.length, 0);
  assert.equal(active.report.complete, true);
  assert.match(active.report.dimensions, /8 x 4 x 8/);
  const objective = coordinator.board.getObjective(exc.objectiveId);
  assert.equal(objective.status, 'COMPLETED');
  // Every region task is verified complete on the board.
  for (const entry of exc.tasks) assert.equal(coordinator.board.getTask(entry.taskId).status, 'COMPLETED');
  // Blocks are really gone.
  assert.equal(world.getBlock({ x: 3, y: 58, z: 3 }).name, 'air');
});

test('excavation pause, resume, status and stop control real executors', async () => {
  const { world, manager } = setup();
  const res = manager.start({
    mode: 'AT', origin: { x: 20, y: 58, z: 20 }, width: 6, length: 6, depth: 3,
    blockAt: (p) => world.getBlock(p), confirm: true
  });
  assert.equal(res.ok, true);
  const paused = manager.pause();
  assert.equal(paused.ok, true);
  assert.equal(paused.excavation.paused, true);
  const resumed = manager.resume();
  assert.equal(resumed.excavation.paused, false);
  const status = manager.status();
  assert.equal(status.ok, true);
  assert.ok(status.excavation.tasks.length >= 1);
  const stopped = manager.stop();
  assert.equal(stopped.ok, true);
  assert.equal(manager.get(res.excavation.id).status, 'STOPPED');
});

test('disconnected excavator regions are reassigned to healthy teammates', () => {
  const { coordinator, manager } = setup();
  const res = manager.start({
    mode: 'AT', origin: { x: -20, y: 58, z: -20 }, width: 8, length: 8, depth: 2,
    blockAt: (p) => coordinator && manager && p ? manager.adapters.get('________').getBlock(p) : null,
    confirm: true
  });
  assert.equal(res.ok, true);
  const victim = res.excavation.assignments[0].bot;
  const before = res.excavation.assignments.map((a) => a.bot);
  const updates = manager.handleBotDisconnected(victim);
  assert.ok(updates.length >= 1);
  const after = manager.get().assignments.map((a) => a.bot);
  assert.ok(!after.includes(victim));
  assert.notDeepEqual(before, after);
});

test('foundation excavation derives its footprint from a schematic', async () => {
  const { bots, coordinator, manager } = setup();
  const schematic = {
    id: 'test_keep', name: 'Test Keep',
    dimensions: { width: 10, height: 16, length: 12 },
    foundation: { depth: 2 }
  };
  const preview = manager.preview({
    mode: 'FOUNDATION', schematic, origin: { x: 0, y: 63, z: 0 },
    blockAt: (p) => bots.get('________').getBlock(p),
    surfaceAt: (x, z) => bots.get('________').surfaceAt(x, z)
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.plan.schematicId, 'test_keep');
  const started = manager.start({ previewId: preview.previewId, confirm: true, authorized: true });
  assert.equal(started.ok, true);
  assert.match(started.plan.description.dimensions, /10 x 2 x 12/);
  const entry = started.excavation.tasks[0];
  const task = coordinator.board.getTask(entry.taskId);
  const result = await manager.executeTask(entry.assignedTo, task);
  assert.equal(result.ok, true);
  assert.equal(result.verification.complete, true);
});

test('quarry excavation verifies terraces rather than demanding the full bounding box', async () => {
  const { world, coordinator, manager } = setup();
  const res = manager.start({
    mode: 'QUARRY', origin: { x: 0, y: 58, z: 0 }, width: 10, length: 10, depth: 6,
    blockAt: (p) => world.getBlock(p), confirm: true
  });
  assert.equal(res.ok, true);
  assert.ok(res.plan.volume < 10 * 10 * 6);
  for (const entry of res.excavation.tasks) {
    const task = coordinator.board.getTask(entry.taskId);
    const r = await manager.executeTask(entry.assignedTo, task);
    assert.equal(r.ok, true);
  }
  const active = manager.get(res.excavation.id);
  assert.equal(active.status, 'COMPLETED');
  // Preserved terrace walls remain outside the tier footprints (the access
  // corridor at z=0 is carved, so check a neighbouring preserved column).
  assert.notEqual(world.getBlock({ x: 0, y: 58, z: 1 }).name, 'air');
  assert.equal(world.getBlock({ x: 5, y: 58, z: 5 }).name, 'air');
});
