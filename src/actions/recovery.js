'use strict';

const { Logger } = require('../logger');

/**
 * Death-loop recovery state machine.
 *
 * The old runtime treated every respawn as a fresh start. When a bot spawned
 * next to the same zombie pack it died again, resumed the same task and fed the
 * loop. This manager keeps the evidence (when, where and why a bot died),
 * detects a loop and holds the bot in a recovery state until it has survived a
 * quiet period. Only then is its task released for re-planning.
 *
 * States:
 *   ACTIVE       normal work
 *   SUSPECT      one recent death; keep working but watch closely
 *   RECOVERING   death loop / critical health; no task work, heal and retreat
 *   TASK_REPLAN  recovery finished; the old assignment must be released once
 *   SAFE_HOLD    recovery finished but the bot has not proved it can survive
 */
const RECOVERY_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPECT: 'SUSPECT',
  RECOVERING: 'RECOVERING',
  TASK_REPLAN: 'TASK_REPLAN',
  SAFE_HOLD: 'SAFE_HOLD'
});

const DEFAULTS = Object.freeze({
  shortWindowMs: 120000,
  shortThreshold: 3,
  longWindowMs: 600000,
  longThreshold: 5,
  suspectHoldMs: 30000,
  recoverHoldMs: 90000,
  safeHoldMs: 60000,
  criticalHealth: 8,
  historyLimit: 40
});

function iso(ms) {
  return new Date(ms).toISOString();
}

class RecoveryManager {
  constructor({
    botName,
    now = () => Date.now(),
    logger = null,
    shortWindowMs = DEFAULTS.shortWindowMs,
    shortThreshold = DEFAULTS.shortThreshold,
    longWindowMs = DEFAULTS.longWindowMs,
    longThreshold = DEFAULTS.longThreshold,
    suspectHoldMs = DEFAULTS.suspectHoldMs,
    recoverHoldMs = DEFAULTS.recoverHoldMs,
    safeHoldMs = DEFAULTS.safeHoldMs,
    criticalHealth = DEFAULTS.criticalHealth,
    historyLimit = DEFAULTS.historyLimit
  } = {}) {
    if (!botName) throw new Error('RecoveryManager requires a bot name');
    this.botName = botName;
    this.now = now;
    this.logger = logger || new Logger({ level: 'warn' });
    this.shortWindowMs = shortWindowMs;
    this.shortThreshold = shortThreshold;
    this.longWindowMs = longWindowMs;
    this.longThreshold = longThreshold;
    this.suspectHoldMs = suspectHoldMs;
    this.recoverHoldMs = recoverHoldMs;
    this.safeHoldMs = safeHoldMs;
    this.criticalHealth = criticalHealth;
    this.historyLimit = historyLimit;
    this.state = RECOVERY_STATES.ACTIVE;
    this.stateSince = now();
    this.reason = 'started';
    this.deaths = [];
    this.spawns = [];
    this.spawnSafety = null;
    this.lastDeath = null;
    this.lastRecoveryAt = null;
    this.recoveredAt = null;
    this.needsReplan = false;
    this.deathLoop = false;
    this.loopSince = null;
    this.lastHealth = null;
  }

  _setState(state, reason) {
    if (this.state === state) {
      if (reason) this.reason = reason;
      return this.state;
    }
    const from = this.state;
    this.state = state;
    this.stateSince = this.now();
    this.reason = reason || state;
    this.lastTransition = { at: this.stateSince, from, to: state, reason: this.reason };
    this.logger.info(`[${this.botName}] recovery ${from} -> ${state}: ${this.reason}`);
    return this.state;
  }

  _trim(at = this.now()) {
    this.deaths = this.deaths.filter((death) => at - death.at <= this.longWindowMs).slice(-this.historyLimit);
    this.spawns = this.spawns.filter((spawn) => at - spawn.at <= this.longWindowMs).slice(-this.historyLimit);
  }

