'use strict';

const { distance2d } = require('../util/vec');
const { toolTier, SWORDS } = require('../world/items');

const SEVERITY = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * Classify a bot's situation into zero or more emergencies. Pure function:
 * the coordinator, the bot itself and tests all classify identically.
 */
function classifyEmergency(state) {
  if (!state || state.connected === false || state.spawned === false) return [];
  const out = [];
  const health = state.health === undefined ? 20 : state.health;
  const food = state.food === undefined ? 20 : state.food;
  const push = (kind, severity, action, details = {}) => out.push({ kind, severity, action, ...details });

  if (state.inLava) push('LAVA', 'CRITICAL', 'SELF_ESCAPE', { note: 'escape lava immediately' });
  if (state.oxygen !== undefined && state.oxygen <= 6 && state.inWater) push('DROWNING', 'CRITICAL', 'SELF_ESCAPE');
  if (state.onFire && !state.inLava) push('FIRE', 'HIGH', 'SELF_ESCAPE');
  if (state.fallDistance !== undefined && state.fallDistance > 4 && state.velocity && state.velocity.y < -0.9) {
    push('FALL', 'CRITICAL', 'CLUTCH', { fallDistance: state.fallDistance });
  }
  if (health <= 4) push('LOW_HEALTH', 'CRITICAL', 'RETREAT', { health });
  else if (health <= 8) push('LOW_HEALTH', 'HIGH', 'RETREAT', { health });

  if (food <= 0) push('STARVATION', 'HIGH', 'SUPPLY', { food });
  else if (food <= 4 && health < 14) push('LOW_FOOD', 'MEDIUM', 'SUPPLY', { food });

  const threats = state.threats || 0;
  const nearestThreat = state.nearestThreatDistance;
  if (threats >= 3 && nearestThreat !== undefined && nearestThreat <= 12) {
    push('SWARM', 'HIGH', 'RETREAT_OR_FIGHT', { threats, nearestThreat });
  } else if (threats >= 1 && (health <= 10 || (state.armor || 0) < 3)) {
    push('OUTMATCHED', 'HIGH', 'ASSIST', { threats, health, armor: state.armor || 0 });
  }
  if (state.trapped) push('TRAPPED', 'MEDIUM', 'UNSTUCK');
  if (state.lost) push('LOST', 'LOW', 'REGROUP');
  return out;
}

class EmergencyManager {
  constructor({ now = () => Date.now(), ttlMs = 90000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.emergencies = new Map();
    this.history = [];
    this.seq = 0;
    this.maxHistory = 500;
    this.maxResolved = 100;
  }

  _trim() {
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    const inactive = [...this.emergencies.values()].filter((e) => e.status !== 'ACTIVE');
    if (inactive.length > this.maxResolved) {
      const drop = new Set(inactive.slice(0, inactive.length - this.maxResolved));
      for (const emergency of drop) this.emergencies.delete(emergency.id);
    }
  }

  report(state) {
    const found = classifyEmergency(state);
    const created = [];
    for (const e of found) {
      const existing = [...this.emergencies.values()].find((em) => em.bot === state.name && em.kind === e.kind && em.status === 'ACTIVE');
      if (existing) {
        existing.lastSeen = this.now();
        existing.severity = e.severity;
        existing.position = state.position ? { ...state.position } : existing.position;
        existing.threats = state.threats || existing.threats;
        continue;
      }
      const emergency = {
        id: `em-${++this.seq}`,
        bot: state.name,
        kind: e.kind,
        severity: e.severity,
        action: e.action,
        position: state.position ? { ...state.position } : null,
        dimension: state.dimension || 'overworld',
        health: state.health,
        food: state.food,
        threats: state.threats || 0,
        details: e,
        status: 'ACTIVE',
        responders: [],
        createdAt: this.now(),
        lastSeen: this.now()
      };
      this.emergencies.set(emergency.id, emergency);
      this.history.push({ at: this.now(), type: 'reported', ...emergency, details: undefined });
      created.push(emergency);
    }
    this._trim();
    return created;
  }

  get(id) { return this.emergencies.get(id) || null; }

  active() {
    return [...this.emergencies.values()].filter((e) => e.status === 'ACTIVE');
  }

  byBot(name) { return this.active().filter((e) => e.bot === name); }

  highest() {
    const active = this.active();
    if (!active.length) return null;
    return active.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.createdAt - b.createdAt)[0];
  }

