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
    this.spawnPoint = null;
    this.spawnBed = null;
    this.stats = { sleeps: 0, reservations: 0, denied: 0, bedsPlaced: 0, spawnPoints: 0, spawnFailed: 0 };
  }

  status() {
    const position = this.bot.position || { x: 0, y: 0, z: 0 };
    const now = Date.now();
    const moved = this._statusCache ? Math.hypot(position.x - this._statusCache.center.x, position.z - this._statusCache.center.z) : Infinity;
    // The bed scan was the largest status scan in the fleet (25x25x25 block
    // reads per bot). Cache it with a staggered TTL and a hard time budget.
    const ttl = statusTtl(this.bot.name, 6);
    if (!this._statusCache || moved > 8 || now - this._statusCache.at > ttl) {
      this._statusCache = {
        center: { x: position.x, z: position.z },
        at: now,
        // Beds are sparse. The old 8-block/5-bed scan missed every bed that a
        // teammate had built one room away, so the dashboard reported "no
        // beds" while the bot was standing in a bedroom. The world index makes
        // a 16-block scan cheap; the budget only protects the fallback.
        beds: this.findBeds({ radius: 16, limit: 10, budgetMs: STATUS_SCAN_BUDGET_MS })
      };
    }
    const spawn = this.spawnPoint || this._adapterSpawnPoint();
    const nearbyBeds = this._statusCache.beds;
    // A fresh adapter reports the world spawn (or its current position) as
    // `spawnPoint`. That is not a bed anchor. Only a spawn point within a bed
    // is reported as "set", otherwise the dashboard would claim every bot
    // already respawns at a bed it has never clicked.
    const rememberedBed = this.spawnBed
      && BED_NAMES.has(String((this._blockAt(this.spawnBed.foot || this.spawnBed) || {}).name || ''))
      ? this.spawnBed
      : null;
    const spawnBed = spawn
      ? nearbyBeds.find((bed) => distance(spawn, bed.foot || bed) <= 2.5) || rememberedBed
      : null;
    return {
      bot: this.bot.name,
      time: timeOfDay(this.bot),
      night: isNight(timeOfDay(this.bot)),
      sleeping: Boolean(this.bot.isSleeping),
      auto: this.auto,
      reservation: this.reservation ? { bed: this.reservation.bed, key: this.reservation.key } : null,
      nearbyBeds: nearbyBeds.map((bed) => ({
        ...bed,
        spawn: Boolean(spawn && distance(spawn, bed.foot || bed) <= 2.5)
      })),
      spawnPoint: spawn ? { ...spawn } : null,
      spawnBed: spawnBed ? { ...spawnBed } : null,
      spawnSet: Boolean(spawnBed),
      hasBedItem: Boolean(this.bot.hasBed && this.bot.hasBed()),
      stats: { ...this.stats }
    };
  }

  setAuto(enabled) {
    this.auto = Boolean(enabled);
    return { ok: true, bot: this.bot.name, auto: this.auto };
  }

  /** Read the current respawn anchor from the adapter, if it exposes one. */
  _adapterSpawnPoint() {
    const point = this.bot && this.bot.spawnPoint;
    if (!point || ![point.x, point.y, point.z].every((value) => Number.isFinite(Number(value)))) return null;
    return { x: Number(point.x), y: Number(point.y), z: Number(point.z) };
  }

  _blockAt(pos) {
    if (!pos || typeof this.bot.getBlock !== 'function') return null;
    try { return this.bot.getBlock(pos) } catch (_) { return null }
  }

  /**
   * Collapse a bed's two halves into one entry. Bed blocks expose `part` on a
   * real server; when the adapter omits properties, pair two adjacent blocks
   * of the same colour deterministically so a double bed is not counted twice.
   */
  _bedEntry(pos, name, reportedBy = null) {
    const block = this._blockAt(pos);
    const props = (block && block.properties) || {};
    const part = String(props.part || '').toLowerCase();
    const sameBed = (candidate) => {
      if (!candidate || candidate.name !== name) return false;
      const candidatePart = String((candidate.properties && candidate.properties.part) || '').toLowerCase();
      return !part || !candidatePart || candidatePart !== part;
    };
    let foot = { x: pos.x, y: pos.y, z: pos.z };
    let head = null;
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const neighbourPos = { x: pos.x + dx, y: pos.y, z: pos.z + dz };
      const neighbour = this._blockAt(neighbourPos);
      if (!sameBed(neighbour)) continue;
      const neighbourPart = String((neighbour.properties && neighbour.properties.part) || '').toLowerCase();
      if (part === 'foot' || neighbourPart === 'head') {
        head = neighbourPos;
      } else if (part === 'head' || neighbourPart === 'foot') {
        foot = neighbourPos;
        head = { x: pos.x, y: pos.y, z: pos.z };
      } else {
        // No block-state metadata: use a stable ordering rather than whichever
        // half the scan happened to visit first.
        const before = (pos.x < neighbourPos.x) || (pos.x === neighbourPos.x && pos.z <= neighbourPos.z);
        foot = before ? { x: pos.x, y: pos.y, z: pos.z } : neighbourPos;
        head = before ? neighbourPos : { x: pos.x, y: pos.y, z: pos.z };
      }
      break;
    }
    return {
      x: foot.x, y: foot.y, z: foot.z,
      foot,
      head,
      name,
      part: part || null,
      occupied: props.occupied === true || props.occupied === 'true',
      reportedBy,
      reserved: Boolean(props.reserved),
      distance: Math.round(distance(this.bot.position, foot) * 10) / 10
    };
  }

  findBeds({ radius = config.survival.bedSearchRadius, limit = 10, budgetMs = 0 } = {}) {
    const beds = new Map();
    if (this.memory) {
      for (const obs of this.memory.beds()) {
        if (distance(obs.position, this.bot.position) > radius) continue;
        // Team memory can outlive the block (a bed was broken by a player or
        // another bot). Report only beds that still exist in the loaded world.
        const block = this._blockAt(obs.position);
        const name = block && BED_NAMES.has(block.name) ? block.name : null;
        if (!name) continue;
        const entry = this._bedEntry(obs.position, name, obs.reportedBy || null);
        entry.reserved = Boolean(obs.data && obs.data.reservedBy);
        entry.reservedBy = (obs.data && obs.data.reservedBy) || null;
        beds.set(key(entry.foot), entry);
      }
    }
    for (const bed of findBlocks(this.bot, [...BED_NAMES], { radius, limit: 50, budgetMs })) {
      const entry = this._bedEntry(bed, bed.name);
      const existing = beds.get(key(entry.foot));
      if (existing) {
        // A live block is stronger evidence than team memory; keep the memory
        // claim but take the observed name/occupancy.
        beds.set(key(entry.foot), {
          ...entry,
          reserved: existing.reserved, reservedBy: existing.reservedBy,
          reportedBy: existing.reportedBy || entry.reportedBy
        });
      } else {
        beds.set(key(entry.foot), entry);
      }
    }
    return [...beds.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  /** True when the adapter already respawns the bot at this bed. */
  _spawnMatches(bed) {
    const spawn = this.spawnPoint || this._adapterSpawnPoint();
    if (!spawn || !bed) return false;
    return distance(spawn, bed.foot || bed) <= 2.5;
  }

  /**
   * Right-click the bed and verify that the server acknowledged a new spawn
   * position. Sleeping also sets a spawn point, but requiring night and a free
   * bed made daytime detection useless; this is the explicit path.
   */
  async claimSpawn(bed) {
    if (!bed) return { ok: false, code: 'NO_BED', error: 'no bed to claim' };
    if (this._spawnMatches(bed)) {
      return { ok: true, already: true, bed: { ...bed }, spawnPoint: this.spawnPoint || this._adapterSpawnPoint() };
    }
    if (typeof this.bot.setSpawnPoint !== 'function') {
      return { ok: false, code: 'UNSUPPORTED', error: 'adapter cannot set a spawn point', bed: { ...bed } };
    }
    if (distance(this.bot.position, bed.foot || bed) > 4) {
      const move = await this.bot.goTo(bed.foot || bed, { range: 2, timeoutMs: 4000, priority: 'task', owner: 'sleep-spawn' });
      if (move && move.ok === false) return { ok: false, code: 'UNREACHABLE', error: move.error || 'cannot reach the bed', bed: { ...bed } };
    }
    const result = await this.bot.setSpawnPoint(bed.foot || bed, { bed });
    if (!result || result.ok === false) {
      this.stats.spawnFailed++;
      return { ok: false, code: 'SPAWN_REJECTED', error: (result && result.error) || 'server did not accept the spawn point', bed: { ...bed }, result };
    }
    const spawn = result.position || this._adapterSpawnPoint();
    if (spawn) this.spawnPoint = { ...spawn };
    this.spawnBed = { ...bed };
    this.stats.spawnPoints++;
    if (this.memory) {
      this.memory.observe({
        type: 'SPAWN', position: { ...(bed.foot || bed) }, reportedBy: this.bot.name, confidence: 0.95,
        status: 'SET', data: { spawnPoint: spawn || null, verified: result.verified !== false }
      });
    }
    return { ok: true, bed: { ...bed }, spawnPoint: spawn || null, verified: result.verified !== false, result };
  }

  /** Detect a nearby bed and make it the respawn point. */
  async ensureSpawnPoint({ radius = 16 } = {}) {
    const beds = this.findBeds({ radius, limit: 5 });
    if (!beds.length) return { ok: false, code: 'NO_BED', error: `no bed detected within ${radius} blocks` };
    const current = beds.find((bed) => this._spawnMatches(bed));
    if (current) return { ok: true, already: true, bed: current, spawnPoint: this.spawnPoint || this._adapterSpawnPoint() };
    let last = null;
    for (const bed of beds) {
      last = await this.claimSpawn(bed);
      if (last.ok) return last;
    }
    return last || { ok: false, code: 'NO_BED', error: 'no usable bed' };
  }

  reserve(bed) {
    const k = key(bed);
    if (this.taskBoard) {
      const lock = this.taskBoard.acquireLock(`sleep:bed:${k}`, this.bot.name, { label: `sleep ${this.bot.name}`, ttlMs: 10 * 60 * 1000 });
      if (!lock.ok) return { ok: false, error: `bed reserved by ${lock.heldBy}` };
    }
    this.reservation = { bed: { x: bed.x, y: bed.y, z: bed.z }, key: `sleep:bed:${k}`, at: Date.now(), claimedBy: this.bot.name };
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
      const entry = this._bedEntry(candidate.pos, item);
      const spawn = await this.claimSpawn(entry).catch((err) => ({ ok: false, error: err.message }));
      return { ok: true, bed: candidate.pos, placed: true, item, spawn };
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
    // Sitting in a bed sets the respawn anchor in vanilla, but only at night.
    // Explicitly claim it first so the daytime detection path and the night
    // path share one verified mechanism.
    const spawn = await this.claimSpawn(bed).catch((err) => ({ ok: false, error: err.message }));
    const result = await this.bot.sleep(bed);
    if (!result.ok) {
      this.release();
      return result;
    }
    this.stats.sleeps++;
    this.release();
    return { ok: true, bed, slept: true, spawn, spawnPoint: this.spawnPoint, time: timeOfDay(this.bot), day: this.bot.time ? this.bot.time.day : null };
  }

  async tick() {
    if (!this.auto) return { ok: true, skipped: true, reason: 'automatic sleep disabled', time: timeOfDay(this.bot) };
    const tod = timeOfDay(this.bot);
    if (!isNight(tod)) {
      if (this.reservation) this.release();
      // Daytime is exactly when a bed needs to become the respawn anchor.
      // Sleeping is impossible before nightfall, so the old code returned
      // "daytime" and never set a spawn point at all.
      const spawn = await this.ensureSpawnPoint().catch((err) => ({ ok: false, error: err.message }));
      return { ok: true, idle: !spawn.ok, reason: spawn.ok ? 'spawn point set' : (spawn.error || 'daytime'), time: tod, spawn };
    }
    const result = await this.sleep();
    return { ...result, night: true };
  }
}

module.exports = { SleepController };
