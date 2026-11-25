'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { SchematicLibrary, loadManifest, MANIFEST_PATH, enumerateSpecs, TIER_PLAN } = require('../src/schematics/library');
const { createSpec, generateSchematic } = require('../src/schematics/generator');
const { geometryHash, exactHash, specHash, classOfBlock } = require('../src/schematics/designHash');
const {
  rotateSchematic, mirrorSchematic, translateSchematic, substituteMaterials,
  toSpongeSchematic, fromSpongeSchematic, toLegacySchematic, fromLegacySchematic,
  materialList, phaseBlocks, toJSON, fromJSON, varintEncode, varintDecode
} = require('../src/schematics/format');
const { validateSchematic, supportAnalysis, knownBlockSet } = require('../src/schematics/validate');

const manifest = loadManifest();
const library = new SchematicLibrary({ manifest });

function specFor(tier, category, variant = 0) {
  return createSpec({ tier, category, variant, number: tier * 100 + variant, seed: 'test-seed' });
}

function build(tier, category, variant = 0) {
  return generateSchematic(specFor(tier, category, variant), { id: `t${tier}-${category}`, name: `Test ${category}` });
}

test('library manifest covers every tier and the required minimum', () => {
  assert.ok(manifest, `manifest missing at ${MANIFEST_PATH}; run npm run schematics:generate`);
  assert.ok(manifest.designs.length >= 10000, `expected >= 10000 designs, got ${manifest.designs.length}`);
  const ids = new Set();
  const names = new Set();
  const hashes = new Set();
  for (const design of manifest.designs) {
    assert.ok(!ids.has(design.id), `duplicate id ${design.id}`);
    assert.ok(!names.has(design.name), `duplicate name ${design.name}`);
    assert.ok(!hashes.has(design.geometryHash), `duplicate geometry hash ${design.id}`);
    ids.add(design.id);
    names.add(design.name);
    hashes.add(design.geometryHash);
  }
  for (const tierPlan of TIER_PLAN) {
    const numbers = manifest.designs.filter((d) => d.tier === require('../src/schematics/generator').titleCase(tierPlan.name)).map((d) => d.number);
    // Small structural spaces can reject a duplicate; those slots are refilled
    // by real apprentice designs, so the plan is a floor, not an exact range.
    assert.ok(numbers.length >= Math.floor(tierPlan.count * 0.9), `${tierPlan.name} has ${numbers.length} designs`);
    assert.ok(numbers.length > 0, `${tierPlan.name} must be represented`);
  }
  assert.ok(new Set(manifest.designs.map((d) => d.category)).size >= 60);
});

test('library lookup, stats and filtering work on real manifest data', () => {
  const stats = library.stats();
  assert.ok(stats.meetsMinimum);
  assert.equal(stats.uniqueGeometry, stats.count);
  assert.ok(stats.tiers.length === 8);
  assert.ok(stats.blocks.total > 1_000_000);
  const first = manifest.designs[0];
  assert.ok(library.get(first.id));
  assert.equal(library.get('does-not-exist'), null);
  const filtered = library.list({ tier: first.tier.toLowerCase(), limit: 5 });
  assert.ok(filtered.length > 0 && filtered.length <= 5);
  assert.ok(library.search(first.category, 3).length > 0);
  const built = library.build(first.id);
  assert.equal(built.geometryHash, first.geometryHash);
  assert.equal(built.dimensions.width, first.dimensions.width);
});

test('generation is deterministic for identical specs', () => {
  const a = build(3, 'house', 2);
  const b = build(3, 'house', 2);
  assert.equal(a.exactHash, b.exactHash);
  assert.equal(a.geometryHash, b.geometryHash);
  assert.equal(a.blocks.length, b.blocks.length);
  const c = build(3, 'house', 3);
  assert.notEqual(a.geometryHash, c.geometryHash);
  assert.notEqual(specHash(a.spec), specHash(c.spec));
});

