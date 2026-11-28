'use strict';

const { PHASES } = require('../schematics/blockGrid');
const { classifyBlock } = require('../excavate/safety');
const { distance } = require('../util/vec');
const {
  parseBlock, formatBlock, matchesBlock, placementItem
} = require('./blockStates');
const { getBlockRegistry } = require('./blockRegistry');

const STATUS = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  PLANNED: 'PLANNED',
  MATERIAL_MISSING: 'MATERIAL_MISSING',
  READY: 'READY',
  PLACING: 'PLACING',
  WAITING_FOR_WORLD_UPDATE: 'WAITING_FOR_WORLD_UPDATE',
  VERIFYING: 'VERIFYING',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  RETRY_PENDING: 'RETRY_PENDING',
  REPAIR_REQUIRED: 'REPAIR_REQUIRED',
  SKIPPED_WITH_PERMISSION: 'SKIPPED_WITH_PERMISSION'
});

const PHASE_INDEX = Object.fromEntries(PHASES.map((phase, index) => [phase, index]));

function phaseOf(schematic, index) {
  const value = index === undefined || index === null ? 0 : Number(index);
  if (Number.isFinite(value) && PHASES[value]) return PHASES[value];
  return 'FOUNDATION';
}

function key(pos) { return `${pos.x},${pos.y},${pos.z}`; }

function blockDescriptor(value) {
  return parseBlock(value);
}

