'use strict';

/**
 * Bounded, real-data world snapshot for the 3D viewer.
 *
 * The viewer does not need every voxel in render distance; it needs the
 * exposed surface, its block types and the entities standing on it. Scanning
 * one column per (x,z) and stopping at the first solid/fluid block keeps a
 * 41x41 view cheap enough to serve while five bots are working. The result is
 * a heightfield plus a small entity list, never invented terrain.
 */
const CACHE_MS = 1500;
const MAX_RADIUS = 32;
const MIN_RADIUS = 4;
const MAX_HEIGHT = 64;
const MAX_ENTITIES = 80;

const cache = new WeakMap();

const COLORS = {
  air: 0x9ecbff,
  cave_air: 0x9ecbff,
  water: 0x2f6fd0,
  flowing_water: 0x2f6fd0,
  lava: 0xd9480f,
  flowing_lava: 0xd9480f,
  grass_block: 0x5f9e3f,
  grass: 0x5f9e3f,
  dirt: 0x7a5638,
  coarse_dirt: 0x715033,
  podzol: 0x6b4b2b,
  mycelium: 0x826b7e,
  farmland: 0x5c4028,
  sand: 0xdccf9b,
  red_sand: 0xc46b35,
  sandstone: 0xd6c58f,
  gravel: 0x8a8582,
  clay: 0x9ba6b8,
  stone: 0x7d7d7d,
  cobblestone: 0x6b6b6b,
  mossy_cobblestone: 0x5e7355,
  deepslate: 0x4c4c50,
  cobbled_deepslate: 0x54545a,
  andesite: 0x8b8b8b,
  diorite: 0xb5b5b0,
  granite: 0x9a6b57,
  tuff: 0x6c6d63,
  calcite: 0xd8d8cf,
  bedrock: 0x333333,
  obsidian: 0x241a33,
  snow: 0xf2f7fb,
  snow_block: 0xf2f7fb,
  ice: 0xa9d7f5,
  packed_ice: 0x9cc9ec,
  blue_ice: 0x8bb8ee,
  oak_log: 0x6b4d2b,
  birch_log: 0xd7d2c3,
  spruce_log: 0x4b3521,
  jungle_log: 0x5b452b,
  acacia_log: 0x6b4a2c,
  dark_oak_log: 0x3f2d1c,
  cherry_log: 0x8a5a63,
  mangrove_log: 0x5b3a2b,
  pale_oak_log: 0x8f8b7d,
  oak_leaves: 0x3f7a31,
  birch_leaves: 0x5c8c42,
  spruce_leaves: 0x2f5c35,
  jungle_leaves: 0x2f7a28,
  acacia_leaves: 0x4f7d2c,
  dark_oak_leaves: 0x2c5425,
  cherry_leaves: 0xe8a7c0,
  mangrove_leaves: 0x3b6a33,
  azalea_leaves: 0x4b7a3a,
  flowering_azalea_leaves: 0x7a6a8f,
  short_grass: 0x5d9e3f,
  tall_grass: 0x5d9e3f,
  fern: 0x4c8a3b,
  dandelion: 0xd8c51f,
  poppy: 0xc43636,
  coal_ore: 0x4d4d4d,
  iron_ore: 0x9b8067,
  copper_ore: 0x9a6b4d,
  gold_ore: 0xb59a3e,
  redstone_ore: 0x8a3030,
  lapis_ore: 0x2f4f9a,
  diamond_ore: 0x3fb5b0,
  emerald_ore: 0x2f9a5a,
  nether_gold_ore: 0x9a5a35,
  ancient_debris: 0x5a4238,
  coal_block: 0x2b2b2b,
  iron_block: 0xb9b9b9,
  gold_block: 0xe0c341,
  diamond_block: 0x4fd8d0,
  emerald_block: 0x38c46e,
  lapis_block: 0x2a48a0,
  redstone_block: 0xa32a2a,
  quartz_block: 0xe8e4da,
  netherrack: 0x6e2b2b,
  soul_sand: 0x4f3c31,
  soul_soil: 0x4a3730,
  basalt: 0x4a4a50,
  blackstone: 0x2f2a2f,
  end_stone: 0xd9d8a8,
  purpur_block: 0xa77aa7,
  prismarine: 0x4f9a8f,
  sea_lantern: 0xb8e3dc,
  glowstone: 0xd9b85e,
  torch: 0xf0c34a,
  wall_torch: 0xf0c34a,
  lantern: 0xe0b45a,
  chest: 0xa5762f,
  crafting_table: 0x9a6e3a,
  furnace: 0x6a6a6a,
  white_wool: 0xe9e9e9,
  black_wool: 0x2a2a2a,
  red_wool: 0xa32a2a,
  blue_wool: 0x2a3aa3,
  oak_planks: 0xb08a54,
  birch_planks: 0xd2c08d,
  spruce_planks: 0x7a5a35,
  stone_bricks: 0x787878,
  bricks: 0x9a5245,
  glass: 0xbfe0ea,
  white_bed: 0xd8d8d8
};

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function colorFor(name) {
  const key = String(name || '').replace(/^minecraft:/, '');
  if (COLORS[key] !== undefined) return COLORS[key];
  // Stable fallback so a new block type never renders as black.
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return hslToHex(hue, 35, 45);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  // eslint-disable-next-line no-undef
  const to = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0');
  return Number(`0x${to(0)}${to(8)}${to(4)}`);
}

