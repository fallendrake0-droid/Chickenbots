'use strict';

const { distance } = require('../util/vec');

/**
 * Fleet-level destination claims.
 *
 * Ten bots independently choosing the same stance is a real failure mode:
 * they block each other, the pathfinder retries, and the dashboard shows a
 * crowd apparently "stuck". Claims are advisory and bounded by TTL. Operator
 * and emergency moves are never relocated, but they still report a conflict.
 */
class FleetCongestion {
  constructor({ now = Date.now, radius = 1.5, ttlMs = 5000 } = {}) {
    this.now = now;
    this.radius = Math.max(0.5, Number(radius) || 1.5);
    this.ttlMs = Math.max(500, Number(ttlMs) || 5000);
    this.claims = new Map();
    this.corridors = new Map();
    this.conflicts = 0;
    this.relocations = 0;
  }

  _sweep() {
    const now = this.now();
    for (const [name, claim] of this.claims) if (now >= claim.expiresAt) this.claims.delete(name);
    for (const [name, corridor] of this.corridors) if (now >= corridor.expiresAt) this.corridors.delete(name);
  }

  /**
   * Reserve a bounded corridor for a running route. Corridors are advisory:
   * the planner adds a soft cost near them, so a teammate can still use the
   * only doorway. They expire with the route and are never used near operators.
   */
  claimRoute(name, path, { kind = 'corridor', priority = 'task', ttlMs = null, limit = 32 } = {}) {
    this._sweep();
    if (!name || !Array.isArray(path) || !path.length) return null;
    const points = path.filter((point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) && Number.isFinite(Number(point.z)))
      .slice(0, Math.max(1, limit))
      .map((point) => ({ x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) }));
    if (!points.length) return null;
    const corridor = {
      owner: name, kind, priority, path: points,
      at: this.now(), expiresAt: this.now() + Math.max(500, Number(ttlMs) || this.ttlMs)
    };
    this.corridors.set(name, corridor);
    return corridor;
  }

  corridorConflicts(name, position) {
    this._sweep();
    if (!name || !position) return [];
    const conflicts = [];
    for (const [owner, corridor] of this.corridors) {
      if (owner === name) continue;
      const hit = corridor.path.some((point) => distance(position, point) <= this.radius);
      if (hit) conflicts.push({ owner, kind: 'corridor' });
    }
    return conflicts;
  }

  conflictsFor(name, position) {
    this._sweep();
    if (!position) return [];
    const out = [];
    for (const [owner, claim] of this.claims) {
      if (owner === name) continue;
      const d = distance(position, claim.position);
      if (Number.isFinite(d) && d <= this.radius) out.push({ owner, distance: Number(d.toFixed(2)), kind: claim.kind });
    }
    return out;
  }

  claim(name, position, { kind = 'task', priority = 'task', ttlMs = null, mayRelocate = true } = {}) {
    this._sweep();
    if (!name || !position) return { ok: true, position, conflicts: [] };
    const conflicts = this.conflictsFor(name, position);
    let chosen = { ...position };
    if (conflicts.length) this.conflicts++;
    // Operator and emergency moves never yield their stance, regardless of what
    // the caller passed. Task moves search two rings of offsets instead of a
    // fixed eight-point ring, so a crowded mining face resolves deterministically.
    const priorityName = String(priority).toLowerCase();
    const numericPriority = Number(priority);
    const protect = priorityName === 'operator' || priorityName === 'emergency'
      || (Number.isFinite(numericPriority) && numericPriority >= 3);
    if (conflicts.length && mayRelocate && !protect) {
      const offsets = [];
      for (let r = 1; r <= 3; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) === r) offsets.push([dx, dz]);
          }
        }
      }
      for (const [dx, dz] of offsets) {
        const candidate = { x: Math.floor(position.x) + dx, y: Math.floor(position.y), z: Math.floor(position.z) + dz };
        if (!this.conflictsFor(name, candidate).length && !this.corridorConflicts(name, candidate).length) {
          chosen = candidate;
          this.relocations++;
          break;
        }
      }
    }
    const claim = {
      owner: name, position: { ...chosen }, requested: { ...position }, kind,
      priority, conflicts, at: this.now(), expiresAt: this.now() + Math.max(500, Number(ttlMs) || this.ttlMs)
    };
    this.claims.set(name, claim);
    return { ok: true, position: chosen, relocated: chosen.x !== position.x || chosen.z !== position.z, conflicts, claim };
  }

  release(name) {
    const had = this.claims.delete(name);
    this.corridors.delete(name);
    return had;
  }

  snapshot() {
    this._sweep();
    return {
      radius: this.radius,
      ttlMs: this.ttlMs,
      conflicts: this.conflicts,
      relocations: this.relocations,
      active: [...this.claims.values()].map((claim) => ({
        ...claim, position: { ...claim.position }, requested: { ...claim.requested }
      })),
      corridors: [...this.corridors.values()].map((corridor) => ({
        ...corridor, path: corridor.path.map((point) => ({ ...point }))
      }))
    };
  }
}

module.exports = { FleetCongestion };
