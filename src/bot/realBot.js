'use strict';

const { BotAdapter } = require('./adapter');
const { config, BOT_NAMES } = require('../config');
const { Logger } = require('../logger');
const { distance, key } = require('../util/vec');
const { bestTool, FOODS, BED_NAMES, toolTier } = require('../world/items');

const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'slime', 'magma_cube',
  'enderman', 'blaze', 'ghast', 'hoglin', 'zoglin', 'piglin_brute', 'warden', 'silverfish',
  'endermite', 'guardian', 'elder_guardian', 'shulker', 'vex', 'breeze'
]);

const FLUID_BLOCKS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);

/**
 * Live Mineflayer bot.
 *
 * Autonomy is gated on a verified connection + successful login + spawn. Until
 * `ready` is true, every gameplay primitive refuses to act. No AI service is
 * involved: the same deterministic controllers that run against MockBot drive
 * this adapter.
 */
class RealBot extends BotAdapter {
  constructor({
    name, host = config.server.host, port = config.server.port, version = config.server.version,
    auth = config.server.auth, logger = null, mineflayer = null, createBot = null,
    loginPassword = config.server.loginPassword, registerPassword = config.server.registerPassword,
    connectTimeoutMs = config.server.connectTimeoutMs
  } = {}) {
    super({ name, logger: logger || new Logger({ level: config.logging.level }), speed: 1 });
    if (!BOT_NAMES.includes(name)) throw new Error(`refusing to create a bot outside the fixed team roster: ${name}`);
    this.host = host;
    this.port = port;
    this.version = version;
    this.auth = auth;
    this.loginPassword = loginPassword;
    this.registerPassword = registerPassword;
    this.connectTimeoutMs = connectTimeoutMs;
    this._mineflayer = mineflayer;
    this._createBot = createBot;
    this.bot = null;
    this.connected = false;
    this.spawned = false;
    this.authenticated = false;
    this.lastError = null;
    this.lastDeath = null;
    this.spawnPosition = null;
    this.worldView = null;
    this._chatLog = [];
    this._chatListeners = new Set();
    this._spawnWaiters = new Set();
    this._blockCache = new Map();
    this._inventoryDirty = false;
    this._lastHealth = undefined;
    this._lastTotemCount = 0;
    this.itemMeta = {};
    this._itemAliases = new Map();
    this.combatEvents = [];
    this.uptimeMs = 0;
    this.startedAt = 0;
    this.stats = { dug: 0, placed: 0, attacked: 0, eaten: 0, crafted: 0, deaths: 0, connections: 0 };
    this._deathCount = 0;
  }

  get ready() { return Boolean(this.connected && this.authenticated && this.spawned && this.bot && this.bot.entity); }

  _loadMineflayer() {
    if (this._createBot) return this._createBot;
    // Lazily require so the deterministic simulator/tests never need a socket.
    const mineflayer = this._mineflayer || require('mineflayer');
    this._mineflayer = mineflayer;
    return mineflayer.createBot.bind(mineflayer);
  }

  async connect({ timeoutMs = this.connectTimeoutMs } = {}) {
    if (this.connected) return { ok: true, already: true };
    const createBot = this._loadMineflayer();
    this.connected = false;
    this.spawned = false;
    this.authenticated = false;
    this.lastError = null;
    try {
      this.bot = createBot({
        username: this.name,
        host: this.host,
        port: this.port,
        auth: this.auth,
        version: this.version === 'auto' ? undefined : this.version,
        checkTimeoutInterval: config.server.keepAliveMs,
        hideErrors: false,
        // Never let mineflayer's own physics fight the deterministic controller loop.
        physicsEnabled: true
      });
    } catch (err) {
      this.lastError = err.message;
      return { ok: false, error: err.message };
    }
    this.stats.connections++;
    this._attachEvents();
    const result = await this.waitForSpawn({ timeoutMs });
    if (result.ok) {
      this.startedAt = Date.now();
      this.uptimeMs = 0;
      await this._handleLoginCommands();
    }
    return result;
  }

