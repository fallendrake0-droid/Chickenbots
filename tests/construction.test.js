'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { TaskBoard } = require('../src/team/taskBoard');
const { ResourceLedger } = require('../src/team/resourceLedger');
const { SchematicLibrary } = require('../src/schematics/library');
const { ConstructionManager, PIPELINE_PHASES, BUILD_PHASES, STATUS } = require('../src/construction/manager');
const { SiteSurveyor } = require('../src/construction/siteSurvey');
const { planLighting, executeLighting, auditLighting, findSpawnableSurfaces, LIGHT_SOURCES } = require('../src/construction/lighting');
const { billOfMaterials, materialStatus, validateSubstitution, categoryForItem, reserveProjectMaterials } = require('../src/construction/materials');
const { Warehouse } = require('../src/construction/storage');
const { createCommandHandler } = require('../src/commands');

const NAMES = ['________', '10101000', '01010100', '11001100', '00110000'];

function tmpState(name) {
  return path.join(os.tmpdir(), `chickenbots-${name}-${process.pid}-${Date.now()}.json`);
}

function makeBots(world, inventory = {}, positions = null) {
  return NAMES.map((name, index) => new MockBot({
    name, world, inventory: { ...inventory },
    position: positions ? positions[index] : { x: index, y: world.surfaceY(index, 0) + 1, z: 0 }
  }));
}

test('site survey uses observed terrain, detects hazards and never treats missing blocks as air', () => {
  const world = new MockWorld({ flat: true, seed: 41 });
  const bot = new MockBot({ name: NAMES[0], world, position: { x: 0, y: 64, z: 0 } });
  const surveyor = new SiteSurveyor({ bot });
  const origin = { x: 20, y: 64, z: 20 };
  world.setBlock({ x: 23, y: 64, z: 23 }, 'stone');
  world.setBlock({ x: 24, y: 64, z: 24 }, 'oak_log');
  world.setBlock({ x: 25, y: 64, z: 25 }, 'water');
  const survey = surveyor.survey({ origin, width: 10, length: 10, margin: 3, sampleLimit: 400 });
  assert.equal(survey.ok, true);
  assert.ok(survey.samples > 0);
  assert.ok(survey.stats.trees > 0);
  assert.ok(survey.stats.water > 0);
  assert.equal(survey.hazards.water, true);
  assert.equal(survey.stats.unknown, 0);
  assert.ok(survey.heightMap.some((column) => column.x === 24 && column.z === 24 && column.tree));

  // Synthetic height map proves the surveyor reports real elevation range when
  // the observed surface genuinely varies.
  const heights = new Map([['0,0', 66], ['1,0', 66], ['0,1', 63], ['1,1', 63]]);
  const synthetic = new SiteSurveyor({
    blockAt: (pos) => ({ name: pos.y <= (heights.get(`${pos.x},${pos.z}`) ?? 63) ? 'stone' : 'air' }),
    surfaceAt: (x, z) => heights.get(`${x},${z}`) ?? 63
  });
  const hilly = synthetic.survey({ origin: { x: 0, y: 67, z: 0 }, width: 2, length: 2, sampleLimit: 20 });
  assert.equal(hilly.stats.range, 3);
  assert.ok(hilly.stats.flatness < 1);

  const scored = surveyor.score(survey, { home: { x: 0, y: 64, z: 0 } });
  assert.ok(Number.isFinite(scored.score));
  assert.ok(scored.score >= 0 && scored.score <= 100);

  // A block reader with no chunk data must produce an explicit unloaded signal.
  const unloaded = new SiteSurveyor({ blockAt: () => null, surfaceAt: () => 63 });
  const missing = unloaded.survey({ origin: { x: 100, y: 64, z: 100 }, width: 6, length: 6 });
  assert.ok(missing.stats.unknown > 0);
  assert.equal(missing.hazards.unloaded, true);
});

