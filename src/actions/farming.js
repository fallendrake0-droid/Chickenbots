'use strict';

const { Logger } = require('../logger');
const { distance } = require('../util/vec');
const { findBlocks } = require('./common');

const CROPS = {
  wheat: { seed: 'wheat_seeds', produce: 'wheat' },
  carrots: { seed: 'carrot', produce: 'carrot' },
  potatoes: { seed: 'potato', produce: 'potato' },
  beetroots: { seed: 'beetroot_seeds', produce: 'beetroot' },
  pumpkin_stem: { seed: 'pumpkin_seeds', produce: 'pumpkin' },
  melon_stem: { seed: 'melon_seeds', produce: 'melon_slice' },
  torchflower_crop: { seed: 'torchflower_seeds', produce: 'torchflower' },
  pitcher_crop: { seed: 'pitcher_pod', produce: 'pitcher_plant' }
};
const ANIMALS = {
  cow: 'wheat', sheep: 'wheat', pig: 'carrot', chicken: 'wheat_seeds', rabbit: 'carrot', goat: 'wheat', mooshroom: 'wheat'
};
const SOIL = new Set(['farmland', 'dirt', 'grass_block', 'coarse_dirt']);
const CROP_ALIASES = {
  wheat: 'wheat', carrot: 'carrots', carrots: 'carrots', potato: 'potatoes', potatoes: 'potatoes',
  beetroot: 'beetroots', beetroots: 'beetroots', pumpkin: 'pumpkin_stem', pumpkins: 'pumpkin_stem',
  melon: 'melon_stem', melons: 'melon_stem', torchflower: 'torchflower_crop', pitcher: 'pitcher_crop'
};

function normalizeCrop(value) {
  if (!value || value === 'all' || value === 'harvest') return null;
  const key = String(value).toLowerCase();
  return CROP_ALIASES[key] || (CROPS[key] ? key : null);
}

/**
 * Crop and animal farming. Mature crops are harvested with real drops and
 * replanted when seeds are available; animals are fed (breeding) only when the
 * team has surplus food, never slaughtered here (combat handles hunting).
 */
