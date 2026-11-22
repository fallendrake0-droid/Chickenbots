'use strict'
const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const MAX_BLOCKS = 256
const MAX_RANGE = 48
const NEARBY_LIMIT = 32
const { chooseFood, validateFoodSettings } = require('./food')
const STONE = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite'])
const ORES = ['coal','copper','iron','gold','redstone','lapis','diamond','emerald']
const ORE_TYPES = new Set(ORES.map(name => `ore_${name}`))
const DIRT = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud'])
function isLog (name) { return /(^|_)(log|wood|stem|hyphae)$/.test(name) }
function matches (type, block) { if (!block || typeof block.name !== 'string' || !block.diggable) return false; if (ORE_TYPES.has(type)) { const ore = type.slice(4); return block.name === `${ore}_ore` || block.name === `deepslate_${ore}_ore` } if (type === 'trees') return isLog(block.name); if (type === 'stone') return STONE.has(block.name); if (type === 'dirt') return DIRT.has(block.name); if (type === 'excavate') return STONE.has(block.name) || DIRT.has(block.name) || isLog(block.name) || ['sand', 'red_sand', 'gravel', 'clay'].includes(block.name) || /_ore$/.test(block.name); return false }
function point (input) { if (!input || typeof input !== 'object') throw new Error('Provide both coordinate corners'); const keys = ['x', 'y', 'z']; for (const k of keys) if (!Number.isSafeInteger(input[k]) || Math.abs(input[k]) > 30000000 || (k === 'y' && (input[k] < -2048 || input[k] > 2048))) throw new Error('Coordinates must be valid integer block positions'); return new Vec3(input.x, input.y, input.z) }
function excavation (from, to, position) {
  const a = point(from); const b = point(to); const low = new Vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)); const high = new Vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)); const volume = (high.x - low.x + 1) * (high.y - low.y + 1) * (high.z - low.z + 1)
  if (volume > MAX_BLOCKS) throw new Error(`Excavation is limited to ${MAX_BLOCKS} blocks`)
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite) || a.distanceTo(position) > MAX_RANGE || b.distanceTo(position) > MAX_RANGE) throw new Error(`Both corners must be within ${MAX_RANGE} blocks of the bot`)
  const positions = []; for (let y = high.y; y >= low.y; y--) for (let x = low.x; x <= high.x; x++) for (let z = low.z; z <= high.z; z++) positions.push(new Vec3(x, y, z)); return positions
}
class Work {
  constructor (controller) { this.c = controller; this.oreTimeoutMs = 30000; this.createMovements = bot => new Movements(bot); this.autoEat = true; this.foodSettings = { threshold: 14, reserve: 0, priority: 'balanced' }; this.foodReason = null; this.active = null; this.eatAction = null; this.generation = 0; this.lastEat = 0; this.lastFoodWarning = 0; this.eatTimer = null; this.task = { state: 'IDLE', type: null, done: 0, total: 0, message: '' } }
  ready () { return this.c.state === 'CONNECTED' && ['AUTHENTICATED', 'DISABLED'].includes(this.c.authState) && this.c.bot }
  snapshot () { return { ...this.task, autoEat: this.autoEat, eating: !!this.eatAction, foodSettings: { ...this.foodSettings }, foodReason: this.foodReason } }
  setAutoEat (enabled) { if (typeof enabled !== 'boolean') throw new Error('Auto-eat must be true or false'); this.autoEat = enabled; if (!enabled) { clearTimeout(this.eatTimer); this.eatTimer = null; try { this.c.bot?.deactivateItem?.() } catch {} } this.c.update(); if (enabled) this.health() }
  setFoodSettings (settings) { this.foodSettings = validateFoodSettings(settings); this.c.update(); this.health() }
  foodCandidate () { return chooseFood(this.c.bot, this.foodSettings) }
  health () { if (!this.autoEat || !this.ready() || this.active || this.eatAction || this.c.survival?.busy || this.c.playerActions?.busy() || this.c.bot.currentWindow || this.c.bot.food == null || this.c.bot.food > this.foodSettings.threshold || Date.now() - this.lastEat < 5000) return; const bot = this.c.bot; const generation = this.generation; const action = {}; this.eatAction = action; this.c.update(); this.eat(bot, generation).catch(err => { if (this.generation === generation) this.c.log('warning', `Auto-eat: ${err.message}`) }).finally(() => { if (this.eatAction === action) { this.eatAction = null; this.c.update(); this.scheduleEat(); this.c.survival?.schedule() } }) }
  scheduleEat () { clearTimeout(this.eatTimer); this.eatTimer = null; if (this.autoEat && this.ready() && !this.active && this.c.bot.food != null && this.c.bot.food <= this.foodSettings.threshold) { this.eatTimer = setTimeout(() => { this.eatTimer = null; this.health() }, 5500); this.eatTimer.unref?.() } }
  async eat (bot, generation) {
    if (!this.autoEat || bot.food == null || bot.food > this.foodSettings.threshold || Date.now() - this.lastEat < 5000) return
    this.lastEat = Date.now(); const selection = chooseFood(bot, this.foodSettings); const food = selection.item; this.foodReason = selection.reason; this.c.update()
    if (!food) { if (Date.now() - this.lastFoodWarning > 30000) { this.c.log('warning', `Auto-eat: ${selection.reason}`); this.lastFoodWarning = Date.now() } return }
    await bot.equip(food, 'hand'); this.check(bot, generation); if (!this.autoEat) return; await bot.consume(); this.check(bot, generation); this.c.log('info', `Auto-eat: consumed ${food.name}`)
  }
  check (bot, generation) { if (generation !== this.generation || this.c.bot !== bot || !this.ready() || (this.active?.team && bot.game?.dimension !== this.active.team.dimension)) throw new Error('Task cancelled or bot disconnected') }
  start (type, args = {}) {
    const bot = this.ready(); if (!bot) throw new Error('Bot must be connected and authenticated'); if (this.active || this.eatAction || this.c.survival?.busy || this.c.playerActions?.busy()) throw new Error('Bot is already busy'); if (!['trees', 'stone', 'dirt', 'excavate'].includes(type) && !ORE_TYPES.has(type)) throw new Error('Invalid work type'); if (!bot.pathfinder || !bot.entity?.position) throw new Error('Pathfinder or bot position unavailable')
    let positions
    if (type === 'excavate') positions = excavation(args.from, args.to, bot.entity.position)
    else { positions = bot.findBlocks({ matching: block => matches(type, block), maxDistance: type === 'trees' ? 16 : MAX_RANGE, count: NEARBY_LIMIT }); if (!positions.length) throw new Error(`No matching ${type} blocks found nearby`) }
    this.active = { bot, generation: this.generation }; this.task = { state: 'RUNNING', type, done: 0, total: positions.length, message: 'Starting' }; this.c.log('info', `Starting ${type} task (${positions.length} candidate blocks)`); this.c.update()
    const active = this.active
    this.run(bot, active.generation, type, positions).catch(err => { if (this.active === active && this.generation === active.generation) { this.task.state = 'FAILED'; this.task.message = this.c.manager.logger.clean(err.message); this.c.log('warning', `${type}: ${err.message}`) } }).finally(async () => { if (active.timedOutAction) await active.timedOutAction.catch(() => {}); if (this.active === active) { this.active = null; this.c.update(); this.health(); this.c.survival?.schedule() } })
  }
  prepare (bot) {
    const movement = this.createMovements(bot); movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.allowSprinting = false; movement.scafoldingBlocks = []; bot.pathfinder.setMovements(movement); bot.pathfinder.searchRadius = MAX_RANGE
  }
  async oreAction (bot, label, action) {
    let timer
    const active = this.active; const pending = Promise.resolve().then(() => { if (active) this.check(bot, active.generation); return action() }); if (active) { active.inFlight = pending; pending.then(() => { if (active.inFlight === pending) active.inFlight = null }, () => { if (active.inFlight === pending) active.inFlight = null }) }
    const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => { if (active && this.active === active) active.timedOutAction = pending; try { bot.pathfinder?.setGoal(null); bot.stopDigging?.() } catch {} reject(new Error(`${label} timed out; cancellation requested`)) }, this.oreTimeoutMs); timer.unref?.() })
    try { return await Promise.race([pending, timeout]) } finally { clearTimeout(timer) }
  }
  oreSafety (bot, pos) {
    if (typeof bot.health === 'number' && bot.health <= 8) return 'Low health'
    if (typeof bot.food === 'number' && bot.food <= 6) return 'Critical hunger'
    if (typeof bot.inventory?.emptySlotCount === 'function' && bot.inventory.emptySlotCount() === 0) return 'Inventory has no empty slot'
    const offsets = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    for (const [x,y,z] of offsets) {
      const block = bot.blockAt(pos.offset(x,y,z)); if (!block || typeof block.name !== 'string') return 'Adjacent terrain is not loaded'
      let properties = {}; try { properties = block.getProperties?.() || {} } catch { return 'Adjacent block state unavailable' }
      if (['lava','water','bubble_column'].includes(block.name) || properties.waterlogged === true || properties.waterlogged === 'true') return `Adjacent liquid at ${pos.x+x}, ${pos.y+y}, ${pos.z+z}`
      if (y === 1 && (['sand','red_sand','gravel','anvil','chipped_anvil','damaged_anvil','suspicious_sand','suspicious_gravel','dragon_egg'].includes(block.name) || /_concrete_powder$/.test(block.name))) return 'Falling block above ore'
    }
    return null
  }
  async digOne (bot, generation, type, pos) {
    this.check(bot, generation); await this.eat(bot, generation); this.check(bot, generation)
    const hazardousWork = ORE_TYPES.has(type) || type === 'excavate'
    const isSupport = () => { const feet = bot.entity.position.floored(); return pos.x === feet.x && pos.z === feet.z && (pos.y === feet.y || pos.y === feet.y - 1) }
    if (isSupport()) return false
    let block = bot.blockAt(pos); if (!matches(type, block)) return false
    if (!bot.canDigBlock(block)) { this.task.message = `Moving to ${pos.x}, ${pos.y}, ${pos.z}`; this.c.update(); await this.oreAction(bot, 'Work navigation', () => bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3))); this.check(bot, generation); block = bot.blockAt(pos); if (!matches(type, block)) return false }
    if (!bot.canDigBlock(block) || isSupport()) return false
    if (hazardousWork) { const reason = this.oreSafety(bot, pos); if (reason) { this.task.message = `Skipped ${block.name}: ${reason}`; this.c.log('warning', this.task.message); return false } }
    const tool = bot.pathfinder.bestHarvestTool(block)
    const oreBlock = ORE_TYPES.has(type) || (type === 'excavate' && /_ore$/.test(block.name))
    if (oreBlock && (!block.harvestTools || !Object.keys(block.harvestTools).length)) throw new Error(`Harvest requirements unavailable for ${block.name}`)
    if (block.harvestTools && (!tool || !block.harvestTools[tool.type])) throw new Error(`No suitable tool to harvest ${block.name}`)
    if (tool && oreBlock) { let used; try { used = tool.durabilityUsed } catch {} const max = tool.maxDurability ?? bot.registry?.itemsByName?.[tool.name]?.maxDurability; if (Number.isFinite(max) && Number.isFinite(used) && max - used <= Math.max(1, max * 0.05)) throw new Error(`Tool ${tool.name} is nearly broken`) }
    if (tool) { await bot.equip(tool, 'hand'); this.check(bot, generation) }
    if (hazardousWork) { const reason = this.oreSafety(bot, pos); if (reason) { this.c.log('warning', `Skipped ${block.name}: ${reason}`); return false } block = bot.blockAt(pos); if (!matches(type, block) || !bot.canDigBlock(block)) return false }
    this.task.message = `Digging ${block.name} at ${pos.x}, ${pos.y}, ${pos.z}`; this.c.update(); await this.oreAction(bot, 'Work digging', () => bot.dig(block, true, 'raycast')); this.check(bot, generation); if (oreBlock) { const after = bot.blockAt(pos); if (!after || after.name === block.name) throw new Error(`Local block state did not change after digging ${block.name}`) } return true
  }
  async run (bot, generation, type, positions) {
    this.prepare(bot); let skipped = 0
    for (const pos of positions) { if (await this.digOne(bot, generation, type, pos)) this.task.done++; else skipped++; this.c.update() }
    this.task.state = skipped ? 'PARTIAL' : 'COMPLETED'; this.task.message = `Finished: ${this.task.done} dig actions completed, ${skipped} skipped`; this.c.log(this.task.state === 'PARTIAL' ? 'warning' : 'success', `${type}: ${this.task.message}${ORE_TYPES.has(type) ? ' (client-predicted; drops not verified)' : ''}`)
  }
  startTeam (team) {
    const bot = this.ready(); if (!bot || this.active || this.eatAction || this.c.survival?.busy || this.c.playerActions?.busy() || !bot.pathfinder || !bot.entity?.position) throw new Error(`${this.c.name} is not available for work`)
    const active = { bot, generation: this.generation, team }; this.active = active
    this.task = { state: 'RUNNING', type: team.type, done: 0, total: team.total, message: 'Team task: waiting for an assignment' }; this.c.update()
    this.runTeam(bot, active.generation, team).catch(err => {
      if (this.active === active && this.generation === active.generation) { this.task.state = 'FAILED'; this.task.message = this.c.manager.logger.clean(err.message); this.c.log('warning', `Team ${team.type}: ${err.message}`); team.leave(this, err.message, !!active.timedOutAction) }
    }).finally(async () => { if (active.timedOutAction) await active.timedOutAction.catch(() => {}); if (this.active === active) { this.active = null; this.c.update(); this.health(); this.c.survival?.schedule() } })
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
    if (bot && (active || this.eatAction)) { try { if (networkAvailable) { bot.pathfinder?.setGoal(null); bot.stopDigging?.(); if (bot.usingHeldItem || this.eatAction) bot.deactivateItem?.() } else bot.emit?.('path_stop'); bot.clearControlStates?.() } catch {} }
    // Keep a cancelled task busy until its in-flight action settles; disconnected bots are discarded.
    if (active?.team) active.team.leave(this, 'Stopped or disconnected', !!active.inFlight)
    if (discard) { this.active = null; this.eatAction = null }
    this.c.update()
  }
}
module.exports = { Work, matches, excavation, MAX_BLOCKS, MAX_RANGE, ORES, ORE_TYPES }
