'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { Logger } = require('../logger');
const { SchematicBuilder } = require('../builder/builder');
const { SiteSurveyor, projectBoundaries } = require('./siteSurvey');
const { SitePreparer, inBounds } = require('./sitePreparer');
const {
  billOfMaterials, availableMaterials, materialStatus, buildAcquisitionPlan,
  phaseReadiness, reserveProjectMaterials
} = require('./materials');
const { findSpawnableSurfaces, planLighting, PREFERRED_SOURCES } = require('./lighting');
const { Warehouse } = require('./storage');
const {
  PIPELINE_PHASES, PIPELINE_LABELS, BUILD_PHASES, STATUS, INITIAL_ROLES, PHASE_STATUS,
  rotateSchematic, botWorldView
} = require('./constants');
const { applyPipeline } = require('./pipeline');

let projectSeq = 0;
function nowIso() { return new Date().toISOString(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sumValues(obj) { return Object.values(obj || {}).reduce((sum, n) => sum + Number(n || 0), 0); }

class ConstructionManager {
  constructor({
    library, bots = [], actions = null, world = null, taskBoard = null, ledger = null,
    memory = null, coordinator = null, builders = new Map(), logger = null, home = null,
    persistPath = path.join(config.paths.runtime, 'construction-projects.json'), now = () => Date.now(),
    maxProjects = 12
  } = {}) {
    if (!library) throw new Error('ConstructionManager requires the schematic library');
    this.library = library;
    this.bots = bots;
    this.actions = actions;
    this.world = world;
    this.taskBoard = taskBoard;
    this.ledger = ledger;
    this.memory = memory;
    this.coordinator = coordinator;
    this.builders = builders;
    this.logger = logger || new Logger({ level: 'warn' });
    this.home = home;
    this.persistPath = persistPath;
    this.now = now;
    this.maxProjects = maxProjects;
    this.projects = new Map();
    this.activeId = null;
    this.lastError = null;
    this.stats = { created: 0, advanced: 0, completed: 0, cancelled: 0, loads: 0, saves: 0, blocked: 0 };
    this._rotated = new Map();
    this.warehouse = new Warehouse({ bots, ledger, memory, logger: this.logger, now });
    this.preparer = new SitePreparer({ bots, world: this._world(), ledger, memory, logger: this.logger });
    this.surveyor = new SiteSurveyor({
      bot: bots[0] || null,
      blockAt: (pos) => this._blockAt(pos),
      surfaceAt: (x, z) => this._surfaceAt(x, z),
      now
    });
    this.load();
  }

  _world() {
    if (this.world) return this.world;
    const bot = this.bots.find((candidate) => typeof candidate.getBlock === 'function');
    return botWorldView(bot);
  }

  _blockAt(pos) {
    const world = this._world();
    return world ? world.getBlock(pos) : null;
  }

  _surfaceAt(x, z) {
    const world = this._world();
    return world ? Math.floor(world.surfaceY(x, z)) : Math.floor(this.bots[0]?.position.y || 64) - 1;
  }

  _schematicFor(project) {
    const key = `${project.schematicId}:${project.rotation || 0}`;
    if (this._rotated.has(key)) return this._rotated.get(key);
    const base = this.library.build(project.schematicId);
    if (!base) return null;
    const rotated = rotateSchematic(base, project.rotation || 0);
    this._rotated.set(key, rotated);
    return rotated;
  }

  // ------------------------------------------------------------------
  // Project lifecycle
  // ------------------------------------------------------------------
  createProject({ schematicId, origin = null, rotation = 0, name = null, priority = 50, budgetBlocks = null, excavationDepth = 2 } = {}) {
    const design = this.library.get(schematicId) || this.library.get(String(schematicId || '').split(':')[0]);
    if (!design) return { ok: false, error: `unknown schematic: ${schematicId}` };
    if (this.projects.size >= this.maxProjects) {
      // The limit is for concurrent work, not lifetime work: retire the oldest
      // finished project before refusing a new one.
      const terminal = [...this.projects.values()]
        .filter((project) => [STATUS.COMPLETE, STATUS.CANCELLED].includes(project.status))
        .sort((a, b) => String(a.completedAt || a.createdAt).localeCompare(String(b.completedAt || b.createdAt)));
      while (this.projects.size >= this.maxProjects && terminal.length) {
        const old = terminal.shift();
        this.projects.delete(old.id);
        if (this.activeId === old.id) this.activeId = null;
      }
    }
    if (this.projects.size >= this.maxProjects) return { ok: false, error: `project limit reached (${this.maxProjects}); complete or cancel an old project` };
    const schematic = this.library.build(design.id);
    if (!schematic) return { ok: false, error: `cannot build schematic data for ${design.id}` };
    const rotated = rotateSchematic(schematic, rotation);
    const home = this.home || (this.bots[0] ? this.bots[0].position : { x: 0, y: 64, z: 0 });
    const requested = origin && Number.isFinite(origin.x) && Number.isFinite(origin.z)
      ? { x: Math.floor(origin.x), y: Number.isFinite(origin.y) ? Math.floor(origin.y) : null, z: Math.floor(origin.z) }
      : null;
    const provisional = requested
      ? { ...requested, y: requested.y === null ? this._surfaceAt(requested.x, requested.z) + 1 : requested.y }
      : { x: Math.floor(home.x) + 14, y: Math.floor(home.y) + 1, z: Math.floor(home.z) + 14 };
    const id = `project-${String(++projectSeq).padStart(3, '0')}-${String(design.id).replace(/[^a-z0-9_-]/gi, '').slice(0, 32)}`;
    const phases = PIPELINE_PHASES.map((phase) => ({ id: phase, name: PIPELINE_LABELS[phase], status: PHASE_STATUS.PENDING, startedAt: null, completedAt: null, attempts: 0, detail: null }));
    const project = {
      id, name: name || design.name,
      schematic: design.id, schematicId: design.id, schematicName: design.name,
      category: design.category, tier: design.tier,
      status: STATUS.PLANNING,
      origin: provisional, requestedOrigin: requested, siteLocked: Boolean(requested),
      rotation: ((Number(rotation) % 360) + 360) % 360,
      dimensions: rotated.dimensions,
      teamAssignments: clone(INITIAL_ROLES),
      materialRequirements: {},
      sitePreparation: {
        surveyed: false, survey: null, candidates: [], boundaries: null, excavationDepth,
        clearance: null, excavation: null, levelling: null, lighting: null, perimeter: null, storage: null
      },
      buildPhases: phases,
      buildMilestones: BUILD_PHASES.map((phase) => ({ name: phase.name, status: PHASE_STATUS.PENDING, progress: 0 })),
      progress: 0,
      priority,
      budget: { blocks: budgetBlocks || sumValues(design.materials), spent: 0 },
      createdAt: nowIso(), updatedAt: nowIso(), startedAt: null, completedAt: null,
      paused: false, autonomyEnabled: false, builderId: null, materialPlan: null, storage: null,
      lightingPlan: null, security: null, quality: null,
      history: [{ at: nowIso(), event: 'created', schematic: design.id, origin: provisional }]
    };
    this.projects.set(id, project);
    if (!this.activeId) this.setActive(id);
    this.stats.created++;
    this._save();
    return { ok: true, project: this.summary(project), id };
  }

  getProject(id = null) {
    if (!id) return this.projects.get(this.activeId) || null;
    return this.projects.get(id) || [...this.projects.values()].find((project) => project.id.startsWith(id)) || null;
  }

  activeProject() { return this.getProject(this.activeId); }

  setActive(id) {
    const project = this.getProject(id);
    if (!project) return { ok: false, error: `unknown project ${id}` };
    if (project.status === STATUS.CANCELLED) return { ok: false, error: 'cancelled project cannot be activated' };
    this.activeId = project.id;
    project.updatedAt = nowIso();
    this._save();
    return { ok: true, project: this.summary(project) };
  }

  list({ status = null } = {}) {
    return [...this.projects.values()]
      .filter((project) => !status || project.status === status)
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
      .map((project) => this.summary(project));
  }

  summary(project) {
    if (!project) return null;
    const phase = project.buildPhases.find((entry) => entry.status !== PHASE_STATUS.COMPLETE && entry.status !== PHASE_STATUS.SKIPPED);
    return {
      id: project.id, name: project.name, schematicId: project.schematicId, schematicName: project.schematicName,
      tier: project.tier, category: project.category, status: project.status, active: project.id === this.activeId,
      origin: { ...project.origin }, rotation: project.rotation, dimensions: { ...project.dimensions },
      priority: project.priority, progress: project.progress, createdAt: project.createdAt,
      updatedAt: project.updatedAt, completedAt: project.completedAt,
      phases: project.buildPhases.map((entry) => ({ id: entry.id, name: entry.name, status: entry.status })),
      assignments: clone(project.teamAssignments), materialsReady: project.materialPlan ? project.materialPlan.ready : false,
      phase: phase ? phase.id : 'COMPLETE', blockedReason: project.blockedReason || null
    };
  }

  pause({ reason = 'paused by operator' } = {}) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    project.paused = true;
    project.status = STATUS.PAUSED;
    for (const builder of this._projectBuilders(project)) builder.pause();
    project.history.push({ at: nowIso(), event: 'paused', reason });
    this._save();
    return { ok: true, project: this.summary(project) };
  }

  resume() {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    if ([STATUS.CANCELLED, STATUS.COMPLETE].includes(project.status)) return { ok: false, error: `project is ${project.status}` };
    project.paused = false;
    // A material/storage stop leaves the active phase BLOCKED. Once the operator
    // has restocked, resume must make that phase runnable again rather than
    // silently skipping it.
    if ([STATUS.AWAITING_MATERIALS, STATUS.AWAITING_STORAGE, STATUS.BLOCKED].includes(project.status)) {
      const blocked = project.buildPhases.find((phase) => phase.status === PHASE_STATUS.BLOCKED);
      if (blocked) blocked.status = PHASE_STATUS.PENDING;
      project.blockedReason = null;
    }
    project.status = this._statusForPhase(project);
    for (const builder of this._projectBuilders(project)) if (builder.state === 'PAUSED') builder.resume();
    project.history.push({ at: nowIso(), event: 'resumed' });
    this._save();
    return { ok: true, project: this.summary(project) };
  }

  cancel({ reason = 'cancelled by operator' } = {}) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    project.status = STATUS.CANCELLED;
    project.paused = true;
    project.completedAt = nowIso();
    for (const builder of this._projectBuilders(project)) builder.cancel(reason);
    project.history.push({ at: nowIso(), event: 'cancelled', reason });
    this.stats.cancelled++;
    this._save();
    return { ok: true, project: this.summary(project) };
  }

  setPriority(id, priority) {
    const project = this.getProject(id);
    if (!project) return { ok: false, error: `unknown project ${id}` };
    project.priority = Math.max(0, Math.min(100, Number(priority) || 0));
    this._save();
    return { ok: true, project: this.summary(project) };
  }

  assign({ bot, role, phase = null } = {}) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    if (!bot) return { ok: false, error: 'assign requires a bot name' };
    project.teamAssignments[bot] = { role: role || 'FLEXIBLE', phase, assignedAt: nowIso() };
    if (this.coordinator && typeof this.coordinator.setRole === 'function') this.coordinator.setRole(bot, role);
    project.history.push({ at: nowIso(), event: 'assignment', bot, role, phase });
    this._save();
    return { ok: true, assignments: clone(project.teamAssignments) };
  }

  _statusForPhase(project) {
    const phase = project.buildPhases.find((entry) => entry.status !== PHASE_STATUS.COMPLETE && entry.status !== PHASE_STATUS.SKIPPED);
    if (!phase) return STATUS.COMPLETE;
    if (['QUALITY_VERIFICATION', 'SECURITY_AUDIT'].includes(phase.id)) return STATUS.AUDITING;
    if (['CONSTRUCTION', 'INTERIOR', 'BUILD_PLAN'].includes(phase.id)) return STATUS.BUILDING;
    return STATUS.PREPARING;
  }

  _projectBuilders(project) {
    return [...this.builders.values()].filter((builder) => builder.id && builder.id.startsWith(project.id));
  }

  _builderFor(project, { fresh = false } = {}) {
    const world = this._world();
    if (!world) throw new Error('no world or bot available for construction');
    const schematic = this._schematicFor(project);
    if (!schematic) throw new Error(`schematic data missing for ${project.schematicId}`);
    if (!fresh && project.builderId && this.builders.has(project.builderId)) return this.builders.get(project.builderId);
    const buildId = project.builderId || `${project.id}:build`;
    const builder = new SchematicBuilder({
      schematic, origin: project.origin, world, bots: this.bots,
      taskBoard: this.taskBoard, ledger: this.ledger, memory: this.memory, logger: this.logger,
      authorized: Boolean(project.sitePreparation && project.sitePreparation.authorized),
      preserveOres: true, buildId
    });
    this.builders.set(buildId, builder);
    project.builderId = buildId;
    return builder;
  }

  _positionTeam(origin, radius = 3) {
    return Promise.all(this.bots.map((bot, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, this.bots.length);
      const target = { x: Math.floor(origin.x + Math.cos(angle) * radius), y: Math.floor(origin.y) + 1, z: Math.floor(origin.z + Math.sin(angle) * radius) };
      return bot.goTo(target, { range: 3, timeoutMs: 12000 }).catch((err) => ({ ok: false, error: err.message }));
    }));
  }

  // ------------------------------------------------------------------
  // Survey and site selection
  // ------------------------------------------------------------------
  surveyActive({ candidates = true, radius = 64 } = {}) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    const dims = project.dimensions;
    this.surveyor = new SiteSurveyor({ blockAt: (pos) => this._blockAt(pos), surfaceAt: (x, z) => this._surfaceAt(x, z), now: this.now });
    const centered = project.requestedOrigin || project.origin;
    const survey = this.surveyor.survey({ origin: centered, width: dims.width, length: dims.length, margin: 5, sampleLimit: 1600 });
    if (!survey.ok) return survey;
    const score = this.surveyor.score(survey, { home: this.home });
    let ranked = [];
    if (candidates) {
      const result = this.surveyor.candidates({
        home: this.home || centered, origin: project.siteLocked ? centered : null,
        width: dims.width, length: dims.length, radius, count: project.siteLocked ? 1 : 6
      });
      ranked = result.candidates || [];
      for (const candidate of ranked) {
        candidate.overlaps = this._overlappingProjects(candidate.survey);
        candidate.score = candidate.overlaps.length ? Math.max(0, candidate.score - 40) : candidate.score;
        if (candidate.overlaps.length) candidate.reasons = [...(candidate.reasons || []), 'overlaps an existing project'];
      }
      ranked.sort((a, b) => b.score - a.score);
    }
    project.sitePreparation.surveyed = true;
    project.sitePreparation.survey = survey;
    project.sitePreparation.score = score;
    project.sitePreparation.candidates = ranked;
    project.sitePreparation.boundaries = project.sitePreparation.boundaries || projectBoundaries({ origin: project.origin, width: dims.width, length: dims.length, margin: 6 });
    project.updatedAt = nowIso();
    this._save();
    return { ok: true, survey, score, candidates: ranked, recommended: ranked.find((candidate) => !candidate.overlaps.length) || ranked[0] || null };
  }

  surveyCandidates(options = {}) { return this.surveyActive({ candidates: true, ...options }); }

  _overlappingProjects(survey) {
    const a = survey.origin;
    const aw = survey.footprint ? survey.footprint.width : (survey.dimensions?.width || 1);
    const al = survey.footprint ? survey.footprint.length : (survey.dimensions?.length || 1);
    const others = [];
    for (const other of this.projects.values()) {
      if (other.id === this.activeId || [STATUS.CANCELLED, STATUS.COMPLETE].includes(other.status)) continue;
      const b = other.origin;
      const bw = other.dimensions.width;
      const bl = other.dimensions.length;
      if (a.x <= b.x + bw + 4 && a.x + aw + 4 >= b.x && a.z <= b.z + bl + 4 && a.z + al + 4 >= b.z) others.push(other.id);
    }
    return others;
  }

  selectSite({ origin = null, candidateId = null } = {}) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    let chosen = null;
    if (candidateId) chosen = (project.sitePreparation.candidates || []).find((candidate) => candidate.id === candidateId);
    else if (origin) {
      const survey = this.surveyor.survey({ origin, width: project.dimensions.width, length: project.dimensions.length, margin: 5 });
      const score = this.surveyor.score(survey, { home: this.home });
      chosen = { id: 'manual', origin: survey.origin, survey, score: score.score, factors: score.factors, reasons: score.reasons };
    } else {
      chosen = (project.sitePreparation.candidates || []).find((candidate) => !candidate.overlaps.length) || (project.sitePreparation.candidates || [])[0];
    }
    if (!chosen) return { ok: false, error: 'no surveyed site available; run site survey first' };
    const overlaps = this._overlappingProjects(chosen.survey || { origin: chosen.origin, dimensions: project.dimensions });
    if (overlaps.length) return { ok: false, error: `site overlaps active project(s): ${overlaps.join(', ')}` };
    if (chosen.survey && chosen.survey.hazards && chosen.survey.hazards.lava) return { ok: false, error: 'site has observed lava; choose another candidate or treat the hazard first' };
    project.origin = { x: Math.floor(chosen.origin.x), y: Math.floor(chosen.origin.y), z: Math.floor(chosen.origin.z) };
    project.siteLocked = true;
    project.sitePreparation.selected = { id: chosen.id, score: chosen.score, factors: chosen.factors || null, reasons: chosen.reasons || [] };
    project.sitePreparation.survey = chosen.survey || project.sitePreparation.survey;
    project.sitePreparation.boundaries = projectBoundaries({ origin: project.origin, width: project.dimensions.width, length: project.dimensions.length, margin: 6 });
    project.history.push({ at: nowIso(), event: 'site-selected', origin: project.origin, score: chosen.score });
    project.updatedAt = nowIso();
    this._save();
    return { ok: true, project: this.summary(project), origin: project.origin, selected: project.sitePreparation.selected, boundaries: project.sitePreparation.boundaries };
  }

  boundaries(id = null) {
    const project = this.getProject(id);
    if (!project) return { ok: false, error: 'unknown project' };
    if (!project.sitePreparation.boundaries) {
      project.sitePreparation.boundaries = projectBoundaries({ origin: project.origin, width: project.dimensions.width, length: project.dimensions.length, margin: 6 });
    }
    return { ok: true, boundaries: clone(project.sitePreparation.boundaries) };
  }

  // ------------------------------------------------------------------
  // Previews and materials (no world mutation except registry updates)
  // ------------------------------------------------------------------
  preview() {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    const builder = this._builderFor(project);
    const analysis = builder.analyze({ refresh: true });
    const survey = project.sitePreparation.survey;
    const bom = billOfMaterials(this._schematicFor(project));
    const available = availableMaterials({ bots: this.bots, ledger: this.ledger });
    const materials = materialStatus(bom, available);
    const boundaries = project.sitePreparation.boundaries || projectBoundaries({ origin: project.origin, width: project.dimensions.width, length: project.dimensions.length, margin: 6 });
    const prep = this.preparer.previewClearance(boundaries.clearance);
    return {
      ok: true, project: this.summary(project), analysis,
      survey: survey ? { origin: survey.origin, stats: survey.stats, hazards: survey.hazards } : null,
      boundaries, clearance: prep,
      materials: { ready: materials.ready, deficit: materials.deficit, requirements: materials.requirements },
      buildTasks: builder.planTasks({ refresh: true }).tasks.length
    };
  }

  materials() {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    const schematic = this._schematicFor(project);
    const bom = billOfMaterials(schematic);
    const available = availableMaterials({ bots: this.bots, ledger: this.ledger });
    const status = materialStatus(bom, available);
    const plan = buildAcquisitionPlan(status);
    const readiness = phaseReadiness(schematic, available);
    project.materialRequirements = bom.materials;
    project.materialPlan = { ...status, acquisitionPlan: plan, readiness, calculatedAt: nowIso() };
    this._save();
    return { ok: true, project: project.id, bom, available, ...status, acquisitionPlan: plan, phaseReadiness: readiness, storage: this.warehouse.capacity() };
  }

  phaseReadiness() {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    const available = availableMaterials({ bots: this.bots, ledger: this.ledger });
    const readiness = phaseReadiness(this._schematicFor(project), available);
    return { ok: true, phases: readiness };
  }

  lightingPreview({ includeUnderground = false } = {}) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    const boundaries = project.sitePreparation.boundaries || projectBoundaries({ origin: project.origin, width: project.dimensions.width, length: project.dimensions.length, margin: 6 });
    const surfaces = findSpawnableSurfaces({
      blockAt: (pos) => this._blockAt(pos), surfaceAt: (x, z) => this._surfaceAt(x, z),
      bounds: boundaries.work, maxSurfaces: 500, includeUnderground
    }).filter((surface) => !inBounds(surface, boundaries.main));
    const inventory = {};
    for (const bot of this.bots) for (const [item, count] of Object.entries(bot.inventory)) inventory[item] = (inventory[item] || 0) + count;
    const reserved = project.materialRequirements || {};
    const sourceCount = PREFERRED_SOURCES.reduce((sum, item) => sum + Math.max(0, Number(inventory[item] || 0) - Number(reserved[item] || 0)), 0);
    const plan = planLighting({ surfaces, inventory, reserved, blockAt: (pos) => this._blockAt(pos), maxLights: Math.max(0, Math.min(300, sourceCount)) });
    project.lightingPlan = { ...plan, previewAt: nowIso(), inventory };
    this._save();
    return { ok: true, plan, surfaces: surfaces.length, inventory };
  }

  quality() {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    let builder = project.builderId ? this.builders.get(project.builderId) : null;
    if (!builder) {
      try { builder = this._builderFor(project); } catch (err) { return { ok: false, error: err.message }; }
    }
    const verification = builder.verify();
    const analysis = builder.analyze({ refresh: true });
    const structural = this._structuralQA(project, builder);
    const quality = {
      verification,
      analysis: { blocked: analysis.blocked.length, conflicts: analysis.conflicts.length, undergroundRatio: analysis.undergroundRatio },
      structural,
      complete: verification.complete && structural.ok,
      checkedAt: nowIso()
    };
    project.quality = quality;
    this._save();
    return { ok: true, ...quality };
  }

  _structuralQA(project, builder) {
    const schematic = builder.schematic;
    const missing = builder.verify().missingCount;
    const paletteExpected = new Set(schematic.palette);
    const observed = {};
    for (const [x, y, z] of schematic.blocks) {
      const pos = { x: project.origin.x + x, y: project.origin.y + y, z: project.origin.z + z };
      const block = this._blockAt(pos);
      observed[block ? block.name : 'air'] = (observed[block ? block.name : 'air'] || 0) + 1;
    }
    const wrongPalette = Object.entries(observed).filter(([name]) => name !== 'air' && !paletteExpected.has(name));
    return {
      ok: missing === 0 && wrongPalette.length === 0,
      missing, dimensions: project.dimensions,
      expectedPalette: [...paletteExpected].sort(), observedPalette: Object.keys(observed).sort(),
      wrongPalette: wrongPalette.map(([name, count]) => ({ name, count })),
      checks: { dimensions: true, palette: wrongPalette.length === 0, alignment: missing === 0, reach: true, roof: null, symmetry: null, doors: null, stairs: null }
    };
  }

  // ------------------------------------------------------------------
  // Phase engine shell (implementations in pipeline.js)
  // ------------------------------------------------------------------
  _phase(project, id) {
    const phase = project.buildPhases.find((entry) => entry.id === id);
    if (!phase) throw new Error(`unknown phase ${id}`);
    return phase;
  }

  _beginPhase(project, phase) {
    phase.status = PHASE_STATUS.ACTIVE;
    phase.startedAt = phase.startedAt || nowIso();
    phase.attempts++;
    project.status = this._statusForPhase(project);
    project.updatedAt = nowIso();
    project.history.push({ at: nowIso(), event: 'phase-start', phase: phase.id, attempt: phase.attempts });
  }

  _completePhase(project, phase, detail = null) {
    phase.status = PHASE_STATUS.COMPLETE;
    phase.completedAt = nowIso();
    phase.detail = detail;
    project.updatedAt = nowIso();
    project.history.push({ at: nowIso(), event: 'phase-complete', phase: phase.id, detail });
    this._recomputeProgress(project);
    this._save();
  }

  _blockPhase(project, phase, detail, status = STATUS.BLOCKED) {
    phase.status = PHASE_STATUS.BLOCKED;
    phase.detail = detail;
    project.status = status;
    project.blockedReason = detail;
    project.updatedAt = nowIso();
    project.history.push({ at: nowIso(), event: 'phase-blocked', phase: phase.id, detail });
    this.stats.blocked++;
    this._save();
    return { ok: false, blocked: true, phase: phase.id, detail };
  }

  _recomputeProgress(project) {
    const done = project.buildPhases.filter((phase) => phase.status === PHASE_STATUS.COMPLETE || phase.status === PHASE_STATUS.SKIPPED).length;
    project.progress = Math.round((done / project.buildPhases.length) * 1000) / 10;
    project.buildMilestones.forEach((milestone) => {
      const phase = project.buildPhases.find((entry) => entry.id === milestone.name || (milestone.name === 'FINAL_QA' && entry.id === 'QUALITY_VERIFICATION'));
      if (phase) {
        milestone.status = phase.status;
        milestone.progress = phase.status === PHASE_STATUS.COMPLETE ? 100 : 0;
      }
    });
  }

  async runPhase(id, options = {}) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    const phase = this._phase(project, String(id).toUpperCase());
    if (phase.status === PHASE_STATUS.COMPLETE && !options.force) return { ok: true, already: true, phase: phase.id, detail: phase.detail };
    return this._execute(project, phase, options);
  }

  async advance({ maxPhases = 1, maxActions = 400 } = {}) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    if (project.paused || project.status === STATUS.PAUSED) return { ok: false, error: 'project is paused', project: this.summary(project) };
    if ([STATUS.COMPLETE, STATUS.CANCELLED].includes(project.status)) return { ok: true, done: true, project: this.summary(project) };
    if ([STATUS.BLOCKED, STATUS.AWAITING_MATERIALS, STATUS.AWAITING_STORAGE].includes(project.status)) return { ok: false, error: project.blockedReason || `project is ${project.status}`, project: this.summary(project) };
    const results = [];
    for (let i = 0; i < Math.max(1, maxPhases); i++) {
      const phase = project.buildPhases.find((entry) => entry.status !== PHASE_STATUS.COMPLETE && entry.status !== PHASE_STATUS.SKIPPED);
      if (!phase) {
        project.status = STATUS.COMPLETE;
        project.completedAt = project.completedAt || nowIso();
        this.stats.completed++;
        this._save();
        break;
      }
      if ([PHASE_STATUS.BLOCKED, PHASE_STATUS.FAILED].includes(phase.status)) break;
      const result = await this._execute(project, phase, { maxActions });
      results.push(result);
      this.stats.advanced++;
      if (!result.ok || result.active) break;
      if (phase.id === 'CONSTRUCTION' && result.builder && result.builder !== 'COMPLETE') break;
    }
    return { ok: results.every((result) => result.ok !== false), project: this.summary(project), results, done: project.status === STATUS.COMPLETE };
  }

  async run({ maxPhases = PIPELINE_PHASES.length * 4, maxActions = 400 } = {}) {
    const results = [];
    let guard = 0;
    while (guard++ < maxPhases) {
      const result = await this.advance({ maxPhases: 1, maxActions });
      results.push(result);
      if (!result.ok || result.done) break;
      const project = this.activeProject();
      if (!project || project.paused || [STATUS.BLOCKED, STATUS.AWAITING_MATERIALS, STATUS.AWAITING_STORAGE, STATUS.CANCELLED, STATUS.COMPLETE].includes(project.status)) break;
    }
    return { ok: results.every((result) => result.ok !== false), results, project: this.summary(this.activeProject()), done: this.activeProject()?.status === STATUS.COMPLETE };
  }

  async autoAdvance() {
    const project = this.activeProject();
    if (!project || project.paused || [STATUS.COMPLETE, STATUS.CANCELLED, STATUS.BLOCKED, STATUS.AWAITING_MATERIALS, STATUS.AWAITING_STORAGE].includes(project.status)) return { ok: false, skipped: true };
    // Autonomous world changes only after an operator explicitly armed this
    // project (or ran it with confirm).
    if (!project.autonomyEnabled) return { ok: false, skipped: true, reason: 'project not armed for autonomous execution' };
    if (project.status === STATUS.PAUSED) return { ok: false, skipped: true };
    return this.advance({ maxPhases: 1 });
  }

  setAutonomy(enabled) {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    project.autonomyEnabled = Boolean(enabled);
    project.updatedAt = nowIso();
    this._save();
    return { ok: true, project: this.summary(project), autonomyEnabled: project.autonomyEnabled };
  }

  // ------------------------------------------------------------------
  // Storage and reporting
  // ------------------------------------------------------------------
  state() {
    const project = this.activeProject();
    return {
      activeId: this.activeId, projects: this.list(),
      active: project ? this.projectDetail(project) : null,
      warehouse: this.warehouse.state(), stats: { ...this.stats }, lastError: this.lastError,
      persisted: this.persistPath, phases: PIPELINE_PHASES,
      buildPhases: BUILD_PHASES.map((phase) => phase.name)
    };
  }

  projectDetail(project) {
    if (!project) return null;
    const detail = clone(project);
    // Keep the dashboard/API snapshot bounded: the full height map stays in
    // the persisted project and is available from the survey subsystem.
    if (detail.sitePreparation && detail.sitePreparation.survey) {
      const survey = detail.sitePreparation.survey;
      detail.sitePreparation.survey = {
        origin: survey.origin, footprint: survey.footprint, samples: survey.samples,
        stats: survey.stats, hazards: survey.hazards, ores: (survey.ores || []).slice(0, 20)
      };
    }
    if (Array.isArray(detail.sitePreparation?.candidates)) {
      detail.sitePreparation.candidates = detail.sitePreparation.candidates.map((candidate) => ({
        id: candidate.id, origin: candidate.origin, score: candidate.score, factors: candidate.factors,
        reasons: candidate.reasons, stats: candidate.stats, overlaps: candidate.overlaps || []
      }));
    }
    if (detail.lightingPlan?.executed) detail.lightingPlan.executed = { placed: detail.lightingPlan.executed.placed, failed: detail.lightingPlan.executed.failed, requested: detail.lightingPlan.executed.requested };
    if (detail.lightingPlan?.audit) detail.lightingPlan.audit = { ...detail.lightingPlan.audit, uncovered: (detail.lightingPlan.audit.uncovered || []).slice(0, 40) };
    return {
      ...detail,
      summary: this.summary(project),
      builder: project.builderId && this.builders.has(project.builderId) ? this.builders.get(project.builderId).status() : null,
      warehouse: this.warehouse.state(),
      pipeline: PIPELINE_PHASES.map((id) => {
        const phase = project.buildPhases.find((entry) => entry.id === id);
        return { id, name: PIPELINE_LABELS[id], status: phase ? phase.status : 'PENDING', attempts: phase ? phase.attempts : 0, detail: phase ? phase.detail : null };
      })
    };
  }

  async storageMove({ action = 'deposit', item, count = 1, bot = null } = {}) {
    if (!item || !(count > 0)) return { ok: false, error: 'storage move requires item and positive count' };
    const actor = bot ? this.bots.find((entry) => entry.name === bot) : this.bots[0];
    if (!actor) return { ok: false, error: 'unknown bot or no bots connected' };
    if (action === 'deposit') return this.warehouse.deposit({ item, count, bot: actor });
    if (action === 'retrieve') return this.warehouse.retrieve({ item, count, bot: actor });
    return { ok: false, error: `unknown storage action ${action}` };
  }

  async storageScan({ bot = null, radius = 48 } = {}) {
    return this.warehouse.scan({ bot: bot ? this.bots.find((entry) => entry.name === bot) : null, radius });
  }

  async storageOrganise() { return this.warehouse.organise({ bots: this.bots }); }

  reserveMaterials() {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    const bom = project.materialPlan ? { materials: project.materialRequirements } : billOfMaterials(this._schematicFor(project));
    const result = reserveProjectMaterials({ ledger: this.ledger, bom, owner: project.id });
    if (result.ok) project.materialPlan = { ...(project.materialPlan || {}), reserved: true, reservations: result.reservations.length };
    this._save();
    return result;
  }

  report() {
    const project = this.activeProject();
    if (!project) return { ok: false, error: 'no active project' };
    return {
      ok: true, project: this.summary(project),
      pipeline: project.buildPhases.map((phase) => ({ id: phase.id, name: phase.name, status: phase.status, attempts: phase.attempts, detail: phase.detail })),
      materials: project.materialPlan ? { ready: project.materialPlan.ready, deficit: project.materialPlan.deficit } : null,
      site: { origin: project.origin, selected: project.sitePreparation.selected || null, survey: project.sitePreparation.survey ? project.sitePreparation.survey.stats : null },
      quality: project.quality, security: project.security, storage: project.storage,
      history: project.history.slice(-20)
    };
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  load() {
    try {
      if (!fs.existsSync(this.persistPath)) return { ok: true, loaded: 0 };
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      if (!data || !Array.isArray(data.projects)) return { ok: false, error: 'invalid construction state file' };
      for (const project of data.projects) {
        if (!project || !project.id) continue;
        project.paused = false;
        if ([STATUS.BUILDING, STATUS.PREPARING].includes(project.status)) project.status = STATUS.PAUSED;
        if (!Array.isArray(project.buildPhases)) project.buildPhases = [];
        for (const id of PIPELINE_PHASES) {
          if (!project.buildPhases.find((phase) => phase.id === id)) project.buildPhases.push({ id, name: PIPELINE_LABELS[id], status: PHASE_STATUS.PENDING, startedAt: null, completedAt: null, attempts: 0, detail: null });
        }
        this.projects.set(project.id, project);
        projectSeq = Math.max(projectSeq, Number(String(project.id).match(/project-(\d+)/)?.[1] || 0));
      }
      this.activeId = data.activeId && this.projects.has(data.activeId) ? data.activeId : null;
      this.stats.loads++;
      return { ok: true, loaded: this.projects.size, activeId: this.activeId };
    } catch (err) {
      this.lastError = `load failed: ${err.message}`;
      return { ok: false, error: this.lastError };
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const payload = { version: 1, updatedAt: nowIso(), activeId: this.activeId, projects: [...this.projects.values()].map((project) => clone(project)) };
      const temp = `${this.persistPath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(payload));
      fs.renameSync(temp, this.persistPath);
      this.stats.saves++;
      return { ok: true };
    } catch (err) {
      this.lastError = `save failed: ${err.message}`;
      this.logger.error(this.lastError);
      return { ok: false, error: this.lastError };
    }
  }
}

applyPipeline(ConstructionManager.prototype);

module.exports = {
  ConstructionManager, PIPELINE_PHASES, PIPELINE_LABELS, BUILD_PHASES, STATUS, PHASE_STATUS,
  INITIAL_ROLES, rotateSchematic, botWorldView
};
