'use strict';

const mcData = require('minecraft-data');
const { generateSchematic } = require('./generator');
const { classOfBlock } = require('./designHash');
const { parseBlock, formatBlock, placementItem } = require('../building/blockStates');
const { config } = require('../config');

const REQUIRED_PHASES = ['FOUNDATION', 'WALLS'];

function validationVersion() {
  const configured = config.building?.minecraftVersion;
  return configured && configured !== 'auto' ? configured : '26.1';
}

function knownBlockSet(version = validationVersion()) {
  try {
    const data = mcData(version);
    // Material totals use the item required to place a block (torch for a
    // wall torch, water_bucket for water), so both registries are valid names.
    return new Set([...Object.keys(data.blocksByName), ...Object.keys(data.itemsByName)]);
  } catch (_) {
    const fallback = mcData('1.20.1');
    return new Set([...Object.keys(fallback.blocksByName), ...Object.keys(fallback.itemsByName)]);
  }
}

const CLASS_CACHE = new Map();
function cachedClass(name) {
  if (CLASS_CACHE.has(name)) return CLASS_CACHE.get(name);
  const cls = classOfBlock(name);
  if (CLASS_CACHE.size < 20000) CLASS_CACHE.set(name, cls);
  return cls;
}

/**
 * Structural support analysis: how many structural blocks have no neighbour.
 * Numeric packed keys and cached block classes keep the 10,000-design full
 * validation linear; string keys and a fresh class regex per block made it
 * quadratic in allocation cost and dominated the whole run.
 */
function supportAnalysis(schematic, { maxUnsupportedRatio = 0.05 } = {}) {
  const { width: w, length: l } = schematic.dimensions;
  const key = (x, y, z) => (y * w + x) * l + z;
  const occupied = new Set(schematic.blocks.map(([x, y, z]) => key(x, y, z)));
  const paletteNames = schematic.palette.map((entry) => parseBlock(entry).name);
  let checked = 0;
  let unsupported = 0;
  const examples = [];
  for (const [x, y, z, p] of schematic.blocks) {
    const name = paletteNames[p];
    const cls = cachedClass(name);
    if (cls === 'light' || cls === 'vegetation' || cls === 'glass' || cls === 'interior' || cls === 'decoration') continue;
    if (y === 0) continue;
    checked++;
    const supported = occupied.has(key(x, y - 1, z))
      || occupied.has(key(x, y + 1, z))
      || (x + 1 < w && occupied.has(key(x + 1, y, z)))
      || (x > 0 && occupied.has(key(x - 1, y, z)))
      || (z + 1 < l && occupied.has(key(x, y, z + 1)))
      || (z > 0 && occupied.has(key(x, y, z - 1)));
    if (!supported) {
      unsupported++;
      if (examples.length < 5) examples.push({ x, y, z, block: name });
    }
  }
  const ratio = checked ? unsupported / checked : 0;
  return { checked, unsupported, ratio: Number(ratio.toFixed(4)), ok: ratio <= maxUnsupportedRatio, examples };
}

