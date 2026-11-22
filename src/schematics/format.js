'use strict';

const zlib = require('zlib');
const nbt = require('prismarine-nbt');
const { geometryHash, exactHash } = require('./designHash');
const { PHASES } = require('./blockGrid');

/** Legacy numeric ids used by MCEdit .schematic files. Only these blocks can be
 * exported losslessly; anything else is reported as substituted. */
const LEGACY_IDS = {
  air: 0, stone: 1, grass_block: 2, dirt: 3, cobblestone: 4, oak_planks: 5, bedrock: 7,
  water: 9, lava: 11, sand: 12, gravel: 13, oak_log: 17, oak_leaves: 18, glass: 20,
  sandstone: 24, white_wool: 35, dandelion: 37, poppy: 38, bricks: 45, bookshelf: 47,
  torch: 50, chest: 54, crafting_table: 58, furnace: 61, oak_stairs: 53, oak_slab: 44,
  stone_bricks: 98, glass_pane: 102, cobblestone_wall: 139, iron_bars: 101,
  nether_bricks: 112, quartz_block: 155, sea_lantern: 169, terracotta: 172,
  white_terracotta: 159
};
const LEGACY_BY_ID = {};
for (const [name, id] of Object.entries(LEGACY_IDS)) if (!(id in LEGACY_BY_ID)) LEGACY_BY_ID[id] = name;
const signedByte = (v) => (v > 127 ? v - 256 : v);
const unsignedByte = (v) => v & 0xff;

function rotateSchematic(schematic, quarterTurns = 1) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  let blocks = schematic.blocks.map((b) => b.slice());
  let { width, height, length } = schematic.dimensions;
  for (let t = 0; t < turns; t++) {
    blocks = blocks.map(([x, y, z, p, ph]) => [length - 1 - z, y, x, p, ph]);
    const nextW = length;
    length = width;
    width = nextW;
  }
  return finalize({
    ...schematic,
    dimensions: { width, height, length },
    blocks,
    rotation: turns * 90,
    structural: { ...schematic.structural, rotated: turns * 90 }
  });
}

function mirrorSchematic(schematic, axis = 'x') {
  const { width, length } = schematic.dimensions;
  const blocks = schematic.blocks.map(([x, y, z, p, ph]) => (axis === 'x' ? [width - 1 - x, y, z, p, ph] : [x, y, z, length - 1 - z, p, ph]));
  return finalize({ ...schematic, blocks, mirrored: axis });
}

function translateSchematic(schematic, dx, dy, dz) {
  const blocks = schematic.blocks.map(([x, y, z, p, ph]) => [x + dx, y + dy, z + dz, p, ph]);
  return finalize({ ...schematic, blocks });
}

function substituteMaterials(schematic, mapping) {
  const palette = schematic.palette.map((name) => mapping[name] || name);
  const materials = {};
  for (const b of schematic.blocks) {
    const name = palette[b[3]];
    materials[name] = (materials[name] || 0) + 1;
  }
  return finalize({ ...schematic, palette, materials, materialSubstitutions: Object.keys(mapping) });
}

function finalize(schematic) {
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (const [x, y, z] of schematic.blocks) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const blocks = schematic.blocks.map(([x, y, z, p, ph]) => [x - minX, y - minY, z - minZ, p, ph]);
  const dimensions = { width: maxX - minX + 1, height: maxY - minY + 1, length: maxZ - minZ + 1 };
  const materials = {};
  for (const b of blocks) {
    const name = schematic.palette[b[3]];
    materials[name] = (materials[name] || 0) + 1;
  }
  return {
    ...schematic,
    blocks,
    dimensions,
    materials,
    geometryHash: geometryHash(blocks, schematic.palette),
    exactHash: exactHash(blocks, schematic.palette),
    estimatedCost: { blocks: blocks.length, uniqueMaterials: schematic.palette.length }
  };
}

function varintEncode(values) {
  const out = [];
  for (const value of values) {
    let v = value;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      out.push(byte);
    } while (v !== 0);
  }
  return out;
}

