'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const logStore = require('./logStore');

class Logger {
  constructor(scope = 'chickenbots', level = process.env.LOG_LEVEL || 'info') {
    if (scope && typeof scope === 'object') {
      const options = scope;
      level = options.level || level;
      scope = options.scope || 'chickenbots';
    }
    this.scope = scope;
    this.level = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
    this.sinks = [];
    this.history = [];
    this.maxHistory = 500;
  }

  child(scope) {
    const child = new Logger(`${this.scope}:${scope}`, 'info');
    child.level = this.level;
    child.sinks = this.sinks;
    child._parentHistory = this;
    return child;
  }

  addSink(fn) { this.sinks.push(fn); return () => { this.sinks = this.sinks.filter((s) => s !== fn); }; }

  _log(level, msg, meta) {
    if (LEVELS[level] < this.level) return;
    const entry = { ts: Date.now(), level, scope: this.scope, msg: String(msg), meta: meta === undefined ? null : meta };
    logStore.record(entry);
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.shift();
    if (this._parentHistory) {
      this._parentHistory.history.push(entry);
      if (this._parentHistory.history.length > this._parentHistory.maxHistory) this._parentHistory.history.shift();
    }
    for (const sink of this.sinks) {
      try { sink(entry); } catch (_) { /* a broken sink must never break a bot */ }
    }
    if (this.sinks.length === 0) {
      const metaStr = meta === undefined ? '' : ` ${safeJson(meta)}`;
      process.stdout.write(`[${new Date(entry.ts).toISOString()}] ${level.toUpperCase().padEnd(5)} ${this.scope}: ${entry.msg}${metaStr}\n`);
    }
  }

  debug(msg, meta) { this._log('debug', msg, meta); }
  info(msg, meta) { this._log('info', msg, meta); }
  warn(msg, meta) { this._log('warn', msg, meta); }
  error(msg, meta) { this._log('error', msg, meta); }
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

const rootLogger = new Logger('chickenbots');

module.exports = { Logger, rootLogger, LEVELS };
