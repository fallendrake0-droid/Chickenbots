'use strict';

const { boxVolume } = require('../util/vec');

const CLEARABLE = /^(_log|_wood|_leaves|_sapling|_propagule|short_grass|grass|tall_grass|fern|large_fern|dead_bush|sweet_berry_bush|vine|glow_lichen|snow|snow_layer|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|brown_mushroom|red_mushroom|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|pumpkin|melon|sugar_cane|bamboo|kelp|seagrass|torchflower_crop|pitcher_crop)$/;
const VALUABLE = /(_ore|ancient_debris|spawner|chest|barrel|shulker_box|furnace|crafting_table|enchanting_table|beacon|bed|_bed)$/;
const STRUCTURE = /(planks|bricks|stone_bricks|glass|_stairs|_slab|_fence|_door|_trapdoor|_wall|torch|lantern|campfire|bookshelf|cobblestone_wall|deepslate_tiles)$/;
const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const PLANTS = /(_leaves|_sapling|grass|flower|dandelion|poppy|fern|vine|bush|snow|crop|wheat|carrot|potato|beetroot|melon|pumpkin|kelp|seagrass)/;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function blockName(blockAt, pos) {
  const block = blockAt ? blockAt(pos) : null;
  // A missing block read means the chunk is not loaded/unknown. It is never
  // safe to rewrite this as air or to plan work on it.
  return block && block.name ? block.name : 'unloaded';
}

function makeAccessors({ bot = null, blockAt = null, surfaceAt = null, findBlocks = null } = {}) {
  if (bot) {
    return {
      blockAt: blockAt || ((pos) => bot.getBlock(pos)),
      surfaceAt: surfaceAt || ((x, z) => (typeof bot.surfaceAt === 'function' ? bot.surfaceAt(x, z) : Math.floor(bot.position.y) - 1)),
      findBlocks: findBlocks || (typeof bot.world?.findBlocks === 'function' ? (names, near, radius, limit) => bot.world.findBlocks(names, near, radius, limit) : null),
      bot
    };
  }
  return { blockAt, surfaceAt, findBlocks, bot: null };
}

function columnInfo(access, x, z, { liquidDepth = 3, caveDepth = 12 } = {}) {
  const surface = Math.floor(access.surfaceAt(x, z));
  const top = blockName(access.blockAt, { x, y: surface, z });
  let liquid = LIQUIDS.has(top) ? top : null;
  if (!liquid) {
    for (let dy = 1; dy <= liquidDepth; dy++) {
      const name = blockName(access.blockAt, { x, y: surface + dy, z });
      if (LIQUIDS.has(name)) { liquid = name; break; }
    }
  }
  let tree = false;
  let structure = false;
  let vegetation = false;
  for (let dy = 1; dy <= 4; dy++) {
    const name = blockName(access.blockAt, { x, y: surface + dy, z });
    if (/_log$|_wood$|_leaves$/.test(name)) tree = true;
    else if (CLEARABLE.test(name) || PLANTS.test(name)) vegetation = true;
    if (STRUCTURE.test(name)) structure = true;
  }
  if (STRUCTURE.test(top)) structure = true;
  if (CLEARABLE.test(top) || PLANTS.test(top)) vegetation = true;
  let cave = false;
  for (let dy = 3; dy <= caveDepth; dy++) {
    const name = blockName(access.blockAt, { x, y: surface - dy, z });
    if (name === 'air' || name === 'cave_air') {
      const below = blockName(access.blockAt, { x, y: surface - dy - 1, z });
      if (below !== 'air' && below !== 'cave_air' && !LIQUIDS.has(below)) { cave = true; break; }
    }
  }
  return { x, z, surface, top, liquid, tree, structure, vegetation, cave };
}

/**
 * Deterministic terrain survey. Everything is derived from observed blocks;
 * unloaded chunks are never treated as empty and no biome metadata is invented.
 */
class SiteSurveyor {
  constructor({ bot = null, blockAt = null, surfaceAt = null, findBlocks = null, now = () => Date.now() } = {}) {
    this.access = makeAccessors({ bot, blockAt, surfaceAt, findBlocks });
    if (!this.access.blockAt || !this.access.surfaceAt) throw new Error('SiteSurveyor requires blockAt and surfaceAt');
    this.now = now;
  }

