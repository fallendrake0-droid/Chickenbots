'use strict'
const fs = require('fs')
class Logger {
  constructor (config) { this.config = config; this.lines = []; this.listeners = new Set() }
  clean (value) { let s = String(value ?? ''); if (this.config.password) s = s.split(this.config.password).join('[REDACTED]'); return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\/(register|login)\s+\S+(?:\s+\S+)?/gi, '/$1 [REDACTED]') }
  log (name, level, message) {
    const line = `[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] [${name}] ${this.clean(message)}`
    this.lines.push(line); if (this.lines.length > 500) this.lines.shift()
    if (level !== 'debug' || this.config.logLevel === 'debug') console.log(line)
    if (process.env.LOG_FILE) fs.appendFile(process.env.LOG_FILE, line + '\n', () => {})
    for (const cb of this.listeners) cb(line)
  }
}
module.exports = Logger
