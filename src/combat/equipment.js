'use strict';

const {
  SWORD_DAMAGE, AXE_DAMAGE, WEAPON_SPEED, WEAPON_REACH, DURABILITY,
  ARMOR_STATS, ARMOR_SLOTS, ARMOR_PIECE_SLOTS
} = require('./constants');
const { profileFor } = require('./mobs');

const SWORD_RE = /_sword$/;
const AXE_RE = /_axe$/;
const ARMOR_RE = /_(helmet|chestplate|leggings|boots)$/;
const RANGED_WEAPONS = new Set(['bow', 'crossbow', 'trident']);
const AMMO = { bow: 'arrow', crossbow: 'arrow', trident: null };

function itemMeta(meta, name) {
  return (meta && (meta[name] || meta.stacks?.[name])) || {};
}

function enchantLevel(meta, name) {
  // Accept either an item's enchantment map or a full item detail object.
  const enchants = (meta && (meta.enchantments || meta.enchants)) || meta || {};
  const level = enchants[name] ?? enchants[name.replace(/_/g, ' ')] ?? 0;
  return Number(level) || 0;
}

function durabilityOf(name, meta = {}) {
  const max = Number(meta.maxDurability) || DURABILITY[name] || 0;
  const remaining = meta.durability === undefined ? max : Number(meta.durability);
  return { remaining: Math.max(0, remaining), max, ratio: max ? Math.max(0, Math.min(1, remaining / max)) : 1 };
}

function weaponClass(name) {
  if (SWORD_RE.test(name)) return 'sword';
  if (AXE_RE.test(name)) return 'axe';
  if (name === 'mace') return 'mace';
  if (name === 'trident') return 'trident';
  if (name === 'bow') return 'bow';
  if (name === 'crossbow') return 'crossbow';
  return null;
}

function baseDamage(name) {
  if (SWORD_DAMAGE[name]) return SWORD_DAMAGE[name];
  if (AXE_DAMAGE[name]) return AXE_DAMAGE[name];
  if (name === 'trident') return 9;
  if (name === 'mace') return 6;
  return 1;
}

function damageEnchantBonus(meta, profile) {
  let bonus = 0;
  const sharp = enchantLevel(meta, 'sharpness');
  if (sharp) bonus += 0.5 * sharp + 0.5;
  if (profile && profile.undead) bonus += 2.5 * enchantLevel(meta, 'smite');
  if (profile && profile.arthropod) bonus += 2.5 * enchantLevel(meta, 'bane_of_arthropods');
  return bonus;
}

/**
 * Evaluate every usable weapon in the actual inventory. Target-specific
 * enchantments matter: Smite can beat Sharpness against undead and loses all
 * value against a player.
 */
