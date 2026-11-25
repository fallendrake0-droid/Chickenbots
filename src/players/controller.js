'use strict';

const { BOT_NAMES, config } = require('../config');
const { isHostile } = require('../actions/common');
const { cleanName } = require('./registry');

const FOLLOW_DISTANCE = 3;
const GUARD_RADIUS = 8;
const LOOT_LIMIT = 12;
const PROTECTED = new Set([
  'shield', 'totem_of_undying', 'bow', 'crossbow', 'arrow', 'spectral_arrow', 'tipped_arrow',
  'golden_apple', 'enchanted_golden_apple', 'elytra', 'firework_rocket'
]);
const PROTECTED_PATTERN = /(_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots)$/;
const LOOT_PATTERN = /(_log|_planks|_sapling|_propagule|raw_|_ingot|_nugget|coal|charcoal|diamond|emerald|redstone|lapis_lazuli|quartz|amethyst_shard|netherite_scrap|copper_ingot|gold_ingot|iron_ingot|wheat|carrot|potato|beetroot|_seeds|pumpkin|melon_slice|sugar_cane|string|bone|gunpowder|ender_pearl|slime_ball|leather|feather|_hide|_meat|beef|porkchop|chicken|mutton|rabbit|bread|cod|salmon|_wool|glow_ink_sac|ink_sac|nautilus_shell|heart_of_the_sea|honeycomb|honey_bottle)$/;

function textOnly(value, max = 200) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f§]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) return null;
  // Chat that starts with '/' would execute a server command, not a message.
  if (text.startsWith('/')) return null;
  return text;
}

/**
 * Operator-directed interaction with a real player. Nothing here grants PvP:
 * follow, guard, escort, give and loot only move, toss items or fight hostiles.
 * A player is never attacked by this controller.
 */
class PlayerController {
  constructor({ bot, registry = null, combat = null, logger = null } = {}) {
    if (!bot) throw new Error('PlayerController requires a bot');
    this.bot = bot;
    this.registry = registry;
    this.combat = combat;
    this.logger = logger;
    this.mode = null;
    this.target = null;
    this.followDistance = FOLLOW_DISTANCE;
    this.guardRadius = GUARD_RADIUS;
    this.lastAction = null;
    this.lastActionAt = 0;
    this.lastError = null;
    this.lastMoveAt = 0;
    this.lastDrop = null;
    this.lastMessage = null;
    this.stats = { follows: 0, guards: 0, drops: 0, delivered: 0, messages: 0, defences: 0 };
  }

  isActive() { return Boolean(this.mode && this.target); }

  observe() {
    if (this.registry) this.registry.observeBot(this.bot);
    return this.registry ? this.registry.list({ limit: 200 }) : [];
  }

  _note(action, error = null) {
    this.lastAction = action;
    this.lastActionAt = Date.now();
    this.lastError = error;
    if (error && this.logger) this.logger.warn(`[${this.bot.name}] player ${action}: ${error}`);
  }

  _entity(name) {
    const cleaned = cleanName(name);
    if (!cleaned) return null;
    let list = [];
    try {
      list = typeof this.bot.entitiesNear === 'function' ? this.bot.entitiesNear(64) : [];
    } catch (_) { return null; }
    return list.find((entity) => (entity.username || entity.name) === cleaned) || null;
  }

  _target(name) {
    // A command can arrive between entity updates; refresh this bot's sightings
    // before rejecting a player the fleet has in fact just seen.
    if (this.registry) this.registry.observeBot(this.bot);
    const cleaned = cleanName(name);
    if (!cleaned) return { ok: false, code: 'INVALID_NAME', error: `invalid player name '${name}'` };
    if (BOT_NAMES.includes(cleaned)) return { ok: false, code: 'TEAMMATE', error: `${cleaned} is a team bot, not a player` };
    const entry = this.registry ? this.registry.get(cleaned) : null;
    if (!entry) return { ok: false, code: 'PLAYER_NOT_SEEN', error: `${cleaned} has not been seen by the fleet` };
    const entity = this._entity(cleaned);
    return { ok: true, name: cleaned, entry, entity };
  }

  follow(name, { distance = FOLLOW_DISTANCE } = {}) {
    const target = this._target(name);
    if (!target.ok) return target;
    const dist = Math.max(1, Math.min(8, Number(distance) || FOLLOW_DISTANCE));
    this.mode = 'FOLLOW';
    this.target = target.name;
    this.followDistance = dist;
    // Two follow controllers chasing two goals would fight for the pathfinder.
    if (this.combat && this.combat.mode === 'FOLLOW' && typeof this.combat.stopFollow === 'function') this.combat.stopFollow();
    this.stats.follows++;
    this._note(`follow ${target.name}`);
    return { ok: true, bot: this.bot.name, mode: this.mode, target: this.target, distance: dist, visible: Boolean(target.entity) };
  }