function nameOf(block) {
  return block && block.name ? String(block.name).replace(/^minecraft:/, '') : null;
}

function isVisible(name) {
  return Boolean(name) && name !== 'air' && name !== 'cave_air' && name !== 'void_air';
}

function isFluid(name) {
  return /water|lava/.test(String(name || ''));
}

function botColor(name) {
  let hash = 0;
  for (let i = 0; i < String(name).length; i++) hash = (Math.imul(hash, 31) + String(name).charCodeAt(i)) | 0;
  const palette = [0x4fc3f7, 0xffb74d, 0x81c784, 0xe57373, 0xba68c8, 0x4dd0e1, 0xffd54f, 0xaed581];
  return palette[Math.abs(hash) % palette.length];
}

function resolveBot(services, requested) {
  const bots = services.bots instanceof Map ? [...services.bots.values()] : [];
  if (!bots.length) return null;
  if (requested) {
    const named = bots.find((bot) => bot.name === requested);
    if (named) return named;
  }
  const online = bots.filter((bot) => bot && bot.ready !== false && bot.connected !== false && bot.spawned !== false);
  return online[0] || bots[0] || null;
}

function resolveCenter(services, query, bot) {
  const x = Number(query.x);
  const y = Number(query.y);
  const z = Number(query.z);
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    && Math.abs(x) <= 32_000_000 && Math.abs(z) <= 32_000_000 && y >= -2048 && y <= 2048) {
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), source: 'explicit' };
  }
  if (bot && bot.position) {
    return {
      x: Math.floor(bot.position.x),
      y: Math.floor(bot.position.y),
      z: Math.floor(bot.position.z),
      source: bot.name
    };
  }
  return null;
}

function readBlock(bot, x, y, z) {
  try {
    const block = typeof bot.getBlock === 'function' ? bot.getBlock({ x, y, z }) : null;
    return block || null;
  } catch (_) {
    return null;
  }
}

function surfaceAt(bot, x, z, topY, bottomY) {
  let highest = null;
  for (let y = topY; y >= bottomY; y--) {
    const block = readBlock(bot, x, y, z);
    const name = nameOf(block);
    if (!isVisible(name)) continue;
    highest = { y, name, solid: !isFluid(name), fluid: isFluid(name) };
    break;
  }
  return highest;
}

/**
 * Build the snapshot. `query` is untrusted HTTP input; every number is clamped
 * and the bot must belong to the configured roster.
 */
