'use strict';

/** Server-side join throttling and connection pacing helpers. */
const THROTTLE_RE = /throttl|wait before reconnecting|too many connect|rate.?limit|try again later|connection limit/i;

function isThrottleError(error) {
  return THROTTLE_RE.test(String(error || ''));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

module.exports = { isThrottleError, reconnectDelay, staggerDelay, sleep };
