'use strict';

const { config } = require('../config');
const { distance } = require('../util/vec');
const { BED_NAMES, FOODS, bestFood } = require('../world/items');

const NIGHT_START = config.survival.sleepStart;
const NIGHT_END = config.survival.sleepEnd;

function isNight(timeOfDay) { return timeOfDay >= NIGHT_START && timeOfDay <= NIGHT_END; }

function timeOfDay(bot) {
  if (!bot) return 0;
  if (bot.time && Number.isFinite(bot.time.timeOfDay)) return bot.time.timeOfDay;
  if (bot.world && Number.isFinite(bot.world.time)) return bot.world.time;
  return 0;
}

const SURFACE_BLOCKS = /(_log|_leaves|_sapling|_propagule|wheat|carrots|potatoes|beetroots|melon|pumpkin|torchflower|pitcher|farmland|chest|barrel|_bed|oak_door|torch)$/;

/**
 * A dashboard status panel must never own the event loop. The live log showed
 * single snapshots blocking for 8-38 s because ten bots each rescanned the
 * world for beds, crops, water and ores inside the same synchronous snapshot.
 * Status scans now share one small time budget per controller, so a broken or
 * enormous world can only delay a tick by a few milliseconds.
 */
const STATUS_SCAN_BUDGET_MS = 8;
const STATUS_TTL_BASE_MS = 15000;
const STATUS_TTL_STEP_MS = 1100;
const STATUS_TTL_SLOTS = 11;

/**
 * Deterministic per-bot offset for status caches. The previous jitter used the
 * first character of the bot name; every roster name starts with `0` or `1`,
 * so all ten caches expired in the same snapshot. Hash the whole name instead.
 */
