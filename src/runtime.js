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
const { isThrottleError, isJoinStallError, throttleCooldown, reconnectDelay, staggerDelay, sleep } = require('./bot/connection');
const { resolveServerVersion } = require('./bot/serverVersion');
const { connectionStatus } = require('./bot/status');

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
  constructor({ simulate = config.sim.enabled, connect = true, dashboard = true, port = config.dashboard.port, host = config.dashboard.host, logger = null, resolveVersion = resolveServerVersion } = {}) {
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
    this.retryPausedBots = new Map();
    this.supervisorTicks = 0;
    this.supervisorBusy = false;
    this.serverVersion = null;
    this.serverVersionSource = null;
    this.serverVersionError = null;
    this.versionProbe = null;
    this.resolveVersion = resolveVersion;
    this.joinLock = Promise.resolve();
    this.joinCooldownUntil = 0;
    this.nextJoinAt = 0;
    this.throttleStrikes = 0;
    this.lastThrottleAt = 0;
    this.lastJoinStartedAt = 0;
    this.shutdownController = new AbortController();
  }

  get allBotsReady() {
    if (this.bots.size !== BOT_NAMES.length) return false;
    // Same verdict the dashboard renders: a fresh, spawned, authenticated
    // session. No separate flag arithmetic that can disagree with the UI.
    return [...this.bots.values()].every((bot) => connectionStatus(bot).online);
  }

  /**
   * The initial gate requires every bot. After the whole team has been ready
   * once, the remaining healthy bots keep operating if one drops out.
   */
  get autonomyAllowed() {
    if (this.allBotsReady) return true;
    if (!this.autonomyArmed) return false;
    return [...this.bots.values()].some((bot) => connectionStatus(bot).online);
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
      this.connectLoop = this._connectAll().catch((err) => {
      if (!this.shutdownRequested) this.logger.error(`connection supervisor failed: ${err.message}`);
    });
    }
    this.timer = setInterval(() => this._tick().catch((err) => this.logger.error(`autonomy tick failed: ${err.message}`)), config.autonomy.tickMs);
    return { ok: true, mode: this.mode, dashboard: dashboardInfo, autonomyAllowed: this.autonomyAllowed };
  }

  /**
   * Resolve (and cache) the server version before opening any login sockets.
   * Aternos answers status pings with protocol -1 while the instance is asleep,
   * so wait for a real version instead of letting all five bots fail in turn.
   */
  async _ensureServerVersion() {
    if (this.serverVersion) return true;
    if (this.versionProbe) return this.versionProbe;
    this.versionProbe = (async () => {
      let attempt = 0;
      while (!this.shutdownRequested) {
        attempt++;
        const result = await this.resolveVersion({
          host: config.server.host,
          port: config.server.port,
          version: config.server.version,
          timeoutMs: config.server.versionProbeTimeoutMs
        });
        if (result.ok) {
          this.serverVersion = result.version;
          this.serverVersionSource = result.source;
          this.serverVersionError = null;
          delete this.connectionErrors.server;
          const sourceLabel = result.source === 'protocol' ? 'protocol map' : result.source === 'status-name' ? 'status name' : 'configured';
          this.logger.info(`server version: ${result.version} (protocol ${result.protocol}, ${sourceLabel})`);
          for (const bot of this.bots.values()) {
            if (typeof bot.setVersion === 'function') bot.setVersion(result.version);
          }
          return true;
        }
        const code = result.code || 'VERSION_PROBE_FAILED';
        this.serverVersionError = `${code}: ${result.error}`;
        this.connectionErrors.server = this.serverVersionError;
        const delay = code === 'SERVER_NOT_READY' || code === 'SERVER_UNREACHABLE'
          ? config.server.serverStartDelayMs
          : config.server.versionRetryDelayMs;
        this.logger.warn(`server not ready for bots (attempt ${attempt}, ${code}): ${result.error}; probing again in ${(delay / 1000).toFixed(0)}s`);
        await sleep(delay, this.shutdownController.signal);
      }
      return false;
    })().finally(() => { this.versionProbe = null; });
    return this.versionProbe;
  }

  async _connectAll() {
    if (!this.simulate && !(await this._ensureServerVersion())) return;
    const names = BOT_NAMES.filter((name) => this.bots.has(name));
    for (let index = 0; index < names.length; index++) {
      if (this.shutdownRequested) return;
      const name = names[index];
      this._startConnection(this.bots.get(name));
      if (index < names.length - 1) {
        await sleep(staggerDelay({
          staggerMs: config.server.connectStaggerMs,
          jitterMs: config.server.connectJitterMs
        }), this.shutdownController.signal);
      }
    }
  }

  /**
   * Own one connection task per bot. Registering the initial task in the same
   * map as recovery prevents the supervisor from opening a second socket while
   * a bot is already retrying.
   */
  _startConnection(bot) {
    if (bot.retryPaused) return Promise.resolve({ ok: false, paused: true, error: bot.lastError || 'automatic retries paused' });
    const existing = this.reconnectTasks.get(bot.name);
    if (existing) return existing;
    const task = this._connectWithRetry(bot)
      .catch((err) => {
        this.connectionErrors[bot.name] = err.message;
        this.logger.error(`[${bot.name}] connection failed: ${err.message}`);
        return { ok: false, error: err.message };
      })
      .finally(() => {
        if (this.reconnectTasks.get(bot.name) === task) this.reconnectTasks.delete(bot.name);
      });
    this.reconnectTasks.set(bot.name, task);
    return task;
  }

  /**
   * Aternos throttles multiple logins from one IP. Serialize attempts and keep
   * a fleet-wide cooldown after a throttle instead of firing all five sockets
   * into the limiter at once.
   */
  async _acquireJoinSlot() {
    let release;
    const previous = this.joinLock;
    this.joinLock = new Promise((resolve) => { release = resolve; });
    await previous;
    while (!this.shutdownRequested) {
      const now = Date.now();
      const target = Math.max(this.joinCooldownUntil, this.nextJoinAt);
      if (now >= target) break;
      const wait = Math.max(50, target - now);
      const reason = this.joinCooldownUntil >= this.nextJoinAt ? 'server throttle cooldown' : 'per-IP join spacing';
      this.logger.info(`join queue: waiting ${(wait / 1000).toFixed(1)}s for ${reason}`);
      await sleep(wait, this.shutdownController.signal);
    }
    // Hold the slot until the caller finishes connecting, then enforce the next
    // start time. A fixed inter-start interval is what keeps the server's
    // per-IP connection throttle from rejecting the fleet.
    this.lastJoinStartedAt = Date.now();
    this.nextJoinAt = this.lastJoinStartedAt + staggerDelay({
      staggerMs: config.server.joinIntervalMs,
      jitterMs: config.server.joinJitterMs
    });
    return release;
  }

  /**
   * A throttle or a socket that never reaches spawn means the server's per-IP
   * limiter is still active. Pause every join for an exponentially longer
   * window; hammering it extends the block and can drop the bots already in.
   */
  _registerJoinBackoff(kind, error) {
    this.throttleStrikes = Math.min(10, (this.throttleStrikes || 0) + 1);
    this.lastThrottleAt = Date.now();
    const wait = throttleCooldown({
      strikes: this.throttleStrikes,
      throttleDelayMs: config.server.reconnect.throttleDelayMs,
      maxDelayMs: config.server.reconnect.throttleMaxDelayMs
    });
    this.joinCooldownUntil = Math.max(this.joinCooldownUntil, Date.now() + wait);
    this.logger.warn(`join queue: ${kind} (${error}); all joins paused until ${new Date(this.joinCooldownUntil).toISOString()} (strike ${this.throttleStrikes}, ${(wait / 1000).toFixed(0)}s)`);
  }

  async _connectWithRetry(bot) {
    let attempt = 0;
    while (!this.shutdownRequested && !bot.ready) {
      if (this.intentionalDisconnects.has(bot.name)) {
        return { ok: false, error: 'disconnected by operator', stopped: true };
      }
      if (bot.retryPaused || this.retryPausedBots.has(bot.name)) {
        const reason = this.retryPausedBots.get(bot.name) || bot.lastError || 'automatic retries paused';
        this.connectionErrors[bot.name] = reason;
        return { ok: false, error: reason, paused: true };
      }
      attempt++;
      // Aternos throttles an immediate rejoin after a real session ends. Wait
      // behind the hold-down *before* taking the join slot, so the server never
      // sees the rejected attempt and a waiting bot does not block the queue.
      const rejoinWait = Math.max(0, Number(bot.lastSessionEndedAt || 0) + config.server.rejoinDelayMs - Date.now());
      if (rejoinWait > 0) {
        this.logger.info(`[${bot.name}] rejoin hold-down: waiting ${(rejoinWait / 1000).toFixed(1)}s after the previous session ended`);
        await sleep(rejoinWait, this.shutdownController.signal);
      }
      if (this.shutdownRequested) return { ok: false, error: 'shutting down' };
      const release = await this._acquireJoinSlot();
      if (this.shutdownRequested) { release(); return { ok: false, error: 'shutting down' }; }
      const startedAt = Date.now();
      this.logger.info(`[${bot.name}] connect attempt ${attempt}: ${config.server.host}:${config.server.port} version=${bot.version} auth=${bot.passwordRequired ? 'password' : 'none'} timeout=${config.server.connectTimeoutMs}ms`);
      let result;
      try {
        result = await bot.connect();
      } catch (err) {
        result = { ok: false, error: err.message, code: err.code };
      } finally {
        release();
      }
      const elapsed = Date.now() - startedAt;
      if (!result.ok && isThrottleError(result.error)) {
        this._registerJoinBackoff('throttled', result.error);
      } else if (!result.ok && isJoinStallError(result.error)) {
        this._registerJoinBackoff('join stalled', result.error);
      }
      if (this.intentionalDisconnects.has(bot.name)) {
        return { ok: false, error: 'disconnected by operator', stopped: true };
      }
      if (bot.retryPaused) {
        const pauseReason = bot.lastError || `${bot.kickKind || 'moderation'} kick`;
        this.retryPausedBots.set(bot.name, pauseReason);
        this.connectionErrors[bot.name] = pauseReason;
        this.logger.error(`[${bot.name}] retries paused (${bot.kickKind || 'moderation'}); explicit reconnect required`);
        return { ok: false, error: pauseReason, paused: true, kickKind: bot.kickKind };
      }
      // A rejected password will stay rejected. Retrying it on a timer can
      // trip AuthMe's lockout, so pause until an operator fixes the credential
      // and explicitly reconnects. Transient auth timeouts recover on retry.
      if (!result.ok && result.code === 'AUTH_FAILED' && /password|login|register|auth/i.test(String(result.error || ''))) {
        const pauseReason = result.error || 'password authentication failed';
        bot.retryPaused = true;
        this.retryPausedBots.set(bot.name, pauseReason);
        this.connectionErrors[bot.name] = pauseReason;
        this.logger.error(`[${bot.name}] authentication failed; automatic retries paused: ${pauseReason}`);
        return { ok: false, error: pauseReason, paused: true, code: 'AUTH_FAILED' };
      }
      if (result.ok && bot.ready) {
        delete this.connectionErrors[bot.name];
        this.retryPausedBots.delete(bot.name);
        // A stable session proves the limiter has cleared. Decay the strike
        // counter only after a quiet period, so a success immediately followed
        // by another throttle does not reset the exponential backoff.
        if (this.lastThrottleAt && Date.now() - this.lastThrottleAt > 10 * 60 * 1000) {
          this.throttleStrikes = Math.max(0, this.throttleStrikes - 1);
        }
        this.logger.info(`[${bot.name}] ready (attempt ${attempt}, ${elapsed}ms)`);
        return result;
      }
      if (result.ok && !bot.ready) {
        result.ok = false;
        result.error = bot.lastError || 'connection closed before the bot became ready';
      }
      this.connectionErrors[bot.name] = result.error || 'connection failed';
      const max = config.server.reconnect.maxAttempts;
      if (max > 0 && attempt >= max) throw new Error(result.error || 'max reconnect attempts reached');
      let delay = reconnectDelay({
        attempt,
        error: result.error,
        baseDelayMs: config.server.reconnect.baseDelayMs,
        maxDelayMs: config.server.reconnect.maxDelayMs,
        throttleDelayMs: config.server.reconnect.throttleDelayMs,
        jitterMs: config.server.reconnect.jitterMs
      });
      const stalled = isJoinStallError(result.error);
      if (stalled) delay = Math.max(delay, config.server.reconnect.throttleDelayMs);
      // Never let a per-bot retry start sooner than the next fleet join slot.
      delay = Math.max(delay, config.server.joinIntervalMs, this.nextJoinAt - Date.now());
      const reason = isThrottleError(result.error) ? 'server join throttle' : stalled ? 'join stalled before spawn' : 'connection failed';
      this.logger.warn(`[${bot.name}] ${reason} after ${elapsed}ms: ${result.error}; retrying in ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay, this.shutdownController.signal);
    }
    return { ok: bot.ready };
  }

  /**
   * Keep the coordinator's view of the fleet aligned with the live adapters on
   * every tick, including while the autonomy gate is closed or the runtime is
   * paused. Without this, the Team page can keep showing a kicked bot as online
   * because coordinator state is only refreshed inside the autonomous path.
   */
  _syncBots() {
    for (const bot of this.bots.values()) {
      try {
        if (typeof bot._syncInventory === 'function') bot._syncInventory();
        const fallback = {
          name: bot.name,
          connected: bot.connected !== false,
          spawned: bot.spawned !== false,
          authenticated: bot.authenticated !== false,
          ready: Boolean(bot.ready),
          health: bot.health,
          food: bot.food,
          position: bot.position,
          inventory: bot.inventory || {}
        };
        const summary = { ...fallback, ...(typeof bot.summary === 'function' ? bot.summary() : {}) };
        const status = connectionStatus(bot);
        this.coordinator.updateBot(bot.name, { ...summary, online: status.online, status: status.status, statusLabel: status.statusLabel });
        this.ledger.updateBotInventory(bot.name, summary.inventory);
        if (!status.online) {
          if (!this.disconnectedNotified.has(bot.name)) {
            this.coordinator.setDisconnected(bot.name, status.statusDetail || 'connection lost');
            this.disconnectedNotified.add(bot.name);
          }
        } else {
          this.disconnectedNotified.delete(bot.name);
        }
      } catch (err) {
        this.logger.warn(`[${bot.name}] state sync failed: ${err.message}`);
        if (!this.disconnectedNotified.has(bot.name)) {
          this.coordinator.setDisconnected(bot.name, `state sync failed: ${err.message}`);
          this.disconnectedNotified.add(bot.name);
        }
      }
    }
  }

  async _tick() {
    if (!this.running || this.ticking) return;
    if (this.allBotsReady) this.autonomyArmed = true;
    this._syncBots();
    if (this.paused) return;
    // Connection supervision must run even while the autonomy gate is closed;
    // otherwise a bot that fails after the initial retry budget is never restored.
    if (!this.simulate && this.shouldConnect) {
      this.supervisorTicks++;
      if (this.supervisorTicks % 2 === 0 && !this.supervisorBusy) {
        this.supervisorBusy = true;
        this._recoverDisconnected()
          .catch((err) => this.logger.warn(`reconnect supervisor: ${err.message}`))
          .finally(() => { this.supervisorBusy = false; });
      }
    }
    if (!this.autonomyAllowed) {
      // A ready bot must still eat, flee or defend itself while the team waits
      // for the remaining members; otherwise it stands still and is slain by
      // the first zombie that finds it.
      await this._safetyOnlyTick();
      return;
    }
    this.ticking = true;
    this.ticks++;
    try {
      for (const bot of this.bots.values()) {
        if (bot.ready && bot.connected !== false && bot.health <= 0) {
          const actions = this.actions && typeof this.actions.get === 'function' ? this.actions.get(bot.name) : null;
          if (actions && actions.combat) actions.combat.onDeath('runtime observed death');
        }
      }
      try {
        this.coordinator.tick();
      } catch (err) {
        this.logger.error(`coordinator tick failed: ${err.message}`);
      }
      for (const actions of this.actions.list()) {
        const bot = actions.bot;
        if (!bot.connected || !bot.spawned || bot.health <= 0) continue;
        try {
          await actions.safetyTick();
          const assignment = this.coordinator.getAssignment(bot.name);
          if (assignment) {
            await actions.step({ coordinator: this.coordinator, bots: this.bots });
          } else if (this.ticks % 20 === 0) {
            await this._idleWork(actions);
          }
        } catch (err) {
          // One controller failure must not stop the other four bots.
          this.logger.warn(`[${bot.name}] action tick failed: ${err.message}`);
        }
      }
      try {
        if (this.ticks % 5 === 0) this.combatTeam.assignRoles();
      } catch (err) {
        this.logger.warn(`combat role assignment failed: ${err.message}`);
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

  async _safetyOnlyTick() {
    if (!this.actions) return;
    for (const actions of this.actions.list()) {
      const bot = actions.bot;
      if (!bot.ready || !bot.connected || !bot.spawned || bot.health <= 0) continue;
      try {
        await actions.safetyTick();
      } catch (err) {
        this.logger.warn(`[${bot.name}] pre-join safety tick failed: ${err.message}`);
      }
    }
  }

  /**
   * Reconnect one bot at a time in the background. A deliberate dashboard
   * disconnect is respected until an explicit reconnect clears that intent.
   */
  async _recoverDisconnected() {
    let started = 0;
    for (const name of BOT_NAMES) {
      const bot = this.bots.get(name);
      if (!bot || this.intentionalDisconnects.has(name) || this.retryPausedBots.has(name) || this.reconnectTasks.has(name)) continue;
      const status = connectionStatus(bot);
      // A silently dead socket still has connected=true. Drop it explicitly so
      // the supervisor opens a fresh one instead of trusting a zombie flag.
      if (status.status === 'stale') {
        this.logger.warn(`[${name}] connection is stale (${status.statusDetail}); forcing a reconnect`);
        try { await bot.disconnect('no packets from server'); } catch (_) { /* already gone */ }
      } else if (bot.connected !== false) {
        continue;
      }
      if (started > 0) {
        await sleep(staggerDelay({
          staggerMs: config.server.connectStaggerMs,
          jitterMs: config.server.connectJitterMs
        }), this.shutdownController.signal);
      }
      if (this.shutdownRequested) return;
      const task = this._startConnection(bot);
      task.then((result) => {
        if (result && result.ok) this.logger.info(`[${name}] reconnect supervisor restored the bot`);
        return result;
      }).catch(() => null);
      started++;
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
    if (!this.simulate && !(await this._ensureServerVersion())) {
      return { ok: false, error: this.serverVersionError || 'server version unavailable', bot: this.botState(name) };
    }
    if (this.reconnectTasks.has(name)) {
      return { ok: true, queued: true, already: true, bot: this.botState(name) };
    }
    this.intentionalDisconnects.delete(name);
    this.retryPausedBots.delete(name);
    bot.shuttingDown = false;
    if (bot.retryPaused) { bot.retryPaused = false; bot.kickKind = null; }

    // Simulated adapters have no socket. Flip their flags so the dashboard
    // control still works in the deterministic demo.
    if (typeof bot.connect !== 'function') {
      if (typeof bot.disconnect === 'function') await bot.disconnect('dashboard reconnect');
      bot.connected = true;
      bot.spawned = true;
      bot.authenticated = true;
      // BaseAdapter.disconnect() also stops the simulated ticker; resume it or
      // the preview's world clock would freeze after a dashboard reconnect.
      if (typeof bot.startTicking === 'function' && !bot._tickHandle) bot.startTicking();
      delete this.connectionErrors[name];
      return { ok: true, bot: this.botState(name) };
    }

    try {
      if (typeof bot.disconnect === 'function') await bot.disconnect('dashboard reconnect');
      else { bot.connected = false; bot.spawned = false; bot.authenticated = false; }
    } catch (err) {
      bot.connected = false;
      bot.spawned = false;
      bot.authenticated = false;
      this.connectionErrors[name] = err.message;
    }
    delete this.connectionErrors[name];
    // Queue the reconnect instead of blocking the HTTP request for the
    // Aternos hold-down. _startConnection owns the hold-down, join queue and
    // retries, so the dashboard response returns immediately with the truth.
    this._startConnection(bot);
    const retryAt = Math.max(Date.now(), Number(bot.lastSessionEndedAt || 0) + config.server.rejoinDelayMs);
    this.logger.info(`[${name}] reconnect queued from dashboard (first attempt after ${new Date(retryAt).toISOString()})`);
    return { ok: true, queued: true, retryAt, bot: this.botState(name) };
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
    const status = connectionStatus(bot);
    return {
      name: bot.name,
      connected: Boolean(bot.connected),
      spawned: Boolean(bot.spawned),
      authenticated: status.online || bot.authenticated !== false,
      ready: Boolean(bot.ready),
      online: status.online,
      status: status.status,
      statusLabel: status.statusLabel,
      statusDetail: status.statusDetail,
      lastEventAt: status.lastEventAt,
      lastEventAgeMs: status.lastEventAgeMs,
      kickKind: bot.kickKind || null,
      retryPaused: Boolean(bot.retryPaused || this.retryPausedBots.has(name)),
      error: this.connectionErrors[name] || this.connectionErrors.server || bot.lastError || null
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
      serverVersion: this.serverVersion,
      serverVersionError: this.serverVersionError,
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
    if (this.shutdownController) this.shutdownController.abort();
    // Stop any in-flight connect() from opening a new socket during the
    // dashboard/SSE teardown that follows.
    for (const bot of this.bots.values()) bot.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { if (this.coordinator) this.coordinator.disable(); } catch (_) { /* ignore */ }
    if (this.dashboard) {
      try { await this.dashboard.stop(); } catch (_) { /* server already closed */ }
    }
    const results = [];
    for (const bot of this.bots.values()) {
      bot.shuttingDown = true;
      try {
        // Simulated adapters have no socket, but they own a ticking interval.
        // Disconnect every adapter, connected or not, so the final state is honest.
        if (typeof bot.stopTicking === 'function') bot.stopTicking();
        if (typeof bot.disconnect === 'function') results.push({ bot: bot.name, ...(await bot.disconnect(reason)) });
      } catch (err) {
        results.push({ bot: bot.name, ok: false, error: err.message });
      }
    }
    this.reconnectTasks.clear();
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
