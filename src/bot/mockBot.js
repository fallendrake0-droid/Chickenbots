'use strict';

const { BotAdapter } = require('./adapter');
const { MockWorld, DROPS } = require('./mockWorld');
const { delay, CancelledError } = require('../util/async');
const { distance, key } = require('../util/vec');
const { PICKAXES, AXES, SHOVELS, SWORDS, toolTier, BED_NAMES, FOODS } = require('../world/items');

const PICK_REQUIRED = {
  stone: 1, cobblestone: 1, deepslate: 1, cobbled_deepslate: 1, andesite: 1, diorite: 1, granite: 1, tuff: 1,
  iron_ore: 2, deepslate_iron_ore: 2, copper_ore: 2, deepslate_copper_ore: 2, lapis_ore: 2, deepslate_lapis_ore: 2,
  gold_ore: 3, deepslate_gold_ore: 3, redstone_ore: 3, deepslate_redstone_ore: 3, diamond_ore: 3, deepslate_diamond_ore: 3,
  emerald_ore: 3, deepslate_emerald_ore: 3, obsidian: 4, ancient_debris: 4, iron_block: 2, gold_block: 3, diamond_block: 3,
  stone_bricks: 1, cobblestone_wall: 1, furnace: 1, blast_furnace: 1, spawner: 1
};

const SHOVEL_BLOCKS = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'sand', 'red_sand', 'gravel', 'clay', 'mud', 'soul_sand', 'soul_soil', 'snow', 'snow_block', 'farmland']);
const AXE_BLOCKS = /_log$|_wood$|_planks$|_fence$|_door$|_trapdoor$|crafting_table|chest|barrel|bookshelf/;

const RECIPES = {
  oak_planks: { yield: 4, ingredients: { oak_log: 1 } },
  stick: { yield: 4, ingredients: { oak_planks: 2 } },
  crafting_table: { yield: 1, ingredients: { oak_planks: 4 } },
  wooden_pickaxe: { yield: 1, ingredients: { oak_planks: 3, stick: 2 } },
  wooden_axe: { yield: 1, ingredients: { oak_planks: 3, stick: 2 } },
  wooden_shovel: { yield: 1, ingredients: { oak_planks: 1, stick: 2 } },
  wooden_sword: { yield: 1, ingredients: { oak_planks: 2, stick: 1 } },
  stone_pickaxe: { yield: 1, ingredients: { cobblestone: 3, stick: 2 } },
  stone_axe: { yield: 1, ingredients: { cobblestone: 3, stick: 2 } },
  stone_sword: { yield: 1, ingredients: { cobblestone: 2, stick: 1 } },
  stone_shovel: { yield: 1, ingredients: { cobblestone: 1, stick: 2 } },
  iron_pickaxe: { yield: 1, ingredients: { iron_ingot: 3, stick: 2 } },
  iron_sword: { yield: 1, ingredients: { iron_ingot: 2, stick: 1 } },
  iron_axe: { yield: 1, ingredients: { iron_ingot: 3, stick: 2 } },
  iron_shovel: { yield: 1, ingredients: { iron_ingot: 1, stick: 2 } },
  diamond_pickaxe: { yield: 1, ingredients: { diamond: 3, stick: 2 } },
  diamond_sword: { yield: 1, ingredients: { diamond: 2, stick: 1 } },
  diamond_axe: { yield: 1, ingredients: { diamond: 3, stick: 2 } },
  torch: { yield: 4, ingredients: { coal: 1, stick: 1 } },
  chest: { yield: 1, ingredients: { oak_planks: 8 } },
  furnace: { yield: 1, ingredients: { cobblestone: 8 } },
  bucket: { yield: 1, ingredients: { iron_ingot: 3 } },
  bread: { yield: 1, ingredients: { wheat: 3 } },
  white_bed: { yield: 1, ingredients: { white_wool: 3, oak_planks: 3 } },
  ladder: { yield: 3, ingredients: { stick: 7 } },
  oak_fence: { yield: 3, ingredients: { oak_planks: 4, stick: 2 } },
  glass: { yield: 1, ingredients: { sand: 1 }, requiresFurnace: true },
  iron_ingot: { yield: 1, ingredients: { raw_iron: 1 }, requiresFurnace: true }
};

