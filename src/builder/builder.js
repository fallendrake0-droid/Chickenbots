'use strict';

const { Logger } = require('../logger');
const { classifyBlock, isAir } = require('../excavate/safety');
const { PHASES } = require('../schematics/blockGrid');
const { distance, boxVolume } = require('../util/vec');

const DEFAULT_CHUNK_SIZE = 96;

function phaseIndex(name) {
  const idx = PHASES.indexOf(name);
  return idx === -1 ? 0 : idx;
}

function blockKey(pos) { return `${pos.x},${pos.y},${pos.z}`; }

function countMaterials(blocks) {
  const out = {};
  for (const b of blocks) out[b.block] = (out[b.block] || 0) + 1;
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
    this.startedAt = null;
    this.state = 'READY';
    this.cancelled = false;
    this.paused = false;
    this.events = [];
    this.stats = { placed: 0, cleared: 0, skipped: 0, transferred: 0, failedPlacements: 0 };
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
      const target = this.schematic.palette[paletteIndex];
      const pos = this.worldPos([x, y, z]);
      const current = this.world.getBlock(pos);
      const currentName = current ? current.name : 'air';
      if (currentName === target) {
        alreadyBuilt.push({ x: pos.x, y: pos.y, z: pos.z, block: target, phase: PHASES[phase] });
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
      toPlace.push({ x: pos.x, y: pos.y, z: pos.z, block: target, phase: PHASES[phase] || 'FOUNDATION' });
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
    for (const b of blocks) {
      const pos = { x: b.x, y: b.y, z: b.z };
      const current = this.world.getBlock(pos);
      if (current && current.name === b.block) { skipped++; continue; }
      // Reach the work face.
      let move = await bot.goTo({ x: pos.x, y: pos.y, z: pos.z }, { range: 4, timeoutMs: 10000 });
      if (move && move.ok === false) { failures.push({ pos, error: move.error || 'cannot reach block' }); continue; }
      if (current && current.name !== 'air' && current.name !== 'water') {
        const cls = classifyBlock(current.name, { preserveOres: this.preserveOres, authorized: this.authorized });
        if (!cls.excavatable) { failures.push({ pos, error: `blocked by ${current.name} (${cls.reason})` }); continue; }
        // Move adjacent before digging so reach rules hold.
        if (distance(bot.position, pos) > 5) {
          move = await bot.goTo({ x: pos.x, y: pos.y + 1, z: pos.z }, { range: 3, timeoutMs: 10000 });
        }
        const dig = await bot.digBlock(pos);
        if (!dig.ok) { failures.push({ pos, error: dig.error || 'dig failed' }); continue; }
        cleared++;
      }
      let have = bot.countItem(b.block);
      if (!have) {
        const transfer = await this._acquireMaterial(bot, b.block, 1);
        if (!transfer.ok) { failures.push({ pos, error: transfer.error || `missing ${b.block}` }); continue; }
      }
      let place = await bot.placeBlock(pos, b.block);
      if (!place.ok) {
        // Move one block closer and retry once.
        await bot.goTo({ x: pos.x, y: pos.y + 1, z: pos.z }, { range: 2, timeoutMs: 8000 });
        place = await bot.placeBlock(pos, b.block);
      }
      if (!place.ok) { failures.push({ pos, error: place.error || 'place failed' }); this.stats.failedPlacements++; continue; }
      placed++;
      this.stats.placed++;
    }
    if (cleared) this.stats.cleared += cleared;
    if (skipped) this.stats.skipped += skipped;
    this.taskBoard.updateProgress(task.id, { current: Math.min(blocks.length, placed + skipped), target: blocks.length });
    // Real verification: rescan the assigned block list.
    const missing = [];
    for (const b of blocks) {
      const current = this.world.getBlock({ x: b.x, y: b.y, z: b.z });
      if (!current || current.name !== b.block) missing.push({ x: b.x, y: b.y, z: b.z, expected: b.block, found: current ? current.name : 'air' });
    }
    if (this.ledger) {
      this.ledger.updateBotInventory(bot.name, bot.inventory);
      this.ledger.completeTransfer(`build:${this.id}:${task.id}`, missing.length === 0);
    }
    let complete = { ok: false };
    if (missing.length === 0) {
      complete = this.taskBoard.complete(task.id, { by: bot.name, verified: true, notes: `verified ${blocks.length} blocks` });
    } else {
      complete = this.taskBoard.fail(task.id, `${missing.length}/${blocks.length} blocks not placed`, { by: bot.name, retry: true });
    }
    this._event('build.task', { taskId: task.id, bot: bot.name, placed, cleared, skipped, missing: missing.length });
    return {
      ok: missing.length === 0, buildId: this.id, taskId: task.id, bot: bot.name,
      placed, cleared, skipped, missing: missing.slice(0, 25), missingCount: missing.length,
      failures: failures.slice(0, 25), failureCount: failures.length,
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

  /** Re-read the world and report exactly which blocks are missing. */
  verify() {
    const missing = [];
    const wrong = [];
    let placed = 0;
    for (const [x, y, z, paletteIndex] of this.schematic.blocks) {
      const target = this.schematic.palette[paletteIndex];
      const pos = this.worldPos([x, y, z]);
      const current = this.world.getBlock(pos);
      const name = current ? current.name : 'air';
      if (name === target) placed++;
      else if (name === 'air') missing.push({ x: pos.x, y: pos.y, z: pos.z, expected: target });
      else wrong.push({ x: pos.x, y: pos.y, z: pos.z, expected: target, found: name });
    }
    const total = this.schematic.blocks.length;
    return {
      buildId: this.id,
      total,
      placed,
      missingCount: missing.length,
      wrongCount: wrong.length,
      complete: missing.length === 0 && wrong.length === 0,
      percentComplete: Number(((placed / total) * 100).toFixed(2)),
      missing: missing.slice(0, 50),
      wrong: wrong.slice(0, 50)
    };
  }

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
      if (taskStats.COMPLETED === taskStats.total && taskStats.total > 0) state = 'COMPLETE';
      else if (taskStats.FAILED > 0) state = 'FAILED';
    }
    this.state = state;
    return {
      buildId: this.id,
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
