/**
 * Client-side reader for the single connection verdict produced by
 * src/bot/status.js. The browser must not invent a second definition of
 * "online": it renders `bot.online`/`bot.status` from the snapshot and only
 * derives a fallback when talking to an older server.
 */
const STATUS_META = {
  online: { label: 'Online', tone: 'ok', dot: 'ok', online: true },
  online_not_ready: { label: 'Online — starting', tone: 'warn', dot: 'warn', online: true },
  auth_required_manual: { label: 'Online — auth required', tone: 'warn', dot: 'warn', online: true },
  joining: { label: 'Joining', tone: 'warn', dot: 'warn', online: false },
  reconnecting: { label: 'Reconnecting', tone: 'warn', dot: 'warn', online: false },
  authenticating: { label: 'Authenticating', tone: 'warn', dot: 'warn', online: true },
  auth_failed: { label: 'Online — auth failed', tone: 'danger', dot: 'danger', online: true },
  dead: { label: 'Dead — online', tone: 'danger', dot: 'danger', online: true },
  stale: { label: 'No packets', tone: 'danger', dot: 'danger', online: true },
  initialising: { label: 'Online — starting', tone: 'warn', dot: 'warn', online: true },
  offline: { label: 'Offline', tone: 'danger', dot: 'danger', online: false },
  unknown: { label: 'Unknown', tone: 'neutral', dot: 'muted', online: false }
};

const AUTH_ERROR_RE = /auth|login|password|register|credential|not authenticated|not logged in/i;
const STALE_AFTER_MS = 90000;

export function botStatus(bot) {
  if (!bot) return withDetail(STATUS_META.unknown, 'unknown', 'No bot data');
  const meta = STATUS_META[bot.status];
  if (meta) {
    // The status key is the verdict. Never combine it with a second, possibly
    // inconsistent `online` boolean from an older payload.
    return { ...meta, key: bot.status, label: bot.statusLabel || meta.label, online: typeof bot.online === 'boolean' ? bot.online : meta.online, detail: bot.statusDetail || '' };
  }
  return deriveStatus(bot);
}

export function botOnline(bot) {
  if (!bot) return false;
  if (typeof bot.online === 'boolean') return bot.online;
  if (STATUS_META[bot.status]) return STATUS_META[bot.status].online;
  return botStatus(bot).online;
}

function deriveStatus(bot) {
  if (bot.connected === false) return withDetail(STATUS_META.offline, 'offline', bot.lastError || 'No open connection');
  if (bot.spawned === false) return withDetail(STATUS_META.joining, 'joining', bot.authenticated === false ? 'Connected, authenticating and waiting for spawn' : 'Connected, waiting for spawn');
  if (bot.lastEventAt && Date.now() - bot.lastEventAt > STALE_AFTER_MS) return withDetail(STATUS_META.stale, 'stale', `No packet from the server for ${Math.round((Date.now() - bot.lastEventAt) / 1000)}s`);
  // Ready wins over stale legacy auth flags; a live entity cannot be "Auth failed".
  if (bot.ready === true) {
    if (Number.isFinite(bot.health) && bot.health <= 0) return withDetail(STATUS_META.dead, 'dead', 'Spawned but dead; waiting to respawn');
    return withDetail(STATUS_META.online, 'online', 'Connected, authenticated and spawned');
  }
  if (bot.authRequiredManual || bot.authPending) return withDetail(STATUS_META.auth_required_manual, 'auth_required_manual', bot.lastError || 'Manual authentication required; gameplay is blocked');
  if (bot.authenticated === false) {
    const key = AUTH_ERROR_RE.test(String(bot.lastError || '')) ? 'auth_failed' : 'authenticating';
    return withDetail(STATUS_META[key], key, bot.lastError || 'Waiting for password authentication');
  }
  if (Number.isFinite(bot.health) && bot.health <= 0) return withDetail(STATUS_META.dead, 'dead', 'Spawned but dead; waiting to respawn');
  if (bot.ready === false || bot.gameplayReady === false) return withDetail(STATUS_META.online_not_ready, 'online_not_ready', 'Spawned and online; the entity is not ready yet');
  return withDetail(STATUS_META.online, 'online', 'Connected, authenticated and spawned');
}

function withDetail(meta, key, detail) {
  return { ...meta, key, label: meta.label, detail };
}
