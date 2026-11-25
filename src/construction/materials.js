'use strict';

const { PHASES, PHASE_ORDER } = require('../schematics/blockGrid');
const { categoryOf } = require('../world/items');

const CATEGORY_ORDER = ['stone', 'wood', 'stairs_slabs', 'glass', 'lighting', 'decoration', 'utility', 'tools', 'food', 'valuables', 'excavation', 'surplus', 'other'];

const CATEGORY_PATTERNS = [
  ['stairs_slabs', /(_stairs|_slab)$/],
  ['lighting', /(torch|lantern|glowstone|shroomlight|sea_lantern|candle|campfire|redstone_lamp|end_rod|lava_bucket)$/],
  ['glass', /glass/],
  ['valuables', /(diamond|emerald|netherite|ancient_debris|gold_ingot|iron_ingot|lapis|amethyst|echo_shard|_ore$)/],
  ['food', /(bread|apple|cooked_|raw_|carrot|potato|beetroot|stew|melon_slice)/],
  ['tools', /(pickaxe|_axe|shovel|sword|hoe|shears|flint_and_steel|bucket|bow|arrow)$/],
  ['utility', /(chest|barrel|shulker_box|furnace|crafting_table|anvil|bed|_bed|sign|bucket|ladder|rail|redstone|piston|observer|hopper|lever|button|pressure_plate)$/],
  ['wood', /(_log|_wood|_planks|_stem|_hyphae|bamboo|stick)/],
  ['stone', /(stone|cobblestone|deepslate|andesite|diorite|granite|tuff|calcite|blackstone|basalt|brick|terracotta|sandstone|dirt|grass_block|sand|gravel|clay|mud|snow|prismarine|quartz|copper|iron_block|gold_block|netherrack|end_stone)/],
  ['decoration', /(wool|carpet|flower|sapling|leaves|painting|item_frame|pot|banner|head|skull|candle)/]
];

function categoryForItem(name) {
  const fromItems = categoryOf(name);
  if (fromItems && CATEGORY_ORDER.includes(fromItems)) return fromItems === 'block' ? 'surplus' : fromItems;
  for (const [category, pattern] of CATEGORY_PATTERNS) if (pattern.test(name)) return category;
  return 'other';
}

function categoryChestGroup(category) {
  if (['stairs_slabs', 'glass', 'decoration'].includes(category)) return `${category}_chests`;
  if (category === 'stone' || category === 'wood') return `${category}_chests`;
  return `${category}_chests`;
}

/** Full bill of materials from schematic blocks (not estimates copied from tooltips). */
function billOfMaterials(schematic, { contingency = 0 } = {}) {
  const exact = {};
  for (const block of schematic.blocks || []) {
    const name = Array.isArray(block) ? schematic.palette[block[3]] : block.name;
    if (!name) continue;
    exact[name] = (exact[name] || 0) + 1;
  }
  const materials = {};
  for (const [item, count] of Object.entries(exact)) {
    materials[item] = count + Math.ceil(count * Math.max(0, contingency));
  }
  return {
    schematicId: schematic.id,
    name: schematic.name,
    materials,
    exact,
    contingency,
    totalBlocks: Object.values(exact).reduce((sum, count) => sum + count, 0),
    categories: groupByCategory(materials),
    generatedAt: new Date().toISOString()
  };
}

function groupByCategory(materials) {
  const out = {};
  for (const [item, count] of Object.entries(materials)) {
    const category = categoryForItem(item);
    out[category] = out[category] || { items: {}, count: 0 };
    out[category].items[item] = count;
    out[category].count += count;
  }
  return out;
}

/** Combine bot inventories and verified ledger storage into one real total. */
function availableMaterials({ bots = [], ledger = null } = {}) {
  const counts = {};
  for (const bot of bots) {
    for (const [item, count] of Object.entries(bot.inventory || {})) if (count > 0) counts[item] = (counts[item] || 0) + count;
  }
  if (ledger && ledger.storages) {
    for (const storage of ledger.storages.values()) {
      for (const [item, count] of Object.entries(storage.counts || {})) if (count > 0) counts[item] = (counts[item] || 0) + count;
    }
  }
  return counts;
}

