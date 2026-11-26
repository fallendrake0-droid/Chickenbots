'use strict';

const { Logger } = require('../logger');
const { config, BOT_NAMES } = require('../config');
const { findBlocks, isHostile, ACTION_SCAN_BUDGET_MS } = require('./common');
const { inWorkZone, clampToWorkZone, outsideWorkZone, workZone } = require('../world/workZone');
const { treeKey } = require('./reservations');
const {
  LOG_TYPES, LOG_PATTERN, SAPLING_FOR, SAPLINGS, TYPE_ALIASES,
  speciesFor, isLog, isLeaves, definition, saplingFor, plantableFor,
  supportsVersion, catalogue
} = require('../woodcutting/catalog');

const MAX_TREE_HEIGHT = 40;
const MAX_TRUNK_HEIGHT = MAX_TREE_HEIGHT;
const MAX_TRUNK_COLUMNS = 4;
const MAX_LEAVES_PER_TREE = 20;
const REACH = 4.5;
// Adapters gate a dig at five blocks from the feet as well as the eye ray.
const DIG_REACH = 5;
const ROLES = Object.freeze(['CHOPPER', 'SCOUT', 'HAULER', 'PLANTER', 'GUARD']);

function normalizeLogTypes(value) {
  if (value === undefined || value === null || value === '' || value === 'wood' || value === 'any') return LOG_TYPES.slice();
  const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/).filter(Boolean);
  const resolved = list.map((entry) => TYPE_ALIASES[String(entry).toLowerCase()] || (LOG_TYPES.includes(entry) ? entry : null)).filter(Boolean);
  return resolved.length ? [...new Set(resolved)] : LOG_TYPES.slice();
}

function countLogs(inventory = {}, filter = /(^|_)(log|wood)$/) {
  return Object.entries(inventory)
    .filter(([name, count]) => filter.test(String(name).replace(/^minecraft:/, '')) && Number(count) > 0)
    .reduce((sum, [, count]) => sum + Number(count), 0);
}

function zeroCounters() {
  return {
    treesChopped: 0, logsCollected: 0, replanted: 0, saplingsCollected: 0,
    leavesCleared: 0, treesReserved: 0, treesSkipped: 0, treesFailed: 0,
    logsLost: 0, blocksVerified: 0, axesCrafted: 0, axesEquipped: 0,
    axesBroken: 0, tripsHome: 0, stored: 0, planted: 0, identified: 0,
    supportRequests: 0
  };
}

/**
 * Tree harvesting with a version-aware catalogue, 2x2/tall trunk support,
 * reach and safety checks, verified drops, leaf handling and species-correct
 * replanting. The controller never reports a tree as harvested unless the
 * world confirms each log was removed.
 */
