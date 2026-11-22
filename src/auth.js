'use strict'
const fs = require('fs')
const path = require('path')
class AuthStore {
  constructor (dir) { this.file = path.join(dir, 'auth-state.json'); this.data = {}; try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch (err) { if (err.code !== 'ENOENT') throw new Error(`Cannot read auth state: ${err.message}`) } }
  registered (name) { return this.data[name]?.registered === true }
  save (name, value) { this.data[name] = { registered: value }; fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file) }
}
class AuthSession {
  constructor (controller, store) { this.c = controller; this.store = store; this.sent = null; this.timer = null }
  start () { if (!this.c.config.enabled) { this.c.authState = 'DISABLED'; this.c.update(); return } this.c.authState = 'WAITING_FOR_PROMPT'; this.c.update(); this.timer = setTimeout(() => this.fail('Authentication prompt or confirmation timed out; check plugin patterns.'), this.c.config.authTimeout) }
  stop () { clearTimeout(this.timer) }
  fail (message) { this.stop(); this.c.authState = 'FAILED'; this.c.fail('AUTH_FAILED', message, true) }
  message (text) {
    if (!this.c.config.enabled || !['WAITING_FOR_PROMPT', 'AUTHENTICATING'].includes(this.c.authState)) return
    const p = this.c.config.patterns; const name = this.c.name
    if (p.incorrect.test(text)) return this.fail('Server rejected the plugin password. Check BOT_AUTH_PASSWORD and server account settings.')
    if (p.already.test(text) && this.sent === 'register') { this.store.save(name, true); this.sent = null; return this.send('login') }
    if (this.sent === 'register' && p.registered.test(text)) { this.store.save(name, true); return this.success() }
    if (this.sent === 'login' && p.success.test(text)) { this.store.save(name, true); return this.success() }
    if (this.sent) return
    if (p.register.test(text)) return this.send('register')
    if (p.login.test(text)) return this.send('login')
  }
  send (type) { if (!this.c.bot || this.c.state !== 'CONNECTED') return; this.sent = type; this.c.authState = 'AUTHENTICATING'; this.c.log('info', `Server authentication: ${type} requested`); const pass = this.c.config.password; this.c.bot.chat(type === 'register' ? `/register ${pass} ${pass}` : `/login ${pass}`); this.c.update() }
  success () { this.stop(); this.c.authState = 'AUTHENTICATED'; this.c.log('success', 'Server authentication confirmed'); this.c.update() }
}
module.exports = { AuthStore, AuthSession }
