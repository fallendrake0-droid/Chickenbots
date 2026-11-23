'use strict';

const { profileFor } = require('./mobs');

const TOTEM = 'totem_of_undying';

function offhandOf(bot) {
  if (!bot) return null;
  if (typeof bot.getOffhand === 'function') return bot.getOffhand();
  if (bot.equipment && bot.equipment.offhand !== undefined) return bot.equipment.offhand;
  if (bot.bot && bot.bot.inventory && typeof bot.bot.inventory.slots === 'object') {
    const slot = bot.bot.inventory.slots[45];
    return slot ? slot.name : null;
  }
  return null;
}

/**
 * Totem of Undying manager. It only claims an activation when the adapter
 * reports a real activation event or a verified inventory/offhand change.
 */
class TotemManager {
  constructor({ bot, team = null, comms = null, reserve = 1, criticalReserve = 1, now = () => Date.now() } = {}) {
    if (!bot) throw new Error('TotemManager requires a bot');
    this.bot = bot;
    this.team = team;
    this.comms = comms;
    this.now = now;
    this.reserve = Math.max(0, reserve);
    this.criticalReserve = Math.max(0, criticalReserve);
    this.stats = { equipped: 0, activations: 0, replacements: 0, failedEquips: 0 };
    this.lastEquipAt = 0;
    this.lastActivationAt = 0;
    this.lastOffhand = offhandOf(bot);
    this.lastCount = this.count();
    this.events = [];
    this.switchWindowMs = 1500;
  }

  count() {
    return typeof this.bot.countItem === 'function' ? Number(this.bot.countItem(TOTEM) || 0) : 0;
  }

  offhand() { return offhandOf(this.bot); }
  equipped() { return this.offhand() === TOTEM; }

  async equip({ force = false } = {}) {
    if (this.count() <= 0) return { ok: false, error: 'no totem of undying in inventory', totems: 0 };
    if (this.equipped() && !force) return { ok: true, already: true, offhand: TOTEM };
    if (typeof this.bot.equipItem !== 'function') return { ok: false, error: 'adapter cannot equip an offhand item' };
    const result = await this.bot.equipItem(TOTEM, 'off-hand');
    const verified = result && result.ok !== false && this.equipped();
    if (verified) {
      this.stats.equipped++;
      this.lastEquipAt = this.now();
      this.lastOffhand = TOTEM;
      return { ok: true, offhand: TOTEM, verified, totems: this.count() };
    }
    this.stats.failedEquips++;
    return { ok: false, error: (result && result.error) || 'offhand equip was not verified', verified: false };
  }

  async equipShield() {
    if (!this.bot.countItem('shield')) return { ok: false, error: 'no shield' };
    if (this.offhand() === 'shield') return { ok: true, already: true, offhand: 'shield' };
    const result = await this.bot.equipItem('shield', 'off-hand');
    const verified = result && result.ok !== false && this.offhand() === 'shield';
    if (verified) this.lastOffhand = 'shield';
    return { ...result, verified };
  }

  /**
   * Choose the offhand item. Emergency risk always wins; ordinary projectile
   * threats use a shield, but switching inside the hysteresis window is refused.
   */
  async chooseOffhand({ threat = null, health = 20, shieldAvailable = null, totalThreats = 1, force = false } = {}) {
    const profile = threat ? profileFor(threat) : null;
    const hasTotem = this.count() > 0;
    const hasShield = shieldAvailable === null ? this.bot.countItem('shield') > 0 : Boolean(shieldAvailable);
    const urgent = (profile && (profile.boss || profile.explosive)) || health <= 8 || totalThreats >= 3;
    if (urgent && hasTotem) return this.equip({ force });
    if (this.equipped() && !urgent) {
      // A totem already in the offhand is never displaced by a shield: it is
      // the stronger survival guarantee and the shield is only a fallback
      // when no totem is carried at all.
      return { ok: true, already: true, offhand: TOTEM, reason: 'totem stays equipped' };
    }
    if (hasTotem) return this.equip({ force });
    if (profile && (profile.ranged || profile.projectile) && hasShield && !urgent) {
      return this.equipShield();
    }
    if (hasShield) return this.equipShield();
    return { ok: false, error: 'no totem or shield available', offhand: this.offhand() };
  }

  /** Poll adapter events and inventory state. Returns verified activations only. */
  checkActivation() {
    const activations = [];
    const drain = typeof this.bot.drainCombatEvents === 'function' ? this.bot.drainCombatEvents.bind(this.bot) : null;
    const rawEvents = drain ? drain() : (Array.isArray(this.bot.combatEvents) ? this.bot.combatEvents.splice(0) : []);
    for (const event of rawEvents) {
      if (event && event.type === 'totem_activated') activations.push(event);
    }
    // A fallback for adapters that expose only inventory/equipment changes:
    // require that a totem was actually equipped and that the count dropped.
    const count = this.count();
    const offhand = this.offhand();
    if (!activations.length && this.lastOffhand === TOTEM && offhand !== TOTEM && count < this.lastCount) {
      activations.push({ type: 'totem_activated', detectedBy: 'inventory-change', at: this.now() });
    }
    this.lastOffhand = offhand;
    this.lastCount = count;
    for (const event of activations) this._recordActivation(event);
    return activations;
  }

  _recordActivation(event) {
    this.stats.activations++;
    this.lastActivationAt = this.now();
    const entry = { at: new Date(this.lastActivationAt).toISOString(), event, totemsRemaining: this.count(), health: this.bot.health };
    this.events.push(entry);
    if (this.events.length > 100) this.events.shift();
    if (this.comms && typeof this.comms.send === 'function') {
      try {
        this.comms.send('BOT_IN_DANGER', this.bot.name, { bot: this.bot.name, kind: 'totem_activated', totemsRemaining: this.count() });
      } catch (_) { /* communication must never break combat */ }
    }
  }

  /** Replace a consumed totem, verify it, and report whether any reserve remains. */
  async handleActivation() {
    const before = this.count();
    const replacement = await this.equip({ force: true });
    if (replacement.ok) this.stats.replacements++;
    return {
      ok: replacement.ok,
      consumed: true,
      totemsBefore: before,
      totemsAfter: this.count(),
      reserveSafe: this.count() >= this.reserve,
      criticalReserveSafe: this.count() >= this.criticalReserve,
      replacement,
      health: this.bot.health,
      offhand: this.offhand()
    };
  }

  status() {
    const count = this.count();
    return {
      count,
      offhand: this.offhand(),
      equipped: this.equipped(),
      reserve: this.reserve,
      criticalReserve: this.criticalReserve,
      belowReserve: count < this.reserve,
      activations: this.stats.activations,
      replacements: this.stats.replacements,
      lastActivationAt: this.lastActivationAt ? new Date(this.lastActivationAt).toISOString() : null,
      events: this.events.slice(-10),
      stats: { ...this.stats }
    };
  }
}

function teamTotemLedger(controllers) {
  const rows = [];
  let total = 0;
  for (const controller of controllers || []) {
    const manager = controller && controller.totems;
    if (!manager) continue;
    const count = manager.count();
    total += count;
    rows.push({ bot: manager.bot.name, totems: count, equipped: offhandOf(manager.bot) === TOTEM, reserve: manager.reserve });
  }
  return { bots: rows, total, withTotems: rows.filter((row) => row.totems > 0).length, reserveMet: rows.filter((row) => row.totems >= row.reserve).length };
}

module.exports = { TotemManager, teamTotemLedger, offhandOf, TOTEM };
