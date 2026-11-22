'use strict'
const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const MAX_BLOCKS = 256
const MAX_RANGE = 48
const NEARBY_LIMIT = 32
const FOODS = new Set(['bread', 'baked_potato', 'carrot', 'golden_carrot', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'cooked_potato', 'pumpkin_pie', 'melon_slice', 'beetroot', 'dried_kelp', 'sweet_berries'])
const STONE = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite'])
const DIRT = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud'])
function isLog (name) { return /(^|_)(log|wood|stem|hyphae)$/.test(name) }
function matches (type, block) { if (!block || typeof block.name !== 'string' || !block.diggable) return false; if (type === 'trees') return isLog(block.name); if (type === 'stone') return STONE.has(block.name); if (type === 'dirt') return DIRT.has(block.name); if (type === 'excavate') return STONE.has(block.name) || DIRT.has(block.name) || isLog(block.name) || ['sand', 'red_sand', 'gravel', 'clay'].includes(block.name) || /_ore$/.test(block.name); return false }
function point (input) { if (!input || typeof input !== 'object') throw new Error('Provide both coordinate corners'); const keys = ['x', 'y', 'z']; for (const k of keys) if (!Number.isSafeInteger(input[k]) || Math.abs(input[k]) > 30000000 || (k === 'y' && (input[k] < -2048 || input[k] > 2048))) throw new Error('Coordinates must be valid integer block positions'); return new Vec3(input.x, input.y, input.z) }
function excavation (from, to, position) {
  const a = point(from); const b = point(to); const low = new Vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)); const high = new Vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)); const volume = (high.x - low.x + 1) * (high.y - low.y + 1) * (high.z - low.z + 1)
  if (volume > MAX_BLOCKS) throw new Error(`Excavation is limited to ${MAX_BLOCKS} blocks`)
  if (!position || a.distanceTo(position) > MAX_RANGE || b.distanceTo(position) > MAX_RANGE) throw new Error(`Both corners must be within ${MAX_RANGE} blocks of the bot`)
  const positions = []; for (let y = high.y; y >= low.y; y--) for (let x = low.x; x <= high.x; x++) for (let z = low.z; z <= high.z; z++) positions.push(new Vec3(x, y, z)); return positions
}
class Work {
  constructor (controller) { this.c = controller; this.createMovements = bot => new Movements(bot); this.autoEat = true; this.active = null; this.eatAction = null; this.generation = 0; this.lastEat = 0; this.lastFoodWarning = 0; this.eatTimer = null; this.task = { state: 'IDLE', type: null, done: 0, total: 0, message: '' } }
  ready () { return this.c.state === 'CONNECTED' && ['AUTHENTICATED', 'DISABLED'].includes(this.c.authState) && this.c.bot }
  snapshot () { return { ...this.task, autoEat: this.autoEat, eating: !!this.eatAction } }
  setAutoEat (enabled) { if (typeof enabled !== 'boolean') throw new Error('Auto-eat must be true or false'); this.autoEat = enabled; if (!enabled) { clearTimeout(this.eatTimer); this.eatTimer = null; try { this.c.bot?.deactivateItem?.() } catch {} } this.c.update(); if (enabled) this.health() }
  health () { if (!this.autoEat || !this.ready() || this.active || this.eatAction || this.c.bot.food == null || this.c.bot.food > 14 || Date.now() - this.lastEat < 5000) return; const bot = this.c.bot; const generation = this.generation; const action = {}; this.eatAction = action; this.c.update(); this.eat(bot, generation).catch(err => { if (this.generation === generation) this.c.log('warning', `Auto-eat: ${err.message}`) }).finally(() => { if (this.eatAction === action) { this.eatAction = null; this.c.update(); this.scheduleEat() } }) }
  scheduleEat () { clearTimeout(this.eatTimer); this.eatTimer = null; if (this.autoEat && this.ready() && !this.active && this.c.bot.food != null && this.c.bot.food <= 14) { this.eatTimer = setTimeout(() => { this.eatTimer = null; this.health() }, 5500); this.eatTimer.unref?.() } }
  async eat (bot, generation) {
    if (!this.autoEat || bot.food == null || bot.food > 14 || Date.now() - this.lastEat < 5000) return
    this.lastEat = Date.now(); const food = bot.inventory.items().find(item => FOODS.has(item.name))
    if (!food) { if (Date.now() - this.lastFoodWarning > 30000) { this.c.log('warning', 'Auto-eat: no suitable food in inventory'); this.lastFoodWarning = Date.now() } return }
    await bot.equip(food, 'hand'); this.check(bot, generation); if (!this.autoEat) return; await bot.consume(); this.check(bot, generation); this.c.log('info', `Auto-eat: consumed ${food.name}`)
  }
  check (bot, generation) { if (generation !== this.generation || this.c.bot !== bot || !this.ready() || (this.active?.team && bot.game?.dimension !== this.active.team.dimension)) throw new Error('Task cancelled or bot disconnected') }
  start (type, args = {}) {
    const bot = this.ready(); if (!bot) throw new Error('Bot must be connected and authenticated'); if (this.active || this.eatAction) throw new Error('Bot is already busy'); if (!['trees', 'stone', 'dirt', 'excavate'].includes(type)) throw new Error('Invalid work type'); if (!bot.pathfinder || !bot.entity?.position) throw new Error('Pathfinder or bot position unavailable')
    let positions
    if (type === 'excavate') positions = excavation(args.from, args.to, bot.entity.position)
    else { positions = bot.findBlocks({ matching: block => matches(type, block), maxDistance: 16, count: NEARBY_LIMIT }); if (!positions.length) throw new Error(`No matching ${type} blocks found nearby`) }
    this.active = { bot, generation: this.generation }; this.task = { state: 'RUNNING', type, done: 0, total: positions.length, message: 'Starting' }; this.c.log('info', `Starting ${type} task (${positions.length} candidate blocks)`); this.c.update()
    const active = this.active
    this.run(bot, active.generation, type, positions).catch(err => { if (this.active === active && this.generation === active.generation) { this.task.state = 'FAILED'; this.task.message = this.c.manager.logger.clean(err.message); this.c.log('warning', `${type}: ${err.message}`) } }).finally(() => { if (this.active === active) { this.active = null; this.c.update(); this.health() } })
  }
  prepare (bot) {
    const movement = this.createMovements(bot); movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.scafoldingBlocks = []; bot.pathfinder.setMovements(movement); bot.pathfinder.searchRadius = MAX_RANGE
  }
  async digOne (bot, generation, type, pos) {
    this.check(bot, generation); await this.eat(bot, generation); this.check(bot, generation)
    const isSupport = () => { const feet = bot.entity.position.floored(); return pos.x === feet.x && pos.z === feet.z && (pos.y === feet.y || pos.y === feet.y - 1) }
    if (isSupport()) return false
    let block = bot.blockAt(pos); if (!matches(type, block)) return false
    if (!bot.canDigBlock(block)) { this.task.message = `Moving to ${pos.x}, ${pos.y}, ${pos.z}`; this.c.update(); await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)); this.check(bot, generation); block = bot.blockAt(pos); if (!matches(type, block)) return false }
    if (!bot.canDigBlock(block) || isSupport()) return false
    const tool = bot.pathfinder.bestHarvestTool(block)
    if (block.harvestTools && (!tool || !block.harvestTools[tool.type])) throw new Error(`No suitable tool to harvest ${block.name}`)
    if (tool) { await bot.equip(tool, 'hand'); this.check(bot, generation) }
    this.task.message = `Digging ${block.name} at ${pos.x}, ${pos.y}, ${pos.z}`; this.c.update(); await bot.dig(block, true, 'raycast'); this.check(bot, generation); return true
  }
  async run (bot, generation, type, positions) {
    this.prepare(bot); let skipped = 0
    for (const pos of positions) { if (await this.digOne(bot, generation, type, pos)) this.task.done++; else skipped++; this.c.update() }
    this.task.state = 'COMPLETED'; this.task.message = `Finished: ${this.task.done} dig actions completed, ${skipped} skipped`; this.c.log('success', `${type}: ${this.task.message}`)
  }
  startTeam (team) {
    const bot = this.ready(); if (!bot || this.active || this.eatAction || !bot.pathfinder || !bot.entity?.position) throw new Error(`${this.c.name} is not available for work`)
    const active = { bot, generation: this.generation, team }; this.active = active
    this.task = { state: 'RUNNING', type: team.type, done: 0, total: team.total, message: 'Team task: waiting for an assignment' }; this.c.update()
    this.runTeam(bot, active.generation, team).catch(err => {
      if (this.active === active && this.generation === active.generation) { this.task.state = 'FAILED'; this.task.message = this.c.manager.logger.clean(err.message); this.c.log('warning', `Team ${team.type}: ${err.message}`); team.leave(this, err.message) }
    }).finally(() => { if (this.active === active) { this.active = null; this.c.update(); this.health() } })
  }
  async runTeam (bot, generation, team) {
    this.prepare(bot)
    while (true) {
      this.check(bot, generation)
      const lease = await team.claim(this, bot)
      this.check(bot, generation)
      if (!lease) break
      const dug = await this.digOne(bot, generation, team.type, lease.pos)
      this.check(bot, generation)
      if (dug) this.task.done++
      team.report(this, lease, dug); this.c.update()
    }
    this.task.state = 'COMPLETED'; this.task.message = `Team work finished: ${this.task.done} dig actions completed`
  }
  stop (discard = false, networkAvailable = true) {
    ++this.generation; clearTimeout(this.eatTimer); this.eatTimer = null; const active = this.active
    if (active || this.task.state === 'RUNNING') { this.task.state = 'STOPPED'; this.task.message = 'Stopped by operator or disconnect' }
    const bot = this.c.bot
    if (bot) { try { if (networkAvailable) { bot.pathfinder?.setGoal(null); bot.stopDigging?.(); if (bot.usingHeldItem || this.eatAction) bot.deactivateItem?.() } else bot.emit?.('path_stop'); bot.clearControlStates?.() } catch {} }
    // Keep a cancelled task busy until its in-flight action settles; disconnected bots are discarded.
    if (active?.team) active.team.leave(this, 'Stopped or disconnected')
    if (discard) { this.active = null; this.eatAction = null }
    this.c.update()
  }
}
module.exports = { Work, matches, excavation, MAX_BLOCKS, MAX_RANGE }
