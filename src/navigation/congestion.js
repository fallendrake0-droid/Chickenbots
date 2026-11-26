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
    this.conflicts = 0;
    this.relocations = 0;
  }

  _sweep() {
    const now = this.now();
    for (const [name, claim] of this.claims) if (now >= claim.expiresAt) this.claims.delete(name);
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
    if (conflicts.length && mayRelocate) {
      const offsets = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, 2], [2, -2], [-2, -2]];
      for (const [dx, dz] of offsets) {
        const candidate = { x: Math.floor(position.x) + dx, y: Math.floor(position.y), z: Math.floor(position.z) + dz };
        if (!this.conflictsFor(name, candidate).length) {
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

  release(name) { return this.claims.delete(name); }

  snapshot() {
    this._sweep();
    return {
      radius: this.radius,
      ttlMs: this.ttlMs,
      conflicts: this.conflicts,
      relocations: this.relocations,
      active: [...this.claims.values()].map((claim) => ({
        ...claim, position: { ...claim.position }, requested: { ...claim.requested }
      }))
    };
  }
}

module.exports = { FleetCongestion };
