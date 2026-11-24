'use strict';

const { Logger } = require('../logger');
const { config } = require('../config');
const { classifyBlock, isAir } = require('../excavate/safety');
const { PHASES } = require('../schematics/blockGrid');
const { distance } = require('../util/vec');
const { BuildEngine, STATUS: BLOCK_STATUS } = require('../building/engine');
const { parseBlock, matchesBlock, formatBlock, placementItem } = require('../building/blockStates');

const DEFAULT_CHUNK_SIZE = 96;

function phaseIndex(name) {
  const idx = PHASES.indexOf(name);
  return idx === -1 ? 0 : idx;
}

function blockKey(pos) { return `${pos.x},${pos.y},${pos.z}`; }

function countMaterials(blocks) {
  const out = {};
  for (const b of blocks) {
    const name = placementItem(parseBlock(b.blockState || b.block));
    out[name] = (out[name] || 0) + 1;
  }
  return out;
}

/**
 * Cooperative schematic construction.
 *
 * The builder turns a generated (or imported) schematic into phased tasks on
 * the shared task board, assigns spatially separated regions to the team,
 * delivers materials between bots, clears natural obstacles under the normal
 * safety policy, places real blocks through the bot adapter, and only reports
 * completion after rescanning the world.
 */
class SchematicBuilder {
  constructor({
    schematic, origin, world, bots = [], taskBoard = null, ledger = null, memory = null,
    logger = null, authorized = false, preserveOres = true, chunkSize = DEFAULT_CHUNK_SIZE,
    buildId = null, maxUndergroundRatio = 0.35
  } = {}) {
    if (!schematic || !Array.isArray(schematic.blocks) || !schematic.blocks.length) throw new Error('builder requires a schematic with blocks');
    if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) throw new Error('builder requires a finite origin');
    if (!world) throw new Error('builder requires a world');
    this.schematic = schematic;
    this.origin = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
    this.world = world;
    this.bots = bots;
    this.taskBoard = taskBoard;
    this.ledger = ledger;
    this.memory = memory;
    this.logger = logger || new Logger({ level: 'warn' });
    this.authorized = Boolean(authorized);
    this.preserveOres = preserveOres !== false;
    this.chunkSize = Math.max(8, chunkSize);
    this.maxUndergroundRatio = maxUndergroundRatio;
    this.id = buildId || `build-${schematic.id || 'schematic'}-${Date.now().toString(36)}`;
    this.objectiveId = null;
    this.tasks = [];
    this.analysis = null;
    this.finalAudit = null;
    this.startedAt = null;
    this.state = 'READY';
    this.cancelled = false;
    this.paused = false;
    this.events = [];
    this.stats = { placed: 0, cleared: 0, skipped: 0, transferred: 0, failedPlacements: 0, stateMismatches: 0, repaired: 0 };
    this.engine = new BuildEngine({
      schematic, origin: this.origin, world, bots,
      authorized: this.authorized, preserveOres: this.preserveOres,
      registryVersion: config.building?.minecraftVersion || 'auto',
      logger: this.logger
    });
  }

  // ------------------------------------------------------------------
  // Analysis
  // ------------------------------------------------------------------
  worldPos(b) {
    const [x, y, z] = Array.isArray(b) ? b : [b.x, b.y, b.z];
    return { x: this.origin.x + x, y: this.origin.y + y, z: this.origin.z + z };
  }

  analyze({ refresh = false } = {}) {
    if (this.analysis && !refresh) return this.analysis;
    const dims = this.schematic.dimensions;
    const volume = dims.width * dims.height * dims.length;
    const clearance = new Map();
    const occupiedClearance = new Set();
    const conflicts = [];
    const blocked = [];
    const alreadyBuilt = [];
    const toPlace = [];
    let underground = 0;
    const surfaceCache = new Map();
    for (const [x, y, z, paletteIndex, phase] of this.schematic.blocks) {
      const targetEntry = this.schematic.palette[paletteIndex];
      const target = parseBlock(targetEntry).name;
      const pos = this.worldPos([x, y, z]);
      const current = this.world.getBlock(pos);
      if (!current) {
        // Unknown is not air: never plan a placement into an unloaded chunk.
        blocked.push({ pos, block: 'unloaded', kind: 'UNLOADED', reason: 'chunk not loaded' });
        continue;
      }
      const currentName = current.name;
      if (matchesBlock(current, targetEntry)) {
        alreadyBuilt.push({ x: pos.x, y: pos.y, z: pos.z, block: target, blockState: formatBlock(targetEntry), phase: PHASES[phase] });
        continue;
      }
      let mustClear = false;
      if (!isAir(currentName)) {
        const cls = classifyBlock(currentName, { preserveOres: this.preserveOres, authorized: this.authorized });
        if (cls.excavatable) mustClear = true;
        else if (cls.requiresAuth) {
          conflicts.push({ pos, block: currentName, kind: cls.kind, reason: cls.reason, needsAuthorization: true });
          continue;
        } else {
          blocked.push({ pos, block: currentName, kind: cls.kind, reason: cls.reason });
          continue;
        }
      }
      // Detect how much of the build sits inside terrain: a proxy for required site prep.
      const surfKey = `${pos.x},${pos.z}`;
      if (!surfaceCache.has(surfKey)) surfaceCache.set(surfKey, this.world.surfaceY(pos.x, pos.z));
      if (pos.y <= surfaceCache.get(surfKey)) underground++;
      if (mustClear) {
        const k = blockKey(pos);
        if (!occupiedClearance.has(k)) {
          occupiedClearance.add(k);
          clearance.set(k, { pos, block: currentName });
        }
      }
      toPlace.push({ x: pos.x, y: pos.y, z: pos.z, block: target, blockState: formatBlock(targetEntry), paletteIndex, phase: PHASES[phase] || 'FOUNDATION' });
    }
    const requiredMaterials = countMaterials(toPlace);
    const available = {};
    for (const bot of this.bots) {
      for (const [item, count] of Object.entries(bot.inventory || {})) if (count > 0) available[item] = (available[item] || 0) + count;
    }
    const missingMaterials = {};
    for (const [item, count] of Object.entries(requiredMaterials)) {
      const have = available[item] || 0;
      if (have < count) missingMaterials[item] = count - have;
    }
    const clearanceBlocks = [...clearance.values()];
    const clearanceCounts = {};
    for (const c of clearanceBlocks) clearanceCounts[c.block] = (clearanceCounts[c.block] || 0) + 1;
    const undergroundRatio = volume ? underground / volume : 0;
    this.analysis = {
      buildId: this.id,
      schematicId: this.schematic.id,
      name: this.schematic.name,
      tier: this.schematic.tier,
      origin: { ...this.origin },
      dimensions: { ...dims },
      volume,
      totalBlocks: this.schematic.blocks.length,
      toPlace: toPlace.length,
      alreadyBuilt: alreadyBuilt.length,
      clearance: { volume: clearanceBlocks.length, blocks: clearanceCounts },
      conflicts,
      blocked,
      undergroundBlocks: underground,
      undergroundRatio: Number(undergroundRatio.toFixed(3)),
      requiresSitePrep: undergroundRatio > this.maxUndergroundRatio,
      requiredMaterials,
      availableMaterials: available,
      missingMaterials,
      authorized: this.authorized,
      feasible: conflicts.length === 0 && blocked.length === 0 && Object.keys(missingMaterials).length === 0,
      plannedBlocks: toPlace
    };
    return this.analysis;
  }

  // ------------------------------------------------------------------
  // Task planning
  // ------------------------------------------------------------------
  planTasks({ refresh = false } = {}) {
    const analysis = this.analyze({ refresh });
    if (this.tasks.length) return { tasks: this.tasks, analysis };
    const teamSize = Math.max(1, this.bots.length);
    const width = Math.max(1, analysis.dimensions.width);
    const regionCount = Math.min(teamSize, width);
    const byRegion = new Map();
    for (let i = 0; i < regionCount; i++) {
      const minX = Math.floor((width * i) / regionCount);
      const maxX = Math.floor((width * (i + 1)) / regionCount) - 1;
      byRegion.set(i, { id: `r${i + 1}`, minX, maxX, blocks: [] });
    }
    for (const b of analysis.plannedBlocks) {
      const relX = b.x - this.origin.x;
      const regionIndex = Math.min(regionCount - 1, Math.max(0, Math.floor((relX * regionCount) / width)));
      byRegion.get(regionIndex).blocks.push(b);
    }
    const phases = [...new Set(analysis.plannedBlocks.map((b) => b.phase))].sort((a, b) => phaseIndex(a) - phaseIndex(b));
    const tasks = [];
    for (const region of byRegion.values()) {
      if (!region.blocks.length) continue;
      const regionBlocks = region.blocks.slice().sort((a, b) => phaseIndex(a.phase) - phaseIndex(b.phase) || a.y - b.y);
      let previousTaskId = null;
      let phaseCursor = -1;
      let chunk = [];
      let chunkIndex = 0;
      const flush = () => {
        if (!chunk.length) return;
        const bounds = {
          minX: Math.min(...chunk.map((b) => b.x)), minY: Math.min(...chunk.map((b) => b.y)), minZ: Math.min(...chunk.map((b) => b.z)),
          maxX: Math.max(...chunk.map((b) => b.x)), maxY: Math.max(...chunk.map((b) => b.y)), maxZ: Math.max(...chunk.map((b) => b.z))
        };
        const phase = chunk[0].phase;
        const id = `${this.id}:${region.id}:${phase.toLowerCase()}:${chunkIndex}`;
        const assignee = this.bots[tasks.length % Math.max(1, this.bots.length)];
        const task = {
          id,
          buildId: this.id,
          regionId: region.id,
          phase,
          phaseIndex: phaseIndex(phase),
          chunkIndex,
          blocks: chunk,
          materials: countMaterials(chunk),
          bounds,
          assignee: assignee ? assignee.name : null,
          dependsOn: previousTaskId ? [previousTaskId] : []
        };
        previousTaskId = id;
        chunkIndex++;
        chunk = [];
        tasks.push(task);
      };
      for (const b of regionBlocks) {
        if (b.phase !== phases[phaseCursor]) {
          flush();
          phaseCursor = phases.indexOf(b.phase);
          chunk = [];
          if (tasks.length && previousTaskId) {
            // Depend on the last task of the previous phase for this region.
          }
        }
        chunk.push(b);
        if (chunk.length >= this.chunkSize) flush();
      }
      flush();
    }
    // Ensure cross-phase dependencies: first task of a phase depends on the
    // last task of the previous phase in the same region.
    const byRegionPhase = new Map();
    for (const t of tasks) {
      byRegionPhase.set(`${t.regionId}:${t.phaseIndex}`, t);
    }
    for (const t of tasks) {
      if (t.dependsOn.length) continue;
      const prevPhase = [...byRegionPhase.entries()]
        .filter(([key]) => key.startsWith(`${t.regionId}:`) && Number(key.split(':')[1]) < t.phaseIndex)
        .sort((a, b) => Number(b[0].split(':')[1]) - Number(a[0].split(':')[1]))[0];
      if (prevPhase) t.dependsOn = [prevPhase[1].id];
    }
    this.tasks = tasks;
    this.analysis.taskCount = tasks.length;
    this.analysis.regionCount = regionCount;
    return { tasks, analysis: this.analysis };
  }

  // ------------------------------------------------------------------
  // Execution
  // ------------------------------------------------------------------
  start({ confirm = false } = {}) {
    if (this.state === 'RUNNING') return { ok: false, error: 'build already running' };
    const validation = this.engine.validateBlueprint();
    if (!validation.ok) {
      this.state = 'FAILED';
      this._event('build.blueprint-invalid', { issues: validation.issues.length });
      return { ok: false, error: `blueprint is invalid (${validation.issues.length} issue(s)); nothing was placed`, validation: validation.issues.slice(0, 20) };
    }
    const plan = this.engine.buildPlan();
    if (!plan.valid) {
      this.state = 'FAILED';
      return { ok: false, error: `blueprint has ${plan.cycles.length} cyclic dependency position(s); nothing was placed`, cycles: plan.cycles.slice(0, 20) };
    }
    const analysis = this.analyze();
    if (analysis.requiresSitePrep) {
      return { ok: false, error: `site preparation required: ${analysis.undergroundBlocks} blocks are inside terrain`, requiresSitePrep: true };
    }
    if (analysis.blocked.length) {
      return {
        ok: false,
        error: `cannot build: ${analysis.blocked.length} permanently blocked blocks (ores, liquids, bedrock) in the footprint`,
        blocked: analysis.blocked.slice(0, 20)
      };
    }
    if (analysis.conflicts.length) {
      if (!confirm || !this.authorized) {
        return {
          ok: false,
          error: `cannot build: ${analysis.conflicts.length} protected blocks in the footprint; re-run with confirmation to authorise player structures`,
          conflicts: analysis.conflicts.slice(0, 20),
          needsConfirmation: true
        };
      }
      this.analyze({ refresh: true });
      if (this.analysis.conflicts.length) {
        return { ok: false, error: 'protected blocks remain that cannot be destroyed (containers, beds, ores, redstone)', conflicts: this.analysis.conflicts.slice(0, 20) };
      }
    }
    if (Object.keys(analysis.missingMaterials).length) {
      return { ok: false, error: 'materials missing', missing: analysis.missingMaterials };
    }
    if (!this.taskBoard) return { ok: false, error: 'builder requires a task board' };
    const { tasks } = this.planTasks();
    if (!tasks.length) {
      this.state = 'COMPLETE';
      return { ok: true, message: 'structure already exists', tasks: [], alreadyBuilt: analysis.alreadyBuilt };
    }
    const objective = this.taskBoard.createObjective({
      id: `${this.id}:objective`,
      title: `Build ${this.schematic.name}`,
      description: `${this.schematic.blocks.length} blocks in ${tasks.length} cooperative tasks`,
      priority: 70,
      progress: { current: 0, target: analysis.toPlace, unit: 'blocks' },
      metadata: { buildId: this.id, schematicId: this.schematic.id, origin: this.origin }
    });
    this.objectiveId = objective.id;
    for (const t of tasks) {
      const res = this.taskBoard.addTask({
        id: t.id,
        objectiveId: this.objectiveId,
        type: 'BUILD_BLOCK',
        label: `${this.schematic.name} ${t.phase} ${t.regionId}`,
        priority: 60 + (10 - t.phaseIndex),
        params: {
          buildId: this.id,
          schematicId: this.schematic.id,
          phase: t.phase,
          regionId: t.regionId,
          blocks: t.blocks,
          materials: t.materials,
          assignee: t.assignee
        },
        region: t.bounds,
        lockKeys: [`build:${this.id}:${t.regionId}`],
        dependsOn: t.dependsOn,
        units: { current: 0, target: t.blocks.length },
        maxAttempts: 3
      });
      if (!res.ok) throw new Error(`failed to add build task: ${res.error}`);
      t.taskId = res.task.id;
    }
    this.startedAt = Date.now();
    this.paused = false;
    this.state = 'RUNNING';
    this._event('build.started', { buildId: this.id, tasks: tasks.length });
    if (this.memory) {
      this.memory.setFact(`build:${this.id}`, { name: this.schematic.name, origin: this.origin, tasks: tasks.length, startedAt: this.startedAt });
    }
    return { ok: true, buildId: this.id, objectiveId: this.objectiveId, tasks: tasks.length, analysis: this.analyze() };
  }

  nextTask() {
    if (!this.taskBoard || this.paused) return null;
    for (const t of this.tasks) {
      const task = this.taskBoard.getTask(t.taskId || t.id);
      if (!task) continue;
      if (task.status !== 'PENDING') continue;
      if (!this.taskBoard.dependenciesSatisfied(task)) continue;
      return { plan: t, task };
    }
    return null;
  }

  botFor(name) { return this.bots.find((b) => b.name === name) || null; }

  selectBot(task) {
    if (task.params?.assignee) {
      const preferred = this.botFor(task.params.assignee);
      if (preferred) return preferred;
    }
    return this.bots[0] || null;
  }

  /**
   * Execute one build task. Returns only after re-reading the world and only
   * calls taskBoard.complete(..., {verified:true}) when every block is real.
   */
  async executeTask(bot, taskId) {
    if (this.paused) return { ok: true, paused: true, verified: false };
    if (!bot) return { ok: false, error: 'no bot' };
    if (!this.taskBoard) return { ok: false, error: 'builder requires a task board' };
    const task = this.taskBoard.getTask(taskId);
    if (!task) return { ok: false, error: 'unknown build task' };
    if (task.claimedBy && task.claimedBy !== bot.name) return { ok: false, error: `task claimed by ${task.claimedBy}` };
    if (!task.claimedBy) {
      const claim = this.taskBoard.claim(task.id, bot.name);
      if (!claim.ok) return { ok: false, error: claim.error };
    }
    this.taskBoard.start(task.id, bot.name);
    const blocks = task.params.blocks;
    let placed = 0;
    let cleared = 0;
    let skipped = 0;
    const failures = [];
    // Process in the engine's dependency order, not the chunk's storage order.
    const planOrder = new Map((this.engine.buildPlan().order || []).map((key, index) => [key, index]));
    const ordered = blocks.slice().sort((a, b) => {
      const ak = `${a.x - this.origin.x},${a.y - this.origin.y},${a.z - this.origin.z}`;
      const bk = `${b.x - this.origin.x},${b.y - this.origin.y},${b.z - this.origin.z}`;
      return (planOrder.get(ak) ?? 1e9) - (planOrder.get(bk) ?? 1e9);
    });
    for (const b of ordered) {
      const localKey = `${b.x - this.origin.x},${b.y - this.origin.y},${b.z - this.origin.z}`;
      const engineBlock = this.engine.byPosition.get(localKey);
      if (!engineBlock) {
        failures.push({ pos: { x: b.x, y: b.y, z: b.z }, error: 'position is not in the validated blueprint' });
        continue;
      }
      this.finalAudit = null;
      const result = await this.engine.place(engineBlock, bot, {
        acquire: (worker, item, count) => this._acquireMaterial(worker, item, count),
        retries: 1
      });
      if (result.ok) {
        if (result.alreadyPresent) skipped++;
        else placed++;
        continue;
      }
      failures.push({ pos: { x: b.x, y: b.y, z: b.z }, error: result.error, status: result.status });
      if (result.status === BLOCK_STATUS.MATERIAL_MISSING) this.stats.failedPlacements++;
      if (result.status === BLOCK_STATUS.REPAIR_REQUIRED) this.stats.failedPlacements++;
    }
    const clearedDelta = this.engine.stats.cleared - (this._engineCleared || 0);
    this._engineCleared = this.engine.stats.cleared;
    if (clearedDelta > 0) { cleared = clearedDelta; this.stats.cleared += cleared; }
    if (placed) this.stats.placed += placed;
    if (skipped) this.stats.skipped += skipped;
    this.taskBoard.updateProgress(task.id, { current: Math.min(blocks.length, placed + skipped), target: blocks.length });
    // Per-block verification of the exact state, not a summary count.
    const missing = [];
    const wrong = [];
    for (const b of blocks) {
      const localKey = `${b.x - this.origin.x},${b.y - this.origin.y},${b.z - this.origin.z}`;
      const engineBlock = this.engine.byPosition.get(localKey);
      const current = this.world.getBlock({ x: b.x, y: b.y, z: b.z });
      if (!engineBlock) {
        missing.push({ x: b.x, y: b.y, z: b.z, expected: b.block, found: current ? current.name : 'unloaded' });
      } else if (!matchesBlock(current, engineBlock.desired)) {
        const entry = { x: b.x, y: b.y, z: b.z, expected: engineBlock.canonical, found: current ? formatBlock(current) : 'unloaded' };
        if (!current || current.name === 'air') missing.push(entry);
        else wrong.push(entry);
      }
    }
    if (this.ledger) {
      this.ledger.updateBotInventory(bot.name, bot.inventory);
      this.ledger.completeTransfer(`build:${this.id}:${task.id}`, missing.length === 0 && wrong.length === 0);
    }
    let complete = { ok: false };
    if (missing.length === 0 && wrong.length === 0) {
      complete = this.taskBoard.complete(task.id, { by: bot.name, verified: true, notes: `verified ${blocks.length} blocks` });
    } else {
      complete = this.taskBoard.fail(task.id, `${missing.length}/${blocks.length} blocks missing, ${wrong.length} wrong state`, { by: bot.name, retry: true });
    }
    if (wrong.length) this.stats.stateMismatches += wrong.length;
    this._event('build.task', { taskId: task.id, bot: bot.name, placed, cleared, skipped, missing: missing.length });
    return {
      ok: missing.length === 0 && wrong.length === 0, buildId: this.id, taskId: task.id, bot: bot.name,
      placed, cleared, skipped, missing: missing.slice(0, 25), missingCount: missing.length,
      wrong: wrong.slice(0, 25), wrongCount: wrong.length,
      failures: failures.slice(0, 25), failureCount: failures.length,
      blockStatuses: this.engine.statusCounts(),
      taskStatus: this.taskBoard.getTask(task.id)?.status, completion: complete
    };
  }

  async _acquireMaterial(bot, item, count) {
    // 1. Ask a teammate that already holds the material; record a real transfer.
    for (const other of this.bots) {
      if (other === bot || other.name === bot.name) continue;
      if (!other.countItem(item)) continue;
      if (typeof other.tossItem !== 'function' || typeof bot.addItem !== 'function') break;
      const toss = await other.tossItem(item, count);
      if (!toss.ok) continue;
      bot.addItem(item, count);
      this.stats.transferred += count;
      if (this.ledger) {
        const req = this.ledger.requestTransfer({ from: other.name, to: bot.name, item, count, reason: `build ${this.id}` });
        if (req.ok) {
          this.ledger.claimTransfer(req.request.id, bot.name);
          this.ledger.completeTransfer(req.request.id, true);
        }
      }
      this._event('build.transfer', { from: other.name, to: bot.name, item, count });
      return { ok: true, from: other.name, item, count };
    }
    // 2. Withdraw from recorded storage containers.
    if (this.ledger && bot.world) {
      for (const storage of this.ledger.storages.values()) {
        if (!storage.position) continue;
        if (distance(bot.position, storage.position) > 32) continue;
        const container = await bot.openContainer(storage.position);
        if (!container || !container.ok) continue;
        const taken = await container.withdraw(item, count);
        await container.close();
        if (taken.ok) {
          this.ledger.updateStorage(storage.id, { position: storage.position, counts: container.items() });
          this._event('build.storage', { storage: storage.id, item, count });
          return { ok: true, from: storage.id, item, count };
        }
      }
    }
    return { ok: false, error: `no ${item} available to ${bot.name}` };
  }

  /** Round-robin cooperative execution, useful for scripts and the dashboard. */
  async run({ maxIterations = 200, onProgress = null } = {}) {
    let iterations = 0;
    const results = [];
    while (iterations < maxIterations) {
      if (this.cancelled || this.paused) break;
      const next = this.nextTask();
      if (!next) break;
      const bot = this.selectBot(next.task) || this.bots[iterations % Math.max(1, this.bots.length)];
      if (!bot) break;
      const result = await this.executeTask(bot, next.task.id);
      results.push(result);
      iterations++;
      if (onProgress) onProgress({ result, status: this.status() });
      if (!result.ok && !result.missingCount && result.failureCount) {
        // Make no-progress failures visible instead of looping forever.
        if (results.filter((r) => !r.ok).length >= 3) break;
      }
    }
    return { iterations, results, status: this.status() };
  }

  /** Re-read the world and report exactly which block states are missing/wrong. */
  verify({ includeExtras = false } = {}) {
    const audit = this.engine.verify({ includeExtras });
    return {
      buildId: this.id,
      total: audit.total,
      placed: audit.placed,
      missingCount: audit.missingCount,
      wrongCount: audit.wrongCount,
      extraCount: audit.extraCount,
      complete: audit.verified,
      percentComplete: audit.percentComplete,
      missing: audit.missing,
      wrong: audit.wrong,
      extras: audit.extras,
      stateExact: audit.stateExact,
      blockStatuses: this.engine.statusCounts(),
      versionCompatibility: this.engine.registry.describe()
    };
  }

  /** Repair missing/wrong blocks from a fresh diff, then re-audit. */
  async repair(bot, { includeExtras = false, allowExtraRemoval = false } = {}) {
    const worker = bot || this.bots[0];
    const result = await this.engine.repair(worker, {
      includeExtras,
      allowExtraRemoval,
      acquire: (target, item, count) => this._acquireMaterial(target, item, count)
    });
    if (result.repaired) {
      this.stats.repaired += result.repaired;
      this.finalAudit = null;
      this._event('build.repaired', { repaired: result.repaired, complete: result.complete });
    }
    return result;
  }

  /** Blueprint validity + placement evidence + independent world audit. */
  tripleCheck() { return this.engine.tripleCheck(); }

  /** Scan the built footprint for blocks that should not be there. */
  auditExtras() { return this.engine.auditExtras(); }

  status() {
    const analysis = this.analysis || this.analyze();
    const taskStats = { PENDING: 0, CLAIMED: 0, ACTIVE: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0, total: 0 };
    let placedBlocks = 0;
    if (this.taskBoard && this.tasks.length) {
      for (const t of this.tasks) {
        const task = this.taskBoard.getTask(t.taskId || t.id);
        if (!task) continue;
        taskStats[task.status] = (taskStats[task.status] || 0) + 1;
        taskStats.total++;
        if (task.status === 'COMPLETED') placedBlocks += task.units.target;
      }
    }
    const total = analysis.toPlace;
    const percent = total ? Math.round((placedBlocks / total) * 1000) / 10 : 100;
    let state = this.state;
    if (this.paused && state === 'RUNNING') state = 'PAUSED';
    if (state === 'RUNNING') {
      if (taskStats.COMPLETED === taskStats.total && taskStats.total > 0) {
        // Task completion proves each chunk was read back, but the build is
        // only COMPLETE after the independent blueprint + placement + world
        // audit also agrees. Cache it: status() is polled every two seconds.
        if (!this.finalAudit) this.finalAudit = this.engine.tripleCheck();
        state = this.finalAudit.ok ? 'COMPLETE' : 'FAILED';
      } else if (taskStats.FAILED > 0) state = 'FAILED';
    }
    this.state = state;
    return {
      buildId: this.id,
      finalAudit: this.finalAudit ? { ok: this.finalAudit.ok, sampledAt: this.finalAudit.sampledAt, blueprint: this.finalAudit.blueprint, placement: this.finalAudit.placement, audit: this.finalAudit.audit } : null,
      schematicId: this.schematic.id,
      name: this.schematic.name,
      tier: this.schematic.tier,
      state,
      origin: { ...this.origin },
      dimensions: analysis.dimensions,
      totalBlocks: analysis.totalBlocks,
      toPlace: total,
      alreadyBuilt: analysis.alreadyBuilt,
      placedBlocks,
      percentComplete: Math.min(100, percent),
      tasks: taskStats,
      conflicts: analysis.conflicts.length,
      blocked: analysis.blocked.length,
      clearance: analysis.clearance,
      missingMaterials: analysis.missingMaterials,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      stats: { ...this.stats },
      recentEvents: this.events.slice(-12)
    };
  }

  pause(reason = 'paused by operator') {
    if (this.state !== 'RUNNING') return { ok: false, error: `cannot pause a ${this.state} build` };
    this.paused = true;
    this._event('build.paused', { reason });
    return { ok: true, status: this.status() };
  }

  resume() {
    if (this.cancelled) return { ok: false, error: 'build was cancelled' };
    if (!this.paused && this.state === 'RUNNING') return { ok: false, error: 'build is not paused' };
    this.paused = false;
    this.state = 'RUNNING';
    this._event('build.resumed', {});
    return { ok: true, status: this.status() };
  }

  cancel(reason = 'cancelled') {
    this.cancelled = true;
    if (this.taskBoard) {
      for (const t of this.tasks) {
        const task = this.taskBoard.getTask(t.taskId || t.id);
        if (task && ['PENDING', 'CLAIMED', 'ACTIVE'].includes(task.status)) this.taskBoard.cancel(task.id, reason);
      }
    }
    this.state = 'CANCELLED';
    this._event('build.cancelled', { reason });
    return this.status();
  }

  _event(type, payload) {
    this.events.push({ at: Date.now(), type, ...payload });
    if (this.events.length > 200) this.events.shift();
  }
}

module.exports = { SchematicBuilder, DEFAULT_CHUNK_SIZE, phaseIndex };
