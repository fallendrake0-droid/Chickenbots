'use strict';

const { config } = require('../config');
const { distance } = require('../util/vec');
const { finitePosition } = require('./standability');
const { dimensionProfile } = require('./dimension');

/**
 * One serializable definition of the live pathfinding policy.
 *
 * The renderer, `path` command and mineflayer adapter must describe the same
 * rules. Keeping the numbers here stops a dashboard label from claiming a
 * budget the pathfinder does not actually use.
 */

/**
 * Named route modes. They are the single source of truth for both the planner
 * cost model and the live pathfinder policy; a dashboard label may not invent a
 * mode that the backend does not implement.
 *
 *   SAFE      shortest distance is irrelevant; avoid water, drops and hazards
 *   FAST      accept bounded drops and water to cut corners
 *   BALANCED  the default: no hazards, bounded drops, water allowed
 *   CAUTIOUS  no drops beyond one block, no water, larger hazard penalty
 *   FOLLOW    escort a player: balanced but cheap to replan frequently
 *   COMBAT    stay on solid ground, avoid water, prefer open ground
 *   RETREAT   safe ladder bias: shortest legal escape, hazards avoided
 *   TASK      routine work travel: balanced with a stronger narrow-passage cost
 *
 * `maxDrop` is in blocks. `heuristicWeight` stays at or above 1 so A* remains
 * admissible with the terrain costs below.
 */
const ROUTE_MODES = Object.freeze({
  SAFE: { maxDrop: 1, allowWater: false, allowHazard: false, heuristicWeight: 1.15, waterCost: 12, hazardCost: 24, dropCost: 3, climbCost: 1.6, doorCost: 0.8, narrowCost: 1.4, stepUpCost: 2.2, diagonalCost: 1.45 },
  FAST: { maxDrop: 4, allowWater: true, allowHazard: false, heuristicWeight: 1.3, waterCost: 1.1, hazardCost: 12, dropCost: 0.2, climbCost: 0.8, doorCost: 0.2, narrowCost: 0.1, stepUpCost: 1.0, diagonalCost: 1.38 },
  BALANCED: { maxDrop: 3, allowWater: true, allowHazard: false, heuristicWeight: 1.2, waterCost: 1.8, hazardCost: 8, dropCost: 0.6, climbCost: 1.1, doorCost: 0.35, narrowCost: 0.45, stepUpCost: 1.4, diagonalCost: 1.4142 },
  CAUTIOUS: { maxDrop: 1, allowWater: false, allowHazard: false, heuristicWeight: 1.1, waterCost: 20, hazardCost: 32, dropCost: 4, climbCost: 2, doorCost: 1, narrowCost: 2, stepUpCost: 2.6, diagonalCost: 1.5 },
  FOLLOW: { maxDrop: 2, allowWater: true, allowHazard: false, heuristicWeight: 1.25, waterCost: 2.2, hazardCost: 10, dropCost: 0.8, climbCost: 1.2, doorCost: 0.4, narrowCost: 0.5, stepUpCost: 1.5, diagonalCost: 1.42 },
  COMBAT: { maxDrop: 2, allowWater: false, allowHazard: false, heuristicWeight: 1.2, waterCost: 18, hazardCost: 20, dropCost: 1.4, climbCost: 1.4, doorCost: 0.6, narrowCost: 1.2, stepUpCost: 1.7, diagonalCost: 1.45 },
  RETREAT: { maxDrop: 3, allowWater: false, allowHazard: false, heuristicWeight: 1.35, waterCost: 16, hazardCost: 30, dropCost: 0.4, climbCost: 0.9, doorCost: 0.3, narrowCost: 0.3, stepUpCost: 1.2, diagonalCost: 1.4 },
  TASK: { maxDrop: 3, allowWater: true, allowHazard: false, heuristicWeight: 1.2, waterCost: 2, hazardCost: 10, dropCost: 0.7, climbCost: 1.1, doorCost: 0.4, narrowCost: 0.8, stepUpCost: 1.6, diagonalCost: 1.4142 }
});

function routeMode(name = 'balanced', overrides = {}) {
  const key = String(name || 'balanced').trim().toUpperCase();
  const base = ROUTE_MODES[key] || ROUTE_MODES.BALANCED;
  return { name: ROUTE_MODES[key] ? key : 'BALANCED', ...base, ...(overrides || {}) };
}

function routeModeNames() { return Object.keys(ROUTE_MODES); }

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
    planBudgetMs: Number(nav.planBudgetMs || 700),
    allowDig: nav.allowDig === true,
    allowScaffold: nav.allowScaffold === true,
    openDoors: nav.openDoors === true,
    routeMode: routeMode(nav.routeMode || 'balanced').name,
    sprint: nav.sprint !== false,
    adaptiveSearchRadius: nav.adaptiveSearchRadius !== false,
    baseSearchRadius: Number(autonomy.pathfinderSearchRadius || 64),
    searchRadiusScale: Number(nav.searchRadiusScale || 1.5),
    searchRadiusMax: Number(nav.searchRadiusMax || 512),
    thinkTimeoutMs: Number(autonomy.pathfinderThinkTimeoutMs || 2500),
    tickTimeoutMs: Number(autonomy.pathfinderTickTimeoutMs || 10),
    operatorThinkTimeoutMs: Number(autonomy.pathfinderOperatorThinkTimeoutMs || 8000),
    operatorTickTimeoutMs: Number(autonomy.pathfinderOperatorTickTimeoutMs || 25),
    dimension: dimensionProfile(nav.dimension || 'overworld')
  };
}

/**
 * A* budgets for one planning attempt. Operator moves get a bigger slice and a
 * bigger wall-clock budget; each subsequent attempt may scale the wall budget
 * once more so a long walk is not abandoned at the first timeout while the
 * autonomous task budget stays small.
 */
function pathfinderBudgets(priority = 'task', { attempt = 0, settings = null } = {}) {
  const policy = navigationPolicy(settings);
  const operator = String(priority).toLowerCase() === 'operator';
  const baseThink = operator ? policy.operatorThinkTimeoutMs : policy.thinkTimeoutMs;
  const scale = operator ? Math.min(2, 1 + Math.max(0, Number(attempt) || 0) * 0.5) : 1;
  return {
    thinkTimeoutMs: Math.round(Math.max(100, baseThink * scale)),
    tickTimeoutMs: operator ? policy.operatorTickTimeoutMs : policy.tickTimeoutMs,
    operator
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

module.exports = {
  ROUTE_MODES, routeMode, routeModeNames,
  navigationPolicy, adaptiveSearchRadius, pathfinderBudgets
};
