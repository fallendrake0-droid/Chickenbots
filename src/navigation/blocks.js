'use strict';

/**
 * Navigation block classifier.
 *
 * Every navigation decision (feet/head clearance, support, drops, liquids,
 * hazards, ladders) goes through this module. `unloaded` and a missing block
 * are unknown, never air: treating an unread chunk as empty is how a bot walks
 * into a wall it has not seen yet. Where a real Mineflayer block carries
 * `shapes`/`boundingBox`, those are authoritative; the name tables are the
 * deterministic fallback used by MockWorld and by block records that only
 * expose a name.
 */

const UNKNOWN_BLOCK = 'unloaded';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const WATER = new Set(['water', 'flowing_water', 'bubble_column']);
const LAVA = new Set(['lava', 'flowing_lava']);
const FLUIDS = new Set([...WATER, ...LAVA]);

// Blocks that damage or trap an entity standing in them.
const HAZARDS = new Set([
  'lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'cactus',
  'sweet_berry_bush', 'powder_snow', 'campfire', 'soul_campfire',
  'wither_rose', 'pointed_dripstone', 'end_portal', 'nether_portal',
  'sculk_shrieker', 'trial_spawner', 'vault'
]);

// Blocks that are safe to stand in but still slow or obstruct movement.
const PASSABLE = new Set([
  'short_grass', 'grass', 'fern', 'large_fern', 'tall_grass', 'dead_bush',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony',
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch',
  'redstone_wall_torch', 'lantern', 'soul_lantern', 'rail', 'powered_rail',
  'detector_rail', 'activator_rail', 'redstone_wire', 'tripwire', 'lever',
  'stone_pressure_plate', 'oak_pressure_plate', 'spruce_pressure_plate',
  'birch_pressure_plate', 'jungle_pressure_plate', 'acacia_pressure_plate',
  'dark_oak_pressure_plate', 'mangrove_pressure_plate', 'cherry_pressure_plate',
  'pale_oak_pressure_plate', 'crimson_pressure_plate', 'warped_pressure_plate',
  'polished_blackstone_pressure_plate', 'light_weighted_pressure_plate',
  'heavy_weighted_pressure_plate', 'tripwire_hook', 'string', 'flower_pot',
  'lily_pad', 'nether_sprouts', 'warped_roots', 'crimson_roots', 'glow_lichen',
  'moss_carpet', 'pink_petals', 'spore_blossom', 'hanging_roots',
  'small_dripleaf', 'big_dripleaf_stem', 'cave_vines', 'cave_vines_plant',
  'weeping_vines', 'weeping_vines_plant', 'twisting_vines',
  'twisting_vines_plant', 'sugar_cane', 'bamboo', 'kelp', 'kelp_plant',
  'seagrass', 'tall_seagrass', 'wheat', 'carrots', 'potatoes', 'beetroots',
  'pumpkin_stem', 'melon_stem', 'attached_pumpkin_stem', 'attached_melon_stem',
  'torchflower_crop', 'pitcher_crop', 'oak_sapling', 'birch_sapling',
  'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling',
  'cherry_sapling', 'pale_oak_sapling', 'mangrove_propagule', 'brown_mushroom',
  'red_mushroom', 'crimson_fungus', 'warped_fungus', 'nether_wart',
  'cocoa', 'vine', 'sculk_vein', 'frosted_ice', 'snow'
]);

// A door is passable only when its *actual* open state says so. A wooden door
// that is closed is an obstacle for the deterministic planner even when the
// live pathfinder is allowed to open it: pretending a closed door is air is how
// the simulator walks through walls that the live server still blocks. Iron
// doors are never openable by hand. Trapdoors and fence gates use the same
// state rule; an open trapdoor is empty, a closed one is a low partial block.
const DOOR = /_door$/;
const TRAPDOOR = /_trapdoor$/;
const FENCE_GATE = /_fence_gate$/;

const CLIMBABLE = new Set(['ladder', 'vine', 'scaffolding', 'twisting_vines', 'weeping_vines', 'cave_vines', 'cave_vines_plant']);