function normalizeSchematic(schematic) {
  if (!schematic || !Array.isArray(schematic.palette) || !Array.isArray(schematic.blocks)) {
    throw new Error('build engine requires a schematic palette and blocks');
  }
  const palette = schematic.palette.map((entry) => blockDescriptor(entry));
  const blocks = [];
  const issues = [];
  const seen = new Set();
  let maxX = -1; let maxY = -1; let maxZ = -1;
  for (let i = 0; i < schematic.blocks.length; i++) {
    const raw = schematic.blocks[i];
    if (!Array.isArray(raw) || raw.length < 4) {
      issues.push({ kind: 'MALFORMED_BLOCK', index: i, detail: 'expected [x,y,z,paletteIndex,phase]' });
      continue;
    }
    const [x, y, z, p, phaseIndex] = raw;
    if (![x, y, z, p].every(Number.isFinite) || !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
      issues.push({ kind: 'NON_INTEGER_COORDINATE', index: i, detail: raw });
      continue;
    }
    if (!palette[p]) {
      issues.push({ kind: 'INVALID_PALETTE_INDEX', index: i, paletteIndex: p });
      continue;
    }
    const k = `${x},${y},${z}`;
    if (seen.has(k)) {
      issues.push({ kind: 'DUPLICATE_POSITION', index: i, position: { x, y, z } });
      continue;
    }
    seen.add(k);
    const desired = palette[p];
    blocks.push({
      index: i,
      x, y, z,
      paletteIndex: p,
      phase: phaseOf(schematic, phaseIndex),
      phaseIndex: phaseIndex === undefined ? 0 : Number(phaseIndex),
      desired,
      canonical: formatBlock(desired),
      item: placementItem(desired),
      status: STATUS.NOT_STARTED,
      attempts: 0,
      lastError: null,
      observed: null
    });
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const dims = schematic.dimensions || { width: maxX + 1, height: maxY + 1, length: maxZ + 1 };
  return { palette, blocks, issues, dimensions: { width: dims.width, height: dims.height, length: dims.length } };
}

function descriptorFromWorld(block) {
  if (!block) return null;
  if (typeof block === 'string') return parseBlock(block);
  let properties = block.properties;
  if (!properties && typeof block.getProperties === 'function') {
    try { properties = block.getProperties(); } catch (err) { properties = {}; }
  }
  return { name: String(block.name || block.type || 'air').replace(/^minecraft:/, ''), properties: properties ? { ...properties } : {} };
}

function readWorldBlock(world, pos) {
  if (!world || typeof world.getBlock !== 'function') return null;
  let block = null;
  try { block = world.getBlock(pos); } catch (err) { return null; }
  if (!block) return null;
  return descriptorFromWorld(block);
}

/**
 * A chunk the client has not received yet is unknown, not air and not solid.
 * Mixing the two would let a build float on a block nobody has observed, or
 * report a permanent protection conflict for a chunk that merely loads late.
 */
const UNKNOWN_WORLD_NAMES = new Set(['unloaded', 'unknown', 'not_loaded', 'notloaded', 'void']);

function isUnknownWorldName(name) {
  return !name || UNKNOWN_WORLD_NAMES.has(String(name).toLowerCase());
}

function isSolidName(name) {
  if (isUnknownWorldName(name)) return false;
  return !['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'seagrass', 'tall_seagrass', 'snow'].includes(name);
}

/**
 * Dependent blocks and their support. `behind` depends on horizontal facing.
 * Supports are positions that must contain a non-air block before placement.
 */
function supportPositions(block) {
  const { name, properties } = block.desired;
  const p = properties || {};
  const pos = { x: block.x, y: block.y, z: block.z };
  const below = { x: pos.x, y: pos.y - 1, z: pos.z };
  const behind = (() => {
    const facing = p.facing;
    if (facing === 'north') return { x: pos.x, y: pos.y, z: pos.z + 1 };
    if (facing === 'south') return { x: pos.x, y: pos.y, z: pos.z - 1 };
    if (facing === 'east') return { x: pos.x - 1, y: pos.y, z: pos.z };
    if (facing === 'west') return { x: pos.x + 1, y: pos.y, z: pos.z };
    return null;
  })();
  const belowList = [];
  const behindList = [];
  const addBelow = (position = below) => belowList.push({ x: position.x, y: position.y, z: position.z });
  const addBehind = () => { if (behind) behindList.push(behind); };

  if (name.endsWith('_door')) {
    if (p.half === 'upper') addBelow(); // lower door half
    else if (p.half === 'lower' || p.half === undefined) addBelow(); // block under the door
  } else if (name.endsWith('_bed')) {
    addBelow();
    if (p.part === 'head') {
      const facing = p.facing || 'north';
      const foot = { north: { x: 0, z: 1 }, south: { x: 0, z: -1 }, east: { x: -1, z: 0 }, west: { x: 1, z: 0 } }[facing];
      if (foot) addBelow({ x: pos.x + foot.x, y: pos.y, z: pos.z + foot.z });
    }
  } else if (name.endsWith('_torch') || name === 'torch' || name === 'soul_torch' || name === 'redstone_torch') {
    if (name.includes('wall') || p.facing) addBehind(); else addBelow();
  } else if (name.endsWith('_sign') || name.endsWith('_hanging_sign')) {
    if (name.includes('wall') || p.facing) addBehind(); else addBelow();
  } else if (name === 'ladder' || name === 'lever' || name === 'tripwire_hook' || name === 'wall_torch') {
    addBehind();
  } else if (name.endsWith('_button')) {
    if (p.face === 'wall' || p.facing) addBehind(); else addBelow();
  } else if (name === 'rail' || name === 'powered_rail' || name === 'detector_rail' || name === 'activator_rail'
    || name === 'redstone_wire' || name === 'repeater' || name === 'comparator' || name === 'redstone_torch'
    || name === 'tripwire' || name.endsWith('_pressure_plate') || name.endsWith('_carpet')
    || name === 'snow' || name === 'stone_pressure_plate' || name === 'polished_blackstone_pressure_plate') {
    addBelow();
  } else if (name === 'wheat' || name === 'carrots' || name === 'potatoes' || name === 'beetroots'
    || name === 'sweet_berry_bush' || name === 'nether_wart' || name === 'torchflower_crop' || name === 'pitcher_crop'
    || name === 'cocoa' || name === 'melon_stem' || name === 'pumpkin_stem') {
    addBelow();
  } else if (name === 'sugar_cane' || name === 'bamboo' || name === 'cactus' || name === 'kelp'
    || name === 'kelp_plant' || name === 'sea_pickle' || name === 'big_dripleaf_stem' || name === 'cave_vines'
    || name === 'cave_vines_plant' || name === 'twisting_vines' || name === 'weeping_vines') {
    addBelow();
  } else if (name === 'oak_sapling' || name.endsWith('_sapling') || name === 'dandelion' || name === 'poppy'
    || name.endsWith('_tulip') || name === 'short_grass' || name === 'fern' || name === 'dead_bush'
    || name === 'brown_mushroom' || name === 'red_mushroom' || name === 'crimson_fungus' || name === 'warped_fungus') {
    addBelow();
  } else if (name === 'vine' || name === 'glow_lichen' || name === 'sculk_vein' || name === 'hanging_roots') {
    addBehind();
  } else if (name.endsWith('_trapdoor')) {
    // Trapdoors are valid against any neighbouring solid block. The engine
    // only enforces attachment when the blueprint specifies `facing`.
    if (p.facing) addBehind();
  } else if (name.endsWith('_fence_gate') || name.endsWith('_fence') || name.endsWith('_wall')) {
    addBelow();
  } else if (name.endsWith('_stairs') || name.endsWith('_slab')) {
    if (p.half === 'top') addBelow();
  } else if (name.endsWith('_candle') || name === 'candle' || name === 'lantern' || name === 'soul_lantern'
    || name.endsWith('_chain') || name === 'end_rod' || name === 'lightning_rod' || name === 'flower_pot') {
    if (p.hanging === true) return { below: [], behind: [], above: [{ x: pos.x, y: pos.y + 1, z: pos.z }] };
    addBelow();
  }
  return { below: belowList, behind: behindList, above: [] };
}

class BuildEngine {
  constructor({
    schematic, origin, world, bots = [], registry = null, logger = null,
    authorized = false, preserveOres = true, registryVersion = null,
    confirmationAttempts = 4, confirmationDelayMs = 25, mode = 'replace-region'
  } = {}) {
    if (!schematic) throw new Error('build engine requires a schematic');
    if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) throw new Error('build engine requires a finite origin');
    if (!world) throw new Error('build engine requires a world');
    this.schematic = schematic;
    this.origin = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
    this.world = world;
    this.bots = bots;
    this.registry = registry || getBlockRegistry({ version: registryVersion });
    this.logger = logger;
    this.authorized = Boolean(authorized);
    this.preserveOres = preserveOres !== false;
    this.confirmationAttempts = Math.max(1, confirmationAttempts);
    this.confirmationDelayMs = Math.max(0, confirmationDelayMs);
    this.mode = mode;
    const normalized = normalizeSchematic(schematic);
    this.blocks = normalized.blocks;
    this.palette = normalized.palette;
    this.blueprintIssues = normalized.issues;
    this.dimensions = normalized.dimensions;
    this.byPosition = new Map(this.blocks.map((block) => [`${block.x},${block.y},${block.z}`, block]));
    this.plan = null;
    this.validation = null;
    this.events = [];
    this.stats = this._emptyStats();
  }

  _emptyStats() {
    return {
      attempted: 0, verified: 0, failed: 0, skipped: 0, cleared: 0, repaired: 0,
      materialMissing: 0, stateMismatch: 0, supportMissing: 0, waiting: 0
    };
  }

  worldPos(block) {
    return { x: this.origin.x + block.x, y: this.origin.y + block.y, z: this.origin.z + block.z };
  }

  _event(type, payload = {}) {
    this.events.push({ at: Date.now(), type, ...payload });
    if (this.events.length > 500) this.events.shift();
  }

  // ------------------------------------------------------------------
  // Blueprint validation
  // ------------------------------------------------------------------
  validateBlueprint() {
    if (this.validation) return this.validation;
    const issues = [...this.blueprintIssues];
    const warnings = [];
    const registry = this.registry.describe();
    if (registry.compatibility !== 'EXACT') {
      warnings.push({
        kind: 'VERSION_COMPATIBILITY',
        detail: registry.fallbackReason,
        requested: registry.requestedVersion,
        validatedAgainst: registry.version
      });
    }
    let invalid = 0;
    const omittedByBlock = new Map();
    const missingItems = new Map();
    for (const block of this.blocks) {
      const check = this.registry.validate(block.desired, { requireItem: true });
      if (!check.ok) {
        invalid++;
        block.status = STATUS.FAILED;
        block.lastError = check.errors.join('; ');
        issues.push({ kind: 'INVALID_BLOCK', position: { x: block.x, y: block.y, z: block.z }, block: block.canonical, errors: check.errors });
      }
      block.itemName = check.itemName || placeItemFallback(block.desired);
      block.registryDefinition = check.definition ? {
        id: check.definition.id,
        stateRange: [check.definition.minStateId, check.definition.maxStateId],
        defaultState: check.definition.defaultState
      } : null;
      for (const warning of check.warnings || []) missingItems.set(block.canonical, warning);
      // Omitted properties are legal but cannot be verified exactly.
      const definedProperties = new Set((check.definition?.states || []).map((state) => state.name));
      const omitted = [...definedProperties].filter((name) => !Object.prototype.hasOwnProperty.call(block.desired.properties, name));
      if (omitted.length) {
        block.stateOmitted = omitted;
        const prior = omittedByBlock.get(block.canonical) || { omitted, count: 0 };
        prior.count++;
        omittedByBlock.set(block.canonical, prior);
      }
      if (block.desired.properties.waterlogged === true && !definedProperties.has('waterlogged')) {
        issues.push({ kind: 'INVALID_WATERLOGGED_STATE', block: block.canonical, position: { x: block.x, y: block.y, z: block.z } });
      }
    }
    // Aggregate per-block warnings instead of one object per placed block:
    // a 79k-block build would otherwise carry 79k near-identical warnings.
    if (omittedByBlock.size) {
      const types = [...omittedByBlock.entries()].slice(0, 50).map(([block, entry]) => ({ block, omitted: entry.omitted, count: entry.count }));
      warnings.push({
        kind: 'STATE_NOT_SPECIFIED',
        detail: `${types.length} palette state(s) omit optional properties; they are compared only where the blueprint specifies them`,
        count: [...omittedByBlock.values()].reduce((sum, entry) => sum + entry.count, 0),
        types
      });
    }
    if (missingItems.size) {
      warnings.push({
        kind: 'MISSING_ITEM',
        detail: `${missingItems.size} palette block(s) have no matching inventory item`,
        count: missingItems.size,
        types: [...missingItems.entries()].slice(0, 50).map(([block, detail]) => ({ block, detail }))
      });
    }
    // Double-block consistency: every door/bed half must have its partner.
    for (const block of this.blocks) {
      const { name, properties } = block.desired;
      if (name.endsWith('_door') && properties.half === 'upper') {
        const lower = this.byPosition.get(`${block.x},${block.y - 1},${block.z}`);
        if (!lower || lower.desired.name !== name || lower.desired.properties.half !== 'lower') {
          issues.push({ kind: 'DOOR_HALF_MISSING', position: { x: block.x, y: block.y, z: block.z }, block: block.canonical });
        }
      }
      if (name.endsWith('_door') && properties.half === 'lower') {
        const upper = this.byPosition.get(`${block.x},${block.y + 1},${block.z}`);
        if (!upper || upper.desired.name !== name || upper.desired.properties.half !== 'upper') {
          issues.push({ kind: 'DOOR_HALF_MISSING', position: { x: block.x, y: block.y, z: block.z }, block: block.canonical });
        }
      }
      if (name.endsWith('_bed') && properties.part === 'head') {
        const facing = properties.facing || 'north';
        const dx = facing === 'east' ? -1 : facing === 'west' ? 1 : 0;
        const dz = facing === 'south' ? -1 : facing === 'north' ? 1 : 0;
        const foot = this.byPosition.get(`${block.x + dx},${block.y},${block.z + dz}`);
        if (!foot || foot.desired.name !== name) {
          issues.push({ kind: 'BED_FOOT_MISSING', position: { x: block.x, y: block.y, z: block.z }, block: block.canonical });
        }
      }
    }
    const unsupportedEntities = [];
    const entities = this.schematic.blockEntities || this.schematic.blockEntityData || null;
    if (entities) {
      for (const entry of Object.values(entities)) {
        unsupportedEntities.push(entry && entry.id ? entry.id : entry);
      }
      if (unsupportedEntities.length) {
        warnings.push({
          kind: 'BLOCK_ENTITY_DATA_LIMITED',
          detail: `${unsupportedEntities.length} block entity payload(s) cannot be written through the placement API; contents/sign text may be lost`,
          count: unsupportedEntities.length
        });
      }
    }
    const result = {
      ok: issues.length === 0,
      issues,
      warnings,
      invalidBlocks: invalid,
      blockCount: this.blocks.length,
      registry,
      versionCompatibility: registry.compatibility,
      checkedAt: Date.now()
    };
    this.validation = result;
    return result;
  }

  // ------------------------------------------------------------------
  // Dependency-aware ordering
  // ------------------------------------------------------------------
  buildPlan({ refresh = false } = {}) {
    if (this.plan && !refresh) return this.plan;
    const dependencies = new Map(this.blocks.map((block) => [key({ x: block.x, y: block.y, z: block.z }), new Set()]));
    const dependents = new Map(this.blocks.map((block) => [key({ x: block.x, y: block.y, z: block.z }), new Set()]));
    const link = (from, to) => {
      if (!from || !to || from === to) return;
      dependencies.get(to).add(from);
      dependents.get(from).add(to);
    };
    for (const block of this.blocks) {
      const posKey = `${block.x},${block.y},${block.z}`;
      const supports = supportPositions(block);
      for (const support of [...supports.below, ...supports.behind, ...supports.above]) {
        const supportKey = `${support.x},${support.y},${support.z}`;
        const supportBlock = this.byPosition.get(supportKey);
        if (supportBlock) link(supportKey, posKey);
      }
      const { name, properties } = block.desired;
      if (name.endsWith('_door') || name.endsWith('_bed') || name === 'tall_grass' || name === 'large_fern'
        || name === 'sunflower' || name === 'lilac' || name === 'rose_bush' || name === 'peony'
        || name === 'tall_seagrass' || name.endsWith('_hanging_sign')) {
        // Lower/foot half must be placed first. For doors the supporting lower
        // block is at y-1; for beds the foot is one step opposite `facing`.
        if (name.endsWith('_door') && properties.half === 'upper') {
          link(`${block.x},${block.y - 1},${block.z}`, posKey);
        }
        if (name.endsWith('_bed') && properties.part === 'head') {
          const facing = properties.facing || 'north';
          const dx = facing === 'east' ? -1 : facing === 'west' ? 1 : 0;
          const dz = facing === 'south' ? -1 : facing === 'north' ? 1 : 0;
          const footKey = `${block.x + dx},${block.y},${block.z + dz}`;
          if (this.byPosition.has(footKey)) link(footKey, posKey);
        }
        if (properties.half === 'upper' || properties.part === 'upper') {
          link(`${block.x},${block.y - 1},${block.z}`, posKey);
        }
      }
      // Gravity blocks are only stable after their support exists.
      if (this.registry.isGravityBlock(name)) {
        const below = this.byPosition.get(`${block.x},${block.y - 1},${block.z}`);
        if (below) link(`${block.x},${block.y - 1},${block.z}`, posKey);
      }
      // Redstone dust/components should follow their supporting block.
      if (['redstone_wire', 'repeater', 'comparator', 'torch', 'redstone_torch'].includes(name)) {
        for (const support of supports.below) {
          const supportKey = `${support.x},${support.y},${support.z}`;
          if (this.byPosition.has(supportKey)) link(supportKey, posKey);
        }
      }
    }
    // Stable topological order, with phase then vertical position as tie-break.
    const sortKey = (blockKeyValue) => {
      const block = this.byPosition.get(blockKeyValue);
      return [PHASE_INDEX[block.phase] ?? 0, block.y, block.z, block.x];
    };
    const ready = this.blocks
      .filter((block) => dependencies.get(`${block.x},${block.y},${block.z}`).size === 0)
      .map((block) => `${block.x},${block.y},${block.z}`)
      .sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
    const ordered = [];
    const visiting = new Set();
    const emitted = new Set();
    const pushReady = (candidate) => {
      if (emitted.has(candidate)) return;
      let inserted = false;
      for (let i = 0; i < ready.length; i++) {
        if (compareKeys(sortKey(candidate), sortKey(ready[i])) < 0) { ready.splice(i, 0, candidate); inserted = true; break; }
      }
      if (!inserted) ready.push(candidate);
    };
    while (ready.length) {
      const current = ready.shift();
      if (emitted.has(current)) continue;
      emitted.add(current);
      ordered.push(current);
      for (const dependent of [...dependents.get(current)].sort((a, b) => compareKeys(sortKey(a), sortKey(b)))) {
        if (emitted.has(dependent)) continue;
        const deps = dependencies.get(dependent);
        let allDone = true;
        for (const dep of deps) if (!emitted.has(dep)) { allDone = false; break; }
        if (allDone && !visiting.has(dependent)) pushReady(dependent);
      }
      visiting.clear();
    }
    const cycles = this.blocks
      .map((block) => `${block.x},${block.y},${block.z}`)
      .filter((blockKeyValue) => !emitted.has(blockKeyValue));
    // Cycles are a blueprint defect, not something to silently flatten.
    const plan = {
      order: ordered,
      dependencies: Object.fromEntries([...dependencies].map(([position, set]) => [position, [...set]])),
      cycles,
      blocks: ordered.map((position) => this.byPosition.get(position)),
      phaseCounts: this.blocks.reduce((acc, block) => { acc[block.phase] = (acc[block.phase] || 0) + 1; return acc; }, {}),
      valid: cycles.length === 0
    };
    for (const block of this.blocks) {
      if (block.status === STATUS.NOT_STARTED || block.status === STATUS.PLANNED) block.status = STATUS.PLANNED;
    }
    this.plan = plan;
    this._event('plan.built', { blocks: ordered.length, cycles: cycles.length });
    return plan;
  }

  // ------------------------------------------------------------------
  // Placement
  // ------------------------------------------------------------------
  async _confirm(block, attempts = this.confirmationAttempts) {
    let observed = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      observed = readWorldBlock(this.world, this.worldPos(block));
      if (observed && matchesBlock(observed, block.desired)) return { ok: true, observed, attempts: attempt + 1 };
      if (attempt < attempts - 1 && this.confirmationDelayMs) await new Promise((resolve) => setTimeout(resolve, this.confirmationDelayMs));
    }
    return { ok: false, observed, unknown: !observed || isUnknownWorldName(observed.name), attempts };
  }

  /**
   * Give an unloaded position a bounded chance to arrive. Moving the bot toward
   * the block is the only legitimate way to make the server send its chunk; a
   * build must never fabricate the block or call the missing chunk protected.
   */
  async _awaitWorld(bot, pos, attempts = this.confirmationAttempts, { move = true } = {}) {
    let observed = readWorldBlock(this.world, pos);
    if (observed && !isUnknownWorldName(observed.name)) return { ok: true, observed };
    if (move && bot && typeof bot.goTo === 'function' && bot.position) {
      const far = distance(bot.position, pos) > 4;
      if (far || isUnknownWorldName(observed && observed.name)) {
        try {
          await bot.goTo(pos, { range: 4, timeoutMs: 8000 });
        } catch (_) { /* movement failure is reported by the caller as waiting */ }
      }
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      observed = readWorldBlock(this.world, pos);
      if (observed && !isUnknownWorldName(observed.name)) return { ok: true, observed };
      if (attempt < attempts - 1 && this.confirmationDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.confirmationDelayMs));
      }
    }
    return { ok: false, observed };
  }

  _companion(block) {
    const { name, properties } = block.desired;
    if (name.endsWith('_door') && properties.half === 'lower') {
      const upper = this.byPosition.get(`${block.x},${block.y + 1},${block.z}`);
      if (upper && upper.desired.name === name) {
        return {
          position: this.worldPos(upper),
          descriptor: { name, properties: { ...upper.desired.properties } }
        };
      }
    }
    if (name.endsWith('_bed') && properties.part === 'foot') {
      const facing = properties.facing || 'north';
      const dx = facing === 'east' ? 1 : facing === 'west' ? -1 : 0;
      const dz = facing === 'south' ? 1 : facing === 'north' ? -1 : 0;
      const head = this.byPosition.get(`${block.x + dx},${block.y},${block.z + dz}`);
      if (head && head.desired.name === name) {
        return {
          position: this.worldPos(head),
          descriptor: { name, properties: { ...head.desired.properties } }
        };
      }
    }
    return null;
  }

  _strategy(block) {
    const { name, properties } = block.desired;
    const p = properties || {};
    // Minecraft yaw: 0 = south (+z), 90 = west, 180 = north, 270 = east.
    // Stairs, doors, trapdoors and gates take their `facing` from the player's
    // horizontal facing, so one mapping is correct for all of them.
    let yaw = null;
    if (p.facing === 'north') yaw = 180; else if (p.facing === 'south') yaw = 0;
    else if (p.facing === 'west') yaw = 90; else if (p.facing === 'east') yaw = 270;
    const strategy = { yaw, pitch: 0, clickFace: 'below', companion: this._companion(block) };
    if (name === 'wall_torch' || name.endsWith('_wall_sign') || name.endsWith('_wall_banner')) {
      const attach = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }[p.facing];
      if (attach) strategy.attach = attach;
    }
    if (p.half === 'top' && (name.endsWith('_slab') || name.endsWith('_trapdoor'))) {
      strategy.clickFace = 'above';
      strategy.pitch = 90;
    }
    if (p.axis === 'x' || p.axis === 'z') {
      // Logs/pillars: look horizontally for x/z, down for y.
      strategy.pitch = 90;
      strategy.yaw = p.axis === 'x' ? 90 : 0;
    } else if (p.axis === 'y') {
      strategy.pitch = 90;
    }
    return strategy;
  }

  async _canReplace(block, observed) {
    if (!observed || observed.name === 'air') return { ok: true, cleared: false };
    if (matchesBlock(observed, block.desired)) return { ok: true, cleared: false };
    // A block of the expected type with the wrong state is our own placement,
    // not a protected player structure; allow the state to be corrected.
    if (observed.name === block.desired.name) return { ok: true, cleared: true };
    const cls = classifyBlock(observed.name, { preserveOres: this.preserveOres, authorized: this.authorized });
    if (!cls.excavatable) {
      return { ok: false, error: `blocked by ${observed.name} (${cls.reason || cls.kind})`, requiresAuthorization: Boolean(cls.requiresAuth) };
    }
    return { ok: true, cleared: true };
  }

  async place(block, bot, {
    acquire = null, retries = 2, replace = true, confirmAttempts = this.confirmationAttempts
  } = {}) {
    if (!bot) return { ok: false, status: STATUS.FAILED, error: 'no bot' };
    const pos = this.worldPos(block);
    block.attempts = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      block.attempts++;
      this.stats.attempted++;
      let observed = readWorldBlock(this.world, pos);
      if (observed && matchesBlock(observed, block.desired)) {
        block.status = STATUS.VERIFIED;
        block.observed = observed;
        this.stats.verified++;
        return { ok: true, status: STATUS.VERIFIED, position: pos, block: block.canonical, observed, attempts: block.attempts, alreadyPresent: true };
      }
      if (!observed || isUnknownWorldName(observed.name)) {
        // Try one bounded load-and-read cycle before declaring the position
        // unknown. The block is not air, so no support/material decision may be
        // made from this read.
        const ready = await this._awaitWorld(bot, pos, confirmAttempts);
        observed = ready.observed;
        if (!ready.ok) {
          block.status = STATUS.WAITING_FOR_WORLD_UPDATE;
          block.lastError = `world has not loaded ${pos.x},${pos.y},${pos.z} yet`;
          this.stats.waiting++;
          return { ok: false, status: STATUS.WAITING_FOR_WORLD_UPDATE, error: block.lastError, position: pos, retryable: true };
        }
      }
      block.status = STATUS.READY;
      const supports = supportPositions(block);
      for (const support of [...supports.below, ...supports.behind, ...supports.above]) {
        const supportLocalKey = `${support.x},${support.y},${support.z}`;
        // A bottom-layer block rests on the prepared ground, which is outside
        // the schematic bounding box. Site preparation owns that check.
        if (!this.byPosition.has(supportLocalKey) && support.y === 0 && support.x === block.x && support.z === block.z) continue;
        const supportPos = { x: pos.x + support.x - block.x, y: pos.y + support.y - block.y, z: pos.z + support.z - block.z };
        let worldSupport = readWorldBlock(this.world, supportPos);
        if (!worldSupport || isUnknownWorldName(worldSupport.name)) {
          const ready = await this._awaitWorld(bot, supportPos, confirmAttempts, { move: false });
          worldSupport = ready.observed;
          if (!ready.ok) {
            block.status = STATUS.WAITING_FOR_WORLD_UPDATE;
            block.lastError = `support at ${supportPos.x},${supportPos.y},${supportPos.z} is in an unloaded chunk`;
            this.stats.waiting++;
            return { ok: false, status: STATUS.WAITING_FOR_WORLD_UPDATE, error: block.lastError, position: pos, retryable: true };
          }
        }
        if (!isSolidName(worldSupport.name)) {
          block.status = STATUS.FAILED;
          block.lastError = `support missing at ${support.x},${support.y},${support.z}`;
          this.stats.supportMissing++;
          this._event('block.support-missing', { position: pos, block: block.canonical, support });
          return { ok: false, status: STATUS.FAILED, error: block.lastError, position: pos, retryable: false };
        }
      }
      if (observed && observed.name !== 'air') {
        if (!replace) {
          block.status = STATUS.FAILED;
          block.lastError = `position occupied by ${observed.name}`;
          return { ok: false, status: STATUS.FAILED, error: block.lastError, position: pos, observed };
        }
        const replaceable = await this._canReplace(block, observed);
        if (!replaceable.ok) {
          block.status = replaceable.requiresAuthorization ? StatusSafe(STATUS.REPAIR_REQUIRED) : STATUS.FAILED;
          block.lastError = replaceable.error;
          return { ok: false, status: block.status, error: replaceable.error, position: pos, observed, needsAuthorization: replaceable.requiresAuthorization };
        }
        if (replaceable.cleared) {
          // Digging has a shorter reach than placing. Step into range first;
          // a large mock buildReach must not make obstacle clearing fail.
          if (typeof bot.goTo === 'function' && bot.position && distance(bot.position, pos) > 5) {
            await bot.goTo({ x: pos.x, y: pos.y, z: pos.z }, { range: 2, timeoutMs: 10000 });
          }
          const dig = await bot.digBlock(pos, { range: Number(bot.buildReach) > 0 ? Number(bot.buildReach) : 5 });
          if (!dig || dig.ok === false) {
            block.status = STATUS.FAILED;
            block.lastError = (dig && dig.error) || 'could not clear existing block';
            return { ok: false, status: STATUS.FAILED, error: block.lastError, position: pos };
          }
          const cleared = await this._confirmAir(pos, confirmAttempts);
          if (!cleared) {
            block.status = STATUS.WAITING_FOR_WORLD_UPDATE;
            block.lastError = `world still reports ${observed.name} after digging`;
            this.stats.waiting++;
            return { ok: false, status: STATUS.WAITING_FOR_WORLD_UPDATE, error: block.lastError, position: pos };
          }
          this.stats.cleared++;
        }
      }
      const buildReach = Number(bot.buildReach) > 0 ? Number(bot.buildReach) : 5.8;
      if (typeof bot.goTo === 'function' && bot.position && distance(bot.position, pos) > buildReach) {
        // Walk to a reachable cell near the target's column before placing.
        // Workers on a real server use a temporary scaffold for upper walls and
        // roofs; the mock advertises a larger buildReach to represent that
        // instead of demanding a standable cell inside the block itself.
        const approach = {
          x: pos.x,
          y: pos.y > bot.position.y ? Math.floor(bot.position.y) : pos.y,
          z: pos.z
        };
        const move = await bot.goTo(approach, { range: 8, timeoutMs: 10000 });
        if (move && move.ok === false && distance(bot.position, pos) > buildReach) {
          block.lastError = move.error || 'cannot reach build position';
          block.status = STATUS.RETRY_PENDING;
          if (attempt < retries) continue;
          block.status = STATUS.FAILED;
          this.stats.failed++;
          return { ok: false, status: STATUS.FAILED, error: block.lastError, position: pos };
        }
      }
      let item = block.itemName || block.item;
      let have = typeof bot.countItem === 'function' ? bot.countItem(item) : 1;
      if (!have && acquire) {
        const acquired = await acquire(bot, item, 1);
        if (acquired && acquired.ok) have = typeof bot.countItem === 'function' ? bot.countItem(item) : 1;
      }
      if (!have) {
        block.status = STATUS.MATERIAL_MISSING;
        block.lastError = `no ${item} available to ${bot.name}`;
        this.stats.materialMissing++;
        return { ok: false, status: STATUS.MATERIAL_MISSING, error: block.lastError, position: pos, item };
      }
      block.status = STATUS.PLACING;
      const strategy = this._strategy(block);
      let placed = null;
      try {
        if (typeof bot.placeBlock === 'function') {
          placed = await bot.placeBlock(pos, item, {
            descriptor: block.desired,
            properties: block.desired.properties,
            companion: strategy.companion,
            strategy
          });
        }
      } catch (err) {
        placed = { ok: false, error: err.message };
      }
      if (!placed || placed.ok === false) {
        block.lastError = (placed && placed.error) || 'placement API failed';
        block.status = STATUS.RETRY_PENDING;
        if (attempt < retries) { this._event('block.retry', { position: pos, error: block.lastError }); continue; }
        block.status = STATUS.FAILED;
        this.stats.failed++;
        return { ok: false, status: STATUS.FAILED, error: block.lastError, position: pos, apiResult: placed };
      }
      block.status = STATUS.WAITING_FOR_WORLD_UPDATE;
      const confirmed = await this._confirm(block, confirmAttempts);
      if (confirmed.ok) {
        block.status = STATUS.VERIFIED;
        block.observed = confirmed.observed;
        block.lastError = null;
        this.stats.verified++;
        this._event('block.verified', { position: pos, block: block.canonical, attempts: block.attempts, confirmations: confirmed.attempts });
        return { ok: true, status: STATUS.VERIFIED, position: pos, block: block.canonical, observed: confirmed.observed, attempts: block.attempts, confirmations: confirmed.attempts };
      }
      block.observed = confirmed.observed;
      if (confirmed.unknown) {
        block.status = STATUS.WAITING_FOR_WORLD_UPDATE;
        block.lastError = 'chunk unloaded before the placed block could be confirmed';
        this.stats.waiting++;
        return { ok: false, status: STATUS.WAITING_FOR_WORLD_UPDATE, error: block.lastError, position: pos, retryable: true };
      }
      block.status = STATUS.RETRY_PENDING;
      block.lastError = observedMismatch(block, confirmed.observed);
      this.stats.stateMismatch++;
      this._event('block.state-mismatch', { position: pos, expected: block.canonical, observed: confirmed.observed });
      if (attempt < retries) {
        // Remove a wrongly-shaped block so the next attempt can place cleanly.
        if (confirmed.observed && confirmed.observed.name !== 'air' && typeof bot.digBlock === 'function') {
          const cls = classifyBlock(confirmed.observed.name, { preserveOres: this.preserveOres, authorized: this.authorized });
          if (cls.excavatable) await bot.digBlock(pos);
        }
        continue;
      }
    }
    block.status = STATUS.FAILED;
    this.stats.failed++;
    return { ok: false, status: STATUS.FAILED, error: block.lastError || 'verification failed', position: pos, observed: block.observed };
  }

  async _confirmAir(pos, attempts) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const observed = readWorldBlock(this.world, pos);
      if (!observed) return false;
      if (observed.name === 'air') return true;
      if (attempt < attempts - 1 && this.confirmationDelayMs) await new Promise((resolve) => setTimeout(resolve, this.confirmationDelayMs));
    }
    return false;
  }

  /** Place in dependency order. Stops on the first non-retryable failure. */
  async placeMany(bot, { limit = Infinity, onBlock = null, acquire = null, retries = 1 } = {}) {
    const plan = this.buildPlan();
    const results = [];
    let placed = 0;
    let waiting = 0;
    for (const block of plan.blocks) {
      if (placed >= limit) break;
      const result = await this.place(block, bot, { acquire, retries });
      results.push(result);
      if (onBlock) onBlock(result);
      if (result.ok) placed++;
      else if (result.status === STATUS.WAITING_FOR_WORLD_UPDATE) waiting++;
      if (!result.ok && [STATUS.FAILED, STATUS.REPAIR_REQUIRED].includes(result.status)) break;
    }
    // `waiting` is reported instead of being silently swallowed: a caller that
    // sees no placements can distinguish a desynced chunk from a real failure.
    return { results, placed, waiting, deferred: waiting > 0, summary: this.summary() };
  }

  // ------------------------------------------------------------------
  // Verification and repair
  // ------------------------------------------------------------------
  verify({ includeExtras = false } = {}) {
    const missing = [];
    const wrong = [];
    let placed = 0;
    let unloadedCount = 0;
    for (const block of this.blocks) {
      const pos = this.worldPos(block);
      const observed = readWorldBlock(this.world, pos);
      block.observed = observed;
      if (observed && matchesBlock(observed, block.desired)) {
        placed++;
        block.status = STATUS.VERIFIED;
        continue;
      }
      if (!observed || observed.name === 'air' || isUnknownWorldName(observed.name)) {
        block.status = STATUS.RETRY_PENDING;
        if (!observed || isUnknownWorldName(observed.name)) unloadedCount++;
        missing.push({ x: pos.x, y: pos.y, z: pos.z, expected: block.canonical, found: observed ? observed.name : 'unloaded', unloaded: !observed || isUnknownWorldName(observed.name) });
      } else {
        block.status = STATUS.REPAIR_REQUIRED;
        wrong.push({
          x: pos.x, y: pos.y, z: pos.z, expected: block.canonical, expectedName: block.desired.name,
          found: formatBlock(observed), foundName: observed.name,
          propertyMismatch: observed.name === block.desired.name ? diffProperties(observed.properties, block.desired.properties) : null
        });
      }
    }
    const extras = includeExtras ? this.auditExtras() : [];
    const verified = missing.length === 0 && wrong.length === 0 && extras.length === 0;
    const audit = {
      verified,
      placed,
      total: this.blocks.length,
      missingCount: missing.length,
      wrongCount: wrong.length,
      extraCount: extras.length,
      unloadedCount,
      percentComplete: this.blocks.length ? Number(((placed / this.blocks.length) * 100).toFixed(2)) : 100,
      missing: missing.slice(0, 100),
      wrong: wrong.slice(0, 100),
      extras: extras.slice(0, 100),
      stateExact: this.blocks.every((block) => Object.keys(block.desired.properties || {}).length === 0) ? 'NAME_ONLY' : 'CHECKED_WHERE_SPECIFIED',
      checkedAt: Date.now()
    };
    this.lastAudit = audit;
    this._event('verify', { verified, placed, missing: missing.length, wrong: wrong.length, extras: extras.length });
    return audit;
  }

  /** Cheap summary of the last explicit verification (for status streams). */
  auditSummary() {
    if (!this.lastAudit) return null;
    const { verified, placed, total, missingCount, wrongCount, extraCount, unloadedCount = 0, percentComplete, checkedAt } = this.lastAudit;
    return { verified, complete: verified, remaining: missingCount + wrongCount + extraCount, placed, total, missingCount, wrongCount, extraCount, unloadedCount, percentComplete, checkedAt };
  }

  /** Auto-repair from a fresh diff. Never reports success from a dry run. */
  async repair(bot, { acquire = null, includeExtras = false, maxBlocks = 500, allowExtraRemoval = false } = {}) {
    const before = this.verify({ includeExtras });
    let repaired = 0;
    const failures = [];
    const targets = [...before.wrong, ...before.missing];
    for (const target of targets.slice(0, maxBlocks)) {
      if (!bot) break;
      const block = this.byPosition.get(`${target.x - this.origin.x},${target.y - this.origin.y},${target.z - this.origin.z}`);
      if (!block) continue;
      const result = await this.place(block, bot, { acquire, retries: 1 });
      if (result.ok) repaired++;
      else failures.push({ position: { x: target.x, y: target.y, z: target.z }, error: result.error, status: result.status });
      if (!result.ok && result.status === STATUS.MATERIAL_MISSING) break;
    }
    if (includeExtras && allowExtraRemoval) {
      const extras = this.auditExtras();
      for (const extra of extras.slice(0, maxBlocks)) {
        const result = await this.clearExtra(extra, bot);
        if (result.ok) repaired++;
        else failures.push({ position: { x: extra.x, y: extra.y, z: extra.z }, error: result.error, status: result.status });
      }
    }
    const after = this.verify({ includeExtras });
    this.stats.repaired += repaired;
    return { repaired, failures, before, after, complete: after.verified };
  }

  async clearExtra(extra, bot) {
    if (!bot) return { ok: false, status: STATUS.FAILED, error: 'no bot' };
    const pos = { x: extra.x, y: extra.y, z: extra.z };
    const cls = classifyBlock(extra.name, { preserveOres: this.preserveOres, authorized: this.authorized });
    if (!cls.excavatable) return { ok: false, status: STATUS.FAILED, error: `refusing to clear protected ${extra.name}` };
    const dig = await bot.digBlock(pos);
    if (!dig || dig.ok === false) return { ok: false, status: STATUS.FAILED, error: (dig && dig.error) || 'dig failed' };
    const cleared = await this._confirmAir(pos, this.confirmationAttempts);
    return { ok: cleared, status: cleared ? STATUS.VERIFIED : STATUS.WAITING_FOR_WORLD_UPDATE, error: cleared ? null : 'world still contains extra block' };
  }

  /** Scan the schematic bounding box for non-air blocks not in the blueprint. */
  auditExtras({ max = 10000 } = {}) {
    const extras = [];
    const { width, height, length } = this.dimensions;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          if (extras.length >= max) return extras;
          const pos = { x: this.origin.x + x, y: this.origin.y + y, z: this.origin.z + z };
          const observed = readWorldBlock(this.world, pos);
          if (!observed || isUnknownWorldName(observed.name) || observed.name === 'air' || observed.name === 'cave_air' || observed.name === 'water') continue;
          if (this.byPosition.has(`${x},${y},${z}`)) continue;
          // Ignore the natural ground directly below the build; it is not a
          // stray block and is handled by site preparation.
          if (y === 0) continue;
          extras.push({ x: pos.x, y: pos.y, z: pos.z, name: observed.name, block: formatBlock(observed) });
        }
      }
    }
    return extras;
  }

  /**
   * Triple check: blueprint validity + per-block placement evidence + an
   * independent fresh world audit. Any stage failing keeps the build open.
   */
  tripleCheck() {
    const blueprint = this.validateBlueprint();
    const placement = this.verify({ includeExtras: false });
    const audit = this.verify({ includeExtras: true });
    const ok = blueprint.ok && placement.verified && audit.verified;
    return {
      ok,
      blueprint: { ok: blueprint.ok, issues: blueprint.issues.length, warnings: blueprint.warnings.length },
      placement: { verified: placement.verified, placed: placement.placed, missing: placement.missingCount, wrong: placement.wrongCount },
      audit: { verified: audit.verified, extra: audit.extraCount, percent: audit.percentComplete },
      statuses: this.statusCounts(),
      sampledAt: Date.now()
    };
  }

  statusCounts() {
    const counts = {};
    for (const status of Object.values(STATUS)) counts[status] = 0;
    for (const block of this.blocks) counts[block.status] = (counts[block.status] || 0) + 1;
    return counts;
  }

  statusFor(block) { return block.status; }

  summary() {
    const counts = this.statusCounts();
    return {
      total: this.blocks.length,
      dimensions: { ...this.dimensions },
      origin: { ...this.origin },
      statuses: counts,
      plan: this.plan ? { blocks: this.plan.order.length, cycles: this.plan.cycles.length, valid: this.plan.valid } : null,
      validation: this.validation ? { ok: this.validation.ok, issues: this.validation.issues.length, warnings: this.validation.warnings.length } : null,
      audit: this.lastAudit ? {
        verified: this.lastAudit.verified, placed: this.lastAudit.placed,
        missing: this.lastAudit.missingCount, wrong: this.lastAudit.wrongCount, extra: this.lastAudit.extraCount
      } : null,
      stats: { ...this.stats },
      registry: this.registry.describe()
    };
  }
}

function placeItemFallback(desired) {
  const { name } = desired;
  if (name.startsWith('potted_')) return name.slice('potted_'.length);
  return placementItem(desired);
}

function StatusSafe(status) { return status; }

function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0; const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function diffProperties(actual = {}, expected = {}) {
  const out = {};
  for (const [key, value] of Object.entries(expected)) {
    if (String(actual[key]) !== String(value)) out[key] = { expected: value, actual: actual[key] ?? null };
  }
  return out;
}

function observedMismatch(block, observed) {
  if (!observed) return 'world did not report the placed block';
  if (observed.name !== block.desired.name) return `placed ${observed.name}, expected ${block.desired.name}`;
  const diff = diffProperties(observed.properties, block.desired.properties);
  return `block state mismatch: ${JSON.stringify(diff)}`;
}

module.exports = {
  BuildEngine, STATUS, supportPositions, normalizeSchematic, readWorldBlock, descriptorFromWorld,
  blockDescriptor, diffProperties, matchesBlock, isUnknownWorldName, isSolidName
};
