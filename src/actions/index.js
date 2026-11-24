'use strict';

const { Logger } = require('../logger');
const { config } = require('../config');
const { SurvivalController } = require('./survival');
const { CombatController } = require('./combat');
const { MiningController } = require('./mining');
const { WoodcuttingController } = require('./woodcutting');
const { FarmingController } = require('./farming');
const { SleepController } = require('./sleep');
const { ExplorationController } = require('./exploration');
const { InventoryManager } = require('./inventory');
const { FishingController } = require('./fishing');
const { HomeBaseManager } = require('./homeBase');
const { RecoveryManager } = require('./recovery');

/**
 * Per-bot action layer. Wires every controller to the same adapter and routes
 * shared task-board assignments to the controller that can actually do the
 * work. Task completion is only recorded when the controller reports a real
 * world change.
 */
class BotActions {
  constructor({
    bot, index = 0, memory = null, taskBoard = null, ledger = null, team = null, home = null,
    library = null, logger = null, builders = null, excavationManager = null, world = null,
    combatTeam = null, comms = null
  } = {}) {
    if (!bot) throw new Error('BotActions requires a bot');
    this.bot = bot;
    this.index = index;
    this.memory = memory;
    this.taskBoard = taskBoard;
    this.ledger = ledger;
    this.team = team;
    this.library = library;
    this.builders = builders || new Map();
    this.excavationManager = excavationManager;
    this.logger = logger || new Logger({ level: config.logging.level });
    this.home = home || { x: 0, y: 64, z: 0 };
    this.recovery = new RecoveryManager({ botName: bot.name, logger: this.logger });
    this._deathHandled = false;
    this._lastRecoveryStepAt = 0;
    this.survival = new SurvivalController({ bot, memory, logger: this.logger });
    this.combat = new CombatController({ bot, team, combatTeam, memory, logger: this.logger, comms, pvp: config.autonomy.pvp, pve: config.autonomy.pve });
    this.mining = new MiningController({ bot, memory, ledger, logger: this.logger });
    this.woodcutting = new WoodcuttingController({ bot, memory, ledger, logger: this.logger });
    this.farming = new FarmingController({ bot, memory, home: this.home, logger: this.logger });
    this.sleep = new SleepController({ bot, memory, taskBoard, home: this.home, logger: this.logger });
    this.fishing = new FishingController({ bot, memory, ledger, logger: this.logger });
    this.exploration = new ExplorationController({ bot, memory, home: this.home, logger: this.logger, teamIndex: index });
    this.inventory = new InventoryManager({ bot, ledger, memory, logger: this.logger });
    this.homeBase = new HomeBaseManager({ bots: [bot], world, memory, taskBoard, ledger, library, logger: this.logger });
    this.lastAction = null;
    this.lastActionAt = 0;
  }

  updateHome(home) {
    this.home = home;
    if (this.sleep) this.sleep.home = home ? { ...home } : null;
    if (this.farming) this.farming.home = home ? { ...home } : null;
    this.exploration.home = home;
    this.homeBase.setHome(home);
  }

  status() {
    return {
      bot: this.bot.name,
      survival: this.survival.status(),
      combat: this.combat.status(),
      mining: this.mining.status(),
      woodcutting: this.woodcutting.status(),
      farming: this.farming.status(),
      sleep: this.sleep.status(),
      fishing: this.fishing.status(),
      exploration: this.exploration.status(),
      inventory: this.inventory.status(),
      homeBase: this.homeBase.status(),
      recovery: this.recovery.status(),
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt
    };
  }

