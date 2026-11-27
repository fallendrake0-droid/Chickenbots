'use strict';

const { config } = require('../config');
const { Logger } = require('../logger');
const { bestFood } = require('../world/items');
const { needsFood, foodItems, hasFood } = require('./common');

// Operator-controlled survival routines. This is the single list used by the
// controller, the command handler, command metadata and the dashboard.
const SURVIVAL_FEATURES = Object.freeze(['eat', 'healing', 'armour', 'tools', 'crafting', 'shield']);

const ARMOUR_SLOTS = [
  { slot: 'head', names: ['netherite_helmet', 'diamond_helmet', 'iron_helmet', 'chainmail_helmet', 'golden_helmet', 'leather_helmet'] },
  { slot: 'torso', names: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'leather_chestplate'] },
  { slot: 'legs', names: ['netherite_leggings', 'diamond_leggings', 'iron_leggings', 'chainmail_leggings', 'golden_leggings', 'leather_leggings'] },
  { slot: 'feet', names: ['netherite_boots', 'diamond_boots', 'iron_boots', 'chainmail_boots', 'golden_boots', 'leather_boots'] }
];

const TOOL_RECIPES = [
  { tool: 'stone_pickaxe', materials: { cobblestone: 3, stick: 2 } },
  { tool: 'stone_axe', materials: { cobblestone: 3, stick: 2 } },
  { tool: 'stone_sword', materials: { cobblestone: 2, stick: 1 } },
  { tool: 'wooden_pickaxe', materials: { oak_planks: 3, stick: 2 } },
  { tool: 'wooden_axe', materials: { oak_planks: 3, stick: 2 } }
];

/**
 * Survival loop: eat before starving, heal, wear armour, keep a working tool,
 * and escape lava/fall emergencies. Every action goes through the adapter, so
 * the same logic is exercised in tests and on the live server.
 */
