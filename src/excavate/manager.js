'use strict';

const crypto = require('crypto');
const { createExcavationPlan, formatPlan } = require('./planner');
const { ExcavationVerifier } = require('./verifier');
const { ExcavationExecutor } = require('./executor');
const { assignRegions, reassignRegion } = require('./regions');
const { createExcavationPlanTasks } = require('../team/plans');
const { config } = require('../config');

/**
 * Excavation lifecycle: preview -> authorise -> start -> (bots execute regions)
 * -> verify with real blocks -> report. Also owns pause/resume/stop/assign.
 */
class ExcavationManager {
  constructor({ coordinator = null, logger = null, now = () => Date.now(), options = {} } = {}) {
    this.coordinator = coordinator;
    this.logger = logger;
    this.now = now;
    this.options = {
      maxBlocks: config.excavation.maxBlocks,
      maxDepth: config.excavation.maxDepth,
      preserveOres: config.excavation.preserveOres,
      protectedDefault: config.excavation.protectedDefault,
      requireConfirmation: config.excavation.requireConfirmation,
      ...options
    };
    this.previews = new Map();
    this.excavations = new Map();
    this.executors = new Map(); // taskId -> executor
    this.adapters = new Map(); // botName -> adapter
    this.seq = 0;
    this.history = [];
  }

  attachBot(name, adapter) { this.adapters.set(name, adapter); return this; }
  detachBot(name) { this.adapters.delete(name); }

  _planOptions(opts) {
    return {
      maxBlocks: this.options.maxBlocks,
      maxDepth: this.options.maxDepth,
      preserveOres: this.options.preserveOres,
      protectedDefault: this.options.protectedDefault,
      authorized: Boolean(opts.authorized),
      scanLimit: opts.scanLimit || this.options.scanLimit
    };
  }

  /** Build a plan without starting it. */
  preview(opts) {
    const blockAt = opts.blockAt || this._blockAtFor(opts.bot);
    const surfaceAt = opts.surfaceAt || this._surfaceAtFor(opts.bot);
    const result = createExcavationPlan({
      ...opts,
      blockAt,
      surfaceAt,
      options: this._planOptions(opts)
    });
    if (!result.ok) return result;
    const plan = result.plan;
    const previewId = `preview-${++this.seq}`;
    plan.previewId = previewId;
    this.previews.set(previewId, plan);
    this._trimPreviews();
    return { ok: true, plan, text: formatPlan(plan), previewId };
  }

  _trimPreviews() {
    while (this.previews.size > 20) {
      const oldest = this.previews.keys().next().value;
      this.previews.delete(oldest);
    }
  }

  _blockAtFor(botName) {
    if (botName && this.adapters.has(botName)) {
      const adapter = this.adapters.get(botName);
      return (pos) => adapter.getBlock(pos);
    }
    // Fall back to any attached adapter.
    const first = this.adapters.values().next().value;
    return first ? (pos) => first.getBlock(pos) : null;
  }

  _surfaceAtFor(botName) {
    const adapter = (botName && this.adapters.get(botName)) || this.adapters.values().next().value;
    if (!adapter || typeof adapter.surfaceAt !== 'function') return null;
    return (x, z) => adapter.surfaceAt(x, z);
  }

  undoPreview(previewId = null) {
    if (previewId) return { ok: this.previews.delete(previewId) };
    const count = this.previews.size;
    this.previews.clear();
    return { ok: true, cleared: count };
  }

