'use strict';

/**
 * Minecraft 1.21.2+ / 26.x client tick loop.
 *
 * The vanilla client writes one `tick_end` at the end of every client tick,
 * after that tick's movement packet. Servers use it to reset the one-position-
 * per-tick counter and Paper fires its tick-end event from it. Mineflayer
 * 4.39.0 does not have the upstream fix (PrismarineJS/mineflayer#4137), so
 * without this loop a bot is detectable and, on strict servers, kicked.
 *
 * The previous workaround wrote `tick_end` immediately after a movement
 * packet. That fixed the second-move kick but produced no tick end at all on
 * the many ticks where the bot is idle. This scheduler emits exactly one tick
 * end per tick and keeps at most one position-bearing packet in a tick by
 * deferring an extra position write to the next tick.
 */

const MOVEMENT_PACKETS = new Set(['position', 'position_look', 'look', 'flying', 'tick_end']);
const POSITION_PACKETS = new Set(['position', 'position_look']);
const DEFAULT_TICK_RATE = 20;

function asBool(value) {
  return value === true;
}

class ClientTickScheduler {
  constructor({
    write,
    enabled = true,
    tickRate = DEFAULT_TICK_RATE,
    maxCatchUpTicks = 2,
    name = '',
    logger = null,
    now = Date.now,
    timers = null,
    stallMs = 0,
    onStall = null
  } = {}) {
    if (typeof write !== 'function') throw new TypeError('ClientTickScheduler needs a write function');
    this.write = write;
    this.enabled = Boolean(enabled);
    this.name = name;
    this.logger = logger;
    this.now = now;
    this.timers = timers || { setInterval, clearInterval };
    this.maxCatchUpTicks = Math.max(1, Math.min(10, Number(maxCatchUpTicks) || 2));
    this.stallMs = Math.max(0, Number(stallMs) || 0);
    this.onStall = typeof onStall === 'function' ? onStall : null;
    this.running = false;
    this.frozen = false;
    this.ticks = 0;
    this.tickEnds = 0;
    this.deferredMovements = 0;
    this.deferredTicks = 0;
    this.writeErrors = 0;
    this.lastTickAt = 0;
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.stopReason = null;
    this.tickRate = this._normaliseRate(tickRate);
    this._timer = null;
    this._positionWrittenThisTick = false;
    this._pendingPosition = null;
    this._pendingPositionName = null;
    this._tickEndOpen = false;
    this.stalls = 0;
    this.lastStallMs = 0;
  }

  get tickMs() { return Math.round(1000 / this.tickRate); }

  start(at = null) {
    if (!this.enabled || this.running) return false;
    this.running = true;
    this.frozen = false;
    this.startedAt = at === null ? this.now() : at;
    this.lastTickAt = this.startedAt;
    this._schedule();
    return true;
  }

  stop(reason = 'stopped') {
    if (!this.running) return false;
    this.running = false;
    this.frozen = false;
    this.stopReason = String(reason || 'stopped');
    this.stoppedAt = this.now();
    if (this._timer) {
      try { this.timers.clearInterval(this._timer); } catch (_) { /* optional */ }
      this._timer = null;
    }
    this._pendingPosition = null;
    this._pendingPositionName = null;
    return true;
  }

  /**
   * Called by the adapter's write wrapper for a movement packet.
   * Returns true when the packet was written now, false when it was deferred.
   */
  writeMovement(name, packet) {
    if (!this.enabled) {
      this._safeWrite(name, packet);
      return true;
    }
    if (!this.running) {
      // Before the play state starts (or after it ends) there is no tick to
      // close; pass the write through and let the protocol state reject it.
      this._safeWrite(name, packet);
      return true;
    }
    if (this.frozen) {
      this.deferredMovements += 1;
      return false;
    }
    if (!POSITION_PACKETS.has(name)) {
      this._safeWrite(name, packet);
      return true;
    }
    if (!this._positionWrittenThisTick) {
      this._safeWrite(name, packet);
      this._positionWrittenThisTick = true;
      return true;
    }
    this._pendingPosition = packet;
    this._pendingPositionName = name;
    this.deferredMovements += 1;
    return false;
  }

  /** Run one client tick. This is the only place that emits `tick_end`. */
  tick(at = null) {
    if (!this.running || this.frozen) return false;
    const when = at === null ? this.now() : at;
    return this._runTick(when);
  }

