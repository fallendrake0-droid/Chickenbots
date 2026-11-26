'use strict';

/**
 * Bounded navigation telemetry. Counters are cheap enough to update on every
 * move; the event ring is deliberately small so a long-running bot cannot grow
 * memory without bound. All measurements are local observations, not server
 * confirmation.
 */
const MAX_EVENTS = 64;

function emptyCounts() {
  return {
    attempts: 0, success: 0, failed: 0, timeout: 0, cancelled: 0, superseded: 0,
    invalidDestination: 0, unloadedDestination: 0, noStandable: 0, noPath: 0,
    stuck: 0, recovered: 0, replanned: 0, arrivalUnverified: 0,
    waterSteps: 0, drops: 0, climbs: 0, longDistance: 0
  };
}

class NavigationTelemetry {
  constructor({ now = Date.now, bot = null, maxEvents = MAX_EVENTS } = {}) {
    this.now = now;
    this.bot = bot;
    this.maxEvents = Math.max(8, Math.min(256, Number(maxEvents) || MAX_EVENTS));
    this.counts = emptyCounts();
    this.events = [];
    this.durations = [];
    this.last = null;
    this.lastError = null;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastStuckAt = null;
    this.distance = 0;
    this.active = null;
  }

  begin(request = {}) {
    const entry = {
      id: `${this.bot || 'bot'}-${this.now()}-${this.counts.attempts + 1}`,
      startedAt: this.now(),
      from: request.from ? { ...request.from } : null,
      target: request.target ? { ...request.target } : null,
      priority: request.priority || null,
      owner: request.owner || null,
      range: request.range === undefined ? null : request.range
    };
    this.counts.attempts++;
    this.active = entry;
    return entry.id;
  }

  recordCount(key, amount = 1) {
    if (!(key in this.counts)) this.counts[key] = 0;
    this.counts[key] += Number(amount) || 0;
  }

  finish(id, result = {}) {
    const startedAt = this.active && this.active.id === id ? this.active.startedAt : this.now();
    const durationMs = Math.max(0, this.now() - startedAt);
    this.durations.push(durationMs);
    if (this.durations.length > 128) this.durations.shift();
    const ok = result.ok === true;
    if (ok) {
      this.counts.success++;
      this.lastSuccessAt = this.now();
    } else {
      this.counts.failed++;
      this.lastFailureAt = this.now();
      if (result.timedOut) this.counts.timeout++;
      if (result.cancelled) this.counts.cancelled++;
      if (result.superseded) this.counts.superseded++;
      if (result.stuck) this.counts.stuck++;
      if (result.code === 'INVALID_DESTINATION') this.counts.invalidDestination++;
      if (result.code === 'DESTINATION_UNLOADED') this.counts.unloadedDestination++;
      if (result.code === 'NO_STANDABLE_DESTINATION') this.counts.noStandable++;
      if (result.noPath) this.counts.noPath++;
      this.lastError = result.error || result.code || 'movement failed';
    }
    if (result.position) {
      const target = this.active && this.active.target;
      if (target) {
        const dx = Number(result.position.x) - Number(target.x);
        const dz = Number(result.position.z) - Number(target.z);
        const dy = Number(result.position.y) - Number(target.y);
        if ([dx, dy, dz].every(Number.isFinite)) this.distance += Math.hypot(dx, dy, dz);
      }
    }
    const event = {
      at: this.now(),
      kind: ok ? 'arrived' : result.cancelled ? 'cancelled' : result.stuck ? 'stuck' : result.timedOut ? 'timeout' : 'failed',
      id,
      durationMs,
      owner: result.owner || null,
      target: result.target || (this.active && this.active.target) || null,
      position: result.position ? { ...result.position } : null,
      code: result.code || null,
      error: result.error || null,
      attempts: result.attempts || 1,
      recovered: Boolean(result.recovered),
      arrived: result.arrived === true
    };
    this.last = event;
    if (this.active && this.active.id === id) this.active = null;
    this._event(event);
    return event;
  }

  event(kind, data = {}) {
    if (kind === 'stuck') this.lastStuckAt = this.now();
    if (kind === 'recovered') this.counts.recovered++;
    if (kind === 'replanned') this.counts.replanned++;
    const event = { at: this.now(), kind, ...data };
    this._event(event);
    return event;
  }

  _event(event) {
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
  }

  summary() {
    const durations = this.durations.slice().sort((a, b) => a - b);
    const percentile = (p) => durations.length ? durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))] : null;
    return {
      ...this.counts,
      successRate: this.counts.attempts ? Number((this.counts.success / this.counts.attempts * 100).toFixed(1)) : null,
      distance: Number(this.distance.toFixed(1)),
      last: this.last ? { ...this.last } : null,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastStuckAt: this.lastStuckAt,
      active: this.active ? { ...this.active } : null,
      durationMs: {
        count: durations.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: durations.length ? durations[durations.length - 1] : null
      },
      events: this.events.slice(-16)
    };
  }
}

module.exports = { NavigationTelemetry, MAX_EVENTS };
