'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { config } = require('../config');
const { importSchematic, exportSchematic, FORMATS, detectFormat } = require('./schematicIO');
const { LIMITS } = require('../schematics/limits');
const { BlockRegistry } = require('./blockRegistry');

const SUPPORTED = new Set(['.schem', '.litematic', '.schematic', '.nbt', '.json', '.cbschem']);

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function slug(value) {
  return String(value || 'schematic').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'schematic';
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Custom schematic catalogue.
 *
 * The index stores metadata only; block data lives in a converted cache and is
 * loaded lazily. Imported files are never silently modified. Duplicate content
 * is detected by SHA-256, duplicate geometry by the existing geometry hash, and
 * unsupported formats fail with a specific reason instead of being counted.
 */
class CustomSchematicStore extends EventEmitter {
  constructor({
    dir = path.join(config.paths.schematicData, 'custom'),
    indexFile = null, cacheDir = null, registry = null, logger = null,
    enabled = true, watch = false, maxCache = 16
  } = {}) {
    super();
    this.dir = dir;
    this.indexFile = indexFile || path.join(dir, 'index.json');
    this.cacheDir = cacheDir || path.join(dir, '.cache');
    this.registry = registry || new BlockRegistry({ version: config.building?.minecraftVersion || null });
    this.logger = logger;
    this.enabled = enabled !== false;
    this.maxCache = Math.max(2, maxCache);
    this.entries = new Map();
    this.ignored = new Set();
    this.cache = new Map();
    this.stats = { discovered: 0, imported: 0, rejected: 0, duplicates: 0, contentDuplicates: 0, geometryDuplicates: 0, invalid: 0, lastScanAt: null };
    this.watcher = null;
    this._scanTimer = null;
    this.loadIndex();
    if (watch && this.enabled) this.startWatching();
  }

  get count() { return this.entries.size; }

  loadIndex() {
    try {
      if (!fs.existsSync(this.indexFile)) return this;
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (!raw || !Array.isArray(raw.entries)) return this;
      this.entries = new Map(raw.entries.map((entry) => [entry.id, entry]));
      this.ignored = new Set(Array.isArray(raw.ignored) ? raw.ignored : []);
      this.stats = { ...this.stats, ...(raw.stats || {}) };
    } catch (err) {
      if (this.logger) this.logger.warn(`custom schematic index unreadable: ${err.message}`);
    }
    return this;
  }

  saveIndex() {
    atomicWrite(this.indexFile, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stats: this.stats,
      ignored: [...this.ignored],
      entries: [...this.entries.values()]
    }, null, 2));
  }

  *files() {
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir)) {
      if (name.startsWith('.')) continue;
      if (path.basename(this.indexFile) === name) continue;
      const full = path.join(this.dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch (err) { continue; }
      if (!stat.isFile()) continue;
      if (!SUPPORTED.has(path.extname(name).toLowerCase())) continue;
      yield { name, full, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }

  /** Scan the folder. `import` errors are recorded, never counted as builds. */
  scan({ force = false, persist = true } = {}) {
    if (!this.enabled) return { ok: true, disabled: true, imported: 0, discovered: 0 };
    const started = Date.now();
    const byPath = new Map([...this.entries.values()].map((entry) => [entry.file, entry]));
    this.stats.discovered = 0;
    this.stats.rejected = 0;
    let imported = 0; let rejected = 0;
    for (const file of this.files()) {
      this.stats.discovered++;
      const existing = byPath.get(file.name);
      if (existing && !force && existing.fileMtimeMs === file.mtimeMs) continue;
      if (file.size > LIMITS.MAX_INPUT_BYTES) {
        this.stats.rejected++;
        rejected++;
        if (this.logger) this.logger.warn(`custom schematic ${file.name} is ${file.size} bytes; skipping the ${LIMITS.MAX_INPUT_BYTES}-byte import limit`);
        continue;
      }
      const result = this.importFile(file.full, { filename: file.name, source: existing?.source || 'folder', licence: existing?.licence || 'UNKNOWN', persist: false, scan: true });
      if (result.ok) imported++;
      else rejected++;
    }
    this.stats.lastScanAt = new Date().toISOString();
    this.stats.lastScanMs = Date.now() - started;
    if (persist) this.saveIndex();
    this.emit('scanned', { imported, rejected, ...this.stats });
    return { ok: true, imported, rejected, discovered: this.stats.discovered, count: this.entries.size, ms: this.stats.lastScanMs };
  }

  _entryId(filename, buffer) {
    const base = slug(path.basename(filename, path.extname(filename)));
    const suffix = sha256(buffer).slice(0, 8);
    let id = `custom_${base}`;
    if (this.entries.has(id)) id = `custom_${base}_${suffix}`;
    return id;
  }

  importFile(fileOrBuffer, {
    filename = null, name = null, source = 'local', author = null, licence = 'UNKNOWN',
    tags = [], category = 'custom', persist = true, force = false, scan = false
  } = {}) {
    if (!this.enabled) return { ok: false, error: 'custom schematics are disabled' };
    let buffer = fileOrBuffer;
    let filePath = null;
    if (typeof fileOrBuffer === 'string') {
      filePath = fileOrBuffer;
      filename = filename || path.basename(fileOrBuffer);
      try {
        const stat = fs.statSync(fileOrBuffer);
        if (stat.size > LIMITS.MAX_INPUT_BYTES) return { ok: false, error: `${filename} is ${stat.size} bytes; the import limit is ${LIMITS.MAX_INPUT_BYTES}` };
        buffer = fs.readFileSync(fileOrBuffer);
      } catch (err) { return { ok: false, error: `cannot read ${filename}: ${err.message}` }; }
    }
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
    const contentHash = sha256(buffer);
    if (this.ignored.has(contentHash) && !force) {
      return { ok: false, ignored: true, reason: 'this file was removed from the catalogue; re-import it explicitly with force to restore it' };
    }
    for (const entry of this.entries.values()) {
      if (entry.contentHash === contentHash && !force) {
        this.stats.contentDuplicates++;
        return { ok: false, duplicate: true, reason: 'identical file content', existing: entry.id };
      }
    }
    const format = detectFormat(buffer, filename);
    if (!format) return { ok: false, error: 'unsupported schematic format' };
    const importedResult = importSchematic(buffer, { filename, registry: this.registry, name });
    if (!importedResult.ok) {
      this.stats.rejected++;
      return { ok: false, error: importedResult.error, format };
    }
    const schematic = importedResult.schematic;
    // Geometry duplicates are not new catalogue entries. Keep the reason.
    for (const entry of this.entries.values()) {
      if (entry.geometryHash && entry.geometryHash === schematic.geometryHash && !force) {
        this.stats.geometryDuplicates++;
        return { ok: false, duplicate: true, reason: `same geometry as ${entry.id} (rotations/mirrors are not new builds)`, existing: entry.id };
      }
    }
    if (importedResult.invalidBlocks > 0) this.stats.invalid++;
    const id = filePath ? this._entryId(filename, buffer) : (name ? `custom_${slug(name)}_${contentHash.slice(0, 6)}` : this._entryId(filename || 'import', buffer));
    const finalId = this.entries.has(id) && force ? `${id}_${contentHash.slice(8, 12)}` : id;
    const cachePath = path.join(this.cacheDir, `${finalId}.json`);
    atomicWrite(cachePath, JSON.stringify({ ...schematic, custom: true }));
    const entry = {
      id: finalId,
      name: name || schematic.name || path.basename(filename || 'Imported schematic', path.extname(filename || '')),
      format,
      category,
      tags: [...new Set([...(tags || []), 'custom', format])],
      filename: filename || null,
      file: filename || `${finalId}.${format === FORMATS.NATIVE ? 'json' : 'schemat'}`,
      fileMtimeMs: filePath && fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : Date.now(),
      contentHash,
      geometryHash: schematic.geometryHash,
      exactHash: schematic.exactHash,
      dimensions: schematic.dimensions,
      blocks: schematic.blocks.length,
      paletteSize: schematic.palette.length,
      materials: schematic.materials,
      warnings: importedResult.warnings || [],
      invalidBlocks: importedResult.invalidBlocks || 0,
      source: { kind: source, author, url: null },
      licence,
      version: importedResult.registry?.version || null,
      versionExact: importedResult.registry?.exact || false,
      importedAt: new Date().toISOString(),
      cachePath,
      enabled: true,
      validated: importedResult.invalidBlocks === 0
    };
    this.entries.set(finalId, entry);
    this.cache.delete(finalId);
    if (!scan) this.stats.imported++;
    if (persist) this.saveIndex();
    this.emit('imported', entry);
    return { ok: true, entry, schematic, format, warnings: importedResult.warnings, duplicate: false };
  }

  list({ q = null, category = null, tag = null, format = null, limit = 100, offset = 0 } = {}) {
    let entries = [...this.entries.values()].filter((entry) => entry.enabled !== false);
    if (category) entries = entries.filter((entry) => entry.category === category);
    if (tag) entries = entries.filter((entry) => (entry.tags || []).includes(tag));
    if (format) entries = entries.filter((entry) => entry.format === format);
    if (q) {
      const query = String(q).toLowerCase();
      entries = entries.filter((entry) => entry.id.toLowerCase().includes(query)
        || entry.name.toLowerCase().includes(query)
        || (entry.tags || []).some((tagName) => tagName.includes(query))
        || Object.keys(entry.materials || {}).some((material) => material.includes(query)));
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }

  get(id) { return this.entries.get(id) || null; }

  build(id) {
    if (this.cache.has(id)) {
      const value = this.cache.get(id);
      this.cache.delete(id); this.cache.set(id, value);
      return value;
    }
    const entry = this.entries.get(id);
    if (!entry) return null;
    let schematic;
    try { schematic = JSON.parse(fs.readFileSync(entry.cachePath, 'utf8')); }
    catch (err) { return null; }
    schematic.custom = true;
    schematic.tier = 'custom';
    schematic.category = entry.category || 'custom';
    schematic.name = entry.name;
    schematic.sourceAttribution = entry.source;
    schematic.licence = entry.licence;
    this.cache.set(id, schematic);
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    return schematic;
  }

  rename(id, name) {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: 'unknown custom schematic' };
    if (!name || !String(name).trim()) return { ok: false, error: 'name is required' };
    entry.name = String(name).trim();
    entry.tags = [...new Set([...(entry.tags || []), 'renamed'])];
    this._touch(entry);
    return { ok: true, entry };
  }

  tag(id, tags = []) {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: 'unknown custom schematic' };
    entry.tags = [...new Set([...(entry.tags || []), ...tags.map((tag) => String(tag).toLowerCase())])];
    this._touch(entry);
    return { ok: true, entry };
  }

  setLicence(id, licence) {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: 'unknown custom schematic' };
    entry.licence = licence || 'UNKNOWN';
    this._touch(entry);
    return { ok: true, entry };
  }

  duplicate(id, { name = null } = {}) {
    const source = this.build(id);
    const entry = this.entries.get(id);
    if (!source || !entry) return { ok: false, error: 'unknown custom schematic' };
    const copy = { ...source, id: null, name: name || `${entry.name} copy` };
    return this.importFile(Buffer.from(JSON.stringify(copy)), {
      filename: `${slug(copy.name)}.json`, name: copy.name, source: 'duplicate',
      licence: entry.licence, tags: [...(entry.tags || []), 'copy'], force: true
    });
  }

  export(id, format = FORMATS.SPONGE) {
    const schematic = this.build(id);
    if (!schematic) return { ok: false, error: 'unknown custom schematic' };
    try {
      const exported = exportSchematic(schematic, format);
      return { ok: true, ...exported };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: 'unknown custom schematic' };
    this.entries.delete(id);
    this.cache.delete(id);
    if (entry.contentHash) this.ignored.add(entry.contentHash);
    try { if (entry.cachePath && fs.existsSync(entry.cachePath)) fs.unlinkSync(entry.cachePath); } catch (err) { /* keep going */ }
    this.saveIndex();
    this.emit('removed', entry);
    return { ok: true, id };
  }

  reimport(id) {
    const entry = this.entries.get(id);
    if (!entry || !entry.filename) return { ok: false, error: 'no source file to reimport' };
    const full = path.join(this.dir, entry.filename);
    if (!fs.existsSync(full)) return { ok: false, error: `source file ${entry.filename} no longer exists` };
    return this.importFile(full, {
      filename: entry.filename, name: entry.name, source: entry.source?.kind || 'folder',
      licence: entry.licence, tags: entry.tags, force: true
    });
  }

  startWatching() {
    if (this.watcher || !this.enabled) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (event, filename) => {
        if (!filename || filename.startsWith('.') || filename === 'index.json') return;
        if (!SUPPORTED.has(path.extname(filename).toLowerCase())) return;
        clearTimeout(this._scanTimer);
        this._scanTimer = setTimeout(() => {
          try { this.scan({ persist: true }); } catch (err) { this.emit('error', err); }
        }, 750);
      });
      this.watcher.on('error', (err) => this.emit('error', err));
      return true;
    } catch (err) {
      if (this.logger) this.logger.warn(`custom schematic watcher unavailable: ${err.message}`);
      return false;
    }
  }

  stopWatching() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    clearTimeout(this._scanTimer);
  }

  _touch(entry) {
    entry.updatedAt = new Date().toISOString();
    this.saveIndex();
    this.emit('updated', entry);
  }

  statsSummary() {
    const entries = [...this.entries.values()];
    const byFormat = {};
    const byCategory = {};
    for (const entry of entries) {
      byFormat[entry.format] = (byFormat[entry.format] || 0) + 1;
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    }
    return {
      enabled: this.enabled,
      count: entries.length,
      validated: entries.filter((entry) => entry.validated).length,
      withWarnings: entries.filter((entry) => (entry.warnings || []).length).length,
      invalidBlocks: entries.filter((entry) => entry.invalidBlocks > 0).length,
      byFormat,
      byCategory,
      discovered: this.stats.discovered,
      imported: this.stats.imported,
      rejected: this.stats.rejected,
      duplicates: this.stats.contentDuplicates + this.stats.geometryDuplicates,
      geometryDuplicates: this.stats.geometryDuplicates,
      contentDuplicates: this.stats.contentDuplicates,
      lastScanAt: this.stats.lastScanAt,
      watching: Boolean(this.watcher),
      dir: this.dir
    };
  }
}

module.exports = { CustomSchematicStore, SUPPORTED, sha256 };