test('a completed construction project cannot be paused, cancelled or restarted', async () => {
  const manager = new ConstructionManager({
    library: {}, persistPath: tmpState('construction-terminal'), now: () => 1000
  });
  manager.projects.set('project-terminal', {
    id: 'project-terminal', status: STATUS.COMPLETE, paused: false, history: [],
    buildPhases: [], completedAt: new Date(1000).toISOString()
  });
  manager.activeId = 'project-terminal';
  assert.equal(manager.pause().ok, false);
  assert.equal(manager.cancel().ok, false);
  const rerun = await manager.runPhase('ANALYSIS', { force: true });
  assert.equal(rerun.ok, false);
  assert.match(rerun.error, /COMPLETE/);
  assert.equal(manager.getProject('project-terminal').status, STATUS.COMPLETE);
  assert.equal(manager.getProject('project-terminal').history.length, 0);
  const summary = manager.summary(manager.getProject('project-terminal'));
  assert.equal(summary.status, STATUS.COMPLETE);
  assert.deepEqual(summary.assignments, {});
  assert.deepEqual(summary.origin, {});
});

test('site survey rejects non-finite footprints instead of returning Infinity statistics', () => {
  const surveyor = new SiteSurveyor({ blockAt: () => ({ name: 'stone' }), surfaceAt: () => 64 });
  for (const bad of [
    { origin: { x: 0, y: 64, z: 0 }, width: Number.NaN, length: 8 },
    { origin: { x: 0, y: 64, z: 0 }, width: 8, length: Infinity },
    { origin: { x: 0, y: 64, z: 0 }, width: -4, length: 8 },
    { origin: { x: 0, y: 64, z: 0 }, width: 8, length: 8, sampleLimit: 0 }
  ]) {
    const result = surveyor.survey(bad);
    assert.equal(result.ok, false);
    assert.match(result.error, /positive/);
  }
  assert.deepEqual(surveyor.candidateOrigins({ x: Number.NaN, z: 0 }), []);
});

test('lighting planner uses real emission values, respects reserved BOM blocks and verifies placement', async () => {
  const world = new MockWorld({ flat: true, seed: 42 });
  const bots = makeBots(world, { torch: 32, lantern: 2 }, NAMES.map((_, i) => ({ x: i, y: 64, z: 0 })));
  const bounds = { min: { x: -4, y: 60, z: -4 }, max: { x: 4, y: 70, z: 4 } };
  const surfaces = findSpawnableSurfaces({ bot: bots[0], bounds, maxSurfaces: 100 });
  assert.ok(surfaces.length > 0);
  const inventory = { torch: 32, lantern: 2 };
  const plan = planLighting({ surfaces, inventory, reserved: { lantern: 2 }, blockAt: (pos) => bots[0].getBlock(pos), maxLights: 32 });
  assert.equal(plan.source, 'torch', 'reserved build lanterns must not be used for temporary lighting');
  assert.ok(plan.placements.length > 0);
  assert.ok(plan.placements.length <= 32);
  assert.equal(LIGHT_SOURCES.torch, 14);
  assert.equal(LIGHT_SOURCES.lantern, 15);
  assert.equal(LIGHT_SOURCES.soul_torch, 10);
  const executed = await executeLighting({ bots, plan, blockAt: (pos) => bots[0].getBlock(pos) });
  assert.equal(executed.ok, true, JSON.stringify(executed.results.filter((result) => !result.ok).slice(0, 2)));
  assert.equal(executed.placed, plan.placements.length);
  for (const result of executed.results) {
    assert.equal(world.getBlock(result.placement.pos).name, 'torch');
  }
  const audit = auditLighting({ bot: bots[0], bounds, lights: plan.placements, maxSurfaces: 100 });
  assert.equal(audit.uncovered.length, 0);
});

test('bill of materials, deficits, categories and substitution safety are real', () => {
  const schematic = {
    id: 'bom', name: 'BOM', palette: ['cobblestone', 'oak_planks', 'torch', 'lantern'],
    blocks: [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 1], [1, 1, 0, 2], [2, 0, 0, 3]]
  };
  const bom = billOfMaterials(schematic);
  assert.deepEqual(bom.materials, { cobblestone: 2, oak_planks: 1, torch: 1, lantern: 1 });
  assert.equal(bom.totalBlocks, 5);
  const status = materialStatus(bom, { cobblestone: 1, oak_planks: 1, torch: 0, lantern: 1 });
  assert.equal(status.ready, false);
  assert.deepEqual(status.deficit, { cobblestone: 1, torch: 1 });
  assert.equal(categoryForItem('cobblestone'), 'stone');
  assert.equal(categoryForItem('oak_planks'), 'wood');
  assert.equal(categoryForItem('lantern'), 'lighting');
  assert.equal(validateSubstitution('cobblestone', 'stone').ok, true);
  assert.equal(validateSubstitution('oak_stairs', 'cobblestone').ok, false);
  assert.equal(validateSubstitution('redstone_lamp', 'glowstone').ok, false);
  assert.equal(validateSubstitution('cobblestone', 'diamond_block').ok, false);
});

