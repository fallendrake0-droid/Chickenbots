'use strict';

const { BotAdapter } = require('./adapter');
const { MockWorld, DROPS } = require('./mockWorld');
const { delay, CancelledError } = require('../util/async');
const { distance, key } = require('../util/vec');
const { BED_NAMES, FOODS, inventorySlotUsage } = require('../world/items');
const { CROPS, TILLABLE, isMatureCrop } = require('../world/crops');
const { config } = require('../config');
const { NavigationManager } = require('../navigation/manager');
const { planRoute, withBlockCache } = require('../navigation/planner');
const { standableAt, nearestStandable, standableCandidates, floorPosition } = require('../navigation/standability');

function finiteMockPosition(pos) {
  return Boolean(pos) && [pos.x, pos.y, pos.z].every((v) => Number.isFinite(Number(v)));
}

const PICK_REQUIRED = {
  stone: 1, cobblestone: 1, deepslate: 1, cobbled_deepslate: 1, andesite: 1, diorite: 1, granite: 1, tuff: 1,
  iron_ore: 2, deepslate_iron_ore: 2, copper_ore: 2, deepslate_copper_ore: 2, lapis_ore: 2, deepslate_lapis_ore: 2,
  gold_ore: 3, deepslate_gold_ore: 3, redstone_ore: 3, deepslate_redstone_ore: 3, diamond_ore: 3, deepslate_diamond_ore: 3,
  emerald_ore: 3, deepslate_emerald_ore: 3, obsidian: 4, ancient_debris: 4, iron_block: 2, gold_block: 3, diamond_block: 3,
  stone_bricks: 1, cobblestone_wall: 1, furnace: 1, blast_furnace: 1, spawner: 1
};

const SHOVEL_BLOCKS = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'sand', 'red_sand', 'gravel', 'clay', 'mud', 'soul_sand', 'soul_soil', 'snow', 'snow_block', 'farmland']);
const AXE_BLOCKS = /_log$|_wood$|_planks$|_fence$|_door$|_trapdoor$|crafting_table|chest|barrel|bookshelf/;

const RECIPES = {
  oak_planks: { yield: 4, ingredients: { oak_log: 1 } },
  stick: { yield: 4, ingredients: { oak_planks: 2 } },
  crafting_table: { yield: 1, ingredients: { oak_planks: 4 } },
  wooden_pickaxe: { yield: 1, ingredients: { oak_planks: 3, stick: 2 } },
  wooden_axe: { yield: 1, ingredients: { oak_planks: 3, stick: 2 } },
  wooden_shovel: { yield: 1, ingredients: { oak_planks: 1, stick: 2 } },
  wooden_hoe: { yield: 1, ingredients: { oak_planks: 2, stick: 2 } },
  wooden_sword: { yield: 1, ingredients: { oak_planks: 2, stick: 1 } },
  stone_pickaxe: { yield: 1, ingredients: { cobblestone: 3, stick: 2 } },
  stone_axe: { yield: 1, ingredients: { cobblestone: 3, stick: 2 } },
  stone_sword: { yield: 1, ingredients: { cobblestone: 2, stick: 1 } },
  stone_shovel: { yield: 1, ingredients: { cobblestone: 1, stick: 2 } },
  iron_pickaxe: { yield: 1, ingredients: { iron_ingot: 3, stick: 2 } },
  iron_sword: { yield: 1, ingredients: { iron_ingot: 2, stick: 1 } },
  iron_axe: { yield: 1, ingredients: { iron_ingot: 3, stick: 2 } },
  iron_shovel: { yield: 1, ingredients: { iron_ingot: 1, stick: 2 } },
  diamond_pickaxe: { yield: 1, ingredients: { diamond: 3, stick: 2 } },
  diamond_sword: { yield: 1, ingredients: { diamond: 2, stick: 1 } },
  diamond_axe: { yield: 1, ingredients: { diamond: 3, stick: 2 } },
  torch: { yield: 4, ingredients: { coal: 1, stick: 1 } },
  chest: { yield: 1, ingredients: { oak_planks: 8 } },
  furnace: { yield: 1, ingredients: { cobblestone: 8 } },
  bucket: { yield: 1, ingredients: { iron_ingot: 3 } },
  bread: { yield: 1, ingredients: { wheat: 3 } },
  white_bed: { yield: 1, ingredients: { white_wool: 3, oak_planks: 3 } },
  ladder: { yield: 3, ingredients: { stick: 7 } },
  oak_fence: { yield: 3, ingredients: { oak_planks: 4, stick: 2 } },
  glass: { yield: 1, ingredients: { sand: 1 }, requiresFurnace: true },
  iron_ingot: { yield: 1, ingredients: { raw_iron: 1 }, requiresFurnace: true }
};

/**
 * Deterministic mock bot with the same adapter contract as a live Mineflayer
 * bot. Used by the simulator, the dashboard demo and the unit/integration tests.
 */
// All mock bots share one Node process and one event loop. Per-move A*
// deadlines are not enough: five safety passes can each spend their full
// budget back-to-back inside the same macrotask and add up to a multi-second
// block. The window below lets the whole fleet plan for at most one budget
// slice, then refuses further planning until the loop has had a turn.
let planWindowUntil = 0;
let planWindowDeadline = 0;
function sharedPlanningDeadline(now) {
  if (now >= planWindowUntil) {
    planWindowUntil = now + 100;
    planWindowDeadline = now + Math.max(50, Number(config.navigation.planBudgetMs) || 350);
  }
  return now < planWindowUntil ? planWindowDeadline : now;
}

class MockBot extends BotAdapter {
  constructor({ name, world = null, speed = 0, inventory = {}, position = null, logger = null } = {}) {
    super({ name, world, logger, speed });
    this.world = world || new MockWorld();
    this.speed = speed;
    // Construction workers on a real server use scaffolds for roofs; the mock
    // has no scaffold task, so it accepts the same placement from the ground
    // within a slightly larger (but still bounded) working reach.
    this.buildReach = 32;
    this.position = position || { x: 0, y: this.world.surfaceY(0, 0) + 1, z: 0 };
    for (const [item, count] of Object.entries(inventory)) if (count > 0) this.inventory[item] = count;
    this.containers = new Map();
    this.isSleeping = false;
    this.spawnPoint = { ...this.position };
    this.uptimeMs = 0;
    this.startedAt = Date.now();
    this._lastDamage = 0;
    this.deaths = 0;
    this.diedAt = null;
    this.lastDeath = null;
    this.lastDeathMessage = null;
    this.lastAttacker = null;
    this.lastDamageAmount = 0;
    this.lastDamageAt = 0;
    this.deathHistory = [];
    this.lastSpawn = {
      at: Date.now(),
      respawned: false,
      position: { ...this.position },
      health: this.health,
      food: this.food,
      dimension: 'overworld'
    };
    this._tickHandle = null;
    this.stats = { dug: 0, placed: 0, moved: 0, attacked: 0, eaten: 0, crafted: 0, fished: 0, deaths: 0, potions: 0, totemActivations: 0, damageDealt: 0, damageTaken: 0 };
    this.itemMeta = {};
    this.combatEvents = [];
    this.heldItem = null;
    this.equipment.offhand = null;
    this.equipment.armorPieces = null;
    this._updateEquipment();
    this._navigation = null;
    this.navigationFleet = null;
  }

