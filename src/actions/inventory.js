'use strict';

const { Logger } = require('../logger');
const { config } = require('../config');
const { distance } = require('../util/vec');
const { categoryOf, bestTool, FOODS } = require('../world/items');
const { findBlocks } = require('./common');

const TOOL_MATERIALS = {
  wooden_pickaxe: { oak_planks: 3, stick: 2 },
  wooden_axe: { oak_planks: 3, stick: 2 },
  stone_pickaxe: { cobblestone: 3, stick: 2 },
  stone_axe: { cobblestone: 3, stick: 2 },
  stone_sword: { cobblestone: 2, stick: 1 },
  iron_pickaxe: { iron_ingot: 3, stick: 2 },
  iron_sword: { iron_ingot: 2, stick: 1 },
  torch: { coal: 1, stick: 1 }
};

/**
 * Inventory, storage and reserve management.
 *
 * Reserves are real counts (bot inventories plus verified storage), deposits
 * and withdrawals move items through container windows, and sharing between
 * teammates is a real toss (recorded as a ledger transfer).
 */
class InventoryManager {
  constructor({ bot, ledger = null, memory = null, logger = null } = {}) {
    if (!bot) throw new Error('InventoryManager requires a bot');
    this.bot = bot;
    this.ledger = ledger;
    this.memory = memory;
    this.logger = logger || new Logger({ level: 'warn' });
    this.stats = { deposited: 0, withdrawn: 0, shared: 0, crafted: 0, junkDropped: 0 };
  }

  snapshot() {
    const items = Object.entries(this.bot.inventory || {}).filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count, category: categoryOf(name) }))
      .sort((a, b) => b.count - a.count);
    return {
      bot: this.bot.name,
      slotsUsed: items.length,
      totalItems: items.reduce((s, i) => s + i.count, 0),
      items,
      food: items.filter((i) => FOODS[i.name]).reduce((s, i) => s + i.count, 0),
      tools: items.filter((i) => ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].includes(i.category)),
      blocks: items.filter((i) => i.category === 'block').reduce((s, i) => s + i.count, 0),
      full: this.bot.isInventoryFull ? this.bot.isInventoryFull() : false
    };
  }

  reserveStatus() {
    const targets = { ...config.reserves };
    const held = {};
    const shortages = [];
    for (const [item, target] of Object.entries(targets)) {
      let count = this.bot.countItem(item);
      if (item === 'food') {
        count = Object.entries(this.bot.inventory).filter(([n]) => FOODS[n]).reduce((s, [, c]) => s + c, 0);
      }
      held[item] = count;
      if (count < target) shortages.push({ item, have: count, target, missing: target - count });
    }
    return { targets, held, shortages, satisfied: shortages.length === 0 };
  }

  reportInventory() {
    if (this.ledger) this.ledger.updateBotInventory(this.bot.name, this.bot.inventory);
    return this.snapshot();
  }

  async ensureTool(category) {
    if (this.bot.bestToolFor(category)) return { ok: true, tool: this.bot.bestToolFor(category) };
    const candidates = Object.entries(TOOL_MATERIALS).filter(([name]) => name.includes(category));
    for (const [tool, materials] of candidates) {
      if (!Object.entries(materials).every(([name, count]) => this.bot.countItem(name) >= count)) continue;
      const result = await this.bot.craft(tool, 1);
      if (result.ok) { this.stats.crafted++; return { ok: true, tool, crafted: true }; }
    }
    return { ok: false, error: `cannot craft a ${category}` };
  }

  async findStorage() {
    if (!this.ledger) return null;
    let best = null;
    for (const storage of this.ledger.storages.values()) {
      if (!storage.position) continue;
      const d = distance(this.bot.position, storage.position);
      if (!best || d < best.distance) best = { id: storage.id, position: storage.position, distance: d };
    }
    if (best) return best;
    // No registered storage yet: discover real containers in the world, then
    // register them only after the position is known to hold a container.
    const containers = findBlocks(this.bot, ['chest', 'trapped_chest', 'barrel', 'shulker_box'], { radius: 32, limit: 12 });
    for (const block of containers) {
      const position = { x: block.x, y: block.y, z: block.z };
      const d = distance(this.bot.position, position);
      if (!best || d < best.distance) best = { id: `world:${block.name}:${block.x},${block.y},${block.z}`, position, distance: d, name: block.name };
    }
    if (best && this.ledger) this.ledger.updateStorage(best.id, { position: best.position, counts: {}, label: best.name || 'world storage' });
    return best;
  }

  async deposit(itemName, count, position = null) {
    const storage = position ? { id: `manual:${position.x},${position.y},${position.z}`, position } : await this.findStorage();
    if (!storage) return { ok: false, error: 'no verified storage' };
    const move = await this.bot.goTo(storage.position, { range: 3 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const window = await this.bot.openContainer(storage.position);
    if (!window.ok) return window;
    const result = await window.deposit(itemName, count);
    const remaining = window.items();
    await window.close();
    if (this.ledger) this.ledger.updateStorage(storage.id, { position: storage.position, counts: remaining });
    if (result.ok) this.stats.deposited += result.count;
    return result;
  }

  async withdraw(itemName, count, position = null) {
    const storage = position ? { id: `manual:${position.x},${position.y},${position.z}`, position } : await this.findStorage();
    if (!storage) return { ok: false, error: 'no verified storage' };
    const move = await this.bot.goTo(storage.position, { range: 3 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const window = await this.bot.openContainer(storage.position);
    if (!window.ok) return window;
    const result = await window.withdraw(itemName, count);
    const remaining = window.items();
    await window.close();
    if (this.ledger) this.ledger.updateStorage(storage.id, { position: storage.position, counts: remaining });
    if (result.ok) this.stats.withdrawn += result.count;
    return result;
  }

  async share(itemName, count, recipient) {
    if (!recipient || recipient === this.bot) return { ok: false, error: 'invalid recipient' };
    if (this.bot.countItem(itemName) < count) return { ok: false, error: `not enough ${itemName}` };
    const toss = await this.bot.tossItem(itemName, count);
    if (!toss.ok) return toss;
    if (typeof recipient.addItem === 'function') recipient.addItem(itemName, count);
    else return { ok: false, error: 'recipient cannot receive tossed items through this adapter' };
    this.stats.shared += count;
    if (this.ledger) {
      const request = this.ledger.requestTransfer({ from: this.bot.name, to: recipient.name, item: itemName, count, reason: 'inventory share' });
      if (request.ok) { this.ledger.claimTransfer(request.request.id, recipient.name); this.ledger.completeTransfer(request.request.id, true); }
    }
    return { ok: true, item: itemName, count, to: recipient.name };
  }

  async dropJunk() {
    if (typeof this.bot.dropJunk === 'function') {
      const result = await this.bot.dropJunk();
      this.stats.junkDropped += (result.dropped || []).length;
      return result;
    }
    return { ok: false, error: 'adapter does not support junk dropping' };
  }

  status() {
    return { ...this.snapshot(), reserves: this.reserveStatus(), bestTools: { pickaxe: bestTool(this.bot.inventory, 'pickaxe'), axe: bestTool(this.bot.inventory, 'axe') }, stats: { ...this.stats } };
  }
}

module.exports = { InventoryManager, TOOL_MATERIALS };
