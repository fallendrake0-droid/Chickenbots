'use strict'
// Explicit allowlist excludes raw meat, pufferfish, suspicious stew and rotten flesh.
// Values are vanilla food points and saturation; registry food points are used when present.
const FOOD = Object.freeze({ cooked_beef: [8,12.8,1], cooked_porkchop:[8,12.8,1], golden_carrot:[6,14.4,3], cooked_mutton:[6,9.6,1], cooked_chicken:[6,7.2,1], cooked_salmon:[6,9.6,1], cooked_cod:[5,6,1], bread:[5,6,0], baked_potato:[5,6,0], carrot:[3,3.6,0], apple:[4,2.4,0], cooked_rabbit:[5,6,1], pumpkin_pie:[8,4.8,1], melon_slice:[2,1.2,0], beetroot:[1,1.2,0], dried_kelp:[1,0.6,0], sweet_berries:[2,0.4,0] })
const PRIORITIES = ['balanced', 'saturation', 'cheap']
function chooseFood (bot, settings) {
  const food = Number(bot.food); if (!Number.isFinite(food) || food >= 20 || food > settings.threshold) return { item: null, reason: 'not hungry' }
  const items = bot.inventory?.items?.() || []
  const available = items.filter(item => FOOD[item.name] && Number(item.count ?? 1) > 0)
  if (!available.length) return { item: null, reason: 'no suitable food in inventory' }
  const count = available.reduce((sum, item) => sum + Number(item.count ?? 1), 0)
  if (count <= settings.reserve && food > 6) return { item: null, reason: 'food reserve protected' }
  const deficit = 20 - food
  const ranked = available.map(item => {
    const [fallback, saturation, cost] = FOOD[item.name]
    const registryPoints = bot.registry?.foodsByName?.[item.name]?.foodPoints
    const points = Number.isFinite(registryPoints) && registryPoints > 0 ? registryPoints : fallback
    const restored = Math.min(points, deficit); const waste = Math.max(0, points - deficit)
    // Expensive food is protected in balanced/cheap mode unless near starvation.
    const penalty = food <= 6 || settings.priority === 'saturation' ? 0 : cost * (settings.priority === 'cheap' ? 6 : 2)
    const score = restored * 2 + saturation * (settings.priority === 'saturation' ? 1 : 0.35) - waste * 2 - penalty
    return { item, score }
  }).sort((a,b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
  return { item: ranked[0].item, reason: null }
}
function validateFoodSettings (settings) {
  if (!settings || !Number.isInteger(settings.threshold) || settings.threshold < 0 || settings.threshold > 19) throw new Error('Hunger threshold must be an integer between 0 and 19')
  if (!Number.isInteger(settings.reserve) || settings.reserve < 0 || settings.reserve > 2304) throw new Error('Food reserve must be an integer between 0 and 2304')
  if (!PRIORITIES.includes(settings.priority)) throw new Error('Food priority must be balanced, saturation, or cheap')
  return { threshold: settings.threshold, reserve: settings.reserve, priority: settings.priority }
}
module.exports = { FOOD, PRIORITIES, chooseFood, validateFoodSettings }
