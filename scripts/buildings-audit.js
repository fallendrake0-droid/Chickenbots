#!/usr/bin/env node
'use strict';

/**
 * Independent blueprint audit for the build library.
 *
 * For every design this reconstructs the schematic, builds the dependency
 * graph and validates every palette entry against the installed block registry.
 * It does not place blocks; construction is covered by the test suite and by
 * `build ... run` against the simulation.
 *
 *   node scripts/buildings-audit.js            # full library
 *   node scripts/buildings-audit.js --limit 50 # quick sample
 *   node scripts/buildings-audit.js --json report.json
 */

const fs = require('fs');
const { SchematicLibrary } = require('../src/schematics/library');
const { BuildEngine } = require('../src/building/engine');
const { BlockRegistry } = require('../src/building/blockRegistry');
const { config } = require('../src/config');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const limit = arg('limit') ? Math.max(1, Number(arg('limit'))) : Infinity;
const offset = arg('offset') ? Math.max(0, Number(arg('offset'))) : 0;
const jsonPath = arg('json');
const library = new SchematicLibrary();
if (!library.loaded) {
  console.error('No schematic manifest. Run npm run schematics:generate first.');
  process.exit(2);
}
const registry = new BlockRegistry({ version: config.building?.minecraftVersion || null });
const world = { getBlock: () => ({ name: 'air', properties: {} }) };
const custom = library.customStore ? library.customStore.statsSummary() : null;
const all = library.list({ limit: Number.MAX_SAFE_INTEGER, excludeCustom: false });
const designs = Number.isFinite(limit) ? all.slice(offset, offset + limit) : all.slice(offset);
const started = Date.now();
const failures = [];
let blocks = 0;
let invalidBlocks = 0;
let issues = 0;
let warnings = 0;
let cycles = 0;

for (let i = 0; i < designs.length; i++) {
  const design = designs[i];
  const schematic = library.build(design.id);
  if (!schematic) {
    failures.push({ id: design.id, error: 'no block data' });
    continue;
  }
  const engine = new BuildEngine({ schematic, origin: { x: 0, y: 64, z: 0 }, world, registry });
  const validation = engine.validateBlueprint();
  const plan = engine.buildPlan();
  blocks += schematic.blocks.length;
  invalidBlocks += validation.issues.filter((issue) => issue.kind === 'INVALID_BLOCK').length;
  issues += validation.issues.length;
  warnings += validation.warnings.length;
  cycles += plan.cycles.length;
  if (!validation.ok || plan.cycles.length) {
    failures.push({
      id: design.id, name: design.name, blocks: schematic.blocks.length,
      issues: validation.issues.slice(0, 5), cycles: plan.cycles.slice(0, 5)
    });
  }
  if ((i + 1) % 100 === 0 || i + 1 === designs.length) {
    process.stderr.write(`  ${i + 1}/${designs.length} audited (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  registry: registry.describe(),
  library: library.stats(),
  custom,
  audited: designs.length,
  available: all.length,
  elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
  blocks,
  issues,
  invalidBlocks,
  warnings,
  cycles,
  failures: failures.length,
  failureSamples: failures.slice(0, 20),
  ok: failures.length === 0
};

if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
