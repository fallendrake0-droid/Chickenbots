'use strict';

const { BOT_NAMES } = require('../config');

const TEAM = new Set(BOT_NAMES.map((name) => String(name).toLowerCase()));
const ONLINE_WINDOW_MS = 15000;
const POSITION_FRESH_MS = 5000;
const MAX_PLAYERS = 200;
const MAX_NAME_LENGTH = 32;
const MAX_HISTORY = 80;
const MAX_EVENTS = 500;
const GAMEMODES = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' };
const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function cleanName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  // Minecraft names are ASCII; rejecting control characters keeps dashboard
  // rows and command output free of injected newlines.
  if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) return null;
  if (TEAM.has(name.toLowerCase())) return null;
  return name;
}

function nameKey(value) {
  const cleaned = cleanName(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function finitePosition(position) {
  return Boolean(position)
    && [position.x, position.y, position.z].every((value) => Number.isFinite(Number(value)));
}

function roundPosition(position) {
  return { x: Math.round(Number(position.x)), y: Math.round(Number(position.y)), z: Math.round(Number(position.z)) };
}

function distance(a, b) {
  if (!finitePosition(a) || !finitePosition(b)) return null;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

function cleanDimension(value) {
  if (!value) return null;
  const text = String(value).trim().toLowerCase().replace(/^minecraft:/, '');
  if (!text || text.length > 64 || !/^[a-z0-9_.:/-]+$/.test(text)) return null;
  return text;
}

function validUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase().replace(/-/g, '') : null;
}

/**
 * Seen-player directory shared by every controller. Bots only observe; the
 * registry never attacks, follows or authorises anyone. PvP remains gated by
 * PvpPolicy, but the registry is the single source of truth for presence,
 * identity, position freshness and the relationship category shown to humans.
 */
class PlayerRegistry {
  constructor({ now = () => Date.now(), ttlMs = 30 * 60 * 1000, maxPlayers = MAX_PLAYERS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxPlayers = maxPlayers;
    this.players = new Map(); // lower-case name key -> entry
    this.byUuid = new Map();
    this.bindings = new Map(); // observed name -> UUID
    this.policy = null;
    this.activity = new Map(); // bot name -> { mode, target, at }
    this.events = [];
    this.stats = { observed: 0, updated: 0, rejected: 0, pruned: 0, renamed: 0, events: 0 };
  }

  attachPolicy(policy) {
    this.policy = policy || null;
    return this;
  }

  _entry(name) {
    const key = nameKey(name);
    if (!key) return null;
    let entry = this.players.get(key);
    if (!entry) {
      entry = {
        key, name, uuid: null, firstSeen: this.now(), lastSeen: 0,
        lastEntityAt: 0, lastTabSeenAt: 0, lastPositionAt: 0,
        seenBy: new Set(), position: null, dimension: null,
        health: null, gamemode: null, ping: null,
        botDistances: new Map(), source: 'unknown', confidence: 0,
        tags: new Set(), notes: [], history: [], manual: false,
        online: false
      };
      this.players.set(key, entry);
    }
    return entry;
  }

  _record(entry, type, data = {}) {
    const at = this.now();
    const event = { at, type, name: entry.name, ...data };
    entry.history.push(event);
    if (entry.history.length > MAX_HISTORY) entry.history.splice(0, entry.history.length - MAX_HISTORY);
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.stats.events++;
    return event;
  }

  _bindUuid(entry, uuid) {
    const normalized = validUuid(uuid);
    if (!normalized) return false;
    if (entry.uuid && entry.uuid !== normalized) {
      this._record(entry, 'IDENTITY_CONFLICT', { from: entry.uuid, to: normalized });
      return false;
    }
    const previous = this.byUuid.get(normalized);
    if (previous && previous !== entry.key) {
      // A name change is the normal case. Merge the old name's data rather
      // than creating a second player, but never silently discard a manual target.
      const old = this.players.get(previous);
      if (old && old !== entry) {
        for (const bot of old.seenBy) entry.seenBy.add(bot);
        for (const [bot, value] of old.botDistances) if (!entry.botDistances.has(bot)) entry.botDistances.set(bot, value);
        for (const tag of old.tags) entry.tags.add(tag);
        if (!entry.notes.length) entry.notes = old.notes.slice();
        entry.firstSeen = Math.min(entry.firstSeen || Infinity, old.firstSeen || entry.firstSeen);
        this.players.delete(previous);
        this.stats.renamed++;
        this._record(entry, 'RENAMED', { previousName: old.name });
      }
    }
    entry.uuid = normalized;
    this.byUuid.set(normalized, entry.key);
    this.bindings.set(entry.name.toLowerCase(), normalized);
    return true;
  }

  /** Merge one sighting. Untrusted names and non-finite positions are refused. */
  observe(name, {
    bot = null, position = null, health = null, gamemode = null, ping = null,
    uuid = null, dimension = null, source = 'entity', seenAt = null, manual = false
  } = {}) {
    const cleaned = cleanName(name);
    if (!cleaned) { this.stats.rejected++; return null; }
    const entry = this._entry(cleaned);
    if (!entry) { this.stats.rejected++; return null; }
    const at = Number.isFinite(Number(seenAt)) ? Number(seenAt) : this.now();
    const first = entry.lastSeen === 0;
    const previousOnline = this._isOnline(entry, at);
    entry.lastSeen = Math.max(entry.lastSeen, at);
    if (first) entry.firstSeen = at;
    if (bot && BOT_NAMES.includes(bot)) entry.seenBy.add(bot);
    if (source === 'entity' || source === 'manual') entry.source = source;
    else if (source === 'server_list' && entry.source !== 'entity' && entry.source !== 'manual') entry.source = source;
    if (manual) entry.manual = true;
    if (source === 'entity') {
      entry.lastEntityAt = Math.max(entry.lastEntityAt, at);
      entry.confidence = Math.max(entry.confidence, 0.9);
    } else if (source === 'server_list') {
      entry.lastTabSeenAt = Math.max(entry.lastTabSeenAt, at);
      entry.confidence = Math.max(entry.confidence, 0.8);
    } else if (source === 'manual') {
      entry.confidence = 1;
    }
    if (dimension) entry.dimension = cleanDimension(dimension) || entry.dimension;
    if (finitePosition(position)) {
      entry.position = roundPosition(position);
      entry.lastPositionAt = at;
    }
    if (health !== null && health !== undefined && Number.isFinite(Number(health))) entry.health = Math.max(0, Math.min(20, Number(health)));
    const mode = typeof gamemode === 'string' ? gamemode.toLowerCase() : GAMEMODES[gamemode];
    if (mode && ['survival', 'creative', 'adventure', 'spectator'].includes(mode)) entry.gamemode = mode;
    if (ping !== null && ping !== undefined && Number.isFinite(Number(ping))) entry.ping = Math.max(0, Math.round(Number(ping)));
    if (uuid) this._bindUuid(entry, uuid);
    if (first) {
      this.stats.observed++;
      this._record(entry, 'SEEN', { source, bot });
    } else {
      this.stats.updated++;
    }
    const online = this._isOnline(entry, at);
    if (!previousOnline && online) this._record(entry, 'ONLINE', { source });
    return entry;
  }

  _isOnline(entry, at = this.now()) {
    return Boolean(entry && ((entry.lastEntityAt && at - entry.lastEntityAt <= ONLINE_WINDOW_MS)
      || (entry.lastTabSeenAt && at - entry.lastTabSeenAt <= ONLINE_WINDOW_MS)));
  }

  /**
   * Read one bot's entity list and merge every visible non-team player. Tab-list
   * rows are presence-only: they never create an entity position or distance.
   */
  observeBot(bot, { radius = 64 } = {}) {
    if (!bot || !bot.name) return [];
    // Distances are per sighting, not historical. A bot that can no longer
    // see the player must not keep advertising its old 3-block distance.
    for (const entry of this.players.values()) entry.botDistances.delete(bot.name);
    if (!finitePosition(bot.position)) return [];
    // A dead/disconnected adapter keeps its last entity array; observing it
    // would keep players "online" after the socket closed.
    if (bot.ready === false || bot.connected === false) {
      this.activity.delete(bot.name);
      return [];
    }
    const observed = [];
    const at = this.now();
    const botDimension = cleanDimension(bot.dimension || (bot.game && bot.game.dimension) || 'overworld');
    let entities = [];
    try {
      entities = typeof bot.entitiesNear === 'function' ? bot.entitiesNear(radius) : (Array.isArray(bot.entities) ? bot.entities : []);
    } catch (_) { entities = []; }
    for (const entity of entities) {
      if (!entity) continue;
      const name = entity.username || entity.name;
      if (!cleanName(name)) continue;
      if (entity.type && entity.type !== 'player' && entity.type !== 'human') continue;
      const entry = this.observe(name, {
        bot: bot.name, position: entity.position, health: entity.health,
        gamemode: entity.gamemode, ping: entity.ping, source: 'entity', seenAt: at,
        uuid: entity.uuid || entity.id, dimension: entity.dimension || botDimension
      });
      if (!entry) continue;
      const d = distance(entity.position, bot.position);
      if (d !== null) entry.botDistances.set(bot.name, { distance: Math.round(d * 10) / 10, at });
      observed.push(entry.name);
    }
    // The server player list survives render-distance loss and carries ping /
    // gamemode for players no bot can currently see.
    let server = [];
    try {
      server = typeof bot.serverPlayers === 'function' ? (bot.serverPlayers() || []) : [];
    } catch (_) { server = []; }
    for (const row of server) {
      if (!row || !cleanName(row.name)) continue;
      this.observe(row.name, {
        bot: bot.name, health: null, gamemode: row.gamemode, ping: row.ping,
        uuid: row.uuid || row.id, source: 'server_list', seenAt: at
      });
    }
    this._prune();
    return observed;
  }

  observeBots(bots) {
    for (const bot of bots || []) this.observeBot(bot);
    return this.list();
  }

  add(name, { notes = null, tags = [], dimension = null } = {}) {
    const cleaned = cleanName(name);
    if (!cleaned) return { ok: false, code: 'INVALID_NAME', error: `invalid player name '${name}'` };
    const entry = this._entry(cleaned);
    const existed = entry.lastSeen !== 0;
    this.observe(cleaned, { source: 'manual', manual: true, dimension });
    if (notes) this.note(cleaned, notes);
    for (const tag of tags || []) this.tag(cleaned, tag);
    this._record(entry, existed ? 'MANUAL_UPDATE' : 'MANUAL_ADD', {});
    return { ok: true, created: !existed, player: this.list({ limit: 200 }).find((row) => row.name === entry.name) };
  }

  note(name, text) {
    const entry = this.get(name);
    if (!entry) return { ok: false, code: 'PLAYER_NOT_SEEN', error: `${String(name)} is not in the directory` };
    const note = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!note) return { ok: false, code: 'INVALID_NOTE', error: 'note text required' };
    if (note.length > 280) return { ok: false, code: 'INVALID_NOTE', error: 'note is limited to 280 characters' };
    entry.notes.push({ text: note, at: this.now() });
    if (entry.notes.length > 20) entry.notes.splice(0, entry.notes.length - 20);
    this._record(entry, 'NOTE', { text: note });
    return { ok: true, player: entry.name, notes: entry.notes.slice() };
  }

  tag(name, tag) {
    const entry = this.get(name);
    if (!entry) return { ok: false, code: 'PLAYER_NOT_SEEN', error: `${String(name)} is not in the directory` };
    const value = String(tag || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,24}$/.test(value)) return { ok: false, code: 'INVALID_TAG', error: 'tags are 1-24 letters, digits, _ or -' };
    if (entry.tags.size >= 12) return { ok: false, code: 'TAG_LIMIT', error: 'a player can carry at most 12 tags' };
    entry.tags.add(value);
    this._record(entry, 'TAG', { tag: value });
    return { ok: true, player: entry.name, tags: [...entry.tags].sort() };
  }

  untag(name, tag) {
    const entry = this.get(name);
    if (!entry) return { ok: false, code: 'PLAYER_NOT_SEEN', error: `${String(name)} is not in the directory` };
    const value = String(tag || '').trim().toLowerCase();
    const removed = entry.tags.delete(value);
    if (removed) this._record(entry, 'UNTAG', { tag: value });
    return { ok: true, player: entry.name, removed, tags: [...entry.tags].sort() };
  }

  forget(name) {
    const entry = this.get(name);
    if (!entry) return { ok: true, removed: false };
    this.players.delete(entry.key);
    if (entry.uuid) this.byUuid.delete(entry.uuid);
    this.stats.pruned++;
    return { ok: true, removed: true, name: entry.name };
  }

  /** Shared watch state so the directory can show which bot is doing what. */
  setActivity(bot, activity = null) {
    if (!bot) return;
    if (!activity || !activity.mode || !activity.target) this.activity.delete(bot);
    else this.activity.set(bot, { bot, mode: String(activity.mode).toUpperCase(), target: activity.target, at: this.now() });
  }

  activityFor(name) {
    const key = nameKey(name);
    if (!key) return [];
    return [...this.activity.values()].filter((row) => nameKey(row.target) === key);
  }

  _prune() {
    const at = this.now();
    const stale = [];
    for (const [key, entry] of this.players) {
      // Manual records carry operator notes/tags. They are not observations
      // that expire; only an explicit forget removes them.
      if (entry.manual) continue;
      if (entry.lastSeen === 0 || at - entry.lastSeen > this.ttlMs) stale.push(key);
    }
    for (const key of stale) {
      const entry = this.players.get(key);
      if (entry && entry.uuid) this.byUuid.delete(entry.uuid);
      this.players.delete(key);
      this.stats.pruned++;
    }
    if (this.players.size <= this.maxPlayers) return;
    const ordered = [...this.players.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    while (this.players.size > this.maxPlayers && ordered.length) {
      const victim = ordered.shift();
      this.players.delete(victim.key);
      if (victim.uuid) this.byUuid.delete(victim.uuid);
      this.stats.pruned++;
    }
  }

  get(name) {
    const key = nameKey(name);
    return key ? this.players.get(key) || null : null;
  }

  byUuidOrName(value) {
    const uuid = validUuid(value);
    if (uuid && this.byUuid.has(uuid)) return this.players.get(this.byUuid.get(uuid)) || null;
    return this.get(value);
  }

  _relationship(entry) {
    if (this.policy) {
      // Trust is a stronger, separately-managed relationship; check it before
      // isProtected(), which intentionally treats trusted players as safe too.
      if (this.policy.isTrusted && this.policy.isTrusted(entry)) return 'trusted';
      if (this.policy.isProtected && this.policy.isProtected(entry)) return 'protected';
      if (entry.tags.has('staff')) return 'staff';
      if (this.policy.targets && this.policy.targets.has(entry.name.toLowerCase())) return 'target';
      if (entry.tags.has('trusted')) return 'trusted';
      if (entry.tags.has('protected')) return 'protected';
    }
    if (entry.manual || entry.tags.size || entry.notes.length) return 'neutral';
    return 'unknown';
  }

  _row(entry, at) {
    const online = this._isOnline(entry, at);
    let nearestBot = null;
    let nearest = null;
    let distanceAt = null;
    if (online) {
      for (const [bot, value] of entry.botDistances) {
        const numeric = typeof value === 'number' ? value : value.distance;
        if (nearest === null || numeric < nearest) {
          nearest = numeric; nearestBot = bot;
          distanceAt = typeof value === 'number' ? null : value.at;
        }
      }
    }
    const positionAgeMs = entry.lastPositionAt ? Math.max(0, at - entry.lastPositionAt) : null;
    const entityFresh = Boolean(entry.lastEntityAt && at - entry.lastEntityAt <= ONLINE_WINDOW_MS);
    const positionFresh = Boolean(entry.lastPositionAt && at - entry.lastPositionAt <= POSITION_FRESH_MS && entityFresh);
    const presence = entityFresh && at - entry.lastEntityAt <= POSITION_FRESH_MS
      ? 'visible'
      : online ? 'online' : (entry.lastSeen && at - entry.lastSeen <= this.ttlMs ? 'recent' : 'offline');
    const activity = this.activityFor(entry.name);
    const tasks = {};
    for (const row of activity) {
      const key = row.mode.toLowerCase();
      if (!tasks[key]) tasks[key] = [];
      tasks[key].push(row.bot);
    }
    return {
      name: entry.name,
      uuid: entry.uuid,
      online,
      presence,
      presenceSource: entry.lastEntityAt && at - entry.lastEntityAt <= ONLINE_WINDOW_MS ? 'entity' : (entry.lastTabSeenAt ? 'server_list' : (entry.manual ? 'manual' : 'unknown')),
      onlineWindowMs: ONLINE_WINDOW_MS,
      onlineSince: entry.lastEntityAt || entry.lastTabSeenAt || null,
      lastSeen: entry.lastSeen,
      lastEntityAt: entry.lastEntityAt || null,
      lastTabSeenAt: entry.lastTabSeenAt || null,
      firstSeen: entry.firstSeen,
      seenBy: [...entry.seenBy],
      position: entry.position ? { ...entry.position } : null,
      positionAgeMs,
      positionFresh,
      dimension: entry.dimension,
      distance: nearest,
      nearestBot,
      distanceAt,
      health: entry.health,
      gamemode: entry.gamemode,
      ping: entry.ping,
      source: entry.source,
      confidence: Math.round(entry.confidence * 100) / 100,
      category: this._relationship(entry),
      tags: [...entry.tags].sort(),
      notes: entry.notes.slice(-3).map((note) => ({ ...note })),
      taskCount: activity.length,
      watchedBy: activity.map((row) => row.bot),
      tasks,
      history: entry.history.slice(-8).map((event) => ({ ...event }))
    };
  }

  list({ limit = 50, category = null, online: onlineOnly = null, query = null } = {}) {
    const at = this.now();
    const wantedCategory = category ? String(category).toLowerCase() : null;
    const text = query ? String(query).toLowerCase() : null;
    return [...this.players.values()]
      .map((entry) => this._row(entry, at))
      .filter((row) => (!wantedCategory || row.category === wantedCategory)
        && (onlineOnly === null || row.online === Boolean(onlineOnly))
        && (!text || row.name.toLowerCase().includes(text) || row.tags.some((tag) => tag.includes(text))))
      .sort((a, b) => (b.online - a.online) || ((a.distance ?? Infinity) - (b.distance ?? Infinity)) || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  getRow(name) {
    const entry = this.get(name);
    return entry ? this._row(entry, this.now()) : null;
  }

  history(name, { limit = 25 } = {}) {
    const entry = this.get(name);
    if (!entry) return null;
    return {
      player: entry.name,
      events: entry.history.slice(-Math.max(1, Math.min(MAX_HISTORY, Number(limit) || 25))).map((event) => ({ ...event }))
    };
  }

  recentEvents({ limit = 50 } = {}) {
    return this.events.slice(-Math.max(1, Math.min(MAX_EVENTS, Number(limit) || 50))).map((event) => ({ ...event }));
  }

  categories() {
    const rows = this.list({ limit: 200 });
    const counts = { team: 0, trusted: 0, protected: 0, target: 0, neutral: 0, unknown: 0, staff: 0 };
    for (const row of rows) counts[row.category] = (counts[row.category] || 0) + 1;
    return { ...counts, total: rows.length };
  }

  status() {
    const rows = this.list({ limit: 200 });
    return {
      count: rows.length,
      online: rows.filter((row) => row.online).length,
      rows,
      categories: this.categories(),
      activeWatches: this.activity.size,
      recentEvents: this.recentEvents({ limit: 20 }),
      stats: { ...this.stats }
    };
  }
}

module.exports = {
  PlayerRegistry, cleanName, nameKey, validUuid, ONLINE_WINDOW_MS,
  POSITION_FRESH_MS, MAX_PLAYERS
};
