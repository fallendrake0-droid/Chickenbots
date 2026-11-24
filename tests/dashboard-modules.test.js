'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'js');

function modules() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

function exportsOf(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

test('every browser module named import resolves to a real export', () => {
  const files = modules();
  const exports = new Map(files.map((file) => [file, exportsOf(fs.readFileSync(file, 'utf8'))]));
  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // A browser module graph fails at link time when a named import is absent;
    // Node syntax checks alone do not catch it, so assert the real names here.
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[2]);
      const available = exports.get(target);
      if (!available) {
        missing.push({ file: path.relative(ROOT, file), import: match[2], reason: 'module not found' });
        continue;
      }
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && !available.has(name)) missing.push({ file: path.relative(ROOT, file), import: match[2], name });
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('app.js is the only boot module and the shell has a mount point', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/);
  assert.match(html, /id="view"/);
  assert.match(html, /id="nav"/);
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(app, /^start\(\);$/m);
});
