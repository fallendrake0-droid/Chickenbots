'use strict';

const zlib = require('zlib');
const nbt = require('prismarine-nbt');
const { geometryHash, exactHash } = require('../schematics/designHash');
const { parseBlock, formatBlock, placementItem } = require('./blockStates');
const { BlockRegistry } = require('./blockRegistry');
const { toSpongeSchematic } = require('../schematics/format');

const FORMATS = Object.freeze({
  SPONGE: 'sponge-schem',
  LITEMATIC: 'litematic',
  LEGACY: 'mcedit-schematic',
  STRUCTURE: 'vanilla-structure',
  NATIVE: 'chickenbots-json',
  BEDROCK: 'bedrock-structure'
});

function isGzip(buffer) { return buffer && buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b; }
function maybeGunzip(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (!isGzip(buffer)) return { buffer, compressed: false };
  return { buffer: zlib.gunzipSync(buffer), compressed: true };
}
function maybeGzip(buffer) { return zlib.gzipSync(buffer); }

function parseNbt(buffer) {
  const raw = maybeGunzip(buffer);
  const parsed = nbt.parseUncompressed(raw.buffer, 'big');
  return { root: nbt.simplify(parsed), compressed: raw.compressed, parsed };
}

function detectFormat(buffer, filename = '') {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.cbschem')) return FORMATS.NATIVE;
  if (lower.endsWith('.litematic')) return FORMATS.LITEMATIC;
  if (lower.endsWith('.schematic')) return FORMATS.LEGACY;
  if (lower.endsWith('.schem')) return FORMATS.SPONGE;
  if (lower.endsWith('.nbt') || lower.endsWith('.snbt')) return FORMATS.STRUCTURE;
  if (lower.endsWith('.mcstructure')) return FORMATS.BEDROCK;
  try {
    const { root } = parseNbt(buffer);
    if (root.Regions) return FORMATS.LITEMATIC;
    const rootName = root.Schematic || root;
    if (Array.isArray(rootName.Blocks) && rootName.Width) return FORMATS.LEGACY;
    if (rootName.Blocks && typeof rootName.Blocks === 'object') return FORMATS.SPONGE;
    if ((rootName.Palette || rootName.BlockData) && rootName.Width) return FORMATS.SPONGE;
    if (rootName.size && rootName.palette && rootName.blocks) return FORMATS.STRUCTURE;
  } catch (err) {
    return null;
  }
  return null;
}

