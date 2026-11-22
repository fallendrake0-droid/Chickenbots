'use strict'
const dns = require('dns').promises
const mc = require('minecraft-protocol')
const mineflayer = require('mineflayer')
const path = require('path')
const { AuthStore, AuthSession } = require('./auth')
const { pathfinder } = require('mineflayer-pathfinder')
const { Work } = require('./work')
const { Survival } = require('./survival')
const { TeamManager } = require('./team')
function classify (message) {
  const m = String(message).toLowerCase()
  if (/connection throttled|too many connections|reconnect too (fast|quickly)|reconnecting too (fast|quickly)/.test(m)) return ['CONNECTION_THROTTLED', false]
  if (/econnreset|econnaborted|epipe|socketclosed|socket hang up/.test(m)) return ['CONNECTION_RESET', false]
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

class Controller {
  constructor (manager, name) { this.manager = manager; this.config = manager.config; this.name = name; this.state = 'STOPPED'; this.authState = 'OFFLINE'; this.bot = null; this.generation = 0; this.retryCount = 0; this.timer = null; this.watchdog = null; this.stableTimer = null; this.lastError = null; this.history = []; this.chatHistory = []; this.stats = { connections: 0, disconnections: 0 }; this.connectedAt = null; this.server = null; this.lastChat = 0; this.work = new Work(this); this.survival = new Survival(this) }
  log (level, msg) { this.manager.logger.log(this.name, level, msg); this.history.push({ time: Date.now(), level, message: this.manager.logger.clean(msg) }); if (this.history.length > 100) this.history.shift() }
  update () { this.manager.emit() }
  setState (state) { this.state = state; this.update() }
  snapshot () { const b = this.bot; const pos = b?.entity?.position; return { name: this.name, state: this.state, auth: this.authState, health: b?.health ?? null, food: b?.food ?? null, dimension: b?.game?.dimension ?? null, position: pos ? { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 } : null, ping: b?.player?.ping ?? this.server?.latency ?? null, connectedAt: this.connectedAt, lastError: this.lastError, retryCount: this.retryCount, stats: this.stats, work: this.work.snapshot(), survival: this.survival.snapshot(), history: this.history, chat: this.chatHistory, server: this.server } }
  start () { if (this.state !== 'STOPPED' && !['ERROR', 'AUTHENTICATION_FAILED', 'DISCONNECTED'].includes(this.state)) return false; this.retryCount = 0; this.launch(); return true }
  launch () { const gen = ++this.generation; clearTimeout(this.timer); this.setState('INITIALIZING'); this.manager.enqueue(() => { if (this.generation === gen) this.connect(gen).catch(err => { if (this.generation === gen) { const [code, permanent] = classify(err.message); this.fail(code, err.message, permanent) } }) }) }
  async connect (gen) {
    this.setState('CHECKING_SERVER'); this.log('info', 'Resolving and checking server')
    await this.manager.waitForCooldown(() => gen === this.generation); if (gen !== this.generation) return
    const status = await this.manager.serverStatus(); if (gen !== this.generation) return
    this.server = { version: status.version?.name, protocol: status.version?.protocol, latency: status.latency ?? null }
    const protocolNum = status.version?.protocol
    const matching = mc.supportedVersions.find(v => require('minecraft-data')(v)?.version?.version === protocolNum)
    if (this.config.version === 'auto' && !matching) return this.fail('UNSUPPORTED_VERSION', `Server advertises ${status.version?.name} (protocol ${protocolNum}); no installed client protocol matches. Set MC_VERSION only if the server supports that client via ViaVersion/ViaBackwards.`, true)
    const version = this.config.version === 'auto' ? matching : this.config.version
    this.log('info', `Server ${status.version?.name} protocol ${protocolNum}; client ${version} protocol ${require('minecraft-data')(version).version.version}`)
    await this.manager.connectionSlot(() => gen === this.generation); if (gen !== this.generation) return
    this.setState('CONNECTING')
    const bot = this.manager.createBot({ host: this.config.host, port: this.config.port, username: this.name, auth: this.config.auth, version, logErrors: false, profilesFolder: path.join(this.config.dataDir, 'microsoft', this.name), onMsaCode: data => { if (gen === this.generation) this.manager.deviceLogin(`[${this.name}] Microsoft device login: ${data.message}`) } })
    this.bot = bot; const pendingPrompts = []; if (typeof bot.loadPlugin === 'function') bot.loadPlugin(pathfinder); this.authState = 'OFFLINE'; this.session = new AuthSession(this, this.manager.store)
    this.watchdog = setTimeout(() => { if (gen === this.generation) this.fail('CONNECTION_TIMEOUT', 'Login or world spawn timed out.', false) }, this.config.timeout)
    bot.once('login', () => { if (gen !== this.generation) return; if (this.config.auth === 'microsoft' && bot.username && bot.username.toLowerCase() !== this.name.toLowerCase()) return this.fail('AUTH_FAILED', `Microsoft profile name ${bot.username} does not match configured bot ${this.name}. Use the account owning this name.`, true); this.setState('LOGGED_IN'); this.log('info', 'Minecraft login successful; waiting for spawn'); this.setState('SPAWNING') })
    bot.once('spawn', () => { if (gen !== this.generation) return; clearTimeout(this.watchdog); this.connectedAt = Date.now(); this.stats.connections++; this.lastError = null; this.setState('CONNECTED'); this.log('success', 'BOT SUCCESSFULLY JOINED THE SERVER (world spawn)'); this.session.start(); for (const text of pendingPrompts.splice(0)) { if (gen !== this.generation) break; try { this.session.message(text) } catch (err) { this.fail('AUTH_FAILED', `Authentication state error: ${err.message}`, true); break } } if (gen === this.generation) this.stableTimer = setTimeout(() => { if (gen === this.generation) this.maybeResetRetries() }, this.config.stableTime) })
    bot.on('messagestr', (text) => { if (gen !== this.generation) return; if (this.state !== 'CONNECTED' && typeof text === 'string' && (this.config.patterns.register.test(text) || this.config.patterns.login.test(text))) { pendingPrompts.push(text); if (pendingPrompts.length > 5) pendingPrompts.shift() } try { this.session.message(text) } catch (err) { this.fail('AUTH_FAILED', `Authentication state error: ${err.message}`, true); return } const clean = this.manager.logger.clean(text); if (/\/(register|login)\b/i.test(text) || (this.config.password && text.includes(this.config.password))) return; this.addChat('server', clean) })
    bot.inventory?.on?.('updateSlot', () => { if (gen === this.generation) { this.work.health(); this.survival.schedule() } })
    bot.on('windowClose', () => { if (gen === this.generation) { this.work.health(); this.survival.schedule() } })
    bot.on('health', () => { if (gen === this.generation) { this.update(); this.work.health() } })
    bot.on('kicked', reason => { if (gen !== this.generation) return; const message = typeof reason === 'string' ? reason : JSON.stringify(reason); const [code, permanent] = classify(message); this.fail(code === 'UNEXPECTED_DISCONNECT' ? 'KICKED' : code, message, permanent, true) })
    bot.on('error', err => { if (gen !== this.generation) return; const [code, permanent] = classify(err.message); this.fail(code, err.message, permanent, true) })
    bot.once('end', reason => { if (gen === this.generation) { const message = String(reason || 'Connection ended'); const [code, permanent] = classify(message); this.fail(code, message, permanent, true) } })
    this.setState('AUTHENTICATING')
  }
  maybeResetRetries () { if (this.state === 'CONNECTED' && this.connectedAt && Date.now() - this.connectedAt >= this.config.stableTime && ['AUTHENTICATED', 'DISABLED'].includes(this.authState) && this.retryCount) { this.retryCount = 0; this.log('info', 'Connection stable and authenticated; retry backoff reset'); this.update() } }
  fail (code, message, permanent, connectionDead = false) {
    const previousAuth = this.authState; const shortConnection = this.connectedAt && Date.now() - this.connectedAt < this.config.stableTime
    this.lastError = `${code}: ${this.manager.logger.clean(message)}`
    this.log('error', this.lastError + (code === 'WHITELIST_REJECTED' ? ' Ask the administrator to whitelist this account.' : ''))
    if (code === 'CONNECTION_RESET') this.log('warning', `The connection was reset without a detailed kick reason${shortConnection ? ` shortly after spawn (plugin auth: ${previousAuth})` : ''}. Check the Aternos server log, login plugin, proxy and protocol compatibility.`)
    if (code === 'CONNECTION_THROTTLED') { this.manager.applyCooldown(this.config.throttleCooldown); this.log('warning', `Server requested slower connections; all bot attempts are paused for at least ${this.config.throttleCooldown / 1000}s.`) }
    this.cleanup(connectionDead); if (code === 'AUTH_FAILED') this.authState = 'FAILED'; this.setState(permanent ? (code === 'AUTH_FAILED' ? 'AUTHENTICATION_FAILED' : 'ERROR') : 'DISCONNECTED')
    if (!permanent && this.config.retry && (!this.config.attempts || this.retryCount < this.config.attempts)) {
      let delay = Math.min(this.config.max, this.config.initial * 2 ** Math.min(this.retryCount, 30)); if (code === 'CONNECTION_THROTTLED') delay = Math.max(delay, this.config.throttleCooldown)
      this.retryCount++; this.setState('RECONNECTING'); this.log('warning', `Retry ${this.retryCount} in at least ${delay}ms`); this.timer = setTimeout(() => this.launch(), delay)
    }
  }
  cleanup (connectionDead = false) {
    this.survival.reset(); this.work.stop(true, !connectionDead); ++this.generation; this.manager.cancelInvalid(); clearTimeout(this.timer); clearTimeout(this.watchdog); clearTimeout(this.stableTimer); this.session?.stop()
    if (this.bot) { this.stats.disconnections++; const b = this.bot; this.bot = null; try { b.clearControlStates(); if (connectionDead && b._client?.socket) b._client.socket.destroy(); else if (!connectionDead) b.quit() } catch {} }
    this.connectedAt = null; this.authState = 'OFFLINE'
  }
  stop () { this.cleanup(); this.setState('STOPPED') }
  reconnect () { this.stop(); this.start() }
  addChat (source, text) { this.chatHistory.push({ source, text: this.manager.logger.clean(text), time: Date.now() }); if (this.chatHistory.length > 100) this.chatHistory.shift(); this.update() }
  chat (message) { if (this.state !== 'CONNECTED' || !['AUTHENTICATED', 'DISABLED'].includes(this.authState)) throw new Error('Bot is not connected and authenticated'); if (typeof message !== 'string' || !message.trim() || message.length > 256 || /[\r\n]/.test(message) || message.trim().startsWith('/')) throw new Error('Chat must be 1–256 characters and cannot be a command'); if (this.config.password && message.includes(this.config.password)) throw new Error('Chat cannot contain the configured password'); if (Date.now() - this.lastChat < 2000) throw new Error('Chat rate limit: wait two seconds'); this.bot.chat(message); this.lastChat = Date.now(); this.addChat('operator', message) }
  movement (control, value) { if (value && this.work.active) throw new Error('Stop the work task before manual movement'); if (this.state !== 'CONNECTED' || !['AUTHENTICATED', 'DISABLED'].includes(this.authState)) throw new Error('Bot is not connected and authenticated'); if (!['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(control) || typeof value !== 'boolean') throw new Error('Invalid movement'); this.bot.setControlState(control, value) }
  stopMovement () { if (!this.work.active) this.bot?.clearControlStates() }
}
class Manager {
  constructor (config, logger, createBot = mineflayer.createBot) { this.config = config; this.logger = logger; this.createBot = createBot; this.deviceLogin = message => console.log(message); this.resolve = dns.lookup; this.ping = mc.ping; this.statusCache = null; this.statusPromise = null; this.store = new AuthStore(config.dataDir); this.controllers = new Map(config.names.map(n => [n, new Controller(this, n)])); this.queue = []; this.queueTimer = null; this.lastAttempt = 0; this.nextConnection = 0; this.cooldownUntil = 0; this.slotQueue = []; this.slotTimer = null; this.cooldownWaiters = new Map(); this.listeners = new Set(); this.startedAt = Date.now(); this.closed = false; this.team = new TeamManager(this); this.positionTimer = setInterval(() => this.emit(), 2000); this.positionTimer.unref() }
  enqueue (fn) { this.queue.push(fn); this.drain() }
  drain () { if (this.queueTimer || !this.queue.length || this.closed) return; const wait = Math.max(0, this.config.delay - (Date.now() - this.lastAttempt)); this.queueTimer = setTimeout(() => { this.queueTimer = null; const fn = this.queue.shift(); this.lastAttempt = Date.now(); fn(); this.drain() }, wait) }
  async serverStatus () {
    if (this.statusCache && Date.now() < this.statusCache.until) { if (this.statusCache.error) throw this.statusCache.error; return this.statusCache.value }
    if (!this.statusPromise) {
      const promise = (async () => { await this.resolve(this.config.host); return this.ping({ host: this.config.host, port: this.config.port, closeTimeout: this.config.timeout, noPongTimeout: 2000 }) })()
      this.statusPromise = promise
      promise.then(value => { this.statusCache = { value, until: Date.now() + 30000 }; if (this.statusPromise === promise) this.statusPromise = null }, error => { this.statusCache = { error, until: Date.now() + 5000 }; if (this.statusPromise === promise) this.statusPromise = null })
    }
    return this.statusPromise
  }
  async waitForCooldown (valid) {
    while (!this.closed && valid() && Date.now() < this.cooldownUntil) {
      await new Promise(resolve => { const timer = setTimeout(() => { this.cooldownWaiters.delete(timer); resolve() }, this.cooldownUntil - Date.now()); this.cooldownWaiters.set(timer, { resolve, valid }) })
    }
  }
  connectionSlot (valid = () => true) {
    if (this.closed || !valid()) return Promise.resolve()
    return new Promise(resolve => { this.slotQueue.push({ resolve, valid }); this.scheduleSlots() })
  }
  scheduleSlots () {
    if (this.closed || this.slotTimer || !this.slotQueue.length) return
    const wait = Math.max(0, Math.max(this.nextConnection, this.cooldownUntil) - Date.now())
    this.slotTimer = setTimeout(() => {
      this.slotTimer = null
      while (this.slotQueue.length && !this.slotQueue[0].valid()) this.slotQueue.shift().resolve()
      if (this.slotQueue.length) { this.nextConnection = Date.now() + this.config.delay; this.slotQueue.shift().resolve() }
      this.scheduleSlots()
    }, wait)
  }
  cancelInvalid () {
    this.slotQueue = this.slotQueue.filter(waiter => { if (waiter.valid()) return true; waiter.resolve(); return false })
    for (const [timer, waiter] of this.cooldownWaiters) { if (!waiter.valid()) { clearTimeout(timer); this.cooldownWaiters.delete(timer); waiter.resolve() } }
    if (!this.slotQueue.length) { clearTimeout(this.slotTimer); this.slotTimer = null }
  }
  applyCooldown (duration) { this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + duration); clearTimeout(this.slotTimer); this.slotTimer = null; this.scheduleSlots() }
  emit () { for (const fn of this.listeners) fn() }
  snapshot () { return { server: `${this.config.host}:${this.config.port}`, uptime: Date.now() - this.startedAt, team: this.team.snapshot(), bots: [...this.controllers.values()].map(c => c.snapshot()) } }
  all (action) { for (const c of this.controllers.values()) { if (action === 'start') c.start(); else if (action === 'stop') c.stop(); else if (action === 'reconnect' || action === 'restart') c.reconnect() } }
  shutdown () { this.team.stop(); this.closed = true; clearTimeout(this.queueTimer); clearInterval(this.positionTimer); this.queue = []; clearTimeout(this.slotTimer); for (const waiter of this.slotQueue) waiter.resolve(); this.slotQueue = []; for (const [timer, waiter] of this.cooldownWaiters) { clearTimeout(timer); waiter.resolve() } this.cooldownWaiters.clear(); this.all('stop') }
}
module.exports = { Manager, Controller, classify }