  get navigation() {
    if (!this._navigation) {
      this._navigation = new NavigationManager({
        bot: this,
        reader: this,
        now: Date.now,
        logger: this.logger,
        fleet: this.navigationFleet,
        settings: { waitForWorldMs: 0, defaultTimeoutMs: 15000 },
        onMotion: (motion, meta = {}) => {
          if (motion) this._motion = motion;
          else if (!meta.token || (this._motion && this._motion.token === meta.token)) this._motion = null;
        }
      });
    }
    return this._navigation;
  }

  navigationStatus() { return this.navigation.status(); }

  setNavigationFleet(fleet) {
    this.navigationFleet = fleet;
    if (this._navigation) this._navigation.fleet = fleet;
    return this;
  }

  async _wait(ms) {
    if (!this.speed || this.speed <= 0) return;
    await delay(Math.max(1, Math.round(ms / this.speed)));
  }

  get time() { return { timeOfDay: this.world.time, day: Math.floor(this.world.time / 24000) + 1 }; }

  getBlock(pos) { return this.world.getBlock(pos); }

  isDiggable(name) {
    const required = PICK_REQUIRED[name] || 0;
    if (required > 0) {
      const tool = this.bestToolFor('pickaxe');
      if (!tool || tool.tier < required) return false;
    }
    return true;
  }

  _requiredTier(name) { return PICK_REQUIRED[name] || 0; }

  _updateEquipment() {
    const pick = this.bestToolFor('pickaxe');
    const axe = this.bestToolFor('axe');
    const shovel = this.bestToolFor('shovel');
    const sword = this.bestToolFor('sword');
    if (this.heldItem && !this.countItem(this.heldItem)) this.heldItem = null;
    this.equipment = {
      ...this.equipment,
      pickaxe: pick ? pick.tier : 0,
      axe: axe ? axe.tier : 0,
      shovel: shovel ? shovel.tier : 0,
      sword: sword ? sword.tier : 0,
      armor: this.armorPoints(),
      shield: Boolean(this.inventory.shield),
      bow: Boolean(this.inventory.bow),
      pickaxeName: pick ? pick.name : null,
      axeName: axe ? axe.name : null,
      swordName: sword ? sword.name : null,
      heldItem: this.heldItem || (sword ? sword.name : null),
      offhand: this.equipment?.offhand && this.countItem(this.equipment.offhand) ? this.equipment.offhand : null
    };
  }

  addItem(name, count = 1) {
    if (!name || count <= 0) return;
    this.inventory[name] = (this.inventory[name] || 0) + count;
    this._updateEquipment();
  }

  removeItem(name, count = 1) {
    if (!this.inventory[name]) return false;
    this.inventory[name] -= count;
    if (this.inventory[name] <= 0) delete this.inventory[name];
    this._updateEquipment();
    return true;
  }

  async equipBestTool(category) {
    const tool = this.bestToolFor(category);
    if (!tool) return { ok: false, error: `no ${category} in inventory` };
    this._updateEquipment();
    return { ok: true, tool };
  }

  async equipItem(name, destination = 'hand') {
    if (!this.countItem(name)) return { ok: false, error: 'not in inventory' };
    if (destination === 'off-hand') {
      this.equipment.offhand = name;
      this.equipment.shield = name === 'shield';
    } else {
      this.heldItem = name;
      this.equipment.heldItem = name;
    }
    this._updateEquipment();
    return { ok: true, name, destination, verified: destination === 'off-hand' ? this.getOffhand() === name : this.heldItem === name };
  }

  getOffhand() { return this.equipment?.offhand || null; }

  async equipArmor(pieces = []) {
    const available = pieces.filter((piece) => piece && this.countItem(piece.name));
    this.equipment.armorPieces = available.map((piece) => piece.name);
    this.equipment.armor = available.reduce((sum, piece) => sum + (piece.points || 0), 0);
    return { ok: available.length > 0, pieces: available.map((piece) => piece.name), points: this.equipment.armor };
  }

  recordCombatEvent(event) {
    this.combatEvents.push(event);
    if (this.combatEvents.length > 200) this.combatEvents.shift();
    return true;
  }

  drainCombatEvents() { return this.combatEvents.splice(0); }

  async strafe(direction = 'left', { durationMs = 120 } = {}) {
    const sign = direction === 'left' ? 1 : -1;
    const start = { ...this.position };
    const candidates = [
      { x: this.position.x + sign, y: this.position.y, z: this.position.z },
      { x: this.position.x, y: this.position.y, z: this.position.z + sign },
      { x: this.position.x + sign, y: this.position.y, z: this.position.z + sign }
    ];
    for (const candidate of candidates) {
      const foot = this.getBlock(candidate);
      if (!foot || foot.name === 'air' || foot.name === 'water') {
        this.position = candidate;
        this.stats.moved++;
        await this._wait(durationMs);
        return { ok: true, direction, position: { ...this.position }, moved: distance(start, this.position) };
      }
    }
    return { ok: false, error: 'no safe strafe square' };
  }

  applyEffect(effect, { level = 1, duration = 180 } = {}) {
    this.effects[String(effect)] = { level, duration, at: Date.now() };
    return { ok: true, effect, level, duration };
  }

