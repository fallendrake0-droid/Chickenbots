'use strict';

const { COMBAT_ROLES } = require('./constants');
const { profileFor, isHostile } = require('./mobs');

const TEAM_COMBAT_MODES = Object.freeze(['TEAM_FIGHT', 'DEFENSIVE', 'GUARD', 'FOLLOW', 'ARENA', 'BOSS', 'RETREAT', 'ESCORT']);

const ROLE_OFFSETS = {
  FRONTLINE: { angle: 0, distance: 2.2 },
  FLANKER: { angle: Math.PI / 2, distance: 2.6 },
  RANGED: { angle: Math.PI, distance: 8 },
  SUPPORT: { angle: -Math.PI / 2, distance: 5 },
  COORDINATOR: { angle: Math.PI / 4, distance: 6 }
};

/**
 * Ten-bot combat coordinator. It assigns dynamic roles, one focus target,
 * different approach bearings and shared retreat/rescue decisions. It never
 * takes control of a controller's emergency response: survival actions remain
 * local and can pre-empt these assignments.
 */
class TeamCombatCoordinator {
  constructor({ controllers = [], comms = null, memory = null, now = () => Date.now() } = {}) {
    this.controllers = controllers;
    this.comms = comms;
    this.memory = memory;
    this.now = now;
    this.enabled = true;
    this.mode = 'TEAM_FIGHT';
    this.roles = {};
    this.focus = null;
    this.focusSince = 0;
    this.locks = new Map();
    this.flankBearing = {};
    this.lastPlanAt = 0;
    this.stats = { plans: 0, focusChanges: 0, retreats: 0, rescues: 0, heals: 0, roleChanges: 0 };
    this._rolesAt = 0;
    this._roleSnapshot = {};
    this.lastRescueAt = 0;
    this.lastHealAt = 0;
  }

