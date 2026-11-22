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
  ['MC_AUTH', 'Account authentication (microsoft or offline)', 'offline'],
  ['BOT_AUTH_ENABLED', 'Server plugin authentication (true/false)', 'true'],
  ['BOT_AUTH_MODE', 'Plugin authentication mode (login/prompt)', 'login'],
  ['BOT_AUTH_PASSWORD', 'Server plugin password (hidden)', '', true],
  ['BOT_REGISTER_CONFIRM', 'Registration requires password confirmation (true/false)', 'true'],
  ['TICK_END_WORKAROUND', 'Send tick end after movement (true/false)', 'true'],
  ['DASHBOARD_PORT', 'Local dashboard port', '3000'],
  ['RECONNECT_ENABLED', 'Automatic reconnect (true/false)', 'true'],
  ['RECONNECT_INITIAL_DELAY', 'Initial retry delay in ms', '5000'],
  ['RECONNECT_MAX_DELAY', 'Maximum retry delay in ms', '60000'],
  ['RECONNECT_MAX_ATTEMPTS', 'Maximum retries (0 = unlimited)', '0'],
  ['MAX_SIMULTANEOUS_LOGINS', 'Maximum simultaneous pending logins', '5'],
  ['POST_AUTH_STABILITY_MS', 'Authenticated stability interval in ms', '30000'],
  ['POST_AUTH_RESET_LIMIT', 'Short authenticated disconnects before suspending retries', '3'],
  ['BOT_START_DELAY', 'Delay between bot connections in ms (minimum 3000)', '3000'],
  ['THROTTLE_COOLDOWN', 'Server throttle cooldown in ms', '30000'],
  ['STABLE_CONNECTION_TIME', 'Stable connection time before resetting retries in ms', '60000'],
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
    // question renders its prompt synchronously. Mute only after it is displayed,
    // so readline cannot erase the password label during its initial redraw.
    rl.question(prompt, answer => {
      if (done) return
      done = true; cleanup()
      if (hidden) { rl.output.write('\n'); if (Array.isArray(rl.history)) rl.history = rl.history.filter(entry => entry !== answer) }
      resolve(answer)
    })
    if (hidden) rl._writeToOutput = () => {}
  })
}

async function promptPluginPassword (rl, { file = path.resolve('.env'), overrides = {} } = {}) {
  if (!rl.terminal) throw new Error('An interactive terminal is required to enter the password securely.')
  const original = readEnv(file)
  if (Object.hasOwn(overrides, 'BOT_AUTH_PASSWORD')) throw new Error('BOT_AUTH_PASSWORD is set in your shell but is empty or invalid. Remove or correct that environment variable and restart.')
  rl.output.write('Server plugin authentication is enabled and needs a password.\nEnter the password provided by your server administrator; your typing will be hidden.\n')
  while (true) {
    const password = await question(rl, 'Server plugin password (BOT_AUTH_PASSWORD): ', true)
    if (!password || /[\s"\x00]/.test(password) || dotenv.parse(`BOT_AUTH_PASSWORD="${password}"`).BOT_AUTH_PASSWORD !== password) {
      rl.output.write('Enter a non-empty password without spaces or double quotes. Try again, or press Ctrl-C to cancel.\n')
      continue
    }
    writeEnv(file, original, { BOT_AUTH_PASSWORD: password }, overrides)
    rl.output.write('Password saved privately in .env. Starting Chickenbots.\n')
    return
  }
}

async function editConfig (rl, { file = path.resolve('.env'), overrides = {}, startup = false } = {}) {
  if (!rl.terminal) throw new Error('The config editor requires an interactive terminal (TTY) to protect passwords.')
  const original = readEnv(file); const current = dotenv.parse(original); const changes = {}
  console.log('\nCONFIG EDITOR — Enter keeps the current value; type !clear to clear a value.')
  console.log(`Values are saved to .env only after validation. Ctrl-C cancels.${startup ? '' : ' Restart Chickenbots to apply changes.'}`)
  for (const [key, label, fallback, hidden] of FIELDS) {
    const existing = Object.hasOwn(current, key) ? current[key] : fallback
    const shown = hidden ? (current[key] ? 'set' : 'default') : existing
    const overridden = Object.hasOwn(overrides, key) ? ' [shell override]' : ''
    while (true) {
      const answer = await question(rl, `${label} (${key}) [${shown}]${overridden}: `, hidden)
      if (answer !== '') changes[key] = answer === '!clear' ? '' : answer
      if (key === 'BOT_AUTH_PASSWORD') {
        const enabled = overrides.BOT_AUTH_ENABLED ?? changes.BOT_AUTH_ENABLED ?? current.BOT_AUTH_ENABLED ?? 'true'
        const password = (overrides.BOT_AUTH_PASSWORD ?? changes.BOT_AUTH_PASSWORD ?? current.BOT_AUTH_PASSWORD) || ''
        if (enabled === 'true' && (!password || /\s/.test(password))) {
          if (Object.hasOwn(overrides, 'BOT_AUTH_PASSWORD')) throw new Error('The BOT_AUTH_PASSWORD environment override is empty or invalid; remove or correct it before editing.')
          console.log('A password without spaces is required while server plugin authentication is enabled. Enter it at the hidden prompt, or cancel and disable plugin authentication.')
          continue
        }
      }
      break
    }
  }
  writeEnv(file, original, changes, overrides)
  console.log(`Configuration saved to .env. ${startup ? 'Press Enter at the startup screen to apply it.' : 'Restart Chickenbots to apply it.'} Shell environment variables take precedence over .env.`)
}
module.exports = { FIELDS, editConfig, promptPluginPassword, writeEnv, readEnv }
