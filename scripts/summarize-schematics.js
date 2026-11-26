#!/usr/bin/env node
'use strict';

/**
 * Build data/schematics/summary.json from the catalogue manifest.
 *
 * The manifest is ~20 MB and JSON.parse of it blocked the live process for
 * 7.2 s at startup. Runtime/dashboard status only needs aggregate facts, so
 * this small, generated summary is loaded instead; the full manifest is still
 * parsed lazily by commands that actually need individual designs.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');

const manifestPath = path.join(config.paths.schematicData, 'manifest.json');
const summaryPath = path.join(config.paths.schematicData, 'summary.json');

function buildSummary(manifest) {
  const designs = Array.isArray(manifest.designs) ? manifest.designs : [];
  const blockCounts = designs.map((d) => Object.values(d.materials || {}).reduce((s, n) => s + Number(n || 0), 0));
  const materialTotals = {};
  for (const d of designs) {
    for (const [name, n] of Object.entries(d.materials || {})) materialTotals[name] = (materialTotals[name] || 0) + Number(n || 0);
  }
  const topMaterials = Object.entries(materialTotals).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count }));
  const tiers = [...new Set(designs.map((d) => d.tier))].map((tier) => ({ tier, count: designs.filter((d) => d.tier === tier).length }));
  // The dashboard filter, the CLI stats printer and construction.js all read
  // category objects ({category, count}), matching the full-manifest stats.
  // This summary used to emit bare strings, so a cold dashboard showed every
  // option as "undefined" and `npm run schematics:stats` crashed on padEnd.
  const categories = [...new Set(designs.map((d) => d.category))].sort()
    .map((category) => ({ category, count: designs.filter((d) => d.category === category).length }));
  return {
    version: 1,
    source: 'manifest.json',
    loaded: true,
    count: designs.length,
    minimumRequired: manifest.minimumRequired,
    meetsMinimum: designs.length >= Number(manifest.minimumRequired || 0),
    uniqueGeometry: new Set(designs.map((d) => d.geometryHash)).size,
    tiers,
    categories,
    blocks: {
      total: blockCounts.reduce((s, n) => s + n, 0),
      min: blockCounts.length ? Math.min(...blockCounts) : 0,
      max: blockCounts.length ? Math.max(...blockCounts) : 0,
      average: blockCounts.length ? Math.round(blockCounts.reduce((s, n) => s + n, 0) / blockCounts.length) : 0
    },
    topMaterials,
    dimensions: designs.length ? {
      maxWidth: Math.max(...designs.map((d) => d.dimensions.width)),
      maxHeight: Math.max(...designs.map((d) => d.dimensions.height)),
      maxLength: Math.max(...designs.map((d) => d.dimensions.length))
    } : { maxWidth: 0, maxHeight: 0, maxLength: 0 },
    manifestGeneratedAt: manifest.generatedAt || null,
    generationMs: manifest.generationMs || null,
    rejected: (manifest.rejected || []).length
  };
}

function writeSummary(manifest, { startedAt = Date.now() } = {}) {
  const summary = buildSummary(manifest);
  summary.summarizedAt = new Date().toISOString();
  summary.summaryMs = Date.now() - startedAt;
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function main() {
  const started = Date.now();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const summary = writeSummary(manifest, { startedAt: started });
  process.stdout.write(`summary written: ${summaryPath} (${summary.count} designs, ${summary.uniqueGeometry} unique, ${Date.now() - started}ms)\n`);
}

if (require.main === module) {
  try { main(); }
  catch (err) { process.stderr.write(`summary failed: ${err.message}\n`); process.exitCode = 1; }
}

module.exports = { buildSummary, writeSummary };
