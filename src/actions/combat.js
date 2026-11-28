'use strict';

const { config } = require('../config');
const { Logger } = require('../logger');
const { distance } = require('../util/vec');
const { isTeammate, isHostile: legacyHostile, moveAway, STATUS_SCAN_BUDGET_MS } = require('./common');
const { COMBAT_STATES, ACTION_PRIORITY, COMBAT_MODES } = require('../combat/constants');
const { isHostile, isNeutral, isPlayer, profileFor } = require('../combat/mobs');
const { selectWeapon, optimizeArmor, gearStatus } = require('../combat/equipment');
const { TotemManager } = require('../combat/totems');
const { chooseFood, choosePotion, consumeItem, suppliesStatus } = require('../combat/supplies');
const { PvpPolicy } = require('../combat/players');

const ANIMALS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mushroom_cow', 'horse', 'donkey', 'mule', 'llama', 'goat']);
const NEVER_ATTACK = new Set(['villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'wolf', 'cat', 'ocelot', 'parrot', 'fox', 'panda', 'polar_bear', 'bee', 'allay', 'axolotl', 'turtle', 'dolphin', 'squid', 'glow_squid', 'bat', 'frog', 'tadpole', 'strider', 'zombified_piglin', 'piglin']);

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * V6 combat agent. One instance per bot owns its state machine, equipment,
 * totem, supply and target decisions. A shared TeamCombatCoordinator supplies a
 * focus target, role and approach bearing but never overrides local survival.
 */
class CombatController {
  constructor({
    bot, team = null, combatTeam = null, memory = null, logger = null, comms = null,
    pvp = config.autonomy.pvp, pve = config.autonomy.pve, pvpTargets = [], protectedPlayers = [], mode = 'BALANCED',
    meta = null, config: combatConfig = {}
  } = {}) {
    if (!bot) throw new Error('CombatController requires a bot');
    this.bot = bot;
    this.team = team;
    this.combatTeam = combatTeam;
    this.memory = memory;
    this.comms = comms;
    this.logger = logger || new Logger({ level: 'warn' });
    this.pvp = new PvpPolicy({ enabled: Boolean(pvp), targets: pvpTargets, protectedPlayers, teamNames: config.team.names });
    this.playerRegistry = null;
    this.defending = null;
    this.mode = COMBAT_MODES.includes(String(mode).toUpperCase()) ? String(mode).toUpperCase() : 'BALANCED';
    this.state = 'IDLE';
    this.stateSince = Date.now();
    this.policy = {
      autoTotem: true, autoHeal: true, autoArmour: true, autoWeapon: true,
      autoFood: true, autoPotions: true, autoShield: true, autoRetreat: true,
      allowEnchantedGoldenApple: true,
      retreatHealth: config.survival.fleeHealth,
      criticalHealth: config.survival.criticalHealth,
      eatHealth: config.survival.eatAtHealth,
      ...combatConfig
    };
    this.stats = {
      attacks: 0, hits: 0, misses: 0, kills: 0, retreats: 0, threatAssessments: 0,
      damageDealt: 0, damageReceived: 0, totemActivations: 0, goldenApples: 0,
      potions: 0, deaths: 0, rescues: 0, weaponSwitches: 0, armourSwitches: 0,
      shieldBlocks: 0, dodges: 0, playerKills: 0, verifiedKills: 0
    };
    this.events = [];
    this.stopRequested = false;
    this.target = null;
    this.lastAction = null;
    this.lastAttackAt = 0;
    this.lastWeapon = null;
    this.lastArmorSignature = null;
    this.killedIds = new Set();
    this.totems = new TotemManager({ bot, team, comms, reserve: 1, criticalReserve: 1 });
    this.guardPosition = null;
    this.pveEnabled = pve !== false;
    this.armed = true;
    this._meta = meta || bot.itemMeta || {};
    this.serverPvp = Boolean(bot.serverPvp === undefined ? config.autonomy.serverPvp !== false : bot.serverPvp);
    this.lastPlan = null;
    this.followTarget = null;
    this._followBackoffUntil = 0;
    this._followFailures = 0;
    this._deadNotified = false;
  }

  get ready() { return this.bot.ready !== false && this.bot.health > 0; }
  get meta() { return this._meta || this.bot.itemMeta || {}; }

  _setState(state, detail = null) {
    if (!COMBAT_STATES.includes(state)) throw new Error(`invalid combat state ${state}`);
    if (this.state !== state) {
      this.events.push({ at: new Date().toISOString(), type: 'state', from: this.state, to: state, detail });
      if (this.events.length > 250) this.events.shift();
      this.state = state;
      this.stateSince = Date.now();
    }
    return state;
  }

  _record(type, payload = {}) {
    const entry = { at: new Date().toISOString(), type, ...payload };
    this.events.push(entry);
    if (this.events.length > 250) this.events.shift();
    if (this.bot && typeof this.bot.recordCombatEvent === 'function') this.bot.recordCombatEvent(entry);
    return entry;
  }

  attachTeam(combatTeam) {
    this.combatTeam = combatTeam;
    return { ok: true, team: Boolean(combatTeam) };
  }

  setPolicy(patch = {}) {
    const allowed = ['autoTotem', 'autoHeal', 'autoArmour', 'autoWeapon', 'autoFood', 'autoPotions', 'autoShield', 'autoRetreat', 'allowEnchantedGoldenApple'];
    for (const [key, value] of Object.entries(patch)) if (allowed.includes(key)) this.policy[key] = Boolean(value);
    return { ok: true, policy: { ...this.policy } };
  }

  setMode(mode) {
    const value = String(mode || '').toUpperCase();
    if (!COMBAT_MODES.includes(value)) return { ok: false, error: `unknown combat mode ${mode}` };
    this.mode = value;
    return { ok: true, mode: this.mode };
  }

  arm() { this.armed = true; return { ok: true, armed: true }; }
  disarm() { this.armed = false; return { ok: true, armed: false }; }
  setPve(enabled) { this.pveEnabled = Boolean(enabled); this.armed = this.pveEnabled || this.pvp.enabled; return { ok: true, pveEnabled: this.pveEnabled, armed: this.armed }; }
  setAuto(key, enabled) {
    const map = { armour: 'autoArmour', weapon: 'autoWeapon', totem: 'autoTotem', food: 'autoFood', potions: 'autoPotions', shield: 'autoShield', retreat: 'autoRetreat', heal: 'autoHeal' };
    const field = map[String(key || '').toLowerCase()];
    if (!field) return { ok: false, error: `unknown automation '${key}'` };
    this.policy[field] = Boolean(enabled);
    return { ok: true, automation: key, enabled: this.policy[field] };
  }

  setPvp(enabled) {
    const body = this.pvp.setEnabled(enabled);
    if (enabled) this.armed = true;
    else {
      // Disabling PvP must cancel an engagement already in progress; otherwise
      // an attack loop keeps hitting a target after the operator revoked it.
      this.stop();
      if (this.target && isPlayer(this.target)) this.target = null;
    }
    return body;
  }

  _playerValidation(player, { explicit = true, defending = false } = {}) {
    this._refreshDefence();
    const row = this.playerRegistry && typeof this.playerRegistry.getRow === 'function'
      ? this.playerRegistry.getRow(player && (player.username || player.name))
      : null;
    const botDimension = this.bot.dimension || (this.bot.game && this.bot.game.dimension) || null;
    return this.pvp.canEngage(player, {
      position: this.bot.position,
      serverPvp: this.serverPvp,
      explicit,
      defending: defending || this._isDefending(player),
      // The entity handed to attackEntity / selected by assess is live. The
      // registry contributes UUID/dimension but cannot make a visible player
      // look stale just because another bot's cache is older.
      online: true,
      positionFresh: true,
      dimension: row ? row.dimension : null,
      botDimension
    });
  }

  /** Turn a real recent attack from an authorised player into defensive evidence. */
  _refreshDefence() {
    const attacker = this.bot.lastAttacker;
    if (!attacker || !attacker.name) return false;
    const at = Number(this.bot.lastDamageAt) || 0;
    if (!at || Date.now() - at > 30000) return false;
    const name = String(attacker.name).toLowerCase();
    if (!this.pvp.targets.has(name)) return false;
    if (attacker.type && attacker.type !== 'player' && attacker.type !== 'human') return false;
    this.noteDefence(name);
    return true;
  }

  addTarget(name) {
    const added = this.pvp.addTarget(name);
    if (added.ok && this.playerRegistry) this.playerRegistry.attachPolicy(this.pvp);
    return added;
  }
  removeTarget(name) {
    const removed = this.pvp.removeTarget(name);
    const key = String(name || '').toLowerCase();
    if (removed.ok && removed.removed && this.target && isPlayer(this.target)
      && String(this.target.username || this.target.name || '').toLowerCase() === key) {
      this.stop();
      this.target = null;
    }
    return removed;
  }
  protect(name) { return this.pvp.protect(name); }
  unprotect(name) { return this.pvp.unprotect(name); }
  trust(name) { return this.pvp.trust(name); }
  untrust(name) { return this.pvp.untrust(name); }
  noteDefence(name) {
    if (!name) return;
    this.defending = { name: String(name).toLowerCase(), at: Date.now() };
  }
  _isDefending(player) {
    if (!this.defending) return false;
    if (Date.now() - this.defending.at > 30000) { this.defending = null; return false; }
    return this.defending.name === String((player && (player.username || player.name)) || '').toLowerCase();
  }

  /** Hostile/authorised entities only. Teammates and neutrals are filtered out. */
  assess(radius = 16, { commitFocus = true, record = true, budgetMs = 0 } = {}) {
    if (record) this.stats.threatAssessments++;
    // Defensive mode needs evidence before assessment decides who is a valid
    // threat. A fresh hit from a named player is that evidence.
    this._refreshDefence();
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;
    let scanned = 0;
    let budgetExceeded = false;
    const raw = typeof this.bot.entitiesNear === 'function'
      ? this.bot.entitiesNear(radius)
      : [];
    const threats = [];
    if (!this.bot.position || !Number.isFinite(Number(this.bot.position.x)) || !Number.isFinite(Number(this.bot.position.y)) || !Number.isFinite(Number(this.bot.position.z))) {
      this.stats.invalidPositions = (this.stats.invalidPositions || 0) + 1;
      return { threats: [], count: 0, nearest: null, focus: null, health: this.bot.health, food: this.bot.food, outmatched: false, totems: this.totems.count(), pvpEnabled: this.pvp.enabled, state: this.state, invalidPosition: true };
    }
    for (const entity of raw) {
      if (deadline && (++scanned & 31) === 0 && Date.now() >= deadline) { budgetExceeded = true; break; }
      if (!entity || entity.alive === false || !entity.position) continue;
      if (![entity.position.x, entity.position.y, entity.position.z].every((value) => Number.isFinite(Number(value)))) {
        this.stats.invalidEntityPositions = (this.stats.invalidEntityPositions || 0) + 1;
        continue;
      }
      if (isTeammate(entity, this.team)) continue;
      const profile = profileFor(entity);
      const name = String(entity.name || entity.type || '').toLowerCase();
      if (isPlayer(entity)) {
        if (!this.pvp.enabled) continue;
        if (!this.pvp.isAuthorized(entity)) continue;
      } else if (!this.pveEnabled || !isHostile(entity) || NEVER_ATTACK.has(name) || profile.neutral) {
        // Neutrals, pets and conditional hostiles require an explicit order;
        // PvE combat disabled means no hostile mob is auto-engaged either.
        continue;
      }
      const rawDistance = distance(entity.position, this.bot.position);
      if (!Number.isFinite(rawDistance)) {
        this.stats.invalidEntityPositions = (this.stats.invalidEntityPositions || 0) + 1;
        continue;
      }
      const dist = Number(rawDistance.toFixed(1));
      threats.push({
        ...entity,
        distance: dist,
        profile,
        player: isPlayer(entity),
        danger: profile.threat + (entity.health === undefined ? 0 : (20 - entity.health)) * 0.5 - dist * 0.5
      });
    }
    threats.sort((a, b) => b.danger - a.danger);
    const nearest = [...threats].sort((a, b) => a.distance - b.distance)[0] || null;
    const focus = this.combatTeam && this.combatTeam.enabled
      ? this.combatTeam.chooseFocus(threats, { commit: commitFocus })
      : null;
    return {
      threats, count: threats.length, nearest, focus,
      health: this.bot.health, food: this.bot.food,
      outmatched: threats.length >= 3 || threats.some((threat) => threat.profile.boss || threat.profile.keepDistance),
      totems: this.totems.count(),
      pvpEnabled: this.pvp.enabled,
      state: this.state,
      budgetExceeded
    };
  }

  /**
   * Cheap decision summary for team scheduling. It deliberately does not run
   * assess() or gearStatus(): CombatTeam.assignRoles() called the full status
   * for every bot every five ticks and that synchronous pass was the 5.7s
   * launch-actions block in the live log.
   */
  summary() {
    const bot = this.bot;
    const armorPoints = typeof bot.armorPoints === 'function'
      ? Number(bot.armorPoints() || 0)
      : Number((this.armorPoints || 0));
    const count = (name) => (typeof bot.countItem === 'function' ? Number(bot.countItem(name) || 0) : 0);
    const ranged = count('bow') > 0 || count('crossbow') > 0;
    const melee = typeof bot.bestToolFor === 'function' ? bot.bestToolFor('sword') : null;
    const weapon = melee ? { ...(typeof melee === 'string' ? { name: melee } : melee), ranged: false } : null;
    return {
      bot: bot.name,
      health: bot.health,
      food: bot.food,
      state: this.state,
      armed: this.armed,
      armorPoints,
      armor: { points: armorPoints },
      weapon,
      loadout: { ranged, gear: { weapons: ranged ? [{ name: 'bow', ranged: true, available: true }] : [] } },
      totems: this.totems ? this.totems.count() : count('totem_of_undying'),
      pvpEnabled: this.pvp ? this.pvp.enabled : false
    };
  }

  status() {
    // Status is polled by the dashboard every second. It must not commit a
    // focus target, reset the focus hysteresis or inflate threat statistics.
    const assessment = this.assess(16, { commitFocus: false, record: false, budgetMs: STATUS_SCAN_BUDGET_MS });
    const gear = gearStatus({ inventory: this.bot.inventory, meta: this.meta, target: this.target });
    return {
      bot: this.bot.name,
      health: this.bot.health,
      food: this.bot.food,
      state: this.state,
      mode: this.mode,
      armed: this.armed,
      pveEnabled: this.pveEnabled,
      threats: assessment.threats.length,
      nearestThreat: assessment.nearest,
      target: this.target ? { id: this.target.id, name: this.target.name || this.target.username || this.target.type, distance: this.target.distance } : null,
      plan: this.lastPlan ? { role: this.lastPlan.role, offset: this.lastPlan.offset, focus: this.lastPlan.focus ? (this.lastPlan.focus.name || this.lastPlan.focus.username || this.lastPlan.focus.type) : null } : null,
      outmatched: assessment.outmatched,
      pvpEnabled: this.pvp.enabled,
      pvp: { ...this.pvp.status(), serverPvp: this.serverPvp },
      sword: this.bot.bestToolFor ? this.bot.bestToolFor('sword') : null,
      shield: Boolean(this.bot.countItem('shield')),
      weapon: gear.bestWeapon ? { name: gear.bestWeapon.name, damage: gear.bestWeapon.effectiveDamage, dps: gear.bestWeapon.dps, durability: gear.bestWeapon.durability } : null,
      armor: gear.armor,
      armorPoints: gear.armor.points,
      offhand: this.totems.offhand(),
      totems: this.totems.count(),
      goldenApples: Number(this.bot.countItem('golden_apple') || 0),
      enchantedGoldenApples: Number(this.bot.countItem('enchanted_golden_apple') || 0),
      supplies: suppliesStatus({ inventory: this.bot.inventory, meta: this.meta, bot: this.bot }),
      loadout: { gear, role: this.combatTeam ? this.combatTeam.roleFor(this) : null },
      policy: { ...this.policy },
      lastAction: this.lastAction,
      stats: { ...this.stats },
      totemStatus: this.totems.status(),
      events: this.events.slice(-15)
    };
  }

  /** Follow a teammate bot or an observed player without ever auto-attacking a protected player. */
  async follow(target, { distance = 4 } = {}) {
    if (!target) return { ok: false, error: 'follow requires a bot or player name' };
    if (typeof target === 'string') {
      this.followTarget = { kind: 'player', name: String(target).toLowerCase(), distance };
      this.mode = 'FOLLOW';
      this._setState('FOLLOWING', this.followTarget.name);
      return { ok: true, mode: this.mode, follow: { kind: 'player', name: this.followTarget.name, distance }, visible: false };
    }
    if (!target.position && !target.name) return { ok: false, error: 'invalid follow target' };
    this.followTarget = { kind: 'bot', bot: target, name: target.name, distance };
    this.mode = 'FOLLOW';
    this._setState('FOLLOWING', target.name);
    return { ok: true, mode: this.mode, follow: { kind: 'bot', name: target.name, distance }, distance };
  }

  stopFollow() {
    this.followTarget = null;
    this._followBackoffUntil = 0;
    this._followFailures = 0;
    if (this.mode === 'FOLLOW') this.mode = 'BALANCED';
    this._setState('IDLE', 'follow stopped');
    return { ok: true, mode: this.mode };
  }

  async followTick({ deadlineAt = 0 } = {}) {
    if (this.mode !== 'FOLLOW' || !this.followTarget) return { ok: false, reason: 'not following' };
    // Formation following runs inside the safety tick. A 20s pathfinder call
    // for a blocked leader used to hold one bot's whole safety pass open and
    // starve the next tick; a short bounded move plus backoff keeps the loop
    // responsive without pretending the bot caught up.
    if (this._followBackoffUntil && Date.now() < this._followBackoffUntil) {
      return { ok: false, action: 'follow', deferred: true, reason: 'follow retry backoff', retryInMs: this._followBackoffUntil - Date.now() };
    }
    let target = this.followTarget.kind === 'bot' ? this.followTarget.bot : null;
    if (!target) {
      target = typeof this.bot.entitiesNear === 'function'
        ? this.bot.entitiesNear(32).find((entity) => String(entity.username || entity.name || '').toLowerCase() === this.followTarget.name)
        : null;
      if (!target) return { ok: false, follow: this.followTarget, visible: false, reason: 'follow target is not visible' };
    }
    if (!target.position) return { ok: false, reason: 'follow target has no position' };
    const dist = distance(this.bot.position, target.position);
    if (!Number.isFinite(dist)) return { ok: false, reason: 'follow target position is not finite' };
    const wanted = this.followTarget.distance || 4;
    if (dist > wanted + 1.5) {
      // Stay inside the safety pass budget. A flat 4 s path inside a 6 s
      // budget queued behind a 3 s operator watch is what made the pass
      // overrun and cancel itself.
      const timeoutMs = deadlineAt ? Math.max(600, Math.min(4000, deadlineAt - Date.now() - 250)) : 4000;
      const move = typeof this.bot.goNear === 'function'
        ? await this.bot.goNear(target, wanted, { timeoutMs, priority: 'task', owner: 'team-follow' })
        : await this.bot.goTo(target.position, { range: wanted, timeoutMs, priority: 'task', owner: 'team-follow' });
      if (move && move.ok === false) {
        this._followFailures = Math.min(6, (this._followFailures || 0) + 1);
        this._followBackoffUntil = Date.now() + Math.min(15000, 1000 * (2 ** this._followFailures));
        return { ok: false, action: 'follow', target: target.name, distance: Number(dist.toFixed(1)), move, visible: true, deferred: true };
      }
      this._followFailures = 0;
      this._followBackoffUntil = 0;
      return { ok: true, action: 'follow', target: target.name, distance: Number(dist.toFixed(1)), move, visible: true };
    }
    this._followFailures = 0;
    this._followBackoffUntil = 0;
    return { ok: true, action: 'follow', target: target.name, distance: Number(dist.toFixed(1)), inRange: true, visible: true };
  }

  /** Called when the bot actually dies; clears stale target and releases team locks. */
  onDeath(reason = 'death') {
    if (!this._deadNotified) {
      this.stats.deaths++;
      this._record('death', { reason, position: { ...this.bot.position } });
      this._deadNotified = true;
    }
    this.target = null;
    this.stopRequested = true;
    this._setState('DEAD', reason);
    if (this.combatTeam && typeof this.combatTeam.releaseBot === 'function') this.combatTeam.releaseBot(this.bot.name);
    return { ok: true, dead: true, state: this.state };
  }

  /** Called after a respawn is observed. Never resumes the old target. */
  onRespawn() {
    if (this.state !== 'DEAD') return { ok: false, reason: 'not dead' };
    this._deadNotified = false;
    this.target = null;
    this.stopRequested = false;
    // Death can remove armour, a weapon or an offhand item. Clear the cached
    // signatures so the next prepare() re-reads the actual inventory instead of
    // believing the dead session's equipment is still equipped.
    this.lastWeapon = null;
    this.lastArmorSignature = null;
    this._setState('RECOVERING', 'respawned');
    return { ok: true, state: this.state };
  }

  stop() {
    this.stopRequested = true;
    this._setState('DISENGAGED', 'operator stop');
    return { ok: true, bot: this.bot.name, stopped: true, state: this.state };
  }

  /**
   * Prepare equipment before an engagement. Armour is optimised as a set; the
   * weapon is selected for the actual target profile.
   */
  async prepare(target = null) {
    this._setState('PREPARING', target ? (target.name || target.type) : 'general');
    const result = { armor: null, weapon: null, offhand: null };
    if (this.policy.autoArmour) {
      const armor = optimizeArmor({ inventory: this.bot.inventory, meta: this.meta, target, preferFlight: false });
      const signature = armor.selected.map((piece) => piece.name).join('|');
      if (signature && signature !== this.lastArmorSignature && typeof this.bot.equipArmor === 'function') {
        const equipped = await this.bot.equipArmor(armor.selected);
        if (equipped && equipped.ok !== false) {
          this.stats.armourSwitches++;
          this.lastArmorSignature = signature;
        }
        result.armor = { ...armor, equipped: Boolean(equipped && equipped.ok !== false) };
      } else {
        result.armor = armor;
      }
    }
    if (this.policy.autoWeapon) {
      const choice = selectWeapon({ inventory: this.bot.inventory, meta: this.meta, target, distance: target ? target.distance : undefined });
      if (choice.ok && choice.weapon.name !== this.lastWeapon && typeof this.bot.equipItem === 'function') {
        const equipped = await this.bot.equipItem(choice.weapon.name, 'hand');
        if (equipped && equipped.ok !== false) {
          if (this.lastWeapon) this.stats.weaponSwitches++;
          this.lastWeapon = choice.weapon.name;
          this._setState('WEAPON_SWITCHING', choice.weapon.name);
          this._setState('PREPARING', 'weapon ready');
        }
        result.weapon = { ...choice, equipped: Boolean(equipped && equipped.ok !== false) };
      } else {
        result.weapon = { ...choice, equipped: choice.ok && choice.weapon.name === this.lastWeapon };
      }
    }
    if (this.policy.autoTotem) {
      const assessment = this.assess();
      result.offhand = await this.totems.chooseOffhand({
        threat: target || assessment.nearest,
        health: this.bot.health,
        totalThreats: assessment.count,
        shieldAvailable: this.policy.autoShield ? null : 0
      });
    }
    return result;
  }

  /** Emergency survival pass. Returns a priority action or null. */
  async survivalPass(target = null) {
    const activations = this.totems.checkActivation();
    if (activations.length) {
      this.stats.totemActivations += activations.length;
      this._setState('TOTEM_EMERGENCY', 'totem activated');
      const handled = await this.totems.handleActivation();
      this._record('totem_activated', { handled });
      const healing = await this.heal({ emergency: true, threat: target });
      if (this.bot.health <= this.policy.retreatHealth || (!handled.reserveSafe && this.bot.health <= 12)) {
        return { priority: ACTION_PRIORITY.TOTEM_EMERGENCY, action: 'retreat', reason: 'totem consumed and reserve is low', handled, healing };
      }
      return { priority: ACTION_PRIORITY.TOTEM_EMERGENCY, action: 'totem', handled, healing };
    }
    if (this.bot.health <= this.policy.retreatHealth) {
      if (this.policy.autoRetreat) return { priority: ACTION_PRIORITY.RETREAT, action: 'retreat', reason: `health ${this.bot.health}` };
    }
    if (this.bot.health <= 14 || this.bot.food <= 16) {
      const healed = await this.heal({ threat: target });
      if (healed.did) return { priority: this.bot.health <= 8 ? ACTION_PRIORITY.CRITICAL_HEAL : ACTION_PRIORITY.EAT, action: 'heal', ...healed };
    }
    return null;
  }

  async heal({ emergency = false, threat = null } = {}) {
    if (!this.policy.autoHeal) return { did: false, reason: 'auto healing disabled' };
    const foodChoice = chooseFood({
      inventory: this.bot.inventory, health: this.bot.health, food: this.bot.food,
      saturation: this.bot.saturation, threat,
      allowEnchanted: this.policy.allowEnchantedGoldenApple && emergency,
      emergency
    });
    let used = null;
    if (foodChoice.ok) {
      used = await consumeItem(this.bot, foodChoice.name);
      if (used.consumed !== false) {
        if (/golden_apple/.test(foodChoice.name)) this.stats.goldenApples++;
        this.lastAction = `used ${foodChoice.name}`;
        this._record('consume', { item: foodChoice.name, reason: foodChoice.reason, healthGained: used.healthGained });
        return { did: true, kind: 'food', choice: foodChoice, result: used, verified: used.consumed !== false };
      }
    }
    if (this.policy.autoPotions) {
      const potion = choosePotion({
        inventory: this.bot.inventory, meta: this.meta, bot: this.bot,
        health: this.bot.health, threat
      });
      if (potion && potion.name) {
        const drunk = await consumeItem(this.bot, potion.name);
        if (drunk.consumed !== false) {
          this.stats.potions++;
          this.lastAction = `used ${potion.name}`;
          this._record('potion', { item: potion.name, reason: potion.reason, healthGained: drunk.healthGained });
          return { did: true, kind: 'potion', choice: potion, result: drunk, verified: drunk.consumed !== false };
        }
      }
    }
    return { did: false, food: foodChoice, reason: foodChoice.error || 'no healing item' };
  }

  /** Drink useful buffs before the first swing; never replaces emergency healing. */
  async prebuff(target = null) {
    if (!this.policy.autoPotions) return { ok: false, reason: 'auto potions disabled', used: [] };
    const used = [];
    for (let i = 0; i < 2; i++) {
      const potion = choosePotion({
        inventory: this.bot.inventory, meta: this.meta, bot: this.bot,
        health: this.bot.health, threat: target
      });
      if (!potion || !potion.name) break;
      if (['healing', 'strong_healing', 'regeneration', 'milk'].includes(potion.effect)) break;
      const drunk = await consumeItem(this.bot, potion.name);
      if (drunk.consumed === false) break;
      this.stats.potions++;
      this.lastAction = `used ${potion.name}`;
      this._record('potion', { item: potion.name, reason: potion.reason, prebuff: true });
      used.push({ item: potion.name, effect: potion.effect, reason: potion.reason });
    }
    return { ok: used.length > 0, used };
  }

  /** Brief shield window before an attack. Never blocks while swinging. */
  async shieldWindow(target) {
    if (!this.policy.autoShield || !this.bot.countItem('shield')) return { ok: false, reason: 'no shield' };
    const profile = target ? profileFor(target) : null;
    if (!profile || (!profile.ranged && !profile.projectile)) return { ok: false, reason: 'no projectile threat' };
    if (this.totems.equipped()) return { ok: false, reason: 'totem is in the offhand' };
    const on = await this.bot.useShield?.(true);
    if (on && on.ok !== false) {
      this.stats.shieldBlocks++;
      this._setState('DEFENDING', 'incoming projectile');
      await sleep(this.bot.speed ? 80 : 0);
      await this.bot.useShield?.(false);
      return { ok: true, blocked: true };
    }
    return { ok: false, reason: (on && on.error) || 'shield unavailable' };
  }

  async dodge(target, direction = null) {
    if (!target || !target.position) return { ok: false, error: 'no target' };
    const profile = profileFor(target);
    if (profile.explosive && target.distance <= (profile.retreatBefore || 4)) return { ok: false, reason: 'creeper: create distance instead of strafing' };
    const side = direction || (Date.now() % 2 ? 'left' : 'right');
    if (typeof this.bot.strafe === 'function') {
      const result = await this.bot.strafe(side, { durationMs: 120 });
      if (result && result.ok !== false) {
        this.stats.dodges++;
        this._setState('DODGING', side);
        return { ok: true, direction: side, verified: result.position !== undefined };
      }
    }
    return { ok: false, reason: 'adapter has no strafe primitive' };
  }

  _verifyTarget(target) {
    if (!target) return { alive: null, missing: true, confirmedDeath: false };
    if (target.alive === false) return { alive: false, health: 0, confirmedDeath: true };
    if (target.health !== undefined && target.health <= 0) return { alive: false, health: 0, confirmedDeath: true };
    const live = typeof this.bot.entitiesNear === 'function'
      ? this.bot.entitiesNear(64).find((entity) => entity.id === target.id)
      : null;
    if (live) return { alive: true, health: live.health, confirmedDeath: false };
    // An entity id can vanish because the mob died, because it walked out of
    // render distance, or because the server unloaded it. That is "unknown",
    // not a confirmed kill. The old fallback treated a previously healthy
    // target as alive, but a caller that mutated `alive` could still produce a
    // verified kill with no death evidence.
    return { alive: null, missing: true, confirmedDeath: false, health: target.health };
  }

  async engage(options = {}) {
    const maxAttacks = options.maxAttacks || 10;
    const maxTicks = options.maxTicks || Math.max(20, maxAttacks * 4);
    // A deadline is checked between every blocking phase. It is propagated to
    // pathfinding so a single unreachable goal cannot hold a safety slot for
    // the whole 20-second Mineflayer default.
    const deadlineAt = Number(options.deadlineAt)
      || (Number(options.timeBudgetMs) > 0 ? Date.now() + Number(options.timeBudgetMs) : 0);
    const remainingMs = () => deadlineAt ? Math.max(0, deadlineAt - Date.now()) : null;
    const moveTimeout = (fallback = 8000) => {
      const left = remainingMs();
      return left === null ? fallback : Math.max(250, Math.min(fallback, left));
    };
    this.stopRequested = false;
    this._setState('SCANNING');
    let assessment = this.assess(options.radius || 20);
    if (!assessment.threats.length) {
      this._setState('IDLE', 'no threats');
      return { action: 'defend', ok: true, idle: true, state: this.state, remaining: 0, results: [] };
    }
    let target = options.target || assessment.focus || assessment.threats[0];
    if (target) {
      target = {
        ...target,
        player: isPlayer(target),
        profile: target.profile || profileFor(target),
        distance: target.distance === undefined ? Number(distance(target.position, this.bot.position).toFixed(1)) : target.distance
      };
    }
    if (isPlayer(target)) {
      const validation = this._playerValidation(target, { explicit: true, defending: this._isDefending(target) });
      if (!validation.ok) {
        this._setState('IDLE', validation.error);
        return { action: 'defend', ok: false, error: validation.error, code: validation.code, state: this.state, results: [] };
      }
    }
    if (target.profile && target.profile.avoid && !options.authorizeHighRisk) {
      this._setState('IDLE', 'high-risk entity avoided');
      return { action: 'defend', ok: true, avoided: true, target: target.name || target.type, reason: `${target.name || target.type} requires an explicit high-risk order`, state: this.state, results: [] };
    }
    this.target = target;
    await this.prepare(target);
    const results = [];
    const prebuff = await this.prebuff(target);
    if (prebuff.used.length) results.push({ action: 'potion', ...prebuff });
    let ticks = 0;
    let confirmedKill = false;
    while (ticks < maxTicks && !this.stopRequested) {
      ticks++;
      if (deadlineAt && Date.now() >= deadlineAt) {
        results.push({ action: 'deadline', ok: false, reason: 'safety/action budget exhausted' });
        this._setState('DISENGAGED', 'action budget exhausted');
        break;
      }
      if (!this.ready) { this._setState('IDLE', 'bot not ready'); break; }
      const survival = await this.survivalPass(target);
      if (survival && survival.action === 'retreat') {
        const retreat = await this.retreat(target, { reason: survival.reason, deadlineAt });
        results.push({ action: 'retreat', ...retreat });
        break;
      }
      if (survival && survival.action === 'totem') {
        results.push({ action: 'totem', ...survival });
      }
      if (survival && survival.action === 'heal') {
        this._setState('HEALING', 'consumed healing item');
        results.push({ action: 'heal', ...survival });
      }
      const verified = this._verifyTarget(target);
      if (verified.alive === false) break;
      if (verified.alive === null) {
        this._setState('DISENGAGED', 'target lost; kill unconfirmed');
        results.push({ action: 'lost-target', target: target.name || target.type, confirmed: false });
        break;
      }
      let current = assessment.threats.find((threat) => threat.id === target.id) || null;
      if (!current || !current.position) {
        assessment = this.assess(options.radius || 20);
        current = assessment.threats.find((threat) => threat.id === target.id) || null;
        if (!current) {
          this._setState('DISENGAGED', 'target lost');
          results.push({ action: 'lost-target', target: target.name || target.type });
          break;
        }
      }
      target = current;
      const live = typeof this.bot.entitiesNear === 'function'
        ? this.bot.entitiesNear(64).find((entity) => entity.id === target.id)
        : null;
      if (live && live.position) {
        target = { ...target, position: { ...live.position }, health: live.health, distance: Number(distance(live.position, this.bot.position).toFixed(1)) };
      }
      this.target = target;
      if (target.distance > 3) {
        this._setState('APPROACHING', `closing ${target.distance}`);
        let destination = target.position;
        let planned = false;
        if (this.combatTeam && this.combatTeam.enabled) {
          const plan = this.combatTeam.plan(this, assessment.threats);
          this.lastPlan = plan;
          if (plan.offset) { destination = { y: target.position.y, ...plan.offset }; planned = true; }
        }
        const hasBow = Boolean(this.bot.countItem('bow') || this.bot.countItem('crossbow')) && Boolean(this.bot.countItem('arrow') || this.bot.countItem('firework_rocket'));
        const wantsDistance = hasBow && target.profile && (target.profile.keepDistance || target.profile.ranged);
        const desiredRange = wantsDistance
          ? Math.max(4, Math.min(8, target.profile.preferredRange || 6))
          : Math.min(3, target.profile?.preferredRange || 3);
        const move = planned && typeof this.bot.goTo === 'function'
          ? await this.bot.goTo(destination, { range: wantsDistance ? desiredRange : 1.5, timeoutMs: moveTimeout() })
          : typeof this.bot.goNear === 'function'
            ? await this.bot.goNear(target, desiredRange, { timeoutMs: moveTimeout() })
            : await this.bot.goTo(destination, { range: 2, timeoutMs: moveTimeout() });
        if (move && move.ok === false) {
          results.push({ action: 'move', ok: false, error: move.error });
          this._setState('DISENGAGED', 'cannot reach target');
          break;
        }
        const afterMove = typeof this.bot.entitiesNear === 'function'
          ? this.bot.entitiesNear(64).find((entity) => entity.id === target.id)
          : null;
        if (afterMove && afterMove.position) {
          target = { ...target, position: { ...afterMove.position }, health: afterMove.health, distance: Number(distance(afterMove.position, this.bot.position).toFixed(1)) };
          this.target = target;
        }
      }
      const explosiveClose = Boolean(target.profile && target.profile.explosive && target.distance <= (target.profile.retreatBefore || 4));
      if (explosiveClose && this.bot.health <= 10) {
        await this.retreat(target, { reason: 'explosive proximity and low health', deadlineAt });
        results.push({ action: 'retreat', reason: 'explosive proximity and low health' });
        break;
      }
      const weapon = selectWeapon({ inventory: this.bot.inventory, meta: this.meta, target, distance: target.distance });
      if (!weapon.ok) {
        results.push({ action: 'attack', ok: false, error: weapon.error });
        break;
      }
      if (weapon.weapon.name !== this.lastWeapon && this.policy.autoWeapon && typeof this.bot.equipItem === 'function') {
        const equipped = await this.bot.equipItem(weapon.weapon.name, 'hand');
        if (equipped && equipped.ok !== false) {
          if (this.lastWeapon) this.stats.weaponSwitches++;
          this.lastWeapon = weapon.weapon.name;
        }
      }
      if (target.distance <= 3.2 && target.profile && target.profile.ranged) {
        await this.shieldWindow(target);
        if (typeof this.bot.strafe === 'function') await this.dodge(target);
      }
      this._setState('ENGAGING', weapon.weapon.name);
      const attack = await this.bot.attack(target, { authorizedPlayer: isPlayer(target) && this.pvp.isAuthorized(target), pvpAuthorized: isPlayer(target) && this.pvp.isAuthorized(target) });
      this.stats.attacks++;
      if (attack.ok !== false) {
        this.stats.hits++;
        if (attack.damage) this.stats.damageDealt += Number(attack.damage) || 0;
      } else {
        this.stats.misses++;
      }
      this.lastAttackAt = Date.now();
      results.push({ action: 'attack', target: target.name || target.username || target.type, weapon: weapon.weapon.name, ...attack });
      if (attack.killed) {
        confirmedKill = true;
        this._recordKill(target, { verified: true });
        results.push({ action: 'killed', target: target.name || target.type, verified: true });
        break;
      }
      if (explosiveClose) {
        // Creeper hit-and-run: land one hit, immediately leave the blast radius,
        // then re-approach instead of standing in fuse range.
        const away = await moveAway(this.bot, target.position, 8);
        this._setState('REPOSITIONING', 'creeper hit-and-run');
        results.push({ action: 'retreat', reason: 'creeper hit-and-run', ...away });
        continue;
      }
      const post = this._verifyTarget(target);
      if (post.alive === false && post.confirmedDeath) {
        confirmedKill = true;
        this._recordKill(target, { verified: true });
        results.push({ action: 'killed', target: target.name || target.type, verified: true });
        break;
      }
      if (post.alive === null) {
        this._setState('DISENGAGED', 'target lost; kill unconfirmed');
        results.push({ action: 'lost-target', target: target.name || target.type, confirmed: false });
        break;
      }
      const attackDelay = this.bot.speed ? Math.max(50, Math.round(1000 / (weapon.weapon.attackSpeed || 1))) : 0;
      if (attackDelay > 0 && remainingMs() !== null && remainingMs() < attackDelay) {
        results.push({ action: 'deadline', ok: false, reason: 'safety/action budget exhausted before next attack' });
        break;
      }
      await sleep(attackDelay);
    }
    this._setState('VERIFYING');
    const finalTarget = this.target;
    const finalState = confirmedKill
      ? { alive: false, confirmedDeath: true, killed: true }
      : finalTarget ? this._verifyTarget(finalTarget) : { alive: null, missing: true, confirmedDeath: false };
    if (finalState.alive === false && finalState.confirmedDeath && finalTarget) this._recordKill(finalTarget, { verified: true });
    if (finalState.alive === null) this._setState('DISENGAGED', 'target lost; kill unconfirmed');
    else if (finalState.alive) this._setState('DISENGAGED', 'attack budget exhausted');
    else this._setState('LOOTING', 'target defeated');
    if (finalState.alive === false && finalState.confirmedDeath && typeof this.bot.collectDrops === 'function') {
      const loot = await this.bot.collectDrops();
      results.push({ action: 'loot', ...loot });
    }
    if (this.state === 'LOOTING') this._setState('RECOVERING');
    const remaining = this.assess().threats.length;
    if (remaining === 0) this._setState('IDLE', 'area clear');
    const onlyRetreat = results.length > 0 && results[results.length - 1].action === 'retreat' && !results.some((entry) => entry.action === 'attack');
    return {
      action: onlyRetreat ? 'retreat' : 'defend', ok: results.every((entry) => entry.ok !== false || entry.action === 'retreat'),
      state: this.state, target: finalTarget ? (finalTarget.name || finalTarget.type) : null,
      targetDefeated: finalState.alive === false, remaining, attacks: results.filter((entry) => entry.action === 'attack').length,
      results, stats: { ...this.stats }
    };
  }

  _recordKill(target, { verified = false } = {}) {
    if (!target || this.killedIds.has(target.id)) return;
    this.killedIds.add(target.id);
    if (this.killedIds.size > 1000) {
      const oldest = this.killedIds.values().next().value;
      this.killedIds.delete(oldest);
    }
    this.stats.kills++;
    if (verified) this.stats.verifiedKills++;
    if (target.player) this.stats.playerKills++;
    this.lastAction = `killed ${target.name || target.username || target.type}`;
    this._record('kill', { target: target.name || target.username || target.type, verified, player: Boolean(target.player) });
  }

  async defend(options = {}) {
    return this.engage(options);
  }

  async retreat(threat = null, { reason = null, team = false, deadlineAt = 0 } = {}) {
    this.stats.retreats++;
    this._setState('RETREATING', reason || 'low health');
    await this.totems.equip({ force: false }).catch(() => null);
    if (this.bot.health <= 12) await this.heal({ emergency: true, threat });
    const origin = threat && threat.position
      ? threat.position
      : this.target && this.target.position
        ? this.target.position
        : { x: this.bot.position.x - 1, y: this.bot.position.y, z: this.bot.position.z - 1 };
    const left = Number(deadlineAt) ? Math.max(1000, Math.min(8000, Number(deadlineAt) - Date.now())) : 8000;
    const result = await moveAway(this.bot, origin, team ? 14 : 10, { priority: 'emergency', owner: 'combat-retreat', timeoutMs: left });
    if (this.policy.autoShield && this.bot.useShield && this.totems.offhand() !== 'totem_of_undying') await this.bot.useShield(true);
    const away = threat && threat.position ? distance(this.bot.position, threat.position) : null;
    this.lastAction = 'retreated';
    this._record('retreat', { reason, distance: away, team });
    if (this.comms && typeof this.comms.send === 'function' && team) {
      try { this.comms.send('RETURN_TO_BASE', this.bot.name, { bot: this.bot.name, reason }); } catch (_) { /* ignore */ }
    }
    this._setState('DISENGAGED', 'retreated');
    return {
      action: 'retreat', ok: result.ok !== false, threat: threat ? threat.name || threat.type : null,
      reason, distance: away, verified: result.ok !== false, state: this.state
    };
  }

  async regroup() {
    const home = (this.combatTeam && this.combatTeam.home) || (this.team && this.team.home) || null;
    if (home && home.position) {
      const result = await this.bot.goTo(home.position, { range: 3 });
      this.lastAction = 'regrouped at home';
      this._setState('RECOVERING', 'regrouped');
      return { ok: result.ok !== false, position: home.position, reason: 'outmatched' };
    }
    const away = { x: this.bot.position.x + 8, y: this.bot.position.y, z: this.bot.position.z + 8 };
    const result = await this.bot.goTo(away, { range: 2 });
    this.lastAction = 'regrouped';
    this._setState('RECOVERING', 'regrouped');
    return { ok: result.ok !== false, reason: 'no home set' };
  }

  async protectTeammate(victim, { deadlineAt = 0 } = {}) {
    if (!victim) return { ok: false, error: 'no teammate' };
    this.stats.rescues++;
    this._setState('APPROACHING', `protecting ${victim.bot.name}`);
    const moveTimeout = Number(deadlineAt) ? Math.max(1000, Math.min(5000, Number(deadlineAt) - Date.now())) : 5000;
    await this.bot.goNear(victim.bot, 3, { timeoutMs: moveTimeout, priority: 'recovery', owner: `team-rescue:${victim.bot.name}` });
    const threats = this.assess(12).threats.filter((threat) => distance(threat.position, victim.bot.position) <= 10);
    if (!threats.length) return { ok: true, protected: victim.bot.name, threats: 0 };
    const result = await this.engage({ target: threats[0], maxAttacks: 6, deadlineAt });
    return { ok: result.ok !== false, protected: victim.bot.name, threats: threats.length, engagement: result };
  }

  async guard(position = null) {
    if (position) this.guardPosition = { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
    this.mode = 'GUARD';
    const assessment = this.assess(16);
    if (assessment.threats.length) return this.engage({ radius: 16, maxAttacks: 6 });
    if (this.guardPosition) {
      const move = await this.bot.goTo(this.guardPosition, { range: 3 });
      return { ok: move.ok !== false, action: 'guard', idle: true, position: this.guardPosition, move };
    }
    return { ok: true, action: 'guard', idle: true, position: this.bot.position };
  }

  async duel(name) {
    if (!name) return { ok: false, error: 'duel requires an authorised player name' };
    this.pvp.setEnabled(true);
    const added = this.pvp.addTarget(name);
    if (!added.ok) return added;
    this.mode = 'DUEL';
    this.armed = true;
    return { ok: true, mode: this.mode, target: String(name).toLowerCase(), note: 'authorisation is explicit; server PvP rules still apply' };
  }

  /** Hunt a food animal only. Never targets teammates, players or pets. */
  async hunt({ maxDistance = 24 } = {}) {
    const animals = (this.bot.entitiesNear ? this.bot.entitiesNear(maxDistance) : [])
      .filter((e) => ANIMALS.has(e.name || e.type) && !NEVER_ATTACK.has(e.name || e.type))
      .sort((a, b) => distance(a.position, this.bot.position) - distance(b.position, this.bot.position));
    const target = animals[0];
    if (!target) return { action: 'hunt', ok: true, idle: true, reason: 'no animals nearby' };
    const move = typeof this.bot.goNear === 'function' ? await this.bot.goNear(target, 2) : await this.bot.goTo(target.position, { range: 2 });
    if (move && move.ok === false) return { action: 'hunt', ok: false, error: move.error };
    const attack = await this.bot.attack(target);
    if (attack.ok) { this.stats.attacks++; if (attack.killed) this.stats.kills++; }
    this.lastAction = attack.ok ? `hunted ${target.name || target.type}` : 'hunt failed';
    return { action: 'hunt', target: target.name || target.type, ...attack };
  }

  /** Explicit target validation: teammates, neutrals, protected players and unauthorised players are refused. */
  async attackEntity(entity) {
    if (!entity) return { ok: false, error: 'no target' };
    if (isTeammate(entity, this.team)) return { ok: false, error: 'never attack teammates' };
    const name = entity.name || entity.type || '';
    if (isPlayer(entity)) {
      if (!this.pvp.enabled) return { ok: false, error: 'PvP is disabled; ordinary players are never auto-attacked' };
      const validation = this._playerValidation(entity, { explicit: true, defending: this._isDefending(entity) });
      if (!validation.ok) return { ok: false, error: validation.error, code: validation.code };
      const attack = await this.bot.attack(entity, { authorizedPlayer: true, pvpAuthorized: true });
      if (attack.ok) {
        this.stats.attacks++;
        if (attack.damage) this.stats.damageDealt += Number(attack.damage) || 0;
        if (attack.killed) this._recordKill({ ...entity, player: true }, { verified: true });
      }
      return { ...attack, player: true };
    }
    if (!this.pveEnabled) return { ok: false, error: 'PvE combat is disabled' };
    if (NEVER_ATTACK.has(name) || ANIMALS.has(name) || isNeutral(entity)) return { ok: false, error: `not a hostile target: ${name}` };
    if (!isHostile(entity) && legacyHostile(entity) === false) return { ok: false, error: `refusing to attack ${name}` };
    const prep = await this.prepare(entity);
    const result = await this.bot.attack(entity);
    if (result.ok) {
      this.stats.attacks++;
      if (result.damage) this.stats.damageDealt += Number(result.damage) || 0;
      if (result.killed) this._recordKill(entity, { verified: true });
    }
    return { ...result, prepared: prep };
  }

  totemStatus() { return this.totems.status(); }
  foodStatus() { return suppliesStatus({ inventory: this.bot.inventory, meta: this.meta, bot: this.bot }); }
  potionStatus() { return this.foodStatus().potions; }
  gearStatus() { return gearStatus({ inventory: this.bot.inventory, meta: this.meta, target: this.target }); }
}

module.exports = { CombatController, ANIMALS, NEVER_ATTACK };
