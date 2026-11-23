'use strict';

const { config } = require('../config');
const { Logger } = require('../logger');
const { distance } = require('../util/vec');

const ORE_TIERS = {
  coal_ore: 1, deepslate_coal_ore: 1, copper_ore: 1, deepslate_copper_ore: 1,
  iron_ore: 2, deepslate_iron_ore: 2, lapis_ore: 2, deepslate_lapis_ore: 2,
  gold_ore: 3, deepslate_gold_ore: 3, redstone_ore: 3, deepslate_redstone_ore: 3,
  diamond_ore: 3, deepslate_diamond_ore: 3, emerald_ore: 3, deepslate_emerald_ore: 3,
  ancient_debris: 4
};

const ORE_NAMES = Object.keys(ORE_TIERS);
const ORE_DROPS = {
  coal_ore: 'coal', deepslate_coal_ore: 'coal', iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper', gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond', emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
  ancient_debris: 'netherite_scrap'
};
const HAZARDS = new Set(['lava', 'flowing_lava', 'water', 'flowing_water', 'bedrock', 'spawner']);

const NEIGHBOUR_OFFSETS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
];

/**
 * Find the nearest exposed blocks of the wanted types. The generic findBlocks
 * helper caps results at a flat limit, and because it scans y ascending that
 * limit fills with one buried layer. Mining needs reachable faces, so scan the
 * local cube and test air neighbours as we go.
 */
function findExposed(bot, names, { radius = 16, minY = -59, limit = 8 } = {}) {
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  const world = bot.world;
  const origin = bot.position;
  const r = Math.max(1, Math.min(radius, 20));
  const found = [];
  for (let dy = -r; dy <= r; dy++) {
    const y = Math.floor(origin.y) + dy;
    if (y < minY) continue;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.floor(origin.x) + dx;
        const z = Math.floor(origin.z) + dz;
        const name = world && typeof world.blockNameAt === 'function' ? world.blockNameAt(x, y, z) : null;
        if (!name || !wanted.has(name)) continue;
        let exposed = false;
        for (const [ox, oy, oz] of NEIGHBOUR_OFFSETS) {
          const other = world && typeof world.blockNameAt === 'function'
            ? world.blockNameAt(x + ox, y + oy, z + oz)
            : (bot.getBlock({ x: x + ox, y: y + oy, z: z + oz }) || {}).name;
          if (other === 'air' || other === 'cave_air' || other === 'water') { exposed = true; break; }
        }
        if (exposed) found.push({ x, y, z, name, distance: distance(origin, { x, y, z }) });
      }
    }
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.slice(0, limit);
}

/**
 * Ore mining with cave safety. Never digs into lava, never opens a liquid
 * ceiling, respects tool tiers, lights tunnels, and records discoveries in
 * shared memory with attribution.
 */
