'use strict';

const { TeamMemory } = require('./teamMemory');
const { TaskBoard, TASK_STATUS } = require('./taskBoard');
const { ResourceLedger } = require('./resourceLedger');
const { Leadership } = require('./leadership');
const { TeamComms } = require('./comms');
const { EmergencyManager } = require('./emergencies');
const { computeSlots, separation, normalizeFormation, formationForTask } = require('./formations');
const { createSurvivalBasePlan } = require('./plans');
const { config } = require('../config');
const { sumCategory } = require('../world/items');

const ROLE_BY_TASK = {
  CHOP_WOOD: 'WOODCUTTER',
  MINE_ORE: 'MINER',
  MINE_BLOCK: 'MINER',
  FARM_CROP: 'FARMER',
  FARM_ANIMAL: 'RANCHER',
  BUILD_PHASE: 'BUILDER',
  EXCAVATE_REGION: 'EXCAVATOR',
  FIND_SITE: 'SCOUT',
  EXPLORE: 'SCOUT',
  STORE_ITEMS: 'QUARTERMASTER',
  TRANSFER_ITEMS: 'QUARTERMASTER',
  PLACE_BED: 'QUARTERMASTER',
  COMBAT_GUARD: 'GUARD',
  DEFEND: 'GUARD',
  FISH: 'FISHER',
  CRAFT: 'CRAFTSMAN',
  SMELT: 'CRAFTSMAN',
  RETURN_HOME: 'RETURNING'
};

/**
 * The team brain.
 *
 * It does not move bots itself. It observes bot snapshots, maintains shared
 * state (memory, board, ledger, leadership, emergencies), allocates work, and
 * publishes assignments the bots' schedulers consume. This separation keeps
 * the coordination logic deterministic and testable with mock bots.
 */
class TeamCoordinator {
  constructor({
    botNames = config.team.names,
    memory = null,
    board = null,
    ledger = null,
    leadership = null,
    comms = null,
    emergencies = null,
    logger = null,
    now = () => Date.now(),
    // Planning is opt-in. A fresh launch must not manufacture work before
    // the operator has asked for it (`team plan on`).
    autoPlan = config.autonomy.autoPlan
  } = {}) {
    this.botNames = botNames.slice();
    this.now = now;
    this.memory = memory || new TeamMemory({ maxObservations: config.team.maxObservations, defaultTtlMs: config.team.observationTtlMs, now });
    this.board = board || new TaskBoard({ claimTtlMs: config.team.claimTtlMs, lockTtlMs: config.team.lockTtlMs, now });
    this.ledger = ledger || new ResourceLedger({ reserves: config.reserves, now });
    this.leadership = leadership || new Leadership({ preferred: config.team.preferredLeader, order: botNames, now });
    this.comms = comms || new TeamComms();
    this.emergencies = emergencies || new EmergencyManager({ now });
    this.logger = logger;
    this.botStates = new Map();
    this.assignments = new Map();
    this.rescues = new Map();
    this.roles = new Map();
    this.formation = config.team.formation;
    this.autoPlan = autoPlan;
    // Consecutive failed plans, not the number of plans ever created. Counting
    // creations made the team stop planning forever after three successful
    // objectives, which looked exactly like "the bots are idle".
    this.planFailures = 0;
    this.planAttempts = 0;
    this.planRetryAt = 0;
    this.planRetryMs = 60000;
    this.maxAutoPlanBackoffMs = 5 * 60 * 1000;
    this.maxConsecutivePlanFailures = 3;
    this.planBlockedUntil = 0;
    this.planBlockedReason = null;
    this.lastPlanFailure = null;
    this.lastPlanObjectiveId = null;
    // A failed objective is retried by re-opening the same id, never by
    // minting another near-identical objective.
    this.planReopen = null;
    this.enabled = false;
    this.ticks = 0;
    this.startedAt = now();
    this.lastTickDurationMs = 0;
    this.lastSummary = null;
    this.extrasFn = null;
    this.availableAnnounced = new Set();
    this.listeners = [];
    this.leaderChangedListeners = [];
    this.leadership.onElection((leader, previous) => {
      this.comms.send('LEADER_ELECTED', 'system', { leader, previous });
      for (const fn of this.leaderChangedListeners) { try { fn(leader, previous); } catch (_) { /* ignore */ } }
    });
  }

