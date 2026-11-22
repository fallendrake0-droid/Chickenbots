'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Terminal = require('../src/terminal')
const Logger = require('../src/logger')
function stream (tty, columns = 80) { return { isTTY: tty, columns, data: '', write (s) { this.data += s } } }
test('terminal is colorful on a tty and clean for pipes or NO_COLOR', () => {
  const config = { host: 'example.test', port: 55742, dashboardHost: '127.0.0.1', dashboardPort: 3000, delay: 5000 }
  const tty = stream(true); const t = new Terminal(tty, {}); t.banner(config); t.log('joined', 'success'); assert.match(tty.data, /\x1b\[/); assert.match(tty.data, /example.test:55742/)
  const plain = stream(false); const p = new Terminal(plain, {}); p.banner(config); p.log('joined', 'success'); assert.doesNotMatch(plain.data, /\x1b\[/)
  const disabled = stream(true); new Terminal(disabled, { NO_COLOR: '' }).log('joined', 'success'); assert.doesNotMatch(disabled.data, /\x1b\[/)
  const narrow = stream(true, 40); new Terminal(narrow, {}).banner(config); assert.match(narrow.data, /C H I C K E N B O T S/)
})
test('status is based on real snapshot and logs are buffered while editing', () => {
  const out = stream(false); const t = new Terminal(out, {}); t.setEditing(true); t.log('message', 'info'); assert.equal(out.data, ''); t.setEditing(false); assert.match(out.data, /message/)
  t.status({ bots: [{ name: '______', state: 'SPAWNING', auth: 'OFFLINE' }] }); assert.match(out.data, /SPAWNING/); assert.doesNotMatch(out.data, /CONNECTED/)
})
test('logger strips terminal control codes and secrets from every output', () => {
  const log = new Logger({ password: 'secret', logLevel: 'info' }); const out = []; log.output = line => out.push(line); log.log('bot', 'info', '\x1b]0;evil\x07 /login secret secret\nnext'); assert.doesNotMatch(out[0], /secret|\x1b|\n/); assert.match(out[0], /REDACTED/); assert.equal(log.lines[0], out[0])
})