test('warehouse performs verified physical deposits/withdrawals, categorises chests and honours locks', async () => {
  const world = new MockWorld({ flat: true, seed: 43 });
  const bot = new MockBot({ name: NAMES[0], world, inventory: { cobblestone: 12, oak_planks: 8, torch: 4 }, position: { x: 0, y: 64, z: 0 } });
  world.setBlock({ x: 2, y: 64, z: 0 }, 'chest');
  const ledger = new ResourceLedger();
  const warehouse = new Warehouse({ bots: [bot], ledger });
  const scan = await warehouse.scan({ bot, near: { x: 0, y: 64, z: 0 }, radius: 6 });
  assert.equal(scan.ok, true);
  assert.equal(scan.containers.length, 1);
  const container = scan.containers[0];
  const lock = warehouse.lock(container.id, '________');
  assert.equal(lock.ok, true);
  assert.equal(warehouse.lock(container.id, 'other').ok, false);
  warehouse.unlock(container.id, '________');
  const before = bot.countItem('cobblestone');
  const deposit = await warehouse.deposit({ item: 'cobblestone', count: 5, bot, container });
  assert.equal(deposit.ok, true);
  assert.equal(bot.countItem('cobblestone'), before - 5);
  assert.equal(Number((await warehouse.peek(container, bot)).items.cobblestone), 5);
  const retrieve = await warehouse.retrieve({ item: 'cobblestone', count: 3, bot, container });
  assert.equal(retrieve.ok, true);
  assert.equal(bot.countItem('cobblestone'), before - 2);
  assert.equal(Number((await warehouse.peek(container, bot)).items.cobblestone), 2);
  assert.equal(warehouse.capacity().containers, 1);
  assert.equal(warehouse.locate('cobblestone')[0].count, 2);
});

test('full construction pipeline runs ten bots from survey to verified handover', async () => {
  const statePath = tmpState('pipeline');
  const world = new MockWorld({ flat: true, seed: 44 });
  const library = new SchematicLibrary();
  const design = library.get('0001_beginner_shelter');
  const schematic = library.build(design.id);
  const materials = billOfMaterials(schematic).materials;
  const inventory = {
    ...materials, torch: 256, oak_planks: 512, stick: 256, cobblestone: 1024,
    oak_log: 64, coal: 64
  };
  const bots = makeBots(world, inventory, NAMES.map((_, i) => ({ x: 24 + i, y: 64, z: 24 })));
  const taskBoard = new TaskBoard();
  const ledger = new ResourceLedger();
  for (const bot of bots) ledger.updateBotInventory(bot.name, bot.inventory);
  const manager = new ConstructionManager({
    library, bots, world, taskBoard, ledger, home: { x: 0, y: 64, z: 0 }, persistPath: statePath
  });
  const created = manager.createProject({ schematicId: design.id, origin: { x: 24, y: 64, z: 24 } });
  assert.equal(created.ok, true);
  assert.equal(created.project.origin.x, 24);
  assert.equal(manager.activeProject().buildPhases.length, PIPELINE_PHASES.length);
  assert.equal(manager.activeProject().buildMilestones.length, BUILD_PHASES.length);
  const gated = await manager.autoAdvance();
  assert.equal(gated.skipped, true, 'autonomy must stay disarmed until an operator confirms');
  manager.setAutonomy(true);
  const armed = await manager.autoAdvance();
  assert.equal(armed.ok, true);

  for (let i = 0; i < 45; i++) {
    const step = await manager.advance({ maxPhases: 1, maxActions: 500 });
    assert.equal(step.ok, true, `${manager.activeProject().status}: ${step.error || step.results?.[0]?.detail || ''}`);
    if (manager.activeProject().status === STATUS.COMPLETE) break;
  }
  const project = manager.activeProject();
  assert.equal(project.status, STATUS.COMPLETE, project.blockedReason || '');
  assert.equal(project.progress, 100);
  const builder = manager.builders.get(project.builderId);
  assert.ok(builder);
  const verification = builder.verify();
  assert.equal(verification.complete, true);
  assert.equal(verification.placed, schematic.blocks.length);
  assert.equal(project.quality.verification.complete, true);
  assert.ok(project.sitePreparation.lighting.placements > 0);
  assert.ok(project.sitePreparation.perimeter.placed > 0);
  assert.ok(project.sitePreparation.excavation.actions > 0);
  assert.ok(project.sitePreparation.levelling.filled > 0);
  assert.ok(manager.warehouse.containers.size > 0);
  const participants = new Set([...taskBoard.tasks.values()].map((task) => task.claimedBy).filter(Boolean));
  assert.ok(participants.size >= 2, `expected cooperative build, got ${participants.size} participant(s)`);

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(persisted.projects.length, 1);
  assert.equal(persisted.projects[0].status, STATUS.COMPLETE);
  assert.equal(persisted.projects[0].origin.x, 24);
  const restored = new ConstructionManager({
    library, bots, world, taskBoard, ledger, home: { x: 0, y: 64, z: 0 }, persistPath: statePath
  });
  assert.equal(restored.projects.size, 1);
  assert.equal(restored.activeProject().id, project.id);
  assert.equal(restored.activeProject().origin.z, 24);
  fs.rmSync(statePath, { force: true });
});

