'use strict';

const { config, BOT_NAMES } = require('./config');
const { Logger } = require('./logger');
const { TaskBoard } = require('./team/taskBoard');
const { TeamMemory } = require('./team/teamMemory');
const { ResourceLedger } = require('./team/resourceLedger');
const { TeamComms } = require('./team/comms');
const { TeamCoordinator } = require('./team/teamCoordinator');
const { ExcavationManager } = require('./excavate/manager');
const { ConstructionManager } = require('./construction/manager');
const { SchematicLibrary } = require('./schematics/library');
const { ActionRegistry } = require('./actions');
const { TeamCombatCoordinator } = require('./combat/team');
const { createCommandHandler } = require('./commands');
const { createDashboard } = require('./dashboard/server');
const { MockWorld } = require('./bot/mockWorld');
const { MockBot } = require('./bot/mockBot');
const { RealBot } = require('./bot/realBot');

const STARTER_KIT = {
  bread: 32, cooked_beef: 16, stone_pickaxe: 2, iron_pickaxe: 1, iron_axe: 1, iron_sword: 1,
  shield: 1, torch: 64, oak_log: 96, cobblestone: 192, oak_planks: 96, water_bucket: 2,
  coal: 32, stick: 48, wheat_seeds: 24, oak_sapling: 12, white_bed: 5, iron_ingot: 16,
  diamond_pickaxe: 1, diamond_sword: 1, diamond_chestplate: 1, diamond_helmet: 1,
  diamond_leggings: 1, diamond_boots: 1, cooked_porkchop: 16, golden_apple: 3
};

/**
 * Team runtime: owns the shared coordination state, the bot adapters, the
 * action controllers, the command handler and the dashboard. Autonomy cannot
 * start until every configured bot has connected, authenticated and spawned.
 */
class TeamRuntime {
  constructor({ simulate = config.sim.enabled, connect = true, dashboard = true, port = config.dashboard.port, host = config.dashboard.host, logger = null } = {}) {
    this.simulate = Boolean(simulate);
    this.shouldConnect = connect;
    this.wantDashboard = dashboard;
    this.port = port;
    this.host = host;
    this.logger = logger || new Logger({ level: config.logging.level });
    this.mode = this.simulate ? 'simulation' : 'live';
    this.now = () => Date.now();
    this.board = new TaskBoard({ claimTtlMs: config.team.claimTtlMs, lockTtlMs: config.team.lockTtlMs, now: this.now });
    this.memory = new TeamMemory({ maxObservations: config.team.maxObservations, defaultTtlMs: config.team.observationTtlMs, now: this.now });
    this.ledger = new ResourceLedger({ reserves: config.reserves, now: this.now });
    this.comms = new TeamComms();
    const existingCommsRecent = typeof this.comms.recent === 'function';
    if (!existingCommsRecent && Array.isArray(this.comms.history)) this.comms.recent = (limit = 20) => this.comms.history.slice(-limit);
    this.coordinator = new TeamCoordinator({
      botNames: BOT_NAMES, memory: this.memory, board: this.board, ledger: this.ledger, comms: this.comms, logger: this.logger, now: this.now
    });
    this.excavation = new ExcavationManager({ coordinator: this.coordinator, logger: this.logger, now: this.now });
    this.construction = null;
    this.constructionBusy = false;
    this.library = new SchematicLibrary();
    this.world = null;
    this.bots = new Map();
    this.actions = null;
    this.builders = new Map();
    this.imported = new Map();
    this.commands = null;
    this.dashboard = null;
    this.home = { x: 0, y: 64, z: 0 };
    this.paused = false;
    this.running = false;
    this.ticking = false;
    this.ticks = 0;
    this.startedAt = null;
    this.timer = null;
    this.connectLoop = null;
    this.connectionErrors = {};
    this.shutdownRequested = false;
    this.idleCounter = 0;
    this.autonomyArmed = false;
    this.disconnectedNotified = new Set();
    this.reconnectTasks = new Map();
    this.intentionalDisconnects = new Set();
  }

  get allBotsReady() {
    if (this.bots.size !== BOT_NAMES.length) return false;
    return [...this.bots.values()].every((bot) => bot.connected && bot.spawned && bot.authenticated !== false);
  }

  /**
   * The initial gate requires every bot. After the whole team has been ready
   * once, the remaining healthy bots keep operating if one drops out.
   */
  get autonomyAllowed() {
    if (this.allBotsReady) return true;
    if (!this.autonomyArmed) return false;
    return [...this.bots.values()].some((bot) => bot.connected && bot.spawned && bot.authenticated !== false && bot.health > 0);
  }

