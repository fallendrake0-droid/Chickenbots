'use strict';

const { nearestStandable, standableCandidates, finitePosition } = require('./standability');

/**
 * Deterministic recovery ladder. No randomness: the same failure always
 * produces the same sequence, which makes simulator and unit tests meaningful.
 *
 *   0 restart   clear controls, retry the same goal
 *   1 offset    a standable stance around the goal (never a known failed cell)
 *   2 previous  a safe stance near the starting position
 *   3 midpoint  a safe stance halfway back toward the goal (breaks a corridor
 *               deadlock without abandoning the move)
 *   4 abort     report the reason instead of retrying for ever
 *
 * `avoid` is the bounded failure memory from NavigationManager. A candidate is
 * skipped when it is the exact cell that just failed, so the ladder cannot
 * oscillate between two equally blocked stances.
 */
function recoveryGoal({
  attempt = 0, reader, target, start, range = 1, maxDrop = 3,
  allowWater = true, avoid = [], openDoors = false
} = {}) {
  if (!target) return { action: 'abort', reason: 'no-target' };
  const opts = { maxDrop, allowWater, openDoors };
  const avoidKeys = new Set((Array.isArray(avoid) ? avoid : [])
    .filter(finitePosition)
    .map((pos) => `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`));
  const isAvoided = (pos) => pos && avoidKeys.has(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
  if (attempt <= 0) return { action: 'restart', position: { ...target } };
  if (attempt === 1) {
    // Search around the real goal, not a hard-coded southeast point. The old
    // (+2,+2) centre could land in a wall while a perfectly good adjacent
    // stance existed, so a transient obstruction exhausted recovery.
    const candidates = standableCandidates(reader, target, {
      ...opts, maxNearbyRadius: 4, limit: 12, maxDistance: Math.max(2, Number(range) || 1) + 2
    });
    const around = candidates.find((candidate) => !isAvoided(candidate.position))
      || (candidates[0] || nearestStandable(reader, target, { ...opts, maxNearbyRadius: 4 }));
    if (around && around.ok !== false && !isAvoided(around.position)) {
      return { action: 'offset', position: around.position, offset: around.offset || null };
    }
    return { action: 'restart', position: { ...target } };
  }
  if (attempt === 2 && start) {
    const candidates = standableCandidates(reader, { x: start.x, y: start.y, z: start.z }, {
      ...opts, maxNearbyRadius: 3, limit: 12
    });
    const back = candidates.find((candidate) => !isAvoided(candidate.position));
    if (back) return { action: 'previous', position: back.position };
    const nearest = nearestStandable(reader, { x: start.x, y: start.y, z: start.z }, { ...opts, maxNearbyRadius: 3 });
    if (nearest.ok && !isAvoided(nearest.position)) return { action: 'previous', position: nearest.position };
  }
  if (attempt === 3 && start) {
    const mid = {
      x: Math.round((start.x + target.x) / 2),
      y: Math.round((start.y + target.y) / 2),
      z: Math.round((start.z + target.z) / 2)
    };
    const candidates = standableCandidates(reader, mid, {
      ...opts, maxNearbyRadius: 5, limit: 16, maxDistance: 6
    });
    const step = candidates.find((candidate) => !isAvoided(candidate.position));
    if (step) return { action: 'midpoint', position: step.position };
  }
  return { action: 'abort', reason: 'recovery exhausted' };
}

function describeRecovery(plan) {
  if (!plan) return 'none';
  if (plan.action === 'restart') return 'restart the path after clearing controls';
  if (plan.action === 'offset') return `replan to an offset stance (${plan.offset ? `${plan.offset.x},${plan.offset.y},${plan.offset.z}` : 'nearby'})`;
  if (plan.action === 'previous') return 'return to a safe stance near the start';
  if (plan.action === 'midpoint') return 'replan through a safe midpoint stance';
  return plan.reason || 'abort';
}

module.exports = { recoveryGoal, describeRecovery };
