'use strict';

const { boxVolume, key } = require('../util/vec');
const { classifyBlock, isAir } = require('./safety');

/**
 * Verify an excavation against its plan.
 *
 * Verification is based on real blocks, never on the number of dig commands
 * issued. For very large areas the scan is budgeted and the result is reported
 * as SAMPLED instead of claiming an exhaustive check.
 */
class ExcavationVerifier {
  constructor(plan, { getBlock, budget = 40000, options = {}, mask = null } = {}) {
    if (!plan) throw new Error('plan required');
    if (typeof getBlock !== 'function') throw new Error('getBlock required');
    this.plan = plan;
    this.getBlock = getBlock;
    this.budget = budget;
    this.mask = mask;
    this.options = {
      preserveOres: true,
      protectedDefault: true,
      authorized: false,
      ...(plan.options || {}),
      ...options
    };
  }

  _shouldRemove(name) {
    const c = classifyBlock(name, this.options);
    if (c.kind === 'AIR') return false;
    return c.excavatable;
  }

  verifyRegion(region, { budget = this.budget } = {}) {
    const box = region.box || region;
    const volume = boxVolume(box.min, box.max);
    const stride = volume > budget ? Math.max(1, Math.ceil(Math.cbrt(volume / budget))) : 1;
    let checked = 0;
    let remaining = 0;
    let air = 0;
    const sample = [];
    for (let y = box.min.y; y <= box.max.y; y += stride) {
      for (let z = box.min.z; z <= box.max.z; z += stride) {
        for (let x = box.min.x; x <= box.max.x; x += stride) {
          const pos = { x, y, z };
          if (this.mask && !this.mask.includes(pos)) continue;
          const block = this.getBlock(pos);
          checked++;
          if (!block || isAir(block.name)) { air++; continue; }
          if (this._shouldRemove(block.name)) {
            remaining++;
            if (sample.length < 25) sample.push({ ...pos, name: block.name });
          }
        }
      }
    }
    const sampled = stride > 1;
    const expectedChecked = Math.ceil((box.max.x - box.min.x + 1) / stride)
      * Math.ceil((box.max.y - box.min.y + 1) / stride)
      * Math.ceil((box.max.z - box.min.z + 1) / stride);
    return {
      id: region.id || null,
      box,
      volume,
      checked,
      expectedChecked,
      remaining,
      air,
      stride,
      sampled,
      complete: remaining === 0,
      removedRatio: checked ? Number((1 - remaining / Math.max(1, checked - air + remaining)).toFixed(3)) : 0,
      sample
    };
  }

  verify({ perRegion = true } = {}) {
    const started = Date.now();
    const regions = perRegion && this.plan.regions && this.plan.regions.length
      ? this.plan.regions
      : [{ id: 'ALL', box: this.plan.bounds }];
    const perBudget = Math.max(2000, Math.floor(this.budget / Math.max(1, regions.length)));
    const results = regions.map((r) => this.verifyRegion(r, { budget: perBudget }));
    const remaining = results.reduce((s, r) => s + r.remaining, 0);
    const checked = results.reduce((s, r) => s + r.checked, 0);
    const sampled = results.some((r) => r.sampled);

    // Protected blocks must still exist where they were recorded at plan time.
    const forbiddenRemoved = [];
    for (const p of (this.plan.protectedBlocks || []).slice(0, 2000)) {
      const block = this.getBlock(p);
      if (!block || isAir(block.name)) forbiddenRemoved.push({ ...p, now: block ? block.name : 'air' });
    }
    const oreMissing = [];
    for (const ore of (this.plan.ores || []).slice(0, 500)) {
      const block = this.getBlock(ore);
      if (!block || isAir(block.name)) oreMissing.push({ ...ore, now: block ? block.name : 'air' });
    }

    // Access route: the stair/ramp bottom must be passable.
    let accessOk = true;
    if (this.plan.accessRoute && this.plan.accessRoute.bottom) {
      const b = this.plan.accessRoute.bottom;
      const block = this.getBlock(b);
      accessOk = Boolean(block && isAir(block.name));
    }
    const dims = this.plan.bounds;
    const expectedBox = Number.isFinite(this.plan.boxVolume)
      ? this.plan.boxVolume
      : (this.plan.mask && this.plan.mask.type === 'box' ? this.plan.volume : null);
    const dimensionsOk = dims.max.x >= dims.min.x && dims.max.y >= dims.min.y && dims.max.z >= dims.min.z
      && (expectedBox === null || expectedBox === boxVolume(dims.min, dims.max));

    const complete = remaining === 0 && forbiddenRemoved.length === 0 && dimensionsOk;
    const notes = [];
    if (sampled) notes.push('Verification used stratified sampling; remaining count is an estimate.');
    if (forbiddenRemoved.length) notes.push(`${forbiddenRemoved.length} protected blocks were removed and must be restored.`);
    if (!accessOk) notes.push('Access route is blocked; the pit needs safe entry/exit.');
    if (remaining > 0) notes.push(`${remaining} excavatable blocks remain.`);

    return {
      complete,
      checked,
      remaining,
      sampled,
      dimensionsOk,
      accessOk,
      forbiddenRemoved,
      oreMissing,
      regions: results,
      notes,
      durationMs: Date.now() - started,
      checkedAt: Date.now()
    };
  }
}

module.exports = { ExcavationVerifier };