// Partial collision blocks. The integer navigation grid treats these as solid
// support/obstacles; `collisionHeight` preserves the information for a live
// entity that can stand on a slab top.
const PARTIAL_NAMES = [
  /_slab$/, /_stairs$/, /_fence$/, /_fence_gate$/, /_wall$/, /_carpet$/,
  /^snow_layer$/, /_trapdoor$/, /_pane$/, /^cactus$/, /^chest$/, /^end_rod$/,
  /^lily_pad$/, /^lectern$/, /^cauldron$/, /^composter$/, /^anvil$/,
  /^grindstone$/, /^stonecutter$/, /^enchanting_table$/, /^brewing_stand$/,
  /^hopper$/, /^daylight_detector$/, /^sculk_sensor$/, /^calibrated_sculk_sensor$/,
  /^dirt_path$/, /^farmland$/, /^soul_sand$/, /^mud$/, /^honey_block$/
];

function nameOf(block) {
  if (!block) return UNKNOWN_BLOCK;
  if (typeof block === 'string') return block;
  return String(block.name || UNKNOWN_BLOCK).toLowerCase();
}

function isUnknownName(name) {
  return !name || name === UNKNOWN_BLOCK || name === 'unknown' || name === 'not_loaded';
}

function truthy(value) {
  return value === true || value === 1 || value === 'true' || value === '1' || value === 'yes';
}

/**
 * Read block state without assuming a particular Mineflayer version. Prismarine
 * exposes `getProperties()`; older objects expose `properties`/`_properties`,
 * and mock worlds attach a plain object. A state that cannot be read is
 * explicitly unknown, never silently treated as open.
 */
function blockState(block) {
  if (!block || typeof block !== 'object') return { known: false, open: null, half: null, powered: null };
  let raw = null;
  if (typeof block.getProperties === 'function') {
    try { raw = block.getProperties(); } catch (_) { raw = null; }
  }
  if (!raw) raw = block.properties || block._properties || block.state || null;
  if (!raw || typeof raw !== 'object') return { known: false, open: null, half: null, powered: null };
  const out = { known: true, open: null, half: null, powered: null, raw };
  if (Object.prototype.hasOwnProperty.call(raw, 'open')) out.open = truthy(raw.open);
  if (raw.half !== undefined) out.half = String(raw.half);
  if (raw.powered !== undefined) out.powered = truthy(raw.powered);
  return out;
}

/** Collision height declared by a shape array, regardless of the name table. */
function declaredCollisionHeight(block) {
  if (!block || typeof block !== 'object') return null;
  const shapes = Array.isArray(block.shapes) ? block.shapes : null;
  if (shapes && shapes.length) {
    let max = 0;
    for (const shape of shapes) {
      if (Array.isArray(shape) && shape.length >= 6) {
        // Shapes are local box corners [x1,y1,z1,x2,y2,z2]; the highest
        // occupied Y is the collision top. Some versions emit absolute Y too.
        const top = Math.max(Number(shape[4]) || 0, Number(shape[1]) || 0);
        max = Math.max(max, Math.min(2, top));
      }
    }
    return Math.max(0, max);
  }
  if (block.boundingBox === 'empty') return 0;
  if (block.boundingBox === 'block') return 1;
  return null;
}

function isAirName(name) { return AIR.has(String(name)); }
function isWaterName(name) { return WATER.has(String(name)); }
function isLavaName(name) { return LAVA.has(String(name)); }
function isFluidName(name) { return FLUIDS.has(String(name)); }
function isHazardName(name) { return HAZARDS.has(String(name)); }
function isClimbableName(name) { return CLIMBABLE.has(String(name)); }
function isPartialName(name) { return PARTIAL_NAMES.some((re) => re.test(String(name))); }

/** Maximum Y of a block's collision shapes, or null when shapes are absent. */
function shapeHeight(block) { return declaredCollisionHeight(block); }

/**
 * @returns {{
 *   name:string, known:boolean, kind:string, solid:boolean, passable:boolean,
 *   liquid:boolean, water:boolean, lava:boolean, hazard:boolean,
 *   climbable:boolean, support:boolean, collisionHeight:number, replaceable:boolean
 * }}
 */
