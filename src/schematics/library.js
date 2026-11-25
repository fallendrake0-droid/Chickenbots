'use strict';

const fs = require('fs');
const path = require('path');
const { createSpec, generateSchematic, titleCase } = require('./generator');
const { config } = require('../config');
const { CustomSchematicStore } = require('../building/customLibrary');

const CATEGORY_LISTS = {
  beginner: ['shelter', 'cabin', 'farm_shed', 'watchtower', 'well', 'garden', 'dock', 'bridge', 'shrine', 'mine_entrance'],
  novice: ['cottage', 'barn', 'workshop', 'gatehouse', 'pier', 'treehouse', 'stable', 'fountain', 'plaza', 'tunnel'],
  apprentice: ['house', 'mill', 'forge', 'chapel', 'harbor', 'underground_room', 'greenhouse', 'pagoda', 'aqueduct', 'dojo'],
  intermediate: ['keep', 'inn', 'guildhall', 'library', 'observatory', 'maze', 'park', 'road', 'railway', 'courtyard'],
  advanced: ['castle', 'temple', 'fortress', 'academy', 'station', 'villa', 'underground_base', 'city_block', 'warehouse', 'plaza'],
  expert: ['citadel', 'palace', 'grand_temple', 'mansion', 'skyscraper', 'pyramid', 'mountain_keep', 'subterranean_city', 'royal_gardens', 'harbor'],
  master: ['mega_castle', 'cathedral_complex', 'floating_island', 'sky_city', 'underground_metropolis', 'grand_station', 'imperial_palace', 'fortress_city', 'arcane_academy', 'titan_forge'],
  grandmaster: ['kingdom', 'metropolis', 'mega_base', 'floating_citadel', 'underground_kingdom', 'colossal_castle', 'world_tree_palace', 'sunken_city', 'sky_fortress', 'eternal_library']
};

const TIER_NAMES = ['beginner', 'novice', 'apprentice', 'intermediate', 'advanced', 'expert', 'master', 'grandmaster'];
// The original 1,120 designs are preserved as the "core" slice. Extra
// catalogue designs are weighted toward small/mid structures, where the
// generator has the deepest combinatorial space, so every one is genuine
// geometry rather than a renamed duplicate.
const CORE_COUNTS = [100, 100, 150, 150, 150, 150, 150, 170];
// Exact 10,000 catalogue. The beginner/novice caps are the measured number of
// distinct geometries their structural space accepts; the remainder is placed
// in apprentice and above, where every candidate was accepted. This keeps the
// library at exactly 10,000 without renaming a duplicate or lowering the bar.
const TARGET_COUNTS_10K = [962, 2847, 3115, 1304, 682, 505, 327, 258];
const CATALOGUE_WEIGHTS = [0.10, 0.34, 0.30, 0.13, 0.06, 0.04, 0.02, 0.01];

function buildTierPlan(total = config.schematics.targetCount) {
  const target = Math.max(CORE_COUNTS.reduce((sum, n) => sum + n, 0), Number(total) || 0);
  let counts;
  if (target === 10000) {
    counts = TARGET_COUNTS_10K.slice();
  } else {
    const extra = target - CORE_COUNTS.reduce((sum, n) => sum + n, 0);
    counts = CORE_COUNTS.map((count, index) => count + Math.floor(extra * CATALOGUE_WEIGHTS[index]));
    counts[1] += target - counts.reduce((sum, n) => sum + n, 0);
  }
  let start = 1;
  return counts.map((count, index) => {
    const entry = { tier: index + 1, name: TIER_NAMES[index], count, start };
    start += count;
    return entry;
  });
}

const TIER_PLAN = buildTierPlan();

const MANIFEST_VERSION = 2;
const DEFAULT_SEED = 'chickenbots-v4-architecture';
const MANIFEST_PATH = path.join(config.paths.schematicData, 'manifest.json');
const SUMMARY_PATH = path.join(config.paths.schematicData, 'summary.json');

function designId(number, tierName, category) {
  return `${String(number).padStart(4, '0')}_${tierName}_${category}`;
}

