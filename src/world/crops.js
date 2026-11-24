'use strict';

/**
 * Crop registry shared by the farming controller and the deterministic world.
 *
 * `maxAge` is the real vanilla block-state limit (wheat/carrots/potatoes/stems
 * 0..7, beetroots 0..3, torchflower 0..1, pitcher 0..4). A crop is harvested
 * only at max age; anything else is left to grow.
 */
const CROPS = {
  wheat: { seed: 'wheat_seeds', produce: 'wheat', maxAge: 7, seedYield: true },
  carrots: { seed: 'carrot', produce: 'carrot', maxAge: 7, seedYield: false },
  potatoes: { seed: 'potato', produce: 'potato', maxAge: 7, seedYield: false },
  beetroots: { seed: 'beetroot_seeds', produce: 'beetroot', maxAge: 3, seedYield: true },
  pumpkin_stem: { seed: 'pumpkin_seeds', produce: 'pumpkin', maxAge: 7, stem: true, fruit: 'pumpkin' },
  melon_stem: { seed: 'melon_seeds', produce: 'melon_slice', maxAge: 7, stem: true, fruit: 'melon' },
  torchflower_crop: { seed: 'torchflower_seeds', produce: 'torchflower', maxAge: 1, seedYield: true },
  pitcher_crop: { seed: 'pitcher_pod', produce: 'pitcher_plant', maxAge: 4, double: true, seedYield: true }
};

const CROP_ALIASES = {
  wheat: 'wheat', carrot: 'carrots', carrots: 'carrots', potato: 'potatoes', potatoes: 'potatoes',
  beetroot: 'beetroots', beetroots: 'beetroots', pumpkin: 'pumpkin_stem', pumpkins: 'pumpkin_stem',
  melon: 'melon_stem', melons: 'melon_stem', torchflower: 'torchflower_crop', pitcher: 'pitcher_crop'
};

const TILLABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'moss_block', 'dirt_path']);
const SOIL = new Set(['farmland', ...TILLABLE]);
const REPLACEABLE = new Set([
  'air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'dandelion', 'poppy', 'cornflower', 'azure_bluet', 'oxeye_daisy', 'snow'
]);

function bareName(name) { return name ? String(name).replace(/^minecraft:/, '') : name; }

function cropDefinition(name) { return CROPS[bareName(name)] || null; }

function normalizeCrop(value) {
  if (!value || value === 'all' || value === 'harvest') return null;
  const key = String(value).toLowerCase();
  return CROP_ALIASES[key] || (CROPS[key] ? key : null);
}

function cropAge(block) {
  if (!block || !block.properties) return null;
  const raw = block.properties.age;
  if (raw === undefined || raw === null) return null;
  const age = Number(raw);
  return Number.isFinite(age) ? age : null;
}

/** Missing age means the adapter does not expose block states; real adapters
 * do expose it, so treat unknown as mature only for limited adapters. */
function isMatureCrop(block) {
  const name = bareName(block && block.name);
  const def = CROPS[name];
  if (!def) return false;
  if (name === 'pitcher_crop' && block.properties && block.properties.half === 'upper') return false;
  const age = cropAge(block);
  if (age === null) return true;
  return age >= def.maxAge;
}

function isCrop(name) { return Boolean(CROPS[bareName(name)]); }

module.exports = {
  CROPS,
  CROP_ALIASES,
  TILLABLE,
  SOIL,
  REPLACEABLE,
  bareName,
  cropDefinition,
  normalizeCrop,
  cropAge,
  isMatureCrop,
  isCrop
};
