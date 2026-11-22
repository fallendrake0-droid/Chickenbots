#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadManifest, MANIFEST_PATH } = require('../src/schematics/library');
const { validateLibrary, formatValidationReport } = require('../src/schematics/validate');
const { config } = require('../src/config');

function main() {
  const args = process.argv.slice(2);
  const sampleArg = args.find((a) => a.startsWith('--sample='));
  const sampleSize = sampleArg ? Number(sampleArg.split('=')[1]) : null;
  const regenerate = !args.includes('--metadata-only');
  const manifest = loadManifest();
  if (!manifest) {
    process.stderr.write(`No schematic manifest at ${MANIFEST_PATH}. Run: npm run schematics:generate\n`);
    process.exit(1);
  }
  const report = validateLibrary(manifest, {
    regenerate,
    sampleSize,
    onProgress: ({ done, total }) => {
      if (done % 100 === 0 || done === total) process.stdout.write(`  validated ${done}/${total}\n`);
    }
  });
  const text = formatValidationReport(report);
  process.stdout.write(`\n${text}\n`);
  const outDir = config.paths.schematicData;
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'validation-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`Report written to ${reportPath}\n`);
  if (!report.passed) process.exit(1);
}

main();