function designName(number, tierName, category) {
  return `${titleCase(tierName)} ${titleCase(category)} ${String(number).padStart(3, '0')}`;
}

/** Deterministic list of structural specs covering the whole library. */
function enumerateSpecs({ seed = DEFAULT_SEED, plan = TIER_PLAN } = {}) {
  const specs = [];
  for (const tierPlan of plan) {
    const categories = CATEGORY_LISTS[tierPlan.name];
    for (let i = 0; i < tierPlan.count; i++) {
      const category = categories[i % categories.length];
      const variant = Math.floor(i / categories.length);
      const number = tierPlan.start + i;
      specs.push({
        tier: tierPlan.tier,
        tierName: tierPlan.name,
        category,
        variant,
        number,
        id: designId(number, tierPlan.name, category),
        name: designName(number, tierPlan.name, category),
        seed
      });
    }
  }
  return specs;
}

function manifestEntry(chosen, number) {
  return {
    id: chosen.id,
    number,
    name: chosen.name,
    tier: chosen.tier,
    tierIndex: chosen.tierIndex,
    difficulty: chosen.difficulty,
    category: chosen.category,
    archetype: chosen.archetype,
    style: chosen.style,
    dimensions: chosen.dimensions,
    materials: chosen.materials,
    phases: chosen.phases,
    geometryHash: chosen.geometryHash,
    exactHash: chosen.exactHash,
    specHash: chosen.specHash,
    seed: chosen.seed,
    tags: chosen.tags,
    versionCompatibility: chosen.versionCompatibility,
    spec: chosen.spec
  };
}

/**
 * Generate the whole library, rejecting duplicate geometry and palette-only
 * variants. If a candidate collides, its spec is deterministically perturbed
 * and regenerated; failures are reported, never silently counted.
 *
 * The tier plan is a target, not a guarantee: small tiers have a finite
 * structural space. Any rejected slot is refilled by a real generated
 * apprentice design (not a renamed duplicate) so the requested total is
 * reached without lowering the uniqueness bar.
 */
function generateLibrary({ seed = DEFAULT_SEED, plan = TIER_PLAN, onProgress = null, maxAttempts = 12 } = {}) {
  const started = Date.now();
  const specs = enumerateSpecs({ seed, plan });
  const hashes = new Map();
  const specHashes = new Map();
  const entries = [];
  const rejected = [];
  for (let idx = 0; idx < specs.length; idx++) {
    const baseSpec = specs[idx];
    let chosen = null;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const structuralSpec = createSpec({
          tier: baseSpec.tier,
          category: baseSpec.category,
          // Perturbation changes the seed only; the structural family stays.
          variant: baseSpec.variant + attempt * 1000,
          number: baseSpec.number,
          seed: `${seed}:${attempt}`
        });
        const schematic = generateSchematic(structuralSpec, { id: baseSpec.id, name: baseSpec.name });
        if (hashes.has(schematic.geometryHash)) {
          lastError = `duplicate geometry of ${hashes.get(schematic.geometryHash)}`;
          continue;
        }
        if (specHashes.has(schematic.specHash)) {
          lastError = `duplicate structural spec of ${specHashes.get(schematic.specHash)}`;
          continue;
        }
        chosen = schematic;
        hashes.set(schematic.geometryHash, baseSpec.id);
        specHashes.set(schematic.specHash, baseSpec.id);
        break;
      } catch (err) {
        lastError = err.message;
      }
    }
    if (chosen) {
      entries.push(manifestEntry(chosen, baseSpec.number));
    } else {
      rejected.push({ id: baseSpec.id, category: baseSpec.category, tier: baseSpec.tierName, reason: lastError });
    }
    if (onProgress && (idx % 25 === 0 || idx === specs.length - 1)) {
      onProgress({ done: idx + 1, total: specs.length, accepted: entries.length, rejected: rejected.length });
    }
  }
  // Refill rejected slots with real, freshly generated apprentice designs.
  // The deterministic seed includes a supplement counter, and every candidate
  // still passes both geometry and structural-spec deduplication.
  let supplement = 0;
  while (entries.length < specs.length && supplement < 5000) {
    const category = CATEGORY_LISTS.apprentice[supplement % CATEGORY_LISTS.apprentice.length];
    const number = 10001 + supplement;
    const id = designId(number, 'apprentice', category);
    let chosen = null;
    let lastError = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const structuralSpec = createSpec({
          tier: 3, category, variant: 5000 + supplement + attempt * 1000,
          number, seed: `${seed}:supplement:${attempt}`
        });
        const schematic = generateSchematic(structuralSpec, { id, name: designName(number, 'apprentice', category) });
        if (hashes.has(schematic.geometryHash)) { lastError = `duplicate geometry of ${hashes.get(schematic.geometryHash)}`; continue; }
        if (specHashes.has(schematic.specHash)) { lastError = `duplicate structural spec`; continue; }
        chosen = schematic;
        hashes.set(schematic.geometryHash, id);
        specHashes.set(schematic.specHash, id);
        break;
      } catch (err) { lastError = err.message; }
    }
    if (chosen) entries.push(manifestEntry(chosen, number));
    else rejected.push({ id, category, tier: 'apprentice', reason: lastError, supplement: true });
    supplement++;
  }
  const manifest = {
    version: MANIFEST_VERSION,
    generator: 'chickenbots-procedural-architecture',
    seed,
    generatedAt: new Date().toISOString(),
    generationMs: Date.now() - started,
    minimumRequired: config.schematics.minimumCount,
    counts: {
      total: entries.length,
      uniqueGeometry: new Set(entries.map((e) => e.geometryHash)).size,
      rejected: rejected.length,
      supplemented: entries.filter((e) => e.number > 10000).length,
      byTier: entries.reduce((acc, e) => { acc[e.tier] = (acc[e.tier] || 0) + 1; return acc; }, {}),
      byCategory: entries.reduce((acc, e) => { acc[e.category] = (acc[e.category] || 0) + 1; return acc; }, {})
    },
    rejected,
    designs: entries
  };
  return manifest;
}

