'use strict';

const { config } = require('../config');

const TARGET_MODES = Object.freeze(['EXPLICIT', 'ARENA', 'DEFENSIVE']);
const NAME_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
const MAX_TARGETS = 32;
const MAX_PROTECTED = 64;
const MAX_ARENAS = 12;

function cleanPlayerName(value) {
  const name = String(value || '').trim();
  if (!NAME_PATTERN.test(name)) return null;
  return name.toLowerCase();
}

function finiteNumber(value) {
  return Number.isFinite(Number(value));
}

function normalizeArena(arena = {}) {
  const min = arena.min || {};
  const max = arena.max || {};
  if (![min.x, min.y, min.z, max.x, max.y, max.z].every(finiteNumber)) return null;
  const low = { x: Math.min(Number(min.x), Number(max.x)), y: Math.min(Number(min.y), Number(max.y)), z: Math.min(Number(min.z), Number(max.z)) };
  const high = { x: Math.max(Number(min.x), Number(max.x)), y: Math.max(Number(min.y), Number(max.y)), z: Math.max(Number(min.z), Number(max.z)) };
  return {
    name: String(arena.name || 'arena').slice(0, 48), min: low, max: high,
    enabled: arena.enabled !== false, createdAt: arena.createdAt || Date.now()
  };
}

/**
 * Explicit player-target authorisation. PvP is a capability that defaults to
 * off; neither a random player nor a teammate can become a target by scanning.
 *
 * The three modes are genuinely different:
 *   EXPLICIT  — an operator named the player; arena bounds still apply.
 *   ARENA     — an operator named the player AND an authorised arena exists;
 *               the target must be inside it.
 *   DEFENSIVE — only retaliation against a named player who attacked the bot
 *               or its team; never an opening attack.
 */
class PvpPolicy {
  constructor({ teamNames = config.team.names, enabled = false, mode = 'EXPLICIT', targets = [], protectedPlayers = [], trustedPlayers = [], arenas = [] } = {}) {
    this.teamNames = new Set((teamNames || []).map((name) => String(name).toLowerCase()));
    this.enabled = Boolean(enabled);
    this.mode = TARGET_MODES.includes(String(mode).toUpperCase()) ? String(mode).toUpperCase() : 'EXPLICIT';
    this.targets = new Set();
    this.protectedPlayers = new Set();
    this.trustedPlayers = new Set();
    this.arenas = [];
    this.audit = [];
    for (const name of targets || []) this.addTarget(name);
    for (const name of protectedPlayers || []) this.protect(name);
    for (const name of trustedPlayers || []) this.trust(name);
    for (const arena of arenas || []) this.addArena(arena);
    this.retaliation = this.mode === 'DEFENSIVE';
    this.updatedAt = Date.now();
  }

  _name(player) {
    return String((player && (player.username || player.name || player.type)) || '').toLowerCase();
  }

  _audit(action, data = {}) {
    this.audit.push({ at: Date.now(), action, ...data });
    if (this.audit.length > 100) this.audit.splice(0, this.audit.length - 100);
  }

  isTeammate(player) {
    const name = this._name(player);
    return this.teamNames.has(name) || this.teamNames.has(String((player && player.username) || '').toLowerCase());
  }

  isProtected(player) {
    const name = this._name(player);
    return this.protectedPlayers.has(name) || this.trustedPlayers.has(name);
  }

  isTrusted(player) {
    return this.trustedPlayers.has(this._name(player));
  }

  isAuthorized(player) {
    if (!player || !this.enabled) return false;
    if (this.isTeammate(player) || this.isProtected(player)) return false;
    return this.targets.has(this._name(player));
  }

  inArena(position) {
    if (!this.arenas.length) return { allowed: true, configured: false };
    if (!position) {
      return { allowed: false, configured: true, reason: 'target position is unknown, so arena bounds cannot be verified' };
    }
    for (const arena of this.arenas) {
      if (position.x >= arena.min.x && position.x <= arena.max.x
        && position.y >= arena.min.y && position.y <= arena.max.y
        && position.z >= arena.min.z && position.z <= arena.max.z) {
        return arena.enabled === false
          ? { allowed: false, configured: true, reason: `arena ${arena.name || 'unnamed'} is disabled` }
          : { allowed: true, configured: true, arena };
      }
    }
    return { allowed: false, configured: true, reason: 'position is outside every authorised arena' };
  }

