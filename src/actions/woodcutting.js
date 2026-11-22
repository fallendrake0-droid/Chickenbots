'use strict';

const { Logger } = require('../logger');
const { findBlocks, nearestBlock } = require('./common');

const LOG_PATTERN = /_log$/;
const SAPLING_FOR = {
  oak_log: 'oak_sapling', birch_log: 'birch_sapling', spruce_log: 'spruce_sapling',
  jungle_log: 'jungle_sapling', acacia_log: 'acacia_sapling', dark_oak_log: 'dark_oak_sapling',
  cherry_log: 'cherry_sapling', mangrove_log: 'mangrove_propagule', pale_oak_log: 'pale_oak_sapling'
};
const SAPLINGS = new Set(Object.values(SAPLING_FOR));

/**
 * Tree harvesting with replanting. Chop from the top down (so the trunk drops
 * are not lost), take leaves only when saplings are short, and replant on the
 * original dirt/grass block. Every tree is recorded in shared memory.
 */
class WoodcuttingController {
  constructor({ bot, memory = null, ledger = null, logger = null, reserveTarget = 64 } = {}) {
    if (!bot) throw new Error('WoodcuttingController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.ledger = ledger;
    this.logger = logger || new Logger({ level: 'warn' });
    this.reserveTarget = reserveTarget;
    this.stats = { treesChopped: 0, logsCollected: 0, replanted: 0, saplingsCollected: 0, leavesCleared: 0 };
    this.replanted = [];
  }

  status() {
    return {
      bot: this.bot.name,
      axe: this.bot.bestToolFor('axe'),
      logs: Object.entries(this.bot.inventory).filter(([n]) => LOG_PATTERN.test(n)).reduce((s, [, c]) => s + c, 0),
      saplings: [...SAPLINGS].reduce((s, n) => s + (this.bot.countItem(n) || 0), 0),
      reserveTarget: this.reserveTarget,
      treesChopped: this.stats.treesChopped,
      replanted: this.replanted.slice(-10),
      stats: { ...this.stats }
    };
  }

  findTrees({ radius = 24, limit = 10 } = {}) {
    const logs = findBlocks(this.bot, ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log'], { radius, limit: 200 });
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

  async chopTree(base, { maxHeight = 24 } = {}) {
    const type = this.bot.getBlock(base).name;
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
    for (const log of logs.slice().reverse()) {
      const move = await this.bot.goTo(log, { range: 4 });
      if (move && move.ok === false) break;
      const dig = await this.bot.digBlock(log);
      if (dig.ok) chopped++;
    }
    // Clear leaves that are still attached to the top of the stump.
    let leaves = 0;
    if (chopped === logs.length) {
      const top = { x: base.x, y: base.y + logs.length, z: base.z };
      for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const pos = { x: top.x + dx, y: top.y + dy, z: top.z + dz };
        const block = this.bot.getBlock(pos);
        if (block && /_leaves$/.test(block.name)) {
          const move = await this.bot.goTo(pos, { range: 4 });
          if (move && move.ok === false) continue;
          const dig = await this.bot.digBlock(pos);
          if (dig.ok) { leaves++; this.stats.leavesCleared++; }
        }
      }
    }
    if (typeof this.bot.collectDrops === 'function') await this.bot.collectDrops(8);
    this.stats.treesChopped++;
    const harvested = Object.entries(this.bot.inventory).filter(([n]) => LOG_PATTERN.test(n)).reduce((s, [, c]) => s + c, 0);
    this.stats.logsCollected = harvested;
    this.stats.saplingsCollected = [...SAPLINGS].reduce((s, n) => s + (this.bot.countItem(n) || 0), 0);
    if (this.memory) {
      this.memory.observe({
        type: 'TREE', resource: 'wood', position: { x: base.x, y: base.y, z: base.z }, reportedBy: this.bot.name,
        confidence: 0.9, status: 'HARVESTED', data: { type, logs: chopped, leaves, at: Date.now() }
      });
    }
    const replant = await this.replant(base, type);
    if (this.ledger) this.ledger.updateBotInventory(this.bot.name, this.bot.inventory);
    return { ok: chopped > 0, type, chopped, leaves, replanted: replant.ok, replant, base };
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

  async tick({ radius = 24, maxTrees = 2 } = {}) {
    const trees = this.findTrees({ radius, limit: maxTrees });
    if (!trees.length) return { ok: true, idle: true, reason: 'no trees nearby', status: this.status() };
    const results = [];
    for (const tree of trees) {
      results.push(await this.chopTree(tree.base));
      if (this.bot.health <= 8) break;
    }
    return { ok: results.some((r) => r.ok), results, status: this.status() };
  }
}

module.exports = { WoodcuttingController, SAPLING_FOR, SAPLINGS, LOG_PATTERN };
