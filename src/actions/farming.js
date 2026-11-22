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
  }

  status() {
    return {
      bot: this.bot.name,
      crops: this.scanCrops().slice(0, 12),
      cropCount: this.cropCount(),
      seeds: Object.entries(CROPS).map(([crop, def]) => ({ crop, seed: def.seed, count: this.bot.countItem(def.seed) })).filter((s) => s.count > 0),
      animals: this.countAnimals(),
      farms: this.farmPlots.slice(-5),
      stats: { ...this.stats }
    };
  }

  scanCrops({ radius = this.farmRadius } = {}) {
    this.stats.farmsScanned++;
    return findBlocks(this.bot, Object.keys(CROPS), { radius, limit: 120 })
      .map((crop) => ({ ...crop, crop: crop.name, distance: Math.round(distance(this.bot.position, crop)) }))
      .sort((a, b) => a.distance - b.distance);
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
    this.stats.harvested++;
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
    if (placed.ok) this.stats.replanted++;
    return placed;
  }

  async harvestAll({ radius = this.farmRadius, limit = 32 } = {}) {
    const crops = this.scanCrops({ radius }).slice(0, limit);
    if (!crops.length) return { ok: true, idle: true, reason: 'no crops nearby' };
    const results = [];
    for (const crop of crops) {
      const block = this.bot.getBlock(crop);
      if (!block || !CROPS[block.name]) continue;
      results.push(await this.harvest(crop));
    }
    return { ok: results.some((r) => r.ok), harvested: results.filter((r) => r.ok).length, results };
  }

  async feedAnimals({ radius = this.farmRadius, max = 4 } = {}) {
    const animals = (this.bot.entitiesNear ? this.bot.entitiesNear(radius) : []).filter((e) => ANIMALS[e.name || e.type]);
    const fed = [];
    for (const animal of animals.slice(0, max)) {
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

module.exports = { FarmingController, CROPS, ANIMALS, SOIL };