function evaluateWeapons({ inventory = {}, meta = {}, target = null, hasArrow = null } = {}) {
  const profile = target ? profileFor(target) : null;
  const arrowCount = hasArrow === null ? Number(inventory.arrow || 0) : Number(hasArrow);
  const weapons = [];
  for (const [name, count] of Object.entries(inventory)) {
    if (!count || count <= 0) continue;
    const cls = weaponClass(name);
    if (!cls) continue;
    const detail = itemMeta(meta, name);
    const enchants = detail.enchantments || detail.enchants || {};
    const durability = durabilityOf(name, detail);
    const base = baseDamage(name);
    const bonus = damageEnchantBonus(enchants, profile);
    const speed = WEAPON_SPEED[cls] || 1;
    let effective = base + bonus;
    let available = true;
    let reason = '';
    if (cls === 'bow') {
      available = arrowCount > 0;
      effective = 6 + 0.5 * enchantLevel(enchants, 'power');
      reason = available ? 'ranged draw' : 'no arrows';
    } else if (cls === 'crossbow') {
      available = arrowCount > 0 || Number(inventory.firework_rocket || 0) > 0;
      effective = 7 + 0.5 * enchantLevel(enchants, 'power');
      reason = available ? 'loaded crossbow' : 'no ammunition';
    } else if (cls === 'trident') {
      available = true;
      reason = 'thrown or melee';
    } else if (cls === 'mace') {
      available = true;
      effective += 1.5 * enchantLevel(enchants, 'density');
      effective += 0.75 * enchantLevel(enchants, 'breach');
      reason = 'fall attack is situational; density/breach scored, wind burst is mobility';
    }
    const broken = durability.ratio <= 0.05;
    if (broken) available = false;
    if (durability.ratio < 0.25 && !broken) effective *= 0.9;
    const synergy = {
      fireAspect: enchantLevel(enchants, 'fire_aspect'),
      looting: enchantLevel(enchants, 'looting'),
      knockback: enchantLevel(enchants, 'knockback'),
      mending: enchantLevel(enchants, 'mending') > 0,
      unbreaking: enchantLevel(enchants, 'unbreaking'),
      sweeping: enchantLevel(enchants, 'sweeping_edge'),
      density: enchantLevel(enchants, 'density'),
      breach: enchantLevel(enchants, 'breach'),
      windBurst: enchantLevel(enchants, 'wind_burst'),
      quickCharge: enchantLevel(enchants, 'quick_charge'),
      piercing: enchantLevel(enchants, 'piercing'),
      multishot: enchantLevel(enchants, 'multishot')
    };
    let score = effective * speed;
    if (cls === 'axe' && target && target.blocking) score += 4;
    if (cls === 'crossbow') score += 0.35 * synergy.quickCharge + 0.2 * synergy.multishot + 0.1 * synergy.piercing;
    if (cls === 'bow') score += 0.15 * enchantLevel(enchants, 'power');
    if (profile && (profile.ranged || profile.explosive) && cls === 'bow') score += 2;
    if (!available) score = -Infinity;
    weapons.push({
      name, cls, count, baseDamage: base, enchantmentBonus: Number(bonus.toFixed(2)),
      effectiveDamage: Number(effective.toFixed(2)), attackSpeed: speed,
      dps: Number((effective * speed).toFixed(2)), score: Number(score.toFixed(2)),
      enchantments: { ...enchants }, synergy, durability, available, reason,
      reach: WEAPON_REACH[cls] || 3, ranged: RANGED_WEAPONS.has(name) || cls === 'bow' || cls === 'crossbow'
    });
  }
  return weapons.sort((a, b) => b.score - a.score);
}

function selectWeapon(options = {}) {
  const weapons = evaluateWeapons(options);
  const melee = weapons.filter((weapon) => !weapon.ranged && weapon.available);
  const ranged = weapons.filter((weapon) => weapon.ranged && weapon.available);
  const target = options.target || null;
  const profile = target ? profileFor(target) : null;
  const inReach = options.distance !== undefined ? options.distance <= (options.reach || 3.5) : true;
  const reaching = profile && (profile.ranged || profile.keepDistance) && !inReach;
  const choice = (reaching && ranged.length ? ranged[0] : null) || (melee[0] || ranged[0] || null);
  if (!choice) return { ok: false, error: 'no usable weapon', weapons };
  const lowDurability = melee.find((weapon) => weapon.durability.ratio > 0.05 && weapon.durability.ratio < 0.25);
  return {
    ok: true,
    weapon: choice,
    weapons,
    reason: choice.ranged ? `ranged ${choice.cls} at distance` : `${choice.cls} for ${profile ? profile.name : 'general combat'}`,
    switchTo: lowDurability && lowDurability.name !== choice.name ? lowDurability.name : null,
    backup: melee.find((weapon) => weapon.name !== choice.name) || null,
    smiteForUndead: Boolean(profile && profile.undead && choice.enchantments.smite)
  };
}

function bestMelee(inventory, meta = {}, target = null) {
  const result = selectWeapon({ inventory, meta, target });
  if (!result.ok) return null;
  return result.weapons.find((weapon) => !weapon.ranged) || null;
}

