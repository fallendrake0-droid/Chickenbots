'use strict'
const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')
const { loadConfig } = require('./config')

// Fixed bot names and localhost binding are intentional safety constraints.
const FIELDS = [
  ['MC_HOST', 'Minecraft server host', 'cr3xlol.aternos.me'],
  ['MC_PORT', 'Minecraft server port', '55742'],
  ['MC_VERSION', 'Minecraft version (auto or supported version)', 'auto'],
  ['MC_AUTH', 'Account authentication (microsoft or offline)', 'microsoft'],
  ['BOT_AUTH_ENABLED', 'Server plugin authentication (true/false)', 'true'],
  ['BOT_AUTH_PASSWORD', 'Server plugin password (hidden)', '', true],
  ['DASHBOARD_PORT', 'Local dashboard port', '3000'],
  ['RECONNECT_ENABLED', 'Automatic reconnect (true/false)', 'true'],
  ['RECONNECT_INITIAL_DELAY', 'Initial retry delay in ms', '5000'],
  ['RECONNECT_MAX_DELAY', 'Maximum retry delay in ms', '60000'],
  ['RECONNECT_MAX_ATTEMPTS', 'Maximum retries (0 = unlimited)', '0'],
  ['BOT_START_DELAY', 'Delay between bot connections in ms (minimum 5000)', '5000'],
  ['CONNECTION_TIMEOUT', 'Connection timeout in ms', '30000'],
  ['AUTH_TIMEOUT', 'Server authentication timeout in ms', '30000'],
  ['LOG_LEVEL', 'Log level (info/debug)', 'info']
]

function readEnv (file) {
  try { return fs.readFileSync(file, 'utf8') } catch (err) { if (err.code === 'ENOENT') return ''; throw err }
}

function writeEnv (file, original, changes, overrides = {}) {
  const values = { ...dotenv.parse(original), ...changes }
  // Shell environment values take precedence at startup, just as they do in dotenv.
  loadConfig({ ...values, ...overrides, ...changes })
  loadConfig({ ...values, ...overrides })
  if (values.LOG_LEVEL && !['info', 'debug'].includes(values.LOG_LEVEL)) throw new Error('LOG_LEVEL must be info or debug')
  for (const [key, value] of Object.entries(changes)) {
    if (!FIELDS.some(field => field[0] === key) || /[\r\n\0"]/.test(value)) throw new Error(`Invalid value for ${key}`)
    if (dotenv.parse(`${key}="${value}"`)[key] !== value) throw new Error(`${key} contains unsupported escape sequences`)
  }
  const remaining = { ...changes }
  const lines = original.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    return !match || !Object.hasOwn(changes, match[1])
  })
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (const [key, value] of Object.entries(remaining)) lines.push(`${key}="${value}"`)
  const temp = path.join(path.dirname(file), `.env-edit-${process.pid}-${Date.now()}`)
  try {
    fs.writeFileSync(temp, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally { try { fs.unlinkSync(temp) } catch (err) { if (err.code !== 'ENOENT') throw err } }
}

function question (rl, prompt, hidden) {
  return new Promise((resolve, reject) => {
    let done = false
    const oldWrite = rl._writeToOutput
    const cleanup = () => { rl._writeToOutput = oldWrite; rl.removeListener('close', onClose) }
    const onClose = () => { if (!done) { done = true; cleanup(); reject(new Error('Configuration editing cancelled')) } }
    rl.once('close', onClose)
    if (hidden) {
      // Print the prompt before muting readline's echo, including redraws and history.
      rl.output.write(prompt)
      rl._writeToOutput = () => {}
    }
    rl.question(hidden ? '' : prompt, answer => {
      if (done) return
      done = true; cleanup()
      if (hidden) { rl.output.write('\n'); if (Array.isArray(rl.history)) rl.history = rl.history.filter(entry => entry !== answer) }
      resolve(answer)
    })
  })
}

async function editConfig (rl, { file = path.resolve('.env'), overrides = {} } = {}) {
  if (!rl.terminal) throw new Error('The config editor requires an interactive terminal (TTY) to protect passwords.')
  const original = readEnv(file); const current = dotenv.parse(original); const changes = {}
  console.log('\nCONFIG EDITOR — Enter keeps the current value; type !clear to clear a value.')
  console.log('Values are saved to .env only after validation. Ctrl-C cancels. Restart Chickenbots to apply changes.')
  for (const [key, label, fallback, hidden] of FIELDS) {
    const existing = Object.hasOwn(current, key) ? current[key] : fallback
    const shown = hidden ? (existing ? 'set' : 'not set') : existing
    const overridden = Object.hasOwn(overrides, key) ? ' [shell override]' : ''
    const answer = await question(rl, `${label} (${key}) [${shown}]${overridden}: `, hidden)
    if (answer !== '') changes[key] = answer === '!clear' ? '' : answer
  }
  writeEnv(file, original, changes, overrides)
  console.log('Configuration saved to .env. Restart Chickenbots to apply it. Shell environment variables take precedence over .env.')
}
module.exports = { FIELDS, editConfig, writeEnv, readEnv }
