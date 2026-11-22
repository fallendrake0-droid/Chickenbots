'use strict';

/** Material palettes. Palette choice is deliberately NOT part of design
 * identity: the deduplicator hashes material *classes* so recolouring a design
 * does not count as a new schematic. */
const PALETTES = {
  oak: { primary: 'oak_planks', frame: 'oak_log', floor: 'oak_planks', roof: 'dark_oak_stairs', roofBase: 'dark_oak_planks', accent: 'cobblestone', glass: 'glass_pane', light: 'lantern', path: 'dirt_path', furniture: 'oak_fence', wall: 'oak_planks', pillar: 'oak_log' },
  spruce: { primary: 'spruce_planks', frame: 'spruce_log', floor: 'spruce_planks', roof: 'spruce_stairs', roofBase: 'spruce_planks', accent: 'stone_bricks', glass: 'glass_pane', light: 'lantern', path: 'gravel', furniture: 'spruce_planks', wall: 'spruce_planks', pillar: 'spruce_log' },
  birch: { primary: 'birch_planks', frame: 'birch_log', floor: 'birch_planks', roof: 'spruce_stairs', roofBase: 'spruce_planks', accent: 'cobblestone', glass: 'glass_pane', light: 'lantern', path: 'dirt_path', furniture: 'birch_planks', wall: 'birch_planks', pillar: 'birch_log' },
  cherry: { primary: 'cherry_planks', frame: 'cherry_log', floor: 'cherry_planks', roof: 'cherry_stairs', roofBase: 'cherry_planks', accent: 'quartz_block', glass: 'white_stained_glass_pane', light: 'lantern', path: 'dirt_path', furniture: 'cherry_planks', wall: 'cherry_planks', pillar: 'cherry_log' },
  stone: { primary: 'stone_bricks', frame: 'chiseled_stone_bricks', floor: 'smooth_stone', roof: 'stone_brick_stairs', roofBase: 'stone_bricks', accent: 'cobblestone', glass: 'glass_pane', light: 'torch', path: 'gravel', furniture: 'stone_bricks', wall: 'stone_bricks', pillar: 'stone_brick_wall' },
  deepslate: { primary: 'deepslate_bricks', frame: 'polished_deepslate', floor: 'deepslate_tiles', roof: 'deepslate_tile_stairs', roofBase: 'deepslate_tiles', accent: 'tuff', glass: 'gray_stained_glass_pane', light: 'soul_lantern', path: 'cobbled_deepslate', furniture: 'deepslate_bricks', wall: 'deepslate_bricks', pillar: 'polished_deepslate' },
  sandstone: { primary: 'sandstone', frame: 'chiseled_sandstone', floor: 'smooth_sandstone', roof: 'sandstone_stairs', roofBase: 'sandstone', accent: 'cut_sandstone', glass: 'glass_pane', light: 'lantern', path: 'sand', furniture: 'smooth_sandstone', wall: 'sandstone', pillar: 'cut_sandstone' },
  quartz: { primary: 'quartz_block', frame: 'chiseled_quartz_block', floor: 'smooth_quartz', roof: 'quartz_stairs', roofBase: 'quartz_block', accent: 'calcite', glass: 'white_stained_glass_pane', light: 'end_rod', path: 'smooth_quartz', furniture: 'quartz_block', wall: 'quartz_block', pillar: 'quartz_pillar' },
  prismarine: { primary: 'prismarine_bricks', frame: 'dark_prismarine', floor: 'prismarine', roof: 'dark_prismarine_stairs', roofBase: 'dark_prismarine', accent: 'sea_lantern', glass: 'glass_pane', light: 'sea_lantern', path: 'prismarine', furniture: 'prismarine_bricks', wall: 'prismarine_bricks', pillar: 'prismarine' },
  nether: { primary: 'polished_blackstone_bricks', frame: 'blackstone', floor: 'blackstone', roof: 'blackstone', roofBase: 'blackstone', accent: 'nether_bricks', glass: 'gray_stained_glass_pane', light: 'soul_lantern', path: 'blackstone', furniture: 'nether_bricks', wall: 'polished_blackstone_bricks', pillar: 'polished_blackstone_bricks' },
  copper: { primary: 'cut_copper', frame: 'copper_block', floor: 'smooth_stone', roof: 'oxidized_cut_copper', roofBase: 'cut_copper', accent: 'oxidized_copper', glass: 'light_gray_stained_glass_pane' || 'glass_pane', light: 'lantern', path: 'smooth_stone', furniture: 'cut_copper', wall: 'cut_copper', pillar: 'copper_block' },
  terracotta: { primary: 'terracotta', frame: 'white_terracotta', floor: 'smooth_stone', roof: 'bricks', roofBase: 'bricks', accent: 'orange_terracotta', glass: 'glass_pane', light: 'lantern', path: 'gravel', furniture: 'bricks', wall: 'terracotta', pillar: 'white_terracotta' },
  modern: { primary: 'white_concrete', frame: 'light_gray_concrete', floor: 'smooth_stone', roof: 'smooth_stone', roofBase: 'light_gray_concrete', accent: 'gray_concrete', glass: 'tinted_glass', light: 'sea_lantern', path: 'white_concrete', furniture: 'white_concrete', wall: 'white_concrete', pillar: 'gray_concrete' },
  mossy: { primary: 'mossy_stone_bricks', frame: 'mossy_cobblestone', floor: 'stone', roof: 'mossy_stone_bricks', roofBase: 'mossy_stone_bricks', accent: 'moss_block', glass: 'glass_pane', light: 'lantern', path: 'moss_block', furniture: 'mossy_stone_bricks', wall: 'mossy_stone_bricks', pillar: 'mossy_cobblestone' },
  bamboo: { primary: 'bamboo_planks', frame: 'bamboo_block', floor: 'bamboo_planks', roof: 'bamboo_planks', roofBase: 'bamboo_planks', accent: 'mud_bricks', glass: 'glass_pane', light: 'lantern', path: 'dirt_path', furniture: 'bamboo_planks', wall: 'bamboo_planks', pillar: 'bamboo_block' },
  mangrove: { primary: 'mangrove_planks', frame: 'mangrove_log', floor: 'mangrove_planks', roof: 'mangrove_stairs', roofBase: 'mangrove_planks', accent: 'mud_bricks', glass: 'glass_pane', light: 'lantern', path: 'mud', furniture: 'mangrove_planks', wall: 'mangrove_planks', pillar: 'mangrove_log' }
};

const STYLE_PALETTES = {
  medieval: ['oak', 'spruce', 'stone', 'mossy'],
  rustic: ['oak', 'spruce', 'birch', 'mangrove'],
  japanese: ['spruce', 'cherry', 'bamboo', 'birch'],
  fantasy: ['mossy', 'cherry', 'deepslate', 'quartz'],
  desert: ['sandstone', 'terracotta'],
  nordic: ['spruce', 'stone', 'deepslate'],
  modern: ['modern', 'quartz', 'copper'],
  industrial: ['stone', 'deepslate', 'copper', 'terracotta'],
  oceanic: ['prismarine', 'quartz'],
  dark: ['deepslate', 'nether'],
  royal: ['quartz', 'stone', 'cherry'],
  woodland: ['birch', 'mangrove', 'oak', 'mossy']
};

function paletteFor(style, rngPick) {
  const list = STYLE_PALETTES[style] || ['oak', 'stone', 'spruce'];
  return PALETTES[rngPick(list)] || PALETTES.oak;
}

module.exports = { PALETTES, STYLE_PALETTES, paletteFor };