function classifyBlock(block, options = {}) {
  const name = nameOf(block);
  if (isUnknownName(name)) {
    return {
      name: UNKNOWN_BLOCK, known: false, kind: 'unknown', solid: true, passable: false,
      liquid: false, water: false, lava: false, hazard: true, climbable: false,
      support: false, collisionHeight: 1, replaceable: false
    };
  }
  const water = WATER.has(name);
  const lava = LAVA.has(name);
  const liquid = water || lava;
  const hazard = HAZARDS.has(name);
  const climbable = CLIMBABLE.has(name);
  const air = AIR.has(name);
  const passableName = PASSABLE.has(name) || /_button$/.test(name) || /_sign$/.test(name);
  const height = declaredCollisionHeight(block);
  const state = blockState(block);
  const partial = isPartialName(name);
  const door = DOOR.test(name);
  const trapdoor = TRAPDOOR.test(name);
  const gate = FENCE_GATE.test(name);
  // `null` means the state was not exposed; a closed or unknown door is an
  // obstacle. An empty collision shape is positive evidence that it is open.
  const open = state.open === null ? (door || trapdoor || gate ? height === 0 : null) : state.open;
  const openable = door && !/^iron_/.test(name)
    && (options.canOpenDoors === true || options.openDoors === true);
  let collisionHeight;
  if (door) collisionHeight = open === true ? 0 : 1;
  else if (trapdoor) collisionHeight = open === true ? 0 : (height !== null ? height : 0.1875);
  else if (gate) collisionHeight = open === true ? 0 : (height !== null ? height : 1);
  else if (liquid || air || passableName) collisionHeight = 0;
  else if (height !== null) collisionHeight = height;
  else if (partial) {
    if (/_slab$/.test(name)) collisionHeight = 0.5;
    else if (/^snow_layer$/.test(name)) collisionHeight = 0.125;
    else if (/_carpet$/.test(name)) collisionHeight = 0.0625;
    else if (/^dirt_path$|^farmland$/.test(name)) collisionHeight = 0.9375;
    else if (/^soul_sand$|^mud$|^honey_block$/.test(name)) collisionHeight = 0.9;
    else collisionHeight = 1;
  } else collisionHeight = 1;
  const passable = collisionHeight < 0.5;
  const solid = collisionHeight >= 0.5;
  const kind = hazard ? 'hazard' : lava ? 'lava' : water ? 'water' : air ? 'air'
    : door ? (open === true ? 'door-open' : openable ? 'door-closed-openable' : 'door-closed')
      : trapdoor ? (open === true ? 'trapdoor-open' : 'trapdoor-closed')
        : gate ? (open === true ? 'gate-open' : 'gate-closed')
          : climbable ? 'climbable' : passable ? 'passable' : partial ? 'partial' : 'solid';
  return {
    name,
    known: true,
    kind,
    solid,
    passable,
    liquid,
    water,
    lava,
    hazard,
    climbable,
    // A door is not support while open; a closed door is a wall. A closed
    // trapdoor is a low partial surface, not a full standable floor cell.
    // A closed trapdoor is only 3/16 high, so it is passable as a body cell
    // but its top still supports a player standing above it.
    support: (solid && !hazard) || (trapdoor && open !== true && !hazard),
    collisionHeight,
    replaceable: air || liquid || passableName,
    open: open === null ? null : Boolean(open),
    stateKnown: state.known,
    openable,
    door,
    trapdoor,
    gate,
    // Narrow passages and doorways are valid but cost more than open ground.
    doorLike: door || gate || trapdoor
  };
}

/** Read and classify one block through a reader's getBlock/blockAt method. */
function readBlock(reader, pos) {
  if (!reader || !pos) return null;
  try {
    const fn = typeof reader.getBlock === 'function' ? reader.getBlock.bind(reader)
      : typeof reader.blockAt === 'function' ? reader.blockAt.bind(reader) : null;
    if (!fn) return null;
    return fn({ x: Math.floor(Number(pos.x)), y: Math.floor(Number(pos.y)), z: Math.floor(Number(pos.z)) });
  } catch (_) {
    return null;
  }
}

function classifyAt(reader, pos, options = {}) { return classifyBlock(readBlock(reader, pos), options); }

module.exports = {
  UNKNOWN_BLOCK, AIR, WATER, LAVA, FLUIDS, HAZARDS, PASSABLE, CLIMBABLE,
  nameOf, isUnknownName, isAirName, isWaterName, isLavaName, isFluidName,
  isHazardName, isClimbableName, isPartialName, shapeHeight,
  blockState, declaredCollisionHeight,
  classifyBlock, readBlock, classifyAt
};