function finishSchematic({ id, name, palette, blocks, width, height, length, format, warnings = [], blockEntities = {}, metadata = {} }) {
  // Remove air, normalise to the occupied bounding box and deduplicate the
  // palette. Coordinates remain exact.
  const used = [];
  const map = new Map();
  const remapped = [];
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (const [x, y, z, p] of blocks) {
    const entry = palette[p];
    if (!entry) continue;
    const block = parseBlock(entry);
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
    const canonical = formatBlock(block);
    if (!map.has(canonical)) {
      map.set(canonical, used.length);
      used.push(canonical);
    }
    remapped.push([x, y, z, map.get(canonical), 0]);
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const normalized = remapped.map(([x, y, z, p, ph]) => [x - minX, y - minY, z - minZ, p, ph]);
  const dims = {
    width: maxX >= minX ? maxX - minX + 1 : width,
    height: maxY >= minY ? maxY - minY + 1 : height,
    length: maxZ >= minZ ? maxZ - minZ + 1 : length
  };
  const shiftedEntities = {};
  for (const [key, value] of Object.entries(blockEntities || {})) {
    const [x, y, z] = String(key).split(',').map(Number);
    if (![x, y, z].every(Number.isFinite)) continue;
    shiftedEntities[`${x - minX},${y - minY},${z - minZ}`] = value;
  }
  const materials = {};
  for (const [, , , p] of normalized) {
    const name2 = placementItem(parseBlock(used[p]));
    materials[name2] = (materials[name2] || 0) + 1;
  }
  const schematic = {
    id: id || `imported_${Date.now().toString(36)}`,
    name: name || 'Imported schematic',
    tier: 'imported', tierIndex: 0, difficulty: 0,
    category: 'imported', archetype: 'imported', style: 'imported',
    dimensions: dims,
    palette: used,
    blocks: normalized,
    phases: [{ name: 'FOUNDATION', index: 0, blockCount: normalized.length }],
    materials,
    foundation: { depth: 1, material: 'cobblestone', supports: [] },
    supports: [],
    estimatedCost: { blocks: normalized.length, uniqueMaterials: used.length },
    buildPhases: ['FOUNDATION'],
    tags: ['imported', format],
    versionCompatibility: [format],
    structural: { imported: true },
    format,
    sourceOffset: { x: minX, y: minY, z: minZ },
    warnings: [...warnings],
    blockEntities: shiftedEntities
  };
  schematic.geometryHash = geometryHash(schematic.blocks, schematic.palette);
  schematic.exactHash = exactHash(schematic.blocks, schematic.palette);
  return schematic;
}

// ---------------------------------------------------------------------------
// Litematica
// ---------------------------------------------------------------------------
function readPackedLongs(longs, bits, count) {
  if (bits <= 0) return new Array(count).fill(0);
  const values = new Array(count).fill(0);
  const mask = (1n << BigInt(bits)) - 1n;
  const source = longs.map((value) => (typeof value === 'bigint' ? value : BigInt(value)));
  for (let i = 0; i < count; i++) {
    const start = i * bits;
    const arrIndex = Math.floor(start / 64);
    const offset = start % 64;
    let value = source[arrIndex] >> BigInt(offset);
    if (offset + bits > 64) value |= source[arrIndex + 1] << BigInt(64 - offset);
    values[i] = Number(value & mask);
  }
  return values;
}

function writePackedLongs(values, bits) {
  const longs = [];
  let current = 0n;
  let used = 0;
  const mask = (1n << BigInt(bits)) - 1n;
  for (const value of values) {
    const v = BigInt(value) & mask;
    current |= v << BigInt(used);
    used += bits;
    while (used >= 64) {
      longs.push(BigInt.asIntN(64, current));
      current >>= 64n;
      used -= 64;
    }
  }
  if (used > 0) longs.push(BigInt.asIntN(64, current));
  return longs;
}

function paletteDescriptor(entry) {
  if (!entry) return { name: 'air', properties: {} };
  const block = parseBlock(entry);
  const value = { Name: block.name.includes(':') ? block.name : `minecraft:${block.name}` };
  if (Object.keys(block.properties || {}).length) value.Properties = Object.fromEntries(Object.entries(block.properties).map(([k, v]) => [k, String(v)]));
  return value;
}

function fromLitematic(buffer, { id = null, name = null } = {}) {
  const { root } = parseNbt(buffer);
  const regions = root.Regions;
  if (!regions || typeof regions !== 'object') throw new Error('litematic has no Regions');
  const regionEntries = Object.entries(regions);
  if (!regionEntries.length) throw new Error('litematic has no regions');
  const warnings = [];
  const blockEntities = {};
  const palette = [];
  const paletteIndex = new Map();
  const blocks = [];
  for (const [regionName, region] of regionEntries) {
    const position = Array.isArray(region.Position) ? region.Position.map(Number) : [0, 0, 0];
    const sizeRaw = Array.isArray(region.Size) ? region.Size.map(Number) : [0, 0, 0];
    const size = sizeRaw.map((value) => Math.abs(value));
    if (!size[0] || !size[1] || !size[2]) { warnings.push({ kind: 'EMPTY_REGION', region: regionName }); continue; }
    const [sx, sy, sz] = size;
    const regionPalette = region.Palette || {};
    const paletteList = Object.entries(regionPalette)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([key, value]) => ({ key: Number(key), value }));
    if (!paletteList.length) { warnings.push({ kind: 'REGION_WITHOUT_PALETTE', region: regionName }); continue; }
    const byKey = new Map(paletteList.map((entry) => [entry.key, entry.value]));
    const bits = Math.max(1, Math.ceil(Math.log2(paletteList.length)));
    const states = readPackedLongs(region.BlockStates || [], bits, sx * sy * sz);
    // Litematica stores a region's corner in Position and uses a signed Size.
    // A negative component means the block array extends in the negative
    // direction from that corner.
    const base = {
      x: position[0] + (sizeRaw[0] < 0 ? -(sx - 1) : 0),
      y: position[1] + (sizeRaw[1] < 0 ? -(sy - 1) : 0),
      z: position[2] + (sizeRaw[2] < 0 ? -(sz - 1) : 0)
    };
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) {
          const index = (y * sz + z) * sx + x;
          const state = byKey.get(states[index]);
          const block = parseBlock(state);
          if (block.name === 'air') continue;
          const canonical = formatBlock(block);
          if (!paletteIndex.has(canonical)) {
            paletteIndex.set(canonical, palette.length);
            palette.push(Object.keys(block.properties).length ? block : block.name);
          }
          blocks.push([base.x + x, base.y + y, base.z + z, paletteIndex.get(canonical)]);
        }
      }
    }
    if (Array.isArray(region.TileEntities)) {
      for (const entity of region.TileEntities) {
        const pos = entity.pos || entity.Pos || [0, 0, 0];
        blockEntities[`${base.x + Number(pos[0])},${base.y + Number(pos[1])},${base.z + Number(pos[2])}`] = entity;
      }
    }
  }
  const schematic = finishSchematic({
    id, name: name || root.Metadata?.Name || 'Imported litematic',
    palette, blocks, width: 0, height: 0, length: 0,
    format: FORMATS.LITEMATIC, warnings, blockEntities,
    metadata: { author: root.Metadata?.Author, description: root.Metadata?.Description, regions: regionEntries.length }
  });
  schematic.regionCount = regionEntries.length;
  return schematic;
}