test('rotation changes dimensions and project selection rejects overlapping active footprints', () => {
  const statePath = tmpState('rotation');
  const world = new MockWorld({ flat: true, seed: 45 });
  const library = new SchematicLibrary();
  const bots = makeBots(world, {}, NAMES.map((_, i) => ({ x: i, y: 64, z: 0 })));
  const manager = new ConstructionManager({ library, bots, world, home: { x: 0, y: 64, z: 0 }, persistPath: statePath });
  const design = library.get('0001_beginner_shelter');
  const normal = manager.createProject({ schematicId: design.id, origin: { x: 20, y: 64, z: 20 } });
  assert.equal(normal.ok, true);
  assert.equal(normal.project.dimensions.width, design.dimensions.width);
  manager.setActive(normal.project.id);
  const rotated = manager.createProject({ schematicId: design.id, origin: { x: 80, y: 64, z: 80 }, rotation: 90 });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.project.dimensions.width, design.dimensions.length);
  assert.equal(rotated.project.dimensions.length, design.dimensions.width);
  // Selecting a site for the second project that overlaps the first must fail.
  manager.setActive(rotated.project.id);
  const survey = manager.surveyActive({ candidates: false });
  assert.equal(survey.ok, true);
  const selected = manager.selectSite({ origin: { x: 24, y: 64, z: 24 } });
  assert.equal(selected.ok, false);
  assert.match(selected.error, /overlaps/);
  fs.rmSync(statePath, { force: true });
});


test('builder, site, materials and storage command families operate on the real manager', async () => {
  const statePath = tmpState('commands');
  const world = new MockWorld({ flat: true, seed: 46 });
  const library = new SchematicLibrary();
  const bots = makeBots(world, { cobblestone: 64, oak_planks: 32, torch: 16 }, NAMES.map((_, i) => ({ x: i, y: 64, z: 0 })));
  const taskBoard = new TaskBoard();
  const ledger = new ResourceLedger();
  const manager = new ConstructionManager({ library, bots, world, taskBoard, ledger, home: { x: 0, y: 64, z: 0 }, persistPath: statePath });
  const handlers = createCommandHandler({
    library, bots: new Map(bots.map((bot) => [bot.name, bot])), world, taskBoard, ledger,
    construction: manager, builders: manager.builders, imported: new Map(), actions: null
  });
  const run = async (line) => handlers.execute(line, { source: 'cli' });
  const help = handlers.help();
  for (const name of ['builder', 'site', 'materials', 'storage', 'build']) assert.ok(help.categories.builder.some((command) => command.name === name), name);
  const created = await run('builder create 0001 40 64 40');
  assert.equal(created.ok, true, created.result?.error);
  assert.equal(manager.activeProject().origin.x, 40);
  const listed = await run('builder projects');
  assert.equal(listed.result.projects.length, 1);
  const survey = await run('site survey');
  assert.equal(survey.ok, true, survey.result?.error);
  assert.ok(survey.result.candidates.length >= 1);
  const preview = await run('site preview light');
  assert.equal(preview.ok, true, preview.result?.error);
  assert.ok(preview.result.plan);
  const materials = await run('materials status');
  assert.equal(materials.ok, true, materials.result?.error);
  assert.equal(materials.result.totalNeeded, Object.values(manager.activeProject().materialRequirements).reduce((sum, n) => sum + n, 0));
  assert.ok(Object.keys(materials.result.deficit).length > 0, 'starter inventory is honestly short');
  const readiness = await run('materials readiness');
  assert.equal(readiness.ok, true);
  assert.ok(readiness.result.phases.FOUNDATION);
  const capacity = await run('storage capacity');
  assert.equal(capacity.ok, true);
  assert.equal(capacity.result.capacity.containers, 0);
  const gated = await run('builder run');
  assert.equal(gated.ok, false);
  assert.equal(gated.result.code, 'CONFIRMATION_REQUIRED');
  const arming = await run('builder auto on');
  assert.equal(arming.ok, true);
  assert.equal(manager.activeProject().autonomyEnabled, true);
  fs.rmSync(statePath, { force: true });
});

