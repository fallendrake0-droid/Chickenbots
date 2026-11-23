#!/usr/bin/env node
'use strict';

/**
 * Fail CI if a real credential is present in the tracked tree.
 *
 * The check reports only the file, line and pattern name — never the matched
 * value — so running it cannot itself leak a secret into a build log.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tracked = (() => {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch (_) {
    // Source archives without .git still get a targeted scan.
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'data', 'logs', 'coverage'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(path.relative(ROOT, full));
      }
    };
    walk(ROOT);
    return out;
  }
})();

const checks = [
  { name: 'committed env value', re: /^[ \t]*(?:MC_(?:LOGIN|REGISTER)_PASSWORD|DASHBOARD_TOKEN)[ \t]*=[ \t]*([^\s#]+)/gm, allow: (value) => !value || /^(?:""|'')$/.test(value) || /^\$\{|^<.*>$/.test(value) },
  { name: 'known demo credential', re: new RegExp('chickenbot' + '12345', 'g') },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g }
];

const findings = [];
for (const file of tracked) {
  if (file === 'package-lock.json' || file.startsWith('data/')) continue;
  const full = path.join(ROOT, file);
  let text;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    text = fs.readFileSync(full, 'utf8');
  } catch (_) { continue; }
  for (const check of checks) {
    check.re.lastIndex = 0;
    let match;
    while ((match = check.re.exec(text)) !== null) {
      const value = match[1] || '';
      if (check.allow && check.allow(value)) continue;
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      findings.push({ file, line, check: check.name });
    }
  }
}

if (findings.length) {
  process.stderr.write('SECRET LEAK CHECK FAILED\n');
  for (const finding of findings) process.stderr.write(`  ${finding.file}:${finding.line} (${finding.check})\n`);
  process.stderr.write('\nRemove the value, rotate the credential, and keep the real value in .env.\n');
  process.exit(1);
}
process.stdout.write(`SECRET LEAK CHECK PASSED (${tracked.length} tracked files; values never printed)\n`);