  /** Survival first, then immediate threats. Safe to call every tick. */
  async safetyTick() {
    const bot = this.bot;
    if (bot.health <= 0) {
      this._recordDeath();
      this.combat.onDeath('health reached zero');
      // A dead bot still needs recovery bookkeeping, but cannot act.
      this.recovery.update({ health: 0, food: bot.food, threats: 0 });
      return { ok: false, dead: true, recovery: this.recovery.status() };
    }
    if (this._deathHandled || this.combat.state === 'DEAD') {
      this.combat.onRespawn();
      const threatsNow = typeof bot.entitiesNear === 'function' ? bot.entitiesNear(16) : [];
      this.recovery.recordSpawn({
        position: bot.position,
        threats: threatsNow,
        health: bot.health,
        food: bot.food
      });
      this._deathHandled = false;
    }
    const assessment = this.combat.assess(14);
    this.recovery.update({
      health: bot.health,
      food: bot.food,
      threats: assessment.threats.length,
      spawnSafe: this.recovery.spawnSafety ? this.recovery.spawnSafety.safe : null
    });
    if (!this.recovery.canWork()) {
      const recovery = await this._recover(assessment);
      return { ok: true, recovering: true, recovery, threatCount: assessment.threats.length };
    }
    const survival = await this.survival.tick();
    const follow = this.combat.mode === 'FOLLOW' ? await this.combat.followTick() : null;
    let defence = null;
    if (assessment.threats.length && this.combat.armed) {
      defence = await this.combat.defend({ maxAttacks: 6 });
    }
    const result = { ok: true, survival, follow, defence, threatCount: assessment.threats.length, recovery: this.recovery.status() };
    if (survival.actions.length || defence) {
      this.lastAction = survival.actions.length ? survival.actions[survival.actions.length - 1].action : 'combat';
      this.lastActionAt = Date.now();
    }
    return result;
  }

