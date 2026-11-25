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
const { PlayerRegistry } = require('./players/registry');
const { TeamCombatCoordinator } = require('./combat/team');
const { createCommandHandler } = require('./commands');
const { monitorEventLoopDelay } = require('perf_hooks');
const { createDashboard } = require('./dashboard/server');
const { MockWorld } = require('./bot/mockWorld');
const { MockBot } = require('./bot/mockBot');
const { RealBot } = require('./bot/realBot');
const { isThrottleError, isJoinStallError, reconnectDelay, staggerDelay, sleep } = require('./bot/connection');
const { JoinScheduler } = require('./bot/joinScheduler');
const { resolveServerVersion } = require('./bot/serverVersion');
const { connectionStatus } = require('./bot/status');

const STARTER_KIT = {
  bread: 32, cooked_beef: 16, stone_pickaxe: 2, iron_pickaxe: 1, iron_axe: 1, iron_sword: 1, iron_hoe: 1,
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
const PERMANENT_AUTH_CODES = new Set([
  'AUTH_REJECTED',
  'AUTH_NOT_REGISTERED',
  'AUTH_MISSING_CREDENTIAL',
  'AUTH_PROMPT_TIMEOUT'
]);

/**
 * A permanent authentication failure must not be retried by the supervisor.
 * A bare AUTH_FAILED is only permanent when it names a credential/auth cause;
 * transient confirmation timeouts keep their normal bounded retry.
 */
function shouldPauseAuthRetry(result) {
  if (!result || result.ok) return false;
  if (PERMANENT_AUTH_CODES.has(result.code)) return true;
  if (result.code !== 'AUTH_FAILED') return false;
  return /password|login|register|auth/i.test(String(result.error || ''));
}

class TeamRuntime {
  constructor({ simulate = config.sim.enabled, connect = true, dashboard = true, port = config.dashboard.port, host = config.dashboard.host, logger = null, resolveVersion = resolveServerVersion, now = Date.now, random = Math.random } = {}) {
    this.simulate = Boolean(simulate);
    this.shouldConnect = connect;
    this.wantDashboard = dashboard;
    this.port = port;
    this.host = host;
    this.logger = logger || new Logger({ level: config.logging.level });
    this.mode = this.simulate ? 'simulation' : 'live';
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.random = typeof random === 'function' ? random : Math.random;
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
    this.homeSource = 'provisional';
    this.homeAnchored = false;
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
    this.autonomyArmedAt = null;
    this.autonomyWarmupLogged = false;
    // A long controller action must not serialise the runtime tick. Each bot
    // owns at most one in-flight step, and a small fleet-wide cap keeps ten
    // mineflayer pathfinders from starving tick_end and keep-alive.
    this.botSteps = new Map();
    this.botSafety = new Map();
    this.safetyStages = new Map();
    this.commandLocks = new Set();
    // Commands for the same bot must queue, not race. The lock alone only
    // excluded autonomy; two dashboard clicks could still both call into the
    // same pathfinder/eat/drop sequence at once.
    this.commandWaiters = new Map();
    this.botStepCursor = 0;
    this.supervisorTimer = null;
    this.disconnectedNotified = new Set();
    this.reconnectTasks = new Map();
    this.intentionalDisconnects = new Set();
    this.retryPausedBots = new Map();
    this.supervisorTicks = 0;
    this.supervisorBusy = false;
    this.stateSyncTicks = 0;
    this._lastSlowSyncWarnAt = 0;
    this._phase = 'startup';
    this._lastPhase = 'startup';
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
    this.joinScheduler = new JoinScheduler({
      now: this.now,
      random: this.random,
      baseDelayMs: config.server.reconnect.throttleDelayMs,
      maxDelayMs: config.server.reconnect.throttleMaxDelayMs,
      jitterMs: Math.min(250, config.server.reconnect.jitterMs)
    });
    this.lastJoinStartedAt = 0;
    this.shutdownController = new AbortController();
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopDelay.enable();
    this._eventLoopWarnedMax = 0;
    this.retryMeta = new Map();
    this._eventLoopLastWarnAt = 0;
  }

  get allBotsReady() {
    if (this.bots.size !== BOT_NAMES.length) return false;
    // Same verdict the dashboard renders: spawned, authenticated and free of
    // pending manual auth. `online` alone is intentionally not enough — an
    // online-but-not-ready bot must not arm gameplay autonomy.
    return [...this.bots.values()].every((bot) => connectionStatus(bot).gameplayReady);
  }

  /**
   * The initial gate requires every bot. After the whole team has been ready
   * once, the remaining healthy bots keep operating if one drops out.
   */
  get autonomyAllowed() {
    // The final join is immediately followed by its chunk burst. Starting ten
    // pathfinders in that window froze the live loop for 26s and caused the
    // server to drop four bots. Simulators skip the wall-clock warm-up.
    if (!this.autonomySettled) return false;
    if (this.allBotsReady) return true;
    if (!this.autonomyArmed) return false;
    return [...this.bots.values()].some((bot) => connectionStatus(bot).gameplayReady);
  }

  get autonomyWarmupRemainingMs() {
    if (this.simulate || !this.autonomyArmedAt) return 0;
    return Math.max(0, config.autonomy.warmupMs - (this.now() - this.autonomyArmedAt));
  }

  get autonomySettled() {
    if (this.simulate || !config.autonomy.warmupMs) return true;
    return Boolean(this.autonomyArmedAt) && this.now() - this.autonomyArmedAt >= config.autonomy.warmupMs;
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
      // Home is the team's spawn point, not an arbitrary 0,0 datum: all bots
      // spawn at z=2, so the shared home is the centre of those spawn cells.
      const spawned = [...this.bots.values()];
      const spawn = spawned[0] && spawned[0].position ? spawned[0].position : { x: 0, y: this.world.surfaceY(0, 2) + 1, z: 2 };
      const cx = Math.round(spawned.reduce((sum, bot) => sum + (bot.position ? bot.position.x : 0), 0) / Math.max(1, spawned.length));
      const cz = Math.round(spawned.reduce((sum, bot) => sum + (bot.position ? bot.position.z : 0), 0) / Math.max(1, spawned.length));
      this.home = { x: cx, y: spawn.y, z: cz };
      this.homeSource = 'spawn';
      this.homeAnchored = true;
    } else {
      for (const name of BOT_NAMES) {
        const bot = new RealBot({
          name,
          logger: this.logger,
          authProfile: config.server.authProfile,
          credentials: config.server.credentials ? config.server.credentials[name] : null,
          authRegistrationEnabled: config.server.authRegistrationEnabled,
          authMaxAttempts: config.server.authMaxAttempts,
          authRetryDelayMs: config.server.authRetryDelayMs
        });
        this.bots.set(name, bot);
      }
      this.home = { x: 0, y: 64, z: 0 };
    }
    this.excavation.attachBot && [...this.bots.values()].forEach((bot) => this.excavation.attachBot(bot.name, bot));
    this.players = new PlayerRegistry();
    this.actions = new ActionRegistry({
      memory: this.memory, taskBoard: this.board, ledger: this.ledger, team: this.coordinator,
      home: this.home, library: this.library, logger: this.logger, builders: this.builders,
      excavationManager: this.excavation, world: this.world, players: this.players
    });
    let index = 0;
    for (const bot of this.bots.values()) {
      const actions = this.actions.register(bot, index++);
      actions.updateHome(this.home);
      this.ledger.updateBotInventory(bot.name, bot.inventory);
    }
    this.memory.setHome({ position: this.home, setAt: Date.now() });
    // Region excavation is outside the action task loop, so give it the same
    // home-chest overflow handler as the normal mining/chopping assignments.
    this.excavation.setInventoryHandler(async ({ botName, bot }) => {
      const actions = this.actions ? this.actions.get(botName) : null;
      if (!actions || !bot || !bot.position) return { ok: false, attempted: false, error: 'no action layer for excavation bot' };
      return actions.inventory.makeRoomAtHome({ home: this.home, resumeAt: { ...bot.position }, reason: 'excavation inventory full' });
    });
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
      construction: this.construction, combatTeam: this.combatTeam, players: this.players,
      imported: this.imported, world: this.world, runtime: this
    };
    this.services = services;
    this.commands = createCommandHandler(services);
    services.commands = this.commands;
    this.dashboard = this.wantDashboard ? createDashboard(services, { port: this.port, host: this.host }) : null;
    return this;
  }

  setHome(position, { source = 'operator', snapToSurface = true } = {}) {
    const x = Number(position && position.x);
    const y = Number(position && position.y);
    const z = Number(position && position.z);
    if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000 || y < -2048 || y > 2048) {
      return { ok: false, error: 'home coordinates must be finite world coordinates', home: this.home };
    }
    this.home = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
    if (snapToSurface && this.world && typeof this.world.getBlock === 'function') {
      const ground = this.bots.values().next().value;
      if (ground && typeof ground.surfaceAt === 'function') this.home.y = ground.surfaceAt(this.home.x, this.home.z) + 1;
    }
    this.homeSource = source;
    this.homeAnchored = true;
    this.memory.setHome({ position: this.home, setAt: Date.now(), reportedBy: source });
    if (this.construction) this.construction.home = this.home;
    for (const actions of this.actions ? this.actions.list() : []) actions.updateHome(this.home);
    return { ok: true, home: this.home };
  }

  /**
   * First successful spawn defines the shared home until an operator moves it.
   * Called once per process after a real connection; respawns/reconnects keep
   * the anchored position instead of drifting with the death location.
   */
  _anchorHomeToSpawn(bot) {
    if (this.homeAnchored || !bot) return false;
    const spawn = bot.spawnPosition || bot.position;
    if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.z)) return false;
    const result = this.setHome(spawn, { source: 'spawn', snapToSurface: false });
    this.logger.info(`home anchored to ${bot.name}'s spawn at ${this.home.x},${this.home.y},${this.home.z}`);
    return Boolean(result.ok);
  }

  async start() {
    if (this.running) return { ok: true, already: true };
    this.running = true;
    this.startedAt = Date.now();
    let dashboardInfo = null;
    if (this.dashboard && this.library) {
      // Build the library index/summary before the first dashboard request or
      // bot socket. Parsing the 20 MB manifest inside a live status snapshot
      // blocked the event loop for >1 s while logins were in flight.
      const started = Date.now();
      this.library.stats();
      this.logger.info(`schematic library ready: ${this.library.count} designs in ${Date.now() - started}ms`);
    }
    if (this.dashboard) {
      dashboardInfo = await this.dashboard.start();
      this.logger.info(`dashboard listening on http://${dashboardInfo.host}:${dashboardInfo.port}`);
    }
    if (!this.simulate && this.shouldConnect) {
      const requested = config.server.requestedViewDistance;
      const effective = config.server.viewDistance;
      if (String(requested) !== String(effective)) {
        this.logger.warn(`chunk view distance ${requested} requested but capped to ${effective} (MC_VIEW_DISTANCE_MAX) so five bots cannot replay the 26s chunk freeze`);
      }
      this.logger.info(`live protection: chunk view ${effective}, autonomy warm-up ${(config.autonomy.warmupMs / 1000).toFixed(0)}s, ${config.autonomy.maxConcurrentActions} concurrent actions, reconnect supervisor 1.5s`);
    }
    if (!this.simulate && this.shouldConnect) {
      this.connectLoop = this._connectAll().catch((err) => {
      if (!this.shutdownRequested) this.logger.error(`connection supervisor failed: ${err.message}`);
    });
    }
    this.timer = setInterval(() => this._tick().catch((err) => this.logger.error(`autonomy tick failed: ${err.message}`)), config.autonomy.tickMs);
    // Connection supervision gets its own timer. It used to live inside the
    // autonomy tick, where one 20s pathfinder step delayed every reconnect by
    // the same amount. A dropped bot must be restored while work continues.
    if (!this.simulate && this.shouldConnect) {
      this.supervisorTimer = setInterval(() => {
        this._superviseConnections().catch((err) => this.logger.warn(`reconnect supervisor: ${err.message}`));
      }, 1500);
      if (typeof this.supervisorTimer.unref === 'function') this.supervisorTimer.unref();
    }
    return { ok: true, mode: this.mode, dashboard: dashboardInfo, autonomyAllowed: this.autonomyAllowed };
  }

  /**
   * Resolve (and cache) the server version before opening any login sockets.
   * Aternos answers status pings with protocol -1 while the instance is asleep,
   * so wait for a real version instead of letting every bot fail in turn.
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
   * a fleet-wide cooldown after a throttle instead of firing all ten sockets
   * into the limiter at once.
   */
  async _acquireJoinSlot() {
    let release;
    const previous = this.joinLock;
    this.joinLock = new Promise((resolve) => { release = resolve; });
    await previous;
    let announced = false;
    while (!this.shutdownRequested) {
      const now = Date.now();
      const target = Math.max(this.joinCooldownUntil, this.nextJoinAt);
      if (now >= target) break;
      const wait = Math.max(50, target - now);
      const reason = this.joinCooldownUntil >= this.nextJoinAt ? 'server throttle cooldown' : 'per-IP join spacing';
      if (!announced) {
        this.logger.info(`join queue: waiting ${(wait / 1000).toFixed(1)}s for ${reason}`);
        announced = true;
      }
      // Re-check at least once a second. A bot becoming ready clears the
      // fleet-wide cooldown; without this short poll a healthy join queued
      // behind the old pause would still sit out the full 90s.
      await sleep(Math.min(wait, 1000), this.shutdownController.signal);
    }
    // Record the start time, then release the slot immediately unless an
    // operator configured a non-zero interval. Holding the lock through the
    // whole handshake made bots join strictly one-by-one even at 0 ms spacing.
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
    // Read the live configuration so an operator/test changing the throttle
    // budget takes effect without rebuilding the runtime.
    this.joinScheduler.baseDelayMs = config.server.reconnect.throttleDelayMs;
    this.joinScheduler.maxDelayMs = config.server.reconnect.throttleMaxDelayMs;
    this.joinScheduler.jitterMs = Math.min(250, config.server.reconnect.jitterMs);
    const record = this.joinScheduler.strike({ kind, error });
    this.throttleStrikes = record.strikes;
    this.lastThrottleAt = record.lastFailureAt || this.now();
    this.joinCooldownUntil = record.cooldownUntil || 0;
    if (record.counted) {
      this.logger.warn(`join queue: ${kind} (${error}); joins paused until ${new Date(this.joinCooldownUntil).toISOString()} (strike ${record.strikes}/${record.maxStrikes}, ${(record.lastWaitMs / 1000).toFixed(1)}s, episode ${record.episodes})`);
    } else {
      this.logger.info(`join queue: ${kind} (${error}) belongs to the open outage episode; strike ${record.strikes} unchanged, ${(record.remainingMs / 1000).toFixed(1)}s remaining`);
    }
    return record;
  }

  _markJoinSuccess(bot) {
    const record = this.joinScheduler.success();
    this.throttleStrikes = record.strikes;
    this.joinCooldownUntil = record.cooldownUntil || 0;
    this.logger.info(`join queue: ${bot.name} is ready; outage episode closed (strike level ${record.strikes}/${record.maxStrikes} retained for the next outage)`);
    return record;
  }

  /**
   * Only an explicit server throttle is a fleet-wide event. A single bot's TCP
   * or protocol-login timeout gets its own retry backoff and must not pause
   * four healthy sessions behind a 90s global cooldown.
   */
  _registerJoinFailure(bot, result) {
    if (!result || result.ok) return null;
    if (isThrottleError(result.error)) {
      this._registerJoinBackoff('throttled', result.error);
      return 'throttled';
    }
    if (isJoinStallError(result.error)) {
      this.logger.info(`[${bot.name}] join stall is scoped to this bot; the fleet join queue stays open`);
      return 'stalled';
    }
    return null;
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
      if (!this.simulate && !this.serverVersion) {
        const resolved = await this._ensureServerVersion();
        if (!resolved || this.shutdownRequested) {
          return { ok: false, error: this.serverVersionError || 'server version unavailable', code: 'VERSION_UNRESOLVED' };
        }
      }
      attempt++;
      this.retryMeta.set(bot.name, { attempt, nextRetryAt: null, lastError: null, since: Date.now() });
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
      // Release after the start slot is granted, not after the entire
      // handshake, so a 0 ms join interval really means no artificial delay.
      release();
      if (this.shutdownRequested) { return { ok: false, error: 'shutting down' }; }
      const startedAt = Date.now();
      this.logger.info(`[${bot.name}] connect attempt ${attempt}: ${config.server.host}:${config.server.port} version=${bot.version} auth=${bot.authProfile ? bot.authProfile.id : 'none'}${bot.passwordRequired ? ' (credential)' : ''} budgets: dns=${config.server.dnsTimeoutMs}ms tcp=${config.server.connectTimeoutMs}ms login=${config.server.loginTimeoutMs}ms configuration=${config.server.configurationTimeoutMs}ms spawn=${config.server.spawnTimeoutMs}ms`);
      let result;
      try {
        result = await bot.connect();
      } catch (err) {
        result = { ok: false, error: err.message, code: err.code };
      }
      const elapsed = Date.now() - startedAt;
      this._registerJoinFailure(bot, result);
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
      // A rejected password, missing credential or profile/challenge mismatch
      // will stay rejected. Retrying on a timer can trip AuthMe's lockout, so
      // pause until an operator fixes it and explicitly reconnects. A transient
      // confirmation timeout still recovers on retry.
      if (!result.ok && shouldPauseAuthRetry(result)) {
        const pauseReason = result.error || 'password authentication failed';
        bot.retryPaused = true;
        this.retryPausedBots.set(bot.name, pauseReason);
        this.connectionErrors[bot.name] = pauseReason;
        this.logger.error(`[${bot.name}] authentication failed (${result.code || 'AUTH_FAILED'}); automatic retries paused: ${pauseReason}`);
        return { ok: false, error: pauseReason, paused: true, code: result.code || 'AUTH_FAILED' };
      }
      if (result.ok && result.authPending) {
        const reason = `${bot.authProfile && bot.authProfile.label ? bot.authProfile.label : 'manual'} authentication required; no password command was sent`;
        this.connectionErrors[bot.name] = reason;
        this.logger.warn(`[${bot.name}] authentication pending: ${reason}; the spawned session stays open and gameplay is gated`);
        return result;
      }
      if (result.ok && bot.ready) {
        delete this.connectionErrors[bot.name];
        this.retryPausedBots.delete(bot.name);
        this.retryMeta.delete(bot.name);
        // A ready session proves this outage episode is over. The join
        // scheduler retains the strike level for a future outage and resets it
        // after a genuinely quiet ten minutes.
        this._markJoinSuccess(bot);
        this.logger.info(`[${bot.name}] ready (attempt ${attempt}, ${elapsed}ms)`);
        this._anchorHomeToSpawn(bot);
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
      // The fleet-wide cooldown is enforced by _acquireJoinSlot, which
      // re-checks every second: a healthy bot becoming ready clears it, and a
      // sleeping retry must not ignore that. The log still shows the effective
      // wait so an operator is not told 90s when the queue will hold 180s.
      const cooldownWait = Math.max(0, this.joinCooldownUntil - Date.now());
      delay = Math.max(delay, config.server.joinIntervalMs, this.nextJoinAt - Date.now());
      const effectiveDelay = Math.max(delay, cooldownWait);
      const reason = isThrottleError(result.error) ? 'server join throttle' : stalled ? 'join stalled before spawn' : 'connection failed';
      this.logger.warn(`[${bot.name}] ${reason} after ${elapsed}ms${result.code ? ` [${result.code}${result.stage ? `/${result.stage}` : ''}]` : ''}: ${result.error}; retrying in ${(effectiveDelay / 1000).toFixed(1)}s`);
      this.retryMeta.set(bot.name, { attempt, nextRetryAt: Date.now() + effectiveDelay, lastError: result.error || null, since: Date.now() });
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
    const snapshotStarted = Date.now();
    this.stateSyncTicks += 1;
    // Inventory metadata is the most expensive part of the snapshot. Actions
    // refresh it after their own writes; a 1.5s fleet-wide cadence is enough
    // for the dashboard and halves the per-tick allocation.
    const refreshInventory = this.stateSyncTicks % 2 === 1;
    for (const bot of this.bots.values()) {
      const started = Date.now();
      try {
        if (refreshInventory && typeof bot._syncInventory === 'function') bot._syncInventory();
        const status = connectionStatus(bot);
        const fallback = {
          name: bot.name,
          connected: status.transportConnected,
          spawned: status.spawned,
          serverPlayerListed: status.serverPlayerListed,
          authenticated: status.authenticated,
          authPending: status.authPending,
          ready: status.gameplayReady,
          health: bot.health,
          food: bot.food,
          position: bot.position,
          inventory: bot.inventory || {}
        };
        const summary = { ...fallback, ...(typeof bot.summary === 'function' ? bot.summary() : {}), ...status };
        this.coordinator.updateBot(bot.name, {
          ...summary,
          online: status.online,
          ready: status.gameplayReady,
          gameplayReady: status.gameplayReady,
          authPending: status.authPending,
          status: status.status,
          statusLabel: status.statusLabel
        });
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
      const elapsed = Date.now() - started;
      if (elapsed >= 250 && Date.now() - this._lastSlowSyncWarnAt >= 10000) {
        this._lastSlowSyncWarnAt = Date.now();
        this.logger.warn(`[${bot.name}] state sync took ${elapsed}ms; the snapshot for one bot is blocking the tick`);
      }
    }
    // Player sightings are shared by every controller and the Players page.
    // Entity scans are cheap but still O(entities), so refresh on a 2.25s
    // cadence rather than every 750ms state sync.
    if (this.players && this.stateSyncTicks % 3 === 0) {
      try { this.players.observeBots(this.bots.values()); }
      catch (err) { this.logger.warn(`player observation failed: ${err.message}`); }
    }
    this.lastSyncMs = Date.now() - snapshotStarted;
  }

  async _tick() {
    if (!this.running || this.ticking) return;
    const tickStarted = Date.now();
    // Hold the guard for the whole tick, including the pre-join safety path.
    // Previously the gate-closed path returned before setting this.ticking, so
    // the 750ms interval could stack dozens of overlapping safety ticks, each
    // replacing the previous pathfinding goal and eventually starving the
    // socket keepalive. That is what produced EPIPE / ECONNRESET storms while
    // the fleet was still joining.
    this.ticking = true;
    try {
      if (this.allBotsReady) {
        if (!this.autonomyArmedAt) {
          this.autonomyArmedAt = this.now();
          this.logger.info(`fleet ready; autonomy warm-up ${(config.autonomy.warmupMs / 1000).toFixed(0)}s while spawn chunks settle`);
        }
        this.autonomyArmed = true;
      } else if (!this.autonomyArmed) {
        // A joiner dropped during the first warm-up. Restart the settle window
        // when the fleet is complete again; its replacement is still receiving
        // the same spawn chunk burst.
        this.autonomyArmedAt = null;
      }
      this._checkEventLoopDelay();
      this._phase = 'state-sync';
      const syncStarted = Date.now();
      this._syncBots();
      this._lastPhase = 'state-sync';
      const syncMs = Date.now() - syncStarted;
      if (syncMs >= 1000) this.logger.warn(`state sync took ${syncMs}ms; the event loop was blocked inside _syncBots`);
      // Connection supervision must run while paused and while the autonomy
      // gate is closed. Pausing work must never leave a disconnected bot out of
      // the server until an operator notices.
      if (!this.simulate && this.shouldConnect) {
        this.supervisorTicks++;
        if (this.supervisorTicks % 2 === 0) this._superviseConnections();
      }
      if (this.paused) return;
      if (!this.autonomyAllowed) {
        // A ready bot must still eat, flee or defend itself while the team waits
        // for the remaining members; otherwise it stands still and is slain by
        // the first zombie that finds it.
        // Schedule per-bot safety work and return. A retreat can take seconds;
        // awaiting it here held the whole runtime tick (and every other join)
        // hostage, which is how "pre-join safety pass took 22491ms" happened.
        await this._safetyOnlyTick();
        return;
      }
      this.ticks++;
      // Crop growth is server-driven in live play. The deterministic world has
      // no random ticks, so advance real block-state ages on a slow cadence.
      if (this.simulate && this.world && typeof this.world.advanceCrops === 'function' && this.ticks % 4 === 0) {
        this.world.advanceCrops(1);
      }
      for (const bot of this.bots.values()) {
        if (bot.ready && bot.connected !== false && bot.health <= 0) {
          const actions = this.actions && typeof this.actions.get === 'function' ? this.actions.get(bot.name) : null;
          if (actions && actions.combat) actions.combat.onDeath('runtime observed death');
        }
      }
      this._phase = 'coordinator';
      try {
        this.coordinator.tick();
      } catch (err) {
        this.logger.error(`coordinator tick failed: ${err.message}`);
      }
      this._lastPhase = 'coordinator';
      this._phase = 'launch-actions';
      this._launchBotWork();
      this._lastPhase = 'launch-actions';
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
      this.lastTickMs = Date.now() - tickStarted;
      this.ticking = false;
    }
  }

  eventLoopStats() {
    const histogram = this.eventLoopDelay;
    if (!histogram) return null;
    const ms = (value) => Number.isFinite(value) ? Math.round(value / 1e6 * 10) / 10 : null;
    return {
      samples: histogram.count || 0,
      meanMs: ms(histogram.mean),
      maxMs: ms(histogram.max),
      p50Ms: ms(histogram.percentile(50)),
      p95Ms: ms(histogram.percentile(95)),
      p99Ms: ms(histogram.percentile(99)),
      resolutionMs: histogram.resolution
    };
  }

  /**
   * Attribute a long synchronous block that happened outside the tick loop
   * (dashboard snapshots, command handlers). Without this the watchdog blamed
   * the last tick phase (`state-sync`) for a block that occurred in a timer.
   */
  recordExternalWork(label, ms) {
    this._lastExternalWork = { label: String(label), ms: Number(ms) || 0, at: Date.now() };
    if (this._lastExternalWork.ms >= 250) this._lastPhase = this._lastExternalWork.label;
    return this._lastExternalWork;
  }

  _checkEventLoopDelay() {
    const stats = this.eventLoopStats();
    if (!stats || stats.maxMs === null) return;
    if (stats.maxMs < 1000 || stats.maxMs < this._eventLoopWarnedMax + 1000) return;
    const now = Date.now();
    if (now - this._eventLoopLastWarnAt < 30000) return;
    this._eventLoopWarnedMax = stats.maxMs;
    this._eventLoopLastWarnAt = now;
    this.logger.warn(`event loop blocked for up to ${stats.maxMs}ms (p99 ${stats.p99Ms}ms) at phase ${this._lastPhase || this._phase || 'unknown'}; a chunk/status burst can starve tick_end and keep-alive deadlines`);
  }

  /**
   * Keep the autonomy tick non-blocking. A controller action can await a
   * pathfinder for tens of seconds; awaiting ten of them inside the interval
   * meant status sync, reconnect supervision and the next tick all stalled
   * behind one bot. Launch at most `autonomy.maxConcurrentActions`, rotate
   * which bots get a slot, and run safety-only passes for the rest.
   */
  _launchBotWork() {
    if (!this.actions || !this.coordinator) return { launched: 0, safety: 0 };
    const active = this.actions.list().filter((actions) => {
      const bot = actions.bot;
      return bot && bot.connected && bot.spawned;
    });
    if (!active.length) return { launched: 0, safety: 0 };
    const cap = Math.max(1, Number(config.autonomy.maxConcurrentActions) || 4);
    let launched = 0;
    let safety = 0;
    for (let i = 0; i < active.length; i++) {
      const actions = active[(this.botStepCursor + i) % active.length];
      const name = actions.bot.name;
      if (this.commandLocks.has(name)) continue;
      if (this.botSteps.has(name) || this.botSafety.has(name)) continue;
      // The spawn chunks can still be streaming after the warm-up. Pathfinding
      // into an unloaded column is both useless and a synchronous burst, so a
      // bot without its local column stays on safety work for this tick.
      const worldBlocked = typeof actions.bot.isChunkReady === 'function' && !actions.bot.isChunkReady();
      // An operator player-watch (follow/guard/escort) must pre-empt task work
      // for that bot; it runs inside the safety pass so emergencies still win.
      const playerWatch = Boolean(actions.players && actions.players.isActive());
      if (!worldBlocked && !playerWatch && launched < cap && this.botSteps.size < cap) {
        this._startBotStep(actions);
        launched++;
      } else {
        this._startBotSafety(actions);
        safety++;
      }
    }
    this.botStepCursor = (this.botStepCursor + 1) % active.length;
    return { launched, safety };
  }

  _startBotSafety(actions) {
    const name = actions.bot.name;
    const started = Date.now();
    const task = (async () => {
      try {
        const safetyStarted = Date.now();
        const result = await actions.safetyTick();
        this._recordSafetyStages(name, result, safetyStarted);
      } catch (err) {
        this.logger.warn(`[${name}] safety tick failed: ${err.message}`);
      }
    })().finally(() => {
      const elapsed = Date.now() - started;
      if (elapsed >= 5000) this.logger.warn(`[${name}] safety task took ${(elapsed / 1000).toFixed(1)}s (movement is bounded, but this bot was slow)`);
      if (this.botSafety.get(name) === task) this.botSafety.delete(name);
    });
    this.botSafety.set(name, task);
    return task;
  }

  /** Keep each safety stage's real duration, not just one aggregate total. */
  _recordSafetyStages(name, result, started) {
    if (!result || !result.stages) return;
    const elapsed = Date.now() - started;
    const totalMs = result.totalMs === undefined ? elapsed : result.totalMs;
    this.safetyStages.set(name, { at: Date.now(), totalMs, stages: { ...result.stages } });
    const parts = Object.entries(result.stages)
      .filter(([, ms]) => ms >= 250)
      .map(([stage, ms]) => `${stage} ${ms}ms`);
    if (elapsed >= 5000 || parts.length) {
      this.logger.warn(`[${name}] safety stages ${elapsed}ms${parts.length ? `: ${parts.join(', ')}` : ''}`);
    }
  }

  _startBotStep(actions) {
    const bot = actions.bot;
    const name = bot.name;
    const started = Date.now();
    // A controller that never settles must not own a concurrency slot while
    // its pathfinder is dead. Cancel the movement at the configured budget; a
    // rejected path lets the action return and the slot free honestly.
    const watchdog = setTimeout(() => {
      const reason = `exceeded ${config.autonomy.actionTimeoutMs}ms`;
      try { bot.cancelAction?.(reason); } catch (_) { /* optional */ }
      try { actions.cancelCurrent?.(reason); } catch (_) { /* optional */ }
    }, Math.max(5000, config.autonomy.actionTimeoutMs));
    if (typeof watchdog.unref === 'function') watchdog.unref();
    const task = (async () => {
      try {
        // Safety and death bookkeeping must run for a dead bot too; the
        // controller returns early without moving it.
        const safetyStarted = Date.now();
        const safetyResult = await actions.safetyTick();
        this._recordSafetyStages(name, safetyResult, safetyStarted);
        if (bot.health <= 0) return;
        const assignment = this.coordinator.getAssignment(name);
        if (assignment) {
          const assignmentType = assignment.type || 'task';
          this._lastPhase = `action:${name}:${assignmentType}`;
          await actions.step({ coordinator: this.coordinator, bots: this.bots });
        } else if (this.ticks % 20 === 0 && actions.recovery.canWork()) {
          await this._idleWork(actions);
        }
      } catch (err) {
        // One controller failure must not stop the other bots.
        this.logger.warn(`[${name}] action tick failed: ${err.message}`);
      } finally {
        clearTimeout(watchdog);
        const elapsed = Date.now() - started;
        if (elapsed >= 10000) {
          const assignment = this.coordinator.getAssignment(name);
          this.logger.info(`[${name}] long action ${assignment ? assignment.type : 'idle'} finished in ${(elapsed / 1000).toFixed(1)}s`);
        }
        if (this.botSteps.get(name) === task) this.botSteps.delete(name);
      }
    })();
    this.botSteps.set(name, task);
    return task;
  }

  /**
   * Give an operator command exclusive use of one bot. A live fleet command
   * must not race an autonomous pathfinder: the autonomous step is cancelled
   * and its slot stays closed until the command returns.
   */
  async runExclusive(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('runExclusive needs a command function');
    const bot = this.bots.get(name);
    // Queue behind an earlier operator command for this bot. Resolving one
    // waiter on release preserves FIFO order without an unbounded array scan.
    while (this.commandLocks.has(name)) {
      await new Promise((resolve) => {
        const waiters = this.commandWaiters.get(name) || [];
        waiters.push(resolve);
        this.commandWaiters.set(name, waiters);
      });
    }
    this.commandLocks.add(name);
    try {
      const prior = this.botSteps.get(name);
      // A player-watch or formation follow also owns the pathfinder. Cancelling
      // only the autonomous step let a 20s follow continue under the command,
      // so the operator saw a slow command and two movement owners.
      const safety = this.botSafety.get(name);
      if (prior || safety) {
        try { bot?.cancelAction?.('operator command'); } catch (_) { /* optional */ }
        const grace = new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          if (timer.unref) timer.unref();
        });
        await Promise.race([
          Promise.allSettled([prior, safety].filter(Boolean)),
          grace
        ]);
      }
      return await fn();
    } finally {
      this.commandLocks.delete(name);
      const waiters = this.commandWaiters.get(name);
      if (waiters && waiters.length) {
        const next = waiters.shift();
        if (!waiters.length) this.commandWaiters.delete(name);
        next();
      }
    }
  }

  /** Wait for in-flight controller work (tests, shutdown, diagnostics). */
  async drainBotWork(timeoutMs = 30000) {
    const pending = [...this.botSteps.values(), ...this.botSafety.values()];
    if (!pending.length) return { drained: 0, timedOut: false };
    const all = Promise.allSettled(pending);
    if (!timeoutMs) { await all; return { drained: pending.length, timedOut: false }; }
    const timer = sleep(timeoutMs);
    const winner = await Promise.race([all.then(() => 'done'), timer.then(() => 'timeout')]);
    return { drained: pending.length, timedOut: winner === 'timeout' };
  }

  /**
   * Run reconnect supervision regardless of whether an autonomy tick is in
   * flight. The busy flag makes the interval and the tick idempotent.
   */
  async _superviseConnections() {
    if (this.shutdownRequested || this.simulate || !this.shouldConnect) return null;
    if (this.supervisorBusy) return null;
    this.supervisorBusy = true;
    try {
      await this._recoverDisconnected();
      return true;
    } catch (err) {
      this.logger.warn(`reconnect supervisor: ${err.message}`);
      return false;
    } finally {
      this.supervisorBusy = false;
    }
  }

  async _safetyOnlyTick() {
    if (!this.actions) return { scheduled: 0 };
    // Start one bounded safety task per ready bot and return immediately. The
    // per-bot map prevents overlap; a long retreat for one bot no longer
    // delays state sync, reconnect supervision or another bot's safety pass.
    let scheduled = 0;
    for (const actions of this.actions.list()) {
      const bot = actions.bot;
      if (!bot || !bot.ready || !bot.connected || !bot.spawned || bot.health <= 0) continue;
      const name = bot.name;
      if (this.commandLocks.has(name) || this.botSafety.has(name)) continue;
      this._startBotSafety(actions);
      scheduled++;
      // Do not start ten pathfinders inside one synchronous turn.
      if (scheduled % 2 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    return { scheduled };
  }

  /**
   * Reconnect one bot at a time in the background. A deliberate dashboard
   * disconnect is respected until an explicit reconnect clears that intent.
   */
  async _recoverDisconnected() {
    // Aternos can be asleep when the runtime starts. The version probe is the
    // only thing allowed to touch the server until it resolves; starting ten
    // retry loops here burned join slots on VERSION_UNRESOLVED and delayed the
    // first real login by tens of seconds.
    if (!this.simulate && !this.serverVersion) return;
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
      } else if (status.transportConnected) {
        // Trust the lifecycle verdict, not the legacy boolean. A kicked bot can
        // still have connected=true after a terminal transition; skipping it
        // here left it offline forever because connect() also saw connected.
        continue;
      }
      if (started > 0) {
        await sleep(staggerDelay({
          staggerMs: config.server.connectStaggerMs,
          jitterMs: config.server.connectJitterMs
        }), this.shutdownController.signal);
      }
      if (this.shutdownRequested) return;
      const hadSession = Number(bot.lastSessionEndedAt || 0) > 0;
      const task = this._startConnection(bot);
      task.then((result) => {
        // An initial join is not a restoration. Only claim the supervisor
        // restored a bot when this bot actually had a ready session before.
        if (result && result.ok && hadSession) this.logger.info(`[${name}] reconnect supervisor restored the bot`);
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
    if (bot.retryPaused) { bot.retryPaused = false; bot.kickKind = null; bot.movementKickStrikes = 0; }

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
    this.retryMeta.delete(name);
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
      connected: status.transportConnected,
      spawned: status.spawned,
      serverPlayerListed: status.serverPlayerListed,
      authenticated: status.authenticated,
      authPending: status.authPending,
      authRequiredManual: status.authRequiredManual,
      ready: status.gameplayReady,
      gameplayReady: status.gameplayReady,
      online: status.online,
      status: status.status,
      statusLabel: status.statusLabel,
      statusDetail: status.statusDetail,
      lastEventAt: status.lastEventAt,
      lastEventAgeMs: status.lastEventAgeMs,
      kickKind: bot.kickKind || null,
      sessionId: status.sessionId || (bot.connection ? bot.connection.generation : null),
      stage: status.stage || null,
      connection: typeof bot.connection === 'object' && bot.connection && typeof bot.connection.snapshot === 'function' ? bot.connection.snapshot() : null,
      stageTimings: bot.stageTimings || null,
      keepAlive: bot._keepAlive ? { ...bot._keepAlive } : null,
      ticker: typeof bot._clientTicker?.snapshot === 'function' ? bot._clientTicker.snapshot() : null,
      lastDisconnect: bot.lastDisconnect || null,
      retryPaused: Boolean(bot.retryPaused || this.retryPausedBots.has(name)),
      error: this.connectionErrors[name] || this.connectionErrors.server || bot.lastError || null
    };
  }

  pause() {
    this.paused = true;
    return { ok: true, paused: true, tick: this.ticks };
  }

  resume() {
    if (!this.autonomyAllowed) return { ok: false, error: 'no ready bots; the fleet connection gate is still closed' };
    this.paused = false;
    return { ok: true, paused: false, tick: this.ticks };
  }

  state({ combatTeamStatus = undefined } = {}) {
    const started = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    const at = Date.now();
    let cpuPercent = null;
    if (this._lastCpuSample) {
      const elapsed = at - this._lastCpuSample.at;
      if (elapsed > 0) {
        const usedUs = (cpu.user - this._lastCpuSample.user) + (cpu.system - this._lastCpuSample.system);
        cpuPercent = Number(((usedUs / 1000) / elapsed * 100).toFixed(1));
      }
    }
    this._lastCpuSample = { at, user: cpu.user, system: cpu.system };
    const state = {
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
      bots: [...this.bots.values()].map((bot) => {
        const status = connectionStatus(bot);
        const connection = bot.connection && typeof bot.connection.snapshot === 'function' ? bot.connection.snapshot() : null;
        return {
          name: bot.name,
          connected: status.transportConnected, spawned: status.spawned,
          serverPlayerListed: status.serverPlayerListed,
          authenticated: status.authenticated, authPending: status.authPending,
          authRequiredManual: status.authRequiredManual,
          ready: status.gameplayReady, gameplayReady: status.gameplayReady,
          online: status.online, status: status.status, statusLabel: status.statusLabel, statusDetail: status.statusDetail,
          health: bot.health, deaths: bot.deaths || 0, lastSpawn: bot.lastSpawn || null,
          stageTimings: bot.stageTimings || null,
          safety: this.safetyStages.get(bot.name) || null,
          retry: this.retryMeta.get(bot.name) || null,
          connection: connection ? {
            generation: connection.generation, state: connection.state, label: connection.label, detail: connection.detail,
            stage: connection.stage, stageLabel: connection.stageLabel, stageElapsedMs: connection.stageElapsedMs,
            stageTimeoutMs: connection.stageTimeoutMs, elapsedMs: connection.elapsedMs, failure: connection.failure,
            invalidTransitions: connection.invalidTransitions
          } : null
        };
      }),
      connectionErrors: { ...this.connectionErrors },
      eventLoop: this.eventLoopStats(),
      joinQueue: {
        nextJoinAt: this.nextJoinAt || null,
        cooldownUntil: this.joinCooldownUntil || null,
        waiting: [...this.reconnectTasks.keys()],
        joinIntervalMs: config.server.joinIntervalMs,
        joinJitterMs: config.server.joinJitterMs,
        throttleStrikes: this.throttleStrikes || 0,
        scheduler: this.joinScheduler.snapshot()
      },
      dashboard: this.dashboard ? this.dashboard.url : null,
      construction: this.construction ? { activeId: this.construction.activeId, projects: this.construction.projects.size } : null,
      // A dashboard snapshot already computed the team status from its own
      // per-controller objects. Recomputing it here repeated every entity scan.
      combat: combatTeamStatus !== undefined
        ? combatTeamStatus
        : (this.combatTeam ? this.combatTeam.status() : null),
      pausedAt: this.paused ? Date.now() : null,
      performance: {
        stateSnapshotMs: 0,
        cpuPercent,
        rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
        heapUsedMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
        lastTickMs: this.lastTickMs === undefined ? null : this.lastTickMs,
        lastSyncMs: this.lastSyncMs === undefined ? null : this.lastSyncMs
      }
    };
    const elapsedMs = Number(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1);
    state.performance.stateSnapshotMs = Number(elapsedMs);
    this._lastStateSnapshotMs = Number(elapsedMs);
    return state;
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
    if (this.supervisorTimer) clearInterval(this.supervisorTimer);
    this.supervisorTimer = null;
    if (this.botSteps.size || this.botSafety.size) {
      await Promise.race([
        Promise.allSettled([...this.botSteps.values(), ...this.botSafety.values()]),
        sleep(2000)
      ]).catch(() => {});
    }
    try { this.eventLoopDelay?.disable(); } catch (_) { /* unavailable */ }
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

module.exports = { TeamRuntime, createRuntime, STARTER_KIT, shouldPauseAuthRetry, PERMANENT_AUTH_CODES };
