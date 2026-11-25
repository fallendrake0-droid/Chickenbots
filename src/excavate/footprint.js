'use strict';

const { boxVolume, clone } = require('../util/vec');

/** Build excavation bounds from explicit coordinates.
 * The coordinate is the LOWER corner; the box extends +X, +Y and +Z. */
function boxFromLowerCorner(origin, width, length, depth) {
  if (!(width > 0 && length > 0 && depth > 0)) throw new Error('width, length and depth must be positive');
  return {
    min: { x: origin.x, y: origin.y, z: origin.z },
    max: { x: origin.x + width - 1, y: origin.y + depth - 1, z: origin.z + length - 1 }
  };
}

/** Build bounds from a bot's feet position: the top layer is the feet level and
 * the excavation extends DOWN by `depth` layers. */
function boxFromFeet(origin, width, length, depth) {
  if (!(width > 0 && length > 0 && depth > 0)) throw new Error('width, length and depth must be positive');
  return {
    min: { x: origin.x, y: origin.y - depth + 1, z: origin.z },
    max: { x: origin.x + width - 1, y: origin.y, z: origin.z + length - 1 }
  };
}

function circleCells(center, radius) {
  const cells = [];
  const r = Math.floor(radius);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz <= r * r + r) cells.push({ x: center.x + dx, z: center.z + dz });
    }
  }
  return cells;
}

function radiusPlan({ origin, radius, depth, shape = 'circle' }) {
  if (!(radius > 0) || !(depth > 0)) throw new Error('radius and depth must be positive');
  const r = Math.ceil(radius);
  const bounds = {
    min: { x: origin.x - r, y: origin.y - depth + 1, z: origin.z - r },
    max: { x: origin.x + r, y: origin.y, z: origin.z + r }
  };
  const cells = circleCells(origin, radius);
  const volume = cells.length * depth;
  return {
    mode: 'RADIUS',
    bounds,
    center: { x: origin.x, y: origin.y, z: origin.z },
    radius,
    shape,
    depth,
    footprint: { width: 2 * r + 1, length: 2 * r + 1 },
    volume,
    mask: 'radius',
    orientation: { extendsX: '±', extendsZ: '±', down: depth },
    notes: [`circular footprint: ${cells.length} columns, radius ${radius}`]
  };
}

function boxPlan({ mode, origin, width, length, depth, anchored = 'lower', extra = {} }) {
  const bounds = anchored === 'feet'
    ? boxFromFeet(origin, width, length, depth)
    : boxFromLowerCorner(origin, width, length, depth);
  return {
    mode,
    bounds,
    origin: clone(bounds.min),
    depth,
    footprint: { width, length },
    volume: boxVolume(bounds.min, bounds.max),
    mask: 'box',
    anchored,
    orientation: { extendsX: `+${width}`, extendsZ: `+${length}`, down: depth },
    notes: [],
    ...extra
  };
}

/** Terraced quarry: staged rings, one 3-wide access ramp on the +X wall. */
function quarryPlan({ origin, width, length, depth }) {
  if (width < 3 || length < 3) throw new Error('quarry needs width and length >= 3');
  const plan = boxPlan({ mode: 'QUARRY', origin, width, length, depth, anchored: 'lower' });
  const tierHeight = Math.max(2, Math.min(4, Math.floor(depth / 3) || 2));
  const tiers = [];
  for (let y = 0, inset = 0; y < depth; y += tierHeight, inset++) {
    const w = width - inset * 2;
    const l = length - inset * 2;
    if (w < 2 || l < 2) break;
    tiers.push({ level: tiers.length, inset, yOffset: y, height: Math.min(tierHeight, depth - y), width: w, length: l });
  }
  plan.tiers = tiers;
  plan.tierHeight = tierHeight;
  plan.volume = tiers.reduce((sum, t) => sum + t.width * t.length * t.height, 0);
  plan.ramp = {
    width: Math.min(3, width),
    side: '+X',
    from: { x: plan.bounds.max.x - Math.min(2, width - 1), y: plan.bounds.max.y, z: plan.bounds.min.z },
    to: { x: plan.bounds.max.x, y: plan.bounds.min.y, z: plan.bounds.min.z + Math.min(3, length) - 1 },
    note: 'descending 3-wide ramp cut into the +X wall; one block fall per two blocks forward'
  };
  plan.notes.push(`terraced quarry: ${tiers.length} tiers of ${tierHeight} blocks`, 'access ramp on +X face');
  return plan;
}