  guard(name, { radius = GUARD_RADIUS, distance = FOLLOW_DISTANCE } = {}) {
    const target = this._target(name);
    if (!target.ok) return target;
    this.mode = 'GUARD';
    this.target = target.name;
    if (this.combat && this.combat.mode === 'FOLLOW' && typeof this.combat.stopFollow === 'function') this.combat.stopFollow();
    this.guardRadius = Math.max(3, Math.min(16, Number(radius) || GUARD_RADIUS));
    this.followDistance = Math.max(1, Math.min(8, Number(distance) || FOLLOW_DISTANCE));
    this.stats.guards++;
    this._note(`guard ${target.name}`);
    return { ok: true, bot: this.bot.name, mode: this.mode, target: this.target, radius: this.guardRadius, distance: this.followDistance, visible: Boolean(target.entity) };
  }

  stop() {
    const previous = this.target ? `${this.mode}:${this.target}` : this.mode;
    this.mode = null;
    this.target = null;
    if (typeof this.bot.cancelMotion === 'function') {
      try { this.bot.cancelMotion('player watch stopped'); } catch (_) { /* optional */ }
    }
    this._note('stop');
    return { ok: true, bot: this.bot.name, stopped: true, previous };
  }

  async come(name, { distance = 2, timeoutMs = 15000 } = {}) {
    const target = this._target(name);
    if (!target.ok) return target;
    if (!target.entity) return { ok: false, bot: this.bot.name, target: target.name, code: 'PLAYER_NOT_VISIBLE', error: `${target.name} is not in render distance` };
    const move = await this.bot.goNear(target.entity, Math.max(1, Number(distance) || 2), {
      timeoutMs, priority: 'operator', owner: `player-come:${target.name}`
    });
    const ok = Boolean(move && move.ok !== false);
    this._note(`come ${target.name}`, ok ? null : (move && move.error));
    return { ok, bot: this.bot.name, target: target.name, ...move };
  }

  async tick() {
    if (!this.isActive()) return { ok: true, active: false, status: this.status() };
    const seen = this.registry ? this.registry.get(this.target) : null;
    const entity = this._entity(this.target);
    if (!entity) {
      // The directory keeps a last-known position, but walking to a stale
      // position is worse than waiting: report invisibility and stay put.
      const online = Boolean(seen && Date.now() - seen.lastSeen <= 15000);
      return { ok: true, active: true, visible: false, online, target: this.target, mode: this.mode, status: this.status() };
    }
    const dist = Math.hypot(entity.position.x - this.bot.position.x, entity.position.y - this.bot.position.y, entity.position.z - this.bot.position.z);
    if (this.mode === 'GUARD' && this.combat) {
      const threats = (typeof this.bot.entitiesNear === 'function' ? this.bot.entitiesNear(this.guardRadius, entity.position) : [])
        .filter((candidate) => isHostile(candidate))
        .sort((a, b) => Math.hypot(a.position.x - entity.position.x, a.position.z - entity.position.z)
          - Math.hypot(b.position.x - entity.position.x, b.position.z - entity.position.z));
      if (threats.length && Number(this.bot.health) > 6) {
        const threat = threats[0];
        const reach = Math.hypot(threat.position.x - this.bot.position.x, threat.position.y - this.bot.position.y, threat.position.z - this.bot.position.z);
        if (reach > 3.5) {
          const approach = await this.bot.goNear(threat, 2, {
            timeoutMs: 6000, priority: 'operator', owner: `player-guard:${this.target}`
          });
          if (approach && approach.ok === false) this.lastError = approach.error || 'could not reach a threat near the player';
        }
        const attack = await this.combat.attackEntity(threat);
        if (attack && attack.ok) {
          this.stats.defences++;
          this._note(`guard defence ${threats[0].name || threats[0].type}`);
          return { ok: true, active: true, visible: true, target: this.target, mode: this.mode, defence: attack, distance: dist, status: this.status() };
        }
        if (attack && attack.ok === false) this.lastError = attack.error || 'guard attack refused';
      }
    }
    if (dist > this.followDistance + 1.5 && Date.now() - this.lastMoveAt >= 1200) {
      this.lastMoveAt = Date.now();
      const move = await this.bot.goNear(entity, this.followDistance, {
        timeoutMs: 9000, priority: 'operator', owner: `player-${this.mode.toLowerCase()}:${this.target}`
      });
      if (move && move.ok === false) this.lastError = move.error || 'could not reach player';
      this._note(`${this.mode.toLowerCase()} ${this.target}`, move && move.ok === false ? (move.error || 'move failed') : null);
      return { ok: Boolean(move && move.ok !== false), active: true, visible: true, target: this.target, mode: this.mode, move, distance: dist, status: this.status() };
    }
    return { ok: true, active: true, visible: true, target: this.target, mode: this.mode, distance: dist, status: this.status() };
  }