function materialStatus(bom, available = {}) {
  const requirements = {};
  for (const [item, needed] of Object.entries(bom.materials || {})) {
    const have = Number(available[item] || 0);
    requirements[item] = {
      needed,
      have,
      deficit: Math.max(0, needed - have),
      surplus: Math.max(0, have - needed),
      category: categoryForItem(item),
      ready: have >= needed
    };
  }
  const deficit = {};
  for (const [item, row] of Object.entries(requirements)) if (row.deficit > 0) deficit[item] = row.deficit;
  return {
    requirements,
    deficit,
    ready: Object.keys(deficit).length === 0,
    totalNeeded: Object.values(requirements).reduce((sum, row) => sum + row.needed, 0),
    totalAvailable: Object.values(requirements).reduce((sum, row) => sum + Math.min(row.have, row.needed), 0)
  };
}

/** Source options for an item. Mining/chop/craft/smelt are real actions the executor can take. */
function acquisitionOptions(item) {
  const options = [];
  if (/cobblestone|stone|deepslate|andesite|diorite|granite|tuff|coal_ore|iron_ore|copper_ore|gold_ore|diamond_ore|redstone_ore|lapis_ore|emerald_ore|nether_quartz_ore/.test(item)) {
    options.push({ type: 'mine', block: item === 'cobblestone' ? 'stone' : item, tool: 'pickaxe', note: 'cobblestone is collected from stone; ore drops are preserved separately' });
  }
  if (/_log$|_wood$|_stem$/.test(item)) options.push({ type: 'chop', block: item, tool: 'axe' });
  if (item === 'oak_planks' || item === 'spruce_planks' || item === 'birch_planks') options.push({ type: 'craft', recipe: 'planks', note: '1 log -> 4 planks' });
  if (item === 'stick') options.push({ type: 'craft', recipe: 'stick', note: '2 planks -> 4 sticks' });
  if (item === 'torch') options.push({ type: 'craft', recipe: 'torch', note: 'coal + stick -> 4 torches' });
  if (item === 'chest') options.push({ type: 'craft', recipe: 'chest', note: '8 planks -> 1 chest' });
  if (/fence/.test(item)) options.push({ type: 'craft', recipe: 'fence', note: 'planks + sticks' });
  if (/glass$/.test(item)) options.push({ type: 'smelt', block: 'sand', note: 'sand in a furnace' });
  if (/brick/.test(item)) options.push({ type: 'smelt', block: 'clay_ball', note: 'clay balls in a furnace' });
  if (item === 'charcoal') options.push({ type: 'smelt', block: 'oak_log', note: 'logs in a furnace' });
  if (item === 'iron_ingot') options.push({ type: 'smelt', block: 'raw_iron', note: 'raw iron in a furnace' });
  if (item === 'gold_ingot') options.push({ type: 'smelt', block: 'raw_gold', note: 'raw gold in a furnace' });
  if (['dirt', 'grass_block', 'sand', 'gravel', 'clay', 'snow'].includes(item)) options.push({ type: 'gather', block: item, tool: 'shovel' });
  if (item.endsWith('_leaves') || item.endsWith('_sapling')) options.push({ type: 'gather', block: item, tool: 'shears_or_hand' });
  if (!options.length) options.push({ type: 'acquire', note: 'no deterministic local source mapping; retrieve from storage or trade/manual stock' });
  return options;
}

function buildAcquisitionPlan(status) {
  const plan = [];
  for (const [item, row] of Object.entries(status.requirements || {})) {
    if (row.deficit <= 0) continue;
    plan.push({ item, missing: row.deficit, needed: row.needed, have: row.have, category: row.category, options: acquisitionOptions(item), priority: row.deficit > 16 ? 'high' : 'normal' });
  }
  return plan.sort((a, b) => b.missing - a.missing || a.item.localeCompare(b.item));
}

