'use strict';

/**
 * V6 combat constants. Values are vanilla Java values used for real decisions.
 * They are data, not rules: unknown future items fall back to conservative
 * defaults and are never treated as better than a known weapon.
 */

const COMBAT_STATES = Object.freeze([
  'IDLE', 'SCANNING', 'TARGET_CLASSIFYING', 'TARGET_VALIDATING', 'PREPARING',
  'APPROACHING', 'REPOSITIONING', 'FOLLOWING', 'ENGAGING', 'DODGING', 'DEFENDING', 'HEALING',
  'WEAPON_SWITCHING', 'TOTEM_EMERGENCY', 'RETREATING', 'DEAD', 'VERIFYING',
  'LOOTING', 'RECOVERING', 'DISENGAGED'
]);

const ACTION_PRIORITY = Object.freeze({
  DEAD: 1000,
  TOTEM_EMERGENCY: 900,
  CRITICAL_HEAL: 850,
  TEAMMATE_RESCUE: 800,
  RETREAT: 750,
  DODGE: 700,
  EAT: 600,
  POTION: 550,
  SHIELD_BLOCK: 500,
  ATTACK: 400,
  REPOSITION: 300,
  LOOT: 200,
  RECOVER: 100
});

const COMBAT_MODES = Object.freeze(['BALANCED', 'DUEL', 'DEFENSIVE', 'ARENA', 'TEAM_FIGHT', 'GUARD', 'FOLLOW', 'TARGET_DEFENCE', 'BOSS', 'RETREAT', 'SURVIVAL', 'ESCORT']);
const COMBAT_ROLES = Object.freeze(['COORDINATOR', 'FRONTLINE', 'FLANKER', 'RANGED', 'SUPPORT']);

const SWORD_DAMAGE = Object.freeze({
  wooden_sword: 4, golden_sword: 4, stone_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8
});
const AXE_DAMAGE = Object.freeze({
  wooden_axe: 7, golden_axe: 7, stone_axe: 9, iron_axe: 9, diamond_axe: 9, netherite_axe: 10
});
const WEAPON_SPEED = Object.freeze({
  sword: 1.6, axe: 1.0, trident: 1.1, mace: 0.6, bow: 1.0, crossbow: 1.25
});
const WEAPON_REACH = Object.freeze({ sword: 3, axe: 3, trident: 4.5, mace: 3.5 });

const DURABILITY = Object.freeze({
  wooden_sword: 59, golden_sword: 32, stone_sword: 131, iron_sword: 250, diamond_sword: 1561, netherite_sword: 2031,
  wooden_axe: 59, golden_axe: 32, stone_axe: 131, iron_axe: 250, diamond_axe: 1561, netherite_axe: 2031,
  trident: 250, mace: 500, bow: 384, crossbow: 465, shield: 336,
  leather_helmet: 55, leather_chestplate: 80, leather_leggings: 75, leather_boots: 65,
  golden_helmet: 77, golden_chestplate: 112, golden_leggings: 105, golden_boots: 91,
  chainmail_helmet: 165, chainmail_chestplate: 240, chainmail_leggings: 225, chainmail_boots: 195,
  iron_helmet: 165, iron_chestplate: 240, iron_leggings: 225, iron_boots: 195,
  diamond_helmet: 363, diamond_chestplate: 528, diamond_leggings: 495, diamond_boots: 429,
  netherite_helmet: 407, netherite_chestplate: 592, netherite_leggings: 555, netherite_boots: 481,
  turtle_helmet: 275, elytra: 432
});

