'use strict';

const { boxVolume } = require('../util/vec');
const { circleCells } = require('./footprint');

/**
 * A mask describes which blocks inside a plan's bounding box are actually part
 * of the excavation. Bounding boxes are rectangular, but radial excavations and
 * terraced quarries preserve material outside their true shape; volume,
 * per-region accounting, execution and verification must all agree on this.
 */
class ExcavationMask {
  constructor({ type = 'box', bounds, cells = null, tiers = null, tierHeight = 1, volume = null, description = '' }) {
    this.type = type;
    this.bounds = bounds;
    this.cells = cells; // Set of "x,z" for radial shapes
    this.tiers = tiers; // [{inset, yOffset, height, width, length}]
    this.tierHeight = tierHeight;
    this.volume = volume !== null ? volume : boxVolume(bounds.min, bounds.max);
    this.description = description;
  }

  includes(pos) {
    if (!pos) return false;
    const b = this.bounds;
    if (pos.x < b.min.x || pos.x > b.max.x || pos.y < b.min.y || pos.y > b.max.y || pos.z < b.min.z || pos.z > b.max.z) return false;
    if (this.type === 'radius') return this.cells.has(`${Math.floor(pos.x)},${Math.floor(pos.z)}`);
    if (this.type === 'terrace') {
      const tier = this._tierAt(pos.y);
      if (!tier) return false;
      return pos.x >= b.min.x + tier.inset && pos.x <= b.max.x - tier.inset
        && pos.z >= b.min.z + tier.inset && pos.z <= b.max.z - tier.inset;
    }
    return true;
  }

  _tierAt(y) {
    if (!this.tiers || !this.tiers.length) return null;
    for (const tier of this.tiers) {
      const top = this.bounds.max.y - tier.yOffset;
      const bottom = top - tier.height + 1;
      if (y <= top && y >= bottom) return tier;
    }
    return null;
  }

  /** Masked block count inside a sub-box (used for balanced region splitting). */
  measure(box) {
    if (this.type === 'box') return boxVolume(box.min, box.max);
    if (this.type === 'radius') {
      let columns = 0;
      for (const c of this.cells) {
        const [x, z] = c.split(',').map(Number);
        if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) columns++;
      }
      return columns * (box.max.y - box.min.y + 1);
    }
    if (this.type === 'terrace') {
      let total = 0;
      for (let y = box.min.y; y <= box.max.y; y++) {
        const tier = this._tierAt(y);
        if (!tier) continue;
        const x0 = Math.max(box.min.x, this.bounds.min.x + tier.inset);
        const x1 = Math.min(box.max.x, this.bounds.max.x - tier.inset);
        const z0 = Math.max(box.min.z, this.bounds.min.z + tier.inset);
        const z1 = Math.min(box.max.z, this.bounds.max.z - tier.inset);
        if (x1 >= x0 && z1 >= z0) total += (x1 - x0 + 1) * (z1 - z0 + 1);
      }
      return total;
    }
    return boxVolume(box.min, box.max);
  }
}

function maskForPlan({ mode, bounds, depth, radius, center, terraces, tierHeight, targetY }) {
  if (mode === 'RADIUS') {
    const cells = new Set(circleCells(center, radius).map((c) => `${c.x},${c.z}`));
    return new ExcavationMask({
      type: 'radius',
      bounds,
      cells,
      volume: cells.size * depth,
      description: `radial footprint (${cells.size} columns)`
    });
  }
  if (mode === 'QUARRY' && terraces && terraces.length) {
    let volume = 0;
    for (const tier of terraces) volume += tier.width * tier.length * tier.height;
    return new ExcavationMask({
      type: 'terrace',
      bounds,
      tiers: terraces,
      tierHeight: tierHeight || 3,
      volume,
      description: `terraced quarry (${terraces.length} tiers)`
    });
  }
  return new ExcavationMask({ type: 'box', bounds, volume: boxVolume(bounds.min, bounds.max), description: 'rectangular volume' });
}

module.exports = { ExcavationMask, maskForPlan };
