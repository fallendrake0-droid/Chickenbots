'use strict';

/**
 * One movement owner per bot.
 *
 * Priorities are intentionally small and named. A recovery retreat and an
 * operator `goto` must not be silently overwritten by a routine task path;
 * equal priority supersedes because follow/escort refreshes its own target.
 */
const MOVE_PRIORITY = Object.freeze({
  routine: 0,
  task: 1,
  recovery: 2,
  operator: 3,
  emergency: 4
});

function movePriority(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  return MOVE_PRIORITY[String(value || 'task').toLowerCase()] ?? MOVE_PRIORITY.task;
}

class MotionArbiter {
  constructor({ now = Date.now, generation = () => 0 } = {}) {
    this.now = now;
    this.generation = generation;
    this.current = null;
    this.token = 0;
    this.history = [];
  }

  claim({ priority = 'task', owner = null, timeoutMs = 20000, ttlMs = null, generation = null, goal = null } = {}) {
    this.sweep();
    const now = this.now();
    const wanted = movePriority(priority);
    const active = this.current;
    if (active && active.generation === (generation === null ? this.generation() : generation) && now < active.expiresAt && wanted < active.priority) {
      return {
        ok: false,
        superseded: true,
        reason: `movement is owned by ${active.owner} (priority ${active.priority})`,
        owner: active.owner,
        priority: active.priority,
        motion: active
      };
    }
    const superseded = active ? { ...active } : null;
    if (active) this.cancel(`superseded by ${owner || priority}`, { record: false });
    const ttl = Number(ttlMs);
    const timeout = Math.max(1000, Number(timeoutMs) || 20000);
    const token = ++this.token;
    const motion = {
      token,
      generation: generation === null ? this.generation() : generation,
      owner: owner || String(priority),
      priority: wanted,
      goal: goal && [goal.x, goal.y, goal.z].every((v) => Number.isFinite(Number(v)))
        ? { x: Number(goal.x), y: Number(goal.y), z: Number(goal.z) } : null,
      startedAt: now,
      expiresAt: now + (Number.isFinite(ttl) && ttl > 0 ? ttl : timeout + 5000)
    };
    this.current = motion;
    this._record({ kind: 'claim', motion, superseded });
    return { ok: true, token, motion, superseded };
  }

  isCurrent(token) {
    return Boolean(this.current && this.current.token === token && token);
  }

  release(token, reason = 'complete') {
    if (!this.isCurrent(token)) return false;
    const motion = this.current;
    this.current = null;
    this._record({ kind: 'release', motion, reason });
    return true;
  }

  cancel(reason = 'cancelled', { token = null, record = true } = {}) {
    if (!this.current) return false;
    if (token && this.current.token !== token) return false;
    const motion = this.current;
    this.current = null;
    this.token += 1;
    if (record) this._record({ kind: 'cancel', motion, reason });
    return true;
  }

  sweep() {
    if (!this.current) return null;
    if (this.now() < this.current.expiresAt) return null;
    const expired = this.current;
    this.current = null;
    this.token += 1;
    this._record({ kind: 'expired', motion: expired });
    return expired;
  }

  snapshot() {
    this.sweep();
    return this.current ? { ...this.current } : null;
  }

  _record(entry) {
    this.history.push({ at: this.now(), ...entry, motion: entry.motion ? { ...entry.motion } : null });
    if (this.history.length > 32) this.history.shift();
  }
}

module.exports = { MOVE_PRIORITY, movePriority, MotionArbiter };