function toLitematic(schematic, { author = 'Chickenbots', name = null } = {}) {
  const { width, height, length } = schematic.dimensions;
  const paletteNames = schematic.palette.map(formatBlock);
  const bits = Math.max(1, Math.ceil(Math.log2(paletteNames.length + 1)));
  const indices = new Array(width * height * length).fill(0);
  for (const [x, y, z, p] of schematic.blocks) indices[(y * length + z) * width + x] = p + 1;
  const longs = writePackedLongs(indices, bits);
  const value = {
    type: 'compound',
    name: '',
    value: {
      Version: { type: 'int', value: 6 },
      MinecraftDataVersion: { type: 'int', value: 4786 },
      Metadata: {
        type: 'compound',
        value: {
          Name: { type: 'string', value: name || schematic.name || 'Chickenbots build' },
          Author: { type: 'string', value: author },
          Description: { type: 'string', value: 'Exported by Chickenbots' },
          TimeCreated: { type: 'long', value: BigInt(Date.now()) },
          TimeModified: { type: 'long', value: BigInt(Date.now()) },
          TotalBlocks: { type: 'int', value: schematic.blocks.length },
          TotalVolume: { type: 'int', value: width * height * length }
        }
      },
      Regions: {
        type: 'compound',
        value: {
          Main: {
            type: 'compound',
            value: {
              Position: { type: 'intArray', value: [0, 0, 0] },
              Size: { type: 'intArray', value: [width, height, length] },
              BlockStatePalette: { type: 'list', value: { type: 'compound', value: [] } },
              Palette: {
                type: 'compound',
                value: Object.fromEntries(paletteNames.map((entry, index) => [String(index + 1), {
                  type: 'compound', value: paletteDescriptor(entry).Name ? {
                    Name: { type: 'string', value: paletteDescriptor(entry).Name },
                    ...(paletteDescriptor(entry).Properties ? { Properties: { type: 'compound', value: Object.fromEntries(Object.entries(paletteDescriptor(entry).Properties).map(([k, v]) => [k, { type: 'string', value: v }])) } } : {})
                  } : {}
                }]))
              },
              BlockStates: { type: 'longArray', value: longs },
              TileEntities: { type: 'list', value: { type: 'compound', value: [] } }
            }
          }
        }
      }
    }
  };
  return maybeGzip(Buffer.from(nbt.writeUncompressed(value, 'big')));
}