test('a project survives a restart mid-preparation and a complete phase is never re-run by accident', async () => {
  const statePath = tmpState('restart');
  const world = new MockWorld({ flat: true, seed: 47 });
  const library = new SchematicLibrary();
  const design = library.get('0001_beginner_shelter');
  const schematic = library.build(design.id);
  const materials = billOfMaterials(schematic).materials;
  const inventory = { ...materials, torch: 256, oak_planks: 512, stick: 256, cobblestone: 1024, oak_log: 64, coal: 64 };
  const bots = makeBots(world, inventory, NAMES.map((_, i) => ({ x: 24 + i, y: 64, z: 24 })));
  const taskBoard = new TaskBoard();
  const ledger = new ResourceLedger();
  for (const bot of bots) ledger.updateBotInventory(bot.name, bot.inventory);
  const manager = new ConstructionManager({ library, bots, world, taskBoard, ledger, home: { x: 0, y: 64, z: 0 }, persistPath: statePath });
  assert.equal(manager.createProject({ schematicId: design.id, origin: { x: 24, y: 64, z: 24 } }).ok, true);
  for (let i = 0; i < 30; i++) {
    const phase = manager.activeProject().buildPhases.find((entry) => entry.id === 'CONSTRUCTION');
    if (phase.status !== 'PENDING' && phase.status !== 'ACTIVE') break;
    const step = await manager.advance({ maxPhases: 1, maxActions: 24 });
    assert.equal(step.ok, true, step.error || '');
    if (manager.activeProject().status === STATUS.COMPLETE) break;
  }
  const before = manager.activeProject();
  const inFlight = before.buildPhases.find((entry) => entry.status === 'ACTIVE');
  assert.ok(inFlight, 'the run should still be mid-phase when the restart happens');
  assert.ok(before.buildPhases.find((entry) => entry.id === 'SURVEY').status === 'COMPLETE');

  const restored = new ConstructionManager({ library, bots, world, taskBoard, ledger, home: { x: 0, y: 64, z: 0 }, persistPath: statePath });
  assert.equal(restored.projects.size, 1);
  assert.equal(restored.activeProject().buildPhases.find((entry) => entry.id === inFlight.id).status, inFlight.status);
  assert.equal(restored.activeProject().sitePreparation.survey.samples > 0, true, 'survey evidence survives the restart');
  const analysis = await restored.runPhase('ANALYSIS');
  assert.equal(analysis.already, true, 'completed work must not be silently repeated');
  const forced = await restored.runPhase('ANALYSIS', { force: true });
  assert.equal(forced.ok, true);
  for (let i = 0; i < 45; i++) {
    if (restored.activeProject().status === STATUS.COMPLETE) break;
    const step = await restored.advance({ maxPhases: 1, maxActions: 500 });
    assert.equal(step.ok, true, `${restored.activeProject().status}: ${step.error || ''}`);
  }
  assert.equal(restored.activeProject().status, STATUS.COMPLETE, restored.activeProject().blockedReason || '');
  assert.equal(restored.activeProject().quality.verification.placed, schematic.blocks.length);
  fs.rmSync(statePath, { force: true });
});


test('a failed material reservation rolls back every partial reservation', () => {
  const ledger = new ResourceLedger();
  ledger.updateBotInventory('________', { oak_log: 10 });
  const result = reserveProjectMaterials({
    ledger,
    owner: 'project-rollback',
    bom: { materials: { oak_log: 5, stone: 5 } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.released, 1);
  assert.equal(ledger.available('oak_log'), 10);
  assert.equal(ledger.reservations.filter((reservation) => reservation.active).length, 0);
});
