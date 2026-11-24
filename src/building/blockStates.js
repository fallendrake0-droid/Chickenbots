'use strict';

/**
 * Block-state handling for construction.
 *
 * A palette entry is either a legacy block name (`oak_stairs`) or a full
 * descriptor (`oak_stairs[facing=east,half=top]` / `{name, properties}`).
 * Schematics are kept in this compact form, but every placement and every
 * verification compares the canonical name + properties, never just the name.
 */

const AIR = new Set(['air', 'cave_air', 'void_air']);
const HORIZONTAL = ['north', 'east', 'south', 'west'];
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

function stripNamespace(name) {
  return String(name || '').replace(/^minecraft:/, '');
}

function parseProperties(text) {
  const properties = {};
  if (!text) return properties;
  for (const part of String(text).split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    if (value === 'true' || value === 'false') properties[key] = value === 'true';
    else if (/^-?\d+$/.test(value)) properties[key] = Number(value);
    else properties[key] = value;
  }
  return properties;
}

/** Parse any of the palette shapes used by the project and by NBT readers. */
function parseBlock(value, properties = null) {
  if (value == null) return { name: 'air', properties: {} };
  if (typeof value === 'string') {
    const raw = value.trim();
    const open = raw.indexOf('[');
    if (open === -1) return { name: stripNamespace(raw), properties: properties ? { ...properties } : {} };
    const close = raw.lastIndexOf(']');
    const name = stripNamespace(raw.slice(0, open));
    const text = raw.slice(open + 1, close === -1 ? raw.length : close);
    return { name, properties: parseProperties(text), raw };
  }
  if (Array.isArray(value)) return parseBlock(value[0]);
  const name = value.name || value.Name || value.id || value.block || 'air';
  const props = value.properties || value.Properties || properties || {};
  const out = {};
  for (const [key, val] of Object.entries(props)) {
    if (val === 'true' || val === 'false') out[key] = val === 'true';
    else if (typeof val === 'string' && /^-?\d+$/.test(val)) out[key] = Number(val);
    else out[key] = val;
  }
  return { name: stripNamespace(name), properties: out, raw: value.raw };
}

function canonicalProperties(properties = {}) {
  const out = {};
  for (const key of Object.keys(properties).sort()) {
    const val = properties[key];
    if (val === undefined || val === null) continue;
    out[key] = val;
  }
  return out;
}

function formatBlock(value) {
  const block = parseBlock(value);
  const keys = Object.keys(canonicalProperties(block.properties));
  if (!keys.length) return block.name;
  return `${block.name}[${keys.map((key) => `${key}=${block.properties[key]}`).join(',')}]`;
}

function blockKey(value) {
  const block = parseBlock(value);
  return formatBlock(block);
}

function isAir(value) {
  return AIR.has(parseBlock(value).name);
}

function sameProperties(actual = {}, expected = {}) {
  for (const [key, value] of Object.entries(expected)) {
    if (String(actual[key]) !== String(value)) return false;
  }
  return true;
}

/** True when the observed world block satisfies the blueprint block. */
function matchesBlock(observed, expected) {
  if (!observed) return false;
  const want = parseBlock(expected);
  const got = typeof observed === 'string' ? parseBlock(observed) : parseBlock(observed);
  if (want.name !== got.name) return false;
  return sameProperties(got.properties, want.properties);
}

function rotateFacing(face, turns = 1) {
  let value = face;
  const n = ((Number(turns) || 0) % 4 + 4) % 4;
  for (let i = 0; i < n; i++) value = CW[value] || value;
  return value;
}

function mirrorFacing(face, axis = 'x') {
  if (axis === 'x') return { east: 'west', west: 'east' }[face] || face;
  return { north: 'south', south: 'north' }[face] || face;
}

function rotateConnectionKey(key, turns) {
  // keys are compass names; rotate the name and leave the boolean in place.
  return rotateFacing(key, turns);
}

function mirrorConnectionKey(key, axis) {
  return mirrorFacing(key, axis);
}