  /** Server sent set_ticking_state: adopt its rate and freeze flag. */
  setTickingState({ tickRate, isFrozen } = {}, at = null) {
    if (tickRate !== undefined && tickRate !== null) {
      const next = this._normaliseRate(tickRate);
      if (next !== this.tickRate) {
        this.tickRate = next;
        if (this.running && !this.frozen) this._reschedule();
      }
    }
    const nextFrozen = asBool(isFrozen);
    if (nextFrozen === this.frozen) return this.snapshot(at);
    this.frozen = nextFrozen;
    if (this.running) {
      if (this.frozen) {
        if (this._timer) {
          try { this.timers.clearInterval(this._timer); } catch (_) { /* optional */ }
          this._timer = null;
        }
      } else {
        this._schedule();
      }
    }
    return this.snapshot(at);
  }

  /** Server sent step_tick while frozen: advance exactly the requested ticks. */
  stepTicks(steps, at = null) {
    const requested = Math.max(0, Math.min(200, Number(steps) || 0));
    if (!this.running || !this.frozen || requested === 0) return 0;
    let done = 0;
    for (let i = 0; i < requested; i++) {
      if (!this._runTick(at === null ? this.now() : at)) break;
      done += 1;
    }
    return done;
  }

  snapshot(at = null) {
    const when = at === null ? this.now() : at;
    return {
      enabled: this.enabled,
      running: this.running,
      frozen: this.frozen,
      tickRate: this.tickRate,
      tickMs: this.tickMs,
      ticks: this.ticks,
      tickEnds: this.tickEnds,
      deferredMovements: this.deferredMovements,
      deferredTicks: this.deferredTicks,
      writeErrors: this.writeErrors,
      stalls: this.stalls,
      lastStallMs: this.lastStallMs,
      lastTickAt: this.lastTickAt || null,
      ageMs: this.lastTickAt ? Math.max(0, Math.round(when - this.lastTickAt)) : null,
      startedAt: this.startedAt || null,
      stoppedAt: this.stoppedAt || null,
      stopReason: this.stopReason
    };
  }

  _runTick(when) {
    // A tick arriving hundreds of milliseconds late means the process was
    // frozen (a synchronous chunk/pathfinding burst or a host suspend). Do not
    // emit movement before the caller has had a chance to resynchronise the
    // entity with the server; the first post-freeze packet is otherwise an
    // impossible jump and Paper answers with invalid_player_movement.
    if (this.stallMs > 0 && this.lastTickAt > 0) {
      const late = when - this.lastTickAt;
      if (late >= this.stallMs) {
        this.stalls += 1;
        this.lastStallMs = late;
        this._pendingPosition = null;
        this._pendingPositionName = null;
        if (this.onStall) {
          try { this.onStall(late, when); } catch (_) { /* recovery must not stop ticks */ }
        }
      }
    }
    // A deferred position belongs to this tick. It is written before the
    // tick's tick_end, exactly as vanilla orders movement then tick end.
    if (this._pendingPosition) {
      const name = this._pendingPositionName || 'position';
      const packet = this._pendingPosition;
      this._pendingPosition = null;
      this._pendingPositionName = null;
      this._safeWrite(name, packet);
      this.deferredTicks += 1;
    }
    this._positionWrittenThisTick = false;
    this._safeWrite('tick_end', {});
    this.ticks += 1;
    this.tickEnds += 1;
    this.lastTickAt = when;
    return true;
  }

  _schedule() {
    if (!this.running || this.frozen || this._timer) return;
    this._timer = this.timers.setInterval(() => {
      try { this.tick(); } catch (_) { /* one bad tick must not kill the loop */ }
    }, this.tickMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  _reschedule() {
    if (this._timer) {
      try { this.timers.clearInterval(this._timer); } catch (_) { /* optional */ }
      this._timer = null;
    }
    this._schedule();
  }

  _safeWrite(name, packet) {
    try {
      this.write(name, packet);
      return true;
    } catch (_) {
      this.writeErrors += 1;
      return false;
    }
  }

  _normaliseRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_TICK_RATE;
    return Math.max(1, Math.min(100, value));
  }
}

module.exports = {
  ClientTickScheduler,
  MOVEMENT_PACKETS,
  POSITION_PACKETS,
  DEFAULT_TICK_RATE
};
