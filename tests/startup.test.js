'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const { choice } = require('../src/startup')
const { editConfig } = require('../src/configEditor')

class Input extends EventEmitter { constructor () { super(); this.isRaw = false } setRawMode (value) { this.isRaw = value } resume () {} pause () {} }
for (const [character, key, expected] of [['e', { name: 'e' }, 'edit'], ['\r', { name: 'return' }, 'start'], ['\x03', { name: 'c', ctrl: true }, 'quit']]) {
  test(`startup key selects ${expected} and restores terminal mode`, async () => { const input = new Input(); const output = { write () {} }; const result = choice(input, output); assert.equal(input.isRaw, true); input.emit('keypress', character, key); assert.equal(await result, expected); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0) })
}
test('password prompt is visible and secret is not echoed', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-editor-')), '.env')
  const rl = new EventEmitter(); rl.terminal = true; rl.history = []; let screen = ''; rl.output = { write (text) { screen += text } }; rl._writeToOutput = text => rl.output.write(text)
  const answers = ['', '', '', 'offline', 'true', 'login', 'private-pass', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
  rl.question = (prompt, callback) => { rl._writeToOutput(prompt); const answer = answers.shift(); setImmediate(() => { rl._writeToOutput(answer); callback(answer) }) }
  await editConfig(rl, { file, overrides: {}, startup: true })
  assert.equal(answers.length, 0); assert.equal((screen.match(/BOT_AUTH_PASSWORD/g) || []).length, 1); assert.doesNotMatch(screen, /private-pass/); assert.match(fs.readFileSync(file, 'utf8'), /BOT_AUTH_PASSWORD="private-pass"/)
})

test('quick password setup retries invalid input, saves securely and never echoes it', async () => {
  const { promptPluginPassword } = require('../src/configEditor')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-password-')); const file = path.join(dir, '.env')
  const rl = new EventEmitter(); rl.terminal = true; rl.history = []; let screen = ''; rl.output = { write (s) { screen += s } }; rl._writeToOutput = s => rl.output.write(s)
  const answers = ['', 'bad password', 'private-password']; rl.question = (prompt, cb) => { rl._writeToOutput(prompt); const answer = answers.shift(); setImmediate(() => { rl._writeToOutput(answer); cb(answer) }) }
  await promptPluginPassword(rl, { file, overrides: {} })
  assert.match(screen, /Server plugin password/); assert.doesNotMatch(screen, /private-password|bad password/); assert.equal((screen.match(/Try again/g) || []).length, 2); assert.match(fs.readFileSync(file, 'utf8'), /BOT_AUTH_PASSWORD="private-password"/)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})
test('quick setup rejects shell password overrides rather than falsely claiming success', async () => {
  const { promptPluginPassword } = require('../src/configEditor'); const rl = new EventEmitter(); rl.terminal = true
  await assert.rejects(promptPluginPassword(rl, { file: path.join(os.tmpdir(), 'cb-not-present-' + process.pid), overrides: { BOT_AUTH_PASSWORD: '' } }), /shell/)
})
