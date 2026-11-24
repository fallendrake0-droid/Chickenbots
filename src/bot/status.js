'use strict';

const { config } = require('../config');

/**
 * One authoritative answer to "is this bot actually online?".
 *
 * The dashboard, diagnostics and runtime all use this function so a bot cannot
 * be counted as online by one view and offline by another. "Online" means the
 * socket is open, the bot has authenticated and spawned, it is not dead and it
 * has produced a packet recently. Every other state gets its own label rather
 * than being flattened into a misleading "Online".
 */
const AUTH_ERROR_RE = /auth|login|password|register|credential|not authenticated|not logged in/i;

const STATUS_META = Object.freeze({
  online: { label: 'Online', online: true },
  joining: { label: 'Joining', online: false },
  reconnecting: { label: 'Reconnecting', online: false },
  authenticating: { label: 'Authenticating', online: false },
  auth_failed: { label: 'Auth failed', online: false },
  dead: { label: 'Dead', online: false },
  stale: { label: 'No packets', online: false },
  initialising: { label: 'Starting', online: false },
  offline: { label: 'Offline', online: false },
  unknown: { label: 'Unknown', online: false }
});

function connectionStatus(bot, { now = Date.now(), staleAfterMs = config.server.staleAfterMs || 90000 } = {}) {
  if (!bot) {
    return result('unknown', 'Bot is not present in the runtime', { now, lastEventAt: null, staleAfterMs });
  }
  const lastEventAt = Number.isFinite(bot.lastEventAt) && bot.lastEventAt > 0 ? bot.lastEventAt : null;
  const lastEventAgeMs = lastEventAt ? Math.max(0, now - lastEventAt) : null;
  const lastError = bot.lastError || null;

  // Once a live adapter has a real session, the lifecycle machine is the
  // authoritative answer. The booleans below are only a compatibility
  // fallback for MockBot and for constructors that have never connected.
  const machine = bot.connection && typeof bot.connection.snapshot === 'function' ? bot.connection.snapshot(now) : null;
  // An EPIPE/end callback can arrive before the lifecycle close transition.
  // The socket is already unusable, so do not report the bot online merely
  // because the previous READY state has not been projected away yet.
  if (bot._transportDead) {
    return result('offline', 'Transport closed; awaiting session cleanup', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
  }
  if (machine && machine.generation > 0) {
    const stale = Boolean(machine.state === 'ready' && lastEventAt && lastEventAgeMs > staleAfterMs);
    if (stale) {
      return result('stale', `No packet from the server for ${Math.round(lastEventAgeMs / 1000)}s (${machine.stage})`, { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
    }
    switch (machine.state) {
      case 'ready':
        if (Number.isFinite(bot.health) && bot.health <= 0) return result('dead', 'Spawned but dead; waiting to respawn', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
        return result('online', 'Connected, authenticated and spawned', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
      case 'respawning':
        if (Number.isFinite(bot.health) && bot.health <= 0) return result('dead', 'Dead; waiting for the respawn screen', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
        return result('online', 'Respawning at the server spawn', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
      case 'authenticating':
        return result(AUTH_ERROR_RE.test(String(lastError || '')) ? 'auth_failed' : 'authenticating', lastError || 'Waiting for password authentication', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
      case 'awaiting_spawn':
      case 'configuration':
      case 'handshaking':
      case 'tcp_connecting':
      case 'resolving': {
        const elapsed = machine.stageElapsedMs === null ? '' : ` for ${(machine.stageElapsedMs / 1000).toFixed(1)}s`;
        const retry = Boolean(bot.lastDisconnect) && (machine.state === 'resolving' || machine.state === 'tcp_connecting');
        return result(retry ? 'reconnecting' : 'joining', `${retry ? 'Reconnecting — ' : ''}${machine.stageLabel}${elapsed} (session ${machine.generation})`, { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
      }
      case 'stopping':
        return result('offline', 'Disconnecting', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
      case 'failed': {
        const failure = machine.failure || {};
        const detail = failure.error || lastError || 'Connection failed';
        return result(failure.code === 'AUTH_FAILED' ? 'auth_failed' : 'offline', `Failed in ${failure.stage || machine.stage}: ${detail}`, { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
      }
      case 'closed':
      case 'idle':
      default:
        return result('offline', machine.detail || 'No open connection', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
    }
  }

  const connected = bot.connected !== false;
  const spawned = bot.spawned !== false;
  const authenticated = bot.authenticated !== false;
  const ready = bot.ready === true || (bot.ready === undefined && connected && spawned && authenticated);
  const stale = Boolean(connected && spawned && authenticated && lastEventAt && lastEventAgeMs > staleAfterMs);

  if (!connected) {
    return result('offline', lastError ? `Disconnected: ${lastError}` : 'No open connection', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError });
  }
  if (stale) {
    return result('stale', `No packet from the server for ${Math.round(lastEventAgeMs / 1000)}s`, { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError });
  }
  if (!spawned) {
    return result('joining', authenticated ? 'Connected, waiting for spawn' : 'Connected, authenticating and waiting for spawn', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError });
  }
  // A ready client entity is the strongest signal: the socket, spawn and
  // authentication must all have succeeded even if one legacy boolean was
  // stale. Never label a live, ready bot as "Auth failed".
  if (ready) {
    if (Number.isFinite(bot.health) && bot.health <= 0) {
      return result('dead', 'Spawned but dead; waiting to respawn', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError });
    }
    return result('online', 'Connected, authenticated and spawned', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError });
  }
  if (!authenticated) {
    const key = AUTH_ERROR_RE.test(String(lastError || '')) ? 'auth_failed' : 'authenticating';
    return result(key, lastError || 'Waiting for password authentication', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError });
  }
  if (Number.isFinite(bot.health) && bot.health <= 0) {
    return result('dead', 'Spawned but dead; waiting to respawn', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError });
  }
  return result('initialising', 'Spawned but the client entity is not ready yet', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError });
}

function result(status, detail, { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError = null, machine = null }) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  return {
    online: meta.online,
    status,
    statusLabel: meta.label,
    label: meta.label,
    statusDetail: detail,
    detail,
    lastEventAt,
    lastEventAgeMs: lastEventAgeMs === undefined && lastEventAt ? Math.max(0, now - lastEventAt) : (lastEventAgeMs ?? null),
    staleAfterMs,
    lastError,
    sessionId: machine ? machine.generation : null,
    stage: machine ? machine.stage : null,
    connectionState: machine ? machine.state : null
  };
}

module.exports = { connectionStatus, STATUS_META, AUTH_ERROR_RE };