function saveManifest(manifest, file = MANIFEST_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function loadManifest(file = MANIFEST_PATH) {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || !Array.isArray(raw.designs)) return null;
  return raw;
}

class SchematicLibrary {
  constructor({ manifest = null, minCount = config.schematics.minimumCount, custom = undefined, enableCustom = null } = {}) {
    // A 10,000-design manifest is ~20 MB of JSON. Loading it in every runtime
    // (including a simulation or a dashboard status tick) is wasteful, so the
    // file is read on first use. An explicitly supplied manifest is already in
    // memory and is never re-read.
    this._manifest = manifest;
    this._manifestLoaded = Boolean(manifest);
    this._explicitManifest = Boolean(manifest);
    this.minCount = minCount;
    this.cache = new Map();
    this.byId = new Map();
    this._statsCache = null;
    this._categoryCache = null;
    this._summary = null;
    this._summaryLoaded = false;
    if (this._manifest && Array.isArray(this._manifest.designs)) {
      for (const design of this._manifest.designs) this.byId.set(design.id, design);
    }
    this.custom = custom || null;
    this._customEnabled = enableCustom === null ? Boolean(config.building?.customSchematics) : Boolean(enableCustom);
  }

  get manifest() {
    if (!this._manifestLoaded) {
      this._manifest = loadManifest();
      this._manifestLoaded = true;
      this._statsCache = null;
      this._categoryCache = null;
      if (this._manifest) for (const design of this._manifest.designs) this.byId.set(design.id, design);
    }
    return this._manifest;
  }

  set manifest(value) {
    this._manifest = value;
    this._manifestLoaded = true;
    this._statsCache = null;
    this._categoryCache = null;
    this._summary = null;
    this._summaryLoaded = false;
    this.byId.clear();
    if (value && Array.isArray(value.designs)) for (const design of value.designs) this.byId.set(design.id, design);
  }

  get customStore() {
    if (this.custom === false) return null;
    if (!this.custom && this._customEnabled) {
      this.custom = new CustomSchematicStore({
        dir: config.building?.customDir,
        enabled: true,
        watch: false,
        registry: null
      });
      this.custom.scan({ persist: true });
    }
    return this.custom || null;
  }

