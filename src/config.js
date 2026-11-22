'use strict'
const path = require('path')
const fs = require('fs')
const dotenv = require('dotenv')
// The example file contains the public, intentionally shared initial plugin password.
const DEFAULT_PLUGIN_PASSWORD = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.env.example'))).BOT_AUTH_PASSWORD
const protocol = require('minecraft-protocol')
const NAMES = ['______', '101010', '010101', '110011', '001100']
function loadConfig (env = process.env) {
  const num = (key, def, min, max) => { const raw = env[key] ?? String(def); if (!/^\d+$/.test(raw) || +raw < min || +raw > max) throw new Error(`Invalid ${key}`); return +raw }
  const bool = (key, def) => { const v = env[key] ?? String(def); if (!['true', 'false'].includes(v)) throw new Error(`Invalid ${key}: use true or false`); return v === 'true' }
  const names = (env.BOT_NAMES || NAMES.join(',')).split(',')
  if (names.join(',') !== NAMES.join(',')) throw new Error('BOT_NAMES must contain the five configured usernames in order')
  const host = env.MC_HOST || 'cr3xlol.aternos.me'
  if (!/^(?=.{1,253}$)[a-zA-Z0-9.-]+$/.test(host) || host === 'localhost' || host === '127.0.0.1') throw new Error('Invalid MC_HOST')
  const auth = env.MC_AUTH || 'microsoft'; if (!['microsoft', 'offline'].includes(auth)) throw new Error('MC_AUTH must be microsoft or offline')
  const version = env.MC_VERSION || 'auto'; if (version !== 'auto' && !protocol.supportedVersions.includes(version)) throw new Error(`Unsupported MC_VERSION ${version}`)
  const enabled = bool('BOT_AUTH_ENABLED', true); const password = env.BOT_AUTH_PASSWORD || DEFAULT_PLUGIN_PASSWORD || ''
  if (enabled && (!password || /\s/.test(password))) throw new Error('BOT_AUTH_PASSWORD is required when BOT_AUTH_ENABLED=true and must not contain whitespace')
  const patterns = {}
  for (const [key, fallback] of Object.entries({ register: '\\b(register|registration required)\\b', login: '\\b(login|log in)\\b', registered: '(registration successful|successfully registered|registered successfully)', success: '(login successful|successfully logged in|logged in successfully|authentication successful)', already: '(already registered)', incorrect: '(incorrect password|wrong password|invalid password)' })) {
    try { patterns[key] = new RegExp(env[`AUTH_PATTERN_${key.toUpperCase()}`] || fallback, 'i') } catch { throw new Error(`Invalid AUTH_PATTERN_${key.toUpperCase()}`) }
  }
  const initial = num('RECONNECT_INITIAL_DELAY', 5000, 100, 3600000), max = num('RECONNECT_MAX_DELAY', 60000, 100, 3600000)
  if (max < initial) throw new Error('RECONNECT_MAX_DELAY must be >= RECONNECT_INITIAL_DELAY')
  const dashboardHost = env.DASHBOARD_HOST || '127.0.0.1'; if (dashboardHost !== '127.0.0.1') throw new Error('DASHBOARD_HOST must be 127.0.0.1')
  return { names, host, port: num('MC_PORT', 55742, 1, 65535), auth, version, enabled, password, patterns, dashboardHost, dashboardPort: num('DASHBOARD_PORT', 3000, 1, 65535), retry: bool('RECONNECT_ENABLED', true), initial, max, attempts: num('RECONNECT_MAX_ATTEMPTS', 0, 0, 100000), delay: num('BOT_START_DELAY', 5000, 5000, 3600000), timeout: num('CONNECTION_TIMEOUT', 30000, 1000, 300000), authTimeout: num('AUTH_TIMEOUT', 30000, 1000, 300000), logLevel: env.LOG_LEVEL || 'info', dataDir: path.resolve('data') }
}
module.exports = { loadConfig, NAMES, DEFAULT_PLUGIN_PASSWORD }