  _attachEvents() {
    const bot = this.bot;
    if (!bot) return;
    bot.on('login', () => {
      this.authenticated = true;
      this.logger.info(`[${this.name}] authenticated with ${this.host}`);
    });
    bot.on('spawn', () => {
      this.connected = true;
      this.spawned = true;
      this.authenticated = true; // servers send spawn after successful login
      this.position = this._vec(bot.entity?.position);
      this.spawnPosition = { ...this.position };
      this.dimension = bot.game?.dimension || 'overworld';
      this._syncInventory();
      this.logger.info(`[${this.name}] spawned at ${this.position.x},${this.position.y},${this.position.z}`);
      for (const waiter of this._spawnWaiters) waiter.resolve({ ok: true, spawned: true, authenticated: true });
      this._spawnWaiters.clear();
    });
    bot.on('move', () => {
      this.position = this._vec(bot.entity?.position);
      this.yaw = bot.entity?.yaw || 0;
      this.pitch = bot.entity?.pitch || 0;
      this.onGround = bot.entity?.onGround;
    });
    bot.on('health', () => {
      const count = Number(this.inventory.totem_of_undying || 0);
      if (bot.health > 0 && count < this._lastTotemCount) {
        this.recordCombatEvent({ at: new Date().toISOString(), type: 'totem_activated', bot: this.name, health: bot.health, detectedBy: 'health-transition' });
      }
      this._lastHealth = bot.health;
      this._lastTotemCount = count;
      this.health = bot.health;
      this.food = bot.food;
      this.saturation = bot.foodSaturation || 0;
      this.oxygen = bot.oxygenLevel ?? 20;
    });
    bot.on('breath', () => { this.oxygen = bot.oxygenLevel ?? 20; });
    bot.on('death', () => {
      this._deathCount++;
      this.stats.deaths++;
      this.deaths = this._deathCount;
      this.lastDeath = { at: Date.now(), position: { ...this.position } };
      this.logger.warn(`[${this.name}] died at ${this.position.x},${this.position.y},${this.position.z}`);
    });
    bot.on('kicked', (reason) => {
      this.lastError = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.connected = false;
      this.spawned = false;
      this.logger.warn(`[${this.name}] kicked: ${this.lastError}`);
    });
    bot.on('error', (err) => {
      this.lastError = err.message;
      this.logger.error(`[${this.name}] ${err.message}`);
    });
    bot.on('end', (reason) => {
      this.connected = false;
      this.spawned = false;
      this.authenticated = false;
      this.logger.warn(`[${this.name}] disconnected: ${reason || 'end'}`);
    });
    bot.on('message', (message) => {
      const text = message.toString();
      this._chatLog.push({ at: Date.now(), text });
      if (this._chatLog.length > 200) this._chatLog.shift();
      for (const listener of this._chatListeners) listener(text);
    });
  }

  _vec(position) {
    if (!position) return { ...this.position };
    return { x: Number(position.x.toFixed(3)), y: Number(position.y.toFixed(3)), z: Number(position.z.toFixed(3)) };
  }

  waitForSpawn({ timeoutMs = this.connectTimeoutMs } = {}) {
    if (this.ready) return Promise.resolve({ ok: true, spawned: true, authenticated: true });
    return new Promise((resolve) => {
      const waiter = { resolve: null };
      const timer = setTimeout(() => {
        this._spawnWaiters.delete(waiter);
        this.lastError = this.lastError || 'timed out waiting for spawn';
        resolve({ ok: false, error: this.lastError, spawned: this.spawned, authenticated: this.authenticated });
      }, timeoutMs);
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
      this._spawnWaiters.add(waiter);
    });
  }