/**
 * Deterministic mock bot with the same adapter contract as a live Mineflayer
 * bot. Used by the simulator, the dashboard demo and the unit/integration tests.
 */
class MockBot extends BotAdapter {
  constructor({ name, world = null, speed = 0, inventory = {}, position = null, logger = null } = {}) {
    super({ name, world, logger, speed });
    this.world = world || new MockWorld();
    this.speed = speed;
    this.position = position || { x: 0, y: this.world.surfaceY(0, 0) + 1, z: 0 };
    for (const [item, count] of Object.entries(inventory)) if (count > 0) this.inventory[item] = count;
    this.containers = new Map();
    this.isSleeping = false;
    this.uptimeMs = 0;
    this.startedAt = Date.now();
    this._lastDamage = 0;
    this._tickHandle = null;
    this.stats = { dug: 0, placed: 0, moved: 0, attacked: 0, eaten: 0, crafted: 0, fished: 0, deaths: 0 };
    this._updateEquipment();
  }

  async _wait(ms) {
    if (!this.speed || this.speed <= 0) return;
    await delay(Math.max(1, Math.round(ms / this.speed)));
  }

  get time() { return { timeOfDay: this.world.time, day: Math.floor(this.world.time / 24000) + 1 }; }

  getBlock(pos) { return this.world.getBlock(pos); }

  isDiggable(name) {
    const required = PICK_REQUIRED[name] || 0;
    if (required > 0) {
      const tool = this.bestToolFor('pickaxe');
      if (!tool || tool.tier < required) return false;
    }
    return true;
  }

  _requiredTier(name) { return PICK_REQUIRED[name] || 0; }

  _updateEquipment() {
    const pick = this.bestToolFor('pickaxe');
    const axe = this.bestToolFor('axe');
    const shovel = this.bestToolFor('shovel');
    const sword = this.bestToolFor('sword');
    this.equipment = {
      pickaxe: pick ? pick.tier : 0,
      axe: axe ? axe.tier : 0,
      shovel: shovel ? shovel.tier : 0,
      sword: sword ? sword.tier : 0,
      armor: this.armorPoints(),
      shield: Boolean(this.inventory.shield),
      bow: Boolean(this.inventory.bow),
      pickaxeName: pick ? pick.name : null,
      axeName: axe ? axe.name : null,
      swordName: sword ? sword.name : null
    };
  }

  addItem(name, count = 1) {
    if (!name || count <= 0) return;
    this.inventory[name] = (this.inventory[name] || 0) + count;
    this._updateEquipment();
  }

  removeItem(name, count = 1) {
    if (!this.inventory[name]) return false;
    this.inventory[name] -= count;
    if (this.inventory[name] <= 0) delete this.inventory[name];
    this._updateEquipment();
    return true;
  }

  async equipBestTool(category) {
    const tool = this.bestToolFor(category);
    if (!tool) return { ok: false, error: `no ${category} in inventory` };
    this._updateEquipment();
    return { ok: true, tool };
  }

  async equipItem(name, destination = 'hand') {
    if (!this.countItem(name)) return { ok: false, error: 'not in inventory' };
    if (destination === 'off-hand') this.equipment.shield = name === 'shield';
    this._updateEquipment();
    return { ok: true, name };
  }

