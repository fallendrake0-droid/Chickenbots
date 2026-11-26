'use strict';

const { classifyAt, classifyBlock, readBlock, UNKNOWN_BLOCK } = require('./blocks');

const DEFAULT_OPTIONS = Object.freeze({
  maxDrop: 3,
  maxScanDown: 6,
  maxScanUp: 8,
  maxNearbyRadius: 6,
  allowWater: true,
  allowHazard: false,
  allowUnknown: false
});

function floorPosition(pos) {
  return { x: Math.floor(Number(pos.x)), y: Math.floor(Number(pos.y)), z: Math.floor(Number(pos.z)) };
}

function finitePosition(pos) {
  return Boolean(pos)
    && Number.isFinite(Number(pos.x))
    && Number.isFinite(Number(pos.y))
    && Number.isFinite(Number(pos.z));
}

function optionsWith(options = {}) {
  const defined = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (value !== undefined && value !== null) defined[key] = value;
  }
  return { ...DEFAULT_OPTIONS, ...defined };
}

/** Feet and head are the two blocks a 1.8-high player occupies. */
function bodyAt(reader, pos) {
  const feet = classifyAt(reader, pos);
  const head = classifyAt(reader, { x: pos.x, y: pos.y + 1, z: pos.z });
  return { feet, head, unknown: !feet.known || !head.known };
}

function bodyPassable(feet, head, { allowWater = true, allowHazard = false } = {}) {
  if (!feet.known || !head.known) return { ok: false, reason: 'unloaded' };
  if (feet.lava || head.lava) return { ok: false, reason: 'lava' };
  if ((feet.hazard || head.hazard) && !allowHazard) return { ok: false, reason: 'hazard' };
  if (feet.climbable) return { ok: head.passable || head.climbable || head.water, reason: head.passable ? 'climbable' : 'head-blocked' };
  if (!(feet.passable || (allowWater && feet.water))) return { ok: false, reason: 'feet-blocked' };
  if (!(head.passable || (allowWater && head.water) || head.climbable)) return { ok: false, reason: 'head-blocked' };
  return { ok: true, reason: 'clear' };
}

/**
 * The support under a candidate feet position. Water counts as swimmable, not
 * as a floor. An immediate drop greater than maxDrop is rejected: a bot must
 * not choose a destination that requires falling off a cliff.
 */
function supportAt(reader, pos, { maxDrop = 3, allowWater = true } = {}) {
  for (let drop = 0; drop <= maxDrop; drop++) {
    const below = classifyAt(reader, { x: pos.x, y: pos.y - 1 - drop, z: pos.z });
    if (!below.known) return { ok: false, reason: 'unloaded-support', drop };
    if (below.lava) return { ok: false, reason: 'lava-support', drop };
    if (below.hazard) return { ok: false, reason: 'hazard-support', drop };
    if (below.support) return { ok: drop === 0, reason: drop === 0 ? 'supported' : 'drop', drop, block: below.name };
    if (below.water && allowWater) return { ok: true, reason: 'water', drop, water: true };
    // A climbable column is its own support while descending or holding.
    if (below.climbable) return { ok: true, reason: 'climbable', drop, climbable: true };
  }
  return { ok: false, reason: 'no-support', drop: maxDrop + 1 };
}

/**
 * Full standability verdict for an integer feet coordinate.
 * `position` is always the requested coordinate, even when rejected.
 */
function standableAt(reader, pos, options = {}) {
  const opts = optionsWith(options);
  if (!finitePosition(pos)) return { ok: false, reason: 'invalid-position', position: pos || null };
  const at = floorPosition(pos);
  const body = bodyAt(reader, at);
  if (body.unknown && !opts.allowUnknown) {
    return { ok: false, reason: 'unloaded', unknown: true, position: at, feet: body.feet, head: body.head };
  }
  const clear = bodyPassable(body.feet, body.head, opts);
  if (!clear.ok) {
    return {
      ok: false, reason: clear.reason, position: at, feet: body.feet, head: body.head,
      hazard: body.feet.hazard || body.head.hazard, water: body.feet.water || body.head.water
    };
  }
  const support = supportAt(reader, at, opts);
  // A player can swim without support when the feet and head are water. That is
  // navigable but not a safe final destination unless the caller allows it.
  if (!support.ok && !(opts.allowWater && body.feet.water && (body.head.water || support.reason === 'no-support'))) {
    return { ok: false, reason: support.reason, position: at, feet: body.feet, head: body.head, support };
  }
  return {
    ok: true,
    reason: support.reason,
    position: at,
    feet: body.feet,
    head: body.head,
    support,
    water: body.feet.water || body.head.water,
    drop: support.drop || 0,
    climbable: support.climbable || body.feet.climbable,
    hazardNearby: nearbyHazard(reader, at)
  };
}

