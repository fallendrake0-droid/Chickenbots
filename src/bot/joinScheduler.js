'use strict';

/**
 * Fleet-wide join backoff with one strike record per outage episode.
 *
 * Four bots each timing out during the same server-side join block are four
 * symptoms of one episode, not four independent offences. Counting each as a
 * strike escalated a 90s pause to 180s, 360s and then 600s while the fleet was
 * already unable to join, which made recovery slower for no benefit.
 *
 * Rules:
 *  - the first failure opens an episode and records one strike;
 *  - further failures in the same episode (until a bot is genuinely ready)
 *    keep the same strike level and re-arm a bounded pause;
 *  - a ready session closes the episode. The strike level is retained for the
 *    next episode so repeated separate outages still back off;
 *  - after `quietResetMs` with no failure the strike level returns to zero;
 *  - every pause is capped and jittered so five bots never retry in lockstep.
 */
class JoinScheduler {
  constructor({
    now = Date.now,
    random = Math.random,
    baseDelayMs = 90000,
    maxDelayMs = 600000,
    jitterMs = 4000,
    maxStrikes = 10,
    quietResetMs = 10 * 60 * 1000
  } = {}) {
    this.now = now;
    this.random = random;
    this.baseDelayMs = Math.max(1000, Number(baseDelayMs) || 90000);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || 600000);
    this.jitterMs = Math.max(0, Number(jitterMs) || 0);
    this.maxStrikes = Math.max(1, Number(maxStrikes) || 10);
    this.quietResetMs = Math.max(0, Number(quietResetMs) || 0);
    this.strikes = 0;
    this.episodeOpen = false;
    this.episodeStartedAt = 0;
    this.lastStrikeAt = 0;
    this.lastFailureAt = 0;
    this.lastSuccessAt = 0;
    this.cooldownUntil = 0;
    this.lastWaitMs = 0;
    this.failures = 0;
    this.countedFailures = 0;
    this.suppressedFailures = 0;
    this.episodes = 0;
    this.lastKind = null;
    this.lastError = null;
  }

  /**
   * Record a join failure. Returns the current schedule. `counted` is false
   * when the failure belongs to an already-open episode.
   */
  strike({ kind = 'join stalled', error = '', at = null } = {}) {
    const when = at === null ? this._now() : at;
    this.failures += 1;
    this.lastFailureAt = when;
    this.lastKind = String(kind || 'join stalled');
    this.lastError = String(error || '');

    // A long quiet period starts a fresh strike ladder.
    if (this.lastStrikeAt && when - this.lastStrikeAt > this.quietResetMs) {
      this.strikes = 0;
      this.episodeOpen = false;
    }

    if (this.episodeOpen) {
      this.suppressedFailures += 1;
      // Do not escalate because another bot hit the same outage, and do not
      // push an already-running pause further into the future. Only re-arm a
      // bounded pause once the previous one has actually expired.
      if (when >= this.cooldownUntil) {
        const wait = this._waitFor(this.strikes, true);
        this.cooldownUntil = when + wait;
        this.lastWaitMs = wait;
      }
      return this.snapshot(when, { counted: false, reason: 'same episode' });
    }

    this.episodeOpen = true;
    this.episodeStartedAt = when;
    this.episodes += 1;
    this.countedFailures += 1;
    this.strikes = Math.min(this.maxStrikes, this.strikes + 1);
    this.lastStrikeAt = when;
    const wait = this._waitFor(this.strikes, false);
    this.cooldownUntil = Math.max(this.cooldownUntil, when + wait);
    this.lastWaitMs = wait;
    return this.snapshot(when, { counted: true, reason: 'new episode' });
  }

  /** A bot reached ready: the outage is over, but keep the strike history. */
  success({ at = null } = {}) {
    const when = at === null ? this._now() : at;
    this.lastSuccessAt = when;
    // A successful join proves the server is accepting this fleet again. Do
    // not make the remaining healthy reconnect attempts sit out a pause that
    // has already served its purpose; the configured join spacing (0 by default) still
    // applies. The strike level is retained for a future, separate outage.
    this.cooldownUntil = 0;
    this.lastWaitMs = 0;
    if (this.episodeOpen) {
      this.episodeOpen = false;
      this.episodes = Math.max(this.episodes, 1);
    }
    if (this.lastStrikeAt && when - this.lastStrikeAt > this.quietResetMs) {
      this.strikes = 0;
    }
    return this.snapshot(when, { counted: false, reason: 'ready' });
  }

  /** Remaining pause in milliseconds; 0 when joins may proceed. */
  waitMs(at = null) {
    const when = at === null ? this._now() : at;
    return Math.max(0, this.cooldownUntil - when);
  }

  snapshot(at = null, extra = {}) {
    const when = at === null ? this._now() : at;
    const remaining = this.waitMs(when);
    return {
      strikes: this.strikes,
      maxStrikes: this.maxStrikes,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      jitterMs: this.jitterMs,
      episodeOpen: this.episodeOpen,
      episodeStartedAt: this.episodeStartedAt || null,
      lastStrikeAt: this.lastStrikeAt || null,
      lastFailureAt: this.lastFailureAt || null,
      lastSuccessAt: this.lastSuccessAt || null,
      cooldownUntil: this.cooldownUntil || null,
      remainingMs: remaining,
      lastWaitMs: this.lastWaitMs,
      failures: this.failures,
      countedFailures: this.countedFailures,
      suppressedFailures: this.suppressedFailures,
      episodes: this.episodes,
      lastKind: this.lastKind,
      lastError: this.lastError,
      ...extra
    };
  }

  _waitFor(strikes, sameEpisode) {
    const level = Math.max(1, Number(strikes) || 1);
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, level - 1));
    // Same-episode failures reuse the base pause at the current strike level;
    // the exponential growth is reserved for genuinely separate episodes.
    const base = sameEpisode ? Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, level - 1)) : exp;
    const jitter = this.jitterMs * Math.max(0, Math.min(1, Number(this.random()) || 0));
    return Math.round(Math.min(this.maxDelayMs + this.jitterMs, base + jitter));
  }

  _now() {
    const value = typeof this.now === 'function' ? this.now() : this.now;
    return Number.isFinite(value) ? value : Date.now();
  }
}

module.exports = { JoinScheduler };