function brokenGear(items, meta = {}) {
  const broken = [];
  for (const [name, count] of Object.entries(items)) {
    if (!count) continue;
    if (weaponClass(name) || ARMOR_STATS[name] || name === 'shield') {
      const durability = durabilityOf(name, itemMeta(meta, name));
      if (durability.ratio <= 0.05) broken.push({ name, ...durability });
    }
  }
  return broken;
}

function protectionScore(meta, profile = {}) {
  const general = enchantLevel(meta, 'protection');
  const projectile = enchantLevel(meta, 'projectile_protection');
  const blast = enchantLevel(meta, 'blast_protection');
  const fire = enchantLevel(meta, 'fire_protection');
  const feather = enchantLevel(meta, 'feather_falling');
  let score = general * 4;
  if (profile.ranged || profile.projectile) score += projectile * 6;
  if (profile.explosive) score += blast * 4;
  if (profile.fire) score += fire * 4;
  if (profile.fall) score += feather * 4;
  return { score, general, projectile, blast, fire, feather };
}

/**
 * Optimise the whole armour set, not each slot in isolation. The score blends
 * armour points, toughness, durability and relevant enchantments.
 */
function optimizeArmor({ inventory = {}, meta = {}, target = null, preferFlight = false } = {}) {
  const profile = target ? profileFor(target) : {};
  const bySlot = { head: [], torso: [], legs: [], feet: [] };
  for (const [name, count] of Object.entries(inventory)) {
    if (!count || count <= 0) continue;
    const stats = ARMOR_STATS[name];
    if (!stats) continue;
    const detail = itemMeta(meta, name);
    const durability = durabilityOf(name, detail);
    if (durability.ratio <= 0.05) continue;
    const protection = protectionScore(detail.enchantments || detail.enchants || {}, profile);
    let score = stats.points * 4 + stats.toughness * 2 + protection.score + durability.ratio * 2;
    if (stats.special === 'flight') score += preferFlight ? 80 : -10;
    if (name.startsWith('netherite_')) score += 2;
    bySlot[stats.slot].push({
      name, slot: stats.slot, points: stats.points, toughness: stats.toughness,
      durability, protection, score: Number(score.toFixed(2)), enchantments: { ...(detail.enchantments || detail.enchants || {}) }
    });
  }
  const pieces = {};
  let total = 0;
  for (const slot of ARMOR_SLOTS) {
    const best = bySlot[slot].sort((a, b) => b.score - a.score)[0] || null;
    pieces[slot] = best;
    if (best) total += best.score;
  }
  const selected = Object.values(pieces).filter(Boolean);
  const points = selected.reduce((sum, piece) => sum + piece.points, 0);
  const toughness = selected.reduce((sum, piece) => sum + piece.toughness, 0);
  return {
    pieces, selected, points, toughness,
    score: Number(total.toFixed(2)),
    protection: selected.reduce((sum, piece) => sum + piece.protection.score, 0),
    durabilityRatio: selected.length ? Number((selected.reduce((sum, piece) => sum + piece.durability.ratio, 0) / selected.length).toFixed(3)) : 0,
    elytra: Boolean(pieces.torso && pieces.torso.name === 'elytra'),
    missingSlots: ARMOR_SLOTS.filter((slot) => !pieces[slot]),
    note: selected.length ? '' : 'no armour available'
  };
}

function gearStatus({ inventory = {}, meta = {}, target = null } = {}) {
  const weapons = evaluateWeapons({ inventory, meta, target });
  const armor = optimizeArmor({ inventory, meta, target });
  const shieldDurability = durabilityOf('shield', itemMeta(meta, 'shield'));
  return {
    weapons: weapons.slice(0, 8),
    bestWeapon: weapons[0] || null,
    armor,
    shield: inventory.shield ? { count: inventory.shield, durability: shieldDurability } : null,
    broken: brokenGear(inventory, meta),
    totems: Number(inventory.totem_of_undying || 0),
    goldenApples: Number(inventory.golden_apple || 0),
    enchantedGoldenApples: Number(inventory.enchanted_golden_apple || 0)
  };
}