function validateSchematic(schematic, { knownBlocks, expected = null, minimumBlocks = 10 } = {}) {
  const issues = {
    invalid: [],
    unsupportedBlocks: [],
    missingMaterials: [],
    structuralProblems: [],
    compatibility: []
  };
  if (!schematic || !Array.isArray(schematic.blocks) || !schematic.blocks.length) {
    issues.invalid.push('no blocks');
    return { ok: false, issues };
  }
  const dims = schematic.dimensions;
  if (!dims || !(dims.width > 0 && dims.height > 0 && dims.length > 0)) issues.invalid.push('invalid dimensions');
  if (schematic.blocks.length < minimumBlocks) issues.invalid.push(`only ${schematic.blocks.length} blocks`);
  if (expected) {
    if (expected.dimensions && (expected.dimensions.width !== dims.width || expected.dimensions.height !== dims.height || expected.dimensions.length !== dims.length)) {
      issues.invalid.push(`dimensions differ from manifest (${JSON.stringify(dims)} vs ${JSON.stringify(expected.dimensions)})`);
    }
    if (expected.geometryHash && expected.geometryHash !== schematic.geometryHash) issues.invalid.push('geometry hash differs from manifest');
    if (expected.exactHash && expected.exactHash !== schematic.exactHash) issues.invalid.push('exact hash differs from manifest');
  }
  const paletteSet = new Set(schematic.palette.map((entry) => formatBlock(entry)));
  if (paletteSet.size !== schematic.palette.length) issues.invalid.push('palette contains duplicate entries');
  const placementNames = schematic.palette.map((entry) => placementItem(parseBlock(entry)));
  const materials = {};
  const phaseSet = new Set();
  let outOfBounds = 0;
  for (const [x, y, z, p, phase] of schematic.blocks) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) issues.invalid.push('non-integer coordinates');
    if (x < 0 || y < 0 || z < 0 || x >= dims.width || y >= dims.height || z >= dims.length) outOfBounds++;
    if (p < 0 || p >= schematic.palette.length) issues.invalid.push(`palette index out of range: ${p}`);
    phaseSet.add(phase);
    const name = placementNames[p];
    materials[name] = (materials[name] || 0) + 1;
  }
  if (outOfBounds) issues.invalid.push(`${outOfBounds} blocks outside stated dimensions`);
  if (phaseSet.size === 0) issues.structuralProblems.push('no build phases assigned');
  for (const phaseName of schematic.buildPhases || []) {
    if (!schematic.phases || !schematic.phases.some((p) => p.name === phaseName)) issues.invalid.push(`phase ${phaseName} has no metadata`);
  }
  for (const req of REQUIRED_PHASES) {
    if (!schematic.phases || !schematic.phases.some((p) => p.name === req)) issues.structuralProblems.push(`missing ${req} phase`);
  }
  const phaseTotal = (schematic.phases || []).reduce((s, p) => s + p.blockCount, 0);
  if (phaseTotal !== schematic.blocks.length) issues.structuralProblems.push(`phase block total ${phaseTotal} != ${schematic.blocks.length}`);
  const materialTotal = Object.values(materials).reduce((s, n) => s + n, 0);
  if (materialTotal !== schematic.blocks.length) issues.missingMaterials.push('material totals do not match block count');
  for (const [name, count] of Object.entries(schematic.materials || {})) {
    if (materials[name] !== count) issues.missingMaterials.push(`${name}: manifest ${count} != actual ${materials[name] || 0}`);
  }
  for (const [name, count] of Object.entries(materials)) {
    if (!schematic.materials || schematic.materials[name] !== count) issues.missingMaterials.push(`${name}: actual ${count} not in material totals`);
    if (!knownBlocks.has(name)) issues.unsupportedBlocks.push(name);
  }
  if (!schematic.foundation || !(schematic.foundation.depth > 0)) issues.structuralProblems.push('missing foundation depth');
  if (!schematic.supports || !schematic.supports.length) issues.structuralProblems.push('no foundation supports');
  if (schematic.palette.some((entry) => /^(air|unknown|custom)/.test(parseBlock(entry).name))) issues.unsupportedBlocks.push('placeholder block name');
  const support = supportAnalysis(schematic);
  if (!support.ok) issues.structuralProblems.push(`unsupported structural blocks: ${support.unsupported}/${support.checked} (${support.ratio})`);
  if (!Array.isArray(schematic.versionCompatibility) || !schematic.versionCompatibility.length) issues.compatibility.push('no version compatibility declared');
  if (!schematic.tags || !schematic.tags.length) issues.compatibility.push('no tags');
  const entries = Object.values(issues).reduce((s, arr) => s + arr.length, 0);
  return { ok: entries === 0, issues, support, materials };
}

/**
 * Validate a whole library manifest. With `regenerate` the block data is
 * rebuilt from each spec and compared against the manifest, so the report is
 * based on real generated structures rather than trusting metadata.
 */
