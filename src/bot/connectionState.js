'use strict';

/**
 * The one authoritative lifecycle record for a live bot connection.
 *
 * Before V6.1 the adapter exposed three independent booleans (connected,
 * spawned, authenticated) that were written from a dozen event handlers. A
 * late event from a replaced socket could therefore paint a new session with
 * the old session's state. This machine gives every attempt a generation id
 * and validates every transition; the legacy booleans are projected from it
 * and are never the source of truth for a live session.
 */

const STATES = Object.freeze({
  IDLE: 'idle',
  RESOLVING: 'resolving',
  TCP_CONNECTING: 'tcp_connecting',
  HANDSHAKING: 'handshaking',
  CONFIGURATION: 'configuration',
  AWAITING_SPAWN: 'awaiting_spawn',
  AUTHENTICATING: 'authenticating',
  READY: 'ready',
  RESPAWNING: 'respawning',
  STOPPING: 'stopping',
  CLOSED: 'closed',
  FAILED: 'failed'
});

const STATE_META = Object.freeze({
  idle: { label: 'Idle', open: false, spawned: false, authenticated: false },
  resolving: { label: 'Resolving host', open: false, spawned: false, authenticated: false },
  tcp_connecting: { label: 'TCP connect', open: false, spawned: false, authenticated: false },
  handshaking: { label: 'Protocol login', open: true, spawned: false, authenticated: false },
  configuration: { label: 'Configuration', open: true, spawned: false, authenticated: false },
  awaiting_spawn: { label: 'Awaiting spawn', open: true, spawned: false, authenticated: true },
  authenticating: { label: 'Authenticating', open: true, spawned: true, authenticated: false },
  ready: { label: 'Online', open: true, spawned: true, authenticated: true },
  respawning: { label: 'Respawning', open: true, spawned: true, authenticated: true },
  stopping: { label: 'Disconnecting', open: false, spawned: false, authenticated: false },
  closed: { label: 'Offline', open: false, spawned: false, authenticated: false },
  failed: { label: 'Failed', open: false, spawned: false, authenticated: false }
});

const TERMINAL = new Set([STATES.CLOSED, STATES.FAILED]);
const CLOSING = new Set([STATES.STOPPING, STATES.CLOSED, STATES.FAILED]);

