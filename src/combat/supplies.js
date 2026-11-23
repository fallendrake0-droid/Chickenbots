'use strict';

const { FOODS } = require('../world/items');
const { POTION_EFFECTS, BOSS_MOBS } = require('./constants');
const { profileFor } = require('./mobs');

const GOLDEN_APPLES = new Set(['golden_apple', 'enchanted_golden_apple']);
const HARMFUL_EFFECTS = new Set(['poison', 'wither', 'slowness', 'weakness', 'blindness', 'nausea', 'mining_fatigue', 'hunger', 'levitation', 'darkness']);
const USEFUL_FOODS = Object.entries(FOODS)
  .filter(([name]) => !GOLDEN_APPLES.has(name))
  .map(([name, data]) => ({ name, ...data }));

function normalizeEffect(effect) {
  const key = String(effect || '').toLowerCase().replace(/[\s-]+/g, '_');
  for (const [name, data] of Object.entries(POTION_EFFECTS)) {
    if (name === key || (data.aliases || []).includes(key)) return name;
  }
  return null;
}

/**
 * Parse vanilla potion item names and optional metadata. No hidden effect is
 * inferred when a name/metadata pair is unrecognised.
 */
function parsePotion(name, meta = {}) {
  const lower = String(name || '').toLowerCase();
  if (!/potion/.test(lower) && lower !== 'milk_bucket') return null;
  if (lower === 'milk_bucket') return { name, kind: 'milk', effect: 'milk', milk: true };
  const kind = lower.startsWith('splash_') ? 'splash' : lower.startsWith('lingering_') ? 'lingering' : 'drink';
  const effectText = lower.replace(/^(splash_|lingering_)/, '').replace(/^potion_of_/, '').replace(/^potion_/, '').replace(/_potion$/, '');
  let effect = normalizeEffect(meta.effect || effectText);
  if (!effect) {
    const alias = Object.entries(POTION_EFFECTS).find(([, data]) => (data.aliases || []).some((entry) => effectText.includes(entry)));
    if (alias) effect = alias[0];
  }
  if (!effect) return { name, kind, effect: effectText || 'unknown', unknown: true, duration: Number(meta.duration) || 0 };
  const data = POTION_EFFECTS[effect] || {};
  return {
    name, kind, effect, unknown: false,
    instant: Boolean(data.instant),
    health: data.health || 0,
    duration: Number(meta.duration) || data.duration || 0,
    amplifier: Number(meta.amplifier) || (String(meta.level || '').includes('strong') || effectText.includes('strong') ? 1 : 0),
    harmful: Boolean(data.harmful),
    aliases: data.aliases || []
  };
}

function potionsIn(inventory, meta = {}) {
  const out = [];
  for (const [name, count] of Object.entries(inventory || {})) {
    if (!count || count <= 0) continue;
    const parsed = parsePotion(name, meta[name] || {});
    if (parsed) out.push({ ...parsed, count });
  }
  return out;
}

function activeEffect(bot, effect) {
  const effects = (bot && bot.effects) || {};
  if (effects[effect] === undefined) return null;
  const value = effects[effect];
  return typeof value === 'object' ? value : { level: Number(value) || 1, duration: 0 };
}

function chooseFood({ inventory = {}, health = 20, food = 20, saturation = 5, threat = null, allowEnchanted = false, emergency = false } = {}) {
  const profile = threat ? profileFor(threat) : null;
  const critical = health <= 8 || emergency;
  const inDanger = Boolean(profile && !profile.neutral);
  if (critical && inventory.enchanted_golden_apple > 0 && allowEnchanted) {
    return { ok: true, name: 'enchanted_golden_apple', kind: 'emergency', reason: 'critical health: enchanted golden apple reserved for this emergency' };
  }
  if (critical && inventory.golden_apple > 0) {
    return { ok: true, name: 'golden_apple', kind: 'emergency', reason: 'critical health: instant regeneration and absorption' };
  }
  if (inDanger && health <= 14 && inventory.golden_apple > 0) {
    return { ok: true, name: 'golden_apple', kind: 'boss', reason: 'combat recovery: instant regeneration and absorption' };
  }
  if (food < 20) {
    const safe = USEFUL_FOODS
      .filter((entry) => inventory[entry.name] > 0)
      .filter((entry) => !entry.risk || (critical && food <= 6))
      .map((entry) => ({ ...entry, score: entry.hunger + entry.saturation * 0.5 - (entry.risk ? 4 : 0) }))
      .sort((a, b) => b.score - a.score);
    if (safe.length) return { ok: true, name: safe[0].name, kind: 'food', reason: `hunger ${food}; best safe food` };
  }
  if (inventory.golden_apple > 0 && health <= 16 && !inDanger) {
    return { ok: true, name: 'golden_apple', kind: 'recovery', reason: 'post-combat recovery' };
  }
  return { ok: false, error: 'no suitable food or healing item', hungry: food < 20, health };
}

