'use strict'
const { excavation, matches, MAX_RANGE } = require('./work')
const NEARBY_PER_BOT = 32
const key = pos => `${pos.x},${pos.y},${pos.z}`
class TeamJob {
  constructor (manager, type, workers, positions, excluded, dimension) {
    this.manager = manager; this.type = type; this.dimension = dimension; this.workers = new Set(workers); this.members = workers.map(w => w.c.name); this.excluded = excluded; this.queue = positions.map(pos => ({ pos })); this.claims = new Map(); this.waiters = new Map(); this.total = positions.length; this.done = 0; this.skipped = 0; this.errors = []; this.state = 'RUNNING'
  }
  snapshot () { return { state: this.state, type: this.type, members: this.members, excluded: this.excluded, total: this.total, done: this.done, skipped: this.skipped, remaining: this.queue.length, inProgress: this.claims.size, errors: this.errors } }
  update () { this.manager.emit() }
  claim (worker, bot) { return new Promise(resolve => { if (this.state !== 'RUNNING' || !this.workers.has(worker)) return resolve(null); this.waiters.set(worker, { bot, resolve }); this.drain() }) }
  drain () {
    if (this.state !== 'RUNNING') return
    for (const [worker, waiting] of this.waiters) {
      const index = this.queue.findIndex(item => waiting.bot.entity?.position && waiting.bot.game?.dimension === this.dimension && item.pos.distanceTo(waiting.bot.entity.position) <= MAX_RANGE && waiting.bot.blockAt(item.pos) != null)
      if (index < 0) continue
      const lease = this.queue.splice(index, 1)[0]; this.claims.set(worker, lease); this.waiters.delete(worker); waiting.resolve(lease)
    }
    if (this.claims.size === 0 && this.waiters.size === this.workers.size) {
      if (this.queue.length) { this.skipped += this.queue.length; this.errors.push(`${this.queue.length} positions were out of range or unloaded for available workers`); this.queue = [] }
      this.finish(this.errors.length || this.skipped ? 'PARTIAL' : 'COMPLETED')
    } else this.update()
  }
  report (worker, lease, dug) { if (this.state !== 'RUNNING' || this.claims.get(worker) !== lease) return; this.claims.delete(worker); if (dug) this.done++; else this.skipped++; this.drain() }
  leave (worker, reason) {
    if (!this.workers.has(worker)) return
    this.workers.delete(worker); const waiting = this.waiters.get(worker); this.waiters.delete(worker); if (waiting) waiting.resolve(null)
    const lease = this.claims.get(worker); this.claims.delete(worker)
    if (lease && (this.state === 'RUNNING' || this.state === 'STOPPED')) this.queue.push(lease)
    if (this.state === 'RUNNING') {
      this.errors.push(`${worker.c.name}: ${this.manager.logger.clean(reason)}`)
      if (!this.workers.size) { this.finish('FAILED'); return }
      this.drain()
    } else this.update()
  }
  finish (state) { this.state = state; for (const { resolve } of this.waiters.values()) resolve(null); this.waiters.clear(); this.manager.logger.log('TEAM', state === 'COMPLETED' ? 'success' : 'warning', `${this.type}: ${state} (${this.done}/${this.total} actions completed)`); this.update() }
  stop () { if (this.state !== 'RUNNING') return; this.state = 'STOPPED'; for (const worker of [...this.workers]) worker.stop(); for (const { resolve } of this.waiters.values()) resolve(null); this.waiters.clear(); this.manager.logger.log('TEAM', 'info', 'Team work stopped'); this.update() }
}
class TeamManager {
  constructor (manager) { this.manager = manager; this.job = null }
  snapshot () { return this.job ? this.job.snapshot() : { state: 'IDLE', type: null, members: [], excluded: [], total: 0, done: 0, skipped: 0, remaining: 0, inProgress: 0, errors: [] } }
  start (type, args = {}) {
    if (this.job?.state === 'RUNNING') throw new Error('A team task is already running')
    if (!['trees', 'stone', 'dirt', 'excavate'].includes(type)) throw new Error('Invalid work type')
    const all = [...this.manager.controllers.values()]; const connected = all.filter(c => c.work.ready())
    if (!connected.length) throw new Error('No connected and authenticated bots available')
    if (connected.some(c => c.work.active || c.work.eatAction || c.survival?.busy)) throw new Error('Stop individual work and wait for eating to finish before starting team work')
    const first = connected.find(c => c.bot.pathfinder && c.bot.entity?.position && c.bot.game?.dimension != null)
    if (!first) throw new Error('No bot has a known dimension, position and pathfinder')
    const dimension = first.bot.game.dimension
    const selected = connected.filter(c => c.bot.pathfinder && c.bot.entity?.position && c.bot.game?.dimension === dimension)
    const excluded = all.filter(c => !selected.includes(c)).map(c => c.name)
    let positions
    if (type === 'excavate') positions = excavation(args.from, args.to, first.bot.entity.position)
    else { const unique = new Map(); for (const c of selected) for (const p of c.bot.findBlocks({ matching: block => matches(type, block), maxDistance: 16, count: NEARBY_PER_BOT })) unique.set(key(p), p); positions = [...unique.values()]; if (!positions.length) throw new Error(`No matching ${type} blocks found near the available bots`) }
    const job = new TeamJob(this.manager, type, selected.map(c => c.work), positions, excluded, dimension); this.job = job
    this.manager.logger.log('TEAM', 'info', `Starting ${type} with ${selected.length} bot(s), ${positions.length} candidate blocks`)
    for (const c of selected) { try { c.work.startTeam(job) } catch (err) { job.leave(c.work, err.message) } }
    this.manager.emit()
  }
  stop () { this.job?.stop() }
}
module.exports = { TeamManager, TeamJob }
