'use strict';

const { Logger } = require('../logger');
const { WoodcuttingController } = require('../actions/woodcutting');
const {
  classifySiteBlock, CLEARABLE, VALUABLE, LIQUIDS
} = require('./siteSurvey');

const PLANTABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']);
const FILL_PREFERENCE = ['cobblestone', 'dirt', 'stone', 'deepslate', 'andesite', 'gravel'];

function inBounds(pos, bounds, padding = 0) {
  if (!bounds) return true;
  return pos.x >= bounds.min.x - padding && pos.x <= bounds.max.x + padding &&
    pos.y >= bounds.min.y - padding && pos.y <= bounds.max.y + padding &&
    pos.z >= bounds.min.z - padding && pos.z <= bounds.max.z + padding;
}

function botStandingOn(bot, pos) {
  if (!bot || !bot.position || !pos) return false;
  const p = bot.position;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  return Math.floor(p.x) === pos.x && Math.floor(p.z) === pos.z && Math.floor(p.y) - 1 === pos.y;
}

function isUnknownBlock(block) {
  return !block || !block.name || ['unloaded', 'unknown', 'not_loaded'].includes(String(block.name).toLowerCase());
}

/** Yield between bounded batches so the dashboard/event loop stays responsive. */
function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function availableFill(bot, preferred = null) {
  if (preferred && bot.countItem(preferred) > 0) return preferred;
  return FILL_PREFERENCE.find((item) => bot.countItem(item) > 0) || null;
}

/**
 * Site preparation. Every action uses the real adapter primitives; blocks are
 * re-read after placement/removal, valuable blocks are preserved, and the
 * executor refuses to dig the block a bot is standing on.
 */
class SitePreparer {
  constructor({ bots = [], world = null, ledger = null, memory = null, logger = null, preserveOres = true } = {}) {
    this.bots = bots;
    this.world = world;
    this.ledger = ledger;
    this.memory = memory;
    this.logger = logger || new Logger({ level: 'warn' });
    this.preserveOres = preserveOres;
    this.stats = { cleared: 0, excavated: 0, levelled: 0, filled: 0, replanted: 0, hazards: 0, preserved: 0, failed: 0, drained: 0 };
    this.hazards = [];
    this.lastResults = [];
  }

  updateLedger() {
    if (!this.ledger) return;
    for (const bot of this.bots) this.ledger.updateBotInventory(bot.name, bot.inventory);
  }

  _botFor(index) { return this.bots[index % Math.max(1, this.bots.length)]; }

  /**
   * Pick a bot that is not standing on the column being worked. A bot may not
   * dig the block under its own feet; skipping that column forever left the
   * levelling phase permanently ACTIVE with zero actions.
   */
  async _workerFor(pos, index = 0) {
    if (!this.bots.length) return null;
    for (let i = 0; i < this.bots.length; i++) {
      const candidate = this._botFor(index + i);
      if (candidate && !botStandingOn(candidate, pos)) return candidate;
    }
    const bot = this._botFor(index);
    if (!bot) return null;
    // Single-bot team: step off the column, verify the move, then work it.
    const stance = { x: pos.x + 2, y: pos.y + 1, z: pos.z };
    try {
      const moved = await bot.goTo(stance, { range: 1, timeoutMs: 6000 });
      if (moved && moved.ok !== false && !botStandingOn(bot, pos)) return bot;
    } catch (_) { /* report as unreachable below */ }
    return null;
  }

  _blockAt(pos) {
    if (this.world && typeof this.world.getBlock === 'function') return this.world.getBlock(pos);
    return this.bots[0] ? this.bots[0].getBlock(pos) : null;
  }

  _surfaceAt(x, z) {
    if (this.world && typeof this.world.surfaceY === 'function') return this.world.surfaceY(x, z);
    return this.bots[0] ? this.bots[0].surfaceAt(x, z) : 63;
  }

  classify(pos) {
    const block = this._blockAt(pos);
    return block ? classifySiteBlock(block.name) : 'unknown';
  }