const ALLOWED = Object.freeze({
  idle: new Set([STATES.RESOLVING, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  resolving: new Set([STATES.TCP_CONNECTING, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  tcp_connecting: new Set([STATES.HANDSHAKING, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  handshaking: new Set([STATES.CONFIGURATION, STATES.AWAITING_SPAWN, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  configuration: new Set([STATES.AWAITING_SPAWN, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  awaiting_spawn: new Set([STATES.AUTHENTICATING, STATES.READY, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  authenticating: new Set([STATES.READY, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  ready: new Set([STATES.RESPAWNING, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  respawning: new Set([STATES.AUTHENTICATING, STATES.READY, STATES.STOPPING, STATES.CLOSED, STATES.FAILED]),
  stopping: new Set([STATES.CLOSED, STATES.FAILED]),
  closed: new Set([STATES.RESOLVING]),
  failed: new Set([STATES.RESOLVING])
});

const STAGE_META = Object.freeze({
  none: 'No attempt',
  dns: 'DNS lookup',
  tcp: 'TCP connect',
  handshake: 'Handshake and login',
  configuration: 'Configuration',
  spawn: 'Spawn',
  auth: 'Password authentication',
  ready: 'Ready'
});

function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isFinite(value) ? value : Date.now();
}

class ConnectionStateMachine {
  constructor({ now = Date.now, maxTimeline = 80, onChange = null } = {}) {
    this.now = now;
    this.maxTimeline = Math.max(8, Number(maxTimeline) || 80);
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.generation = 0;
    this.state = STATES.IDLE;
    this.since = nowMs(now);
    this.startedAt = 0;
    this.closedAt = 0;
    this.stage = 'none';
    this.stageStartedAt = 0;
    this.stageTimeouts = {};
    this.detail = 'No connection attempt has been made';
    this.failure = null;
    this.lastError = null;
    this.timeline = [];
    this.invalidTransitions = 0;
    this.transitions = 0;
    this.meta = {};
  }

  get terminal() { return TERMINAL.has(this.state); }

  get open() { return Boolean((STATE_META[this.state] || STATE_META.idle).open); }

  get spawned() { return Boolean((STATE_META[this.state] || STATE_META.idle).spawned); }

  get authenticated() { return Boolean((STATE_META[this.state] || STATE_META.idle).authenticated); }

  get label() { return (STATE_META[this.state] || STATE_META.idle).label; }

  /** Start a brand-new session with a monotonically increasing generation. */
  begin(meta = {}) {
    const at = nowMs(this.now);
    this.generation += 1;
    this.startedAt = at;
    this.closedAt = 0;
    this.state = STATES.RESOLVING;
    this.since = at;
    this.stage = 'dns';
    this.stageStartedAt = at;
    this.stageTimeouts = {};
    this.detail = 'Resolving the server host';
    this.failure = null;
    this.lastError = null;
    this.meta = { ...meta };
    this.timeline = [];
    this.transitions = 1;
    this._record({ at, kind: 'begin', to: STATES.RESOLVING, stage: this.stage, detail: this.detail });
    this._emit();
    return this.snapshot(at);
  }

  /**
   * Move to a new lifecycle state. A transition outside the table is counted
   * and recorded but never applied, so an out-of-order packet cannot corrupt
   * a newer session. `force` exists only for teardown.
   */
  transition(next, { detail = '', stage = null, at = null, timeoutMs = null, force = false } = {}) {
    const when = at === null ? nowMs(this.now) : at;
    if (!STATE_META[next]) {
      this.invalidTransitions += 1;
      this._record({ at: when, kind: 'rejected', to: next, from: this.state, detail: detail || 'unknown state' });
      this._emit();
      return false;
    }
    if (next === this.state) {
      if (detail) this.detail = detail;
      if (stage) this.setStage(stage, { detail, at: when, timeoutMs, quiet: true });
      return true;
    }
    const allowed = ALLOWED[this.state] || new Set();
    if (!force && !allowed.has(next)) {
      this.invalidTransitions += 1;
      this._record({ at: when, kind: 'rejected', to: next, from: this.state, detail: detail || `illegal ${this.state} -> ${next}` });
      this._emit();
      return false;
    }
    const from = this.state;
    this.state = next;
    this.since = when;
    this.detail = detail || (STATE_META[next] || {}).label || next;
    if (stage) this.setStage(stage, { detail: this.detail, at: when, timeoutMs, quiet: true });
    if (TERMINAL.has(next)) this.closedAt = when;
    this.transitions += 1;
    this._record({ at: when, kind: 'state', from, to: next, stage: this.stage, detail: this.detail });
    this._emit();
    return true;
  }

  setStage(stage, { detail = '', at = null, timeoutMs = null } = {}) {
    const when = at === null ? nowMs(this.now) : at;
    const next = STAGE_META[stage] ? stage : this.stage;
    if (next !== this.stage) {
      this.stage = next;
      this.stageStartedAt = when;
    }
    if (timeoutMs !== null && Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) {
      this.stageTimeouts[next] = Number(timeoutMs);
    }
    if (detail) this.detail = detail;
    this._record({ at: when, kind: 'stage', stage: next, detail: detail || STAGE_META[next], timeoutMs: this.stageTimeouts[next] || null });
    this._emit();
    return this.snapshot(when);
  }

  /** Record a real event (packet, keepalive, socket) without changing state. */
  event(name, detail = '', at = null) {
    this._record({ at: at === null ? nowMs(this.now) : at, kind: 'event', event: name, stage: this.stage, detail });
    return this;
  }

  fail(code, error, { at = null, stage = null, details = {} } = {}) {
    const when = at === null ? nowMs(this.now) : at;
    this.failure = {
      code: String(code || 'CONNECTION_FAILED'),
      error: String(error || 'connection failed'),
      stage: stage || this.stage,
      at: when,
      ...details
    };
    this.lastError = this.failure.error;
    // Failure is always legal: a socket can die in any non-terminal state.
    this.transition(STATES.FAILED, {
      detail: `${this.failure.code}: ${this.failure.error}`,
      at: when,
      force: !TERMINAL.has(this.state)
    });
    return this.snapshot(when);
  }

  close(reason = 'closed', { at = null } = {}) {
    const when = at === null ? nowMs(this.now) : at;
    if (TERMINAL.has(this.state)) {
      if (reason && !this.failure) this.detail = reason;
      return this.snapshot(when);
    }
    if (this.state !== STATES.STOPPING) {
      this.transition(STATES.STOPPING, { detail: reason || 'disconnecting', at: when });
    }
    this.transition(STATES.CLOSED, { detail: reason || 'offline', at: when });
    this.closedAt = when;
    return this.snapshot(when);
  }

  /** True when a callback captured for `generation` still owns this machine. */
  isCurrent(generation) {
    return Number(generation) === this.generation && !TERMINAL.has(this.state);
  }

  stageElapsedMs(at = null) {
    const when = at === null ? nowMs(this.now) : at;
    if (!this.stageStartedAt) return null;
    return Math.max(0, when - this.stageStartedAt);
  }

  elapsedMs(at = null) {
    if (!this.startedAt) return 0;
    const when = at === null ? nowMs(this.now) : at;
    return Math.max(0, when - this.startedAt);
  }

  snapshot(at = null) {
    const when = at === null ? nowMs(this.now) : at;
    const meta = STATE_META[this.state] || STATE_META.idle;
    return {
      generation: this.generation,
      state: this.state,
      label: meta.label,
      detail: this.detail,
      since: this.since,
      startedAt: this.startedAt || null,
      closedAt: this.closedAt || null,
      elapsedMs: this.elapsedMs(when),
      stage: this.stage,
      stageLabel: STAGE_META[this.stage] || this.stage,
      stageStartedAt: this.stageStartedAt || null,
      stageElapsedMs: this.stageElapsedMs(when),
      stageTimeoutMs: this.stageTimeouts[this.stage] || null,
      stageTimeouts: { ...this.stageTimeouts },
      open: Boolean(meta.open),
      spawned: Boolean(meta.spawned),
      authenticated: Boolean(meta.authenticated),
      terminal: TERMINAL.has(this.state),
      failure: this.failure ? { ...this.failure } : null,
      lastError: this.lastError,
      transitions: this.transitions,
      invalidTransitions: this.invalidTransitions,
      meta: { ...this.meta },
      timeline: this.timeline.slice(-24)
    };
  }

  _record(entry) {
    this.timeline.push({
      at: entry.at,
      kind: entry.kind,
      from: entry.from || null,
      to: entry.to || null,
      stage: entry.stage || null,
      event: entry.event || null,
      detail: entry.detail ? String(entry.detail).slice(0, 240) : null,
      timeoutMs: entry.timeoutMs || null,
      generation: this.generation
    });
    if (this.timeline.length > this.maxTimeline) this.timeline.shift();
  }

  _emit() {
    if (!this.onChange) return;
    try { this.onChange(this.snapshot()); } catch (_) { /* never break a connection over reporting */ }
  }
}

module.exports = { ConnectionStateMachine, STATES, STATE_META, STAGE_META, TERMINAL, CLOSING };
