'use strict';

const { config } = require('../config');

/**
 * One authoritative answer to "is this bot online, and can it play?".
 *
 * Online and ready are intentionally different questions. A bot the server
 * has spawned is online even while it is still initialising, dead, waiting at
 * a respawn screen or blocked by manual authentication. `gameplayReady` is the
 * narrower verdict used by the autonomy gate: transport + spawn + no pending
 * auth + a live entity. The dashboard, CLI, runtime and command layer all read
 * these fields; none of them re-derives an answer from a different flag.
 */
const AUTH_ERROR_RE = /auth|login|password|register|credential|not authenticated|not logged in/i;

const STATUS_META = Object.freeze({
  online: { label: 'Online', online: true, ready: true },
  online_not_ready: { label: 'Online — starting', online: true, ready: false },
  auth_required_manual: { label: 'Online — auth required', online: true, ready: false },
  auth_failed: { label: 'Online — auth failed', online: true, ready: false },
  joining: { label: 'Joining', online: false, ready: false },
  reconnecting: { label: 'Reconnecting', online: false, ready: false },
  authenticating: { label: 'Authenticating', online: true, ready: false },
  dead: { label: 'Dead — online', online: true, ready: false },
  stale: { label: 'No packets', online: true, ready: false },
  initialising: { label: 'Online — starting', online: true, ready: false },
  offline: { label: 'Offline', online: false, ready: false },
  unknown: { label: 'Unknown', online: false, ready: false }
});

function connectionStatus(bot, { now = Date.now(), staleAfterMs = config.server.staleAfterMs || 90000 } = {}) {
  if (!bot) {
    return result('unknown', 'Bot is not present in the runtime', { now, lastEventAt: null, staleAfterMs });
  }
  const lastEventAt = Number.isFinite(bot.lastEventAt) && bot.lastEventAt > 0 ? bot.lastEventAt : null;
  const lastEventAgeMs = lastEventAt ? Math.max(0, now - lastEventAt) : null;
  const lastError = bot.lastError || null;
  const machine = bot.connection && typeof bot.connection.snapshot === 'function' ? bot.connection.snapshot(now) : null;

  // The transport is genuinely gone. This is the one case where the server has
  // no session to list and "offline" is the honest answer.
  if (bot._transportDead) {
    return result('offline', 'Transport closed; awaiting session cleanup', { now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine });
  }

  const liveMachine = Boolean(machine && machine.generation > 0);
  const transportConnected = liveMachine ? Boolean(machine.open) : bot.connected !== false;
  const spawned = liveMachine
    ? Boolean(machine.spawned) || ['ready', 'respawning'].includes(machine.state)
    : bot.spawned !== false;
  const playerListed = serverPlayerListed(bot);
  // A spawned player is in the server's world even if a readiness flag says
  // otherwise. A player-info entry proves presence before the spawn packet has
  // been projected into our local flags.
  const online = Boolean(transportConnected && (spawned || playerListed));
  const authPending = Boolean(bot.authRequiredManual)
    || (bot.passwordRequired === true && bot.authConfirmed !== true && spawned)
    // Legacy/mock fixtures (and a server that rejected auth before this
    // runtime had a manual flag) still get an honest, non-offline label.
    || (bot.authenticated === false && bot.ready !== true && AUTH_ERROR_RE.test(String(lastError || '')));
  const authenticated = !authPending && (bot.authenticated !== false || spawned);

  const facts = {
    now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError, machine,
    transportConnected, spawned, playerListed, online, authPending, authenticated
  };

  if (!transportConnected) {
    return result('offline', lastError ? `Disconnected: ${lastError}` : 'No open connection', facts);
  }
  if (!spawned && !playerListed) {
    const retry = Boolean(bot.lastDisconnect) && (!machine || ['resolving', 'tcp_connecting'].includes(machine.state));
    const detail = machine ? `${machine.stageLabel}${machine.stageElapsedMs === null ? '' : ` for ${(machine.stageElapsedMs / 1000).toFixed(1)}s`}` : 'Connected, waiting for spawn';
    return result(retry ? 'reconnecting' : 'joining', `${retry ? 'Reconnecting — ' : ''}${detail}`, facts);
  }

  if (authPending) {
    const failed = Boolean(lastError) && AUTH_ERROR_RE.test(String(lastError)) && bot.authRequiredManual !== true;
    return result(failed ? 'auth_failed' : 'auth_required_manual', lastError || 'Manual authentication required by the server; gameplay is blocked', facts);
  }
  if (Number.isFinite(bot.health) && bot.health <= 0) {
    return result('dead', 'Spawned but dead; waiting to respawn', facts);
  }
  if (spawned && lastEventAt && lastEventAgeMs > staleAfterMs) {
    return result('stale', `No packet from the server for ${Math.round(lastEventAgeMs / 1000)}s (still listed by the server)`, facts);
  }

  // Legacy booleans without a lifecycle machine are still honoured, but only
  // to decide readiness. Presence already won above: a spawned bot is online.
  if (machine && machine.generation > 0) {
    if (machine.state === 'ready' || machine.state === 'respawning') {
      return result('online', 'Connected, spawned and ready for gameplay', facts);
    }
    if (machine.state === 'authenticating') {
      return result(bot.passwordRequired === true ? 'authenticating' : 'online_not_ready', 'Spawned; waiting for the client entity to become ready', facts);
    }
  }
  const readyFlag = bot.ready === true || (bot.ready === undefined && bot.authenticated !== false);
  if (!authenticated) {
    const failed = AUTH_ERROR_RE.test(String(lastError || ''));
    return result(failed ? 'auth_failed' : 'auth_required_manual', lastError || 'Authentication pending; gameplay is blocked', facts);
  }
  if (readyFlag) {
    return result('online', 'Connected, spawned and ready for gameplay', facts);
  }
  return result('online_not_ready', 'Spawned and online; the client entity is not ready yet', facts);
}

function serverPlayerListed(bot) {
  if (!bot) return false;
  if (bot.serverPlayerListed === true) return true;
  if (bot.entity && bot.players && bot.name && bot.players[bot.name]) return true;
  if (bot.entity) return true;
  return false;
}

function result(status, detail, {
  now, lastEventAt, lastEventAgeMs, staleAfterMs, lastError = null, machine = null,
  transportConnected = false, spawned = false, playerListed = false, online = false,
  authPending = false, authenticated = false
}) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  const gameplayReady = Boolean(meta.ready && online && spawned && !authPending && authenticated);
  return {
    online: Boolean(meta.online && online),
    ready: gameplayReady,
    gameplayReady,
    status,
    statusLabel: meta.label,
    label: meta.label,
    statusDetail: detail,
    detail,
    transportConnected: Boolean(transportConnected),
    serverPlayerListed: Boolean(playerListed || spawned),
    spawned: Boolean(spawned),
    authenticated: Boolean(authenticated && !authPending),
    authPending: Boolean(authPending),
    authRequiredManual: authPending,
    lastEventAt,
    lastEventAgeMs: lastEventAgeMs === undefined && lastEventAt ? Math.max(0, now - lastEventAt) : (lastEventAgeMs ?? null),
    staleAfterMs,
    lastError,
    sessionId: machine ? machine.generation : null,
    stage: machine ? machine.stage : null,
    connectionState: machine ? machine.state : null
  };
}

module.exports = { connectionStatus, STATUS_META, AUTH_ERROR_RE, serverPlayerListed };