  /** Preview how much clearing is required. No blocks are changed. */
  previewClearance(bounds) {
    const counts = {};
    const positions = [];
    let unknown = 0;
    for (let z = bounds.min.z; z <= bounds.max.z; z++) {
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        const surface = Math.floor(this._surfaceAt(x, z));
        for (let y = surface + 1; y <= surface + 12; y++) {
          const pos = { x, y, z };
          const kind = this.classify(pos);
          if (kind === 'air' || kind === 'valuable' || kind === 'structure' || kind === 'liquid') continue;
          if (kind === 'terrain') continue;
          const block = this._blockAt(pos);
          if (isUnknownBlock(block)) { unknown++; continue; }
          const key = `${kind}:${block.name}`;
          counts[key] = (counts[key] || 0) + 1;
          if (positions.length < 120) positions.push({ ...pos, kind, block: block.name });
        }
      }
    }
    return {
      bounds, counts, positions, unknown,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0)
    };
  }

  /** Clear trees, vegetation and loose terrain above the foundation level. */
  async clearArea({ bounds, level = null, maxActions = 400, targetY = null } = {}) {
    if (!this.bots.length) return { ok: false, error: 'no bots for clearance' };
    const yLimit = targetY !== null ? targetY : (level !== null ? level : bounds.max.y);
    const results = [];
    let actions = 0;
    let scanned = 0;
    let unknown = 0;
    // Trees first, through the real woodcutting controller (top-down + replant).
    const wood = new WoodcuttingController({ bot: this.bots[0], memory: this.memory, ledger: this.ledger, logger: this.logger });
    let trees = [];
    try { trees = wood.findTrees({ radius: 48, limit: 16 }); } catch (_) { trees = []; }
    for (const tree of trees) {
      if (actions >= maxActions) break;
      if (!inBounds(tree.base, bounds)) continue;
      const chopped = await wood.chopTree(tree.base);
      results.push({ action: 'tree', ...chopped });
      if (chopped.ok) {
        actions += 1 + (chopped.chopped || 0);
        this.stats.cleared += 1 + (chopped.leaves || 0);
        if (chopped.replanted) this.stats.replanted++;
      }
    }
    // Vegetation / snow / loose blocks.
    for (let z = bounds.min.z; z <= bounds.max.z && actions < maxActions; z++) {
      for (let x = bounds.min.x; x <= bounds.max.x && actions < maxActions; x++) {
        const surface = Math.floor(this._surfaceAt(x, z));
        const top = Math.min(bounds.max.y, surface + 12);
        for (let y = top; y >= surface + 1 && actions < maxActions; y--) {
          if ((scanned++ & 31) === 0) await yieldToLoop();
          if (y > yLimit + 6 && !CLEARABLE.test((this._blockAt({ x, y, z }) || {}).name || '')) continue;
          const pos = { x, y, z };
          const block = this._blockAt(pos);
          if (isUnknownBlock(block)) { unknown++; continue; }
          if (block.name === 'air' || block.name === 'cave_air') continue;
          const kind = classifySiteBlock(block.name);
          if (kind === 'valuable' || kind === 'structure' || kind === 'liquid') {
            if (kind === 'valuable') this.stats.preserved++;
            continue;
          }
          const bot = await this._workerFor(pos, actions);
          if (!bot) { results.push({ ok: false, action: 'clear', pos, error: 'no bot can leave the column being cleared' }); this.stats.failed++; continue; }
          const move = await bot.goTo(pos, { range: 4, timeoutMs: 12000 });
          if (move && move.ok === false) { results.push({ ok: false, action: 'clear', pos, bot: bot.name, error: move.error }); this.stats.failed++; continue; }
          const dig = await bot.digBlock(pos);
          actions++;
          if (dig.ok) {
            this.stats.cleared++;
            const after = this._blockAt(pos);
            if (after && after.name !== 'air') { results.push({ ok: false, action: 'clear', pos, error: 'block still present' }); this.stats.failed++; }
            else results.push({ ok: true, action: 'clear', pos, bot: bot.name, block: block.name, drops: dig.drops });
          } else {
            results.push({ ok: false, action: 'clear', pos, bot: bot.name, error: dig.error });
            this.stats.failed++;
          }
        }
      }
    }
    this.updateLedger();
    this.lastResults = results;
    return {
      ok: unknown === 0 && results.every((result) => result.ok !== false),
      actions,
      unknown,
      trees: results.filter((result) => result.action === 'tree').length,
      cleared: this.stats.cleared,
      recovered: this._recovered(),
      results,
      remaining: actions >= maxActions ? 'action limit reached; continue clearance' : 'bounded sweep complete'
    };
  }

  _recovered() {
    const counts = {};
    for (const bot of this.bots) for (const [item, count] of Object.entries(bot.inventory)) counts[item] = (counts[item] || 0) + count;
    const interesting = {};
    for (const [item, count] of Object.entries(counts)) {
      if (/_log$|_sapling$|_leaves$|cobblestone|dirt|sand|gravel|clay|snow|_ore$/.test(item)) interesting[item] = count;
    }
    return interesting;
  }

  /** Remove blocks in a box above the target floor, preserving ores and valuables. */
  async excavateBox({ minX, maxX, minZ, maxZ, topY, bottomY, maxActions = 1200, allowOres = false } = {}) {
    const results = [];
    let actions = 0;
    let hazards = 0;
    let unknown = 0;
    let scanned = 0;
    for (let y = Math.floor(topY); y >= Math.floor(bottomY) && actions < maxActions; y--) {
      for (let z = minZ; z <= maxZ && actions < maxActions; z++) {
        for (let x = minX; x <= maxX && actions < maxActions; x++) {
          if ((scanned++ & 31) === 0) await yieldToLoop();
          const pos = { x, y, z };
          const block = this._blockAt(pos);
          if (isUnknownBlock(block)) { unknown++; continue; }
          if (block.name === 'air' || block.name === 'cave_air') continue;
          if (LIQUIDS.has(block.name)) { hazards++; this.hazards.push({ pos, block: block.name, kind: 'liquid' }); continue; }
          if (VALUABLE.test(block.name) && (this.preserveOres || !allowOres)) { this.stats.preserved++; continue; }
          const bot = await this._workerFor(pos, actions);
          if (!bot) { results.push({ ok: false, action: 'excavate', pos, error: 'no bot can leave the column being excavated' }); this.stats.failed++; continue; }
          const move = await bot.goTo(pos, { range: 4, timeoutMs: 12000 });
          if (move && move.ok === false) { results.push({ ok: false, action: 'excavate', pos, error: move.error }); this.stats.failed++; continue; }
          const dig = await bot.digBlock(pos);
          actions++;
          if (dig.ok) {
            this.stats.excavated++;
            const after = this._blockAt(pos);
            const ok = after && ['air', 'cave_air'].includes(after.name);
            results.push({ ok, action: 'excavate', pos, bot: bot.name, block: block.name, drops: dig.drops, error: ok ? undefined : 'block still present' });
          } else {
            results.push({ ok: false, action: 'excavate', pos, bot: bot.name, error: dig.error });
            this.stats.failed++;
          }
        }
      }
    }
    this.stats.hazards += hazards;
    this.updateLedger();
    return {
      ok: unknown === 0 && hazards === 0 && results.every((result) => result.ok !== false),
      actions,
      hazards,
      unknown,
      hazardSamples: this.hazards.slice(-20),
      preserved: this.stats.preserved,
      results,
      remaining: actions >= maxActions ? 'action limit reached' : 'excavation box processed'
    };
  }

  /** Cut/fill every surveyed column to one level. */
  async levelFootprint({ minX, maxX, minZ, maxZ, targetY, maxActions = 900, fillItem = null } = {}) {
    const results = [];
    const y = Math.floor(targetY);
    let actions = 0;
    let cut = 0;
    let filled = 0;
    let unknown = 0;
    let scanned = 0;
    let stoppedReason = null;
    let consecutiveFailures = 0;
    columns:
    for (let z = minZ; z <= maxZ && actions < maxActions; z++) {
      for (let x = minX; x <= maxX && actions < maxActions; x++) {
        if ((scanned++ & 15) === 0) await yieldToLoop();
        // Find the highest observed solid block within a bounded vertical window.
        // Unknown reads are never treated as either air or solid.
        let top = null;
        let columnUnknown = false;
        for (let probe = y + 3; probe >= y - 5; probe--) {
          const block = this._blockAt({ x, y: probe, z });
          if (isUnknownBlock(block)) { columnUnknown = true; break; }
          if (!['air', 'cave_air', 'water', 'lava', 'flowing_water', 'flowing_lava'].includes(block.name)) { top = probe; break; }
        }
        if (columnUnknown) { unknown++; continue; }
        if (top === null) top = y - 1;
        if (top > y) {
          for (let dy = top; dy > y && actions < maxActions; dy--) {
            const pos = { x, y: dy, z };
            const block = this._blockAt(pos);
            if (isUnknownBlock(block)) { unknown++; break; }
            if (block.name === 'air') continue;
            if (VALUABLE.test(block.name) || LIQUIDS.has(block.name)) {
              this.stats.preserved++;
              this.hazards.push({ pos, block: block.name, kind: 'levelling' });
              continue;
            }
            const bot = await this._workerFor(pos, actions);
            if (!bot) {
              results.push({ ok: false, action: 'cut', pos, error: 'no bot can leave the column being cut' });
              this.stats.failed++;
              if (++consecutiveFailures >= 8) { stoppedReason = 'too many columns could not be reached or vacated'; break columns; }
              continue;
            }
            const move = await bot.goTo(pos, { range: 4, timeoutMs: 12000 });
            if (move && move.ok === false) {
              results.push({ ok: false, action: 'cut', pos, bot: bot.name, error: move.error });
              this.stats.failed++;
              if (++consecutiveFailures >= 8) { stoppedReason = 'too many columns could not be reached'; break columns; }
              continue;
            }
            const dig = await bot.digBlock(pos);
            actions++;
            if (dig.ok) {
              cut++;
              this.stats.levelled++;
              consecutiveFailures = 0;
              const after = this._blockAt(pos);
              const removed = after && after.name === 'air';
              results.push({ ok: removed, action: 'cut', pos, bot: bot.name, block: block.name, error: removed ? undefined : 'cut block still present' });
              if (!removed) this.stats.failed++;
            } else {
              results.push({ ok: false, action: 'cut', pos, bot: bot.name, error: dig.error });
              this.stats.failed++;
              if (++consecutiveFailures >= 8) { stoppedReason = 'repeated dig failures'; break columns; }
            }
          }
        } else if (top < y) {
          for (let dy = top + 1; dy <= y && actions < maxActions; dy++) {
            const pos = { x, y: dy, z };
            const bot = await this._workerFor(pos, actions);
            if (!bot) {
              results.push({ ok: false, action: 'fill', pos, error: 'no bot can reach the fill column' });
              this.stats.failed++;
              stoppedReason = 'no bot can reach the fill column';
              break columns;
            }
            const item = availableFill(bot, fillItem);
            if (!item) {
              // Fill material is a team-wide condition. Reporting one failure per
              // column made a large footprint look like hundreds of defects.
              results.push({ ok: false, action: 'fill', pos, error: 'no fill material' });
              this.stats.failed++;
              stoppedReason = 'no fill material';
              break columns;
            }
            const move = await bot.goTo(pos, { range: 5, timeoutMs: 12000 });
            if (move && move.ok === false) {
              results.push({ ok: false, action: 'fill', pos, bot: bot.name, error: move.error });
              this.stats.failed++;
              if (++consecutiveFailures >= 8) { stoppedReason = 'too many fill columns could not be reached'; break columns; }
              continue;
            }
            const placed = await bot.placeBlock(pos, item);
            actions++;
            if (placed.ok) {
              const after = this._blockAt(pos);
              const ok = after && after.name === item;
              if (ok) { filled++; this.stats.filled++; this.stats.levelled++; consecutiveFailures = 0; }
              else this.stats.failed++;
              results.push({ ok, action: 'fill', pos, bot: bot.name, item, error: ok ? undefined : 'fill not visible' });
            } else {
              results.push({ ok: false, action: 'fill', pos, bot: bot.name, error: placed.error });
              this.stats.failed++;
              if (++consecutiveFailures >= 8) { stoppedReason = 'repeated placement failures'; break columns; }
            }
          }
        }
      }
    }
    if (actions >= maxActions) stoppedReason = stoppedReason || 'action limit reached';
    this.updateLedger();
    return {
      ok: !stoppedReason && unknown === 0 && results.every((result) => result.ok !== false),
      actions, cut, filled, unknown, targetY: y, stoppedReason,
      results: results.slice(-80),
      remaining: actions >= maxActions ? 'action limit reached' : stoppedReason || 'footprint levelled'
    };
  }

  /** Drain standing liquids inside the foundation where a solid block can displace them. */
  async drainFootprint({ minX, maxX, minZ, maxZ, topY, bottomY, maxActions = 200 } = {}) {
    const results = [];
    let actions = 0;
    let unknown = 0;
    let scanned = 0;
    let stoppedReason = null;
    const startDrained = this.stats.drained;
    rows:
    for (let y = topY; y >= bottomY && actions < maxActions; y--) {
      for (let z = minZ; z <= maxZ && actions < maxActions; z++) {
        for (let x = minX; x <= maxX && actions < maxActions; x++) {
          if ((scanned++ & 15) === 0) await yieldToLoop();
          const pos = { x, y, z };
          const block = this._blockAt(pos);
          if (isUnknownBlock(block)) { unknown++; continue; }
          if (!LIQUIDS.has(block.name)) continue;
          if (block.name.includes('lava')) {
            results.push({ ok: false, action: 'drain', pos, error: 'lava requires a controlled cooling/containment plan' });
            this.hazards.push({ pos, block: block.name, kind: 'lava' });
            continue;
          }
          const bot = await this._workerFor(pos, actions);
          if (!bot) { results.push({ ok: false, action: 'drain', pos, error: 'no bot can reach the liquid' }); this.stats.failed++; stoppedReason = 'no bot can reach the liquid'; break rows; }
          const item = availableFill(bot, 'cobblestone');
          if (!item) {
            // No displacement material is a team-wide condition; stop after one
            // honest report instead of scanning the whole footprint per column.
            results.push({ ok: false, action: 'drain', pos, error: 'no displacement material' });
            this.stats.failed++;
            stoppedReason = 'no displacement material';
            break rows;
          }
          const move = await bot.goTo(pos, { range: 5, timeoutMs: 12000 });
          if (move && move.ok === false) {
            results.push({ ok: false, action: 'drain', pos, bot: bot.name, error: move.error });
            this.stats.failed++;
            continue;
          }
          const placed = await bot.placeBlock(pos, item);
          actions++;
          const after = this._blockAt(pos);
          const ok = placed.ok && after && !isUnknownBlock(after) && !LIQUIDS.has(after.name);
          if (ok) this.stats.drained++;
          else this.stats.failed++;
          results.push({ ok, action: 'drain', pos, bot: bot.name, item, block: block.name, after: after?.name, error: ok ? undefined : (placed.error || 'liquid still present') });
        }
      }
    }
    if (actions >= maxActions) stoppedReason = stoppedReason || 'action limit reached';
    this.updateLedger();
    return {
      ok: !stoppedReason && unknown === 0 && results.every((result) => result.ok !== false),
      actions, drained: this.stats.drained - startDrained, unknown, stoppedReason,
      results, hazards: this.hazards.slice(-20)
    };
  }

  /** Build a physical fence perimeter with a gate opening; verifies every post. */
  async buildPerimeter({ origin, width, length, margin = 6, bots = this.bots, maxPosts = 220, fenceItem = 'oak_fence', reserved = {} } = {}) {
    const results = [];
    if (!bots.length) return { ok: false, error: 'no bots for perimeter' };
    const minX = origin.x - margin;
    const maxX = origin.x + width + margin - 1;
    const minZ = origin.z - margin;
    const maxZ = origin.z + length + margin - 1;
    const posts = [];
    for (let x = minX; x <= maxX; x++) { posts.push({ x, z: minZ }); posts.push({ x, z: maxZ }); }
    for (let z = minZ + 1; z < maxZ; z++) { posts.push({ x: minX, z }); posts.push({ x: maxX, z }); }
    const gate = { x: origin.x + Math.floor(width / 2), z: minZ, width: 2 };
    const filtered = posts.filter((post) => !(post.z === gate.z && post.x >= gate.x && post.x < gate.x + gate.width));
    let placed = 0;
    let index = 0;
    for (const post of filtered) {
      if (placed >= maxPosts) break;
      const surface = Math.floor(this._surfaceAt(post.x, post.z));
      const pos = { x: post.x, y: surface + 1, z: post.z };
      const existing = this._blockAt(pos);
      if (existing && ['torch', 'wall_torch', 'lantern', 'soul_lantern'].includes(existing.name)) {
        results.push({ ok: true, action: 'perimeter', pos, skipped: 'dedicated light already occupies this post' });
        continue;
      }
      if (existing && !['air', 'cave_air', 'short_grass', 'grass', 'tall_grass', 'snow'].includes(existing.name)) { results.push({ ok: false, action: 'perimeter', pos, error: `occupied by ${existing.name}` }); continue; }
      const bot = bots[index++ % bots.length];
      const spareFence = bot.countItem(fenceItem) - Number(reserved[fenceItem] || 0);
      if (spareFence <= 0) {
        // Perimeter material must come from surplus, never from the reserved
        // schematic palette.
        const sparePlanks = bot.countItem('oak_planks') - Number(reserved.oak_planks || 0);
        const spareSticks = bot.countItem('stick') - Number(reserved.stick || 0);
        if (sparePlanks < 4 || spareSticks < 2) {
          results.push({ ok: false, action: 'perimeter', pos, error: `no surplus ${fenceItem} or planks/sticks beyond the reserved BOM` });
          break;
        }
        const crafted = await bot.craft(fenceItem, 1).catch((err) => ({ ok: false, error: err.message }));
        if (!crafted.ok) { results.push({ ok: false, action: 'perimeter', pos, error: `cannot craft ${fenceItem}: ${crafted.error}` }); break; }
      }
      const move = await bot.goTo(pos, { range: 5, timeoutMs: 12000 });
      if (move && move.ok === false) { results.push({ ok: false, action: 'perimeter', pos, error: move.error }); continue; }
      const block = await bot.placeBlock(pos, fenceItem);
      const after = this._blockAt(pos);
      const ok = block.ok && after && after.name === fenceItem;
      if (ok) placed++;
      results.push({ ok, action: 'perimeter', pos, bot: bot.name, item: fenceItem, error: ok ? undefined : (block.error || 'post not visible') });
    }
    this.updateLedger();
    const skipped = results.filter((result) => result.skipped).length;
    return {
      // Posts already occupied by a dedicated light are satisfied posts, not a
      // reason to fail an otherwise complete perimeter.
      ok: (placed + skipped) > 0 && results.filter((result) => result.ok === false).length === 0,
      placed, requested: filtered.length, gate, fenceItem, skipped, results
    };
  }

  state() {
    return { stats: { ...this.stats }, hazards: this.hazards.slice(-50) };
  }
}

module.exports = { SitePreparer, FILL_PREFERENCE, PLANTABLE, inBounds, botStandingOn };