  /**
   * Metadata is optional for backwards compatibility, but when the caller knows
   * a player is offline, in another dimension or at a stale position the attack
   * is refused. That prevents a remembered coordinate from becoming a target.
   */
  canEngage(player, {
    position = null, explicit = true, serverPvp = true, defending = false,
    online = null, positionFresh = null, dimension = null, botDimension = null
  } = {}) {
    if (!this.enabled) return { ok: false, code: 'PVP_DISABLED', error: 'PvP is disabled' };
    if (serverPvp === false) return { ok: false, code: 'SERVER_PVP_DISABLED', error: 'server configuration has PvP disabled' };
    if (!player) return { ok: false, code: 'NO_TARGET', error: 'no player target' };
    if (this.isTeammate(player)) return { ok: false, code: 'TEAMMATE', error: 'teammates are never valid PvP targets' };
    if (this.isProtected(player)) {
      return { ok: false, code: 'PROTECTED', error: this.isTrusted(player) ? 'player is trusted' : 'player is protected' };
    }
    if (!this.isAuthorized(player)) return { ok: false, code: 'NOT_AUTHORIZED', error: 'player is not on the explicit PvP target list' };
    if (online === false) return { ok: false, code: 'OFFLINE', error: 'target player is not online' };
    if (positionFresh === false) return { ok: false, code: 'STALE_POSITION', error: 'target position is stale; refusing to chase a remembered coordinate' };
    if (dimension && botDimension && String(dimension) !== String(botDimension)) {
      return { ok: false, code: 'DIMENSION', error: `target is in ${dimension}, not ${botDimension}` };
    }
    if (this.mode === 'EXPLICIT' && !explicit) return { ok: false, code: 'NOT_EXPLICIT', error: 'explicit operator targeting is required' };
    if (this.mode === 'ARENA' && !this.arenas.length) {
      return { ok: false, code: 'ARENA_REQUIRED', error: 'arena mode requires at least one authorised arena' };
    }
    if (this.mode === 'DEFENSIVE' && !defending) {
      return { ok: false, code: 'NOT_RETALIATION', error: 'defensive mode only engages after the target attacks the bot or team' };
    }
    const arena = this.inArena((player && player.position) || position);
    if (!arena.allowed) return { ok: false, code: 'ARENA', error: arena.reason };
    return { ok: true, target: this._name(player), arena: arena.arena || null, mode: this.mode };
  }

  addTarget(name) {
    const key = cleanPlayerName(name);
    if (!key) return { ok: false, error: 'target name must be 1-32 letters, digits or underscores' };
    if (this.teamNames.has(key)) return { ok: false, error: 'cannot target a teammate' };
    if (this.protectedPlayers.has(key) || this.trustedPlayers.has(key)) return { ok: false, error: 'player is protected' };
    if (this.targets.size >= MAX_TARGETS) return { ok: false, error: 'target list is full' };
    if (this.targets.has(key)) return { ok: true, target: key, already: true, targets: this.list() };
    this.targets.add(key);
    this.updatedAt = Date.now();
    this._audit('target.add', { target: key });
    return { ok: true, target: key, targets: this.list() };
  }

  removeTarget(name) {
    const key = cleanPlayerName(name);
    if (!key) return { ok: false, error: 'target name must be 1-32 letters, digits or underscores' };
    const removed = this.targets.delete(key);
    this.updatedAt = Date.now();
    this._audit('target.remove', { target: key, removed });
    return { ok: true, removed, target: key, targets: this.list() };
  }

  clearTargets() {
    const removed = this.targets.size;
    this.targets.clear();
    this.updatedAt = Date.now();
    this._audit('target.clear', { removed });
    return { ok: true, removed, targets: [] };
  }