class WoodcuttingController {
  constructor({ bot, memory = null, ledger = null, logger = null, reserveTarget = 64, home = null, index = 0, reservations = null, inventory = null, version = null } = {}) {
    if (!bot) throw new Error('WoodcuttingController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.ledger = ledger;
    this.logger = logger || new Logger({ level: 'warn' });
    this.reserveTarget = Math.max(8, Number(reserveTarget) || 64);
    this.home = home ? { ...home } : null;
    this.index = Number(index) || 0;
    this.reservations = reservations || null;
    this.inventory = inventory || null;
    this.teamCoordinator = null;
    this.combat = null;
    this.version = version && version !== 'auto' ? String(version) : null;
    this.role = 'CHOPPER';
    this.stats = zeroCounters();
    this._task = zeroCounters();
    this.taskStartedAt = Date.now();
    this.replanted = [];
    this.supportRequests = [];
    this.stopRequested = false;
    this._searchAttempts = 0;
    this.lastAxe = null;
    this.lastTree = null;
  }

  updateHome(home) {
    this.home = home ? { ...home } : null;
  }

  setVersion(version) {
    this.version = version && version !== 'auto' ? String(version) : null;
    return this.version;
  }

  zone() {
    return workZone(this.home, { margin: config.workZone ? config.workZone.margin : 0 });
  }

  _inZone(pos) {
    if (!this.home) return true;
    return inWorkZone(pos, this.home, { margin: 0 });
  }

  _zoneError(pos) {
    const outside = outsideWorkZone(pos, this.home, { margin: 0 });
    const zone = outside ? outside.zone : this.zone();
    return {
      ok: false, code: 'OUTSIDE_WORK_ZONE',
      error: `tree at ${pos.x},${pos.z} is outside the ${zone.label} work zone`,
      position: { ...pos }, zone
    };
  }

  _bump(key, amount = 1) {
    if (!Object.prototype.hasOwnProperty.call(this.stats, key)) return;
    this.stats[key] += amount;
    this._task[key] += amount;
  }

  _resetTask() {
    this._task = zeroCounters();
    this.taskStartedAt = Date.now();
  }

  taskStats() {
    return {
      ...this._task,
      startedAt: this.taskStartedAt,
      elapsedMs: Math.max(0, Date.now() - this.taskStartedAt)
    };
  }

  lifetimeStats() { return { ...this.stats }; }

  _claimTree(base) {
    if (!this.reservations) return { ok: true, local: true };
    const lease = this.reservations.claim(treeKey(base), this.bot.name, { ttlMs: 180000 });
    if (!lease.ok) {
      this._bump('treesSkipped');
      this._bump('treesReserved');
    }
    return lease;
  }

  _releaseTree(base) {
    if (this.reservations) this.reservations.release(treeKey(base), this.bot.name);
  }

  async _returnToZone() {
    if (!this.home || this._inZone(this.bot.position)) return { ok: true };
    const target = clampToWorkZone(this.bot.position, this.home, { margin: config.workZone ? config.workZone.margin : 0 });
    const move = await this.bot.goTo(target, { range: 3, timeoutMs: 15000, priority: 'operator', owner: 'work-zone-return' });
    return {
      ok: !(move && move.ok === false),
      position: { ...this.bot.position }, target,
      error: move && move.ok === false ? move.error : undefined
    };
  }

  status() {
    const currentCatalog = catalogue({ version: this.version });
    const axe = typeof this.bot.bestToolFor === 'function' ? this.bot.bestToolFor('axe') : null;
    const durability = axe && this.bot.itemMeta && this.bot.itemMeta[axe.name]
      ? { durability: this.bot.itemMeta[axe.name].durability ?? null, maxDurability: this.bot.itemMeta[axe.name].maxDurability ?? null }
      : null;
    return {
      bot: this.bot.name,
      axe: axe ? { ...axe, ...(durability || {}) } : null,
      logs: countLogs(this.bot.inventory),
      saplings: [...SAPLINGS].reduce((sum, name) => sum + (this.bot.countItem(name) || 0), 0),
      reserveTarget: this.reserveTarget,
      stopped: Boolean(this.stopRequested),
      role: this.role,
      version: this.version,
      treesChopped: this.stats.treesChopped,
      replanted: this.stats.replanted,
      replantedRecent: this.replanted.slice(-10),
      lastTree: this.lastTree,
      zone: this.zone(),
      reservations: this.reservations ? this.reservations.status() : null,
      supportRequests: this.supportRequests.filter((row) => row.status === 'open').slice(-5),
      stats: { ...this.stats },
      task: this.taskStats(),
      lifetime: this.lifetimeStats(),
      catalog: {
        species: currentCatalog.length,
        supported: currentCatalog.filter((row) => row.supported).length
      }
    };
  }

  stop() {
    this.stopRequested = true;
    if (typeof this.bot.cancelMotion === 'function') {
      try { this.bot.cancelMotion('woodcutting stopped'); } catch (_) { /* optional */ }
    }
    return { ok: true, bot: this.bot.name, stopped: true };
  }

  _begin() {
    this.stopRequested = false;
    this._resetTask();
    return true;
  }

  setRole(role) {
    const value = String(role || '').toUpperCase();
    if (!ROLES.includes(value)) return { ok: false, error: `unknown woodcutting role ${role}; use ${ROLES.join('|')}` };
    this.role = value;
    return { ok: true, bot: this.bot.name, role: this.role };
  }

  /** Bounded catalogue for the status/command surface. */
  catalog({ version = this.version } = {}) {
    return catalogue({ version });
  }

  _columnAt(x, z, yHint) {
    const hint = Math.floor(Number(yHint));
    if (![x, z, hint].every(Number.isFinite)) return null;
    let bottom = null;
    let y = hint;
    for (let step = 0; step < MAX_TREE_HEIGHT; step++) {
      const block = this.bot.getBlock({ x, y, z });
      if (!block || !isLog(block.name)) break;
      bottom = y;
      y--;
    }
    if (bottom === null) return null;
    let top = bottom;
    y = bottom + 1;
    for (let step = 0; step < MAX_TREE_HEIGHT; step++) {
      const block = this.bot.getBlock({ x, y, z });
      if (!block || !isLog(block.name)) break;
      top = y;
      y++;
    }
    const baseBlock = this.bot.getBlock({ x, y: bottom, z });
    if (!baseBlock || !isLog(baseBlock.name)) return null;
    return {
      x, z, bottom, top, height: top - bottom + 1,
      type: String(baseBlock.name).replace(/^minecraft:/, ''),
      species: speciesFor(baseBlock.name)
    };
  }

  _columnsFor(base) {
    const first = this._columnAt(base.x, base.z, base.y);
    if (!first) return [];
    const columns = [first];
    const visited = new Set([`${first.x},${first.z}`]);
    const queue = [first];
    while (queue.length && columns.length < MAX_TRUNK_COLUMNS) {
      const current = queue.shift();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (columns.length >= MAX_TRUNK_COLUMNS) break;
        const x = current.x + dx;
        const z = current.z + dz;
        const key = `${x},${z}`;
        if (visited.has(key)) continue;
        const column = this._columnAt(x, z, current.bottom);
        if (!column) continue;
        if (column.species !== current.species) continue;
        if (Math.abs(column.bottom - current.bottom) > 2) continue;
        visited.add(key);
        columns.push(column);
        queue.push(column);
      }
    }
    return columns.sort((a, b) => a.bottom - b.bottom || a.x - b.x || a.z - b.z);
  }