// ---------------------------------------------------------------------------
// Vanilla structure NBT
// ---------------------------------------------------------------------------
function fromStructureNbt(buffer, { id = null, name = null } = {}) {
  const { root } = parseNbt(buffer);
  const size = root.size || root.Size;
  if (!Array.isArray(size) || size.length !== 3) throw new Error('structure NBT has no size');
  const sourcePalette = root.palette || root.Palette;
  const sourceBlocks = root.blocks || root.Blocks;
  if (!Array.isArray(sourcePalette) || !Array.isArray(sourceBlocks)) throw new Error('structure NBT has no palette/blocks');
  const palette = [];
  const map = new Map();
  for (const entry of sourcePalette) {
    const block = parseBlock(entry);
    const canonical = formatBlock(block);
    if (!map.has(canonical)) { map.set(canonical, palette.length); palette.push(Object.keys(block.properties).length ? block : block.name); }
  }
  const blocks = [];
  const blockEntities = {};
  for (const entry of sourceBlocks) {
    const pos = entry.pos || entry.Pos;
    if (!Array.isArray(pos)) continue;
    const descriptor = sourcePalette[entry.state ?? entry.State ?? 0];
    const block = parseBlock(descriptor);
    if (block.name === 'air') continue;
    blocks.push([pos[0], pos[1], pos[2], map.get(formatBlock(block))]);
    if (entry.nbt) blockEntities[`${pos[0]},${pos[1]},${pos[2]}`] = entry.nbt;
  }
  return finishSchematic({
    id, name: name || root.author || 'Imported structure',
    palette, blocks, width: size[0], height: size[1], length: size[2],
    format: FORMATS.STRUCTURE, blockEntities,
    metadata: { dataVersion: root.DataVersion || null, author: root.author || null }
  });
}

