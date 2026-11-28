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
    this.bestGoalDistance = null;
    this.goalProgressAt = this.startedAt;
    this.last = position ? { ...position } : null;
    if (position) this.sample(position, this.startedAt);
    return this;
  }

  /**
   * @param {object} position live feet position
   * @param {number} at sample time
   * @param {{target?:object, waypoint?:object}} context the current goal. Goal
   *   progress is not the same as displacement: a bot sliding along a wall may
   *   travel two blocks without getting closer, while a slow precise approach
   *   moves less than the displacement threshold but is making progress.
   */
  sample(position, at = this.now(), context = {}) {
    if (!position || ![position.x, position.y, position.z].every((v) => Number.isFinite(Number(v)))) {
      return { stuck: false, reason: 'no-position', samples: this.samples.length };
    }
    const pos = { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
    this.last = pos;
    // Keep time samples even when the bot has not moved; otherwise a totally
    // frozen bot would never accumulate the minSamples needed to be detected.
    this.samples.push({ at, pos });
    // Keep the ring bounded, then slide the observation window. The old
    // implementation measured displacement from the first of the last 32
    // samples, so a single 0.5-block step kept the bot "not stuck" for the
    // full 4.8s ring even after it stopped. Drop samples that are more than one
    // window old, preserving one older reference sample so `elapsed` still
    // covers `windowMs`.
    if (this.samples.length > 128) this.samples.shift();
    while (this.samples.length > 2 && at - this.samples[1].at >= this.windowMs) this.samples.shift();
    const first = this.samples[0];
    const elapsed = at - first.at;
    const displacement = Math.hypot(pos.x - first.pos.x, pos.y - first.pos.y, pos.z - first.pos.z);
    let windowTravel = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1].pos;
      const b = this.samples[i].pos;
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (Number.isFinite(d)) windowTravel += d;
    }
    const target = context.target || context.waypoint || null;
    let goalDistance = null;
    let goalProgress = null;
    if (target && [target.x, target.y, target.z].every((v) => Number.isFinite(Number(v)))) {
      goalDistance = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
      if (this.bestGoalDistance === null || goalDistance < this.bestGoalDistance - 0.05) {
        this.bestGoalDistance = goalDistance;
        this.goalProgressAt = at;
      }
      goalProgress = this.bestGoalDistance === null ? null : this.bestGoalDistance - goalDistance;
    }
    const goalStalled = goalDistance !== null && at - this.goalProgressAt >= this.windowMs;
    const oscillating = elapsed >= this.windowMs
      && displacement < Math.max(1, this.minProgress * 3)
      && windowTravel >= this.minProgress * 2;
    const stationary = elapsed >= this.windowMs && displacement < this.minProgress;
    // A detour that travels several blocks is making real progress even if it
    // is temporarily farther from the goal; only a short oscillation/no-travel
    // window counts as stuck. This avoids stopping a bot that walks around a
    // wall or a ravine.
    const stuck = at - this.startedAt >= this.graceMs
      && this.samples.length >= this.minSamples
      && ((goalDistance === null && stationary)
        || (goalDistance !== null && goalStalled
          && (stationary || (oscillating && windowTravel <= 6))));
    return {
      stuck,
      kind: stuck ? (oscillating ? 'oscillating' : 'stationary') : null,
      displacement: Number(displacement.toFixed(3)),
      travel: Number(windowTravel.toFixed(3)),
      elapsed,
      samples: this.samples.length,
      progress: Number((displacement / Math.max(1, elapsed)).toFixed(4)),
      goalDistance: goalDistance === null ? null : Number(goalDistance.toFixed(3)),
      goalProgress: goalProgress === null ? null : Number(goalProgress.toFixed(3)),
      goalStalled,
      position: pos
    };
  }

  snapshot() {
    return {
      windowMs: this.windowMs,
      graceMs: this.graceMs,
      minProgress: this.minProgress,
      samples: this.samples.length,
      windowStartAt: this.samples.length ? this.samples[0].at : null,
      last: this.last ? { ...this.last } : null,
      bestGoalDistance: this.bestGoalDistance
    };
  }
}

module.exports = { StuckDetector };
