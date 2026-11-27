'use strict';

/**
 * Pickaxe requirements for every mineable target the command surface accepts.
 * Tier values match minecraft tool materials:
 *   0 = hand/shovel/axe, 1 = wood, 2 = stone, 3 = iron, 4 = diamond.
 *
 * This table is deliberately broader than the ore list: `mine stone`,
 * `mine obsidian` and `mine ancient_debris` must make the same tool decision as
 * `mine diamonds`, or the bot reaches the block and only then discovers it
 * cannot harvest it.
 */
const ORE_TIERS = {
  coal_ore: 1, deepslate_coal_ore: 1,
  copper_ore: 2, deepslate_copper_ore: 2,
  iron_ore: 2, deepslate_iron_ore: 2,
  lapis_ore: 2, deepslate_lapis_ore: 2,
  gold_ore: 3, deepslate_gold_ore: 3,
  redstone_ore: 3, deepslate_redstone_ore: 3,
  diamond_ore: 3, deepslate_diamond_ore: 3,
  emerald_ore: 3, deepslate_emerald_ore: 3,
  quartz_ore: 1, nether_quartz_ore: 1,
  ancient_debris: 4
};

const ORE_DROPS = {
  coal_ore: 'coal', deepslate_coal_ore: 'coal',
  copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
  iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
  lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
  quartz_ore: 'quartz', nether_quartz_ore: 'quartz',
  ancient_debris: 'netherite_scrap'
};

const ORE_ALIASES = {
  coal: 'coal_ore', copper: 'copper_ore', iron: 'iron_ore', gold: 'gold_ore',
  redstone: 'redstone_ore', lapis: 'lapis_ore', lapis_lazuli: 'lapis_ore',
  diamond: 'diamond_ore', diamonds: 'diamond_ore', emerald: 'emerald_ore',
  emeralds: 'emerald_ore', quartz: 'quartz_ore',
  debris: 'ancient_debris', ancient: 'ancient_debris'
};

const BLOCK_TIERS = {
  // Hand-diggable or shovel/axe blocks. Kept here so a request for them is
  // recognised as a block, not silently turned into "<name>_ore".
  dirt: 0, grass_block: 0, coarse_dirt: 0, podzol: 0, mycelium: 0, mud: 0,
  sand: 0, red_sand: 0, gravel: 0, clay: 0, soul_sand: 0, soul_soil: 0,
  snow: 0, snow_block: 0, farmland: 0,
  // Pickaxe blocks.
  stone: 1, cobblestone: 1, deepslate: 1, cobbled_deepslate: 1,
  andesite: 1, diorite: 1, granite: 1, tuff: 1, calcite: 1, basalt: 1,
  blackstone: 1, netherrack: 1, cobbled_blackstone: 1,
  stone_bricks: 1, mossy_stone_bricks: 1, cracked_stone_bricks: 1,
  coal_block: 1, redstone_block: 1, nether_bricks: 1,
  iron_block: 2, copper_block: 2, lapis_block: 2, cut_copper: 2,
  gold_block: 3, diamond_block: 3, emerald_block: 3,
  obsidian: 4, crying_obsidian: 4, respawn_anchor: 4,
  ancient_debris_block: 4, netherite_block: 4
};

const BLOCK_ALIASES = {
  cobble: 'cobblestone', deepslate_cobble: 'cobbled_deepslate',
  netherite: 'netherite_block', debris_block: 'ancient_debris_block'
};

const ORE_NAMES = Object.keys(ORE_TIERS);
const MINABLE_BLOCKS = new Set([...Object.keys(BLOCK_TIERS), ...ORE_NAMES]);

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/^minecraft:/, '').trim();
}

/** `diamond` -> `diamond_ore`; `stone` stays a block. */
function normalizeMineTarget(value) {
  const name = normalizeName(value);
  if (!name) return null;
  if (ORE_ALIASES[name]) return ORE_ALIASES[name];
  if (ORE_TIERS[name]) return name;
  if (BLOCK_ALIASES[name]) return BLOCK_ALIASES[name];
  if (BLOCK_TIERS[name] !== undefined) return name;
  if (name.endsWith('_ore')) return name;
  return name;
}