  _leavesNear(columns) {
    const found = new Set();
    let checked = 0;
    for (const column of columns) {
      for (let dy = -1; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            if (checked++ > 240) return found;
            const block = this.bot.getBlock({ x: column.x + dx, y: column.top + dy, z: column.z + dz });
            if (block && isLeaves(block.name)) found.add(`${column.x + dx},${column.top + dy},${column.z + dz}`);
          }
        }
      }
    }
    return found;
  }

  _treeFromColumns(columns) {
    if (!columns.length) return null;
    const base = {
      x: Math.min(...columns.map((column) => column.x)),
      y: Math.min(...columns.map((column) => column.bottom)),
      z: Math.min(...columns.map((column) => column.z))
    };
    const positions = [];
    const seen = new Set();
    for (const column of columns) {
      for (let y = column.bottom; y <= column.top; y++) {
        const key = `${column.x},${y},${column.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const block = this.bot.getBlock({ x: column.x, y, z: column.z });
        if (block && isLog(block.name)) {
          positions.push({ x: column.x, y, z: column.z, name: String(block.name).replace(/^minecraft:/, '') });
        }
      }
    }
    if (!positions.length) return null;
    positions.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    const width = Math.max(...columns.map((column) => column.x)) - Math.min(...columns.map((column) => column.x)) + 1;
    const depth = Math.max(...columns.map((column) => column.z)) - Math.min(...columns.map((column) => column.z)) + 1;
    const primary = columns[0];
    const species = primary.species || speciesFor(primary.type);
    const def = definition(species);
    const plantable = columns.every((column) => {
      const below = this.bot.getBlock({ x: column.x, y: column.bottom - 1, z: column.z });
      return Boolean(below && plantableFor(primary.type).includes(String(below.name).replace(/^minecraft:/, '')));
    });
    const leaves = this._leavesNear(columns);
    let confidence = 0.9;
    let reason = 'contiguous trunk';
    if (positions.length <= 1) { confidence -= 0.35; reason = 'single log is not a confirmed tree'; }
    if (!plantable) { confidence -= 0.25; reason = 'trunk base is not on plantable ground'; }
    // A short log column floating on stone/leaves is much more likely to be a
    // branch than a harvestable tree. Tall groundless trunks remain eligible,
    // because a tree can grow beside a cliff / on rooted dirt the scan missed.
    if (!plantable && positions.length < 4) confidence -= 0.2;
    if (columns.length === 4 && width === 2 && depth === 2) { confidence += 0.05; reason = '2x2 trunk footprint'; }
    else if (columns.length > 1) { confidence -= 0.05; reason = 'joined multi-column trunk'; }
    if (leaves.size) confidence += 0.03;
    if (def && def.tall && positions.length < 6) confidence -= 0.05;
    if (def && def.requires2x2 && !(columns.length === 4 && width === 2 && depth === 2)) {
      confidence -= 0.2; reason = `${def.label} needs a 2x2 trunk`;
    }
    return {
      base, columns, positions, type: primary.type, species, label: def ? def.label : species,
      height: Math.max(...columns.map((column) => column.top)) - base.y + 1,
      footprint: `${width}x${depth}`, columnCount: columns.length,
      leaves: leaves.size, plantable,
      confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)),
      reason,
      requires2x2: Boolean(def && def.requires2x2),
      supported: supportsVersion(primary.type, this.version),
      distance: Math.hypot(base.x - this.bot.position.x, base.z - this.bot.position.z)
    };
  }

  _treeAt(base) {
    const columns = this._columnsFor(base);
    return this._treeFromColumns(columns);
  }

  /**
   * Bounded discovery: one scan for logs, derive contiguous columns, then join
   * only touching columns with the same base height. Adjacent trees are never
   * merged, and a 2x2 trunk is returned as one tree.
   */
  findTrees({ radius = 24, limit = 10, types = null, minConfidence = 0.45, budgetMs = ACTION_SCAN_BUDGET_MS } = {}) {
    const names = normalizeLogTypes(types);
    const scanRadius = Math.max(1, Math.min(64, Number(radius) || 24));
    const scanLimit = Math.max(20, Math.min(1200, Number(limit) * 40));
    const logs = findBlocks(this.bot, names, {
      radius: scanRadius,
      limit: scanLimit,
      budgetMs: Math.max(0, Number(budgetMs) || 0),
      yFrom: Math.max(-64, Math.floor(this.bot.position.y) - 20),
      yTo: Math.min(320, Math.floor(this.bot.position.y) + MAX_TREE_HEIGHT + 8)
    });
    const cache = new Map();
    const columns = [];
    for (const log of logs) {
      const key = `${log.x},${log.z}`;
      let column = cache.get(key);
      if (!column) {
        column = this._columnAt(log.x, log.z, log.y);
        cache.set(key, column || null);
      }
      if (column) columns.push(column);
    }
    const unique = new Map();
    for (const column of columns) unique.set(`${column.x},${column.z}`, column);
    const remaining = [...unique.values()].sort((a, b) => a.bottom - b.bottom || a.x - b.x || a.z - b.z);
    const used = new Set();
    const trees = [];
    for (const seed of remaining) {
      if (used.has(`${seed.x},${seed.z}`)) continue;
      const cluster = [seed];
      used.add(`${seed.x},${seed.z}`);
      const queue = [seed];
      while (queue.length && cluster.length < MAX_TRUNK_COLUMNS) {
        const current = queue.shift();
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (cluster.length >= MAX_TRUNK_COLUMNS) break;
          const key = `${current.x + dx},${current.z + dz}`;
          if (used.has(key)) continue;
          const column = unique.get(key);
          if (!column || column.species !== current.species || Math.abs(column.bottom - current.bottom) > 2) continue;
          used.add(key);
          cluster.push(column);
          queue.push(column);
        }
      }
      const tree = this._treeFromColumns(cluster.sort((a, b) => a.bottom - b.bottom || a.x - b.x || a.z - b.z));
      if (tree && this._inZone(tree.base)) trees.push(tree);
    }
    this._bump('identified', trees.filter((tree) => tree.confidence >= minConfidence).length);
    return trees
      .filter((tree) => tree.confidence >= minConfidence)
      .map((tree) => ({
        base: { ...tree.base }, type: tree.type, species: tree.species, label: tree.label,
        count: tree.positions.length, height: tree.height, footprint: tree.footprint,
        columnCount: tree.columnCount, leaves: tree.leaves, confidence: tree.confidence,
        reason: tree.reason, supported: tree.supported, requires2x2: tree.requires2x2,
        distance: Math.round(tree.distance * 10) / 10,
        holder: this.reservations ? (this.reservations.holder(treeKey(tree.base)) || {}).owner || null : null
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
  }

  /**
   * A command that has no tree in its working radius walks to a fresh forest
   * inside the shared work zone. Attempts are bounded; when the allowed ring is
   * exhausted the result is an honest error, never an ever-expanding search.
   */
  async relocateForTrees({ range = 40 } = {}) {
    const bot = this.bot;
    const position = bot.position;
    if (!position) return { ok: false, error: 'bot has no position' };
    if (this._searchAttempts >= 6) {
      return { ok: false, code: 'SEARCH_EXHAUSTED', error: 'bounded forest search is exhausted; no fresh site remains' };
    }
    const origin = this.home || position;
    const zone = this.zone();
    const maxDistance = zone.enabled
      ? Math.max(8, Math.floor(zone.size / 2) - Math.max(4, Number(config.workZone && config.workZone.margin) || 2))
      : 512;
    const wanted = Math.max(16, Number(range) || 40) + this._searchAttempts * 16;
    const distance = Math.min(maxDistance, wanted);
    if (zone.enabled && this._searchAttempts > 0 && distance >= maxDistance) {
      return {
        ok: false, code: 'OUTSIDE_WORK_ZONE', zone,
        error: `no trees found inside the ${zone.label} work zone; refusing to leave it`
      };
    }
    const angle = (this.index / BOT_NAMES.length) * Math.PI * 2 + Math.PI / 3 + this._searchAttempts * 1.15;
    const x = Math.floor(origin.x + Math.cos(angle) * distance);
    const z = Math.floor(origin.z + Math.sin(angle) * distance);
    const target = clampToWorkZone({ x, y: position.y, z }, origin, { margin: config.workZone ? config.workZone.margin : 0 });
    const surface = typeof bot.surfaceAt === 'function' ? bot.surfaceAt(target.x, target.z) : null;
    const y = Number.isFinite(Number(surface)) ? Number(surface) : Math.floor(position.y);
    const previous = { ...position };
    const move = await bot.goTo({ x: target.x, y, z: target.z }, {
      range: 3, timeoutMs: 20000, priority: 'operator', owner: `wood-search:${this.bot.name}`
    });
    if (move && move.ok === false) {
      return {
        ok: false, x: target.x, y, z: target.z, zone,
        error: `could not reach a fresh forest inside the work zone: ${move.error || 'path unavailable'}`
      };
    }
    const travelled = Math.hypot(bot.position.x - previous.x, bot.position.z - previous.z);
    // A successful path call that did not actually move is not exploration.
    if (travelled < 3) {
      return { ok: false, x: target.x, y, z: target.z, moved: false, travelled, zone, error: 'relocation did not move the bot away from its old site' };
    }
    this._searchAttempts++;
    return { ok: true, x: target.x, y, z: target.z, moved: true, travelled: Math.round(travelled * 10) / 10, zone };
  }

  _inventorySnapshot() {
    const out = {};
    for (const [name, count] of Object.entries(this.bot.inventory || {})) out[name] = Number(count) || 0;
    return out;
  }

  _logDelta(before, after) {
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    let gained = 0;
    let lost = 0;
    const items = {};
    for (const name of names) {
      if (!LOG_PATTERN.test(String(name).replace(/^minecraft:/, ''))) continue;
      const delta = (after[name] || 0) - (before[name] || 0);
      if (delta > 0) { gained += delta; items[name] = delta; }
      else if (delta < 0) lost += -delta;
    }
    return { gained, lost, items };
  }

  _axeDurability() {
    const axe = typeof this.bot.bestToolFor === 'function' ? this.bot.bestToolFor('axe') : null;
    if (!axe) return null;
    const meta = this.bot.itemMeta && this.bot.itemMeta[axe.name];
    if (meta && Number(meta.durability) === 0) return { ...axe, broken: true };
    return axe;
  }

  async _ensureAxe() {
    let axe = this._axeDurability();
    if (axe && !axe.broken) {
      if (this.lastAxe !== axe.name) {
        this.lastAxe = axe.name;
        this._bump('axesEquipped');
      }
      if (typeof this.bot.equipBestTool === 'function') await this.bot.equipBestTool('axe').catch(() => null);
      return { ok: true, axe, crafted: false };
    }
    if (axe && axe.broken) this._bump('axesBroken');
    // Convert a log into planks/sticks when the bot has the raw material but
    // no handle. This is the same real craft path; a missing recipe simply
    // leaves the honest "chopping by hand" result below.
    if (typeof this.bot.craft === 'function' && (this.bot.countItem('stick') || 0) < 2) {
      const planks = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks', 'pale_oak_planks'];
      let plankName = planks.find((name) => (this.bot.countItem(name) || 0) >= 3);
      if (!plankName) {
        const log = Object.keys(this.bot.inventory || {}).find((name) => LOG_PATTERN.test(name) && (this.bot.countItem(name) || 0) > 0);
        if (log) {
          const species = speciesFor(log);
          const candidate = `${species || 'oak'}_planks`;
          // Five planks are needed for a wooden axe including its sticks.
          for (let batch = 0; batch < 4; batch++) {
            const total = planks.reduce((sum, name) => sum + (this.bot.countItem(name) || 0), 0);
            if (total >= 5) break;
            const made = await this.bot.craft(candidate, 1).catch(() => ({ ok: false }));
            if (!made || made.ok === false) await this.bot.craft('oak_planks', 1).catch(() => ({ ok: false }));
          }
          plankName = planks.find((name) => (this.bot.countItem(name) || 0) >= 3);
        }
      }
      if (plankName && (this.bot.countItem('stick') || 0) < 2) {
        await this.bot.craft('stick', 1).catch(() => ({ ok: false }));
      }
    }
    // Craft the cheapest axe the inventory can actually support. This is a
    // real craft call; a mock/live adapter must return ok or the result stays
    // honest and chopping continues by hand.
    const orders = [
      ['wooden_axe', { oak_planks: 3, stick: 2 }],
      ['stone_axe', { cobblestone: 3, stick: 2 }],
      ['iron_axe', { iron_ingot: 3, stick: 2 }],
      ['diamond_axe', { diamond: 3, stick: 2 }]
    ];
    for (const [item, materials] of orders) {
      if (!Object.entries(materials).every(([name, count]) => (this.bot.countItem(name) || 0) >= count)) continue;
      const crafted = await this.bot.craft(item, 1).catch((error) => ({ ok: false, error: error.message }));
      if (!crafted || crafted.ok === false) continue;
      axe = this.bot.bestToolFor('axe');
      if (axe) {
        this._bump('axesCrafted');
        this._bump('axesEquipped');
        this.lastAxe = axe.name;
        if (typeof this.bot.equipBestTool === 'function') await this.bot.equipBestTool('axe').catch(() => null);
        return { ok: true, axe, crafted: true, item };
      }
    }
    return { ok: false, axe: null, error: 'no usable axe and no crafting materials; chopping by hand' };
  }

  _danger() {
    if (Number(this.bot.health) <= 6) return { danger: true, reason: 'health is too low to chop safely' };
    if (Number(this.bot.health) <= 10 && typeof this.bot.hostileNear === 'function') {
      let hostiles = [];
      try { hostiles = this.bot.hostileNear(4) || []; } catch (_) { hostiles = []; }
      if (hostiles.length) return { danger: true, reason: `hostile ${hostiles[0].name || hostiles[0].type} within 4 blocks at low health` };
    }
    return { danger: false };
  }

  _stancesFor(log) {
    const candidates = [
      { x: log.x + 1, y: log.y, z: log.z },
      { x: log.x - 1, y: log.y, z: log.z },
      { x: log.x, y: log.y, z: log.z + 1 },
      { x: log.x, y: log.y, z: log.z - 1 }
    ];
    const seen = new Set();
    const out = [];
    for (const candidate of candidates) {
      const clamped = clampToWorkZone(candidate, this.home, { margin: config.workZone ? config.workZone.margin : 0 });
      const key = `${clamped.x},${clamped.y},${clamped.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clamped);
    }
    return out;
  }

  _eyeReach(log) {
    const eye = { x: this.bot.position.x, y: Number(this.bot.position.y) + 1.6, z: this.bot.position.z };
    return Math.hypot(log.x + 0.5 - eye.x, log.y + 0.5 - eye.y, log.z + 0.5 - eye.z);
  }

  /**
   * Adapters enforce their own interaction distance from the bot's feet as
   * well as the eye ray. Checking only the eye produced a "too far to dig"
   * failure after a successful path; both limits must pass before a dig.
   */
  _digReach(log) {
    const feet = this.bot.position;
    return Math.hypot(log.x - feet.x, log.y - feet.y, log.z - feet.z);
  }

  async _clearLeaves(tree) {
    let cleared = 0;
    const candidates = new Set();
    for (const column of tree.columns) {
      for (let dy = 0; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            if (candidates.size >= MAX_LEAVES_PER_TREE * 2) break;
            const pos = { x: column.x + dx, y: column.top + dy, z: column.z + dz };
            const block = this.bot.getBlock(pos);
            if (block && isLeaves(block.name)) candidates.add(`${pos.x},${pos.y},${pos.z}`);
          }
        }
      }
    }
    for (const key of [...candidates].slice(0, MAX_LEAVES_PER_TREE)) {
      if (this.stopRequested) break;
      const [x, y, z] = key.split(',').map(Number);
      const pos = { x, y, z };
      if (!this._inZone(pos)) continue;
      const block = this.bot.getBlock(pos);
      if (!block || !isLeaves(block.name)) continue;
      if (this._eyeReach(pos) > REACH) {
        const move = await this.bot.goTo(pos, { range: 4, timeoutMs: 8000 });
        if (move && move.ok === false) continue;
        if (this._eyeReach(pos) > REACH + 0.6) continue;
      }
      const dig = await this.bot.digBlock(pos);
      const after = this.bot.getBlock(pos);
      if (dig.ok && (!after || !isLeaves(after.name))) {
        cleared++;
        this._bump('leavesCleared');
      }
    }
    return cleared;
  }

  /**
   * Chop every contiguous log column of one identified tree, bottom-up. Each
   * removal is verified by re-reading the block; a failed dig never counts.
   */
  async chopTree(base, { maxHeight = MAX_TREE_HEIGHT, tree = null } = {}) {
    if (!this._inZone(base)) return this._zoneError(base);
    const baseBlock = this.bot.getBlock(base);
    if (!baseBlock) return { ok: false, error: `world returned no block at ${base.x},${base.y},${base.z}` };
    if (!isLog(baseBlock.name)) return { ok: false, error: `not a tree at ${base.x},${base.y},${base.z} (${baseBlock.name})` };
    const danger = this._danger();
    if (danger.danger) return { ok: false, code: 'UNSAFE', error: danger.reason };
    const resolved = tree || this._treeAt(base);
    if (!resolved || !resolved.positions.length) return { ok: false, error: 'no trunk found' };
    const treeInfo = resolved;
    this._bump('identified');
    const before = this._inventorySnapshot();
    const axe = await this._ensureAxe();
    const limitY = treeInfo.base.y + Math.max(1, Number(maxHeight) || MAX_TRUNK_HEIGHT);
    const positions = treeInfo.positions.filter((log) => log.y < limitY);
    const droppedInWorld = treeInfo.positions.length - positions.length;
    let chopped = 0;
    let leaves = 0;
    let failure = null;
    for (const log of positions) {
      if (this.stopRequested) break;
      const still = this.bot.getBlock(log);
      if (!still || !isLog(still.name)) continue; // another actor removed it; never count it
      if (this._eyeReach(log) > REACH || this._digReach(log) > DIG_REACH) {
        let positioned = false;
        let moveError = null;
        // Try at most two adjacent stances. A blocked side of a 2x2 trunk
        // should not consume four pathfinding attempts before reporting that
        // the upper log is genuinely out of reach.
        for (const stance of this._stancesFor(log).slice(0, 2)) {
          const move = await this.bot.goTo(stance, { range: 2, timeoutMs: 12000 });
          if (move && move.ok === false) { moveError = move.error; continue; }
          if (this._eyeReach(log) <= REACH && this._digReach(log) <= DIG_REACH) { positioned = true; break; }
        }
        if (!positioned) {
          failure = moveError
            ? `cannot reach ${log.x},${log.y},${log.z}: ${moveError}`
            : `log at ${log.x},${log.y},${log.z} is above mining reach`;
          break;
        }
      }
      const dig = await this.bot.digBlock(log);
      const after = this.bot.getBlock(log);
      const removed = !after || !isLog(after.name);
      if (dig.ok && removed) {
        chopped++;
        this._bump('blocksVerified');
      } else {
        failure = dig.error || `block at ${log.x},${log.y},${log.z} is still ${after ? after.name : 'unknown'}`;
        if (dig.ok) break;
      }
    }
    if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(8);
    const after = this._inventorySnapshot();
    const delta = this._logDelta(before, after);
    if (delta.gained > 0) this._bump('logsCollected', delta.gained);
    if (delta.lost > 0) this._bump('logsLost', delta.lost);
    const saplingCount = [...SAPLINGS].reduce((sum, name) => sum + (this.bot.countItem(name) || 0), 0);
    if (chopped === positions.length) {
      leaves = await this._clearLeaves(treeInfo);
      if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(8);
    }
    const saplingsNow = [...SAPLINGS].reduce((sum, name) => sum + (this.bot.countItem(name) || 0), 0);
    // Sapling gains are independent of log gains; report the real increase.
    const saplingGain = Math.max(0, saplingsNow - saplingCount);
    if (saplingGain > 0) this._bump('saplingsCollected', saplingGain);
    if (chopped > 0) this._bump('treesChopped');
    else this._bump('treesFailed');
    if (this.memory && chopped > 0) {
      this.memory.observe({
        type: 'TREE', resource: 'wood', position: { x: treeInfo.base.x, y: treeInfo.base.y, z: treeInfo.base.z },
        reportedBy: this.bot.name, confidence: treeInfo.confidence, status: 'HARVESTED',
        data: {
          type: treeInfo.type, species: treeInfo.species, logs: chopped, leaves,
          footprint: treeInfo.footprint, height: treeInfo.height, droppedInWorld, at: Date.now()
        }
      });
    }
    const replant = await this.replant(treeInfo.base, treeInfo.type, { tree: treeInfo });
    if (this.ledger) this.ledger.updateBotInventory(this.bot.name, this.bot.inventory);
    this.lastTree = {
      base: { ...treeInfo.base }, type: treeInfo.type, species: treeInfo.species,
      footprint: treeInfo.footprint, height: treeInfo.height, confidence: treeInfo.confidence,
      chopped, leaves, replanted: Boolean(replant.ok && replant.planted > 0), at: Date.now()
    };
    return {
      ok: chopped > 0,
      type: treeInfo.type, species: treeInfo.species, label: treeInfo.label,
      chopped, leaves, total: positions.length, partial: chopped < treeInfo.positions.length,
      footprint: treeInfo.footprint, height: treeInfo.height, confidence: treeInfo.confidence,
      axe: axe.axe || null, axeCrafted: Boolean(axe.crafted),
      dropped: delta.items, logsGained: delta.gained, verifiedDrops: delta.gained > 0 || chopped === 0,
      saplingsGained: saplingGain, droppedInWorld,
      replanted: Boolean(replant.ok && replant.planted > 0), replant, base,
      error: chopped < treeInfo.positions.length
        ? (failure || (droppedInWorld ? 'upper trunk exceeds the chop height limit' : 'trunk not fully chopped'))
        : undefined
    };
  }

  /**
   * Replant the harvested footprint with the matching sapling. Dark oak and
   * other 2x2 species are only planted when the whole 2x2 square is available.
   */
  async replant(base, logType = null, { tree = null } = {}) {
    const resolved = tree || this._treeAt(base);
    if (!resolved) return { ok: false, error: 'no tree footprint to replant' };
    const type = logType || resolved.type;
    const sapling = saplingFor(type);
    if (resolved.requires2x2 && resolved.columnCount !== 4) {
      return { ok: false, error: `${resolved.label} needs a 2x2 sapling square`, sapling, required: 4 };
    }
    if ((this.bot.countItem(sapling) || 0) < resolved.columns.length) {
      return { ok: false, error: `no ${sapling} (need ${resolved.columns.length})`, sapling, required: resolved.columns.length };
    }
    let planted = 0;
    const failures = [];
    for (const column of resolved.columns) {
      const pos = { x: column.x, y: column.bottom, z: column.z };
      const below = this.bot.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
      if (!below || !plantableFor(type).includes(String(below.name).replace(/^minecraft:/, ''))) {
        failures.push({ position: pos, error: 'ground is not plantable' });
        continue;
      }
      const current = this.bot.getBlock(pos);
      if (current && !['air', 'cave_air'].includes(String(current.name).replace(/^minecraft:/, ''))) {
        failures.push({ position: pos, error: 'stump position occupied' });
        continue;
      }
      if (!this.bot.countItem(sapling)) break;
      const move = await this.bot.goTo(pos, { range: 4, timeoutMs: 10000 });
      if (move && move.ok === false) {
        failures.push({ position: pos, error: move.error });
        continue;
      }
      const placed = await this.bot.placeBlock(pos, sapling);
      const after = this.bot.getBlock(pos);
      const verified = Boolean(placed.ok && after && String(after.name).replace(/^minecraft:/, '') === sapling);
      if (verified) {
        planted++;
        this._bump('replanted');
        this.replanted.push({ position: { ...pos }, sapling, species: resolved.species, at: Date.now() });
        if (this.memory) {
          this.memory.observe({
            type: 'TREE', resource: 'sapling', position: { ...pos }, reportedBy: this.bot.name,
            confidence: 0.9, status: 'PLANTED', data: { sapling, species: resolved.species, at: Date.now() }
          });
        }
      } else {
        failures.push({ position: pos, error: placed.error || 'placement not verified' });
      }
    }
    if (this.replanted.length > 40) this.replanted.splice(0, this.replanted.length - 40);
    return {
      ok: planted > 0 && !failures.length,
      partial: planted > 0 && failures.length > 0,
      planted, required: resolved.columns.length, sapling, failures,
      error: failures.length ? failures[0].error : undefined
    };
  }

  /**
   * Plant spare saplings on nearby suitable ground. Bounded to a handful of
   * positions per call and verified block-by-block.
   */
  async plantNearby({ radius = 10, limit = 4 } = {}) {
    const saplings = [...SAPLINGS].filter((name) => (this.bot.countItem(name) || 0) > 0);
    if (!saplings.length) return { ok: false, code: 'NO_SAPLINGS', error: 'no saplings in inventory' };
    const ground = findBlocks(this.bot, ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block'], {
      radius: Math.max(2, Math.min(24, Number(radius) || 10)), limit: 40, budgetMs: ACTION_SCAN_BUDGET_MS,
      yFrom: Math.floor(this.bot.position.y) - 6, yTo: Math.floor(this.bot.position.y) + 2
    });
    let planted = 0;
    const failures = [];
    for (const block of ground) {
      if (planted >= limit) break;
      const pos = { x: block.x, y: block.y + 1, z: block.z };
      if (!this._inZone(pos)) continue;
      const above = this.bot.getBlock(pos);
      if (!above || !['air', 'cave_air'].includes(String(above.name).replace(/^minecraft:/, ''))) continue;
      const sapling = saplings.find((name) => (this.bot.countItem(name) || 0) > 0);
      if (!sapling) break;
      const move = await this.bot.goTo(pos, { range: 4, timeoutMs: 8000 });
      if (move && move.ok === false) { failures.push({ position: pos, error: move.error }); continue; }
      const placed = await this.bot.placeBlock(pos, sapling);
      const after = this.bot.getBlock(pos);
      if (placed.ok && after && String(after.name).replace(/^minecraft:/, '') === sapling) {
        planted++;
        this._bump('planted');
        this._bump('replanted');
        this.replanted.push({ position: { ...pos }, sapling, at: Date.now() });
      } else {
        failures.push({ position: pos, error: placed.error || 'placement not verified' });
      }
    }
    return { ok: planted > 0, planted, failures, error: planted ? undefined : (failures[0] && failures[0].error) || 'no suitable planting position' };
  }

  /** Deliver logs to real storage, verifying each deposit against inventory. */
  async storeLoot({ minLogs = this.reserveTarget } = {}) {
    const logs = countLogs(this.bot.inventory);
    if (!logs) return { ok: false, code: 'NO_LOGS', error: 'no logs in inventory' };
    if (!this.inventory || typeof this.inventory.deposit !== 'function') {
      return { ok: false, code: 'NO_STORAGE_LAYER', error: 'inventory/storage layer unavailable' };
    }
    const storage = await this.inventory.findStorage();
    if (!storage) return { ok: false, code: 'NO_STORAGE', error: 'no verified storage chest is known' };
    const moves = [];
    let moved = 0;
    for (const [name] of Object.entries(this.bot.inventory || {})) {
      if (!LOG_PATTERN.test(String(name).replace(/^minecraft:/, ''))) continue;
      const held = Number(this.bot.countItem(name)) || 0;
      if (!held) continue;
      const before = held;
      const result = await this.inventory.deposit(name, held, storage.position);
      const after = Number(this.bot.countItem(name)) || 0;
      const verified = before - after;
      if (verified > 0) {
        moved += verified;
        moves.push({ item: name, count: verified, verified: true });
      } else {
        moves.push({ item: name, count: 0, error: result.error || 'deposit not verified' });
      }
    }
    this._bump('stored', moved);
    this._bump('tripsHome');
    if (this.ledger) this.ledger.updateBotInventory(this.bot.name, this.bot.inventory);
    return {
      ok: moved > 0, moved, moves, storage: { position: storage.position, id: storage.id, distance: storage.distance },
      remaining: countLogs(this.bot.inventory), minLogs,
      error: moved > 0 ? undefined : 'no log deposit was verified'
    };
  }

  requestSupport({ kind = 'HELP', target = null, detail = null } = {}) {
    const request = {
      id: `wood-${this.bot.name}-${Date.now()}`,
      bot: this.bot.name, kind: String(kind).toUpperCase(), target: target ? { ...target } : null,
      detail: detail ? String(detail).slice(0, 200) : null,
      status: 'open', createdAt: Date.now()
    };
    this.supportRequests.push(request);
    if (this.supportRequests.length > 20) this.supportRequests.splice(0, this.supportRequests.length - 20);
    if (this.teamCoordinator && typeof this.teamCoordinator.request === 'function') {
      const shared = this.teamCoordinator.request(request);
      this._bump('supportRequests');
      return shared;
    }
    if (this.supportRequests.length > 20) this.supportRequests.splice(0, this.supportRequests.length - 20);
    this._bump('supportRequests');
    return { ok: true, request };
  }

  /**
   * One bounded harvest tick. Role modifies support behaviour, never the
   * verification rules: every tree still has to be confirmed removed.
   */
  async tick({ radius = 24, maxTrees = 2, types = null, relocate = false, maxRelocations = 1, store = false } = {}) {
    this._begin();
    const startedAt = Date.now();
    const zoneReturn = await this._returnToZone();
    if (!zoneReturn.ok) {
      return {
        ok: false, code: 'OUTSIDE_WORK_ZONE', zone: this.zone(), zoneReturn,
        error: `outside the work zone and could not return: ${zoneReturn.error || 'path unavailable'}`
      };
    }
    let guard = null;
    if (this.role === 'GUARD' && this.combat) {
      const threats = (typeof this.bot.entitiesNear === 'function' ? this.bot.entitiesNear(8) : [])
        .filter((entity) => entity && entity.alive !== false && isHostile(entity))
        .sort((a, b) => Math.hypot(a.position.x - this.bot.position.x, a.position.z - this.bot.position.z)
          - Math.hypot(b.position.x - this.bot.position.x, b.position.z - this.bot.position.z));
      if (threats.length && Number(this.bot.health) > 6) {
        const attack = await this.combat.attackEntity(threats[0]);
        guard = { target: threats[0].name || threats[0].type, ...attack };
        if (attack && attack.ok) {
          return {
            ok: true, chopped: 0, guard, role: this.role, idle: false,
            reason: 'guard role defended a hostile instead of chopping',
            task: this.taskStats(), status: this.status()
          };
        }
      }
    }
    let planted = null;
    if (this.role === 'PLANTER') planted = await this.plantNearby({ limit: 4 });
    const radii = [Math.max(4, Math.min(48, Number(radius) || 24))];
    if (radii[0] < 48) radii.push(48);
    let trees = [];
    let searchedRadius = radii[0];
    for (const scanRadius of radii) {
      trees = this.findTrees({ radius: scanRadius, limit: Math.max(maxTrees * 3, maxTrees), types });
      searchedRadius = scanRadius;
      if (trees.length) break;
    }
    let relocations = [];
    const relocationBudget = this.role === 'SCOUT' ? Math.max(2, maxRelocations) : maxRelocations;
    while (!trees.length && relocate && relocations.length < relocationBudget && !this.stopRequested) {
      const moved = await this.relocateForTrees();
      relocations.push(moved);
      if (!moved.ok) break;
      trees = this.findTrees({ radius: 32, limit: Math.max(maxTrees * 3, maxTrees), types });
      searchedRadius = 32;
    }
    const usable = trees.filter((tree) => !tree.holder || tree.holder === this.bot.name);
    const reservedAtScan = trees.length - usable.length;
    if (!usable.length) {
      const result = {
        ok: true, idle: true, chopped: 0,
        reason: reservedAtScan > 0
          ? 'all nearby trees are reserved by teammates'
          : relocations.length ? 'no trees at the fresh forest site' : 'no trees inside the work zone',
        searchedRadius, reserved: reservedAtScan, relocations, zone: this.zone(), status: this.status()
      };
      if (store || this.role === 'HAULER') {
        result.storage = await this.storeLoot().catch((error) => ({ ok: false, error: error.message }));
      }
      return result;
    }
    this._searchAttempts = 0;
    const results = [];
    let chopped = 0;
    let reserved = reservedAtScan;
    let lastError = null;
    for (let index = 0; index < maxTrees && !this.stopRequested; index++) {
      await new Promise((resolve) => setImmediate(resolve));
      let selected = null;
      let lease = null;
      const candidates = this.findTrees({ radius: searchedRadius, limit: Math.max(maxTrees * 3, 12), types })
        .filter((tree) => !tree.holder || tree.holder === this.bot.name);
      for (const tree of candidates) {
        const claim = this._claimTree(tree.base);
        if (!claim.ok) { reserved++; continue; }
        selected = tree;
        lease = claim;
        break;
      }
      if (!selected) {
        if (reserved > 0) lastError = 'all nearby trees are reserved by teammates';
        break;
      }
      try {
        const result = await this.chopTree(selected.base);
        results.push(result);
        chopped += Number(result.chopped) || 0;
        if (result.chopped === 0) {
          lastError = result.error || 'tree was not chopped';
          break;
        }
      } finally {
        if (lease && lease.ok) this._releaseTree(selected.base);
      }
      if (this.bot.health <= 8) break;
    }
    const elapsedMs = Date.now() - startedAt;
    let storage = null;
    if ((store || this.role === 'HAULER') && countLogs(this.bot.inventory) >= this.reserveTarget) {
      storage = await this.storeLoot().catch((error) => ({ ok: false, error: error.message }));
    }
    if (chopped > 0) {
      const treesDone = results.filter((result) => result.chopped > 0).length;
      this.logger.info(`[${this.bot.name}] chop summary: ${treesDone} tree(s), ${chopped} log(s) in ${elapsedMs}ms${reserved ? `, ${reserved} reserved` : ''}`);
    }
    return {
      ok: chopped > 0, chopped, stopped: this.stopRequested, results,
      searchedRadius, relocations, reserved, elapsedMs, zone: this.zone(),
      planted, storage, guard, role: this.role,
      error: chopped > 0 ? undefined : (lastError || 'no tree was chopped and verified'),
      task: this.taskStats(), status: this.status()
    };
  }
}

module.exports = {
  WoodcuttingController, SAPLING_FOR, SAPLINGS, LOG_PATTERN, LOG_TYPES,
  normalizeLogTypes, ROLES, countLogs, catalogue
};