class FarmingController {
  constructor({ bot, memory = null, logger = null, farmRadius = 24 } = {}) {
    if (!bot) throw new Error('FarmingController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.logger = logger || new Logger({ level: 'warn' });
    this.farmRadius = farmRadius;
    this.stats = { harvested: 0, replanted: 0, animalsFed: 0, farmsScanned: 0 };
    this.farmPlots = [];
    this.stopRequested = false;
  }

  status() {
    const position = this.bot.position || { x: 0, y: 0, z: 0 };
    const now = Date.now();
    const moved = this._statusCache ? Math.hypot(position.x - this._statusCache.center.x, position.z - this._statusCache.center.z) : Infinity;
    if (!this._statusCache || moved > 12 || now - this._statusCache.at > 10000) {
      this._statusCache = { center: { x: position.x, z: position.z }, at: now, crops: this.scanCrops({ radius: 20 }) };
    }
    const crops = this._statusCache.crops;
    return {
      bot: this.bot.name,
      crops: crops.slice(0, 12),
      cropCount: crops.length,
      seeds: Object.entries(CROPS).map(([crop, def]) => ({ crop, seed: def.seed, count: this.bot.countItem(def.seed) })).filter((s) => s.count > 0),
      animals: this.countAnimals(),
      farms: this.farmPlots.slice(-5),
      stopped: Boolean(this.stopRequested),
      stats: { ...this.stats }
    };
  }

  scanCrops({ radius = this.farmRadius, crop = null } = {}) {
    this.stats.farmsScanned++;
    const wanted = crop ? [crop] : Object.keys(CROPS);
    return findBlocks(this.bot, wanted, { radius, limit: 120 })
      .map((found) => ({ ...found, crop: found.name, distance: Math.round(distance(this.bot.position, found)) }))
      .sort((a, b) => a.distance - b.distance);
  }

  stop() {
    this.stopRequested = true;
    return { ok: true, bot: this.bot.name, stopped: true };
  }

  _begin() {
    this.stopRequested = false;
    return true;
  }

  cropCount() { return this.scanCrops().length; }

  countAnimals() {
    const animals = (this.bot.entitiesNear ? this.bot.entitiesNear(this.farmRadius) : []).filter((e) => ANIMALS[e.name || e.type]);
    return animals.length;
  }

  async harvest(pos) {
    const block = this.bot.getBlock(pos);
    if (!block || !CROPS[block.name]) return { ok: false, error: `not a crop: ${block ? block.name : 'air'}` };
    const def = CROPS[block.name];
    const move = await this.bot.goTo(pos, { range: 4 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const dig = await this.bot.digBlock(pos);
    if (!dig.ok) return { ok: false, error: dig.error };
    this._statusCache = null;
    this.stats.harvested++;
    const known = this.farmPlots.find((plot) => plot.position.x === pos.x && plot.position.y === pos.y && plot.position.z === pos.z);
    const plot = { crop: block.name, position: { ...pos }, at: Date.now() };
    if (known) Object.assign(known, plot);
    else this.farmPlots.push(plot);
    if (this.farmPlots.length > 20) this.farmPlots.shift();
    if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(6);
    const replant = await this.replant(pos, def.seed);
    if (this.memory) {
      this.memory.observe({ type: 'FARM', resource: block.name, position: { ...pos }, reportedBy: this.bot.name, confidence: 0.9, data: { harvested: true, replanted: replant.ok } });
    }
    return { ok: true, crop: block.name, produce: def.produce, harvested: 1, replanted: replant.ok, replantError: replant.error };
  }

  async replant(pos, seed) {
    if (!seed || !this.bot.countItem(seed)) return { ok: false, error: `no ${seed || 'seed'}` };
    const below = this.bot.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
    if (!below || !SOIL.has(below.name)) return { ok: false, error: 'soil is not farmable' };
    const move = await this.bot.goTo(pos, { range: 4 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const placed = await this.bot.placeBlock(pos, seed);
    if (placed.ok) {
      this.stats.replanted++;
      this._statusCache = null;
    }
    return placed;
  }

  async harvestAll({ radius = this.farmRadius, limit = 32, crop = null, types = null } = {}) {
    this._begin();
    const wanted = normalizeCrop(crop || types);
    const crops = this.scanCrops({ radius, crop: wanted }).slice(0, limit);
    if (!crops.length) return { ok: true, idle: true, reason: wanted ? `no ${wanted} crops nearby` : 'no crops nearby', crop: wanted };
    const results = [];
    for (const target of crops) {
      if (this.stopRequested) break;
      const block = this.bot.getBlock(target);
      if (!block || !CROPS[block.name]) continue;
      results.push(await this.harvest(target));
    }
    return { ok: results.some((r) => r.ok), stopped: this.stopRequested, harvested: results.filter((r) => r.ok).length, results, crop: wanted };
  }

  async feedAnimals({ radius = this.farmRadius, max = 4 } = {}) {
    const animals = (this.bot.entitiesNear ? this.bot.entitiesNear(radius) : []).filter((e) => ANIMALS[e.name || e.type]);
    const fed = [];
    for (const animal of animals.slice(0, max)) {
      if (this.stopRequested) break;
      const food = ANIMALS[animal.name || animal.type];
      if (!this.bot.countItem(food)) continue;
      if (typeof this.bot.feed !== 'function') break;
      const move = await this.bot.goTo(animal.position, { range: 2 });
      if (move && move.ok === false) continue;
      const result = await this.bot.feed(animal, food);
      if (result.ok) { fed.push({ animal: animal.name || animal.type, food }); this.stats.animalsFed++; }
    }
    return { ok: fed.length > 0, fed, note: fed.length ? undefined : 'adapter does not expose animal feeding' };
  }

  async tick(options = {}) {
    const harvest = await this.harvestAll(options);
    const feed = await this.feedAnimals();
    return { ok: harvest.ok || feed.ok, harvest, feed, status: this.status() };
  }
}

module.exports = { FarmingController, CROPS, ANIMALS, SOIL, CROP_ALIASES, normalizeCrop };
