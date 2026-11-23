'use strict';

const { Logger } = require('../logger');
const { findBlocks } = require('../actions/common');
const { categoryForItem, categoryChestGroup, CATEGORY_ORDER } = require('./materials');
const { distance } = require('../util/vec');

const CONTAINER_NAMES = ['chest', 'trapped_chest', 'barrel', 'shulker_box'];

function containerKey(pos) { return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`; }

function storageId(name, pos) { return `warehouse:${name}:${containerKey(pos)}`; }

/**
 * A central, physical warehouse. Every count comes from opening a real
 * container. Categories map to chest groups; locks are cooperative
 * construction locks, not a claim about server-side chest locking.
 */
class Warehouse {
  constructor({ bots = [], ledger = null, memory = null, logger = null, now = () => Date.now() } = {}) {
    this.bots = bots;
    this.ledger = ledger;
    this.memory = memory;
    this.logger = logger || new Logger({ level: 'warn' });
    this.now = now;
    this.containers = new Map();
    this.locks = new Map();
    this.stats = { scans: 0, deposits: 0, withdrawals: 0, failed: 0, chestsPlaced: 0, signLabels: 0 };
  }

  botByName(name) { return this.bots.find((bot) => bot.name === name) || null; }

  _categoryLabel(container) {
    return container.category || categoryChestGroup('surplus');
  }

  /** Discover every container around a bot and read its actual contents. */
  async scan({ bot = null, radius = 48, near = null, limit = 24 } = {}) {
    const actor = bot || this.bots[0];
    if (!actor) return { ok: false, error: 'no bot available to scan storage' };
    const found = findBlocks(actor, CONTAINER_NAMES, { radius, near: near || actor.position, limit });
    const containers = [];
    const errors = [];
    for (const block of found) {
      const pos = { x: block.x, y: block.y, z: block.z };
      const window = await actor.openContainer(pos);
      if (!window.ok) { errors.push({ position: pos, error: window.error }); continue; }
      const items = window.items();
      await window.close();
      const id = storageId(block.name, pos);
      const existing = this.containers.get(id);
      const category = existing?.category || this._inferCategory(items);
      const entry = {
        id,
        name: block.name,
        position: pos,
        category,
        label: existing?.label || categoryChestGroup(category),
        items: { ...items },
        slotsUsed: Object.keys(items).length,
        capacity: 27,
        verifiedAt: this.now(),
        locked: this.locks.has(id)
      };
      containers.push(entry);
      this.containers.set(id, entry);
      if (this.ledger) this.ledger.updateStorage(id, { position: pos, counts: items, label: entry.label });
    }
    this.stats.scans++;
    if (this.memory) {
      this.memory.setFact('warehouse', {
        containers: containers.map((entry) => ({ id: entry.id, position: entry.position, category: entry.category, label: entry.label })),
        scannedAt: this.now()
      });
    }
    return {
      ok: containers.length > 0,
      containers,
      found: found.length,
      errors,
      totalItems: containers.reduce((sum, entry) => sum + Object.values(entry.items).reduce((a, b) => a + b, 0), 0),
      error: containers.length ? undefined : 'no accessible containers observed'
    };
  }

  _inferCategory(items) {
    const total = {};
    for (const [item, count] of Object.entries(items)) {
      const category = categoryForItem(item);
      total[category] = (total[category] || 0) + count;
    }
    const ranked = Object.entries(total).sort((a, b) => b[1] - a[1]);
    return ranked.length ? ranked[0][0] : 'surplus';
  }

  chooseContainer({ category = 'surplus', near = null } = {}) {
    const list = [...this.containers.values()].filter((entry) => !this.locks.has(entry.id));
    if (!list.length) return null;
    const exact = list.filter((entry) => entry.category === category);
    const pool = exact.length ? exact : list;
    if (!near) return pool[0];
    return pool.sort((a, b) => distance(near, a.position) - distance(near, b.position))[0];
  }

  async ensureContainer({ bot = null, anchor, category = 'surplus', label = null, reserved = {} } = {}) {
    const actor = bot || this.bots[0];
    if (!actor || !anchor) return { ok: false, error: 'ensureContainer requires a bot and anchor' };
    const scan = await this.scan({ bot: actor, near: anchor, radius: 8, limit: 8 });
    if (scan.ok) {
      const match = scan.containers.find((entry) => entry.category === category) || scan.containers[0];
      if (match) return { ok: true, container: match, existing: true };
    }
    const surface = typeof actor.surfaceAt === 'function' ? Math.floor(actor.surfaceAt(anchor.x, anchor.z)) : Math.floor(anchor.y) - 1;
    const stand = { x: Math.floor(anchor.x), y: surface + 1, z: Math.floor(anchor.z) };
    const existingBlock = actor.getBlock(stand);
    if (existingBlock && !['air', 'cave_air'].includes(existingBlock.name)) return { ok: false, error: `container site occupied by ${existingBlock.name}`, position: stand };
    const spareChests = actor.countItem('chest') - Number(reserved.chest || 0);
    if (spareChests <= 0) {
      const sparePlanks = actor.countItem('oak_planks') - Number(reserved.oak_planks || 0);
      if (sparePlanks < 8) return { ok: false, error: 'no surplus chest and fewer than 8 spare planks; refuse to consume the reserved BOM' };
      const crafted = await actor.craft('chest', 1).catch((err) => ({ ok: false, error: err.message }));
      if (!crafted.ok) return { ok: false, error: `no spare chest and cannot craft one: ${crafted.error}` };
    }
    const move = await actor.goTo(stand, { range: 4, timeoutMs: 12000 });
    if (move && move.ok === false) return { ok: false, error: move.error };
    const placed = await actor.placeBlock(stand, 'chest');
    if (!placed.ok) return placed;
    const block = actor.getBlock(stand);
    if (!block || block.name !== 'chest') return { ok: false, error: 'chest placement was not visible in the world' };
    this.stats.chestsPlaced++;
    const id = storageId('chest', stand);
    const entry = {
      id, name: 'chest', position: stand, category, label: label || categoryChestGroup(category), items: {},
      slotsUsed: 0, capacity: 27, verifiedAt: this.now(), locked: false
    };
    this.containers.set(id, entry);
    if (this.ledger) this.ledger.updateStorage(id, { position: stand, counts: {}, label: entry.label });
    if (this.memory) this.memory.setFact(`warehouse:${category}`, { id, position: stand, label: entry.label });
    return { ok: true, container: entry, existing: false };
  }

  lock(id, owner = 'team') {
    if (!this.containers.has(id)) return { ok: false, error: 'unknown container' };
    if (this.locks.has(id)) return { ok: false, error: `container locked by ${this.locks.get(id).owner}` };
    const lock = { id, owner, token: `${owner}:${this.now()}`, at: this.now() };
    this.locks.set(id, lock);
    return { ok: true, lock };
  }

  unlock(id, owner = null) {
    const lock = this.locks.get(id);
    if (!lock) return { ok: true, already: true };
    if (owner && lock.owner !== owner) return { ok: false, error: `container locked by ${lock.owner}` };
    this.locks.delete(id);
    return { ok: true };
  }

  async _withContainer({ bot, container, owner = 'team', action }) {
    const lock = this.lock(container.id, owner);
    if (!lock.ok) return lock;
    try {
      const move = await bot.goTo(container.position, { range: 4, timeoutMs: 15000 });
      if (move && move.ok === false) return { ok: false, error: move.error };
      const window = await bot.openContainer(container.position);
      if (!window.ok) return window;
      try { return await action(window); }
      finally { await window.close(); }
    } finally {
      this.unlock(container.id, owner);
    }
  }

  /** Deposit a verified number of items into a real container. */
  async deposit({ item, count = 1, bot = null, container = null, category = null } = {}) {
    const actor = bot || this.bots[0];
    if (!actor || !item || count <= 0) return { ok: false, error: 'deposit requires bot, item and positive count' };
    const target = container || this.chooseContainer({ category: category || categoryForItem(item), near: actor.position });
    if (!target) return { ok: false, error: 'no warehouse container available' };
    const beforeBot = actor.countItem(item);
    const beforeContainer = Number((await this.peek(target, actor)).items[item] || 0);
    if (beforeBot < count) return { ok: false, error: `bot holds ${beforeBot}/${count} ${item}` };
    const result = await this._withContainer({
      bot: actor, container: target, owner: 'warehouse',
      action: (window) => window.deposit(item, count)
    });
    const afterBot = actor.countItem(item);
    const after = await this.peek(target, actor);
    const verified = Boolean(result.ok) && afterBot <= beforeBot - count && Number(after.items[item] || 0) >= beforeContainer + count - 0;
    if (!verified) this.stats.failed++;
    else this.stats.deposits += count;
    if (this.ledger) this.ledger.updateStorage(target.id, { position: target.position, counts: after.items, label: target.label });
    return { ok: verified, item, count: result.count || count, container: target.id, beforeBot, afterBot, beforeContainer, afterContainer: Number(after.items[item] || 0), verified, error: verified ? undefined : (result.error || 'deposit did not match inventory change') };
  }

  /** Read a container without mutating it. */
  async peek(container, bot = null) {
    const actor = bot || this.bots[0];
    const move = await actor.goTo(container.position, { range: 4, timeoutMs: 10000 });
    if (move && move.ok === false) return { items: { ...container.items }, error: move.error };
    const window = await actor.openContainer(container.position);
    if (!window.ok) return { items: { ...container.items }, error: window.error };
    const items = window.items();
    await window.close();
    container.items = { ...items };
    container.verifiedAt = this.now();
    return { items };
  }

  /** Withdraw a verified number of items from a real container. */
  async retrieve({ item, count = 1, bot = null, container = null, category = null } = {}) {
    const actor = bot || this.bots[0];
    if (!actor || !item || count <= 0) return { ok: false, error: 'retrieve requires bot, item and positive count' };
    const target = container || this.chooseContainer({ category: category || categoryForItem(item), near: actor.position });
    if (!target) return { ok: false, error: 'no warehouse container available' };
    const beforeBot = actor.countItem(item);
    const before = await this.peek(target, actor);
    const have = Number(before.items[item] || 0);
    if (have < count) return { ok: false, error: `warehouse holds ${have}/${count} ${item}` };
    const result = await this._withContainer({
      bot: actor, container: target, owner: 'warehouse',
      action: (window) => window.withdraw(item, count)
    });
    const afterBot = actor.countItem(item);
    const after = await this.peek(target, actor);
    const verified = Boolean(result.ok) && afterBot >= beforeBot + count && Number(after.items[item] || 0) <= have - count;
    if (!verified) this.stats.failed++;
    else this.stats.withdrawals += count;
    if (this.ledger) this.ledger.updateStorage(target.id, { position: target.position, counts: after.items, label: target.label });
    return { ok: verified, item, count: result.count || count, container: target.id, beforeBot, afterBot, beforeContainer: have, afterContainer: Number(after.items[item] || 0), verified, error: verified ? undefined : (result.error || 'withdrawal did not match inventory change') };
  }

  locate(item) {
    const hits = [];
    for (const entry of this.containers.values()) {
      const count = Number(entry.items[item] || 0);
      if (count > 0) hits.push({ id: entry.id, position: entry.position, category: entry.category, count });
    }
    return hits.sort((a, b) => b.count - a.count);
  }

  capacity() {
    const containers = [...this.containers.values()];
    const usedSlots = containers.reduce((sum, entry) => sum + Object.keys(entry.items).length, 0);
    return {
      containers: containers.length,
      capacitySlots: containers.length * 27,
      usedSlots,
      freeSlots: containers.length * 27 - usedSlots,
      items: containers.reduce((sum, entry) => sum + Object.values(entry.items).reduce((a, b) => a + b, 0), 0),
      categories: this.categories()
    };
  }

  categories() {
    const out = {};
    for (const category of CATEGORY_ORDER) out[category] = { containers: 0, items: 0 };
    for (const entry of this.containers.values()) {
      out[entry.category] = out[entry.category] || { containers: 0, items: 0 };
      out[entry.category].containers++;
      out[entry.category].items += Object.values(entry.items).reduce((a, b) => a + b, 0);
    }
    return out;
  }

  /** Deposit every bot inventory item into its category group. */
  async organise({ bots = this.bots, maxContainers = 6 } = {}) {
    const actions = [];
    for (const bot of bots) {
      for (const [item, count] of Object.entries({ ...bot.inventory })) {
        if (count <= 0) continue;
        if (/_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|^food$/.test(item)) continue;
        if (!this.chooseContainer({ category: categoryForItem(item), near: bot.position })) {
          if (this.containers.size >= maxContainers) continue;
          const anchor = this.containers.size ? [...this.containers.values()][0].position : bot.position;
          const ensured = await this.ensureContainer({ bot, anchor, category: categoryForItem(item) });
          if (!ensured.ok) { actions.push({ ok: false, item, error: ensured.error }); continue; }
        }
        const result = await this.deposit({ item, count, bot, category: categoryForItem(item) });
        actions.push({ ...result, bot: bot.name });
      }
    }
    return { ok: actions.every((entry) => entry.ok), actions, capacity: this.capacity() };
  }

  /** Attempt physical category signs where the adapter supports them. */
  async labelContainer({ container, bot = null, text = null } = {}) {
    const actor = bot || this.bots[0];
    if (!container || !actor) return { ok: false, error: 'label requires container and bot' };
    container.label = text || container.label || categoryChestGroup(container.category);
    if (this.memory) this.memory.setFact(`warehouse:${container.category}`, { id: container.id, position: container.position, label: container.label });
    if (typeof actor.placeSign === 'function') {
      const result = await actor.placeSign({ ...container.position, y: container.position.y + 1 }, [container.label]).catch((err) => ({ ok: false, error: err.message }));
      if (result.ok) this.stats.signLabels++;
      return { ...result, label: container.label, physical: result.ok };
    }
    return { ok: false, label: container.label, physical: false, error: 'adapter has no sign-writing primitive; label is recorded in shared memory only' };
  }

  state() {
    return {
      containers: [...this.containers.values()].map((entry) => ({ ...entry, locked: this.locks.has(entry.id) })),
      locks: [...this.locks.values()],
      capacity: this.capacity(),
      stats: { ...this.stats }
    };
  }
}

module.exports = { Warehouse, CONTAINER_NAMES, storageId, containerKey };