class MiningController {
  constructor({ bot, memory = null, ledger = null, logger = null } = {}) {
    if (!bot) throw new Error('MiningController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.ledger = ledger;
    this.logger = logger || new Logger({ level: 'warn' });
    this.stats = { oresMined: 0, blocksDug: 0, hazardsAvoided: 0, torchesPlaced: 0, tunnels: 0 };
    this.mined = {};
    this.stopRequested = false;
  }

  status() {
    return {
      bot: this.bot.name,
      position: { ...this.bot.position },
      pickaxe: this.bot.bestToolFor('pickaxe'),
      oresMined: { ...this.mined },
      stopped: Boolean(this.stopRequested),
      stats: { ...this.stats },
      nearbyOres: this.findOres({ radius: 12, limit: 8 }).map((o) => ({ name: o.name, position: { x: o.x, y: o.y, z: o.z }, distance: Math.round(distance(this.bot.position, o)) }))
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

  findOres({ radius = config.mining.maxSearchRadius, limit = 32 } = {}) {
    // Exposed ore only: a flat findBlocks limit returns one deep buried layer,
    // which mineOre() can neither walk to nor reach with its pickaxe.
    return findExposed(this.bot, ORE_NAMES, { radius: Math.min(radius, 20), minY: -59, limit });
  }

  /** Hazards are checked before every dig: adjacent lava/water and a liquid ceiling. */
  checkSafety(pos, { ignoreFloor = false } = {}) {
    const hazards = [];
    const neighbours = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of neighbours) {
      const block = this.bot.getBlock({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz });
      const name = block ? block.name : 'air';
      if (HAZARDS.has(name)) hazards.push({ position: { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }, block: name, reason: 'adjacent hazard' });
    }
    // Liquids two blocks above mean the ceiling would be opened.
    for (let dy = 2; dy <= 3; dy++) {
      const above = this.bot.getBlock({ x: pos.x, y: pos.y + dy, z: pos.z });
      if (above && (above.name === 'water' || above.name === 'lava' || above.name === 'flowing_lava' || above.name === 'flowing_water')) {
        hazards.push({ position: { x: pos.x, y: pos.y + dy, z: pos.z }, block: above.name, reason: 'liquid ceiling' });
      }
    }
    const supported = this.bot.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
    // A downward shaft deliberately removes the floor; that is not a fall
    // hazard, only an unsupported stance when working sideways.
    if (!ignoreFloor && (!supported || supported.name === 'air')) hazards.push({ block: 'air', reason: 'unsupported floor (fall risk)' });
    return { safe: hazards.length === 0, hazards };
  }

  _toolOk(oreName) {
    const required = ORE_TIERS[oreName] || 0;
    const tool = this.bot.bestToolFor('pickaxe');
    return { ok: Boolean(tool) && tool.tier >= required, required, tier: tool ? tool.tier : 0, tool: tool ? tool.name : null };
  }

  async mineOre(pos, { collect = true } = {}) {
    const block = this.bot.getBlock(pos);
    if (!block || block.name === 'air') return { ok: false, error: 'block is air' };
    if (!ORE_TIERS[block.name]) return { ok: false, error: `not an ore: ${block.name}` };
    const safety = this.checkSafety(pos);
    if (!safety.safe) {
      this.stats.hazardsAvoided++;
      return { ok: false, error: 'unsafe to mine', hazards: safety.hazards, ore: block.name };
    }
    const tool = this._toolOk(block.name);
    if (!tool.ok) return { ok: false, error: `need pickaxe tier ${tool.required}`, required: tool.required, have: tool.tier };
    const move = await this.bot.goTo(pos, { range: 3 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    await this.bot.equipBestTool('pickaxe');
    const dig = await this.bot.digBlock(pos);
    if (!dig.ok) return { ok: false, error: dig.error };
    this.stats.blocksDug++;
    this.stats.oresMined++;
    const drop = ORE_DROPS[block.name];
    this.mined[drop] = (this.mined[drop] || 0) + 1;
    if (collect && typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(6);
    if (this.memory) {
      this.memory.observe({
        type: 'ORE_DEPOSIT', resource: block.name, position: { ...pos }, reportedBy: this.bot.name,
        confidence: 0.95, status: 'MINED', data: { drop, at: Date.now(), miner: this.bot.name }
      });
    }
    if (this.ledger) {
      this.ledger.updateBotInventory(this.bot.name, this.bot.inventory);
      const reserve = this.ledger.reserve(drop, 1, { purpose: 'mining', owner: this.bot.name });
      if (reserve.ok) this.ledger.commit(reserve.reservation.id, 1);
    }
    return { ok: true, ore: block.name, drop, position: { ...pos } };
  }

  /** Mine a specific block type (stone, cobblestone, deepslate) with the same safety rules. */
  async mineBlocks({ block: blockName = 'stone', radius = 24, limit = 16, minY = -59 } = {}) {
    this._begin();
    const names = [blockName, blockName === 'stone' ? 'deepslate' : null].filter(Boolean);
    const targets = findExposed(this.bot, names, { radius: 16, minY, limit })
      // Only exposed blocks are mineable without a tunnel: aiming at buried
      // stone made goTo() fall back to the surface and every dig fail as
      // "too far to dig", freezing the quota.
      .map((b) => ({ ...b, distance: distance(this.bot.position, b) }))
      .sort((a, b) => a.distance - b.distance);
    const results = [];
    for (const target of targets) {
      if (this.stopRequested) break;
      const block = this.bot.getBlock(target);
      if (!block || block.name === 'air') continue;
      const safety = this.checkSafety(target);
      if (!safety.safe) {
        this.stats.hazardsAvoided++;
        results.push({ ok: false, error: 'unsafe to mine', hazards: safety.hazards, block: block.name });
        continue;
      }
      const tool = this.bot.bestToolFor('pickaxe');
      if (!tool) {
        results.push({ ok: false, error: 'no pickaxe available' });
        break;
      }
      const stance = NEIGHBOUR_OFFSETS
        .map(([ox, oy, oz]) => ({ x: target.x + ox, y: target.y + oy, z: target.z + oz }))
        .find((n) => {
          const block = this.bot.getBlock(n);
          return block && (block.name === 'air' || block.name === 'cave_air' || block.name === 'water');
        });
      const move = await this.bot.goTo(stance || target, { range: 1 });
      if (move && move.ok === false) {
        results.push({ ok: false, error: move.error });
        continue;
      }
      await this.bot.equipBestTool('pickaxe');
      const dig = await this.bot.digBlock(target);
      if (!dig.ok) {
        results.push({ ok: false, error: dig.error });
        continue;
      }
      this.stats.blocksDug++;
      if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(4);
      results.push({ ok: true, block: block.name, position: { x: target.x, y: target.y, z: target.z } });
      if (this.bot.health <= config.mining.retreatHealth || this.stopRequested) break;
    }
    let mined = results.filter((r) => r.ok).length;
    if (!mined) {
      // No reachable exposed block: sink a safe vertical access shaft and take
      // the requested block from below the bot (the same thing a player does).
      for (let depth = 0; depth < 8 && mined < limit && !this.stopRequested; depth++) {
        const below = { x: Math.floor(this.bot.position.x), y: Math.floor(this.bot.position.y) - 1, z: Math.floor(this.bot.position.z) };
        if (below.y < minY) {
          results.push({ ok: false, error: `minimum mining depth ${minY} reached`, depthReached: below.y });
          break;
        }
        const block = this.bot.getBlock(below);
        if (!block || block.name === 'air') {
          const move = await this.bot.goTo(below, { range: 0 });
          if (!move || move.ok === false) break;
          continue;
        }
        const safety = this.checkSafety(below, { ignoreFloor: true });
        if (!safety.safe) {
          this.stats.hazardsAvoided++;
          results.push({ ok: false, error: 'unsafe shaft block', hazards: safety.hazards });
          break;
        }
        const dig = await this.bot.digBlock(below);
        if (!dig.ok) {
          results.push({ ok: false, error: dig.error });
          break;
        }
        this.stats.blocksDug++;
        const isWanted = block.name === blockName || (blockName === 'stone' && block.name === 'deepslate');
        if (isWanted) mined++;
        results.push({ ok: true, block: block.name, position: below, shaft: true });
        const move = await this.bot.goTo(below, { range: 0 });
        if (!move || move.ok === false) break;
        if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(4);
      }
    }
    if (!mined) {
      // The local pocket and the vertical shaft are exhausted (or the depth
      // floor blocked it). Drive a short horizontal branch instead of idling
      // at the bottom of the band forever.
      this._branchAxis = this._branchAxis === 'z' ? 'x' : 'z';
      this._branchDir = -(this._branchDir || 1);
      const branch = await this.branchMine({ length: 12, axis: this._branchAxis, direction: this._branchDir, torchEvery: 6 });
      mined += branch.mined;
      results.push({ ok: branch.mined > 0, branch: true, mined: branch.mined, stopped: branch.stopped, axis: this._branchAxis });
    }
    return { ok: mined > 0, mined, skipped: results.filter((r) => !r.ok).length, results, block: blockName };
  }

  /** Mine every safe ore in range, best-first by distance. */
  async mineNearby({ radius = 24, limit = 16 } = {}) {
    this._begin();
    const ores = this.findOres({ radius, limit });
    const results = [];
    for (const ore of ores) {
      if (this.stopRequested) break;
      const result = await this.mineOre({ x: ore.x, y: ore.y, z: ore.z });
      results.push(result);
      if (this.bot.health <= config.mining.retreatHealth) break;
    }
    return {
      ok: results.some((r) => r.ok),
      mined: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => !r.ok).length,
      results
    };
  }

  /** Ore search that can sink a safe shaft when no ore is reachable from the surface. */
  async mineOresDeep({ radius = 48, limit = 6, maxDepth = 8, minY = -59 } = {}) {
    this._begin();
    const shallow = await this.mineNearby({ radius, limit });
    if (shallow.mined > 0 || this.stopRequested) return shallow;
    const results = [];
    let mined = 0;
    for (let depth = 0; depth < maxDepth && mined < limit && !this.stopRequested; depth++) {
      const below = { x: Math.floor(this.bot.position.x), y: Math.floor(this.bot.position.y) - 1, z: Math.floor(this.bot.position.z) };
      // Never dig past the task's depth band or the world floor: an unbounded
      // shaft used to walk bots thousands of blocks down and stall the quota.
      if (below.y < minY) {
        results.push({ ok: false, error: `minimum mining depth ${minY} reached`, depthReached: below.y });
        break;
      }
      const block = this.bot.getBlock(below);
      if (!block || block.name === 'air') {
        const move = await this.bot.goTo(below, { range: 0 });
        if (!move || move.ok === false) break;
        continue;
      }
      const safety = this.checkSafety(below, { ignoreFloor: true });
      if (!safety.safe) {
        this.stats.hazardsAvoided++;
        results.push({ ok: false, error: 'unsafe shaft block', hazards: safety.hazards });
        break;
      }
      if (ORE_TIERS[block.name]) {
        const oreResult = await this.mineOre(below);
        results.push(oreResult);
        if (oreResult.ok) mined++;
      } else {
        const dig = await this.bot.digBlock(below);
        if (!dig.ok) {
          results.push({ ok: false, error: dig.error });
          break;
        }
        this.stats.blocksDug++;
        results.push({ ok: true, block: block.name, shaft: true });
      }
      const move = await this.bot.goTo(below, { range: 0 });
      if (!move || move.ok === false) break;
    }
    return { ok: mined > 0, mined, skipped: results.filter((r) => !r.ok).length, results };
  }

  /** A 1x2 branch tunnel with torches, stopping at hazards. */
  async branchMine({ length = 16, axis = 'x', direction = 1, torchEvery = config.mining.torchInterval } = {}) {
    this._begin();
    const start = { ...this.bot.position };
    let mined = 0;
    let placed = 0;
    let stopped = null;
    for (let step = 1; step <= length && !this.stopRequested; step++) {
      const feet = { x: Math.floor(start.x) + (axis === 'x' ? step * direction : 0), y: Math.floor(start.y), z: Math.floor(start.z) + (axis === 'z' ? step * direction : 0) };
      const head = { ...feet, y: feet.y + 1 };
      for (const pos of [feet, head]) {
        const block = this.bot.getBlock(pos);
        if (!block || block.name === 'air') continue;
        if (HAZARDS.has(block.name)) { stopped = { reason: `hazard ${block.name}`, position: pos }; break; }
        const safety = this.checkSafety(pos);
        if (!safety.safe) { stopped = { reason: 'unsafe', position: pos, hazards: safety.hazards }; break; }
        if (ORE_TIERS[block.name]) {
          const oreResult = await this.mineOre(pos);
          if (oreResult.ok) mined++;
          continue;
        }
        const move = await this.bot.goTo(pos, { range: 3 });
        if (move && move.ok === false) { stopped = { reason: move.error, position: pos }; break; }
        const dig = await this.bot.digBlock(pos);
        if (dig.ok) { mined++; this.stats.blocksDug++; }
        else { stopped = { reason: dig.error, position: pos }; break; }
      }
      if (stopped) break;
      if (step % torchEvery === 0 && this.bot.countItem('torch')) {
        const torchPos = { x: feet.x, y: feet.y + 1, z: feet.z };
        const torchBlock = this.bot.getBlock(torchPos);
        if (torchBlock && torchBlock.name === 'air') {
          const placedTorch = await this.bot.placeBlock(torchPos, 'torch');
          if (placedTorch.ok) { placed++; this.stats.torchesPlaced++; }
        }
      }
    }
    this.stats.tunnels++;
    return { ok: mined > 0, mined, torches: placed, stopped, start, length, axis, direction };
  }

  caveScan({ radius = 24 } = {}) {
    const caves = [];
    const y0 = Math.max(-60, Math.floor(this.bot.position.y) - 20);
    for (let y = y0; y < y0 + 40; y += 4) {
      for (let z = -radius; z <= radius; z += 4) {
        for (let x = -radius; x <= radius; x += 4) {
          const pos = { x: Math.floor(this.bot.position.x) + x, y, z: Math.floor(this.bot.position.z) + z };
          if (pos.y > this.bot.surfaceAt(pos.x, pos.z) - 4) continue;
          const block = this.bot.getBlock(pos);
          if (!block || block.name !== 'air') continue;
          const above = this.bot.getBlock({ x: pos.x, y: pos.y + 1, z: pos.z });
          if (!above || above.name === 'air') {
            caves.push({ ...pos, depth: Math.round(this.bot.surfaceAt(pos.x, pos.z) - pos.y), hazard: this._caveHazard(pos) });
          }
        }
      }
    }
    if (this.memory && caves.length) {
      for (const cave of caves.slice(0, 10)) {
        this.memory.observe({ type: 'CAVE', position: { x: cave.x, y: cave.y, z: cave.z }, reportedBy: this.bot.name, confidence: 0.6, data: { depth: cave.depth, hazard: cave.hazard } });
      }
    }
    return caves.slice(0, 100);
  }

  _caveHazard(pos) {
    const hazards = [];
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      const block = this.bot.getBlock({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz });
      if (block && (block.name === 'lava' || block.name === 'flowing_lava')) hazards.push('lava');
      if (block && (block.name === 'water' || block.name === 'flowing_water')) hazards.push('water');
    }
    return hazards.length ? [...new Set(hazards)] : ['none'];
  }
}

module.exports = { MiningController, ORE_NAMES, ORE_TIERS, ORE_DROPS };