/**
 * Safe substitution validation. Structural blocks and palette-sensitive
 * pieces are never auto-substituted. Only explicit, same-role, full-block
 * families are permitted, and only when the caller opts in.
 */
function validateSubstitution(from, to, { structural = true } = {}) {
  if (!from || !to) return { ok: false, error: 'missing block name' };
  if (from === to) return { ok: true, same: true, structural: false };
  if (structural && /(slab|stairs|fence|door|trapdoor|wall|pane|glass)$/.test(from)) return { ok: false, error: 'shape-specific block cannot be substituted without a geometry change' };
  if (/redstone|piston|observer|repeater|comparator|hopper|rail|button|lever|pressure_plate/.test(from)) return { ok: false, error: 'redstone/utility block substitution is not safe' };
  const allowed = {
    cobblestone: ['stone', 'deepslate', 'andesite', 'tuff'],
    stone: ['cobblestone', 'andesite', 'diorite', 'granite'],
    oak_planks: ['spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'],
    dirt: ['coarse_dirt', 'rooted_dirt'],
    oak_log: ['spruce_log', 'birch_log']
  };
  if ((allowed[from] || []).includes(to)) return { ok: true, from, to, structural: true, note: 'validated same-role full-block substitution' };
  return { ok: false, error: 'substitution is not in the validated same-role allowlist' };
}

/** Material readiness by schematic build phase. Also supports phase-level BOMs. */
function phaseReadiness(schematic, available = {}, { phaseOrder = PHASES } = {}) {
  const required = {};
  for (const block of schematic.blocks || []) {
    const phaseIndex = Array.isArray(block) ? block[4] : 0;
    const phase = phaseOrder[phaseIndex] || 'WALLS';
    const name = Array.isArray(block) ? schematic.palette[block[3]] : block.name;
    required[phase] = required[phase] || {};
    required[phase][name] = (required[phase][name] || 0) + 1;
  }
  const result = {};
  for (const phase of PHASES) {
    const req = required[phase] || {};
    let needed = 0;
    let have = 0;
    const missing = {};
    for (const [item, count] of Object.entries(req)) {
      needed += count;
      have += Math.min(count, Number(available[item] || 0));
      if ((available[item] || 0) < count) missing[item] = count - (available[item] || 0);
    }
    result[phase] = { phase, order: PHASE_ORDER[phase] || 0, required: req, needed, have, missing, ready: Object.keys(missing).length === 0, percent: needed ? Number((have / needed).toFixed(3)) : 1 };
  }
  return result;
}

function reserveProjectMaterials({ ledger, bom, owner = 'project', ratio = 1 } = {}) {
  if (!ledger) return { ok: false, error: 'no ledger' };
  const reservations = [];
  const failures = [];
  for (const [item, count] of Object.entries(bom.materials || {})) {
    const request = Math.ceil(count * Math.max(0, ratio));
    if (request <= 0) continue;
    const result = ledger.reserve(item, request, { purpose: 'construction', owner });
    if (result.ok) reservations.push(result.reservation);
    else failures.push({ item, ...result.shortage });
  }
  if (failures.length) {
    // All-or-nothing: a partial construction reservation would hold real
    // materials hostage forever when one missing item blocks the project.
    for (const reservation of reservations) ledger.release(reservation.id);
    return { ok: false, reservations: [], failures, released: reservations.length };
  }
  return { ok: true, reservations, failures };
}

module.exports = {
  CATEGORY_ORDER, categoryForItem, categoryChestGroup, billOfMaterials, groupByCategory,
  availableMaterials, materialStatus, acquisitionOptions, buildAcquisitionPlan,
  validateSubstitution, phaseReadiness, reserveProjectMaterials
};