function worldSnapshot(services, query = {}) {
  const started = Date.now();
  const bot = resolveBot(services, query.bot ? String(query.bot) : null);
  if (!bot) {
    return { ok: false, code: 'NO_BOT', error: 'no bot is available for the world view', generatedAt: new Date().toISOString() };
  }
  const center = resolveCenter(services, query, bot);
  if (!center) {
    return { ok: false, code: 'NO_POSITION', error: `${bot.name} has no known position yet`, bot: bot.name, generatedAt: new Date().toISOString() };
  }
  const radius = clampInt(query.radius, MIN_RADIUS, MAX_RADIUS, 20);
  const height = clampInt(query.height, 8, MAX_HEIGHT, 32);
  const key = `${bot.name}:${center.x}:${center.y}:${center.z}:${radius}:${height}`;
  let entry = cache.get(services);
  if (!entry) {
    entry = new Map();
    cache.set(services, entry);
  }
  const cached = entry.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return { ...cached.value, cached: true, ms: Date.now() - started };
  if (entry.size > 24) entry.clear();

  const topY = Math.min(318, center.y + Math.ceil(height / 2));
  const bottomY = Math.max(-63, topY - height);
  const columns = [];
  const chunks = new Map();
  const palette = new Map();
  let minHeight = Infinity;
  for (let x = center.x - radius; x <= center.x + radius; x++) {
    for (let z = center.z - radius; z <= center.z + radius; z++) {
      const surface = surfaceAt(bot, x, z, topY, bottomY);
      if (!surface) continue;
      const color = colorFor(surface.name);
      columns.push([x - center.x, z - center.z, surface.y, color, paletteKey(palette, surface.name)]);
      if (surface.y < minHeight) minHeight = surface.y;
      const chunkKey = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
      chunks.set(chunkKey, (chunks.get(chunkKey) || 0) + 1);
    }
  }
  const baseY = Number.isFinite(minHeight) ? Math.max(bottomY, minHeight - 4) : Math.max(bottomY, center.y - 8);

  const entities = [];
  if (typeof bot.entitiesNear === 'function') {
    for (const entity of bot.entitiesNear(radius + 10)) {
      if (!entity || !entity.position) continue;
      // Teammates have their own richer entry in `bots`; do not draw them twice.
      if (services.bots instanceof Map && (services.bots.has(entity.username) || services.bots.has(entity.name))) continue;
      const { x: ex, y: ey, z: ez } = entity.position;
      if (![ex, ey, ez].every(Number.isFinite)) continue;
      const dx = ex - center.x;
      const dy = ey;
      const dz = ez - center.z;
      if (Math.abs(dx) > radius + 10 || Math.abs(dz) > radius + 10) continue;
      entities.push({
        id: entity.id,
        name: entity.name || entity.username || entity.type || 'entity',
        type: entity.type || null,
        username: entity.username || null,
        hostile: Boolean(entity.hostile),
        health: entity.health ?? null,
        position: [Number(dx.toFixed(2)), Number(dy.toFixed(2)), Number(dz.toFixed(2))]
      });
      if (entities.length >= MAX_ENTITIES) break;
    }
  }

  const bots = [];
  if (services.bots instanceof Map) {
    for (const other of services.bots.values()) {
      if (!other || !other.position) continue;
      const { x: ox, y: oy, z: oz } = other.position;
      if (![ox, oy, oz].every(Number.isFinite)) continue;
      const dx = ox - center.x;
      const dy = oy;
      const dz = oz - center.z;
      if (Math.abs(dx) > radius + 16 || Math.abs(dz) > radius + 16) continue;
      const assignment = services.coordinator && typeof services.coordinator.getAssignment === 'function'
        ? services.coordinator.getAssignment(other.name)
        : null;
      bots.push({
        name: other.name,
        position: [Number(dx.toFixed(2)), Number(dy.toFixed(2)), Number(dz.toFixed(2))],
        health: other.health,
        food: other.food,
        online: other.ready === true && other.connected !== false && other.spawned !== false && Number(other.health) > 0,
        color: botColor(other.name),
        selected: other.name === bot.name,
        task: assignment ? { id: assignment.taskId, type: assignment.type, label: assignment.label } : null
      });
    }
  }

  const value = {
    ok: true,
    source: services.mode || (services.runtime && services.runtime.simulate ? 'simulation' : 'live'),
    generatedAt: new Date().toISOString(),
    bot: bot.name,
    dimension: bot.dimension || 'overworld',
    center,
    radius,
    height,
    bounds: {
      minY: baseY,
      maxY: topY,
      minX: center.x - radius,
      maxX: center.x + radius,
      minZ: center.z - radius,
      maxZ: center.z + radius
    },
    baseY,
    columns,
    palette: [...palette.values()],
    chunks: [...chunks.entries()].map(([key, count]) => {
      const [cx, cz] = key.split(',').map(Number);
      return { x: cx, z: cz, columns: count };
    }),
    bots,
    entities,
    time: typeof bot.time === 'object' ? bot.time : { timeOfDay: 0, day: 1 },
    counts: {
      columns: columns.length,
      chunks: chunks.size,
      bots: bots.length,
      entities: entities.length,
      triangles: columns.length * 2
    }
  };
  entry.set(key, { at: Date.now(), value });
  return { ...value, cached: false, ms: Date.now() - started };
}

function paletteKey(palette, name) {
  if (!palette.has(name)) palette.set(name, { name, color: colorFor(name), index: palette.size });
  return palette.get(name).index;
}

module.exports = { worldSnapshot, colorFor, dashboardConstants: { MIN_RADIUS, MAX_RADIUS, MAX_HEIGHT } };