function varintDecode(bytes) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const byte of bytes) {
    value |= (byte & 0x7f) << shift;
    if (byte & 0x80) {
      shift += 7;
    } else {
      out.push(value >>> 0);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

function blockIndex(x, y, z, dims) {
  return (y * dims.length + z) * dims.width + x;
}

/** Export Sponge schematic v2 (.schem, gzip-compressed NBT). */
function toSpongeSchematic(schematic, { author = 'Chickenbots', dataVersion = 4189 } = {}) {
  const { width, height, length } = schematic.dimensions;
  const namespaced = schematic.palette.map((name) => (name.includes(':') ? name : `minecraft:${name}`));
  const paletteNames = ['minecraft:air', ...namespaced];
  const palette = {};
  paletteNames.forEach((name, i) => { palette[name] = i; });
  const indices = new Array(width * height * length).fill(0);
  for (const [x, y, z, p] of schematic.blocks) indices[blockIndex(x, y, z, { width, length })] = p + 1;
  const blockData = varintEncode(indices).map(signedByte);
  const value = {
    type: 'compound',
    name: 'Schematic',
    value: {
      Version: { type: 'int', value: 2 },
      DataVersion: { type: 'int', value: dataVersion },
      Width: { type: 'short', value: width },
      Height: { type: 'short', value: height },
      Length: { type: 'short', value: length },
      Offset: { type: 'intArray', value: [0, 0, 0] },
      Metadata: {
        type: 'compound',
        value: {
          Name: { type: 'string', value: schematic.name || schematic.id || 'chickenbots' },
          Author: { type: 'string', value: author },
          Description: { type: 'string', value: `Chickenbots schematic ${schematic.id || ''}` }
        }
      },
      PaletteMax: { type: 'int', value: paletteNames.length },
      Palette: { type: 'compound', value: Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, { type: 'int', value: v }])) },
      BlockData: { type: 'byteArray', value: blockData }
    }
  };
  const raw = nbt.writeUncompressed(value, 'big');
  return zlib.gzipSync(raw);
}

/** Parse Sponge schematic v2/v3 data into a Chickenbots schematic object. */
function fromSpongeSchematic(buffer, { id = null, name = null } = {}) {
  const raw = zlib.gunzipSync(buffer);
  const parsed = nbt.parseUncompressed(raw, 'big');
  const simplified = nbt.simplify(parsed);
  const root = simplified.Schematic || simplified;
  const width = root.Width;
  const height = root.Height;
  const length = root.Length;
  if (!(width > 0 && height > 0 && length > 0)) throw new Error('invalid schematic dimensions');
  let paletteArray;
  let indices;
  if (root.Blocks && root.Blocks.Palette) {
    // Sponge v3
    paletteArray = Object.entries(root.Blocks.Palette).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    indices = root.Blocks.Data;
  } else {
    paletteArray = Object.entries(root.Palette).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    indices = root.BlockData;
  }
  paletteArray = paletteArray.map((name) => name.replace(/^minecraft:/, ''));
  if (!Array.isArray(indices)) throw new Error('missing block data');
  const decoded = varintDecode(indices);
  const blocks = [];
  const materials = {};
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const p = decoded[blockIndex(x, y, z, { width, length })] || 0;
        const blockName = paletteArray[p];
        if (!blockName || blockName === 'air') continue;
        blocks.push([x, y, z, p, 0]);
        materials[blockName] = (materials[blockName] || 0) + 1;
      }
    }
  }
  // Re-index palette to only used entries.
  const used = [...new Set(blocks.map((b) => paletteArray[b[3]]))].sort();
  const mapIndex = new Map(used.map((n, i) => [n, i]));
  const palette = used;
  for (const b of blocks) b[3] = mapIndex.get(paletteArray[b[3]]);
  const schematic = {
    id: id || `imported_${Date.now().toString(36)}`,
    name: name || root.Metadata?.Name || 'Imported schematic',
    tier: 'imported',
    tierIndex: 0,
    difficulty: 0,
    category: 'imported',
    archetype: 'imported',
    style: 'imported',
    dimensions: { width, height, length },
    palette,
    blocks,
    phases: [{ name: 'FOUNDATION', index: 0, blockCount: blocks.length }],
    materials,
    foundation: { depth: 1, material: 'cobblestone', supports: [] },
    supports: [],
    estimatedCost: { blocks: blocks.length, uniqueMaterials: palette.length },
    buildPhases: ['FOUNDATION'],
    tags: ['imported'],
    versionCompatibility: ['sponge-schem-v2'],
    structural: { imported: true },
    dataVersion: root.DataVersion || null
  };
  schematic.geometryHash = geometryHash(schematic.blocks, schematic.palette);
  schematic.exactHash = exactHash(schematic.blocks, schematic.palette);
  return schematic;
}

/** Export a legacy MCEdit .schematic. Unsupported blocks are substituted with
 * stone and reported; this format is intentionally best-effort. */
