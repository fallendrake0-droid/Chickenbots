'use strict'
const { excavation, matches } = require('./work')
const crypto = require('crypto')

// Preview is a bounded observation, not an authorization to bypass server protections.
function observe (manager, target, from, to) {
  const controller = target === 'all' ? manager.team.intel.elect() : manager.controllers.get(target)
  if (!controller || !controller.work.ready()) throw new Error('A connected, ready bot is required for the preview')
  const bot = controller.bot
  if (!bot.pathfinder || !bot.entity?.position || bot.game?.dimension == null) throw new Error('Known dimension, position and pathfinder required')
  const positions = excavation(from, to, bot.entity.position)
  const counts = { eligible: 0, excluded: 0, unloaded: 0, hazards: 0 }
  const blocks = positions.map(pos => {
    const block = bot.blockAt(pos)
    if (!block) { counts.unloaded++; return [pos.x, pos.y, pos.z, null] }
    const eligible = matches('excavate', block)
    const hazard = eligible ? controller.work.oreSafety(bot, pos) : null
    if (eligible) { counts.eligible++; if (hazard) counts.hazards++ } else counts.excluded++
    let state = null; try { state = block.stateId ?? null } catch {}
    return [pos.x, pos.y, pos.z, block.name, !!block.diggable, state, hazard]
  })
  const binding = { target, from, to, coordinator: controller.name, dimension: bot.game.dimension, position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }, blocks }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex')
  return { fingerprint, summary: { target, anchor: controller.name, dimension: bot.game.dimension, from, to, volume: positions.length, ...counts, observedAt: Date.now() } }
}
module.exports = { observe }
