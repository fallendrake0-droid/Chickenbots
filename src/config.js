'use strict';

/**
 * Chickenbots V6 configuration.
 *
 * Everything is deterministic and local. No AI service, API key or cloud
 * inference is used anywhere in this project.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// .env loader (tiny, dependency free). Real environment variables win.
// ---------------------------------------------------------------------------
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const dotenv = loadDotEnv();

function env(name, fallback = undefined) {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
  if (dotenv[name] !== undefined && dotenv[name] !== '') return dotenv[name];
  return fallback;
}

function envInt(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

/** The five bot usernames are fixed. Never rename, never add bots. */
const BOT_NAMES = Object.freeze(['________', '10101000', '01010100', '11001100', '00110000']);

const DEFAULT_RESERVES = Object.freeze({
  food: 128,
  torch: 64,
  oak_log: 128,
  iron_ingot: 32,
  building_blocks: 128,
  water_bucket: 5
});

const config = {
  root: ROOT,
  paths: {
    data: path.join(ROOT, 'data'),
    schematics: path.join(ROOT, 'schematics'),
    schematicData: path.join(ROOT, 'data', 'schematics'),
    exports: path.join(ROOT, 'data', 'exports'),
    runtime: path.join(ROOT, 'data', 'runtime'),
    logs: path.join(ROOT, 'logs')
  },
  server: {
    host: env('MC_HOST', 'cr3xlol.aternos.me'),
    port: envInt('MC_PORT', 55742),
    version: env('MC_VERSION', 'auto'),
    // Resolve 'auto' with a validated status ping before any login socket is
    // opened. A sleeping Aternos server can report protocol -1; retrying that
    // through minecraft-protocol's autoVersion path only produces noise.
    versionProbeTimeoutMs: envInt('MC_VERSION_PROBE_TIMEOUT_MS', 8000),
    serverStartDelayMs: envInt('MC_SERVER_START_DELAY_MS', 30000),
    versionRetryDelayMs: envInt('MC_VERSION_RETRY_MS', 60000),
    // Aternos servers with ViaVersion/ViaBackwards accept the version the
    // installed mineflayer/minecraft-protocol pair supports. 'auto' pings the
    // server and negotiates, which is the safe default.
    auth: env('MC_AUTH', 'offline'),
    // Each connection stage has its own budget. A single 45s timeout could not
    // distinguish a dead TCP connect from a server that accepts the socket but
    // never finishes login, spawn or AuthMe, which made the join queue opaque.
    connectTimeoutMs: envInt('MC_CONNECT_TIMEOUT_MS', 45000),
    loginTimeoutMs: envInt('MC_LOGIN_TIMEOUT_MS', 30000),
    spawnTimeoutMs: envInt('MC_SPAWN_TIMEOUT_MS', 45000),
    keepAliveMs: envInt('MC_KEEPALIVE_MS', 120000),
    // A socket can die silently (NAT timeout, proxy restart) without emitting
    // 'end'. Mark a connected bot as stale when no packet arrives for this
    // long, so the dashboard never reports a dead socket as online. The vanilla
    // server sends keep-alives every ~15-20s, so 90s is safely above normal.
    staleAfterMs: envInt('MC_STALE_AFTER_MS', 90000),
    // Aternos throttles a reconnect that follows a real session end. Hold the
    // first rejoin briefly; the join queue and throttle backoff still protect
    // against a server that rejects it. Initial joins use the same 10s spacing.
    rejoinDelayMs: envInt('MC_REJOIN_DELAY_MS', 10000),
    // Never start the next initial connection task before the fleet join
    // interval has elapsed. Jitter is zero so the spacing is exactly 10s.
    connectStaggerMs: envInt('MC_CONNECT_STAGGER_MS', 10000),
    connectJitterMs: envInt('MC_CONNECT_JITTER_MS', 0),
    // Paper/Bukkit applies a per-IP connection throttle (`connection-throttle`,
    // commonly 30-60s on Aternos). Every bot in this fleet shares one source
    // IP, so joins must be at least this far apart or the server rejects them
    // and an existing session can be dropped in the storm.
    joinIntervalMs: envInt('MC_JOIN_INTERVAL_MS', 10000),
    joinJitterMs: envInt('MC_JOIN_JITTER_MS', 0),
    // Registration / login (Aternos + AuthMe style plugins). There is no
    // built-in password and no default credential: live connections refuse to
    // start with auth enabled unless a password is supplied through the
    // environment or .env. Set MC_AUTH_ENABLED=false for a server without a
    // password plugin.
    authEnabled: envBool('MC_AUTH_ENABLED', true),
    registerPassword: env('MC_REGISTER_PASSWORD', ''),
    loginPassword: env('MC_LOGIN_PASSWORD', ''),
    loginCommand: env('MC_LOGIN_COMMAND', '/login {password}'),
    registerCommand: env('MC_REGISTER_COMMAND', '/register {password} {password}'),
    // Accounts already exist on the server, so normal operation is login-only.
    // Set MC_AUTH_REGISTER_ON_FIRST_JOIN=true only for a brand-new account.
    registerOnFirstJoin: envBool('MC_AUTH_REGISTER_ON_FIRST_JOIN', false),
    // AuthMe-style plugins confirm in chat; stay unready and frozen until that
    // confirmation arrives so no bot can move before authenticating.
    authDelayMs: envInt('MC_AUTH_DELAY_MS', 300),
    authTimeoutMs: envInt('MC_AUTH_TIMEOUT_MS', 12000),
    reconnect: {
      maxAttempts: envInt('MC_RECONNECT_MAX', 0), // 0 = unlimited
      baseDelayMs: envInt('MC_RECONNECT_BASE_MS', 5000),
      maxDelayMs: envInt('MC_RECONNECT_MAX_MS', 120000),
      throttleDelayMs: envInt('MC_THROTTLE_DELAY_MS', 90000),
      throttleMaxDelayMs: envInt('MC_THROTTLE_MAX_DELAY_MS', 600000),
      jitterMs: envInt('MC_RECONNECT_JITTER_MS', 4000)
    }
  },
  dashboard: {
    // The control plane is a command surface. Loopback is the default so a
    // fresh checkout can never be driven by someone else on the network. The
    // sandbox preview opts out explicitly with DASHBOARD_ALLOW_INSECURE=true.
    host: envBool('DASHBOARD_LOCAL', false) ? '127.0.0.1' : env('DASHBOARD_HOST', '127.0.0.1'),
    port: envInt('DASHBOARD_PORT', 3000),
    bind127: envBool('DASHBOARD_LOCAL', false),
    // Optional HTTP Basic/Bearer password. Required before exposing the
    // control plane beyond loopback unless the operator explicitly accepts the
    // risk with DASHBOARD_ALLOW_INSECURE=true (trusted local preview only).
    token: env('DASHBOARD_TOKEN', ''),
    allowInsecure: envBool('DASHBOARD_ALLOW_INSECURE', false)
  },
  team: {
    names: BOT_NAMES,
    // Initial coordinator. Leadership is elected, never assumed.
    preferredLeader: '________',
    coordinatorTickMs: envInt('TEAM_TICK_MS', 1000),
    claimTtlMs: envInt('TASK_CLAIM_TTL_MS', 45000),
    lockTtlMs: envInt('TASK_LOCK_TTL_MS', 30000),
    observationTtlMs: envInt('OBSERVATION_TTL_MS', 300000),
    maxObservations: envInt('MAX_OBSERVATIONS', 4000),
    // A task that repeatedly produces no verified progress is released back to
    // the board instead of pinning one bot to a dead area forever.
    taskStallMs: envInt('TASK_STALL_MS', 45000),
    taskStallCycles: envInt('TASK_STALL_CYCLES', 3),
    formation: env('TEAM_FORMATION', 'FOLLOW'),
    // Autonomy is gated on a verified spawn + authentication.
    requireSpawnBeforeAutonomy: true
  },
  autonomy: {
    enabled: envBool('AUTONOMY_ENABLED', true),
    tickMs: envInt('AUTONOMY_TICK_MS', 750),
    actionTimeoutMs: envInt('ACTION_TIMEOUT_MS', 60000),
    maxConsecutiveFailures: envInt('MAX_ACTION_FAILURES', 4),
    // PvE is safe automation and is on by default. PvP is also enabled as a
    // feature, but PvpPolicy still requires an explicit operator target list;
    // no player is ever auto-targeted by scanning.
    pve: envBool('PVE_ENABLED', true),
    pvp: envBool('PvP_ENABLED', true),
    serverPvp: envBool('SERVER_PVP_ENABLED', true), // set false when the Minecraft server itself has pvp=false
    // Optional AI hook. Disabled by default; the deterministic engine is
    // complete without it.
    ai: {
      enabled: false,
      provider: env('AI_PROVIDER', ''),
      endpoint: env('AI_ENDPOINT', ''),
      apiKey: env('AI_API_KEY', '')
    }
  },
  survival: {
    eatAtFood: envInt('EAT_AT_FOOD', 18),
    eatAtHealth: envInt('EAT_AT_HEALTH', 14),
    criticalHealth: 8,
    fleeHealth: 10,
    lowFood: 6,
    sleepStart: 12541,
    sleepEnd: 23459,
    bedSearchRadius: 32,
    shelterRadius: 8
  },
  reserves: { ...DEFAULT_RESERVES },
  mining: {
    maxSearchRadius: 48,
    torchInterval: 6,
    branchSpacing: 3,
    maxVeinSize: 32,
    retreatHealth: 6,
    unsafeBlockRadius: 2
  },
  excavation: {
    maxBlocks: envInt('EXCAVATE_MAX_BLOCKS', 250000),
    maxDepth: 120,
    requireConfirmation: true,
    preserveOres: true,
    protectedDefault: true,
    bots: 5,
    maxFallPerTick: 4
  },
  builder: {
    maxPlacementDistance: 5,
    phaseRetries: 3,
    verifySamples: 200
  },
  building: {
    verification: envBool('BUILD_VERIFICATION', true),
    tripleCheck: envBool('BUILD_TRIPLE_CHECK', true),
    autoRepair: envBool('BUILD_AUTO_REPAIR', false),
    deterministic: envBool('BUILD_DETERMINISTIC', true),
    randomPlacement: envBool('BUILD_RANDOM_PLACEMENT', false),
    allowExplosives: envBool('BUILD_ALLOW_EXPLOSIVES', false),
    destructiveExcavation: envBool('BUILD_DESTRUCTIVE_EXCAVATION', false),
    customSchematics: envBool('BUILD_CUSTOM_SCHEMATICS', true),
    autoStartImportedBuilds: envBool('BUILD_AUTOSTART_IMPORTED', false),
    libraryTarget: envInt('BUILD_LIBRARY_TARGET', 10000),
    minecraftVersion: env('BUILD_MC_VERSION', 'auto'),
    placementMode: env('BUILD_PLACEMENT_MODE', 'replace-region'),
    customDir: path.join(ROOT, 'data', 'schematics', 'custom'),
    watchCustom: envBool('BUILD_WATCH_CUSTOM', true),
    maxConfirmationAttempts: envInt('BUILD_CONFIRM_ATTEMPTS', 4),
    confirmationDelayMs: envInt('BUILD_CONFIRM_DELAY_MS', 25),
    maxConcurrentProjects: envInt('BUILD_MAX_CONCURRENT', 3)
  },
  construction: {
    autoAdvance: envBool('CONSTRUCTION_AUTO', true),
    tickEvery: envInt('CONSTRUCTION_TICK_EVERY', 20),
    maxActionsPerPhase: envInt('CONSTRUCTION_MAX_ACTIONS', 500),
    maxProjects: envInt('CONSTRUCTION_MAX_PROJECTS', 12)
  },
  schematics: {
    minimumCount: 1100,
    targetCount: 1120,
    tiers: [
      { tier: 'beginner', label: 'Beginner', from: 1, to: 100, difficulty: 1 },
      { tier: 'novice', label: 'Novice', from: 101, to: 200, difficulty: 2 },
      { tier: 'apprentice', label: 'Apprentice', from: 201, to: 350, difficulty: 3 },
      { tier: 'intermediate', label: 'Intermediate', from: 351, to: 500, difficulty: 4 },
      { tier: 'advanced', label: 'Advanced', from: 501, to: 650, difficulty: 6 },
      { tier: 'expert', label: 'Expert', from: 651, to: 800, difficulty: 7 },
      { tier: 'master', label: 'Master', from: 801, to: 950, difficulty: 9 },
      { tier: 'grandmaster', label: 'Grandmaster', from: 951, to: 1120, difficulty: 10 }
    ]
  },
  sim: {
    enabled: envBool('MC_SIMULATE', false),
    seed: env('SIM_SEED', 'chickenbots-v4'),
    tickMs: envInt('SIM_TICK_MS', 120)
  },
  logging: {
    level: env('LOG_LEVEL', 'info'),
    tracePackets: envBool('MC_TRACE_PACKETS', false)
  }
};