  /**
   * Toss in stack-sized calls. A real inventory stack cannot exceed 64, so one
   * `tossItem(item, 200)` would only drop 64 and silently under-deliver.
   */
  async _toss(item, amount, { maxCalls = 8 } = {}) {
    let requested = Math.max(0, Number(amount) || 0);
    let delivered = 0;
    let calls = 0;
    while (requested > 0 && calls < maxCalls) {
      const before = Number(this.bot.countItem(item)) || 0;
      if (!before) break;
      const toss = await this.bot.tossItem(item, Math.min(64, requested, before));
      const after = Number(this.bot.countItem(item)) || 0;
      const moved = Math.max(0, before - after);
      if (!toss || toss.ok === false || moved <= 0) break;
      delivered += moved;
      requested -= moved;
      calls++;
    }
    return { delivered, remaining: Math.max(0, Number(this.bot.countItem(item)) || 0), calls, short: requested > 0 };
  }

  async _deliver(name, item, count) {
    const target = this._target(name);
    if (!target.ok) return target;
    if (!target.entity) return { ok: false, bot: this.bot.name, target: target.name, code: 'PLAYER_NOT_VISIBLE', error: `${target.name} is not in render distance` };
    const held = Math.max(0, Number(this.bot.countItem(item)) || 0);
    if (!held) return { ok: false, bot: this.bot.name, target: target.name, item, code: 'NOT_HELD', error: `not holding ${item}` };
    const move = await this.bot.goNear(target.entity, 2, { timeoutMs: 12000, priority: 'operator', owner: `player-give:${target.name}` });
    if (move && move.ok === false) return { ok: false, bot: this.bot.name, target: target.name, item, error: `cannot reach ${target.name}: ${move.error}` };
    // Mineflayer throws in the look direction; face the player so the stack
    // lands at their feet instead of behind the bot.
    if (typeof this.bot.lookAt === 'function') await this.bot.lookAt(target.entity.position);
    const amount = Math.max(1, Math.min(held, Number(count) || held));
    const toss = await this._toss(item, amount);
    const delivered = toss.delivered;
    if (delivered <= 0) {
      return { ok: false, bot: this.bot.name, target: target.name, item, error: 'toss failed', held };
    }
    this.stats.drops++;
    this.stats.delivered += delivered;
    this.lastDrop = { target: target.name, item, count: delivered, at: Date.now() };
    this._note(`gave ${delivered} ${item} to ${target.name}`);
    return {
      ok: true, bot: this.bot.name, target: target.name, item, count: delivered,
      requested: amount, remaining: toss.remaining, partial: delivered < amount, atDistance: 2
    };
  }

  async give(name, item, count = 1) {
    const cleaned = String(item || '').trim().toLowerCase();
    if (!cleaned) return { ok: false, code: 'INVALID_ITEM', error: 'give requires an item name' };
    const target = this._target(name);
    if (!target.ok) return target;
    return this._deliver(target.name, cleaned, Number(count) || 1);
  }