function transformAxes(properties, turns, mirror) {
  const out = { ...properties };
  if (turns) {
    for (const key of ['facing', 'orientation', 'vertical_direction', 'attachment_face', 'face']) {
      if (HORIZONTAL.includes(out[key])) out[key] = rotateFacing(out[key], turns);
    }
    if (out.axis === 'x') out.axis = 'z';
    else if (out.axis === 'z') out.axis = 'x';
    if (Number.isFinite(out.rotation)) out.rotation = (out.rotation + 4 * turns) % 16;
    // Rotation preserves handedness relative to `facing`; mirroring flips it.
    // Connection booleans (fences, walls, redstone dust, glass panes).
    const connections = {};
    for (const side of HORIZONTAL) if (Object.prototype.hasOwnProperty.call(out, side)) connections[side] = out[side];
    if (Object.keys(connections).length) {
      for (const side of HORIZONTAL) delete out[side];
      for (const [side, value] of Object.entries(connections)) out[rotateConnectionKey(side, turns)] = value;
    }
  }
  if (mirror === 'x' || mirror === 'z') {
    for (const key of ['facing', 'orientation', 'attachment_face', 'face']) {
      if (HORIZONTAL.includes(out[key])) out[key] = mirrorFacing(out[key], mirror);
    }
    if (out.hinge === 'left') out.hinge = 'right';
    else if (out.hinge === 'right') out.hinge = 'left';
    if (out.shape === 'inner_left') out.shape = 'inner_right';
    else if (out.shape === 'inner_right') out.shape = 'inner_left';
    else if (out.shape === 'outer_left') out.shape = 'outer_right';
    else if (out.shape === 'outer_right') out.shape = 'outer_left';
    const connections = {};
    for (const side of HORIZONTAL) if (Object.prototype.hasOwnProperty.call(out, side)) connections[side] = out[side];
    if (Object.keys(connections).length) {
      for (const side of HORIZONTAL) delete out[side];
      for (const [side, value] of Object.entries(connections)) out[mirrorConnectionKey(side, mirror)] = value;
    }
    if (Number.isFinite(out.rotation)) {
      // The 16-step rotation used by rails/repeaters is clockwise. Reflecting
      // it is equivalent to negating the angle (mod 16).
      out.rotation = (16 - out.rotation) % 16;
    }
  }
  return out;
}

/** Rotate one palette block descriptor. */
function rotateBlock(value, turns = 1) {
  const block = parseBlock(value);
  const n = ((Number(turns) || 0) % 4 + 4) % 4;
  if (!n) return block;
  return { name: block.name, properties: transformAxes(block.properties, n, null) };
}

/** Mirror one palette block descriptor across the x or z axis. */
function mirrorBlock(value, axis = 'x') {
  const block = parseBlock(value);
  if (axis !== 'x' && axis !== 'z') return block;
  return { name: block.name, properties: transformAxes(block.properties, 0, axis) };
}

/** Coordinate transform used by both format.js and the build engine. */
function rotatePosition(x, z, width, length, turns = 1) {
  let px = x; let pz = z; let w = width; let l = length;
  const n = ((Number(turns) || 0) % 4 + 4) % 4;
  for (let i = 0; i < n; i++) {
    const nx = l - 1 - pz;
    const nz = px;
    px = nx; pz = nz;
    const nw = l; l = w; w = nw;
  }
  return { x: px, z: pz, width: w, length: l };
}

function mirrorPosition(x, z, width, length, axis = 'x') {
  return axis === 'x' ? { x: width - 1 - x, z } : { x, z: length - 1 - z };
}

/** Item that must be held to obtain this block. */
function placementItem(value) {
  const block = parseBlock(value);
  const name = block.name;
  if (name === 'water' || name === 'flowing_water') return 'water_bucket';
  if (name === 'lava' || name === 'flowing_lava') return 'lava_bucket';
  if (name === 'wheat') return 'wheat_seeds';
  if (name === 'carrots') return 'carrot';
  if (name === 'potatoes') return 'potato';
  if (name === 'beetroots') return 'beetroot_seeds';
  if (name === 'nether_wart') return 'nether_wart';
  if (name === 'cocoa') return 'cocoa_beans';
  if (name === 'sweet_berry_bush') return 'sweet_berries';
  if (name === 'cave_vines' || name === 'cave_vines_plant') return 'glow_berries';
  if (name === 'tripwire') return 'string';
  if (name === 'redstone_wire') return 'redstone';
  if (name.endsWith('_wall_torch')) return name.replace('_wall_torch', '_torch');
  if (name.endsWith('_wall_sign')) return name.replace('_wall_sign', '_sign');
  if (name.endsWith('_hanging_sign')) return name.replace(/_hanging_sign$/, '_hanging_sign');
  if (name.endsWith('_bed')) return name;
  if (name.endsWith('_door')) return name;
  if (name === 'potted_oak_sapling' || name.startsWith('potted_')) return name.replace(/^potted_/, '');
  if (name === 'farmland') return 'dirt';
  if (name === 'dirt_path') return 'dirt';
  if (name === 'grass_block') return 'grass_block';
  if (name === 'snow') return 'snow';
  if (name === 'big_dripleaf_stem') return 'big_dripleaf';
  if (name === 'tall_grass') return 'short_grass';
  if (name === 'wall_torch') return 'torch';
  return name;
}

function isDoubleBlock(value) {
  const { name } = parseBlock(value);
  return name.endsWith('_door') || name.endsWith('_bed') || name === 'tall_grass' || name === 'large_fern'
    || name === 'tall_seagrass' || name === 'sunflower' || name === 'lilac' || name === 'rose_bush' || name === 'peony';
}

module.exports = {
  AIR, HORIZONTAL, CW, CCW, OPPOSITE,
  parseBlock, formatBlock, blockKey, canonicalProperties, parseProperties,
  isAir, matchesBlock, sameProperties,
  rotateBlock, mirrorBlock, rotatePosition, mirrorPosition,
  rotateFacing, mirrorFacing, transformAxes, placementItem, isDoubleBlock
};
