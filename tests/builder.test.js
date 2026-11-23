'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { TaskBoard } = require('../src/team/taskBoard');
const { ResourceLedger } = require('../src/team/resourceLedger');
const { SchematicLibrary } = require('../src/schematics/library');
const { SchematicBuilder } = require('../src/builder/builder');
const { generateSchematic, createSpec } = require('../src/schematics/generator');

function smallSchematic() {
  const library = new SchematicLibrary();
  let best = null;
  let bestCount = Infinity;
  for (const design of library.manifest.designs.filter((d) => d.tier === 'Beginner').slice(0, 40)) {
    const count = Object.values(design.materials).reduce((s, n) => s + n, 0);
    if (count < bestCount) { bestCount = count; best = design; }
  }
  return library.build(best.id);
}

function materialCounts(schematic) {
  return Object.values(schematic.materials).reduce((s, n) => s + n, 0);
}

function makeBots(world, schematic, count = 5, { giveAll = true } = {}) {
  const inventory = giveAll ? { ...schematic.materials } : {};
  const bots = [];
  for (let i = 0; i < count; i++) {
    const bot = new MockBot({ name: ['________', '10101000', '01010100', '11001100', '00110000'][i], world, inventory: { ...inventory } });
    bot.position = { x: 4, y: 70, z: 4 };
    bots.push(bot);
  }
  return bots;
}

test('analysis measures the footprint, materials and protected conflicts', () => {
  const schematic = smallSchematic();
  const world = new MockWorld({ flat: true });
  const origin = { x: 20, y: 70, z: 20 };
  const bots = makeBots(world, schematic);
  const builder = new SchematicBuilder({ schematic, origin, world, bots, taskBoard: new TaskBoard() });
  const analysis = builder.analyze();
  assert.equal(analysis.totalBlocks, schematic.blocks.length);
  assert.equal(analysis.toPlace, schematic.blocks.length);
  assert.equal(analysis.conflicts.length, 0);
  assert.equal(analysis.blocked.length, 0);
  assert.deepEqual(analysis.requiredMaterials, schematic.materials);
  assert.deepEqual(analysis.missingMaterials, {});
  assert.equal(analysis.feasible, true);
  assert.equal(analysis.undergroundBlocks, 0);

  // A player chest inside the footprint must stop the build until authorised.
  const firstBlock = schematic.blocks[0];
  const chest = { x: origin.x + firstBlock[0], y: origin.y + firstBlock[1], z: origin.z + firstBlock[2] };
  world.setBlock(chest, 'chest');
  const guarded = new SchematicBuilder({ schematic, origin, world, bots, taskBoard: new TaskBoard() });
  const blocked = guarded.analyze();
  assert.ok(blocked.conflicts.length >= 1);
  assert.equal(blocked.feasible, false);
  const start = guarded.start();
  assert.equal(start.ok, false);
  assert.ok(start.needsConfirmation);
  // Authorisation cannot destroy containers.
  const authorised = new SchematicBuilder({ schematic, origin, world, bots, taskBoard: new TaskBoard(), authorized: true });
  const attempt = authorised.start({ confirm: true });
  assert.equal(attempt.ok, false);
  assert.ok(attempt.error.includes('protected'));
});

test('start refuses to build without materials instead of faking success', () => {
  const schematic = smallSchematic();
  const world = new MockWorld({ flat: true });
  const bots = makeBots(world, schematic, 5, { giveAll: false });
  const builder = new SchematicBuilder({ schematic, origin: { x: 10, y: 70, z: 10 }, world, bots, taskBoard: new TaskBoard() });
  const start = builder.start();
  assert.equal(start.ok, false);
  assert.equal(start.error, 'materials missing');
  assert.ok(Object.keys(start.missing).length > 0);
});

test('five bots cooperatively build a real schematic and verification passes', async () => {
  const schematic = smallSchematic();
  const world = new MockWorld({ flat: true });
  const bots = makeBots(world, schematic);
  const taskBoard = new TaskBoard();
  const ledger = new ResourceLedger();
  for (const bot of bots) ledger.updateBotInventory(bot.name, bot.inventory);
  const origin = { x: 30, y: 72, z: 30 };
  const builder = new SchematicBuilder({ schematic, origin, world, bots, taskBoard, ledger });
  const start = builder.start();
  assert.equal(start.ok, true, start.error);
  assert.ok(start.tasks >= 2);
  const run = await builder.run({ maxIterations: 400 });
  assert.equal(run.status.state, 'COMPLETE', `state ${run.status.state}: ${JSON.stringify(run.results.filter((r) => !r.ok).slice(0, 2))}`);
  assert.equal(run.status.percentComplete, 100);
  assert.equal(run.status.tasks.COMPLETED, run.status.tasks.total);
  const verification = builder.verify();
  assert.equal(verification.complete, true);
  assert.equal(verification.placed, schematic.blocks.length);
  assert.equal(verification.missingCount, 0);
  // Blocks really exist in the world.
  const [bx, by, bz] = schematic.blocks[0];
  assert.equal(world.getBlock({ x: origin.x + bx, y: origin.y + by, z: origin.z + bz }).name, schematic.palette[schematic.blocks[0][3]]);
  // Multiple bots participated.
  assert.ok(new Set(run.results.map((r) => r.bot)).size >= 2, 'expected cooperative execution');
});