  /** Start an excavation. Destructive operations require explicit confirmation. */
  start(opts = {}) {
    const preview = opts.previewId ? this.previews.get(opts.previewId) : null;
    let plan = preview || opts.plan;
    if (!plan) {
      const built = this.preview(opts);
      if (!built.ok) return built;
      plan = built.plan;
    }
    if (plan.authorizationRequired && !opts.authorized) {
      return {
        ok: false,
        error: 'protected player blocks are inside the excavation; repeat with authorisation (authorized: true)',
        requiresAuthorization: true,
        plan,
        text: formatPlan(plan)
      };
    }
    if (this.options.requireConfirmation && !opts.confirm) {
      return { ok: false, error: 'confirmation required: run preview, then start with confirmation', requiresConfirmation: true, plan, text: formatPlan(plan) };
    }
    const supervisor = this.coordinator ? this.coordinator.leader : null;
    const botNames = this.coordinator ? this.coordinator.botNames : [];
    const workerCount = opts.team ? botNames.length : Math.min(4, botNames.length || 4);
    const planRegions = plan.regions && plan.regions.length ? plan.regions : [];
    const uses = planRegions.length ? planRegions : [];
    const assignment = assignRegions(uses, botNames, { supervisor, includeSupervisor: Boolean(opts.team) });
    plan.assignments = assignment.assignments;

    const excavation = {
      id: `excavation-${++this.seq}-${crypto.randomBytes(2).toString('hex')}`,
      planId: plan.id,
      plan,
      status: 'ACTIVE',
      paused: false,
      createdAt: this.now(),
      createdBy: opts.createdBy || 'console',
      confirmations: { required: true, confirmed: true, authorized: Boolean(opts.authorized) },
      assignments: assignment.assignments,
      supervisor: assignment.supervisor,
      objectiveId: null,
      tasks: [],
      executors: {},
      verification: null,
      report: null,
      notes: []
    };

    // Register with the team board so bots pick the regions up as real tasks.
    if (this.coordinator && opts.createTasks !== false) {
      const objective = this.coordinator.board.createObjective({
        title: `EXCAVATE ${plan.description.dimensions} at ${plan.description.origin}`,
        description: `${plan.mode} excavation, ${plan.volume} blocks`,
        priority: opts.priority || 75,
        progress: { current: 0, target: plan.volume, unit: 'blocks' },
        metadata: { template: 'EXCAVATION', excavationId: excavation.id, planId: plan.id }
      });
      excavation.objectiveId = objective.id;
      const created = createExcavationPlanTasks(this.coordinator.board, {
        objectiveId: objective.id,
        excavationId: excavation.id,
        regions: plan.regions,
        priority: opts.priority || 75
      });
      if (!created.ok) {
        this.coordinator.board.updateObjective(objective.id, { status: 'CANCELLED' });
        return { ok: false, error: created.error };
      }
      excavation.tasks = created.tasks.filter((t) => t.ok).map((t) => {
        const region = plan.regions.find((r) => r.id === (t.region.id || t.region));
        const assigned = excavation.assignments.find((a) => a.regionId === (t.region.id || t.region));
        return { taskId: t.task.id, regionId: t.region.id, region: t.region.box, volume: t.region.volume, assignedTo: assigned ? assigned.bot : null };
      });
      // Claim region tasks for the planned bots immediately so allocation is
      // intentional and balanced rather than first-come-first-served.
      for (const entry of excavation.tasks) {
        if (!entry.assignedTo) continue;
        if (entry.assignedTo === supervisor && !opts.team) continue;
        const claim = this.coordinator.board.claim(entry.taskId, entry.assignedTo);
        if (claim.ok) {
          this.coordinator.assignments.set(entry.assignedTo, {
            taskId: entry.taskId,
            type: 'EXCAVATE_REGION',
            label: `Excavate ${entry.regionId}`,
            params: { excavationId: excavation.id, regionId: entry.regionId },
            region: entry.region,
            priority: 75,
            units: { current: 0, target: entry.volume },
            assignedAt: this.now()
          });
          this.coordinator.roles.set(entry.assignedTo, 'EXCAVATOR');
          this.coordinator.board.start(entry.taskId, entry.assignedTo);
        }
      }
    }
    this.excavations.set(excavation.id, excavation);
    this._event('started', excavation);
    if (this.coordinator) {
      this.coordinator.comms.send('OBJECTIVE_CREATED', 'system', { objectiveId: excavation.objectiveId, title: 'EXCAVATION', excavationId: excavation.id });
      this.coordinator.memory.setFact('activeExcavation', {
        id: excavation.id,
        bounds: plan.bounds,
        mode: plan.mode,
        origin: plan.origin
      });
    }
    if (this.logger) this.logger.info(`excavation ${excavation.id} started (${plan.mode}, ${plan.volume} blocks)`);
    return { ok: true, excavation, plan, text: formatPlan(plan) };
  }