  /**
   * Small generated aggregate of the catalogue. Never parses the 20 MB
   * manifest; a missing/corrupt file simply falls back to the full load.
   */
  get summaryStats() {
    if (!this._summaryLoaded) {
      this._summaryLoaded = true;
      try {
        // A committed summary for a deleted manifest would otherwise report a
        // library that cannot serve a design. Existence is cheap; no parse.
        if (fs.existsSync(MANIFEST_PATH) && fs.existsSync(SUMMARY_PATH)) {
          this._summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
        }
      } catch (_) { this._summary = null; }
    }
    return this._summary;
  }

  get summaryLoaded() { return Boolean(this.summaryStats); }
  // A summary is enough for status/health; reading individual designs still
  // requires the full manifest and remains lazy.
  get loaded() { return Boolean(this._manifest) || this.summaryLoaded; }
  /** Non-loading probe: true only if the manifest is already in memory. */
  get loadedInMemory() { return Boolean(this._manifest); }
  /** Count known without constructing/scanning the custom store. */
  get knownCount() {
    const base = this._manifest ? this._manifest.designs.length : (this.summaryLoaded ? this.summaryStats.count : 0);
    const store = this._customEnabled ? this.custom : null;
    return base + (store ? store.count : 0);
  }
  get count() {
    const base = this.manifest ? this.manifest.designs.length : 0;
    const store = this.customStore;
    return base + (store ? store.count : 0);
  }

