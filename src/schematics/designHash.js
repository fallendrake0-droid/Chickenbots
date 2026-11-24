'use strict';

const crypto = require('crypto');
const { parseBlock, formatBlock } = require('../building/blockStates');

/** Material class used for design identity. Palettes are intentionally ignored:
 * recolouring a design must NOT produce a "new" schematic. */

function blockNameOf(value) {
  return parseBlock(value).name;
}

function classOfBlock(value) {
  const n = parseBlock(value).name.toLowerCase();
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return 'air';
  if (n === 'water' || n === 'lava') return 'water';
  if (n.includes('glass')) return 'glass';
  if (n.includes('leaves') || n === 'grass_block' || n.includes('moss') || n.includes('vine') || n.includes('flower') || n.includes('sapling') || n.includes('wheat') || n.includes('carrot') || n.includes('potato') || n.includes('beetroot') || n.includes('hay_block') || n.includes('melon') || n.includes('pumpkin')) return 'vegetation';
  if (n.includes('torch') || n.includes('lantern') || n.includes('lamp') || n.includes('glowstone') || n.includes('sea_lantern') || n.includes('shroomlight') || n.includes('froglight') || n.includes('candle')) return 'light';
  if (n.includes('fence') || n.includes('rail') || n.includes('chain') || n.includes('carpet') || n.includes('banner') || n.includes('button') || n.includes('lever') || n.includes('pressure_plate') || n.includes('sign') || n.includes('item_frame') || n.includes('painting') || n.includes('flower_pot')) return 'decoration';
  if (n.includes('bed') || n.includes('chest') || n.includes('furnace') || n.includes('smoker') || n.includes('crafting_table') || n.includes('bookshelf') || n.includes('barrel') || n.includes('anvil') || n.includes('brewing_stand') || n.includes('enchanting_table') || n.includes('cauldron') || n.includes('composter') || n.includes('lectern') || n.includes('campfire') || n.includes('jukebox') || n.includes('note_block') || n.includes('ladder')) return 'interior';
  if (n.includes('stairs') || n.includes('slab') || n.includes('planks') || n.includes('log') || n.includes('wood') || n.includes('bookshelf') || n.includes('scaffolding')) return 'structure';
  if (n.includes('roof') || n.includes('shingle') || n.includes('tile') || n.includes('copper') || n.includes('thatch')) return 'roof';
  return 'structure';
}

const TRANSFORMS = [
  (x, z) => [x, z],
  (x, z) => [-z, x],
  (x, z) => [-x, -z],
  (x, z) => [z, -x],
  (x, z) => [-x, z],
  (x, z) => [x, -z],
  (x, z) => [z, x],
  (x, z) => [-z, -x]
];

/**
 * Canonical, rotation/mirror invariant geometry hash.
 * Normalises translation, ignores palette, and hashes material classes plus
 * voxel positions, which makes duplicate detection meaningful.
 */
function geometryHash(blocks, palette) {
  if (!blocks.length) return null;
  let minX = Infinity; let minZ = Infinity;
  for (const [x, , z] of blocks) {
    if (x < minX) minX = x;
    if (z < minZ) minZ = z;
  }
  let best = null;
  for (const transform of TRANSFORMS) {
    const transformed = new Array(blocks.length);
    let i = 0;
    let minTX = Infinity;
    let minTZ = Infinity;
    for (const [x, y, z, p] of blocks) {
      const [tx, tz] = transform(x - minX, z - minZ);
      if (tx < minTX) minTX = tx;
      if (tz < minTZ) minTZ = tz;
      transformed[i++] = [tx, y, tz, classOfBlock(palette[p])];
    }
    // Normalise AFTER the transform: translation and rotation do not commute,
    // so normalising only before the transform would break invariance.
    const entries = transformed.map(([tx, y, tz, cls]) => `${tx - minTX},${y},${tz - minTZ},${cls}`);
    entries.sort();
    const digest = crypto.createHash('sha256').update(entries.join(';')).digest('hex');
    if (best === null || digest < best) best = digest;
  }
  return best.slice(0, 32);
}

/** Exact hash including palette and block indices (for integrity checks). */
function exactHash(blocks, palette) {
  const entries = blocks.map(([x, y, z, p]) => `${x},${y},${z},${formatBlock(palette[p])}`);
  entries.sort();
  return crypto.createHash('sha256').update(entries.join(';')).digest('hex').slice(0, 32);
}

/** Hash of the structural parameters (used to reject palette-only variants). */
function specHash(spec) {
  const structural = {
    archetype: spec.archetype,
    w: spec.w,
    l: spec.l,
    shape: spec.shape,
    floors: spec.floors,
    floorHeight: spec.floorHeight,
    roofType: spec.roofType,
    wallThickness: spec.wallThickness,
    windowPattern: spec.windowPattern,
    doorSide: spec.doorSide,
    towers: spec.towers,
    wings: spec.wings,
    courtyard: spec.courtyard,
    basement: spec.basement,
    decor: spec.decor
  };
  return crypto.createHash('sha256').update(JSON.stringify(structural)).digest('hex').slice(0, 24);
}

module.exports = { blockNameOf, classOfBlock, geometryHash, exactHash, specHash, TRANSFORMS };
