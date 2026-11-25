'use strict';

const { BOT_NAMES } = require('../config');

const TEAM = new Set(BOT_NAMES);
const ONLINE_WINDOW_MS = 15000;
const MAX_PLAYERS = 200;
const MAX_NAME_LENGTH = 32;
const GAMEMODES = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' };

function cleanName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  // Minecraft names are ASCII; rejecting control characters keeps dashboard
  // rows and command output free of injected newlines.
  if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) return null;
  if (TEAM.has(name)) return null;
  return name;
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

/**
 * Seen-player directory shared by every controller. Bots only observe; the
 * registry never attacks, follows or authorises anyone. PvP remains gated by
 * the explicit target list in CombatController.
 */
class PlayerRegistry {
  constructor({ now = () => Date.now(), ttlMs = 30 * 60 * 1000, maxPlayers = MAX_PLAYERS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxPlayers = maxPlayers;
    this.players = new Map();
    this.stats = { observed: 0, updated: 0, rejected: 0, pruned: 0 };
  }

  _entry(name) {
    let entry = this.players.get(name);
    if (!entry) {
      entry = {
        name, firstSeen: this.now(), lastSeen: 0, seenBy: new Set(),
        position: null, health: null, gamemode: null, ping: null,
        botDistances: new Map(), online: false
      };
      this.players.set(name, entry);
    }
    return entry;
  }

  /** Merge one sighting. Untrusted names and non-finite positions are refused. */
  observe(name, { bot = null, position = null, health = null, gamemode = null, ping = null } = {}) {
    const cleaned = cleanName(name);
    if (!cleaned) { this.stats.rejected++; return null; }
    const entry = this._entry(cleaned);
    const at = this.now();
    const first = entry.lastSeen === 0;
    entry.lastSeen = at;
    if (bot && BOT_NAMES.includes(bot)) entry.seenBy.add(bot);
    if (finitePosition(position)) {
      entry.position = roundPosition(position);
      entry.positionAt = at;
    }
    if (health !== null && health !== undefined && Number.isFinite(Number(health))) entry.health = Math.max(0, Math.min(20, Number(health)));
    const mode = typeof gamemode === 'string' ? gamemode.toLowerCase() : GAMEMODES[gamemode];
    if (mode && ['survival', 'creative', 'adventure', 'spectator'].includes(mode)) entry.gamemode = mode;
    if (ping !== null && ping !== undefined && Number.isFinite(Number(ping))) entry.ping = Math.max(0, Math.round(Number(ping)));
    if (first) this.stats.observed++; else this.stats.updated++;
    return entry;
  }

  /** Read one bot's entity list and merge every visible non-team player. */
  observeBot(bot, { radius = 64 } = {}) {
    if (!bot || !bot.name) return [];
    // Distances are per sighting, not historical. A bot that can no longer
    // see the player must not keep advertising its old 3-block distance.
    for (const entry of this.players.values()) entry.botDistances.delete(bot.name);
    if (!finitePosition(bot.position)) return [];
    // A dead/disconnected adapter keeps its last entity array; observing it
    // would keep players "online" after the socket closed.
    if (bot.ready === false || bot.connected === false) return [];
    const observed = [];
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
        gamemode: entity.gamemode, ping: entity.ping
      });
      if (!entry) continue;
      const d = distance(entity.position, bot.position);
      if (d !== null) entry.botDistances.set(bot.name, Math.round(d * 10) / 10);
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
      this.observe(row.name, { bot: bot.name, health: null, gamemode: row.gamemode, ping: row.ping });
    }
    this._prune();
    return observed;
  }

  observeBots(bots) {
    for (const bot of bots || []) this.observeBot(bot);
    return this.list();
  }

  _prune() {
    const at = this.now();
    const stale = [];
    for (const [name, entry] of this.players) {
      if (entry.lastSeen === 0 || at - entry.lastSeen > this.ttlMs) stale.push(name);
    }
    for (const name of stale) {
      this.players.delete(name);
      this.stats.pruned++;
    }
    if (this.players.size <= this.maxPlayers) return;
    const ordered = [...this.players.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    while (this.players.size > this.maxPlayers) {
      const victim = ordered.shift();
      this.players.delete(victim.name);
      this.stats.pruned++;
    }
  }

  get(name) {
    const cleaned = cleanName(name);
    return cleaned ? this.players.get(cleaned) || null : null;
  }

  list({ limit = 50 } = {}) {
    const at = this.now();
    return [...this.players.values()]
      .map((entry) => {
        const online = at - entry.lastSeen <= ONLINE_WINDOW_MS;
        let nearestBot = null;
        let nearest = null;
        if (online) {
          for (const [bot, value] of entry.botDistances) {
            if (nearest === null || value < nearest) { nearest = value; nearestBot = bot; }
          }
        }
        return {
          name: entry.name,
          online,
          onlineWindowMs: ONLINE_WINDOW_MS,
          lastSeen: entry.lastSeen,
          firstSeen: entry.firstSeen,
          seenBy: [...entry.seenBy],
          position: entry.position ? { ...entry.position } : null,
          positionAgeMs: entry.positionAt ? Math.max(0, at - entry.positionAt) : null,
          distance: nearest,
          nearestBot,
          health: entry.health,
          gamemode: entry.gamemode,
          ping: entry.ping
        };
      })
      .sort((a, b) => (b.online - a.online) || ((a.distance ?? Infinity) - (b.distance ?? Infinity)) || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  status() {
    const rows = this.list({ limit: 200 });
    return {
      count: rows.length,
      online: rows.filter((row) => row.online).length,
      rows,
      stats: { ...this.stats }
    };
  }
}

module.exports = { PlayerRegistry, cleanName, ONLINE_WINDOW_MS };