  list() { return (this.controllers || []).filter(Boolean); }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.releaseLocks();
    return { ok: true, enabled: this.enabled };
  }

  setMode(mode) {
    const value = String(mode || '').toUpperCase();
    if (!TEAM_COMBAT_MODES.includes(value)) return { ok: false, error: `unknown team combat mode ${mode}` };
    this.mode = value;
    return { ok: true, mode: value };
  }

  attach(controller) {
    if (!controller) return;
    this.controllers = this.controllers || [];
    if (!this.controllers.includes(controller)) this.controllers.push(controller);
  }

  _statusOf(controller) {
    try {
      // Scheduling needs health/armour/totem/weapon facts, not a full threat
      // assessment. summary() is O(inventory) and never scans entities.
      if (typeof controller.summary === 'function') return controller.summary();
      return controller.status();
    } catch (_) {
      return { bot: controller.bot ? controller.bot.name : 'unknown', health: 20, armor: null, weapon: null, totems: 0, state: 'IDLE' };
    }
  }

  assignRoles({ force = false } = {}) {
    const list = this.list();
    if (!list.length) return this.roles;
    if (!force && this.now() - this._rolesAt < 3000) return this.roles;
    const scored = list.map((controller) => {
      const status = this._statusOf(controller);
      const weapon = status.weapon || {};
      const ranged = Boolean(weapon.ranged || (status.loadout && status.loadout.ranged) || (status.loadout && status.loadout.gear && status.loadout.gear.weapons.some((entry) => entry.ranged && entry.available)));
      const armor = Number(status.armorPoints || status.armor?.points || 0);
      const totems = Number(status.totems || 0);
      const health = Number(status.health || 0);
      const score = health + armor * 1.5 + Math.min(6, totems * 2) + (ranged ? 2 : 0);
      return { controller, status, ranged, armor, totems, health, score };
    }).sort((a, b) => b.score - a.score);
    const assigned = {};
    const used = new Set();
    const coordinator = scored.find((entry) => !entry.ranged) || scored[0];
    assigned[coordinator.controller.bot.name] = 'COORDINATOR';
    used.add(coordinator.controller.bot.name);
    const ranged = scored.find((entry) => entry.ranged && !used.has(entry.controller.bot.name));
    if (ranged) { assigned[ranged.controller.bot.name] = 'RANGED'; used.add(ranged.controller.bot.name); }
    const support = scored.filter((entry) => !used.has(entry.controller.bot.name)).sort((a, b) => (b.totems + b.armor) - (a.totems + a.armor))[0];
    if (support) { assigned[support.controller.bot.name] = 'SUPPORT'; used.add(support.controller.bot.name); }
    const flank = scored.find((entry) => !used.has(entry.controller.bot.name) && entry.health <= 20);
    if (flank) { assigned[flank.controller.bot.name] = 'FLANKER'; used.add(flank.controller.bot.name); }
    for (const entry of scored) if (!used.has(entry.controller.bot.name)) assigned[entry.controller.bot.name] = 'FRONTLINE';
    const changed = list.some((controller) => this.roles[controller.bot.name] !== assigned[controller.bot.name]);
    this.roles = assigned;
    this._rolesAt = this.now();
    if (changed) this.stats.roleChanges++;
    return this.roles;
  }

  roleFor(controller) { return this.roles[controller.bot.name] || 'FRONTLINE'; }

  /** Choose one focus target; focus changes are rate-limited to avoid flip-flopping. */
  chooseFocus(threats = [], { commit = true } = {}) {
    const viable = threats.filter((threat) => threat.player || (isHostile(threat) && !profileFor(threat).neutral));
    if (!viable.length) {
      if (!commit) return null;
      this.focus = null; this.focusSince = 0; return null;
    }
    const scored = viable.map((threat) => {
      const profile = profileFor(threat);
      const health = threat.health === undefined ? 20 : threat.health;
      const distance = Number(threat.distance) || 0;
      const avoidPenalty = profile.avoid ? 35 : 0;
      const score = profile.threat * 1.4 + (40 - Math.min(40, health)) * 0.7 - distance * 0.8 - avoidPenalty;
      return { threat, profile, score };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (this.focus && this.now() - this.focusSince < 2500 && best.threat.id !== this.focus.id) {
      const previous = viable.find((threat) => threat.id === this.focus.id);
      if (previous) return previous;
    }
    // Read-only callers (dashboard status) may inspect the focus without
    // resetting its hysteresis window or inflating focus-change statistics.
    if (!commit) return best.threat;
    if (!this.focus || this.focus.id !== best.threat.id) this.stats.focusChanges++;
    this.focus = best.threat;
    this.focusSince = this.now();
    return best.threat;
  }

  /** Assign focus and a unique approach bearing to each bot in the fight. */
  plan(controller, threats = []) {
    this.assignRoles();
    const focus = this.chooseFocus(threats);
    this.lastPlanAt = this.now();
    this.stats.plans++;
    if (!focus) return { focus: null, role: this.roleFor(controller), offset: null };
    if (!focus.position) return { focus, role: this.roleFor(controller), offset: null, reason: 'focus has no position' };
    this.locks.set(focus.id, (this.locks.get(focus.id) || []).length ? this.locks.get(focus.id) : []);
    const role = this.roleFor(controller);
    if (!this.flankBearing[controller.bot.name]) {
      const index = this.list().indexOf(controller);
      this.flankBearing[controller.bot.name] = (index < 0 ? 0 : index) * (Math.PI * 2 / Math.max(1, this.list().length));
    }
    const roleOffset = ROLE_OFFSETS[role] || ROLE_OFFSETS.FRONTLINE;
    const angle = this.flankBearing[controller.bot.name] + roleOffset.angle;
    // Ranged roles hold their distance; melee roles spread around the target
    // but never end up outside a sword's reach.
    const radius = role === 'RANGED' ? roleOffset.distance : Math.min(roleOffset.distance, 2.4);
    const offset = {
      x: Number((focus.position.x + Math.cos(angle) * radius).toFixed(1)),
      z: Number((focus.position.z + Math.sin(angle) * radius).toFixed(1))
    };
    const assigned = this.locks.get(focus.id) || [];
    if (!assigned.includes(controller.bot.name)) assigned.push(controller.bot.name);
    this.locks.set(focus.id, assigned);
    return { focus, role, offset, distance: roleOffset.distance, focusBots: assigned.slice() };
  }

  /** Drop a dead/disconnected bot from target locks and flank bearings. */
  releaseBot(name) {
    let removed = 0;
    for (const [id, bots] of [...this.locks.entries()]) {
      const next = bots.filter((bot) => bot !== name);
      if (next.length !== bots.length) { removed++; this.locks.set(id, next); }
      if (!next.length) this.locks.delete(id);
    }
    delete this.flankBearing[name];
    return { ok: true, bot: name, removed };
  }

  releaseLocks(targetId = null) {
    if (targetId === null) this.locks.clear();
    else this.locks.delete(targetId);
    return { ok: true, locks: this.locks.size };
  }

  teammateInDanger() {
    const list = this.list();
    return list
      .map((controller) => ({ controller, status: this._statusOf(controller) }))
      .filter((entry) => Number(entry.status.health || 20) <= 8)
      .sort((a, b) => a.status.health - b.status.health)[0] || null;
  }

  /** Automatic rescue pass, rate-limited so one victim is not swarmed twice. */
  async autoRescue({ cooldownMs = 8000, minRescuerHealth = 10, timeBudgetMs = 8000 } = {}) {
    if (!this.enabled) return { ok: false, idle: true, reason: 'team combat is disabled' };
    const danger = this.teammateInDanger();
    if (!danger) return { ok: true, idle: true, reason: 'no teammate in danger' };
    if (this.lastRescueAt && this.now() - this.lastRescueAt < cooldownMs) {
      return { ok: true, idle: true, reason: 'rescue cooldown', victim: danger.controller.bot.name };
    }
    const victim = danger.controller;
    const candidates = this.list().filter((entry) => entry !== victim && Number(this._statusOf(entry).health || 0) >= minRescuerHealth);
    if (!candidates.length) return { ok: false, error: 'no healthy rescuer available', victim: victim.bot.name };
    candidates.sort((a, b) => {
      const av = a.bot.position ? Math.hypot(a.bot.position.x - victim.bot.position.x, a.bot.position.z - victim.bot.position.z) : 999;
      const bv = b.bot.position ? Math.hypot(b.bot.position.x - victim.bot.position.x, b.bot.position.z - victim.bot.position.z) : 999;
      return av - bv;
    });
    this.lastRescueAt = this.now();
    return this.rescue(victim, { deadlineAt: this.now() + Math.max(1000, Number(timeBudgetMs) || 8000) });
  }

  /** Physically hand a spare golden apple to an injured teammate. */
  async assistHealing({ cooldownMs = 12000, maxHealth = 14, timeBudgetMs = 5000 } = {}) {
    if (!this.enabled) return { ok: false, idle: true, reason: 'team combat is disabled' };
    if (this.lastHealAt && this.now() - this.lastHealAt < cooldownMs) return { ok: true, idle: true, reason: 'healing cooldown' };
    const candidates = this.list()
      .map((controller) => ({ controller, status: this._statusOf(controller) }))
      .filter((entry) => Number(entry.status.health || 0) > 0 && Number(entry.status.health || 0) <= maxHealth)
      .sort((a, b) => Number(a.status.health) - Number(b.status.health));
    const victimEntry = candidates[0];
    if (!victimEntry) return { ok: true, idle: true, reason: 'no injured teammate' };
    const victim = victimEntry.controller;
    if (Number(this._statusOf(victim).goldenApples || 0) > 0) return { ok: true, idle: true, reason: 'victim already carries a golden apple', victim: victim.bot.name };
    const donors = this.list()
      .filter((entry) => entry !== victim && Number(entry.bot.countItem('golden_apple') || 0) > 1)
      .sort((a, b) => {
        const av = a.bot.position ? Math.hypot(a.bot.position.x - victim.bot.position.x, a.bot.position.z - victim.bot.position.z) : 999;
        const bv = b.bot.position ? Math.hypot(b.bot.position.x - victim.bot.position.x, b.bot.position.z - victim.bot.position.z) : 999;
        return av - bv;
      });
    const donor = donors[0];
    if (!donor) return { ok: false, idle: true, reason: 'no donor with a spare golden apple', victim: victim.bot.name };
    this.lastHealAt = this.now();
    await donor.bot.goNear?.(victim.bot, 2, {
      timeoutMs: Math.max(1000, Number(timeBudgetMs) || 5000),
      priority: 'recovery', owner: `team-healing:${victim.bot.name}`
    });
    const before = Number(victim.bot.countItem('golden_apple') || 0);
    const toss = await donor.bot.tossItem('golden_apple', 1);
    if (!toss || toss.ok === false) return { ok: false, error: (toss && toss.error) || 'toss failed', victim: victim.bot.name, donor: donor.bot.name };
    let delivered = false;
    if (typeof victim.bot.addItem === 'function') {
      victim.bot.addItem('golden_apple', 1);
      delivered = true;
    } else if (typeof victim.bot.refreshInventory === 'function') {
      await new Promise((resolve) => setTimeout(resolve, 900));
      victim.bot.refreshInventory();
      delivered = Number(victim.bot.countItem('golden_apple') || 0) > before;
    }
    if (!delivered) return { ok: false, error: 'teammate did not pick up the tossed golden apple', victim: victim.bot.name, donor: donor.bot.name };
    this.stats.heals++;
    if (this.comms && typeof this.comms.send === 'function') {
      try { this.comms.send('ASSISTANCE_DISPATCHED', donor.bot.name, { kind: 'healing', victim: victim.bot.name, item: 'golden_apple' }); } catch (_) { /* ignore */ }
    }
    return { ok: true, donor: donor.bot.name, victim: victim.bot.name, item: 'golden_apple', goldenApples: Number(victim.bot.countItem('golden_apple') || 0) };
  }

  async rescue(controller = null, { deadlineAt = 0 } = {}) {
    if (!this.enabled) return { ok: false, error: 'team combat is disabled' };
    const victim = controller || (this.teammateInDanger() && this.teammateInDanger().controller);
    if (!victim) return { ok: true, idle: true, reason: 'no teammate in danger' };
    const candidates = this.list().filter((entry) => entry !== victim);
    if (!candidates.length) return { ok: false, error: 'no rescuer available' };
    candidates.sort((a, b) => {
      const av = a.bot.position ? Math.hypot(a.bot.position.x - victim.bot.position.x, a.bot.position.z - victim.bot.position.z) : 999;
      const bv = b.bot.position ? Math.hypot(b.bot.position.x - victim.bot.position.x, b.bot.position.z - victim.bot.position.z) : 999;
      return av - bv;
    });
    const rescuer = candidates[0];
    this.stats.rescues++;
    const result = await (typeof rescuer.protectTeammate === 'function'
      ? rescuer.protectTeammate(victim, { deadlineAt })
      : { ok: false, error: 'rescuer has no team protection routine' });
    if (this.comms && typeof this.comms.send === 'function') {
      try { this.comms.send('ASSISTANCE_DISPATCHED', rescuer.bot.name, { victim: victim.bot.name, bot: rescuer.bot.name }); } catch (_) { /* ignore */ }
    }
    return { ok: result.ok !== false, rescuer: rescuer.bot.name, victim: victim.bot.name, ...result };
  }

  async retreat(reason = 'team retreat') {
    this.mode = 'RETREAT';
    this.stats.retreats++;
    const results = [];
    for (const controller of this.list()) {
      results.push({ bot: controller.bot.name, ...(await controller.retreat(null, { reason, team: true })) });
    }
    this.releaseLocks();
    if (this.comms && typeof this.comms.send === 'function') {
      try { this.comms.send('TEAM_REGROUP', 'combat', { reason }); } catch (_) { /* ignore */ }
    }
    return { ok: true, reason, results };
  }

  async regroup() {
    const results = [];
    for (const controller of this.list()) {
      results.push({ bot: controller.bot.name, ...(await controller.regroup()) });
    }
    this.releaseLocks();
    this.mode = 'TEAM_FIGHT';
    return { ok: true, results };
  }

  /**
   * `controllerStatus` lets a dashboard snapshot reuse the per-controller
   * status objects it already built. Recomputing them here (and again inside
   * runtime.state) tripled the entity/equipment work on every poll.
   */
  status({ controllerStatus = null } = {}) {
    const statusOf = (controller) => {
      if (controllerStatus instanceof Map) {
        const cached = controllerStatus.get(controller.bot.name);
        if (cached) return cached;
      }
      return this._statusOf(controller);
    };
    return {
      enabled: this.enabled,
      mode: this.mode,
      roles: this.roles,
      availableRoles: COMBAT_ROLES,
      focus: this.focus ? { id: this.focus.id, name: this.focus.name || this.focus.username || this.focus.type, type: this.focus.type, health: this.focus.health, distance: this.focus.distance, position: this.focus.position, priority: this.focus.profile ? this.focus.profile.threat : undefined } : null,
      locks: [...this.locks.entries()].map(([id, bots]) => ({ targetId: id, bots })),
      engaged: this.list().filter((controller) => ['APPROACHING', 'REPOSITIONING', 'ENGAGING', 'DODGING', 'DEFENDING', 'HEALING', 'RETREATING', 'TOTEM_EMERGENCY'].includes(controller.state)).length,
      bots: this.list().map((controller) => {
        const status = statusOf(controller);
        return {
          bot: controller.bot.name,
          role: this.roleFor(controller),
          state: status.state,
          target: status.target,
          health: status.health,
          armorPoints: status.armorPoints || status.armor?.points || 0,
          weapon: status.weapon ? status.weapon.name : null,
          offhand: status.offhand || null,
          totems: status.totems || 0,
          goldenApples: status.goldenApples || 0,
          focus: this.focus ? (this.focus.name || this.focus.username || this.focus.type) : null,
          retreating: controller.state === 'RETREATING',
          distance: this.focus && controller.bot.position && this.focus.position
            ? Number(Math.hypot(controller.bot.position.x - this.focus.position.x, controller.bot.position.z - this.focus.position.z).toFixed(1))
            : undefined
        };
      }),
      stats: { ...this.stats },
      lastPlanAt: this.lastPlanAt ? new Date(this.lastPlanAt).toISOString() : null
    };
  }
}

module.exports = { TEAM_COMBAT_MODES, TeamCombatCoordinator, ROLE_OFFSETS };
