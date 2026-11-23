'use strict';

const { matchesCategory, sumCategory, keepPriority } = require('../world/items');

let reservationSeq = 0;
let requestSeq = 0;

/**
 * Team resource ledger, backed only by real inventories and verified storage.
 *
 * Total = sum of bot inventories + verified storage contents. Bots never share
 * a physical inventory; a "team total" is an accounting view, and moving items
 * between bots requires an actual in-game container/throw interaction.
 */
class ResourceLedger {
  constructor({ reserves = {}, now = () => Date.now(), maxHistory = 2000, maxInactiveReservations = 5000 } = {}) {
    this.reserves = { ...reserves };
    this.inventories = new Map(); // name -> { counts, updatedAt }
    this.storages = new Map(); // id -> { position, counts, verifiedAt, dimension, label }
    this.reservations = [];
    this.targets = new Map(); // item/category -> count
    this.transferRequests = [];
    this.history = [];
    this.maxHistory = Math.max(100, Number(maxHistory) || 2000);
    this.maxInactiveReservations = Math.max(100, Number(maxInactiveReservations) || 5000);
    this.now = now;
    for (const [item, count] of Object.entries(this.reserves)) this.targets.set(item, count);
  }

  _trimHistory() {
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
  }

  _trimReservations() {
    if (this.reservations.length <= this.maxInactiveReservations) return;
    const inactive = this.reservations.filter((r) => !r.active);
    const excess = this.reservations.length - this.maxInactiveReservations;
    if (inactive.length <= excess) return;
    const drop = new Set(inactive.slice(0, excess));
    this.reservations = this.reservations.filter((r) => !drop.has(r));
  }

  setReserveTarget(item, count, source = 'config') {
    this.targets.set(item, count);
    this.history.push({ at: this.now(), type: 'target', item, count, source });
    this._trimHistory();
    return this.getTarget(item);
  }

  getTarget(item) {
    return this.targets.has(item) ? this.targets.get(item) : 0;
  }

  updateBotInventory(name, counts, { updatedAt = this.now() } = {}) {
    this.inventories.set(name, { counts: { ...counts }, updatedAt });
    return this.inventories.get(name);
  }

  removeBot(name) { this.inventories.delete(name); }

  updateStorage(id, { position, counts, verifiedAt = this.now(), dimension = 'overworld', label = '' }) {
    this.storages.set(id, { position, counts: { ...counts }, verifiedAt, dimension, label });
    return this.storages.get(id);
  }

  removeStorage(id) { this.storages.delete(id); }

  storageStale(id, maxAgeMs = 10 * 60 * 1000) {
    const store = this.storages.get(id);
    if (!store) return true;
    return this.now() - store.verifiedAt > maxAgeMs;
  }

  botTotal(item) {
    let total = 0;
    for (const { counts } of this.inventories.values()) total += sumCategory(counts, item);
    return total;
  }

  storageTotal(item) {
    let total = 0;
    for (const store of this.storages.values()) total += sumCategory(store.counts, item);
    return total;
  }

  total(item) { return this.botTotal(item) + this.storageTotal(item); }

  reserved(item, { excludePurpose = null } = {}) {
    return this.reservations
      .filter((r) => r.active && matchesCategory(r.item, item) && (!excludePurpose || r.purpose !== excludePurpose))
      .reduce((sum, r) => sum + r.remaining, 0);
  }

  available(item) {
    return Math.max(0, this.total(item) - this.reserved(item));
  }

  /** Reserve resources for a purpose. Reservations never exceed real stock. */
  reserve(item, count, { purpose = 'general', owner = 'team', id = null } = {}) {
    const amount = Number(count);
    if (!item || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'invalid reservation' };
    const free = this.available(item);
    if (free < amount) {
      const shortage = { item, requested: amount, free, purpose };
      this.history.push({ at: this.now(), type: 'reserve-failed', ...shortage });
      this._trimHistory();
      return { ok: false, error: 'insufficient resources', shortage };
    }
    const reservation = { id: id || `res-${++reservationSeq}`, item, count: amount, remaining: amount, purpose, owner, createdAt: this.now(), active: true };
    this.reservations.push(reservation);
    this.history.push({ at: this.now(), type: 'reserve', ...reservation });
    this._trimHistory();
    this._trimReservations();
    return { ok: true, reservation };
  }