/** True when a lava/fire block touches the candidate stance horizontally. */
function nearbyHazard(reader, pos) {
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of offsets) {
    const block = classifyAt(reader, { x: pos.x + dx, y: pos.y, z: pos.z + dz });
    if (block.lava || block.name === 'fire' || block.name === 'soul_fire' || block.name === 'magma_block' || block.name === 'cactus') {
      return { name: block.name, x: pos.x + dx, z: pos.z + dz };
    }
  }
  return null;
}

/**
 * Resolve the requested block Y into a standable feet Y.
 *
 * The old helper only checked that feet/head were air-like and stepped upward.
 * It accepted a mid-air block, ignored the support below, treated water as dry
 * ground and could not recover from a solid destination. This scans both
 * directions, then nearby columns, and reports the adjustment it made.
 */
function resolveStandable(reader, pos, options = {}) {
  const opts = optionsWith(options);
  if (!finitePosition(pos)) return { ok: false, reason: 'invalid-position', position: pos || null };
  const original = floorPosition(pos);
  const maxUp = Math.max(0, Math.floor(Number(opts.maxScanUp) || 0));
  const maxDown = Math.max(0, Math.floor(Number(opts.maxScanDown) || 0));
  const order = [0];
  for (let d = 1; d <= Math.max(maxUp, maxDown); d++) {
    if (d <= maxUp) order.push(d);
    if (d <= maxDown) order.push(-d);
  }
  let sawUnknown = false;
  let firstReject = null;
  for (const dy of order) {
    const candidate = { x: original.x, y: original.y + dy, z: original.z };
    const verdict = standableAt(reader, candidate, opts);
    if (verdict.ok) {
      return {
        ...verdict,
        adjusted: dy !== 0,
        adjustment: dy,
        original,
        reason: dy === 0 ? verdict.reason : dy > 0 ? 'lifted' : 'lowered'
      };
    }
    if (verdict.unknown) sawUnknown = true;
    if (!firstReject) firstReject = verdict;
  }
  if (sawUnknown && !opts.allowUnknown) {
    // Keep the operator's coordinates rather than inventing a Y from a chunk
    // that has not arrived. Callers can retry once the world is loaded.
    return {
      ok: false, reason: 'unloaded', unknown: true, position: original,
      original, feet: firstReject && firstReject.feet, head: firstReject && firstReject.head
    };
  }
  const nearby = nearestStandable(reader, original, opts);
  if (nearby.ok) {
    return { ...nearby, adjusted: true, adjustment: { x: nearby.position.x - original.x, y: nearby.position.y - original.y, z: nearby.position.z - original.z }, original, reason: 'nearby-standable' };
  }
  return {
    ok: false, reason: 'no-standable-position', position: original, original,
    reject: firstReject, nearby: nearby.reason
  };
}

/** Compatibility helper: return only the resolved Y, preserving unknown Y. */
function resolveStandableY(reader, pos, options = {}) {
  const base = Number(pos && pos.y);
  if (!Number.isFinite(base)) return base;
  const resolved = resolveStandable(reader, pos, options);
  if (resolved.ok) return resolved.position.y;
  if (resolved.unknown) return Math.floor(base);
  return Math.floor(base);
}

function ringOffsets(radius, includeCenter = false) {
  const out = [];
  if (includeCenter) out.push([0, 0]);
  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        out.push([dx, dz]);
      }
    }
  }
  return out;
}

/** Deterministic nearest standable stance around a target, same Y band first. */
function nearestStandable(reader, pos, options = {}) {
  const opts = optionsWith(options);
  if (!finitePosition(pos)) return { ok: false, reason: 'invalid-position', position: null };
  const center = floorPosition(pos);
  const radius = Math.max(1, Math.min(16, Math.floor(Number(opts.maxNearbyRadius) || 4)));
  const offsets = ringOffsets(radius);
  // Prefer the target's own Y, then one above (block targets are often the
  // ground block the operator copied), then one below.
  const yOrder = [0, 1, -1, 2, -2, 3, -3];
  let sawUnknown = false;
  for (const dy of yOrder) {
    for (const [dx, dz] of offsets) {
      if (dx === 0 && dz === 0) continue;
      const candidate = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
      const verdict = standableAt(reader, candidate, opts);
      if (verdict.ok) return { ...verdict, offset: { x: dx, y: dy, z: dz } };
      if (verdict.unknown) sawUnknown = true;
    }
  }
  return { ok: false, reason: sawUnknown ? 'unloaded' : 'no-nearby-standable', unknown: sawUnknown, position: center };
}

/**
 * Choose a goal for a move. With range > 0 the requested coordinate may be the
 * block being worked; the stance is the nearest standable within that range.
 * With range 0 the coordinate itself must be standable.
 */
