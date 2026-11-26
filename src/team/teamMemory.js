'use strict';

const { distance2d } = require('../util/vec');
const { BOT_NAMES } = require('../config');

const OBSERVATION_TYPES = Object.freeze([
  'ORE_DEPOSIT', 'TREE', 'CAVE', 'VILLAGE', 'STRUCTURE', 'THREAT', 'BED',
  'STORAGE', 'FARM', 'ANIMAL', 'MINING_TUNNEL', 'EXCAVATION_SITE', 'BUILD_SITE',
  'HOME', 'WATER', 'LAVA', 'DANGER', 'DISCOVERY', 'RESOURCE', 'SHELTER'
]);

/** Shared team memory.
 *
 * Every observation is attributable (reportedBy), timestamped, positioned,
 * confidence-scored, dimension-tagged and expirable. Consumers must verify
 * before acting: `fresh()` only filters by age, never by truth.
 */
class TeamMemory {
  constructor({ maxObservations = 4000, defaultTtlMs = 300000, now = () => Date.now() } = {}) {
    this.maxObservations = maxObservations;
    this.defaultTtlMs = defaultTtlMs;
    this.now = now;
    this.observations = [];
    this.byId = new Map();
    // Identity+status index. The old duplicate check scanned every observation
    // on every report, making a full 4000-entry memory O(n^2) per observe.
    this.byIdentity = new Map();
    this.facts = new Map();
    this.seq = 0;
    this.stats = { added: 0, updated: 0, expired: 0, rejected: 0 };
  }

  _validate(obs) {
    if (!obs || typeof obs !== 'object') return 'observation must be an object';
    if (!OBSERVATION_TYPES.includes(obs.type)) return `unknown observation type: ${obs.type}`;
    if (!obs.reportedBy || !this._isBotName(obs.reportedBy)) return 'reportedBy must be a team bot name';
    if (!obs.position || !Number.isFinite(obs.position.x) || !Number.isFinite(obs.position.y) || !Number.isFinite(obs.position.z)) {
      return 'position must be finite {x,y,z}';
    }
    if (obs.confidence !== undefined && (typeof obs.confidence !== 'number' || obs.confidence < 0 || obs.confidence > 1)) {
      return 'confidence must be within 0..1';
    }
    return null;
  }

  _isBotName(name) {
    return typeof name === 'string' && BOT_NAMES.includes(name);
  }

  _identity(obs) {
    const resource = obs.resource || '';
    const pos = obs.position;
    // Round to the block so floating point noise cannot create duplicates.
    return `${obs.type}|${resource}|${Math.round(pos.x)}|${Math.round(pos.y)}|${Math.round(pos.z)}|${obs.dimension || 'overworld'}`;
  }

  _identityKey(obs) {
    return `${obs._identity || this._identity(obs)}|${obs.status || 'AVAILABLE'}`;
  }

  _index(obs) {
    if (!obs) return;
    const key = this._identityKey(obs);
    obs._idKey = key;
    this.byIdentity.set(key, obs);
  }

  _unindex(obs) {
    if (!obs) return;
    const key = obs._idKey || this._identityKey(obs);
    if (this.byIdentity.get(key) === obs) this.byIdentity.delete(key);
    delete obs._idKey;
  }

  _setStatus(obs, status) {
    if (!obs) return false;
    this._unindex(obs);
    obs.status = status;
    this._index(obs);
    return true;
  }