  async init() {
    if (this.simulate) {
      this.world = new MockWorld({ seed: config.sim.seed });
      for (let i = 0; i < BOT_NAMES.length; i++) {
        const name = BOT_NAMES[i];
        const surface = this.world.surfaceY(-2 + i, 2);
        const bot = new MockBot({ name, world: this.world, inventory: { ...STARTER_KIT }, position: { x: -2 + i, y: surface + 1, z: 2 }, logger: this.logger });
        this.bots.set(name, bot);
      }
      this.home = { x: 0, y: this.world.surfaceY(0, 0) + 1, z: 0 };
    } else {
      for (const name of BOT_NAMES) {
        const bot = new RealBot({ name, logger: this.logger });
        this.bots.set(name, bot);
      }
      this.home = { x: 0, y: 64, z: 0 };
    }
    this.excavation.attachBot && [...this.bots.values()].forEach((bot) => this.excavation.attachBot(bot.name, bot));
    this.actions = new ActionRegistry({
      memory: this.memory, taskBoard: this.board, ledger: this.ledger, team: this.coordinator,
      home: this.home, library: this.library, logger: this.logger, builders: this.builders,
      excavationManager: this.excavation, world: this.world
    });
    let index = 0;
    for (const bot of this.bots.values()) {
      const actions = this.actions.register(bot, index++);
      actions.updateHome(this.home);
      this.ledger.updateBotInventory(bot.name, bot.inventory);
    }
    this.memory.setHome({ position: this.home, setAt: Date.now() });
    this.coordinator.enable();
    this.combatTeam = new TeamCombatCoordinator({
      controllers: this.actions.list().map((actions) => actions.combat),
      comms: this.comms, memory: this.memory
    });
    for (const actions of this.actions.list()) actions.combat.attachTeam(this.combatTeam);
    this.combatTeam.home = this.home;
    this.combatTeam.assignRoles({ force: true });
    this.construction = new ConstructionManager({
      library: this.library, bots: [...this.bots.values()], actions: this.actions,
      world: this.world, taskBoard: this.board, ledger: this.ledger, memory: this.memory,
      coordinator: this.coordinator, builders: this.builders, logger: this.logger,
      home: this.home, maxProjects: config.construction.maxProjects
    });
    const services = {
      mode: this.mode, logger: this.logger, config,
      coordinator: this.coordinator, leadership: this.coordinator.leadership, memory: this.memory,
      taskBoard: this.board, ledger: this.ledger, comms: this.comms, excavation: this.excavation,
      library: this.library, bots: this.bots, actions: this.actions, builders: this.builders,
      construction: this.construction, combatTeam: this.combatTeam, imported: this.imported, world: this.world, runtime: this
    };
    this.services = services;
    this.commands = createCommandHandler(services);
    services.commands = this.commands;
    this.dashboard = this.wantDashboard ? createDashboard(services, { port: this.port, host: this.host }) : null;
    return this;
  }

  setHome(position) {
    this.home = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    if (this.world && typeof this.world.getBlock === 'function') {
      const ground = this.bots.values().next().value;
      if (ground && typeof ground.surfaceAt === 'function') this.home.y = ground.surfaceAt(this.home.x, this.home.z) + 1;
    }
    this.memory.setHome({ position: this.home, setAt: Date.now() });
    if (this.construction) this.construction.home = this.home;
    for (const actions of this.actions ? this.actions.list() : []) actions.updateHome(this.home);
    return { ok: true, home: this.home };
  }

  async start() {
    if (this.running) return { ok: true, already: true };
    this.running = true;
    this.startedAt = Date.now();
    let dashboardInfo = null;
    if (this.dashboard) {
      dashboardInfo = await this.dashboard.start();
      this.logger.info(`dashboard listening on http://${dashboardInfo.host}:${dashboardInfo.port}`);
    }
    if (!this.simulate && this.shouldConnect) {
      this.connectLoop = this._connectAll().catch((err) => this.logger.error(`connection supervisor failed: ${err.message}`));
    }
    this.timer = setInterval(() => this._tick().catch((err) => this.logger.error(`autonomy tick failed: ${err.message}`)), config.autonomy.tickMs);
    return { ok: true, mode: this.mode, dashboard: dashboardInfo, autonomyAllowed: this.autonomyAllowed };
  }

  async _connectAll() {
    for (const name of BOT_NAMES) {
      if (this.shutdownRequested) return;
      const bot = this.bots.get(name);
      this._connectWithRetry(bot).catch((err) => {
        this.connectionErrors[name] = err.message;
        this.logger.error(`[${name}] connection failed: ${err.message}`);
      });
    }
  }

