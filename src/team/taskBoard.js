'use strict';

const { boxesOverlap } = require('../util/vec');

const TASK_STATUS = Object.freeze({ PENDING: 'PENDING', CLAIMED: 'CLAIMED', ACTIVE: 'ACTIVE', BLOCKED: 'BLOCKED', COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' });
const OBJECTIVE_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' });

let taskSeq = 0;

/**
 * Shared objective + task board.
 *
 * Owns task identity, claiming, reservations (resource locks and spatial
 * regions), dependency tracking, expiry, reassignment and deadlock recovery.
 * Everything is coordinated here so two bots can never claim the same work.
 */
class TaskBoard {
  constructor({ claimTtlMs = 45000, lockTtlMs = 30000, maxTasks = 4000, maxObjectives = 500, now = () => Date.now() } = {}) {
    this.claimTtlMs = claimTtlMs;
    this.lockTtlMs = lockTtlMs;
    this.maxTasks = maxTasks;
    this.maxObjectives = maxObjectives;
    this.now = now;
    this.objectives = new Map();
    this.tasks = new Map();
    this.locks = new Map(); // key -> { owner, acquiredAt, expiresAt, label, reentrant }
    this.regions = new Map(); // id -> { owner, box, label, taskId, expiresAt }
    this.waiters = new Map(); // lock key -> Set(owner)
    this.regionSeq = 0;
    this.events = [];
  }

  _event(type, payload) {
    this.events.push({ at: this.now(), type, ...payload });
    if (this.events.length > 500) this.events.shift();
  }

  // ------------------------------------------------------------------
  // Objectives
  // ------------------------------------------------------------------
  createObjective(spec) {
    if (!spec || !spec.title) throw new Error('objective requires a title');
    if (this.objectives.size >= this.maxObjectives) {
      const terminal = [...this.objectives.values()]
        .filter((objective) => objective.status !== OBJECTIVE_STATUS.ACTIVE)
        .sort((a, b) => (a.completedAt || a.createdAt) - (b.completedAt || b.createdAt));
      while (this.objectives.size >= this.maxObjectives && terminal.length) {
        this.objectives.delete(terminal.shift().id);
      }
      if (this.objectives.size >= this.maxObjectives) throw new Error(`objective limit reached (${this.maxObjectives})`);
    }
    const id = spec.id || `obj-${this.objectives.size + 1}-${Date.now().toString(36)}`;
    if (this.objectives.has(id)) throw new Error(`objective ${id} already exists`);
    const objective = {
      id,
      title: spec.title,
      description: spec.description || '',
      priority: spec.priority === undefined ? 50 : spec.priority,
      status: spec.status || OBJECTIVE_STATUS.ACTIVE,
      createdAt: this.now(),
      requirements: spec.requirements || {},
      assignedBots: spec.assignedBots || [],
      dependencies: spec.dependencies || [],
      progress: spec.progress || { current: 0, target: 1, unit: 'steps' },
      completionCondition: spec.completionCondition || 'all tasks complete',
      failureCondition: spec.failureCondition || 'unrecoverable task failure',
      recoveryStrategy: spec.recoveryStrategy || 'regenerate tasks',
      tasks: [],
      metadata: spec.metadata || {}
    };
    this.objectives.set(id, objective);
    this._event('objective.created', { objectiveId: id, title: objective.title });
    return objective;
  }

  getObjective(id) { return this.objectives.get(id) || null; }
  listObjectives(status = null) { return [...this.objectives.values()].filter((o) => !status || o.status === status); }

  updateObjective(id, patch) {
    const obj = this.objectives.get(id);
    if (!obj) return null;
    Object.assign(obj, patch);
    return obj;
  }

  refreshObjectiveProgress(id) {
    const obj = this.objectives.get(id);
    if (!obj) return null;
    const tasks = obj.tasks.map((tid) => this.tasks.get(tid)).filter(Boolean);
    if (!tasks.length) return obj;
    let current = 0;
    let target = 0;
    for (const t of tasks) {
      current += t.units.current || 0;
      target += t.units.target || 0;
    }
    obj.progress = { current, target: target || tasks.length, unit: obj.progress.unit || 'units' };
    if (tasks.every((t) => t.status === TASK_STATUS.COMPLETED) && obj.status === OBJECTIVE_STATUS.ACTIVE) {
      obj.status = OBJECTIVE_STATUS.COMPLETED;
      obj.completedAt = this.now();
      this._event('objective.completed', { objectiveId: id });
    }
    return obj;
  }

  // ------------------------------------------------------------------
  // Tasks
  // ------------------------------------------------------------------
  addTask(spec) {
    if (!spec || !spec.type) throw new Error('task requires a type');
    if (this.tasks.size >= this.maxTasks) return { ok: false, error: 'task board full' };
    const id = spec.id || `task-${Date.now().toString(36)}-${++taskSeq}-${spec.type.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (this.tasks.has(id)) return { ok: false, error: `duplicate task id ${id}` };
    const task = {
      id,
      objectiveId: spec.objectiveId || null,
      type: spec.type,
      label: spec.label || spec.type,
      priority: spec.priority === undefined ? 50 : spec.priority,
      status: TASK_STATUS.PENDING,
      params: spec.params || {},
      requires: spec.requires || {},
      region: spec.region || null,
      resources: spec.resources || [],
      dependsOn: spec.dependsOn ? spec.dependsOn.slice() : [],
      units: spec.units ? { current: spec.units.current || 0, target: spec.units.target || 1 } : { current: 0, target: 1 },
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      attempts: 0,
      maxAttempts: spec.maxAttempts || 3,
      estimatedMs: spec.estimatedMs || null,
      deadlineAt: spec.deadlineAt || null,
      createdAt: this.now(),
      sourceCommand: spec.sourceCommand ? String(spec.sourceCommand).slice(0, 600) : null,
      createdBy: spec.createdBy || null,
      lastUpdateAt: this.now(),
      lastProgressAt: this.now(),
      startedAt: null,
      completedAt: null,
      lastError: null,
      verification: null,
      stallCycles: 0,
      noProgressSince: null,
      lastProgressValue: 0,
      metadata: spec.metadata || {},
      lockKeys: spec.lockKeys ? spec.lockKeys.slice() : []
    };
    this.tasks.set(id, task);
    if (task.objectiveId) {
      const obj = this.objectives.get(task.objectiveId);
      if (obj) obj.tasks.push(id);
    }
    this._event('task.created', { taskId: id, type: task.type });
    return { ok: true, task };
  }

  getTask(id) { return this.tasks.get(id) || null; }

  listTasks(filter = {}) {
    return [...this.tasks.values()].filter((t) => {
      if (filter.status && t.status !== filter.status) return false;
      if (filter.types && !filter.types.includes(t.type)) return false;
      if (filter.objectiveId && t.objectiveId !== filter.objectiveId) return false;
      if (filter.claimedBy && t.claimedBy !== filter.claimedBy) return false;
      if (filter.unclaimed && t.claimedBy) return false;
      return true;
    });
  }

  dependenciesSatisfied(task) {
    return task.dependsOn.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep && dep.status === TASK_STATUS.COMPLETED;
    });
  }

  /** Claim a specific task (used by individual bot commands). */
  claim(taskId, botId, { force = false } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'unknown task' };
    if (!botId) return { ok: false, error: 'botId required' };
    if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED].includes(task.status)) return { ok: false, error: `task ${task.status}` };
    // Repeated claims by the same owner are idempotent: re-acquiring the
    // resource locks would inflate their reentrancy count and leak them.
    if (task.claimedBy === botId) return { ok: true, task, already: true };
    if (task.claimedBy && task.claimedBy !== botId) {
      if (!force) {
        this._noteWait(botId, `task:${taskId}`);
        return { ok: false, error: `${task.claimedBy} already claimed`, heldBy: task.claimedBy };
      }
      this.release(taskId, task.claimedBy, 'preempted');
    }
    if (!this.dependenciesSatisfied(task)) return { ok: false, error: 'dependencies not satisfied', blockedBy: task.dependsOn.filter((d) => (this.tasks.get(d) || {}).status !== TASK_STATUS.COMPLETED) };
    if (task.attempts >= task.maxAttempts) return { ok: false, error: 'retry limit reached' };

    if (task.region) {
      const conflict = this.regionConflicts(task.region, botId);
      if (conflict) return { ok: false, error: `region conflict with ${conflict.owner}`, heldBy: conflict.owner };
    }
    const acquired = [];
    for (const key of task.lockKeys) {
      const lock = this.acquireLock(key, botId, { label: task.type, taskId: task.id });
      if (!lock.ok) {
        // All-or-nothing: release the locks this claim already took so a
        // partial failure cannot block another bot until the TTL expires.
        for (const held of acquired) this.releaseLock(held, botId);
        return { ok: false, error: `lock ${key} held by ${lock.heldBy}`, heldBy: lock.heldBy };
      }
      acquired.push(key);
    }
    if (task.region) {
      const region = this.reserveRegion(botId, task.region, { taskId: task.id, label: task.label });
      if (!region.ok) {
        for (const held of acquired) this.releaseLock(held, botId);
        return { ok: false, error: region.error, conflict: region.conflict };
      }
    }
    task.claimedBy = botId;
    task.claimedAt = this.now();
    task.claimExpiresAt = this.now() + (task.claimTtlMs || this.claimTtlMs);
    task.status = TASK_STATUS.CLAIMED;
    task.attempts += 1;
    task.lastError = null;
    task.lastUpdateAt = this.now();
    task.stallCycles = 0;
    task.noProgressSince = this.now();
    task.lastProgressValue = task.units.current || 0;
    this._clearWait(botId);
    this._event('task.claimed', { taskId, botId });
    return { ok: true, task };
  }

  /** Claim the best available task for a bot. */
  nextFor(bot, context = {}) {
    const { rankTasksForBot } = require('./allocation');
    const open = this.listTasks({ status: TASK_STATUS.PENDING }).filter((t) => !t.claimedBy && t.attempts < t.maxAttempts);
    const ranked = rankTasksForBot(open, bot, {
      now: this.now(),
      // The real dependency check happens below; scoring must not discard
      // deterministic tasks whose dependencies are already complete.
      dependenciesSatisfied: true
    }).filter((r) => this.dependenciesSatisfied(r.task));
    for (const candidate of ranked) {
      if (candidate.score <= 0) break;
      const res = this.claim(candidate.task.id, bot.name);
      if (res.ok) return { ...res, score: candidate.score, reasons: candidate.reasons };
    }
    return { ok: false, error: 'no suitable task' };
  }

  start(taskId, botId) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'unknown task' };
    if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED].includes(task.status)) return { ok: false, error: `task is already ${task.status.toLowerCase()}` };
    if (task.claimedBy !== botId) return { ok: false, error: 'not claimed by this bot' };
    task.status = TASK_STATUS.ACTIVE;
    task.startedAt = this.now();
    task.claimExpiresAt = this.now() + (task.claimTtlMs || this.claimTtlMs);
    this._event('task.started', { taskId, botId });
    return { ok: true, task };
  }

  heartbeat(taskId, botId) {
    const task = this.tasks.get(taskId);
    if (!task || task.claimedBy !== botId) return false;
    if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED].includes(task.status)) return false;
    task.claimExpiresAt = this.now() + (task.claimTtlMs || this.claimTtlMs);
    for (const [key, lock] of this.locks) {
      // Resource locks acquired by this task (not just the synthetic task lock)
      // must live as long as the task keeps heartbeating. Otherwise a long
      // mine/chop can silently lose its reservation after 30s while the bot
      // still believes it owns the work.
      if (lock.owner === botId && (key.startsWith('task:') || lock.taskId === taskId)) {
        lock.expiresAt = this.now() + this.lockTtlMs;
      }
    }
    for (const region of this.regions.values()) {
      if (region.owner === botId && region.taskId === taskId) region.expiresAt = this.now() + this.lockTtlMs;
    }
    return true;
  }

  updateProgress(taskId, { current, target, note } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (current !== undefined) {
      const next = Number(current);
      if (!Number.isFinite(next)) return null;
      const previous = task.units.current || 0;
      task.units.current = Math.max(0, next);
      task.lastUpdateAt = this.now();
      if (task.units.current > previous) {
        task.noProgressSince = this.now();
        task.lastProgressAt = this.now();
        task.stallCycles = 0;
      }
    }
    if (target !== undefined) {
      const nextTarget = Number(target);
      if (!Number.isFinite(nextTarget)) return null;
      task.units.target = Math.max(0, nextTarget);
    }
    if (note) task.progressNote = note;
    if (task.objectiveId) this.refreshObjectiveProgress(task.objectiveId);
    return task;
  }

  /** Complete a task. Completion requires verification by default. */
  complete(taskId, { by = null, verified = false, notes = '' } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'unknown task' };
    if (task.status === TASK_STATUS.COMPLETED) return { ok: true, already: true, task };
    if (task.status === TASK_STATUS.CANCELLED) return { ok: false, error: 'task was cancelled' };
    if (task.status === TASK_STATUS.FAILED) return { ok: false, error: 'task already failed' };
    // A completion without an owner identity is never trustworthy when the
    // task is claimed; verified work must identify the bot that did it.
    if (task.claimedBy && task.claimedBy !== by) return { ok: false, error: 'completed by non-owner' };
    if (!verified) return { ok: false, error: 'unverified completion rejected' };
    task.status = TASK_STATUS.COMPLETED;
    task.completedAt = this.now();
    task.lastUpdateAt = task.completedAt;
    task.verification = { verifiedBy: by || task.claimedBy, at: this.now(), notes };
    task.units.current = Math.max(task.units.current, task.units.target);
    this._releaseTaskResources(task);
    this._event('task.completed', { taskId, by: by || task.claimedBy });
    if (task.objectiveId) this.refreshObjectiveProgress(task.objectiveId);
    return { ok: true, task };
  }

  fail(taskId, reason, { by = null, retry = true } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'unknown task' };
    if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED].includes(task.status)) {
      return { ok: false, error: `task is already ${task.status.toLowerCase()}`, task };
    }
    if (task.claimedBy && task.claimedBy !== by) return { ok: false, error: 'not owner' };
    task.lastError = reason || 'unknown failure';
    task.lastUpdateAt = this.now();
    this._releaseTaskResources(task);
    if (retry && task.attempts < task.maxAttempts) {
      task.status = TASK_STATUS.PENDING;
      task.claimedBy = null;
      task.claimExpiresAt = null;
      task.claimedAt = null;
      this._event('task.retry', { taskId, reason: task.lastError });
      return { ok: true, retry: true, task };
    }
    task.status = TASK_STATUS.FAILED;
    task.claimedBy = null;
    this._event('task.failed', { taskId, reason: task.lastError });
    if (task.objectiveId) {
      const obj = this.objectives.get(task.objectiveId);
      if (obj) {
        obj.status = OBJECTIVE_STATUS.FAILED;
        obj.blockedReason = task.lastError;
        obj.failure = { taskId: task.id, type: task.type, label: task.label, reason: task.lastError, at: this.now() };
        obj.completedAt = this.now();
        // A failed objective must not keep spending the team's time. Cancel
        // the sibling work it can no longer complete, so no ACTIVE rows are
        // left running under a FAILED objective.
        for (const other of this.tasks.values()) {
          if (other.objectiveId !== obj.id || other.id === task.id) continue;
          if ([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED].includes(other.status)) continue;
          this.cancel(other.id, `objective failed: ${task.lastError}`);
        }
      }
    }
    return { ok: true, retry: false, task };
  }

  /**
   * Re-open a failed objective without creating a duplicate. This is the
   * planner's retry primitive: the same objective id, the same task rows and
   * the same history are reused, so repeated failures can never accumulate a
   * row of near-identical objectives on the dashboard.
   */
  reopenObjective(objectiveId, { reason = 'retry' } = {}) {
    const obj = this.objectives.get(objectiveId);
    if (!obj) return { ok: false, error: 'unknown objective' };
    if (obj.status === OBJECTIVE_STATUS.COMPLETED) return { ok: false, error: 'objective already completed' };
    obj.status = OBJECTIVE_STATUS.ACTIVE;
    obj.reopenCount = (obj.reopenCount || 0) + 1;
    obj.reopenedAt = this.now();
    obj.blockedReason = null;
    obj.failure = null;
    obj.completedAt = null;
    let reopened = 0;
    for (const taskId of obj.tasks || []) {
      const task = this.tasks.get(taskId);
      if (!task || task.status === TASK_STATUS.COMPLETED) continue;
      task.status = TASK_STATUS.PENDING;
      task.claimedBy = null;
      task.claimedAt = null;
      task.claimExpiresAt = null;
      task.attempts = 0;
      task.lastError = null;
      task.completedAt = null;
      task.stallCycles = 0;
      task.noProgressSince = null;
      task.lastProgressValue = task.units ? task.units.current : 0;
      reopened++;
    }
    this._event('objective.reopened', { objectiveId, reason, tasks: reopened });
    return { ok: true, objective: obj, reopened, reason };
  }

  release(taskId, botId = null, reason = 'released') {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'unknown task' };
    if (botId && task.claimedBy && task.claimedBy !== botId) return { ok: false, error: 'not owner' };
    this._releaseTaskResources(task, botId || task.claimedBy);
    task.claimedBy = null;
    task.claimedAt = null;
    task.claimExpiresAt = null;
    if (task.status === TASK_STATUS.CLAIMED || task.status === TASK_STATUS.ACTIVE) task.status = TASK_STATUS.PENDING;
    this._event('task.released', { taskId, reason });
    return { ok: true, task };
  }

  cancel(taskId, reason = 'cancelled') {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'unknown task' };
    if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.FAILED].includes(task.status)) {
      return { ok: false, error: `task is already ${task.status.toLowerCase()}`, task };
    }
    this._releaseTaskResources(task);
    task.status = TASK_STATUS.CANCELLED;
    task.claimedBy = null;
    task.lastError = reason || 'cancelled';
    task.lastUpdateAt = this.now();
    this._event('task.cancelled', { taskId, reason });
    return { ok: true, task };
  }

  _releaseTaskResources(task, owner = null) {
    const botId = owner || task.claimedBy;
    if (botId) {
      this.releaseLock(`task:${task.id}`, botId);
      for (const key of task.lockKeys) this.releaseLock(key, botId);
      this.releaseRegions(botId, task.id);
      this._clearWait(botId);
    }
  }

  /** Release expired claims and locks so a crashed bot cannot block the team. */
  expire(at = this.now()) {
    const released = [];
    for (const task of this.tasks.values()) {
      if ((task.status === TASK_STATUS.CLAIMED || task.status === TASK_STATUS.ACTIVE) && task.claimExpiresAt && task.claimExpiresAt <= at) {
        const owner = task.claimedBy;
        this.release(task.id, owner, 'claim expired');
        released.push({ taskId: task.id, owner });
      }
    }
    for (const [key, lock] of [...this.locks]) {
      // Expiry is authoritative. Keeping a reentrant lock forever because its
      // count is >1 was a real leak: a crashed bot that had re-acquired a lock
      // left every other bot blocked until a full restart.
      if (lock.expiresAt <= at) this.locks.delete(key);
    }
    for (const [id, region] of [...this.regions]) {
      if (region.expiresAt <= at) this.regions.delete(id);
    }
    for (const [key, owners] of [...this.waiters]) {
      if (owners.size === 0) this.waiters.delete(key);
    }
    return released;
  }

  // ------------------------------------------------------------------
  // Resource locks
  // ------------------------------------------------------------------
  acquireLock(key, owner, { ttlMs = this.lockTtlMs, label = '', taskId = null } = {}) {
    const existing = this.locks.get(key);
    const now = this.now();
    if (existing && existing.owner === owner) {
      existing.reentrant += 1;
      existing.expiresAt = now + ttlMs;
      if (taskId && !existing.taskId) existing.taskId = taskId;
      return { ok: true, lock: existing, reentrant: true };
    }
    if (existing && existing.expiresAt > now && existing.owner !== owner) {
      this._noteWait(owner, key);
      return { ok: false, error: 'lock held', heldBy: existing.owner };
    }
    const lock = { key, owner, acquiredAt: now, expiresAt: now + ttlMs, label, taskId, reentrant: 1 };
    this.locks.set(key, lock);
    this._clearWait(owner);
    return { ok: true, lock };
  }

  releaseLock(key, owner) {
    const lock = this.locks.get(key);
    if (!lock) return false;
    if (owner && lock.owner !== owner) return false;
    lock.reentrant -= 1;
    if (lock.reentrant <= 0) this.locks.delete(key);
    return true;
  }

  releaseAllLocks(owner) {
    let released = 0;
    for (const [key, lock] of [...this.locks]) {
      if (lock.owner === owner) { this.locks.delete(key); released++; }
    }
    this._clearWait(owner);
    return released;
  }

  isLocked(key) {
    const lock = this.locks.get(key);
    return Boolean(lock && lock.expiresAt > this.now());
  }

  locksHeldBy(owner) {
    return [...this.locks.values()].filter((l) => l.owner === owner);
  }

  _noteWait(owner, key) {
    if (!this.waiters.has(key)) this.waiters.set(key, new Set());
    this.waiters.get(key).add(owner);
  }

  _clearWait(owner) {
    for (const [key, owners] of this.waiters) {
      owners.delete(owner);
      if (owners.size === 0) this.waiters.delete(key);
    }
  }

  // ------------------------------------------------------------------
  // Spatial reservations
  // ------------------------------------------------------------------
  reserveRegion(owner, box, { label = '', taskId = null, ttlMs = this.lockTtlMs } = {}) {
    const conflict = this.regionConflicts(box, owner);
    if (conflict) return { ok: false, error: 'region overlap', conflict };
    const id = `region-${++this.regionSeq}`;
    this.regions.set(id, { id, owner, box, label, taskId, expiresAt: this.now() + ttlMs, reservedAt: this.now() });
    return { ok: true, id };
  }

  regionConflicts(box, owner) {
    if (!box) return null;
    for (const region of this.regions.values()) {
      if (region.owner === owner) continue;
      if (region.expiresAt <= this.now()) continue;
      if (boxesOverlap(region.box, box)) return region;
    }
    return null;
  }

  releaseRegions(owner, taskId = null) {
    let released = 0;
    for (const [id, region] of [...this.regions]) {
      if (region.owner === owner && (!taskId || region.taskId === taskId)) { this.regions.delete(id); released++; }
    }
    return released;
  }

  regionsFor(owner) { return [...this.regions.values()].filter((r) => r.owner === owner); }

  // ------------------------------------------------------------------
  // Deadlock detection
  // ------------------------------------------------------------------
  detectDeadlocks() {
    const edges = new Map(); // owner -> Set(owner)
    const addEdge = (from, to) => {
      if (!from || !to || from === to) return;
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from).add(to);
    };
    for (const task of this.tasks.values()) {
      if (!task.claimedBy) continue;
      if (task.status !== TASK_STATUS.CLAIMED && task.status !== TASK_STATUS.ACTIVE) continue;
      for (const depId of task.dependsOn) {
        const dep = this.tasks.get(depId);
        if (dep && dep.status !== TASK_STATUS.COMPLETED && dep.claimedBy && dep.claimedBy !== task.claimedBy) {
          addEdge(task.claimedBy, dep.claimedBy);
        }
      }
    }
    for (const [key, owners] of this.waiters) {
      const holder = this.locks.get(key);
      if (!holder) continue;
      for (const waiter of owners) addEdge(waiter, holder.owner);
    }
    // Classic DFS cycle search, deterministic ordering.
    const nodes = [...edges.keys()].sort();
    const state = new Map(); // 0 unvisited, 1 in stack, 2 done
    const cycles = [];
    const stack = [];
    const visit = (node) => {
      state.set(node, 1);
      stack.push(node);
      const next = [...(edges.get(node) || [])].sort();
      for (const n of next) {
        if (!state.has(n) || state.get(n) === 0) visit(n);
        else if (state.get(n) === 1) {
          const idx = stack.indexOf(n);
          if (idx !== -1) cycles.push(stack.slice(idx));
        }
      }
      stack.pop();
      state.set(node, 2);
    };
    for (const node of nodes) if ((state.get(node) || 0) === 0) visit(node);

    // Deduplicate cycles by their sorted member set.
    const seen = new Set();
    return cycles.filter((cycle) => {
      const key = cycle.slice().sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((cycle) => {
      const tasks = this.listTasks().filter((t) => cycle.includes(t.claimedBy) && (t.status === TASK_STATUS.CLAIMED || t.status === TASK_STATUS.ACTIVE));
      return { members: cycle, tasks: tasks.map((t) => t.id) };
    });
  }

  /** Break deadlocks by preempting the lowest-priority claimed task in a cycle. */
  resolveDeadlocks() {
    const cycles = this.detectDeadlocks();
    const resolutions = [];
    for (const cycle of cycles) {
      const candidates = cycle.tasks
        .map((id) => this.tasks.get(id))
        .filter(Boolean)
        .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
      if (!candidates.length) continue;
      const victim = candidates[0];
      const owner = victim.claimedBy;
      this.release(victim.id, owner, 'deadlock preemption');
      resolutions.push({ taskId: victim.id, releasedFrom: owner, cycle: cycle.members });
      this._event('deadlock.resolved', { taskId: victim.id, cycle: cycle.members });
    }
    return resolutions;
  }

  stats({ deadlocks = null } = {}) {
    const byStatus = {};
    for (const t of this.tasks.values()) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    return {
      objectives: this.objectives.size,
      activeObjectives: this.listObjectives(OBJECTIVE_STATUS.ACTIVE).length,
      tasks: this.tasks.size,
      byStatus,
      locks: this.locks.size,
      regions: this.regions.size,
      claims: [...this.tasks.values()].filter((t) => t.claimedBy).length,
      deadlocks: deadlocks === null ? this.detectDeadlocks().length : deadlocks.length
    };
  }

  /** Compact JSON snapshot for persistence. Functions are never stored. */
  toJSON() {
    return {
      objectives: [...this.objectives.values()],
      tasks: [...this.tasks.values()],
      locks: [...this.locks.entries()],
      regions: [...this.regions.entries()],
      regionSeq: this.regionSeq,
      taskSeq
    };
  }

  load(data) {
    if (!data) return;
    this.objectives = new Map((data.objectives || []).map((o) => [o.id, o]));
    this.tasks = new Map((data.tasks || []).map((t) => [t.id, t]));
    this.locks = new Map(data.locks || []);
    this.regions = new Map(data.regions || []);
    this.regionSeq = data.regionSeq || 0;
    if (data.taskSeq) taskSeq = Math.max(taskSeq, data.taskSeq);
  }
}

module.exports = { TaskBoard, TASK_STATUS, OBJECTIVE_STATUS };
