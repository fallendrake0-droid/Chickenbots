'use strict';

const { distance } = require('../util/vec');
const { standableAt, nearbyHazard, floorPosition, finitePosition, bodyAt, bodyPassable } = require('./standability');
const { routeMode } = require('./policy');
const { dimensionProfile, withinDimension } = require('./dimension');

/**
 * Deterministic 3D grid planner used by MockBot and by the unit tests.
 *
 * RealBot delegates A* to mineflayer-pathfinder, but the fleet needs one
 * authoritative definition of a legal step. This planner is that definition:
 * horizontal steps, one-block rises, bounded drops, water swims and ladder
 * climbs. It never breaks or places blocks; a caller that wants tunnelling must
 * dig first and then ask to move through the resulting air.
 */

const CARDINALS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1]
];

class MinHeap {
  constructor() { this.items = []; this.seq = 0; }
  get size() { return this.items.length; }
  push(node) {
    node.order = this.seq++;
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.before(this.items[p], this.items[i])) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      i = p;
    }
  }
  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.before(this.items[l], this.items[smallest])) smallest = l;
        if (r < this.items.length && this.before(this.items[r], this.items[smallest])) smallest = r;
        if (smallest === i) break;
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return first;
  }
  before(a, b) {
    if (a.f !== b.f) return a.f < b.f;
    if (a.g !== b.g) return a.g < b.g;
    return a.order < b.order;
  }
}

function key(pos) { return `${pos.x},${pos.y},${pos.z}`; }

/**
 * One read-through cache for the duration of a move. A* asks for the same
 * feet/head/support cells many times per expansion and the stance search
 * scans a whole shell before planning; without this the simulator repeated
 * thousands of identical block reads. The cache is deliberately per-move (not
 * global): a dug block must be visible to the next plan.
 */
function withBlockCache(reader) {
  if (!reader || reader.__navigationBlockCache) return reader;
  const cache = new Map();
  const read = (pos) => {
    const at = floorPosition(pos);
    const k = key(at);
    if (cache.has(k)) return cache.get(k);
    let block = null;
    try {
      if (typeof reader.getBlock === 'function') block = reader.getBlock(at);
      else if (typeof reader.blockAt === 'function') block = reader.blockAt(at);
    } catch (_) {
      block = null;
    }
    cache.set(k, block);
    return block;
  };
  return {
    getBlock: read,
    blockAt: read,
    __navigationBlockCache: cache,
    position: reader.position
  };
}

function octile(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const dz = Math.abs(a.z - b.z);
  const horizontal = Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  return horizontal + dy * 1.35;
}

function goalTest(pos, target, range) {
  if (Number(range) <= 0) return pos.x === target.x && pos.y === target.y && pos.z === target.z;
  return distance(pos, target) <= Number(range) + 1e-9;
}

function clearAt(reader, pos, options) {
  const verdict = standableAt(reader, pos, options);
  if (!verdict.ok) return null;
  const hazard = verdict.hazardNearby || nearbyHazard(reader, pos);
  return { ...verdict, hazardNearby: hazard };
}

/**
 * Validate every body cell in a fall, not only the landing. A drop through a
 * closed trapdoor or into a lava column used to look legal because the landing
 * cell happened to be clear. Each intermediate cell must be body-passable with
 * the same options as the landing.
 */
function fallTrajectorySafe(reader, base, landing, options = {}) {
  if (!base || !landing) return { ok: false, reason: 'invalid-trajectory' };
  if (landing.y >= base.y) return { ok: false, reason: 'not-a-fall' };
  // Start one block below the take-off cell. The take-off body is checked by
  // the caller's standability verdict; re-checking it here rejected a normal
  // one-block stair descent into a two-block-high tunnel (the old head cell is
  // solid above the new stance but is never occupied at the destination).
  for (let y = base.y - 1; y > landing.y; y--) {
    const body = bodyAt(reader, { x: base.x, y, z: base.z }, options);
    if (body.unknown) return { ok: false, reason: 'trajectory-unloaded', y };
    const clear = bodyPassable(body.feet, body.head, options);
    if (!clear.ok) return { ok: false, reason: `trajectory-${clear.reason}`, y };
  }
  return { ok: true, drop: base.y - landing.y };
}

