'use strict';

const { config } = require('../config');
const { Logger } = require('../logger');
const { distance, key } = require('../util/vec');
const { BED_NAMES } = require('../world/items');
const { isNight, timeOfDay, findBlocks, statusTtl, STATUS_SCAN_BUDGET_MS } = require('./common');

/**
 * Night sleeping with real bed reservations. A bed is claimed through the
 * shared task board (TTL lock) and recorded in team memory, so two bots can
 * never reserve the same bed. Reservations are released after waking.
 */
class SleepController {
  constructor({ bot, memory = null, taskBoard = null, home = null, logger = null } = {}) {
    if (!bot) throw new Error('SleepController requires a bot');
    this.bot = bot;
    this.memory = memory;
    this.taskBoard = taskBoard;
    this.home = home ? { ...home } : null;
    this.logger = logger || new Logger({ level: 'warn' });
    this.reservation = null;
    this.auto = true;
    this.stats = { sleeps: 0, reservations: 0, denied: 0, bedsPlaced: 0 };
  }

  status() {
    const position = this.bot.position || { x: 0, y: 0, z: 0 };
    const now = Date.now();
    const moved = this._statusCache ? Math.hypot(position.x - this._statusCache.center.x, position.z - this._statusCache.center.z) : Infinity;
    // The bed scan was the largest status scan in the fleet (25x25x25 block
    // reads per bot). Cache it with a staggered TTL and a hard time budget.
    const ttl = statusTtl(this.bot.name, 6);
    if (!this._statusCache || moved > 24 || now - this._statusCache.at > ttl) {
      this._statusCache = {
        center: { x: position.x, z: position.z },
        at: now,
        beds: this.findBeds({ radius: 8, limit: 5, budgetMs: STATUS_SCAN_BUDGET_MS })
      };
    }
    return {
      bot: this.bot.name,
      time: timeOfDay(this.bot),
      night: isNight(timeOfDay(this.bot)),
      sleeping: Boolean(this.bot.isSleeping),
      auto: this.auto,
      reservation: this.reservation ? { bed: this.reservation.bed, key: this.reservation.key } : null,
      nearbyBeds: this._statusCache.beds,
      hasBedItem: Boolean(this.bot.hasBed && this.bot.hasBed()),
      stats: { ...this.stats }
    };
  }

  setAuto(enabled) {
    this.auto = Boolean(enabled);
    return { ok: true, bot: this.bot.name, auto: this.auto };
  }

  findBeds({ radius = config.survival.bedSearchRadius, limit = 10, budgetMs = 0 } = {}) {
    const beds = new Map();
    if (this.memory) {
      for (const obs of this.memory.beds()) {
        if (distance(obs.position, this.bot.position) <= radius) beds.set(key(obs.position), { ...obs.position, reportedBy: obs.reportedBy, reserved: Boolean(obs.data && obs.data.reservedBy) });
      }
    }
    for (const bed of findBlocks(this.bot, [...BED_NAMES], { radius, limit: 50, budgetMs })) {
      if (!beds.has(key(bed))) beds.set(key(bed), { x: bed.x, y: bed.y, z: bed.z, name: bed.name });
    }
    return [...beds.values()].slice(0, limit);
  }

  reserve(bed) {
    const k = key(bed);
    if (this.taskBoard) {
      const lock = this.taskBoard.acquireLock(`sleep:bed:${k}`, this.bot.name, { label: `sleep ${this.bot.name}`, ttlMs: 10 * 60 * 1000 });
      if (!lock.ok) return { ok: false, error: `bed reserved by ${lock.heldBy}` };
    }
    this.reservation = { bed: { x: bed.x, y: bed.y, z: bed.z }, key: `sleep:bed:${k}`, at: Date.now() };
    this.stats.reservations++;
    if (this.memory) {
      this.memory.observe({
        type: 'BED', position: { x: bed.x, y: bed.y, z: bed.z }, reportedBy: this.bot.name, confidence: 0.9,
        status: 'RESERVED', data: { reservedBy: this.bot.name, reservedAt: Date.now() }
      });
    }
    return { ok: true, reservation: this.reservation };
  }

  release() {
    if (!this.reservation) return false;
    if (this.taskBoard) this.taskBoard.releaseLock(this.reservation.key, this.bot.name);
    if (this.memory) {
      this.memory.observe({
        type: 'BED', position: this.reservation.bed, reportedBy: this.bot.name, confidence: 0.9,
        status: 'AVAILABLE', data: { releasedAt: Date.now() }
      });
    }
    this.reservation = null;
    return true;
  }