function statusJitter(name, offset = 0) {
  const text = String(name || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return ((hash + offset) % STATUS_TTL_SLOTS) * STATUS_TTL_STEP_MS;
}

/** TTL for a status cache, staggered across the roster and controller. */
function statusTtl(name, offset = 0, base = STATUS_TTL_BASE_MS) {
  return base + statusJitter(name, offset);
}

/** Find blocks by name through the world when supported, else bounded scan. */
function findBlocks(bot, names, { near = null, radius = 24, limit = 50, yFrom = null, yTo = null, budgetMs = 0 } = {}) {
  // Before the first spawn the live adapter has no world object yet; scanning
  // would call bot.blockAt() and crash the status snapshot.
  if (!bot || bot.ready === false || !bot.position) return [];
  // A missing/non-finite centre or an unbounded radius used to turn this scan
  // into a multi-billion-iteration synchronous loop.
  const origin = near || bot.position;
  if (!origin || ![origin.x, origin.y, origin.z].every((value) => Number.isFinite(Number(value)))) return [];
  near = { x: Number(origin.x), y: Number(origin.y), z: Number(origin.z) };
  radius = Math.max(0, Math.min(128, Math.floor(Number(radius) || 24)));
  limit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 50)));
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  // An empty wanted list would make every block match the surface test below
  // and scan the whole cube for nothing.
  if (!wanted.size) return [];
  const out = [];
  const world = bot.world;
  // Surface decoration never lives far from the surface; constraining the
  // vertical window keeps repeated scans of large volumes affordable.
  if (yFrom === null && yTo === null && [...wanted].every((name) => SURFACE_BLOCKS.test(name))) {
    yFrom = Math.max(-64, Math.floor(near.y) - 12);
    yTo = Math.min(200, Math.floor(near.y) + 12);
  }
  const minY = yFrom !== null ? yFrom : Math.max(-64, Math.floor(near.y) - radius);
  const maxY = yTo !== null ? yTo : Math.min(200, Math.floor(near.y) + radius);
  const withinY = (y) => y >= minY && y <= maxY;

  // Mineflayer's indexed search lives on the world view. It skips sections
  // whose palette cannot contain a target, which is dramatically cheaper than
  // constructing one block object per position. Status scans pass a budget and
  // deliberately use the bounded fallback instead: it can be interrupted.
  if (!budgetMs && world && typeof world.findBlocks === 'function') {
    const found = world.findBlocks([...wanted], near, radius, Math.max(limit, 1), yFrom, yTo);
    if (Array.isArray(found)) {
      return found
        .filter((block) => block && wanted.has(block.name) && withinY(block.y))
        .slice(0, limit);
    }
  }

  const startedAt = budgetMs > 0 ? Date.now() : 0;
  const expired = budgetMs > 0 ? () => Date.now() - startedAt >= budgetMs : () => false;
  const nameAt = world && typeof world.blockNameAt === 'function'
    ? (x, y, z) => world.blockNameAt(x, y, z)
    : null;
  // Walk y outward from the bot instead of bottom-up. A time-bounded status
  // scan must spend its budget on the blocks the panel actually describes;
  // bottom-up filled the limit with buried layers far below the player.
  const yStart = Math.max(minY, Math.min(maxY, Math.floor(near.y)));
  const ys = [];
  for (let d = 0; yStart - d >= minY || yStart + d <= maxY; d++) {
    if (yStart - d >= minY) ys.push(yStart - d);
    if (d > 0 && yStart + d <= maxY) ys.push(yStart + d);
  }
  let visited = 0;
  for (const y of ys) {
    for (let z = Math.floor(near.z) - radius; z <= Math.floor(near.z) + radius; z++) {
      for (let x = Math.floor(near.x) - radius; x <= Math.floor(near.x) + radius; x++) {
        // Check the deadline in batches. Date.now() is not free and the inner
        // body is only a map lookup on a live adapter.
        if (budgetMs > 0 && (++visited & 31) === 0 && expired()) return out;
        const name = nameAt ? nameAt(x, y, z) : null;
        if (name !== null) {
          if (name && wanted.has(name)) {
            out.push({ x, y, z, name });
            if (out.length >= limit) return out;
          }
          continue;
        }
        const block = bot.getBlock({ x, y, z });
        if (block && wanted.has(block.name)) {
          out.push({ x, y, z, name: block.name });
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

function nearestBlock(bot, names, options = {}) {
  const found = findBlocks(bot, names, { ...options, limit: 200 });
  let best = null;
  let bestDistance = Infinity;
  for (const block of found) {
    const d = distance(bot.position, block);
    if (d < bestDistance) { best = block; bestDistance = d; }
  }
  return best;
}

function foodItems(bot) {
  const items = [];
  for (const [name, count] of Object.entries(bot.inventory || {})) {
    if (count > 0 && FOODS[name]) items.push({ name, count, ...FOODS[name] });
  }
  return items.sort((a, b) => (b.saturation + b.hunger) - (a.saturation + a.hunger));
}

function needsFood(bot, thresholds = config.survival) {
  if (bot.food <= thresholds.lowFood) return 'critical';
  if (bot.food <= thresholds.eatAtFood) return 'hungry';
  if (bot.health <= thresholds.eatAtHealth && bot.food < 20) return 'healing';
  return null;
}

function hasFood(bot) { return foodItems(bot).length > 0; }

function teamNames(team) {
  return new Set((team && team.names) || config.team.names);
}

function isTeammate(entity, team) {
  if (!entity) return false;
  if (entity.type && teamNames(team).has(entity.type)) return true;
  if (entity.name && teamNames(team).has(entity.name)) return true;
  if (entity.username && teamNames(team).has(entity.username)) return true;
  return false;
}

function isHostile(entity) {
  if (!entity) return false;
  if (entity.hostile === true) return true;
  if (entity.kind && /hostile/i.test(entity.kind)) return true;
  return false;
}

function describeFood(bot) {
  const items = foodItems(bot);
  return { items: items.slice(0, 8), best: bestFood(bot.inventory) };
}

/** Step away from a point along the dominant axis; deterministic and safe. */
async function moveAway(bot, from, blocks = 8, { vertical = false, priority = 'recovery', owner = 'retreat', timeoutMs = 8000 } = {}) {
  const dx = bot.position.x - from.x;
  const dz = bot.position.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  const target = {
    x: Math.round(bot.position.x + (dx / length) * blocks),
    y: Math.round(bot.position.y + (vertical ? blocks : 0)),
    z: Math.round(bot.position.z + (dz / length) * blocks)
  };
  return bot.goTo(target, { range: 2, priority, owner, timeoutMs });
}

function isBed(name) { return BED_NAMES.has(name); }

module.exports = {
  NIGHT_START, NIGHT_END, isNight, timeOfDay, findBlocks, nearestBlock,
  foodItems, needsFood, hasFood, teamNames, isTeammate, isHostile, describeFood,
  moveAway, isBed, statusJitter, statusTtl, STATUS_SCAN_BUDGET_MS
};
