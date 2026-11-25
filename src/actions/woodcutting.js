'use strict';

const { Logger } = require('../logger');
const { config, BOT_NAMES } = require('../config');
const { findBlocks } = require('./common');
const { inWorkZone, clampToWorkZone, outsideWorkZone, workZone } = require('../world/workZone');
const { treeKey } = require('./reservations');

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
  constructor({ bot, memory = null, ledger = null, logger = null, reserveTarget = 64, home = null, index = 0, reservations = null } = {}) {
    if (!bot) throw new Error('WoodcuttingController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.ledger = ledger;
    this.logger = logger || new Logger({ level: 'warn' });
    this.reserveTarget = reserveTarget;
    this.home = home ? { ...home } : null;
    this.index = Number(index) || 0;
    this.reservations = reservations || null;
    this.stats = { treesChopped: 0, logsCollected: 0, replanted: 0, saplingsCollected: 0, leavesCleared: 0, treesReserved: 0, treesSkipped: 0 };
    this.replanted = [];
    this.stopRequested = false;
    this._searchAttempts = 0;
  }

  updateHome(home) {
    this.home = home ? { ...home } : null;
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

  _claimTree(base) {
    if (!this.reservations) return { ok: true, local: true };
    const lease = this.reservations.claim(treeKey(base), this.bot.name, { ttlMs: 180000 });
    if (!lease.ok) this.stats.treesSkipped++;
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
    return {
      bot: this.bot.name,
      axe: this.bot.bestToolFor('axe'),
      logs: Object.entries(this.bot.inventory).filter(([n]) => LOG_PATTERN.test(n)).reduce((s, [, c]) => s + c, 0),
      saplings: [...SAPLINGS].reduce((s, n) => s + (this.bot.countItem(n) || 0), 0),
      reserveTarget: this.reserveTarget,
      stopped: Boolean(this.stopRequested),
      treesChopped: this.stats.treesChopped,
      replanted: this.replanted.slice(-10),
      zone: this.zone(),
      reservations: this.reservations ? this.reservations.status() : null,
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
      .filter((g) => this._inZone(g.base))
      .map((g) => ({
        base: g.base, type: g.type, count: g.logs.length,
        distance: Math.hypot(g.base.x - this.bot.position.x, g.base.z - this.bot.position.z),
        holder: this.reservations ? (this.reservations.holder(treeKey(g.base)) || {}).owner || null : null
      }))
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
    const zone = this.zone();
    // Never search outside the shared work zone. The old expanding radius kept
    // walking farther from home on every failed attempt and is exactly how a
    // bot got lost. When the allowed ring is exhausted, report it honestly.
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
    const move = await bot.goTo({ x: target.x, y, z: target.z }, {
      range: 3, timeoutMs: 20000, priority: 'operator', owner: `wood-search:${this.bot.name}`
    });
    if (move && move.ok === false) {
      return {
        ok: false, x: target.x, y, z: target.z, zone,
        error: `could not reach a fresh forest inside the work zone: ${move.error || 'path unavailable'}`
      };
    }
    this._searchAttempts++;
    return { ok: true, x: target.x, y, z: target.z, moved: true, zone };
  }

  /**
   * Chop the lowest reachable logs first. The old top-down order asked the bot
   * to path to the crown of a tall tree, which is outside mining reach; the
   * first failure aborted the whole tree and the command honestly reported
   * "no tree was chopped". Bottom-up also lets a partially blocked trunk still
   * yield verified logs instead of losing the entire tree.
   */
  async chopTree(base, { maxHeight = 24 } = {}) {
    if (!this._inZone(base)) return this._zoneError(base);
    const baseBlock = this.bot.getBlock(base);
    if (!baseBlock) return { ok: false, error: `world returned no block at ${base.x},${base.y},${base.z}` };
    const type = baseBlock.name;
    if (!LOG_PATTERN.test(type)) return { ok: false, error: `not a tree at ${base.x},${base.y},${base.z} (${type})` };
    // Equip the axe once per tree, not once per log. A held tool is both faster
    // and the only way a live dig uses the intended speed.
    if (typeof this.bot.equipBestTool === 'function') await this.bot.equipBestTool('axe').catch(() => null);
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
        // Clamp the stance too: a trunk at the zone edge must not make the bot
        // step one block outside the 100x100 area.
        const stance = clampToWorkZone(
          { x: log.x + 1, y: log.y, z: log.z + 1 }, this.home,
          { margin: config.workZone ? config.workZone.margin : 0 }
        );
        const move = await this.bot.goTo(stance, { range: 2, timeoutMs: 12000 });
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
    const startedAt = Date.now();
    const zoneReturn = await this._returnToZone();
    if (!zoneReturn.ok) {
      return {
        ok: false, code: 'OUTSIDE_WORK_ZONE', zone: this.zone(), zoneReturn,
        error: `outside the work zone and could not return: ${zoneReturn.error || 'path unavailable'}`
      };
    }
    const radii = [radius];
    if (radius < 48) radii.push(48);
    let trees = [];
    let searchedRadius = radius;
    for (const scanRadius of radii) {
      trees = this.findTrees({ radius: scanRadius, limit: Math.max(maxTrees * 3, maxTrees), types });
      searchedRadius = scanRadius;
      if (trees.length) break;
    }
    let relocations = [];
    while (!trees.length && relocate && relocations.length < maxRelocations && !this.stopRequested) {
      const moved = await this.relocateForTrees();
      relocations.push(moved);
      if (!moved.ok) break;
      // The fresh site is validated by the same bounded scan; a path that
      // arrived somewhere without logs is reported as such, not as success.
      trees = this.findTrees({ radius: 32, limit: Math.max(maxTrees * 3, maxTrees), types });
      searchedRadius = 32;
    }
    const usable = trees.filter((tree) => !tree.holder || tree.holder === this.bot.name);
    const reservedAtScan = trees.length - usable.length;
    if (!usable.length) {
      return {
        ok: true, idle: true, chopped: 0,
        reason: reservedAtScan > 0
          ? 'all nearby trees are reserved by teammates'
          : relocations.length ? 'no trees at the fresh forest site' : 'no trees inside the work zone',
        searchedRadius, reserved: reservedAtScan, relocations, zone: this.zone(), status: this.status()
      };
    }
    this._searchAttempts = 0;
    const results = [];
    let chopped = 0;
    let reserved = reservedAtScan;
    let lastError = null;
    for (let index = 0; index < maxTrees && !this.stopRequested; index++) {
      let selected = null;
      let lease = null;
      // Claims are atomic and synchronous: if two bots scanned the same trunk,
      // only one gets this lease and the other immediately picks a different
      // tree instead of both walking to it.
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
    if (chopped > 0) {
      const treesDone = results.filter((result) => result.chopped > 0).length;
      this.logger.info(`[${this.bot.name}] chop summary: ${treesDone} tree(s), ${chopped} log(s) in ${elapsedMs}ms${reserved ? `, ${reserved} reserved` : ''}`);
    }
    return {
      ok: chopped > 0, chopped, stopped: this.stopRequested, results,
      searchedRadius, relocations, reserved, elapsedMs, zone: this.zone(),
      error: chopped > 0 ? undefined : (lastError || 'no tree was chopped and verified'),
      status: this.status()
    };
  }
}

module.exports = { WoodcuttingController, SAPLING_FOR, SAPLINGS, LOG_PATTERN, LOG_TYPES, normalizeLogTypes };
