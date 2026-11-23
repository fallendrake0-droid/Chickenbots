'use strict';

const { distance } = require('../util/vec');
const {
  bestTool, bestFood, PICKAXES, AXES, SHOVELS, SWORDS, armorPoints,
  BED_NAMES, categoryOf, sumCategory
} = require('../world/items');

/**
 * Contract every bot adapter implements. The gameplay controllers only touch
 * this interface, which is why they can be unit-tested against MockBot and run
 * unchanged against a real Mineflayer connection (RealBot).
 *
 * Required primitives: getBlock, digBlock, goTo, placeBlock, attack, consume,
 * equipBestTool, sleep, fish, openContainer, and the synchronous state fields.
 *
 * Combat adapters may also implement these optional V6 hooks; the controller
 * degrades safely when one is absent:
 *   itemMeta(item)                  -> { enchantments, durability, maxDurability }
 *   getOffhand()                    -> item name or null
 *   equipArmor(piece)               -> equip a specific armour piece
 *   combatEvents()/drainCombatEvents()-> real totem/attack events, never inferred
 *   strafe(direction, options)      -> dodge movement
 *   useShield()                     -> raise the offhand shield
 *   attack(entity, { authorizedPlayer }) -> melee or charged ranged attack
 */
class BotAdapter {
  constructor({ name, world = null, logger = null, speed = 1 }) {
    this.name = name;
    this.world = world;
    this.logger = logger;
    this.speed = speed;
    this.connected = true;
    this.spawned = true;
    this.authenticated = true;
    this.health = 20;
    this.food = 20;
    this.saturation = 5;
    this.oxygen = 20;
    this.onFire = false;
    this.inLava = false;
    this.inWater = false;
    this.fallDistance = 0;
    this.velocity = { x: 0, y: 0, z: 0 };
    this.position = { x: 0, y: 64, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.dimension = 'overworld';
    this.inventory = {};
    this.equipment = { pickaxe: 0, axe: 0, shovel: 0, sword: 0, armor: 0, shield: false, bow: false };
    this.isSleeping = false;
    this.effects = {};
    this.capabilities = ['mine', 'chop', 'farm', 'build', 'excavate', 'explore', 'combat', 'fish'];
    this.deaths = 0;
    this.currentTaskId = null;
    this.activity = 'idle';
    this.recentTaskTypes = [];
    this.shuttingDown = false;
  }

  // --- lifecycle -----------------------------------------------------------
  /**
   * Drop the logical connection. Simulated adapters own no socket, but their
   * state must still become offline so dashboards and supervisors do not keep
   * reporting a stopped runtime as five healthy bots.
   */
  async disconnect(reason = 'shutdown') {
    if (typeof this.stopTicking === 'function') this.stopTicking();
    const wasConnected = Boolean(this.connected);
    this.connected = false;
    this.spawned = false;
    this.authenticated = false;
    this.activity = 'offline';
    return { ok: true, wasConnected, reason };
  }

  // --- synchronous state helpers -------------------------------------------
  /** A bot may only act autonomously once the connection gate has passed. */
  get ready() { return this.connected && this.spawned && this.authenticated; }

  get time() { return { timeOfDay: this.world ? this.world.time : 0, day: 1 }; }
  get entities() { return this.world ? this.world.entities : []; }

  getBlock(pos) { throw new Error('getBlock not implemented'); }
  blockAt(pos) { return this.getBlock(pos); }

  surfaceAt(x, z) {
    if (!this.world || typeof this.world.surfaceY !== 'function') return this.position.y;
    return this.world.surfaceY(x, z);
  }

  countItem(name) {
    if (!name) return 0;
    if (name.startsWith('category:')) return sumCategory(this.inventory, name.slice(9));
    return this.inventory[name] || 0;
  }

  hasItem(name) { return this.countItem(name); }

  inventoryCount() { return Object.values(this.inventory).reduce((s, n) => s + n, 0); }

  distinctItems() { return Object.keys(this.inventory).filter((k) => this.inventory[k] > 0).length; }

  isInventoryFull(limit = 36) { return this.distinctItems() >= limit; }

  hostileNear(position = this.position, radius = 16) {
    return this.entitiesNear(radius, position).filter((e) => e.hostile);
  }

  threatsNear(position = this.position, radius = 8) {
    return this.hostileNear(position, radius).length;
  }

  nearestThreat(position = this.position) {
    const list = this.hostileNear(position, 24);
    if (!list.length) return null;
    return list.sort((a, b) => distance(a.position, position) - distance(b.position, position))[0];
  }

  entitiesNear(radius = 16, position = this.position) {
    if (!this.world || !Array.isArray(this.world.entities)) return [];
    return this.world.entities
      .filter((e) => e.alive !== false && e.position && distance(e.position, position) <= radius)
      .map((e) => ({
        id: e.id,
        type: e.type,
        kind: e.kind,
        name: e.name || e.username || e.type,
        username: e.username,
        position: { ...e.position },
        health: e.health,
        hostile: Boolean(e.hostile),
        alive: e.alive !== false
      }));
  }

  entitiesByName(name) {
    return this.entitiesNear(64).filter((e) => e.type === name || e.name === name);
  }

  distanceTo(pos) { return distance(this.position, pos); }

  bestToolFor(category) {
    const table = { pickaxe: PICKAXES, axe: AXES, shovel: SHOVELS, sword: SWORDS }[category];
    if (!table) return null;
    return bestTool(this.inventory, table);
  }

  bestFoodItem({ critical = false } = {}) {
    return bestFood(this.inventory, { critical, health: this.health });
  }

  armorPoints() { return armorPoints(this.inventory); }

  hasBed() {
    return Object.keys(this.inventory).find((n) => BED_NAMES.has(n) && this.inventory[n] > 0) || null;
  }

  summary() {
    return {
      name: this.name,
      connected: this.connected,
      spawned: this.spawned,
      authenticated: this.authenticated,
      ready: this.ready,
      health: this.health,
      food: this.food,
      saturation: this.saturation,
      oxygen: this.oxygen,
      onFire: this.onFire,
      inLava: this.inLava,
      inWater: this.inWater,
      fallDistance: this.fallDistance,
      velocity: { ...this.velocity },
      position: { ...this.position },
      yaw: this.yaw,
      dimension: this.dimension,
      inventory: { ...this.inventory },
      equipment: { ...this.equipment },
      armor: this.armorPoints(),
      isSleeping: this.isSleeping,
      effects: { ...this.effects },
      capabilities: this.capabilities.slice(),
      threats: this.threatsNear(this.position, 12),
      nearestThreatDistance: (this.nearestThreat() ? Number(distance(this.nearestThreat().position, this.position).toFixed(1)) : undefined),
      deaths: this.deaths,
      currentTaskId: this.currentTaskId,
      activity: this.activity,
      time: this.time,
      uptimeMs: this.uptimeMs || 0,
      inventoryFull: this.isInventoryFull(),
      activityDetail: this.activityDetail || null
    };
  }

  describeItem(name) { return { name, category: categoryOf(name) }; }
}

module.exports = { BotAdapter };
