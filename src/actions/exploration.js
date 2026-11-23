'use strict';

const { Logger } = require('../logger');
const { distance } = require('../util/vec');
const { isNight, timeOfDay, findBlocks } = require('./common');

const STRUCTURE_BLOCKS = ['oak_planks', 'cobblestone', 'stone_bricks', 'glass', 'bookshelf', 'crafting_table', 'chest', 'furnace', 'torch'];
const CLUE_BLOCKS = {
  village: ['bell', 'composter', 'hay_block', 'white_bed', 'farmland', 'bookshelf', 'cartography_table', 'fletching_table', 'smithing_table', 'stonecutter', 'loom', 'barrel'],
  mineshaft: ['rail', 'detector_rail', 'powered_rail', 'oak_fence', 'cobweb', 'dark_oak_planks', 'chest'],
  temple: ['chiseled_stone_bricks', 'mossy_cobblestone', 'stone_bricks', 'dispenser'],
  ruin: ['mossy_cobblestone', 'cracked_stone_bricks', 'chiseled_stone_bricks', 'gravel']
};

/**
 * Deterministic spiral exploration. Waypoints are derived from the home point
 * and the bot's roster index, so the team spreads out instead of walking in a
 * single line. Structures, water and lava are reported to shared memory.
 */
class ExplorationController {
  constructor({ bot, memory = null, home = { x: 0, y: 64, z: 0 }, radius = 48, logger = null, teamIndex = 0 } = {}) {
    if (!bot) throw new Error('ExplorationController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.home = home;
    this.radius = radius;
    this.logger = logger || new Logger({ level: 'warn' });
    this.teamIndex = teamIndex;
    this.waypointIndex = teamIndex;
    this.discoveries = [];
    this.stats = { waypoints: 0, distance: 0, discoveries: 0, nightReturns: 0 };
    this.stopRequested = false;
  }

  status() {
    return {
      bot: this.bot.name,
      home: this.home,
      radius: this.radius,
      waypointIndex: this.waypointIndex,
      discoveries: this.discoveries.slice(-10),
      night: isNight(timeOfDay(this.bot)),
      stopped: Boolean(this.stopRequested),
      stats: { ...this.stats }
    };
  }

  /** Square spiral: deterministic and guaranteed to cover the whole area. */
  nextWaypoint() {
    const index = this.waypointIndex++;
    const ring = Math.floor((Math.sqrt(index + 1) + 1) / 2);
    const offset = index - (2 * ring - 1) ** 2;
    const side = Math.floor(offset / Math.max(1, 2 * ring)) % 4;
    const step = offset % Math.max(1, 2 * ring);
    let dx = 0;
    let dz = 0;
    if (side === 0) { dx = -ring + step; dz = -ring; }
    else if (side === 1) { dx = ring; dz = -ring + step; }
    else if (side === 2) { dx = ring - step; dz = ring; }
    else { dx = -ring; dz = ring - step; }
    const spacing = Math.max(6, Math.floor(this.radius / 6));
    return {
      x: this.home.x + dx * spacing,
      y: this.home.y,
      z: this.home.z + dz * spacing,
      index
    };
  }

  scanArea({ radius = 12 } = {}) {
    const found = [];
    const structures = findBlocks(this.bot, STRUCTURE_BLOCKS, { radius, limit: 40 });
    if (structures.length >= 6) {
      const cx = Math.round(structures.reduce((s, b) => s + b.x, 0) / structures.length);
      const cz = Math.round(structures.reduce((s, b) => s + b.z, 0) / structures.length);
      const cy = Math.round(structures.reduce((s, b) => s + b.y, 0) / structures.length);
      found.push({ type: 'STRUCTURE', position: { x: cx, y: cy, z: cz }, count: structures.length, blocks: [...new Set(structures.map((b) => b.name))] });
    }
    for (const water of findBlocks(this.bot, ['water', 'flowing_water'], { radius, limit: 10 })) found.push({ type: 'WATER', position: water });
    for (const lava of findBlocks(this.bot, ['lava', 'flowing_lava'], { radius, limit: 10 })) found.push({ type: 'LAVA', position: lava });
    return found;
  }

  /**
   * Look for block-level evidence of a structure in the loaded area. This is
   * deliberately labelled evidence, not a claim that a complete village or
   * mineshaft exists outside the scanned radius.
   */
  findClue(kind, { radius = 32 } = {}) {
    const target = String(kind || '').toLowerCase();
    const spec = CLUE_BLOCKS[target];
    if (!spec) return { ok: false, error: `unknown structure clue '${kind}'; available: ${Object.keys(CLUE_BLOCKS).join(', ')}` };
    const blocks = findBlocks(this.bot, spec, { radius, limit: 80 });
    if (blocks.length < 3) {
      return { ok: true, found: false, kind: target, evidence: blocks.length, blocks: blocks.slice(0, 10), radius };
    }
    const position = {
      x: Math.round(blocks.reduce((sum, block) => sum + block.x, 0) / blocks.length),
      y: Math.round(blocks.reduce((sum, block) => sum + block.y, 0) / blocks.length),
      z: Math.round(blocks.reduce((sum, block) => sum + block.z, 0) / blocks.length)
    };
    const confidence = Math.min(0.95, Number((0.35 + blocks.length * 0.08).toFixed(2)));
    const discovery = {
      kind: target,
      position,
      evidence: blocks.length,
      blocks: [...new Set(blocks.map((block) => block.name))],
      confidence,
      radius,
      note: 'Block evidence found in the loaded area; the full structure may extend beyond the scan.'
    };
    if (this.memory) {
      this.memory.observe({
        type: target === 'village' ? 'VILLAGE' : 'STRUCTURE',
        resource: target,
        position,
        reportedBy: this.bot.name,
        confidence,
        data: { evidence: discovery.evidence, blocks: discovery.blocks, radius }
      });
    }
    return { ok: true, found: true, ...discovery };
  }

  stop() {
    this.stopRequested = true;
    return { ok: true, bot: this.bot.name, stopped: true };
  }

  async explore({ steps = 4, scanRadius = 12 } = {}) {
    this.stopRequested = false;
    const results = [];
    for (let i = 0; i < steps && !this.stopRequested; i++) {
      const waypoint = this.nextWaypoint();
      const clamped = {
        x: Math.max(this.home.x - this.radius, Math.min(this.home.x + this.radius, waypoint.x)),
        y: waypoint.y,
        z: Math.max(this.home.z - this.radius, Math.min(this.home.z + this.radius, waypoint.z))
      };
      if (distance(this.bot.position, clamped) > this.radius * 1.5) clamped.y = this.home.y;
      const move = await this.bot.goTo(clamped, { range: 3, timeoutMs: 15000 });
      if (move && move.ok === false) { results.push({ waypoint: clamped, ok: false, error: move.error }); continue; }
      const moved = Number(distance(this.bot.position, { x: this.home.x, y: this.home.y, z: this.home.z }).toFixed(1));
      this.stats.waypoints++;
      this.stats.distance = moved;
      const discoveries = this.scanArea({ radius: scanRadius });
      for (const discovery of discoveries) {
        const exists = this.discoveries.some((d) => d.type === discovery.type && distance(d.position, discovery.position) < 6);
        if (exists) continue;
        this.discoveries.push({ ...discovery, at: Date.now() });
        this.stats.discoveries++;
        if (this.memory) {
          this.memory.observe({
            type: discovery.type === 'LAVA' ? 'LAVA' : discovery.type === 'WATER' ? 'WATER' : discovery.type,
            position: discovery.position, reportedBy: this.bot.name, confidence: 0.75,
            data: { source: 'exploration', detail: discovery.blocks || null }
          });
        }
      }
      results.push({ waypoint: clamped, ok: true, discoveries: discoveries.length, position: { ...this.bot.position } });
    }
    return { ok: results.some((r) => r.ok), stopped: this.stopRequested, results, discoveries: this.discoveries.slice(-10), status: this.status() };
  }

  async tick(options = {}) {
    if (isNight(timeOfDay(this.bot))) {
      this.stats.nightReturns++;
      const back = await this.bot.goTo(this.home, { range: 3 });
      return { ok: back.ok !== false, returnedHome: true, night: true };
    }
    return this.explore(options);
  }
}

module.exports = { ExplorationController, STRUCTURE_BLOCKS };
