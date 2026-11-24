'use strict';

const { parseBlock, formatBlock } = require('./blockStates');

/**
 * Minecraft block/item registry backed by the installed minecraft-data.
 *
 * The project targets a specific server, but a datapack/mod can advertise a
 * release that minecraft-data does not ship yet. Guessing a block id or state
 * is never acceptable, so an unavailable version is reported explicitly and a
 * nearest known compatible version can be used for validation only. Live
 * placement still goes through the server's own block-state ids via Mineflayer.
 */

const PREFERRED_FALLBACKS = ['26.1', '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21'];

function safeRequireMinecraftData() {
  try { return require('minecraft-data'); } catch (err) { return null; }
}

class BlockRegistry {
  constructor({ version = null, minecraftData = null, logger = null } = {}) {
    this.requestedVersion = version ? String(version) : null;
    this.minecraftData = minecraftData || safeRequireMinecraftData();
    this.logger = logger;
    this.data = null;
    this.version = null;
    this.exact = false;
    this.compatibility = 'UNAVAILABLE';
    this.fallbackReason = null;
    this._resolve();
  }

  _candidateVersions() {
    const list = [];
    if (this.requestedVersion && this.requestedVersion !== 'auto') list.push(this.requestedVersion);
    list.push(...PREFERRED_FALLBACKS);
    return [...new Set(list)];
  }

  _resolve() {
    if (!this.minecraftData) {
      this.fallbackReason = 'minecraft-data is not installed';
      return this;
    }
    let versions = [];
    try {
      versions = require('minecraft-data/minecraft-data/data/pc/common/versions.json');
    } catch (err) {
      versions = [];
    }
    const available = new Set(versions);
    for (const candidate of this._candidateVersions()) {
      if (!available.has(candidate)) continue;
      try {
        this.data = this.minecraftData(candidate);
      } catch (err) {
        continue;
      }
      if (!this.data || !this.data.blocksByName) continue;
      this.version = candidate;
      this.exact = Boolean(this.requestedVersion && candidate === this.requestedVersion);
      this.compatibility = this.exact ? 'EXACT' : 'NEAREST_KNOWN';
      if (!this.exact) {
        this.fallbackReason = this.requestedVersion
          ? `minecraft-data has no ${this.requestedVersion} registry; validating against ${candidate}`
          : `no requested version; using ${candidate}`;
      }
      return this;
    }
    this.fallbackReason = `no usable minecraft-data registry for ${this.requestedVersion || 'any version'}`;
    return this;
  }

  get loaded() { return Boolean(this.data); }

  describe() {
    return {
      requestedVersion: this.requestedVersion,
      version: this.version,
      exact: this.exact,
      compatibility: this.compatibility,
      fallbackReason: this.fallbackReason,
      dataVersion: this.data ? this.data.version?.dataVersion : null,
      blockCount: this.loaded ? this.data.blocksArray.length : 0,
      itemCount: this.loaded ? this.data.itemsArray.length : 0
    };
  }

  blockByName(name) {
    if (!this.loaded) return null;
    return this.data.blocksByName[String(name).replace(/^minecraft:/, '')] || null;
  }

  itemByName(name) {
    if (!this.loaded) return null;
    return this.data.itemsByName[String(name).replace(/^minecraft:/, '')] || null;
  }

  /**
   * Validate one palette entry without inventing state values.
   * Returns {ok, block, errors, warnings, item}.
   */
  validate(value, { requireItem = false } = {}) {
    const parsed = parseBlock(value);
    const errors = [];
    const warnings = [];
    if (!this.loaded) return { ok: false, block: parsed, errors: ['no block registry loaded'], warnings };
    const definition = this.blockByName(parsed.name);
    if (!definition) {
      errors.push(`unknown block ${parsed.name}`);
      return { ok: false, block: parsed, errors, warnings, definition: null };
    }
    for (const [key, value2] of Object.entries(parsed.properties)) {
      const state = (definition.states || []).find((entry) => entry.name === key);
      if (!state) {
        errors.push(`${parsed.name} has no property ${key}`);
        continue;
      }
      if (state.type === 'bool' && typeof value2 !== 'boolean') errors.push(`${parsed.name}.${key} must be a boolean`);
      if (state.type === 'int' && !Number.isInteger(value2)) errors.push(`${parsed.name}.${key} must be an integer`);
      if (state.type === 'enum' && Array.isArray(state.values) && !state.values.includes(String(value2))) {
        errors.push(`${parsed.name}.${key}=${value2} is not one of ${state.values.join(', ')}`);
      }
    }
    const itemName = require('./blockStates').placementItem(parsed);
    const item = this.itemByName(itemName);
    if (requireItem && !item) warnings.push(`no inventory item found for ${parsed.name} (${itemName})`);
    if (definition.name !== parsed.name) errors.push(`registry returned ${definition.name} for ${parsed.name}`);
    return {
      ok: errors.length === 0,
      block: parsed,
      definition,
      item,
      itemName,
      errors,
      warnings,
      canonical: formatBlock(parsed),
      defaultStateId: definition.defaultState,
      stateRange: [definition.minStateId, definition.maxStateId]
    };
  }

  /** All valid state values for a property, used by the designer/UI. */
  propertyValues(blockName, property) {
    const definition = this.blockByName(blockName);
    if (!definition) return [];
    const state = (definition.states || []).find((entry) => entry.name === property);
    if (!state) return [];
    if (state.type === 'bool') return [true, false];
    return Array.isArray(state.values) ? [...state.values] : [];
  }

  isGravityBlock(name) {
    const bare = String(name).replace(/^minecraft:/, '');
    return ['sand', 'red_sand', 'gravel', 'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'suspicious_sand', 'suspicious_gravel', 'concrete_powder'].includes(bare)
      || bare.endsWith('_concrete_powder');
  }

  isWaterloggable(value) {
    const { name, properties } = parseBlock(value);
    return Object.prototype.hasOwnProperty.call(properties, 'waterlogged')
      || ['water', 'lava'].includes(name);
  }
}

let defaultRegistry = null;
function getBlockRegistry(options = null) {
  if (options) return new BlockRegistry(options);
  if (!defaultRegistry) defaultRegistry = new BlockRegistry({ version: options?.version || null });
  return defaultRegistry;
}

module.exports = { BlockRegistry, getBlockRegistry, PREFERRED_FALLBACKS };
