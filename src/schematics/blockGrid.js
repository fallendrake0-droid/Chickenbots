'use strict';

const { parseBlock, placementItem } = require('../building/blockStates');

const PHASES = ['FOUNDATION', 'FLOORS', 'WALLS', 'STAIRS', 'ROOF', 'TOWERS', 'INTERIOR', 'DECORATION', 'LIGHTING', 'TERRAIN'];
const PHASE_ORDER = Object.fromEntries(PHASES.map((p, i) => [p, i]));

/** Sparse voxel grid used by the generator. Coordinates start at 0 and the
 * final schematic is normalised to its bounding box. */
class BlockGrid {
  constructor() {
    this.cells = new Map();
    this.phaseOf = new Map();
  }

  static key(x, y, z) { return `${x},${y},${z}`; }

  set(x, y, z, name, phase = 'WALLS') {
    if (name === 'air') { this.clear(x, y, z); return false; }
    if (!name) return false;
    if (Math.abs(x) > 400 || Math.abs(y) > 400 || Math.abs(z) > 400) throw new Error(`schematic too large at ${x},${y},${z}`);
    if (!PHASE_ORDER.hasOwnProperty(phase)) throw new Error(`unknown build phase ${phase}`);
    const k = BlockGrid.key(x, y, z);
    this.cells.set(k, name);
    this.phaseOf.set(k, phase);
    return true;
  }

  get(x, y, z) { return this.cells.get(BlockGrid.key(x, y, z)) || null; }
  has(x, y, z) { return this.cells.has(BlockGrid.key(x, y, z)); }

  clear(x, y, z) {
    const k = BlockGrid.key(x, y, z);
    this.cells.delete(k);
    this.phaseOf.delete(k);
  }

  fill(x0, y0, z0, x1, y1, z1, name, phase) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, name, phase);
      }
    }
  }

  /** Horizontal rectangle outline (walls) with configurable thickness. */
  outline(x0, z0, x1, z1, y0, y1, name, phase, thickness = 1) {
    for (let y = y0; y <= y1; y++) {
      for (let t = 0; t < thickness; t++) {
        for (let x = x0 + t; x <= x1 - t; x++) {
          this.set(x, y, z0 + t, name, phase);
          this.set(x, y, z1 - t, name, phase);
        }
        for (let z = z0 + t; z <= z1 - t; z++) {
          this.set(x0 + t, y, z, name, phase);
          this.set(x1 - t, y, z, name, phase);
        }
      }
    }
  }

  rectangle(x0, z0, x1, z1, y, name, phase) {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, name, phase);
  }

  /** Solid or hollow cuboid. */
  box(x0, y0, z0, x1, y1, z1, name, phase, { hollow = false } = {}) {
    if (!hollow) { this.fill(x0, y0, z0, x1, y1, z1, name, phase); return; }
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (x === x0 || x === x1 || z === z0 || z === z1 || y === y0 || y === y1) this.set(x, y, z, name, phase);
        }
      }
    }
  }

  countByPhase() {
    const counts = {};
    for (const phase of this.phaseOf.values()) counts[phase] = (counts[phase] || 0) + 1;
    return counts;
  }

  materials() {
    const out = {};
    for (const name of this.cells.values()) {
      const bare = placementItem(parseBlock(name));
      out[bare] = (out[bare] || 0) + 1;
    }
    return out;
  }

  bounds() {
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    for (const k of this.cells.keys()) {
      const [x, y, z] = k.split(',').map(Number);
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    if (!this.cells.size) return null;
    return { minX, minY, minZ, maxX, maxY, maxZ, width: maxX - minX + 1, height: maxY - minY + 1, length: maxZ - minZ + 1 };
  }

  /** Normalised, deterministic block list: [x,y,z,paletteIndex,phaseIndex]. */
  compile() {
    const palette = [...new Set(this.cells.values())].sort();
    const paletteIndex = new Map(palette.map((n, i) => [n, i]));
    const blocks = [];
    for (const [k, name] of this.cells) {
      const [x, y, z] = k.split(',').map(Number);
      blocks.push([x, y, z, paletteIndex.get(name), PHASE_ORDER[this.phaseOf.get(k)]]);
    }
    blocks.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
    return { palette, blocks, phases: PHASES };
  }

  /** Shift every block so the bounding box starts at (0,0,0). */
  shiftToOrigin() {
    const b = this.bounds();
    if (!b) return this;
    const dx = -b.minX;
    const dy = -b.minY;
    const dz = -b.minZ;
    if (dx === 0 && dy === 0 && dz === 0) return this;
    const cells = new Map();
    const phases = new Map();
    for (const [k, name] of this.cells) {
      const [x, y, z] = k.split(',').map(Number);
      const nk = BlockGrid.key(x + dx, y + dy, z + dz);
      cells.set(nk, name);
      phases.set(nk, this.phaseOf.get(k));
    }
    this.cells = cells;
    this.phaseOf = phases;
    return this;
  }

  /** Merge another grid at an offset (offsets may be negative; the result is
   * normalised before compilation). */
  merge(other, dx = 0, dy = 0, dz = 0) {
    for (const [k, name] of other.cells) {
      const [x, y, z] = k.split(',').map(Number);
      this.set(x + dx, y + dy, z + dz, name, other.phaseOf.get(k));
    }
    return this;
  }

  clone() {
    const copy = new BlockGrid();
    copy.cells = new Map(this.cells);
    copy.phaseOf = new Map(this.phaseOf);
    return copy;
  }
}

module.exports = { BlockGrid, PHASES, PHASE_ORDER };
