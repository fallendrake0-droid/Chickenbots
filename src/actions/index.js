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

/**
 * Per-bot action layer. Wires every controller to the same adapter and routes
 * shared task-board assignments to the controller that can actually do the
 * work. Task completion is only recorded when the controller reports a real
 * world change.
 */
class BotActions {
  constructor({
    bot, index = 0, memory = null, taskBoard = null, ledger = null, team = null, home = null,
    library = null, logger = null, builders = null, excavationManager = null, world = null
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
    this.survival = new SurvivalController({ bot, memory, logger: this.logger });
    this.combat = new CombatController({ bot, team, memory, logger: this.logger, pvp: config.autonomy.pvp });
    this.mining = new MiningController({ bot, memory, ledger, logger: this.logger });
    this.woodcutting = new WoodcuttingController({ bot, memory, ledger, logger: this.logger });
    this.farming = new FarmingController({ bot, memory, logger: this.logger });
    this.sleep = new SleepController({ bot, memory, taskBoard, logger: this.logger });
    this.fishing = new FishingController({ bot, memory, ledger, logger: this.logger });
    this.exploration = new ExplorationController({ bot, memory, home: this.home, logger: this.logger, teamIndex: index });
    this.inventory = new InventoryManager({ bot, ledger, memory, logger: this.logger });
    this.homeBase = new HomeBaseManager({ bots: [bot], world, memory, taskBoard, ledger, library, logger: this.logger });
    this.lastAction = null;
    this.lastActionAt = 0;
  }

  updateHome(home) {
    this.home = home;
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
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt
    };
  }

  /** Survival first, then immediate threats. Safe to call every tick. */
  async safetyTick() {
    if (this.bot.health <= 0) return { ok: false, dead: true };
    const survival = await this.survival.tick();
    const threats = this.combat.assess(14);
    let defence = null;
    if (threats.threats.length) {
      defence = await this.combat.defend({ maxAttacks: 6 });
    }
    const result = { ok: true, survival, defence, threatCount: threats.threats.length };
    if (survival.actions.length || defence) {
      this.lastAction = survival.actions.length ? survival.actions[survival.actions.length - 1].action : 'combat';
      this.lastActionAt = Date.now();
    }
    return result;
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
        break;
      }
      case 'MINE_ORE':
        result = await this.mining.mineOresDeep({ radius: 48, limit: 6 });
        result.quantity = result.mined;
        result.verified = result.mined > 0;
        // No ore in reach is not a failure: keep the claim and search again
        // next tick instead of burning an attempt and failing the objective.
        if (result.mined === 0) { result.ok = true; result.pending = true; }
        break;
      case 'MINE_BLOCK':
        result = await this.mining.mineBlocks({ block: task.params?.block || 'stone', radius: 24, limit: 8 });
        result.quantity = result.mined;
        result.verified = result.mined > 0;
        break;
      case 'FARM_CROP':
        result = await this.farming.harvestAll({ limit: 16, crop: task.params?.crop || null });
        result.quantity = result.harvested;
        result.verified = result.harvested > 0;
        break;
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
        const item = task.params?.item || 'dirt';
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
        const bed = await this.sleep.ensureBed();
        result = { ok: Boolean(bed.ok), ...bed, verified: Boolean(bed.ok) };
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
    const assignment = coordinator ? coordinator.getAssignment(this.bot.name) : null;
    if (!assignment || !this.taskBoard) return { ok: true, idle: true };
    const task = this.taskBoard.getTask(assignment.taskId);
    if (!task) return { ok: false, error: 'assigned task missing' };
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') return { ok: true, idle: true };
    if (!task.claimedBy) {
      const claim = this.taskBoard.claim(task.id, this.bot.name);
      if (!claim.ok) return { ok: false, error: claim.error };
    }
    if (task.status !== 'ACTIVE') {
      const started = this.taskBoard.start(task.id, this.bot.name);
      if (!started.ok) return { ok: false, error: started.error };
    }
    const result = await this.performTask(task, { builder, bots, recipient });
    let verified = result.verified === true;
    let progress = null;
    if (verified && task.units && task.units.target > 1) {
      const produced = Math.max(0, Number(result.quantity) || 0);
      progress = Math.min(task.units.target, (task.units.current || 0) + produced);
      this.taskBoard.updateProgress(task.id, { current: progress });
      if (progress < task.units.target) verified = false;
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