test('the builder clears natural obstacles but never valuable blocks', async () => {
  const schematic = generateSchematic(createSpec({ tier: 1, category: 'shelter', variant: 0, number: 1, seed: 'clear-test' }), { id: 'clear', name: 'Clear test' });
  const world = new MockWorld({ flat: true });
  const bots = makeBots(world, schematic, 3);
  const origin = { x: 40, y: 72, z: 40 };
  const target = schematic.blocks.find(([x, y, z]) => x > 0 && y > 0 && z > 0);
  const worldPos = { x: origin.x + target[0], y: origin.y + target[1], z: origin.z + target[2] };
  world.setBlock(worldPos, 'dirt');
  const builder = new SchematicBuilder({ schematic, origin, world, bots, taskBoard: new TaskBoard() });
  const start = builder.start();
  assert.equal(start.ok, true, start.error);
  assert.equal(builder.analyze().clearance.blocks.dirt, 1);
  const run = await builder.run({ maxIterations: 400 });
  assert.equal(run.status.state, 'COMPLETE');
  assert.ok(builder.stats.cleared >= 1);
  assert.equal(world.getBlock(worldPos).name, schematic.palette[target[3]]);

  // Ores are preserved by default, so a build that needs their space refuses.
  const orePos = { x: origin.x + 1, y: origin.y + 1, z: origin.z + 1 };
  const world2 = new MockWorld({ flat: true });
  world2.setBlock(orePos, 'diamond_ore');
  const builder2 = new SchematicBuilder({ schematic: { ...schematic, blocks: [[1, 1, 1, 0, 1]], palette: ['oak_planks'], dimensions: { width: 2, height: 2, length: 2 }, materials: { oak_planks: 1 } }, origin, world: world2, bots: makeBots(world2, schematic, 1), taskBoard: new TaskBoard() });
  const analysis = builder2.analyze();
  assert.equal(analysis.blocked.length, 1, JSON.stringify(analysis.blocked));
  assert.equal(analysis.blocked[0].block, 'diamond_ore');
  assert.equal(analysis.feasible, false);
  const refused = builder2.start({ confirm: true });
  assert.equal(refused.ok, false);
  assert.ok(refused.error.includes('blocked'));
});

test('missing materials are transferred between teammates instead of duplicated', async () => {
  const schematic = smallSchematic();
  const world = new MockWorld({ flat: true });
  const bots = makeBots(world, schematic, 2);
  const empty = bots[1];
  for (const item of Object.keys(empty.inventory)) delete empty.inventory[item];
  const ledger = new ResourceLedger();
  for (const bot of bots) ledger.updateBotInventory(bot.name, bot.inventory);
  const builder = new SchematicBuilder({ schematic, origin: { x: 50, y: 72, z: 50 }, world, bots, taskBoard: new TaskBoard(), ledger });
  const item = Object.keys(schematic.materials)[0];
  const before = empty.countItem(item);
  const result = await builder._acquireMaterial(empty, item, 1);
  assert.equal(result.ok, true, result.error);
  assert.equal(empty.countItem(item), before + 1);
  assert.ok(builder.stats.transferred >= 1);
  assert.ok(ledger.pendingTransfers().length === 0);
});

test('verification detects missing blocks and status reports partial progress', async () => {
  const schematic = smallSchematic();
  const world = new MockWorld({ flat: true });
  const bots = makeBots(world, schematic);
  const origin = { x: 60, y: 72, z: 60 };
  const builder = new SchematicBuilder({ schematic, origin, world, bots, taskBoard: new TaskBoard() });
  builder.start();
  for (let i = 0; i < Math.ceil(schematic.blocks.length / 2); i++) {
    const [x, y, z, p] = schematic.blocks[i];
    world.setBlock({ x: origin.x + x, y: origin.y + y, z: origin.z + z }, schematic.palette[p]);
  }
  const verification = builder.verify();
  assert.equal(verification.complete, false);
  assert.ok(verification.missingCount > 0);
  assert.ok(verification.percentComplete > 20 && verification.percentComplete < 100);
  const status = builder.status();
  assert.equal(status.totalBlocks, schematic.blocks.length);
  assert.equal(status.conflicts, 0);
});

test('cancel stops pending tasks and a completed build is idempotent', async () => {
  const schematic = smallSchematic();
  const world = new MockWorld({ flat: true });
  const bots = makeBots(world, schematic);
  const taskBoard = new TaskBoard();
  const origin = { x: 70, y: 72, z: 70 };
  const builder = new SchematicBuilder({ schematic, origin, world, bots, taskBoard });
  builder.start();
  const cancelled = builder.cancel('test');
  assert.equal(cancelled.state, 'CANCELLED');
  assert.ok([...taskBoard.tasks.values()].every((t) => t.status === 'CANCELLED'));

  const again = new SchematicBuilder({ schematic, origin, world, bots: makeBots(world, schematic), taskBoard: new TaskBoard() });
  again.start();
  await again.run({ maxIterations: 400 });
  const repeat = new SchematicBuilder({ schematic, origin, world, bots: makeBots(world, schematic), taskBoard: new TaskBoard() });
  const result = repeat.start();
  assert.equal(result.ok, true);
  assert.equal(result.message, 'structure already exists');
});
