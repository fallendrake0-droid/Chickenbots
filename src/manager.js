'use strict'
const dns = require('dns').promises
const net = require('net')
const mc = require('minecraft-protocol')
const mineflayer = require('mineflayer')
const path = require('path')
const { AuthStore, AuthSession } = require('./auth')
const { pathfinder } = require('mineflayer-pathfinder')
const { Work } = require('./work')
const { TeamManager } = require('./team')
function classify (message) {
  const m = String(message).toLowerCase()
  if (/whitelist|not white.listed/.test(m)) return ['WHITELIST_REJECTED', true]
  if (/banned/.test(m)) return ['PLAYER_BANNED', true]
  if (/invalid session|failed to verify|authentication|unauthorized|invalid credentials/.test(m)) return ['AUTH_FAILED', true]
  if (/outdated (client|server)|unsupported|incompatible|protocol version/.test(m)) return ['UNSUPPORTED_VERSION', true]
  if (/server is full|server full/.test(m)) return ['SERVER_FULL', false]
  if (/enotfound|eai_again/.test(m)) return ['DNS_ERROR', false]
  if (/econnrefused/.test(m)) return ['CONNECTION_REFUSED', false]
  if (/timeout|etimedout/.test(m)) return ['CONNECTION_TIMEOUT', false]
  return ['UNEXPECTED_DISCONNECT', false]
}
function tcpCheck (host, port, timeout) { return new Promise((resolve, reject) => { const s = net.connect({ host, port }); s.setTimeout(timeout); s.once('connect', () => { s.destroy(); resolve() }); s.once('timeout', () => { s.destroy(); reject(new Error('ETIMEDOUT')) }); s.once('error', reject) }) }
class Controller {
  constructor (manager, name) { this.manager = manager; this.config = manager.config; this.name = name; this.state = 'STOPPED'; this.authState = 'OFFLINE'; this.bot = null; this.generation = 0; this.retryCount = 0; this.timer = null; this.watchdog = null; this.lastError = null; this.history = []; this.chatHistory = []; this.stats = { connections: 0, disconnections: 0 }; this.connectedAt = null; this.server = null; this.lastChat = 0; this.work = new Work(this) }
  log (level, msg) { this.manager.logger.log(this.name, level, msg); this.history.push({ time: Date.now(), level, message: this.manager.logger.clean(msg) }); if (this.history.length > 100) this.history.shift() }
  update () { this.manager.emit() }
  setState (state) { this.state = state; this.update() }
  snapshot () { const b = this.bot; const pos = b?.entity?.position; return { name: this.name, state: this.state, auth: this.authState, health: b?.health ?? null, food: b?.food ?? null, dimension: b?.game?.dimension ?? null, position: pos ? { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 } : null, ping: b?.player?.ping ?? this.server?.latency ?? null, connectedAt: this.connectedAt, lastError: this.lastError, retryCount: this.retryCount, stats: this.stats, work: this.work.snapshot(), history: this.history, chat: this.chatHistory, server: this.server } }
  start () { if (this.state !== 'STOPPED' && !['ERROR', 'AUTHENTICATION_FAILED', 'DISCONNECTED'].includes(this.state)) return false; this.retryCount = 0; this.launch(); return true }
  launch () { const gen = ++this.generation; clearTimeout(this.timer); this.setState('INITIALIZING'); this.manager.enqueue(() => { if (this.generation === gen) this.connect(gen).catch(err => { if (this.generation === gen) { const [code, permanent] = classify(err.message); this.fail(code, err.message, permanent) } }) }) }
  async connect (gen) {
    this.setState('CHECKING_SERVER'); this.log('info', 'Resolving and checking server')
    await this.manager.resolve(this.config.host); if (gen !== this.generation) return
    await this.manager.tcpCheck(this.config.host, this.config.port, this.config.timeout); if (gen !== this.generation) return
    const status = await this.manager.ping({ host: this.config.host, port: this.config.port, closeTimeout: this.config.timeout, noPongTimeout: 2000 }); if (gen !== this.generation) return
    this.server = { version: status.version?.name, protocol: status.version?.protocol, latency: status.latency ?? null }
    const protocolNum = status.version?.protocol
    const matching = mc.supportedVersions.find(v => require('minecraft-data')(v)?.version?.version === protocolNum)
    if (this.config.version === 'auto' && !matching) return this.fail('UNSUPPORTED_VERSION', `Server advertises ${status.version?.name} (protocol ${protocolNum}); no installed client protocol matches. Set MC_VERSION only if the server supports that client via ViaVersion/ViaBackwards.`, true)
    const version = this.config.version === 'auto' ? matching : this.config.version
    this.log('info', `Server ${status.version?.name} protocol ${protocolNum}; client ${version} protocol ${require('minecraft-data')(version).version.version}`)
    await this.manager.connectionSlot(); if (gen !== this.generation) return
    this.setState('CONNECTING')
    const bot = this.manager.createBot({ host: this.config.host, port: this.config.port, username: this.name, auth: this.config.auth, version, profilesFolder: path.join(this.config.dataDir, 'microsoft', this.name), onMsaCode: data => { if (gen === this.generation) this.manager.deviceLogin(`[${this.name}] Microsoft device login: ${data.message}`) } })
    this.bot = bot; if (typeof bot.loadPlugin === 'function') bot.loadPlugin(pathfinder); this.authState = 'OFFLINE'; this.session = new AuthSession(this, this.manager.store)
    this.watchdog = setTimeout(() => { if (gen === this.generation) this.fail('CONNECTION_TIMEOUT', 'Login or world spawn timed out.', false) }, this.config.timeout)
    bot.once('login', () => { if (gen !== this.generation) return; if (this.config.auth === 'microsoft' && bot.username && bot.username.toLowerCase() !== this.name.toLowerCase()) return this.fail('AUTH_FAILED', `Microsoft profile name ${bot.username} does not match configured bot ${this.name}. Use the account owning this name.`, true); this.setState('LOGGED_IN'); this.log('info', 'Minecraft login successful; waiting for spawn'); this.setState('SPAWNING') })
    bot.once('spawn', () => { if (gen !== this.generation) return; clearTimeout(this.watchdog); this.retryCount = 0; this.connectedAt = Date.now(); this.stats.connections++; this.lastError = null; this.setState('CONNECTED'); this.log('success', 'BOT SUCCESSFULLY JOINED THE SERVER (world spawn)'); this.session.start() })
    bot.on('messagestr', (text) => { if (gen !== this.generation) return; try { this.session.message(text) } catch (err) { this.fail('AUTH_FAILED', `Authentication state error: ${err.message}`, true); return } const clean = this.manager.logger.clean(text); if (/\/(register|login)\b/i.test(text) || (this.config.password && text.includes(this.config.password))) return; this.addChat('server', clean) })
    bot.inventory?.on?.('updateSlot', () => { if (gen === this.generation) this.work.health() })
    bot.on('health', () => { if (gen === this.generation) { this.update(); this.work.health() } })
    bot.on('kicked', reason => { if (gen !== this.generation) return; const message = typeof reason === 'string' ? reason : JSON.stringify(reason); const [code, permanent] = classify(message); this.fail(code === 'UNEXPECTED_DISCONNECT' ? 'KICKED' : code, message, permanent) })
    bot.on('error', err => { if (gen !== this.generation) return; const [code, permanent] = classify(err.message); this.fail(code, err.message, permanent) })
    bot.once('end', reason => { if (gen === this.generation) this.fail('UNEXPECTED_DISCONNECT', String(reason || 'Connection ended'), false) })
    this.setState('AUTHENTICATING')
  }
  fail (code, message, permanent) { this.lastError = `${code}: ${this.manager.logger.clean(message)}`; this.log('error', this.lastError + (code === 'WHITELIST_REJECTED' ? ' Ask the administrator to whitelist this account.' : '')); this.cleanup(); if (code === 'AUTH_FAILED') this.authState = 'FAILED'; this.setState(permanent ? (code === 'AUTH_FAILED' ? 'AUTHENTICATION_FAILED' : 'ERROR') : 'DISCONNECTED'); if (!permanent && this.config.retry && (!this.config.attempts || this.retryCount < this.config.attempts)) { const delay = Math.min(this.config.max, this.config.initial * 2 ** Math.min(this.retryCount, 30)); this.retryCount++; this.setState('RECONNECTING'); this.log('warning', `Retry ${this.retryCount} in ${delay}ms`); this.timer = setTimeout(() => this.launch(), delay) } }
  cleanup () { this.work.stop(true); ++this.generation; clearTimeout(this.timer); clearTimeout(this.watchdog); this.session?.stop(); if (this.bot) { this.stats.disconnections++; const b = this.bot; this.bot = null; try { b.clearControlStates(); b.quit() } catch {} } this.connectedAt = null; this.authState = 'OFFLINE' }
  stop () { this.cleanup(); this.setState('STOPPED') }
  reconnect () { this.stop(); this.start() }
  addChat (source, text) { this.chatHistory.push({ source, text: this.manager.logger.clean(text), time: Date.now() }); if (this.chatHistory.length > 100) this.chatHistory.shift(); this.update() }
  chat (message) { if (this.state !== 'CONNECTED' || !['AUTHENTICATED', 'DISABLED'].includes(this.authState)) throw new Error('Bot is not connected and authenticated'); if (typeof message !== 'string' || !message.trim() || message.length > 256 || /[\r\n]/.test(message) || message.trim().startsWith('/')) throw new Error('Chat must be 1–256 characters and cannot be a command'); if (this.config.password && message.includes(this.config.password)) throw new Error('Chat cannot contain the configured password'); if (Date.now() - this.lastChat < 2000) throw new Error('Chat rate limit: wait two seconds'); this.bot.chat(message); this.lastChat = Date.now(); this.addChat('operator', message) }
  movement (control, value) { if (value && this.work.active) throw new Error('Stop the work task before manual movement'); if (this.state !== 'CONNECTED' || !['AUTHENTICATED', 'DISABLED'].includes(this.authState)) throw new Error('Bot is not connected and authenticated'); if (!['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(control) || typeof value !== 'boolean') throw new Error('Invalid movement'); this.bot.setControlState(control, value) }
  stopMovement () { if (!this.work.active) this.bot?.clearControlStates() }
}
class Manager {
  constructor (config, logger, createBot = mineflayer.createBot) { this.config = config; this.logger = logger; this.createBot = createBot; this.deviceLogin = message => console.log(message); this.resolve = dns.lookup; this.tcpCheck = tcpCheck; this.ping = mc.ping; this.store = new AuthStore(config.dataDir); this.controllers = new Map(config.names.map(n => [n, new Controller(this, n)])); this.queue = []; this.queueTimer = null; this.lastAttempt = 0; this.nextConnection = 0; this.slotWaiters = new Map(); this.listeners = new Set(); this.startedAt = Date.now(); this.closed = false; this.team = new TeamManager(this); this.positionTimer = setInterval(() => this.emit(), 2000); this.positionTimer.unref() }
  enqueue (fn) { this.queue.push(fn); this.drain() }
  drain () { if (this.queueTimer || !this.queue.length || this.closed) return; const wait = Math.max(0, this.config.delay - (Date.now() - this.lastAttempt)); this.queueTimer = setTimeout(() => { this.queueTimer = null; const fn = this.queue.shift(); this.lastAttempt = Date.now(); fn(); this.drain() }, wait) }
  connectionSlot () { const now = Date.now(); const at = Math.max(now, this.nextConnection); this.nextConnection = at + this.config.delay; if (at === now) return Promise.resolve(); return new Promise(resolve => { const timer = setTimeout(() => { this.slotWaiters.delete(timer); resolve() }, at - now); this.slotWaiters.set(timer, resolve) }) }
  emit () { for (const fn of this.listeners) fn() }
  snapshot () { return { server: `${this.config.host}:${this.config.port}`, uptime: Date.now() - this.startedAt, team: this.team.snapshot(), bots: [...this.controllers.values()].map(c => c.snapshot()) } }
  all (action) { for (const c of this.controllers.values()) { if (action === 'start') c.start(); else if (action === 'stop') c.stop(); else if (action === 'reconnect' || action === 'restart') c.reconnect() } }
  shutdown () { this.team.stop(); this.closed = true; clearTimeout(this.queueTimer); clearInterval(this.positionTimer); this.queue = []; for (const [timer, resolve] of this.slotWaiters) { clearTimeout(timer); resolve() } this.slotWaiters.clear(); this.all('stop') }
}
module.exports = { Manager, Controller, classify, tcpCheck }