/** Convert advisory rows into an O(1) per-neighbour lookup grid. */
function avoidanceGrid(rows) {
  const grid = new Map();
  for (const row of rows) {
    const radius = Math.max(0.5, Number(row.radius) || 2);
    const weight = Math.max(0, Number(row.weight) || 2.5);
    const cx = Math.floor(row.position.x);
    const cy = Math.floor(row.position.y);
    const cz = Math.floor(row.position.z);
    const r = Math.ceil(radius);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const d = Math.hypot(dx, dy, dz);
          if (d > radius) continue;
          const k = `${cx + dx},${cy + dy},${cz + dz}`;
          const value = weight * (1 - d / (radius + 0.001));
          if (value > (grid.get(k) || 0)) grid.set(k, value);
        }
      }
    }
  }
  return grid;
}

function depthOfWater(reader, pos, options, limit = 4) {
  let depth = 0;
  for (let d = 0; d < limit; d++) {
    const body = bodyAt(reader, { x: pos.x, y: pos.y - d, z: pos.z }, options);
    if (!body.feet.water) break;
    depth++;
  }
  return depth;
}

/** Cost profile for a named route mode. All values are bounded and documented. */
function costProfile(mode, override = {}) {
  const m = routeMode(mode);
  return {
    water: override.waterCost === undefined ? m.waterCost : override.waterCost,
    hazard: override.hazardCost === undefined ? m.hazardCost : override.hazardCost,
    drop: override.dropCost === undefined ? m.dropCost : override.dropCost,
    climb: override.climbCost === undefined ? m.climbCost : override.climbCost,
    door: override.doorCost === undefined ? m.doorCost : override.doorCost,
    narrow: override.narrowCost === undefined ? m.narrowCost : override.narrowCost,
    stepUp: override.stepUpCost === undefined ? m.stepUpCost : override.stepUpCost,
    diagonal: override.diagonalCost === undefined ? m.diagonalCost : override.diagonalCost
  };
}

/**
 * Plan one segment.
 * @returns {{ok:boolean, path:Array, reason:string, expanded:number, visited:number, cost:number, start:object, goal:object}}
 */