  /**
   * Choose responders. Deliberately conservative: never sends the whole team
   * into a lethal situation, never sends the victim, never sends a bot that is
   * itself critical.
   */
  planRescue(emergency, states, { maxResponders = 2, teamSize = states.length } = {}) {
    const candidates = states.filter((s) => s.name !== emergency.bot && s.connected !== false && s.spawned !== false);
    const healthy = candidates.filter((s) => (s.health === undefined ? 20 : s.health) >= 12 && (s.food === undefined ? 20 : s.food) >= 8);
    const emergencyCounts = {};
    for (const e of this.active()) {
      for (const r of e.responders) emergencyCounts[r.name] = (emergencyCounts[r.name] || 0) + 1;
    }
    const available = healthy.filter((s) => (emergencyCounts[s.name] || 0) === 0);
    const pool = available.length ? available : [];
    const victimPos = emergency.position;

    const scored = pool.map((s) => {
      let score = 0;
      const d = victimPos && s.position ? distance2d(s.position, victimPos) : 9999;
      score += Math.max(0, 80 - d) * 1.2;
      score += (s.health === undefined ? 20 : s.health) * 2;
      score += (s.food === undefined ? 20 : s.food);
      if (s.equipment && s.equipment.sword) score += s.equipment.sword * 8;
      else score += Math.max(0, toolTier(Object.keys(s.inventory || {}).find((n) => SWORDS[n]) || '', SWORDS)) * 8;
      score += (s.armor || 0) * 2;
      if (s.currentTaskId) score -= 6;
      return { state: s, score, distance: d };
    }).sort((a, b) => b.score - a.score || a.state.name.localeCompare(b.state.name));

    let strategy = 'ASSIST';
    let responders = scored.slice(0, maxResponders).map((s) => ({
      name: s.state.name,
      role: emergency.kind === 'STARVATION' || emergency.kind === 'LOW_FOOD' ? 'SUPPLY' : 'RESCUE',
      distance: Math.round(s.distance)
    }));
    let withholdReason = null;

    if (emergency.action === 'SELF_ESCAPE' || emergency.action === 'CLUTCH') {
      strategy = 'SELF_RESCUE';
      responders = responders.slice(0, 1); // one nearby bot as backup only
    } else if (emergency.kind === 'SWARM' && emergency.threats >= 5) {
      const strong = scored.filter((s) => (s.state.health || 20) >= 16 && (s.state.armor || 0) >= 4);
      if (strong.length >= 2 && teamSize >= 4) {
        strategy = 'TEAM_ENGAGE';
        responders = strong.slice(0, 2).map((s) => ({ name: s.state.name, role: 'FRONTLINE', distance: Math.round(s.distance) }));
      } else {
        strategy = 'REGROUP_AND_RETREAT';
        responders = [];
        withholdReason = 'threat too strong for available equipment';
      }
    } else if (emergency.kind === 'TRAPPED' || emergency.kind === 'LOST') {
      strategy = 'NAVIGATION_ASSIST';
      responders = responders.slice(0, 1);
    } else if (emergency.kind === 'STARVATION' || emergency.kind === 'LOW_FOOD') {
      strategy = 'FOOD_SUPPLY';
      const withFood = scored.filter((s) => Object.keys(s.inventory || {}).some((n) => /(bread|cooked_|carrot|potato|apple|beef|porkchop|mutton|chicken|salmon|cod)/.test(n)));
      responders = (withFood.length ? withFood : scored).slice(0, 1).map((s) => ({ name: s.state.name, role: 'SUPPLY', distance: Math.round(s.distance) }));
      if (!responders.length) withholdReason = 'no bot carries food';
    } else if (emergency.severity === 'CRITICAL') {
      // Lava/drowning/fall: self-rescue first, one backup.
      strategy = 'SELF_RESCUE';
      responders = responders.slice(0, 1);
    }

    // Never strip the team of every defender while the victim's threats remain.
    if (teamSize >= 3 && responders.length >= teamSize - 1 && emergency.severity !== 'CRITICAL') {
      responders = responders.slice(0, Math.max(0, teamSize - 2));
      withholdReason = withholdReason || 'preserve team defence';
    }

    return { emergencyId: emergency.id, strategy, responders, withholdReason, considered: scored.length };
  }

