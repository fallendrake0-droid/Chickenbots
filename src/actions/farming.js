'use strict';

const { Logger } = require('../logger');
const { distance } = require('../util/vec');
const { findBlocks, statusTtl, STATUS_SCAN_BUDGET_MS } = require('./common');
const {
  CROPS, CROP_ALIASES, TILLABLE, SOIL, REPLACEABLE,
  cropDefinition, normalizeCrop, cropAge, isMatureCrop
} = require('../world/crops');

const ANIMALS = {
  cow: 'wheat', sheep: 'wheat', pig: 'carrot', chicken: 'wheat_seeds', rabbit: 'carrot', goat: 'wheat', mooshroom: 'wheat'
};
const WATER = new Set(['water', 'flowing_water']);
const ANIMAL_FEED_COOLDOWN_MS = 300000;

function keyOf(pos) { return `${pos.x},${pos.y},${pos.z}`; }

/**
 * Crop and animal farming.
 *
 * Harvesting is maturity-gated from real block states. Wheat/carrot/potato/
 * beetroot crops are replanted and verified; pumpkin/melon stems stay in place
 * and their fruit is harvested. Establishing a farm tills soil with a real
 * hoe, digs and fills irrigation cells from a water bucket, and plants only on
 * verified farmland. No crop is counted as harvested or planted from a call
 * result alone.
 */
