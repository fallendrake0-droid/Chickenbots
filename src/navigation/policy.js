'use strict';

const { config } = require('../config');
const { distance } = require('../util/vec');
const { finitePosition } = require('./standability');

/**
 * One serializable definition of the live pathfinding policy.
 *
 * The renderer, `path` command and mineflayer adapter must describe the same
 * rules. Keeping the numbers here stops a dashboard label from claiming a
 * budget the pathfinder does not actually use.
 */
function navigationPolicy(settings = null) {
  const nav = settings || config.navigation || {};
  const autonomy = config.autonomy || {};
  return {
    strictDestinations: nav.strictDestinations !== false,
    maxDrop: Number(nav.maxDrop === undefined ? 3 : nav.maxDrop),
    allowWater: nav.allowWater !== false,
    taskAttempts: Number(nav.maxAttempts === undefined ? 2 : nav.maxAttempts),
    operatorAttempts: Number(nav.operatorAttempts === undefined ? 3 : nav.operatorAttempts),
    recoveryDelayMs: Number(nav.recoveryDelayMs === undefined ? 250 : nav.recoveryDelayMs),
    stuckWindowMs: Number(nav.stuckWindowMs === undefined ? 2500 : nav.stuckWindowMs),
    waitForWorldMs: Number(nav.waitForWorldMs === undefined ? 750 : nav.waitForWorldMs),
    defaultTimeoutMs: Number(nav.defaultTimeoutMs === undefined ? 20000 : nav.defaultTimeoutMs),
    maxNodes: Number(nav.maxNodes || 12000),
    longDistance: Number(nav.longDistance || 64),
    segmentLength: Number(nav.segmentLength || 32),
    planBudgetMs: Number(nav.planBudgetMs || 350),
    allowDig: nav.allowDig === true,
    allowScaffold: nav.allowScaffold === true,
    openDoors: nav.openDoors === true,
    sprint: nav.sprint !== false,
    adaptiveSearchRadius: nav.adaptiveSearchRadius !== false,
    baseSearchRadius: Number(autonomy.pathfinderSearchRadius || 64),
    searchRadiusScale: Number(nav.searchRadiusScale || 1.5),
    searchRadiusMax: Number(nav.searchRadiusMax || 512),
    thinkTimeoutMs: Number(autonomy.pathfinderThinkTimeoutMs || 2500),
    tickTimeoutMs: Number(autonomy.pathfinderTickTimeoutMs || 10)
  };
}

/**
 * Mineflayer-pathfinder's `searchRadius` is a detour budget added to the
 * heuristic, not the maximum route length. A fixed 64 therefore fails a long
 * walk that has to go around a base or a ravine even though the straight-line
 * distance is legal. Scale the budget with the real distance, with a floor and
 * a hard ceiling so one enormous request cannot expand the whole loaded world.
 */
function adaptiveSearchRadius(base, from, to, {
  enabled = true, scale = 1.5, max = 512, padding = 16
} = {}) {
  const floor = Math.max(8, Math.ceil(Number(base) || 64));
  const ceiling = Math.max(floor, Math.ceil(Number(max) || 512));
  if (!enabled || !finitePosition(from) || !finitePosition(to)) return floor;
  const straight = distance(from, to);
  if (!Number.isFinite(straight)) return floor;
  const factor = Math.max(0.5, Math.min(4, Number(scale) || 1.5));
  const wanted = Math.ceil(straight * factor + Math.max(0, Number(padding) || 0));
  return Math.max(floor, Math.min(ceiling, wanted));
}

module.exports = { navigationPolicy, adaptiveSearchRadius };
