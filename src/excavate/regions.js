'use strict';

const { boxVolume, boxesOverlap, clone } = require('../util/vec');

/**
 * Split a bounds box into `parts` non-overlapping, roughly equal-volume
 * rectangular regions using deterministic guillotine cuts along the longer
 * horizontal axis. Only X/Z are split, so each bot removes full-depth columns;
 * this prevents two bots working the same block from opposite sides.
 */
function splitRegions(bounds, parts, { prefix = 'R', measure = null } = {}) {
  if (!bounds || !parts || parts < 1) return [];
  const volumeOf = (box) => (measure ? measure(box) : boxVolume(box.min, box.max));
  let regions = [{ id: `${prefix}1`, box: { min: clone(bounds.min), max: clone(bounds.max) } }];
  let idx = 1;
  while (regions.length < parts) {
    regions.sort((a, b) => volumeOf(b.box) - volumeOf(a.box) || a.id.localeCompare(b.id));
    const target = regions[0];
    const w = target.box.max.x - target.box.min.x + 1;
    const l = target.box.max.z - target.box.min.z + 1;
    // Split the longer axis; ties go to X for determinism.
    const axis = w >= l ? 'x' : 'z';
    const size = axis === 'x' ? w : l;
    if (size < 2) { regions.push({ id: `${prefix}${++idx}`, box: { min: clone(target.box.min), max: clone(target.box.max) } }); break; }
    const half = Math.floor(size / 2);
    const a = { min: clone(target.box.min), max: clone(target.box.max) };
    const b = { min: clone(target.box.min), max: clone(target.box.max) };
    if (axis === 'x') {
      a.max.x = target.box.min.x + half - 1;
      b.min.x = target.box.min.x + half;
    } else {
      a.max.z = target.box.min.z + half - 1;
      b.min.z = target.box.min.z + half;
    }
    regions.splice(regions.indexOf(target), 1,
      { id: target.id, box: a },
      { id: `${prefix}${++idx}`, box: b });
  }
  return regions.map((region, i) => ({
    ...region,
    label: i === 0 ? 'WEST/NORTH' : i === 1 ? 'EAST/SOUTH' : `${region.id}`,
    volume: volumeOf(region.box)
  }));
}

/** Split a region horizontally into quadrant-sections like the excavation UI. */
function quadrantNames(regions) {
  const labels = ['NORTHWEST', 'NORTHEAST', 'SOUTHWEST', 'SOUTHEAST', 'CENTER'];
  return regions.map((r, i) => ({ ...r, label: labels[i] || r.id }));
}

function assignRegions(regions, botNames, { supervisor = null, includeSupervisor = false } = {}) {
  const assign = [];
  const workers = includeSupervisor ? botNames.slice() : botNames.filter((n) => n !== supervisor);
  const pool = workers.length ? workers : botNames.slice();
  regions.forEach((region, i) => {
    const name = pool[i % pool.length];
    assign.push({ regionId: region.id, bot: name, box: region.box, volume: region.volume });
  });
  return {
    assignments: assign,
    supervisor: includeSupervisor ? null : supervisor,
    balanced: assign.every((a) => !regions.find((r) => r.id !== a.regionId && boxesOverlap(r.box, a.box)))
  };
}

/** Reassign a disconnected bot's region to the healthiest remaining bot. */
function reassignRegion(assignments, disconnectedBot, candidates = []) {
  const lost = assignments.filter((a) => a.bot === disconnectedBot);
  if (!lost.length) return { ok: false, error: 'bot has no regions' };
  const pool = candidates.filter((c) => c !== disconnectedBot);
  if (!pool.length) return { ok: false, error: 'no candidates' };
  const updated = assignments.map((a) => {
    if (a.bot !== disconnectedBot) return a;
    const loads = {};
    for (const x of assignments) if (x.bot !== disconnectedBot) loads[x.bot] = (loads[x.bot] || 0) + x.volume;
    const best = pool.slice().sort((x, y) => (loads[x] || 0) - (loads[y] || 0) || x.localeCompare(y))[0];
    return { ...a, bot: best, reassignedFrom: disconnectedBot };
  });
  return { ok: true, assignments: updated, moved: lost.length };
}

/** Layer iteration used by the planner and executor. */
function* iterateRegionLayers(box, { order = 'top-down', serpentine = true } = {}) {
  const yStart = order === 'bottom-up' ? box.min.y : box.max.y;
  const yEnd = order === 'bottom-up' ? box.max.y : box.min.y;
  const step = order === 'bottom-up' ? 1 : -1;
  let row = 0;
  for (let y = yStart; step > 0 ? y <= yEnd : y >= yEnd; y += step) {
    row = 0;
    for (let z = box.min.z; z <= box.max.z; z++) {
      const reverse = serpentine && row % 2 === 1;
      if (reverse) {
        for (let x = box.max.x; x >= box.min.x; x--) yield { x, y, z };
      } else {
        for (let x = box.min.x; x <= box.max.x; x++) yield { x, y, z };
      }
      row++;
    }
  }
}

function countLayers(bounds) {
  return bounds.max.y - bounds.min.y + 1;
}

module.exports = {
  splitRegions, assignRegions, reassignRegion, iterateRegionLayers,
  quadrantNames, countLayers
};
