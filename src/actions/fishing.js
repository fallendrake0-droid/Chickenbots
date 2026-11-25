'use strict';

const { Logger } = require('../logger');
const { distance } = require('../util/vec');
const { findBlocks } = require('./common');

const WATER_BLOCKS = ['water', 'flowing_water'];
const FISH = new Set(['cod', 'salmon', 'tropical_fish', 'pufferfish']);

/**
 * Fishing with real water, a real rod and real inventory results.
 *
 * MockBot resolves a deterministic catch from the shared world; RealBot calls
 * Mineflayer's `bot.fish()` and only reports items that actually appeared in
 * the inventory. No fish are fabricated when no water or rod exists.
 */
class FishingController {
  constructor({ bot, memory = null, ledger = null, logger = null, radius = 24 } = {}) {
    if (!bot) throw new Error('FishingController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.ledger = ledger;
    this.logger = logger || new Logger({ level: 'warn' });
    this.radius = radius;
    this.stats = { casts: 0, caught: 0, failed: 0, spots: 0 };
    this.caught = {};
    this.stopRequested = false;
  }

  status() {
    const position = this.bot.position || { x: 0, y: 0, z: 0 };
    const now = Date.now();
    const moved = this._statusCache ? Math.hypot(position.x - this._statusCache.center.x, position.z - this._statusCache.center.z) : Infinity;
    const ttl = 10000 + (String(this.bot.name).charCodeAt(0) % 7) * 900;
    if (!this._statusCache || moved > 8 || now - this._statusCache.at > ttl) {
      this._statusCache = { center: { x: position.x, z: position.z }, at: now, water: findBlocks(this.bot, WATER_BLOCKS, { radius: 8, limit: 8 }) };
    }
    const water = this._statusCache.water;
    return {
      bot: this.bot.name,
      rod: Boolean(this.bot.countItem('fishing_rod')),
      water: water.length,
      nearestWater: water.length ? { ...water[0], distance: Math.round(distance(position, water[0])) } : null,
      caught: { ...this.caught },
      stopped: Boolean(this.stopRequested),
      stats: { ...this.stats }
    };
  }

  stop() {
    this.stopRequested = true;
    return { ok: true, bot: this.bot.name, stopped: true };
  }

  _begin() {
    this.stopRequested = false;
    return true;
  }

  /** Find a walkable shore block adjacent to water. */
  findSpot() {
    const water = findBlocks(this.bot, WATER_BLOCKS, { radius: this.radius, limit: 40 })
      .sort((a, b) => distance(this.bot.position, a) - distance(this.bot.position, b));
    for (const block of water) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ground = { x: block.x + dx, y: block.y - 1, z: block.z + dz };
        const stand = { x: block.x + dx, y: block.y, z: block.z + dz };
        const below = this.bot.getBlock(ground);
        const at = this.bot.getBlock(stand);
        const above = this.bot.getBlock({ x: stand.x, y: stand.y + 1, z: stand.z });
        if (!below || below.name === 'air' || below.name === 'water' || below.name === 'lava') continue;
        if (!at || (at.name !== 'air' && at.name !== 'water')) continue;
        if (!above || above.name !== 'air') continue;
        return { stand, water: { x: block.x, y: block.y, z: block.z } };
      }
    }
    return water.length ? { stand: null, water: { x: water[0].x, y: water[0].y, z: water[0].z } } : null;
  }

  async cast({ timeoutMs = 20000 } = {}) {
    if (this.stopRequested) return { ok: false, stopped: true, error: 'fishing stopped' };
    if (!this.bot.countItem('fishing_rod')) return { ok: false, error: 'no fishing_rod in inventory' };
    const spot = this.findSpot();
    if (!spot) return { ok: false, error: 'no water within fishing range' };
    if (spot.stand) {
      const move = await this.bot.goTo(spot.stand, { range: 2, timeoutMs: Math.min(timeoutMs, 15000) });
      if (move && move.ok === false) return { ok: false, error: move.error || 'cannot reach the shore' };
    }
    this.stats.casts++;
    let result;
    try {
      result = await this.bot.fish({ timeoutMs });
    } catch (err) {
      this.stats.failed++;
      return { ok: false, error: err.message, casts: this.stats.casts };
    }
    if (!result || !result.ok) {
      this.stats.failed++;
      return { ok: false, error: (result && result.error) || 'fish escaped', casts: this.stats.casts };
    }
    const items = Array.isArray(result.items) ? result.items : (result.item ? [{ name: result.item, count: result.count || 1 }] : []);
    const caught = items.filter((item) => FISH.has(item.name));
    if (!caught.length) {
      this.stats.failed++;
      return { ok: false, error: result.item ? `caught non-fish ${result.item}` : 'nothing was caught', casts: this.stats.casts };
    }
    this.stats.caught += caught.reduce((sum, item) => sum + (item.count || 1), 0);
    for (const item of caught) this.caught[item.name] = (this.caught[item.name] || 0) + (item.count || 1);
    if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(4);
    if (this.ledger) this.ledger.updateBotInventory(this.bot.name, this.bot.inventory);
    if (this.memory) {
      this.memory.observe({
        type: 'RESOURCE', resource: caught.map((item) => item.name).join(','),
        position: { ...spot.water }, reportedBy: this.bot.name, confidence: 0.9,
        status: 'FISHED', data: { style: 'fishing', items: caught, at: Date.now() }
      });
    }
    return { ok: true, items: caught, water: spot.water, casts: this.stats.casts, caught: this.stats.caught };
  }

  async tick({ casts = 1, timeoutMs = 20000 } = {}) {
    this._begin();
    const results = [];
    for (let i = 0; i < Math.max(1, casts); i++) {
      if (this.stopRequested) break;
      results.push(await this.cast({ timeoutMs }));
      if (!results[results.length - 1].ok) break;
      if (this.bot.health <= 8) break;
    }
    const caught = results.reduce((sum, result) => sum + (result.ok ? result.items.reduce((n, item) => n + (item.count || 1), 0) : 0), 0);
    return { ok: caught > 0, caught, results, status: this.status() };
  }
}

module.exports = { FishingController, FISH, WATER_BLOCKS };
