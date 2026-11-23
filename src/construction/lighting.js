'use strict';

const { distance } = require('../util/vec');

/** Actual block-light emission values used by modern Java Edition. */
const LIGHT_SOURCES = Object.freeze({
  torch: 14,
  wall_torch: 14,
  soul_torch: 10,
  soul_wall_torch: 10,
  lantern: 15,
  soul_lantern: 10,
  glowstone: 15,
  shroomlight: 15,
  sea_lantern: 15,
  jack_o_lantern: 15,
  campfire: 15,
  soul_campfire: 10,
  redstone_lamp: 15,
  end_rod: 14,
  amethyst_cluster: 5,
  candle: 3,
  lava: 15
});

const PREFERRED_SOURCES = ['glowstone', 'sea_lantern', 'shroomlight', 'lantern', 'torch', 'soul_lantern'];

const SPAWN_PROOF_BLOCKS = /(_bottom_slab|_slab$|carpet$|_carpet|button$|pressure_plate$|rail$|_rail$|trapdoor$|glass$|glass_pane$|fence$|wall$|stairs$|chest$|barrel$|furnace$|crafting_table$|bookshelf$|water$|lava$)/;
const OPAQUE = /^(?!air$|cave_air$|water$|flowing_water$|lava$|flowing_lava$|glass$|glass_pane$|_leaves$|torch$|wall_torch$|soul_torch$|lantern$|soul_lantern$|_fence$|_fence_gate$|_slab$|_stairs$|carpet$)/;

/**
 * Spawn rules are deliberately conservative. Vanilla hostile mobs in modern
 * Java require block light 0 on most spawnable surfaces. Specific mobs have
 * separate or additional conditions and are listed rather than flattened into
 * one universal rule.
 */
const HOSTILE_SPAWN_RULES = Object.freeze({
  defaultBlockLightMax: 0,
  exceptions: {
    slime: 'slime chunk + light level <= 7 (varies by version)',
    phantom: 'insomnia / high altitude, not light driven',
    pillager: 'patrol/raid spawning, not light driven',
    witch: 'spawns with hostile groups, hut-specific',
    warden: 'sculk shrieker, not light driven',
    breeze: 'trial spawner, not light driven',
    magma_cube: 'Nether / spawner rules',
    ghast: 'Nether rules',
    hoglin: 'Nether rules',
    zombified_piglin: 'Nether rules',
    drowned: 'water spawn rules',
    guardian: 'ocean monument rules'
  }
});

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function makeBlockAccess({ bot = null, blockAt = null, surfaceAt = null } = {}) {
  if (bot) {
    return {
      blockAt: blockAt || ((pos) => bot.getBlock(pos)),
      surfaceAt: surfaceAt || ((x, z) => (typeof bot.surfaceAt === 'function' ? bot.surfaceAt(x, z) : Math.floor(bot.position.y) - 1)),
      bot
    };
  }
  return { blockAt, surfaceAt, bot: null };
}

function isOpaque(name) {
  if (!name || name === 'air' || name === 'cave_air') return false;
  return OPAQUE.test(name);
}

function isSpawnProof(name) { return Boolean(name && SPAWN_PROOF_BLOCKS.test(name)); }

/** A surface is a solid top with two air blocks above it. */
function isSpawnableSurface(blockAt, x, y, z) {
  const top = blockAt({ x, y, z });
  if (!top || top.name === 'air' || top.name === 'cave_air') return false;
  if (isSpawnProof(top.name)) return false;
  if (top.name === 'water' || top.name === 'lava' || top.name === 'flowing_water' || top.name === 'flowing_lava') return false;
  const feet = blockAt({ x, y: y + 1, z });
  const head = blockAt({ x, y: y + 2, z });
  if (!feet || !['air', 'cave_air'].includes(feet.name)) return false;
  if (!head || !['air', 'cave_air'].includes(head.name)) return false;
  return true;
}

function surfaceLabel(pos) { return `${pos.x},${pos.y},${pos.z}`; }

