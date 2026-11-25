'use strict';

const { Logger } = require('../logger');
const { BOT_NAMES } = require('../config');
const { findBlocks } = require('./common');

const LOG_PATTERN = /_log$/;
const SAPLING_FOR = {
  oak_log: 'oak_sapling', birch_log: 'birch_sapling', spruce_log: 'spruce_sapling',
  jungle_log: 'jungle_sapling', acacia_log: 'acacia_sapling', dark_oak_log: 'dark_oak_sapling',
  cherry_log: 'cherry_sapling', mangrove_log: 'mangrove_propagule', pale_oak_log: 'pale_oak_sapling'
};
const SAPLINGS = new Set(Object.values(SAPLING_FOR));
const LOG_TYPES = Object.keys(SAPLING_FOR);
const TYPE_ALIASES = {
  oak: 'oak_log', birch: 'birch_log', spruce: 'spruce_log', jungle: 'jungle_log',
  acacia: 'acacia_log', dark_oak: 'dark_oak_log', dark: 'dark_oak_log',
  cherry: 'cherry_log', mangrove: 'mangrove_log', pale_oak: 'pale_oak_log'
};

function normalizeLogTypes(value) {
  if (value === undefined || value === null || value === '' || value === 'wood' || value === 'any') return LOG_TYPES.slice();
  const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/).filter(Boolean);
  const resolved = list.map((entry) => TYPE_ALIASES[String(entry).toLowerCase()] || (LOG_TYPES.includes(entry) ? entry : null)).filter(Boolean);
  return resolved.length ? [...new Set(resolved)] : LOG_TYPES.slice();
}

/**
 * Tree harvesting with replanting. Chop from the lowest reachable log upward
 * (mining reach cannot touch a crown), verify each removed block, take leaves
 * only when the whole trunk fell, and replant on the original dirt/grass
 * block. Every completed tree is recorded in shared memory.
 */
