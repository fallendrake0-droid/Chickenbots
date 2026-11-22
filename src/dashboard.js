'use strict'
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const path = require('path')
function dashboard (manager) {
  const app = express(); const server = http.createServer(app); const port = manager.config.dashboardPort
  const allowedHost = host => host === `127.0.0.1:${port}` || host === `localhost:${port}`
  const validOrigin = origin => { try { const u = new URL(origin); return u.protocol === 'http:' && allowedHost(u.host) } catch { return false } }
  app.use((req, res, next) => { if (!allowedHost(req.headers.host)) return res.sendStatus(403); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"); next() })
  app.use(express.static(path.join(__dirname, '..', 'public')))
  const io = new Server(server, { allowRequest: (req, cb) => cb(null, allowedHost(req.headers.host) && validOrigin(req.headers.origin)), maxHttpBufferSize: 4096 })
  let pending = false
  const broadcast = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; io.emit('snapshot', manager.snapshot()) }, 100) }
  manager.listeners.add(broadcast)
  io.on('connection', socket => {
    socket.emit('snapshot', manager.snapshot()); let requests = []; const held = new Map()
    socket.on('action', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {}; const now = Date.now(); requests = requests.filter(t => now - t < 10000); if (requests.length >= 50) return reply({ error: 'Rate limit exceeded' }); requests.push(now)
      try {
        if (!data || typeof data !== 'object' || typeof data.action !== 'string') throw new Error('Invalid request')
        const targets = data.bot === 'all' ? [...manager.controllers.values()] : [manager.controllers.get(data.bot)]; if (targets.some(c => !c)) throw new Error('Invalid bot')
        if (['start', 'stop', 'restart', 'reconnect'].includes(data.action)) { for (const c of targets) { if (data.action === 'start') c.start(); else if (data.action === 'stop') c.stop(); else c.reconnect() } }
        else if (data.action === 'suspendReconnect') { for (const c of targets) c.suspendReconnect() }
        else if (data.action === 'player:action') { const result = require('./players').playerCommand(manager, data.bot, data.command, {player:data.player, item:data.item, count:data.count}); if (data.bot === 'all') return reply({ok:true, ...result}) }
        else if (data.action === 'chat') { const errors = []; for (const c of targets) { try { c.chat(data.message) } catch (e) { errors.push(`${c.name}: ${e.message}`) } } if (errors.length) throw new Error(errors.join('; ')) }
        else if (data.action === 'work:start' && data.bot !== 'all') { if (manager.team.job?.state === 'RUNNING') throw new Error('Stop the team task before starting individual work'); targets[0].work.start(data.type, { from: data.from, to: data.to }) }
        else if (data.action === 'work:stop' && data.bot !== 'all') targets[0].work.stop()
        else if (data.action === 'work:autoEat') { if (typeof data.enabled !== 'boolean') throw new Error('Auto-eat must be true or false'); for (const c of targets) c.work.setAutoEat(data.enabled) }
        else if (data.action === 'survival:armour') { if (typeof data.enabled !== 'boolean') throw new Error('Auto armour must be true or false'); for (const c of targets) c.survival.setAutoArmour(data.enabled) }
        else if (data.action === 'survival:food') { const { validateFoodSettings } = require('./food'); const settings = validateFoodSettings(data.settings); for (const c of targets) c.work.setFoodSettings(settings) }
        else if (data.action === 'team:start' && data.bot === 'all') manager.team.start(data.type, { from: data.from, to: data.to })
        else if (data.action === 'team:stop' && data.bot === 'all') manager.team.stop()
        else if (data.action === 'movement' && data.bot !== 'all') { const c = targets[0]; c.movement(data.control, data.value); const key = `${c.name}:${data.control}`; clearTimeout(held.get(key)); if (data.value) held.set(key, setTimeout(() => { held.delete(key); try { c.movement(data.control, false) } catch {} }, 10000)); else held.delete(key) }
        else if (data.action === 'stopMovement') { for (const c of targets) c.stopMovement(); for (const [key, timer] of held) { if (data.bot === 'all' || key.startsWith(data.bot + ':')) { clearTimeout(timer); held.delete(key) } } }
        else throw new Error('Invalid action')
        reply({ ok: true })
      } catch (err) { reply({ error: manager.logger.clean(err.message) }) }
    })
    socket.on('disconnect', () => { for (const [key, timer] of held) { clearTimeout(timer); const [name, control] = key.split(':'); try { manager.controllers.get(name)?.movement(control, false) } catch {} } })
  })
  return { server, io, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, manager.config.dashboardHost, resolve) }), close: () => new Promise(resolve => { manager.listeners.delete(broadcast); io.close(() => resolve()) }) }
}
module.exports = dashboard