  /**
   * Record a real death. `cause` is best-effort: Mineflayer does not expose a
   * damage-source packet, so callers pass the last known attacker/death message
   * and this manager never invents one.
   */
  recordDeath({
    at = this.now(),
    position = null,
    cause = 'unknown',
    healthBefore = null,
    food = null,
    threats = [],
    lastDamageAt = null,
    deathMessage = null
  } = {}) {
    const entry = {
      at,
      bot: this.botName,
      position: position ? { ...position } : null,
      cause: cause || 'unknown',
      healthBefore: healthBefore === undefined ? null : healthBefore,
      food: food === undefined ? null : food,
      threats: (threats || []).slice(0, 6).map((threat) => ({
        name: threat.name || threat.type || threat.username || 'unknown',
        distance: threat.distance ?? null,
        hostile: Boolean(threat.hostile),
        username: threat.username || null
      })),
      lastDamageAt: lastDamageAt || null,
      deathMessage: deathMessage || null
    };
    this.deaths.push(entry);
    this._trim(at);
    this.lastDeath = entry;
    this.recoveredAt = null;
    this.spawnSafety = null;

    const recent = this.deaths.filter((death) => at - death.at <= this.shortWindowMs).length;
    const long = this.deaths.filter((death) => at - death.at <= this.longWindowMs).length;
    this.deathLoop = recent >= this.shortThreshold || long >= this.longThreshold;
    if (this.deathLoop && !this.loopSince) this.loopSince = at;
    if (this.deathLoop) {
      this.lastRecoveryAt = at;
      this.needsReplan = true;
      this._setState(RECOVERY_STATES.RECOVERING, `${recent} deaths in ${Math.round(this.shortWindowMs / 1000)}s`);
      this.logger.warn(`[${this.botName}] death loop detected: ${long} death(s) in ${Math.round(this.longWindowMs / 60000)}min; holding autonomy and re-planning work`);
    } else {
      this._setState(RECOVERY_STATES.SUSPECT, `death ${recent} in window; watching for a loop`);
    }
    if (entry.position) this.logger.warn(`[${this.botName}] death recorded at ${entry.position.x},${entry.position.y},${entry.position.z} (cause: ${entry.cause})`);
    return entry;
  }