function toLegacySchematic(schematic) {
  const { width, height, length } = schematic.dimensions;
  const blocks = new Array(width * height * length).fill(0);
  const data = new Array(width * height * length).fill(0);
  const substituted = {};
  for (const [x, y, z, p] of schematic.blocks) {
    const name = schematic.palette[p];
    const id = LEGACY_IDS[name];
    const idx = blockIndex(x, y, z, { width, length });
    if (id === undefined) { blocks[idx] = 1; substituted[name] = (substituted[name] || 0) + 1; }
    else blocks[idx] = id;
  }
  const value = {
    type: 'compound',
    name: 'Schematic',
    value: {
      Width: { type: 'short', value: width },
      Height: { type: 'short', value: height },
      Length: { type: 'short', value: length },
      Materials: { type: 'string', value: 'Alpha' },
      Blocks: { type: 'byteArray', value: blocks.map(signedByte) },
      Data: { type: 'byteArray', value: data.map(signedByte) },
      Entities: { type: 'list', value: { type: 'compound', value: [] } },
      TileEntities: { type: 'list', value: { type: 'compound', value: [] } }
    }
  };
  return { buffer: zlib.gzipSync(nbt.writeUncompressed(value, 'big')), substituted };
}

function fromLegacySchematic(buffer, { id = null } = {}) {
  const raw = zlib.gunzipSync(buffer);
  const simplified = nbt.simplify(nbt.parseUncompressed(raw, 'big'));
  const root = simplified.Schematic || simplified;
  const { Width: width, Height: height, Length: length } = root;
  const ids = root.Blocks;
  const blocks = [];
  const materials = {};
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idn = unsignedByte(ids[blockIndex(x, y, z, { width, length })]);
        const name = LEGACY_BY_ID[idn];
        if (!name || name === 'air') continue;
        blocks.push([x, y, z, 0, 0]);
        materials[name] = (materials[name] || 0) + 1;
      }
    }
  }
  const palette = [...new Set(blocks.map((b) => {
    const idx = blockIndex(b[0], b[1], b[2], { width, length });
    return LEGACY_BY_ID[unsignedByte(ids[idx])];
  }))].sort();
  const mapIndex = new Map(palette.map((n, i) => [n, i]));
  for (const b of blocks) b[3] = mapIndex.get(LEGACY_BY_ID[unsignedByte(ids[blockIndex(b[0], b[1], b[2], { width, length })])]);
  const schematic = {
    id: id || `legacy_${Date.now().toString(36)}`,
    name: 'Imported legacy schematic',
    tier: 'imported', tierIndex: 0, difficulty: 0, category: 'imported',
    archetype: 'imported', style: 'imported',
    dimensions: { width, height, length },
    palette, blocks,
    phases: [{ name: 'FOUNDATION', index: 0, blockCount: blocks.length }],
    materials,
    foundation: { depth: 1, material: 'cobblestone', supports: [] },
    supports: [],
    estimatedCost: { blocks: blocks.length, uniqueMaterials: palette.length },
    buildPhases: ['FOUNDATION'],
    tags: ['imported', 'legacy'],
    versionCompatibility: ['mcedit-schematic'],
    structural: { imported: true }
  };
  schematic.geometryHash = geometryHash(schematic.blocks, schematic.palette);
  schematic.exactHash = exactHash(schematic.blocks, schematic.palette);
  return schematic;
}

function materialList(schematic, { limit = 40 } = {}) {
  return Object.entries(schematic.materials || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/** Group blocks by build phase: foundation -> walls -> roof -> interior. */
function phaseBlocks(schematic) {
  const phaseNames = schematic.phases && schematic.phases.length
    ? schematic.phases.map((p) => p.name)
    : PHASES;
  const groups = new Map();
  for (const [x, y, z, p, phase] of schematic.blocks) {
    const name = phaseNames[phase] || phaseNames[0] || 'FOUNDATION';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ x, y, z, block: schematic.palette[p] });
  }
  return groups;
}

function toJSON(schematic) {
  return {
    id: schematic.id,
    name: schematic.name,
    tier: schematic.tier,
    category: schematic.category,
    dimensions: schematic.dimensions,
    palette: schematic.palette,
    blocks: schematic.blocks,
    phases: schematic.phases,
    materials: schematic.materials,
    geometryHash: schematic.geometryHash,
    exactHash: schematic.exactHash
  };
}

function fromJSON(json) {
  const schematic = { ...json };
  schematic.geometryHash = geometryHash(schematic.blocks, schematic.palette);
  schematic.exactHash = exactHash(schematic.blocks, schematic.palette);
  return schematic;
}

module.exports = {
  LEGACY_IDS, LEGACY_BY_ID,
  rotateSchematic, mirrorSchematic, translateSchematic, substituteMaterials,
  toSpongeSchematic, fromSpongeSchematic, toLegacySchematic, fromLegacySchematic,
  varintEncode, varintDecode, blockIndex, materialList, phaseBlocks, toJSON, fromJSON,
  finalize
};