  list(filter = {}) {
    let designs = this.manifest ? this.manifest.designs.slice() : [];
    if (filter.tier) designs = designs.filter((d) => d.tier.toLowerCase() === String(filter.tier).toLowerCase());
    if (filter.category) designs = designs.filter((d) => d.category === filter.category);
    if (filter.style) designs = designs.filter((d) => d.style === filter.style);
    if (filter.maxWidth) designs = designs.filter((d) => d.dimensions.width <= filter.maxWidth);
    if (filter.q) {
      const q = String(filter.q).toLowerCase();
      designs = designs.filter((d) => d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q) || (d.tags || []).some((t) => t.includes(q)));
    }
    const store = this.customStore;
    if (store && !filter.excludeCustom) {
      const customEntries = store.list({
        q: filter.q, category: filter.category, tag: filter.tag,
        format: filter.format, limit: Number.MAX_SAFE_INTEGER
      }).map((entry) => ({
        id: entry.id,
        name: entry.name,
        tier: 'custom',
        category: entry.category,
        style: entry.format,
        dimensions: entry.dimensions,
        difficulty: 0,
        blocks: entry.blocks,
        custom: true,
        format: entry.format,
        licence: entry.licence,
        tags: entry.tags,
        source: entry.source,
        warnings: entry.warnings,
        validated: entry.validated
      }));
      designs = [...customEntries, ...designs];
    }
    if (filter.sort === 'blocks') designs.sort((a, b) => (a.blocks || 0) - (b.blocks || 0));
    else if (filter.sort === 'name') designs.sort((a, b) => a.name.localeCompare(b.name));
    const offset = Math.max(0, Number(filter.offset) || 0);
    const limit = filter.limit === undefined ? 100 : filter.limit;
    const page = Number.isFinite(limit) ? designs.slice(offset, offset + limit) : designs.slice(offset);
    return page.map((d) => ({
      id: d.id, name: d.name, tier: d.tier, category: d.category, style: d.style,
      dimensions: d.dimensions, difficulty: d.difficulty,
      blocks: d.blocks !== undefined ? d.blocks : Object.values(d.materials || {}).reduce((s, n) => s + n, 0),
      custom: Boolean(d.custom), format: d.format || null, licence: d.licence || null,
      tags: d.tags || [], validated: d.validated !== false, warnings: d.warnings || []
    }));
  }

  get(id) {
    // Touch the lazy manifest first so byId is populated for an explicit or
    // on-disk manifest before the first lookup.
    void this.manifest;
    const entry = this.byId.get(id);
    if (entry) return { ...entry };
    const store = this.customStore;
    const custom = store ? store.get(id) : null;
    if (!custom) return null;
    return { ...custom, custom: true, tier: 'custom', style: custom.format };
  }

  /** Regenerate full block data for a design, or load a custom one lazily. */
  build(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const entry = this.get(id);
    if (!entry) return null;
    let schematic;
    if (entry.custom) {
      const store = this.customStore;
      schematic = store ? store.build(id) : null;
      if (!schematic) return null;
    } else {
      schematic = generateSchematic(entry.spec, { id: entry.id, name: entry.name });
    }
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(id, schematic);
    return schematic;
  }

  search(query, limit = 20) { return this.list({ q: query, limit }); }

  categories() {
    if (!this._categoryCache) {
      const base = new Map();
      for (const d of (this.manifest ? this.manifest.designs : [])) base.set(d.category, (base.get(d.category) || 0) + 1);
      this._categoryCache = base;
    }
    const map = new Map(this._categoryCache);
    const store = this.customStore;
    if (store) for (const entry of store.list({ limit: Number.MAX_SAFE_INTEGER })) {
      map.set(entry.category, (map.get(entry.category) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }));
  }

  stats() {
    // Startup/dashboard path: use the generated summary when the full manifest
    // has not been needed yet. A 3.3 KB read replaces the ~20 MB JSON.parse
    // that took 7.2 s on the live box.
    const summary = this.summaryStats;
    const summaryMatchesManifest = summary && !this._explicitManifest && (!this._manifestLoaded
      || !this._manifest.generatedAt
      || this._manifest.generatedAt === summary.manifestGeneratedAt);
    if (summaryMatchesManifest) {
      const store = this.customStore;
      const customStats = store ? store.statsSummary() : null;
      return {
        ...summary,
        minimumRequired: this.minCount,
        meetsMinimum: summary.count >= this.minCount,
        generatedAt: summary.manifestGeneratedAt || null,
        custom: customStats,
        totalIncludingCustom: summary.count + (customStats ? customStats.count : 0),
        fromSummary: true
      };
    }
    if (!this.manifest) return { loaded: false, count: 0 };
    const store = this.customStore;
    const customStats = store ? store.statsSummary() : null;
    // The 10,000-design manifest is static between generations. Walking every
    // material map and re-sorting categories on each dashboard snapshot cost
    // more than a second and blocked keep-alive/tick processing, so the base
    // half is computed once and only custom-store counts are refreshed.
    if (!this._statsCache) {
      const designs = this.manifest.designs;
      const blockCounts = designs.map((d) => Object.values(d.materials).reduce((s, n) => s + n, 0));
      const materialTotals = {};
      for (const d of designs) for (const [name, n] of Object.entries(d.materials)) materialTotals[name] = (materialTotals[name] || 0) + n;
      const topMaterials = Object.entries(materialTotals).sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([name, count]) => ({ name, count }));
      this._statsCache = {
        loaded: true,
        count: designs.length,
        minimumRequired: this.minCount,
        meetsMinimum: designs.length >= this.minCount,
        uniqueGeometry: new Set(designs.map((d) => d.geometryHash)).size,
        tiers: [...new Set(designs.map((d) => d.tier))].map((tier) => ({ tier, count: designs.filter((d) => d.tier === tier).length })),
        categories: this.categories(),
        blocks: {
          total: blockCounts.reduce((s, n) => s + n, 0),
          // Math.min(...[]) is Infinity and 0/0 is NaN; an empty manifest must
          // report zeros rather than poison the dashboard JSON.
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
        generatedAt: this.manifest.generatedAt,
        generationMs: this.manifest.generationMs,
        rejected: (this.manifest.rejected || []).length
      };
    }
    return {
      ...this._statsCache,
      custom: customStats,
      totalIncludingCustom: this._statsCache.count + (customStats ? customStats.count : 0)
    };
  }
}

module.exports = {
  CATEGORY_LISTS, TIER_PLAN, MANIFEST_VERSION, DEFAULT_SEED, MANIFEST_PATH,
  enumerateSpecs, generateLibrary, saveManifest, loadManifest, SchematicLibrary,
  designId, designName
};
