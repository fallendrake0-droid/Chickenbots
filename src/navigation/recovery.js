'use strict';

const { nearestStandable } = require('./standability');

/**
 * Deterministic recovery ladder. No randomness: the same failure always
 * produces the same sequence, which makes simulator and unit tests meaningful.
 *
 *   0 restart  – clear controls, wait one tick, retry the same goal
 *   1 offset   – try a standable stance one/two blocks around the goal
 *   2 previous – fall back to a safe stance near the starting position
 */
function recoveryGoal({ attempt = 0, reader, target, start, range = 1, maxDrop = 3, allowWater = true }) {
  if (!target) return { action: 'abort', reason: 'no-target' };
  if (attempt <= 0) return { action: 'restart', position: { ...target } };
  if (attempt === 1) {
    // Search around the real goal, not a hard-coded southeast point. The old
    // (+2,+2) centre could land in a wall while a perfectly good adjacent
    // stance existed, so a transient obstruction exhausted recovery.
    const around = nearestStandable(reader, target, { maxNearbyRadius: 4, maxDrop, allowWater });
    if (around.ok) return { action: 'offset', position: around.position, offset: around.offset };
    return { action: 'restart', position: { ...target } };
  }
  if (start) {
    const back = nearestStandable(reader, { x: start.x, y: start.y, z: start.z }, { maxNearbyRadius: 3, maxDrop, allowWater });
    if (back.ok) return { action: 'previous', position: back.position };
  }
  return { action: 'abort', reason: 'recovery exhausted' };
}

function describeRecovery(plan) {
  if (!plan) return 'none';
  if (plan.action === 'restart') return 'restart the path after clearing controls';
  if (plan.action === 'offset') return `replan to an offset stance (${plan.offset ? `${plan.offset.x},${plan.offset.y},${plan.offset.z}` : 'nearby'})`;
  if (plan.action === 'previous') return 'return to a safe stance near the start';
  return plan.reason || 'abort';
}

module.exports = { recoveryGoal, describeRecovery };