function planRoute({
  reader, from, to, range = 0, maxNodes = 12000, maxDrop = undefined,
  allowWater = undefined, allowHazard = undefined, allowClimb = true, maxDistance = 256,
  deadline = Infinity, heuristicWeight = null, mode = 'balanced',
  openDoors = false, costOverrides = null, avoid = [], dimension = null
} = {}) {
  const startedAt = Date.now();
  if (!reader) return { ok: false, path: [], reason: 'no-reader', expanded: 0, visited: 0, cost: Infinity, ms: 0 };
  if (!finitePosition(from) || !finitePosition(to)) {
    return { ok: false, path: [], reason: 'invalid-position', expanded: 0, visited: 0, cost: Infinity, ms: 0 };
  }
  const modeSettings = routeMode(mode);
  const dimensionSettings = dimensionProfile(dimension || 'overworld');
  const effectiveMaxDrop = Math.min(dimensionSettings.maxDrop, maxDrop === undefined ? modeSettings.maxDrop : maxDrop);
  const effectiveAllowWater = allowWater === undefined ? modeSettings.allowWater : allowWater;
  const effectiveAllowHazard = allowHazard === undefined ? modeSettings.allowHazard : allowHazard;
  if (!withinDimension(dimensionSettings, from) || !withinDimension(dimensionSettings, to)) {
    return {
      ok: false, path: [], reason: 'outside-dimension-bounds', expanded: 0, visited: 0,
      cost: Infinity, ms: 0, dimension: dimensionSettings.name
    };
  }
  const target = floorPosition(to);
  const scan = withBlockCache(reader);
  let start = floorPosition(from);
  const options = {
    maxDrop: effectiveMaxDrop,
    allowWater: effectiveAllowWater,
    allowHazard: effectiveAllowHazard,
    openDoors
  };
  const costs = costProfile(mode, costOverrides || {});
  const avoidList = (Array.isArray(avoid) ? avoid : []).filter((row) => row && finitePosition(row.position || row))
    .map((row) => ({
      position: floorPosition(row.position || row),
      radius: Math.max(0.5, Number(row.radius) || 2),
      weight: Math.max(0, Number(row.weight) || 2.5)
    }));
  const avoidGrid = avoidanceGrid(avoidList);
  let startVerdict = standableAt(scan, start, options);
  if (!startVerdict.ok) {
    // A bot can be a block or two above its support for a tick after a dig or
    // a server correction. Search the immediate column in both directions
    // before declaring the start bad; an un-normalised start made every path
    // from a freshly levelled column fail with "already there".
    const maxDrop = Math.max(1, Number(options.maxDrop) || 3);
    const order = [0, 1, -1, 2, -2, 3, -3];
    for (let d = 4; d <= maxDrop; d++) order.push(-d);
    let recovered = null;
    for (const dy of order) {
      const candidate = { x: start.x, y: start.y + dy, z: start.z };
      const verdict = standableAt(scan, candidate, options);
      if (verdict.ok) { recovered = verdict; break; }
    }
    if (!recovered) {
      return { ok: false, path: [], reason: `start-${startVerdict.reason}`, expanded: 0, visited: 0, cost: Infinity, ms: Date.now() - startedAt, start };
    }
    start = recovered.position;
  }
  if (distance(start, target) > maxDistance) {
    return { ok: false, path: [], reason: 'beyond-segment-range', expanded: 0, visited: 0, cost: Infinity, ms: Date.now() - startedAt, start };
  }
  if (goalTest(start, target, range)) {
    return { ok: true, path: [], reason: 'already-there', expanded: 0, visited: 1, cost: 0, start, goal: startVerdict.position, ms: Date.now() - startedAt };
  }
  // A target inside a sealed room must fail quickly. Without a local search
  // envelope, A* expands the entire loaded neighbourhood (thousands of nodes)
  // before admitting there is no route.
  // A local work target does not need a 24-block search envelope. The old
  // floor let a three-block move that was blocked by a trunk expand thousands
  // of irrelevant nodes and hit the wall-clock budget, which read as `noPath`
  // and blocked the event loop for every other bot. Scale from the actual
  // distance, with a 16-block floor for a genuine detour around a wall.
  const maxDetour = Math.max(16, distance(start, target) * 2 + 8);
  const heap = new MinHeap();
  const open = new Map();
  const best = new Map();
  const parent = new Map();
  const weight = Math.max(1, Math.min(2, Number(heuristicWeight === null ? modeSettings.heuristicWeight : heuristicWeight) || 1));
  const startNode = { pos: start, g: 0, f: octile(start, target) * weight, order: 0 };
  heap.push(startNode);
  best.set(key(start), 0);
  let expanded = 0;
  let truncated = false;
  let timedOut = false;
  let closest = start;
  let closestDistance = distance(start, target);
  while (heap.size) {
    if (expanded >= maxNodes) { truncated = true; break; }
    // A caller with a wall-clock budget (the simulator's movement adapter)
    // must not be able to block the event loop for seconds in A*. Stop on a
    // coarse boundary so the clock check itself is not the hot path.
    if ((expanded & 63) === 0 && Date.now() >= deadline) { timedOut = true; break; }
    const node = heap.pop();
    const k = key(node.pos);
    if (open.has(k) && open.get(k) < node.g) continue;
    open.delete(k);
    expanded++;
    const d = distance(node.pos, target);
    if (d < closestDistance) { closest = node.pos; closestDistance = d; }
    if (goalTest(node.pos, target, range)) {
      const path = [];
      const moves = [];
      let cursor = k;
      while (parent.has(cursor)) {
        const entry = parent.get(cursor);
        path.push(entry.pos);
        moves.push(entry.move || 'walk');
        cursor = entry.parent;
      }
      path.reverse();
      moves.reverse();
      return {
        ok: true, path, moves, reason: path.length ? 'path' : 'already-there', expanded,
        visited: best.size, cost: node.g, start, goal: node.pos,
        closest, closestDistance: Number(closestDistance.toFixed(3)), ms: Date.now() - startedAt,
        mode: modeSettings.name, dimension: dimensionSettings.name,
        terrain: summarizeTerrain(scan, path, moves, options, start),
        budgetMs: deadline === Infinity ? null : Math.max(0, deadline - startedAt)
      };
    }
    for (const step of neighbours(scan, node.pos, options, allowClimb, costs, avoidGrid)) {
      if (octile(step.pos, target) > maxDetour) continue;
      const nk = key(step.pos);
      const g = node.g + step.cost;
      if (best.has(nk) && best.get(nk) <= g) continue;
      best.set(nk, g);
      parent.set(nk, { parent: k, pos: step.pos, move: step.move });
      const f = g + octile(step.pos, target) * weight;
      heap.push({ pos: step.pos, g, f });
      open.set(nk, g);
    }
  }
  return {
    ok: false,
    path: [],
    reason: timedOut ? 'time-budget' : (truncated ? 'search-limit' : 'no-path'),
    expanded, visited: best.size, cost: Infinity, start, closest,
    closestDistance: Number(closestDistance.toFixed(3)), ms: Date.now() - startedAt,
    mode: modeSettings.name, terrain: null, dimension: dimensionSettings.name
  };
}

