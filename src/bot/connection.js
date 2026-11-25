'use strict';

/** Server-side join throttling and connection pacing helpers. */
const THROTTLE_RE = /throttl|wait before reconnecting|too many connect|rate.?limit|try again later|connection limit/i;
// A server that accepts the socket but never sends login/spawn is usually
// still enforcing the same per-IP limiter. Treat it like a throttle so the
// fleet backs off instead of retrying into the block.
const JOIN_STALL_RE = /timed out.*waiting for (?:spawn|protocol login|configuration)|before the bot became ready|no login confirmation|no register confirmation/i;

function isThrottleError(error) {
  return THROTTLE_RE.test(String(error || ''));
}

function isJoinStallError(error) {
  return JOIN_STALL_RE.test(String(error || ''));
}

/** Exponential fleet-wide join backoff after repeated throttle responses. */
function throttleCooldown({ strikes = 1, throttleDelayMs = 90000, maxDelayMs = 600000 } = {}) {
  const base = Math.max(1000, Number(throttleDelayMs) || 0);
  const n = Math.max(1, Number(strikes) || 1);
  return Math.min(Math.max(base, Number(maxDelayMs) || base), base * Math.pow(2, n - 1));
}

/**
 * Reconnect delay with exponential backoff, a longer floor for server-side
 * throttling and jitter so ten bots do not retry in lockstep.
 */
function reconnectDelay({
  attempt = 1,
  error = '',
  baseDelayMs = 5000,
  maxDelayMs = 120000,
  throttleDelayMs = 30000,
  jitterMs = 4000,
  random = Math.random
} = {}) {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(1.5, Math.max(0, attempt - 1)));
  const floor = isThrottleError(error) ? Math.max(throttleDelayMs, exp) : exp;
  const jitter = Math.max(0, Number(jitterMs) || 0) * Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(Math.min(maxDelayMs + jitterMs, floor + jitter));
}

/** Space out initial joins and recovery attempts. */
function staggerDelay({ staggerMs = 7000, jitterMs = 2000, random = Math.random } = {}) {
  const jitter = Math.max(0, Number(jitterMs) || 0) * Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(Math.max(0, Number(staggerMs) || 0) + jitter);
}

/** Sleep that resolves early when the runtime aborts during shutdown. */
function sleep(ms, signal = null) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Classify why a socket ended. Operator/staff kicks and bans must stop the
 * automatic reconnect loop: immediately rejoining after moderation is spam
 * and can turn a temporary kick into a ban. A generic network/protocol kick
 * remains retryable with backoff.
 */
const MOVEMENT_KICK_PAUSE_THRESHOLD = 3;

/**
 * A movement rejection normally retries, but three consecutive rejections
 * across sessions mean the client is repeatedly violating the server's
 * movement rules. Pause and ask for an explicit reconnect instead of
 * thrashing the join queue.
 */
function movementRetryVerdict(strikes) {
  const count = Math.max(0, Number.isFinite(Number(strikes)) ? Math.floor(Number(strikes)) : 0);
  return {
    strikes: count,
    pause: count >= MOVEMENT_KICK_PAUSE_THRESHOLD,
    retry: count < MOVEMENT_KICK_PAUSE_THRESHOLD
  };
}

function classifyKick(reason) {
  const raw = String(reason || '');
  const text = raw.toLowerCase();
  if (/\b(banned|ban|blacklisted|blacklist)\b/.test(text)) {
    return { kind: 'ban', retry: false, pauseRetries: true, operator: false, label: 'Banned by the server' };
  }
  if (/not (?:allowed|whitelisted)|whitelist|you are not white-listed/.test(text)) {
    return { kind: 'whitelist', retry: false, pauseRetries: true, operator: true, label: 'Not whitelisted on the server' };
  }
  if (/(kicked|removed|disconnected)\s+by\s+(an?\s+)?(operator|admin|administrator|staff|moderator|mod)\b/.test(text)
    || /\b(operator|staff|admin)\s+kick(ed)?\b/.test(text)) {
    return { kind: 'operator', retry: false, pauseRetries: true, operator: true, label: 'Kicked by a server operator' };
  }
  if (/duplicate login|logged in from another location|already logged in|another client/.test(text)) {
    return { kind: 'duplicate', retry: true, pauseRetries: false, operator: false, label: 'Duplicate login detected' };
  }
  if (/invalid move player packet|invalid_player_movement|moved wrongly|moved too (?:quickly|fast)|moving too (?:quickly|fast)|flying is not enabled|invalid position/.test(text)) {
    // A movement rejection is a client-behaviour defect, not a version guess.
    // Keep retrying after a bounded backoff, but surface the exact category so
    // the operator does not mistake it for a generic socket error.
    return { kind: 'movement', retry: true, pauseRetries: false, operator: false, label: 'Movement rejected by the server' };
  }
  if (/unsupported protocol|outdated client|outdated server|incompatible version|unsupported version/.test(text)) {
    return { kind: 'version', retry: false, pauseRetries: true, operator: false, label: 'Protocol version rejected' };
  }
  if (/authentication failed|login failed|wrong password|not authenticated|please log\s?in|please register|authme|simpleauth/.test(text)) {
    return { kind: 'auth', retry: false, pauseRetries: true, operator: false, label: 'Server authentication failed' };
  }
  if (/server is full|server full|no slots|max(?:imum)? players/.test(text)) {
    return { kind: 'full', retry: true, pauseRetries: false, operator: false, label: 'Server is full' };
  }
  if (THROTTLE_RE.test(text)) {
    return { kind: 'throttle', retry: true, pauseRetries: false, operator: false, label: 'Server join throttle' };
  }
  if (/server (?:is )?(?:restarting|shutting down|closed)|proxy (?:restarting|shutting down)/.test(text)) {
    return { kind: 'restart', retry: true, pauseRetries: false, operator: false, label: 'Server restarting' };
  }
  if (/timed out|timeout|took too long/.test(text)) {
    return { kind: 'timeout', retry: true, pauseRetries: false, operator: false, label: 'Connection timed out' };
  }
  if (/econnreset|epipe|socketclosed|socket closed|socket hang up|connection reset/.test(text)) {
    return { kind: 'network', retry: true, pauseRetries: false, operator: false, label: 'Network connection lost' };
  }
  if (/bad packet|protocol error|decoder|malformed/.test(text)) {
    return { kind: 'protocol', retry: true, pauseRetries: false, operator: false, label: 'Protocol rejection' };
  }
  return { kind: 'generic', retry: true, pauseRetries: false, operator: false, label: 'Connection closed' };
}

module.exports = {
  MOVEMENT_KICK_PAUSE_THRESHOLD,
  movementRetryVerdict,
  isThrottleError,
  isJoinStallError,
  throttleCooldown,
  reconnectDelay,
  staggerDelay,
  sleep,
  classifyKick
};
