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
  const connected = bot.connected !== false;
  const spawned = bot.spawned !== false;
  const authenticated = bot.authenticated !== false;
  const ready = bot.ready === true || (bot.ready === undefined && connected && spawned && authenticated);
  const lastEventAt = Number.isFinite(bot.lastEventAt) && bot.lastEventAt > 0 ? bot.lastEventAt : null;
  const lastEventAgeMs = lastEventAt ? Math.max(0, now - lastEventAt) : null;
  const stale = Boolean(connected && spawned && authenticated && lastEventAt && lastEventAgeMs > staleAfterMs);
  const lastError = bot.lastError || null;

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

function result(status, detail, { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError = null }) {
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
    lastError
  };
}

module.exports = { connectionStatus, STATUS_META, AUTH_ERROR_RE };