  /** Survey a rectangular footprint, bounded by sampleLimit. */
  survey({ origin, width, length, margin = 4, sampleLimit = 2500, caveDepth = 10 } = {}) {
    if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.z)) return { ok: false, error: 'survey requires a finite origin' };
    const w = Math.max(1, Math.floor(width));
    const l = Math.max(1, Math.floor(length));
    const area = w * l;
    const stride = Math.max(1, Math.ceil(Math.sqrt(area / Math.max(1, sampleLimit))));
    const columns = [];
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let sumSq = 0;
    let liquids = 0;
    let trees = 0;
    let vegetation = 0;
    let structures = 0;
    let caves = 0;
    let unknown = 0;
    let water = 0;
    let lava = 0;
    for (let dz = 0; dz < l; dz += stride) {
      for (let dx = 0; dx < w; dx += stride) {
        const info = columnInfo(this.access, origin.x + dx, origin.z + dz, { caveDepth });
        columns.push(info);
        if (info.top === 'unloaded') unknown++;
        min = Math.min(min, info.surface);
        max = Math.max(max, info.surface);
        sum += info.surface;
        sumSq += info.surface * info.surface;
        if (info.liquid) {
          liquids++;
          if (info.liquid.includes('lava')) lava++;
          else water++;
        }
        if (info.tree) trees++;
        if (info.vegetation) vegetation++;
        if (info.structure) structures++;
        if (info.cave) caves++;
      }
    }
    const count = columns.length;
    const average = count ? sum / count : 0;
    const variance = count ? Math.max(0, sumSq / count - average * average) : 0;
    const stddev = Math.sqrt(variance);
    const range = count ? max - min : 0;
    const flatness = clamp(1 - range / 16 - stddev / 10, 0, 1);
    const hazardRatio = count ? liquids / count : 0;
    const structureRatio = count ? structures / count : 0;
    const treeRatio = count ? trees / count : 0;
    const estimatedBlocks = w * l * Math.max(0, range + 2);
    let nearbyOres = [];
    if (this.access.findBlocks) {
      try {
        nearbyOres = this.access.findBlocks(['coal_ore', 'iron_ore', 'copper_ore', 'diamond_ore', 'emerald_ore', 'gold_ore', 'redstone_ore', 'lapis_ore'], origin, 48, 40) || [];
      } catch (_) { nearbyOres = []; }
    }
    return {
      ok: true,
      surveyedAt: this.now(),
      origin: { x: origin.x, y: origin.y, z: origin.z },
      footprint: { width: w, length: l, margin },
      sampleStride: stride,
      samples: count,
      heightMap: columns,
      stats: {
        min, max, average: Number(average.toFixed(2)), range, stddev: Number(stddev.toFixed(2)),
        flatness: Number(flatness.toFixed(3)),
        liquids, water, lava, trees, vegetation, structures, caves, unknown,
        hazardRatio: Number(hazardRatio.toFixed(3)),
        unknownRatio: Number((unknown / Math.max(1, count)).toFixed(3)),
        structureRatio: Number(structureRatio.toFixed(3)),
        treeRatio: Number(treeRatio.toFixed(3)),
        estimatedExcavationBlocks: estimatedBlocks,
        nearbyOres: nearbyOres.length
      },
      hazards: {
        water: water > 0,
        lava: lava > 0,
        caves: caves > 0,
        existingStructure: structureRatio > 0.02,
        trees: trees > 0,
        unloaded: unknown > 0
      },
      ores: nearbyOres.slice(0, 20).map((block) => ({ ...block })),
      bounds: {
        min: { x: origin.x - margin, y: Math.floor(origin.y) - 8, z: origin.z - margin },
        max: { x: origin.x + w - 1 + margin, y: Math.floor(origin.y) + 64, z: origin.z + l - 1 + margin }
      }
    };
  }

  /** Score a survey against real, observed factors. */
  score(survey, { home = null, weights = {} } = {}) {
    if (!survey || !survey.ok) return { ok: false, error: 'no survey to score' };
    const w = { flatness: 30, hazards: 22, space: 16, access: 10, excavation: 12, resources: 10, ...weights };
    const flat = survey.stats.flatness * w.flatness;
    const hazardFree = clamp(1 - survey.stats.hazardRatio * 4 - survey.stats.structureRatio * 2 - (survey.stats.unknownRatio || 0) * 8, 0, 1);
    const hazard = hazardFree * w.hazards;
    const space = clamp(1 - survey.stats.treeRatio * 0.5, 0, 1) * w.space;
    const distanceHome = home ? Math.hypot(survey.origin.x - home.x, survey.origin.z - home.z) : 0;
    const access = clamp(1 - distanceHome / 160, 0, 1) * w.access;
    const excavation = clamp(1 - survey.stats.estimatedExcavationBlocks / Math.max(1, (survey.samples || survey.stats.samples || 1) * 12), 0, 1) * w.excavation;
    const resources = clamp(survey.stats.nearbyOres / 20, 0, 1) * 0.6 * w.resources + clamp(survey.stats.treeRatio * 2, 0, 1) * 0.4 * w.resources;
    const total = flat + hazard + space + access + excavation + resources;
    return {
      ok: true,
      score: Math.round(clamp(total, 0, 100)),
      factors: {
        flatness: Math.round(flat), hazards: Math.round(hazard), space: Math.round(space),
        access: Math.round(access), excavation: Math.round(excavation), resources: Math.round(resources)
      },
      reasons: [
        survey.stats.lava ? 'lava observed' : null,
        survey.stats.water ? 'water observed' : null,
        survey.hazards.existingStructure ? 'existing structure blocks observed' : null,
        survey.stats.range > 8 ? 'uneven terrain' : null
      ].filter(Boolean)
    };
  }

  /** Deterministic ring of candidate origins around home. */
  candidateOrigins(home, { radius = 48, count = 6, spacing = 24 } = {}) {
    const base = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z) };
    const out = [];
    const rings = [spacing, spacing * 2, spacing * 3];
    const angles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5, Math.PI / 4, Math.PI * 3 / 4, Math.PI * 5 / 4, Math.PI * 7 / 4];
    for (const ring of rings) {
      for (const angle of angles) {
        if (out.length >= count) break;
        const x = base.x + Math.round(Math.cos(angle) * Math.min(ring, radius));
        const z = base.z + Math.round(Math.sin(angle) * Math.min(ring, radius));
        if (out.some((entry) => entry.x === x && entry.z === z)) continue;
        out.push({ x, z });
      }
    }
    return out;
  }

  /** Survey and rank several candidate sites. */
  candidates({ home, width, length, radius = 64, count = 6, origin = null } = {}) {
    const origins = origin ? [{ x: origin.x, z: origin.z }] : this.candidateOrigins(home || origin || { x: 0, y: 64, z: 0 }, { radius, count });
    const candidates = origins.map((position, index) => {
      const surfaceY = Math.floor(this.access.surfaceAt(position.x, position.z));
      const survey = this.survey({ origin: { x: position.x, y: surfaceY + 1, z: position.z }, width, length, margin: 4 });
      const score = this.score(survey, { home: home || origin });
      return {
        id: `site-${index + 1}`,
        origin: survey.origin,
        score: score.score,
        factors: score.factors,
        reasons: score.reasons,
        stats: survey.stats,
        survey
      };
    }).sort((a, b) => b.score - a.score);
    return { ok: true, candidates, recommended: candidates[0] || null };
  }
}

