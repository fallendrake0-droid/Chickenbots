'use strict'
const { goals } = require('mineflayer-pathfinder')
const SAFE_ITEMS = new Set(['dirt','cobblestone','stone','granite','diorite','andesite','sand','gravel','torch','oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log','oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks'])
const MAX_DISTANCE = 64
const FOLLOW_MS = 5 * 60 * 1000
class PlayerActions {
  constructor (c) { this.c = c; this.active = null; this.operation = null; this.timer = null; this.task = {state:'IDLE', type:null, target:null, message:''} }
  busy () { return !!(this.active || this.operation) }
  snapshot () {
    const bot = this.c.work.ready(); const entries = bot?.players || {}
    const players = Object.entries(entries).filter(([name]) => /^[A-Za-z0-9_]{1,16}$/.test(name)).map(([name, p]) => ({ name, visible: !!p?.entity?.position })).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,256)
    return { ...this.task, players, busy:this.busy(), droppable: bot?.inventory?.items?.().filter(i => SAFE_ITEMS.has(i.name)).map(i => ({name:i.name,count:i.count})).slice(0,36) || [] }
  }
  target (name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('Invalid player name')
    const bot = this.c.work.ready(); if (!bot) throw new Error('Bot must be connected and authenticated')
    if (name.toLowerCase() === this.c.name.toLowerCase()) throw new Error('A bot cannot target itself')
    const player = bot.players?.[name]; const entity = player?.entity
    if (!entity?.position || !bot.entity?.position || typeof bot.entity.position.distanceTo !== 'function') throw new Error('Player is not visible to this bot')
    const distance = bot.entity.position.distanceTo(entity.position); if (!Number.isFinite(distance) || distance > MAX_DISTANCE) throw new Error('Player is too far away')
    return { bot, entity, distance }
  }
  available () {
    if (this.busy() || this.c.work.active || this.c.work.eatAction || this.c.survival.busy || this.c.bot?.currentWindow) throw new Error('Bot is busy; stop its current action first')
    if (this.c.manager.team.job?.state === 'RUNNING') throw new Error('Stop the team task before player actions')
  }
  follow (name) {
    const {bot, entity} = this.target(name); this.available()
    if (!bot.pathfinder || !bot.entity?.position) throw new Error('Pathfinder unavailable')
    bot.clearControlStates?.()
    this.c.work.prepare(bot)
    this.active = {bot, entity, name, until:Date.now()+FOLLOW_MS}; this.task = {state:'RUNNING', type:'follow', target:name, message:'Following visible player; stops after five minutes'}
    try { bot.pathfinder.setGoal(new goals.GoalFollow(entity, 3), true) } catch (err) { this.active = null; this.task.state='FAILED'; throw err }
    const onPath = result => { if (this.active?.bot === bot && result?.status === 'noPath') this.stop('No path to player') }; this.active.onPath = onPath; bot.on?.('path_update', onPath)
    this.c.log('info', `Following ${name} for up to five minutes`); this.c.update(); this.monitor()
  }
  monitor () {
    const active = this.active; if (!active) return
    const { bot, name, entity, until } = active
    let reason = null
    if (bot.isAlive === false) reason = 'Bot died'
    else if (this.c.bot !== bot || !this.c.work.ready()) reason = 'Bot disconnected or no longer authenticated'
    else if (bot.players?.[name]?.entity !== entity || !entity.position) reason = 'Player is no longer visible'
    else if (!bot.entity?.position || !Number.isFinite(bot.entity.position.distanceTo(entity.position)) || bot.entity.position.distanceTo(entity.position) > MAX_DISTANCE) reason = 'Player is too far away or position unavailable'
    else if (Date.now() >= until) reason = 'Follow time limit reached'
    else if ((typeof bot.health === 'number' && bot.health <= 6) || (this.c.work.autoEat && typeof bot.food === 'number' && bot.food <= 6)) reason = 'Stopped for critical health or hunger'
    if (reason) { this.stop(reason); return }
    this.timer = setTimeout(() => { this.timer = null; this.monitor() }, 1000); this.timer.unref?.()
  }
  drop (name, itemName, count) {
    const {bot, entity, distance} = this.target(name); this.available()
    if (distance > 3) throw new Error('Player must be within 3 blocks to receive items')
    if (typeof itemName !== 'string' || !SAFE_ITEMS.has(itemName)) throw new Error('Item is not in the safe handoff list')
    if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error('Count must be an integer from 1 to 64')
    if (typeof bot.transfer !== 'function' || typeof bot.lookAt !== 'function' || bot.inventory?.selectedItem) throw new Error('Item handoff unavailable')
    const item = bot.inventory?.items?.().find(i => i.name === itemName && i.count >= count && !i.nbt && !i.componentMap?.size)
    if (!item) throw new Error('One unmodified inventory stack must contain the requested quantity')
    const action = {bot, name}; this.operation = action; this.task = {state:'RUNNING',type:'drop',target:name,message:'Preparing item handoff'}; this.c.update()
    const run = async () => {
      await bot.lookAt(entity.position.offset(0, 1, 0), true)
      if (this.operation !== action || action.cancelled || this.c.bot !== bot || !this.c.work.ready() || bot.players?.[name]?.entity !== entity || bot.entity.position.distanceTo(entity.position) > 3) throw new Error('Handoff cancelled or player moved away')
      const current = bot.inventory.items().find(i => i.slot === item.slot && i.name === itemName && i.type === item.type && i.count >= count && !i.nbt && !i.componentMap?.size)
      if (!current) throw new Error('Inventory changed before handoff')
      action.sending = true; await bot.transfer({ window:bot.inventory, itemType:current.type, metadata:current.metadata, count, nbt:current.nbt, sourceStart:current.slot, sourceEnd:current.slot + 1, destStart:-999, destEnd:-998 })
      if (this.operation !== action || this.c.bot !== bot) return
      if (action.cancelled) { this.task = {state:'STOPPED',type:'drop',target:name,message:'Stopped during handoff; check inventory and ground for the outcome'}; return }
      this.task = {state:'COMPLETED',type:'drop',target:name,message:`Toss action completed for ${count} ${itemName}; pickup is not verified`}; this.c.log('info', this.task.message)
    }
    action.timeout = setTimeout(() => { if (this.operation === action) { action.cancelled = true; this.task = {state:'FAILED',type:'drop',target:name,message:'Handoff timed out; waiting for the inventory action to settle'}; this.c.update() } }, 15000); action.timeout.unref?.()
    run().catch(err => { if (this.operation === action) { this.task = {state:action.cancelled ? 'STOPPED' : 'FAILED',type:'drop',target:name,message:this.c.manager.logger.clean(err.message)}; this.c.log('warning', `Player handoff: ${err.message}`) } }).finally(() => { clearTimeout(action.timeout); if (this.operation === action) { this.operation = null; this.c.update(); this.c.work.health(); this.c.survival.schedule() } })
  }
  stop (reason = 'Stopped by operator', disconnected = false) {
    clearTimeout(this.timer); this.timer = null
    const active = this.active; this.active = null
    if (active) { active.bot.removeListener?.('path_update', active.onPath); if (!disconnected && this.c.bot === active.bot) { try { active.bot.pathfinder.setGoal(null); active.bot.clearControlStates() } catch {} } this.task = {state:'STOPPED',type:'follow',target:active.name,message:reason}; this.c.log('info', `Player follow stopped: ${reason}`) }
    if (this.operation) { const action = this.operation; action.cancelled = true; this.task = {state:'STOPPED',type:'drop',target:action.name,message:action.sending ? 'Stop requested; handoff in progress, outcome unknown' : reason}; if (disconnected) { clearTimeout(action.timeout); this.operation = null } }
    this.c.update(); if (!disconnected && !this.busy()) { this.c.work.health(); this.c.survival.schedule() }
  }
}
function playerCommand (manager, botName, command, args = {}) {
  if (botName === 'all') {
    if (!['follow', 'stop'].includes(command)) throw new Error('Only follow and stop support all bots')
    if (command === 'follow' && (typeof args.player !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(args.player))) throw new Error('Invalid player name')
    const started = []; const skipped = []
    for (const c of manager.controllers.values()) {
      try {
        if (command === 'stop') { if (c.playerActions.active) { c.playerActions.stop(); started.push(c.name) } continue }
        const active = c.playerActions.active
        if (active?.name === args.player) { started.push(c.name); continue }
        // Validate the new target before stopping an existing follow.
        c.playerActions.target(args.player)
        if (active) c.playerActions.stop('Following a different player')
        c.playerActions.follow(args.player)
        if (c.playerActions.active) started.push(c.name)
        else skipped.push(`${c.name}: ${manager.logger.clean(c.playerActions.task.message)}`)
      } catch (err) { skipped.push(`${c.name}: ${manager.logger.clean(err.message)}`) }
    }
    return { started, skipped }
  }
  const c = manager.controllers.get(botName); if (!c) throw new Error('Invalid bot')
  if (command === 'follow') c.playerActions.follow(args.player)
  else if (command === 'drop') c.playerActions.drop(args.player, args.item, args.count)
  else if (command === 'stop') c.playerActions.stop()
  else throw new Error('Invalid player action')
}
module.exports = { PlayerActions, playerCommand, SAFE_ITEMS }
