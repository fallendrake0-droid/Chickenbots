'use strict';

/**
 * Dimension-aware navigation bounds.
 *
 * The deterministic planner is dimension-agnostic in its blocks, but Y limits
 * and the safe drop envelope are not: a Nether move can fall into lava, and an
 * End move outside the island is a void death rather than a normal drop. The
 * profile is kept small and serialisable so the dashboard explains the same
 * limits the planner uses.
 */
const DIMENSIONS = Object.freeze({
  overworld: { name: 'overworld', minY: -64, maxY: 320, maxDrop: 4, allowWater: true, voidDeath: false },
  nether: { name: 'nether', minY: 0, maxY: 256, maxDrop: 2, allowWater: true, voidDeath: false, lavaHazard: true },
  end: { name: 'the_end', minY: 0, maxY: 256, maxDrop: 2, allowWater: false, voidDeath: true }
});

function normalizeDimension(value) {
  const raw = String(value || 'overworld').toLowerCase().replace(/^minecraft:/, '');
  if (raw === 'the_nether' || raw === 'nether') return 'nether';
  if (raw === 'the_end' || raw === 'end') return 'end';
  return 'overworld';
}

function dimensionProfile(value) {
  return { ...DIMENSIONS[normalizeDimension(value)] };
}

function withinDimension(profile, position) {
  if (!profile || !position) return false;
  const y = Number(position.y);
  return Number.isFinite(y) && y >= profile.minY && y <= profile.maxY;
}

module.exports = { DIMENSIONS, normalizeDimension, dimensionProfile, withinDimension };
