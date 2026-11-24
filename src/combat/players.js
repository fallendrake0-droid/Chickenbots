'use strict';

const { config } = require('../config');

/**
 * Explicit player-target authorisation. PvP is enabled as a feature by default,
 * but neither a random player nor a teammate can become a target through
 * scanning. Targets must be named by an operator and the server's PvP setting
 * remains authoritative.
 */
class PvpPolicy {
  constructor({ teamNames = config.team.names, enabled = false, mode = 'EXPLICIT', targets = [], protectedPlayers = [], arenas = [] } = {}) {
    this.teamNames = new Set(teamNames || []);
    this.enabled = Boolean(enabled);
    this.mode = mode;
    this.targets = new Set((targets || []).map((name) => String(name).toLowerCase()));
    this.protectedPlayers = new Set((protectedPlayers || []).map((name) => String(name).toLowerCase()));
    this.arenas = (arenas || []).map((arena) => ({ ...arena }));
    this.retaliation = false;
    this.updatedAt = Date.now();
  }

  _name(player) {
    return String((player && (player.username || player.name || player.type)) || '').toLowerCase();
  }

  isTeammate(player) {
    const name = this._name(player);
    return this.teamNames.has(name) || this.teamNames.has(String(player && player.username));
  }

  isProtected(player) {
    return this.protectedPlayers.has(this._name(player));
  }

  isAuthorized(player) {
    if (!player || !this.enabled) return false;
    if (this.isTeammate(player) || this.isProtected(player)) return false;
    return this.targets.has(this._name(player));
  }

  inArena(position) {
    if (!this.arenas.length || !position) return { allowed: true };
    for (const arena of this.arenas) {
      if (!arena.min || !arena.max) continue;
      if (position.x >= arena.min.x && position.x <= arena.max.x && position.y >= arena.min.y && position.y <= arena.max.y && position.z >= arena.min.z && position.z <= arena.max.z) {
        return arena.enabled === false ? { allowed: false, reason: `arena ${arena.name || 'unnamed'} is disabled` } : { allowed: true, arena };
      }
    }
    return { allowed: false, reason: 'position is outside every authorised arena' };
  }

  canEngage(player, { position = null, explicit = true, serverPvp = true } = {}) {
    if (!this.enabled) return { ok: false, code: 'PVP_DISABLED', error: 'PvP is disabled' };
    if (serverPvp === false) return { ok: false, code: 'SERVER_PVP_DISABLED', error: 'server configuration has PvP disabled' };
    if (!player) return { ok: false, code: 'NO_TARGET', error: 'no player target' };
    if (this.isTeammate(player)) return { ok: false, code: 'TEAMMATE', error: 'teammates are never valid PvP targets' };
    if (this.isProtected(player)) return { ok: false, code: 'PROTECTED', error: 'player is protected' };
    if (!this.isAuthorized(player)) return { ok: false, code: 'NOT_AUTHORIZED', error: 'player is not on the explicit PvP target list' };
    if (this.mode === 'EXPLICIT' && !explicit) return { ok: false, code: 'NOT_EXPLICIT', error: 'explicit operator targeting is required' };
    const arena = this.inArena(position || (player && player.position));
    if (!arena.allowed) return { ok: false, code: 'ARENA', error: arena.reason };
    return { ok: true, target: this._name(player), arena: arena.arena || null };
  }

  addTarget(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return { ok: false, error: 'target name required' };
    if (this.teamNames.has(key)) return { ok: false, error: 'cannot target a teammate' };
    if (this.protectedPlayers.has(key)) return { ok: false, error: 'player is protected' };
    if (this.targets.size >= 32) return { ok: false, error: 'target list is full' };
    this.targets.add(key);
    this.updatedAt = Date.now();
    return { ok: true, target: key, targets: this.list() };
  }

  removeTarget(name) {
    const key = String(name || '').toLowerCase();
    const removed = this.targets.delete(key);
    this.updatedAt = Date.now();
    return { ok: true, removed, targets: this.list() };
  }

  protect(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return { ok: false, error: 'player name required' };
    if (this.teamNames.has(key)) return { ok: false, error: 'teammates are already protected' };
    this.protectedPlayers.add(key);
    this.targets.delete(key);
    this.updatedAt = Date.now();
    return { ok: true, protected: key, protectedPlayers: this.listProtected() };
  }

  unprotect(name) {
    const removed = this.protectedPlayers.delete(String(name || '').toLowerCase());
    this.updatedAt = Date.now();
    return { ok: true, removed, protectedPlayers: this.listProtected() };
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.updatedAt = Date.now();
    return { ok: true, enabled: this.enabled, targets: this.list() };
  }

  setMode(mode) {
    const normalized = String(mode || '').toUpperCase();
    if (!['EXPLICIT', 'ARENA', 'DEFENSIVE'].includes(normalized)) return { ok: false, error: `unknown targeting mode ${mode}` };
    this.mode = normalized;
    this.updatedAt = Date.now();
    return { ok: true, mode: this.mode };
  }

  list() { return [...this.targets].sort(); }
  listProtected() { return [...this.protectedPlayers].sort(); }

  status() {
    return {
      enabled: this.enabled, mode: this.mode, targets: this.list(),
      protectedPlayers: this.listProtected(), arenas: this.arenas,
      teamNames: [...this.teamNames], updatedAt: new Date(this.updatedAt).toISOString()
    };
  }
}

module.exports = { PvpPolicy };
