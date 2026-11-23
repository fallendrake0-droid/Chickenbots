'use strict';

/**
 * Version-aware entity registry and combat profiles.
 *
 * Hostility comes from the installed minecraft-data entity registry. Profiles
 * add only observable mechanics that change tactics (explosives, projectiles,
 * poison, water, bosses). Nothing here invents hidden enemy information.
 */

let mcData = null;
try {
  // The project pins minecraft-data; the version follows config's protocol data.
  mcData = require('minecraft-data')('1.21.4');
} catch (_) {
  mcData = null;
}

const REGISTRY = new Map();
if (mcData) {
  for (const entity of Object.values(mcData.entitiesByName || {})) {
    if (!entity || !entity.name) continue;
    REGISTRY.set(entity.name.toLowerCase(), {
      name: entity.name.toLowerCase(),
      type: entity.type,
      category: entity.category,
      hostile: entity.type === 'hostile' || entity.type === 'boss' || /hostile|monster/i.test(entity.category || '')
    });
  }
}

/** Entities that are hostile even when a world adapter does not mark them. */
const KNOWN_HOSTILE = new Set([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'creaking', 'creeper', 'drowned', 'elder_guardian',
  'enderman', 'endermite', 'evoker', 'ghast', 'giant', 'guardian', 'hoglin', 'husk', 'illusioner',
  'magma_cube', 'phantom', 'piglin', 'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish',
  'skeleton', 'slime', 'spider', 'stray', 'vex', 'vindicator', 'warden', 'wither', 'wither_skeleton',
  'witch', 'zoglin', 'zombie', 'zombie_villager', 'zombified_piglin'
]);

/** Neutral or conditionally hostile: never auto-attacked without authorisation. */
const NEUTRAL = new Set([
  'bee', 'dolphin', 'enderman', 'goat', 'iron_golem', 'llama', 'panda', 'polar_bear',
  'pufferfish', 'trader_llama', 'wolf', 'zombified_piglin', 'piglin'
]);

const UNDEAD = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither', 'wither_skeleton', 'zombie_villager', 'phantom', 'zoglin', 'skeleton_horse', 'zombie_horse']);
const ARTHROPOD = new Set(['spider', 'cave_spider', 'silverfish', 'endermite', 'bee']);
const AQUATIC = new Set(['guardian', 'elder_guardian', 'drowned', 'turtle', 'dolphin', 'squid', 'glow_squid', 'axolotl', 'cod', 'salmon', 'tropical_fish', 'pufferfish']);
const EXPLOSIVE = new Set(['creeper', 'ghast']);
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'guardian', 'elder_guardian', 'shulker', 'evoker', 'illusioner']);
const SUMMONERS = new Set(['evoker', 'illusioner']);
const BOSSES = new Set(['warden', 'wither', 'ender_dragon', 'elder_guardian']);
const AVOID_UNLESS_PREPARED = new Set(['warden', 'wither', 'ender_dragon', 'ravager', 'evoker', 'elder_guardian']);
const FLYING = new Set(['phantom', 'vex', 'ghast', 'breeze', 'bee', 'allay', 'bat', 'blaze']);
const JUMPERS = new Set(['spider', 'cave_spider', 'slime', 'magma_cube', 'frog', 'goat', 'ravager']);
const PACK = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'piglin', 'piglin_brute', 'pillager', 'vindicator', 'vex']);