  /** Consume part of a reservation as real items are used. */
  commit(reservationId, count) {
    const res = this.reservations.find((r) => r.id === reservationId);
    if (!res) return { ok: false, error: 'unknown reservation' };
    const amount = Number(count);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'commit count must be positive' };
    res.remaining = Math.max(0, res.remaining - amount);
    if (res.remaining === 0) res.active = false;
    this.history.push({ at: this.now(), type: 'commit', id: reservationId, count: amount, remaining: res.remaining });
    this._trimHistory();
    this._trimReservations();
    return { ok: true, reservation: res };
  }

  release(reservationId) {
    const res = this.reservations.find((r) => r.id === reservationId);
    if (!res) return false;
    res.active = false;
    res.remaining = 0;
    this.history.push({ at: this.now(), type: 'release', id: reservationId });
    this._trimHistory();
    this._trimReservations();
    return true;
  }

  releaseOwner(owner) {
    let n = 0;
    for (const res of this.reservations) {
      if (res.active && res.owner === owner) { res.active = false; res.remaining = 0; n++; }
    }
    return n;
  }

  requestTransfer({ from = null, to, item, count, reason = '' }) {
    if (!to || !item || !(count > 0)) return { ok: false, error: 'invalid transfer request' };
    const req = { id: `xfer-${++requestSeq}`, from, to, item, count, reason, status: 'PENDING', createdAt: this.now() };
    this.transferRequests.push(req);
    if (this.transferRequests.length > 200) this.transferRequests.shift();
    return { ok: true, request: req };
  }

  pendingTransfers(to = null) {
    return this.transferRequests.filter((r) => r.status === 'PENDING' && (!to || r.to === to));
  }

  claimTransfer(id, botName) {
    const req = this.transferRequests.find((r) => r.id === id);
    if (!req || req.status !== 'PENDING') return { ok: false, error: 'transfer not pending' };
    req.status = 'ASSIGNED';
    req.assignedTo = botName;
    req.assignedAt = this.now();
    return { ok: true, request: req };
  }

  completeTransfer(id, success = true) {
    const req = this.transferRequests.find((r) => r.id === id);
    if (!req) return false;
    req.status = success ? 'COMPLETED' : 'FAILED';
    req.completedAt = this.now();
    this.history.push({ at: this.now(), type: 'transfer', id, success });
    this._trimHistory();
    return true;
  }

  shortages() {
    const out = [];
    for (const item of this.targets.keys()) {
      const target = this.getTarget(item);
      const total = this.total(item);
      const avail = this.available(item);
      if (avail < target) {
        out.push({
          item,
          target,
          total,
          available: avail,
          reserved: this.reserved(item),
          deficit: target - avail,
          severity: avail === 0 ? 'critical' : avail < target * 0.5 ? 'high' : 'medium'
        });
      }
    }
    return out.sort((a, b) => b.deficit - a.deficit);
  }

  summary() {
    const items = new Set([...this.targets.keys()]);
    for (const { counts } of this.inventories.values()) for (const k of Object.keys(counts)) items.add(k);
    for (const store of this.storages.values()) for (const k of Object.keys(store.counts)) items.add(k);
    const rows = [];
    for (const item of items) {
      const target = this.getTarget(item);
      if (!target && this.total(item) === 0) continue;
      const total = this.total(item);
      const reserved = this.reserved(item);
      const available = Math.max(0, total - reserved);
      rows.push({
        item,
        total,
        available,
        reserved,
        target,
        status: target === 0 ? 'TRACKED' : available >= target ? 'OK' : available === 0 ? 'CRITICAL' : 'DEFICIT'
      });
    }
    return rows.sort((a, b) => (b.target ? b.target - b.available : 0) - (a.target ? a.target - a.available : 0));
  }

  /** Items a bot must never drop, with per-bot minimums. */
  protectedItems(counts) {
    const keep = new Set();
    for (const [name, count] of Object.entries(counts || {})) {
      if (count <= 0) continue;
      if (keepPriority(name) >= 0.75) keep.add(name);
    }
    return keep;
  }

  /** Pick junk to drop when the inventory is full; never rare or essential. */
  junkCandidates(counts, count = 8) {
    return Object.entries(counts || {})
      .filter(([, n]) => n > 0)
      .map(([name, n]) => ({ name, count: n, priority: keepPriority(name) }))
      .filter((e) => e.priority <= 0.5)
      .sort((a, b) => a.priority - b.priority || b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, count);
  }

  transferPlan(item, count, donors, recipient, { perBotMax = 64 } = {}) {
    const sources = donors
      .map((d) => ({ name: d.name, have: sumCategory(d.counts || {}, item), distance: d.distance || 0 }))
      .filter((s) => s.have > 0)
      .sort((a, b) => b.have - a.have || a.distance - b.distance);
    const plan = [];
    let remaining = count;
    for (const source of sources) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, source.have, perBotMax);
      if (take <= 0) continue;
      plan.push({ from: source.name, to: recipient, item, count: take });
      remaining -= take;
    }
    return { plan, fulfilled: count - remaining, remaining };
  }

  snapshot() {
    return {
      rows: this.summary(),
      shortages: this.shortages(),
      storages: [...this.storages.entries()].map(([id, s]) => ({ id, ...s, stale: this.storageStale(id) })),
      reservations: this.reservations.filter((r) => r.active),
      transfers: this.transferRequests.slice(-20).map((r) => ({ ...r })),
      inventories: [...this.inventories.entries()].map(([name, inv]) => ({ name, updatedAt: inv.updatedAt, items: Object.keys(inv.counts).length }))
    };
  }
}

module.exports = { ResourceLedger };
