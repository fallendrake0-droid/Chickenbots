'use strict';

const dns = require('dns');
const { BotAdapter } = require('./adapter');
const { config, BOT_NAMES } = require('../config');
const { redactString } = require('../util/redact');
const { classifyKick, sleep } = require('./connection');
const { ConnectionStateMachine, STATES, TERMINAL } = require('./connectionState');
const { ClientTickScheduler, MOVEMENT_PACKETS } = require('./clientTicker');
const { Logger } = require('../logger');
const { distance } = require('../util/vec');
const { FOODS, BED_NAMES, toolTier } = require('../world/items');
const { TILLABLE } = require('../world/crops');

const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'slime', 'magma_cube',
  'enderman', 'blaze', 'ghast', 'hoglin', 'zoglin', 'piglin_brute', 'warden', 'silverfish',
  'endermite', 'guardian', 'elder_guardian', 'shulker', 'vex', 'breeze'
]);

const FLUID_BLOCKS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);

/**
 * Live Mineflayer bot.
 *
 * Autonomy is gated on a verified connection + successful login + spawn. Until
 * `ready` is true, every gameplay primitive refuses to act. No AI service is
 * involved: the same deterministic controllers that run against MockBot drive
 * this adapter.
 */
class RealBot extends BotAdapter {
  constructor({
    name, host = config.server.host, port = config.server.port, version = config.server.version,
    auth = config.server.auth, logger = null, mineflayer = null, createBot = null,
    loginPassword = config.server.loginPassword, registerPassword = config.server.registerPassword,
    connectTimeoutMs = config.server.connectTimeoutMs,
    dnsTimeoutMs = config.server.dnsTimeoutMs,
    configurationTimeoutMs = config.server.configurationTimeoutMs,
    now = Date.now,
    authDelayMs = config.server.authDelayMs, authTimeoutMs = config.server.authTimeoutMs,
    authEnabled = config.server.authEnabled, registerOnFirstJoin = config.server.registerOnFirstJoin
  } = {}) {
    super({ name, logger: logger || new Logger({ level: config.logging.level }), speed: 1 });
    if (!BOT_NAMES.includes(name)) throw new Error(`refusing to create a bot outside the fixed team roster: ${name}`);
    this.host = host;
    this.port = port;
    this.version = version;
    this.auth = auth;
    this.loginPassword = loginPassword;
    this.registerPassword = registerPassword;
    this.connectTimeoutMs = connectTimeoutMs;
    this.dnsTimeoutMs = dnsTimeoutMs;
    this.configurationTimeoutMs = configurationTimeoutMs;
    this.loginTimeoutMs = config.server.loginTimeoutMs;
    this.spawnTimeoutMs = config.server.spawnTimeoutMs;
    this.authEnabled = authEnabled !== false;
    this.registerOnFirstJoin = registerOnFirstJoin;
    this.hasRegistered = false;
    this.authDelayMs = authDelayMs;
    this.authTimeoutMs = authTimeoutMs;
    this._mineflayer = mineflayer;
    this._createBot = createBot;
    this.bot = null;
    this.connected = false;
    this.spawned = false;
    this.authenticated = false;
    this.passwordRequired = this.authEnabled && Boolean(this.loginPassword || this.registerPassword);
    this.authConfirmed = false;
    this.lastError = null;
    // Updated by every inbound packet. The dashboard uses it to distinguish a
    // live socket from one that died without emitting 'end'.
    this.lastEventAt = 0;
    // Set only when a spawned session ends, never for a failed connect attempt.
    this.lastSessionEndedAt = 0;
    this.lastDeath = null;
    this.lastDeathMessage = null;
    this.lastDamageAt = 0;
    this.lastDamageAmount = 0;
    this.lastAttacker = null;
    this.deathHistory = [];
    this.lastSpawn = null;
    this.respawnAttempts = 0;
    this.lastRespawnAt = 0;
    this._respawnTimer = null;
    this._loginWaiters = new Set();
    this._tcpWaiters = new Set();
    this._stageTimers = new Map();
    this._pendingConnectionError = null;
    this.loginAt = 0;
    this.spawnAt = 0;
    this.connectStartedAt = 0;
    this.now = typeof now === 'function' ? now : Date.now;
    this.stageTimings = {
      dnsMs: null, tcpMs: null, handshakeMs: null, configurationMs: null,
      connectMs: null, loginMs: null, spawnMs: null, authMs: null, totalMs: null
    };
    this.stageStartedAt = { dns: 0, tcp: 0, handshake: 0, configuration: 0, spawn: 0, auth: 0 };
    this.spawnPosition = null;
    this.worldView = null;
    this._chatLog = [];
    this._chatListeners = new Set();
    this._spawnWaiters = new Set();
    this._movementLock = false;
    this._clientWriteOriginal = null;
    this._suppressedMovement = 0;
    this._traceLog = [];
    this.lastServerPosition = null;
    this._authWaiters = new Set();
    this._connectPromise = null;
    this._clientGeneration = 0;
    this._connectionGeneration = 0;
    this._tcpConnected = false;
    this._tcpAt = 0;
    this._loginReceivedAt = 0;
    this._configurationAt = 0;
    this._spawnedThisSession = false;
    this._respawnPacketSeen = false;
    this.lastDisconnectDumped = null;
    this._clientTicker = null;
    this._serverTickingState = null;
    this._tickEndSent = false;
    this._lastTickEndAt = 0;
    this._keepAlive = { received: 0, replies: 0, lastReceivedAt: 0, lastReplyAt: 0, maxGapMs: 0, warnings: 0, lastWarningAt: 0 };
    this.lastDisconnect = null;
    this._antiAfkTimer = null;
    this._antiAfkJumpTimer = null;
    this._antiAfkPulses = 0;
    this.kickKind = null;
    this.retryPaused = false;
    this._blockCache = new Map();
    this._inventoryDirty = false;
    this._lastHealth = undefined;
    this._lastTotemCount = 0;
    this.itemMeta = {};
    this._itemAliases = new Map();
    this.combatEvents = [];
    this.uptimeMs = 0;
    this.startedAt = 0;
    this.stats = { dug: 0, placed: 0, attacked: 0, eaten: 0, crafted: 0, deaths: 0, connections: 0 };
    this._deathCount = 0;
    this.connection = new ConnectionStateMachine({
      now: this.now,
      onChange: (snapshot) => this._onConnectionChange(snapshot)
    });
  }

  get ready() { return Boolean(this.connected && this.authenticated && this.spawned && this.bot && this.bot.entity); }

  /** Runtime resolves 'auto' once and pushes the explicit version to each bot. */
  setVersion(version) {
    if (version) this.version = version;
  }

  /**
   * Drop every position/look/flying packet while the password is unconfirmed.
   * mineflayer's physics loop keeps calling updatePosition() even when
   * physicsEnabled is false, and an early movement packet makes AuthMe/Paper
   * kick the bot with "Invalid move player packet received" before /register
   * can complete.
   */
  _installClientTrace() {
    const client = this.bot && this.bot._client;
    if (!client || typeof client.write !== 'function' || this._clientWriteOriginal) return;
    const original = client.write.bind(client);
    const owner = this.bot;
    const generation = this.connection.generation;
    this._clientWriteOriginal = original;
    const movement = MOVEMENT_PACKETS;
    client.write = (name, packet) => {
      // A queued Mineflayer physics callback from an old socket must never
      // write into the replacement socket after a reconnect. The generation is
      // owned by the lifecycle state machine, not by this closure.
      if (this.bot !== owner || !this.connection.isCurrent(generation)) return true;
      const socket = client.socket;
      if (socket && (socket.destroyed || socket.readyState === 'closed')) return true;
      if (movement.has(name)) {
        try { this._trace(this._movementLock ? 'held-out' : 'out', name, packet); } catch (_) { /* tracing must never break movement */ }
        if (this._movementLock) {
          this._suppressedMovement++;
          return true;
        }
        // The client tick scheduler owns packet ordering: at most one
        // position-bearing packet per tick, then a single tick_end. It passes
        // non-position movement (look/flying) straight through.
        if (this._clientTicker && this._clientTicker.enabled) {
          this._clientTicker.writeMovement(name, packet);
          return true;
        }
      }
      const result = original(name, packet);
      // Count the library's own automatic reply only after its write call
      // returns, so a failed write cannot look like a verified keep-alive.
      if (name === 'keep_alive') this._noteKeepAliveReply();
      return result;
    };
  }

  /**
   * A second spawn/respawn packet can arrive after AuthMe confirmation (the
   * respawn screen issues one). This used to recompute `authenticated` from
   * `passwordRequired`, wiping a confirmed login and making a healthy session
   * look unready. Confirmation is monotonic for the lifetime of one session.
   */
  _applySpawnAuth() {
    if (this.authConfirmed) {
      this.authenticated = true;
      if (this.connection.state === STATES.AUTHENTICATING) this.connection.transition(STATES.READY, { detail: 'password authentication already confirmed' });
      return true;
    }
    if (!this.passwordRequired) {
      this.authenticated = true;
      if (this.connection.state === STATES.AUTHENTICATING) this.connection.transition(STATES.READY, { detail: 'no password required' });
      return true;
    }
    this.authenticated = false;
    return false;
  }

  _lockMovement() {
    const client = this.bot && this.bot._client;
    if (!client || typeof client.write !== 'function') return;
    this._installClientTrace();
    this._movementLock = true;
  }

  _unlockMovement() {
    if (!this._movementLock) return;
    this._movementLock = false;
    if (this._suppressedMovement > 0) {
      const outcome = this.authenticated ? 'released movement after auth' : 'discarded movement while unauthenticated';
      this.logger.info(`[${this.name}] ${outcome} (${this._suppressedMovement} packet(s) held)`);
    }
  }

  _restoreClientTrace() {
    this._stopClientTicker('client trace restored');
    const client = this.bot && this.bot._client;
    if (client && this._clientWriteOriginal) client.write = this._clientWriteOriginal;
    this._clientWriteOriginal = null;
    this._movementLock = false;
  }

  _onConnectionChange(snapshot) {
    this.connected = Boolean(snapshot.open);
    this.spawned = Boolean(snapshot.spawned);
    this.authenticated = Boolean(snapshot.authenticated);
    // Awaiting spawn with no password is already authenticated in the only
    // sense that matters: no credential exchange is pending.
    if (snapshot.state === STATES.AWAITING_SPAWN && !this.passwordRequired) this.authenticated = true;
    if (TERMINAL.has(snapshot.state)) this.authenticated = false;
    if (snapshot.generation !== this._connectionGeneration) {
      this._connectionGeneration = snapshot.generation;
      this._clientGeneration = snapshot.generation;
    }
  }

  _transition(state, detail = '', options = {}) {
    const ok = this.connection.transition(state, { detail, ...options });
    if (!ok) {
      this.logger.debug(`[${this.name}] refused lifecycle transition ${this.connection.state} -> ${state}: ${detail}`);
    }
    return ok;
  }

  _supportFeature(name) {
    try {
      if (this.bot && typeof this.bot.supportFeature === 'function') return Boolean(this.bot.supportFeature(name));
      const version = (this.bot && this.bot.version) || this.version;
      if (!version || version === 'auto') return false;
      return Boolean(require('minecraft-data')(version).supportFeature(name));
    } catch (_) {
      return false;
    }
  }

  _startClientTicker() {
    this._stopClientTicker('restarting client tick loop');
    const client = this.bot && this.bot._client;
    const original = this._clientWriteOriginal;
    if (!client || !original || !this._supportFeature('sendsClientTickEndPacket')) return false;
    const owner = this.bot;
    const generation = this.connection.generation;
    this._clientTicker = new ClientTickScheduler({
      name: this.name,
      logger: this.logger,
      now: this.now,
      write: (name, packet) => {
        if (this.bot !== owner || !this.connection.isCurrent(generation)) return;
        const socket = client.socket;
        if (socket && (socket.destroyed || socket.readyState === 'closed')) return;
        if (name === 'tick_end') {
          this._lastTickEndAt = this.now();
          if (!this._tickEndSent) {
            this._tickEndSent = true;
            this.logger.info(`[${this.name}] client_tick_end loop active at ${this._clientTicker ? this._clientTicker.tickRate : 20} tps (1.21.2+ requirement)`);
          }
        }
        original(name, packet);
      }
    });
    this._clientTicker.start();
    if (this._serverTickingState) this._clientTicker.setTickingState(this._serverTickingState);
    this.connection.event('client_ticker_started', `${this._clientTicker.tickRate} tps`);
    return true;
  }

  _stopClientTicker(reason = 'stopped') {
    if (!this._clientTicker) return false;
    const stopped = this._clientTicker.stop(reason);
    this._clientTicker = null;
    return stopped;
  }

  _noteKeepAliveReply() {
    const at = this.now();
    this._keepAlive.replies += 1;
    this._keepAlive.lastReplyAt = at;
    this.connection.event('keep_alive_reply', 'automatic reply written by minecraft-protocol', at);
  }

