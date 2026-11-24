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
 * throttling and jitter so five bots do not retry in lockstep.
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

module.exports = { isThrottleError, isJoinStallError, throttleCooldown, reconnectDelay, staggerDelay, sleep, classifyKick };

/**
 * Classify why a socket ended. Operator/staff kicks and bans must stop the
 * automatic reconnect loop: immediately rejoining after moderation is spam
 * and can turn a temporary kick into a ban. A generic network/protocol kick
 * remains retryable with backoff.
 */
function classifyKick(reason) {
  const text = String(reason || '').toLowerCase();
  if (/\b(banned|ban|blacklisted|blacklist)\b/.test(text)) {
    return { kind: 'ban', retry: false, pauseRetries: true, operator: false, label: 'Banned by the server' };
  }
  if (/(kicked|removed|disconnected)\s+by\s+(an?\s+)?(operator|admin|administrator|staff|moderator|mod)\b/.test(text)
    || /\b(operator|staff|admin)\s+kick(ed)?\b/.test(text)
    || /not allowed on this server|not whitelisted|whitelist/i.test(text)) {
    return { kind: 'operator', retry: false, pauseRetries: true, operator: true, label: 'Kicked by a server operator' };
  }
  if (THROTTLE_RE.test(text)) {
    return { kind: 'throttle', retry: true, pauseRetries: false, operator: false, label: 'Server join throttle' };
  }
  if (/invalid move player packet|bad packet|protocol error|unsupported protocol/i.test(text)) {
    return { kind: 'protocol', retry: true, pauseRetries: false, operator: false, label: 'Protocol rejection' };
  }
  return { kind: 'generic', retry: true, pauseRetries: false, operator: false, label: 'Connection closed' };
}
