'use strict';

const { config } = require('../config');
const { Logger } = require('../logger');
const { distance } = require('../util/vec');
const { isTeammate, isHostile, moveAway } = require('./common');

const ANIMALS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mushroom_cow', 'horse', 'donkey', 'mule', 'llama', 'goat']);
const NEVER_ATTACK = new Set(['villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'wolf', 'cat', 'ocelot', 'parrot', 'fox', 'panda', 'polar_bear', 'bee', 'allay', 'axolotl', 'turtle', 'dolphin', 'squid', 'glow_squid', 'bat', 'frog', 'tadpole', 'strider', 'zombified_piglin']);

/**
 * PvE combat. PvP is disabled by default and hard-disabled for teammates and
 * ordinary players regardless of configuration. The controller can retreat,
 * regroup, defend the team and hunt animals for food.
 */
class CombatController {
  constructor({ bot, team = null, memory = null, logger = null, pvp = config.autonomy.pvp } = {}) {
    if (!bot) throw new Error('CombatController requires a bot');
    this.bot = bot;
    this.team = team;
    this.memory = memory;
    this.logger = logger || new Logger({ level: 'warn' });
    this.pvpEnabled = Boolean(pvp);
    this.stats = { attacks: 0, kills: 0, retreats: 0, threatAssessments: 0 };
    this.lastAction = null;
  }

  assess(radius = 16) {
    this.stats.threatAssessments++;
    const raw = typeof this.bot.hostileNear === 'function'
      ? this.bot.hostileNear(this.bot.position, radius)
      : (this.bot.threatsNear && Array.isArray(this.bot.threatsNear(this.bot.position, radius)) ? this.bot.threatsNear(this.bot.position, radius) : []);
    const threats = raw
      .filter((e) => !isTeammate(e, this.team) && isHostile(e) !== false)
      .map((e) => ({ ...e, distance: Number(distance(e.position, this.bot.position).toFixed(1)) }))
      .sort((a, b) => a.distance - b.distance);
    return {
      threats,
      count: threats.length,
      nearest: threats[0] || null,
      health: this.bot.health,
      outmatched: threats.length >= 3 || (threats[0] && /creeper|warden|ravager|witch/i.test(threats[0].name || '')),
      pvpEnabled: this.pvpEnabled
    };
  }

  status() {
    const assessment = this.assess();
    return {
      bot: this.bot.name,
      health: this.bot.health,
      threats: assessment.threats.length,
      nearestThreat: assessment.nearest,
      outmatched: assessment.outmatched,
      pvpEnabled: this.pvpEnabled,
      sword: this.bot.bestToolFor('sword'),
      shield: Boolean(this.bot.countItem('shield')),
      lastAction: this.lastAction,
      stats: { ...this.stats }
    };
  }

  stop() {
    this.stopRequested = true;
    return { ok: true, bot: this.bot.name, stopped: true };
  }

  async defend({ maxAttacks = 12 } = {}) {
    this.stopRequested = false;
    const assessment = this.assess();
    if (!assessment.threats.length) return { action: 'defend', ok: true, idle: true };
    if (this.bot.health <= config.survival.fleeHealth) {
      return this.retreat(assessment.nearest);
    }
    if (assessment.outmatched && this.bot.health < 14) {
      const regroup = await this.regroup();
      return { action: 'regroup', ...regroup, outmatched: true };
    }
    await this.bot.useShield?.(true);
    const results = [];
    for (let i = 0; i < maxAttacks && !this.stopRequested; i++) {
      const current = this.assess();
      if (!current.threats.length) break;
      if (this.bot.health <= config.survival.fleeHealth) {
        results.push(await this.retreat(current.nearest));
        break;
      }
      const target = current.threats[0];
      const attack = await this.bot.attack(target);
      this.stats.attacks++;
      results.push({ action: 'attack', target: target.name || target.type, ...attack });
      if (!attack.ok) break;
      if (attack.killed) {
        this.stats.kills++;
        this.lastAction = `killed ${target.name || target.type}`;
      }
    }
    await this.bot.useShield?.(false);
    return { action: 'defend', ok: true, stopped: this.stopRequested, attacks: results.length, results, remaining: this.assess().threats.length };
  }

  async retreat(threat) {
    this.stats.retreats++;
    const result = await moveAway(this.bot, threat ? threat.position : this.bot.position, 10);
    if (this.bot.useShield) await this.bot.useShield(true);
    this.lastAction = 'retreated';
    return { action: 'retreat', ok: result.ok !== false, threat: threat ? threat.name || threat.type : null };
  }

  async regroup() {
    const home = this.team && this.team.home ? this.team.home : null;
    if (home && home.position) {
      const result = await this.bot.goTo(home.position, { range: 3 });
      this.lastAction = 'regrouped at home';
      return { ok: result.ok !== false, position: home.position, reason: 'outmatched' };
    }
    const away = { x: this.bot.position.x + 8, y: this.bot.position.y, z: this.bot.position.z + 8 };
    const result = await this.bot.goTo(away, { range: 2 });
    this.lastAction = 'regrouped';
    return { ok: result.ok !== false, reason: 'no home set' };
  }

  /** Hunt a food animal only. Never targets teammates, players or pets. */
  async hunt({ maxDistance = 24 } = {}) {
    const animals = (this.bot.entitiesNear ? this.bot.entitiesNear(maxDistance) : [])
      .filter((e) => ANIMALS.has(e.name || e.type) && !NEVER_ATTACK.has(e.name || e.type))
      .sort((a, b) => distance(a.position, this.bot.position) - distance(b.position, this.bot.position));
    const target = animals[0];
    if (!target) return { action: 'hunt', ok: true, idle: true, reason: 'no animals nearby' };
    const move = typeof this.bot.goNear === 'function'
      ? await this.bot.goNear(target, 2)
      : await this.bot.goTo(target.position, { range: 2 });
    if (move && move.ok === false) return { action: 'hunt', ok: false, error: move.error };
    const attack = await this.bot.attack(target);
    if (attack.ok) { this.stats.attacks++; if (attack.killed) this.stats.kills++; }
    this.lastAction = attack.ok ? `hunted ${target.name || target.type}` : 'hunt failed';
    return { action: 'hunt', target: target.name || target.type, ...attack };
  }

  /** Guard against accidental PvP: only hostile mobs are ever valid targets. */
  async attackEntity(entity) {
    if (!entity) return { ok: false, error: 'no target' };
    if (isTeammate(entity, this.team)) return { ok: false, error: 'never attack teammates' };
    const name = entity.name || entity.type || '';
    if (entity.username) {
      if (!this.pvpEnabled) return { ok: false, error: 'PvP is disabled' };
      return { ok: false, error: 'ordinary players are never auto-attacked' };
    }
    if (NEVER_ATTACK.has(name) || ANIMALS.has(name)) return { ok: false, error: `not a hostile target: ${name}` };
    if (!isHostile(entity)) return { ok: false, error: `refusing to attack ${name}` };
    const result = await this.bot.attack(entity);
    if (result.ok) this.stats.attacks++;
    return result;
  }
}

module.exports = { CombatController, ANIMALS, NEVER_ATTACK };