  _checkKeepAlive() {
    if (!this.ready || !this._keepAlive.lastReceivedAt) return;
    const age = this.now() - this._keepAlive.lastReceivedAt;
    if (age > config.server.keepAliveMs && this.now() - this._keepAlive.lastWarningAt > config.server.keepAliveMs) {
      this._keepAlive.warnings += 1;
      this._keepAlive.lastWarningAt = this.now();
      this.logger.warn(`[${this.name}] no keep-alive from the server for ${Math.round(age / 1000)}s; minecraft-protocol will close the socket at ${Math.round(config.server.keepAliveMs / 1000)}s`);
    }
  }

  _connectionSnapshot(extra = {}) {
    const snapshot = this.connection.snapshot();
    return {
      ...snapshot,
      name: this.name,
      version: this.version,
      connected: this.connected,
      spawned: this.spawned,
      authenticated: this.authenticated,
      ready: this.ready,
      stageTimings: { ...this.stageTimings },
      keepAlive: { ...this._keepAlive },
      ticker: this._clientTicker ? this._clientTicker.snapshot() : null,
      lastEventAt: this.lastEventAt || null,
      lastEventAgeMs: this.lastEventAt ? Math.max(0, this.now() - this.lastEventAt) : null,
      loginAt: this.loginAt || null,
      spawnAt: this.spawnAt || null,
      clientState: this.bot && this.bot._client ? this.bot._client.state : null,
      serverTickingState: this._serverTickingState,
      lastError: this.lastError || snapshot.lastError || null,
      lastDisconnect: this.lastDisconnect,
      ...extra
    };
  }

  _captureDisconnectSnapshot(reason) {
    const at = this.now();
    const snapshot = {
      at,
      reason: this._redact(String(reason || 'connection ended')),
      generation: this.connection.generation,
      state: this.connection.state,
      label: this.connection.label,
      stage: this.connection.stage,
      connected: Boolean(this.connected),
      spawned: Boolean(this.spawned),
      authenticated: Boolean(this.authenticated),
      ready: Boolean(this.ready),
      lastError: this.lastError,
      kickKind: this.kickKind,
      position: this.position ? { ...this.position } : null,
      serverPosition: this.lastServerPosition ? { ...this.lastServerPosition } : null,
      lastSpawn: this.lastSpawn,
      stageTimings: { ...this.stageTimings },
      keepAlive: { ...this._keepAlive },
      ticker: this._clientTicker ? this._clientTicker.snapshot() : null,
      lastEventAt: this.lastEventAt || null,
      lastEventAgeMs: this.lastEventAt ? Math.max(0, at - this.lastEventAt) : null,
      loginAt: this.loginAt || null,
      spawnAt: this.spawnAt || null,
      clientState: this.bot && this.bot._client ? this.bot._client.state : null,
      serverTickingState: this._serverTickingState,
      timeline: this.connection.snapshot(at).timeline
    };
    // The kicked/end pair must not overwrite the pre-cleanup evidence with the
    // already-reset booleans of the second event.
    if (this.lastDisconnect && this.lastDisconnect.generation === snapshot.generation) {
      return this.lastDisconnect;
    }
    this.lastDisconnect = snapshot;
    return snapshot;
  }

  _redact(value) {
    return redactString(value == null ? '' : value);
  }