class FarmingController {
  constructor({ bot, memory = null, home = null, logger = null, farmRadius = 24 } = {}) {
    if (!bot) throw new Error('FarmingController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.home = home ? { ...home } : null;
    this.logger = logger || new Logger({ level: 'warn' });
    this.farmRadius = farmRadius;
    this.stats = {
      harvested: 0, replanted: 0, animalsFed: 0, farmsScanned: 0, produce: 0,
      immatureSkipped: 0, plotsPrepared: 0, tilled: 0, waterPlaced: 0, planted: 0, crafted: 0, animalsBred: 0
    };
    this.farmPlots = [];
    this.lastPlot = null;
    this.stopRequested = false;
    this._statusCache = null;
    this._animalCooldowns = new Map();
    this._nextPlantAttempt = 0;
  }

  status() {
    const position = this.bot.position || { x: 0, y: 0, z: 0 };
    const now = Date.now();
    const moved = this._statusCache ? Math.hypot(position.x - this._statusCache.center.x, position.z - this._statusCache.center.z) : Infinity;
    // A dashboard poll used to scan a 25x17x17 volume per bot synchronously,
    // which on the live server froze the loop for tens of seconds. The cache is
    // now staggered across the roster and the scan itself is time-bounded.
    const ttl = statusTtl(this.bot.name, 3);
    if (!this._statusCache || moved > 24 || now - this._statusCache.at > ttl) {
      this._statusCache = {
        center: { x: position.x, z: position.z },
        at: now,
        crops: this.scanCrops({ radius: 6, budgetMs: STATUS_SCAN_BUDGET_MS }),
        animals: this.countAnimals()
      };
    }
    const crops = this._statusCache.crops;
    return {
      bot: this.bot.name,
      crops: crops.slice(0, 12),
      cropCount: crops.length,
      matureCount: crops.filter((crop) => crop.mature).length,
      immatureCount: crops.filter((crop) => !crop.mature).length,
      seeds: Object.entries(CROPS).map(([crop, def]) => ({ crop, seed: def.seed, count: this.bot.countItem(def.seed) })).filter((s) => s.count > 0),
      animals: this._statusCache.animals,
      farms: this.farmPlots.slice(-5),
      plot: this.lastPlot,
      stopped: Boolean(this.stopRequested),
      stats: { ...this.stats }
    };
  }

  _block(pos) {
    if (!pos || typeof this.bot.getBlock !== 'function') return null;
    try { return this.bot.getBlock(pos); } catch (_) { return null; }
  }

  _name(pos) { const block = this._block(pos); return block ? String(block.name).replace(/^minecraft:/, '') : null; }

  _isReplaceable(blockOrName) {
    const name = typeof blockOrName === 'string' ? blockOrName : blockOrName && blockOrName.name;
    return REPLACEABLE.has(String(name || '').replace(/^minecraft:/, ''));
  }

  _inventory() { return { ...(this.bot.inventory || {}) }; }

  scanCrops({ radius = this.farmRadius, crop = null, budgetMs = 0 } = {}) {
    this.stats.farmsScanned++;
    let wanted;
    const raw = crop ? String(crop).toLowerCase() : null;
    if (raw && raw !== 'all' && raw !== 'harvest') {
      const name = normalizeCrop(raw);
      if (!name) return [];
      wanted = [name];
    } else {
      wanted = Object.keys(CROPS);
    }
    return findBlocks(this.bot, wanted, { radius, limit: 200, budgetMs })
      .map((found) => {
        const block = this._block(found) || found;
        const def = cropDefinition(found.name);
        // A pitcher plant exposes upper and lower halves for one crop.
        if (block && block.properties && block.properties.half === 'upper') return null;
        return {
          ...found,
          crop: found.name,
          age: cropAge(block),
          maxAge: def ? def.maxAge : null,
          mature: isMatureCrop(block),
          distance: Math.round(distance(this.bot.position, found))
        };
      })
      .filter(Boolean)
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

  cropCount({ radius = this.farmRadius, crop = null } = {}) { return this.scanCrops({ radius, crop }).length; }

  countAnimals() {
    const animals = (this.bot.entitiesNear ? this.bot.entitiesNear(this.farmRadius) : []).filter((e) => ANIMALS[e.name || e.type]);
    return animals.length;
  }

  _findStemFruit(pos, def) {
    if (!def || !def.stem || !def.fruit) return null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, -1]) {
        const target = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
        if (this._name(target) === def.fruit) return target;
      }
    }
    return null;
  }

  async harvest(pos, { force = false } = {}) {
    const block = this._block(pos);
    const def = cropDefinition(block && block.name);
    if (!block || !def) return { ok: false, error: `not a crop: ${block ? block.name : 'air'}` };
    if (block.name === 'pitcher_crop' && block.properties && block.properties.half === 'upper') {
      return { ok: false, skipped: true, error: 'pitcher upper half is harvested via the lower block' };
    }
    const age = cropAge(block);
    if (!force && !isMatureCrop(block)) {
      this.stats.immatureSkipped++;
      return { ok: false, immature: true, crop: block.name, age, maxAge: def.maxAge, error: `${block.name} is still growing (${age ?? '?'}/${def.maxAge})` };
    }

    // Pumpkin/melon: harvest the fruit and leave the mature stem alive.
    if (def.stem) {
      const fruit = this._findStemFruit(pos, def);
      if (!fruit) return { ok: false, skipped: true, mature: true, crop: block.name, error: `mature ${block.name} has no fruit yet` };
      const before = this._inventory();
      const move = await this.bot.goTo(fruit, { range: 4 });
      if (move && move.ok === false) return { ok: false, error: move.error };
      const dig = await this.bot.digBlock(fruit, {});
      if (!dig.ok) return { ok: false, error: dig.error };
      if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(6);
      const after = this._inventory();
      const produced = Math.max(0, Number(after[def.produce] || 0) - Number(before[def.produce] || 0));
      if (this._name(fruit) === def.fruit) return { ok: false, error: `fruit ${def.fruit} was not removed from the world` };
      if (this._name(pos) !== block.name) return { ok: false, error: `${block.name} stem was lost while harvesting its fruit` };
      this.stats.harvested++;
      this.stats.produce += produced;
      this._statusCache = null;
      this._rememberPlot(block.name, pos);
      this._observe(block.name, pos, true);
      return {
        ok: true, crop: block.name, harvestedBlock: def.fruit, produce: def.produce, produced,
        harvested: 1, replanted: false, stemKept: true, mature: true, age
      };
    }

    const before = this._inventory();
    const move = await this.bot.goTo(pos, { range: 4 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const dig = await this.bot.digBlock(pos, {});
    if (!dig.ok) return { ok: false, error: dig.error };
    if (this._name(pos) === block.name) return { ok: false, error: `crop ${block.name} was not removed from the world` };
    if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(6);
    const after = this._inventory();
    const produced = Math.max(0, Number(after[def.produce] || 0) - Number(before[def.produce] || 0));
    const seeds = def.seed === def.produce ? produced : Math.max(0, Number(after[def.seed] || 0) - Number(before[def.seed] || 0));

    const replant = await this.replant(pos, def.seed, block.name);
    this.stats.harvested++;
    this.stats.produce += produced;
    this._statusCache = null;
    this._rememberPlot(block.name, pos);
    this._observe(block.name, pos, replant.ok);
    return {
      ok: true, crop: block.name, produce: def.produce, produced, seeds,
      harvested: 1, replanted: replant.ok, replantError: replant.error,
      replantPosition: replant.position, mature: true, age
    };
  }

  _observe(crop, position, replanted) {
    if (!this.memory || typeof this.memory.observe !== 'function') return;
    this.memory.observe({
      type: 'FARM', resource: crop, position: { ...position }, reportedBy: this.bot.name,
      confidence: 0.95, data: { harvested: true, replanted }
    });
  }

  _rememberPlot(crop, position) {
    const known = this.farmPlots.find((plot) => plot.position.x === position.x && plot.position.y === position.y && plot.position.z === position.z);
    const entry = { crop, position: { ...position }, at: Date.now() };
    if (known) Object.assign(known, entry);
    else this.farmPlots.push(entry);
    if (this.farmPlots.length > 40) this.farmPlots.shift();
  }

  async replant(pos, seed, cropName = null) {
    if (!seed) return { ok: false, error: 'no seed for this crop' };
    const existing = this._block(pos);
    if (cropName && existing && String(existing.name).replace(/^minecraft:/, '') === cropName) {
      return { ok: true, already: true, position: { ...pos } };
    }
    const belowPos = { x: pos.x, y: pos.y - 1, z: pos.z };
    const below = this._block(belowPos);
    if (!below) return { ok: false, error: 'soil below the crop is unloaded' };
    if (below.name !== 'farmland') {
      const tilled = await this.till(belowPos);
      if (!tilled.ok) return { ok: false, error: `soil is not farmland and could not be tilled: ${tilled.error}` };
    }
    if (this.bot.countItem(seed) < 1) return { ok: false, error: `no ${seed}` };
    const name = cropName || normalizeCrop(seed.replace(/_seeds$/, '')) || null;
    return this._plantAt(pos, name, seed, { replant: true });
  }

  async _plantAt(pos, cropName, seed, { replant = false } = {}) {
    if (!cropName) return { ok: false, error: 'unknown crop block' };
    const current = this._block(pos);
    if (!current) return { ok: false, error: 'planting position is unloaded' };
    if (String(current.name).replace(/^minecraft:/, '') === cropName) return { ok: true, already: true, position: { ...pos } };
    if (!this._isReplaceable(current)) return { ok: false, error: `planting position occupied by ${current.name}` };
    const below = this._block({ x: pos.x, y: pos.y - 1, z: pos.z });
    if (!below || below.name !== 'farmland') return { ok: false, error: 'crops can only be planted on farmland' };
    const def = CROPS[cropName];
    if (def && def.double) {
      const above = this._block({ x: pos.x, y: pos.y + 1, z: pos.z });
      if (!above || !this._isReplaceable(above)) return { ok: false, error: `tall crop needs a clear second block (${above ? above.name : 'unloaded'})` };
    }
    const move = await this.bot.goTo(pos, { range: 4 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const placed = await this.bot.placeBlock(pos, seed);
    if (!placed.ok) return { ...placed, error: placed.error || `could not place ${seed}` };
    // The simulator stores the held item; the live server stores the crop
    // block. Mirror the server transition in the mock world, then verify the
    // final block through getBlock in both cases.
    const world = this.bot.world;
    if (world && world.overrides instanceof Map && typeof world.setBlock === 'function') {
      world.setBlock(pos, cropName, { age: 0, ...(def && def.double ? { half: 'lower' } : {}) });
      if (def && def.double) world.setBlock({ x: pos.x, y: pos.y + 1, z: pos.z }, cropName, { age: 0, half: 'upper' });
    }
    let actual = this._name(pos);
    for (let i = 0; i < 6 && actual !== cropName; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      actual = this._name(pos);
    }
    if (actual !== cropName) return { ok: false, position: { ...pos }, error: `placed block is ${actual || 'unknown'}, expected ${cropName}` };
    if (replant) this.stats.replanted++;
    this._statusCache = null;
    return { ok: true, position: { ...pos }, crop: cropName, seed };
  }

  async harvestAll({ radius = this.farmRadius, limit = 32, crop = null, types = null, matureOnly = true } = {}) {
    this._begin();
    const requested = crop !== null && crop !== undefined ? crop : types;
    const requestedName = requested ? String(requested).toLowerCase() : null;
    const explicitAll = requestedName === 'all' || requestedName === 'harvest';
    if (requested && !explicitAll && !normalizeCrop(requested)) {
      return { ok: false, harvested: 0, produced: 0, results: [], error: `unknown crop ${requested}` };
    }
    const wanted = explicitAll ? null : normalizeCrop(requested);
    const crops = this.scanCrops({ radius, crop: wanted }).slice(0, limit);
    if (!crops.length) return { ok: true, idle: true, harvested: 0, produced: 0, standing: 0, results: [], crop: wanted, reason: wanted ? `no ${wanted} crops nearby` : 'no crops nearby' };
    const results = [];
    const immature = [];
    let produced = 0;
    let harvested = 0;
    for (const target of crops) {
      if (this.stopRequested) break;
      const block = this._block(target);
      if (!block || !cropDefinition(block.name)) continue;
      if (matureOnly && !isMatureCrop(block)) {
        immature.push({ position: { x: target.x, y: target.y, z: target.z }, crop: block.name, age: cropAge(block) });
        this.stats.immatureSkipped++;
        continue;
      }
      const result = await this.harvest(target);
      results.push(result);
      if (result.ok) {
        harvested += result.harvested || 0;
        produced += result.produced || 0;
      } else if (result.immature) {
        immature.push({ position: { x: target.x, y: target.y, z: target.z }, crop: block.name, age: result.age });
      }
    }
    return {
      ok: true, crop: wanted, harvested, produced, immature: immature.length,
      standing: crops.length,
      mature: crops.filter((entry) => entry.mature).length,
      skipped: immature.slice(0, 20), results,
      idle: harvested === 0
    };
  }

  // ------------------------------------------------------------------
  // Farm establishment: real soil, real hoe, real water, verified crops.
  // ------------------------------------------------------------------
  async _ensureHoe() {
    const held = typeof this.bot.bestToolFor === 'function' ? this.bot.bestToolFor('hoe') : null;
    if (held) return { ok: true, tool: held.name || held };
    const direct = Object.keys(this.bot.inventory || {}).find((name) => /_hoe$/.test(name) && this.bot.countItem(name) > 0);
    if (direct) return { ok: true, tool: direct };
    if (this.inventory && typeof this.inventory.ensureMaterials === 'function'
      && (this.bot.countItem('oak_planks') < 2 || this.bot.countItem('stick') < 2)) {
      await this.inventory.ensureMaterials({ oak_planks: 2, stick: 2 }).catch(() => null);
    }
    if (this.bot.countItem('oak_planks') < 2) {
      const log = Object.keys(this.bot.inventory || {}).find((name) => /_log$/.test(name) && this.bot.countItem(name) > 0);
      if (log && typeof this.bot.craft === 'function') {
        const crafted = await this.bot.craft(log.replace(/_log$/, '_planks'), 1).catch((err) => ({ ok: false, error: err.message }));
        if (!crafted.ok) return { ok: false, error: `cannot mill planks for a hoe: ${crafted.error}` };
      }
    }
    if (this.bot.countItem('stick') < 2 && this.bot.countItem('oak_planks') >= 2 && typeof this.bot.craft === 'function') {
      await this.bot.craft('stick', 1).catch(() => null);
    }
    if (this.bot.countItem('oak_planks') < 2 || this.bot.countItem('stick') < 2 || typeof this.bot.craft !== 'function') {
      return { ok: false, error: 'no hoe and not enough planks/sticks to craft one' };
    }
    let crafted = await this.bot.craft('wooden_hoe', 1).catch((err) => ({ ok: false, error: err.message }));
    if (!crafted.ok && /recipe|table|ingredient/i.test(String(crafted.error || ''))
      && this.inventory && typeof this.inventory._ensureCraftingTable === 'function') {
      const table = await this.inventory._ensureCraftingTable(this.home || this.bot.position).catch((err) => ({ ok: false, error: err.message }));
      if (table.ok) crafted = await this.bot.craft('wooden_hoe', 1).catch((err) => ({ ok: false, error: err.message }));
    }
    if (!crafted.ok) return { ok: false, error: `cannot craft a hoe: ${crafted.error}` };
    this.stats.crafted = (this.stats.crafted || 0) + 1;
    return { ok: true, tool: 'wooden_hoe', crafted: true };
  }

  async till(pos) {
    const block = this._block(pos);
    if (!block) return { ok: false, error: 'soil position is unloaded' };
    if (block.name === 'farmland') return { ok: true, already: true, position: { ...pos } };
    if (!TILLABLE.has(block.name)) return { ok: false, error: `${block.name} cannot be tilled` };
    const hoe = await this._ensureHoe();
    if (!hoe.ok) return hoe;
    if (typeof this.bot.tillSoil !== 'function') return { ok: false, error: 'adapter does not support tilling' };
    if (distance(this.bot.position, pos) > 4) {
      const move = await this.bot.goTo(pos, { range: 4, timeoutMs: 12000 });
      if (move && move.ok === false) return { ok: false, error: move.error };
    }
    const result = await this.bot.tillSoil(pos);
    if (!result || !result.ok) return result || { ok: false, error: 'tilling failed' };
    const after = this._name(pos);
    if (after !== 'farmland') return { ok: false, error: `tilling left ${after || 'unknown'} instead of farmland` };
    this.stats.tilled++;
    return { ...result, ok: true, tool: hoe.tool, position: { ...pos } };
  }

  _waterNear(pos, radius = 4) {
    // Vanilla farmland is hydrated by water within four blocks horizontally
    // and at most one block above it.
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (const dy of [0, 1]) {
          const name = this._name({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz });
          if (name && WATER.has(name)) return { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
        }
      }
    }
    return null;
  }

  _hydrated(pos) { return Boolean(this._waterNear(pos)); }

  _localSoil(origin, radius, limit = 400) {
    const found = [];
    const r = Math.max(1, Math.min(radius, 24));
    const cx = Math.floor(origin.x);
    const cy = Math.floor(origin.y);
    const cz = Math.floor(origin.z);
    for (let dy = -8; dy <= 8; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const pos = { x: cx + dx, y: cy + dy, z: cz + dz };
          const block = this._block(pos);
          if (!block || !(TILLABLE.has(block.name) || block.name === 'farmland')) continue;
          const above = this._block({ x: pos.x, y: pos.y + 1, z: pos.z });
          if (!above || !this._isReplaceable(above)) continue;
          const above2 = this._block({ x: pos.x, y: pos.y + 2, z: pos.z });
          if (!above2 || !this._isReplaceable(above2)) continue;
          found.push({ ...pos, soil: block.name, distance: distance(origin, { x: pos.x, y: pos.y + 1, z: pos.z }) });
          if (found.length >= limit) break;
        }
        if (found.length >= limit) break;
      }
      if (found.length >= limit) break;
    }
    return found.sort((a, b) => a.distance - b.distance);
  }

  _readyFarmland(origin, radius, limit = 128) {
    return this._localSoil(origin, radius, limit * 4)
      .filter((cell) => cell.soil === 'farmland')
      .slice(0, limit);
  }

  _flatPlot(origin, side, radius, def) {
    const baseY = Math.floor(origin.y) - 1;
    const half = Math.floor(side / 2);
    const anchors = [];
    const centre = this.home || origin;
    for (let r = Math.max(3, side); r <= radius; r += 2) {
      for (let dz = -r; dz <= r; dz += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          anchors.push({ x: Math.floor(centre.x) + dx, z: Math.floor(centre.z) + dz });
        }
      }
    }
    const base = this.memory && typeof this.memory.getFact === 'function' ? this.memory.getFact('base_anchor') : null;
    for (const anchor of anchors) {
      if (base && Math.hypot(anchor.x - base.x, anchor.z - base.z) < half + 4) continue;
      if (Math.hypot(anchor.x - centre.x, anchor.z - centre.z) < Math.max(2, half)) continue;
      const minX = anchor.x - half;
      const minZ = anchor.z - half;
      const cells = [];
      let valid = true;
      for (let z = minZ; z < minZ + side && valid; z++) {
        for (let x = minX; x < minX + side; x++) {
          const ground = this._block({ x, y: baseY, z });
          if (!ground || !(TILLABLE.has(ground.name) || ground.name === 'farmland')) { valid = false; break; }
          const above = this._block({ x, y: baseY + 1, z });
          const above2 = this._block({ x, y: baseY + 2, z });
          if (!above || !this._isReplaceable(above) || !above2 || !this._isReplaceable(above2)) { valid = false; break; }
          cells.push({ x, y: baseY, z });
        }
      }
      if (valid && cells.length === side * side) {
        return { origin: { x: minX, y: baseY, z: minZ }, side, cells, distance: distance(origin, anchor), crop: def ? def.seed : null };
      }
    }
    return null;
  }

  _waterLayout(site, def) {
    if (!site) return [];
    const side = site.side;
    if (side <= 5) {
      const c = Math.floor(side / 2);
      return [{ x: site.origin.x + c, y: site.origin.y, z: site.origin.z + c }];
    }
    const cells = [];
    for (let z = 2; z < side - 1; z += 4) {
      for (let x = 2; x < side - 1; x += 4) {
        cells.push({ x: site.origin.x + x, y: site.origin.y, z: site.origin.z + z });
      }
    }
    return cells;
  }

  _selectPlantCells(cells, count, def) {
    if (!def || !def.stem) return cells.slice(0, count);
    const selected = [];
    const reserved = new Set();
    for (const cell of cells) {
      if (selected.length >= count) break;
      const k = keyOf(cell);
      if (reserved.has(k)) continue;
      const neighbour = cells.find((other) => {
        if (other === cell) return false;
        if (reserved.has(keyOf(other))) return false;
        return (Math.abs(other.x - cell.x) === 1 && other.z === cell.z) || (Math.abs(other.z - cell.z) === 1 && other.x === cell.x);
      });
      if (!neighbour) continue;
      selected.push(cell);
      reserved.add(keyOf(neighbour));
    }
    return selected;
  }

  async _preparePlot({ count, radius, origin, def }) {
    const multiplier = def.stem ? 32 / 15 : 16 / 15;
    let side = Math.max(3, Math.ceil(Math.sqrt(Math.max(1, count) * multiplier)));
    if (def.stem) side += 1;
    side = Math.min(side, 15);
    let site = this._flatPlot(origin, side, radius, def);
    if (!site) site = this._flatPlot(origin, Math.max(3, side - 2), radius, def);
    if (!site) return { ok: false, error: 'no flat clear ground near home for a farm plot' };

    // Clear vegetation above every cell. Crops/blocks are never overwritten:
    // the site scan already rejected occupied cells.
    for (const cell of site.cells) {
      const above = this._block({ x: cell.x, y: cell.y + 1, z: cell.z });
      if (above && !['air', 'cave_air'].includes(above.name) && this._isReplaceable(above)) {
        await this.bot.goTo({ x: cell.x, y: cell.y + 1, z: cell.z }, { range: 4 });
        await this.bot.digBlock({ x: cell.x, y: cell.y + 1, z: cell.z });
      }
    }

    const waterPositions = this._waterLayout(site, def);
    const canWater = this.bot.countItem('water_bucket') > 0;
    const waterKeys = new Set(canWater ? waterPositions.map(keyOf) : []);
    const farmCells = site.cells.filter((cell) => !waterKeys.has(keyOf(cell)));
    const tilled = [];
    let firstTillError = null;
    for (const cell of farmCells) {
      const before = this._name(cell);
      if (before === 'farmland') { tilled.push(cell); continue; }
      const result = await this.till(cell);
      if (result.ok) tilled.push(cell);
      else if (!firstTillError) {
        firstTillError = result.error;
        if (/no hoe|not enough planks|cannot craft a hoe/i.test(String(result.error || ''))) break;
      }
    }
    if (!tilled.length) return { ok: false, error: firstTillError || 'could not till any farm cell' };

    let waterPlaced = 0;
    const waterCells = [];
    let bucket = this.bot.countItem('water_bucket');
    for (const water of waterPositions) {
      if (bucket < 1) break;
      const existing = this._name(water);
      if (existing && WATER.has(existing)) { waterPlaced++; waterCells.push({ ...water }); continue; }
      if (distance(this.bot.position, water) > 4) {
        const move = await this.bot.goTo(water, { range: 4, timeoutMs: 12000 });
        if (move && move.ok === false) continue;
      }
      const dig = await this.bot.digBlock(water);
      if (!dig.ok) continue;
      const placed = await this.bot.placeBlock(water, 'water_bucket');
      if (!placed.ok || !WATER.has(this._name(water))) {
        // Do not leave a hole in the plot: put soil back when possible.
        if (this.bot.countItem('dirt') > 0) await this.bot.placeBlock(water, 'dirt');
        continue;
      }
      waterPlaced++;
      waterCells.push({ ...water });
      bucket--;
      this.stats.waterPlaced++;
    }

    // Simulator has no fluid tick; set the moisture state the live server
    // would compute so growth and status reflect the real irrigation.
    const world = this.bot.world;
    if (world && world.overrides instanceof Map && typeof world.setBlock === 'function') {
      for (const cell of tilled) {
        if (this._hydrated(cell)) world.setBlock(cell, 'farmland', { moisture: 7 });
      }
    }

    const usable = tilled.filter((cell) => {
      const soil = this._name(cell);
      const above = this._block({ x: cell.x, y: cell.y + 1, z: cell.z });
      return soil === 'farmland' && above && this._isReplaceable(above);
    });
    const hydrated = usable.filter((cell) => this._hydrated(cell)).length;
    const plot = {
      layout: 'plot', origin: { ...site.origin }, side: site.side,
      cells: usable.map((cell) => ({ ...cell })), tilled: tilled.length,
      waterCells, waterPlaced, hydrated, watered: waterPlaced > 0 || hydrated > 0,
      crop: def.seed, preparedAt: Date.now()
    };
    this.stats.plotsPrepared++;
    this.lastPlot = plot;
    if (this.memory && typeof this.memory.setFact === 'function') this.memory.setFact('farm_plot', plot);
    if (!usable.length) return { ok: false, error: 'plot has no usable farmland', plot };
    return { ok: true, plot, cells: usable, waterPlaced, hydrated, watered: plot.watered };
  }

  async plantCrops({ crop = 'wheat', count = 16, radius = this.farmRadius } = {}) {
    this._begin();
    const name = normalizeCrop(crop === undefined || crop === null ? 'wheat' : crop);
    const def = name ? CROPS[name] : null;
    if (!def) return { ok: false, planted: 0, error: `unknown crop ${crop}` };
    if (this.bot.countItem(def.seed) < 1) return { ok: false, planted: 0, error: `no ${def.seed}` };
    const target = Math.max(1, Math.floor(Number(count) || 1));
    const results = [];
    let planted = 0;
    let origin = this.home || this.bot.position;
    if (this.home && distance(this.home, this.bot.position) > Math.max(8, radius / 2)) {
      const back = await this.bot.goTo(this.home, { range: 3, timeoutMs: 20000 });
      if (!back || back.ok !== false) origin = { ...this.bot.position };
    }

    // First use real, already-tilled farmland instead of building a new plot.
    const ready = this._readyFarmland(origin, radius, Math.max(target * 2, 32));
    for (const cell of ready) {
      if (planted >= target || this.stopRequested) break;
      if (this.bot.countItem(def.seed) < 1) break;
      if (!this._isReplaceable(this._block({ x: cell.x, y: cell.y + 1, z: cell.z }))) continue;
      const result = await this._plantAt({ x: cell.x, y: cell.y + 1, z: cell.z }, name, def.seed);
      results.push(result);
      if (result.ok) planted++;
    }

    let plot = null;
    if (planted < target && !this.stopRequested && this.bot.countItem(def.seed) > 0) {
      const prepared = await this._preparePlot({ count: target - planted, radius, origin, def });
      if (prepared.ok) {
        plot = prepared.plot;
        const selected = this._selectPlantCells(prepared.cells, target - planted, def);
        for (const cell of selected) {
          if (planted >= target || this.stopRequested || this.bot.countItem(def.seed) < 1) break;
          const result = await this._plantAt({ x: cell.x, y: cell.y + 1, z: cell.z }, name, def.seed);
          results.push(result);
          if (result.ok) planted++;
        }
      } else if (planted === 0) {
        // A missing hoe is an honest failure, not a reason to try every cell.
        if (/no hoe|not enough planks|cannot craft a hoe/i.test(String(prepared.error || ''))) {
          return { ok: false, planted, crop: name, seed: def.seed, error: prepared.error, results };
        }
        // Uneven ground: fall back to individual tillable cells rather than
        // claiming a farm that does not exist.
        const scattered = this._localSoil(origin, radius, Math.max(target * 4, 64));
        for (const cell of scattered) {
          if (planted >= target || this.stopRequested || this.bot.countItem(def.seed) < 1) break;
          if (cell.soil !== 'farmland') {
            const tilled = await this.till(cell);
            if (!tilled.ok) { results.push(tilled); continue; }
          }
          const result = await this._plantAt({ x: cell.x, y: cell.y + 1, z: cell.z }, name, def.seed);
          results.push(result);
          if (result.ok) planted++;
        }
        if (planted === 0) return { ok: false, planted, crop: name, seed: def.seed, error: prepared.error, results };
      }
    }

    this.stats.planted += planted;
    if (this.farmPlots.length > 40) this.farmPlots.splice(0, this.farmPlots.length - 40);
    this._statusCache = null;
    const farm = plot || (ready.length ? { layout: 'existing', cells: ready.slice(0, target), watered: ready.some((cell) => this._hydrated(cell)) } : null);
    return {
      ok: planted > 0, planted, crop: name, seed: def.seed, target,
      seedsLeft: this.bot.countItem(def.seed), farm, layout: farm ? farm.layout : null,
      tilled: plot ? plot.tilled : 0, waterPlaced: plot ? plot.waterPlaced : 0,
      watered: farm ? farm.watered : false, verified: planted > 0, results
    };
  }

  /**
   * Harvest mature crops and, when seeds are available, fill empty farmland and
   * replant. This is the maintenance entry point used by the idle tick.
   */
  async maintain({ radius = this.farmRadius, maxPlant = 8 } = {}) {
    const harvest = await this.harvestAll({ radius });
    let planted = 0;
    const seedCrops = Object.entries(CROPS)
      .map(([crop, def]) => ({ crop, count: this.bot.countItem(def.seed) }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count);
    if (seedCrops.length) {
      const empty = this._readyFarmland(this.home || this.bot.position, radius, Math.max(1, maxPlant));
      // No farmland at all is the establishment case: build a plot instead of
      // calling maintenance a success because a seed exists in the inventory.
      if (empty.length || harvest.standing === 0) {
        const start = await this.plantCrops({ crop: seedCrops[0].crop, count: Math.min(maxPlant, seedCrops[0].count), radius });
        planted = start.planted || 0;
      }
    }
    return { ok: harvest.harvested > 0 || planted > 0, harvest, plant: { planted } };
  }

  async feedAnimals({ radius = this.farmRadius, max = 4 } = {}) {
    const animals = (this.bot.entitiesNear ? this.bot.entitiesNear(radius) : []).filter((e) => ANIMALS[e.name || e.type] && !e.baby);
    const fed = [];
    const skipped = [];
    for (const animal of animals.slice(0, max)) {
      if (this.stopRequested) break;
      const key = animal.id || `${animal.name || animal.type}:${animal.position.x},${animal.position.z}`;
      const last = this._animalCooldowns.get(key) || 0;
      if (Date.now() - last < ANIMAL_FEED_COOLDOWN_MS) { skipped.push({ animal: animal.name || animal.type, reason: 'breeding cooldown' }); continue; }
      const food = ANIMALS[animal.name || animal.type];
      if (!food || !this.bot.countItem(food)) { skipped.push({ animal: animal.name || animal.type, reason: `no ${food}` }); continue; }
      if (typeof this.bot.feed !== 'function') break;
      const move = await this.bot.goTo(animal.position, { range: 2 });
      if (move && move.ok === false) { skipped.push({ animal: animal.name || animal.type, reason: move.error }); continue; }
      const result = await this.bot.feed(animal, food);
      if (result.ok) {
        fed.push({
          animal: animal.name || animal.type, food, consumed: result.consumed, verified: result.verified,
          bred: Boolean(result.bred), offspring: result.offspring || null
        });
        this.stats.animalsFed++;
        if (result.bred) this.stats.animalsBred++;
        this._animalCooldowns.set(key, Date.now());
      } else {
        skipped.push({ animal: animal.name || animal.type, reason: result.error || 'feeding failed' });
      }
    }
    const bred = fed.filter((entry) => entry.bred);
    return {
      ok: fed.length > 0, fed, skipped, bred: bred.length,
      offspring: bred.map((entry) => entry.offspring),
      note: fed.length ? undefined : (animals.length ? 'no animal could be fed' : 'no breedable animals nearby')
    };
  }

  async tick(options = {}) {
    const harvest = await this.harvestAll(options);
    // If there is nothing growing and seeds are available, start a real farm
    // instead of idling forever beside bare soil.
    let plant = null;
    if (harvest.ok !== false && harvest.standing === 0 && Date.now() >= this._nextPlantAttempt) {
      const seed = Object.entries(CROPS)
        .map(([crop, def]) => ({ crop, count: this.bot.countItem(def.seed) }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count)[0];
      if (seed) {
        plant = await this.plantCrops({ crop: seed.crop, count: Math.min(8, seed.count), radius: options.radius || this.farmRadius });
        this._nextPlantAttempt = Date.now() + (plant.planted > 0 ? 10000 : 60000);
      }
    }
    const feed = await this.feedAnimals();
    return {
      ok: harvest.ok !== false,
      worked: harvest.harvested > 0 || Boolean(plant && plant.planted > 0) || feed.fed.length > 0,
      harvest, plant, feed, status: this.status()
    };
  }
}

module.exports = { FarmingController, CROPS, ANIMALS, SOIL, CROP_ALIASES, normalizeCrop, isMatureCrop, cropAge };