/**
 * Validate a configuration object without contacting a server.
 *
 * Env parsing is deliberately forgiving (a typo falls back to a default), so
 * this is the single place that turns a bad value into a clear startup error
 * instead of a mysterious socket/behaviour failure later. Pass
 * `requireCredentials: true` for a live, connecting run: password auth enabled
 * with no password is a configuration error, not a bot that silently tries to
 * move unauthenticated.
 */
function validateConfig(candidate = config, { requireCredentials = false, simulate = false } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (path, message) => errors.push(`${path}: ${message}`);
  const warn = (path, message) => warnings.push(`${path}: ${message}`);
  const integer = (path, value, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) fail(path, `must be an integer in ${min}..${max} (got ${value})`);
  };
  const boolean = (path, value) => {
    if (typeof value !== 'boolean') fail(path, `must be true or false (got ${value})`);
  };
  const text = (path, value, max = 512) => {
    if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string');
    else if (value.length > max) fail(path, `must be at most ${max} characters`);
  };

  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['config: must be an object'], warnings };
  }
  const server = candidate.server || {};
  const dashboard = candidate.dashboard || {};
  const team = candidate.team || {};
  const autonomy = candidate.autonomy || {};
  const reconnect = server.reconnect || {};

  text('server.host', server.host, 255);
  integer('server.port', server.port, 1, 65535);
  text('server.version', server.version, 64);
  if (server.auth !== 'offline' && server.auth !== 'microsoft') fail('server.auth', "must be 'offline' or 'microsoft'");
  integer('server.connectTimeoutMs', server.connectTimeoutMs, 1000, 600000);
  integer('server.loginTimeoutMs', server.loginTimeoutMs, 1000, 600000);
  integer('server.spawnTimeoutMs', server.spawnTimeoutMs, 1000, 600000);
  integer('server.keepAliveMs', server.keepAliveMs, 1000, 3600000);
  integer('server.staleAfterMs', server.staleAfterMs, 1000, 3600000);
  integer('server.rejoinDelayMs', server.rejoinDelayMs, 0, 3600000);
  integer('server.connectStaggerMs', server.connectStaggerMs, 0, 3600000);
  integer('server.connectJitterMs', server.connectJitterMs, 0, 3600000);
  integer('server.joinIntervalMs', server.joinIntervalMs, 0, 3600000);
  integer('server.joinJitterMs', server.joinJitterMs, 0, 3600000);
  integer('server.versionProbeTimeoutMs', server.versionProbeTimeoutMs, 1000, 120000);
  integer('server.serverStartDelayMs', server.serverStartDelayMs, 1000, 3600000);
  integer('server.versionRetryDelayMs', server.versionRetryDelayMs, 1000, 3600000);
  boolean('server.authEnabled', server.authEnabled);
  boolean('server.registerOnFirstJoin', server.registerOnFirstJoin);
  integer('server.authDelayMs', server.authDelayMs, 0, 60000);
  integer('server.authTimeoutMs', server.authTimeoutMs, 1000, 300000);
  text('server.loginCommand', server.loginCommand, 255);
  text('server.registerCommand', server.registerCommand, 255);
  integer('server.reconnect.maxAttempts', reconnect.maxAttempts, 0, 10000);
  integer('server.reconnect.baseDelayMs', reconnect.baseDelayMs, 0, 3600000);
  integer('server.reconnect.maxDelayMs', reconnect.maxDelayMs, 1, 3600000);
  integer('server.reconnect.throttleDelayMs', reconnect.throttleDelayMs, 0, 3600000);
  integer('server.reconnect.throttleMaxDelayMs', reconnect.throttleMaxDelayMs, 1, 3600000);
  integer('server.reconnect.jitterMs', reconnect.jitterMs, 0, 3600000);
  if (reconnect.baseDelayMs > reconnect.maxDelayMs) warn('server.reconnect', 'baseDelayMs is greater than maxDelayMs and will be capped');

  text('dashboard.host', dashboard.host, 255);
  integer('dashboard.port', dashboard.port, 0, 65535);
  boolean('dashboard.bind127', dashboard.bind127);
  if (typeof dashboard.token !== 'string') fail('dashboard.token', 'must be a string');
  else if (dashboard.token && dashboard.token.length < 16) fail('dashboard.token', 'must be at least 16 characters, or empty to leave the local demo open');
  else if (dashboard.token.length > 256) fail('dashboard.token', 'must be at most 256 characters');
  const loopbackBind = ['127.0.0.1', '::1', 'localhost'].includes(String(dashboard.host || '').toLowerCase());
  boolean('dashboard.allowInsecure', dashboard.allowInsecure);
  if (!dashboard.token && !loopbackBind && !dashboard.allowInsecure) {
    fail('dashboard.token', 'is empty while the dashboard is bound beyond loopback; set DASHBOARD_TOKEN or explicitly opt into DASHBOARD_ALLOW_INSECURE=true for a trusted local preview');
  } else if (!dashboard.token && !loopbackBind && dashboard.allowInsecure) {
    warn('dashboard.token', 'control plane is unauthenticated on a non-loopback bind because DASHBOARD_ALLOW_INSECURE=true');
  }

  if (!Array.isArray(team.names) || team.names.length !== BOT_NAMES.length || team.names.some((name, index) => name !== BOT_NAMES[index])) {
    fail('team.names', `must be exactly the fixed roster ${BOT_NAMES.join(', ')}`);
  }
  integer('team.coordinatorTickMs', team.coordinatorTickMs, 100, 60000);
  integer('team.claimTtlMs', team.claimTtlMs, 1000, 3600000);
  integer('team.lockTtlMs', team.lockTtlMs, 1000, 3600000);
  integer('team.observationTtlMs', team.observationTtlMs, 1000, 86400000);
  integer('team.maxObservations', team.maxObservations, 1, 100000);
  integer('team.taskStallMs', team.taskStallMs, 1000, 3600000);
  integer('team.taskStallCycles', team.taskStallCycles, 1, 100);

  boolean('autonomy.enabled', autonomy.enabled);
  integer('autonomy.tickMs', autonomy.tickMs, 50, 60000);
  integer('autonomy.actionTimeoutMs', autonomy.actionTimeoutMs, 1000, 3600000);
  boolean('autonomy.pve', autonomy.pve);
  boolean('autonomy.pvp', autonomy.pvp);
  boolean('autonomy.serverPvp', autonomy.serverPvp);
  if (autonomy.ai && autonomy.ai.enabled) {
    fail('autonomy.ai.enabled', 'the optional AI hook is not implemented; keep it false so deterministic mode stays authoritative');
  }

  integer('excavation.maxBlocks', candidate.excavation?.maxBlocks, 1, 10000000);
  integer('construction.tickEvery', candidate.construction?.tickEvery, 1, 10000);
  integer('construction.maxProjects', candidate.construction?.maxProjects, 1, 1000);
  integer('schematics.minimumCount', candidate.schematics?.minimumCount, 1, 100000);
  integer('schematics.targetCount', candidate.schematics?.targetCount, candidate.schematics?.minimumCount || 1, 100000);
  if (candidate.logging && !['debug', 'info', 'warn', 'error', 'silent'].includes(candidate.logging.level)) {
    fail('logging.level', `must be debug, info, warn, error or silent (got ${candidate.logging.level})`);
  }

  const authEnabled = server.authEnabled !== false;
  const hasPassword = Boolean(server.loginPassword || server.registerPassword);
  if (authEnabled && !hasPassword) {
    if (requireCredentials && !simulate) {
      fail('server.loginPassword', 'is empty while password auth is enabled; set MC_LOGIN_PASSWORD (or MC_AUTH_ENABLED=false for a server without AuthMe)');
    } else {
      warn('server.loginPassword', 'is empty; a live connecting run would refuse to start until it is set');
    }
  }
  if (authEnabled && hasPassword) {
    const password = String(server.loginPassword || server.registerPassword);
    if (password.length < 12) warn('server.loginPassword', 'is shorter than 12 characters; use a strong server password');
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { config, BOT_NAMES, loadDotEnv, validateConfig, ROOT };