function isOreName(name) {
  return Boolean(ORE_TIERS[normalizeName(name)]);
}

function isMineableTarget(name) {
  const target = normalizeMineTarget(name);
  return Boolean(target && (ORE_TIERS[target] !== undefined || BLOCK_TIERS[target] !== undefined || target.endsWith('_ore')));
}

function requiredPickaxeTier(name) {
  const raw = normalizeName(name);
  const target = normalizeMineTarget(raw) || raw;
  if (target !== raw) return requiredPickaxeTier(target);
  if (ORE_TIERS[target] !== undefined) return ORE_TIERS[target];
  if (BLOCK_TIERS[target] !== undefined) return BLOCK_TIERS[target];
  // An unknown deepslate variant inherits the base requirement.
  if (target.startsWith('deepslate_')) {
    const base = target.slice('deepslate_'.length);
    if (ORE_TIERS[base] !== undefined) return ORE_TIERS[base];
    if (BLOCK_TIERS[base] !== undefined) return BLOCK_TIERS[base];
  }
  // Unknown "foo_ore" is still an ore, so never treat it as hand-diggable.
  return target.endsWith('_ore') ? 1 : 0;
}

function oreVariants(name) {
  const target = normalizeName(name);
  if (target.startsWith('deepslate_')) {
    const base = target.slice('deepslate_'.length);
    return [target, base].filter((entry) => ORE_TIERS[entry]);
  }
  return [target, `deepslate_${target}`].filter((entry) => ORE_TIERS[entry]);
}

function label(target) {
  return String(target || '')
    .replace(/^deepslate_/, 'deepslate ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * The authoritative target catalogue for operator surfaces. Both the CLI and
 * the dashboard resolve `mine` targets through this list — there is no second
 * ore/block table in the frontend. `choices` are the friendly alias forms the
 * UI shows; `accepted` is every raw name the handler will resolve.
 */
function miningTargets() {
  const oreAliases = {};
  for (const [alias, target] of Object.entries(ORE_ALIASES)) {
    oreAliases[target] = oreAliases[target] || [];
    oreAliases[target].push(alias);
  }
  const oreTargets = [...new Set(Object.values(ORE_ALIASES))];
  const ores = oreTargets.map((target) => ({
    kind: 'ore',
    target,
    id: (oreAliases[target] || [target])[0],
    label: label(target).replace(/ Ore$/, ''),
    aliases: oreAliases[target] || [],
    variants: oreVariants(target),
    tier: requiredPickaxeTier(target),
    drop: ORE_DROPS[target] || null
  })).sort((a, b) => a.label.localeCompare(b.label));
  const blocks = Object.keys(BLOCK_TIERS).map((target) => ({
    kind: 'block',
    target,
    id: target,
    label: label(target),
    aliases: Object.entries(BLOCK_ALIASES).filter(([, value]) => value === target).map(([alias]) => alias),
    variants: [target],
    tier: BLOCK_TIERS[target],
    drop: target
  })).sort((a, b) => a.label.localeCompare(b.label));
  return {
    ores,
    blocks,
    choices: [...ores, ...blocks],
    aliases: { ...ORE_ALIASES, ...BLOCK_ALIASES },
    tierNames: ['hand', 'wood', 'stone', 'iron', 'diamond'],
    defaults: { radius: 48, limit: 4, maxDepth: 12, minY: -60 },
    source: 'src/actions/miningCatalog.js'
  };
}

module.exports = {
  ORE_TIERS, ORE_DROPS, ORE_ALIASES, ORE_NAMES,
  BLOCK_TIERS, BLOCK_ALIASES, MINABLE_BLOCKS,
  normalizeName, normalizeMineTarget, isOreName, isMineableTarget,
  requiredPickaxeTier, oreVariants, miningTargets
};