  async _handleLoginCommands() {
    if (!this.bot || !this.ready) return;
    if (this.registerPassword) {
      const command = config.server.registerCommand.replace(/\{password\}/g, this.registerPassword);
      this.bot.chat(command);
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (this.loginPassword) {
      const command = config.server.loginCommand.replace(/\{password\}/g, this.loginPassword);
      this.bot.chat(command);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // ------------------------------------------------------------------
  // World access
  // ------------------------------------------------------------------
  get world() { return this.worldView || (this.worldView = this._makeWorldView()); }

  set world(value) { this.worldView = value; }

  _makeWorldView() {
    const self = this;
    return {
      getBlock(pos) {
        const block = self._blockAt(pos);
        return block ? { name: block.name, position: { ...pos } } : { name: 'air', position: { ...pos } };
      },
      setBlock() { throw new Error('RealBot cannot set blocks directly; use placeBlock'); },
      surfaceY(x, z, from = 320) {
        for (let y = from; y > -64; y--) {
          const block = self.bot.blockAt(self._vec3(x, y, z));
          if (block && block.boundingBox !== 'empty') return y + 1;
        }
        return 63;
      },
      get entities() { return self.entities; },
      get time() { return self.time.timeOfDay; },
      setTime() { throw new Error('cannot set world time'); }
    };
  }

  _vec3(x, y, z) {
    const Vec3 = (this._mineflayer && this._mineflayer.Vec3) || (this._createBot && this._createBot.Vec3);
    if (Vec3) return new Vec3(x, y, z);
    const vec3 = require('vec3');
    return vec3(x, y, z);
  }

  _blockAt(pos) {
    if (!this.bot) return null;
    const k = `${pos.x},${pos.y},${pos.z}`;
    if (this._blockCache.has(k)) return this._blockCache.get(k);
    const block = this.bot.blockAt(this._vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
    if (this._blockCache.size > 4000) this._blockCache.clear();
    this._blockCache.set(k, block);
    return block;
  }

  getBlock(pos) {
    const block = this._blockAt(pos);
    return block ? { name: block.name, position: { x: pos.x, y: pos.y, z: pos.z } } : { name: 'air', position: { x: pos.x, y: pos.y, z: pos.z } };
  }

  get entities() {
    if (!this.bot) return [];
    const out = [];
    for (const entity of Object.values(this.bot.entities || {})) {
      if (!entity || entity === this.bot.entity || !entity.position) continue;
      out.push({
        id: entity.id,
        name: entity.name || entity.username || 'unknown',
        username: entity.username,
        type: entity.type,
        kind: entity.kind,
        hostile: Boolean(entity.username ? false : HOSTILE.has(entity.name)),
        position: this._vec(entity.position),
        health: entity.health
      });
    }
    return out;
  }

  get time() {
    const timeOfDay = this.bot?.time?.timeOfDay ?? 0;
    return { timeOfDay, day: this.bot?.time?.day ?? 1 };
  }

  entitiesNear(radius = 16, position = this.position) {
    return this.entities
      .filter((entity) => entity.alive !== false && entity.position && distance(entity.position, position) <= radius)
      .map((entity) => ({
        id: entity.id,
        type: entity.type,
        kind: entity.kind,
        name: entity.name || entity.username || entity.type,
        username: entity.username,
        position: { ...entity.position },
        health: entity.health,
        hostile: Boolean(entity.hostile),
        blocking: Boolean(entity.usingItem || entity.blocking),
        equipment: Array.isArray(entity.equipment) ? entity.equipment.filter(Boolean).map((item) => item.name || item) : [],
        heldItem: entity.heldItem ? (entity.heldItem.name || entity.heldItem) : null
      }));
  }

  threatsNear(position = this.position, radius = 8) {
    return this.entitiesNear(radius, position).filter((entity) => entity.hostile).length;
  }

  nearestThreat(position = this.position) {
    const list = this.entitiesNear(24, position).filter((entity) => entity.hostile);
    if (!list.length) return null;
    return list.sort((a, b) => distance(a.position, position) - distance(b.position, position))[0];
  }

  _assertReady() {
    if (!this.ready) {
      const error = `bot ${this.name} is not ready (connected=${this.connected}, authenticated=${this.authenticated}, spawned=${this.spawned})`;
      return { ok: false, error };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Inventory
  // ------------------------------------------------------------------
  _potionEffect(item) {
    if (!item || !/potion$/.test(String(item.name || ''))) return null;
    const nbt = item.nbt && (item.nbt.value || item.nbt);
    const raw = nbt && (nbt.Potion || nbt.potion);
    const value = raw && typeof raw === 'object' ? (raw.value ?? raw) : raw;
    return value ? String(value).replace(/^minecraft:/, '') : null;
  }

  _syncInventory() {
    if (!this.bot || !this.bot.inventory) return;
    const counts = {};
    const meta = {};
    this._itemAliases = new Map();
    const record = (item) => {
      if (!item || !item.name) return;
      let name = item.name;
      const potion = this._potionEffect(item);
      if (potion) {
        const prefix = name.startsWith('splash_') ? 'splash_' : name.startsWith('lingering_') ? 'lingering_' : '';
        name = `${prefix}potion_of_${potion}`;
        this._itemAliases.set(name, item);
      }
      counts[name] = (counts[name] || 0) + (item.count || 1);
      const enchants = {};
      for (const entry of item.enchants || []) {
        const effectName = typeof entry.name === 'string' ? entry.name : (entry.name && entry.name.name) || entry.name;
        if (effectName) enchants[effectName] = entry.lvl || entry.level || 1;
      }
      meta[name] = {
        durability: item.durabilityUsed !== undefined && item.maxDurability ? item.maxDurability - item.durabilityUsed : item.durability,
        maxDurability: item.maxDurability || undefined,
        enchantments: enchants
      };
      if (potion) meta[name].effect = potion;
    };
    for (const item of this.bot.inventory.items()) record(item);
    // `inventory.items()` covers the main inventory and hotbar only. Armour
    // slots (5-8) and the offhand (45) are part of what the bot actually owns,
    // so include them or the controller would think equipped gear disappeared.
    for (const index of [5, 6, 7, 8, 45]) {
      const item = this.bot.inventory.slots && this.bot.inventory.slots[index];
      if (item) record(item);
    }
    this.inventory = counts;
    this.itemMeta = meta;
    this._lastTotemCount = Number(counts.totem_of_undying || 0);
    this.uptimeMs = this.startedAt ? Date.now() - this.startedAt : 0;
    this._updateEquipmentFromBot();
  }

  refreshInventory() { this._syncInventory(); return { ok: true, items: Object.keys(this.inventory).length }; }

  getOffhand() {
    if (!this.bot || !this.bot.inventory) return null;
    const slot = this.bot.inventory.slots && this.bot.inventory.slots[45];
    return slot ? slot.name : null;
  }

  async equipArmor(pieces = []) {
    const check = this._assertReady();
    if (check) return check;
    this._syncInventory();
    const equipped = [];
    const destinations = { head: 'head', torso: 'torso', legs: 'legs', feet: 'feet' };
    const armorSlot = { head: 5, torso: 6, legs: 7, feet: 8 };
    for (const piece of pieces || []) {
      if (!piece || !piece.name) continue;
      const currentlyWorn = this.bot.inventory.slots && this.bot.inventory.slots[armorSlot[piece.slot]];
      if (currentlyWorn && currentlyWorn.name === piece.name) { equipped.push(piece.name); continue; }
      const item = this._findItem(piece.name, { includeEquipped: true });
      if (!item) continue;
      try {
        await this.bot.equip(item, destinations[piece.slot] || 'torso');
        equipped.push(piece.name);
      } catch (_) { /* leave the slot unchanged rather than dropping gear */ }
    }
    this._syncInventory();
    return { ok: equipped.length > 0, pieces: equipped };
  }

  recordCombatEvent(event) {
    this.combatEvents.push(event);
    if (this.combatEvents.length > 200) this.combatEvents.shift();
    return true;
  }

  drainCombatEvents() { return this.combatEvents.splice(0); }

  async strafe(direction = 'left', { durationMs = 120 } = {}) {
    if (!this.bot || !this.ready) return { ok: false, error: 'not ready' };
    const control = direction === 'left' ? 'left' : 'right';
    this.bot.setControlState(control, true);
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(30, durationMs))));
    this.bot.setControlState(control, false);
    this.position = this._vec(this.bot.entity?.position);
    return { ok: true, direction, position: { ...this.position } };
  }

  _updateEquipmentFromBot() {
    const held = this.bot?.heldItem;
    if (!held) return;
    this.equipment = {
      ...this.equipment,
      heldItem: held.name,
      pickaxe: toolTier(held.name, 'pickaxe'),
      axe: toolTier(held.name, 'axe'),
      shovel: toolTier(held.name, 'shovel'),
      sword: toolTier(held.name, 'sword')
    };
  }

  _findItem(name, { includeEquipped = false } = {}) {
    if (!this.bot) return null;
    if (this._itemAliases && this._itemAliases.has(name)) return this._itemAliases.get(name);
    const found = this.bot.inventory.items().find((item) => item.name === name);
    if (found || !includeEquipped) return found || null;
    for (const index of [5, 6, 7, 8, 45]) {
      const item = this.bot.inventory.slots && this.bot.inventory.slots[index];
      if (item && item.name === name) return item;
    }
    return null;
  }

  async equipBestTool(category) {
    const check = this._assertReady();
    if (check) return check;
    this._syncInventory();
    const choice = bestTool(this.inventory, category);
    if (!choice) return { ok: false, error: `no ${category} available` };
    const item = this._findItem(choice.name);
    if (!item) return { ok: false, error: `no ${choice.name} in inventory` };
    await this.bot.equip(item, 'hand');
    this._updateEquipmentFromBot();
    return { ok: true, tool: choice.name };
  }

  async equipItem(name, destination = 'hand') {
    const check = this._assertReady();
    if (check) return check;
    if (destination === 'off-hand' && this.getOffhand() === name) return { ok: true, already: true, item: name };
    const item = this._findItem(name, { includeEquipped: true });
    if (!item) return { ok: false, error: `no ${name}` };
    await this.bot.equip(item, destination);
    this._syncInventory();
    return { ok: true, item: name };
  }

  countItem(name) { return this.inventory[name] || 0; }

  // ------------------------------------------------------------------
  // Movement and interaction
  // ------------------------------------------------------------------
  async goTo(pos, { range = 1, timeoutMs = 20000 } = {}) {
    const check = this._assertReady();
    if (check) return check;
    const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
    if (!this.bot.pathfinder) this.bot.loadPlugin(pathfinder);
    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);
    const goal = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), Math.max(1, range));
    const pathPromise = this.bot.pathfinder.goto(goal).then(() => ({ ok: true }));
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'path timeout' }), timeoutMs));
    const result = await Promise.race([pathPromise, timeout]);
    if (result.ok === false) {
      try { this.bot.pathfinder.stop(); } catch (_) { /* pathfinder may not be running */ }
    }
    this.position = this._vec(this.bot.entity?.position);
    return result;
  }

  async digBlock(pos, { timeoutMs = 20000 } = {}) {
    const check = this._assertReady();
    if (check) return check;
    const block = this._blockAt(pos);
    if (!block || block.name === 'air') return { ok: false, error: 'already air' };
    if (FLUID_BLOCKS.has(block.name)) return { ok: false, error: 'refusing to dig liquid' };
    if (!block.diggable) return { ok: false, error: `not diggable: ${block.name}` };
    if (distance(this.position, pos) > 5) {
      const move = await this.goTo(pos, { range: 4, timeoutMs });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach block' };
    }
    const category = /_log$|_wood$|_planks$|_fence$|_door$/.test(block.name) ? 'axe' : 'pickaxe';
    await this.equipBestTool(category);
    try {
      await this.bot.dig(block, true);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this._blockCache.delete(`${pos.x},${pos.y},${pos.z}`);
    this.stats.dug++;
    this._syncInventory();
    return { ok: true, block: block.name, drops: {} };
  }

  async placeBlock(pos, itemName) {
    const check = this._assertReady();
    if (check) return check;
    const item = this._findItem(itemName);
    if (!item) return { ok: false, error: `no ${itemName}` };
    const target = this._blockAt(pos);
    if (target && target.name !== 'air' && target.name !== 'water') return { ok: false, error: 'space occupied' };
    const offsets = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
    let reference = null;
    let face = null;
    for (const [dx, dy, dz] of offsets) {
      const refPos = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
      const block = this._blockAt(refPos);
      if (block && block.name !== 'air' && block.boundingBox === 'block') {
        reference = block;
        face = this._vec3(-dx, -dy, -dz);
        break;
      }
    }
    if (!reference) return { ok: false, error: 'no support block to place against' };
    if (distance(this.position, pos) > 5) {
      const move = await this.goTo(pos, { range: 4 });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach build position' };
    }
    try {
      await this.bot.equip(item, 'hand');
      await this.bot.placeBlock(reference, face);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this._blockCache.delete(`${pos.x},${pos.y},${pos.z}`);
    this.stats.placed++;
    this._syncInventory();
    return { ok: true, position: { ...pos }, item: itemName };
  }

  async fish({ timeoutMs = 20000 } = {}) {
    const check = this._assertReady();
    if (check) return check;
    const rod = this._findItem('fishing_rod');
    if (!rod) return { ok: false, error: 'no fishing_rod in inventory' };
    const mcData = require('minecraft-data')(this.bot.version);
    const waterIds = [mcData.blocksByName.water && mcData.blocksByName.water.id, mcData.blocksByName.flowing_water && mcData.blocksByName.flowing_water.id].filter((id) => id !== undefined && id !== null);
    const water = this.bot.findBlock({ matching: waterIds, maxDistance: 16 });
    if (!water) return { ok: false, error: 'no water within fishing range' };
    const before = { ...this.inventory };
    try {
      const move = await this.goTo({ x: water.position.x, y: water.position.y + 1, z: water.position.z }, { range: 3, timeoutMs: Math.min(timeoutMs, 15000) });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach the shore' };
      await this.bot.equip(rod, 'hand');
      await Promise.race([
        this.bot.fish(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('fishing timed out')), timeoutMs))
      ]);
      await new Promise((resolve) => setTimeout(resolve, 350));
      this._syncInventory();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const items = [];
    for (const [name, count] of Object.entries(this.inventory)) {
      const gained = count - (before[name] || 0);
      if (gained > 0) items.push({ name, count: gained });
    }
    if (!items.length) return { ok: false, error: 'no catch appeared in inventory' };
    return { ok: true, items, water: { x: water.position.x, y: water.position.y, z: water.position.z } };
  }

  async attack(entity, { authorizedPlayer = false, critical = false } = {}) {
    const check = this._assertReady();
    if (check) return check;
    if (!entity || !entity.id) return { ok: false, error: 'no target' };
    if (entity.username && BOT_NAMES.includes(entity.username)) return { ok: false, error: 'never attack teammates' };
    if (entity.username && config.autonomy.serverPvp === false) return { ok: false, error: 'server configuration has PvP disabled', code: 'SERVER_PVP_DISABLED' };
    if (entity.username && !authorizedPlayer) return { ok: false, error: 'PvP is disabled or the player is not explicitly authorised' };
    if (!entity.username && !entity.hostile && !HOSTILE.has(entity.name)) return { ok: false, error: `refusing to attack ${entity.name}` };
    const target = this.bot.entities[entity.id];
    if (!target) return { ok: false, error: 'target not visible' };
    const held = this.bot.heldItem ? this.bot.heldItem.name : null;
    const reach = held === 'bow' || held === 'crossbow' ? 32 : 4;
    if (distance(this.position, target.position) > reach) {
      const move = await this.goTo(target.position, { range: 2 });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach target' };
    }
    const ranged = held === 'bow' || held === 'crossbow';
    const beforeHealth = target.health;
    await this._aimAt(target, { lead: ranged ? distance(this.position, target.position) / 45 : 0 });
    if (ranged) {
      await this.bot.activateItem();
      await new Promise((resolve) => setTimeout(resolve, held === 'bow' ? 1000 : 1250));
      await this.bot.deactivateItem();
    } else {
      if (critical && this.bot.entity && this.bot.entity.onGround && !this.bot.entity.sprinting) {
        this.bot.setControlState('jump', true);
        await new Promise((resolve) => setTimeout(resolve, 120));
        this.bot.setControlState('jump', false);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this._aimAt(target);
      }
      await this.bot.attack(target);
    }
    this.stats.attacked++;
    // Damage and kills are only reported when the server exposes a health drop.
    await new Promise((resolve) => setTimeout(resolve, ranged ? 700 : 250));
    const observed = this.bot.entities && this.bot.entities[entity.id] ? this.bot.entities[entity.id].health : target.health;
    const damage = beforeHealth !== undefined && observed !== undefined ? Math.max(0, Number(beforeHealth) - Number(observed)) : undefined;
    const killed = observed !== undefined && Number(observed) <= 0;
    this._syncInventory();
    return { ok: true, target: entity.name || entity.username, weapon: held, damage, health: observed, killed: killed || undefined };
  }

  /** Aim at an observed entity; for projectiles lead its measured velocity. */
  async _aimAt(target, { lead = 0 } = {}) {
    const point = target.position.clone();
    if (lead > 0 && target.velocity && typeof target.velocity.clone === 'function') point.add(target.velocity.clone().scale(lead));
    point.y += target.height || 1.5;
    return this.bot.lookAt(point, true);
  }

  async consume(itemName = null) {
    const check = this._assertReady();
    if (check) return check;
    let foodName = itemName;
    if (!foodName) {
      const choice = this.bestFoodItem({ critical: this.food <= 6 });
      if (!choice) return { ok: false, error: 'no food' };
      foodName = choice.name;
    }
    const item = this._findItem(foodName);
    if (!item) return { ok: false, error: `no ${foodName} in inventory` };
    if (this.bot.food >= 20 && !FOODS[foodName]?.special && !/potion|milk_bucket/.test(foodName)) return { ok: false, error: 'not hungry' };
    try {
      await this.bot.equip(item, 'hand');
      await this.bot.consume();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.stats.eaten++;
    this.health = this.bot.health;
    this.food = this.bot.food;
    this._syncInventory();
    return { ok: true, item: foodName, food: this.food };
  }

  async sleep(bedPos) {
    const check = this._assertReady();
    if (check) return check;
    const block = this._blockAt(bedPos);
    if (!block || !BED_NAMES.has(block.name)) return { ok: false, error: 'no bed at position' };
    try {
      await this.goTo(bedPos, { range: 2 });
      await this.bot.sleep(block);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.isSleeping = true;
    return { ok: true, slept: true };
  }

  async wake() {
    if (this.bot && this.isSleeping) this.bot.wake();
    this.isSleeping = false;
    return { ok: true };
  }

  async openContainer(pos) {
    const check = this._assertReady();
    if (check) return check;
    const block = this._blockAt(pos);
    if (!block) return { ok: false, error: 'no block there' };
    let window;
    try {
      window = await this.bot.openContainer(block);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const self = this;
    return {
      ok: true,
      position: { ...pos },
      items: () => {
        const out = {};
        for (const item of window.containerItems()) out[item.name] = (out[item.name] || 0) + item.count;
        return out;
      },
      withdraw: async (itemName, count = 1) => {
        const matches = window.containerItems().filter((i) => i.name === itemName);
        let remaining = count;
        for (const item of matches) {
          if (remaining <= 0) break;
          const take = Math.min(item.count, remaining);
          await window.withdraw(item.type, null, take);
          remaining -= take;
        }
        self._syncInventory();
        return remaining < count ? { ok: true, item: itemName, count: count - remaining } : { ok: false, error: 'not in container' };
      },
      deposit: async (itemName, count = 1) => {
        const matches = self.bot.inventory.items().filter((i) => i.name === itemName);
        let remaining = count;
        for (const item of matches) {
          if (remaining <= 0) break;
          const put = Math.min(item.count, remaining);
          await window.deposit(item.type, null, put);
          remaining -= put;
        }
        self._syncInventory();
        return remaining < count ? { ok: true, item: itemName, count: count - remaining } : { ok: false, error: 'not in inventory' };
      },
      close: async () => { try { window.close(); } catch (_) { /* already closed */ } return { ok: true }; }
    };
  }

  async closeContainer() { return { ok: true }; }

  async tossItem(itemName, count = 1) {
    const check = this._assertReady();
    if (check) return check;
    const item = this._findItem(itemName);
    if (!item) return { ok: false, error: 'not held' };
    const toss = Math.min(count, item.count);
    await this.bot.toss(item.type, null, toss);
    this._syncInventory();
    return { ok: true, item: itemName, count: toss };
  }

  /** Drop only a short allow-list of junk; combat gear, totems, food and valuables are never touched. */
  async dropJunk() {
    const check = this._assertReady();
    if (check) return check;
    const junk = new Set(['dirt', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'cobblestone', 'netherrack']);
    const dropped = [];
    const items = this.bot.inventory && typeof this.bot.inventory.items === 'function' ? this.bot.inventory.items() : [];
    for (const item of items) {
      if (dropped.length >= 3) break;
      if (!junk.has(item.name)) continue;
      try {
        await this.bot.toss(item.type, null, item.count);
        dropped.push({ name: item.name, count: item.count });
      } catch (err) { return { ok: false, error: err.message, dropped }; }
    }
    this._syncInventory();
    return { ok: true, dropped, preservedCombatItems: true };
  }

  /** Move combat items into stable hotbar slots without displacing other protected combat gear. */
  async layoutHotbar() {
    const check = this._assertReady();
    if (check) return check;
    const inventory = this.bot.inventory;
    if (!inventory || !Array.isArray(inventory.slots) || typeof this.bot.moveSlotItem !== 'function') {
      return { ok: false, error: 'adapter cannot reorder the hotbar' };
    }
    const desired = [
      ['sword', 36, (name) => /_sword$/.test(name)],
      ['axe', 37, (name) => /_axe$/.test(name)],
      ['ranged', 38, (name) => name === 'bow' || name === 'crossbow'],
      ['golden_apple', 39, (name) => name === 'golden_apple' || name === 'enchanted_golden_apple'],
      ['potion', 40, (name) => /potion$/.test(name)],
      ['pickaxe', 41, (name) => /_pickaxe$/.test(name)],
      ['food', 42, (name) => Boolean(FOODS[name])],
      ['water_bucket', 43, (name) => name === 'water_bucket']
    ];
    const protectedItem = (name) => /_sword$|_axe$|bow|crossbow|potion|golden_apple|totem_of_undying|shield|_pickaxe$|_helmet$|_chestplate$|_leggings$|_boots$|elytra|trident|mace/.test(name) || Boolean(FOODS[name]);
    const moved = [];
    const skipped = [];
    for (const [key, dest, match] of desired) {
      const item = Object.values(inventory.slots).find((slot) => slot && match(slot.name));
      if (!item) continue;
      if (item.slot === dest) continue;
      const occupant = inventory.slots[dest];
      if (occupant && protectedItem(occupant.name)) { skipped.push({ key, reason: `slot ${dest} holds ${occupant.name}` }); continue; }
      try {
        await this.bot.moveSlotItem(item.slot, dest);
        moved.push({ key, item: item.name, from: item.slot, to: dest });
      } catch (err) { skipped.push({ key, reason: err.message }); }
    }
    this._syncInventory();
    return { ok: true, moved, skipped, protected: ['combat gear', 'totems', 'food', 'valuables'] };
  }

  async collectDrops(radius = 12) {
    const check = this._assertReady();
    if (check) return check;
    let collected = 0;
    const items = Object.values(this.bot.entities || {}).filter((e) => e.name === 'item' && distance(e.position, this.position) <= radius);
    for (const entity of items) {
      const move = await this.goTo(entity.position, { range: 1, timeoutMs: 6000 });
      if (move.ok) collected++;
    }
    this._syncInventory();
    return { ok: true, collected };
  }

  async craft(itemName, count = 1) {
    const check = this._assertReady();
    if (check) return check;
    const mcData = require('minecraft-data')(this.bot.version);
    const item = mcData.itemsByName[itemName];
    if (!item) return { ok: false, error: `unknown item ${itemName}` };
    const recipes = this.bot.recipesFor(item.id, null, 1, null);
    if (!recipes.length) {
      const table = this.bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 6 });
      if (!table) return { ok: false, error: `no recipe available for ${itemName}` };
      const tableRecipes = this.bot.recipesFor(item.id, null, 1, table);
      if (!tableRecipes.length) return { ok: false, error: `no recipe available for ${itemName}` };
      await this.bot.craft(tableRecipes[0], count, table);
    } else {
      await this.bot.craft(recipes[0], count, null);
    }
    this.stats.crafted++;
    this._syncInventory();
    return { ok: true, item: itemName, count };
  }

  async smelt(input, count = 1) {
    const check = this._assertReady();
    if (check) return check;
    const mcData = require('minecraft-data')(this.bot.version);
    const fuel = this._findItem('coal') || this._findItem('oak_planks') || this._findItem('charcoal');
    if (!fuel) return { ok: false, error: 'no fuel' };
    const inputItem = this._findItem(input);
    if (!inputItem) return { ok: false, error: `no ${input}` };
    const furnaceBlock = this.bot.findBlock({ matching: [mcData.blocksByName.furnace.id, mcData.blocksByName.blast_furnace.id, mcData.blocksByName.smoker.id], maxDistance: 6 });
    if (!furnaceBlock) return { ok: false, error: 'no furnace nearby' };
    const window = await this.bot.openFurnace(furnaceBlock);
    try {
      if (typeof window.putInput === 'function') {
        await window.putInput(inputItem.type, null, Math.min(count, inputItem.count));
        await window.putFuel(fuel.type, null, Math.min(fuel.count, Math.max(1, Math.ceil(count / 8))));
      } else {
        return { ok: false, error: 'furnace window does not expose input slots' };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(12000, 1200 + count * 900)));
      const output = window.outputItem ? window.outputItem() : null;
      if (output && typeof window.takeOutput === 'function') await window.takeOutput();
    } finally {
      try { window.close(); } catch (_) { /* closed */ }
    }
    this._syncInventory();
    return { ok: true, input, count };
  }

  async useShield(on) {
    const shield = this._findItem('shield');
    if (!shield) return { ok: false, error: 'no shield' };
    if (on) {
      if (this.getOffhand() !== 'shield') await this.bot.equip(shield, 'off-hand');
      if (typeof this.bot.activateItem === 'function') await this.bot.activateItem(true);
    } else if (typeof this.bot.deactivateItem === 'function') {
      await this.bot.deactivateItem();
    }
    return { ok: true, shield: Boolean(on), offhand: this.getOffhand() };
  }

  async say(message) {
    if (!this.bot) return { ok: false, error: 'not connected' };
    this.bot.chat(String(message).slice(0, 250));
    return { ok: true };
  }

  async chat(message) { return this.say(message); }

  async lookAt(pos) { if (this.bot && this.ready) await this.bot.lookAt(this._vec3(pos.x, pos.y, pos.z), true); return { ok: true }; }

  async jump() { if (this.bot && this.ready) this.bot.setControlState('jump', true); return { ok: true }; }

  async setControlState(control, state) {
    if (this.bot && this.ready) this.bot.setControlState(control, state);
    return { ok: true };
  }

  async damage() { return { ok: false, error: 'cannot damage a live bot directly' }; }

  async respawn() {
    if (!this.bot) return { ok: false, error: 'not connected' };
    if (typeof this.bot.respawn === 'function') this.bot.respawn();
    else this.bot._client.write('client_command', { actionId: 0 });
    return { ok: true };
  }

  onChat(listener) {
    this._chatListeners.add(listener);
    return () => this._chatListeners.delete(listener);
  }

  get chatLog() { return this._chatLog.slice(-50); }

  async disconnect(reason = 'shutdown') {
    try { if (this.bot) this.bot.quit(reason); } catch (_) { /* already gone */ }
    this.connected = false;
    this.spawned = false;
    this.authenticated = false;
    return { ok: true };
  }

  summary() {
    const base = super.summary();
    return {
      ...base,
      ready: this.ready,
      host: this.host,
      port: this.port,
      version: this.version,
      lastError: this.lastError,
      lastDeath: this.lastDeath,
      uptimeMs: this.uptimeMs,
      stats: { ...this.stats },
      chatLog: this.chatLog.slice(-8)
    };
  }
}

module.exports = { RealBot, HOSTILE, FLUID_BLOCKS };