const PROFILES = {
  creeper: { preferredRange: 6, keepDistance: true, explosive: true, retreatBefore: 4, threat: 45, note: 'fuse/explosion risk; keep distance and never chase into teammates' },
  charged_creeper: { preferredRange: 8, keepDistance: true, explosive: true, retreatBefore: 6, threat: 70, note: 'charged explosion is lethal; ranged engagement preferred' },
  skeleton: { preferredRange: 8, ranged: true, projectile: 'arrow', shield: true, threat: 25, note: 'predict arrows, use cover and a shield while closing' },
  stray: { preferredRange: 8, ranged: true, projectile: 'arrow', shield: true, threat: 28, note: 'slowness arrows; cover matters' },
  bogged: { preferredRange: 8, ranged: true, projectile: 'arrow', shield: true, threat: 28, note: 'poison arrows; avoid prolonged exposure' },
  pillager: { preferredRange: 9, ranged: true, projectile: 'crossbow', shield: true, threat: 30, note: 'crossbow reload window is the approach window' },
  witch: { preferredRange: 10, ranged: true, potions: true, threat: 40, note: 'splash potions; do not stand in the open at range' },
  spider: { preferredRange: 2, jumps: true, climbs: true, threat: 20, note: 'handle jumping and wall-climbing attacks' },
  cave_spider: { preferredRange: 1.5, jumps: true, climbs: true, poison: true, threat: 26, note: 'poison in tight spaces; avoid caves without gear' },
  silverfish: { preferredRange: 1.5, swarm: true, threat: 12, note: 'swarm; do not let it kite into stone tunnels' },
  enderman: { preferredRange: 3, neutral: true, teleports: true, threat: 35, note: 'avoid eye contact; engage only when authorised and prepared' },
  drowned: { preferredRange: 3, aquatic: true, trident: true, threat: 25, note: 'trident throws and drowning; keep oxygen and land footing' },
  guardian: { preferredRange: 8, aquatic: true, ranged: true, threat: 30, note: 'underwater beam; oxygen and depth matter' },
  elder_guardian: { preferredRange: 10, aquatic: true, ranged: true, boss: true, threat: 65, note: 'mining fatigue and guardians; high-risk underwater encounter' },
  evoker: { preferredRange: 9, ranged: true, summons: true, threat: 45, note: 'evoker fangs and vexes; move immediately' },
  vex: { preferredRange: 2, flying: true, threat: 28, note: 'flies through walls; short sword reach matters' },
  vindicator: { preferredRange: 2.5, axe: true, threat: 35, note: 'heavy axe; shield and spacing' },
  ravager: { preferredRange: 5, charge: true, threat: 55, note: 'charge and knockback; do not get trapped' },
  breeze: { preferredRange: 8, flying: true, wind: true, threat: 40, note: 'wind charges knock you toward hazards' },
  warden: { preferredRange: 20, avoid: true, boss: true, sonic: true, threat: 100, note: 'avoid; only a planned high-risk operation may engage' },
  wither: { preferredRange: 12, flying: true, boss: true, explosive: true, threat: 100, note: 'exceptional boss encounter; requires preparation and team plan' },
  slime: { preferredRange: 2, jumps: true, splits: true, threat: 12, note: 'splits; finish small slimes' },
  magma_cube: { preferredRange: 2, jumps: true, fire: true, threat: 18, note: 'fire damage; keep distance from lava' },
  phantom: { preferredRange: 3, flying: true, threat: 30, note: 'swoops; punish the recovery window' },
  blaze: { preferredRange: 7, flying: true, ranged: true, fire: true, threat: 40, note: 'fireballs; cover and fire resistance' },
  ghast: { preferredRange: 14, flying: true, ranged: true, explosive: true, threat: 45, note: 'fireballs; deflect or use cover' },
  shulker: { preferredRange: 8, ranged: true, threat: 30, note: 'levitation projectiles; cover and range' },
  piglin: { preferredRange: 3, neutral: true, threat: 25, note: 'neutral unless provoked; never auto-attack' },
  zombified_piglin: { preferredRange: 3, neutral: true, threat: 22, note: 'neutral unless provoked' }
};

function entityName(entity) {
  return String((entity && (entity.name || entity.type || entity.username)) || '').toLowerCase();
}

function registryEntry(name) {
  return REGISTRY.get(String(name || '').toLowerCase()) || null;
}

function isHostile(entity) {
  if (!entity) return false;
  const name = entityName(entity);
  if (entity.username) return false;
  if (NEUTRAL.has(name) && entity.hostile !== true) return false;
  if (entity.hostile === true) return true;
  if (KNOWN_HOSTILE.has(name)) return true;
  const entry = registryEntry(name);
  return Boolean(entry && entry.hostile);
}

function isNeutral(entity) {
  const name = entityName(entity);
  return NEUTRAL.has(name) || Boolean(entity && entity.hostile !== true && registryEntry(name) && !isHostile(entity) && !entity.username);
}

function isPlayer(entity) { return Boolean(entity && (entity.username || entity.type === 'player')); }
function isUndead(entity) { return UNDEAD.has(entityName(entity)); }
function isArthropod(entity) { return ARTHROPOD.has(entityName(entity)); }
function isAquatic(entity) { return AQUATIC.has(entityName(entity)); }
function isBoss(entity) { return BOSSES.has(entityName(entity)); }

function profileFor(entity) {
  const raw = entityName(entity);
  const special = PROFILES[raw] || PROFILES[raw.replace(/^charged_/, '')] || {};
  return {
    name: raw,
    kind: isPlayer(entity) ? 'player' : isHostile(entity) ? 'hostile' : isNeutral(entity) ? 'neutral' : 'other',
    undead: isUndead(entity),
    arthropod: isArthropod(entity),
    aquatic: isAquatic(entity),
    explosive: EXPLOSIVE.has(raw) || Boolean(special.explosive),
    ranged: RANGED.has(raw) || Boolean(special.ranged),
    summons: SUMMONERS.has(raw) || Boolean(special.summons),
    flying: FLYING.has(raw) || Boolean(special.flying),
    jumps: JUMPERS.has(raw) || Boolean(special.jumps),
    pack: PACK.has(raw),
    boss: BOSSES.has(raw) || Boolean(special.boss),
    avoid: AVOID_UNLESS_PREPARED.has(raw) || Boolean(special.avoid),
    neutral: NEUTRAL.has(raw) || Boolean(special.neutral),
    preferredRange: special.preferredRange ?? (RANGED.has(raw) ? 8 : 2.5),
    threat: special.threat ?? (BOSSES.has(raw) ? 100 : RANGED.has(raw) ? 30 : 15),
    keepDistance: Boolean(special.keepDistance),
    retreatBefore: special.retreatBefore || 0,
    projectile: special.projectile || (RANGED.has(raw) ? 'arrow' : null),
    note: special.note || ''
  };
}

function hostileRegistry() {
  return [...REGISTRY.values()].filter((entry) => entry.hostile || KNOWN_HOSTILE.has(entry.name)).map((entry) => entry.name).sort();
}

function neutralRegistry() {
  return [...NEUTRAL].sort();
}

module.exports = {
  REGISTRY, KNOWN_HOSTILE, NEUTRAL, PROFILES,
  registryEntry, entityName, isHostile, isNeutral, isPlayer, isUndead, isArthropod, isAquatic, isBoss,
  profileFor, hostileRegistry, neutralRegistry
};
