'use strict';

class CancelledError extends Error {
  constructor(reason = 'cancelled') { super(reason); this.name = 'CancelledError'; this.cancelled = true; }
}

class TimeoutError extends Error {
  constructor(message) { super(message); this.name = 'TimeoutError'; this.timedOut = true; }
}

class CancellationToken {
  constructor() { this.cancelled = false; this.reason = null; this._listeners = new Set(); }
  cancel(reason = 'cancelled') {
    if (this.cancelled) return;
    this.cancelled = true;
    this.reason = reason;
    for (const fn of this._listeners) { try { fn(reason); } catch (_) { /* ignore */ } }
    this._listeners.clear();
  }
  throwIfCancelled() { if (this.cancelled) throw new CancelledError(this.reason); }
  onCancel(fn) { if (this.cancelled) { fn(this.reason); return () => {}; } this._listeners.add(fn); return () => this._listeners.delete(fn); }
}

function delay(ms, token = null) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const off = token ? token.onCancel(() => { cleanup(); reject(new CancelledError(token.reason)); }) : null;
    function cleanup() { clearTimeout(timer); if (off) off(); }
    if (timer.unref) timer.unref();
    if (token && token.cancelled) { cleanup(); reject(new CancelledError(token.reason)); }
  });
}

function withTimeout(promise, ms, message = 'operation timed out') {
  if (!ms || ms <= 0) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(message)), ms); if (timer.unref) timer.unref(); })
  ]);
}

async function retry(fn, { attempts = 3, delayMs = 250, token = null, onError = null } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    if (token) token.throwIfCancelled();
    try { return await fn(i); } catch (err) {
      if (err instanceof CancelledError) throw err;
      lastError = err;
      if (onError) onError(err, i);
      if (i < attempts - 1) await delay(delayMs * (i + 1), token);
    }
  }
  throw lastError;
}

module.exports = { CancellationToken, CancelledError, TimeoutError, delay, withTimeout, retry };
