'use strict';

const { boxVolume, iterateBox, key } = require('../util/vec');
const { classifyBlock, summarizeArea, buildWarnings, isLiquid } = require('./safety');
const {
  boxPlan, radiusPlan, quarryPlan, trenchPlan, flattenPlan, foundationPlan, describeFootprint
} = require('./footprint');
const { splitRegions, countLayers } = require('./regions');
const { maskForPlan } = require('./mask');

const PICK_SOFT = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'clay', 'sand', 'red_sand', 'gravel', 'snow', 'snow_block', 'soul_sand', 'soul_soil', 'farmland']);
const AXE_BLOCKS = /_log$|_wood$|_planks$|_fence$|_stairs$|_slab$|_door$|_trapdoor$|crafting_table|chest|barrel|bookshelf/;

let planSeq = 0;

function estimateToolNeeds(blockCounts, { workers = 5, volume = 0 } = {}) {
  let pick = 0;
  let shovel = 0;
  let axe = 0;
  for (const [name, count] of Object.entries(blockCounts)) {
    const c = classifyBlock(name);
    if (!c.excavatable) continue;
    if (PICK_SOFT.has(name)) shovel += count;
    else if (AXE_BLOCKS.test(name)) axe += count;
    else pick += count;
  }
  const durability = { wood: 59, stone: 131, iron: 250, diamond: 1561, netherite: 2031 };
  return {
    blocks: { pickaxe: pick, shovel, axe },
    tools: {
      diamond_pickaxes: Math.max(1, Math.ceil(pick / durability.diamond / Math.max(1, workers))),
      iron_pickaxes: Math.max(1, Math.ceil(pick / durability.iron / Math.max(1, workers))),
      shovels: Math.max(1, Math.ceil(shovel / durability.iron / Math.max(1, workers))),
      axes: Math.max(1, Math.ceil(axe / durability.iron / Math.max(1, workers))),
      torches: Math.max(16, Math.ceil(Math.max(volume, 1) / 40)),
      water_buckets: Math.max(1, Math.min(5, workers)),
      building_blocks: Math.max(64, Math.ceil(Math.max(volume, 1) / 80))
    }
  };
}

function scanArea(bounds, blockAt, { scanLimit = 120000, mask = null } = {}) {
  const volume = boxVolume(bounds.min, bounds.max);
  const stride = volume > scanLimit ? Math.ceil(Math.cbrt(volume / scanLimit)) : 1;
  const counts = {};
  const ores = [];
  const protectedBlocks = [];
  const liquids = [];
  const falling = [];
  let scanned = 0;
  let unknownErrors = 0;
  const start = { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z };
  for (let y = bounds.min.y; y <= bounds.max.y; y += stride) {
    for (let z = bounds.min.z; z <= bounds.max.z; z += stride) {
      for (let x = bounds.min.x; x <= bounds.max.x; x += stride) {
        if (mask && !mask.includes({ x, y, z })) continue;
        let block;
        try { block = blockAt({ x, y, z }); } catch (_) { unknownErrors++; continue; }
        if (!block || !block.name) { unknownErrors++; continue; }
        scanned++;
        counts[block.name] = (counts[block.name] || 0) + 1;
        if (ores.length < 2000 && /_ore$|ancient_debris/.test(block.name)) ores.push({ x, y, z, name: block.name });
        if (liquids.length < 1000 && isLiquid(block.name)) liquids.push({ x, y, z, name: block.name });
        if (falling.length < 1000 && /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/.test(block.name)) falling.push({ x, y, z, name: block.name });
        const c = classifyBlock(block.name);
        if ((c.kind === 'PROTECTED' || c.kind === 'MANUFACTURED' || c.kind === 'BEDROCK' || c.kind === 'UNKNOWN') && protectedBlocks.length < 2000) {
          protectedBlocks.push({ x, y, z, name: block.name, reason: c.reason });
        }
      }
    }
    if (scanned >= scanLimit) break;
  }
  return {
    counts,
    ores,
    liquids,
    falling,
    protectedBlocks,
    scanned,
    stride,
    full: stride === 1,
    errors: unknownErrors,
    coverage: volume ? Math.min(1, scanned / volume) : 0
  };
}