function projectBoundaries({ origin, width, length, margin = 6, staging = null } = {}) {
  const x = Math.floor(origin.x);
  const y = Math.floor(origin.y);
  const z = Math.floor(origin.z);
  const w = Math.max(1, Math.floor(width));
  const l = Math.max(1, Math.floor(length));
  const box = (name, minX, minZ, maxX, maxZ, extra = 0) => ({
    name,
    min: { x: minX, y: y - 4 - extra, z: minZ },
    max: { x: maxX, y: y + 96, z: maxZ },
    ground: { x: minX, y, z: minZ },
    volume: boxVolume({ x: minX, y: y - 4, z: minZ }, { x: maxX, y: y + 95, z: maxZ })
  });
  const stagingOrigin = staging || { x: x - margin - 4, z: z - margin - 4 };
  return {
    main: box('main', x, z, x + w - 1, z + l - 1),
    foundation: box('foundation', x - 1, z - 1, x + w, z + l),
    clearance: box('clearance', x - 2, z - 2, x + w + 1, z + l + 1),
    work: box('work', x - margin, z - margin, x + w + margin - 1, z + l + margin - 1),
    staging: {
      name: 'staging',
      min: { x: stagingOrigin.x - 3, y, z: stagingOrigin.z - 3 },
      max: { x: stagingOrigin.x + 3, y: y + 5, z: stagingOrigin.z + 3 },
      anchor: { x: stagingOrigin.x, y, z: stagingOrigin.z }
    },
    storage: {
      name: 'storage',
      min: { x: stagingOrigin.x - 4, y, z: stagingOrigin.z - 4 },
      max: { x: stagingOrigin.x + 4, y: y + 5, z: stagingOrigin.z + 4 },
      anchor: { x: stagingOrigin.x - 1, y, z: stagingOrigin.z }
    },
    security: box('security', x - margin, z - margin, x + w + margin - 1, z + l + margin - 1, 1),
    patrol: box('patrol', x - margin - 2, z - margin - 2, x + w + margin + 1, z + l + margin + 1, 2),
    authorized: box('authorized', x - margin - 4, z - margin - 4, x + w + margin + 3, z + l + margin + 3, 3)
  };
}

function classifySiteBlock(name) {
  if (!name || name === 'air' || name === 'cave_air') return 'air';
  if (LIQUIDS.has(name)) return 'liquid';
  if (VALUABLE.test(name)) return 'valuable';
  if (CLEARABLE.test(name) || PLANTS.test(name)) return 'vegetation';
  if (STRUCTURE.test(name)) return 'structure';
  return 'terrain';
}

function heightMapFor(project, survey) {
  const targetY = Math.floor(project.origin.y) - 1;
  return (survey.heightMap || []).map((column) => ({
    ...column,
    desired: targetY,
    delta: column.surface - targetY,
    action: column.surface > targetY ? 'CUT' : column.surface < targetY ? 'FILL' : 'KEEP'
  }));
}

module.exports = {
  SiteSurveyor, makeAccessors, projectBoundaries, classifySiteBlock, heightMapFor,
  CLEARABLE, VALUABLE, STRUCTURE, LIQUIDS
};