async function consumeItem(bot, name, { before = null } = {}) {
  if (!bot || typeof bot.consume !== 'function') return { ok: false, error: 'adapter cannot consume items' };
  const prior = before || { health: bot.health, food: bot.food, effects: { ...(bot.effects || {}) } };
  const priorCount = typeof bot.countItem === 'function' ? bot.countItem(name) : null;
  let result;
  try {
    result = await bot.consume(name);
  } catch (err) {
    return { ok: false, error: err.message, item: name };
  }
  const afterCount = typeof bot.countItem === 'function' ? bot.countItem(name) : null;
  const consumed = priorCount === null ? Boolean(result && result.ok !== false) : afterCount < priorCount;
  return {
    ...result,
    item: name,
    consumed,
    before: prior,
    after: { health: bot.health, food: bot.food, effects: { ...(bot.effects || {}) } },
    healthGained: Number((bot.health - prior.health).toFixed(2)),
    foodGained: Number((bot.food - prior.food).toFixed(2)),
    effectsGained: Object.keys(bot.effects || {}).filter((effect) => !prior.effects[effect])
  };
}

/**
 * Choose a potion for the current situation. Duplicate effects are refused
 * unless the active version is weaker; splash healing is only for explicit
 * team mode where a target is supplied.
 */
function choosePotion({ inventory = {}, meta = {}, bot = null, health = 20, threat = null, teamMode = false, teamNeeds = 0, harmfulEffects = [] } = {}) {
  const potions = potionsIn(inventory, meta);
  const profile = threat ? profileFor(threat) : null;
  const critical = health <= 8;
  const boss = Boolean(profile && profile.boss);
  const dangerous = Boolean(profile && !profile.neutral);
  const candidates = [];
  for (const potion of potions) {
    if (potion.unknown || potion.harmful) continue;
    if (potion.kind === 'splash' && !teamMode && potion.instant) continue;
    const active = bot ? activeEffect(bot, potion.effect) : null;
    if (active && !potion.instant) {
      const activeLevel = Number(active.level || active.amplifier || 1);
      if (activeLevel >= (potion.amplifier + 1)) continue;
    }
    let priority = 0;
    let reason = '';
    if (potion.effect === 'strong_healing' || potion.effect === 'healing') {
      if (critical || health <= 12) { priority = 95; reason = 'instant healing'; }
    } else if (potion.effect === 'regeneration') {
      if (dangerous && health <= 16) { priority = 80; reason = 'regeneration during combat'; }
    } else if (potion.effect === 'absorption') {
      if (dangerous && (boss || health >= 14)) { priority = 60; reason = 'absorption before engagement'; }
    } else if (potion.effect === 'resistance') {
      if (boss || (dangerous && health <= 14)) { priority = 70; reason = 'damage reduction'; }
    } else if (potion.effect === 'fire_resistance') {
      if (profile && (profile.fire || profile.explosive)) { priority = 65; reason = 'fire/explosion protection'; }
    } else if (potion.effect === 'strength') {
      if (dangerous) { priority = 45; reason = 'offensive preparation'; }
    } else if (potion.effect === 'swiftness') {
      if (dangerous) { priority = 40; reason = 'speed and repositioning'; }
    } else if (potion.effect === 'slow_falling') {
      if (profile && profile.flying) { priority = 55; reason = 'fall protection against aerial attacks'; }
    } else if (potion.effect === 'water_breathing') {
      if (profile && profile.aquatic) { priority = 65; reason = 'aquatic encounter'; }
    } else if (potion.effect === 'turtle_master') {
      if (boss && health <= 12) { priority = 60; reason = 'emergency resistance'; }
    }
    if (potion.kind === 'splash' && teamNeeds > 0 && potion.effect === 'healing') priority += 5;
    if (priority > 0) candidates.push({ ...potion, priority, reason });
  }
  const harmful = harmfulEffects.length ? harmfulEffects : bot ? Object.keys(bot.effects || {}).filter((effect) => HARMFUL_EFFECTS.has(effect)) : [];
  if (harmful.length && inventory.milk_bucket > 0 && !critical) {
    candidates.push({ name: 'milk_bucket', kind: 'milk', effect: 'milk', priority: 35, reason: `remove harmful effect(s): ${harmful.join(', ')}` });
  }
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates[0] || { ok: false, error: 'no situationally useful potion', potions };
}

async function usePotion(bot, choice) {
  if (!choice || !choice.name) return { ok: false, error: 'no potion selected' };
  return consumeItem(bot, choice.name);
}

function suppliesStatus({ inventory = {}, meta = {}, bot = null } = {}) {
  return {
    food: USEFUL_FOODS.filter((entry) => inventory[entry.name] > 0).map((entry) => ({ name: entry.name, count: inventory[entry.name] })),
    goldenApples: Number(inventory.golden_apple || 0),
    enchantedGoldenApples: Number(inventory.enchanted_golden_apple || 0),
    potions: potionsIn(inventory, meta),
    harmfulEffects: bot ? Object.keys(bot.effects || {}).filter((effect) => HARMFUL_EFFECTS.has(effect)) : [],
    milk: Number(inventory.milk_bucket || 0)
  };
}

module.exports = {
  GOLDEN_APPLES, HARMFUL_EFFECTS, normalizeEffect, parsePotion, potionsIn, activeEffect,
  chooseFood, consumeItem, choosePotion, usePotion, suppliesStatus, BOSS_MOBS
};
