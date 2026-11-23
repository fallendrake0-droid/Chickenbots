#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { loadManifest } = require('../src/schematics/library');

const ROOT = path.resolve(__dirname, '..');
const quick = process.argv.includes('--quick');

function step(name, command, args, { timeout = 1800000 } = {}) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    process.stderr.write(`${name} failed to run: ${result.error.message}\n`);
    return { ok: false, name, status: -1 };
  }
  const ok = result.status === 0;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}: ${name}\n`);
  return { ok, name, status: result.status };
}

function consistency() {
  process.stdout.write('\n=== consistency ===\n');
  const checks = [];
  const check = (name, fn) => {
    let ok = false;
    let detail = '';
    try {
      const result = fn();
      ok = result.ok;
      detail = result.detail || '';
    } catch (err) {
      detail = err.message;
    }
    checks.push({ name, ok, detail });
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  };
  check('roster is exactly five fixed usernames', () => ({ ok: JSON.stringify(config.team.names) === JSON.stringify(['________', '10101000', '01010100', '11001100', '00110000']) && config.team.names.length === 5, detail: config.team.names.join(', ') }));
  check('default server preserved', () => ({ ok: config.server.host === 'cr3xlol.aternos.me' && config.server.port === 55742 && config.server.version === 'auto', detail: `${config.server.host}:${config.server.port}` }));
  check('AI disabled and keyless', () => ({ ok: config.autonomy.ai.enabled === false, detail: 'deterministic mode' }));
  check('PvP disabled', () => ({ ok: config.autonomy.pvp === false, detail: 'false' }));
  check('manifest exists and meets minimum', () => {
    const manifest = loadManifest();
    if (!manifest) return { ok: false, detail: 'run npm run schematics:generate' };
    const unique = new Set(manifest.designs.map((d) => d.geometryHash)).size;
    return { ok: manifest.designs.length >= config.schematics.minimumCount && unique === manifest.designs.length, detail: `${manifest.designs.length} designs, ${unique} unique` };
  });
  check('required source files exist', () => {
    const required = [
      'src/index.js', 'src/runtime.js', 'src/cli.js', 'src/dashboard/server.js',
      'src/bot/realBot.js', 'src/bot/mockBot.js', 'src/commands/index.js', 'src/builder/builder.js',
      'src/schematics/generator.js', 'src/schematics/format.js', 'src/actions/survival.js',
      'src/construction/manager.js', 'src/construction/pipeline.js', 'src/construction/siteSurvey.js',
      'src/construction/sitePreparer.js', 'src/construction/lighting.js', 'src/construction/materials.js',
      'src/construction/storage.js', 'src/dashboard/public/js/pages/operations.js',
      'tests/survival.test.js', 'tests/controllers.test.js', 'tests/schematics.test.js', 'tests/builder.test.js',
      'tests/construction.test.js', 'scripts/deploy-check.js'
    ];
    const missing = required.filter((file) => !fs.existsSync(path.join(ROOT, file)));
    return { ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : `${required.length} files` };
  });
  check('dashboard exposes every navigation page', () => {
    const js = fs.readFileSync(path.join(ROOT, 'src/dashboard/public/js/router.js'), 'utf8');
    const pages = ['Overview', 'Live Activity', 'Notifications', 'All Bots', 'Team Management', 'Bot Profiles', 'Connection Management', 'Survival', 'Combat', 'Inventory', 'Mining', 'Excavation', 'Woodcutting', 'Farming', 'Fishing', 'Exploration', 'Sleep', 'Builder Overview', 'Builder Projects', 'Site Survey', 'Site Preparation', 'Lighting', 'Material Planning', 'Storage', 'Team Assignments', 'QA & Security', 'Home Base', 'Builder', 'Schematic Library', 'Build Projects', 'Project History', 'Task Manager', 'Logs & Diagnostics', 'Settings'];
    const missing = pages.filter((page) => !js.includes(page));
    return { ok: missing.length === 0, detail: missing.length ? missing.join(', ') : `${pages.length}/${pages.length}` };
  });
  check('no grounded success placeholders in src', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));
    const bad = files.filter((file) => /not implemented yet|TODO|FIXME/.test(fs.readFileSync(file, 'utf8')));
    return { ok: bad.length === 0, detail: bad.length ? bad.map((f) => path.relative(ROOT, f)).join(', ') : `${files.length} files clean` };
  });
  const passed = checks.filter((c) => c.ok).length;
  process.stdout.write(`${passed === checks.length ? 'PASS' : 'FAIL'}: consistency (${passed}/${checks.length})\n`);
  return { ok: passed === checks.length, name: 'consistency', checks };
}

function main() {
  process.stdout.write('Chickenbots V6 validation\n');
  process.stdout.write(quick ? 'Mode: quick (sampled schematics)\n' : 'Mode: full\n');
  const results = [];
  results.push(step('lint', process.execPath, ['scripts/lint.js']));
  results.push(step('tests', process.execPath, ['--test', '--test-concurrency=1', 'tests/*.test.js']));
  results.push(step('schematics validation', process.execPath, quick ? ['scripts/schematics-validate.js', '--sample=120'] : ['scripts/schematics-validate.js']));
  results.push(consistency());
  const failed = results.filter((r) => !r.ok);
  process.stdout.write('\n');
  for (const result of results) process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n`);
  if (failed.length) {
    process.stderr.write(`\nVALIDATION FAILED (${failed.length} step(s))\n`);
    process.exit(1);
  }
  process.stdout.write('\nVALIDATION PASSED\n');
}

main();
