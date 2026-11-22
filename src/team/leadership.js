'use strict';

/**
 * Dynamic coordinator election.
 *
 * The preferred coordinator is elected when available, but never required:
 * any connected, spawned, living bot can coordinate. State lives in the team
 * board/memory, so losing the leader never loses the plan.
 */
class Leadership {
  constructor({ preferred = '______', order = [], now = () => Date.now() } = {}) {
    this.preferred = preferred;
    this.order = order.slice();
    this.now = now;
    this.leader = null;
    this.history = [];
    this.listeners = [];
  }

  onElection(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }

  candidates(states) {
    return (states || []).filter((s) => s && s.connected !== false && s.spawned !== false && (s.health === undefined || s.health > 0));
  }

  _orderIndex(name) {
    const idx = this.order.indexOf(name);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  }

  score(candidate) {
    let score = 0;
    if (candidate.name === this.preferred) score += 100;
    score += Math.min(20, candidate.health === undefined ? 20 : candidate.health) * 2;
    score += Math.min(20, candidate.food === undefined ? 20 : candidate.food);
    score += Math.min(30, (candidate.uptimeMs || 0) / 60000);
    score -= Math.min(30, (candidate.taskLoad || 0) * 6);
    if (candidate.isLeader) score += 15; // stability: re-elect the incumbent
    return Number(score.toFixed(2));
  }

  update(states) {
    const candidates = this.candidates(states);
    if (!candidates.length) {
      this.leader = null;
      return { leader: null, changed: false, reason: 'no eligible bots' };
    }
    const ranked = candidates
      .map((c) => ({ ...c, electionScore: this.score(c) }))
      .sort((a, b) => b.electionScore - a.electionScore
        || this._orderIndex(a.name) - this._orderIndex(b.name)
        || a.name.localeCompare(b.name));
    const winner = ranked[0].name;
    const changed = winner !== this.leader;
    if (changed) {
      const previous = this.leader;
      this.leader = winner;
      this.history.push({ at: this.now(), leader: winner, previous, scores: ranked.map((r) => ({ name: r.name, score: r.electionScore })) });
      if (this.history.length > 100) this.history.shift();
      for (const fn of this.listeners) { try { fn(winner, previous); } catch (_) { /* ignore */ } }
      return { leader: winner, previous, changed: true, scores: ranked };
    }
    return { leader: winner, changed: false, scores: ranked };
  }

  isLeader(name) { return this.leader === name; }

  /** Deterministic succession order, used if the leader disconnects mid-task. */
  successionOrder(states) {
    return [...this.candidates(states)].map((c) => ({ name: c.name, score: this.score(c) }))
      .sort((a, b) => b.score - a.score || this._orderIndex(a.name) - this._orderIndex(b.name) || a.name.localeCompare(b.name))
      .map((c) => c.name);
  }
}

module.exports = { Leadership };