  _trace(direction, name, packet = {}) {
    packet = packet || {};
    const n3 = (value) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(3)) : value);
    const entity = this.bot && this.bot.entity && this.bot.entity.position;
    const entry = {
      at: new Date().toISOString(),
      direction,
      packet: name,
      x: Number.isFinite(packet.x) ? n3(packet.x) : undefined,
      y: Number.isFinite(packet.y) ? n3(packet.y) : undefined,
      z: Number.isFinite(packet.z) ? n3(packet.z) : undefined,
      yaw: Number.isFinite(packet.yaw) ? n3(packet.yaw) : undefined,
      pitch: Number.isFinite(packet.pitch) ? n3(packet.pitch) : undefined,
      onGround: packet.onGround,
      flags: packet.flags,
      auth: this.authenticated,
      locked: this._movementLock,
      entity: entity ? { x: n3(entity.x), y: n3(entity.y), z: n3(entity.z) } : null
    };
    this._traceLog.push(entry);
    if (this._traceLog.length > 120) this._traceLog.shift();
    const pos = `${entry.x ?? '-'},${entry.y ?? '-'},${entry.z ?? '-'}`;
    const line = `[${this.name}] TRACE ${direction} ${name} pos=${pos} yaw=${entry.yaw ?? '-'} pitch=${entry.pitch ?? '-'} ground=${entry.onGround} flags=${JSON.stringify(entry.flags)} auth=${entry.auth} locked=${entry.locked}`;
    // Per-packet lines are debug-only, and the logger keeps TRACE lines off
    // unless MC_TRACE_PACKETS=true because a flooded terminal can stall the
    // socket keepalive.
    this.logger.debug(line);
  }

  _dumpTrace(reason, captured = null) {
    const snapshot = captured || this._captureDisconnectSnapshot(reason);
    const at = snapshot.at ? new Date(snapshot.at).toISOString() : new Date().toISOString();
    const summaryLevel = (snapshot.spawned || snapshot.ready) ? 'error' : 'warn';
    this.logger[summaryLevel](`[${this.name}] DISCONNECT SNAPSHOT ${at} (${snapshot.reason}) generation=${snapshot.generation} state=${snapshot.state} stage=${snapshot.stage} spawned=${snapshot.spawned} authenticated=${snapshot.authenticated} connected=${snapshot.connected} ready=${snapshot.ready} held=${this._suppressedMovement} entity=${JSON.stringify(snapshot.position)} serverPosition=${JSON.stringify(snapshot.serverPosition)} timings=${JSON.stringify(snapshot.stageTimings)} keepAlive=${JSON.stringify(snapshot.keepAlive)} ticker=${JSON.stringify(snapshot.ticker)}`);
    const entryLevel = (snapshot.spawned || snapshot.ready) ? 'error' : 'debug';
    for (const entry of (snapshot.timeline || []).slice(-16)) {
      this.logger[entryLevel](`[${this.name}] LIFECYCLE ${new Date(entry.at).toISOString()} ${entry.kind} ${entry.from ? `${entry.from}->` : ''}${entry.to || entry.stage || entry.event} ${entry.detail || ''}`);
    }
    for (const entry of this._traceLog.slice(-20)) {
      this.logger.error(`[${this.name}] TRACE ${entry.at} ${entry.direction} ${entry.packet} pos=${entry.x ?? '-'},${entry.y ?? '-'},${entry.z ?? '-'} yaw=${entry.yaw ?? '-'} pitch=${entry.pitch ?? '-'} ground=${entry.onGround} flags=${JSON.stringify(entry.flags)} auth=${entry.auth} locked=${entry.locked}`);
    }
  }

  _abortAuth(error) {
    const failure = { ok: false, code: 'AUTH_ABORTED', error: error || 'connection lost during password authentication', kind: 'connection' };
    for (const finish of [...this._authWaiters]) finish(failure);
    this._authWaiters.clear();
  }

  _failTcpWaiters(error, code = 'CONNECTION_CLOSED') {
    for (const waiter of [...this._tcpWaiters]) {
      waiter.resolve({ ok: false, code, error: error || 'connection closed before TCP establishment', stage: 'tcp' });
    }
    this._tcpWaiters.clear();
  }

  _failLoginWaiters(error, code = 'CONNECTION_CLOSED') {
    for (const waiter of [...this._loginWaiters]) {
      waiter.resolve({ ok: false, code, error: error || 'connection closed before login', stage: waiter.stage || 'handshake' });
    }
    this._loginWaiters.clear();
  }

  _failSpawnWaiters(error, code = 'CONNECTION_CLOSED') {
    if (!this._spawnWaiters.size) return;
    for (const waiter of [...this._spawnWaiters]) {
      waiter.resolve({
        ok: false,
        code,
        error: error || this.lastError || 'connection closed before spawn',
        stage: 'spawn',
        spawned: this.spawned,
        authenticated: this.authenticated
      });
    }
    this._spawnWaiters.clear();
  }

  _armLoginWaiters(stage, timeoutMs) {
    for (const waiter of this._loginWaiters) {
      if (typeof waiter.arm === 'function') waiter.arm(stage, timeoutMs);
    }
  }

  _loadMineflayer() {
    if (this._createBot) return this._createBot;
    // Lazily require so the deterministic simulator/tests never need a socket.
    const mineflayer = this._mineflayer || require('mineflayer');
    this._mineflayer = mineflayer;
    return mineflayer.createBot.bind(mineflayer);
  }

  async connect(options = {}) {
    if (this.shuttingDown) return { ok: false, error: 'shutting down', code: 'SHUTDOWN' };
    // One socket per bot. A dashboard reconnect and the supervisor must never
    // race into two simultaneous logins for the same username.
    if (this._connectPromise) return this._connectPromise;
    if (this.connected) return { ok: true, already: true };
    this._connectPromise = this._connectOnce(options).finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  _beginSession(startedAt = null) {
    this._restoreClientTrace();
    this._stopClientTicker('new session');
    this.connected = false;
    this.spawned = false;
    this.authenticated = false;
    this.kickKind = null;
    this.retryPaused = false;
    this.passwordRequired = this.authEnabled && Boolean(this.loginPassword || this.registerPassword);
    this.authConfirmed = false;
    this.lastError = null;
    this.lastEventAt = 0;
    this._movementLock = false;
    this._clientWriteOriginal = null;
    this._suppressedMovement = 0;
    this._traceLog = [];
    this.lastServerPosition = null;
    this._authWaiters = new Set();
    this._loginWaiters = new Set();
    this._tcpWaiters = new Set();
    this._pendingConnectionError = null;
    this._tickEndSent = false;
    this._lastTickEndAt = 0;
    this._serverTickingState = null;
    this._tcpConnected = false;
    this._tcpAt = 0;
    this._loginReceivedAt = 0;
    this._configurationAt = 0;
    this._spawnedThisSession = false;
    this._respawnPacketSeen = false;
    this.lastDisconnectDumped = null;
    this._keepAlive = { received: 0, replies: 0, lastReceivedAt: 0, lastReplyAt: 0, maxGapMs: 0, warnings: 0, lastWarningAt: 0 };
    this.stageTimings = {
      dnsMs: null, tcpMs: null, handshakeMs: null, configurationMs: null,
      connectMs: null, loginMs: null, spawnMs: null, authMs: null, totalMs: null
    };
    this.stageStartedAt = { dns: 0, tcp: 0, handshake: 0, configuration: 0, spawn: 0, auth: 0 };
    this.connection.begin({ host: this.host, port: this.port, version: this.version, username: this.name });
    this._connectionGeneration = this.connection.generation;
    this._clientGeneration = this.connection.generation;
    this.connectStartedAt = startedAt === null ? this.now() : startedAt;
    this.stageStartedAt.dns = this.now();
    this.loginAt = 0;
    this.spawnAt = 0;
  }

  async _preflightDns(timeoutMs) {
    // The minecraft-protocol socket performs its own DNS (and SRV) lookup.
    // Resolve once here so a DNS hang is a distinct, timed stage instead of
    // being reported as a protocol-login timeout. Injected test adapters have
    // no hostname to resolve.
    if (this._createBot) {
      const skipped = { ok: true, skipped: true, ms: 0, address: null };
      this.stageTimings.dnsMs = 0;
      this.connection.event('dns_skipped', 'injected createBot');
      return skipped;
    }
    const budget = Math.max(1, Math.min(this.dnsTimeoutMs, timeoutMs));
    const started = this.now();
    this.connection.setStage('dns', { detail: `resolving ${this.host}`, timeoutMs: budget });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stageTimings.dnsMs = this.now() - started;
        if (result.ok) {
          this.stageStartedAt.tcp = this.now();
          this.connection.event('dns_resolved', `${result.address || this.host} (${this.stageTimings.dnsMs}ms)`);
        } else {
          this.connection.event('dns_failed', result.error);
        }
        resolve({ ...result, ms: this.stageTimings.dnsMs });
      };
      const timer = setTimeout(() => finish({ ok: false, code: 'DNS_TIMEOUT', error: `DNS lookup for ${this.host} timed out after ${budget}ms` }), budget);
      try {
        dns.lookup(this.host, (err, address, family) => {
          if (err) return finish({ ok: false, code: 'DNS_FAILED', error: `DNS lookup failed for ${this.host}: ${err.message}` });
          finish({ ok: true, address, family });
        });
      } catch (err) {
        finish({ ok: false, code: 'DNS_FAILED', error: `DNS lookup failed for ${this.host}: ${err.message}` });
      }
    });
  }

  async _connectOnce({ timeoutMs = this.connectTimeoutMs } = {}) {
    if (this.connected) return { ok: true, already: true };
    if (!this._createBot && this.version === 'auto') {
      return { ok: false, code: 'VERSION_UNRESOLVED', error: 'server version has not been resolved; the runtime must probe it before connecting' };
    }
    // The attempt clock starts before mineflayer's lazy module/version load:
    // otherwise a 30s login deadline appears as a 31.1s attempt and the extra
    // second is misattributed to the server.
    const attemptStartedAt = this.now();
    const createBot = this._loadMineflayer();
    this._beginSession(attemptStartedAt);
    // Keep the injected-adapter path synchronous: tests and the simulator
    // emit events immediately after connect() is called. A real connection
    // has no socket yet, so awaiting DNS cannot miss an event.
    let dnsResult;
    if (this._createBot) {
      this.stageTimings.dnsMs = 0;
      this.connection.event('dns_skipped', 'injected createBot');
      dnsResult = { ok: true, skipped: true, ms: 0, address: null };
    } else {
      dnsResult = await this._preflightDns(Math.min(this.dnsTimeoutMs, timeoutMs));
    }
    if (!dnsResult.ok) {
      return this._failConnect(dnsResult.code || 'DNS_FAILED', dnsResult.error, 'dns', { dnsMs: this.stageTimings.dnsMs });
    }
    this._transition(STATES.TCP_CONNECTING, `connecting to ${this.host}:${this.port}`, { stage: 'tcp', timeoutMs: this.connectTimeoutMs });
    try {
      this.bot = createBot({
        username: this.name,
        host: this.host,
        port: this.port,
        auth: this.auth,
        version: this.version === 'auto' ? undefined : this.version,
        // Bounds the inbound chunk burst at spawn and reconnect. Mineflayer's
        // default is 'far' (12), which is expensive for five bots at once.
        viewDistance: config.server.viewDistance,
        checkTimeoutInterval: config.server.keepAliveMs,
        hideErrors: false,
        // Mineflayer's default logErrors handler console.log()s the raw Error
        // object before our structured logger sees it. Keep the event, drop
        // the duplicate raw dump.
        logErrors: false,
        // Never let mineflayer's own physics fight the deterministic controller loop.
        physicsEnabled: true
      });
    } catch (err) {
      return this._failConnect('CREATE_BOT_FAILED', err.message, 'tcp', { errorName: err.name });
    }
    // A shutdown can land between the loop's last check and createBot(); close
    // the socket immediately rather than letting it outlive the runtime.
    if (this.shuttingDown) {
      await this.disconnect('shutdown');
      return { ok: false, error: 'shutting down', code: 'SHUTDOWN' };
    }
    this.stats.connections++;
    this._attachEvents();
    const tcp = await this.waitForTcp({ timeoutMs: Math.min(this.connectTimeoutMs, timeoutMs) });
    if (!tcp.ok) {
      return this._failConnect(tcp.code || 'TCP_TIMEOUT', tcp.error, 'tcp', { skipped: Boolean(tcp.skipped) });
    }
    const login = await this.waitForLogin({
      timeoutMs: Math.min(this.loginTimeoutMs, timeoutMs),
      configurationTimeoutMs: Math.min(this.configurationTimeoutMs, timeoutMs)
    });
    this.stageTimings.connectMs = this.now() - this.connectStartedAt;
    if (!login.ok) {
      return this._failConnect(login.code || 'LOGIN_TIMEOUT', login.error, login.stage || 'handshake');
    }
    this.stageTimings.loginMs = this.loginAt - this.connectStartedAt;
    if (!this._spawnedThisSession) {
      if (this.connection.state === STATES.AWAITING_SPAWN) {
        this.connection.setStage('spawn', { detail: 'waiting for the first spawn packet', timeoutMs: this.spawnTimeoutMs });
      }
      this.stageStartedAt.spawn = this.stageStartedAt.spawn || this.now();
    }
    const result = await this.waitForSpawn({ timeoutMs: Math.min(this.spawnTimeoutMs, timeoutMs) });
    if (this.stageTimings.spawnMs == null && this.stageStartedAt.spawn) {
      this.stageTimings.spawnMs = this.now() - this.stageStartedAt.spawn;
    }
    if (!result.ok) {
      return this._failConnect(result.code || 'SPAWN_TIMEOUT', result.error, 'spawn', { spawned: result.spawned, authenticated: result.authenticated });
    }
    this.startedAt = this.now();
    this.uptimeMs = 0;
    this.stageStartedAt.auth = this.now();
    this.stageTimings.authMs = 0;
    const auth = await this._handleLoginCommands();
    this.stageTimings.authMs = this.now() - this.stageStartedAt.auth;
    if (auth.ok === false) {
      return this._failConnect(auth.code || 'AUTH_FAILED', auth.error, 'auth', { authFailed: true });
    }
    // Authentication success is monotonic for this session. A respawn packet
    // that arrives later may not undo it.
    this._applySpawnAuth();
    if (!this.ready) {
      return this._failConnect('NOT_READY', this.lastError || 'connection closed before the bot became ready', this.connection.stage);
    }
    this._transition(STATES.READY, 'ready: socket, spawn and authentication verified', { stage: 'ready' });
    result.authenticated = this.authenticated;
    this.lastSessionEndedAt = 0;
    this.stageTimings.totalMs = this.now() - this.connectStartedAt;
    this._startAntiAfk();
    return result;
  }

  /**
   * Resolve a connection failure exactly once. The pre-cleanup snapshot is
   * captured before any boolean is reset and is what the log dump prints.
   */
  async _failConnect(code, error, stage, details = {}) {
    // A kick/error handler can win the race against the pending waiter. Keep
    // the first terminal explanation instead of overwriting it with a
    // downstream timeout.
    if (this.connection.terminal && this.lastDisconnectDumped === this.connection.generation) {
      const failure = this.connection.failure || {};
      return {
        ok: false,
        code: failure.code || code,
        error: failure.error || String(error || 'connection failed'),
        stage: failure.stage || stage,
        sessionId: this.connection.generation,
        elapsedMs: this.connection.elapsedMs(),
        stageTimings: { ...this.stageTimings },
        lastStage: this.connection.stage
      };
    }
    const message = String(error || 'connection failed');
    this.lastError = this._redact(message);
    this.stageTimings.totalMs = this.connectStartedAt ? this.now() - this.connectStartedAt : null;
    const snapshot = this._captureDisconnectSnapshot(`${code}: ${message}`);
    this.connection.fail(code, this.lastError, { stage, details: { ...details, snapshotAt: snapshot.at } });
    this._keepAlive = this._keepAlive || {};
    this._dumpTrace(`${code}: ${message}`, snapshot);
    await this.disconnect(`${code}: ${message}`);
    return {
      ok: false,
      code,
      error: this.lastError,
      stage,
      sessionId: snapshot.generation,
      elapsedMs: this.now() - this.connectStartedAt,
      stageTimings: { ...this.stageTimings },
      lastStage: this.connection.stage,
      spawned: snapshot.spawned,
      authenticated: snapshot.authenticated
    };
  }

  waitForTcp({ timeoutMs = this.connectTimeoutMs } = {}) {
    if (!this.bot || !this.bot._client) {
      // Injected test adapters have no protocol client; the login waiter
      // remains the authoritative timeout for them.
      return Promise.resolve({ ok: true, skipped: true, at: this.now() });
    }
    if (this._pendingConnectionError) {
      return Promise.resolve({ ok: false, code: this._pendingConnectionError.code, error: this._pendingConnectionError.error, stage: 'tcp' });
    }
    if (this._tcpConnected) return Promise.resolve({ ok: true, at: this._tcpAt || this.now() });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._tcpWaiters.delete(waiter);
        resolve(value);
      };
      const waiter = { finish, resolve: finish };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          code: 'TCP_TIMEOUT',
          error: `timed out after ${timeoutMs}ms establishing TCP to ${this.host}:${this.port}`,
          stage: 'tcp'
        });
      }, timeoutMs);
      this._tcpWaiters.add(waiter);
    });
  }

  _markEvent() {
    this.lastEventAt = this.now();
  }

  _attachEvents() {
    const bot = this.bot;
    if (!bot) return;
    const generation = this.connection.generation;
    const owns = () => this.bot === bot && this.connection.isCurrent(generation);
    this._ownsEvent = owns;
    bot.on('login', () => {
      if (!owns()) return;
      this._markEvent();
      this.loginAt = this.now();
      this._loginReceivedAt = this.loginAt;
      this.stageStartedAt.spawn = this.loginAt;
      this.stageTimings.configurationMs = this._configurationAt ? this.loginAt - this._configurationAt : null;
      this.stageTimings.loginMs = this.loginAt - this.connectStartedAt;
      this.stageTimings.connectMs = this.stageTimings.loginMs;
      this.stageStartedAt.handshake = this.stageStartedAt.handshake || this._tcpAt || this.connectStartedAt;
      if (!this._configurationAt) this.stageTimings.handshakeMs = this.loginAt - this.stageStartedAt.handshake;
      if (this.connection.state === STATES.TCP_CONNECTING) {
        this._transition(STATES.HANDSHAKING, 'socket connected; protocol handshake sent', { stage: 'handshake', timeoutMs: this.loginTimeoutMs });
      }
      if (this.connection.state === STATES.HANDSHAKING) {
        this._transition(STATES.CONFIGURATION, 'login success; configuration exchange complete', { stage: 'configuration' });
      }
      this._transition(STATES.AWAITING_SPAWN, 'protocol login accepted; waiting for spawn', { stage: 'spawn', timeoutMs: this.spawnTimeoutMs });
      this.connection.event('login', `protocol=${bot.protocolVersion} version=${bot.version} passwordRequired=${this.passwordRequired}`);
      this.logger.info(`[${this.name}] TRACE login event (protocol=${bot.protocolVersion}, version=${bot.version}, physics=${bot.physicsEnabled}, passwordRequired=${this.passwordRequired}, generation=${generation})`);
      this._installClientTrace();
      if (this.passwordRequired) this._lockMovement();
      this._startClientTicker();
      this.authenticated = !this.passwordRequired;
      for (const waiter of [...this._loginWaiters]) waiter.resolve({ ok: true, at: this.loginAt, stage: 'spawn' });
      this._loginWaiters.clear();
      this.logger.info(`[${this.name}] protocol login accepted with ${this.host}${this.passwordRequired ? '; waiting for password authentication' : ''}`);
    });
    bot.on('spawn', () => {
      if (!owns()) return;
      this._markEvent();
      this.logger.debug(`[${this.name}] TRACE spawn event (position=${bot.entity?.position ? `${bot.entity.position.x.toFixed(3)},${bot.entity.position.y.toFixed(3)},${bot.entity.position.z.toFixed(3)}` : 'none'}, onGround=${bot.entity?.onGround}, locked=${this._movementLock}, state=${this.connection.state})`);
      const manuallySpawned = !this._spawnedThisSession && Boolean(this.spawned);
      const firstSpawn = !this._spawnedThisSession && !this.spawned;
      const respawned = manuallySpawned || this.connection.state === STATES.RESPAWNING || (!firstSpawn && this._respawnPacketSeen);
      if (!firstSpawn && !respawned) {
        // Mineflayer's health plugin can emit a second `spawn` when a positive
        // update_health arrives shortly after the first one. Without a
        // serverbound respawn packet this is a duplicate spawn event, not a
        // death/respawn cycle, and must not reset the session clock or be
        // reported as "respawned".
        this.connection.event('spawn_duplicate', 'spawn event without a respawn packet; not treated as a respawn');
        this.logger.info(`[${this.name}] duplicate spawn event at ${this._vec(bot.entity?.position).x},${this._vec(bot.entity?.position).y},${this._vec(bot.entity?.position).z} (not a respawn: no respawn packet for this session)`);
        this.position = this._vec(bot.entity?.position);
        return;
      }
      this._spawnedThisSession = true;
      this._respawnPacketSeen = false;
      this.spawnAt = this.now();
      this.respawnAttempts = 0;
      if (this._respawnTimer) { clearTimeout(this._respawnTimer); this._respawnTimer = null; }
      this.lastSpawn = {
        at: this.spawnAt,
        respawned,
        position: this._vec(bot.entity?.position),
        health: bot.health,
        food: bot.food,
        dimension: bot.game?.dimension || 'overworld'
      };
      // First spawn: awaiting_spawn -> authenticating/ready. A later spawn
      // after a death comes from respawning. A duplicate spawn while already
      // ready is acknowledged but does not rewrite the lifecycle.
      const target = (this.passwordRequired && !this.authConfirmed) ? STATES.AUTHENTICATING : STATES.READY;
      if (firstSpawn && this.connection.state !== STATES.AWAITING_SPAWN) {
        // Be tolerant of a proxy that omitted the configuration events, but
        // keep the transitions valid by walking through the missing states.
        if (this.connection.state === STATES.HANDSHAKING) this._transition(STATES.AWAITING_SPAWN, 'spawn arrived before login event');
        else if (this.connection.state === STATES.TCP_CONNECTING) {
          this._transition(STATES.HANDSHAKING, 'spawn arrived before connect event');
          this._transition(STATES.AWAITING_SPAWN, 'spawn arrived before login event');
        }
      }
      this._transition(target, firstSpawn ? 'first spawn packet' : 'respawn packet', { stage: target === STATES.READY ? 'ready' : 'auth' });
      this._applySpawnAuth();
      if (!this._clientTicker && this._supportFeature('sendsClientTickEndPacket')) this._startClientTicker();
      this.position = this._vec(bot.entity?.position);
      this.spawnPosition = { ...this.position };
      this.dimension = bot.game?.dimension || 'overworld';
      this._syncInventory();
      this.stageTimings.spawnMs = this.loginAt ? this.spawnAt - this.loginAt : this.spawnAt - this.connectStartedAt;
      this.connection.event('spawn', `position=${this.position.x},${this.position.y},${this.position.z} respawned=${respawned}`);
      // Some proxies emit a second spawn packet after the initial teleport.
      // Keep the event useful without logging two identical "spawned" lines.
      this.logger.info(`[${this.name}] ${firstSpawn ? 'spawned' : 'respawned'} at ${this.position.x},${this.position.y},${this.position.z}`);
      for (const waiter of [...this._spawnWaiters]) waiter.resolve({ ok: true, spawned: true, authenticated: this.authenticated });
      this._spawnWaiters.clear();
    });
    bot.on('move', () => {
      if (this.bot !== bot) return;
      this._markEvent();
      this.position = this._vec(bot.entity?.position);
      this.yaw = bot.entity?.yaw || 0;
      this.pitch = bot.entity?.pitch || 0;
      this.onGround = bot.entity?.onGround;
      if (bot.entity?.velocity) {
        this.velocity = {
          x: Number(bot.entity.velocity.x.toFixed(3)),
          y: Number(bot.entity.velocity.y.toFixed(3)),
          z: Number(bot.entity.velocity.z.toFixed(3))
        };
      }
    });
    bot.on('health', () => {
      if (this.bot !== bot) return;
      this._markEvent();
      const count = Number(this.inventory.totem_of_undying || 0);
      if (bot.health > 0 && count < this._lastTotemCount) {
        this.recordCombatEvent({ at: new Date().toISOString(), type: 'totem_activated', bot: this.name, health: bot.health, detectedBy: 'health-transition' });
      }
      if (Number.isFinite(this._lastHealth) && bot.health < this._lastHealth) {
        this.lastDamageAt = Date.now();
        this.lastDamageAmount = Number((this._lastHealth - bot.health).toFixed(2));
        const near = Object.values(bot.entities || {})
          .filter((entity) => entity && entity !== bot.entity && entity.position && entity.position.distanceTo
            && bot.entity?.position && entity.position.distanceTo(bot.entity.position) <= 12)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null;
        this.lastAttacker = near ? { name: near.name || near.username || near.type || 'unknown', type: near.type || null, distance: Number(near.position.distanceTo(bot.entity.position).toFixed(1)) } : null;
      }
      this._lastHealth = bot.health;
      this._lastTotemCount = count;
      this.health = bot.health;
      this.food = bot.food;
      this.saturation = bot.foodSaturation || 0;
      this.oxygen = bot.oxygenLevel ?? 20;
    });
    bot.on('breath', () => { if (this.bot === bot) this.oxygen = bot.oxygenLevel ?? 20; });
    bot.on('death', () => {
      if (this.bot !== bot) return;
      this._deathCount++;
      this.stats.deaths++;
      this.deaths = this._deathCount;
      const at = Date.now();
      const environment = this._captureEnvironment();
      const confidence = this.lastDeathMessage ? 'confirmed' : this.lastAttacker ? 'likely' : 'unknown';
      const cause = this.lastAttacker
        ? `${this.lastAttacker.name}${this.lastAttacker.distance !== undefined ? ` (${this.lastAttacker.distance}m)` : ''}`
        : this.lastDeathMessage || 'unknown damage source';
      this.lastDeath = {
        at,
        position: { ...this.position },
        cause,
        confidence,
        summary: `Died at ${Math.round(this.position.x)},${Math.round(this.position.y)},${Math.round(this.position.z)}: ${cause}`,
        healthBefore: Number.isFinite(this._lastHealth) ? this._lastHealth : null,
        food: this.food,
        saturation: this.saturation,
        lastDamageAt: this.lastDamageAt || null,
        lastDamageAmount: this.lastDamageAmount || null,
        attacker: this.lastAttacker || null,
        message: this.lastDeathMessage || null,
        dimension: this.dimension || 'overworld',
        velocity: this.velocity || null,
        onGround: this.onGround ?? null,
        equipment: this._equipmentSummary(),
        environment
      };
      this.deathHistory.push(this.lastDeath);
      if (this.deathHistory.length > 40) this.deathHistory.shift();
      this.lastDeathMessage = null;
      this.logger.warn(`[${this.name}] died at ${this.position.x},${this.position.y},${this.position.z} (cause: ${cause})`);
      // A dead entity must not keep an old pathfinder goal or attack target.
      try { this.bot.pathfinder?.stop?.(); } catch (_) { /* optional */ }
      try { this.bot.stopDigging?.(); } catch (_) { /* optional */ }
      try { this.bot.clearControlStates?.(); } catch (_) { /* optional */ }
      this.target = null;
      // Mineflayer does not always send client_command on its own. Ask the
      // server for the respawn screen once, then once more if the first packet
      // was lost. The spawn handler clears the timer, so this cannot loop.
      this._scheduleRespawn();
    });
    bot.on('kicked', (reason) => {
      if (!owns()) return;
      this.lastError = this._redact(this._formatKickReason(reason));
      const kick = classifyKick(this.lastError);
      this.kickKind = kick.kind;
      if (kick.pauseRetries) this.retryPaused = true;
      if (this.spawned && this.authenticated) this.lastSessionEndedAt = this.now();
      this._stopAntiAfk();
      this._stopClientTicker(`kicked: ${kick.kind}`);
      const snapshot = this._captureDisconnectSnapshot(`kicked (${kick.label}): ${this.lastError}`);
      this.connection.fail('KICKED', this.lastError, { stage: this.connection.stage, details: { kickKind: kick.kind, label: kick.label } });
      this.logger.warn(`[${this.name}] kicked (${kick.label}): ${this.lastError}`);
      this.lastDisconnectDumped = snapshot.generation;
      this._dumpTrace(`kicked: ${this.lastError}`, snapshot);
      this._abortAuth(this.lastError);
      this._failTcpWaiters(this.lastError, 'KICKED');
      this._failLoginWaiters(this.lastError, 'KICKED');
      this._failSpawnWaiters(this.lastError, 'KICKED');
      if (kick.pauseRetries) {
        this.logger.error(`[${this.name}] automatic retries paused after ${kick.kind} kick; an explicit dashboard reconnect is required`);
      }
      if (/invalid move player packet/i.test(this.lastError)) {
        this.logger.warn(`[${this.name}] server rejected a movement packet; set MC_VERSION to the server's exact version before relying on live movement`);
      }
      // The lifecycle is already terminal and its end event is ignored by the
      // generation gate. Close the library client explicitly so a kicked bot
      // cannot keep timers or a half-open socket alive until reconnect.
      try { bot.quit('kicked'); } catch (_) { /* already gone */ }
    });
    bot.on('error', (err) => {
      if (!owns()) return;
      this.lastError = this._redact(err.message);
      this._pendingConnectionError = { error: this.lastError, code: err.code || 'CONNECTION_ERROR', at: this.now() };
      this.logger.error(`[${this.name}] connection error${err.code ? ` (${err.code})` : ''}: ${this.lastError}`);
      this.connection.event('connection_error', `${err.code || ''} ${this.lastError}`.trim());
      this._captureDisconnectSnapshot(`connection error${err.code ? ` (${err.code})` : ''}: ${this.lastError}`);
      this._abortAuth(this.lastError);
      this._failTcpWaiters(this.lastError);
      this._failLoginWaiters(this.lastError);
      this._failSpawnWaiters(this.lastError);
    });
    if (bot._client && typeof bot._client.on === 'function') {
      const client = bot._client;
      const markTcp = () => {
        if (!owns() || this._tcpConnected) return;
        this._tcpConnected = true;
        this._tcpAt = this.now();
        this.stageTimings.tcpMs = this._tcpAt - (this.stageStartedAt.tcp || this.connectStartedAt);
        this.stageStartedAt.handshake = this._tcpAt;
        this.connection.setStage('handshake', { detail: 'TCP connected; sending handshake', timeoutMs: this.loginTimeoutMs });
        if (this.connection.state === STATES.TCP_CONNECTING) {
          this._transition(STATES.HANDSHAKING, 'TCP connected; handshake sent', { stage: 'handshake', timeoutMs: this.loginTimeoutMs });
        }
        this.connection.event('tcp_connected', `${this.host}:${this.port} in ${this.stageTimings.tcpMs}ms`);
        for (const waiter of [...this._tcpWaiters]) waiter.resolve({ ok: true, at: this._tcpAt, elapsedMs: this.stageTimings.tcpMs });
        this._tcpWaiters.clear();
      };
      const attachSocket = (socket) => {
        if (!owns()) return;
        if (!socket) return markTcp();
        if (socket.readyState === 'open' || (socket.connecting === false && !socket.destroyed)) return markTcp();
        socket.once('connect', markTcp);
        socket.once('error', (err) => {
          if (!owns()) return;
          this._failTcpWaiters(`TCP socket error: ${err.message}`, 'TCP_ERROR');
        });
      };
      // `client.connect` fires when the library has created (or adopted) the
      // socket, after its DNS/SRV step. Actual TCP readiness is the socket's
      // own connect event. Attach both now and on the library event so a
      // synchronous stream adapter cannot race past us.
      client.once('connect', () => attachSocket(client.socket));
      if (client.socket) attachSocket(client.socket);
      client.on('start_configuration', () => {
        if (!owns()) return;
        this._configurationAt = this.now();
        this.stageTimings.handshakeMs = this._configurationAt - (this.stageStartedAt.handshake || this._tcpAt || this.connectStartedAt);
        this.stageStartedAt.configuration = this._configurationAt;
        this._stopClientTicker('re-entering configuration');
        if (this.connection.state === STATES.TCP_CONNECTING) this._transition(STATES.HANDSHAKING, 'configuration requested before connect event', { stage: 'handshake' });
        if (this.connection.state === STATES.HANDSHAKING) {
          this._transition(STATES.CONFIGURATION, 'server configuration exchange', { stage: 'configuration', timeoutMs: this.configurationTimeoutMs });
        }
        this._armLoginWaiters('configuration', this.configurationTimeoutMs);
        this.connection.event('start_configuration', 'configuration state entered');
      });
      client.on('finish_configuration', () => {
        if (!owns()) return;
        this.connection.event('finish_configuration', 'configuration acknowledged by the server');
        if (!this._clientTicker && String(client.state || '').toLowerCase() === 'play') this._startClientTicker();
      });
      client.on('set_ticking_state', (packet = {}) => {
        if (!owns()) return;
        // 26.1 names these fields tick_rate/is_frozen on the wire. Accept the
        // camelCase aliases too so older minecraft-data schemas work.
        const tickRate = packet.tick_rate ?? packet.tickRate;
        const isFrozen = packet.is_frozen ?? packet.isFrozen;
        this._serverTickingState = { tickRate, isFrozen };
        if (this._clientTicker) this._clientTicker.setTickingState({ tickRate, isFrozen });
        this.connection.event('set_ticking_state', `rate=${tickRate} frozen=${isFrozen}`);
      });
      client.on('step_tick', (packet = {}) => {
        if (!owns()) return;
        const steps = packet.tick_steps ?? packet.tickSteps ?? packet.steps ?? packet.ticks ?? 0;
        if (this._clientTicker) this._clientTicker.stepTicks(steps);
        this.connection.event('step_tick', `steps=${steps}`);
      });
      client.on('keep_alive', () => {
        if (!owns()) return;
        this._markEvent();
        const at = this.now();
        if (this._keepAlive.lastReceivedAt) {
          this._keepAlive.maxGapMs = Math.max(this._keepAlive.maxGapMs, at - this._keepAlive.lastReceivedAt);
        }
        this._keepAlive.received += 1;
        this._keepAlive.lastReceivedAt = at;
        this.connection.event('keep_alive', 'received; minecraft-protocol replies automatically');
        this.logger.debug(`[${this.name}] TRACE keep_alive received; minecraft-protocol replies automatically`);
      });
      client.on('position', (packet) => {
        if (!owns()) return;
        this.lastServerPosition = {
          x: Number.isFinite(packet.x) ? Number(packet.x.toFixed(3)) : packet.x,
          y: Number.isFinite(packet.y) ? Number(packet.y.toFixed(3)) : packet.y,
          z: Number.isFinite(packet.z) ? Number(packet.z.toFixed(3)) : packet.z,
          yaw: packet.yaw,
          pitch: packet.pitch,
          flags: packet.flags,
          teleportId: packet.teleportId
        };
        this.logger.debug(`[${this.name}] TRACE in position x=${packet.x} y=${packet.y} z=${packet.z} yaw=${packet.yaw} pitch=${packet.pitch} flags=${JSON.stringify(packet.flags)} teleportId=${packet.teleportId}`);
      });
      client.on('respawn', () => {
        if (!owns()) return;
        this._respawnPacketSeen = true;
        this.connection.event('respawn', 'server respawn packet');
        if (this.passwordRequired && !this.authConfirmed) this._transition(STATES.AUTHENTICATING, 'respawn while authentication is pending', { stage: 'auth' });
        else this._transition(STATES.RESPAWNING, 'server respawn packet; waiting for spawn', { stage: 'spawn' });
        this.logger.debug(`[${this.name}] TRACE in respawn`);
      });
      client.on('update_health', (packet) => {
        if (owns()) this.logger.debug(`[${this.name}] TRACE in update_health health=${packet.health} food=${packet.food}`);
      });
      client.on('packet', (data, meta) => {
        if (!owns()) return;
        this._markEvent();
        if (!meta) return;
        if (['kick_disconnect', 'system_chat', 'player_loaded', 'start_configuration', 'login'].includes(meta.name)) {
          this.logger.debug(`[${this.name}] TRACE in packet ${meta.name} ${this._redact(JSON.stringify(data).slice(0, 600))}`);
        }
      });
    }
    bot.on('end', (reason) => {
      if (!owns()) return;
      if (this.spawned && this.authenticated) this.lastSessionEndedAt = this.now();
      this._stopAntiAfk();
      this._stopClientTicker(`end: ${reason || 'end'}`);
      const detail = this.lastError && this.lastError !== reason ? `${reason || 'end'}: ${this.lastError}` : (reason || 'end');
      const snapshot = this._captureDisconnectSnapshot(`end: ${detail}`);
      if (!this.connection.terminal) {
        this.connection.close(this._redact(String(detail)));
      }
      this.logger.warn(`[${this.name}] disconnected: ${this._redact(detail)}`);
      if (!this.lastDisconnectDumped || this.lastDisconnectDumped !== snapshot.generation) {
        this.lastDisconnectDumped = snapshot.generation;
        this._dumpTrace(`end: ${detail}`, snapshot);
      }
      this._abortAuth(this.lastError || `connection closed (${reason || 'end'})`);
      this._failTcpWaiters(this.lastError || `connection closed (${reason || 'end'})`);
      this._failLoginWaiters(this.lastError || `connection closed (${reason || 'end'})`);
      this._failSpawnWaiters(this.lastError || `connection closed (${reason || 'end'})`);
    });
    bot.on('message', (message) => {
      if (this.bot !== bot) return;
      this._markEvent();
      const text = message.toString();
      const safe = this._redact(text);
      const plain = String(text || '').replace(/\u00a7./g, '').trim();
      if (this.name && plain.includes(this.name) && /(slain|killed|shot|blown up|burned|burn|drowned|fell|withered|starved|suffocat|died|death|magic|fireball|pummeled|impaled|stung|frozen)/i.test(plain)) {
        this.lastDeathMessage = plain.slice(0, 240);
      }
      this.logger.debug(`[${this.name}] TRACE chat: ${safe}`);
      // Only the redacted text is retained. Auth listeners still receive the
      // raw chat line locally so login confirmation parsing keeps working.
      this._chatLog.push({ at: Date.now(), text: safe });
      if (this._chatLog.length > 200) this._chatLog.shift();
      for (const listener of this._chatListeners) listener(text);
    });
  }

  /**
   * A compact, real snapshot of the death environment. Block reads are bounded
   * and best-effort: a failed read is absent evidence, never an invented cause.
   */
  _captureEnvironment() {
    const position = this.position;
    if (!position || typeof this.getBlock !== 'function') {
      return { blocks: null, hazards: [], flags: { onGround: this.onGround ?? null, oxygen: this.oxygen ?? null } };
    }
    const blockAt = (dx, dy, dz) => {
      try {
        const block = this.getBlock({ x: Math.floor(position.x) + dx, y: Math.floor(position.y) + dy, z: Math.floor(position.z) + dz });
        return block && block.name ? String(block.name).replace(/^minecraft:/, '') : null;
      } catch (_) { return null; }
    };
    const blocks = {
      feet: blockAt(0, 0, 0),
      head: blockAt(0, 1, 0),
      below: blockAt(0, -1, 0)
    };
    const names = Object.values(blocks).filter(Boolean);
    const hazards = [];
    if (names.some((name) => name.includes('lava'))) hazards.push('lava');
    if (names.some((name) => name === 'fire' || name === 'soul_fire')) hazards.push('fire');
    if (names.some((name) => name.includes('water'))) hazards.push('water');
    if (blocks.head && !/(air|water|grass|fern|flower|torch|sign|vine)/.test(blocks.head)) hazards.push('suffocation');
    if (this.onGround === false) hazards.push('falling');
    return {
      blocks,
      hazards,
      flags: {
        onGround: this.onGround ?? null,
        oxygen: this.oxygen ?? null,
        food: this.food ?? null,
        saturation: this.saturation ?? null,
        health: this.health ?? null,
        onFire: Boolean(this.onFire),
        inLava: Boolean(this.inLava)
      }
    };
  }

  _equipmentSummary() {
    const worn = [];
    const slots = this.bot && this.bot.inventory && this.bot.inventory.slots;
    if (slots) {
      for (const [slot, label] of [[5, 'head'], [6, 'torso'], [7, 'legs'], [8, 'feet']]) {
        if (slots[slot] && slots[slot].name) worn.push({ slot: label, item: slots[slot].name, durability: this.itemMeta?.[slots[slot].name]?.durability ?? null });
      }
    }
    return {
      held: this.equipment?.heldItem || this.heldItem || null,
      offhand: typeof this.getOffhand === 'function' ? this.getOffhand() : null,
      armor: worn,
      toolTiers: {
        pickaxe: this.equipment?.pickaxe ?? null,
        axe: this.equipment?.axe ?? null,
        shovel: this.equipment?.shovel ?? null,
        sword: this.equipment?.sword ?? null
      }
    };
  }

  /**
   * Ask for a respawn when the server leaves the bot on the death screen.
   * Bounded to two attempts; a live spawn event cancels the timer.
   */
  _scheduleRespawn(delayMs = 1500) {
    if (this._respawnTimer) clearTimeout(this._respawnTimer);
    this._respawnTimer = setTimeout(async () => {
      this._respawnTimer = null;
      if (!this.bot || !this.connected || this.health > 0 || this.spawned && this.lastSpawn && this.lastSpawn.at > (this.lastDeath?.at || 0)) return;
      if (this.respawnAttempts >= 2) {
        this.logger.warn(`[${this.name}] still dead after ${this.respawnAttempts} respawn requests; waiting for the server`);
        return;
      }
      this.respawnAttempts++;
      this.lastRespawnAt = Date.now();
      try {
        const result = await this.respawn();
        this.logger.info(`[${this.name}] requested respawn (attempt ${this.respawnAttempts})${result.ok === false ? `: ${result.error}` : ''}`);
      } catch (err) {
        this.logger.warn(`[${this.name}] respawn request failed: ${err.message}`);
      }
      if (this.health <= 0 && this.respawnAttempts < 2) this._scheduleRespawn(3000);
    }, delayMs);
    if (this._respawnTimer.unref) this._respawnTimer.unref();
  }

  _formatKickReason(reason) {
    if (typeof reason === 'string') return reason;
    const parts = [];
    const visit = (node) => {
      if (!node) return;
      if (typeof node === 'string') { parts.push(node); return; }
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node !== 'object') return;
      if (typeof node.text === 'string') parts.push(node.text);
      if (node.extra !== undefined) visit(node.extra);
      if (node.value !== undefined) visit(node.value);
    };
    visit(reason);
    const text = parts.join('').trim();
    return text || JSON.stringify(reason);
  }

  _vec(position) {
    if (!position) return { ...this.position };
    return { x: Number(position.x.toFixed(3)), y: Number(position.y.toFixed(3)), z: Number(position.z.toFixed(3)) };
  }

  waitForLogin({ timeoutMs = this.loginTimeoutMs, configurationTimeoutMs = this.configurationTimeoutMs } = {}) {
    if (this.loginAt) return Promise.resolve({ ok: true, already: true, loginAt: this.loginAt });
    if (this._pendingConnectionError) {
      return Promise.resolve({ ok: false, code: this._pendingConnectionError.code, error: this._pendingConnectionError.error, stage: this.connection.stage });
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let stage = this.connection.state === STATES.CONFIGURATION ? 'configuration' : 'handshake';
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._loginWaiters.delete(waiter);
        resolve(value);
      };
      const arm = (nextStage, budget) => {
        if (settled) return;
        if (nextStage) stage = nextStage;
        clearTimeout(timer);
        const at = this.now();
        timer = setTimeout(() => {
          finish({
            ok: false,
            code: stage === 'configuration' ? 'CONFIGURATION_TIMEOUT' : 'LOGIN_TIMEOUT',
            error: `timed out after ${budget}ms in ${stage} stage waiting for protocol login`,
            stage,
            elapsedMs: this.now() - at
          });
        }, budget);
      };
      const waiter = {
        stage,
        resolve: finish,
        arm: (nextStage, budget = configurationTimeoutMs) => arm(nextStage, budget)
      };
      this._loginWaiters.add(waiter);
      arm(stage, timeoutMs);
    });
  }

  waitForSpawn({ timeoutMs = this.spawnTimeoutMs } = {}) {
    // A password-required bot is spawned but not *ready* until /login is
    // confirmed. The spawn event can arrive before this waiter is registered
    // (the login waiter resolves in the same turn), so checking `ready` here
    // made the adapter wait the whole spawn timeout despite a valid spawn.
    if (this._spawnedThisSession && this.spawned) {
      return Promise.resolve({ ok: true, spawned: true, authenticated: this.authenticated });
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._spawnWaiters.delete(waiter);
        resolve(value);
      };
      const waiter = { resolve: finish };
      const startedAt = this.now();
      const arm = () => {
        timer = setTimeout(() => {
          this.lastError = this.lastError || 'timed out waiting for spawn';
          finish({
            ok: false,
            code: 'SPAWN_TIMEOUT',
            error: `timed out after ${timeoutMs}ms waiting for spawn`,
            stage: 'spawn',
            elapsedMs: this.now() - startedAt,
            spawned: this.spawned,
            authenticated: this.authenticated
          });
        }, timeoutMs);
      };
      this._spawnWaiters.add(waiter);
      arm();
    });
  }

  /** Send one auth command and wait for the server's chat confirmation. */
  _sendAuthCommand(command, kind) {
    const success = kind === 'register'
      ? /successfully registered|registration (?:successful|complete)|you are now registered|already registered|now logged in|successfully logged in|already logged in|login successful/i
      : /successfully logged in|you are now logged in|now logged in|already logged in|welcome back|logged in successfully|login successful|logged in\.?$/i;

    const failure = /wrong password|incorrect password|invalid password|password (?:is )?(?:wrong|incorrect)|not registered|please register|register first|too many (?:attempts|tries)|kicked/i;
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        this._authWaiters.delete(finish);
        resolve(value);
      };
      const off = this.onChat((text) => {
        const clean = String(text || '').replace(/\u00a7./g, '').trim();
        if (success.test(clean)) finish({ ok: true, kind, message: clean, alreadyRegistered: /already registered/i.test(clean) });
        else if (failure.test(clean)) finish({ ok: false, error: clean, kind });
      });
      this._authWaiters.add(finish);
      timer = setTimeout(() => finish({ ok: false, code: 'AUTH_TIMEOUT', error: `timed out after ${this.authTimeoutMs}ms waiting for ${kind} confirmation from the server`, kind }), this.authTimeoutMs);
      this.logger.debug(`[${this.name}] auth ${kind}: sending command (password redacted), timeout=${this.authTimeoutMs}ms`);
      try {
        this.bot.chat(command);
      } catch (err) {
        finish({ ok: false, code: 'AUTH_SEND_FAILED', error: err.message, kind });
      }
    });
  }

  async _handleLoginCommands() {
    if (!this.passwordRequired) {
      this.authenticated = true;
      return { ok: true, required: false };
    }
    if (!this.bot || !this.connected || !this.spawned) return { ok: false, code: 'AUTH_DISCONNECTED', error: 'cannot authenticate before spawn' };
    // Freeze movement until the password is accepted. physicsEnabled alone is
    // not enough: mineflayer's updatePosition() keeps sending packets.
    this._lockMovement();
    if (this.bot.clearControlStates) this.bot.clearControlStates();
    this.bot.physicsEnabled = false;
    await sleep(this.authDelayMs);
    if (!this.connected || !this.spawned) return { ok: false, code: 'AUTH_DISCONNECTED', error: this.lastError || 'disconnected before password authentication' };

    let registered = false;
    // Existing accounts are login-only. Registration is opt-in because every
    // bot already has an account; /register only earns "already registered".
    if (this.registerPassword && this.registerOnFirstJoin && !this.hasRegistered) {
      this.logger.info(`[${this.name}] first join: sending /register (password hidden)`);
      const command = config.server.registerCommand.replace(/\{password\}/g, this.registerPassword);
      const result = await this._sendAuthCommand(command, 'register');
      if (!result.ok) return result;
      this.hasRegistered = true;
      registered = !result.alreadyRegistered;
      if (result.alreadyRegistered && !this.loginPassword) {
        return { ok: false, error: 'account is already registered; set MC_LOGIN_PASSWORD', kind: 'register' };
      }
    } else if (this.registerPassword && this.hasRegistered && !this.loginPassword) {
      return { ok: false, error: 'account is already registered; set MC_LOGIN_PASSWORD for reconnects', kind: 'login' };
    }
    if (!this.connected || !this.spawned) return { ok: false, code: 'AUTH_DISCONNECTED', error: this.lastError || 'disconnected before password authentication' };
    if (!this.loginPassword) {
      return { ok: false, error: 'no login password configured; set MC_LOGIN_PASSWORD', kind: 'login' };
    }
    if (this.loginPassword) {
      const command = config.server.loginCommand.replace(/\{password\}/g, this.loginPassword);
      let result = await this._sendAuthCommand(command, 'login');
      // Existing accounts are login-only. A brand-new account (or one that was
      // never created) answers "You are not registered."; create it once and
      // retry the login instead of retrying forever.
      if (!result.ok && this.registerPassword && /not registered|please register|register first/i.test(result.error || '')) {
        this.logger.info(`[${this.name}] login says not registered; sending /register once, then /login`);
        const registerCommand = config.server.registerCommand.replace(/\{password\}/g, this.registerPassword);
        const created = await this._sendAuthCommand(registerCommand, 'register');
        if (!created.ok) return created;
        this.hasRegistered = true;
        registered = !created.alreadyRegistered;
        result = await this._sendAuthCommand(command, 'login');
      }
      if (!result.ok) return result;
    }
    if (!this.connected || !this.spawned) return { ok: false, code: 'AUTH_DISCONNECTED', error: this.lastError || 'disconnected before password confirmation' };
    this.authenticated = true;
    this.authConfirmed = true;
    this.lastError = null;
    this.kickKind = null;
    if (this.connection.state === STATES.AUTHENTICATING) {
      this._transition(STATES.READY, 'password authentication confirmed', { stage: 'ready' });
    }
    // Report the confirmation before releasing the held movement packets: the
    // previous order made the log read as if movement was released first.
    this.logger.info(`[${this.name}] password authentication confirmed${registered ? ' (registered)' : ''}`);
    this._unlockMovement();
    if (this.bot) this.bot.physicsEnabled = true;
    return { ok: true, required: true, registered };
  }

  // ------------------------------------------------------------------
  // World access
  // ------------------------------------------------------------------
  get world() { return this.worldView || (this.worldView = this._makeWorldView()); }

  set world(value) { this.worldView = value; }

  _makeWorldView() {
    const self = this;
    return {
      getBlock(pos) {
        const block = self._blockAt(pos);
        return block ? { name: block.name, position: { ...pos } } : { name: 'air', position: { ...pos } };
      },
      setBlock() { throw new Error('RealBot cannot set blocks directly; use placeBlock'); },
      surfaceY(x, z, from = 320) {
        for (let y = from; y > -64; y--) {
          const block = self.bot.blockAt(self._vec3(x, y, z));
          if (block && block.boundingBox !== 'empty') return y + 1;
        }
        return 63;
      },
      get entities() { return self.entities; },
      get time() { return self.time.timeOfDay; },
      setTime() { throw new Error('cannot set world time'); }
    };
  }

  _vec3(x, y, z) {
    const Vec3 = (this._mineflayer && this._mineflayer.Vec3) || (this._createBot && this._createBot.Vec3);
    if (Vec3) return new Vec3(x, y, z);
    const vec3 = require('vec3');
    return vec3(x, y, z);
  }

  _blockAt(pos) {
    if (!this.bot || !this.bot.world || !this.bot.entity) return null;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;
    const k = `${pos.x},${pos.y},${pos.z}`;
    if (this._blockCache.has(k)) return this._blockCache.get(k);
    const block = this.bot.blockAt(this._vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
    if (this._blockCache.size > 4000) this._blockCache.clear();
    this._blockCache.set(k, block);
    return block;
  }

  getBlock(pos) {
    const block = this._blockAt(pos);
    // An unloaded chunk is unknown, not air. Reporting it as air would let a
    // build engine plan placements against terrain it has never seen.
    if (!block) return { name: 'unloaded', properties: {}, position: { x: pos.x, y: pos.y, z: pos.z } };
    let properties = {};
    try {
      if (typeof block.getProperties === 'function') properties = block.getProperties() || {};
      else if (block.properties) properties = { ...block.properties };
    } catch (err) { properties = {}; }
    let stateId = null;
    try { if (typeof block.getStateId === 'function') stateId = block.getStateId(); } catch (err) { stateId = null; }
    return { name: block.name, properties, stateId, position: { x: pos.x, y: pos.y, z: pos.z } };
  }

  get entities() {
    if (!this.bot) return [];
    const out = [];
    for (const entity of Object.values(this.bot.entities || {})) {
      if (!entity || entity === this.bot.entity || !entity.position) continue;
      out.push({
        id: entity.id,
        name: entity.name || entity.username || 'unknown',
        username: entity.username,
        type: entity.type,
        kind: entity.kind,
        hostile: Boolean(entity.username ? false : HOSTILE.has(entity.name)),
        position: this._vec(entity.position),
        health: entity.health
      });
    }
    return out;
  }

  get time() {
    const timeOfDay = this.bot?.time?.timeOfDay ?? 0;
    return { timeOfDay, day: this.bot?.time?.day ?? 1 };
  }

  entitiesNear(radius = 16, position = this.position) {
    return this.entities
      .filter((entity) => entity.alive !== false && entity.position && distance(entity.position, position) <= radius)
      .map((entity) => ({
        id: entity.id,
        type: entity.type,
        kind: entity.kind,
        name: entity.name || entity.username || entity.type,
        username: entity.username,
        position: { ...entity.position },
        health: entity.health,
        hostile: Boolean(entity.hostile),
        blocking: Boolean(entity.usingItem || entity.blocking),
        equipment: Array.isArray(entity.equipment) ? entity.equipment.filter(Boolean).map((item) => item.name || item) : [],
        heldItem: entity.heldItem ? (entity.heldItem.name || entity.heldItem) : null
      }));
  }

  threatsNear(position = this.position, radius = 8) {
    return this.entitiesNear(radius, position).filter((entity) => entity.hostile).length;
  }

  nearestThreat(position = this.position) {
    const list = this.entitiesNear(24, position).filter((entity) => entity.hostile);
    if (!list.length) return null;
    return list.sort((a, b) => distance(a.position, position) - distance(b.position, position))[0];
  }

  _assertReady() {
    if (!this.ready) {
      const error = `bot ${this.name} is not ready (connected=${this.connected}, authenticated=${this.authenticated}, spawned=${this.spawned})`;
      return { ok: false, error };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Inventory
  // ------------------------------------------------------------------
  _potionEffect(item) {
    if (!item || !/potion$/.test(String(item.name || ''))) return null;
    const nbt = item.nbt && (item.nbt.value || item.nbt);
    const raw = nbt && (nbt.Potion || nbt.potion);
    const value = raw && typeof raw === 'object' ? (raw.value ?? raw) : raw;
    return value ? String(value).replace(/^minecraft:/, '') : null;
  }

  /**
   * Mineflayer knows the real slot layout. The aggregate inventory map cannot
   * distinguish one full stack from two partial ones, so use the window slots
   * when they are available (9..44 are the 36 storage slots).
   */
  isInventoryFull(limit = 36) {
    const slots = this.bot && this.bot.inventory ? this.bot.inventory.slots : null;
    if (Array.isArray(slots)) {
      let used = 0;
      for (let i = 9; i < 45; i++) if (slots[i]) used++;
      if (used > 0) return used >= limit;
    }
    return super.isInventoryFull(limit);
  }

  inventorySlots(capacity = 36) {
    const slots = this.bot && this.bot.inventory ? this.bot.inventory.slots : null;
    if (Array.isArray(slots)) {
      let used = 0;
      for (let i = 9; i < 45; i++) if (slots[i]) used++;
      return { used, free: Math.max(0, capacity - used), capacity, overflow: Math.max(0, used - capacity) };
    }
    return super.inventorySlots(capacity);
  }

  _syncInventory() {
    if (!this.bot || !this.bot.inventory) return;
    const counts = {};
    const meta = {};
    this._itemAliases = new Map();
    const record = (item) => {
      if (!item || !item.name) return;
      let name = item.name;
      const potion = this._potionEffect(item);
      if (potion) {
        const prefix = name.startsWith('splash_') ? 'splash_' : name.startsWith('lingering_') ? 'lingering_' : '';
        name = `${prefix}potion_of_${potion}`;
        this._itemAliases.set(name, item);
      }
      counts[name] = (counts[name] || 0) + (item.count || 1);
      const enchants = {};
      for (const entry of item.enchants || []) {
        const effectName = typeof entry.name === 'string' ? entry.name : (entry.name && entry.name.name) || entry.name;
        if (effectName) enchants[effectName] = entry.lvl || entry.level || 1;
      }
      meta[name] = {
        durability: item.durabilityUsed !== undefined && item.maxDurability ? item.maxDurability - item.durabilityUsed : item.durability,
        maxDurability: item.maxDurability || undefined,
        enchantments: enchants
      };
      if (potion) meta[name].effect = potion;
    };
    for (const item of this.bot.inventory.items()) record(item);
    // `inventory.items()` covers the main inventory and hotbar only. Armour
    // slots (5-8) and the offhand (45) are part of what the bot actually owns,
    // so include them or the controller would think equipped gear disappeared.
    for (const index of [5, 6, 7, 8, 45]) {
      const item = this.bot.inventory.slots && this.bot.inventory.slots[index];
      if (item) record(item);
    }
    this.inventory = counts;
    this.itemMeta = meta;
    this._lastTotemCount = Number(counts.totem_of_undying || 0);
    this.uptimeMs = this.startedAt ? Date.now() - this.startedAt : 0;
    this._updateEquipmentFromBot();
  }

  refreshInventory() { this._syncInventory(); return { ok: true, items: Object.keys(this.inventory).length }; }

  getOffhand() {
    if (!this.bot || !this.bot.inventory) return null;
    const slot = this.bot.inventory.slots && this.bot.inventory.slots[45];
    return slot ? slot.name : null;
  }

  async equipArmor(pieces = []) {
    const check = this._assertReady();
    if (check) return check;
    this._syncInventory();
    const equipped = [];
    const destinations = { head: 'head', torso: 'torso', legs: 'legs', feet: 'feet' };
    const armorSlot = { head: 5, torso: 6, legs: 7, feet: 8 };
    for (const piece of pieces || []) {
      if (!piece || !piece.name) continue;
      const currentlyWorn = this.bot.inventory.slots && this.bot.inventory.slots[armorSlot[piece.slot]];
      if (currentlyWorn && currentlyWorn.name === piece.name) { equipped.push(piece.name); continue; }
      const item = this._findItem(piece.name, { includeEquipped: true });
      if (!item) continue;
      try {
        await this.bot.equip(item, destinations[piece.slot] || 'torso');
        equipped.push(piece.name);
      } catch (_) { /* leave the slot unchanged rather than dropping gear */ }
    }
    this._syncInventory();
    return { ok: equipped.length > 0, pieces: equipped };
  }

  recordCombatEvent(event) {
    this.combatEvents.push(event);
    if (this.combatEvents.length > 200) this.combatEvents.shift();
    return true;
  }

  drainCombatEvents() { return this.combatEvents.splice(0); }

  async strafe(direction = 'left', { durationMs = 120 } = {}) {
    if (!this.bot || !this.ready) return { ok: false, error: 'not ready' };
    const control = direction === 'left' ? 'left' : 'right';
    this.bot.setControlState(control, true);
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(30, durationMs))));
    this.bot.setControlState(control, false);
    this.position = this._vec(this.bot.entity?.position);
    return { ok: true, direction, position: { ...this.position } };
  }

  _updateEquipmentFromBot() {
    const held = this.bot?.heldItem;
    if (!held) return;
    this.equipment = {
      ...this.equipment,
      heldItem: held.name,
      pickaxe: toolTier(held.name, 'pickaxe'),
      axe: toolTier(held.name, 'axe'),
      shovel: toolTier(held.name, 'shovel'),
      sword: toolTier(held.name, 'sword')
    };
  }

  _findItem(name, { includeEquipped = false } = {}) {
    if (!this.bot) return null;
    if (this._itemAliases && this._itemAliases.has(name)) return this._itemAliases.get(name);
    const found = this.bot.inventory.items().find((item) => item.name === name);
    if (found || !includeEquipped) return found || null;
    for (const index of [5, 6, 7, 8, 45]) {
      const item = this.bot.inventory.slots && this.bot.inventory.slots[index];
      if (item && item.name === name) return item;
    }
    return null;
  }

  async equipBestTool(category) {
    const check = this._assertReady();
    if (check) return check;
    this._syncInventory();
    const choice = this.bestToolFor(category);
    if (!choice) return { ok: false, error: `no ${category} available` };
    const item = this._findItem(choice.name);
    if (!item) return { ok: false, error: `no ${choice.name} in inventory` };
    await this.bot.equip(item, 'hand');
    this._updateEquipmentFromBot();
    return { ok: true, tool: choice.name };
  }

  async tillSoil(pos) {
    const check = this._assertReady();
    if (check) return check;
    const block = this._blockAt(pos);
    if (!block) return { ok: false, error: 'soil position is unloaded' };
    if (block.name === 'farmland') return { ok: true, already: true, position: { ...pos } };
    if (!TILLABLE.has(block.name)) return { ok: false, error: `${block.name} cannot be tilled` };
    const equip = await this.equipBestTool('hoe');
    if (!equip.ok) return equip;
    if (distance(this.position, pos) > 5) {
      const move = await this.goTo(pos, { range: 4, timeoutMs: 12000 });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach soil' };
    }
    if (typeof this.bot.activateBlock !== 'function') return { ok: false, error: 'mineflayer does not expose activateBlock' };
    try {
      try { await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true); } catch (_) { /* look is best-effort */ }
      await this.bot.activateBlock(block);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    let after = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(attempt === 0 ? 250 : 350);
      this._blockCache.delete(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
      after = this._blockAt(pos);
      if (after && after.name === 'farmland') break;
    }
    if (!after || after.name !== 'farmland') return { ok: false, error: `tilling left ${after ? after.name : 'unknown'} instead of farmland` };
    this.stats.tilled = (this.stats.tilled || 0) + 1;
    return { ok: true, position: { ...pos }, block: 'farmland', tool: equip.tool };
  }

  async feed(animal, itemName) {
    const check = this._assertReady();
    if (check) return check;
    if (!animal || !itemName) return { ok: false, error: 'feed requires an animal and food' };
    const id = animal.id;
    const entity = Object.values(this.bot.entities || {}).find((entry) => entry && (entry.id === id || (!id && entry.name === animal.name)));
    if (!entity) return { ok: false, error: 'animal not found' };
    if (distance(this.position, entity.position) > 4) {
      const move = await this.goTo(entity.position, { range: 2, timeoutMs: 10000 });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach animal' };
    }
    const before = this.countItem(itemName);
    if (before < 1) return { ok: false, error: `no ${itemName}` };
    const equip = await this.equipItem(itemName);
    if (!equip.ok) return equip;
    if (typeof this.bot.activateEntity !== 'function') return { ok: false, error: 'mineflayer does not expose activateEntity' };
    try {
      await this.bot.activateEntity(entity);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    await sleep(400);
    this._syncInventory();
    const consumed = Math.max(0, before - this.countItem(itemName));
    return { ok: consumed > 0, animal: animal.name || animal.type || entity.name, food: itemName, consumed, verified: consumed > 0, error: consumed > 0 ? undefined : 'server did not consume the food (breeding cooldown?)' };
  }

  async equipItem(name, destination = 'hand') {
    const check = this._assertReady();
    if (check) return check;
    if (destination === 'off-hand' && this.getOffhand() === name) return { ok: true, already: true, item: name };
    const item = this._findItem(name, { includeEquipped: true });
    if (!item) return { ok: false, error: `no ${name}` };
    await this.bot.equip(item, destination);
    this._syncInventory();
    return { ok: true, item: name };
  }

  countItem(name) { return this.inventory[name] || 0; }

  // ------------------------------------------------------------------
  // Movement and interaction
  // ------------------------------------------------------------------
  async goTo(pos, { range = 1, timeoutMs = 20000 } = {}) {
    const check = this._assertReady();
    if (check) return check;
    const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
    if (!this.bot.pathfinder) this.bot.loadPlugin(pathfinder);
    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);
    const goal = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), Math.max(1, range));
    const pathPromise = this.bot.pathfinder.goto(goal).then(() => ({ ok: true }));
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'path timeout' }), timeoutMs));
    const result = await Promise.race([pathPromise, timeout]);
    if (result.ok === false) {
      try { this.bot.pathfinder.stop(); } catch (_) { /* pathfinder may not be running */ }
    }
    this.position = this._vec(this.bot.entity?.position);
    return result;
  }

  async digBlock(pos, { timeoutMs = 20000 } = {}) {
    const check = this._assertReady();
    if (check) return check;
    const block = this._blockAt(pos);
    if (!block || block.name === 'air') return { ok: false, error: 'already air' };
    if (FLUID_BLOCKS.has(block.name)) return { ok: false, error: 'refusing to dig liquid' };
    if (!block.diggable) return { ok: false, error: `not diggable: ${block.name}` };
    if (distance(this.position, pos) > 5) {
      const move = await this.goTo(pos, { range: 4, timeoutMs });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach block' };
    }
    const category = /_log$|_wood$|_planks$|_fence$|_door$/.test(block.name) ? 'axe' : 'pickaxe';
    await this.equipBestTool(category);
    try {
      await this.bot.dig(block, true);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this._blockCache.delete(`${pos.x},${pos.y},${pos.z}`);
    this.stats.dug++;
    this._syncInventory();
    return { ok: true, block: block.name, drops: {} };
  }

  async placeBlock(pos, itemName, { descriptor = null, strategy = null } = {}) {
    const check = this._assertReady();
    if (check) return check;
    const item = this._findItem(itemName);
    if (!item) return { ok: false, error: `no ${itemName}` };
    const target = this._blockAt(pos);
    // A door's upper half or a bed's head is created by the server when its
    // companion is placed. Treat an already-correct target as success.
    if (target && target.name !== 'air' && target.name !== 'water') {
      let properties = {};
      try { properties = typeof target.getProperties === 'function' ? target.getProperties() : {}; } catch (err) { properties = {}; }
      const matches = !descriptor || (target.name === descriptor.name
        && Object.entries(descriptor.properties || {}).every(([key, value]) => String(properties[key]) === String(value)));
      if (matches) return { ok: true, position: { ...pos }, item: itemName, alreadyPresent: true };
      return { ok: false, error: 'space occupied' };
    }
    const offsets = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
    let references = offsets.map(([dx, dy, dz]) => ({ dx, dy, dz }))
      .map((entry) => ({ ...entry, block: this._blockAt({ x: pos.x + entry.dx, y: pos.y + entry.dy, z: pos.z + entry.dz }) }))
      .filter((entry) => entry.block && entry.block.name !== 'air' && entry.block.boundingBox === 'block');
    if (strategy && Array.isArray(strategy.attach)) {
      const [dx, dy, dz] = strategy.attach;
      references.sort((a, b) => (Math.abs(a.dx - dx) + Math.abs(a.dy - dy) + Math.abs(a.dz - dz))
        - (Math.abs(b.dx - dx) + Math.abs(b.dy - dy) + Math.abs(b.dz - dz)));
    } else if (strategy && strategy.clickFace === 'above') {
      references.sort((a, b) => (b.dy - a.dy) || (Math.abs(b.dy) - Math.abs(a.dy)));
    }
    if (!references.length) return { ok: false, error: 'no support block to place against' };
    if (distance(this.position, pos) > 5) {
      const move = await this.goTo(pos, { range: 4 });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach build position' };
    }
    let lastError = null;
    for (const reference of references.slice(0, 3)) {
      try {
        if (strategy && (strategy.yaw !== null || strategy.pitch !== null)) {
          const yaw = strategy.yaw === null ? this.bot.entity.yaw : strategy.yaw * Math.PI / 180;
          const pitch = strategy.pitch === null ? this.bot.entity.pitch : strategy.pitch * Math.PI / 180;
          await this.bot.look(yaw, pitch, true);
        }
        await this.bot.equip(item, 'hand');
        const face = this._vec3(-reference.dx, -reference.dy, -reference.dz);
        await this.bot.placeBlock(reference.block, face);
        this._blockCache.delete(`${pos.x},${pos.y},${pos.z}`);
        this.stats.placed++;
        this._syncInventory();
        return { ok: true, position: { ...pos }, item: itemName };
      } catch (err) {
        lastError = err.message;
      }
    }
    return { ok: false, error: lastError || 'placement failed' };
  }

  async fish({ timeoutMs = 20000 } = {}) {
    const check = this._assertReady();
    if (check) return check;
    const rod = this._findItem('fishing_rod');
    if (!rod) return { ok: false, error: 'no fishing_rod in inventory' };
    const mcData = require('minecraft-data')(this.bot.version);
    const waterIds = [mcData.blocksByName.water && mcData.blocksByName.water.id, mcData.blocksByName.flowing_water && mcData.blocksByName.flowing_water.id].filter((id) => id !== undefined && id !== null);
    const water = this.bot.findBlock({ matching: waterIds, maxDistance: 16 });
    if (!water) return { ok: false, error: 'no water within fishing range' };
    const before = { ...this.inventory };
    try {
      const move = await this.goTo({ x: water.position.x, y: water.position.y + 1, z: water.position.z }, { range: 3, timeoutMs: Math.min(timeoutMs, 15000) });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach the shore' };
      await this.bot.equip(rod, 'hand');
      await Promise.race([
        this.bot.fish(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('fishing timed out')), timeoutMs))
      ]);
      await new Promise((resolve) => setTimeout(resolve, 350));
      this._syncInventory();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const items = [];
    for (const [name, count] of Object.entries(this.inventory)) {
      const gained = count - (before[name] || 0);
      if (gained > 0) items.push({ name, count: gained });
    }
    if (!items.length) return { ok: false, error: 'no catch appeared in inventory' };
    return { ok: true, items, water: { x: water.position.x, y: water.position.y, z: water.position.z } };
  }

  async attack(entity, { authorizedPlayer = false, critical = false } = {}) {
    const check = this._assertReady();
    if (check) return check;
    if (!entity || !entity.id) return { ok: false, error: 'no target' };
    if (entity.username && BOT_NAMES.includes(entity.username)) return { ok: false, error: 'never attack teammates' };
    if (entity.username && config.autonomy.serverPvp === false) return { ok: false, error: 'server configuration has PvP disabled', code: 'SERVER_PVP_DISABLED' };
    if (entity.username && !authorizedPlayer) return { ok: false, error: 'PvP is disabled or the player is not explicitly authorised' };
    if (!entity.username && !entity.hostile && !HOSTILE.has(entity.name)) return { ok: false, error: `refusing to attack ${entity.name}` };
    const target = this.bot.entities[entity.id];
    if (!target) return { ok: false, error: 'target not visible' };
    const held = this.bot.heldItem ? this.bot.heldItem.name : null;
    const reach = held === 'bow' || held === 'crossbow' ? 32 : 4;
    if (distance(this.position, target.position) > reach) {
      const move = await this.goTo(target.position, { range: 2 });
      if (move.ok === false) return { ok: false, error: move.error || 'cannot reach target' };
    }
    const ranged = held === 'bow' || held === 'crossbow';
    const beforeHealth = target.health;
    await this._aimAt(target, { lead: ranged ? distance(this.position, target.position) / 45 : 0 });
    if (ranged) {
      await this.bot.activateItem();
      await new Promise((resolve) => setTimeout(resolve, held === 'bow' ? 1000 : 1250));
      await this.bot.deactivateItem();
    } else {
      if (critical && this.bot.entity && this.bot.entity.onGround && !this.bot.entity.sprinting) {
        this.bot.setControlState('jump', true);
        await new Promise((resolve) => setTimeout(resolve, 120));
        this.bot.setControlState('jump', false);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this._aimAt(target);
      }
      await this.bot.attack(target);
    }
    this.stats.attacked++;
    // Damage and kills are only reported when the server exposes a health drop.
    await new Promise((resolve) => setTimeout(resolve, ranged ? 700 : 250));
    const observed = this.bot.entities && this.bot.entities[entity.id] ? this.bot.entities[entity.id].health : target.health;
    const damage = beforeHealth !== undefined && observed !== undefined ? Math.max(0, Number(beforeHealth) - Number(observed)) : undefined;
    const killed = observed !== undefined && Number(observed) <= 0;
    this._syncInventory();
    return { ok: true, target: entity.name || entity.username, weapon: held, damage, health: observed, killed: killed || undefined };
  }

  /** Aim at an observed entity; for projectiles lead its measured velocity. */
  async _aimAt(target, { lead = 0 } = {}) {
    const point = target.position.clone();
    if (lead > 0 && target.velocity && typeof target.velocity.clone === 'function') point.add(target.velocity.clone().scale(lead));
    point.y += target.height || 1.5;
    return this.bot.lookAt(point, true);
  }

  async consume(itemName = null) {
    const check = this._assertReady();
    if (check) return check;
    let foodName = itemName;
    if (!foodName) {
      const choice = this.bestFoodItem({ critical: this.food <= 6 });
      if (!choice) return { ok: false, error: 'no food' };
      foodName = choice.name;
    }
    const item = this._findItem(foodName);
    if (!item) return { ok: false, error: `no ${foodName} in inventory` };
    if (this.bot.food >= 20 && !FOODS[foodName]?.special && !/potion|milk_bucket/.test(foodName)) return { ok: false, error: 'not hungry' };
    try {
      await this.bot.equip(item, 'hand');
      await this.bot.consume();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.stats.eaten++;
    this.health = this.bot.health;
    this.food = this.bot.food;
    this._syncInventory();
    return { ok: true, item: foodName, food: this.food };
  }

  async sleep(bedPos) {
    const check = this._assertReady();
    if (check) return check;
    const block = this._blockAt(bedPos);
    if (!block || !BED_NAMES.has(block.name)) return { ok: false, error: 'no bed at position' };
    try {
      await this.goTo(bedPos, { range: 2 });
      await this.bot.sleep(block);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.isSleeping = true;
    return { ok: true, slept: true };
  }

  async wake() {
    if (this.bot && this.isSleeping) this.bot.wake();
    this.isSleeping = false;
    return { ok: true };
  }

  async openContainer(pos) {
    const check = this._assertReady();
    if (check) return check;
    const block = this._blockAt(pos);
    if (!block) return { ok: false, error: 'no block there' };
    let window;
    try {
      window = await this.bot.openContainer(block);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const self = this;
    return {
      ok: true,
      position: { ...pos },
      items: () => {
        const out = {};
        for (const item of window.containerItems()) out[item.name] = (out[item.name] || 0) + item.count;
        return out;
      },
      withdraw: async (itemName, count = 1) => {
        const matches = window.containerItems().filter((i) => i.name === itemName);
        let remaining = count;
        for (const item of matches) {
          if (remaining <= 0) break;
          const take = Math.min(item.count, remaining);
          await window.withdraw(item.type, null, take);
          remaining -= take;
        }
        self._syncInventory();
        return remaining < count ? { ok: true, item: itemName, count: count - remaining } : { ok: false, error: 'not in container' };
      },
      deposit: async (itemName, count = 1) => {
        const matches = self.bot.inventory.items().filter((i) => i.name === itemName);
        let remaining = count;
        for (const item of matches) {
          if (remaining <= 0) break;
          const put = Math.min(item.count, remaining);
          await window.deposit(item.type, null, put);
          remaining -= put;
        }
        self._syncInventory();
        return remaining < count ? { ok: true, item: itemName, count: count - remaining } : { ok: false, error: 'not in inventory' };
      },
      close: async () => { try { window.close(); } catch (_) { /* already closed */ } return { ok: true }; }
    };
  }

  async closeContainer() { return { ok: true }; }

  async tossItem(itemName, count = 1) {
    const check = this._assertReady();
    if (check) return check;
    const item = this._findItem(itemName);
    if (!item) return { ok: false, error: 'not held' };
    const toss = Math.min(count, item.count);
    await this.bot.toss(item.type, null, toss);
    this._syncInventory();
    return { ok: true, item: itemName, count: toss };
  }

  /** Drop only a short allow-list of junk; combat gear, totems, food and valuables are never touched. */
  async dropJunk() {
    const check = this._assertReady();
    if (check) return check;
    const junk = new Set(['dirt', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'cobblestone', 'netherrack']);
    const dropped = [];
    const items = this.bot.inventory && typeof this.bot.inventory.items === 'function' ? this.bot.inventory.items() : [];
    for (const item of items) {
      if (dropped.length >= 3) break;
      if (!junk.has(item.name)) continue;
      try {
        await this.bot.toss(item.type, null, item.count);
        dropped.push({ name: item.name, count: item.count });
      } catch (err) { return { ok: false, error: err.message, dropped }; }
    }
    this._syncInventory();
    return { ok: true, dropped, preservedCombatItems: true };
  }

  /** Move combat items into stable hotbar slots without displacing other protected combat gear. */
  async layoutHotbar() {
    const check = this._assertReady();
    if (check) return check;
    const inventory = this.bot.inventory;
    if (!inventory || !Array.isArray(inventory.slots) || typeof this.bot.moveSlotItem !== 'function') {
      return { ok: false, error: 'adapter cannot reorder the hotbar' };
    }
    const desired = [
      ['sword', 36, (name) => /_sword$/.test(name)],
      ['axe', 37, (name) => /_axe$/.test(name)],
      ['ranged', 38, (name) => name === 'bow' || name === 'crossbow'],
      ['golden_apple', 39, (name) => name === 'golden_apple' || name === 'enchanted_golden_apple'],
      ['potion', 40, (name) => /potion$/.test(name)],
      ['pickaxe', 41, (name) => /_pickaxe$/.test(name)],
      ['food', 42, (name) => Boolean(FOODS[name])],
      ['water_bucket', 43, (name) => name === 'water_bucket']
    ];
    const protectedItem = (name) => /_sword$|_axe$|bow|crossbow|potion|golden_apple|totem_of_undying|shield|_pickaxe$|_helmet$|_chestplate$|_leggings$|_boots$|elytra|trident|mace/.test(name) || Boolean(FOODS[name]);
    const moved = [];
    const skipped = [];
    for (const [key, dest, match] of desired) {
      const item = Object.values(inventory.slots).find((slot) => slot && match(slot.name));
      if (!item) continue;
      if (item.slot === dest) continue;
      const occupant = inventory.slots[dest];
      if (occupant && protectedItem(occupant.name)) { skipped.push({ key, reason: `slot ${dest} holds ${occupant.name}` }); continue; }
      try {
        await this.bot.moveSlotItem(item.slot, dest);
        moved.push({ key, item: item.name, from: item.slot, to: dest });
      } catch (err) { skipped.push({ key, reason: err.message }); }
    }
    this._syncInventory();
    return { ok: true, moved, skipped, protected: ['combat gear', 'totems', 'food', 'valuables'] };
  }

  async collectDrops(radius = 12) {
    const check = this._assertReady();
    if (check) return check;
    // Item entities spawn on the server tick after the block breaks. Give that
    // tick a chance to arrive before scanning, or a real harvest looks empty.
    await sleep(120);
    let collected = 0;
    const items = Object.values(this.bot.entities || {}).filter((e) => e.name === 'item' && distance(e.position, this.position) <= radius);
    for (const entity of items) {
      const move = await this.goTo(entity.position, { range: 1, timeoutMs: 6000 });
      if (move.ok) collected++;
    }
    this._syncInventory();
    return { ok: true, collected };
  }

  async craft(itemName, count = 1) {
    const check = this._assertReady();
    if (check) return check;
    const mcData = require('minecraft-data')(this.bot.version);
    const item = mcData.itemsByName[itemName];
    if (!item) return { ok: false, error: `unknown item ${itemName}` };
    const recipes = this.bot.recipesFor(item.id, null, 1, null);
    if (!recipes.length) {
      const table = this.bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 6 });
      if (!table) return { ok: false, error: `no recipe available for ${itemName}` };
      const tableRecipes = this.bot.recipesFor(item.id, null, 1, table);
      if (!tableRecipes.length) return { ok: false, error: `no recipe available for ${itemName}` };
      await this.bot.craft(tableRecipes[0], count, table);
    } else {
      await this.bot.craft(recipes[0], count, null);
    }
    this.stats.crafted++;
    this._syncInventory();
    return { ok: true, item: itemName, count };
  }

  async smelt(input, count = 1) {
    const check = this._assertReady();
    if (check) return check;
    const mcData = require('minecraft-data')(this.bot.version);
    const fuel = this._findItem('coal') || this._findItem('oak_planks') || this._findItem('charcoal');
    if (!fuel) return { ok: false, error: 'no fuel' };
    const inputItem = this._findItem(input);
    if (!inputItem) return { ok: false, error: `no ${input}` };
    const furnaceBlock = this.bot.findBlock({ matching: [mcData.blocksByName.furnace.id, mcData.blocksByName.blast_furnace.id, mcData.blocksByName.smoker.id], maxDistance: 6 });
    if (!furnaceBlock) return { ok: false, error: 'no furnace nearby' };
    const window = await this.bot.openFurnace(furnaceBlock);
    try {
      if (typeof window.putInput === 'function') {
        await window.putInput(inputItem.type, null, Math.min(count, inputItem.count));
        await window.putFuel(fuel.type, null, Math.min(fuel.count, Math.max(1, Math.ceil(count / 8))));
      } else {
        return { ok: false, error: 'furnace window does not expose input slots' };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(12000, 1200 + count * 900)));
      const output = window.outputItem ? window.outputItem() : null;
      if (output && typeof window.takeOutput === 'function') await window.takeOutput();
    } finally {
      try { window.close(); } catch (_) { /* closed */ }
    }
    this._syncInventory();
    return { ok: true, input, count };
  }

  async useShield(on) {
    const shield = this._findItem('shield');
    if (!shield) return { ok: false, error: 'no shield' };
    if (on) {
      if (this.getOffhand() !== 'shield') await this.bot.equip(shield, 'off-hand');
      if (typeof this.bot.activateItem === 'function') await this.bot.activateItem(true);
    } else if (typeof this.bot.deactivateItem === 'function') {
      await this.bot.deactivateItem();
    }
    return { ok: true, shield: Boolean(on), offhand: this.getOffhand() };
  }

  async say(message) {
    if (!this.bot) return { ok: false, error: 'not connected' };
    this.bot.chat(String(message).slice(0, 250));
    return { ok: true };
  }

  async chat(message) { return this.say(message); }

  async lookAt(pos) { if (this.bot && this.ready) await this.bot.lookAt(this._vec3(pos.x, pos.y, pos.z), true); return { ok: true }; }

  async jump() { if (this.bot && this.ready) this.bot.setControlState('jump', true); return { ok: true }; }

  async setControlState(control, state) {
    if (this.bot && this.ready) this.bot.setControlState(control, state);
    return { ok: true };
  }

  async damage() { return { ok: false, error: 'cannot damage a live bot directly' }; }

  async respawn() {
    if (!this.bot) return { ok: false, error: 'not connected' };
    if (typeof this.bot.respawn === 'function') this.bot.respawn();
    else this.bot._client.write('client_command', { actionId: 0 });
    return { ok: true };
  }

  onChat(listener) {
    this._chatListeners.add(listener);
    return () => this._chatListeners.delete(listener);
  }

  get chatLog() { return this._chatLog.slice(-50); }

  /**
   * Keep-alive verification only.
   *
   * A swing every 30s is a real animation packet, not a position change, and
   * proves the session is writable. V6 does not send synthetic movement to
   * defeat idle-kick plugins: the fix for a frozen client is the real 20 tps
   * client tick loop, not fabricated walking or jumping.
   */
  _startAntiAfk() {
    this._stopAntiAfk();
    this._antiAfkTimer = setInterval(() => this._antiAfkPulse(), 30000);
    if (typeof this._antiAfkTimer.unref === 'function') this._antiAfkTimer.unref();
  }

  _antiAfkPulse() {
    if (!this.ready || !this.bot) return;
    this._checkKeepAlive();
    try {
      if (typeof this.bot.swingArm === 'function') this.bot.swingArm();
      this._antiAfkPulses += 1;
    } catch (_) { /* an animation must never drop the session */ }
  }

  _stopAntiAfk() {
    if (this._antiAfkTimer) clearInterval(this._antiAfkTimer);
    this._antiAfkTimer = null;
    if (this._antiAfkJumpTimer) clearTimeout(this._antiAfkJumpTimer);
    this._antiAfkJumpTimer = null;
  }

  async disconnect(reason = 'shutdown') {
    // Capture before any cleanup changes the state the operator is trying to
    // diagnose. The first capture for a generation is the one kept.
    const snapshot = this._captureDisconnectSnapshot(reason || 'disconnected');
    if (this._respawnTimer) { clearTimeout(this._respawnTimer); this._respawnTimer = null; }
    this._stopAntiAfk();
    this._unlockMovement();
    this._stopClientTicker(`disconnect: ${reason}`);
    if (!this.connection.terminal) this.connection.close(reason || 'disconnected');
    this._failTcpWaiters(reason || 'disconnected');
    this._failLoginWaiters(reason || 'disconnected');
    this._restoreClientTrace();
    if (snapshot.ready) this.lastSessionEndedAt = this.now();
    const bot = this.bot;
    this.bot = null;
    try { if (bot) bot.quit(reason); } catch (_) { /* already gone */ }
    this.connected = false;
    this.spawned = false;
    this.authenticated = false;
    this.authConfirmed = false;
    this._tcpConnected = false;
    this._abortAuth(reason || 'disconnected');
    this._failSpawnWaiters(reason || 'disconnected');
    return { ok: true, sessionId: snapshot.generation };
  }

  summary() {
    const base = super.summary();
    return {
      ...base,
      ready: this.ready,
      host: this.host,
      port: this.port,
      version: this.version,
      lastError: this.lastError,
      kickKind: this.kickKind,
      retryPaused: this.retryPaused,
      lastEventAt: this.lastEventAt,
      lastSessionEndedAt: this.lastSessionEndedAt,
      lastDisconnect: this.lastDisconnect,
      connection: this._connectionSnapshot(),
      keepAlive: { ...this._keepAlive },
      ticker: this._clientTicker ? this._clientTicker.snapshot() : null,
      lastDeath: this.lastDeath,
      lastDeathMessage: this.lastDeathMessage,
      lastDamageAt: this.lastDamageAt,
      lastAttacker: this.lastAttacker,
      deathHistory: this.deathHistory.slice(-10),
      lastSpawn: this.lastSpawn,
      stageTimings: { ...this.stageTimings },
      uptimeMs: this.uptimeMs,
      stats: { ...this.stats },
      chatLog: this.chatLog.slice(-8)
    };
  }
}

module.exports = { RealBot, HOSTILE, FLUID_BLOCKS };
