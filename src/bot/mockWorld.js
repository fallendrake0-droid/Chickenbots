'use strict';

const { key, distance } = require('../util/vec');
const { CROPS } = require('../world/crops');

const HOSTILE_TYPES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'slime', 'phantom', 'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'silverfish', 'guardian', 'elder_guardian', 'breeze', 'warden', 'zombie_villager', 'magma_cube', 'blaze', 'ghast', 'piglin', 'hoglin', 'zoglin', 'wither_skeleton', 'enderman']);

function hash3(x, y, z, salt = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647) + Math.imul(salt | 0, 1274126177);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function noise(x, z, salt = 0) {
  return (hash3(x, 0, z, salt) % 1000) / 1000;
}

function smoothNoise(x, z, scale, salt) {
  const cx = Math.floor(x / scale);
  const cz = Math.floor(z / scale);
  const fx = (x / scale) - cx;
  const fz = (z / scale) - cz;
  const a = noise(cx, cz, salt);
  const b = noise(cx + 1, cz, salt);
  const c = noise(cx, cz + 1, salt);
  const d = noise(cx + 1, cz + 1, salt);
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}

const ORE_TABLE = [
  { name: 'coal_ore', min: 0, max: 90, salt: 11, threshold: 12 },
  { name: 'iron_ore', min: -10, max: 60, salt: 23, threshold: 8 },
  { name: 'copper_ore', min: 0, max: 70, salt: 31, threshold: 7 },
  { name: 'gold_ore', min: -40, max: 30, salt: 47, threshold: 3 },
  { name: 'redstone_ore', min: -60, max: -5, salt: 59, threshold: 5 },
  { name: 'lapis_ore', min: -55, max: 5, salt: 67, threshold: 2 },
  { name: 'diamond_ore', min: -62, max: -20, salt: 79, threshold: 2 },
  { name: 'emerald_ore', min: -10, max: 70, salt: 83, threshold: 1 }
];

const DROPS = {
  stone: 'cobblestone', cobblestone: 'cobblestone', deepslate: 'cobbled_deepslate', dirt: 'dirt', grass_block: 'dirt',
  coarse_dirt: 'dirt', podzol: 'dirt', mycelium: 'dirt', mud: 'mud', clay: 'clay_ball', sand: 'sand', red_sand: 'red_sand',
  gravel: 'gravel', sandstone: 'sandstone', andesite: 'andesite', diorite: 'diorite', granite: 'granite', tuff: 'tuff',
  calcite: 'calcite', snow_block: 'snow_block', ice: 'ice', oak_log: 'oak_log', birch_log: 'birch_log', spruce_log: 'spruce_log',
  oak_leaves: 'oak_sapling', birch_leaves: 'birch_leaves', coal_ore: 'coal', iron_ore: 'raw_iron', copper_ore: 'raw_copper',
  gold_ore: 'raw_gold', redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli', diamond_ore: 'diamond', emerald_ore: 'emerald',
  deepslate_coal_ore: 'coal', deepslate_iron_ore: 'raw_iron', deepslate_copper_ore: 'raw_copper', deepslate_gold_ore: 'raw_gold',
  deepslate_redstone_ore: 'redstone', deepslate_lapis_ore: 'lapis_lazuli', deepslate_diamond_ore: 'diamond', deepslate_emerald_ore: 'emerald',
  wheat: 'wheat', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot', sugar_cane: 'sugar_cane',
  pumpkin: 'pumpkin', melon: 'melon_slice', cocoa: 'cocoa_beans', oak_planks: 'oak_planks', cobbled_deepslate: 'cobbled_deepslate',
  short_grass: 'wheat_seeds', grass: 'wheat_seeds', tall_grass: 'wheat_seeds', fern: 'wheat_seeds',
  dandelion: 'dandelion', poppy: 'poppy', torch: 'torch', crafting_table: 'crafting_table', chest: 'chest',
  furnace: 'furnace', water: null, lava: null, bedrock: null,
  stone_bricks: 'stone_bricks', glass: 'glass', bookshelf: 'bookshelf', lantern: 'lantern', white_wool: 'white_wool',
  oak_fence: 'oak_fence', oak_stairs: 'oak_stairs', oak_slab: 'oak_slab'
};

/**
 * Deterministic voxel world for simulation and tests.
 *
 * Terrain, caves, ores, trees and lakes are pure functions of coordinates, so
 * generation is cheap and reproducible. Player edits are stored as overrides.
 */