  /** Assess whether the place the server put the bot is survivable. */
  assessSpawn({ threats = [], health = 20, food = 20, position = null } = {}) {
    const hostiles = threats.filter((threat) => threat && (threat.hostile || threat.type === 'player'));
    const nearest = hostiles.slice().sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999))[0] || null;
    const reasons = [];
    if (nearest) reasons.push(`${nearest.name || nearest.type || 'hostile'} ${Number(nearest.distance).toFixed(1)}m away`);
    if (hostiles.length >= 3) reasons.push(`${hostiles.length} hostiles nearby`);
    if (Number(health) <= this.criticalHealth) reasons.push(`health ${health}`);
    if (Number(food) <= 6) reasons.push(`food ${food}`);
    const safe = reasons.length === 0;
    const assessment = {
      at: this.now(),
      position: position ? { ...position } : null,
      safe,
      score: Math.max(0, 100 - hostiles.length * 20 - (nearest ? Math.max(0, 20 - nearest.distance) : 0) - (Number(health) <= this.criticalHealth ? 30 : 0)),
      threats: hostiles.length,
      nearest: nearest ? { name: nearest.name || nearest.type || 'unknown', distance: nearest.distance ?? null } : null,
      health,
      food,
      reasons
    };
    this.spawnSafety = assessment;
    return assessment;
  }

  recordSpawn({ at = this.now(), position = null, threats = [], health = 20, food = 20 } = {}) {
    const assessment = this.assessSpawn({ threats, health, food, position });
    this.spawns.push({ at, position: position ? { ...position } : null, safe: assessment.safe, reasons: assessment.reasons });
    this._trim(at);
    if (!assessment.safe) {
      this.lastRecoveryAt = at;
      if (this.state !== RECOVERY_STATES.RECOVERING) {
        this._setState(RECOVERY_STATES.RECOVERING, `unsafe spawn: ${assessment.reasons.join(', ')}`);
      }
    }
    return assessment;
  }

  /**
   * Advance the state machine using live health/threat evidence. Safe to call
   * on every safety tick; it never throws and never initiates movement.
   */
  update({ at = this.now(), health = null, food = null, threats = 0, spawnSafe = null } = {}) {
    this.lastHealth = health === null ? this.lastHealth : health;
    const dying = Number.isFinite(health) && health > 0 && health <= this.criticalHealth;
    const threatPressure = Number(threats) >= 3;
    if (this.state === RECOVERY_STATES.ACTIVE || this.state === RECOVERY_STATES.SUSPECT) {
      if (dying || threatPressure || (spawnSafe === false && this.lastDeath)) {
        this.lastRecoveryAt = at;
        this.needsReplan = true;
        this._setState(RECOVERY_STATES.RECOVERING, dying ? `health ${health}` : `${threats} threats nearby`);
      } else if (this.state === RECOVERY_STATES.SUSPECT && at - this.stateSince >= this.suspectHoldMs) {
        this._setState(RECOVERY_STATES.ACTIVE, 'survived the watch window');
        this.deathLoop = false;
        this.loopSince = null;
      }
    } else if (this.state === RECOVERY_STATES.RECOVERING) {
      const quiet = !dying && !threatPressure && (spawnSafe !== false);
      const heldLongEnough = at - this.stateSince >= this.recoverHoldMs;
      if (quiet && heldLongEnough) {
        this._setState(RECOVERY_STATES.TASK_REPLAN, 'recovery window complete; release old work');
        this.recoveredAt = at;
      }
    } else if (this.state === RECOVERY_STATES.TASK_REPLAN) {
      // The runtime consumes the replan request; this state must not persist
      // if no consumer is present, otherwise a bot could never work again.
      const replanExpired = at - this.stateSince >= 15000;
      if (!this.needsReplan || replanExpired) {
        this.needsReplan = false;
        this._setState(RECOVERY_STATES.SAFE_HOLD, 'waiting for a safe survival period');
      }
    } else if (this.state === RECOVERY_STATES.SAFE_HOLD) {
      const survived = Number(health) > this.criticalHealth && !threatPressure && at - this.stateSince >= this.safeHoldMs;
      if (survived) {
        this.deathLoop = false;
        this.loopSince = null;
        this._setState(RECOVERY_STATES.ACTIVE, `survived ${Math.round(this.safeHoldMs / 1000)}s after recovery`);
      }
    }
    return this.status();
  }

  /** Work is blocked while the bot is healing, re-planning or proving safety. */
  canWork() {
    return this.state === RECOVERY_STATES.ACTIVE || this.state === RECOVERY_STATES.SUSPECT;
  }

  needsReplanning() {
    return this.needsReplan || this.state === RECOVERY_STATES.TASK_REPLAN;
  }

  consumeReplan() {
    if (!this.needsReplan && this.state !== RECOVERY_STATES.TASK_REPLAN) return false;
    this.needsReplan = false;
    if (this.state === RECOVERY_STATES.TASK_REPLAN) {
      this._setState(RECOVERY_STATES.SAFE_HOLD, 'old work released; proving safety');
    }
    return true;
  }

  /** Clear the loop only after a genuinely quiet, healthy period. */
  markSafe(at = this.now()) {
    if (this.state === RECOVERY_STATES.SAFE_HOLD && at - this.stateSince >= this.safeHoldMs) {
      this.deathLoop = false;
      this.loopSince = null;
      this._setState(RECOVERY_STATES.ACTIVE, 'safe period confirmed');
      return true;
    }
    return false;
  }

  status() {
    const at = this.now();
    const recent = this.deaths.filter((death) => at - death.at <= this.shortWindowMs).length;
    const long = this.deaths.filter((death) => at - death.at <= this.longWindowMs).length;
    return {
      bot: this.botName,
      state: this.state,
      reason: this.reason,
      stateSince: this.stateSince,
      stateAgeMs: at - this.stateSince,
      canWork: this.canWork(),
      needsReplan: this.needsReplan,
      deathLoop: this.deathLoop,
      deathsRecent: recent,
      deathsLong: long,
      deaths: this.deaths.map((death) => ({
        at: death.at,
        atIso: iso(death.at),
        position: death.position,
        cause: death.cause,
        healthBefore: death.healthBefore,
        food: death.food,
        threats: death.threats,
        deathMessage: death.deathMessage
      })),
      lastDeath: this.lastDeath,
      spawnSafety: this.spawnSafety,
      lastRecoveryAt: this.lastRecoveryAt,
      recoveredAt: this.recoveredAt,
      lastTransition: this.lastTransition || null
    };
  }
}

module.exports = { RecoveryManager, RECOVERY_STATES };