/** Human- and dashboard-readable route composition. */
function summarizeTerrain(reader, path, moves, options, start = null) {
  const out = {
    steps: path.length, walk: 0, diagonal: 0, stepUp: 0, drop: 0, climb: 0,
    waterSteps: 0, hazardSteps: 0, doors: 0, narrowSteps: 0, maxDrop: 0,
    vertical: 0
  };
  if (!path.length) return out;
  out.vertical = path[path.length - 1].y - path[0].y;
  for (let i = 0; i < path.length; i++) {
    const move = moves[i] || 'walk';
    const prev = i === 0 ? (start || path[0]) : path[i - 1];
    const step = path[i];
    if (move === 'climb-up' || move === 'climb-down') out.climb++;
    else if (move === 'drop') {
      out.drop++;
      out.maxDrop = Math.max(out.maxDrop, Math.max(0, prev.y - step.y));
    } else if (move === 'step-up') out.stepUp++;
    else if (step.x !== prev.x && step.z !== prev.z) out.diagonal++;
    else out.walk++;
    const verdict = clearAt(reader, step, options);
    if (verdict) {
      if (verdict.water) out.waterSteps++;
      if (verdict.hazardNearby) out.hazardSteps++;
      if (verdict.feet && verdict.feet.doorLike) out.doors++;
    }
  }
  return out;
}

function neighbours(reader, pos, options, allowClimb, costs = costProfile('balanced'), avoid = new Map()) {
  const out = [];
  const current = clearAt(reader, pos, options);
  // Narrowness is derived from the moves A* actually generated, not from an
  // extra eight-block scan. The old scan multiplied every expansion by another
  // full standability pass and pushed ordinary 25-block construction walks over
  // their planning budget.
  let narrowCost = 0;
  for (const [dx, dz] of CARDINALS) {
    const diagonal = dx !== 0 && dz !== 0;
    const base = { x: pos.x + dx, y: pos.y, z: pos.z + dz };
    // Diagonal corner-cut guard: both orthogonal feet/head columns must be
    // traversable, or the player clips a wall corner.
    if (diagonal) {
      const a = clearAt(reader, { x: pos.x + dx, y: pos.y, z: pos.z }, options);
      const b = clearAt(reader, { x: pos.x, y: pos.y, z: pos.z + dz }, options);
      if (!a || !b) continue;
    }
    const horizontal = diagonal ? costs.diagonal : 1;
    const terrain = (verdict, extra = 0) => {
      let cost = horizontal + extra + narrowCost;
      if (verdict.water) cost += costs.water + Math.max(0, depthOfWater(reader, verdict.position, options) - 1) * 0.8;
      if (verdict.hazardNearby) cost += costs.hazard;
      if (verdict.feet && verdict.feet.climbable) cost += costs.climb;
      if (verdict.feet && verdict.feet.doorLike) cost += costs.door;
      // Soft fleet avoidance: another bot's claimed stance or corridor cell is
      // more expensive, not forbidden. A blocked doorway must still be usable
      // when it is the only route.
      if (avoid instanceof Map) {
        const penalty = avoid.get(key(verdict.position));
        if (penalty) cost += penalty;
      }
      return cost;
    };
    const flat = clearAt(reader, base, options);
    if (flat) out.push({ pos: base, move: diagonal ? 'diagonal' : 'walk', cost: terrain(flat) });
    // A one-block rise needs head room above the current head. Only cardinal
    // steps can be climbed; a diagonal step-up clips the corner in vanilla.
    if (!diagonal) {
      const head = classifyColumn(reader, { x: pos.x, y: pos.y + 2, z: pos.z });
      if (head) {
        const up = clearAt(reader, { x: base.x, y: base.y + 1, z: base.z }, options);
        if (up) out.push({ pos: { x: base.x, y: base.y + 1, z: base.z }, move: 'step-up', cost: terrain(up) + costs.stepUp });
      }
    }
    // Bounded drops. The landing must be standable *and* the full fall column
    // must be body-clear; intermediate lava, a closed trapdoor or an unloaded
    // chunk rejects the step instead of producing an optimistic jump.
    const maxDrop = Math.max(0, Number(options.maxDrop) || 0);
    // The drop starts by moving horizontally into `base`; that cell must be
    // body-clear even when it has no support of its own (a ledge). Without this
    // check a drop could be generated through a wall beside the ledge.
    let dropBodyClear = Boolean(flat);
    if (!dropBodyClear && maxDrop > 0) {
      const body = bodyAt(reader, base, options);
      dropBodyClear = bodyPassable(body.feet, body.head, options).ok;
    }
    for (let drop = 1; drop <= maxDrop; drop++) {
      // A one-block step down is entered from the side and never occupies the
      // take-off column at full height. Deeper drops must pass through that
      // column, so a blocked base body rejects them.
      if (drop > 1 && !dropBodyClear) continue;
      const landing = { x: base.x, y: base.y - drop, z: base.z };
      const down = clearAt(reader, landing, options);
      if (!down) continue;
      const fall = fallTrajectorySafe(reader, base, landing, options);
      if (!fall.ok) continue;
      out.push({
        pos: landing,
        move: 'drop',
        cost: terrain(down, costs.drop + drop * 0.45)
      });
      break;
    }
  }
  if (allowClimb && current && (current.climbable || current.feet.climbable)) {
    for (const dy of [-1, 1]) {
      const candidate = { x: pos.x, y: pos.y + dy, z: pos.z };
      const verdict = clearAt(reader, candidate, options);
      if (verdict) out.push({ pos: candidate, move: dy > 0 ? 'climb-up' : 'climb-down', cost: costs.climb + 0.6 });
    }
  }
  // A cell with at most two legal moves is a one-wide tunnel or a corner. Add
  // the narrow penalty once, after the exits are known.
  if (out.length <= 2) {
    narrowCost = costs.narrow;
    for (const step of out) step.cost += narrowCost;
  }
  // Deterministic ordering keeps equal-cost routes reproducible.
  out.sort((a, b) => a.cost - b.cost || a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.pos.z - b.pos.z);
  return out;
}

