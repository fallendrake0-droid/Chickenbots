'use strict';

/** Item taxonomy, food values and tool tiers.
 *
 * Values are vanilla Minecraft (Java) values. They drive real decisions:
 * which food to eat, which tool to equip, what to keep when the inventory is
 * full, and which materials count toward team reserves.
 */

const FOODS = {
  cooked_beef: { hunger: 8, saturation: 12.8 },
  cooked_porkchop: { hunger: 8, saturation: 12.8 },
  golden_carrot: { hunger: 6, saturation: 14.4 },
  rabbit_stew: { hunger: 10, saturation: 12 },
  cooked_mutton: { hunger: 6, saturation: 9.6 },
  cooked_salmon: { hunger: 6, saturation: 9.6 },
  cooked_chicken: { hunger: 6, saturation: 7.2 },
  mushroom_stew: { hunger: 6, saturation: 7.2 },
  baked_potato: { hunger: 5, saturation: 6 },
  bread: { hunger: 5, saturation: 6 },
  cooked_cod: { hunger: 5, saturation: 6 },
  cooked_rabbit: { hunger: 5, saturation: 6 },
  pumpkin_pie: { hunger: 8, saturation: 4.8 },
  apple: { hunger: 4, saturation: 2.4 },
  carrot: { hunger: 3, saturation: 3.6 },
  golden_apple: { hunger: 4, saturation: 9.6, special: true },
  enchanted_golden_apple: { hunger: 4, saturation: 9.6, special: true },
  melon_slice: { hunger: 2, saturation: 1.2 },
  sweet_berries: { hunger: 2, saturation: 0.4 },
  glow_berries: { hunger: 2, saturation: 0.4 },
  beetroot: { hunger: 1, saturation: 1.2 },
  beetroot_soup: { hunger: 6, saturation: 7.2 },
  potato: { hunger: 1, saturation: 0.6 },
  cookie: { hunger: 2, saturation: 0.4 },
  honey_bottle: { hunger: 6, saturation: 1.2 },
  dried_kelp: { hunger: 1, saturation: 0.6 },
  tropical_fish: { hunger: 1, saturation: 0.2 },
  rotten_flesh: { hunger: 4, saturation: 0.8, risk: 'hunger', riskWeight: 0.8 },
  spider_eye: { hunger: 2, saturation: 3.2, risk: 'poison', riskWeight: 1 },
  poisonous_potato: { hunger: 2, saturation: 1.2, risk: 'poison', riskWeight: 1 },
  pufferfish: { hunger: 1, saturation: 0.2, risk: 'poison', riskWeight: 3 },
  chicken: { hunger: 2, saturation: 1.2, risk: 'hunger', riskWeight: 0.3 },
  beef: { hunger: 3, saturation: 1.8 },
  porkchop: { hunger: 3, saturation: 1.8 },
  mutton: { hunger: 2, saturation: 1.2 },
  rabbit: { hunger: 3, saturation: 1.8 },
  cod: { hunger: 2, saturation: 0.4 },
  salmon: { hunger: 2, saturation: 0.4 }
};

const PICKAXES = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5, golden_pickaxe: 1 };
const AXES = { wooden_axe: 1, stone_axe: 2, iron_axe: 3, diamond_axe: 4, netherite_axe: 5, golden_axe: 1 };
const SHOVELS = { wooden_shovel: 1, stone_shovel: 2, iron_shovel: 3, diamond_shovel: 4, netherite_shovel: 5, golden_shovel: 1 };
const SWORDS = { wooden_sword: 1, stone_sword: 2, iron_sword: 3, diamond_sword: 4, netherite_sword: 5, golden_sword: 1 };
const HOES = { wooden_hoe: 1, stone_hoe: 2, iron_hoe: 3, diamond_hoe: 4, netherite_hoe: 5, golden_hoe: 1 };