  observe(input) {
    const error = this._validate(input);
    if (error) { this.stats.rejected++; return { ok: false, error }; }
    const now = this.now();
    const obs = {
      id: input.id || `obs-${++this.seq}`,
      type: input.type,
      resource: input.resource || null,
      position: { x: input.position.x, y: input.position.y, z: input.position.z },
      dimension: input.dimension || 'overworld',
      reportedBy: input.reportedBy,
      timestamp: input.timestamp || now,
      confidence: input.confidence === undefined ? 0.6 : input.confidence,
      status: input.status || 'AVAILABLE',
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : now + (input.ttlMs || this.defaultTtlMs),
      data: input.data || {},
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 12) : []
    };
    const ident = this._identity(obs);
    obs._identity = ident;
    const existing = this.byIdentity.get(`${ident}|${obs.status}`);
    if (existing) {
      // More recent, more confident reports win; keep the reporter of record.
      if (obs.confidence >= existing.confidence) {
        this._unindex(existing);
        Object.assign(existing, obs, { id: existing.id, _identity: ident });
        this.byId.set(existing.id, existing);
        this._index(existing);
        this.stats.updated++;
        return { ok: true, observation: existing, updated: true };
      }
      this.stats.rejected++;
      return { ok: false, error: 'lower-confidence duplicate', observation: existing };
    }
    this.observations.push(obs);
    this.byId.set(obs.id, obs);
    this._index(obs);
    this.stats.added++;
    this._enforceBounds();
    return { ok: true, observation: obs, updated: false };
  }

  _enforceBounds() {
    if (this.observations.length <= this.maxObservations) return;
    // Drop expired first, then the oldest low-confidence entries. Trim the whole
    // excess in one ranked pass; scanning the array once per removed entry made
    // hitting the cap quadratic.
    this.expire();
    const excess = this.observations.length - this.maxObservations;
    if (excess <= 0) return;
    const ranked = this.observations
      .map((obs, index) => ({ obs, index }))
      .sort((a, b) => (a.obs.confidence - b.obs.confidence)
        || (a.obs.timestamp - b.obs.timestamp)
        || (a.index - b.index))
      .slice(0, excess)
      .map((entry) => entry.obs);
    const drop = new Set(ranked);
    this.observations = this.observations.filter((obs) => !drop.has(obs));
    for (const removed of drop) {
      this.byId.delete(removed.id);
      this._unindex(removed);
    }
  }

  expire(at = this.now()) {
    const before = this.observations.length;
    this.observations = this.observations.filter((o) => {
      const keep = o.expiresAt === null || o.expiresAt > at || o.status !== 'AVAILABLE';
      if (!keep) { this.byId.delete(o.id); this._unindex(o); }
      return keep;
    });
    const removed = before - this.observations.length;
    this.stats.expired += removed;
    return removed;
  }

  get(id) { return this.byId.get(id) || null; }

  /**
   * @param {object} filter
   * @param {string|string[]} [filter.type]
   * @param {string} [filter.resource]
   * @param {string|string[]} [filter.status]
   * @param {{x:number,z:number}} [filter.near]
   * @param {number} [filter.radius]
   * @param {number} [filter.minConfidence]
   * @param {number} [filter.maxAgeMs]
   * @param {boolean} [filter.includeExpired]
   */
  query(filter = {}) {
    const now = this.now();
    const types = filter.type ? (Array.isArray(filter.type) ? filter.type : [filter.type]) : null;
    const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
    return this.observations.filter((o) => {
      if (types && !types.includes(o.type)) return false;
      if (filter.resource && o.resource !== filter.resource) return false;
      if (statuses && !statuses.includes(o.status)) return false;
      if (!filter.includeExpired && o.expiresAt !== null && o.expiresAt <= now && o.status === 'AVAILABLE') return false;
      if (filter.minConfidence !== undefined && o.confidence < filter.minConfidence) return false;
      if (filter.maxAgeMs !== undefined && now - o.timestamp > filter.maxAgeMs) return false;
      if (filter.near && filter.radius !== undefined && distance2d(o.position, filter.near) > filter.radius) return false;
      return true;
    });
  }

  nearest(filter, position) {
    const candidates = this.query(filter);
    let best = null;
    for (const obs of candidates) {
      const d = distance2d(obs.position, position);
      if (!best || d < best.d) best = { obs, d };
    }
    return best;
  }

  setStatus(id, status) {
    const obs = this.byId.get(id);
    if (!obs) return false;
    return this._setStatus(obs, status);
  }

  /**
   * Verify an observation against the live world before travelling to it.
   * `checker` receives the observation and must return truthy when the fact is
   * still valid (e.g. the ore block is still there).
   */
  async verify(id, checker) {
    const obs = this.byId.get(id);
    if (!obs) return { ok: false, error: 'not found' };
    const now = this.now();
    if (obs.expiresAt !== null && obs.expiresAt <= now) {
      this._setStatus(obs, 'EXPIRED');
      return { ok: false, error: 'expired', observation: obs };
    }
    if (obs.status !== 'AVAILABLE') return { ok: false, error: `status ${obs.status}`, observation: obs };
    let valid;
    try { valid = await checker(obs); } catch (err) {
      return { ok: false, error: `verification failed: ${err.message}`, observation: obs };
    }
    if (!valid) {
      this._setStatus(obs, 'STALE');
      return { ok: false, error: 'stale', observation: obs };
    }
    obs.confidence = Math.min(1, obs.confidence + 0.05);
    return { ok: true, observation: obs };
  }

  // --- team-level facts (home, active objectives, selected schematic, ...) ---
  setFact(key, value, meta = {}) {
    this.facts.set(key, { value, updatedAt: this.now(), ...meta });
    return this.facts.get(key);
  }

  getFact(key, fallback = null) {
    const entry = this.facts.get(key);
    return entry ? entry.value : fallback;
  }

  factEntry(key) { return this.facts.get(key) || null; }

  setHome(home) {
    return this.setFact('home', {
      position: { x: home.position.x, y: home.position.y, z: home.position.z },
      dimension: home.dimension || 'overworld',
      verified: false
    }, { reportedBy: home.reportedBy || 'system' });
  }

  getHome() { return this.getFact('home'); }

  beds() { return this.query({ type: 'BED', status: ['AVAILABLE', 'RESERVED'] }); }

  summary() {
    const counts = {};
    for (const o of this.query({})) counts[o.type] = (counts[o.type] || 0) + 1;
    return { total: this.observations.length, byType: counts, stats: { ...this.stats }, facts: [...this.facts.keys()] };
  }

  cleanup() {
    this.expire();
    const now = this.now();
    for (const [key, entry] of this.facts) {
      if (entry.expiresAt && entry.expiresAt <= now) this.facts.delete(key);
    }
  }
}

module.exports = { TeamMemory, OBSERVATION_TYPES };