/** Find observable spawnable surfaces inside a rectangular security boundary. */
function findSpawnableSurfaces({ bot = null, blockAt = null, surfaceAt = null, bounds, maxSurfaces = 600, includeUnderground = false } = {}) {
  const access = makeBlockAccess({ bot, blockAt, surfaceAt });
  if (!access.blockAt || !access.surfaceAt || !bounds) return [];
  const minX = Math.floor(bounds.min.x);
  const maxX = Math.floor(bounds.max.x);
  const minZ = Math.floor(bounds.min.z);
  const maxZ = Math.floor(bounds.max.z);
  const width = maxX - minX + 1;
  const length = maxZ - minZ + 1;
  const area = Math.max(1, width * length);
  const stride = Math.max(1, Math.ceil(Math.sqrt(area / Math.max(1, maxSurfaces))));
  const out = [];
  for (let z = minZ; z <= maxZ; z += stride) {
    for (let x = minX; x <= maxX; x += stride) {
      const surface = Math.floor(access.surfaceAt(x, z));
      if (isSpawnableSurface(access.blockAt, x, surface, z)) out.push({ x, y: surface, z, top: access.blockAt({ x, y: surface, z }).name });
      if (includeUnderground) {
        for (let y = surface - 3; y >= Math.max(-60, surface - 16); y -= 2) {
          if (isSpawnableSurface(access.blockAt, x, y, z)) {
            out.push({ x, y, z, top: access.blockAt({ x, y, z }).name, underground: true });
            break;
          }
        }
      }
      if (out.length >= maxSurfaces) return out;
    }
  }
  return out;
}

/** Conservative coverage check: no opaque block between light and surface. */
function hasLineOfSight(blockAt, light, surface) {
  const steps = Math.max(Math.abs(surface.x - light.x), Math.abs(surface.z - light.z), Math.abs(surface.y - light.y));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const pos = {
      x: Math.round(light.x + (surface.x - light.x) * t),
      y: Math.round(light.y + (surface.y - light.y) * t),
      z: Math.round(light.z + (surface.z - light.z) * t)
    };
    if (pos.x === surface.x && pos.y === surface.y && pos.z === surface.z) break;
    const block = blockAt(pos);
    if (isOpaque(block && block.name)) return false;
  }
  return true;
}

function emissionOf(item) { return LIGHT_SOURCES[item] || 0; }

function lightCoverage(light, surface, { blockAt = null } = {}) {
  const emission = emissionOf(light.item);
  if (!emission) return false;
  // One light level is consumed per step; the surface block itself needs > 0.
  const radius = Math.max(0, emission - 2);
  const dx = Math.abs(surface.x - light.pos.x);
  const dz = Math.abs(surface.z - light.pos.z);
  const dy = Math.abs(surface.y - light.pos.y);
  if (Math.max(dx, dz) > radius || dy > 4) return false;
  if (blockAt && !hasLineOfSight(blockAt, light.pos, surface)) return false;
  return true;
}

/**
 * Greedy light planner. A torch is placed one block above each chosen
 * spawnable surface, so the surface itself is occupied/covered and the placed
 * block is verified by the executor. Sources are selected by real inventory.
 */
function planLighting({ surfaces = [], inventory = {}, reserved = {}, blockAt = null, maxLights = 600, includeInventory = true } = {}) {
  const available = {};
  for (const source of PREFERRED_SOURCES) {
    // Materials already promised to the schematic palette are not available
    // for temporary/pre-build lighting.
    const count = Math.max(0, Number(inventory[source] || 0) - Number(reserved[source] || 0));
    if (count > 0) available[source] = count;
  }
  const candidates = PREFERRED_SOURCES.filter((item) => available[item] > 0)
    .sort((a, b) => available[b] - available[a] || PREFERRED_SOURCES.indexOf(a) - PREFERRED_SOURCES.indexOf(b));
  const source = candidates[0] || 'torch';
  // Never promise more lights than the chosen source can actually supply.
  const limit = includeInventory && available[source] ? Math.min(maxLights, available[source]) : maxLights;
  const placements = [];
  const uncovered = [];
  const placedLights = [];
  for (const surface of surfaces) {
    const covered = placedLights.some((light) => lightCoverage(light, surface, { blockAt }));
    if (covered) continue;
    if (placements.length >= limit) { uncovered.push(surface); continue; }
    const above = blockAt ? blockAt({ x: surface.x, y: surface.y + 1, z: surface.z }) : null;
    if (above && !['air', 'cave_air'].includes(above.name)) { uncovered.push(surface); continue; }
    const light = { pos: { x: surface.x, y: surface.y + 1, z: surface.z }, item: source, emission: emissionOf(source), covers: [] };
    placements.push(light);
    placedLights.push(light);
  }
  // Recompute the exact covered/uncovered split after all placements.
  for (const surface of surfaces) {
    const lit = placedLights.some((light) => lightCoverage(light, surface, { blockAt }));
    if (!lit && !uncovered.some((entry) => surfaceLabel(entry) === surfaceLabel(surface))) uncovered.push(surface);
  }
  const sourceCounts = {};
  for (const placement of placements) sourceCounts[placement.item] = (sourceCounts[placement.item] || 0) + 1;
  return {
    ok: true,
    placements,
    uncovered,
    surfaces: surfaces.length,
    covered: Math.max(0, surfaces.length - uncovered.length),
    coverage: surfaces.length ? Number(((surfaces.length - uncovered.length) / surfaces.length).toFixed(3)) : 1,
    source,
    sourceCounts,
    availableSources: available,
    rules: HOSTILE_SPAWN_RULES,
    note: includeInventory ? 'coverage is conservative and computed from observed surfaces and real light emission values' : 'no inventory supplied; plan uses torch as a nominal source'
  };
}

