'use strict';

const { Logger } = require('../logger');
const { config } = require('../config');
const { distance } = require('../util/vec');
const { categoryOf, bestTool, FOODS, LOGS, PLANKS, inventorySlotUsage } = require('../world/items');
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
  constructor({ bot, ledger = null, memory = null, logger = null, home = null } = {}) {
    if (!bot) throw new Error('InventoryManager requires a bot');
    this.bot = bot;
    this.ledger = ledger;
    this.memory = memory;
    this.logger = logger || new Logger({ level: 'warn' });
    this.home = home ? { ...home } : null;
    this.homeStorage = null;
    this.stats = { deposited: 0, withdrawn: 0, shared: 0, crafted: 0, junkDropped: 0, overflowRuns: 0, overflowDropped: 0 };
  }

  snapshot() {
    const items = Object.entries(this.bot.inventory || {}).filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count, category: categoryOf(name) }))
      .sort((a, b) => b.count - a.count);
    const usage = this.slots();
    return {
      bot: this.bot.name,
      slotsUsed: usage.used,
      slotsFree: usage.free,
      capacity: usage.capacity,
      totalItems: items.reduce((s, i) => s + i.count, 0),
      items,
      food: items.filter((i) => FOODS[i.name]).reduce((s, i) => s + i.count, 0),
      tools: items.filter((i) => ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].includes(i.category)),
      blocks: items.filter((i) => i.category === 'block').reduce((s, i) => s + i.count, 0),
      full: this.bot.isInventoryFull ? this.bot.isInventoryFull() : false
    };
  }

  slots(capacity = 36) {
    if (typeof this.bot.inventorySlots === 'function') return this.bot.inventorySlots(capacity);
    return inventorySlotUsage(this.bot.inventory, capacity);
  }

  updateHome(home) { this.home = home ? { ...home } : null; }

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

  /** Public wrapper used by the pickaxe bootstrap (planks/table/furnace). */
  async ensurePlanks(needed = 4) {
    if (this._countPlanks() >= needed) return { ok: true, planks: this._countPlanks(), already: true };
    return this._convertLogsToPlanks(needed);
  }

  async ensureCraftingTable() {
    if (!this.home) return { ok: false, error: 'no home position for a crafting table' };
    return this._ensureCraftingTable(this.home, []);
  }

  async craftAt(item, count = 1) {
    let result = await this.bot.craft(item, count).catch((err) => ({ ok: false, error: err.message }));
    if (!result.ok && /recipe|table|crafting/i.test(String(result.error || ''))) {
      const table = await this.ensureCraftingTable();
      if (table.ok) result = await this.bot.craft(item, count).catch((err) => ({ ok: false, error: err.message }));
    }
    return result;
  }

  /**
   * A live furnace must exist within reach for realBot.smelt(). Craft and place
   * one at home when the bot lacks it; a real tool bootstrap cannot smelt iron
   * without this step.
   */
  async ensureFurnace() {
    const near = this.home || this.bot.position;
    const found = findBlocks(this.bot, ['furnace', 'blast_furnace'], { near, radius: 8, limit: 1 });
    if (found.length) return { ok: true, existing: true, position: { x: found[0].x, y: found[0].y, z: found[0].z } };
    if (!this.bot.countItem('furnace')) {
      if (this.bot.countItem('cobblestone') < 8) return { ok: false, error: 'need 8 cobblestone to craft a furnace' };
      const crafted = await this.craftAt('furnace', 1);
      if (!crafted.ok) return { ok: false, error: `cannot craft a furnace: ${crafted.error}` };
    }
    const site = this._freeChestSites(this.home, 6)[0];
    if (!site) return { ok: false, error: 'no free site for a furnace near home' };
    const move = await this.bot.goTo(site, { range: 4, timeoutMs: 12000 });
    if (move && move.ok === false) return { ok: false, error: `cannot reach the furnace site: ${move.error}` };
    const placed = await this.bot.placeBlock(site, 'furnace');
    if (!placed.ok) return { ok: false, error: `cannot place a furnace: ${placed.error}` };
    const name = this._blockName(site);
    if (name !== 'furnace' && name !== 'blast_furnace') return { ok: false, error: `furnace placement was not visible (${name})` };
    return { ok: true, position: site, placed: true };
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
    const before = typeof recipient.countItem === 'function' ? recipient.countItem(itemName) : 0;
    const toss = await this.bot.tossItem(itemName, count);
    if (!toss.ok) return toss;
    if (typeof recipient.addItem === 'function') {
      recipient.addItem(itemName, count);
    } else if (typeof recipient.refreshInventory === 'function') {
      // Real adapters cannot be mutated locally: wait for the pickup and then
      // verify the recipient's actual inventory before claiming the transfer.
      await new Promise((resolve) => setTimeout(resolve, 900));
      recipient.refreshInventory();
      const after = recipient.countItem(itemName);
      if (after < before + count) return { ok: false, error: 'recipient did not pick up the tossed item', tossed: true, item: itemName, count };
    } else {
      return { ok: false, error: 'recipient cannot receive tossed items through this adapter', tossed: true };
    }
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

  /**
   * Tools, combat gear, food and light stay on the bot. Everything else is
   * surplus that belongs in the home chest. Armour is normally equipped and
   * therefore absent from the inventory, but keep it if it is carried.
   */
  protectedItem(name) {
    if (!name) return true;
    if (FOODS[name]) return true;
    if (['torch', 'lantern', 'crafting_table', 'shield', 'water_bucket', 'bucket', 'fishing_rod', 'shears', 'flint_and_steel'].includes(name)) return true;
    if (/_seeds$|_sapling$|_propagule$/.test(name) || ['bone_meal', 'sugar_cane', 'cocoa_beans', 'pitcher_pod'].includes(name)) return true;
    if (categoryOf(name) === 'tools' || categoryOf(name) === 'armor' || categoryOf(name) === 'weapons') return true;
    if (/potion$|_potion$/.test(name) || name === 'golden_apple' || name === 'enchanted_golden_apple' || name === 'totem_of_undying') return true;
    if (/_helmet$|_chestplate$|_leggings$|_boots$|elytra/.test(name)) return true;
    return false;
  }

  protectedItems() {
    const kept = {};
    for (const [name, count] of Object.entries(this.bot.inventory || {})) {
      if (count > 0 && this.protectedItem(name)) kept[name] = count;
    }
    return kept;
  }

  _blockName(pos) {
    const block = typeof this.bot.getBlock === 'function' ? this.bot.getBlock(pos) : null;
    return block && block.name ? String(block.name).replace(/^minecraft:/, '') : null;
  }

  _chestsNear(home, radius = 7) {
    if (!home) return [];
    const origin = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z) };
    const chests = [];
    for (let y = origin.y - 3; y <= origin.y + 3; y++) {
      for (let z = origin.z - radius; z <= origin.z + radius; z++) {
        for (let x = origin.x - radius; x <= origin.x + radius; x++) {
          const pos = { x, y, z };
          const name = this._blockName(pos);
          if (name === 'chest' || name === 'trapped_chest') chests.push({ ...pos, name });
        }
      }
    }
    return chests;
  }

  _findDoubleChest(home) {
    const chests = this._chestsNear(home);
    for (const chest of chests) {
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const other = chests.find((entry) => entry.name === chest.name && entry.x === chest.x + dx && entry.y === chest.y && entry.z === chest.z + dz);
        if (other) return [chest, other];
      }
    }
    return null;
  }

  _freeChestSites(home, radius = 7) {
    if (!home) return [];
    const origin = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z) };
    const sites = [];
    for (let z = origin.z - radius; z <= origin.z + radius; z++) {
      for (let x = origin.x - radius; x <= origin.x + radius; x++) {
        const dx = x - origin.x;
        const dz = z - origin.z;
        const away = Math.hypot(dx, dz);
        if (away < 2) continue;
        const pos = { x, y: origin.y, z };
        const here = this._blockName(pos);
        const above = this._blockName({ x, y: origin.y + 1, z });
        const floor = this._blockName({ x, y: origin.y - 1, z });
        if (here !== 'air' && here !== 'cave_air') continue;
        if (above !== 'air' && above !== 'cave_air') continue;
        if (!floor || floor === 'air' || floor === 'cave_air' || /water|lava/.test(floor)) continue;
        sites.push({ ...pos, distance: away });
      }
    }
    return sites.sort((a, b) => a.distance - b.distance);
  }

  _chooseSitePair(home, reserved = []) {
    const sites = this._freeChestSites(home).filter((site) => !reserved.some((r) => r.x === site.x && r.y === site.y && r.z === site.z));
    for (const site of sites) {
      const neighbour = sites.find((other) => {
        if (other === site) return false;
        if (other.y !== site.y) return false;
        return (Math.abs(other.x - site.x) === 1 && other.z === site.z) || (Math.abs(other.z - site.z) === 1 && other.x === site.x);
      });
      if (neighbour) return [site, neighbour];
    }
    return null;
  }

  _adjacentFreeSite(chest, home, reserved = []) {
    const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: chest.x + dx, y: chest.y, z: chest.z + dz }));
    for (const pos of candidates) {
      if (reserved.some((r) => r.x === pos.x && r.y === pos.y && r.z === pos.z)) continue;
      const here = this._blockName(pos);
      const above = this._blockName({ x: pos.x, y: pos.y + 1, z: pos.z });
      const floor = this._blockName({ x: pos.x, y: pos.y - 1, z: pos.z });
      if ((here === 'air' || here === 'cave_air') && (above === 'air' || above === 'cave_air')
        && floor && floor !== 'air' && floor !== 'cave_air' && !/water|lava/.test(floor)) {
        return { ...pos, distance: distance(pos, home) };
      }
    }
    return null;
  }

  _countPlanks() {
    return Object.entries(this.bot.inventory || {}).reduce((sum, [name, count]) => sum + (PLANKS.has(name) ? count : 0), 0);
  }

  async _convertLogsToPlanks(needed) {
    for (const [log, count] of Object.entries(this.bot.inventory || {})) {
      if (!LOGS.has(log) || count <= 0) continue;
      const planks = log.replace(/_log$|_wood$|_stem$/, '_planks');
      if (!PLANKS.has(planks)) continue;
      const batches = Math.min(count, Math.ceil(needed / 4));
      const crafted = await this.bot.craft(planks, batches).catch((err) => ({ ok: false, error: err.message }));
      if (!crafted.ok) return { ok: false, error: `could not mill ${log} into planks: ${crafted.error}` };
      if (this._countPlanks() >= needed) return { ok: true, planks };
    }
    return { ok: this._countPlanks() >= needed, error: `need ${needed} planks, hold ${this._countPlanks()}` };
  }

  async _ensureCraftingTable(home, reserved = []) {
    const existing = findBlocks(this.bot, ['crafting_table'], { near: home, radius: 6, limit: 1 });
    if (existing.length) return { ok: true, existing: true, position: existing[0] };
    if (this._countPlanks() < 4) await this._convertLogsToPlanks(4);
    if (this._countPlanks() < 4) return { ok: false, error: 'need 4 planks for a crafting table' };
    const crafted = await this.bot.craft('crafting_table', 1).catch((err) => ({ ok: false, error: err.message }));
    if (!crafted.ok) return { ok: false, error: `cannot craft a crafting table: ${crafted.error}` };
    const site = this._freeChestSites(home, 3).find((pos) => !reserved.some((r) => r.x === pos.x && r.y === pos.y && r.z === pos.z));
    if (!site) return { ok: false, error: 'no free site for a crafting table' };
    await this.bot.goTo(site, { range: 4, timeoutMs: 12000 });
    const placed = await this.bot.placeBlock(site, 'crafting_table');
    if (!placed.ok) return placed;
    if (this._blockName(site) !== 'crafting_table') return { ok: false, error: 'crafting table placement was not visible' };
    return { ok: true, position: site, placed: true };
  }

  async _craftChests(count) {
    const before = this.bot.countItem('chest');
    let have = before;
    if (have >= count) return { ok: true, crafted: 0, have };
    const needed = count - have;
    if (this._countPlanks() < needed * 8) {
      const milled = await this._convertLogsToPlanks(needed * 8);
      if (!milled.ok) return { ok: false, error: milled.error };
    }
    for (let i = 0; i < needed; i++) {
      let result = await this.bot.craft('chest', 1).catch((err) => ({ ok: false, error: err.message }));
      if (!result.ok && /recipe|table|ingredient/i.test(String(result.error || '')) && this.home) {
        const table = await this._ensureCraftingTable(this.home);
        if (table.ok) {
          if (this._countPlanks() < 8) await this._convertLogsToPlanks(8);
          result = await this.bot.craft('chest', 1).catch((err) => ({ ok: false, error: err.message }));
        }
      }
      if (!result.ok) return { ok: false, error: `could not craft chest ${i + 1}/${needed}: ${result.error}` };
      this.stats.crafted++;
    }
    have = this.bot.countItem('chest');
    return { ok: have >= count, crafted: have - before, have, error: have >= count ? undefined : `crafted ${have}/${count} chests` };
  }

  /** A full inventory can have no slot for crafting output. Free exactly one
   * slot from surplus, never from tools/gear. This is the only lossy path and
   * it is reported in the result. */
  async _makeCraftingRoom({ plankCost = 0 } = {}) {
    if (this.slots().free > 0) return { ok: true };
    // A plank stack that is fully consumed by the recipe frees its slot, so
    // no lossy fallback is needed in the common "16 planks" case.
    const planks = this._countPlanks();
    if (plankCost > 0 && planks >= plankCost && Math.ceil(planks / 64) > Math.ceil((planks - plankCost) / 64)) {
      return { ok: true, freedBy: 'crafting' };
    }
    const candidates = Object.entries(this.bot.inventory || {})
      .filter(([name, count]) => count > 0 && !this.protectedItem(name) && !PLANKS.has(name) && !LOGS.has(name) && name !== 'chest')
      .sort((a, b) => b[1] - a[1]);
    const pick = candidates[0];
    if (!pick) return { ok: false, error: 'inventory is full of protected items; no slot to craft into' };
    const tossed = await this.bot.tossItem(pick[0], 1).catch((err) => ({ ok: false, error: err.message }));
    if (!tossed.ok) return { ok: false, error: `could not free a crafting slot: ${tossed.error}` };
    this.stats.overflowDropped++;
    return { ok: true, dropped: { item: pick[0], count: 1 } };
  }

  _registerHomeStorage(positions, contents) {
    if (!this.ledger || !positions.length) return null;
    const canonical = [...positions].sort((a, b) => (a.x - b.x) || (a.z - b.z))[0];
    const id = `warehouse:home:${canonical.x},${canonical.y},${canonical.z}`;
    const entry = { position: { ...canonical }, counts: { ...contents }, label: 'home overflow' };
    this.ledger.updateStorage(id, entry);
    this.homeStorage = { id, positions: positions.map((pos) => ({ ...pos })), capacity: positions.length * 27, counts: { ...contents } };
    if (this.memory) this.memory.setFact('home_storage', { ...this.homeStorage, verifiedAt: Date.now() });
    return this.homeStorage;
  }

  async _depositSurplusAt(position, { exclude = null } = {}) {
    const move = await this.bot.goTo(position, { range: 3, timeoutMs: 15000 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const window = await this.bot.openContainer(position);
    if (!window.ok) return window;
    const before = { ...(this.bot.inventory || {}) };
    const movedItems = {};
    const failed = [];
    let moved = 0;
    try {
      const entries = Object.entries(before)
        .filter(([name, count]) => count > 0 && !this.protectedItem(name) && !(exclude && exclude.has(name)))
        .sort((a, b) => b[1] - a[1]);
      for (const [name, count] of entries) {
        const result = await window.deposit(name, count);
        if (result && result.ok) {
          movedItems[name] = result.count;
          moved += result.count;
        } else {
          failed.push({ item: name, error: result && result.error ? result.error : 'deposit failed' });
        }
      }
      const contents = { ...window.items() };
      const after = { ...(this.bot.inventory || {}) };
      const verified = Object.entries(movedItems).every(([name, count]) => Number(before[name] || 0) - Number(after[name] || 0) >= count
        && Number(contents[name] || 0) >= Number(before[name] || 0) - Number(after[name] || 0));
      return { ok: moved > 0 && verified, moved, items: movedItems, failed, verified, contents, before, after };
    } finally {
      await window.close();
    }
  }

  /** Pull construction materials back out of home storage before a build phase. */
  async ensureMaterials(required = {}, position = null) {
    const supplied = {};
    const missing = {};
    for (const [item, target] of Object.entries(required)) {
      const need = Math.max(0, Number(target) || 0) - this.bot.countItem(item);
      if (need <= 0) continue;
      const source = position || (this.homeStorage && this.homeStorage.positions && this.homeStorage.positions[0]) || null;
      const result = await this.withdraw(item, need, source);
      if (result.ok) supplied[item] = result.count;
      else missing[item] = { need, error: result.error };
    }
    return { ok: Object.keys(missing).length === 0, supplied, missing };
  }

  /**
   * The requested survival behaviour: when a resource task fills the bot, walk
   * home, place a real double chest beside the spawn point (crafting the chests
   * from logs/planks when necessary), deposit everything except tools/gear/
   * food/light, then return to the work site. The caller keeps its assignment;
   * this method never touches the task board.
   */
  async makeRoomAtHome({ home = this.home, resumeAt = null, reason = 'inventory full' } = {}) {
    const usage = this.slots();
    if (usage.used < usage.capacity) {
      return { attempted: false, ok: true, reason: 'inventory not full', slots: usage };
    }
    if (!home) return { attempted: false, ok: false, error: 'no home position to build storage at' };
    const origin = resumeAt || (this.bot.position ? { ...this.bot.position } : null);
    const report = {
      attempted: true, reason, home: { ...home }, origin, slotsBefore: usage,
      crafted: [], placed: [], dropped: [], deposit: null, doubleChest: false, resumed: false
    };
    this.stats.overflowRuns++;
    try {
      let pair = this._findDoubleChest(home);
      if (!pair) {
        const existing = this._chestsNear(home);
        const anchor = existing[0] || null;
        const need = anchor ? 1 : 2;
        // A single existing chest can absorb enough surplus to free the slot
        // needed for crafting its second half. If not, fall back to dropping
        // one surplus item (never a tool) so the requested double chest can
        // still be built.
        if (anchor && this.slots().free === 0) {
          const pre = await this._depositSurplusAt(anchor, { exclude: new Set([...PLANKS, ...LOGS, 'chest']) });
          report.preDeposit = pre && pre.moved ? { moved: pre.moved, items: pre.items } : null;
        }
        if (this.slots().free === 0) {
          const room = await this._makeCraftingRoom({ plankCost: need * 8 });
          if (!room.ok) return { ...report, ok: false, error: room.error };
          if (room.dropped) report.dropped.push(room.dropped);
        }
        const crafted = await this._craftChests(need);
        if (!crafted.ok) return { ...report, ok: false, error: crafted.error };
        if (crafted.crafted > 0) report.crafted.push({ item: 'chest', count: crafted.crafted });

        if (anchor) {
          const site = this._adjacentFreeSite(anchor, home);
          if (!site) {
            // The spawn chest is boxed in (terrain, beds, the base). Failing
            // the whole overflow trip left six bots permanently full and
            // re-scanning every 15s. Place the crafted chest on any other
            // clear ground near home; the existing chest is already real,
            // verified storage if nothing can be placed at all.
            report.singleChestFallback = true;
            report.singleChestReason = 'no free block beside the existing home chest';
            const alternate = this._freeChestSites(home).find((candidate) => !(
              candidate.x === anchor.x && candidate.y === anchor.y && candidate.z === anchor.z
            ));
            if (alternate) {
              const move = await this.bot.goTo(alternate, { range: 4, timeoutMs: 15000 });
              if (!(move && move.ok === false)) {
                const placed = await this.bot.placeBlock(alternate, 'chest');
                if (placed.ok && this._blockName(alternate) === 'chest') {
                  report.placed.push({ ...alternate });
                  report.singleChestFallback = false;
                  report.singleChestAlternative = { ...alternate };
                }
              }
            }
          } else {
            const move = await this.bot.goTo(site, { range: 4, timeoutMs: 15000 });
            if (move && move.ok === false) return { ...report, ok: false, error: move.error };
            const placed = await this.bot.placeBlock(site, 'chest');
            if (!placed.ok) return { ...report, ok: false, error: placed.error };
            if (this._blockName(site) !== 'chest') return { ...report, ok: false, error: 'chest placement was not visible in the world' };
            report.placed.push({ ...site });
          }
        } else {
          const chosen = this._chooseSitePair(home);
          if (!chosen) return { ...report, ok: false, error: 'no clear ground beside home for a double chest' };
          for (const site of chosen) {
            const move = await this.bot.goTo(site, { range: 4, timeoutMs: 15000 });
            if (move && move.ok === false) return { ...report, ok: false, error: move.error };
            const placed = await this.bot.placeBlock(site, 'chest');
            if (!placed.ok) return { ...report, ok: false, error: placed.error };
            if (this._blockName(site) !== 'chest') return { ...report, ok: false, error: 'chest placement was not visible in the world' };
            report.placed.push({ ...site });
          }
        }
        pair = this._findDoubleChest(home);
        if (!pair) {
          // One half is still real storage; use it rather than losing the trip.
          // Prefer a newly placed empty chest, then the existing anchor.
          const chests = this._chestsNear(home);
          const single = chests.find((chest) => !(anchor && chest.x === anchor.x && chest.y === anchor.y && chest.z === anchor.z))
            || anchor
            || chests[0];
          if (!single) return { ...report, ok: false, error: 'placed chest was not found in the world' };
          pair = [single];
        }
      }
      report.doubleChest = pair.length === 2;
      const deposit = await this._depositSurplusAt(pair[0]);
      report.deposit = deposit;
      if (!deposit.ok && !deposit.moved) {
        return { ...report, ok: false, error: deposit.error || 'could not deposit surplus' };
      }
      const storage = this._registerHomeStorage(pair, deposit.contents || {});
      if (deposit.items) this.stats.deposited += Object.values(deposit.items).reduce((sum, count) => sum + count, 0);
      report.storage = storage;
      report.slotsAfter = this.slots();
      report.kept = this.protectedItems();
      if (origin && this.bot.position && distance(origin, this.bot.position) > 4) {
        const back = await this.bot.goTo(origin, { range: 3, timeoutMs: 20000 });
        report.resumed = !(back && back.ok === false);
        report.resumeError = back && back.ok === false ? back.error : undefined;
      } else {
        report.resumed = true;
      }
      this.logger.info(`[${this.bot.name}] home storage: ${report.doubleChest ? 'double chest' : 'single chest'} at ${pair[0].x},${pair[0].y},${pair[0].z}; deposited ${deposit.moved} items, kept ${Object.keys(report.kept).length} protected stacks`);
      return { ...report, ok: true };
    } catch (err) {
      return { ...report, ok: false, error: err.message };
    }
  }

  status() {
    return { ...this.snapshot(), reserves: this.reserveStatus(), bestTools: { pickaxe: bestTool(this.bot.inventory, 'pickaxe'), axe: bestTool(this.bot.inventory, 'axe') }, stats: { ...this.stats } };
  }
}

module.exports = { InventoryManager, TOOL_MATERIALS };