function buildAccessRoute(bounds, mode) {
  const depth = bounds.max.y - bounds.min.y + 1;
  const z = bounds.min.z;
  const steps = [];
  const seen = new Set();
  const add = (x, y, zz) => {
    const k = `${x},${y},${zz}`;
    if (seen.has(k)) return;
    seen.add(k);
    steps.push({ x, y, z: zz });
  };
  let x = bounds.min.x - 2;
  let y = bounds.max.y + 1;
  for (let i = 0; i < depth; i++) {
    // One block down per block along -X, with two blocks of headroom.
    add(x, y, z);
    add(x, y + 1, z);
    add(x, y + 2, z);
    x -= 1;
    y -= 1;
  }
  const stairEndX = x + 1;
  // Bottom corridor back into the pit, two blocks high.
  for (let cx = stairEndX; cx <= bounds.min.x; cx++) {
    add(cx, bounds.min.y, z);
    add(cx, bounds.min.y + 1, z);
    add(cx, bounds.min.y + 2, z);
  }
  const entrance = steps[0] || { x: bounds.min.x - 2, y: bounds.max.y + 1, z };
  return {
    type: mode === 'QUARRY' ? 'ramp' : 'staircase',
    entrance,
    bottom: { x: bounds.min.x, y: bounds.min.y, z },
    steps: steps.slice(0, 1200),
    stepCount: depth,
    note: 'one-block staircase with two-block headroom outside the footprint, plus a bottom corridor'
  };
}

/**
 * Build a complete excavation plan.
 *
 * @param {object} opts
 * @param {string} opts.mode BOX|AT|RADIUS|QUARRY|TRENCH|FLATTEN|FOUNDATION
 * @param {{x,y,z}} opts.origin
 * @param {function} [opts.blockAt] async-unsafe, returns {name} for a position
 * @param {function} [opts.surfaceAt] returns highest solid y for (x,z)
 * @param {object} [opts.schematic]
 */