  get(id = null) {
    if (id) return this.excavations.get(id) || null;
    const active = [...this.excavations.values()].filter((e) => ['ACTIVE', 'PAUSED', 'VERIFYING', 'INCOMPLETE'].includes(e.status));
    return active.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  list() { return [...this.excavations.values()].map((e) => this._summary(e)); }

  _summary(exc) {
    const tasks = exc.tasks.map((t) => {
      const boardTask = this.coordinator ? this.coordinator.board.getTask(t.taskId) : null;
      const executor = this.executors.get(t.taskId);
      return {
        taskId: t.taskId,
        regionId: t.regionId,
        assignedTo: boardTask ? boardTask.claimedBy : t.assignedTo,
        status: boardTask ? boardTask.status : 'UNKNOWN',
        progress: boardTask ? boardTask.units : { current: 0, target: t.volume },
        executor: executor ? executor.summary() : null
      };
    });
    const totalVolume = exc.tasks.reduce((s, t) => s + (t.volume || 0), 0) || exc.plan.volume;
    const dug = tasks.reduce((s, t) => s + (t.progress.current || 0), 0);
    return {
      id: exc.id,
      status: exc.status,
      paused: exc.paused,
      mode: exc.plan.mode,
      dimensions: exc.plan.description.dimensions,
      origin: exc.plan.description.origin,
      volume: exc.plan.volume,
      dug,
      progressRatio: totalVolume ? Number(Math.min(1, dug / totalVolume).toFixed(4)) : 0,
      objectiveId: exc.objectiveId,
      supervisor: exc.supervisor,
      assignments: exc.assignments,
      tasks,
      verification: exc.verification ? {
        complete: exc.verification.complete,
        remaining: exc.verification.remaining,
        sampled: exc.verification.sampled,
        forbiddenRemoved: exc.verification.forbiddenRemoved.length,
        checkedAt: exc.verification.checkedAt
      } : null,
      createdAt: exc.createdAt,
      report: exc.report
    };
  }

  status(id = null) {
    const exc = this.get(id);
    if (!exc) return { ok: false, error: 'no active excavation' };
    return { ok: true, excavation: this._summary(exc) };
  }

  pause(id = null) {
    const exc = this.get(id);
    if (!exc) return { ok: false, error: 'no active excavation' };
    exc.paused = true;
    exc.status = 'PAUSED';
    for (const executor of this.executors.values()) executor.pause('excavation paused');
    this._event('paused', exc);
    return { ok: true, excavation: this._summary(exc) };
  }

  resume(id = null) {
    const exc = this.get(id);
    if (!exc) return { ok: false, error: 'no active excavation' };
    exc.paused = false;
    exc.status = 'ACTIVE';
    for (const executor of this.executors.values()) executor.resume();
    this._event('resumed', exc);
    return { ok: true, excavation: this._summary(exc) };
  }

  stop(id = null, reason = 'stopped by operator') {
    const exc = this.get(id);
    if (!exc) return { ok: false, error: 'no active excavation' };
    exc.status = 'STOPPED';
    exc.stoppedAt = this.now();
    exc.stopReason = reason;
    for (const [taskId, executor] of this.executors) {
      executor.stop(reason);
      if (this.coordinator) this.coordinator.board.release(taskId, exc.assignments.find((a) => a.taskId === taskId)?.bot || null, reason);
    }
    if (this.coordinator && exc.objectiveId) {
      const objective = this.coordinator.board.getObjective(exc.objectiveId);
      if (objective) this.coordinator.board.updateObjective(exc.objectiveId, { status: 'CANCELLED' });
    }
    this._event('stopped', exc);
    return { ok: true, excavation: this._summary(exc) };
  }

  /** Manually assign a bot to a region (and release the previous owner). */
  assign(botName, regionId = null) {
    const exc = this.get();
    if (!exc) return { ok: false, error: 'no active excavation' };
    const entry = regionId ? exc.tasks.find((t) => t.regionId === regionId) : exc.tasks.find((t) => !t.assignedTo || t.assignedTo === botName);
    if (!entry) return { ok: false, error: 'region not found' };
    if (!this.coordinator) return { ok: false, error: 'team coordinator unavailable' };
    const current = this.coordinator.board.getTask(entry.taskId);
    if (current && current.claimedBy && current.claimedBy !== botName) {
      this.coordinator.board.release(entry.taskId, current.claimedBy, 'reassigned');
    }
    const claim = this.coordinator.board.claim(entry.taskId, botName, { force: true });
    if (!claim.ok) return { ok: false, error: claim.error };
    this.coordinator.assignments.set(botName, {
      taskId: entry.taskId,
      type: 'EXCAVATE_REGION',
      label: `Excavate ${entry.regionId}`,
      params: { excavationId: exc.id, regionId: entry.regionId },
      region: entry.region,
      priority: 75,
      units: { current: 0, target: entry.volume },
      assignedAt: this.now()
    });
    this.coordinator.roles.set(botName, 'EXCAVATOR');
    entry.assignedTo = botName;
    const assignment = exc.assignments.find((a) => a.regionId === entry.regionId);
    if (assignment) assignment.bot = botName;
    this._event('assigned', { excavation: exc.id, bot: botName, region: entry.regionId });
    return { ok: true, excavation: this._summary(exc) };
  }

  /** Reassign work from a disconnected bot. */
  handleBotDisconnected(botName) {
    const updates = [];
    for (const exc of this.excavations.values()) {
      if (exc.status !== 'ACTIVE' && exc.status !== 'PAUSED') continue;
      const executors = [...this.executors.values()].filter((e) => e.botName === botName);
      for (const executor of executors) executor.stop('bot disconnected');
      const result = reassignRegion(exc.assignments, botName, this.coordinator ? this.coordinator.botNames : []);
      if (result.ok) {
        exc.assignments = result.assignments;
        const activeBots = this.coordinator ? this.coordinator.activeBots().map((b) => b.name) : [];
        for (const assignment of result.assignments.filter((a) => a.reassignedFrom === botName)) {
          if (!activeBots.includes(assignment.bot)) continue;
          this.assign(assignment.bot, assignment.regionId);
        }
        updates.push({ excavation: exc.id, moved: result.moved });
        this._event('reassigned', { excavation: exc.id, from: botName });
      }
    }
    return updates;
  }

  /**
   * Run one region task on a bot. Called by the bot scheduler when it picks up
   * an EXCAVATE_REGION task, or directly by tests.
   */
  async executeTask(botName, task, { token = null } = {}) {
    const adapter = this.adapters.get(botName);
    if (!adapter) return { ok: false, error: `no adapter for ${botName}` };
    const excavationId = task.params && task.params.excavationId;
    const regionId = task.params && task.params.regionId;
    const exc = this.excavations.get(excavationId);
    if (!exc) return { ok: false, error: 'unknown excavation' };
    if (exc.status === 'STOPPED') return { ok: false, error: 'excavation stopped' };
    const region = exc.plan.regions.find((r) => r.id === regionId);
    if (!region) return { ok: false, error: 'unknown region' };

    const executor = new ExcavationExecutor({
      botName,
      bot: adapter,
      plan: { ...exc.plan, taskId: task.id },
      region,
      mask: exc.plan._mask || null,
      taskBoard: this.coordinator ? this.coordinator.board : null,
      comms: this.coordinator ? this.coordinator.comms : null,
      logger: this.logger,
      now: this.now
    });
    if (exc.paused) executor.pause('excavation paused');
    if (token) token.onCancel(() => executor.stop('cancelled'));
    this.executors.set(task.id, executor);
    const summary = await executor.run();
    this.executors.delete(task.id);

    const verifier = new ExcavationVerifier(exc.plan, {
      getBlock: (pos) => adapter.getBlock(pos),
      options: exc.plan.options,
      mask: exc.plan._mask || null
    });
    const verification = verifier.verifyRegion(region);
    const board = this.coordinator ? this.coordinator.board : null;
    if (summary.status === 'completed' && verification.complete) {
      if (board) board.complete(task.id, { by: botName, verified: true, notes: `region ${regionId} verified empty` });
      if (this.coordinator) {
        this.coordinator.comms.send('EXCAVATION_PHASE_COMPLETE', botName, { excavationId, regionId, verified: true });
        this.coordinator.clearAssignment(botName, { completed: true });
      }
    } else {
      if (board) {
        board.updateProgress(task.id, { current: Math.min(task.units.target, summary.stats.dug) });
        if (summary.status === 'stopped' || summary.status === 'error') {
          board.fail(task.id, summary.stats.lastError || summary.status, { by: botName, retry: true });
          if (this.coordinator) this.coordinator.clearAssignment(botName);
        }
      }
    }
    this._maybeFinish(exc);
    return { ok: true, executor: summary, verification };
  }

  _maybeFinish(exc) {
    if (!this.coordinator) return;
    const tasks = exc.tasks.map((t) => this.coordinator.board.getTask(t.taskId)).filter(Boolean);
    if (!tasks.length) return;
    const done = tasks.every((t) => t.status === 'COMPLETED');
    if (!done) return;
    exc.status = 'VERIFYING';
    const adapter = this.adapters.values().next().value;
    if (!adapter) return;
    const verifier = new ExcavationVerifier(exc.plan, { getBlock: (pos) => adapter.getBlock(pos), options: exc.plan.options, mask: exc.plan._mask || null });
    const verification = verifier.verify();
    exc.verification = verification;
    exc.report = this._report(exc, verification);
    exc.status = verification.complete ? 'COMPLETED' : 'INCOMPLETE';
    if (verification.complete) {
      this.coordinator.comms.send('EXCAVATION_PHASE_COMPLETE', 'system', { excavationId: exc.id, verified: true });
      this.coordinator.memory.setFact('activeExcavation', null);
      this._event('completed', { excavation: exc.id, report: exc.report });
    } else {
      this.coordinator.comms.send('TEAM_WARNING', 'system', { excavationId: exc.id, warning: 'excavation verification incomplete', remaining: verification.remaining });
    }
  }

  _report(exc, verification) {
    return {
      excavationId: exc.id,
      mode: exc.plan.mode,
      dimensions: exc.plan.description.dimensions,
      origin: exc.plan.description.origin,
      volume: exc.plan.volume,
      checked: verification.checked,
      remaining: verification.remaining,
      sampled: verification.sampled,
      dimensionsOk: verification.dimensionsOk,
      accessOk: verification.accessOk,
      forbiddenRemoved: verification.forbiddenRemoved.length,
      orePositionsIntact: (exc.plan.ores || []).length - verification.oreMissing.length,
      complete: verification.complete,
      notes: verification.notes,
      generatedAt: this.now()
    };
  }

  verify(id = null) {
    const exc = this.get(id);
    if (!exc) return { ok: false, error: 'no excavation to verify' };
    const adapters = [...this.adapters.values()];
    if (!adapters.length) return { ok: false, error: 'no attached bot to read blocks from' };
    const verifier = new ExcavationVerifier(exc.plan, { getBlock: (pos) => adapters[0].getBlock(pos), options: exc.plan.options, mask: exc.plan._mask || null });
    const verification = verifier.verify();
    exc.verification = verification;
    exc.report = this._report(exc, verification);
    return { ok: true, verification, report: exc.report };
  }

  _event(type, payload) {
    this.history.push({ at: this.now(), type, payload });
    if (this.history.length > 200) this.history.shift();
  }

  snapshot() {
    return {
      previews: [...this.previews.values()].map((p) => ({
        previewId: p.previewId,
        mode: p.mode,
        dimensions: p.description.dimensions,
        origin: p.description.origin,
        volume: p.volume,
        authorizationRequired: p.authorizationRequired,
        warnings: p.warnings
      })),
      active: this.list(),
      executors: [...this.executors.values()].map((e) => e.summary()),
      history: this.history.slice(-20)
    };
  }
}

module.exports = { ExcavationManager };