  async goTo(pos, { range = 1, token = null, timeoutMs = 15000 } = {}) {
    if (token && token.cancelled) throw new CancelledError(token.reason);
    if (!pos) return { ok: false, error: 'no target' };
    const target = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const start = { ...this.position };
    // Descending into an open shaft is a direct move, not a path around it.
    if (target.x === Math.floor(start.x) && target.z === Math.floor(start.z) && target.y === Math.floor(start.y) - 1) {
      const below = this.getBlock(target);
      const head = this.getBlock({ x: target.x, y: target.y + 1, z: target.z });
      if ((!below || below.name === 'air' || below.name === 'water') && (!head || head.name === 'air')) {
        this.position = { x: target.x, y: target.y, z: target.z };
        this.stats.moved++;
        this.fallDistance = 0;
        await this._wait(120);
        return { ok: true, descended: true, position: { ...this.position } };
      }
    }
    if (distance(start, target) <= Math.max(1, range)) return { ok: true, already: true, position: { ...this.position } };
    // Stand beside the target (not on the block being worked), preferring a
    // stance at the target's own level so mining/excavation reach is realistic.
    const stances = [
      { x: target.x, y: target.y, z: target.z + 1 },
      { x: target.x + 1, y: target.y, z: target.z },
      { x: target.x - 1, y: target.y, z: target.z },
      { x: target.x, y: target.y, z: target.z - 1 },
      { x: target.x, y: target.y + 1, z: target.z }
    ];
    for (const stance of stances) {
      const foot = this.getBlock(stance);
      const head = this.getBlock({ x: stance.x, y: stance.y + 1, z: stance.z });
      if ((!foot || foot.name === 'air' || foot.name === 'water') && (!head || head.name === 'air')) {
        this.position = { x: stance.x, y: stance.y, z: stance.z };
        this.stats.moved++;
        this.fallDistance = 0;
        await this._wait(250);
        return { ok: true, position: { ...this.position }, distance: distance(start, this.position), range };
      }
    }
    // Terrain navigation: walk toward the target on the surface if no stance is open.
    const ground = this.world.surfaceY(target.x, target.z) + 1;
    this.position = { x: target.x, y: ground, z: target.z };
    this.stats.moved++;
    this.fallDistance = 0;
    await this._wait(400);
    return { ok: true, position: { ...this.position }, distance: distance(start, this.position), range };
  }

  async goNear(entity, range = 2, options = {}) {
    if (!entity || !entity.position) return { ok: false, error: 'no entity' };
    const d = distance(this.position, entity.position);
    if (d <= range) return { ok: true, already: true };
    const dir = { x: entity.position.x - this.position.x, z: entity.position.z - this.position.z };
    const len = Math.hypot(dir.x, dir.z) || 1;
    const target = { x: Math.round(entity.position.x - (dir.x / len) * range), y: entity.position.y, z: Math.round(entity.position.z - (dir.z / len) * range) };
    return this.goTo(target, options);
  }

  async digBlock(pos, { token = null, timeoutMs = 15000 } = {}) {
    if (token && token.cancelled) throw new CancelledError(token.reason);
    if (distance(this.position, pos) > 5) return { ok: false, error: 'too far to dig' };
    const block = this.getBlock(pos);
    if (!block || block.name === 'air') return { ok: false, error: 'already air' };
    if (!this.isDiggable(block.name)) return { ok: false, error: `need better tool for ${block.name}` };
    const tier = this._requiredTier(block.name);
    const tool = tier > 0 ? this.bestToolFor('pickaxe') : this.bestToolFor('axe');
    const baseMs = tier > 0 ? (block.name.includes('deepslate') ? 700 : 500) : (AXE_BLOCKS.test(block.name) ? 350 : SHOVEL_BLOCKS.has(block.name) ? 300 : 400);
    const speedFactor = tool ? 1 - tool.tier * 0.1 : 1;
    await this._wait(baseMs * speedFactor);
    this.world.setBlock(pos, 'air');
    this.stats.dug++;
    const drops = {};
    const drop = DROPS[block.name] === undefined ? block.name : DROPS[block.name];
    if (drop) {
      const count = block.name.includes('leaves') ? ((pos.x * 7 + pos.z * 13 + pos.y) % 5 === 0 ? 1 : 0) : 1;
      if (count > 0) {
        drops[drop] = count;
        this.addItem(drop, count);
      }
    }
    return { ok: true, block: block.name, drops };
  }

  async placeBlock(pos, itemName, { token = null } = {}) {
    if (token && token.cancelled) throw new CancelledError(token.reason);
    if (!this.countItem(itemName)) return { ok: false, error: `no ${itemName}` };
    const existing = this.getBlock(pos);
    if (existing && existing.name !== 'air' && existing.name !== 'water') return { ok: false, error: 'space occupied' };
    if (distance(this.position, pos) > 6) return { ok: false, error: 'too far to place' };
    // Buckets place their fluid, not a solid bucket block.
    const placedName = itemName === 'water_bucket' ? 'water' : itemName === 'lava_bucket' ? 'lava' : itemName;
    this.removeItem(itemName, 1);
    this.world.setBlock(pos, placedName);
    this.stats.placed++;
    await this._wait(80);
    return { ok: true, position: { ...pos }, item: itemName };
  }

