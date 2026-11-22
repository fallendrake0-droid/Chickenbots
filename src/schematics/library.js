'use strict';

const fs = require('fs');
const path = require('path');
const { createSpec, generateSchematic, titleCase } = require('./generator');
const { config } = require('../config');

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

const TIER_PLAN = [
  { tier: 1, name: 'beginner', count: 100, start: 1 },
  { tier: 2, name: 'novice', count: 100, start: 101 },
  { tier: 3, name: 'apprentice', count: 150, start: 201 },
  { tier: 4, name: 'intermediate', count: 150, start: 351 },
  { tier: 5, name: 'advanced', count: 150, start: 501 },
  { tier: 6, name: 'expert', count: 150, start: 651 },
  { tier: 7, name: 'master', count: 150, start: 801 },
  { tier: 8, name: 'grandmaster', count: 170, start: 951 }
];

const MANIFEST_VERSION = 2;
const DEFAULT_SEED = 'chickenbots-v4-architecture';
const MANIFEST_PATH = path.join(config.paths.schematicData, 'manifest.json');

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

/**
 * Generate the whole library, rejecting duplicate geometry and palette-only
 * variants. If a candidate collides, its spec is deterministically perturbed
 * and regenerated; failures are reported, never silently counted.
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
      entries.push({
        id: chosen.id,
        number: baseSpec.number,
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
      });
    } else {
      rejected.push({ id: baseSpec.id, category: baseSpec.category, tier: baseSpec.tierName, reason: lastError });
    }
    if (onProgress && (idx % 25 === 0 || idx === specs.length - 1)) {
      onProgress({ done: idx + 1, total: specs.length, accepted: entries.length, rejected: rejected.length });
    }
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
  constructor({ manifest = null, minCount = config.schematics.minimumCount } = {}) {
    this.manifest = manifest || loadManifest();
    this.minCount = minCount;
    this.cache = new Map();
    this.byId = new Map();
    if (this.manifest) for (const d of this.manifest.designs) this.byId.set(d.id, d);
  }

  get loaded() { return Boolean(this.manifest); }
  get count() { return this.manifest ? this.manifest.designs.length : 0; }

  list(filter = {}) {
    if (!this.manifest) return [];
    let designs = this.manifest.designs;
    if (filter.tier) designs = designs.filter((d) => d.tier.toLowerCase() === String(filter.tier).toLowerCase());
    if (filter.category) designs = designs.filter((d) => d.category === filter.category);
    if (filter.style) designs = designs.filter((d) => d.style === filter.style);
    if (filter.maxWidth) designs = designs.filter((d) => d.dimensions.width <= filter.maxWidth);
    if (filter.q) {
      const q = String(filter.q).toLowerCase();
      designs = designs.filter((d) => d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q) || d.tags.some((t) => t.includes(q)));
    }
    const limit = filter.limit === undefined ? 100 : filter.limit;
    return designs.slice(0, limit).map((d) => ({
      id: d.id, name: d.name, tier: d.tier, category: d.category, style: d.style,
      dimensions: d.dimensions, difficulty: d.difficulty, blocks: Object.values(d.materials).reduce((s, n) => s + n, 0)
    }));
  }

  get(id) {
    const entry = this.byId.get(id);
    if (!entry) return null;
    return { ...this.manifest.designs.find((d) => d.id === id) };
  }

  /** Regenerate full block data for a design. */
  build(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const entry = this.get(id);
    if (!entry) return null;
    const schematic = generateSchematic(entry.spec, { id: entry.id, name: entry.name });
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(id, schematic);
    return schematic;
  }

  search(query, limit = 20) { return this.list({ q: query, limit }); }

  categories() {
    const map = new Map();
    for (const d of (this.manifest ? this.manifest.designs : [])) {
      map.set(d.category, (map.get(d.category) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }));
  }

  stats() {
    if (!this.manifest) return { loaded: false, count: 0 };
    const designs = this.manifest.designs;
    const blockCounts = designs.map((d) => Object.values(d.materials).reduce((s, n) => s + n, 0));
    const materialTotals = {};
    for (const d of designs) for (const [name, n] of Object.entries(d.materials)) materialTotals[name] = (materialTotals[name] || 0) + n;
    const topMaterials = Object.entries(materialTotals).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([name, count]) => ({ name, count }));
    return {
      loaded: true,
      count: designs.length,
      minimumRequired: this.minCount,
      meetsMinimum: designs.length >= this.minCount,
      uniqueGeometry: new Set(designs.map((d) => d.geometryHash)).size,
      tiers: [...new Set(designs.map((d) => d.tier))].map((tier) => ({ tier, count: designs.filter((d) => d.tier === tier).length })),
      categories: this.categories(),
      blocks: {
        total: blockCounts.reduce((s, n) => s + n, 0),
        min: Math.min(...blockCounts),
        max: Math.max(...blockCounts),
        average: Math.round(blockCounts.reduce((s, n) => s + n, 0) / blockCounts.length)
      },
      topMaterials,
      dimensions: {
        maxWidth: Math.max(...designs.map((d) => d.dimensions.width)),
        maxHeight: Math.max(...designs.map((d) => d.dimensions.height)),
        maxLength: Math.max(...designs.map((d) => d.dimensions.length))
      },
      generatedAt: this.manifest.generatedAt,
      generationMs: this.manifest.generationMs,
      rejected: designs.length === 0 ? 0 : (this.manifest.rejected || []).length
    };
  }
}

module.exports = {
  CATEGORY_LISTS, TIER_PLAN, MANIFEST_VERSION, DEFAULT_SEED, MANIFEST_PATH,
  enumerateSpecs, generateLibrary, saveManifest, loadManifest, SchematicLibrary,
  designId, designName
};