  protect(name) {
    const key = cleanPlayerName(name);
    if (!key) return { ok: false, error: 'player name required' };
    if (this.teamNames.has(key)) return { ok: false, error: 'teammates are already protected' };
    if (this.protectedPlayers.size >= MAX_PROTECTED && !this.protectedPlayers.has(key)) return { ok: false, error: 'protection list is full' };
    this.protectedPlayers.add(key);
    this.trustedPlayers.delete(key);
    this.targets.delete(key);
    this.updatedAt = Date.now();
    this._audit('protect', { target: key });
    return { ok: true, protected: key, protectedPlayers: this.listProtected() };
  }

  unprotect(name) {
    const key = cleanPlayerName(name);
    if (!key) return { ok: false, error: 'player name required' };
    const removed = this.protectedPlayers.delete(key);
    this.updatedAt = Date.now();
    this._audit('unprotect', { target: key, removed });
    return { ok: true, removed, protectedPlayers: this.listProtected() };
  }

  trust(name) {
    const key = cleanPlayerName(name);
    if (!key) return { ok: false, error: 'player name required' };
    if (this.teamNames.has(key)) return { ok: false, error: 'teammates are already trusted' };
    if (this.trustedPlayers.size >= MAX_PROTECTED && !this.trustedPlayers.has(key)) return { ok: false, error: 'trusted list is full' };
    this.trustedPlayers.add(key);
    this.protectedPlayers.delete(key);
    this.targets.delete(key);
    this.updatedAt = Date.now();
    this._audit('trust', { target: key });
    return { ok: true, trusted: key, trustedPlayers: this.listTrusted() };
  }

  untrust(name) {
    const key = cleanPlayerName(name);
    if (!key) return { ok: false, error: 'player name required' };
    const removed = this.trustedPlayers.delete(key);
    this.updatedAt = Date.now();
    this._audit('untrust', { target: key, removed });
    return { ok: true, removed, trustedPlayers: this.listTrusted() };
  }

  addArena(arena) {
    const normalized = normalizeArena(arena);
    if (!normalized) return { ok: false, error: 'arena needs finite min/max bounds' };
    if (this.arenas.length >= MAX_ARENAS) return { ok: false, error: 'arena list is full' };
    this.arenas.push(normalized);
    this.updatedAt = Date.now();
    this._audit('arena.add', { arena: normalized.name });
    return { ok: true, arena: normalized, arenas: this.listArenas() };
  }

  removeArena(name) {
    const key = String(name || '').toLowerCase();
    const before = this.arenas.length;
    this.arenas = this.arenas.filter((arena) => String(arena.name || '').toLowerCase() !== key);
    this.updatedAt = Date.now();
    this._audit('arena.remove', { arena: key, removed: before - this.arenas.length });
    return { ok: true, removed: before - this.arenas.length, arenas: this.listArenas() };
  }

  clearArenas() {
    const removed = this.arenas.length;
    this.arenas = [];
    this.updatedAt = Date.now();
    this._audit('arena.clear', { removed });
    return { ok: true, removed, arenas: [] };
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.updatedAt = Date.now();
    this._audit('enabled', { enabled: this.enabled });
    return { ok: true, enabled: this.enabled, targets: this.list() };
  }

  setMode(mode) {
    const normalized = String(mode || '').toUpperCase();
    if (!TARGET_MODES.includes(normalized)) return { ok: false, error: `unknown targeting mode ${mode}` };
    this.mode = normalized;
    this.retaliation = normalized === 'DEFENSIVE';
    this.updatedAt = Date.now();
    this._audit('mode', { mode: normalized });
    return { ok: true, mode: this.mode };
  }

  list() { return [...this.targets].sort(); }
  listProtected() { return [...this.protectedPlayers].sort(); }
  listTrusted() { return [...this.trustedPlayers].sort(); }
  listArenas() { return this.arenas.map((arena) => ({ ...arena, min: { ...arena.min }, max: { ...arena.max } })); }

  status() {
    return {
      enabled: this.enabled, mode: this.mode, modes: TARGET_MODES.slice(), targets: this.list(),
      protectedPlayers: this.listProtected(), trustedPlayers: this.listTrusted(),
      arenas: this.listArenas(), teamNames: [...this.teamNames],
      updatedAt: new Date(this.updatedAt).toISOString(),
      recentAudit: this.audit.slice(-10).map((entry) => ({ ...entry }))
    };
  }
}

module.exports = { PvpPolicy, TARGET_MODES, cleanPlayerName, normalizeArena };
