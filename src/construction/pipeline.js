'use strict';

const { projectBoundaries } = require('./siteSurvey');
const { inBounds } = require('./sitePreparer');
const { billOfMaterials, availableMaterials, materialStatus, buildAcquisitionPlan } = require('./materials');
const {
  findSpawnableSurfaces, planLighting, executeLighting, auditLighting, PREFERRED_SOURCES
} = require('./lighting');
const { BUILD_PHASES, STATUS, PHASE_STATUS } = require('./constants');

function nowIso() { return new Date().toISOString(); }

/**
 * Pipeline methods attached to ConstructionManager. Keeping the phase engine
 * separate from lifecycle/persistence makes each subsystem independently
 * testable and keeps the public manager surface small.
 */
function applyPipeline(proto) {
  const P = proto;

  P._execute = async function execute(project, phase, { maxActions = 400 } = {}) {
    this._beginPhase(project, phase);
    try {
      switch (phase.id) {
        case 'ANALYSIS': return await this._runAnalysis(project, phase);
        case 'SURVEY': return await this._runSurvey(project, phase);
        case 'SITE_SELECTION': return this._runSiteSelection(project, phase);
        case 'CLEARANCE': return await this._runClearance(project, phase, maxActions);
        case 'EXCAVATION': return await this._runExcavation(project, phase, maxActions);
        case 'LEVELLING': return await this._runLevelling(project, phase, maxActions);
        case 'DRAINAGE': return await this._runDrainage(project, phase, maxActions);
        case 'LIGHTING': return await this._runLighting(project, phase);
        case 'PERIMETER': return await this._runPerimeter(project, phase);
        case 'TEMPORARY_STORAGE': return await this._runTemporaryStorage(project, phase);
        case 'MATERIAL_CALCULATION': return this._runMaterialCalculation(project, phase);
        case 'GATHERING': return await this._runGathering(project, phase);
        case 'WAREHOUSE_STORAGE': return await this._runWarehouseStorage(project, phase);
        case 'BUILD_PLAN': return this._runBuildPlan(project, phase);
        case 'CONSTRUCTION': return await this._runConstruction(project, phase);
        case 'INTERIOR': return this._runInterior(project, phase);
        case 'SECURITY_AUDIT': return this._runSecurityAudit(project, phase);
        case 'QUALITY_VERIFICATION': return this._runQualityPhase(project, phase);
        case 'CLEANUP': return this._runCleanup(project, phase);
        default: return this._blockPhase(project, phase, `unknown phase ${phase.id}`);
      }
    } catch (err) {
      this.lastError = err.message;
      this.logger.error(`construction phase ${phase.id} failed: ${err.message}`);
      phase.status = PHASE_STATUS.FAILED;
      project.status = STATUS.BLOCKED;
      project.blockedReason = err.message;
      project.updatedAt = nowIso();
      this._save();
      return { ok: false, phase: phase.id, error: err.message };
    }
  };

  P._runAnalysis = async function runAnalysis(project, phase) {
    const builder = this._builderFor(project, { fresh: true });
    const analysis = builder.analyze({ refresh: true });
    project.dimensions = analysis.dimensions;
    project.materialRequirements = analysis.requiredMaterials;
    project.sitePreparation.boundaries = projectBoundaries({ origin: project.origin, width: project.dimensions.width, length: project.dimensions.length, margin: 6 });
    const detail = {
      blocks: analysis.totalBlocks, toPlace: analysis.toPlace, conflicts: analysis.conflicts.length,
      blocked: analysis.blocked.length, dimensions: analysis.dimensions,
      preliminary: analysis.blocked.length > 0 || analysis.conflicts.length > 0
    };
    // Analysis is preliminary: the survey/selection phases may move the site.
    this._completePhase(project, phase, detail);
    return { ok: true, phase: phase.id, detail };
  };

  P._runSurvey = async function runSurvey(project, phase) {
    await this._positionTeam(project.origin, 3);
    const result = this.surveyActive({ candidates: true });
    if (!result.ok) return this._blockPhase(project, phase, result.error || 'site survey failed');
    const detail = { samples: result.survey.samples, score: result.score.score, candidates: result.candidates.length, hazards: result.survey.hazards };
    if (result.survey.stats.unknown > 0) return this._blockPhase(project, phase, `${result.survey.stats.unknown} survey samples could not be read (unloaded chunks); move the team closer and re-survey`);
    if (!result.candidates.length) return this._blockPhase(project, phase, 'no candidate sites could be surveyed');
    this._completePhase(project, phase, detail);
    return { ok: true, phase: phase.id, detail, survey: result.survey, candidates: result.candidates };
  };

  P._runSiteSelection = function runSiteSelection(project, phase) {
    if (project.siteLocked && project.sitePreparation.selected) {
      this._completePhase(project, phase, project.sitePreparation.selected);
      return { ok: true, phase: phase.id, selected: project.sitePreparation.selected };
    }
    const result = this.selectSite();
    if (!result.ok) return this._blockPhase(project, phase, result.error);
    this._completePhase(project, phase, result.selected);
    return { ok: true, phase: phase.id, selected: result.selected, origin: result.origin };
  };

  P._clearRemaining = function clearRemaining(project) {
    return this.preparer.previewClearance(project.sitePreparation.boundaries.clearance).total;
  };

  P._runClearance = async function runClearance(project, phase, maxActions) {
    await this._positionTeam(project.origin, 4);
    const bounds = project.sitePreparation.boundaries.clearance;
    const result = await this.preparer.clearArea({ bounds, targetY: project.origin.y - 1, maxActions });
    project.sitePreparation.clearance = {
      ...(project.sitePreparation.clearance || {}),
      actions: (project.sitePreparation.clearance?.actions || 0) + result.actions,
      recovered: result.recovered, lastAt: nowIso()
    };
    if (result.unknown > 0) {
      return this._blockPhase(project, phase, `${result.unknown} clearance positions are in unloaded chunks; move the team closer and re-check before clearing`);
    }
    const remaining = this._clearRemaining(project);
    if (remaining > 0) {
      if (result.actions === 0) return this._blockPhase(project, phase, `${remaining} clearance blocks remain and no bot could reach/clear them`);
      phase.status = PHASE_STATUS.ACTIVE;
      phase.detail = { remaining, recovered: result.recovered };
      project.updatedAt = nowIso();
      this._save();
      return { ok: true, active: true, phase: phase.id, remaining, recovered: result.recovered };
    }
    this._completePhase(project, phase, { actions: project.sitePreparation.clearance.actions, recovered: result.recovered });
    return { ok: true, phase: phase.id, cleared: project.sitePreparation.clearance.actions, recovered: result.recovered };
  };

  P._excavationRemaining = function excavationRemaining(project) {
    const b = project.sitePreparation.boundaries.main;
    const depth = project.sitePreparation.excavationDepth || 2;
    const top = project.origin.y - 1;
    const bottom = project.origin.y - depth;
    let remaining = 0;
    for (let y = top; y >= bottom; y--) {
      for (let z = b.min.z; z <= b.max.z; z++) {
        for (let x = b.min.x; x <= b.max.x; x++) {
          const block = this._blockAt({ x, y, z });
          if (block && !['air', 'cave_air', 'water', 'lava', 'flowing_water', 'flowing_lava', 'unloaded'].includes(block.name) && !/_ore$/.test(block.name)) remaining++;
        }
      }
    }
    return remaining;
  };

  P._runExcavation = async function runExcavation(project, phase, maxActions) {
    await this._positionTeam(project.origin, 5);
    const b = project.sitePreparation.boundaries.main;
    const depth = project.sitePreparation.excavationDepth || 2;
    const result = await this.preparer.excavateBox({
      minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z,
      topY: project.origin.y - 1, bottomY: project.origin.y - depth, maxActions
    });
    if (result.hazards > 0) return this._blockPhase(project, phase, 'liquids observed in excavation box; stop and control hazards first');
    if (result.unknown > 0) return this._blockPhase(project, phase, `${result.unknown} excavation positions are in unloaded chunks; the hole cannot be verified yet`);
    project.sitePreparation.excavation = {
      ...(project.sitePreparation.excavation || {}),
      actions: (project.sitePreparation.excavation?.actions || 0) + result.actions,
      depth, preserved: result.preserved, lastAt: nowIso()
    };
    const remaining = this._excavationRemaining(project);
    if (remaining > 0) {
      if (result.actions === 0) return this._blockPhase(project, phase, `${remaining} non-excavatable blocks remain (bedrock/valuables); stop and reassess the foundation`);
      phase.status = PHASE_STATUS.ACTIVE;
      phase.detail = { remaining };
      project.updatedAt = nowIso();
      this._save();
      return { ok: true, active: true, phase: phase.id, remaining };
    }
    this._completePhase(project, phase, { actions: project.sitePreparation.excavation.actions, depth, preserved: result.preserved });
    return { ok: true, phase: phase.id, excavated: project.sitePreparation.excavation.actions, preserved: result.preserved };
  };

  P._levelRemaining = function levelRemaining(project) {
    const b = project.sitePreparation.boundaries.main;
    const target = project.origin.y - 1;
    let remaining = 0;
    for (let z = b.min.z; z <= b.max.z; z++) {
      for (let x = b.min.x; x <= b.max.x; x++) {
        let top = null;
        for (let y = target + 2; y >= target - 4; y--) {
          const block = this._blockAt({ x, y, z });
          if (block && !['air', 'cave_air', 'water', 'lava', 'flowing_water', 'flowing_lava', 'unloaded'].includes(block.name)) { top = y; break; }
        }
        if (top !== target) remaining++;
      }
    }
    return remaining;
  };

  P._runLevelling = async function runLevelling(project, phase, maxActions) {
    await this._positionTeam(project.origin, 5);
    const b = project.sitePreparation.boundaries.main;
    const target = project.origin.y - 1;
    const result = await this.preparer.levelFootprint({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z, targetY: target, maxActions });
    project.sitePreparation.levelling = {
      ...(project.sitePreparation.levelling || {}),
      actions: (project.sitePreparation.levelling?.actions || 0) + result.actions,
      cut: (project.sitePreparation.levelling?.cut || 0) + result.cut,
      filled: (project.sitePreparation.levelling?.filled || 0) + result.filled,
      targetY: target, lastAt: nowIso()
    };
    if (result.unknown > 0) return this._blockPhase(project, phase, `${result.unknown} levelling probes are in unloaded chunks; move the team closer before declaring the footprint level`);
    if (result.stoppedReason && result.stoppedReason !== 'action limit reached') {
      const remaining = this._levelRemaining(project);
      return this._blockPhase(project, phase, `levelling stopped (${result.stoppedReason}); ${remaining} columns are not level`);
    }
    const remaining = this._levelRemaining(project);
    if (remaining > 0) {
      if (result.actions === 0) return this._blockPhase(project, phase, `${remaining} columns are not level and cannot be cut/filled with current reach or materials`);
      phase.status = PHASE_STATUS.ACTIVE;
      phase.detail = { remaining };
      project.updatedAt = nowIso();
      this._save();
      return { ok: true, active: true, phase: phase.id, remaining };
    }
    this._completePhase(project, phase, { targetY: target, cut: project.sitePreparation.levelling.cut, filled: project.sitePreparation.levelling.filled });
    return { ok: true, phase: phase.id, level: target, cut: result.cut, filled: result.filled };
  };

  P._liquidsInFoundation = function liquidsInFoundation(project) {
    const b = project.sitePreparation.boundaries.main;
    const hazards = [];
    for (let y = project.origin.y - 1; y >= project.origin.y - 6; y--) {
      for (let z = b.min.z; z <= b.max.z; z++) {
        for (let x = b.min.x; x <= b.max.x; x++) {
          const block = this._blockAt({ x, y, z });
          if (block && ['water', 'flowing_water', 'lava', 'flowing_lava'].includes(block.name)) hazards.push({ x, y, z, block: block.name });
        }
      }
    }
    return hazards;
  };

  P._runDrainage = async function runDrainage(project, phase, maxActions) {
    const hazards = this._liquidsInFoundation(project);
    if (!hazards.length) { this._completePhase(project, phase, { hazards: 0 }); return { ok: true, phase: phase.id }; }
    if (hazards.some((hazard) => hazard.block.includes('lava'))) return this._blockPhase(project, phase, 'lava in the foundation requires containment/cooling; automatic draining refused');
    const b = project.sitePreparation.boundaries.main;
    const result = await this.preparer.drainFootprint({
      minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z,
      topY: project.origin.y - 1, bottomY: project.origin.y - 6, maxActions
    });
    if (result.unknown > 0) return this._blockPhase(project, phase, `${result.unknown} drainage probes are in unloaded chunks; liquid state is unknown`);
    if (result.stoppedReason && result.stoppedReason !== 'action limit reached') {
      return this._blockPhase(project, phase, `drainage stopped (${result.stoppedReason}); liquids remain in the foundation`);
    }
    const remaining = this._liquidsInFoundation(project);
    if (remaining.length) {
      if (result.actions === 0) return this._blockPhase(project, phase, `${remaining.length} liquid blocks remain and cannot be displaced safely`);
      phase.status = PHASE_STATUS.ACTIVE;
      phase.detail = { remaining: remaining.length };
      this._save();
      return { ok: true, active: true, phase: phase.id, remaining: remaining.length };
    }
    project.sitePreparation.drainage = { drained: (project.sitePreparation.drainage?.drained || 0) + result.drained, hazards: remaining.length, lastAt: nowIso() };
    this._completePhase(project, phase, { drained: project.sitePreparation.drainage.drained });
    return { ok: true, phase: phase.id, drained: result.drained };
  };

  P._runLighting = async function runLighting(project, phase) {
    await this._positionTeam(project.origin, 4);
    const boundaries = project.sitePreparation.boundaries;
    const construction = project.buildPhases.find((entry) => entry.id === 'CONSTRUCTION');
    const postBuild = construction && construction.status === PHASE_STATUS.COMPLETE;
    const surfaces = findSpawnableSurfaces({
      blockAt: (pos) => this._blockAt(pos), surfaceAt: (x, z) => this._surfaceAt(x, z),
      bounds: boundaries.work, maxSurfaces: 420
    }).filter((surface) => postBuild || !inBounds(surface, boundaries.main));
    const inventory = {};
    for (const bot of this.bots) for (const [item, count] of Object.entries(bot.inventory)) inventory[item] = (inventory[item] || 0) + count;
    const reserved = project.materialRequirements || {};
    const sourceCount = PREFERRED_SOURCES.reduce((sum, item) => sum + Math.max(0, Number(inventory[item] || 0) - Number(reserved[item] || 0)), 0);
    if (!sourceCount) return this._blockPhase(project, phase, 'no light sources available beyond reserved build materials; gather/craft torches before lighting', STATUS.AWAITING_MATERIALS);
    const plan = planLighting({ surfaces, inventory, reserved, blockAt: (pos) => this._blockAt(pos), maxLights: Math.min(300, Math.max(1, sourceCount)) });
    const executed = await executeLighting({ bots: this.bots, plan, blockAt: (pos) => this._blockAt(pos), maxPlacements: Math.min(300, Math.max(1, sourceCount)) });
    const observed = executed.results.filter((entry) => entry.ok).map((entry) => ({ pos: entry.placement.pos, item: entry.placement.item }));
    const audit = auditLighting({
      blockAt: (pos) => this._blockAt(pos), surfaceAt: (x, z) => this._surfaceAt(x, z),
      bounds: boundaries.work, lights: observed, maxSurfaces: 420
    });
    project.sitePreparation.lighting = {
      surfaces: surfaces.length, placements: executed.placed, failed: executed.failed,
      coverage: audit.coverage, uncovered: audit.uncovered.length, sourceCount, postBuild, lastAt: nowIso(), audit
    };
    project.lightingPlan = { ...plan, executed, audit };
    if (executed.failed > 0) return this._blockPhase(project, phase, `${executed.failed} light placements failed: ${executed.results.find((entry) => !entry.ok)?.error || 'unknown'}`);
    const gaps = audit.uncovered.filter((surface) => !inBounds(surface, boundaries.main) || postBuild);
    if (gaps.length) {
      if (executed.placed === 0) return this._blockPhase(project, phase, `${gaps.length} surfaces need light but no placement was possible`);
      phase.status = PHASE_STATUS.ACTIVE;
      phase.detail = { uncovered: gaps.length };
      this._save();
      return { ok: true, active: true, phase: phase.id, uncovered: gaps.length };
    }
    this._completePhase(project, phase, { placed: executed.placed, coverage: audit.coverage, surfaces: surfaces.length });
    return { ok: true, phase: phase.id, placed: executed.placed, coverage: audit.coverage, audit };
  };

  P._runPerimeter = async function runPerimeter(project, phase) {
    await this._positionTeam(project.origin, 5);
    const result = await this.preparer.buildPerimeter({ origin: project.origin, width: project.dimensions.width, length: project.dimensions.length, margin: 6, reserved: project.materialRequirements || {} });
    project.sitePreparation.perimeter = { placed: result.placed, requested: result.requested, gate: result.gate, skipped: result.skipped || 0, lastAt: nowIso() };
    if (!result.ok) return this._blockPhase(project, phase, `perimeter incomplete (${result.placed}/${result.requested}): ${result.results.find((entry) => !entry.ok)?.error || 'unknown'}`);
    this._completePhase(project, phase, project.sitePreparation.perimeter);
    return { ok: true, phase: phase.id, placed: result.placed };
  };

  P._runTemporaryStorage = async function runTemporaryStorage(project, phase) {
    await this._positionTeam(project.origin, 5);
    const b = project.sitePreparation.boundaries.storage;
    const ensured = await this.warehouse.ensureContainer({ bot: this.bots[0], anchor: b.anchor, category: 'surplus', label: 'construction-staging', reserved: project.materialRequirements || {} });
    if (!ensured.ok) return this._blockPhase(project, phase, `storage could not be established: ${ensured.error}`, STATUS.AWAITING_MATERIALS);
    await this.warehouse.labelContainer({ container: ensured.container, text: 'construction staging' });
    const scan = await this.warehouse.scan({ bot: this.bots[0], near: b.anchor, radius: 12, limit: 8 });
    project.sitePreparation.storage = { container: ensured.container.id, position: ensured.container.position, containers: scan.containers.length, lastAt: nowIso() };
    project.storage = project.sitePreparation.storage;
    this._completePhase(project, phase, project.sitePreparation.storage);
    return { ok: true, phase: phase.id, storage: project.sitePreparation.storage };
  };

  P._runMaterialCalculation = function runMaterialCalculation(project, phase) {
    const schematic = this._schematicFor(project);
    const bom = billOfMaterials(schematic);
    const available = availableMaterials({ bots: this.bots, ledger: this.ledger });
    const status = materialStatus(bom, available);
    project.materialRequirements = bom.materials;
    project.materialPlan = { ...status, acquisitionPlan: buildAcquisitionPlan(status), calculatedAt: nowIso() };
    this._completePhase(project, phase, { ready: status.ready, deficit: Object.keys(status.deficit).length, total: bom.totalBlocks });
    return { ok: true, phase: phase.id, materials: status, bom };
  };

  P._acquireItem = async function acquireItem(project, entry) {
    const option = (entry.options || []).find((candidate) => ['chop', 'craft', 'mine', 'gather', 'smelt'].includes(candidate.type));
    if (!option) return { ok: false, error: `no local acquisition route for ${entry.item}` };
    const actor = this.bots.find((bot) => bot.countItem(entry.item) > 0) || this.bots[0];
    if (!actor) return { ok: false, error: 'no bot for gathering' };
    if (option.type === 'craft') {
      const recipe = { planks: 'oak_planks', stick: 'stick', torch: 'torch', chest: 'chest', fence: 'oak_fence' }[option.recipe];
      if (!recipe) return { ok: false, error: `no craft recipe mapped for ${entry.item}` };
      const result = await actor.craft(recipe, Math.min(4, Math.max(1, Math.ceil(entry.missing / 4)))).catch((err) => ({ ok: false, error: err.message }));
      return { ...result, action: 'craft', item: entry.item };
    }
    const botActions = this.actions && typeof this.actions.get === 'function' ? this.actions.get(actor.name) : null;
    if (!botActions) return { ok: false, error: `${option.type} requires the action registry for ${entry.item}` };
    if (option.type === 'chop') return { ...(await botActions.performTask({ type: 'CHOP_WOOD' })), action: 'chop', item: entry.item };
    if (option.type === 'mine' || option.type === 'gather') return { ...(await botActions.performTask({ type: 'MINE_BLOCK', params: { block: option.block } })), action: option.type, item: entry.item };
    return { ok: false, error: `${option.type} is not implemented locally for ${entry.item}` };
  };

  P._runGathering = async function runGathering(project, phase) {
    const status = this.materials();
    if (!status.ok) return this._blockPhase(project, phase, status.error || 'material calculation failed');
    if (status.ready) { this._completePhase(project, phase, { deficit: 0 }); return { ok: true, phase: phase.id, ready: true }; }
    const actions = [];
    for (const entry of (status.acquisitionPlan || []).slice(0, 8)) {
      if (!this.bots.length) break;
      const result = await this._acquireItem(project, entry);
      actions.push({ item: entry.item, missing: entry.missing, ok: result.ok, action: result.action, collected: result.quantity || 0, error: result.error });
    }
    const refreshed = this.materials();
    if (!refreshed.ready) {
      project.materialPlan = { ...refreshed, lastGather: actions };
      return this._blockPhase(project, phase, `material deficit remains after gathering: ${Object.keys(refreshed.deficit).slice(0, 8).join(', ')}`, STATUS.AWAITING_MATERIALS);
    }
    this._completePhase(project, phase, { actions });
    return { ok: true, phase: phase.id, actions };
  };

  P._runWarehouseStorage = async function runWarehouseStorage(project, phase) {
    const container = this.warehouse.containers.size ? [...this.warehouse.containers.values()][0] : null;
    if (!container) return this._blockPhase(project, phase, 'no warehouse container available', STATUS.AWAITING_STORAGE);
    const transfers = [];
    for (const [item] of Object.entries(project.materialRequirements || {})) {
      const donor = this.bots.find((bot) => bot.countItem(item) > 0);
      if (!donor) continue;
      const move = Math.min(4, donor.countItem(item));
      const deposit = await this.warehouse.deposit({ item, count: move, bot: donor, container });
      transfers.push({ ...deposit, action: 'deposit' });
      if (!deposit.ok) continue;
      const retrieve = await this.warehouse.retrieve({ item, count: deposit.count, bot: donor, container });
      transfers.push({ ...retrieve, action: 'retrieve' });
      if (transfers.length >= 12) break;
    }
    if (!transfers.some((transfer) => transfer.ok)) return this._blockPhase(project, phase, 'warehouse deposits/retrievals could not be verified', STATUS.AWAITING_STORAGE);
    this.materials();
    this._completePhase(project, phase, { transfers: transfers.filter((entry) => entry.ok).length, container: container.id });
    return { ok: true, phase: phase.id, transfers };
  };

  P._runBuildPlan = function runBuildPlan(project, phase) {
    const builder = this._builderFor(project, { fresh: true });
    const analysis = builder.analyze({ refresh: true });
    project.dimensions = analysis.dimensions;
    if (analysis.blocked.length) return this._blockPhase(project, phase, `blocked blocks remain in footprint: ${analysis.blocked.slice(0, 5).map((entry) => entry.block).join(', ')}`);
    if (analysis.conflicts.length) return this._blockPhase(project, phase, `protected blocks in footprint (${analysis.conflicts.length}); explicit authorization required before build`);
    if (Object.keys(analysis.missingMaterials).length) {
      project.materialPlan = { ...(project.materialPlan || {}), ready: false, deficit: analysis.missingMaterials };
      return this._blockPhase(project, phase, `materials missing: ${Object.keys(analysis.missingMaterials).slice(0, 8).join(', ')}`, STATUS.AWAITING_MATERIALS);
    }
    const start = builder.start({ confirm: true });
    if (!start.ok) return this._blockPhase(project, phase, start.error || 'builder could not start', start.needsConfirmation ? STATUS.BLOCKED : STATUS.AWAITING_MATERIALS);
    project.startedAt = project.startedAt || nowIso();
    this._completePhase(project, phase, { builderId: builder.id, tasks: start.tasks, blocks: analysis.toPlace });
    return { ok: true, phase: phase.id, builderId: builder.id, tasks: start.tasks, analysis };
  };

  P._runConstruction = async function runConstruction(project, phase) {
    let builder = project.builderId ? this.builders.get(project.builderId) : null;
    if (!builder) {
      const plan = this._runBuildPlan(project, this._phase(project, 'BUILD_PLAN'));
      if (!plan.ok) return this._blockPhase(project, phase, plan.detail || plan.error || 'build plan failed');
      builder = this.builders.get(project.builderId);
    }
    if (!builder) return this._blockPhase(project, phase, 'builder could not be restored from the saved project');
    if (builder.state === 'COMPLETE') {
      this._completePhase(project, phase, builder.verify());
      return { ok: true, phase: phase.id, builder: 'COMPLETE' };
    }
    if (builder.state === 'PAUSED') builder.resume();
    const run = await builder.run({ maxIterations: 80 });
    const status = run.status;
    project.buildMilestones = BUILD_PHASES.map((milestone) => {
      if (!milestone.schematic) return { name: milestone.name, status: PHASE_STATUS.PENDING, progress: 0 };
      const tasks = builder.tasks.filter((task) => task.phase === milestone.schematic);
      if (!tasks.length) return { name: milestone.name, status: PHASE_STATUS.SKIPPED, progress: 100 };
      let done = 0;
      let total = 0;
      for (const task of tasks) {
        const boardTask = this.taskBoard.getTask(task.taskId || task.id);
        total += task.blocks.length;
        if (boardTask && boardTask.status === 'COMPLETED') done += task.blocks.length;
      }
      const progress = total ? Math.round((done / total) * 100) : 100;
      return { name: milestone.name, status: progress >= 100 ? PHASE_STATUS.COMPLETE : progress > 0 ? PHASE_STATUS.ACTIVE : PHASE_STATUS.PENDING, progress };
    });
    if (status.state === 'COMPLETE') {
      const verification = builder.verify();
      project.quality = { verification, complete: verification.complete, checkedAt: nowIso() };
      this._completePhase(project, phase, verification);
      return { ok: true, phase: phase.id, builder: 'COMPLETE', verification };
    }
    if (status.state === 'FAILED') return this._blockPhase(project, phase, `builder failed with ${status.tasks.FAILED} failed tasks`);
    phase.status = PHASE_STATUS.ACTIVE;
    phase.detail = { percent: status.percentComplete, tasks: status.tasks, builderState: status.state };
    project.updatedAt = nowIso();
    this._save();
    return { ok: true, active: true, phase: phase.id, builder: status.state, percent: status.percentComplete };
  };

  P._runInterior = function runInterior(project, phase) {
    const builder = project.builderId ? this.builders.get(project.builderId) : null;
    if (builder) {
      for (const group of ['INTERIOR', 'DECORATION']) {
        const tasks = builder.tasks.filter((task) => task.phase === group);
        if (tasks.length && tasks.some((task) => {
          const boardTask = this.taskBoard.getTask(task.taskId || task.id);
          return boardTask && boardTask.status !== 'COMPLETED';
        })) {
          phase.status = PHASE_STATUS.ACTIVE;
          phase.detail = { waitingFor: group };
          this._save();
          return { ok: true, active: true, phase: phase.id, waitingFor: group };
        }
      }
    }
    project.buildMilestones = project.buildMilestones.map((milestone) => ['INTERIOR_WALLS', 'FURNITURE', 'DECORATION', 'INTERIOR_LIGHTING'].includes(milestone.name) ? { ...milestone, status: PHASE_STATUS.COMPLETE, progress: 100 } : milestone);
    this._completePhase(project, phase, { interior: 'verified from builder task completion' });
    return { ok: true, phase: phase.id };
  };

  P._hostileSummary = function hostileSummary(project) {
    const counts = {};
    const threats = (this.coordinator && this.coordinator.threats) || [];
    for (const threat of threats) {
      if (!threat || !threat.position) continue;
      if (Math.abs(threat.position.x - project.origin.x) <= 48 && Math.abs(threat.position.z - project.origin.z) <= 48) {
        const name = threat.type || threat.name || 'hostile';
        counts[name] = (counts[name] || 0) + 1;
      }
    }
    return {
      count: Object.values(counts).reduce((sum, n) => sum + n, 0), counts,
      creeper: Object.keys(counts).some((name) => /creeper/i.test(name)),
      note: 'lighting does not stop spawners, raids, patrols or special mob rules'
    };
  };

  P._runSecurityAudit = function runSecurityAudit(project, phase) {
    const boundaries = project.sitePreparation.boundaries;
    const observed = [];
    if (project.lightingPlan && project.lightingPlan.executed) {
      for (const result of project.lightingPlan.executed.results || []) if (result.ok) observed.push({ pos: result.placement.pos, item: result.placement.item });
    }
    const audit = auditLighting({ blockAt: (pos) => this._blockAt(pos), surfaceAt: (x, z) => this._surfaceAt(x, z), bounds: boundaries.work, lights: observed, maxSurfaces: 500 });
    const hostile = this._hostileSummary(project);
    project.security = { lighting: audit, hostile, perimeter: project.sitePreparation.perimeter || null, checkedAt: nowIso() };
    if (audit.uncovered.length > 0) {
      const lighting = this._phase(project, 'LIGHTING');
      if (lighting.status === PHASE_STATUS.COMPLETE && !project.lightingRetryUsed) {
        lighting.status = PHASE_STATUS.PENDING;
        lighting.detail = { recheck: audit.uncovered.length };
        project.security.retriedLighting = true;
        project.lightingRetryUsed = true;
        phase.status = PHASE_STATUS.ACTIVE;
        project.updatedAt = nowIso();
        this._save();
        return { ok: true, active: true, phase: phase.id, uncovered: audit.uncovered.length };
      }
      return this._blockPhase(project, phase, `${audit.uncovered.length} spawnable surfaces remain unlit after a maintenance pass`);
    }
    this._completePhase(project, phase, { coverage: audit.coverage, hostile: hostile.count });
    return { ok: true, phase: phase.id, coverage: audit.coverage, hostile };
  };

  P._runQualityPhase = function runQualityPhase(project, phase) {
    const quality = this.quality();
    if (!quality.ok) return this._blockPhase(project, phase, quality.error || 'quality check failed');
    if (!quality.complete) {
      phase.status = PHASE_STATUS.ACTIVE;
      phase.detail = { missing: quality.verification.missingCount, wrong: quality.verification.wrongCount };
      this._save();
      return { ok: true, active: true, phase: phase.id, missing: quality.verification.missingCount };
    }
    this._completePhase(project, phase, { verification: quality.verification, structural: quality.structural });
    return { ok: true, phase: phase.id, complete: true, verification: quality.verification };
  };

  P._runCleanup = function runCleanup(project, phase) {
    const leftovers = [];
    for (const bot of this.bots) {
      const scaffolding = bot.countItem('scaffolding') || 0;
      if (scaffolding) leftovers.push({ bot: bot.name, scaffolding });
    }
    project.status = STATUS.COMPLETE;
    project.completedAt = nowIso();
    project.progress = 100;
    this._completePhase(project, phase, { leftovers });
    this.stats.completed++;
    this._save();
    return { ok: true, phase: phase.id, completed: true, leftovers };
  };

  // Explicit operator actions with confirmation gates.
  P.clear = async function clear({ confirm = false, maxActions = 400 } = {}) {
    if (!confirm) return { ok: false, error: 'clear requires confirmation', needsConfirmation: true, preview: this.preview() };
    return this.runPhase('CLEARANCE', { maxActions });
  };

  P.excavate = async function excavate({ confirm = false, maxActions = 800 } = {}) {
    if (!confirm) return { ok: false, error: 'excavate requires confirmation', needsConfirmation: true, preview: this.preview() };
    return this.runPhase('EXCAVATION', { maxActions });
  };

  P.flatten = async function flatten({ confirm = false, maxActions = 700 } = {}) {
    if (!confirm) return { ok: false, error: 'flatten requires confirmation', needsConfirmation: true, preview: this.preview() };
    return this.runPhase('LEVELLING', { maxActions });
  };

  P.light = async function light({ confirm = false } = {}) {
    if (!confirm) return { ok: false, error: 'lighting requires confirmation', needsConfirmation: true, preview: this.lightingPreview() };
    return this.runPhase('LIGHTING', { force: true });
  };

  P.drain = async function drain({ confirm = false, maxActions = 200 } = {}) {
    if (!confirm) return { ok: false, error: 'drainage requires confirmation', needsConfirmation: true, hazards: this._liquidsInFoundation(this.activeProject()) };
    return this.runPhase('DRAINAGE', { maxActions });
  };

  P.secure = async function secure({ confirm = false } = {}) {
    if (!confirm) return { ok: false, error: 'perimeter construction requires confirmation', needsConfirmation: true };
    return this.runPhase('PERIMETER');
  };

  P.gather = async function gather({ confirm = false } = {}) {
    if (!confirm) return { ok: false, error: 'resource gathering requires confirmation', needsConfirmation: true, preview: this.materials() };
    return this.runPhase('GATHERING');
  };

  P.assist = async function assist(botName) {
    const bot = this.bots.find((entry) => entry.name === botName);
    const project = this.activeProject();
    if (!bot || !project) return { ok: false, error: 'assist requires a live bot and an active project' };
    const builder = project.builderId ? this.builders.get(project.builderId) : null;
    const target = builder && builder.tasks.length ? builder.tasks.find((task) => task.blocks.length)?.blocks[0] : project.origin;
    const move = await bot.goTo(target, { range: 4, timeoutMs: 15000 });
    return { ok: move.ok !== false, bot: botName, target, result: move };
  };
}

module.exports = { applyPipeline };