  dispatch(emergencyId, responder, role = 'RESCUE') {
    const emergency = this.emergencies.get(emergencyId);
    if (!emergency) return { ok: false, error: 'unknown emergency' };
    if (emergency.responders.some((r) => r.name === responder)) return { ok: true, duplicate: true };
    emergency.responders.push({ name: responder, role, at: this.now() });
    return { ok: true, emergency };
  }

  markResponderArrived(emergencyId, responder) {
    const emergency = this.emergencies.get(emergencyId);
    if (!emergency) return false;
    const r = emergency.responders.find((x) => x.name === responder);
    if (!r) return false;
    r.arrivedAt = this.now();
    return true;
  }

  resolve(emergencyId, { confirmedSafe = false, reason = '' } = {}) {
    const emergency = this.emergencies.get(emergencyId);
    if (!emergency) return { ok: false, error: 'unknown emergency' };
    emergency.status = confirmedSafe ? 'RESOLVED' : 'UNCONFIRMED';
    emergency.resolvedAt = this.now();
    emergency.resolution = { confirmedSafe, reason };
    this.history.push({ at: this.now(), type: 'resolved', id: emergencyId, confirmedSafe, reason });
    this._trim();
    return { ok: true, emergency };
  }

  /** Auto-resolve when the bot has been healthy and unthreatened for a while. */
  refresh(states, { graceMs = 15000 } = {}) {
    const byName = new Map(states.map((s) => [s.name, s]));
    const resolved = [];
    for (const emergency of this.active()) {
      const state = byName.get(emergency.bot);
      if (!state) {
        if (this.now() - emergency.lastSeen > this.ttlMs) {
          // Losing telemetry is not evidence of safety. Keep the emergency in
          // the explicit UNCONFIRMED state so the dashboard does not report a
          // disconnected or invisible bot as rescued.
          this.resolve(emergency.id, { confirmedSafe: false, reason: 'bot gone; outcome unknown' });
          resolved.push(emergency.id);
        }
        continue;
      }
      const stillAtRisk = classifyEmergency(state).some((e) => e.kind === emergency.kind);
      if (stillAtRisk) { emergency.lastSeen = this.now(); continue; }
      const calm = (state.threats || 0) === 0 && (state.health === undefined ? 20 : state.health) > 12;
      if (calm && this.now() - emergency.lastSeen > graceMs) {
        this.resolve(emergency.id, { confirmedSafe: true, reason: 'state recovered' });
        resolved.push(emergency.id);
      }
    }
    return resolved;
  }

  summary() {
    const active = this.active();
    return {
      active: active.map((e) => ({
        id: e.id, bot: e.bot, kind: e.kind, severity: e.severity, strategy: e.action,
        responders: e.responders.map((r) => r.name), ageMs: this.now() - e.createdAt
      })),
      resolvedRecently: [...this.emergencies.values()].filter((e) => e.status === 'RESOLVED').slice(-10).length,
      total: this.emergencies.size
    };
  }
}

module.exports = { EmergencyManager, classifyEmergency, SEVERITY };
