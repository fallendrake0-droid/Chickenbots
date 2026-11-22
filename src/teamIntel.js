'use strict'
// This is an observation of individual client inventory caches, not shared storage.
class TeamIntel {
  constructor (manager) { this.manager = manager; this.coordinator = null }
  eligible (c) { const pos = c.bot?.entity?.position; return !!c.work.ready() && !!c.bot?.pathfinder && !!pos && [pos.x, pos.y, pos.z].every(Number.isFinite) && c.bot?.game?.dimension != null }
  elect () {
    const current = this.manager.controllers.get(this.coordinator)
    if (current && this.eligible(current)) return current
    const next = [...this.manager.controllers.values()].find(c => this.eligible(c)) || null
    this.coordinator = next?.name || null
    return next
  }
  snapshot () {
    const coordinator = this.elect(); const members = []; const counts = new Map(); const capturedAt = Date.now()
    for (const c of this.manager.controllers.values()) {
      if (!c.work.ready()) continue
      const bot = c.bot; const position = bot?.entity?.position
      let available = false; let items = []
      try {
        const observed = bot?.inventory?.items?.()
        if (Array.isArray(observed)) {
          available = true
          const perBot = new Map()
          for (const item of observed) {
            if (!item || typeof item.name !== 'string' || !/^[a-z0-9_]{1,100}$/.test(item.name) || !Number.isSafeInteger(item.count) || item.count <= 0 || item.count > 127) continue
            perBot.set(item.name, (perBot.get(item.name) || 0) + item.count)
          }
          items = [...perBot].sort(([a],[b]) => a.localeCompare(b)).map(([name,count]) => ({name,count}))
          for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + item.count)
        }
      } catch { available = false; items = [] }
      members.push({ name:c.name, dimension:bot?.game?.dimension ?? null, position:position && [position.x,position.y,position.z].every(Number.isFinite) ? {x:position.x,y:position.y,z:position.z} : null, health:Number.isFinite(bot?.health) ? bot.health : null, food:Number.isFinite(bot?.food) ? bot.food : null, inventoryAvailable:available, items })
    }
    const totals = [...counts].sort(([a],[b]) => a.localeCompare(b)).map(([name,count]) => ({name,count}))
    return { coordinator:coordinator?.name || null, capturedAt, members, totals }
  }
}
module.exports = { TeamIntel }