  async consume(itemName = null) {
    const food = itemName ? { name: itemName, ...(FOODS[itemName] || {}) } : this.bestFoodItem({ critical: this.food <= 6 });
    if (!food || !food.name) return { ok: false, error: 'no food' };
    if (!this.countItem(food.name)) return { ok: false, error: `no ${food.name} in inventory` };
    this.removeItem(food.name, 1);
    const hunger = (FOODS[food.name] && FOODS[food.name].hunger) || 4;
    const saturation = (FOODS[food.name] && FOODS[food.name].saturation) || 2;
    this.food = Math.min(20, this.food + hunger);
    this.saturation = Math.min(20, this.saturation + saturation);
    this.stats.eaten++;
    await this._wait(1200);
    return { ok: true, item: food.name, food: this.food, saturation: this.saturation };
  }

  async fish({ timeoutMs = 2000 } = {}) {
    if (!this.countItem('fishing_rod')) return { ok: false, error: 'no fishing_rod in inventory' };
    const water = this.world && typeof this.world.findBlocks === 'function'
      ? this.world.findBlocks(['water', 'flowing_water'], this.position, 16, 1)
      : [];
    if (!water.length) return { ok: false, error: 'no water within fishing range' };
    await this._wait(Math.min(1800, Math.max(400, timeoutMs)));
    const options = ['cod', 'cod', 'salmon', 'tropical_fish', 'pufferfish'];
    const item = options[this.stats.fished % options.length];
    this.addItem(item, 1);
    this.stats.fished++;
    return { ok: true, item, count: 1, items: [{ name: item, count: 1 }], water: { ...water[0] } };
  }

  async attack(entity, { token = null } = {}) {
    if (token && token.cancelled) throw new CancelledError(token.reason);
    if (!entity) return { ok: false, error: 'no target' };
    if (entity.type === this.name) return { ok: false, error: 'never attack teammates' };
    if (distance(this.position, entity.position) > 4) return { ok: false, error: 'out of reach' };
    const swordTier = this.equipment.sword || 0;
    const damage = 1 + swordTier * 1.5 + (this.effects.strength ? 3 : 0);
    // Controllers pass snapshots; always mutate the live world entity.
    const live = this.world.entities.find((e) => e.id === entity.id) || entity;
    live.health = (live.health === undefined ? 20 : live.health) - damage;
    this.stats.attacked++;
    await this._wait(600);
    if (live.health <= 0) {
      live.alive = false;
      this.world.removeMob(live.id);
      return { ok: true, killed: true, entity: live.type };
    }
    return { ok: true, killed: false, entity: live.type, health: live.health };
  }

  async useShield(on) {
    this.equipment.shield = Boolean(on && this.countItem('shield'));
    return { ok: this.equipment.shield, shield: this.equipment.shield };
  }

  async sleep(bedPos) {
    const block = this.getBlock(bedPos);
    if (!block || !BED_NAMES.has(block.name)) return { ok: false, error: 'no bed at position' };
    if (this.world.time < 12541 || this.world.time > 23459) return { ok: false, error: 'not night' };
    this.isSleeping = true;
    this.position = { x: bedPos.x, y: bedPos.y + 1, z: bedPos.z };
    this.world.setTime(0);
    await this._wait(500);
    this.isSleeping = false;
    return { ok: true, slept: true, time: this.world.time };
  }

  async wake() { this.isSleeping = false; return { ok: true }; }

  async openContainer(pos) {
    const block = this.getBlock(pos);
    if (!block || !['chest', 'barrel', 'trapped_chest', 'shulker_box'].includes(block.name)) return { ok: false, error: 'no container there' };
    const k = key(pos);
    if (!this.containers.has(k)) this.containers.set(k, {});
    const contents = this.containers.get(k);
    const self = this;
    return {
      ok: true,
      position: { ...pos },
      items: () => contents,
      withdraw: async (itemName, count = 1) => {
        const have = contents[itemName] || 0;
        const take = Math.min(have, count);
        if (take <= 0) return { ok: false, error: 'not in container' };
        contents[itemName] -= take;
        if (contents[itemName] <= 0) delete contents[itemName];
        self.addItem(itemName, take);
        return { ok: true, item: itemName, count: take };
      },
      deposit: async (itemName, count = 1) => {
        const have = self.countItem(itemName);
        const put = Math.min(have, count);
        if (put <= 0) return { ok: false, error: 'not in inventory' };
        self.removeItem(itemName, put);
        contents[itemName] = (contents[itemName] || 0) + put;
        return { ok: true, item: itemName, count: put };
      },
      close: async () => ({ ok: true })
    };
  }

