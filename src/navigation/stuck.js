'use strict';

/**
 * Progress detector for a running path.
 *
 * The pathfinder can report neither progress nor a clear stuck state. Sample
 * the entity position; if the bot has moved less than `minProgress` blocks for
 * `windowMs` while a path is active, the manager stops that attempt and enters
 * recovery. A short grace period prevents flagging the pathfinder's initial
 * think/search time.
 */
class StuckDetector {
  constructor({
    now = Date.now,
    windowMs = 2500,
    graceMs = 750,
    minProgress = 0.35,
    minSamples = 3
  } = {}) {
    this.now = now;
    this.windowMs = Math.max(300, Number(windowMs) || 2500);
    this.graceMs = Math.max(0, Number(graceMs) || 750);
    this.minProgress = Math.max(0.01, Number(minProgress) || 0.35);
    this.minSamples = Math.max(2, Number(minSamples) || 3);
    this.reset();
  }

  reset(position = null) {
    this.startedAt = this.now();
    this.samples = [];
    this.best = null;
    this.last = position ? { ...position } : null;
    if (position) this.sample(position, this.startedAt);
    return this;
  }

  sample(position, at = this.now()) {
    if (!position || ![position.x, position.y, position.z].every((v) => Number.isFinite(Number(v)))) {
      return { stuck: false, reason: 'no-position', samples: this.samples.length };
    }
    const pos = { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
    this.last = pos;
    // Keep time samples even when the bot has not moved; otherwise a totally
    // frozen bot would never accumulate the minSamples needed to be detected.
    this.samples.push({ at, pos });
    if (this.samples.length > 32) this.samples.shift();
    const first = this.samples[0];
    const elapsed = at - first.at;
    const displacement = Math.hypot(pos.x - first.pos.x, pos.y - first.pos.y, pos.z - first.pos.z);
    const stuck = elapsed >= this.windowMs
      && at - this.startedAt >= this.graceMs
      && this.samples.length >= this.minSamples
      && displacement < this.minProgress;
    return {
      stuck,
      displacement: Number(displacement.toFixed(3)),
      elapsed,
      samples: this.samples.length,
      progress: Number((displacement / Math.max(1, elapsed)).toFixed(4)),
      position: pos
    };
  }

  snapshot() {
    return {
      windowMs: this.windowMs,
      graceMs: this.graceMs,
      minProgress: this.minProgress,
      samples: this.samples.length,
      last: this.last ? { ...this.last } : null
    };
  }
}

module.exports = { StuckDetector };
