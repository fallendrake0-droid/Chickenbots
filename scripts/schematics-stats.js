#!/usr/bin/env node
'use strict';

const { SchematicLibrary } = require('../src/schematics/library');

function main() {
  const library = new SchematicLibrary();
  if (!library.loaded) {
    process.stderr.write('No schematic manifest found. Run: npm run schematics:generate\n');
    process.exit(1);
  }
  const stats = library.stats();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push('CHICKENBOTS SCHEMATIC LIBRARY');
  lines.push('');
  lines.push(`DESIGNS: ${stats.count}`);
  lines.push(`UNIQUE: ${stats.uniqueGeometry}`);
  lines.push(`MINIMUM: ${stats.minimumRequired} (${stats.meetsMinimum ? 'met' : 'NOT MET'})`);
  lines.push(`BLOCKS: total ${stats.blocks.total.toLocaleString()}, average ${stats.blocks.average}, largest ${stats.blocks.max}`);
  lines.push(`LARGEST DIMENSIONS: ${stats.dimensions.maxWidth} x ${stats.dimensions.maxHeight} x ${stats.dimensions.maxLength}`);
  lines.push('');
  lines.push('BY TIER:');
  for (const t of stats.tiers) lines.push(`  ${t.tier.padEnd(14)} ${t.count}`);
  lines.push('');
  lines.push('BY CATEGORY:');
  for (const c of stats.categories) lines.push(`  ${c.category.padEnd(24)} ${c.count}`);
  lines.push('');
  lines.push('MOST USED MATERIALS:');
  for (const m of stats.topMaterials) lines.push(`  ${m.name.padEnd(28)} ${m.count.toLocaleString()}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
