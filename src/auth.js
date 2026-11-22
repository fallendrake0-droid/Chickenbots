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
  start () { if (!this.c.config.enabled) { this.c.authState = 'DISABLED'; this.c.update(); this.c.authConfirmed?.(); this.c.work?.health(); this.c.survival?.schedule(); return } this.c.authState = 'WAITING_FOR_PROMPT'; this.c.log('info', this.c.config.pluginAuthMode === 'login' ? 'Sending one login command and waiting for server confirmation' : 'Waiting for the server registration or login prompt'); this.c.update(); this.timer = setTimeout(() => this.fail('Authentication prompt or confirmation timed out; check plugin patterns.'), this.c.config.authTimeout); if (this.c.config.pluginAuthMode === 'login') { try { this.send('login') } catch (err) { this.fail(`Could not send authentication command: ${this.c.manager.logger.clean(err.message)}`) } } }
  stop () { clearTimeout(this.timer) }
  fail (message) { this.stop(); this.c.authState = 'FAILED'; this.c.fail('AUTH_FAILED', message, true) }
  message (text) {
    if (!this.c.config.enabled || !['WAITING_FOR_PROMPT', 'AUTHENTICATING'].includes(this.c.authState)) return
    const p = this.c.config.patterns; const name = this.c.name
    if (this.sent === 'login' && this.c.config.pluginAuthMode === 'login' && p.register.test(text) && !p.registered.test(text) && !p.success.test(text)) return this.fail('Server requested registration; login-only mode will not register. Register the account with administrator approval or use prompt mode.')
    if (p.invalid?.test(text) && this.sent) return this.fail('Server rejected or cannot process the authentication command; check the plugin configuration.')
    if (p.incorrect.test(text) && this.sent === 'login') return this.fail('Server rejected the plugin password. Check BOT_AUTH_PASSWORD and server account settings.')
    if (p.already.test(text) && this.sent === 'register') { this.store.save(name, true); this.sent = null; return this.send('login') }
    if (this.sent === 'register' && p.registered.test(text)) { this.store.save(name, true); return this.success() }
    if (this.sent === 'login' && p.success.test(text)) { this.store.save(name, true); return this.success() }
    if (this.sent || p.success.test(text) || p.registered.test(text) || p.incorrect.test(text) || p.already.test(text) || p.invalid?.test(text)) return
    if (p.register.test(text)) return this.send('register')
    if (p.login.test(text)) return this.send('login')
  }
  send (type) { if (!this.c.bot || this.c.state !== 'CONNECTED') return; this.sent = type; this.c.authState = 'AUTHENTICATING'; this.c.log('info', `Server authentication: ${type} requested`); const pass = this.c.config.password; this.c.bot.chat(type === 'register' ? `/register ${pass}${this.c.config.registerConfirm ? ` ${pass}` : ''}` : `/login ${pass}`); this.c.update() }
  success () { this.stop(); this.c.authState = 'AUTHENTICATED'; this.c.log('success', 'Server authentication confirmed'); this.c.update(); this.c.authConfirmed?.(); this.c.work?.health(); this.c.survival?.schedule() }
}
module.exports = { AuthStore, AuthSession }