function toStructureNbt(schematic) {
  const paletteNames = schematic.palette.map(formatBlock);
  const value = {
    type: 'compound',
    name: '',
    value: {
      DataVersion: { type: 'int', value: 4786 },
      size: { type: 'list', value: { type: 'int', value: schematic.dimensions ? [schematic.dimensions.width, schematic.dimensions.height, schematic.dimensions.length] : [0, 0, 0] } },
      palette: {
        type: 'list',
        value: {
          type: 'compound',
          value: paletteNames.map((entry) => {
            const descriptor = paletteDescriptor(entry);
            return {
              Name: { type: 'string', value: descriptor.Name },
              ...(descriptor.Properties ? { Properties: { type: 'compound', value: Object.fromEntries(Object.entries(descriptor.Properties).map(([k, v]) => [k, { type: 'string', value: v }])) } } : {})
            };
          })
        }
      },
      blocks: {
        type: 'list',
        value: {
          type: 'compound',
          value: schematic.blocks.map(([x, y, z, p]) => ({
            pos: { type: 'list', value: { type: 'int', value: [x, y, z] } },
            state: { type: 'int', value: p }
          }))
        }
      },
      entities: { type: 'list', value: { type: 'compound', value: [] } }
    }
  };
  return maybeGzip(Buffer.from(nbt.writeUncompressed(value, 'big')));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function importSchematic(buffer, { filename = '', format = null, id = null, name = null, registry = null } = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (!buffer.length) return { ok: false, error: 'empty file', format: null };
  const detected = format || detectFormat(buffer, filename);
  if (!detected) return { ok: false, error: 'unrecognised schematic format (supported: .schem v1-v3, .litematic, .schematic, vanilla .nbt)', format: null };
  if (detected === FORMATS.BEDROCK) {
    return { ok: false, error: 'Bedrock .mcstructure is not supported by the Java importer; export as .schem or .litematic instead', format: detected };
  }
  if (detected === FORMATS.NATIVE) {
    let json;
    try { json = JSON.parse(buffer.toString('utf8')); } catch (err) { return { ok: false, error: `invalid JSON: ${err.message}`, format: detected }; }
    if (!json || !Array.isArray(json.palette) || !Array.isArray(json.blocks)) return { ok: false, error: 'native schematic needs palette and blocks arrays', format: detected };
    const schematic = { ...json };
    schematic.id = id || json.id || `imported_${Date.now().toString(36)}`;
    schematic.name = name || json.name || 'Imported schematic';
    schematic.format = FORMATS.NATIVE;
    schematic.geometryHash = geometryHash(schematic.blocks, schematic.palette);
    schematic.exactHash = exactHash(schematic.blocks, schematic.palette);
    return { ok: true, schematic, format: detected, warnings: [] };
  }
  let schematic;
  try {
    if (detected === FORMATS.LITEMATIC) schematic = fromLitematic(buffer, { id, name });
    else if (detected === FORMATS.STRUCTURE) schematic = fromStructureNbt(buffer, { id, name });
    else if (detected === FORMATS.LEGACY) {
      const { fromLegacySchematic } = require('../schematics/format');
      schematic = fromLegacySchematic(buffer, { id });
      if (name) schematic.name = name;
      schematic.format = FORMATS.LEGACY;
    } else {
      const { fromSpongeSchematic } = require('../schematics/format');
      schematic = fromSpongeSchematic(buffer, { id, name });
      schematic.format = FORMATS.SPONGE;
    }
  } catch (err) {
    return { ok: false, error: `${detected} import failed: ${err.message}`, format: detected };
  }
  const reg = registry || new BlockRegistry({ version: null });
  const warnings = [...(schematic.warnings || [])];
  const invalid = [];
  if (reg.loaded) {
    const seen = new Set();
    for (const entry of schematic.palette) {
      const key = formatBlock(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      const check = reg.validate(entry);
      if (!check.ok) invalid.push({ block: key, errors: check.errors });
    }
    if (invalid.length) warnings.push({
      kind: 'UNKNOWN_BLOCKS',
      detail: `${invalid.length} palette entries are not in minecraft-data ${reg.version}; placement will refuse them rather than guess`,
      blocks: invalid.slice(0, 25)
    });
  }
  return {
    ok: true,
    schematic,
    format: detected,
    warnings,
    invalidBlocks: invalid.length,
    registry: reg.describe(),
    stats: {
      blocks: schematic.blocks.length,
      palette: schematic.palette.length,
      uniqueMaterials: Object.keys(schematic.materials || {}).length,
      dimensions: schematic.dimensions,
      geometryHash: schematic.geometryHash,
      exactHash: schematic.exactHash
    }
  };
}

function exportSchematic(schematic, format = FORMATS.SPONGE, options = {}) {
  if (format === FORMATS.SPONGE) return { buffer: toSpongeSchematic(schematic, options), format, extension: '.schem' };
  if (format === FORMATS.LITEMATIC) return { buffer: toLitematic(schematic, options), format, extension: '.litematic' };
  if (format === FORMATS.STRUCTURE) return { buffer: toStructureNbt(schematic, options), format, extension: '.nbt' };
  if (format === FORMATS.NATIVE) return { buffer: Buffer.from(JSON.stringify(schematic, null, 2)), format, extension: '.json' };
  if (format === FORMATS.LEGACY) {
    const { toLegacySchematic } = require('../schematics/format');
    const result = toLegacySchematic(schematic);
    return { ...result, format, extension: '.schematic' };
  }
  throw new Error(`cannot export ${format}`);
}

module.exports = {
  FORMATS, detectFormat, importSchematic, exportSchematic,
  fromLitematic, toLitematic, fromStructureNbt, toStructureNbt,
  readPackedLongs, writePackedLongs, finishSchematic, maybeGunzip, parseNbt
};
