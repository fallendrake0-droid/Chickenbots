#!/usr/bin/env node
'use strict';

const { generateLibrary, saveManifest, MANIFEST_PATH, SchematicLibrary } = require('../src/schematics/library');
const { config } = require('../src/config');
const { writeSummary } = require('./summarize-schematics');

function main() {
  process.stdout.write(`Generating ${config.schematics.targetCount}+ schematics...\n`);
  const started = Date.now();
  const manifest = generateLibrary({
    onProgress: ({ done, total, accepted, rejected }) => {
      if (done % 25 === 0 || done === total) process.stdout.write(`  ${done}/${total} generated (${accepted} accepted, ${rejected} retried)\n`);
    }
  });
  const file = saveManifest(manifest);
  // Keep the tiny startup aggregate in lockstep with the generated manifest.
  const summary = writeSummary(manifest);
  const library = new SchematicLibrary({ manifest });
  const stats = library.stats();
  process.stdout.write(`\nSaved manifest: ${file}\n`);
  process.stdout.write(`Designs: ${stats.count} (minimum ${stats.minimumRequired})\n`);
  process.stdout.write(`Unique geometry hashes: ${stats.uniqueGeometry}\n`);
  process.stdout.write(`Block totals: ${stats.blocks.total.toLocaleString()} (avg ${stats.blocks.average}, max ${stats.blocks.max})\n`);
  process.stdout.write(`Rejected after retries: ${manifest.rejected.length}\n`);
  process.stdout.write(`Summary: ${summary.count} designs, ${summary.uniqueGeometry} unique -> data/schematics/summary.json\n`);
  process.stdout.write(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  if (stats.count < stats.minimumRequired) {
    process.stderr.write(`FAIL: generated only ${stats.count} designs, minimum is ${stats.minimumRequired}\n`);
    process.exit(1);
  }
  process.stdout.write('OK: schematic library meets the minimum.\n');
}

main();
