'use strict';

/**
 * Version-aware tree catalogue. The harvester identifies trees by block shape
 * and species, not by a hand-maintained list of whole-tree patterns, so a new
 * log variant (stripped, wood, hyphae) or a newer species still harvests.
 */
const SPECIES = Object.freeze({
  oak: {
    label: 'Oak', since: '1.0', footprint: 1, tall: false,
    logs: ['oak_log', 'oak_wood', 'stripped_oak_log', 'stripped_oak_wood'],
    leaves: ['oak_leaves'], sapling: 'oak_sapling', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  },
  birch: {
    label: 'Birch', since: '1.0', footprint: 1, tall: false,
    logs: ['birch_log', 'birch_wood', 'stripped_birch_log', 'stripped_birch_wood'],
    leaves: ['birch_leaves'], sapling: 'birch_sapling', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  },
  spruce: {
    label: 'Spruce', since: '1.0', footprint: 1, tall: true,
    logs: ['spruce_log', 'spruce_wood', 'stripped_spruce_log', 'stripped_spruce_wood'],
    leaves: ['spruce_leaves'], sapling: 'spruce_sapling', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  },
  jungle: {
    label: 'Jungle', since: '1.2', footprint: 1, tall: true, canBe2x2: true,
    logs: ['jungle_log', 'jungle_wood', 'stripped_jungle_log', 'stripped_jungle_wood'],
    leaves: ['jungle_leaves', 'oak_leaves'], sapling: 'jungle_sapling', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  },
  acacia: {
    label: 'Acacia', since: '1.7', footprint: 1, tall: false,
    logs: ['acacia_log', 'acacia_wood', 'stripped_acacia_log', 'stripped_acacia_wood'],
    leaves: ['acacia_leaves'], sapling: 'acacia_sapling', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  },
  dark_oak: {
    label: 'Dark Oak', since: '1.7', footprint: 2, tall: false, requires2x2: true,
    logs: ['dark_oak_log', 'dark_oak_wood', 'stripped_dark_oak_log', 'stripped_dark_oak_wood'],
    leaves: ['dark_oak_leaves'], sapling: 'dark_oak_sapling', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  },
  mangrove: {
    label: 'Mangrove', since: '1.19', footprint: 1, tall: true, canBe2x2: true,
    logs: ['mangrove_log', 'mangrove_wood', 'stripped_mangrove_log', 'stripped_mangrove_wood'],
    leaves: ['mangrove_leaves'], sapling: 'mangrove_propagule', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  },
  cherry: {
    label: 'Cherry', since: '1.20', footprint: 1, tall: false,
    logs: ['cherry_log', 'cherry_wood', 'stripped_cherry_log', 'stripped_cherry_wood'],
    leaves: ['cherry_leaves'], sapling: 'cherry_sapling', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  },
  pale_oak: {
    label: 'Pale Oak', since: '1.21.4', footprint: 1, tall: false,
    logs: ['pale_oak_log', 'pale_oak_wood', 'stripped_pale_oak_log', 'stripped_pale_oak_wood'],
    leaves: ['pale_oak_leaves'], sapling: 'pale_oak_sapling', plantable: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud']
  }
});

const LOG_TO_SPECIES = new Map();
for (const [species, def] of Object.entries(SPECIES)) {
  for (const log of def.logs) LOG_TO_SPECIES.set(log, species);
}
const LOG_TYPES = Object.freeze([...LOG_TO_SPECIES.keys()]);
const LOG_PATTERN = /(^|_)(log|wood)$/;
const STRIPPED_PATTERN = /^stripped_/;

function baseName(name) {
  return String(name || '').toLowerCase().replace(/^minecraft:/, '');
}

function speciesFor(name) {
  const clean = baseName(name);
  if (LOG_TO_SPECIES.has(clean)) return LOG_TO_SPECIES.get(clean);
  // Modded/future logs: derive the species from `foo_log` and still identify
  // the tree. Replanting falls back to the prefix sapling only if one exists.
  const match = clean.match(/^(?:stripped_)?([a-z0-9_]+?)_(?:log|wood)$/);
  return match ? match[1] : null;
}

function isLog(name) {
  return LOG_PATTERN.test(baseName(name));
}

function isLeaves(name) {
  return /_leaves$/.test(baseName(name));
}

function definition(species) {
  return SPECIES[species] || null;
}

function saplingFor(name) {
  const species = speciesFor(name);
  return species && SPECIES[species] ? SPECIES[species].sapling : `${species || 'oak'}_sapling`;
}

function leavesFor(name) {
  const species = speciesFor(name);
  return species && SPECIES[species] ? SPECIES[species].leaves.slice() : [`${species || 'oak'}_leaves`];
}

function plantableFor(name) {
  const species = speciesFor(name);
  return species && SPECIES[species] ? SPECIES[species].plantable.slice() : SPECIES.oak.plantable.slice();
}

function parseVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  const match = text.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) };
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function supportsVersion(name, version) {
  const species = speciesFor(name);
  const def = species && SPECIES[species];
  if (!def || !version || version === 'auto') return true;
  return compareVersions(version, def.since) >= 0;
}

function catalogue({ version = null } = {}) {
  return Object.entries(SPECIES).map(([species, def]) => ({
    species, label: def.label, since: def.since, footprint: def.footprint,
    tall: Boolean(def.tall), requires2x2: Boolean(def.requires2x2),
    logs: def.logs.slice(), leaves: def.leaves.slice(), sapling: def.sapling,
    supported: supportsVersion(def.logs[0], version)
  }));
}

const SAPLING_FOR = Object.freeze(Object.fromEntries(Object.entries(SPECIES).map(([species, def]) => [`${species}_log`, def.sapling])));
const SAPLINGS = Object.freeze(new Set(Object.values(SAPLING_FOR)));
const TYPE_ALIASES = Object.freeze(Object.fromEntries([
  ...Object.keys(SPECIES).map((species) => [species, `${species}_log`]),
  ['dark', 'dark_oak_log']
]));

module.exports = {
  SPECIES, LOG_TYPES, LOG_PATTERN, SAPLING_FOR, SAPLINGS, TYPE_ALIASES,
  baseName, speciesFor, isLog, isLeaves, definition, saplingFor, leavesFor,
  plantableFor, parseVersion, compareVersions, supportsVersion, catalogue,
  STRIPPED_PATTERN
};