test('every archetype produces a valid, non-empty structure', () => {
  const categories = ['shelter', 'keep', 'chapel', 'skyscraper', 'bridge', 'garden', 'underground_base', 'treehouse'];
  const known = knownBlockSet();
  for (const category of categories) {
    const schematic = build(4, category, 1);
    assert.ok(schematic.blocks.length > 30, `${category} too small`);
    const result = validateSchematic(schematic, { knownBlocks: known });
    assert.ok(result.ok, `${category}: ${JSON.stringify(result.issues)}`);
    assert.ok(schematic.blocks.every(([x, y, z]) => x >= 0 && y >= 0 && z >= 0 && x < schematic.dimensions.width && y < schematic.dimensions.height && z < schematic.dimensions.length));
    assert.ok(schematic.phases.some((p) => p.name === 'FOUNDATION'));
    assert.ok(schematic.supports.length > 0);
    assert.equal(Object.values(schematic.materials).reduce((s, n) => s + n, 0), schematic.blocks.length);
  }
});

test('validation reports malformed schematics instead of throwing', () => {
  const noDims = validateSchematic({ palette: ['minecraft:stone'], blocks: [[0, 0, 0, 0]] });
  assert.equal(noDims.ok, false);
  assert.ok(noDims.issues.invalid.some((issue) => /dimensions/.test(issue)));
  const noPalette = validateSchematic({ dimensions: { width: 1, height: 1, length: 1 }, blocks: [[0, 0, 0, 0]] });
  assert.equal(noPalette.ok, false);
  assert.ok(noPalette.issues.invalid.includes('no palette'));
});

test('palette-only changes are detected as the same design', () => {
  const base = build(2, 'cottage', 0);
  const first = base.palette[0];
  const className = classOfBlock(first);
  const sameClass = {
    structure: 'stone', glass: 'glass', light: 'sea_lantern', interior: 'chest',
    roof: 'stone_bricks', decoration: 'oak_fence', vegetation: 'oak_leaves', water: 'water'
  }[className];
  const replacement = sameClass === first ? 'cobblestone' : sameClass;
  const recoloured = substituteMaterials(base, { [first]: replacement });
  assert.equal(recoloured.geometryHash, base.geometryHash, 'geometry hash must ignore palette');
  assert.notEqual(recoloured.exactHash, base.exactHash, 'exact hash must change with palette');
  assert.equal(specHash(recoloured.spec), specHash(base.spec));
  const rotated = rotateSchematic(base, 1);
  assert.equal(rotated.geometryHash, base.geometryHash, 'rotation must not create a new design');
  const mirrored = mirrorSchematic(base, 'x');
  assert.equal(mirrored.geometryHash, base.geometryHash, 'mirroring must not create a new design');
});

test('rotation and mirroring transform coordinates correctly', () => {
  const base = build(1, 'cabin', 0);
  const rotated = rotateSchematic(base, 1);
  assert.equal(rotated.dimensions.width, base.dimensions.length);
  assert.equal(rotated.dimensions.length, base.dimensions.width);
  assert.equal(rotated.blocks.length, base.blocks.length);
  const twice = rotateSchematic(rotated, 3);
  assert.equal(twice.dimensions.width, base.dimensions.width);
  assert.equal(twice.exactHash, base.exactHash);
  const moved = translateSchematic(base, 12, 3, -4);
  assert.equal(moved.exactHash, base.exactHash);
  const mirroredBack = mirrorSchematic(mirrorSchematic(base, 'x'), 'x');
  assert.equal(mirroredBack.exactHash, base.exactHash);
});

test('Sponge .schem export/import round-trips real structures', () => {
  const designs = [manifest.designs[0], manifest.designs[400], manifest.designs[800], manifest.designs[1119]];
  for (const design of designs) {
    const schematic = library.build(design.id);
    const buffer = toSpongeSchematic(schematic);
    assert.ok(buffer.length > 100);
    const imported = fromSpongeSchematic(buffer);
    assert.deepEqual(imported.dimensions, schematic.dimensions);
    assert.equal(imported.blocks.length, schematic.blocks.length);
    assert.equal(imported.geometryHash, schematic.geometryHash);
    assert.deepEqual(Object.entries(imported.materials).sort(), Object.entries(schematic.materials).sort());
  }
});