function goalPosition(reader, pos, { range = 1, adjustY = false, allowUnknown = false, ...options } = {}) {
  if (!finitePosition(pos)) return { ok: false, code: 'INVALID_DESTINATION', reason: 'invalid-position' };
  const requested = floorPosition(pos);
  const target = classifyAt(reader, requested);
  if (!target.known && !allowUnknown) {
    return { ok: false, code: 'DESTINATION_UNLOADED', reason: 'unloaded', unknown: true, requested };
  }
  if (adjustY) {
    const resolved = resolveStandable(reader, requested, { ...options, allowUnknown });
    if (!resolved.ok) return { ...resolved, code: resolved.unknown ? 'DESTINATION_UNLOADED' : 'NO_STANDABLE_DESTINATION', requested };
    return { ...resolved, code: null, requested, goal: resolved.position };
  }
  // An air/passable coordinate that is not actually supported is a suggested
  // point, not a legal stance. Internal callers frequently pass target.y from a
  // block they want to work near; resolve it to the real floor instead of
  // planning a GoalNear in mid-air.
  if (Number(range) > 0 && !target.solid && !target.hazard) {
    const direct = standableAt(reader, requested, { ...options, allowUnknown });
    if (direct.ok) return { ...direct, code: null, requested, goal: direct.position };
    const resolved = resolveStandable(reader, requested, { ...options, allowUnknown });
    if (resolved.ok) {
      return { ...resolved, code: null, requested, goal: resolved.position };
    }
  }
  // A passable/hazard target with range 0 must be resolved; a solid target with
  // range > 0 is a "stand next to this block" request.
  if (Number(range) <= 0 || target.hazard || target.lava) {
    const direct = standableAt(reader, requested, { ...options, allowUnknown });
    if (direct.ok) return { ...direct, code: null, requested, goal: direct.position };
    if (Number(range) <= 0) {
      const nearby = nearestStandable(reader, requested, { ...options, allowUnknown });
      if (nearby.ok) return { ...nearby, code: null, requested, goal: nearby.position, exact: false };
    }
    return {
      ...(direct.ok ? direct : { ok: false, reason: direct.reason, position: requested }),
      code: direct.unknown ? 'DESTINATION_UNLOADED' : 'NO_STANDABLE_DESTINATION',
      requested
    };
  }
  return { ok: true, reason: 'adjacent-to-target', requested, goal: requested, position: requested, target, code: null };
}

/**
 * All standable stances around a target, nearest-first. Construction and
 * mining targets often name a block high in a structure; the first standable
 * cell may be on the roof and unreachable, while a ground cell within the
 * requested range is a perfectly valid goal. Callers can try these in order.
 */
function standableCandidates(reader, pos, options = {}) {
  const opts = optionsWith(options);
  if (!finitePosition(pos)) return [];
  const center = floorPosition(pos);
  const radius = Math.max(1, Math.min(12, Math.floor(Number(opts.maxNearbyRadius) || 4)));
  const max = Math.max(1, Math.min(64, Math.floor(Number(opts.limit) || 12)));
  const maxDistance = Number(opts.maxDistance) > 0 ? Number(opts.maxDistance) : Infinity;
  // Range callers accept a lower stance; try low Y levels first and stop as
  // soon as enough candidates are found. This avoids scanning a full 3-D
  // shell around every high build target (which dominates mock build time).
  const yOrder = opts.lowFirst
    ? [-(maxDropBounded(opts)), -3, -2, -1, 0, 1, 2, 3, 4, 5]
    : [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5];
  const seenY = new Set();
  const out = [];
  outer:
  for (const dy of yOrder) {
    if (seenY.has(dy)) continue;
    seenY.add(dy);
    for (const [dx, dz] of ringOffsets(radius, true)) {
      if (Math.hypot(dx, dy, dz) > maxDistance) continue;
      const candidate = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
      const verdict = standableAt(reader, candidate, opts);
      if (!verdict.ok) continue;
      out.push({
        ...verdict,
        offset: { x: dx, y: dy, z: dz },
        distanceToCenter: Math.hypot(dx, dy, dz),
        score: Math.hypot(dx, dz) * 1.5 + Math.max(0, dy) * 10 + Math.max(0, -dy) * 0.25
      });
      if (out.length >= max) break outer;
    }
  }
  return out.sort((a, b) => a.position.y - b.position.y || a.score - b.score || a.distanceToCenter - b.distanceToCenter);
}

function maxDropBounded(opts) {
  const drop = Number(opts.maxDrop);
  return Number.isFinite(drop) && drop >= 0 ? Math.min(8, Math.floor(drop) + 1) : 4;
}

module.exports = {
  DEFAULT_OPTIONS,
  finitePosition,
  floorPosition,
  bodyAt,
  bodyPassable,
  supportAt,
  standableAt,
  resolveStandable,
  resolveStandableY,
  nearestStandable,
  nearbyHazard,
  goalPosition,
  standableCandidates,
  ringOffsets
};
