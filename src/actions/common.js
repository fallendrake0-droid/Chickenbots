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

const SURFACE_BLOCKS = /(_log|_leaves|_sapling|_propagule|wheat|carrots|potatoes|beetroots|melon|pumpkin|farmland|chest|barrel|_bed|oak_door|torch)$/;

/** Find blocks by name through the world when supported, else bounded scan. */
function findBlocks(bot, names, { near = bot.position, radius = 24, limit = 50, yFrom = null, yTo = null } = {}) {
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  const out = [];
  const world = bot.world;
  // Surface decoration never lives far from the surface; constraining the
  // vertical window keeps repeated scans of large volumes affordable.
  if (yFrom === null && yTo === null && [...wanted].every((name) => SURFACE_BLOCKS.test(name))) {
    yFrom = Math.max(-64, Math.floor(near.y) - 12);
    yTo = Math.min(200, Math.floor(near.y) + 12);
  }
  if (world && typeof world.blockNameAt === 'function' && yFrom !== null && yTo !== null) {
    for (let y = yFrom; y <= yTo; y++) {
      for (let z = Math.floor(near.z) - radius; z <= Math.floor(near.z) + radius; z++) {
        for (let x = Math.floor(near.x) - radius; x <= Math.floor(near.x) + radius; x++) {
          const name = world.blockNameAt(x, y, z);
          if (name && wanted.has(name)) {
            out.push({ x, y, z, name });
            if (out.length >= limit) return out;
          }
        }
      }
    }
    return out;
  }
  if (world && typeof world.findBlocks === 'function' && yFrom === null && yTo === null) {
    const found = world.findBlocks([...wanted], near, radius, limit);
    return found.slice(0, limit);
  }
  const minY = yFrom !== null ? yFrom : Math.max(-64, Math.floor(near.y) - radius);
  const maxY = yTo !== null ? yTo : Math.min(200, Math.floor(near.y) + radius);
  for (let y = minY; y <= maxY; y++) {
    for (let z = Math.floor(near.z) - radius; z <= Math.floor(near.z) + radius; z++) {
      for (let x = Math.floor(near.x) - radius; x <= Math.floor(near.x) + radius; x++) {
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
async function moveAway(bot, from, blocks = 8, { vertical = false } = {}) {
  const dx = bot.position.x - from.x;
  const dz = bot.position.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  const target = {
    x: Math.round(bot.position.x + (dx / length) * blocks),
    y: Math.round(bot.position.y + (vertical ? blocks : 0)),
    z: Math.round(bot.position.z + (dz / length) * blocks)
  };
  return bot.goTo(target, { range: 2 });
}

function isBed(name) { return BED_NAMES.has(name); }

module.exports = {
  NIGHT_START, NIGHT_END, isNight, timeOfDay, findBlocks, nearestBlock,
  foodItems, needsFood, hasFood, teamNames, isTeammate, isHostile, describeFood,
  moveAway, isBed
};