  /**
   * Excess loot only. The configured reserves (logs, ingots, torches, food,
   * building blocks, water) are the team's working stock; dropping them to a
   * player would silently disable crafting, lighting and the next build.
   */
  _lootItems() {
    const equipment = new Set(Object.values(this.bot.equipment || {}).map((value) => (value && value.name) || value).filter(Boolean));
    const reserves = config.reserves || {};
    const food = new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'apple', 'carrot', 'potato', 'beetroot', 'melon_slice', 'sweet_berries', 'glow_berries']);
    const building = new Set(['cobblestone', 'stone', 'dirt', 'sand', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks']);
    let foodReserve = Number(reserves.food) || 0;
    let buildingReserve = Number(reserves.building_blocks) || 0;
    const keep = {
      oak_log: Number(reserves.oak_log) || 0,
      iron_ingot: Number(reserves.iron_ingot) || 0,
      torch: Number(reserves.torch) || 0,
      water_bucket: Number(reserves.water_bucket) || 0
    };
    const candidates = [];
    for (const [name, raw] of Object.entries(this.bot.inventory || {})) {
      const count = Number(raw) || 0;
      if (count <= 0 || !LOOT_PATTERN.test(name) || PROTECTED.has(name)
        || PROTECTED_PATTERN.test(name) || equipment.has(name)) continue;
      let available = count;
      if (keep[name] !== undefined) available = Math.max(0, available - keep[name]);
      if (food.has(name)) {
        const held = Math.min(available, foodReserve);
        foodReserve -= held;
        available -= held;
      }
      if (building.has(name) || /_planks$/.test(name)) {
        const held = Math.min(available, buildingReserve);
        buildingReserve -= held;
        available -= held;
      }
      if (available > 0) candidates.push({ name, count: available });
    }
    return candidates.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Drop loot (or one named item) at a player's feet; gear and totems stay. */
  async dropLoot(name, { item = 'loot', count = null, limit = LOOT_LIMIT } = {}) {
    const target = this._target(name);
    if (!target.ok) return target;
    if (!target.entity) return { ok: false, bot: this.bot.name, target: target.name, code: 'PLAYER_NOT_VISIBLE', error: `${target.name} is not in render distance` };
    const explicit = item && String(item).toLowerCase() !== 'loot' && String(item).toLowerCase() !== 'all';
    const candidates = explicit
      ? [{ name: String(item).trim().toLowerCase(), count: Number(count) || Number(this.bot.countItem(item)) || 0 }]
      : this._lootItems();
    const wanted = candidates.filter((entry) => entry.count > 0 && this.bot.countItem(entry.name) > 0);
    if (!wanted.length) return { ok: false, bot: this.bot.name, target: target.name, code: 'NOTHING_TO_DROP', error: 'no loot is held (gear, tools, armour, totems and food reserves are protected)' };
    const move = await this.bot.goNear(target.entity, 2, { timeoutMs: 12000, priority: 'operator', owner: `player-drop:${target.name}` });
    if (move && move.ok === false) return { ok: false, bot: this.bot.name, target: target.name, error: `cannot reach ${target.name}: ${move.error}` };
    if (typeof this.bot.lookAt === 'function') await this.bot.lookAt(target.entity.position);
    const dropped = [];
    const failures = [];
    const selected = wanted.slice(0, Math.max(1, Math.min(24, Number(limit) || LOOT_LIMIT)));
    const skipped = Math.max(0, wanted.length - selected.length);
    for (const entry of selected) {
      const before = Number(this.bot.countItem(entry.name)) || 0;
      if (!before) continue;
      const allowed = Math.min(before, Number(entry.count) || before);
      const amount = Math.min(allowed, Number(count) || allowed);
      const toss = await this._toss(entry.name, amount);
      if (toss.delivered > 0) {
        dropped.push({ item: entry.name, count: toss.delivered, remaining: toss.remaining, partial: toss.short });
        this.stats.drops++;
        this.stats.delivered += toss.delivered;
      } else {
        failures.push({ item: entry.name, error: 'toss failed' });
      }
    }
    if (!dropped.length) {
      return { ok: false, bot: this.bot.name, target: target.name, dropped, failures, skipped, error: failures[0] ? failures[0].error : 'nothing was dropped' };
    }
    const total = dropped.reduce((sum, entry) => sum + entry.count, 0);
    this.lastDrop = { target: target.name, items: dropped, total, at: Date.now() };
    this._note(`dropped ${total} item(s) for ${target.name}`);
    return {
      ok: true, bot: this.bot.name, target: target.name, dropped, failures, skipped,
      total, protectedEquipment: true, itemCount: dropped.length
    };
  }

  async message(name, text) {
    const target = this._target(name);
    if (!target.ok) return target;
    const message = textOnly(text);
    if (!message) return { ok: false, code: 'INVALID_MESSAGE', error: 'message must be 1-200 printable characters and must not start with /' };
    const greeted = message.includes(target.name) ? message : `${target.name}: ${message}`;
    const sent = await this.bot.say(greeted);
    if (!sent || sent.ok === false) return { ok: false, bot: this.bot.name, target: target.name, error: (sent && sent.error) || 'chat send failed' };
    this.stats.messages++;
    this.lastMessage = { target: target.name, text: greeted, at: Date.now() };
    this._note(`messaged ${target.name}`);
    return { ok: true, bot: this.bot.name, target: target.name, message: greeted };
  }

  async greet(name) {
    const target = this._target(name);
    if (!target.ok) return target;
    const waved = typeof this.bot.swingArm === 'function' ? await this.bot.swingArm() : { ok: true, unsupported: true };
    const said = await this.message(target.name, `Hello ${target.name}!`);
    return { ok: Boolean(said.ok), bot: this.bot.name, target: target.name, wave: waved, message: said.message || null, error: said.error };
  }

  status() {
    const seen = this.target && this.registry ? this.registry.get(this.target) : null;
    return {
      bot: this.bot.name,
      mode: this.mode,
      target: this.target,
      active: this.isActive(),
      distance: this.followDistance,
      guardRadius: this.guardRadius,
      visible: Boolean(this.target && this._entity(this.target)),
      targetOnline: Boolean(seen && Date.now() - seen.lastSeen <= 15000),
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      lastError: this.lastError,
      lastDrop: this.lastDrop,
      lastMessage: this.lastMessage,
      stats: { ...this.stats }
    };
  }
}

module.exports = { PlayerController, LOOT_PATTERN, PROTECTED, textOnly };