function validateLibrary(manifest, { regenerate = true, sampleSize = null, version = validationVersion(), onProgress = null } = {}) {
  const started = Date.now();
  const knownBlocks = knownBlockSet(version);
  const report = {
    version,
    mode: regenerate ? (sampleSize ? `sample:${sampleSize}` : 'full') : 'metadata',
    totalEntries: manifest ? manifest.designs.length : 0,
    uniqueDesigns: 0,
    duplicateDesigns: [],
    duplicateSpecs: [],
    invalidFiles: [],
    unsupportedBlocks: [],
    missingMaterials: [],
    structuralProblems: [],
    compatibilityIssues: [],
    tierCounts: {},
    categoryCounts: {},
    generatedBlocks: 0,
    minimumRequired: config.schematics.minimumCount,
    meetsMinimum: false,
    passed: false
  };
  if (!manifest) {
    report.invalidFiles.push('manifest missing');
    return report;
  }
  const designs = manifest.designs;
  report.meetsMinimum = designs.length >= report.minimumRequired;
  if (!report.meetsMinimum) report.invalidFiles.push(`only ${designs.length} designs, minimum is ${report.minimumRequired}`);

  const seenDetails = new Map();
  const seenSpecs = new Map();
  let indices = designs.map((_, i) => i);
  if (regenerate && sampleSize && sampleSize < designs.length) {
    const stride = Math.max(1, Math.floor(designs.length / sampleSize));
    indices = designs.filter((_, i) => i % stride === 0).slice(0, sampleSize).map((d) => designs.indexOf(d));
  }
  indices.forEach((idx, count) => {
    const entry = designs[idx];
    report.tierCounts[entry.tier] = (report.tierCounts[entry.tier] || 0) + 1;
    report.categoryCounts[entry.category] = (report.categoryCounts[entry.category] || 0) + 1;
    const geom = entry.geometryHash;
    if (seenDetails.has(geom)) {
      report.duplicateDesigns.push({ a: seenDetails.get(geom), b: entry.id, hash: geom });
    } else {
      seenDetails.set(geom, entry.id);
    }
    if (seenSpecs.has(entry.specHash)) report.duplicateSpecs.push({ a: seenSpecs.get(entry.specHash), b: entry.id, hash: entry.specHash });
    else seenSpecs.set(entry.specHash, entry.id);
    if (!regenerate) {
      if (!entry.blocks && !entry.materials) report.invalidFiles.push(`${entry.id}: missing data`);
      return;
    }
    try {
      const schematic = generateSchematic(entry.spec, { id: entry.id, name: entry.name });
      report.generatedBlocks += schematic.blocks.length;
      const result = validateSchematic(schematic, { knownBlocks, expected: entry });
      if (!result.ok) {
        for (const msg of result.issues.invalid) report.invalidFiles.push(`${entry.id}: ${msg}`);
        for (const block of result.issues.unsupportedBlocks) report.unsupportedBlocks.push(`${entry.id}: ${block}`);
        for (const msg of result.issues.missingMaterials) report.missingMaterials.push(`${entry.id}: ${msg}`);
        for (const msg of result.issues.structuralProblems) report.structuralProblems.push(`${entry.id}: ${msg}`);
        for (const msg of result.issues.compatibility) report.compatibilityIssues.push(`${entry.id}: ${msg}`);
      }
    } catch (err) {
      report.invalidFiles.push(`${entry.id}: generation failed: ${err.message}`);
    }
    if (onProgress && ((count + 1) % 50 === 0 || count === indices.length - 1)) onProgress({ done: count + 1, total: indices.length });
  });
  report.uniqueDesigns = new Set(designs.map((d) => d.geometryHash)).size;
  report.passed = report.totalEntries >= report.minimumRequired
    && report.uniqueDesigns === report.totalEntries
    && report.duplicateDesigns.length === 0
    && report.duplicateSpecs.length === 0
    && report.invalidFiles.length === 0
    && report.unsupportedBlocks.length === 0
    && report.missingMaterials.length === 0
    && report.structuralProblems.length === 0;
  report.durationMs = Date.now() - started;
  return report;
}

function formatValidationReport(report) {
  const lines = [];
  lines.push('SCHEMATIC LIBRARY VALIDATION');
  lines.push('');
  lines.push(`MODE: ${report.mode}   MINECRAFT DATA: ${report.version}`);
  lines.push(`TOTAL ENTRIES: ${report.totalEntries}`);
  lines.push(`UNIQUE DESIGNS: ${report.uniqueDesigns}`);
  lines.push(`MINIMUM REQUIRED: ${report.minimumRequired} -> ${report.meetsMinimum ? 'MET' : 'NOT MET'}`);
  lines.push(`DUPLICATE DESIGNS: ${report.duplicateDesigns.length}`);
  lines.push(`DUPLICATE STRUCTURAL SPECS: ${report.duplicateSpecs.length}`);
  lines.push(`INVALID FILES: ${report.invalidFiles.length}`);
  lines.push(`UNSUPPORTED BLOCKS: ${report.unsupportedBlocks.length}`);
  lines.push(`MISSING MATERIALS: ${report.missingMaterials.length}`);
  lines.push(`STRUCTURAL PROBLEMS: ${report.structuralProblems.length}`);
  lines.push(`COMPATIBILITY ISSUES: ${report.compatibilityIssues.length}`);
  lines.push(`BLOCKS GENERATED: ${report.generatedBlocks.toLocaleString()}`);
  lines.push('');
  lines.push('TIERS:');
  for (const [tier, count] of Object.entries(report.tierCounts)) lines.push(`  ${tier}: ${count}`);
  lines.push('');
  lines.push('CATEGORIES:');
  for (const [cat, count] of Object.entries(report.categoryCounts)) lines.push(`  ${cat}: ${count}`);
  const problems = [
    ['INVALID', report.invalidFiles], ['DUPLICATES', report.duplicateDesigns.map((d) => `${d.a} == ${d.b}`)],
    ['UNSUPPORTED', report.unsupportedBlocks], ['MATERIALS', report.missingMaterials],
    ['STRUCTURE', report.structuralProblems], ['COMPAT', report.compatibilityIssues]
  ];
  for (const [label, list] of problems) {
    if (!list.length) continue;
    lines.push('');
    lines.push(`${label} (first 20):`);
    for (const item of list.slice(0, 20)) lines.push(`  - ${typeof item === 'string' ? item : JSON.stringify(item)}`);
  }
  lines.push('');
  lines.push(`RESULT: ${report.passed ? 'PASS' : 'FAIL'} (${report.durationMs} ms)`);
  return lines.join('\n');
}

module.exports = { validateSchematic, validateLibrary, supportAnalysis, knownBlockSet, formatValidationReport };
