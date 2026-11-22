#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['src', 'tests', 'scripts'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function main() {
  const files = TARGETS.flatMap((t) => (fs.existsSync(path.join(ROOT, t)) ? walk(path.join(ROOT, t)) : []));
  let failed = false;

  // 1. Every JavaScript file must parse.
  for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      process.stderr.write(`SYNTAX ${path.relative(ROOT, file)}\n${res.stderr}\n`);
      failed = true;
    }
  }

  // 2. Project-specific lint rules that matter for this codebase.
  const problems = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel === 'scripts/lint.js' || rel === 'scripts/validate-all.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/\bTODO\b|\bFIXME\b|\bnot implemented yet\b/.test(line) && !rel.startsWith('tests/')) {
        problems.push(`${rel}:${i + 1}: unfinished marker: ${line.trim()}`);
      }
      if (/\.only\(/.test(line)) problems.push(`${rel}:${i + 1}: .only() left in tests`);
      if (/\beval\s*\(/.test(line) || /new Function\s*\(/.test(line)) {
        problems.push(`${rel}:${i + 1}: dynamic code execution is forbidden (chat must never run code)`);
      }
      if (/child_process/.test(line) && rel.startsWith('src/commands/')) {
        problems.push(`${rel}:${i + 1}: command layer must not spawn processes`);
      }
      if (/Math\.random\(/.test(line) && (rel.startsWith('src/schematics/') || rel.startsWith('src/team/'))) {
        problems.push(`${rel}:${i + 1}: non-deterministic randomness in deterministic subsystem`);
      }
    });
  }
  if (problems.length) {
    process.stderr.write(`\nPROJECT RULES (${problems.length}):\n${problems.join('\n')}\n`);
    failed = true;
  }

  // 3. ESLint (recommended rules + project config).
  const eslint = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'eslint'), ['src', 'tests', 'scripts', '--ext', '.js', '--max-warnings', '200'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (eslint.stdout) process.stdout.write(eslint.stdout);
  if (eslint.stderr) process.stderr.write(eslint.stderr);
  if (eslint.status !== 0) {
    failed = true;
    process.stderr.write('ESLint reported errors.\n');
  }

  if (failed) {
    process.stderr.write('\nLINT FAILED\n');
    process.exit(1);
  }
  process.stdout.write(`\nLINT PASSED (${files.length} files checked)\n`);
}

main();