/** Base armour points and toughness, per vanilla Java. */
const ARMOR_STATS = Object.freeze({
  leather_helmet: { slot: 'head', points: 1, toughness: 0 }, leather_chestplate: { slot: 'torso', points: 3, toughness: 0 }, leather_leggings: { slot: 'legs', points: 2, toughness: 0 }, leather_boots: { slot: 'feet', points: 1, toughness: 0 },
  golden_helmet: { slot: 'head', points: 2, toughness: 0 }, golden_chestplate: { slot: 'torso', points: 5, toughness: 0 }, golden_leggings: { slot: 'legs', points: 3, toughness: 0 }, golden_boots: { slot: 'feet', points: 1, toughness: 0 },
  chainmail_helmet: { slot: 'head', points: 2, toughness: 0 }, chainmail_chestplate: { slot: 'torso', points: 5, toughness: 0 }, chainmail_leggings: { slot: 'legs', points: 4, toughness: 0 }, chainmail_boots: { slot: 'feet', points: 1, toughness: 0 },
  iron_helmet: { slot: 'head', points: 2, toughness: 0 }, iron_chestplate: { slot: 'torso', points: 6, toughness: 0 }, iron_leggings: { slot: 'legs', points: 5, toughness: 0 }, iron_boots: { slot: 'feet', points: 2, toughness: 0 },
  diamond_helmet: { slot: 'head', points: 3, toughness: 2 }, diamond_chestplate: { slot: 'torso', points: 8, toughness: 2 }, diamond_leggings: { slot: 'legs', points: 6, toughness: 2 }, diamond_boots: { slot: 'feet', points: 3, toughness: 2 },
  netherite_helmet: { slot: 'head', points: 3, toughness: 3 }, netherite_chestplate: { slot: 'torso', points: 8, toughness: 3 }, netherite_leggings: { slot: 'legs', points: 6, toughness: 3 }, netherite_boots: { slot: 'feet', points: 3, toughness: 3 },
  turtle_helmet: { slot: 'head', points: 2, toughness: 0 },
  elytra: { slot: 'torso', points: 0, toughness: 0, special: 'flight' }
});

const ARMOR_SLOTS = Object.freeze(['head', 'torso', 'legs', 'feet']);
const ARMOR_PIECE_SLOTS = Object.freeze({
  helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet'
});

const ENCHANTMENTS = Object.freeze([
  'protection', 'fire_protection', 'feather_falling', 'blast_protection', 'projectile_protection',
  'respiration', 'aqua_affinity', 'thorns', 'depth_strider', 'frost_walker', 'binding_curse',
  'sharpness', 'smite', 'bane_of_arthropods', 'knockback', 'fire_aspect', 'looting', 'sweeping_edge',
  'efficiency', 'silk_touch', 'unbreaking', 'fortune', 'power', 'punch', 'flame', 'infinity',
  'quick_charge', 'multishot', 'piercing', 'loyalty', 'riptide', 'channeling', 'impaling',
  'density', 'breach', 'wind_burst', 'mending', 'vanishing_curse'
]);

const POTION_EFFECTS = Object.freeze({
  healing: { instant: true, health: 4, aliases: ['instant_health', 'healing'] },
  strong_healing: { instant: true, health: 8, aliases: ['strong_healing', 'strong_instant_health'] },
  regeneration: { duration: 45, perSecond: 1, aliases: ['regeneration'] },
  strength: { duration: 180, damageBonus: 3, aliases: ['strength'] },
  swiftness: { duration: 180, speed: 0.2, aliases: ['swiftness', 'speed'] },
  resistance: { duration: 90, damageReduction: 0.2, aliases: ['resistance'] },
  fire_resistance: { duration: 180, aliases: ['fire_resistance'] },
  absorption: { duration: 120, absorption: 4, aliases: ['absorption'] },
  slow_falling: { duration: 90, aliases: ['slow_falling'] },
  water_breathing: { duration: 180, aliases: ['water_breathing'] },
  invisibility: { duration: 180, aliases: ['invisibility'] },
  turtle_master: { duration: 20, aliases: ['turtle_master'] },
  poison: { harmful: true, duration: 45, aliases: ['poison'] },
  wither: { harmful: true, duration: 40, aliases: ['wither'] },
  slowness: { harmful: true, duration: 90, aliases: ['slowness'] },
  weakness: { harmful: true, duration: 90, aliases: ['weakness'] }
});

const HIGH_RISK_MOBS = new Set(['warden', 'wither', 'ender_dragon', 'ravager', 'evoker', 'elder_guardian']);
const BOSS_MOBS = new Set(['warden', 'wither', 'ender_dragon']);

module.exports = {
  COMBAT_STATES, ACTION_PRIORITY, COMBAT_MODES, COMBAT_ROLES,
  SWORD_DAMAGE, AXE_DAMAGE, WEAPON_SPEED, WEAPON_REACH, DURABILITY,
  ARMOR_STATS, ARMOR_SLOTS, ARMOR_PIECE_SLOTS, ENCHANTMENTS,
  POTION_EFFECTS, HIGH_RISK_MOBS, BOSS_MOBS
};