class WoodcuttingController {
  constructor({ bot, memory = null, ledger = null, logger = null, reserveTarget = 64, home = null, index = 0 } = {}) {
    if (!bot) throw new Error('WoodcuttingController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.ledger = ledger;
    this.logger = logger || new Logger({ level: 'warn' });
    this.reserveTarget = reserveTarget;
    this.home = home ? { ...home } : null;
    this.index = Number(index) || 0;
    this.stats = { treesChopped: 0, logsCollected: 0, replanted: 0, saplingsCollected: 0, leavesCleared: 0 };
    this.replanted = [];
    this.stopRequested = false;
    this._searchAttempts = 0;
  }

  status() {
    return {
      bot: this.bot.name,
      axe: this.bot.bestToolFor('axe'),
      logs: Object.entries(this.bot.inventory).filter(([n]) => LOG_PATTERN.test(n)).reduce((s, [, c]) => s + c, 0),
      saplings: [...SAPLINGS].reduce((s, n) => s + (this.bot.countItem(n) || 0), 0),
      reserveTarget: this.reserveTarget,
      stopped: Boolean(this.stopRequested),
      treesChopped: this.stats.treesChopped,
      replanted: this.replanted.slice(-10),
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

  findTrees({ radius = 24, limit = 10, types = null } = {}) {
    const logs = findBlocks(this.bot, normalizeLogTypes(types), { radius, limit: 200 });
    const groups = [];
    for (const log of logs) {
      let group = groups.find((g) => Math.abs(g.base.x - log.x) <= 1 && Math.abs(g.base.z - log.z) <= 1 && Math.abs(g.base.y - log.y) <= 24);
      if (!group) { group = { base: { x: log.x, y: log.y, z: log.z }, logs: [], type: log.name }; groups.push(group); }
      group.logs.push(log);
      if (log.y < group.base.y) group.base = { x: log.x, y: log.y, z: log.z };
    }
    return groups
      .map((g) => ({ base: g.base, type: g.type, count: g.logs.length, distance: Math.hypot(g.base.x - this.bot.position.x, g.base.z - this.bot.position.z) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  /**
   * A command that has no tree in its 24-block working radius must walk to a
   * fresh forest instead of returning `no trees nearby` forever. Each bot uses
   * its own bearing so five bots do not pile onto the same trunk.
   */
  async relocateForTrees({ range = 40 } = {}) {
    const bot = this.bot;
    const position = bot.position;
    if (!position) return { ok: false, error: 'bot has no position' };
    const origin = this.home || position;
    const distance = Math.max(24, Number(range) || 40) + this._searchAttempts * 24;
    const angle = (this.index / BOT_NAMES.length) * Math.PI * 2 + Math.PI / 3 + this._searchAttempts * 1.15;
    const x = Math.floor(origin.x + Math.cos(angle) * distance);
    const z = Math.floor(origin.z + Math.sin(angle) * distance);
    const surface = typeof bot.surfaceAt === 'function' ? bot.surfaceAt(x, z) : null;
    const y = Number.isFinite(Number(surface)) ? Number(surface) : Math.floor(position.y);
    const move = await bot.goTo({ x, y, z }, {
      range: 3, timeoutMs: 20000, priority: 'operator', owner: `wood-search:${this.bot.name}`
    });
    if (move && move.ok === false) {
      return { ok: false, x, y, z, error: `could not reach a fresh forest: ${move.error || 'path unavailable'}` };
    }
    this._searchAttempts++;
    return { ok: true, x, y, z, moved: true };
  }

  /**
   * Chop the lowest reachable logs first. The old top-down order asked the bot
   * to path to the crown of a tall tree, which is outside mining reach; the
   * first failure aborted the whole tree and the command honestly reported
   * "no tree was chopped". Bottom-up also lets a partially blocked trunk still
   * yield verified logs instead of losing the entire tree.
   */
  async chopTree(base, { maxHeight = 24 } = {}) {
    const baseBlock = this.bot.getBlock(base);
    if (!baseBlock) return { ok: false, error: `world returned no block at ${base.x},${base.y},${base.z}` };
    const type = baseBlock.name;
    if (!LOG_PATTERN.test(type)) return { ok: false, error: `not a tree at ${base.x},${base.y},${base.z} (${type})` };
    const logs = [];
    let y = base.y;
    while (y < base.y + maxHeight) {
      const block = this.bot.getBlock({ x: base.x, y, z: base.z });
      if (!block || !LOG_PATTERN.test(block.name)) break;
      logs.push({ x: base.x, y, z: base.z, name: block.name });
      y++;
    }
    if (!logs.length) return { ok: false, error: 'no trunk found' };
    let chopped = 0;
    let failure = null;
    for (const log of logs) {
      if (this.stopRequested) break;
      const eye = { x: this.bot.position.x, y: Number(this.bot.position.y) + 1.6, z: this.bot.position.z };
      const reach = Math.hypot(log.x + 0.5 - eye.x, log.y + 0.5 - eye.y, log.z + 0.5 - eye.z);
      if (reach > 4.5) {
        // Stand beside the trunk once, then re-measure. Upper logs beyond arm's
        // reach are left standing rather than aborting the logs already won.
        const move = await this.bot.goTo({ x: log.x + 1, y: log.y, z: log.z + 1 }, { range: 2, timeoutMs: 12000 });
        if (move && move.ok === false) {
          failure = `cannot reach ${log.x},${log.y},${log.z}: ${move.error}`;
          break;
        }
        const eye2 = { x: this.bot.position.x, y: Number(this.bot.position.y) + 1.6, z: this.bot.position.z };
        const reach2 = Math.hypot(log.x + 0.5 - eye2.x, log.y + 0.5 - eye2.y, log.z + 0.5 - eye2.z);
        if (reach2 > 4.5) { failure = `log at ${log.x},${log.y},${log.z} is above mining reach`; break; }
      }
      const dig = await this.bot.digBlock(log);
      // A dig packet is not proof. Count only a log the world no longer shows.
      const after = this.bot.getBlock(log);
      const removed = !after || !LOG_PATTERN.test(after.name);
      if (dig.ok && removed) chopped++;
      else {
        failure = dig.error || `block at ${log.x},${log.y},${log.z} is still ${after ? after.name : 'unknown'}`;
        if (dig.ok) break;
      }
    }
    // Clear leaves that are still attached to the top of the stump.
    let leaves = 0;
    if (chopped === logs.length) {
      const top = { x: base.x, y: base.y + logs.length, z: base.z };
      for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const pos = { x: top.x + dx, y: top.y + dy, z: top.z + dz };
        const block = this.bot.getBlock(pos);
        if (block && /_leaves$/.test(block.name) && !this.stopRequested) {
          const move = await this.bot.goTo(pos, { range: 4 });
          if (move && move.ok === false) continue;
          const dig = await this.bot.digBlock(pos);
          if (dig.ok) { leaves++; this.stats.leavesCleared++; }
        }
      }
    }
    if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(8);
    const harvested = Object.entries(this.bot.inventory).filter(([n]) => LOG_PATTERN.test(n)).reduce((s, [, c]) => s + c, 0);
    this.stats.logsCollected = harvested;
    this.stats.saplingsCollected = [...SAPLINGS].reduce((s, n) => s + (this.bot.countItem(n) || 0), 0);
    // A failed chop must not be recorded as a harvested tree: that made the
    // dashboard claim wood production while the trunk was still standing.
    if (chopped > 0) this.stats.treesChopped++;
    if (this.memory && chopped > 0) {
      this.memory.observe({
        type: 'TREE', resource: 'wood', position: { x: base.x, y: base.y, z: base.z }, reportedBy: this.bot.name,
        confidence: 0.9, status: 'HARVESTED', data: { type, logs: chopped, leaves, at: Date.now() }
      });
    }
    const replant = await this.replant(base, type);
    if (this.ledger) this.ledger.updateBotInventory(this.bot.name, this.bot.inventory);
    return {
      ok: chopped > 0, type, chopped, leaves, replanted: replant.ok, replant, base,
      partial: chopped < logs.length,
      error: chopped < logs.length ? (failure || 'trunk not fully chopped') : undefined
    };
  }

  async replant(base, logType = null) {
    const below = this.bot.getBlock({ x: base.x, y: base.y - 1, z: base.z });
    if (!below || !['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud'].includes(below.name)) {
      return { ok: false, error: 'ground is not plantable' };
    }
    const world = this.bot.getBlock(base);
    if (world && world.name !== 'air') return { ok: false, error: 'stump position occupied' };
    const type = logType || 'oak_log';
    const sapling = SAPLING_FOR[type] || 'oak_sapling';
    if (!this.bot.countItem(sapling)) return { ok: false, error: `no ${sapling}` };
    const move = await this.bot.goTo(base, { range: 4 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const placed = await this.bot.placeBlock(base, sapling);
    if (placed.ok) {
      this.stats.replanted++;
      this.replanted.push({ position: { ...base }, sapling, at: Date.now() });
      if (this.memory) {
        this.memory.observe({ type: 'TREE', resource: 'sapling', position: { ...base }, reportedBy: this.bot.name, confidence: 0.9, status: 'PLANTED', data: { sapling, at: Date.now() } });
      }
    }
    return placed;
  }

  async tick({ radius = 24, maxTrees = 2, types = null, relocate = false, maxRelocations = 1 } = {}) {
    this._begin();
    const radii = [radius];
    if (radius < 48) radii.push(48);
    let trees = [];
    let scannedRadius = radius;
    for (const scanRadius of radii) {
      trees = this.findTrees({ radius: scanRadius, limit: maxTrees, types });
      scannedRadius = scanRadius;
      if (trees.length) break;
    }
    let relocations = [];
    while (!trees.length && relocate && relocations.length < maxRelocations && !this.stopRequested) {
      const moved = await this.relocateForTrees();
      relocations.push(moved);
      if (!moved.ok) break;
      // The fresh site is validated by the same bounded scan; a path that
      // arrived somewhere without logs is reported as such, not as success.
      trees = this.findTrees({ radius: 32, limit: maxTrees, types });
      scannedRadius = 32;
    }
    if (!trees.length) {
      return {
        ok: true, idle: true, reason: relocations.length ? 'no trees at the fresh forest site' : 'no trees nearby',
        searchedRadius: scannedRadius, relocations, status: this.status()
      };
    }
    this._searchAttempts = 0;
    const results = [];
    for (const tree of trees) {
      if (this.stopRequested) break;
      results.push(await this.chopTree(tree.base));
      if (this.bot.health <= 8) break;
    }
    return {
      ok: results.some((r) => r.ok), stopped: this.stopRequested, results,
      searchedRadius: scannedRadius, relocations, status: this.status()
    };
  }
}

module.exports = { WoodcuttingController, SAPLING_FOR, SAPLINGS, LOG_PATTERN, LOG_TYPES, normalizeLogTypes };
