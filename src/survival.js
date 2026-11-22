'use strict'
// Conservative vanilla armour values. Unknown and specialised equipment is left alone.
const ARMOUR = {
  leather: { head:1, torso:3, legs:2, feet:1, toughness:0 },
  golden: { head:2, torso:5, legs:3, feet:1, toughness:0 },
  chainmail: { head:2, torso:5, legs:4, feet:1, toughness:0 },
  iron: { head:2, torso:6, legs:5, feet:2, toughness:0 },
  diamond: { head:3, torso:8, legs:6, feet:3, toughness:2 },
  netherite: { head:3, torso:8, legs:6, feet:3, toughness:3 }
}
const SLOTS = { head:'helmet', torso:'chestplate', legs:'leggings', feet:'boots' }
const HOSTILE = new Set(['zombie','skeleton','creeper','spider','cave_spider','witch','slime','drowned','husk','stray','pillager','vindicator','evoker','vex','ravager','phantom','warden'])
function enchants (item) {
  if (!item) return []
  try { const value = item.enchants; if (value == null) return item.nbt || item.componentMap?.has?.('enchantments') ? null : []; if (!Array.isArray(value)) return null; return value.map(e => ({ name: String(e.name || '').replace(/^minecraft:/,''), level: Number(e.lvl ?? e.level ?? 0) })) } catch { return null }
}
function armourInfo (item, slot, registry) {
  if (!item || typeof item.name !== 'string') return null
  const match = item.name.match(/^(leather|golden|chainmail|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/)
  if (!match || SLOTS[slot] !== match[2]) return null
  const ench = enchants(item); if (!ench || ench.some(e => !e.name || !Number.isFinite(e.level))) return null
  const max = item.maxDurability ?? registry?.itemsByName?.[item.name]?.maxDurability
  let used; try { used = item.durabilityUsed } catch { used = undefined }
  const remaining = Number.isFinite(max) && Number.isFinite(used) && max > 0 ? Math.max(0, Math.min(1, (max - used) / max)) : null
  const points = ARMOUR[match[1]][slot]; const toughness = ARMOUR[match[1]].toughness
  return { points, toughness, enchantments: ench, remaining }
}
function betterArmour (candidate, current, slot, registry) {
  const next = armourInfo(candidate, slot, registry); if (!next || (next.remaining != null && next.remaining <= 0.05)) return false
  if (!current) return true
  const old = armourInfo(current, slot, registry); if (!old) return false
  if (old.enchantments.some(e => e.name === 'binding_curse' || e.name === 'curse_of_binding')) return false
  // Never lose an existing enchantment, even if it is specialised or unfamiliar.
  if (old.enchantments.some(e => !next.enchantments.some(n => n.name === e.name && n.level >= e.level))) return false
  if (next.points < old.points || next.toughness < old.toughness) return false
  const oldProt = old.enchantments.find(e => e.name === 'protection')?.level || 0
  const newProt = next.enchantments.find(e => e.name === 'protection')?.level || 0
  return next.points > old.points || next.toughness > old.toughness || newProt > oldProt || (next.remaining != null && old.remaining != null && old.remaining <= 0.1 && next.remaining > old.remaining + 0.1)
}
class Survival {
  constructor (controller) { this.c = controller; this.autoArmour = true; this.busy = false; this.timer = null; this.generation = 0; this.lastError = null; this.retryAt = 0 }
  ready () { return !!this.c.work.ready() }
  setAutoArmour (value) { if (typeof value !== 'boolean') throw new Error('Auto armour must be true or false'); this.autoArmour = value; if (!value) { clearTimeout(this.timer); this.timer = null } else this.schedule(); this.c.update() }
  schedule (delay = 250) { if (!this.autoArmour || !this.ready() || this.timer) return; this.timer = setTimeout(() => { this.timer = null; void this.run().catch(err => { this.lastError = this.c.manager.logger.clean(err.message); this.c.log('warning', `Auto armour: ${this.lastError}`); this.c.update() }) }, delay); this.timer.unref?.() }
  async run () {
    const c = this.c; const bot = c.bot
    if (!this.autoArmour || !this.ready() || this.busy || c.work.active || c.work.eatAction || c.playerActions?.busy() || !bot?.inventory?.slots || !bot.getEquipmentDestSlot || bot.currentWindow) return
    if (Date.now() < this.retryAt) { this.schedule(this.retryAt - Date.now()); return }
    // Eating takes precedence over equipment transactions.
    if (c.work.autoEat && c.work.foodCandidate().item) { c.work.health(); return }
    let target
    for (const slot of Object.keys(SLOTS)) {
      const current = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
      const choices = (bot.inventory.items?.() || []).filter(item => item.slot >= 9 && item.slot <= 44 && betterArmour(item, current, slot, bot.registry))
      if (!choices.length) continue
      let best = choices[0]; for (const item of choices.slice(1)) if (betterArmour(item, best, slot, bot.registry)) best = item
      target = { item: best, slot }; break
    }
    if (!target) return
    const generation = this.generation; this.busy = true; this.c.update()
    try {
      await bot.equip(target.item, target.slot)
      if (this.generation !== generation || this.c.bot !== bot || !this.ready()) return
      const equipped = bot.inventory.slots[bot.getEquipmentDestSlot(target.slot)]
      if (!equipped || equipped.type !== target.item.type) throw new Error(`Server did not confirm ${target.slot} equipment`)
      this.lastError = null; this.c.log('info', `Auto armour: equipped ${target.item.name}`)
    } catch (err) { if (this.generation === generation) { this.lastError = this.c.manager.logger.clean(err.message); this.retryAt = Date.now() + 10000; this.c.log('warning', `Auto armour: ${this.lastError}`) } }
    finally { if (this.generation === generation) { this.busy = false; this.c.update(); c.work.health(); this.schedule(this.retryAt > Date.now() ? this.retryAt - Date.now() : 250) } }
  }
  reset () { this.generation++; clearTimeout(this.timer); this.timer = null; this.busy = false; this.retryAt = 0 }
  snapshot () {
    const bot = this.c.bot; const equipment = {}; const nearby = []
    if (this.ready() && bot?.inventory?.slots && bot.getEquipmentDestSlot) for (const slot of Object.keys(SLOTS)) { try { const item = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]; const info = armourInfo(item, slot, bot.registry); equipment[slot] = item ? { name:item.name, durability:info?.remaining ?? null, points:info?.points ?? null } : null } catch { equipment[slot] = null } }
    if (this.ready() && typeof bot?.entity?.position?.distanceTo === 'function' && bot.entities) for (const entity of Object.values(bot.entities)) { if (!entity?.name || !HOSTILE.has(entity.name) || !entity.position) continue; const distance = bot.entity.position.distanceTo(entity.position); if (distance <= 16) nearby.push({ name:entity.name, distance:Math.round(distance * 10) / 10 }) }
    nearby.sort((a,b) => a.distance - b.distance)
    return { autoArmour:this.autoArmour, busy:this.busy, equipment, threats:nearby.slice(0,10), lastError:this.lastError }
  }
}
module.exports = { Survival, armourInfo, betterArmour }