  /**
   * Mock movement now executes the same legal-step model as the live fleet:
   * the target is validated as a standable stance, a deterministic A* path is
   * planned, and the bot walks the returned waypoints. It no longer teleports
   * to an arbitrary surface point, which is why the simulator can catch a
   * blocked doorway or a cliff drop before commissioning.
   */
  async goTo(pos, { range = 1, token = null, timeoutMs = 15000, priority = 'task', owner = null, adjustY = false, replan = false, allowWater = undefined } = {}) {
    if (token && token.cancelled) throw new CancelledError(token.reason);
    if (!pos) return { ok: false, error: 'no target' };
    const limit = Math.max(4, (this.world.size || 256) - 2);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v))));
    const target = {
      x: clamp(pos.x, -limit, limit),
      y: clamp(pos.y, -63, 318),
      z: clamp(pos.z, -limit, limit)
    };
    // A work target is not automatically a legal stance. A tree trunk, a
    // planting cell and an air coordinate all name a *thing to work on*, not a
    // place to stand. Resolve one real stance from the same standability model
    // the live fleet uses, then walk to it; never snap the bot into place.
    if (range >= 2 && !standableAt(this, target, {
      maxDrop: config.navigation.maxDrop,
      allowWater: allowWater === undefined ? config.navigation.allowWater : allowWater
    }).ok) {
      const stances = standableCandidates(this, target, {
        maxNearbyRadius: Math.max(3, Math.ceil(range) + 1),
        maxDrop: config.navigation.maxDrop,
        allowWater: allowWater === undefined ? config.navigation.allowWater : allowWater,
        limit: 6,
        lowFirst: true,
        maxDistance: range + 2
      });
      if (stances.length) {
        return this.navigation.navigate(stances[0].position, {
          range: 0, timeoutMs, priority, owner: owner || String(priority), adjustY: false, replan,
          allowWater: allowWater === undefined ? config.navigation.allowWater : allowWater,
          verifyArrival: true, token
        }, (goal, context) => this._walkNavigationPath(goal, {
          ...context, cancelToken: token, timeoutMs: context.timeoutMs
        }));
      }
    }
    return this.navigation.navigate(target, {
      range, timeoutMs, priority, owner: owner || String(priority), adjustY, replan,
      allowWater: allowWater === undefined ? config.navigation.allowWater : allowWater,
      verifyArrival: true, token
    }, (goal, context) => this._walkNavigationPath(goal, {
      ...context, cancelToken: token, timeoutMs: context.timeoutMs
    }));
  }

  /**
   * Plan and execute one navigation attempt. Long moves are split into
   * segments so each A* search is bounded; a segment that cannot be planned
   * fails honestly instead of falling back to a teleport.
   */
  /**
   * Gravity settle: removing the floor under a mock bot does not automatically
   * move its entity. Before planning, drop it to the first supported stance
   * below. Without this, an excavation that clears the block under a worker
   * leaves it floating and every route fails with `start-no-support`.
   */
  _settleToSupport(maxFall = 4) {
    const here = standableAt(this, this.position, { maxDrop: 0, allowWater: true });
    if (here.ok) return;
    for (let drop = 1; drop <= maxFall; drop++) {
      const candidate = { x: Math.floor(this.position.x), y: Math.floor(this.position.y) - drop, z: Math.floor(this.position.z) };
      if (standableAt(this, candidate, { maxDrop: 0, allowWater: true }).ok) {
        this.position = candidate;
        this.stats.moved++;
        return;
      }
    }
  }

  async _walkNavigationPath(goal, context = {}) {
    this._settleToSupport();
    // Share one block cache across footing checks, stance selection, every
    // candidate trial and all segments of this move. The same cells are
    // inspected repeatedly; a cold read for each one made complex routes
    // several times slower.
    const scan = withBlockCache(this);
    // Mock builders are deliberately placed in the air beside an elevated
    // build. If nothing supports the bot and the goal is already inside build
    // reach, the correct move is to stay put and place from here.
    const footing = standableAt(scan, this.position, { maxDrop: 0, allowWater: true });
    if (!footing.ok && footing.reason === 'no-support') {
      // A mock worker with no ground beneath it stands for a builder hovering
      // beside an elevated schematic. Real pathfinding cannot start there, so
      // move like the pre-navigation mock: step to a clear cell at the goal's
      // level. Supported workers (miners, farmers) never take this branch.
      // If the goal itself is a real stance (for example the stump spot after
      // felling a tree), drop to it. Otherwise hover at the current height so an
      // elevated build keeps its workers beside the structure.
      const groundStance = standableAt(scan, goal, { maxDrop: 32, allowWater: true });
      if (groundStance.ok) {
        this.position = { ...groundStance.position };
        this.stats.moved++;
        this.fallDistance = 0;
        await this._wait(120);
        return { ok: true, path: [], alreadyThere: false, position: { ...this.position } };
      }
      const hoverY = Math.floor(this.position.y);
      const stances = [
        { x: goal.x, y: hoverY, z: goal.z },
        { x: goal.x, y: hoverY, z: goal.z + 1 },
        { x: goal.x + 1, y: hoverY, z: goal.z },
        { x: goal.x - 1, y: hoverY, z: goal.z },
        { x: goal.x, y: hoverY, z: goal.z - 1 },
        { x: goal.x, y: hoverY + 1, z: goal.z }
      ];
      for (const stance of stances) {
        const foot = this.getBlock(stance);
        const head = this.getBlock({ x: stance.x, y: stance.y + 1, z: stance.z });
        const clear = (b) => !b || b.name === 'air' || b.name === 'water';
        if (clear(foot) && clear(head)) {
          this.position = { ...stance };
          this.stats.moved++;
          this.fallDistance = 0;
          await this._wait(120);
          return { ok: true, path: [], alreadyThere: false, position: { ...this.position } };
        }
      }
    }
    const start = { ...this.position };
    const range = Math.max(0, Number(context.range) || 0);
    const maxNodes = config.navigation.maxNodes || 12000;
    // One wall-clock budget for the whole move, shared by every stance trial
    // and segment. Planning is synchronous, so a per-call cap alone would
    // still allow (candidates x segments) x budget of event-loop blocking.
    const planBudgetMs = Math.max(50, Number(config.navigation.planBudgetMs) || 350);
    const planStartedAt = Date.now();
    const planDeadline = Math.min(planStartedAt + planBudgetMs, sharedPlanningDeadline(planStartedAt));
    const maxDrop = config.navigation.maxDrop === undefined ? 3 : config.navigation.maxDrop;
    const allowWater = context.allowWater === undefined ? config.navigation.allowWater !== false : context.allowWater;
    const goalVerdict = standableAt(scan, goal, { maxDrop, allowWater });
    // A target in a tree canopy or on a high ledge is resolved through the
    // normal candidate-stance search below. The bot walks there; it is never
    // snapped onto a convenient block.
    let planTarget = goalVerdict.ok ? floorPosition(goal) : null;
    // A block target can have several standable cells around it. With a range
    // the caller accepts any of them, so choose the best stance ourselves:
    // ground-level cells come first because the nearest cell is often the roof
    // of a half-built structure that has no stairs yet. This avoids planning to
    // an unreachable roof only to fail after a full A* search.
    const candidateStances = standableCandidates(scan, floorPosition(goal), {
      maxNearbyRadius: Math.max(3, Math.min(8, Math.ceil(range) + 2)),
      maxDrop, allowWater, limit: range > 0 ? 12 : 8, lowFirst: range > 0,
      maxDistance: range > 0 ? range + 0.75 : undefined
    });
    if (range > 0 && candidateStances.length) {
      const here = standableAt(scan, this.position, { maxDrop, allowWater });
      planTarget = here.ok && distance(this.position, goal) <= range + 0.5
        ? floorPosition(this.position)
        : candidateStances[0].position;
    }
    const alternateStances = candidateStances;
    if (!planTarget && !candidateStances.length) {
      return {
        ok: false, noPath: true,
        error: `no standable stance near ${goal.x},${goal.y},${goal.z}`,
        position: { ...this.position }
      };
    }
    // For the named block itself a range is valid. If we picked a different
    // standable stance, that stance must be reached exactly: otherwise the
    // planner can stop early inside the old range and fail live arrival
    // verification against the original target.
    const goalFloor = floorPosition(goal);
    const targetIsGoal = Boolean(planTarget
      && planTarget.x === goalFloor.x && planTarget.y === goalFloor.y && planTarget.z === goalFloor.z);
    const planRange = goalVerdict.ok && targetIsGoal ? range : 0;
    const route = [];
    let cursor = { ...this.position };
    const segmentLength = Math.max(8, Number(config.navigation.segmentLength) || 32);
    const distanceTarget = planTarget || (candidateStances[0] && candidateStances[0].position) || floorPosition(goal);
    const totalDistance = Math.hypot(distanceTarget.x - cursor.x, distanceTarget.z - cursor.z);
    const segments = totalDistance > (config.navigation.longDistance || 64)
      ? Math.min(32, Math.ceil(totalDistance / segmentLength))
      : 1;
    let expanded = 0;
    // A stance trial does not need the whole segment budget. Twelve
    // candidates each allowed 12k nodes was a 144k-node synchronous worst
    // case before the first segment even started.
    const trialNodes = Math.max(1500, Math.floor(maxNodes / Math.min(4, Math.max(1, candidateStances.length))));
    if (!planTarget) {
      let chosen = null;
      for (const candidate of candidateStances) {
        const trial = planRoute({
          reader: scan, from: this.position, to: candidate.position, range: 0,
          maxNodes: trialNodes, maxDrop, allowWater, deadline: planDeadline
        });
        expanded += trial.expanded || 0;
        if (trial.ok) { chosen = { candidate, plan: trial }; break; }
        if (trial.reason === 'time-budget') break;
      }
      if (!chosen) {
        return {
          ok: false, noPath: true,
          error: `no reachable standable stance near ${goal.x},${goal.y},${goal.z}`,
          position: { ...this.position }
        };
      }
      planTarget = chosen.candidate.position;
      const route = chosen.plan.path.map((step) => ({ ...step }));
      this.position = { ...(chosen.plan.start || this.position) };
      for (let i = 0; i < route.length; i++) {
        if (context.cancelToken && context.cancelToken.cancelled) throw new CancelledError(context.cancelToken.reason);
        const verdict = standableAt(scan, route[i], { maxDrop, allowWater });
        if (!verdict.ok) return { ok: false, noPath: true, error: `planned step is no longer standable: ${verdict.reason}`, position: { ...this.position } };
        this.position = { ...route[i] };
        this.stats.moved++;
      }
      await this._wait(Math.min(120, 10 + route.length * 3));
      return {
        ok: true, position: { ...this.position }, route: route.length,
        steps: route.length, expanded, distance: route.length, arrived: true
      };
    }
    for (let segment = 0; segment < segments; segment++) {
      const final = segment === segments - 1;
      let waypoint = planTarget;
      if (!final) {
        const t = (segment + 1) / segments;
        const raw = {
          x: Math.round(start.x + (planTarget.x - start.x) * t),
          y: planTarget.y,
          z: Math.round(start.z + (planTarget.z - start.z) * t)
        };
        const stand = nearestStandable(scan, raw, { maxNearbyRadius: 6, maxDrop, allowWater });
        if (!stand.ok) {
          return { ok: false, noPath: true, error: `no standable waypoint at ${raw.x},${raw.y},${raw.z}`, position: { ...this.position } };
        }
        waypoint = stand.position;
      }
      let planned = planRoute({
        reader: scan,
        from: cursor,
        to: waypoint,
        range: final ? planRange : 0,
        maxNodes,
        maxDrop,
        allowWater,
        deadline: planDeadline
      });
      expanded += planned.expanded || 0;
      // An exact destination (range 0) has no alternate stances: accepting a
      // nearby candidate made a failed shaft step look like a successful move
      // and only the manager's arrival check caught it. With a range, a stance
      // inside that range is legal, but never the cell the bot already occupies.
      if (!planned.ok && final && range > 0 && alternateStances.length) {
        for (const candidate of alternateStances) {
          if (candidate.position.x === waypoint.x && candidate.position.y === waypoint.y && candidate.position.z === waypoint.z) continue;
          if (candidate.position.x === cursor.x && candidate.position.y === cursor.y && candidate.position.z === cursor.z) continue;
          const trial = planRoute({
            reader: scan, from: cursor, to: candidate.position, range: 0,
            maxNodes: trialNodes, maxDrop, allowWater, deadline: planDeadline
          });
          expanded += trial.expanded || 0;
          if (!trial.ok || (trial.path.length === 0
            && (candidate.position.x !== cursor.x || candidate.position.y !== cursor.y || candidate.position.z !== cursor.z))) continue;
          planned = trial;
          waypoint = candidate.position;
          planTarget = candidate.position;
          break;
        }
      }
      if (!planned.ok) {
        return {
          ok: false, noPath: true,
          error: `no path from ${Math.floor(cursor.x)},${Math.floor(cursor.y)},${Math.floor(cursor.z)} to ${waypoint.x},${waypoint.y},${waypoint.z}: ${planned.reason}`,
          route, plan: planned, position: { ...this.position }
        };
      }
      // Settle the bot onto the planner's normalised start (for example after
      // the block under its feet was just dug). Without this the planner says
      // "already there" while the entity still floats one block above the new
      // floor, and every following shaft step is a no-op.
      if (segment === 0 && planned.start && finiteMockPosition(planned.start)) {
        this.position = { ...planned.start };
      }
      for (const step of planned.path) route.push(step);
      cursor = planned.goal || waypoint;
    }
    for (let i = 0; i < route.length; i++) {
      // Long walks commit thousands of standability checks. Yield periodically
      // so dashboard state, safety timers and command handlers are not held
      // behind the whole route.
      if (i > 0 && i % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
      if (context.cancelToken && context.cancelToken.cancelled) throw new CancelledError(context.cancelToken.reason);
      if (context.token && this.navigation.arbiter && !this.navigation.arbiter.isCurrent(context.token)) {
        return { ok: false, cancelled: true, superseded: true, error: 'movement request was superseded', position: { ...this.position } };
      }
      const step = route[i];
      const verdict = standableAt(scan, step, { maxDrop, allowWater });
      if (!verdict.ok) {
        return {
          ok: false, noPath: true,
          error: `planned step ${step.x},${step.y},${step.z} is no longer standable: ${verdict.reason}`,
          route, position: { ...this.position }
        };
      }
      this.position = { x: step.x, y: step.y, z: step.z };
      this.stats.moved++;
      this.fallDistance = 0;
      if (verdict.water) this.navigation.telemetry.recordCount('waterSteps');
      if (verdict.drop > 0) this.navigation.telemetry.recordCount('drops');
      if (i % 8 === 7) await new Promise((resolve) => setImmediate(resolve));
    }
    const walked = Math.hypot(this.position.x - start.x, this.position.y - start.y, this.position.z - start.z);
    await this._wait(Math.min(120, 10 + walked * 3));
    return {
      ok: true,
      position: { ...this.position },
      route: route.length,
      steps: route.length,
      expanded,
      distance: walked,
      already: route.length === 0
    };
  }

  async goNear(entity, range = 2, options = {}) {
    if (!entity || !entity.position) return { ok: false, error: 'no entity' };
    const d = distance(this.position, entity.position);
    if (d <= range) return { ok: true, already: true };
    const dir = { x: entity.position.x - this.position.x, z: entity.position.z - this.position.z };
    const len = Math.hypot(dir.x, dir.z) || 1;
    const target = { x: Math.round(entity.position.x - (dir.x / len) * range), y: entity.position.y, z: Math.round(entity.position.z - (dir.z / len) * range) };
    return this.goTo(target, options);
  }

  async digBlock(pos, { token = null, timeoutMs = 15000 } = {}) {
    if (token && token.cancelled) throw new CancelledError(token.reason);
    if (distance(this.position, pos) > 5) return { ok: false, error: 'too far to dig' };
    const block = this.getBlock(pos);
    if (!block || block.name === 'air') return { ok: false, error: 'already air' };
    if (!this.isDiggable(block.name)) return { ok: false, error: `need better tool for ${block.name}` };
    const tier = this._requiredTier(block.name);
    const tool = tier > 0 ? this.bestToolFor('pickaxe') : this.bestToolFor('axe');
    const baseMs = tier > 0 ? (block.name.includes('deepslate') ? 700 : 500) : (AXE_BLOCKS.test(block.name) ? 350 : SHOVEL_BLOCKS.has(block.name) ? 300 : 400);
    const speedFactor = tool ? 1 - tool.tier * 0.1 : 1;
    await this._wait(baseMs * speedFactor);
    this.world.setBlock(pos, 'air');
    // Server-side multi-block companions disappear with their partner.
    if (block.name.endsWith('_door') && block.properties) {
      const other = block.properties.half === 'upper' ? pos.y - 1 : pos.y + 1;
      if (other >= 0) this.world.setBlock({ x: pos.x, y: other, z: pos.z }, 'air');
    }
    if (block.name.endsWith('_bed') && block.properties) {
      const facing = block.properties.facing || 'north';
      const dx = facing === 'east' ? 1 : facing === 'west' ? -1 : 0;
      const dz = facing === 'south' ? 1 : facing === 'north' ? -1 : 0;
      const sign = block.properties.part === 'head' ? -1 : 1;
      this.world.setBlock({ x: pos.x + dx * sign, y: pos.y, z: pos.z + dz * sign }, 'air');
    }
    if (block.name === 'pitcher_crop' && block.properties && block.properties.half !== 'upper') {
      const upper = this.world.getBlock({ x: pos.x, y: pos.y + 1, z: pos.z });
      if (upper && upper.name === 'pitcher_crop') this.world.setBlock({ x: pos.x, y: pos.y + 1, z: pos.z }, 'air');
    }
    this.stats.dug++;
    const drops = {};
    const def = CROPS[block.name];
    if (def) {
      const mature = isMatureCrop(block);
      const seed = (((pos.x * 7 + pos.z * 13 + pos.y) % 3) + 3) % 3;
      const add = (name, count) => {
        if (!name || count <= 0) return;
        drops[name] = (drops[name] || 0) + count;
        this.addItem(name, count);
      };
      if (!mature) {
        add(def.seed, 1);
      } else if (def.stem) {
        add(def.seed, 1);
      } else if (def.seed === def.produce) {
        add(def.produce, 1 + seed);
      } else {
        add(def.produce, 1);
        if (def.seedYield) add(def.seed, 1 + (seed % 3));
      }
      return { ok: true, block: block.name, drops, mature };
    }
    const drop = DROPS[block.name] === undefined ? block.name : DROPS[block.name];
    if (drop) {
      const count = block.name.includes('leaves') ? ((pos.x * 7 + pos.z * 13 + pos.y) % 5 === 0 ? 1 : 0) : 1;
      if (count > 0) {
        drops[drop] = count;
        this.addItem(drop, count);
      }
    }
    return { ok: true, block: block.name, drops };
  }

  async placeBlock(pos, itemName, { token = null, descriptor = null, properties = null, companion = null } = {}) {
    if (token && token.cancelled) throw new CancelledError(token.reason);
    if (!this.countItem(itemName)) return { ok: false, error: `no ${itemName}` };
    const existing = this.getBlock(pos);
    // A door/bed companion may already exist because the server placed it.
    const wanted = descriptor && descriptor.name ? descriptor.name : null;
    if (existing && existing.name !== 'air' && existing.name !== 'water') {
      if (!wanted || existing.name !== wanted) return { ok: false, error: 'space occupied' };
    }
    const reach = Number(this.buildReach) > 0 ? Number(this.buildReach) : 6;
    if (distance(this.position, pos) > reach) return { ok: false, error: 'too far to place' };
    // Buckets place their fluid, not a solid bucket block.
    const placedName = itemName === 'water_bucket' ? 'water' : itemName === 'lava_bucket' ? 'lava' : itemName;
    const name = wanted || placedName;
    const state = descriptor && descriptor.properties ? { ...descriptor.properties } : (properties ? { ...properties } : {});
    this.removeItem(itemName, 1);
    this.world.setBlock(pos, name, state);
    if (['chest', 'trapped_chest'].includes(name)) this._mergeChestStorage(pos);
    if (name === 'water') this._hydrateFarmland(pos);
    if (companion && companion.position) {
      const target = this.getBlock(companion.position);
      if (!target || target.name === 'air' || target.name === wanted) {
        this.world.setBlock(companion.position, companion.descriptor.name, companion.descriptor.properties || {});
      }
    }
    this.stats.placed++;
    await this._wait(80);
    return { ok: true, position: { ...pos }, item: itemName, placed: { name, properties: state } };
  }

  async consume(itemName = null) {
    const name = itemName || (this.bestFoodItem({ critical: this.food <= 6 }) || {}).name;
    if (!name) return { ok: false, error: 'no food' };
    if (!this.countItem(name)) return { ok: false, error: `no ${name} in inventory` };
    const before = { health: this.health, food: this.food, effects: { ...this.effects } };
    if (name === 'milk_bucket') {
      this.removeItem(name, 1);
      this.effects = {};
      await this._wait(600);
      return { ok: true, item: name, effect: 'milk', cleared: true, before, health: this.health, food: this.food };
    }
    const potion = /potion/.test(name) ? name.toLowerCase() : null;
    if (potion) {
      this.removeItem(name, 1);
      const kind = potion.startsWith('splash_') ? 'splash' : potion.startsWith('lingering_') ? 'lingering' : 'drink';
      const text = potion.replace(/^(splash_|lingering_)/, '').replace(/^potion_of_/, '').replace(/^potion_/, '').replace(/_potion$/, '');
      const map = { healing: 'healing', strong_healing: 'healing', regeneration: 'regeneration', strength: 'strength', swiftness: 'speed', speed: 'speed', resistance: 'resistance', fire_resistance: 'fire_resistance', absorption: 'absorption', slow_falling: 'slow_falling', water_breathing: 'water_breathing', invisibility: 'invisibility', turtle_master: 'turtle_master', poison: 'poison', wither: 'wither', slowness: 'slowness', weakness: 'weakness' };
      const effect = map[text] || text;
      if (effect === 'healing') this.health = Math.min(20, this.health + (text.includes('strong') ? 8 : 4));
      else this.applyEffect(effect, { level: text.includes('strong') ? 2 : 1, duration: 45 });
      this.stats.potions++;
      await this._wait(600);
      return { ok: true, item: name, kind, effect, before, health: this.health, food: this.food };
    }
    const food = { name, ...(FOODS[name] || {}) };
    this.removeItem(name, 1);
    const hunger = food.hunger || 4;
    const saturation = food.saturation || 2;
    this.food = Math.min(20, this.food + hunger);
    this.saturation = Math.min(20, this.saturation + saturation);
    if (name === 'enchanted_golden_apple') {
      this.health = Math.min(20, this.health + 4);
      this.applyEffect('regeneration', { level: 2, duration: 30 });
      this.applyEffect('absorption', { level: 4, duration: 120 });
      this.applyEffect('resistance', { level: 1, duration: 300 });
      this.applyEffect('fire_resistance', { level: 1, duration: 300 });
    } else if (name === 'golden_apple') {
      this.health = Math.min(20, this.health + 4);
      this.applyEffect('regeneration', { level: 2, duration: 5 });
      this.applyEffect('absorption', { level: 1, duration: 120 });
    }
    this.stats.eaten++;
    await this._wait(1200);
    return { ok: true, item: name, food: this.food, saturation: this.saturation, health: this.health, before };
  }

  async fish({ timeoutMs = 2000 } = {}) {
    if (!this.countItem('fishing_rod')) return { ok: false, error: 'no fishing_rod in inventory' };
    const water = this.world && typeof this.world.findBlocks === 'function'
      ? this.world.findBlocks(['water', 'flowing_water'], this.position, 16, 1)
      : [];
    if (!water.length) return { ok: false, error: 'no water within fishing range' };
    await this._wait(Math.min(1800, Math.max(400, timeoutMs)));
    const options = ['cod', 'cod', 'salmon', 'tropical_fish', 'pufferfish'];
    const item = options[this.stats.fished % options.length];
    this.addItem(item, 1);
    this.stats.fished++;
    return { ok: true, item, count: 1, items: [{ name: item, count: 1 }], water: { ...water[0] } };
  }

  async attack(entity, { token = null, authorizedPlayer = false } = {}) {
    if (token && token.cancelled) throw new CancelledError(token.reason);
    if (!entity) return { ok: false, error: 'no target' };
    if (entity.type === this.name || (entity.username && config.team.names.includes(entity.username))) return { ok: false, error: 'never attack teammates' };
    if (entity.username && !authorizedPlayer) return { ok: false, error: 'player attacks require explicit PvP authorisation' };
    const held = this.heldItem || (this.bestToolFor('sword') || {}).name || null;
    const ranged = held === 'bow' || held === 'crossbow';
    if (ranged && !this.countItem('arrow')) return { ok: false, error: 'no arrows' };
    const reach = ranged ? 32 : held === 'trident' ? 4.5 : 4;
    if (distance(this.position, entity.position) > reach) return { ok: false, error: 'out of reach' };
    const damageTable = { wooden_sword: 4, golden_sword: 4, stone_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8, wooden_axe: 7, golden_axe: 7, stone_axe: 9, iron_axe: 9, diamond_axe: 9, netherite_axe: 10, trident: 9, mace: 6, bow: 6, crossbow: 7 };
    const meta = this.itemMeta[held] || {};
    const sharp = Number((meta.enchantments || {}).sharpness || 0);
    const damage = (damageTable[held] || 1) + (sharp ? 0.5 * sharp + 0.5 : 0) + (this.effects.strength ? 3 : 0);
    if (ranged) this.removeItem('arrow', 1);
    if (meta.durability !== undefined && meta.durability > 0) meta.durability = Math.max(0, meta.durability - 1);
    // Controllers pass snapshots; always mutate the live world entity.
    const live = this.world.entities.find((e) => e.id === entity.id) || entity;
    live.health = (live.health === undefined ? 20 : live.health) - damage;
    this.stats.attacked++;
    this.stats.damageDealt += damage;
    await this._wait(600);
    if (live.health <= 0) {
      live.alive = false;
      this.world.removeMob(live.id);
      return { ok: true, killed: true, entity: live.type, damage, weapon: held, health: 0 };
    }
    return { ok: true, killed: false, entity: live.type, damage, weapon: held, health: live.health };
  }

  async useShield(on) {
    this.equipment.shield = Boolean(on && this.countItem('shield'));
    return { ok: this.equipment.shield, shield: this.equipment.shield };
  }

  /** Foot of a bed, so the mock mirrors the live adapter's spawn contract. */
  _bedFoot(bedPos) {
    const block = this.getBlock(bedPos);
    if (!block || !BED_NAMES.has(block.name)) return null;
    const part = String((block.properties && block.properties.part) || '').toLowerCase();
    if (part === 'foot') return { position: { ...bedPos }, part };
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const neighbourPos = { x: bedPos.x + dx, y: bedPos.y, z: bedPos.z + dz };
      const neighbour = this.getBlock(neighbourPos);
      if (!neighbour || neighbour.name !== block.name) continue;
      if (String((neighbour.properties && neighbour.properties.part) || '').toLowerCase() === 'foot') {
        return { position: { ...neighbourPos }, part: 'foot' };
      }
    }
    return { position: { ...bedPos }, part: part || 'unknown' };
  }

  async setSpawnPoint(bedPos) {
    const foot = this._bedFoot(bedPos);
    if (!foot) return { ok: false, code: 'NO_BED', error: 'no bed at position' };
    if (distance(this.position, foot.position) > 4) {
      const move = await this.goTo(foot.position, { range: 2, timeoutMs: 5000 });
      if (move && move.ok === false) return { ok: false, code: 'UNREACHABLE', error: move.error, bed: foot.position };
    }
    this.spawnPoint = { ...foot.position };
    await this._wait(60);
    return { ok: true, verified: true, bed: foot.position, spawnPoint: { ...this.spawnPoint }, position: { ...this.spawnPoint } };
  }

  async sleep(bedPos) {
    const foot = this._bedFoot(bedPos);
    if (!foot) return { ok: false, error: 'no bed at position' };
    if (this.world.time < 12541 || this.world.time > 23459) return { ok: false, error: 'not night' };
    this.isSleeping = true;
    this.spawnPoint = { ...foot.position };
    this.position = { x: bedPos.x, y: bedPos.y + 1, z: bedPos.z };
    this.world.setTime(0);
    await this._wait(500);
    this.isSleeping = false;
    return { ok: true, slept: true, spawnPoint: { ...this.spawnPoint }, time: this.world.time };
  }

  async wake() { this.isSleeping = false; return { ok: true }; }

  _hydrateFarmland(waterPos) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        for (const dy of [0, 1]) {
          const pos = { x: Math.floor(waterPos.x) + dx, y: Math.floor(waterPos.y) + dy, z: Math.floor(waterPos.z) + dz };
          const block = this.getBlock(pos);
          if (block && block.name === 'farmland') this.world.setBlock(pos, 'farmland', { ...(block.properties || {}), moisture: 7 });
        }
      }
    }
  }

  async tillSoil(pos) {
    if (distance(this.position, pos) > 5) return { ok: false, error: 'too far to till' };
    const block = this.getBlock(pos);
    if (!block) return { ok: false, error: 'soil position is unloaded' };
    if (block.name === 'farmland') return { ok: true, already: true, position: { ...pos } };
    if (!TILLABLE.has(block.name)) return { ok: false, error: `${block.name} cannot be tilled` };
    const hoe = this.bestToolFor('hoe');
    if (!hoe) return { ok: false, error: 'no hoe in inventory' };
    await this._wait(250);
    this.world.setBlock(pos, 'farmland', { moisture: this._waterNear(pos) ? 7 : 0 });
    this.stats.tilled = (this.stats.tilled || 0) + 1;
    return { ok: true, position: { ...pos }, block: 'farmland', tool: hoe.name || hoe };
  }

  _waterNear(pos, radius = 4) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (const dy of [0, 1]) {
          const block = this.getBlock({ x: Math.floor(pos.x) + dx, y: Math.floor(pos.y) + dy, z: Math.floor(pos.z) + dz });
          if (block && ['water', 'flowing_water'].includes(block.name)) return true;
        }
      }
    }
    return false;
  }

  async feed(animal, itemName) {
    if (!animal || !itemName) return { ok: false, error: 'feed requires an animal and food' };
    const entity = typeof animal === 'object' && animal.id !== undefined
      ? this.world.entities.find((entry) => entry.id === animal.id)
      : this.world.entities.find((entry) => entry.name === animal || entry.type === animal);
    if (!entity) return { ok: false, error: 'animal not found' };
    if (entity.alive === false) return { ok: false, error: 'animal is not alive' };
    if (entity.baby) return { ok: false, error: 'animal is too young to breed' };
    if (distance(this.position, entity.position) > 4) return { ok: false, error: 'too far to feed' };
    if (entity.inLove) return { ok: false, error: 'animal is already in love' };
    if (this.countItem(itemName) < 1) return { ok: false, error: `no ${itemName}` };
    this.removeItem(itemName, 1);
    entity.inLove = true;
    entity.fedAt = Date.now();
    this.stats.fed = (this.stats.fed || 0) + 1;
    const mate = this.world.entities.find((other) => other !== entity && other.alive !== false && !other.baby
      && (other.name || other.type) === (entity.name || entity.type) && other.inLove
      && distance(other.position, entity.position) <= 8);
    if (!mate) return { ok: true, animal: entity.name || entity.type, food: itemName, consumed: 1, verified: true };
    entity.inLove = false;
    entity.fedAt = null;
    mate.inLove = false;
    mate.fedAt = null;
    const offspring = this.world.addMob(entity.name || entity.type, {
      x: (entity.position.x + mate.position.x) / 2,
      y: entity.position.y,
      z: (entity.position.z + mate.position.z) / 2
    }, { baby: true });
    this.stats.bred = (this.stats.bred || 0) + 1;
    return {
      ok: true, animal: entity.name || entity.type, food: itemName, consumed: 1, verified: true,
      bred: true, offspring: { id: offspring.id, type: offspring.type, baby: true }
    };
  }

  /** Both halves of a double chest share one storage key. */
  _chestStorageKey(pos) {
    const block = this.getBlock(pos);
    if (!block || !['chest', 'trapped_chest'].includes(block.name)) return key(pos);
    let best = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const other = { x: best.x + dx, y: best.y, z: best.z + dz };
      const otherBlock = this.getBlock(other);
      if (!otherBlock || otherBlock.name !== block.name) continue;
      if (other.x < best.x || (other.x === best.x && other.z < best.z)) best = other;
    }
    return key(best);
  }

  _doubleChest(pos) {
    const block = this.getBlock(pos);
    if (!block || !['chest', 'trapped_chest'].includes(block.name)) return false;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
      const other = this.getBlock({ x: Math.floor(pos.x) + dx, y: Math.floor(pos.y), z: Math.floor(pos.z) + dz });
      return other && other.name === block.name;
    });
  }

  /** Fold contents of both halves under the canonical (lowest x/z) key. */
  _mergeChestStorage(pos) {
    const block = this.getBlock(pos);
    if (!block || !['chest', 'trapped_chest'].includes(block.name)) return;
    const parts = [pos];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const other = { x: Math.floor(pos.x) + dx, y: Math.floor(pos.y), z: Math.floor(pos.z) + dz };
      const otherBlock = this.getBlock(other);
      if (otherBlock && otherBlock.name === block.name) parts.push(other);
    }
    if (parts.length < 2) return;
    const canonical = this._chestStorageKey(pos);
    const merged = {};
    for (const part of parts) {
      const existing = this.containers.get(key(part));
      if (!existing) continue;
      for (const [name, count] of Object.entries(existing)) merged[name] = (merged[name] || 0) + count;
      this.containers.delete(key(part));
    }
    this.containers.set(canonical, merged);
  }

  async openContainer(pos) {
    const block = this.getBlock(pos);
    if (!block || !['chest', 'barrel', 'trapped_chest', 'shulker_box'].includes(block.name)) return { ok: false, error: 'no container there' };
    const k = this._chestStorageKey(pos);
    if (!this.containers.has(k)) this.containers.set(k, {});
    const contents = this.containers.get(k);
    const capacity = this._doubleChest(pos) ? 54 : 27;
    const self = this;
    return {
      ok: true,
      position: { ...pos },
      items: () => contents,
      withdraw: async (itemName, count = 1) => {
        const have = contents[itemName] || 0;
        const take = Math.min(have, count);
        if (take <= 0) return { ok: false, error: 'not in container' };
        contents[itemName] -= take;
        if (contents[itemName] <= 0) delete contents[itemName];
        self.addItem(itemName, take);
        return { ok: true, item: itemName, count: take };
      },
      deposit: async (itemName, count = 1) => {
        const have = self.countItem(itemName);
        if (have <= 0) return { ok: false, error: 'not in inventory' };
        const fits = (n) => inventorySlotUsage({ ...contents, [itemName]: (contents[itemName] || 0) + n }, capacity).used <= capacity;
        let put = Math.min(have, count);
        while (put > 0 && !fits(put)) put--;
        if (put <= 0) return { ok: false, error: 'container is full' };
        self.removeItem(itemName, put);
        contents[itemName] = (contents[itemName] || 0) + put;
        return { ok: true, item: itemName, count: put };
      },
      close: async () => ({ ok: true })
    };
  }

  async closeContainer() { return { ok: true }; }

  async tossItem(itemName, count = 1) {
    if (!this.countItem(itemName)) return { ok: false, error: 'not held' };
    const toss = Math.min(count, this.countItem(itemName));
    this.removeItem(itemName, toss);
    return { ok: true, item: itemName, count: toss };
  }

  async craft(itemName, count = 1) {
    const recipe = RECIPES[itemName];
    if (!recipe) return { ok: false, error: `no recipe for ${itemName}` };
    if (recipe.requiresFurnace) return { ok: false, error: 'requires a furnace' };
    for (let i = 0; i < count; i++) {
      for (const [ing, n] of Object.entries(recipe.ingredients)) {
        if (this.countItem(ing) < n) return { ok: false, error: `missing ${ing}` };
      }
      for (const [ing, n] of Object.entries(recipe.ingredients)) this.removeItem(ing, n);
      this.addItem(itemName, recipe.yield);
      this.stats.crafted++;
    }
    await this._wait(300);
    return { ok: true, item: itemName, count: recipe.yield * count };
  }

  async smelt(input, count = 1) {
    const output = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot', sand: 'glass', cobblestone: 'stone' }[input];
    if (!output) return { ok: false, error: `cannot smelt ${input}` };
    if (this.countItem(input) < count) return { ok: false, error: `missing ${input}` };
    if (!this.countItem('coal') && !this.countItem('oak_planks')) return { ok: false, error: 'no fuel' };
    this.removeItem(input, count);
    this.addItem(output, count);
    if (this.countItem('coal')) this.removeItem('coal', 1); else this.removeItem('oak_planks', 1);
    return { ok: true, output, count };
  }

  async say(message) {
    this.lastChat = String(message).slice(0, 250);
    return { ok: true };
  }

  serverPlayers() {
    return Array.isArray(this.serverPlayerList) ? this.serverPlayerList.slice() : [];
  }

  async chat(message) { return this.say(message); }

  cancelMotion() { return { ok: true, cancelled: true }; }

  async setControlState(control, state) { this.controls = this.controls || {}; this.controls[control] = state; return { ok: true }; }

  async lookAt(pos) { return { ok: true }; }

  async jump() { return { ok: true }; }

  async collectDrops() { return { ok: true, collected: 0 }; }

  async dropJunk() {
    const dropped = [];
    for (const [name, count] of Object.entries(this.inventory)) {
      if (dropped.length >= 3) break;
      if (['dirt', 'gravel', 'andesite', 'diorite', 'granite', 'tuff'].includes(name)) {
        await this.tossItem(name, count);
        dropped.push(name);
      }
    }
    return { ok: true, dropped };
  }

  damage(amount, cause = 'mob', { attacker = null, message = null } = {}) {
    const before = this.health;
    const damage = Math.max(0, Number(amount) || 0);
    this.health = Math.max(0, this.health - damage);
    this.stats.damageTaken += damage;
    this._lastDamage = Date.now();
    this.lastDamageAt = this._lastDamage;
    this.lastDamageAmount = Number((before - this.health).toFixed(2));
    this.lastAttacker = attacker ? {
      name: attacker.name || attacker.username || attacker.type || cause,
      type: attacker.type || null,
      distance: Number.isFinite(attacker.distance) ? Number(attacker.distance.toFixed(1)) : null
    } : null;
    if (message) this.lastDeathMessage = String(message).slice(0, 240);
    if (this.health <= 0 && this.getOffhand() === 'totem_of_undying' && this.countItem('totem_of_undying') > 0) {
      this.removeItem('totem_of_undying', 1);
      this.equipment.offhand = null;
      this.health = 1;
      this.applyEffect('regeneration', { level: 2, duration: 45 });
      this.applyEffect('absorption', { level: 2, duration: 5 });
      this.applyEffect('fire_resistance', { level: 1, duration: 40 });
      this.stats.totemActivations++;
      this.recordCombatEvent({ at: new Date().toISOString(), type: 'totem_activated', bot: this.name, damage: amount, health: this.health });
      return { dead: false, totem: true, health: this.health, before };
    }
    if (this.health <= 0) {
      this.deaths++;
      this.stats.deaths++;
      this.diedAt = { ...this.position };
      const at = Date.now();
      const causeLabel = this.lastAttacker
        ? `${this.lastAttacker.name}${this.lastAttacker.distance !== null ? ` (${this.lastAttacker.distance}m)` : ''}`
        : this.lastDeathMessage || cause || 'unknown damage source';
      const blockAt = (dx, dy, dz) => {
        try {
          const block = this.getBlock({ x: Math.floor(this.position.x) + dx, y: Math.floor(this.position.y) + dy, z: Math.floor(this.position.z) + dz });
          return block && block.name ? String(block.name).replace(/^minecraft:/, '') : null;
        } catch (_) { return null; }
      };
      const blocks = { feet: blockAt(0, 0, 0), head: blockAt(0, 1, 0), below: blockAt(0, -1, 0) };
      const names = Object.values(blocks).filter(Boolean);
      const hazards = [];
      if (names.some((name) => name.includes('lava'))) hazards.push('lava');
      if (names.some((name) => name === 'fire' || name === 'soul_fire')) hazards.push('fire');
      if (names.some((name) => name.includes('water'))) hazards.push('water');
      this.lastDeath = {
        at,
        position: { ...this.position },
        cause: causeLabel,
        confidence: this.lastDeathMessage ? 'confirmed' : this.lastAttacker ? 'likely' : 'unknown',
        summary: `Died at ${Math.round(this.position.x)},${Math.round(this.position.y)},${Math.round(this.position.z)}: ${causeLabel}`,
        healthBefore: before,
        food: this.food,
        saturation: this.saturation ?? null,
        lastDamageAt: this.lastDamageAt || null,
        lastDamageAmount: this.lastDamageAmount || null,
        attacker: this.lastAttacker || null,
        message: this.lastDeathMessage || null,
        dimension: this.dimension || 'overworld',
        velocity: null,
        onGround: this.onGround ?? null,
        equipment: {
          held: this.heldItem || null,
          offhand: this.getOffhand ? this.getOffhand() : null,
          armor: this.equipment.armorPieces || [],
          toolTiers: { pickaxe: this.equipment.pickaxe || 0, axe: this.equipment.axe || 0, shovel: this.equipment.shovel || 0, sword: this.equipment.sword || 0 }
        },
        environment: {
          blocks,
          hazards,
          flags: { onGround: this.onGround ?? null, oxygen: this.oxygen ?? null, food: this.food ?? null, saturation: this.saturation ?? null, health: this.health ?? null, onFire: Boolean(this.onFire), inLava: Boolean(this.inLava) }
        }
      };
      this.deathHistory.push(this.lastDeath);
      if (this.deathHistory.length > 40) this.deathHistory.shift();
      this.lastDeathMessage = null;
      return { dead: true, death: this.lastDeath };
    }
    return { dead: false, health: this.health };
  }

  respawn(position = null) {
    const firstSpawn = !this.lastSpawn;
    this.health = 20;
    this.food = 20;
    this.position = position || { x: 0, y: this.world.surfaceY(0, 0) + 1, z: 0 };
    this.isSleeping = false;
    this.inLava = false;
    this.onFire = false;
    this.spawned = true;
    this.lastSpawn = {
      at: Date.now(),
      respawned: !firstSpawn,
      position: { ...this.position },
      health: this.health,
      food: this.food,
      dimension: this.dimension || 'overworld'
    };
    this.deathHandled = true;
    return { ok: true, position: this.position, lastSpawn: this.lastSpawn };
  }

  startTicking(intervalMs = 500) {
    if (this._tickHandle) return;
    this._tickHandle = setInterval(() => {
      this.uptimeMs = Date.now() - this.startedAt;
      this.world.advanceTime(20);
      this.food = Math.max(0, this.food - 0.02);
      if (this.food > 17 && this.health < 20) this.health = Math.min(20, this.health + 0.1);
    }, intervalMs);
    if (this._tickHandle.unref) this._tickHandle.unref();
  }

  stopTicking() {
    if (this._tickHandle) clearInterval(this._tickHandle);
    this._tickHandle = null;
  }
}

module.exports = { MockBot, RECIPES, PICK_REQUIRED };
