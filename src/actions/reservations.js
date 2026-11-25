'use strict';

/**
 * Fleet-wide short leases on concrete world targets. This is deliberately not
 * a task-board claim: a bot may own a CHOP_WOOD task and another bot may be
 * idle, and both still must not walk to the same trunk. Leases are in-memory,
 * owner-checked and expire, so a dead bot cannot pin a resource forever.
 */
class ResourceReservations {
  constructor({ now = Date.now, defaultTtlMs = 120000 } = {}) {
    this.now = now;
    this.defaultTtlMs = Math.max(1000, Number(defaultTtlMs) || 120000);
    this.entries = new Map();
    this.stats = { claimed: 0, rejected: 0, expired: 0, released: 0 };
  }

  _prune(at = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) {
        this.entries.delete(key);
        this.stats.expired++;
      }
    }
  }

  /** Claim one key. A reentrant claim by the owner refreshes the lease. */
  claim(key, owner, { ttlMs = this.defaultTtlMs } = {}) {
    if (!key || !owner) return { ok: false, error: 'a reservation needs a key and an owner' };
    const at = this.now();
    this._prune(at);
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > at && existing.owner !== owner) {
      this.stats.rejected++;
      return { ok: false, held: true, key, owner: existing.owner, expiresAt: existing.expiresAt };
    }
    const ttl = Math.max(1000, Math.min(Number(ttlMs) || this.defaultTtlMs, 600000));
    const reentrant = Boolean(existing && existing.owner === owner);
    this.entries.set(key, { key, owner, claimedAt: at, expiresAt: at + ttl, ttlMs: ttl });
    if (!reentrant) this.stats.claimed++;
    return { ok: true, key, owner, reentrant, expiresAt: at + ttl };
  }

  holder(key, at = this.now()) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= at) {
      this.entries.delete(key);
      this.stats.expired++;
      return null;
    }
    return { ...entry };
  }

  release(key, owner = null) {
    const existing = this.entries.get(key);
    if (!existing) return { ok: true, released: false };
    if (owner && existing.owner !== owner) return { ok: false, released: false, owner: existing.owner };
    this.entries.delete(key);
    this.stats.released++;
    return { ok: true, released: true, owner: existing.owner };
  }

  releaseOwner(owner) {
    let released = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.owner === owner) {
        this.entries.delete(key);
        released++;
      }
    }
    this.stats.released += released;
    return { ok: true, released };
  }

  status() {
    this._prune();
    return {
      count: this.entries.size,
      byOwner: [...this.entries.values()].reduce((out, entry) => {
        out[entry.owner] = (out[entry.owner] || 0) + 1;
        return out;
      }, {}),
      stats: { ...this.stats }
    };
  }
}

function treeKey(base) {
  return `tree:${Math.floor(Number(base.x))},${Math.floor(Number(base.z))}`;
}

function oreKey(pos) {
  return `ore:${Math.floor(Number(pos.x))},${Math.floor(Number(pos.y))},${Math.floor(Number(pos.z))}`;
}

module.exports = { ResourceReservations, treeKey, oreKey };
