'use strict';

const { distance } = require('../util/vec');
const { standableAt, nearbyHazard, floorPosition, finitePosition } = require('./standability');

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
 * Plan one segment.
 * @returns {{ok:boolean, path:Array, reason:string, expanded:number, visited:number, cost:number, start:object, goal:object}}
 */
function planRoute({
  reader, from, to, range = 0, maxNodes = 12000, maxDrop = 3,
  allowWater = true, allowHazard = false, allowClimb = true, maxDistance = 256,
  deadline = Infinity, heuristicWeight = 1.2
} = {}) {
  const startedAt = Date.now();
  if (!reader) return { ok: false, path: [], reason: 'no-reader', expanded: 0, visited: 0, cost: Infinity, ms: 0 };
  if (!finitePosition(from) || !finitePosition(to)) {
    return { ok: false, path: [], reason: 'invalid-position', expanded: 0, visited: 0, cost: Infinity, ms: 0 };
  }
  const target = floorPosition(to);
  const scan = withBlockCache(reader);
  let start = floorPosition(from);
  const options = { maxDrop, allowWater, allowHazard };
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
  const weight = Math.max(1, Math.min(2, Number(heuristicWeight) || 1));
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
      let cursor = k;
      while (parent.has(cursor)) {
        const entry = parent.get(cursor);
        path.push(entry.pos);
        cursor = entry.parent;
      }
      path.reverse();
      return {
        ok: true, path, reason: path.length ? 'path' : 'already-there', expanded,
        visited: best.size, cost: node.g, start, goal: node.pos,
        closest, closestDistance: Number(closestDistance.toFixed(3)), ms: Date.now() - startedAt
      };
    }
    for (const step of neighbours(scan, node.pos, options, allowClimb)) {
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
    closestDistance: Number(closestDistance.toFixed(3)), ms: Date.now() - startedAt
  };
}

function neighbours(reader, pos, options, allowClimb) {
  const out = [];
  const current = clearAt(reader, pos, options);
  for (const [dx, dz] of CARDINALS) {
    const base = { x: pos.x + dx, y: pos.y, z: pos.z + dz };
    // Diagonal corner-cut guard: both orthogonal feet/head columns must be
    // traversable, or the player clips a wall corner.
    if (dx !== 0 && dz !== 0) {
      const a = clearAt(reader, { x: pos.x + dx, y: pos.y, z: pos.z }, options);
      const b = clearAt(reader, { x: pos.x, y: pos.y, z: pos.z + dz }, options);
      if (!a || !b) continue;
    }
    const horizontal = dx !== 0 && dz !== 0 ? Math.SQRT2 : 1;
    const flat = clearAt(reader, base, options);
    if (flat) {
      out.push({ pos: base, move: 'walk', cost: horizontal + (flat.water ? 1.8 : 0) + (flat.hazardNearby ? 8 : 0) });
    }
    // A one-block rise needs head room above the current head.
    if (dx === 0 || dz === 0) {
      const head = classifyColumn(reader, { x: pos.x, y: pos.y + 2, z: pos.z });
      if (head) {
        const up = clearAt(reader, { x: base.x, y: base.y + 1, z: base.z }, options);
        if (up) out.push({ pos: { x: base.x, y: base.y + 1, z: base.z }, move: 'step-up', cost: horizontal + 1.4 + (up.hazardNearby ? 8 : 0) });
      }
    }
    // Bounded drops. The landing must be standable; intermediate air is fine.
    const maxDrop = Math.max(0, Number(options.maxDrop) || 0);
    for (let drop = 1; drop <= maxDrop; drop++) {
      const down = clearAt(reader, { x: base.x, y: base.y - drop, z: base.z }, options);
      if (!down) continue;
      out.push({
        pos: { x: base.x, y: base.y - drop, z: base.z },
        move: 'drop',
        cost: horizontal + 0.6 + drop * 0.45 + (down.water ? 1.2 : 0) + (down.hazardNearby ? 8 : 0)
      });
      break;
    }
  }
  if (allowClimb && current && (current.climbable || current.feet.climbable)) {
    for (const dy of [-1, 1]) {
      const candidate = { x: pos.x, y: pos.y + dy, z: pos.z };
      const verdict = clearAt(reader, candidate, options);
      if (verdict) out.push({ pos: candidate, move: dy > 0 ? 'climb-up' : 'climb-down', cost: 1.1 });
    }
  }
  // Deterministic ordering keeps equal-cost routes reproducible.
  out.sort((a, b) => a.cost - b.cost || a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.pos.z - b.pos.z);
  return out;
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

module.exports = { planRoute, goalTest, withBlockCache, CARDINALS };