function createExcavationPlan(opts = {}) {
  const {
    mode = 'BOX',
    origin,
    width = 16,
    length = 16,
    depth = 8,
    radius = 12,
    schematic = null,
    botNames = [],
    workers = 4,
    includeSupervisor = false,
    supervisor = null,
    blockAt = null,
    surfaceAt = null,
    options = {}
  } = opts;
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) {
    return { ok: false, error: 'a finite origin {x,y,z} is required' };
  }
  const limits = {
    maxBlocks: options.maxBlocks || 250000,
    maxDepth: options.maxDepth || 120,
    preserveOres: options.preserveOres !== false,
    protectedDefault: options.protectedDefault !== false,
    authorized: Boolean(options.authorized),
    scanLimit: options.scanLimit || 120000
  };

  let footprint;
  try {
    switch (mode) {
      case 'RADIUS': footprint = radiusPlan({ origin, radius, depth }); break;
      case 'QUARRY': footprint = quarryPlan({ origin, width, length, depth }); break;
      case 'TRENCH': footprint = trenchPlan({ origin, length, width, depth }); break;
      case 'FLATTEN': {
        if (!surfaceAt) return { ok: false, error: 'flatten requires terrain sampling (surfaceAt)' };
        footprint = flattenPlan({ origin, width, length, surfaceAt });
        // Only blocks above the target surface are excavated.
        footprint.bounds.min.y = footprint.targetY + 1;
        footprint.depth = Math.max(0, footprint.bounds.max.y - footprint.bounds.min.y + 1);
        footprint.volume = boxVolume(footprint.bounds.min, footprint.bounds.max);
        break;
      }
      case 'FOUNDATION':
        if (!schematic) return { ok: false, error: 'foundation excavation requires a schematic' };
        footprint = foundationPlan({ schematic, origin, surfaceAt });
        break;
      case 'AT':
      case 'BOX':
      default:
        footprint = boxPlan({ mode: mode === 'AT' ? 'AT' : 'BOX', origin, width, length, depth, anchored: mode === 'AT' ? 'lower' : 'feet' });
        break;
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (!Number.isFinite(footprint.volume) || footprint.volume <= 0) return { ok: false, error: 'excavation volume is zero' };
  if (footprint.volume > limits.maxBlocks) {
    return { ok: false, error: `volume ${footprint.volume} exceeds limit ${limits.maxBlocks}; split the excavation into phases` };
  }
  if (footprint.depth > limits.maxDepth) return { ok: false, error: `depth ${footprint.depth} exceeds limit ${limits.maxDepth}` };
  if (footprint.bounds.min.y < -64) return { ok: false, error: 'excavation extends below the world floor' };

  const mask = maskForPlan({
    mode: footprint.mode,
    bounds: footprint.bounds,
    depth: footprint.depth,
    radius: footprint.radius,
    center: footprint.center,
    terraces: footprint.tiers,
    tierHeight: footprint.tierHeight,
    targetY: footprint.targetY
  });
  const planVolume = mask.volume;
  if (planVolume > limits.maxBlocks) {
    return { ok: false, error: `excavation volume ${planVolume} exceeds limit ${limits.maxBlocks}; split the excavation into phases` };
  }
  const scan = blockAt
    ? scanArea(footprint.bounds, blockAt, { scanLimit: limits.scanLimit, mask })
    : { counts: {}, ores: [], liquids: [], falling: [], protectedBlocks: [], scanned: 0, stride: 1, full: false, errors: 0, coverage: 0 };
  const summary = summarizeArea(scan.counts, limits);
  const warnings = buildWarnings(summary);
  if (!blockAt) warnings.push({ level: 'warn', text: 'No world scan available: plan is geometric only. Start requires a live block scan.' });
  if (!scan.full && scan.scanned > 0) {
    warnings.push({ level: 'warn', text: `Terrain scan sampled every ${scan.stride} blocks (${Math.round(scan.coverage * 100)}% coverage); hazards may exist between samples.` });
  }
  if (!limits.preserveOres && Object.keys(summary.ores).length) warnings.push({ level: 'warn', text: 'Ore preservation disabled: ores will be removed with terrain.' });
  if (limits.authorized) warnings.push({ level: 'warn', text: 'Protected-block authorisation supplied: player structures inside the area may be removed.' });
  if (footprint.mode === 'QUARRY') warnings.push({ level: 'info', text: `Quarry will be cut in ${footprint.tiers.length} terraces with a ${footprint.ramp.width}-wide ramp.` });
  if (!blockAt) {
    // Geometric estimate without a scan
    summary.excavatable = footprint.volume;
  }

  const regions = splitRegions(footprint.bounds, Math.max(1, Math.min(workers, Math.max(1, botNames.length || workers))), { measure: (box) => mask.measure(box) });
  const toolNeeds = estimateToolNeeds(scan.counts, { workers: regions.length, volume: planVolume });
  const excavatable = blockAt
    ? Math.max(0, Math.round(Math.max(summary.excavatable || 0, planVolume - summary.air)))
    : planVolume;
  const secondsPerBlock = 1.15;
  const estimatedSeconds = Math.ceil((excavatable * secondsPerBlock) / Math.max(1, regions.length));
  const authorizationRequired = Object.keys(summary.protected).length > 0 && limits.protectedDefault && !limits.authorized;
  const confirmationReasons = [];
  if (authorizationRequired) confirmationReasons.push('protected or player-placed blocks inside the area');
  if (Object.keys(summary.liquids).length) confirmationReasons.push('liquids inside the area');
  if (planVolume > 2000) confirmationReasons.push('large volume');
  if (limits.authorized) confirmationReasons.push('authorisation override supplied');

  const plan = {
    id: `exc-${++planSeq}-${footprint.mode.toLowerCase()}`,
    createdAt: Date.now(),
    mode: footprint.mode,
    origin: { ...footprint.bounds.min },
    requestedOrigin: { ...origin },
    bounds: footprint.bounds,
    footprint: footprint.footprint,
    depth: footprint.depth,
    volume: planVolume,
    boxVolume: boxVolume(footprint.bounds.min, footprint.bounds.max),
    mask: { type: mask.type, description: mask.description, volume: mask.volume },
    layers: countLayers(footprint.bounds),
    direction: 'top-down',
    terraces: footprint.tiers || null,
    ramp: footprint.ramp || null,
    exitSteps: footprint.exitSteps || null,
    targetY: footprint.targetY !== undefined ? footprint.targetY : null,
    schematicId: footprint.schematicId || null,
    accessRoute: buildAccessRoute(footprint.bounds, footprint.mode),
    regions,
    workerCount: regions.length,
    assignments: [],
    supervisor: includeSupervisor ? null : supervisor,
    summary,
    scan: {
      scanned: scan.scanned,
      full: scan.full,
      stride: scan.stride,
      coverage: scan.coverage,
      errors: scan.errors
    },
    ores: scan.ores,
    liquids: scan.liquids,
    falling: scan.falling,
    protectedBlocks: scan.protectedBlocks,
    warnings,
    toolNeeds,
    estimate: {
      excavatableBlocks: excavatable,
      seconds: estimatedSeconds,
      minutes: Math.ceil(estimatedSeconds / 60),
      perRegionSeconds: Math.ceil(estimatedSeconds * regions.length / Math.max(1, regions.length)),
      assumptions: '1.15 s per block including travel, one bot per region, no interruptions'
    },
    authorizationRequired,
    confirmation: { required: true, reasons: confirmationReasons },
    options: limits,
    description: describeFootprint(footprint),
    notes: footprint.notes || []
  };
  // Non-enumerable live mask used by executor/verifier in-process.
  Object.defineProperty(plan, '_mask', { value: mask, enumerable: false, writable: false });
  return { ok: true, plan };
}

function formatPlan(plan) {
  const lines = [];
  lines.push('EXCAVATION PLAN');
  lines.push('');
  lines.push(`SIZE: ${plan.description.dimensions}`);
  lines.push(`ESTIMATED VOLUME: ${plan.volume.toLocaleString()} BLOCKS`);
  lines.push(`EXCAVATABLE: ${plan.estimate.excavatableBlocks.toLocaleString()} BLOCKS`);
  lines.push(`LOCATION: ${plan.description.origin}  (max ${plan.description.max})`);
  lines.push(`MODE: ${plan.mode}`);
  lines.push(`METHOD: ${plan.mode === 'QUARRY' ? 'TERRACED LAYERED EXCAVATION' : 'LAYERED TOP-DOWN EXCAVATION'}`);
  lines.push(`ESTIMATED TIME: ${plan.estimate.minutes} MINUTES (${plan.workerCount} WORKERS)`);
  lines.push('');
  lines.push('REGIONS:');
  for (const r of plan.regions) {
    lines.push(`  ${r.id.padEnd(4)} ${r.volume.toLocaleString().padStart(7)} blocks  x=${r.box.min.x}..${r.box.max.x} z=${r.box.min.z}..${r.box.max.z}`);
  }
  lines.push('');
  lines.push('TOOLS REQUIRED:');
  for (const [tool, count] of Object.entries(plan.toolNeeds.tools)) lines.push(`  ${tool}: ${count}`);
  lines.push('');
  lines.push(`SCAN: ${plan.scan.full ? 'FULL' : `SAMPLED (${Math.round(plan.scan.coverage * 100)}%)`}  AIR/BLOCKS SCANNED: ${plan.scan.scanned.toLocaleString()}`);
  if (Object.keys(plan.summary.ores).length) lines.push(`ORES PRESERVED: ${Object.entries(plan.summary.ores).map(([k, v]) => `${k} x${v}`).join(', ')}`);
  if (Object.keys(plan.summary.liquids).length) lines.push(`LIQUIDS: ${Object.entries(plan.summary.liquids).map(([k, v]) => `${k} x${v}`).join(', ')}`);
  if (plan.warnings.length) {
    lines.push('');
    lines.push('WARNINGS:');
    for (const w of plan.warnings) lines.push(`  [${w.level.toUpperCase()}] ${w.text}`);
  }
  lines.push('');
  lines.push(`STATUS: ${plan.authorizationRequired ? 'AWAITING AUTHORISATION (use confirm)' : 'AWAITING APPROVAL (use start)'}`);
  return lines.join('\n');
}

module.exports = { createExcavationPlan, formatPlan, estimateToolNeeds, scanArea, buildAccessRoute };
