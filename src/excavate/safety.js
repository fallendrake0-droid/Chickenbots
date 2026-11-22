'use strict';

/** Protected-block and hazard policy for excavation.
 *
 * Default posture: natural terrain only. Player-placed or valuable blocks are
 * preserved, ores are preserved until mined deliberately, and liquids are never
 * opened blindly.
 */

const AIR = new Set(['air', 'cave_air', 'void_air']);

const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);

const BEDROCK = new Set(['bedrock', 'barrier', 'light', 'structure_void', 'command_block', 'chain_command_block', 'repeating_command_block', 'jigsaw', 'end_portal', 'end_portal_frame', 'end_gateway', 'nether_portal']);

const CONTAINERS = new Set(['chest', 'trapped_chest', 'ender_chest', 'barrel', 'shulker_box', 'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box', 'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box', 'gray_shulker_box', 'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box', 'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box', 'hopper', 'dispenser', 'dropper', 'furnace', 'blast_furnace', 'smoker', 'brewing_stand', 'decorated_pot', 'crafter']);

const FUNCTIONAL = new Set(['enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'beacon', 'conduit', 'spawner', 'trial_spawner', 'vault', 'jukebox', 'note_block', 'bell', 'lodestone', 'respawn_anchor', 'lectern', 'composter', 'cauldron', 'water_cauldron', 'lava_cauldron', 'powder_snow_cauldron', 'cartography_table', 'fletching_table', 'smithing_table', 'grindstone', 'loom', 'stonecutter', 'campfire', 'soul_campfire', 'end_chest']);

const REDSTONE = new Set(['piston', 'sticky_piston', 'observer', 'repeater', 'comparator', 'redstone_wire', 'redstone_torch', 'redstone_wall_torch', 'redstone_lamp', 'lever', 'tripwire_hook', 'tripwire', 'daylight_detector', 'target', 'sculk_sensor', 'calibrated_sculk_sensor', 'note_block', 'powered_rail', 'detector_rail', 'activator_rail', 'rail', 'sculk_shrieker']);

const MANUFACTURED = new Set(['cobblestone', 'mossy_cobblestone', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks', 'bricks', 'deepslate_bricks', 'deepslate_tiles', 'polished_deepslate', 'glass', 'glass_pane', 'tinted_glass', 'white_stained_glass', 'gray_stained_glass', 'black_stained_glass', 'iron_bars', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks', 'crimson_planks', 'warped_planks', 'bamboo_planks', 'oak_stairs', 'stone_stairs', 'oak_slab', 'stone_slab', 'oak_fence', 'oak_fence_gate', 'torch', 'wall_torch', 'lantern', 'soul_lantern', 'scaffolding', 'ladder', 'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool', 'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool', 'terracotta', 'white_terracotta', 'smooth_stone', 'smooth_sandstone', 'cut_sandstone', 'chiseled_sandstone', 'quartz_block', 'smooth_quartz', 'quartz_bricks', 'quartz_pillar', 'chiseled_quartz_block', 'prismarine', 'prismarine_bricks', 'dark_prismarine', 'sea_lantern', 'nether_bricks', 'red_nether_bricks', 'blackstone', 'polished_blackstone', 'polished_blackstone_bricks', 'gilded_blackstone', 'mud_bricks', 'packed_mud', 'copper_block', 'exposed_copper', 'weathered_copper', 'oxidized_copper', 'cut_copper', 'iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'lapis_block', 'redstone_block', 'coal_block', 'concrete', 'white_concrete', 'gray_concrete', 'black_concrete', 'stone_brick_wall', 'cobblestone_wall', 'oak_door', 'oak_trapdoor', 'bookshelf', 'chiseled_bookshelf', 'barrel' ]);

const BEDS_AND_FARMS = new Set(['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots', 'pumpkin_stem', 'melon_stem', 'attached_pumpkin_stem', 'attached_melon_stem', 'sugar_cane', 'cocoa', 'sweet_berry_bush', 'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed', 'torchflower_crop', 'pitcher_crop']);

const ORE_BLOCKS = new Set(['coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris']);

const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'concrete_powder', 'white_concrete_powder', 'orange_concrete_powder', 'magenta_concrete_powder', 'light_blue_concrete_powder', 'yellow_concrete_powder', 'lime_concrete_powder', 'pink_concrete_powder', 'gray_concrete_powder', 'light_gray_concrete_powder', 'cyan_concrete_powder', 'purple_concrete_powder', 'blue_concrete_powder', 'brown_concrete_powder', 'green_concrete_powder', 'red_concrete_powder', 'black_concrete_powder', 'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'pointed_dripstone']);

const VEGETATION = new Set(['short_grass', 'grass', 'fern', 'large_fern', 'tall_grass', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony', 'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling', 'mangrove_propagule', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'pale_oak_leaves', 'azalea_leaves', 'flowering_azalea_leaves', 'brown_mushroom', 'red_mushroom', 'dead_bush', 'sugar_cane', 'vine', 'glow_lichen', 'moss_carpet', 'pink_petals', 'spore_blossom', 'cactus', 'bamboo', 'snow']);

const NATURAL = new Set(['stone', 'deepslate', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'clay', 'sand', 'red_sand', 'gravel', 'sandstone', 'red_sandstone', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'dripstone_block', 'basalt', 'smooth_basalt', 'blackstone', 'magma_block', 'obsidian', 'netherrack', 'soul_sand', 'soul_soil', 'snow_block', 'ice', 'packed_ice', 'blue_ice', 'moss_block', 'sculk', 'sculk_vein', 'amethyst_block', 'budding_amethyst', 'terracotta', 'orange_terracotta', 'yellow_terracotta', 'brown_terracotta', 'red_terracotta', 'white_terracotta', 'light_gray_terracotta', 'light_blue_terracotta', 'blue_terracotta', 'cyan_terracotta', 'purple_terracotta', 'magenta_terracotta', 'pink_terracotta', 'lime_terracotta', 'green_terracotta', 'gray_terracotta', 'black_terracotta', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore', 'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore', 'water', 'lava', 'flowing_water', 'flowing_lava', 'bedrock', 'powder_snow', 'muddy_mangrove_roots', 'mangrove_roots', 'glowstone', 'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris', 'spawner']);

function isAir(name) { return !name || AIR.has(name); }
function isLiquid(name) { return LIQUIDS.has(name); }
function isOre(name) { return ORE_BLOCKS.has(name); }
function isBedrock(name) { return BEDROCK.has(name); }

/**
 * Classify one block for excavation.
 * @returns {{kind:string, excavatable:boolean, requiresAuth:boolean, preserve:boolean, reason:string}}
 */
function classifyBlock(name, { preserveOres = true, protectedDefault = true, authorized = false } = {}) {
  if (isAir(name)) return { kind: 'AIR', excavatable: false, requiresAuth: false, preserve: true, reason: 'air' };
  if (BEDROCK.has(name)) return { kind: 'BEDROCK', excavatable: false, requiresAuth: false, preserve: true, reason: 'unbreakable or reserved block' };
  if (LIQUIDS.has(name)) return { kind: 'LIQUID', excavatable: false, requiresAuth: false, preserve: true, reason: 'liquid must be handled deliberately' };
  if (CONTAINERS.has(name)) return { kind: 'PROTECTED', excavatable: false, requiresAuth: true, preserve: true, reason: 'container contents must be preserved' };
  if (FUNCTIONAL.has(name)) return { kind: 'PROTECTED', excavatable: false, requiresAuth: true, preserve: true, reason: 'functional block' };
  if (REDSTONE.has(name)) return { kind: 'PROTECTED', excavatable: false, requiresAuth: true, preserve: true, reason: 'redstone system' };
  if (BEDS_AND_FARMS.has(name)) return { kind: 'PROTECTED', excavatable: false, requiresAuth: true, preserve: true, reason: 'bed or farm' };
  if (ORE_BLOCKS.has(name)) {
    if (preserveOres) return { kind: 'ORE', excavatable: false, requiresAuth: false, preserve: true, reason: 'valuable ore preserved for mining' };
    return { kind: 'ORE', excavatable: true, requiresAuth: false, preserve: false, reason: 'ore authorised for excavation' };
  }
  if (MANUFACTURED.has(name)) {
    if (!protectedDefault) return { kind: 'MANUFACTURED', excavatable: true, requiresAuth: true, preserve: false, reason: 'manufactured block (protection disabled)' };
    if (authorized) return { kind: 'MANUFACTURED', excavatable: true, requiresAuth: true, preserve: false, reason: 'player structure (authorised)' };
    return { kind: 'MANUFACTURED', excavatable: false, requiresAuth: true, preserve: true, reason: 'player-placed block protected by default' };
  }
  if (FALLING.has(name)) return { kind: 'FALLING', excavatable: true, requiresAuth: false, preserve: false, reason: 'falling block; dig from above' };
  if (VEGETATION.has(name)) return { kind: 'VEGETATION', excavatable: true, requiresAuth: false, preserve: false, reason: 'vegetation' };
  if (NATURAL.has(name)) return { kind: 'NATURAL', excavatable: true, requiresAuth: false, preserve: false, reason: 'natural terrain' };
  // Unknown blocks are treated conservatively.
  return { kind: 'UNKNOWN', excavatable: false, requiresAuth: true, preserve: true, reason: 'unknown block type' };
}

/** Summarise a scanned area for the plan and its warnings. */
function summarizeArea(blockCounts, options = {}) {
  const summary = { air: 0, natural: 0, vegetation: 0, falling: 0, ores: {}, liquids: {}, protected: {}, unknown: {}, terrainBlocks: 0, excavatable: 0, volume: 0 };
  for (const [name, count] of Object.entries(blockCounts)) {
    const c = classifyBlock(name, options);
    summary.volume += count;
    if (c.kind === 'AIR') { summary.air += count; continue; }
    summary.terrainBlocks += count;
    if (c.excavatable) summary.excavatable += count;
    switch (c.kind) {
      case 'NATURAL': summary.natural += count; break;
      case 'VEGETATION': summary.vegetation += count; break;
      case 'FALLING': summary.falling += count; break;
      case 'ORE': summary.ores[name] = (summary.ores[name] || 0) + count; break;
      case 'LIQUID': summary.liquids[name] = (summary.liquids[name] || 0) + count; break;
      case 'PROTECTED': case 'MANUFACTURED': case 'BEDROCK': summary.protected[name] = (summary.protected[name] || 0) + count; break;
      default: summary.unknown[name] = (summary.unknown[name] || 0) + count;
    }
  }
  return summary;
}

function buildWarnings(summary) {
  const warnings = [];
  const liquids = Object.keys(summary.liquids);
  if (liquids.includes('lava') || liquids.includes('flowing_lava')) warnings.push({ level: 'danger', text: 'Lava present: excavation will wall off and skip lava-adjacent blocks.' });
  if (liquids.includes('water') || liquids.includes('flowing_water')) warnings.push({ level: 'warn', text: 'Water present: blocks adjacent to water are skipped to avoid flooding.' });
  if (Object.keys(summary.ores).length) {
    warnings.push({ level: 'info', text: `Ores preserved: ${Object.entries(summary.ores).map(([k, v]) => `${k} x${v}`).join(', ')}` });
  }
  if (Object.keys(summary.protected).length) {
    const top = Object.entries(summary.protected).sort((a, b) => b[1] - a[1]).slice(0, 6);
    warnings.push({ level: 'danger', text: `Protected/player blocks inside area: ${top.map(([k, v]) => `${k} x${v}`).join(', ')}. Explicit authorisation required.` });
  }
  if (summary.falling > 0) warnings.push({ level: 'warn', text: `${summary.falling} falling blocks (sand/gravel): top-down removal required.` });
  if (summary.unknown > 0) warnings.push({ level: 'warn', text: `Unknown block types preserved: ${Object.keys(summary.unknown).slice(0, 5).join(', ')}` });
  return warnings;
}

module.exports = {
  AIR, LIQUIDS, BEDROCK, CONTAINERS, FUNCTIONAL, REDSTONE, MANUFACTURED,
  BEDS_AND_FARMS, ORE_BLOCKS, FALLING, VEGETATION, NATURAL,
  isAir, isLiquid, isOre, isBedrock, classifyBlock, summarizeArea, buildWarnings
};