  /** Capture death evidence exactly once, even if both the adapter and the
   * runtime observed the same event. */
  _recordDeath() {
    if (this._deathHandled) return this.recovery.status();
    const bot = this.bot;
    const last = bot.lastDeath || {};
    const threats = typeof bot.entitiesNear === 'function' ? bot.entitiesNear(18) : [];
    const killer = threats
      .filter((entity) => entity.hostile || entity.type === 'player')
      .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999))[0] || null;
    this.recovery.recordDeath({
      at: Number(last.at) || Date.now(),
      position: last.position || bot.position,
      cause: last.cause || (killer ? `${killer.name || killer.type}` : 'unknown'),
      healthBefore: last.healthBefore ?? null,
      food: last.food ?? bot.food,
      threats,
      lastDamageAt: last.lastDamageAt || bot.lastDamageAt || null,
      deathMessage: last.message || bot.lastDeathMessage || null
    });
    this._deathHandled = true;
    if (this.team && typeof this.team.releaseWork === 'function') {
      this.team.releaseWork(bot.name, 'bot died');
    }
    return this.recovery.status();
  }

  /**
   * Do the minimum needed to break a death loop: heal, re-equip and retreat
   * towards home. This never claims a task and never attacks a player.
   */
  async _recover(assessment = null) {
    const now = Date.now();
    if (now - this._lastRecoveryStepAt < 2500) return this.recovery.status();
    this._lastRecoveryStepAt = now;
    const bot = this.bot;
    const actions = [];
    try {
      const survival = await this.survival.tick();
      if (survival.actions.length) actions.push(...survival.actions);
    } catch (err) {
      this.logger.warn(`[${bot.name}] recovery survival step failed: ${err.message}`);
    }
    try {
      if (bot.health <= 14) {
        const healed = await this.combat.heal({ emergency: true });
        if (healed.did) actions.push({ action: 'recovery-heal', kind: healed.kind || 'heal' });
      }
    } catch (err) {
      this.logger.warn(`[${bot.name}] recovery heal failed: ${err.message}`);
    }
    const threats = assessment && Array.isArray(assessment.threats) ? assessment.threats : [];
    const farFromHome = Math.hypot(bot.position.x - this.home.x, bot.position.z - this.home.z) > 8;
    // Retreat whenever a threat is near and the bot is away from home, even at
    // full health: waiting for damage before moving is what fed the death loop.
    if (threats.length && farFromHome) {
      try {
        const away = threats[0] && threats[0].position ? threats[0].position : this.home;
        const retreat = await bot.goTo(this.home, { range: 3, timeoutMs: 10000 });
        actions.push({ action: 'recovery-retreat', from: { ...away }, ok: retreat.ok !== false, error: retreat.error });
      } catch (err) {
        this.logger.warn(`[${bot.name}] recovery retreat failed: ${err.message}`);
      }
    }
    this.lastAction = actions.length ? actions[actions.length - 1].action : 'recovery-hold';
    this.lastActionAt = Date.now();
    return { ...this.recovery.status(), actions };
  }

  /** Build the survival-base hut phase (shared anchor near home) with real blocks. */
  async buildBasePhase(phase = 'FOUNDATION') {
    const wanted = new Set(['air', 'cave_air', 'leaves', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'short_grass', 'tall_grass', 'fern']);
    const offsets = [[6, 6], [-6, 6], [6, -6], [-6, -6], [10, 0], [0, 10], [-10, 0], [0, -10], [12, 12]];
    let anchor = this.memory && typeof this.memory.getFact === 'function' ? this.memory.getFact('base_anchor') : null;
    for (const [dx, dz] of offsets) {
      if (anchor) break;
      const candidate = { x: Math.floor(this.home.x) + dx, y: Math.floor(this.home.y), z: Math.floor(this.home.z) + dz };
      let clear = true;
      for (let x = candidate.x - 1; x <= candidate.x + 1 && clear; x++) {
        for (let z = candidate.z - 1; z <= candidate.z + 1 && clear; z++) {
          for (let y = candidate.y; y <= candidate.y + 3; y++) {
            const block = this.bot.getBlock({ x, y, z });
            if (!block || !wanted.has(block.name)) { clear = false; break; }
          }
        }
      }
      if (clear) { anchor = candidate; break; }
    }
    if (!anchor) return { ok: false, placed: 0, missing: [], error: 'no clear site for base phase' };
    if (this.memory && typeof this.memory.setFact === 'function' && !this.memory.getFact('base_anchor')) this.memory.setFact('base_anchor', anchor);

    // Clear only vegetation. Never dig blocks a previous phase already placed.
    const vegetation = new Set(['leaves', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'pale_oak_leaves', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log']);
    for (let x = anchor.x - 1; x <= anchor.x + 1; x++) {
      for (let z = anchor.z - 1; z <= anchor.z + 1; z++) {
        for (let y = anchor.y; y <= anchor.y + 3; y++) {
          const block = this.bot.getBlock({ x, y, z });
          if (block && vegetation.has(block.name)) {
            const move = await this.bot.goTo({ x, y, z }, { range: 3 });
            if (move && move.ok === false) continue;
            await this.bot.digBlock({ x, y, z });
          }
        }
      }
    }

    const floor = [];
    const wall = [];
    const roof = [];
    const perimeter = [];
    for (let x = anchor.x - 1; x <= anchor.x + 1; x++) {
      for (let z = anchor.z - 1; z <= anchor.z + 1; z++) {
        floor.push({ x, y: anchor.y, z });
        roof.push({ x, y: anchor.y + 3, z });
        if (x !== anchor.x || z !== anchor.z) {
          wall.push({ x, y: anchor.y + 1, z }, { x, y: anchor.y + 2, z });
        }
      }
    }
    for (let d = -3; d <= 3; d++) {
      perimeter.push({ x: anchor.x + d, y: anchor.y, z: anchor.z - 3 }, { x: anchor.x + d, y: anchor.y, z: anchor.z + 3 });
      perimeter.push({ x: anchor.x - 3, y: anchor.y, z: anchor.z + d }, { x: anchor.x + 3, y: anchor.y, z: anchor.z + d });
    }
    const phaseName = String(phase).toUpperCase();
    let positions;
    let material;
    if (phaseName === 'FOUNDATION') { positions = floor; material = 'cobblestone'; }
    else if (phaseName === 'WALLS') { positions = wall; material = 'oak_planks'; }
    else if (phaseName === 'ROOF') { positions = roof; material = 'oak_planks'; }
    else if (phaseName === 'PERIMETER') { positions = perimeter; material = 'cobblestone'; }
    else { positions = [{ x: anchor.x, y: anchor.y + 1, z: anchor.z }]; material = 'oak_planks'; }

    const missing = [];
    let placed = 0;
    for (const pos of positions) {
      const existing = this.bot.getBlock(pos);
      if (existing && existing.name === material) { placed++; continue; }
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
        // A perimeter cell already filled by solid terrain is already secure.
        if (phaseName === 'PERIMETER') { placed++; continue; }
        missing.push({ ...pos, reason: `occupied by ${existing.name}` });
        continue;
      }
      const move = await this.bot.goTo(pos, { range: 3 });
      if (move && move.ok === false) { missing.push({ ...pos, reason: move.error }); continue; }
      const result = await this.bot.placeBlock(pos, material);
      if (result.ok) placed++;
      else missing.push({ ...pos, reason: result.error });
    }
    // Verify from the world, not from the return values alone.
    const absent = positions.filter((pos) => {
      const block = this.bot.getBlock(pos);
      if (!block) return true;
      if (phaseName === 'PERIMETER') return block.name === 'air' || block.name === 'cave_air';
      return block.name !== material;
    });
    const ok = absent.length === 0;
    return { ok, phase: phaseName, material, anchor, placed, total: positions.length, missing: absent.map((p) => ({ ...p, reason: missing.find((m) => m.x === p.x && m.y === p.y && m.z === p.z)?.reason || 'not placed' })) };
  }

  async performTask(task, context = {}) {
    if (!task) return { ok: false, error: 'no task' };
    let result;
    switch (task.type) {
      case 'CHOP_WOOD': {
        result = await this.woodcutting.tick({ maxTrees: 2, types: task.params?.types || null });
        const chopped = (result.results || []).reduce((sum, r) => sum + (r.chopped || 0), 0);
        result.quantity = chopped;
        result.verified = chopped > 0;
        // No reachable tree is a location problem, not a failed work order.
        if (chopped === 0) { result.ok = true; result.pending = true; }
        break;
      }
      case 'MINE_ORE': {
        const range = Array.isArray(task.params?.yRange) ? task.params.yRange : null;
        const minY = range ? Math.max(-59, Number(range[0]) || 0) : -59;
        if (this.bot.position.y < minY - 1) {
          // Strayed below the assigned band (e.g. an older unbounded shaft):
          // walk back to base instead of mining forever out of range.
          await this.bot.goTo(this.home, { range: 3 });
          result = { ok: true, pending: true, mined: 0, error: 'returning from below the mining band' };
          break;
        }
        result = await this.mining.mineOresDeep({ radius: 48, limit: 6, minY });
        result.quantity = result.mined;
        result.verified = result.mined > 0;
        // No ore in reach is not a failure: keep the claim and search again
        // next tick instead of burning an attempt and failing the objective.
        if (result.mined === 0) { result.ok = true; result.pending = true; }
        break;
      }
      case 'MINE_BLOCK': {
        const blockRange = Array.isArray(task.params?.yRange) ? task.params.yRange : null;
        const blockMinY = blockRange ? Math.max(-59, Number(blockRange[0]) || 0) : -59;
        if (this.bot.position.y < blockMinY - 1) {
          await this.bot.goTo(this.home, { range: 3 });
          result = { ok: true, pending: true, mined: 0, error: 'returning from below the mining band' };
          break;
        }
        result = await this.mining.mineBlocks({ block: task.params?.block || 'stone', radius: 24, limit: 8, minY: blockMinY });
        result.quantity = result.mined;
        result.verified = result.mined > 0;
        // Same rule as ore: an empty local search must not burn the task's
        // remaining attempts and collapse the whole objective.
        if (result.mined === 0) { result.ok = true; result.pending = true; }
        break;
      }
      case 'FARM_CROP': {
        result = await this.farming.harvestAll({ limit: 16, crop: task.params?.crop || null });
        let planted = 0;
        const harvested = result.harvested || 0;
        if (harvested === 0 && task.params?.establish) {
          const start = await this.farming.plantCrops({ crop: task.params?.crop || 'wheat', count: 16 });
          planted = start.planted || 0;
          result.establish = start;
        }
        result.quantity = harvested + planted;
        result.verified = result.quantity > 0;
        if (result.quantity === 0) { result.ok = true; result.pending = true; }
        break;
      }
      case 'FARM_ANIMAL':
        result = await this.farming.feedAnimals();
        result.quantity = result.fed.length;
        result.verified = result.fed.length > 0;
        break;
      case 'EXPLORE':
      case 'FIND_SITE':
        result = await this.exploration.explore({ steps: 3 });
        result.verified = result.results.some((r) => r.ok);
        break;
      case 'RETURN_HOME': {
        const move = await this.bot.goTo(this.home, { range: 3 });
        result = { ok: move.ok !== false, ...move, verified: move.ok !== false };
        break;
      }
      case 'STORE_ITEMS': {
        const item = task.params?.item || null;
        if (!item && task.params?.containers) {
          // Install real containers: craft the missing chests, place them on
          // solid ground, and register each verified position in the ledger.
          const target = Math.max(1, Number(task.params.containers) || 1);
          let have = this.bot.countItem('chest') + this.bot.countItem('trapped_chest');
          let waiting = null;
          while (have < target) {
            if (typeof this.bot.craft !== 'function') { waiting = 'adapter cannot craft'; break; }
            // Convert logs when planks are short; otherwise the chest craft
            // fails and takes the whole objective down with it.
            if (this.bot.countItem('oak_planks') < 8 && this.bot.countItem('oak_log') > 0) {
              const planks = await this.bot.craft('oak_planks', 2);
              if (!planks.ok) { waiting = planks.error || 'cannot mill planks'; break; }
            }
            const crafted = await this.bot.craft('chest', 1);
            if (!crafted.ok) { waiting = crafted.error || 'cannot craft a chest'; break; }
            have++;
          }
          if (waiting) {
            // Missing materials are a supply problem: stay pending and let the
            // logging/plank work unblock us instead of failing the objective.
            result = { ok: true, pending: true, error: `waiting for storage materials: ${waiting}`, placed: have };
            break;
          }
          const placed = [];
          const base = this.bot.position;
          for (let radius = 1; radius <= 4 && placed.length < target; radius++) {
            for (let dx = -radius; dx <= radius && placed.length < target; dx++) {
              for (let dz = -radius; dz <= radius && placed.length < target; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                if (this.bot.countItem('chest') < 1) break;
                const pos = { x: Math.floor(base.x) + dx, y: Math.floor(base.y), z: Math.floor(base.z) + dz };
                const below = this.bot.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
                const at = this.bot.getBlock(pos);
                if (!below || below.name === 'air' || below.name === 'water' || below.name === 'lava') continue;
                if (!at || at.name !== 'air') continue;
                const moved = await this.bot.goTo(pos, { range: 3 });
                if (moved && moved.ok === false) continue;
                const put = await this.bot.placeBlock(pos, 'chest');
                if (!put.ok) continue;
                placed.push(pos);
                if (this.ledger) this.ledger.updateStorage(`placed:${pos.x},${pos.y},${pos.z}`, { position: { ...pos }, counts: {}, label: 'shared storage' });
              }
            }
          }
          result = {
            ok: placed.length >= target,
            containers: placed,
            placed: placed.length,
            quantity: placed.length,
            verified: placed.length >= target,
            error: placed.length >= target ? null : `placed ${placed.length}/${target} chests`
          };
          break;
        }
        if (!item) { result = { ok: false, error: 'store task has no item or container target' }; break; }
        const deposit = await this.inventory.deposit(item, task.params?.count || 64);
        result = { ok: Boolean(deposit.ok), ...deposit, verified: Boolean(deposit.ok) };
        break;
      }
      case 'TRANSFER_ITEMS': {
        const targetName = task.params?.to || task.params?.recipient;
        const recipient = (context.bots && typeof context.bots.get === 'function' ? context.bots.get(targetName) : null) || context.recipient || null;
        if (!recipient) { result = { ok: false, error: `transfer recipient '${targetName || 'unset'}' is unavailable` }; break; }
        if (!task.params?.item) { result = { ok: false, error: 'transfer task has no item' }; break; }
        const before = recipient.countItem(task.params.item);
        const shared = await this.inventory.share(task.params.item, task.params.count || 1, recipient);
        const after = recipient.countItem(task.params.item);
        result = { ok: Boolean(shared.ok), ...shared, verified: Boolean(shared.ok && after - before >= (task.params.count || 1)) };
        break;
      }
      case 'PLACE_BED': {
        // One verified placement per call; the task's unit target accumulates
        // across calls. Never report a pre-existing bed as new work: that used
        // to leave the task permanently short of its quota.
        const bed = await this.sleep.ensureBed({ placeNew: true });
        result = {
          ok: Boolean(bed.ok),
          ...bed,
          quantity: bed.ok && bed.placed ? 1 : 0,
          verified: Boolean(bed.ok && bed.placed)
        };
        break;
      }
      case 'CRAFT': {
        const tool = await this.inventory.ensureTool(task.params?.category || 'pickaxe');
        result = { ok: Boolean(tool.ok), ...tool, verified: Boolean(tool.ok) };
        break;
      }
      case 'SMELT': {
        const smelt = await this.bot.smelt(task.params?.input || 'raw_iron', task.params?.count || 1);
        result = { ok: Boolean(smelt.ok), ...smelt, verified: Boolean(smelt.ok) };
        break;
      }
      case 'FISH': {
        result = await this.fishing.tick({ casts: task.params?.casts || 1 });
        result.quantity = result.caught;
        result.verified = result.caught > 0;
        break;
      }
      case 'DEFEND':
      case 'COMBAT_GUARD':
        result = await this.combat.defend({ maxAttacks: 10 });
        result.verified = result.ok && !result.idle;
        break;
      case 'BUILD_PHASE':
        result = await this.buildBasePhase(task.params?.phase || 'FOUNDATION');
        result.quantity = result.placed;
        result.verified = result.ok && result.missing.length === 0;
        break;
      case 'BUILD_BLOCK': {
        const buildId = task.params?.buildId;
        const builder = context.builder || this.builders.get(buildId);
        if (!builder) { result = { ok: false, error: `no builder for ${buildId}` }; break; }
        result = await builder.executeTask(this.bot, task.id);
        result.verified = result.ok === true;
        break;
      }
      case 'EXCAVATE_REGION': {
        if (!this.excavationManager) { result = { ok: false, error: 'no excavation manager' }; break; }
        result = await this.excavationManager.executeTask(this.bot.name, task);
        result.verified = Boolean(result.ok && result.verified !== false);
        break;
      }
      default:
        result = { ok: false, error: `no handler for task type ${task.type}` };
    }
    this.lastAction = task.type;
    this.lastActionAt = Date.now();
    return { taskId: task.id, type: task.type, ...result };
  }

  /** Execute the coordinator's current assignment, if any. */
  async step({ coordinator = null, builder = null, bots = null, recipient = null } = {}) {
    // Recovery replanning is consumed before any new work is claimed. This is
    // the state transition that used to be missing after a death: the old
    // assignment kept pointing at a task the bot could no longer survive.
    if (this.recovery.needsReplanning()) {
      const assignment = coordinator ? coordinator.getAssignment(this.bot.name) : null;
      if (assignment) {
        const old = this.taskBoard ? this.taskBoard.getTask(assignment.taskId) : null;
        if (old && ['CLAIMED', 'ACTIVE'].includes(old.status)) {
          this.taskBoard.release(old.id, this.bot.name, 'recovery re-plan');
        }
        coordinator.clearAssignment(this.bot.name);
      }
      this.recovery.consumeReplan();
      return { ok: true, held: true, replanned: true, recovery: this.recovery.status() };
    }
    if (!this.recovery.canWork()) {
      return { ok: false, blocked: true, error: 'bot is in recovery', recovery: this.recovery.status() };
    }
    const assignment = coordinator ? coordinator.getAssignment(this.bot.name) : null;
    if (!assignment || !this.taskBoard) return { ok: true, idle: true };
    const task = this.taskBoard.getTask(assignment.taskId);
    if (!task) {
      if (coordinator) coordinator.clearAssignment(this.bot.name);
      return { ok: false, error: 'assigned task missing' };
    }
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED' || task.status === 'FAILED') {
      if (coordinator) coordinator.clearAssignment(this.bot.name, { completed: task.status === 'COMPLETED' });
      return { ok: true, idle: true };
    }
    if (!task.claimedBy) {
      const claim = this.taskBoard.claim(task.id, this.bot.name);
      if (!claim.ok) {
        // A task whose retry budget is exhausted can never be claimed again.
        // Close it instead of leaving the assignment wedged for every tick.
        if (claim.error === 'retry limit reached') {
          this.taskBoard.fail(task.id, 'retry limit reached', { by: null, retry: false });
          if (coordinator) coordinator.clearAssignment(this.bot.name);
        }
        return { ok: false, error: claim.error };
      }
    }
    if (task.claimedBy !== this.bot.name) {
      // The claim expired or was preempted between coordinator ticks. Do not
      // execute work owned by another bot.
      if (coordinator) coordinator.clearAssignment(this.bot.name);
      return { ok: false, error: `task is owned by ${task.claimedBy}` };
    }
    if (task.status !== 'ACTIVE') {
      const started = this.taskBoard.start(task.id, this.bot.name);
      if (!started.ok) return { ok: false, error: started.error };
    }
    // Keep the claim alive for the whole action. Long mining/farming actions
    // routinely exceed the 45s claim TTL; without this heartbeat the board
    // released the task mid-action and another bot could duplicate the work.
    const heartbeat = setInterval(() => {
      try { this.taskBoard.heartbeat(task.id, this.bot.name); } catch (_) { /* board stopped */ }
    }, Math.max(5000, Math.floor((this.taskBoard.claimTtlMs || 45000) / 3)));
    if (heartbeat.unref) heartbeat.unref();
    let result;
    try {
      result = await this.performTask(task, { builder, bots, recipient });
    } finally {
      clearInterval(heartbeat);
      // A final heartbeat also covers tasks that completed faster than the
      // interval; it is harmless because the task is about to leave ACTIVE.
      this.taskBoard.heartbeat(task.id, this.bot.name);
    }
    let verified = result.verified === true;
    let progress = null;
    if (verified && task.units && task.units.target > 1) {
      const produced = Math.max(0, Number(result.quantity) || 0);
      progress = Math.min(task.units.target, (task.units.current || 0) + produced);
      this.taskBoard.updateProgress(task.id, { current: progress });
      if (progress < task.units.target) verified = false;
    }
    // A search that finds nothing is allowed to keep looking, but not forever.
    // After a bounded no-progress window the claim is handed back so another
    // bot (or a fresh approach) can try instead of pinning one bot to a dead
    // area indefinitely.
    if (!verified) {
      const now = Date.now();
      if (!task.noProgressSince) task.noProgressSince = now;
      if (progress !== null && progress > (task.lastProgressValue || 0)) {
        task.lastProgressValue = progress;
        task.noProgressSince = now;
        task.stallCycles = 0;
      } else {
        task.stallCycles = (task.stallCycles || 0) + 1;
      }
      const stallMs = Number(config.team.taskStallMs) || 90000;
      const stallCycles = Number(config.team.taskStallCycles) || 3;
      if (result.ok !== false && task.stallCycles >= stallCycles && now - task.noProgressSince >= stallMs) {
        const error = `no verified progress in ${Math.round(stallMs / 1000)}s; released for re-planning`;
        this.taskBoard.fail(task.id, error, { by: this.bot.name, retry: true });
        if (coordinator) coordinator.clearAssignment(this.bot.name);
        return { ...result, verified: false, progress, stalled: true, error };
      }
    } else {
      task.noProgressSince = null;
      task.stallCycles = 0;
      task.lastProgressValue = progress === null ? task.units.current : progress;
    }
    if (verified) {
      this.taskBoard.complete(task.id, { by: this.bot.name, verified: true, notes: `${task.type} verified` });
      if (coordinator) coordinator.clearAssignment(this.bot.name, { completed: true });
    } else if (result.ok === false) {
      this.taskBoard.fail(task.id, result.error || `${task.type} produced no verified result`, { by: this.bot.name, retry: true });
      if (coordinator) coordinator.clearAssignment(this.bot.name);
    }
    return { ...result, verified, progress };
  }
}

class ActionRegistry {
  constructor(options = {}) {
    this.bots = new Map();
    this.options = options;
  }

  register(bot, index = this.bots.size) {
    const actions = new BotActions({ ...this.options, bot, index });
    this.bots.set(bot.name, actions);
    return actions;
  }

  get(name) { return this.bots.get(name) || null; }
  list() { return [...this.bots.values()]; }

  status() {
    return [...this.bots.entries()].map(([name, actions]) => ({ name, ...actions.status() }));
  }
}

module.exports = { BotActions, ActionRegistry, HomeBaseManager };