/**
 * Evaluate several candidate goals and keep the cheapest legal route. This is
 * what stops a bot retrying one unreachable coordinate for ever: an operator
 * target on a roof can still be served by a ground stance that A* can reach.
 * The shared deadline bounds the whole trial set, not each candidate.
 */
function planCandidates({
  reader, from, candidates = [], range = 0, maxNodes = 12000, deadline = Infinity,
  maxDrop = undefined, allowWater = undefined, allowHazard = undefined,
  mode = 'balanced', openDoors = false, maxCandidates = 8,
  avoid = [], dimension = null, costOverrides = null
} = {}) {
  const startedAt = Date.now();
  const trials = [];
  let best = null;
  const list = (Array.isArray(candidates) ? candidates : []).filter((row) => row && row.position).slice(0, Math.max(1, maxCandidates));
  for (const candidate of list) {
    if (Date.now() >= deadline) break;
    const plan = planRoute({
      reader, from, to: candidate.position, range, maxNodes, deadline,
      maxDrop, allowWater, allowHazard, mode, openDoors,
      avoid, dimension, costOverrides
    });
    trials.push({
      position: candidate.position, ok: plan.ok, cost: plan.ok ? plan.cost : null,
      reason: plan.reason, expanded: plan.expanded, score: candidate.score
    });
    if (plan.ok) {
      const total = plan.cost + (Number(candidate.score) || 0) * 0.05;
      if (!best || total < best.total) best = { ...plan, candidate, total };
    }
  }
  return {
    ok: Boolean(best), plan: best, trials,
    reason: best ? 'path' : (trials.length ? trials[0].reason : 'no-candidates'),
    expanded: trials.reduce((sum, row) => sum + (row.expanded || 0), 0),
    ms: Date.now() - startedAt, mode
  };
}

function classifyColumn(reader, pos) {
  try {
    const { classifyAt } = require('./blocks');
    const block = classifyAt(reader, pos);
    return block && block.known ? block : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  planRoute, planCandidates, goalTest, withBlockCache, CARDINALS,
  fallTrajectorySafe, summarizeTerrain, costProfile
};