test('legacy .schematic export reports substitutions and imports back', () => {
  const schematic = build(1, 'shelter', 0);
  const { buffer, substituted } = toLegacySchematic(schematic);
  assert.ok(buffer.length > 50);
  const imported = fromLegacySchematic(buffer);
  assert.ok(imported.blocks.length > 0);
  assert.ok(imported.materials.stone > 0);
  assert.ok(Object.keys(substituted).length > 0, 'modern palette blocks should be substituted');
  const known = knownBlockSet();
  for (const name of Object.keys(imported.materials)) assert.ok(known.has(name), `${name} is not a real block`);
});

test('varint and JSON serialization are lossless', () => {
  const values = [0, 1, 2, 127, 128, 255, 256, 16383, 16384, 100000];
  assert.deepEqual(varintDecode(varintEncode(values)), values);
  const schematic = build(2, 'barn', 0);
  const restored = fromJSON(toJSON(schematic));
  assert.deepEqual(restored.blocks, schematic.blocks);
  assert.equal(restored.geometryHash, schematic.geometryHash);
});

test('material and phase helpers describe the build order', () => {
  const schematic = build(3, 'forge', 0);
  const materials = materialList(schematic, { limit: 5 });
  assert.equal(materials.length, 5);
  assert.ok(materials[0].count >= materials[4].count);
  const phases = phaseBlocks(schematic);
  assert.ok(phases.size >= 4);
  assert.ok(phases.has('FOUNDATION'));
  let total = 0;
  for (const blocks of phases.values()) total += blocks.length;
  assert.equal(total, schematic.blocks.length);
  assert.ok([...phases.keys()].indexOf('FOUNDATION') <= [...phases.keys()].indexOf('ROOF'));
});

test('support analysis catches floating structures and passes real ones', () => {
  const good = build(2, 'cottage', 0);
  const analysis = supportAnalysis(good);
  assert.ok(analysis.ok, `unexpected floating blocks: ${JSON.stringify(analysis.examples)}`);
  const floating = {
    ...good,
    blocks: [[0, 5, 0, 0, 1], [30, 7, 30, 0, 1]],
    palette: ['stone'],
    dims: { width: 31, height: 8, length: 31 },
    materials: { stone: 2 }
  };
  floating.dimensions = floating.dims;
  const bad = supportAnalysis(floating);
  assert.equal(bad.unsupported, 2);
  assert.equal(bad.ok, false);
});

test('block classification separates structure, decoration and light', () => {
  assert.equal(classOfBlock('stone_bricks'), 'structure');
  assert.equal(classOfBlock('oak_planks'), 'structure');
  assert.equal(classOfBlock('oak_fence'), 'decoration');
  assert.equal(classOfBlock('sea_lantern'), 'light');
  assert.equal(classOfBlock('oak_leaves'), 'vegetation');
  assert.equal(classOfBlock('glass_pane'), 'glass');
  assert.equal(classOfBlock('white_bed'), 'interior');
  assert.equal(classOfBlock('water'), 'water');
});

test('enumerated specs map one-to-one onto the manifest', () => {
  const specs = enumerateSpecs();
  assert.equal(specs.length, 10000);
  assert.equal(new Set(specs.map((s) => s.id)).size, 10000);
  const byNumber = new Map(manifest.designs.map((d) => [d.number, d]));
  for (const spec of specs.slice(0, 30)) {
    const entry = byNumber.get(spec.number);
    assert.ok(entry, `missing manifest entry for ${spec.number}`);
    assert.equal(entry.id, spec.id);
  }
  assert.ok(fs.existsSync(MANIFEST_PATH));
});

test('library statistics stay finite for an empty manifest', () => {
  const library = new SchematicLibrary({ manifest: { designs: [] }, custom: null, enableCustom: false });
  const stats = library.stats();
  assert.equal(stats.count, 0);
  assert.equal(stats.blocks.min, 0);
  assert.equal(stats.blocks.max, 0);
  assert.equal(stats.blocks.average, 0);
  assert.deepEqual(stats.dimensions, { maxWidth: 0, maxHeight: 0, maxLength: 0 });
});