class SurvivalController {
  constructor({ bot, memory = null, logger = null, thresholds = config.survival } = {}) {
    if (!bot) throw new Error('SurvivalController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.logger = logger || new Logger({ level: 'warn' });
    this.thresholds = thresholds;
    this.lastAction = null;
    this.lastActionAt = 0;
    // Operator-controlled routines. Environmental clutch handling is always on
    // because disabling it would let a bot stand in lava.
    this.features = Object.fromEntries(SURVIVAL_FEATURES.map((feature) => [feature, true]));
    this.stats = { eaten: 0, crafted: 0, armourEquipped: 0, clutches: 0, emergencyHeals: 0 };
  }

  status() {
    const bot = this.bot;
    return {
      bot: bot.name,
      health: bot.health,
      food: bot.food,
      saturation: bot.saturation,
      armour: bot.armorPoints ? bot.armorPoints() : 0,
      bestFood: bestFood(bot.inventory),
      foodCount: foodItems(bot).reduce((s, f) => s + f.count, 0),
      needsFood: needsFood(bot, this.thresholds),
      pickaxe: bot.bestToolFor('pickaxe'),
      sword: bot.bestToolFor('sword'),
      hasShield: Boolean(bot.countItem('shield')),
      inLava: bot.inLava,
      inWater: bot.inWater,
      onFire: bot.onFire,
      lastAction: this.lastAction,
      features: { ...this.features },
      stats: { ...this.stats }
    };
  }

  setFeature(name, enabled) {
    if (!Object.prototype.hasOwnProperty.call(this.features, name)) {
      return { ok: false, error: `unknown survival routine '${name}'`, available: Object.keys(this.features) };
    }
    this.features[name] = Boolean(enabled);
    this.logger.info(`[${this.bot.name}] survival routine ${name} ${this.features[name] ? 'enabled' : 'disabled'}`);
    return { ok: true, bot: this.bot.name, feature: name, enabled: this.features[name], features: { ...this.features } };
  }

  async tick({ emergency = false } = {}) {
    const actions = [];
    const bot = this.bot;
    if (!bot || bot.health <= 0) return { actions, status: this.status(), dead: true };
    // Lava / fall emergencies come first: they kill faster than hunger.
    if (bot.inLava || bot.onFire || bot.fallDistance > 3) {
      const clutch = await this.clutch();
      if (clutch) actions.push(clutch);
    }
    const need = needsFood(bot, this.thresholds);
    if (this.features.eat && need) {
      const eat = await this.eat(need === 'critical');
      if (eat) actions.push(eat);
    }
    if (this.features.healing && bot.health <= this.thresholds.criticalHealth) {
      const heal = await this.emergencyHeal();
      if (heal) actions.push(heal);
    }
    // During a live threat, crafting a tool or cycling four armour slots is
    // not worth the milliseconds that could be spent moving out of reach.
    // Normal ticks still optimise equipment.
    if (!emergency && this.features.armour) {
      const armour = await this.equipArmour();
      if (armour.length) actions.push(...armour);
    }
    if (!emergency && this.features.tools) {
      const tool = await this.ensureTool();
      if (tool) actions.push(tool);
    }
    if (this.features.shield && bot.health <= this.thresholds.fleeHealth && bot.countItem('shield')) {
      const shield = await bot.useShield(true);
      if (shield.ok) actions.push({ action: 'shield', ...shield });
    }
    return { actions, status: this.status() };
  }

  async eat(critical = false) {
    const bot = this.bot;
    if (!hasFood(bot)) {
      this.lastAction = 'no-food';
      return { action: 'eat', ok: false, error: 'no food in inventory' };
    }
    // Golden apples are emergency healing, not regular rations.
    const pantry = { ...bot.inventory };
    delete pantry.golden_apple;
    delete pantry.enchanted_golden_apple;
    const choice = bestFood(pantry, { critical, health: bot.health }) || bestFood(bot.inventory, { critical, health: bot.health });
    if (!choice) return { action: 'eat', ok: false, error: 'no suitable food' };
    const result = await bot.consume(choice.name);
    if (result.ok) {
      this.stats.eaten++;
      this.lastAction = `ate ${choice.name}`;
    }
    return { action: 'eat', ...result };
  }

  async emergencyHeal() {
    const bot = this.bot;
    const golden = bot.countItem('golden_apple') ? 'golden_apple' : bot.countItem('enchanted_golden_apple') ? 'enchanted_golden_apple' : null;
    if (golden) {
      const result = await bot.consume(golden);
      if (result.ok) { this.stats.emergencyHeals++; this.lastAction = `healed with ${golden}`; }
      return { action: 'emergency-heal', ...result };
    }
    if (bot.food >= 18 && bot.health < 20) {
      // Natural regeneration is real; report it rather than pretending to heal.
      return { action: 'regenerate', ok: true, waiting: true, health: bot.health, food: bot.food };
    }
    return null;
  }

  async equipArmour() {
    const actions = [];
    for (const { slot, names } of ARMOUR_SLOTS) {
      const name = names.find((n) => this.bot.countItem(n) > 0);
      if (!name) continue;
      if (typeof this.bot.equipItem !== 'function') break;
      const result = await this.bot.equipItem(name, slot);
      if (result.ok) {
        this.stats.armourEquipped++;
        actions.push({ action: 'equip-armour', slot, item: name });
      }
    }
    return actions;
  }

  async ensureTool() {
    const bot = this.bot;
    const desired = ['pickaxe', 'axe', 'sword'];
    for (const category of desired) {
      if (bot.bestToolFor(category)) continue;
      const recipe = TOOL_RECIPES.find((r) => {
        if (!r.tool.includes(category)) return false;
        return Object.entries(r.materials).every(([name, count]) => bot.countItem(name) >= count);
      });
      if (!recipe) continue;
      if (!this.features.crafting) return null;
      const result = await bot.craft(recipe.tool, 1);
      if (result.ok) {
        this.stats.crafted++;
        this.lastAction = `crafted ${recipe.tool}`;
        return { action: 'craft-tool', tool: recipe.tool, ...result };
      }
      return { action: 'craft-tool', tool: recipe.tool, ok: false, error: result.error };
    }
    return null;
  }

  /**
   * Lava/fall clutch. Water is placed on the block below when falling or
   * beside the bot when burning; a solid block is placed underneath when the
   * bot has no water but is falling.
   */
  async clutch() {
    const bot = this.bot;
    if (bot.inLava || bot.onFire) {
      if (bot.countItem('water_bucket')) {
        const feet = { x: Math.floor(bot.position.x), y: Math.floor(bot.position.y), z: Math.floor(bot.position.z) };
        const below = { x: feet.x, y: feet.y - 1, z: feet.z };
        for (const spot of [below, feet, { x: feet.x + 1, y: feet.y, z: feet.z }]) {
          const block = bot.getBlock(spot);
          if (block && block.name !== 'air' && block.name !== 'water') continue;
          const result = await bot.placeBlock(spot, 'water_bucket');
          if (result.ok) {
            this.stats.clutches++;
            this.lastAction = 'water clutch';
            return { action: 'clutch', kind: 'water', ...result };
          }
        }
      }
      const away = { x: bot.position.x + 3, y: bot.position.y + 1, z: bot.position.z + 3 };
      const flee = await bot.goTo(away, { range: 2, priority: 'emergency', owner: 'survival-clutch' });
      if (flee.ok) {
        this.stats.clutches++;
        this.lastAction = 'fled lava/fire';
        return { action: 'clutch', kind: 'flee', ...flee };
      }
      return { action: 'clutch', ok: false, error: 'no escape available' };
    }
    if (bot.fallDistance > 3) {
      const below = { x: Math.floor(bot.position.x), y: Math.floor(bot.position.y) - 1, z: Math.floor(bot.position.z) };
      const block = ['oak_planks', 'cobblestone', 'dirt', 'stone'].find((n) => bot.countItem(n));
      if (block) {
        const result = await bot.placeBlock(below, block);
        if (result.ok) {
          this.stats.clutches++;
          this.lastAction = 'fall clutch';
          return { action: 'clutch', kind: 'block', ...result };
        }
      }
    }
    return null;
  }
}

module.exports = { SurvivalController, SURVIVAL_FEATURES, ARMOUR_SLOTS, TOOL_RECIPES };