const ARMOR = {
  leather_helmet: { slot: 'head', points: 1 }, leather_chestplate: { slot: 'torso', points: 3 }, leather_leggings: { slot: 'legs', points: 2 }, leather_boots: { slot: 'feet', points: 1 },
  golden_helmet: { slot: 'head', points: 2 }, golden_chestplate: { slot: 'torso', points: 5 }, golden_leggings: { slot: 'legs', points: 3 }, golden_boots: { slot: 'feet', points: 1 },
  chainmail_helmet: { slot: 'head', points: 2 }, chainmail_chestplate: { slot: 'torso', points: 5 }, chainmail_leggings: { slot: 'legs', points: 4 }, chainmail_boots: { slot: 'feet', points: 1 },
  iron_helmet: { slot: 'head', points: 2 }, iron_chestplate: { slot: 'torso', points: 6 }, iron_leggings: { slot: 'legs', points: 5 }, iron_boots: { slot: 'feet', points: 2 },
  diamond_helmet: { slot: 'head', points: 3 }, diamond_chestplate: { slot: 'torso', points: 8 }, diamond_leggings: { slot: 'legs', points: 6 }, diamond_boots: { slot: 'feet', points: 3 },
  netherite_helmet: { slot: 'head', points: 3 }, netherite_chestplate: { slot: 'torso', points: 8 }, netherite_leggings: { slot: 'legs', points: 6 }, netherite_boots: { slot: 'feet', points: 3 },
  turtle_helmet: { slot: 'head', points: 2 },
  elytra: { slot: 'torso', points: 0, special: 'flight' }
};