  async _connectWithRetry(bot) {
    let attempt = 0;
    while (!this.shutdownRequested && !bot.ready) {
      attempt++;
      const result = await bot.connect();
      if (result.ok) {
        delete this.connectionErrors[bot.name];
        this.logger.info(`[${bot.name}] ready (attempt ${attempt})`);
        return result;
      }
      this.connectionErrors[bot.name] = result.error || 'connection failed';
      const max = config.server.reconnect.maxAttempts;
      if (max > 0 && attempt >= max) throw new Error(result.error || 'max reconnect attempts reached');
      const delay = Math.min(config.server.reconnect.maxDelayMs, config.server.reconnect.baseDelayMs * Math.pow(1.5, attempt - 1));
      this.logger.warn(`[${bot.name}] connect attempt ${attempt} failed: ${result.error}; retrying in ${Math.round(delay / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return { ok: bot.ready };
  }

  async _tick() {
    if (!this.running || this.paused || this.ticking) return;
    if (this.allBotsReady) this.autonomyArmed = true;
    if (!this.autonomyAllowed) return;
    this.ticking = true;
    this.ticks++;
    try {
      for (const bot of this.bots.values()) {
        if (typeof bot._syncInventory === 'function') bot._syncInventory();
        const summary = typeof bot.summary === 'function' ? bot.summary() : { name: bot.name };
        this.coordinator.updateBot(bot.name, summary);
        this.ledger.updateBotInventory(bot.name, bot.inventory);
        if (bot.ready && bot.connected !== false && bot.health <= 0) {
          const actions = this.actions && typeof this.actions.get === 'function' ? this.actions.get(bot.name) : null;
          if (actions && actions.combat) actions.combat.onDeath('runtime observed death');
        }
        if (!bot.ready || bot.connected === false) {
          if (!this.disconnectedNotified.has(bot.name)) {
            this.coordinator.setDisconnected(bot.name, 'connection lost');
            this.disconnectedNotified.add(bot.name);
          }
        } else {
          this.disconnectedNotified.delete(bot.name);
        }
      }
      this.coordinator.tick();
      if (!this.simulate && this.shouldConnect && this.ticks % 40 === 0) {
        this._recoverDisconnected().catch((err) => this.logger.warn(`reconnect supervisor: ${err.message}`));
      }
      for (const actions of this.actions.list()) {
        const bot = actions.bot;
        if (!bot.connected || !bot.spawned || bot.health <= 0) continue;
        await actions.safetyTick();
        if (this.ticks % 5 === 0) this.combatTeam.assignRoles();
        const assignment = this.coordinator.getAssignment(bot.name);
        if (assignment) {
          await actions.step({ coordinator: this.coordinator, bots: this.bots });
        } else if (this.ticks % 20 === 0) {
          await this._idleWork(actions);
        }
      }
      if (this.combatTeam && this.ticks % 8 === 0) {
        await this.combatTeam.autoRescue().catch((err) => this.logger.warn(`team rescue: ${err.message}`));
      }
      if (this.combatTeam && this.ticks % 16 === 0) {
        await this.combatTeam.assistHealing().catch((err) => this.logger.warn(`team healing: ${err.message}`));
      }
      const home = this.memory.getHome();
      if (home && home.position) this.home = home.position;
      if (this.combatTeam) this.combatTeam.home = this.home;
      if (this.construction && config.construction.autoAdvance && !this.constructionBusy && this.ticks % Math.max(2, config.construction.tickEvery) === 0) {
        this.constructionBusy = true;
        this.construction.autoAdvance()
          .catch((err) => this.logger.warn(`construction auto-advance: ${err.message}`))
          .finally(() => { this.constructionBusy = false; });
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Reconnect one bot at a time in the background. A deliberate dashboard
   * disconnect is respected until an explicit reconnect clears that intent.
   */
  async _recoverDisconnected() {
    for (const name of BOT_NAMES) {
      const bot = this.bots.get(name);
      if (!bot || bot.connected !== false || this.intentionalDisconnects.has(name) || this.reconnectTasks.has(name)) continue;
      const task = this._connectWithRetry(bot)
        .then((result) => {
          if (result && result.ok) this.logger.info(`[${name}] reconnect supervisor restored the bot`);
          return result;
        })
        .catch((err) => {
          this.connectionErrors[name] = err.message;
          this.logger.error(`[${name}] reconnect supervisor failed: ${err.message}`);
        })
        .finally(() => this.reconnectTasks.delete(name));
      this.reconnectTasks.set(name, task);
    }
  }

  /** Deterministic idle work keeps the team productive between objectives. */
  async _idleWork(actions) {
    const index = actions.index;
    this.idleCounter++;
    if (index % 3 === 0) return actions.woodcutting.tick({ maxTrees: 1 });
    if (index % 3 === 1) return actions.farming.tick();
    return actions.exploration.explore({ steps: 1 });
  }

  async executeCommand(line, options = {}) {
    if (!this.commands) return { ok: false, error: 'runtime not initialised' };
    return this.commands.execute(line, options);
  }

  /** Reconnect one bot without disturbing the other four. */
  async reconnectBot(name) {
    const bot = this.bots.get(name);
    if (!bot) return { ok: false, error: 'unknown bot' };
    // Hold a supervisor slot for the whole manual reconnect so the background
    // recovery loop cannot open a second socket at the same time.
    this.reconnectTasks.set(name, Promise.resolve());
    try {
      if (typeof bot.disconnect === 'function') await bot.disconnect('dashboard reconnect');
      else { bot.connected = false; bot.spawned = false; bot.authenticated = false; }
      delete this.connectionErrors[name];
      if (typeof bot.connect === 'function') {
        const result = await bot.connect();
        if (!result.ok) this.connectionErrors[name] = result.error || 'connection failed';
      } else {
        bot.connected = true;
        bot.spawned = true;
        bot.authenticated = true;
      }
      this.logger.info(`[${name}] reconnect requested from dashboard`);
      return { ok: Boolean(bot.connected && bot.spawned && bot.authenticated !== false), bot: this.botState(name) };
    } catch (err) {
      this.connectionErrors[name] = err.message;
      return { ok: false, error: err.message, bot: this.botState(name) };
    } finally {
      this.intentionalDisconnects.delete(name);
      this.reconnectTasks.delete(name);
    }
  }

  /** Disconnect one bot; the rest of the team keeps running. */
  async disconnectBot(name, reason = 'dashboard') {
    const bot = this.bots.get(name);
    if (!bot) return { ok: false, error: 'unknown bot' };
    this.intentionalDisconnects.add(name);
    try {
      if (typeof bot.disconnect === 'function') await bot.disconnect(reason);
      else { bot.connected = false; bot.spawned = false; bot.authenticated = false; }
      this.logger.warn(`[${name}] disconnected from dashboard`);
      return { ok: true, bot: this.botState(name) };
    } catch (err) {
      return { ok: false, error: err.message, bot: this.botState(name) };
    }
  }

  botState(name) {
    const bot = this.bots.get(name);
    if (!bot) return null;
    return {
      name: bot.name,
      connected: Boolean(bot.connected),
      spawned: Boolean(bot.spawned),
      authenticated: bot.authenticated !== false,
      ready: Boolean(bot.ready),
      error: this.connectionErrors[name] || bot.lastError || null
    };
  }

  pause() {
    this.paused = true;
    return { ok: true, paused: true, tick: this.ticks };
  }

  resume() {
    if (!this.autonomyAllowed) return { ok: false, error: 'no ready bots; the five-bot connection gate is still closed' };
    this.paused = false;
    return { ok: true, paused: false, tick: this.ticks };
  }

  state() {
    return {
      mode: this.mode,
      running: this.running,
      paused: this.paused,
      autonomyAllowed: this.autonomyAllowed,
      allBotsReady: this.allBotsReady,
      autonomyArmed: this.autonomyArmed,
      ticks: this.ticks,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      home: this.home,
      bots: [...this.bots.values()].map((bot) => ({ name: bot.name, connected: bot.connected, spawned: bot.spawned, authenticated: bot.authenticated, ready: bot.ready })),
      connectionErrors: { ...this.connectionErrors },
      dashboard: this.dashboard ? this.dashboard.url : null,
      construction: this.construction ? { activeId: this.construction.activeId, projects: this.construction.projects.size } : null,
      combat: this.combatTeam ? this.combatTeam.status() : null,
      pausedAt: this.paused ? Date.now() : null
    };
  }

  async shutdown(reason = 'shutdown') {
    if (this.shutdownRequested) return { ok: true, already: true };
    this.shutdownRequested = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { if (this.coordinator) this.coordinator.disable(); } catch (_) { /* ignore */ }
    if (this.dashboard) {
      try { await this.dashboard.stop(); } catch (_) { /* server already closed */ }
    }
    const results = [];
    for (const bot of this.bots.values()) {
      try {
        if (typeof bot.disconnect === 'function' && bot.connected) results.push({ bot: bot.name, ...(await bot.disconnect(reason)) });
      } catch (err) {
        results.push({ bot: bot.name, ok: false, error: err.message });
      }
    }
    this.logger.info(`runtime stopped: ${reason}`);
    return { ok: true, reason, disconnected: results };
  }
}

async function createRuntime(options = {}) {
  const runtime = new TeamRuntime(options);
  await runtime.init();
  return runtime;
}

module.exports = { TeamRuntime, createRuntime, STARTER_KIT };