  async closeContainer() { return { ok: true }; }

  async tossItem(itemName, count = 1) {
    if (!this.countItem(itemName)) return { ok: false, error: 'not held' };
    const toss = Math.min(count, this.countItem(itemName));
    this.removeItem(itemName, toss);
    return { ok: true, item: itemName, count: toss };
  }

  async craft(itemName, count = 1) {
    const recipe = RECIPES[itemName];
    if (!recipe) return { ok: false, error: `no recipe for ${itemName}` };
    if (recipe.requiresFurnace) return { ok: false, error: 'requires a furnace' };
    for (let i = 0; i < count; i++) {
      for (const [ing, n] of Object.entries(recipe.ingredients)) {
        if (this.countItem(ing) < n) return { ok: false, error: `missing ${ing}` };
      }
      for (const [ing, n] of Object.entries(recipe.ingredients)) this.removeItem(ing, n);
      this.addItem(itemName, recipe.yield);
      this.stats.crafted++;
    }
    await this._wait(300);
    return { ok: true, item: itemName, count: recipe.yield * count };
  }

  async smelt(input, count = 1) {
    const output = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot', sand: 'glass', cobblestone: 'stone' }[input];
    if (!output) return { ok: false, error: `cannot smelt ${input}` };
    if (this.countItem(input) < count) return { ok: false, error: `missing ${input}` };
    if (!this.countItem('coal') && !this.countItem('oak_planks')) return { ok: false, error: 'no fuel' };
    this.removeItem(input, count);
    this.addItem(output, count);
    if (this.countItem('coal')) this.removeItem('coal', 1); else this.removeItem('oak_planks', 1);
    return { ok: true, output, count };
  }

  async say(message) {
    this.lastChat = String(message).slice(0, 250);
    return { ok: true };
  }

  async chat(message) { return this.say(message); }

  async setControlState(control, state) { this.controls = this.controls || {}; this.controls[control] = state; return { ok: true }; }

  async lookAt(pos) { return { ok: true }; }

  async jump() { return { ok: true }; }

  async collectDrops() { return { ok: true, collected: 0 }; }

  async dropJunk() {
    const dropped = [];
    for (const [name, count] of Object.entries(this.inventory)) {
      if (dropped.length >= 3) break;
      if (['dirt', 'gravel', 'andesite', 'diorite', 'granite', 'tuff'].includes(name)) {
        await this.tossItem(name, count);
        dropped.push(name);
      }
    }
    return { ok: true, dropped };
  }

  damage(amount, cause = 'mob') {
    this.health = Math.max(0, this.health - amount);
    this._lastDamage = Date.now();
    if (this.health <= 0) {
      this.deaths++;
      this.stats.deaths++;
      this.diedAt = { ...this.position };
      return { dead: true };
    }
    return { dead: false, health: this.health };
  }

  respawn(position = null) {
    this.health = 20;
    this.food = 20;
    this.position = position || { x: 0, y: this.world.surfaceY(0, 0) + 1, z: 0 };
    this.isSleeping = false;
    this.inLava = false;
    this.onFire = false;
    return { ok: true, position: this.position };
  }

  startTicking(intervalMs = 500) {
    if (this._tickHandle) return;
    this._tickHandle = setInterval(() => {
      this.uptimeMs = Date.now() - this.startedAt;
      this.world.advanceTime(20);
      this.food = Math.max(0, this.food - 0.02);
      if (this.food > 17 && this.health < 20) this.health = Math.min(20, this.health + 0.1);
    }, intervalMs);
    if (this._tickHandle.unref) this._tickHandle.unref();
  }

  stopTicking() {
    if (this._tickHandle) clearInterval(this._tickHandle);
    this._tickHandle = null;
  }
}

module.exports = { MockBot, RECIPES, PICK_REQUIRED };
