'use strict';

const { EventEmitter } = require('events');

/** Bounded, typed internal event bus.
 *
 * Minecraft chat is *not* the coordination channel: routine messages stay in
 * this in-process bus. A small, explicit subset may be mirrored to chat for
 * humans, but chat input can never drive control flow here.
 */
class BoundedEventBus extends EventEmitter {
  constructor({ maxHistory = 1000, types = null, name = 'bus' } = {}) {
    super({ captureRejections: false });
    this.setMaxListeners(200);
    this.maxHistory = maxHistory;
    this.types = types ? new Set(types) : null;
    this.name = name;
    this.history = [];
    this.dropped = 0;
  }

  publish(type, payload = {}, meta = {}) {
    if (this.types && !this.types.has(type)) {
      throw new Error(`Unknown bus message type: ${type}`);
    }
    const message = { id: `${type}-${Date.now()}-${this.history.length % 100000}`, type, payload, meta, ts: Date.now() };
    this.history.push(message);
    if (this.history.length > this.maxHistory) { this.history.shift(); this.dropped++; }
    this.emit(type, payload, meta, message);
    this.emit('*', message);
    return message;
  }

  recent(type = null, limit = 50) {
    const pool = type ? this.history.filter((m) => m.type === type) : this.history;
    return pool.slice(-limit);
  }

  waitFor(type, predicate = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let timer;
      const handler = (payload, meta, message) => {
        if (!predicate(payload, meta)) return;
        cleanup();
        resolve(message);
      };
      const cleanup = () => { clearTimeout(timer); this.off(type, handler); };
      this.on(type, handler);
      if (timeoutMs > 0) {
        timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
        if (timer.unref) timer.unref();
      }
    });
  }
}

module.exports = { BoundedEventBus };