class MockWorld {
  constructor({ seed = 'chickenbots-v4', size = 256, seaLevel = 62, dayLength = 24000, flat = false, guaranteedOres = true } = {}) {
    this.flat = flat;
    this.guaranteedOres = guaranteedOres;
    this.seed = typeof seed === 'number' ? seed : [...String(seed)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
    this.size = size;
    this.seaLevel = seaLevel;
    this.overrides = new Map();
    // Block-state properties for edited cells. Kept separate from the block
    // name map so every existing caller that treats overrides as strings keeps
    // working while schematic construction can verify exact states.
    this.states = new Map();
    // Terrain lookups dominate repeated scans; cache the generated base block
    // name per coordinate. Overrides are consulted first so edits stay live.
    this._baseCache = new Map();
    this._scanCache = new Map();
    this.entities = [];
    this.time = 1000; // morning
    this.dayLength = dayLength;
    this.edits = { dug: 0, placed: 0 };
    this.huts = [
      { min: { x: 8, y: 0, z: 8 }, max: { x: 15, y: 0, z: 15 } }
    ];
    this.farms = [];
    if (guaranteedOres) this._guaranteedOres();
  }

  _guaranteedOres() {
    // Predictable ore pockets for tests and demos.
    const set = (x, y, z, name) => this.overrides.set(key({ x, y, z }), name);
    for (let i = 0; i < 6; i++) { set(6, 20 + i, 6, 'iron_ore'); set(30, 26 + i, 31, 'iron_ore'); }
    for (let i = 0; i < 4; i++) set(-8, -48 + i, -8, 'diamond_ore');
    for (let i = 0; i < 8; i++) set(12, 30 + i, -12, 'coal_ore');
    set(5, 24, 5, 'diamond_ore');
    set(21, 22, 21, 'lapis_ore');
    set(22, 22, 21, 'gold_ore');
    set(23, 22, 21, 'redstone_ore');
    set(-20, 50, 10, 'emerald_ore');
  }

  surfaceY(x, z) {
    if (this.flat) return 63;
    const base = 63 + Math.round(smoothNoise(x, z, 28, 3) * 6 - 2 + smoothNoise(x, z, 7, 19) * 2);
    const lake = this._lakeDepth(x, z);
    return Math.max(-60, base - lake);
  }

  _lakeDepth(x, z) {
    const d = Math.hypot(x - 38, z - 38);
    if (d > 9) return 0;
    return Math.round((9 - d) / 3);
  }

  _isLake(x, z) {
    return Math.hypot(x - 38, z - 38) < 9;
  }

  _cave(x, y, z) {
    if (this.flat) return false;
    if (y > this.surfaceY(x, z) - 3) return false;
    if (y < 5 && y > -56) {
      const c = Math.sin(x * 0.13) + Math.cos(z * 0.11) + Math.sin((x + z) * 0.07 + y * 0.05);
      if (c > 2.1) return true;
    }
    const tunnel = Math.sin(x * 0.07 + z * 0.05) * Math.cos(y * 0.09) + Math.sin(z * 0.06 - y * 0.04);
    return tunnel > 1.55;
  }

  _treeAt(x, z) {
    if (this.flat) return null;
    const surface = this.surfaceY(x, z);
    if (this._isLake(x, z)) return null;
    if (hash3(x, surface, z, 7) % 29 !== 0) return null;
    if (Math.abs(x) < 4 && Math.abs(z) < 4) return null;
    const height = 4 + (hash3(x, 0, z, 13) % 3);
    return { height, surface, type: hash3(x, 0, z, 17) % 5 === 0 ? 'birch' : 'oak' };
  }

  _treeBlock(pos) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const tree = this._treeAt(pos.x + dx, pos.z + dz);
        if (!tree) continue;
        const ox = pos.x + dx;
        const oz = pos.z + dz;
        const base = tree.surface + 1;
        const top = base + tree.height;
        if (pos.x === ox && pos.z === oz && pos.y >= base && pos.y < top) return `${tree.type}_log`;
        const leafBase = top - 3;
        if (pos.y >= leafBase && pos.y <= top + 1) {
          const r = pos.y >= top ? 1 : 2;
          const d = Math.max(Math.abs(pos.x - ox), Math.abs(pos.z - oz));
          if (d <= r && !(d === 0 && pos.y < top)) return `${tree.type}_leaves`;
        }
      }
    }
    return null;
  }

  _hutBlock(pos) {
    if (this.flat) return null;
    for (const hut of this.huts) {
      const { min, max } = hut;
      const baseY = this.surfaceY(Math.floor((min.x + max.x) / 2), Math.floor((min.z + max.z) / 2)) + 1;
      if (pos.x < min.x || pos.x > max.x || pos.z < min.z || pos.z > max.z) continue;
      if (pos.y < baseY || pos.y > baseY + 3) continue;
      const wallX = pos.x === min.x || pos.x === max.x;
      const wallZ = pos.z === min.z || pos.z === max.z;
      if (pos.y === baseY + 3) return 'oak_slab';
      if (pos.y < baseY + 3 && (wallX || wallZ)) {
        if (pos.x === min.x + 3 && pos.z === min.z) return 'oak_door';
        return 'oak_planks';
      }
      if (pos.x === min.x + 1 && pos.z === min.z + 1 && pos.y === baseY) return 'chest';
      if (pos.x === max.x - 1 && pos.z === max.z - 1 && pos.y === baseY) return 'crafting_table';
      if (pos.x === min.x + 1 && pos.z === max.z - 1 && pos.y === baseY) return 'white_bed';
      // The hut has a real interior. Without this explicit air the underlying
      // hillside leaked through the floor and a doorway could lead into solid
      // ground, which made every deterministic route into the hut fail.
      if (pos.y >= baseY && pos.y <= baseY + 3) return 'air';
    }
    return null;
  }

  _lakeBlock(pos) {
    if (this.flat) return null;
    if (!this._isLake(pos.x, pos.z)) return null;
    const surface = this.surfaceY(pos.x, pos.z);
    if (pos.y <= this.seaLevel && pos.y > surface - 2) return 'water';
    return null;
  }

  _lavaPocket(pos) {
    if (this.flat) return null;
    if (pos.x >= -34 && pos.x <= -26 && pos.z >= -34 && pos.z <= -26 && pos.y >= 8 && pos.y <= 13) return 'lava';
    return null;
  }

  baseBlockAt(pos) {
    const y = pos.y;
    if (y < -62) return 'bedrock';
    if (y <= -58) return 'bedrock';
    const surface = this.surfaceY(pos.x, pos.z);
    // Fast paths: nothing decorates the world more than eight blocks above or
    // below the surface except lava pockets and caves. Skipping the tree/hut
    // scans for those volumes keeps repeated action scans affordable.
    if (y > surface + 8) return 'air';
    const deep = y < surface - 8;
    const lava = this._lavaPocket(pos);
    if (lava) return lava;
    if (!deep) {
      const lake = this._lakeBlock(pos);
      if (lake) return lake;
      const tree = this._treeBlock(pos);
      if (tree) return tree;
      const hut = this._hutBlock(pos);
      if (hut) return hut;
    }
    if (y > surface) return 'air';
    if (this._cave(pos.x, y, pos.z)) return 'air';
    if (y === surface) {
      if (this._isLake(pos.x, pos.z)) return 'sand';
      if (surface <= this.seaLevel + 1) return 'sand';
      if (surface > 74) return 'snow_block';
      return 'grass_block';
    }
    if (y > surface - 4) return 'dirt';
    const depth = -y;
    for (const ore of ORE_TABLE) {
      if (this.flat) break;
      if (y < ore.min || y > ore.max) continue;
      if (hash3(pos.x, y, pos.z, ore.salt + (this.seed & 0xffff)) % 2000 < ore.threshold) {
        if (y < 0 && ore.name !== 'deepslate_emerald_ore') return `deepslate_${ore.name}`;
        if (y < 0 && ore.name === 'diamond_ore') return 'deepslate_diamond_ore';
        return ore.name;
      }
    }
    if (depth > 8) return 'stone';
    if (depth > 4) return 'stone';
    return 'stone';
  }

  /** Name-only lookup used by volume scans; avoids allocating block objects. */
  blockNameAt(x, y, z) {
    if (Math.abs(x) > this.size || Math.abs(z) > this.size || y < -64 || y > 320) return null;
    const k = `${x},${y},${z}`;
    const override = this.overrides.get(k);
    if (override !== undefined) return typeof override === 'string' ? override : override.name;
    let name = this._baseCache.get(k);
    if (name === undefined) {
      name = this.baseBlockAt({ x, y, z });
      if (this._baseCache.size > 1000000) this._baseCache.clear();
      this._baseCache.set(k, name);
    }
    return name;
  }

  getBlock(pos) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z);
    const name = this.blockNameAt(x, y, z);
    if (name === null) return null;
    const properties = this.states.get(`${x},${y},${z}`) || {};
    if (name === 'air') return { name: 'air', properties: {}, position: { x, y, z }, solid: false, boundingBox: 'empty' };
    return { name, properties: { ...properties }, position: { x, y, z }, solid: name !== 'water' && name !== 'lava', boundingBox: 'block' };
  }

  setBlock(pos, name, properties = null) {
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z);
    const k = key({ x, y, z });
    let bare = name;
    if (name && typeof name === 'object') {
      bare = name.name;
      properties = name.properties || properties;
    }
    const before = this.getBlock({ x, y, z });
    if (bare === 'air' || bare === null || bare === undefined) {
      this.overrides.set(k, 'air');
      this.states.delete(k);
      if (before && before.name !== 'air') this.edits.dug++;
    } else {
      this.overrides.set(k, bare);
      if (properties && Object.keys(properties).length) this.states.set(k, { ...properties });
      else this.states.delete(k);
      if (!before || before.name === 'air') this.edits.placed++;
    }
    this._scanCache.clear();
    return true;
  }

  /**
   * Deterministic crop growth for the simulator. Live growth comes from the
   * server; here each advance raises real `age` block states and lets mature
   * pumpkin/melon stems place one fruit on adjacent empty soil.
   */
  advanceCrops(ticks = 1) {
    const step = Math.max(1, Math.floor(Number(ticks) || 1));
    let grown = 0;
    let fruits = 0;
    const additions = [];
    for (const [k, name] of this.overrides) {
      const def = CROPS[name];
      if (!def) continue;
      const props = this.states.get(k) || {};
      if (name === 'pitcher_crop' && props.half === 'upper') continue;
      const age = Number(props.age);
      if (!Number.isFinite(age)) continue;
      if (age < def.maxAge) {
        const next = Math.min(def.maxAge, age + step);
        this.states.set(k, { ...props, age: next });
        grown++;
        continue;
      }
      if (!def.stem || !def.fruit) continue;
      const [x, y, z] = k.split(',').map(Number);
      const hasFruit = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => this.blockNameAt(x + dx, y, z + dz) === def.fruit);
      if (hasFruit) continue;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort((a, b) => (hash3(x + a[0], y, z + a[1], 91) % 4) - (hash3(x + b[0], y, z + b[1], 91) % 4));
      for (const [dx, dz] of dirs) {
        const fx = x + dx;
        const fz = z + dz;
        const target = this.blockNameAt(fx, y, fz);
        const below = this.blockNameAt(fx, y - 1, fz);
        const above = this.blockNameAt(fx, y + 1, fz);
        if (target === 'air' && above === 'air' && ['farmland', 'dirt', 'grass_block', 'coarse_dirt'].includes(below)) {
          additions.push({ pos: { x: fx, y, z: fz }, name: def.fruit });
          fruits++;
          break;
        }
      }
    }
    for (const addition of additions) this.setBlock(addition.pos, addition.name);
    this._scanCache.clear();
    return { ok: true, ticks: step, grown, fruits };
  }

  isSolid(pos) {
    const block = this.getBlock(pos);
    return Boolean(block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava');
  }

  addMob(type, position, { health = null, id = null, baby = false } = {}) {
    const entity = {
      id: id || `mob-${this.entities.length + 1}`,
      type,
      name: type,
      position: { x: position.x, y: position.y, z: position.z },
      health: health === null ? (baby ? 10 : 20) : health,
      baby: Boolean(baby),
      hostile: HOSTILE_TYPES.has(type),
      alive: true,
      createdAt: this.time
    };
    this.entities.push(entity);
    return entity;
  }

  removeMob(id) {
    const idx = this.entities.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.entities.splice(idx, 1);
    return true;
  }

  hostileNear(position, radius) {
    return this.entities.filter((e) => e.alive && e.hostile && distance(e.position, position) <= radius);
  }

  advanceTime(ticks = 20) {
    this.time = (this.time + ticks) % this.dayLength;
    return this.time;
  }

  setTime(time) { this.time = ((time % this.dayLength) + this.dayLength) % this.dayLength; return this.time; }

  findBlocks(name, near = { x: 0, y: 64, z: 0 }, radius = 24, limit = Infinity) {
    const names = Array.isArray(name) ? new Set(name) : new Set([name]);
    const nx = Math.round(near.x / 2) * 2;
    const ny = Math.round(near.y / 2) * 2;
    const nz = Math.round(near.z / 2) * 2;
    const cacheKey = `${[...names].sort().join(',')}|${nx},${ny},${nz}|${radius}`;
    const edits = this.edits.dug + this.edits.placed;
    const cached = this._scanCache.get(cacheKey);
    if (cached && cached.edits === edits && Date.now() - cached.at < 1200) return cached.out.slice();
    const out = [];
    const yFrom = Math.max(-64, ny - radius);
    const yTo = Math.min(200, ny + radius);
    for (let y = yFrom; y <= yTo; y++) {
      for (let z = nz - radius; z <= nz + radius; z++) {
        for (let x = nx - radius; x <= nx + radius; x++) {
          const found = this.blockNameAt(x, y, z);
          if (found && names.has(found)) {
            out.push({ x, y, z, name: found });
            if (out.length >= limit) return out;
          }
        }
      }
    }
    if (this._scanCache.size > 240) this._scanCache.clear();
    this._scanCache.set(cacheKey, { at: Date.now(), edits, out });
    return out.slice();
  }

  stats() {
    return { overrides: this.overrides.size, entities: this.entities.length, time: this.time, edits: { ...this.edits } };
  }
}

module.exports = { MockWorld, HOSTILE_TYPES, DROPS, hash3, ORE_TABLE };