const LOGS = new Set(['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log', 'oak_wood', 'birch_wood', 'spruce_wood', 'jungle_wood', 'acacia_wood', 'dark_oak_wood', 'mangrove_wood', 'cherry_wood', 'pale_oak_wood', 'stripped_oak_log', 'crimson_stem', 'warped_stem']);
const PLANKS = new Set(['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks', 'crimson_planks', 'warped_planks', 'bamboo_planks']);
const ORES = new Set(['coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris']);
const RAW_ORES = new Set(['raw_iron', 'raw_copper', 'raw_gold', 'coal', 'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz']);
const INGOTS = new Set(['iron_ingot', 'copper_ingot', 'gold_ingot', 'netherite_ingot', 'netherite_scrap']);
const WEAPONS = new Set([...Object.keys(SWORDS), 'bow', 'crossbow', 'trident', 'arrow', 'spectral_arrow', 'tipped_arrow', 'shield', 'snowball', 'egg']);
const BUILDING = new Set(['cobblestone', 'stone', 'stone_bricks', 'deepslate_bricks', 'deepslate_tiles', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks', 'bricks', 'sandstone', 'cut_sandstone', 'smooth_stone', 'glass', 'glass_pane', 'terracotta', 'white_terracotta', 'quartz_block', 'smooth_quartz', 'prismarine', 'prismarine_bricks', 'dark_prismarine', 'nether_bricks', 'red_nether_bricks', 'blackstone', 'polished_blackstone_bricks', 'calcite', 'tuff', 'dirt', 'grass_block', 'sand', 'gravel', 'andesite', 'diorite', 'granite', 'polished_andesite', 'polished_diorite', 'polished_granite', 'mud_bricks', 'packed_mud', 'copper_block', 'iron_block', 'coal_block', 'white_wool', 'lantern', 'torch', 'oak_fence', 'oak_stairs', 'stone_stairs', 'oak_slab', 'stone_slab']);
const UTILITY = new Set(['torch', 'lantern', 'water_bucket', 'lava_bucket', 'bucket', 'flint_and_steel', 'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'barrel', 'ender_chest', 'bed', 'white_bed', 'red_bed', 'blue_bed', 'shulker_box', 'anvil', 'enchanting_table', 'brewing_stand', 'cauldron', 'composter', 'hoe', 'shears', 'fishing_rod', 'lead', 'saddle', 'name_tag', 'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling', 'mangrove_propagule', 'bone_meal', 'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'carrot', 'potato', 'sugar_cane', 'cocoa_beans', 'hay_block', 'slime_block', 'cobweb', 'boat', 'oak_boat', 'scaffolding', 'ladder']);
const VALUABLE = new Set(['diamond', 'emerald', 'netherite_ingot', 'netherite_scrap', 'enchanted_golden_apple', 'golden_apple', 'ancient_debris', 'diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'diamond_shovel', 'netherite_pickaxe', 'netherite_sword', 'elytra', 'trident', 'shulker_box', 'totem_of_undying', 'name_tag', 'saddle', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']);

// Vanilla stack sizes. A bot's inventory is not "number of item types": 36
// storage slots can hold at most 64 (or 1 for tools) of an item each. Anything
// that decides "is the inventory full" must use these, not distinct names.
const ONE_PER_SLOT = new Set([
  ...Object.keys(ARMOR), ...Object.keys(PICKAXES), ...Object.keys(AXES),
  ...Object.keys(SHOVELS), ...Object.keys(SWORDS), ...Object.keys(HOES),
  'bow', 'crossbow', 'trident', 'shield', 'elytra', 'totem_of_undying',
  'bucket', 'water_bucket', 'lava_bucket', 'milk_bucket',
  'minecart', 'chest_minecart', 'furnace_minecart', 'hopper_minecart', 'tnt_minecart',
  'oak_boat', 'birch_boat', 'spruce_boat', 'jungle_boat', 'acacia_boat', 'dark_oak_boat',
  'mangrove_boat', 'cherry_boat', 'pale_oak_boat', 'oak_chest_boat', 'birch_chest_boat',
  'spruce_chest_boat', 'jungle_chest_boat', 'acacia_chest_boat', 'dark_oak_chest_boat',
  'mangrove_chest_boat', 'cherry_chest_boat', 'pale_oak_chest_boat',
  'saddle', 'name_tag', 'enchanted_book', 'written_book', 'writable_book', 'cake'
]);
const SIXTEEN_PER_SLOT = new Set([
  'snowball', 'egg', 'ender_pearl', 'honey_bottle', 'armor_stand',
  'oak_sign', 'oak_hanging_sign', 'white_banner', 'banner'
]);
const STACK_LIMIT_OVERRIDES = {
  ...Object.fromEntries([...ONE_PER_SLOT].map((name) => [name, 1])),
  ...Object.fromEntries([...SIXTEEN_PER_SLOT].map((name) => [name, 16]))
};

function maxStackSize(name) {
  if (!name) return 64;
  if (STACK_LIMIT_OVERRIDES[name] !== undefined) return STACK_LIMIT_OVERRIDES[name];
  // Every potion variant stacks to one; banners/signs stack to sixteen.
  if (/potion/.test(name)) return 1;
  if (/_banner$/.test(name) || /_sign$/.test(name)) return 16;
  if (/_boat$|_minecart$|_bucket$/.test(name)) return 1;
  if (/^music_disc_/.test(name)) return 1;
  if (ARMOR[name] || /_helmet$|_chestplate$|_leggings$|_boots$/.test(name)) return 1;
  if (/_pickaxe$|_axe$|_shovel$|_sword$|_hoe$/.test(name)) return 1;
  return 64;
}

/** Slots consumed by an aggregate inventory map ({item: count}). */
function inventorySlotUsage(inventory = {}, capacity = 36) {
  let used = 0;
  for (const [name, count] of Object.entries(inventory || {})) {
    if (!(count > 0)) continue;
    used += Math.ceil(count / maxStackSize(name));
  }
  return { used, free: Math.max(0, capacity - used), capacity, overflow: Math.max(0, used - capacity) };
}

const BED_NAMES = new Set(['white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed']);
const CROP_BLOCKS = new Set(['wheat', 'carrots', 'potatoes', 'beetroots', 'sugar_cane', 'pumpkin', 'melon', 'cocoa', 'torchflower_crop', 'pitcher_crop']);
const SAPLING_NAMES = new Set(['oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'pale_oak_sapling', 'mangrove_propagule']);

function isLog(name) { return LOGS.has(name); }
function isPlank(name) { return PLANKS.has(name); }
function isOre(name) { return ORES.has(name); }
function isFood(name) { return Object.prototype.hasOwnProperty.call(FOODS, name); }
function isBed(name) { return BED_NAMES.has(name); }
function isSapling(name) { return SAPLING_NAMES.has(name); }
function isCrop(name) { return CROP_BLOCKS.has(name); }

function toolTier(name, table = PICKAXES) {
  return table[name] || 0;
}

function bestTool(inventory, table) {
  let best = null;
  for (const [name, count] of Object.entries(inventory)) {
    if (count <= 0) continue;
    const tier = toolTier(name, table);
    if (tier > 0 && (!best || tier > best.tier)) best = { name, tier };
  }
  return best;
}

/** Pick the best food for the current situation. Poisonous/risky food is only
 * chosen when there is no safe option and hunger is critical. */
function bestFood(inventory, { critical = false, health = 20 } = {}) {
  let best = null;
  for (const [name, count] of Object.entries(inventory)) {
    if (count <= 0) continue;
    const food = FOODS[name];
    if (!food) continue;
    const risky = Boolean(food.risk);
    if (risky && !critical) continue;
    if (food.risk === 'poison' && health <= 8) continue; // poison can kill
    const score = food.hunger + food.saturation * 0.5 - (risky ? 5 : 0);
    if (!best || score > best.score) best = { name, score, ...food };
  }
  if (!best && !critical) return bestFood(inventory, { critical: true, health });
  return best;
}

function armorPoints(inventory) {
  let total = 0;
  const worn = { head: 0, torso: 0, legs: 0, feet: 0 };
  for (const [name, count] of Object.entries(inventory)) {
    if (count <= 0) continue;
    const armor = ARMOR[name];
    if (!armor) continue;
    if (armor.points > worn[armor.slot]) {
      total += armor.points - worn[armor.slot];
      worn[armor.slot] = armor.points;
    }
  }
  return total;
}

function bestArmorForSlot(inventory, slot) {
  let best = null;
  for (const [name, count] of Object.entries(inventory)) {
    if (count <= 0) continue;
    const armor = ARMOR[name];
    if (!armor || armor.slot !== slot) continue;
    if (!best || armor.points > best.points) best = { name, ...armor };
  }
  return best;
}

function categoryOf(name) {
  if (isFood(name)) return 'food';
  if (LOGS.has(name)) return 'logs';
  if (PLANKS.has(name)) return 'planks';
  if (ORES.has(name)) return 'ores';
  if (RAW_ORES.has(name)) return 'raw_ores';
  if (INGOTS.has(name)) return 'ingots';
  if (toolTier(name, PICKAXES) || toolTier(name, AXES) || toolTier(name, SHOVELS) || toolTier(name, HOES) || /_sword$/.test(name)) return 'tools';
  if (WEAPONS.has(name)) return 'weapons';
  if (ARMOR[name]) return 'armor';
  if (BED_NAMES.has(name)) return 'beds';
  if (/potion$|_potion$/.test(name) || name === 'experience_bottle') return 'potions';
  if (BUILDING.has(name)) return 'building';
  if (UTILITY.has(name)) return 'utility';
  return 'misc';
}

/** 0..1 keep-priority used when the inventory is full. */
function keepPriority(name) {
  if (VALUABLE.has(name)) return 1;
  if (isFood(name)) return 0.9;
  const cat = categoryOf(name);
  if (cat === 'tools' || cat === 'weapons' || cat === 'armor') return 0.85;
  if (name === 'water_bucket' || name === 'bucket' || name === 'torch' || name === 'lantern') return 0.8;
  if (cat === 'ores' || cat === 'ingots' || cat === 'potions' || cat === 'beds') return 0.75;
  if (cat === 'building' || cat === 'logs' || cat === 'planks') return 0.5;
  return 0.2;
}

/** Category aliases used by the team resource ledger and reserves. */
const CATEGORY_ALIASES = {
  food: (n) => isFood(n),
  torch: (n) => n === 'torch',
  wood: (n) => LOGS.has(n),
  logs: (n) => LOGS.has(n),
  iron_ingot: (n) => n === 'iron_ingot',
  building_blocks: (n) => BUILDING.has(n),
  water_bucket: (n) => n === 'water_bucket',
  pickaxe: (n) => toolTier(n, PICKAXES) > 0,
  axe: (n) => toolTier(n, AXES) > 0,
  shovel: (n) => toolTier(n, SHOVELS) > 0,
  sword: (n) => toolTier(n, SWORDS) > 0,
  bed: (n) => BED_NAMES.has(n),
  sapling: (n) => SAPLING_NAMES.has(n),
  arrow: (n) => n === 'arrow'
};

function matchesCategory(itemName, category) {
  if (itemName === category) return true;
  const fn = CATEGORY_ALIASES[category];
  if (!fn) return false;
  return fn(itemName);
}

function sumCategory(inventory, category) {
  let total = 0;
  for (const [name, count] of Object.entries(inventory)) {
    if (count > 0 && matchesCategory(name, category)) total += count;
  }
  return total;
}

module.exports = {
  FOODS, PICKAXES, AXES, SHOVELS, SWORDS, HOES, ARMOR, LOGS, PLANKS, ORES,
  RAW_ORES, INGOTS, WEAPONS, BUILDING, UTILITY, VALUABLE, BED_NAMES, CROP_BLOCKS,
  SAPLING_NAMES, CATEGORY_ALIASES,
  isLog, isPlank, isOre, isFood, isBed, isSapling, isCrop, toolTier, bestTool,
  bestFood, armorPoints, bestArmorForSlot, categoryOf, keepPriority,
  maxStackSize, inventorySlotUsage, matchesCategory, sumCategory
};