function trenchPlan({ origin, length, width, depth }) {
  if (length < 2) throw new Error('trench needs length >= 2');
  // A trench runs along +X for `length`; its `width` is the Z extent.
  const plan = boxPlan({ mode: 'TRENCH', origin, width: length, length: width, depth, anchored: 'lower' });
  plan.footprint = { width: length, length: width };
  plan.notes.push(`trench along +X for ${length} blocks`, 'exit steps recommended at both ends');
  plan.exitSteps = [
    { x: origin.x, y: origin.y, z: origin.z },
    { x: origin.x + length - 1, y: origin.y, z: origin.z + width - 1 }
  ];
  return plan;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Terrain flattening plan. `surfaceAt(x,z)` must return the highest solid block
 * y for a column (or null if unknown). The target height is the median surface
 * of the footprint.
 */
function flattenPlan({ origin, width, length, surfaceAt, maxSearch = 320 }) {
  if (typeof surfaceAt !== 'function') throw new Error('surfaceAt(x,z) is required');
  if (!(width > 0 && length > 0)) throw new Error('width and length must be positive');
  const heights = [];
  const columns = [];
  let sampled = 0;
  let budgetExceeded = false;
  const step = Math.max(1, Math.ceil(Math.sqrt((width * length) / maxSearch)));
  for (let dz = 0; dz < length; dz += step) {
    for (let dx = 0; dx < width; dx += step) {
      if (sampled >= maxSearch) { budgetExceeded = true; break; }
      const h = surfaceAt(origin.x + dx, origin.z + dz);
      sampled++;
      if (Number.isFinite(h)) { heights.push(h); columns.push({ x: origin.x + dx, z: origin.z + dz, h }); }
    }
    if (budgetExceeded) break;
  }
  if (!heights.length) throw new Error('surfaceAt returned no finite terrain heights');
  const targetY = median(heights);
  const removals = columns.filter((c) => c.h > targetY).reduce((s, c) => s + (c.h - targetY), 0);
  const fills = columns.filter((c) => c.h < targetY).reduce((s, c) => s + (targetY - c.h), 0);
  const scale = columns.length ? (width * length) / columns.length : 1;
  const minY = targetY;
  const maxY = heights.length ? Math.max(...heights) : targetY;
  const bounds = {
    min: { x: origin.x, y: Math.min(minY, maxY), z: origin.z },
    max: { x: origin.x + width - 1, y: maxY, z: origin.z + length - 1 }
  };
  return {
    mode: 'FLATTEN',
    bounds,
    origin: { x: origin.x, y: minY, z: origin.z },
    footprint: { width, length },
    depth: Math.max(0, maxY - minY + 1),
    targetY,
    volume: removals,
    estimatedRemovals: Math.round(removals * scale),
    estimatedFill: Math.round(fills),
    sampled,
    sampledStride: step,
    sampleCoverage: columns.length ? Math.min(1, (columns.length * step * step) / (width * length)) : 0,
    mask: 'box',
    orientation: { extendsX: `+${width}`, extendsZ: `+${length}`, down: 'to median surface' },
    notes: [
      `target height ${targetY} (median of ${heights.length} samples, stride ${step})`,
      `fill required below target: ~${Math.round(fills * scale)} blocks`,
      budgetExceeded ? 'sample budget reached: terrain analysis is sampled, not exhaustive' : 'terrain evaluated over the whole footprint'
    ]
  };
}

/**
 * Foundation excavation for a schematic.
 * `schematic.dimensions` gives width/height/length; `schematic.foundation`
 * gives the required depth (default 2).
 */
function foundationPlan({ schematic, origin, surfaceAt, depthOverride = null, padding = 0 }) {
  if (!schematic || !schematic.dimensions) throw new Error('schematic with dimensions is required');
  const width = schematic.dimensions.width + padding * 2;
  const length = schematic.dimensions.length + padding * 2;
  const depth = depthOverride || (schematic.foundation && schematic.foundation.depth) || 2;
  const heights = [];
  if (typeof surfaceAt === 'function') {
    for (let dz = 0; dz < length; dz += Math.max(1, Math.ceil(length / 24))) {
      for (let dx = 0; dx < width; dx += Math.max(1, Math.ceil(width / 24))) {
        const h = surfaceAt(origin.x + dx, origin.z + dz);
        if (Number.isFinite(h)) heights.push(h);
      }
    }
  }
  const referenceY = heights.length ? median(heights) : origin.y;
  const plan = boxPlan({
    mode: 'FOUNDATION',
    origin: { x: origin.x, y: referenceY, z: origin.z },
    width,
    length,
    depth,
    anchored: 'feet'
  });
  plan.schematicId = schematic.id;
  plan.schematicName = schematic.name;
  plan.referenceY = referenceY;
  plan.notes.push(
    `foundation for ${schematic.id} (${schematic.dimensions.width}x${schematic.dimensions.length})`,
    `depth ${depth} below reference y=${referenceY}`,
    'support blocks under structural columns are preserved until the builder places foundations'
  );
  // Columns that must be preserved (corners + mid-edge supports).
  plan.supports = supportColumns(plan.bounds);
  return plan;
}

function supportColumns(bounds) {
  const { min, max } = bounds;
  const midX = Math.floor((min.x + max.x) / 2);
  const midZ = Math.floor((min.z + max.z) / 2);
  const cols = [];
  for (const x of [min.x, midX, max.x]) {
    for (const z of [min.z, midZ, max.z]) cols.push({ x, z });
  }
  return cols;
}

function describeFootprint(plan) {
  const b = plan.bounds;
  return {
    mode: plan.mode,
    dimensions: `${b.max.x - b.min.x + 1} x ${plan.depth} x ${b.max.z - b.min.z + 1}`,
    origin: `${b.min.x} ${b.min.y} ${b.min.z}`,
    max: `${b.max.x} ${b.max.y} ${b.max.z}`,
    volume: plan.volume,
    extendsX: plan.orientation ? plan.orientation.extendsX : '',
    extendsZ: plan.orientation ? plan.orientation.extendsZ : '',
    down: plan.orientation ? plan.orientation.down : ''
  };
}

module.exports = {
  boxFromLowerCorner, boxFromFeet, radiusPlan, boxPlan, quarryPlan,
  trenchPlan, flattenPlan, foundationPlan, supportColumns, describeFootprint,
  median, circleCells
};
