'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(__dirname, 'public');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function hashFiles(files, root) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Read the checked-out revision without spawning a shell. Env overrides make
 * packaged/container builds identifiable even when .git is absent.
 */
function gitRevision() {
  const explicit = String(process.env.GIT_COMMIT || process.env.GITHUB_SHA || '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(explicit)) return explicit.toLowerCase();
  try {
    const gitDir = path.join(ROOT, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head;
    const match = head.match(/^ref:\s*(.+)$/);
    if (!match) return null;
    let ref = match[1].trim();
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim() || null;
    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split(/\r?\n/)) {
        const entry = line.match(/^([0-9a-f]{40})\s+(.+)$/);
        if (entry && entry[2] === ref) return entry[1];
      }
    }
    ref = null;
    return null;
  } catch (_) {
    return null;
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

/**
 * One build identity covers the served frontend and the backend source. The
 * dashboard puts frontendHash on every JS/CSS URL and reports both hashes via
 * /api/build so a stale tab can prove it is stale instead of silently acting
 * on an old interface.
 */
function buildInfo({ publicDir = PUBLIC_DIR, root = ROOT } = {}) {
  const frontendFiles = walk(publicDir);
  const backendFiles = walk(path.join(root, 'src')).filter((file) => /\.(?:js|json)$/i.test(file));
  const manifest = path.join(root, 'package.json');
  if (fs.existsSync(manifest)) backendFiles.push(manifest);
  const frontendHash = hashFiles(frontendFiles, publicDir).slice(0, 12);
  const backendHash = hashFiles(backendFiles, root).slice(0, 12);
  const gitCommit = gitRevision();
  const appVersion = packageVersion();
  const shortGit = gitCommit ? gitCommit.slice(0, 7) : 'nogit';
  const buildId = `${appVersion}+${shortGit}.${frontendHash}.${backendHash}`;
  return {
    appVersion,
    gitCommit,
    gitShort: gitCommit ? gitCommit.slice(0, 7) : null,
    frontendHash,
    backendHash,
    buildId,
    builtAt: new Date().toISOString(),
    node: process.version,
    files: { frontend: frontendFiles.length, backend: backendFiles.length }
  };
}

/**
 * Uptime for /healthz and /api/build. `process.uptime()` excludes time the
 * host was suspended, while the runtime's own uptime includes it, so the two
 * endpoints disagreed after a suspended sandbox resumed. Both now measure the
 * same calendar interval: now minus the process/build start time.
 */
function buildUptimeMs(build, now = Date.now()) {
  const started = Date.parse(build && build.builtAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

module.exports = { buildInfo, buildUptimeMs, hashFiles, walk, gitRevision, PUBLIC_DIR };