/**
 * Place real light blocks through selected bots, verifying each world update.
 * If a source is missing, the executor tries the next preferred source instead
 * of pretending a light was placed.
 */
async function executeLighting({ bots = [], plan = null, placements = null, maxPlacements = 400, blockAt = null } = {}) {
  const list = (placements || (plan && plan.placements) || []).slice(0, maxPlacements);
  if (!bots.length) return { ok: false, error: 'no bots available for lighting' };
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const placement = list[i];
    const bot = bots[i % bots.length];
    if (!bot) { results.push({ ok: false, placement, error: 'no bot' }); continue; }
    let item = placement.item;
    if (!bot.countItem(item)) {
      item = PREFERRED_SOURCES.find((candidate) => candidate !== item && bot.countItem(candidate) > 0) || null;
    }
    if (!item) { results.push({ ok: false, placement, error: `no light source available on ${bot.name}` }); continue; }
    const move = await bot.goTo(placement.pos, { range: 4, timeoutMs: 12000 });
    if (move && move.ok === false) { results.push({ ok: false, placement, bot: bot.name, error: move.error }); continue; }
    const placed = await bot.placeBlock(placement.pos, item);
    const block = blockAt ? blockAt(placement.pos) : bot.getBlock(placement.pos);
    const verified = Boolean(placed.ok && block && block.name === item);
    results.push({ ok: verified, placement: { ...placement, item }, bot: bot.name, verified, block: block && block.name, error: verified ? undefined : (placed.error || 'placement not visible') });
  }
  const placed = results.filter((result) => result.ok);
  return {
    ok: results.length > 0 && placed.length === results.length,
    requested: list.length,
    placed: placed.length,
    failed: results.length - placed.length,
    results,
    verification: { complete: placed.length === list.length, placed: placed.length, requested: list.length }
  };
}

/** Audit currently visible lights and dark surfaces. */
function auditLighting({ bot = null, blockAt = null, surfaceAt = null, bounds, lights = [], maxSurfaces = 600, includeUnderground = false } = {}) {
  const access = makeBlockAccess({ bot, blockAt, surfaceAt });
  const surfaces = findSpawnableSurfaces({ blockAt: access.blockAt, surfaceAt: access.surfaceAt, bounds, maxSurfaces, includeUnderground });
  const observedLights = lights.slice();
  const uncovered = [];
  for (const surface of surfaces) {
    const lit = observedLights.some((light) => lightCoverage(light, surface, { blockAt: access.blockAt }));
    if (!lit) uncovered.push(surface);
  }
  return {
    ok: uncovered.length === 0,
    surfaces: surfaces.length,
    covered: surfaces.length - uncovered.length,
    uncovered,
    coverage: surfaces.length ? Number(((surfaces.length - uncovered.length) / surfaces.length).toFixed(3)) : 1,
    lights: observedLights.length,
    rules: HOSTILE_SPAWN_RULES,
    limits: 'This audit checks ordinary light-driven Overworld spawns. Raids, patrols, spawners, water/Nether mobs and special mob rules need separate handling.'
  };
}

module.exports = {
  LIGHT_SOURCES, PREFERRED_SOURCES, HOSTILE_SPAWN_RULES, SPAWN_PROOF_BLOCKS,
  isOpaque, isSpawnProof, isSpawnableSurface, findSpawnableSurfaces, lightCoverage,
  planLighting, executeLighting, auditLighting, emissionOf
};