  onUpdate(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
  onLeaderChanged(fn) { this.leaderChangedListeners.push(fn); return () => { this.leaderChangedListeners = this.leaderChangedListeners.filter((f) => f !== fn); }; }

  enable() { this.enabled = true; return this; }

  disable() {
    this.enabled = false;
    // Stop issuing work and release active claims so the board stays reusable.
    for (const [name, assignment] of [...this.assignments]) {
      const task = this.board.getTask(assignment.taskId);
      if (task && ['CLAIMED', 'ACTIVE'].includes(task.status)) {
        this.board.release(task.id, name, 'team coordination disabled');
        this.comms.send('TASK_RELEASED', name, { taskId: task.id, reason: 'team coordination disabled' });
      }
      this.assignments.delete(name);
      this.roles.set(name, 'IDLE');
    }
    this.comms.send('TEAM_DISABLED', 'system', { at: this.now() });
    return this;
  }

  setEnabled(enabled) {
    if (enabled) {
      this.enable();
      this.comms.send('TEAM_ENABLED', 'system', { at: this.now() });
    } else {
      this.disable();
    }
    return { ok: true, enabled: this.enabled, leader: this.leader, formation: this.formation };
  }

  setExtras(fn) { this.extrasFn = fn; }

  planningStatus() {
    return {
      autoPlan: this.autoPlan,
      failures: this.planFailures,
      attempts: this.planAttempts,
      nextRetryAt: this.planRetryAt || null,
      blockedUntil: this.planBlockedUntil || null,
      reopenPending: this.planReopen ? { objectiveId: this.planReopen.objectiveId, at: this.planReopen.at } : null,
      blockedReason: this.planBlockedReason || null,
      lastFailure: this.lastPlanFailure,
      lastObjectiveId: this.lastPlanObjectiveId,
      stopped: Boolean(this.planBlockedUntil && this.now() < this.planBlockedUntil)
    };
  }

  /**
   * Turn the survival planner on or off at runtime. Off leaves any objective
   * and task already on the board alone; it only stops new plans. On clears a
   * retry/backoff hold so the next tick can plan immediately.
   */
  setAutoPlan(enabled, { reason = 'operator' } = {}) {
    const next = Boolean(enabled);
    const changed = next !== this.autoPlan;
    this.autoPlan = next;
    if (next) {
      this.planRetryAt = 0;
      this.planBlockedUntil = 0;
      this.planBlockedReason = null;
    }
    if (changed) {
      this.comms.send(next ? 'PLANNER_ENABLED' : 'PLANNER_DISABLED', 'system', { at: this.now(), reason });
      if (this.logger) this.logger.info(`autonomous planning ${next ? 'enabled' : 'disabled'} (${reason})`);
    }
    return { ok: true, changed, autoPlan: next, planning: this.planningStatus() };
  }

  setFormation(name) {
    this.formation = normalizeFormation(name);
    this.comms.send('TEAM_REGROUP', 'system', { formation: this.formation });
    return this.formation;
  }

  get leader() { return this.leadership.leader; }

  updateBot(name, snapshot) {
    if (!this.botNames.includes(name)) return { ok: false, error: 'unknown bot' };
    const previous = this.botStates.get(name);
    const state = {
      ...(previous || {}),
      ...snapshot,
      name,
      lastUpdate: this.now()
    };
    if (!state.inventory) state.inventory = {};
    if (state.connected === undefined) state.connected = true;
    if (state.spawned === undefined) state.spawned = true;
    if (state.capabilities === undefined) state.capabilities = ['mine', 'chop', 'farm', 'build', 'excavate', 'explore', 'combat', 'fish'];
    this.botStates.set(name, state);
    if (previous && previous.connected === false && state.connected !== false) {
      this.comms.send('BOT_CONNECTED', name, { bot: name });
    }
    if (previous && previous.health > 0 && state.health === 0) {
      this.comms.send('BOT_DISCONNECTED', name, { bot: name, reason: 'died', position: state.position });
    }
    if (!previous || previous.spawned === false) {
      if (state.connected && state.spawned) this.comms.send('BOT_CONNECTED', name, { bot: name });
    }
    if (state.position) {
      this.memory.setFact(`lastPosition:${name}`, state.position);
    }
    return { ok: true, state };
  }

  setDisconnected(name, reason = 'disconnected') {
    const state = this.botStates.get(name);
    if (state) {
      state.connected = false;
      state.spawned = false;
      state.lastUpdate = this.now();
    }
    this.comms.send('BOT_DISCONNECTED', name, { bot: name, reason });
    // Release the bot's work so the team can recover immediately.
    for (const task of this.board.listTasks({ claimedBy: name })) {
      this.board.release(task.id, name, reason);
      this.comms.send('TASK_RELEASED', name, { taskId: task.id, reason });
    }
    this.assignments.delete(name);
    this.rescues.delete(name);
    this.ledger.releaseOwner(name);
  }

  activeBots() {
    return [...this.botStates.values()].filter((s) => s.connected !== false && s.spawned !== false && s.authenticated !== false && s.ready !== false && (s.health === undefined || s.health > 0));
  }

  /** Release a bot's current work without marking the whole bot offline. */
  releaseWork(name, reason = 'work released') {
    const assignment = this.assignments.get(name);
    if (!assignment) return { ok: true, released: false };
    const task = this.board.getTask(assignment.taskId);
    if (task && ['CLAIMED', 'ACTIVE'].includes(task.status) && task.claimedBy === name) {
      this.board.release(task.id, name, reason);
      this.comms.send('TASK_RELEASED', name, { taskId: task.id, reason });
    }
    this.assignments.delete(name);
    this.roles.set(name, 'IDLE');
    return { ok: true, released: true, taskId: assignment.taskId, reason };
  }

  assignTask(name, taskId) {
    // Operators may assign work before the first coordinator tick has produced
    // a bot state; the roster is the authority, not the observation cache.
    if (!this.botNames.includes(name)) return { ok: false, error: 'unknown bot' };
    // Forced assignment must not silently orphan the previous task. Release it
    // first so the board can hand it to another bot.
    const previous = this.assignments.get(name);
    const releasedPrevious = Boolean(previous && previous.taskId !== taskId);
    if (releasedPrevious) this.releaseWork(name, 'reassigned by operator');
    const res = this.board.claim(taskId, name, { force: true });
    if (!res.ok) return { ...res, releasedPrevious };
    this._setAssignment(name, res.task);
    return { ...res, releasedPrevious };
  }

  _setAssignment(name, task) {
    const role = ROLE_BY_TASK[task.type] || 'WORKER';
    this.assignments.set(name, {
      taskId: task.id,
      type: task.type,
      label: task.label,
      params: task.params,
      region: task.region,
      requires: task.requires,
      priority: task.priority,
      units: task.units,
      assignedAt: this.now()
    });
    this.roles.set(name, role);
    this.comms.send('TASK_ACCEPTED', name, { bot: name, taskId: task.id, type: task.type, label: task.label, role });
    return role;
  }

  clearAssignment(name, { completed = false } = {}) {
    const assignment = this.assignments.get(name);
    this.assignments.delete(name);
    this.roles.set(name, 'IDLE');
    if (assignment && completed) {
      this.comms.send('TASK_COMPLETED', name, { bot: name, taskId: assignment.taskId, type: assignment.type });
    }
    return assignment;
  }

  getAssignment(name) { return this.assignments.get(name) || null; }
  getRescue(name) { return this.rescues.get(name) || null; }

  clearRescue(name) {
    const rescue = this.rescues.get(name);
    if (!rescue) return null;
    this.rescues.delete(name);
    if (!this.assignments.has(name)) this.roles.set(name, 'IDLE');
    return rescue;
  }

  ensureObjectives() {
    if (!this.autoPlan) return null;
    if (this.board.listObjectives('ACTIVE').length > 0) return null;
    const now = this.now();
    // Retry in place. Older builds deleted the failed objective reference and
    // called createSurvivalBasePlan() again, so the live dashboard showed the
    // same objective recreated every few minutes with a new id.
    if (this.planReopen) {
      if (now < this.planReopen.at) return null;
      const pending = this.planReopen;
      this.planReopen = null;
      const reopened = this.board.reopenObjective(pending.objectiveId, { reason: pending.reason });
      if (!reopened.ok) {
        if (this.logger) this.logger.warn(`could not re-open objective ${pending.objectiveId}: ${reopened.error}`);
        return null;
      }
      this.lastPlanObjectiveId = reopened.objective.id;
      this.planRetryAt = now + this.planRetryMs;
      this.comms.send('OBJECTIVE_REOPENED', 'system', {
        objectiveId: reopened.objective.id, title: reopened.objective.title, reason: pending.reason
      });
      if (this.logger) {
        this.logger.warn(`re-opened the same objective ${reopened.objective.id} (attempt ${this.planFailures + 1}/${this.maxConsecutivePlanFailures}) after: ${pending.reason}`);
      }
      return reopened;
    }
    // Resolve the previous plan before deciding whether to make a new one.
    // Failed plans back off exponentially, but planning is never disabled
    // permanently: a later success resets the backoff.
    if (this.lastPlanObjectiveId) {
      const previous = this.board.getObjective(this.lastPlanObjectiveId);
      this.lastPlanObjectiveId = null;
      if (previous && previous.status === 'FAILED') {
        this.planFailures++;
        const failedTask = this.board.listTasks({ objectiveId: previous.id })
          .find((task) => task.status === 'FAILED') || null;
        const reason = previous.blockedReason || (failedTask && failedTask.lastError) || 'objective failed without a recorded cause';
        this.lastPlanFailure = {
          at: now, objectiveId: previous.id, title: previous.title, reason,
          failedTask: failedTask ? { id: failedTask.id, type: failedTask.type, label: failedTask.label } : null
        };
        const delay = Math.min(this.maxAutoPlanBackoffMs, this.planRetryMs * (2 ** Math.min(4, this.planFailures - 1)));
        const at = this.planFailures >= this.maxConsecutivePlanFailures
          // Three identical failures mean the preconditions are not merely
          // transient. Wait the long backoff before re-opening the same
          // objective; nothing new is created in the meantime.
          ? now + Math.max(this.maxAutoPlanBackoffMs, 30 * 60 * 1000)
          : now + delay;
        this.planReopen = { objectiveId: previous.id, at, reason };
        this.planRetryAt = at;
        if (this.planFailures >= this.maxConsecutivePlanFailures) {
          this.planBlockedUntil = at;
          this.planBlockedReason = reason;
          if (this.logger) this.logger.error(`automatic planning paused after ${this.planFailures} consecutive failures: ${reason}; next attempt in ${Math.round((at - now) / 1000)}s`);
        } else {
          this.planBlockedUntil = 0;
          this.planBlockedReason = null;
          if (this.logger) this.logger.warn(`automatic plan failed (${this.planFailures} consecutive): ${reason}; re-opening the same objective in ${Math.round(delay / 1000)}s`);
        }
        return null;
      }
      if (previous && previous.status === 'COMPLETED') {
        this.planFailures = 0;
        this.planRetryAt = now + 15000;
        return null;
      }
      // A cancelled objective is an operator decision; do not count it as a
      // planner failure, but give the operator a short quiet period.
      this.planFailures = 0;
      this.planRetryAt = now + 5000;
      return null;
    }
    if (now < this.planRetryAt) return null;
    if (this.planBlockedUntil && now < this.planBlockedUntil) return null;
    // One task is claimed by one bot, so the quota is the largest single-bot
    // stock, not the fleet total. Summing five bots' five beds would create a
    // ten-bed task no individual bot could ever finish.
    let bedStock = 0;
    for (const state of this.botStates.values()) bedStock = Math.max(bedStock, sumCategory(state.inventory || {}, 'bed'));
    const plan = createSurvivalBasePlan(this.board, { botNames: this.botNames, bedStock });
    if (plan.created) {
      this.planAttempts++;
      this.planBlockedUntil = 0;
      this.planBlockedReason = null;
      this.lastPlanObjectiveId = plan.objective.id;
      this.planRetryAt = now + this.planRetryMs;
      this.comms.send('OBJECTIVE_CREATED', 'system', { objectiveId: plan.objective.id, title: plan.objective.title });
      if (this.logger) this.logger.info(`new team objective: ${plan.objective.title}`);
    }
    return plan;
  }

  tick() {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    const start = process.hrtime.bigint();
    this.ticks++;
    const now = this.now();
    const summary = { tick: this.ticks, at: now, expired: [], emergencies: [], assignments: [], rescues: [], deadlocks: [], leader: this.leader };

    // 1. Expire stale claims, locks and regions.
    summary.expired = this.board.expire(now);

    // 2. Detect and triage emergencies.
    const states = [...this.botStates.values()];
    for (const state of states) {
      if (state.connected === false) continue;
      const created = this.emergencies.report(state);
      for (const em of created) {
        this.comms.send('BOT_IN_DANGER', em.bot, { bot: em.bot, kind: em.kind, severity: em.severity, position: em.position });
      }
    }
    this.emergencies.refresh(states);
    for (const em of this.emergencies.active()) {
      if (em.plan && em.plan.dispatchedAt) continue;
      const plan = this.emergencies.planRescue(em, states, { teamSize: this.botNames.length });
      em.plan = { ...plan, dispatchedAt: now };
      summary.emergencies.push({ id: em.id, bot: em.bot, kind: em.kind, severity: em.severity, strategy: plan.strategy, responders: plan.responders.map((r) => r.name) });
      if (plan.responders.length) {
        this.comms.send('REQUEST_ASSISTANCE', em.bot, { emergencyId: em.id, kind: em.kind, position: em.position, severity: em.severity });
        for (const responder of plan.responders) {
          this.emergencies.dispatch(em.id, responder.name, responder.role);
          const existing = this.rescues.get(responder.name);
          if (!existing) {
            this.rescues.set(responder.name, {
              emergencyId: em.id,
              victim: em.bot,
              kind: em.kind,
              strategy: plan.strategy,
              role: responder.role,
              position: em.position,
              assignedAt: now
            });
            this.roles.set(responder.name, 'RESCUER');
            this.comms.send('ASSISTANCE_DISPATCHED', responder.name, { bot: responder.name, emergencyId: em.id, victim: em.bot, role: responder.role });
            summary.rescues.push({ responder: responder.name, victim: em.bot, strategy: plan.strategy });
          }
        }
      } else if (plan.strategy === 'REGROUP_AND_RETREAT') {
        this.comms.send('TEAM_REGROUP', 'system', { reason: `${em.bot} ${em.kind}`, position: em.position });
        summary.rescues.push({ responder: null, victim: em.bot, strategy: plan.strategy, withheld: plan.withholdReason });
      }
    }

    // 3. Leadership.
    const election = this.leadership.update(states.map((s) => ({ ...s, isLeader: s.name === this.leader, taskLoad: this.assignments.has(s.name) ? 1 : 0 })));
    summary.leader = election.leader;
    for (const state of states) this.roles.set(state.name, this.roles.get(state.name) || 'IDLE');
    if (election.leader) this.roles.set(election.leader, this.assignments.has(election.leader) ? this.roles.get(election.leader) : 'COORDINATOR');

    // 4. Resource ledger from real inventories.
    for (const state of states) {
      if (state.connected === false) continue;
      this.ledger.updateBotInventory(state.name, state.inventory || {});
    }

    // 5. Objectives.
    this.ensureObjectives();
    for (const obj of this.board.listObjectives('ACTIVE')) this.board.refreshObjectiveProgress(obj.id);

    // 6. Reconcile assignments before allocating new work. A task cancelled,
    // completed elsewhere or expired out from under a bot used to leave the
    // assignment map pointing at dead work forever, so that bot never received
    // another task. Heartbeats also keep long actions from expiring mid-task.
    for (const [name, assignment] of [...this.assignments]) {
      const task = this.board.getTask(assignment.taskId);
      const terminal = !task || ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(task.status);
      if (terminal || (task.claimedBy && task.claimedBy !== name)) {
        this.assignments.delete(name);
        this.roles.set(name, 'IDLE');
        summary.released = summary.released || [];
        summary.released.push({ bot: name, taskId: assignment.taskId, reason: terminal ? `task ${task ? task.status : 'missing'}` : `owner ${task.claimedBy}` });
        continue;
      }
      if (['CLAIMED', 'ACTIVE'].includes(task.status)) this.board.heartbeat(task.id, name);
    }

    // Work that has burned its whole retry budget can never be claimed again;
    // close it instead of leaving a PENDING row that the board can never move.
    for (const task of this.board.listTasks({ status: 'PENDING' })) {
      if (!task.claimedBy && task.attempts >= task.maxAttempts) {
        this.board.fail(task.id, task.lastError || 'retry limit reached', { retry: false });
        summary.failed = summary.failed || [];
        summary.failed.push({ taskId: task.id, type: task.type, reason: 'retry limit reached' });
      }
    }

    // 7. Allocate work to idle bots.
    const idle = this.activeBots()
      .filter((s) => !this.assignments.has(s.name) && !this.rescues.has(s.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const bot of idle) {
      const res = this.board.nextFor(bot, { now });
      if (res.ok) {
        this._setAssignment(bot.name, res.task);
        summary.assignments.push({ bot: bot.name, taskId: res.task.id, type: res.task.type, score: res.score });
        this.board.start(res.task.id, bot.name);
      }
    }

    // 8. Deadlock recovery.
    const resolutions = this.board.resolveDeadlocks();
    for (const res of resolutions) {
      this.comms.send('DEADLOCK_RESOLVED', 'system', res);
      summary.deadlocks.push(res);
      if (this.logger) this.logger.warn(`deadlock resolved: ${res.taskId} released from ${res.releasedFrom}`);
    }

    // 9. Cleanup.
    this.memory.cleanup();
    for (const [name, state] of this.botStates) {
      if (state.connected === false && now - state.lastUpdate > 10 * 60 * 1000) this.botStates.delete(name);
    }

    this.lastTickDurationMs = Number(process.hrtime.bigint() - start) / 1e6;
    this.lastSummary = summary;
    for (const fn of this.listeners) { try { fn(summary); } catch (_) { /* ignore */ } }
    return summary;
  }

  formationSlots() {
    const leader = this.leader;
    const states = this.activeBots();
    if (!leader) return { formation: this.formation, slots: [] };
    const positions = {};
    for (const s of states) if (s.position) positions[s.name] = s.position;
    const leaderState = positions[leader] || { x: 0, z: 0 };
    return computeSlots({
      leader,
      members: states.map((s) => s.name),
      formation: this.formation,
      heading: (this.botStates.get(leader) && this.botStates.get(leader).yaw) || 0,
      positions: { ...positions, [leader]: leaderState }
    });
  }

  separationVectors() {
    const positions = {};
    for (const s of this.activeBots()) if (s.position) positions[s.name] = s.position;
    return separation(positions, { minDistance: 1.6 });
  }

  /** Choose a task-appropriate formation for a bot's current work. */
  formationForBot(name) {
    const assignment = this.getAssignment(name);
    if (this.rescues.has(name)) return 'DEFENSIVE';
    return assignment ? formationForTask(assignment.type) : this.formation;
  }

  objectiveBoard() {
    return this.board.listObjectives().map((obj) => ({
      id: obj.id,
      title: obj.title,
      status: obj.status,
      priority: obj.priority,
      progress: obj.progress,
      completedAt: obj.completedAt || null,
      // Optional work can fail without failing the objective. Surface the
      // degradation so the dashboard explains a lower-than-expected result
      // instead of claiming everything succeeded.
      optionalFailure: obj.optionalFailure || null,
      degraded: Array.isArray(obj.degraded) ? obj.degraded.slice(-5) : [],
      tasks: obj.tasks.map((id) => this.board.getTask(id)).filter(Boolean).map((t) => ({
        id: t.id,
        label: t.label,
        type: t.type,
        status: t.status,
        optional: t.optional === true,
        claimedBy: t.claimedBy,
        progress: t.units,
        dependsOn: t.dependsOn,
        attempts: t.attempts,
        lastError: t.lastError
      }))
    }));
  }

  getState() {
    const bots = this.botNames.map((name) => {
      const state = this.botStates.get(name) || { name, connected: false, spawned: false, authenticated: false, ready: false, health: 0, food: 0, inventory: {}, position: null };
      const emergency = this.emergencies.byBot(name)[0] || null;
      const authenticated = state.authenticated !== undefined ? state.authenticated : state.connected !== false;
      const online = state.connected !== false && state.spawned !== false && authenticated && state.ready !== false && !(Number(state.health) <= 0);
      return {
        name,
        connected: state.connected !== false,
        spawned: state.spawned !== false,
        authenticated,
        online,
        health: state.health === undefined ? 0 : state.health,
        food: state.food === undefined ? 0 : state.food,
        saturation: state.saturation || 0,
        oxygen: state.oxygen,
        armor: state.armor || 0,
        position: state.position || null,
        dimension: state.dimension || 'overworld',
        yaw: state.yaw || 0,
        role: this.roles.get(name) || 'IDLE',
        // The allocator and rescue scorer read this field. It was declared on
        // the adapter but never populated, so both penalties were dead.
        currentTaskId: (this.assignments.get(name) && this.assignments.get(name).taskId) || null,
        assignment: this.assignments.get(name) || null,
        rescue: this.rescues.get(name) || null,
        task: this.assignments.get(name) ? this.assignments.get(name).label : null,
        threats: state.threats || 0,
        equipment: state.equipment || {},
        inventory: state.inventory || {},
        activity: state.activity || 'idle',
        status: emergency ? `${emergency.severity}:${emergency.kind}` : state.connected === false ? 'OFFLINE' : state.spawned === false ? 'JOINING' : !authenticated ? 'AUTHENTICATING' : state.health === 0 ? 'DEAD' : online ? 'OK' : 'NOT_READY',
        emergency: emergency ? { kind: emergency.kind, severity: emergency.severity, id: emergency.id } : null,
        deaths: state.deaths || 0,
        uptimeMs: state.uptimeMs || 0,
        lastUpdate: state.lastUpdate || null
      };
    });
    return {
      team: {
        leader: this.leader,
        enabled: this.enabled,
        formation: this.formation,
        online: bots.filter((b) => b.online).length,
        tick: this.ticks,
        uptimeMs: this.now() - this.startedAt,
        lastTickDurationMs: Number(this.lastTickDurationMs.toFixed(2)),
        objectives: this.objectiveBoard(),
        roles: Object.fromEntries(this.roles),
        formationSlots: this.formationSlots().slots,
        separation: this.separationVectors(),
        planning: this.planningStatus()
      },
      bots,
      resources: this.ledger.snapshot(),
      memory: this.memory.summary(),
      emergencies: this.emergencies.summary(),
      comms: this.comms.recent(null, 60),
      diagnostics: {
        tasks: this.board.stats(),
        botsTracked: this.botStates.size,
        memoryBytes: process.memoryUsage().heapUsed,
        tickDurationMs: Number(this.lastTickDurationMs.toFixed(2)),
        lastSummary: this.lastSummary ? {
          assignments: this.lastSummary.assignments.length,
          rescues: this.lastSummary.rescues.length,
          deadlocks: this.lastSummary.deadlocks.length
        } : null
      },
      extras: this.extrasFn ? this.extrasFn() : {}
    };
  }
}

module.exports = { TeamCoordinator, ROLE_BY_TASK, TASK_STATUS };
