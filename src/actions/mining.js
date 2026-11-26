'use strict';

const { config } = require('../config');
const { Logger } = require('../logger');
const { distance } = require('../util/vec');
const { statusTtl, STATUS_SCAN_BUDGET_MS, ACTION_SCAN_BUDGET_MS } = require('./common');

const {
  ORE_TIERS, ORE_DROPS, ORE_NAMES, requiredPickaxeTier, oreVariants, isOreName
} = require('./miningCatalog');
const { inWorkZone, clampToWorkZone, outsideWorkZone, workZone } = require('../world/workZone');
const { oreKey } = require('./reservations');

const PICKAXE_FOR_TIER = { 1: 'wooden_pickaxe', 2: 'stone_pickaxe', 3: 'iron_pickaxe', 4: 'diamond_pickaxe' };
const PICKAXE_RECIPES = {
  wooden_pickaxe: { planks: 3, stick: 2 },
  stone_pickaxe: { cobblestone: 3, stick: 2 },
  iron_pickaxe: { iron_ingot: 3, stick: 2 },
  diamond_pickaxe: { diamond: 3, stick: 2 }
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
function findExposed(bot, names, { radius = 16, minY = -59, limit = 8, budgetMs = ACTION_SCAN_BUDGET_MS, inside = null } = {}) {
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  const world = bot.world;
  const origin = bot.position;
  if (!origin || !wanted.size) return [];
  const r = Math.max(1, Math.min(radius, 20));
  const startedAt = budgetMs > 0 ? Date.now() : 0;
  const expired = budgetMs > 0 ? () => Date.now() - startedAt >= budgetMs : () => false;
  const nameAt = world && typeof world.blockNameAt === 'function'
    ? (x, y, z) => world.blockNameAt(x, y, z)
    : (x, y, z) => {
      const block = bot.getBlock({ x, y, z });
      return block ? block.name : null;
    };
  const found = [];
  const axis = [];
  for (let d = 0; d <= r; d++) {
    axis.push(d);
    if (d > 0) axis.push(-d);
  }
  // Near-first: a time-bounded scan must reach the closest exposed block before
  // the budget expires, not the bottom of the cube 20 blocks below the bot.
  for (const dy of axis) {
    const y = Math.floor(origin.y) + dy;
    if (y < minY) continue;
    for (const dz of axis) {
      for (const dx of axis) {
        // Check before every lookup: one cold column generation can cost tens
        // of milliseconds, so a batch of 8/32 positions cannot be bounded.
        if (budgetMs > 0 && expired()) {
          found.sort((a, b) => a.distance - b.distance);
          return found.slice(0, limit);
        }
        const x = Math.floor(origin.x) + dx;
        const z = Math.floor(origin.z) + dz;
        if (inside && !inside({ x, y, z })) continue;
        const name = nameAt(x, y, z);
        if (!name || !wanted.has(name)) continue;
        let exposed = false;
        for (const [ox, oy, oz] of NEIGHBOUR_OFFSETS) {
          const other = nameAt(x + ox, y + oy, z + oz);
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
  constructor({ bot, memory = null, ledger = null, logger = null, home = null, reservations = null } = {}) {
    if (!bot) throw new Error('MiningController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.ledger = ledger;
    this.logger = logger || new Logger({ level: 'warn' });
    this.home = home ? { ...home } : null;
    this.reservations = reservations || null;
    this.inventory = null;
    this.woodcutting = null;
    this.stats = {
      oresMined: 0, blocksDug: 0, hazardsAvoided: 0, torchesPlaced: 0, tunnels: 0,
      toolBootstraps: 0, toolTier: 0
    };
    this.mined = {};
    this.stopRequested = false;
    this._bootstrapping = false;
  }

  updateHome(home) {
    this.home = home ? { ...home } : null;
    this._zoneCache = null;
  }

  attachHelpers({ inventory = null, woodcutting = null } = {}) {
    if (inventory) this.inventory = inventory;
    if (woodcutting) this.woodcutting = woodcutting;
  }

  zone() {
    return workZone(this.home, { margin: config.workZone ? config.workZone.margin : 0 });
  }

  _inZone(pos) {
    if (!this.home) return true;
    return inWorkZone(pos, this.home, { margin: 0 });
  }

  _zoneError(pos, action = 'mine') {
    const outside = outsideWorkZone(pos, this.home, { margin: 0 });
    const zone = outside ? outside.zone : this.zone();
    return {
      ok: false, code: 'OUTSIDE_WORK_ZONE', action,
      error: `${action} target at ${pos.x},${pos.y},${pos.z} is outside the ${zone.label} work zone`,
      position: { ...pos }, zone
    };
  }

  async _returnToZoneIfNeeded() {
    if (!this.home || this._inZone(this.bot.position)) return { ok: true };
    const target = clampToWorkZone(this.bot.position, this.home, { margin: config.workZone ? config.workZone.margin : 0 });
    const move = await this.bot.goTo(target, { range: 3, timeoutMs: 15000, priority: 'operator', owner: 'work-zone-return' });
    return {
      ok: !(move && move.ok === false), target, position: { ...this.bot.position },
      error: move && move.ok === false ? move.error : undefined,
      zone: this.zone()
    };
  }

  _pickTier() {
    const tool = this.bot.bestToolFor ? this.bot.bestToolFor('pickaxe') : null;
    return tool ? Number(tool.tier) || 0 : 0;
  }

  status() {
    const position = this.bot.position || { x: 0, y: 0, z: 0 };
    const now = Date.now();
    const moved = this._statusCache ? Math.hypot(position.x - this._statusCache.center.x, position.z - this._statusCache.center.z) : Infinity;
    // `findOres` is a synchronous 3-D world scan. Doing it for every bot on
    // every dashboard snapshot blocked the live event loop for 8-38 s, which
    // starved keepalives (EPIPE/ECONNRESET) and every bot's client tick.
    // Status scans are now cached with a roster-staggered TTL, only invalidated
    // by a long displacement, and hard-bounded by a small time budget. Five
    // blocks is enough for the panel.
    const ttl = statusTtl(this.bot.name, 0);
    if (!this._statusCache || moved > 16 || now - this._statusCache.at > ttl) {
      this._statusCache = {
        center: { x: position.x, z: position.z },
        at: now,
        ores: this.findOres({ radius: 5, limit: 5, budgetMs: STATUS_SCAN_BUDGET_MS })
      };
    }
    return {
      bot: this.bot.name,
      position: { ...position },
      pickaxe: this.bot.bestToolFor('pickaxe'),
      oresMined: { ...this.mined },
      stopped: Boolean(this.stopRequested),
      zone: this.zone(),
      reservations: this.reservations ? this.reservations.status() : null,
      stats: { ...this.stats },
      scan: {
        at: this._statusCache.at,
        radius: 5,
        ttlMs: ttl,
        capped: true,
        note: 'status sampling is cached and radius-limited; command scans use the full 24-block radius'
      },
      nearbyOres: this._statusCache.ores.map((o) => ({ name: o.name, position: { x: o.x, y: o.y, z: o.z }, distance: Math.round(distance(position, o)) }))
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

  findOres({ radius = config.mining.maxSearchRadius, limit = 32, only = null, budgetMs = 0 } = {}) {
    // Exposed ore only: a flat findBlocks limit returns one deep buried layer,
    // which mineOre() can neither walk to nor reach with its pickaxe.
    const names = only ? oreVariants(only) : ORE_NAMES;
    return findExposed(this.bot, names, {
      radius: Math.min(radius, 20), minY: -59, limit, budgetMs,
      inside: this.home ? (pos) => this._inZone(pos) : null
    });
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
    const required = requiredPickaxeTier(oreName);
    const tool = this.bot.bestToolFor ? this.bot.bestToolFor('pickaxe') : null;
    return { ok: Boolean(tool) && Number(tool.tier) >= required, required, tier: tool ? Number(tool.tier) || 0 : 0, tool: tool ? tool.name : null };
  }

  /**
   * Every `mine <target>` starts here. The old controller only checked the
   * current pick at the block and returned "need pickaxe tier 3", which left a
   * bot with no iron pick standing next to a diamond vein forever. This is the
   * bootstrap the operator asked for: craft/gather the missing tool chain, and
   * for iron actually mine iron + coal, smelt three ingots and craft the pick.
   * It works for every target in the catalog, not just diamonds.
   */
  async ensurePickaxeFor(target, { context = 'mining' } = {}) {
    const required = requiredPickaxeTier(target);
    const before = this._pickTier();
    if (!required || before >= required) {
      return { ok: true, required, have: before, tool: this.bot.bestToolFor ? this.bot.bestToolFor('pickaxe') : null, steps: [] };
    }
    if (this._bootstrapping) {
      return {
        ok: false, code: 'TOOL_BOOTSTRAP_BUSY', required, have: before,
        error: 'another tool bootstrap is already running for this bot'
      };
    }
    this._bootstrapping = true;
    const startedAt = Date.now();
    const steps = [];
    try {
      for (let tier = 1; tier <= required; tier++) {
        if (this._pickTier() >= tier) continue;
        const step = await this._obtainPickaxe(tier);
        steps.push(step);
        if (!step.ok) {
          return {
            ok: false, code: 'TOOL_REQUIRED', required, have: this._pickTier(),
            target, context, steps, ms: Date.now() - startedAt,
            error: step.error || `could not obtain pickaxe tier ${tier}`
          };
        }
      }
      const have = this._pickTier();
      if (have < required) {
        return {
          ok: false, code: 'TOOL_REQUIRED', required, have, target, context, steps,
          error: `tool bootstrap finished at tier ${have}, need ${required}`
        };
      }
      this.stats.toolTier = have;
      this.stats.toolBootstraps++;
      this.logger.info(`[${this.bot.name}] tool chain ready for ${target}: tier ${have}/${required} (${steps.filter((step) => step.crafted).map((step) => step.tool).join(', ') || 'already held'})`);
      return { ok: true, required, have, tool: this.bot.bestToolFor('pickaxe'), steps, ms: Date.now() - startedAt };
    } finally {
      this._bootstrapping = false;
    }
  }

  async _craft(item, count = 1) {
    if (!this.bot || typeof this.bot.craft !== 'function') {
      return { ok: false, error: 'this adapter cannot craft' };
    }
    let result = await this.bot.craft(item, count).catch((err) => ({ ok: false, error: err.message }));
    if (!result.ok && this.inventory && /recipe|table|crafting/i.test(String(result.error || ''))) {
      const table = await this.inventory.ensureCraftingTable().catch((err) => ({ ok: false, error: err.message }));
      if (table.ok) result = await this.bot.craft(item, count).catch((err) => ({ ok: false, error: err.message }));
    }
    return result;
  }

  async _ensureSticks(needed = 2) {
    if ((this.bot.countItem ? this.bot.countItem('stick') : 0) >= needed) return { ok: true, have: this.bot.countItem('stick') };
    if (!this.inventory || typeof this.inventory.ensurePlanks !== 'function') {
      return { ok: false, error: 'no inventory helper to mill planks' };
    }
    // No logs/planks at all: a bootstrap is allowed to gather the wood it
    // needs, inside the same work zone and with the same tree reservations.
    const hasWood = Object.keys(this.bot.inventory || {}).some((name) => /_log$|_wood$|_planks$/.test(name));
    let woodRun = null;
    if (!hasWood && this.woodcutting) {
      woodRun = await this.woodcutting.tick({ maxTrees: 1, relocate: true, maxRelocations: 1 });
      if (!(woodRun.chopped > 0)) {
        return { ok: false, error: `no wood for a pickaxe: ${woodRun.error || woodRun.reason || 'no tree was chopped'}` };
      }
    }
    const planks = await this.inventory.ensurePlanks(2);
    if (woodRun) planks.woodRun = { chopped: woodRun.chopped, elapsedMs: woodRun.elapsedMs };
    if (!planks.ok) return { ok: false, error: `no planks for sticks: ${planks.error}` };
    const crafted = await this._craft('stick', 1);
    if (!crafted.ok) return { ok: false, error: `cannot craft sticks: ${crafted.error}` };
    const have = this.bot.countItem('stick');
    return have >= needed ? { ok: true, have, crafted: true } : { ok: false, error: `only ${have} sticks after crafting` };
  }

  async _mineFor(ore, count, { minY = -59, attempts = 2 } = {}) {
    let gathered = 0;
    const runs = [];
    for (let i = 0; i < Math.max(1, attempts) && gathered < count && !this.stopRequested; i++) {
      const result = await this.mineOresDeep({
        radius: 48, limit: Math.max(1, count - gathered), minY, only: ore
      });
      runs.push({ mined: result.mined || 0, error: result.error, code: result.code });
      gathered += Number(result.mined) || 0;
      if (result.code === 'TOOL_REQUIRED' || result.code === 'OUTSIDE_WORK_ZONE') break;
    }
    return { ok: gathered >= count, ore, needed: count, gathered, runs };
  }

  async _ensureCobblestone(needed) {
    let have = this.bot.countItem('cobblestone');
    if (have >= needed) return { ok: true, have };
    const mined = await this.mineBlocks({ block: 'stone', radius: 16, limit: Math.max(1, needed - have), minY: -59 });
    have = this.bot.countItem('cobblestone');
    return have >= needed
      ? { ok: true, have, mined: mined.mined || 0 }
      : { ok: false, error: `need ${needed} cobblestone, hold ${have}${mined.error ? ` (${mined.error})` : ''}` };
  }

  async _ensureFurnace() {
    if (this.inventory && typeof this.inventory.ensureFurnace === 'function') {
      return this.inventory.ensureFurnace();
    }
    return { ok: true, external: true, note: 'adapter handles smelting without a placed furnace' };
  }

  async _ensureIronIngots(needed = 3) {
    let ingots = this.bot.countItem('iron_ingot');
    if (ingots >= needed) return { ok: true, have: ingots, smelted: 0 };
    let raw = this.bot.countItem('raw_iron');
    const missingRaw = Math.max(0, needed - ingots - raw);
    let mining = null;
    if (missingRaw > 0) {
      mining = await this._mineFor('iron_ore', missingRaw);
      raw = this.bot.countItem('raw_iron');
    }
    if (ingots + raw < needed) {
      return {
        ok: false, have: ingots, raw, needed, mining,
        error: `need ${needed} iron ingots, have ${ingots} ingot(s) and ${raw} raw iron${mining ? ` after mining ${mining.gathered}` : ''}`
      };
    }
    // Fuel is a real prerequisite for a live furnace. Mine coal when the bot
    // has none (the operator asked for iron + coal); planks/charcoal remain an
    // honest fallback if coal is not reachable in the work zone.
    const fuel = () => (this.bot.countItem('coal') || this.bot.countItem('charcoal') || this.bot.countItem('oak_planks') || 0);
    let coalMining = null;
    if (!this.bot.countItem('coal') && !this.bot.countItem('charcoal')) {
      coalMining = await this._mineFor('coal_ore', 1, { attempts: 1 });
    }
    if (!fuel()) {
      return { ok: false, have: ingots, raw, needed, mining, coalMining, error: 'no furnace fuel (coal, charcoal or planks)' };
    }
    let furnace = await this._ensureFurnace();
    if (!furnace.ok && this.bot.countItem('cobblestone') < 8) {
      // A live furnace needs 8 cobblestone. Do not make the iron chain depend
      // on the operator having pre-mined that stack.
      const cobble = await this._ensureCobblestone(8);
      if (cobble.ok) furnace = await this._ensureFurnace();
      else furnace = { ...furnace, cobble };
    }
    if (!furnace.ok) return { ok: false, have: ingots, raw, needed, mining, furnace, error: `no usable furnace: ${furnace.error}` };
    const before = this.bot.countItem('iron_ingot');
    const smelt = await this.bot.smelt('raw_iron', Math.min(raw, needed - ingots)).catch((err) => ({ ok: false, error: err.message }));
    const gained = this.bot.countItem('iron_ingot') - before;
    if (!smelt.ok || gained < Math.min(raw, needed - ingots)) {
      return {
        ok: false, have: this.bot.countItem('iron_ingot'), raw, needed, mining, coalMining, furnace, smelt,
        error: `smelted ${gained} iron ingot(s), needed ${Math.min(raw, needed - ingots)}${smelt.error ? `: ${smelt.error}` : ''}`
      };
    }
    this.logger.info(`[${this.bot.name}] smelted ${gained} iron ingot(s) for a tool (fuel ${this.bot.countItem('coal') ? 'coal' : 'fallback'})`);
    return { ok: true, have: this.bot.countItem('iron_ingot'), smelted: gained, mining, coalMining, furnace };
  }

  async _ensureDiamonds(needed = 3) {
    let have = this.bot.countItem('diamond');
    if (have >= needed) return { ok: true, have };
    const mined = await this._mineFor('diamond_ore', needed - have);
    have = this.bot.countItem('diamond');
    return have >= needed
      ? { ok: true, have, mined: mined.gathered }
      : { ok: false, error: `need ${needed} diamonds, have ${have}${mined.runs.some((r) => r.error) ? ` (${mined.runs.map((r) => r.error).filter(Boolean).join('; ')})` : ''}` };
  }

  async _obtainPickaxe(tier) {
    const tool = PICKAXE_FOR_TIER[tier];
    if (!tool) return { ok: false, tier, error: `no pickaxe recipe for tier ${tier}` };
    if (this._pickTier() >= tier) return { ok: true, tier, tool: this.bot.bestToolFor('pickaxe'), already: true };
    const recipe = PICKAXE_RECIPES[tool];
    const sticks = await this._ensureSticks(recipe.stick || 2);
    if (!sticks.ok) return { ok: false, tier, tool, error: sticks.error };
    if (tier === 1) {
      if (!this.inventory) return { ok: false, tier, tool, error: 'no inventory helper to craft a wooden pickaxe' };
      const planks = await this.inventory.ensurePlanks(recipe.planks).catch((err) => ({ ok: false, error: err.message }));
      if (!planks.ok) return { ok: false, tier, tool, error: planks.error || 'no planks for a wooden pickaxe' };
    } else if (tier === 2) {
      const cobble = await this._ensureCobblestone(recipe.cobblestone);
      if (!cobble.ok) return { ok: false, tier, tool, error: cobble.error };
    } else if (tier === 3) {
      const iron = await this._ensureIronIngots(recipe.iron_ingot);
      if (!iron.ok) return { ok: false, tier, tool, error: iron.error, iron };
    } else if (tier === 4) {
      const diamond = await this._ensureDiamonds(recipe.diamond);
      if (!diamond.ok) return { ok: false, tier, tool, error: diamond.error };
    }
    const crafted = await this._craft(tool, 1);
    if (!crafted.ok) return { ok: false, tier, tool, error: `cannot craft ${tool}: ${crafted.error}` };
    const after = this._pickTier();
    if (after < tier) return { ok: false, tier, tool, error: `${tool} was not visible after crafting (have tier ${after})` };
    this.stats.toolTier = after;
    return { ok: true, tier, tool, crafted: true, have: after };
  }

  async mineOre(pos, { collect = true, claim = true } = {}) {
    const block = this.bot.getBlock(pos);
    if (!block || block.name === 'air') return { ok: false, error: 'block is air' };
    if (!isOreName(block.name)) return { ok: false, error: `not an ore: ${block.name}` };
    if (!this._inZone(pos)) return this._zoneError(pos, 'mine');
    const safety = this.checkSafety(pos);
    if (!safety.safe) {
      this.stats.hazardsAvoided++;
      return { ok: false, error: 'unsafe to mine', hazards: safety.hazards, ore: block.name };
    }
    const tool = this._toolOk(block.name);
    if (!tool.ok) {
      return {
        ok: false, code: 'TOOL_REQUIRED', error: `need pickaxe tier ${tool.required}`,
        required: tool.required, have: tool.tier, ore: block.name
      };
    }
    const key = oreKey(pos);
    let lease = null;
    if (claim && this.reservations) {
      lease = this.reservations.claim(key, this.bot.name, { ttlMs: 90000 });
      if (!lease.ok) {
        return {
          ok: false, code: 'ORE_RESERVED', error: `ore is already claimed by ${lease.owner}`,
          ore: block.name, position: { ...pos }, holder: lease.owner
        };
      }
    }
    try {
      // Pathfinding is the expensive part of an ore run. An ore already inside
      // mining reach needs no walk at all.
      if (distance(this.bot.position, pos) > 4.4) {
        const move = await this.bot.goTo(pos, { range: 3, timeoutMs: 12000 });
        if (move && move.ok === false) return { ok: false, error: move.error, ore: block.name };
      }
      await this.bot.equipBestTool('pickaxe');
      const dig = await this.bot.digBlock(pos);
      if (!dig.ok) return { ok: false, error: dig.error, ore: block.name };
      this.stats.blocksDug++;
      this.stats.oresMined++;
      const drop = ORE_DROPS[block.name];
      this.mined[drop] = (this.mined[drop] || 0) + 1;
      // A fleet run collects once at the end; a single dig still collects now.
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
    } finally {
      if (lease && lease.ok) this.reservations.release(key, this.bot.name);
    }
  }

  /** Mine a specific block type (stone, cobblestone, deepslate) with the same safety rules. */
  async mineBlocks({ block: blockName = 'stone', radius = 24, limit = 16, minY = -59 } = {}) {
    this._begin();
    const startedAt = Date.now();
    const zoneReturn = await this._returnToZoneIfNeeded();
    if (!zoneReturn.ok) {
      return {
        ok: false, mined: 0, skipped: 0, results: [], block: blockName,
        code: 'OUTSIDE_WORK_ZONE', zoneReturn, error: `outside the work zone and could not return: ${zoneReturn.error || 'path unavailable'}`
      };
    }
    const toolCheck = await this.ensurePickaxeFor(blockName, { context: 'mineBlocks' });
    if (!toolCheck.ok) {
      return {
        ok: false, mined: 0, skipped: 0, results: [], block: blockName,
        code: toolCheck.code || 'TOOL_REQUIRED', tool: toolCheck, error: toolCheck.error
      };
    }
    const names = [blockName, blockName === 'stone' ? 'deepslate' : null].filter(Boolean);
    const targets = findExposed(this.bot, names, {
      radius: 16, minY, limit, budgetMs: ACTION_SCAN_BUDGET_MS,
      inside: this.home ? (pos) => this._inZone(pos) : null
    })
      // Only exposed blocks are mineable without a tunnel: aiming at buried
      // stone made goTo() fall back to the surface and every dig fail as
      // "too far to dig", freezing the quota.
      .map((b) => ({ ...b, distance: distance(this.bot.position, b) }))
      .sort((a, b) => a.distance - b.distance);
    const results = [];
    for (const target of targets) {
      // Mock and very fast live adapters resolve their awaits as microtasks;
      // without a macrotask yield a whole quota runs in one event-loop turn.
      await new Promise((resolve) => setImmediate(resolve));
      if (this.stopRequested) break;
      const block = this.bot.getBlock(target);
      if (!block || block.name === 'air') continue;
      const safety = this.checkSafety(target);
      if (!safety.safe) {
        this.stats.hazardsAvoided++;
        results.push({ ok: false, error: 'unsafe to mine', hazards: safety.hazards, block: block.name });
        continue;
      }
      const required = requiredPickaxeTier(block.name);
      const tool = required > 0 ? this.bot.bestToolFor('pickaxe') : (this.bot.bestToolFor('shovel') || this.bot.bestToolFor('pickaxe'));
      if (required > 0 && (!tool || Number(tool.tier) < required)) {
        results.push({ ok: false, code: 'TOOL_REQUIRED', error: `need pickaxe tier ${required} for ${block.name}`, required, have: tool ? tool.tier : 0 });
        break;
      }
      const stance = NEIGHBOUR_OFFSETS
        .map(([ox, oy, oz]) => ({ x: target.x + ox, y: target.y + oy, z: target.z + oz }))
        .find((n) => {
          const block = this.bot.getBlock(n);
          return block && (block.name === 'air' || block.name === 'cave_air' || block.name === 'water');
        });
      if (distance(this.bot.position, target) > 4.4) {
        const move = await this.bot.goTo(stance || target, { range: 1, timeoutMs: 12000 });
        if (move && move.ok === false) {
          results.push({ ok: false, error: move.error });
          continue;
        }
      }
      await this.bot.equipBestTool(required > 0 ? 'pickaxe' : 'shovel').catch(() => null);
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
        if (!this._inZone(below)) {
          results.push({ ok: false, code: 'OUTSIDE_WORK_ZONE', error: `shaft would leave the work zone at ${below.x},${below.z}`, zone: this.zone() });
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
    const elapsedMs = Date.now() - startedAt;
    if (mined > 0) this.logger.info(`[${this.bot.name}] mine ${blockName}: ${mined} block(s) in ${elapsedMs}ms (${this._pickTier()} tier pick)`);
    return {
      ok: mined > 0, mined, skipped: results.filter((r) => !r.ok).length, results,
      block: blockName, elapsedMs, zone: this.zone(), tool: toolCheck
    };
  }

  /** Mine every safe ore in range, best-first by distance. */
  async mineNearby({ radius = 24, limit = 16, only = null } = {}) {
    this._begin();
    const startedAt = Date.now();
    const zoneReturn = await this._returnToZoneIfNeeded();
    if (!zoneReturn.ok) {
      return {
        ok: false, mined: 0, skipped: 0, results: [], code: 'OUTSIDE_WORK_ZONE',
        zoneReturn, error: `outside the work zone and could not return: ${zoneReturn.error || 'path unavailable'}`
      };
    }
    let toolCheck = only
      ? await this.ensurePickaxeFor(only, { context: 'mineNearby' })
      : { ok: true, required: 0, skipped: true };
    if (!toolCheck.ok) {
      return {
        ok: false, mined: 0, skipped: 0, results: [], code: toolCheck.code || 'TOOL_REQUIRED',
        tool: toolCheck, error: toolCheck.error, elapsedMs: Date.now() - startedAt
      };
    }
    let found = this.findOres({ radius, limit: Math.max(limit * 3, limit), only, budgetMs: ACTION_SCAN_BUDGET_MS });
    if (!only && found.length) {
      // `mine` with no target still honours the pickaxe requirement of the
      // hardest ore it can see, instead of touching each ore only to fail.
      const hardest = found.reduce((best, ore) => (requiredPickaxeTier(ore.name) > requiredPickaxeTier(best.name) ? ore : best), found[0]);
      toolCheck = await this.ensurePickaxeFor(hardest.name, { context: 'mineNearby' });
      if (!toolCheck.ok) {
        return {
          ok: false, mined: 0, skipped: 0, results: [], code: toolCheck.code || 'TOOL_REQUIRED',
          tool: toolCheck, error: toolCheck.error, elapsedMs: Date.now() - startedAt
        };
      }
      found = this.findOres({ radius, limit: Math.max(limit * 3, limit), only, budgetMs: ACTION_SCAN_BUDGET_MS });
    }
    // A target another bot already owns is not a target for this bot. This is
    // the fleet rule that stops four bots from mining one vein.
    const ores = found.filter((ore) => {
      if (!this.reservations) return true;
      const holder = this.reservations.holder(oreKey(ore));
      return !holder || holder.owner === this.bot.name;
    });
    const reserved = found.length - ores.length;
    const results = [];
    for (const ore of ores) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.stopRequested) break;
      const result = await this.mineOre({ x: ore.x, y: ore.y, z: ore.z }, { collect: false });
      results.push(result);
      if (result.code === 'ORE_RESERVED' || result.code === 'OUTSIDE_WORK_ZONE') continue;
      if (this.bot.health <= config.mining.retreatHealth) break;
    }
    const mined = results.filter((r) => r.ok).length;
    // One pickup sweep for the run instead of a pathfind/scan per ore.
    if (mined > 0 && typeof this.bot.collectDrops === 'function') {
      await this.bot.collectDrops(8).catch(() => null);
    }
    const elapsedMs = Date.now() - startedAt;
    const breakdown = results.filter((row) => row.ok && row.drop).reduce((out, row) => {
      out[row.drop] = (out[row.drop] || 0) + 1;
      return out;
    }, {});
    if (mined > 0) {
      this.logger.info(`[${this.bot.name}] ore sweep: ${mined}/${ores.length} mined in ${elapsedMs}ms${Object.keys(breakdown).length ? ` (${Object.entries(breakdown).map(([drop, count]) => `${count}x ${drop}`).join(', ')})` : ''}${reserved ? `, ${reserved} reserved by teammates` : ''}`);
    }
    return {
      ok: mined > 0,
      mined,
      breakdown,
      skipped: results.filter((r) => !r.ok).length,
      reserved,
      results,
      elapsedMs,
      zone: this.zone(),
      tool: toolCheck
    };
  }

  /** Ore search that can sink a safe shaft when no ore is reachable from the surface. */
  async mineOresDeep({ radius = 48, limit = 6, maxDepth = 8, minY = -59, only = null } = {}) {
    this._begin();
    const startedAt = Date.now();
    if (this.home && !this._inZone(this.bot.position)) {
      const target = clampToWorkZone(this.bot.position, this.home, { margin: config.workZone ? config.workZone.margin : 0 });
      const move = await this.bot.goTo(target, { range: 3, timeoutMs: 15000, priority: 'operator', owner: 'work-zone-return' });
      if (move && move.ok === false) {
        return { ok: false, mined: 0, skipped: 0, results: [], code: 'OUTSIDE_WORK_ZONE', zone: this.zone(), error: `outside the work zone and could not return: ${move.error}` };
      }
    }
    const shallow = await this.mineNearby({ radius, limit, only });
    if (shallow.mined > 0 || this.stopRequested) return { ...shallow, elapsedMs: Date.now() - startedAt };
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
      if (!this._inZone(below)) {
        results.push({ ok: false, code: 'OUTSIDE_WORK_ZONE', error: `shaft would leave the work zone at ${below.x},${below.z}`, zone: this.zone() });
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
      const wanted = !only || block.name === only || block.name === `deepslate_${only}`
        || (only.startsWith('deepslate_') && block.name === only.slice('deepslate_'.length));
      if (ORE_TIERS[block.name] && wanted) {
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
    // A vertical shaft only samples one column. When that column is exhausted
    // (the common 12/32 stall), expose fresh faces with a short horizontal
    // branch before the next tick rescans.
    if (mined === 0 && !this.stopRequested) {
      const axis = (this.stats.tunnels % 2 === 0) ? 'x' : 'z';
      const branch = await this.branchMine({ length: 6, axis, direction: 1, only });
      results.push(branch);
      mined += branch.ores || 0;
    }
    const elapsedMs = Date.now() - startedAt;
    if (mined > 0) this.logger.info(`[${this.bot.name}] deep ore run: ${mined} ore(s) in ${elapsedMs}ms`);
    return {
      ok: mined > 0, mined, skipped: results.filter((r) => !r.ok).length, results,
      elapsedMs, zone: this.zone()
    };
  }

  /** A 1x2 branch tunnel with torches, stopping at hazards. */
  async branchMine({ length = 16, axis = 'x', direction = 1, torchEvery = config.mining.torchInterval, only = null } = {}) {
    this._begin();
    const start = { ...this.bot.position };
    let mined = 0;
    let ores = 0;
    let placed = 0;
    let stopped = null;
    for (let step = 1; step <= length && !this.stopRequested; step++) {
      const feet = { x: Math.floor(start.x) + (axis === 'x' ? step * direction : 0), y: Math.floor(start.y), z: Math.floor(start.z) + (axis === 'z' ? step * direction : 0) };
      const head = { ...feet, y: feet.y + 1 };
      if (!this._inZone(feet)) {
        stopped = { code: 'OUTSIDE_WORK_ZONE', reason: 'branch would leave the work zone', position: feet, zone: this.zone() };
        break;
      }
      for (const pos of [feet, head]) {
        const block = this.bot.getBlock(pos);
        if (!block || block.name === 'air') continue;
        if (HAZARDS.has(block.name)) { stopped = { reason: `hazard ${block.name}`, position: pos }; break; }
        const safety = this.checkSafety(pos, { ignoreFloor: true });
        if (!safety.safe) { stopped = { reason: 'unsafe', position: pos, hazards: safety.hazards }; break; }
        const wanted = !only || block.name === only || block.name === `deepslate_${only}`
          || (only.startsWith('deepslate_') && block.name === only.slice('deepslate_'.length));
        if (ORE_TIERS[block.name] && wanted) {
          const oreResult = await this.mineOre(pos);
          if (oreResult.ok) { mined++; ores++; }
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
    return { ok: mined > 0, mined, ores, torches: placed, stopped, start, length, axis, direction };
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