const TIER_SCORE = Object.freeze({ wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5, mace: 4, trident: 4, bow: 4, crossbow: 4 });

function upgradePlan({ inventory = {}, meta = {}, target = null } = {}) {
  const gear = gearStatus({ inventory, meta, target });
  const melee = gear.weapons.find((weapon) => !weapon.ranged) || null;
  const sword = gear.weapons.find((weapon) => weapon.cls === 'sword') || null;
  const meleeTier = melee ? (TIER_SCORE[melee.name.split('_')[0]] || 0) : 0;
  const missingArmor = gear.armor.missingSlots.slice();
  const objectives = [];
  const push = (key, ok, priority, detail) => objectives.push({ key, ok, priority, detail });
  push('weapon', Boolean(melee && melee.available), melee && melee.available ? 0 : 100, melee ? `best melee ${melee.name} (${melee.effectiveDamage} dmg)` : 'no usable melee weapon');
  push('sword_tier', meleeTier >= TIER_SCORE.iron, meleeTier >= TIER_SCORE.iron ? 0 : 80, sword ? `sword tier ${sword.name}` : 'no sword; axes are situational');
  push('full_armour', missingArmor.length === 0, missingArmor.length ? 70 : 0, missingArmor.length ? `missing ${missingArmor.join(', ')}` : `armour set complete (${gear.armor.points} points)`);
  push('shield', Boolean(gear.shield), gear.shield ? 0 : 60, gear.shield ? `shield at ${Math.round((gear.shield.durability.ratio || 0) * 100)}% durability` : 'no shield');
  push('totem', gear.totems > 0, gear.totems > 0 ? 0 : 90, gear.totems > 0 ? `${gear.totems} totem(s)` : 'no totem of undying');
  push('food', gear.goldenApples + gear.enchantedGoldenApples >= 3, gear.goldenApples + gear.enchantedGoldenApples >= 3 ? 0 : 40, `${gear.goldenApples} golden apple(s), ${gear.enchantedGoldenApples} enchanted`);
  push('durability', gear.broken.length === 0, gear.broken.length ? 50 : 0, gear.broken.length ? `broken: ${gear.broken.map((item) => item.name).join(', ')}` : 'no broken gear');
  const sharpness = melee ? enchantLevel(melee.enchantments, 'sharpness') : 0;
  push('enchants', sharpness > 0, sharpness > 0 ? 0 : 30, sharpness > 0 ? `sharpness ${sharpness}` : 'melee has no sharpness');
  objectives.sort((a, b) => Number(b.priority) - Number(a.priority));
  const next = objectives.find((objective) => !objective.ok) || null;
  return {
    gear,
    tier: melee ? melee.name.split('_')[0] : null,
    next,
    objectives,
    goals: objectives.filter((objective) => !objective.ok).map((objective) => objective.detail),
    note: 'Progression is derived only from the real inventory; no gear is fabricated or purchased automatically.'
  };
}

function itemSlot(name) {
  if (name === 'totem_of_undying' || name === 'shield') return 'offhand';
  if (ARMOR_STATS[name]) return ARMOR_STATS[name].slot;
  const cls = weaponClass(name);
  if (cls === 'sword') return 'hotbar:1';
  if (cls === 'axe') return 'hotbar:2';
  if (name === 'bow' || name === 'crossbow') return 'hotbar:3';
  if (name === 'golden_apple' || name === 'enchanted_golden_apple') return 'hotbar:4';
  if (name === 'water_bucket') return 'hotbar:6';
  if (/potion/.test(name)) return 'hotbar:8';
  return 'inventory';
}

module.exports = {
  SWORD_RE, AXE_RE, ARMOR_RE, AMMO, RANGED_WEAPONS,
  itemMeta, enchantLevel, durabilityOf, weaponClass, baseDamage, damageEnchantBonus,
  evaluateWeapons, selectWeapon, bestMelee, brokenGear, optimizeArmor, protectionScore,
  gearStatus, upgradePlan, itemSlot, ARMOR_PIECE_SLOTS
};