  async ensureBed({ placeNew = false, budgetMs = 8000 } = {}) {
    const beds = this.findBeds({ radius: 12, limit: 1 });
    if (!placeNew && beds.length) return { ok: true, bed: beds[0] };
    const item = this.bot.hasBed ? this.bot.hasBed() : null;
    if (!item) return { ok: false, error: 'no bed available' };
    // A bed search used to try every ring cell (120 positions), each with its
    // own path request. When pathfinding stalled that turned one PLACE_BED
    // step into a 30-minute concurrency-slot owner. Collect candidates first,
    // then attempt only the nearest few inside a hard wall-clock budget.
    const deadline = Date.now() + Math.max(2000, Number(budgetMs) || 8000);
    // Place a bed on a clear, solid surface near the bot. Search outward in
    // rings: a single fixed six-cell list misses beds when teammates stand in
    // the way or the surface is uneven.
    const offsets = [];
    for (let radius = 1; radius <= 5; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) === radius) offsets.push([dx, dz]);
        }
      }
    }
    // A miner can be hundreds of blocks underground in a one-block shaft.
    // Try the local area first, then fall back to the team's home surface,
    // which is where a shared bed belongs anyway.
    const anchors = [this.bot.position];
    if (this.home && distance(this.home, this.bot.position) > 4) anchors.push(this.home);
    const homeAnchor = anchors.length > 1 ? anchors[1] : null;
    const candidates = [];
    for (const anchor of anchors) {
      for (const [dx, dz] of offsets) {
        const pos = { x: Math.floor(anchor.x) + dx, y: Math.floor(anchor.y), z: Math.floor(anchor.z) + dz };
        const below = this.bot.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
        const at = this.bot.getBlock(pos);
        const above = this.bot.getBlock({ x: pos.x, y: pos.y + 1, z: pos.z });
        if (!below || below.name === 'air' || below.name === 'water' || below.name === 'lava') continue;
        if (!at || at.name !== 'air' || !above || above.name !== 'air') continue;
        candidates.push({ pos, anchor, fromHome: anchor === homeAnchor, distance: distance(pos, this.bot.position) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const shortlist = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const k = `${candidate.pos.x},${candidate.pos.y},${candidate.pos.z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      shortlist.push(candidate);
      if (shortlist.length >= 6) break;
    }
    let lastError = 'no safe place for a bed';
    for (const candidate of shortlist) {
      if (Date.now() >= deadline) return { ok: false, error: 'bed placement budget exhausted', attempted: shortlist.length };
      if (candidate.fromHome && distance(candidate.anchor, this.bot.position) > 3) {
        const travel = await this.bot.goTo(candidate.anchor, { range: 3, timeoutMs: 4000 });
        if (travel && travel.ok === false) { lastError = travel.error || 'cannot reach bed area'; continue; }
      }
      const move = await this.bot.goTo(candidate.pos, { range: 3, timeoutMs: 2500 });
      if (move && move.ok === false) { lastError = move.error || 'cannot reach bed position'; continue; }
      const placed = await this.bot.placeBlock(candidate.pos, item);
      if (!placed.ok) { lastError = placed.error || 'placement failed'; continue; }
      this.stats.bedsPlaced++;
      if (this.memory) {
        this.memory.observe({ type: 'BED', position: { ...candidate.pos }, reportedBy: this.bot.name, confidence: 0.95, status: 'AVAILABLE', data: { placedBy: this.bot.name } });
      }
      return { ok: true, bed: candidate.pos, placed: true, item };
    }
    return { ok: false, error: lastError, attempted: shortlist.length };
  }

  async sleep() {
    const tod = timeOfDay(this.bot);
    if (!isNight(tod)) return { ok: false, error: 'not night', time: tod };
    let bed = this.reservation ? this.reservation.bed : null;
    if (!bed) {
      const beds = this.findBeds({ radius: config.survival.bedSearchRadius, limit: 1 });
      bed = beds[0] || (await this.ensureBed()).bed || null;
    }
    if (!bed) return { ok: false, error: 'no bed found' };
    if (!this.reservation) {
      const reserved = this.reserve(bed);
      if (!reserved.ok) { this.stats.denied++; return reserved; }
    }
    const move = await this.bot.goTo(bed, { range: 2 });
    if (move && move.ok === false) {
      this.release();
      return { ok: false, error: move.error };
    }
    const result = await this.bot.sleep(bed);
    if (!result.ok) {
      this.release();
      return result;
    }
    this.stats.sleeps++;
    this.release();
    return { ok: true, bed, slept: true, time: timeOfDay(this.bot), day: this.bot.time ? this.bot.time.day : null };
  }

  async tick() {
    if (!this.auto) return { ok: true, skipped: true, reason: 'automatic sleep disabled', time: timeOfDay(this.bot) };
    const tod = timeOfDay(this.bot);
    if (!isNight(tod)) {
      if (this.reservation) this.release();
      return { ok: true, idle: true, reason: 'daytime', time: tod };
    }
    const result = await this.sleep();
    return { ...result, night: true };
  }
}

module.exports = { SleepController };
