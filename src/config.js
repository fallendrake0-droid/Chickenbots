'use strict';

/**
 * Chickenbots V6 configuration.
 *
 * Everything is deterministic and local. No AI service, API key or cloud
 * inference is used anywhere in this project.
 */

const fs = require('fs');
const path = require('path');
const { PROFILE_IDS, resolveAuthProfile, validateAuthProfile } = require('./bot/authProfiles');

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

function envViewDistance(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) ? numeric : raw.toLowerCase();
}

/**
 * Per-bot plugin credentials. The file is intentionally outside Git
 * (`.mc-auth.json` is ignored) and is read only when an auth profile is
 * configured. A malformed file is reported without echoing its contents.
 */
function loadCredentialFile(file) {
  const empty = { credentials: {}, error: null };
  if (!file || !fs.existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const source = parsed && parsed.bots && typeof parsed.bots === 'object' ? parsed.bots : parsed;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return { credentials: {}, error: 'credential file must contain a bot -> credential object' };
    }
    const credentials = {};
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === 'string') credentials[name] = { password: value };
      else if (value && typeof value === 'object') {
        const password = typeof value.password === 'string' ? value.password
          : typeof value.login === 'string' ? value.login : '';
        const register = typeof value.registerPassword === 'string' ? value.registerPassword : password;
        if (password) credentials[name] = { password, registerPassword: register };
      }
    }
    return { credentials, error: null };
  } catch (err) {
    return { credentials: {}, error: `credential file could not be parsed: ${err.message}` };
  }
}

const AUTH_PROFILE = String(env('MC_AUTH_PROFILE', 'none')).toLowerCase();
const CREDENTIAL_FILE = env('MC_CREDENTIALS_FILE', path.join(ROOT, '.mc-auth.json'));
const CREDENTIALS = loadCredentialFile(CREDENTIAL_FILE);

const VIEW_DISTANCE_PRESETS = Object.freeze({ tiny: 6, short: 8, normal: 10, far: 12 });
function viewDistanceNumber(value) {
  if (Number.isInteger(value)) return value;
  return VIEW_DISTANCE_PRESETS[String(value || '').toLowerCase()] || 2;
}

// A stale .env copied from an older release may still say `tiny` (6). Ten bots
// at six chunks each held 1,690 columns in one Node process and froze the loop
// for 26s in the 03:18 live run. The requested value is kept for diagnostics,
// but the effective value is capped by default so an old file cannot replay
// the crash. Set MC_VIEW_DISTANCE_MAX above 2 only on a host with headroom.
const REQUESTED_VIEW_DISTANCE = envViewDistance('MC_VIEW_DISTANCE', 2);
const VIEW_DISTANCE_MAX = envInt('MC_VIEW_DISTANCE_MAX', 2);

/**
 * The five bot usernames are fixed. The roster was reduced from ten to five
 * so one process holds two chunks per bot without replaying the chunk-burst
 * stalls seen in the 2026-11-25 live run. Never rename, never add bots.
 */
const BOT_NAMES = Object.freeze([
  '________', '10101000', '01010100', '11001100', '00110000'
]);

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
    host: env('MC_HOST', 'EmpiSMP.aternos.me'),
    port: envInt('MC_PORT', 32990),
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
    // Cosmetic join command. The fleet applies the operator-selected skin after
    // spawn+authentication, never before the session is actually ready.
    skinOnJoin: envBool('MC_SKIN_ON_JOIN', true),
    skinCommand: env('MC_SKIN_COMMAND', '/skin uH3WR2v0ti0uTHJ'),
    skinDelayMs: envInt('MC_SKIN_DELAY_MS', 1500),
    // Each connection stage has its own budget. A single 45s timeout could not
    // distinguish a dead TCP connect from a server that accepts the socket but
    // never finishes login, spawn or AuthMe, which made the join queue opaque.
    connectTimeoutMs: envInt('MC_CONNECT_TIMEOUT_MS', 45000),
    // DNS is timed separately from the TCP connect so a resolver hang is not
    // reported as a protocol-login timeout. The library still resolves the
    // hostname it connects to; the preflight only decides whether to attempt.
    dnsTimeoutMs: envInt('MC_DNS_TIMEOUT_MS', 10000),
    // Client-requested chunk distance. 'far' (12) makes the server send up to
    // 625 chunks per bot; ten simultaneous joins then parse them on the same
    // event loop. The live 17:25 run blocked for 40s at 'short' (8), and the
    // 03:18 run blocked for 26s at 'tiny' (6), after which the server dropped
    // sessions. The effective default is 2 (25 columns per bot) regardless of
    // an old env value; movement streams new columns in as the bot walks.
    requestedViewDistance: REQUESTED_VIEW_DISTANCE,
    viewDistanceMax: VIEW_DISTANCE_MAX,
    viewDistance: Math.min(viewDistanceNumber(REQUESTED_VIEW_DISTANCE), VIEW_DISTANCE_MAX),
    // Pause the inbound socket after each kernel read so a burst of chunk
    // packets cannot occupy one uninterrupted event-loop turn. Keepalive and
    // tick timers get a turn between reads.
    inboundYield: envBool('MC_INBOUND_YIELD', true),
    // Handshake/login and the configuration exchange have separate budgets.
    loginTimeoutMs: envInt('MC_LOGIN_TIMEOUT_MS', 30000),
    configurationTimeoutMs: envInt('MC_CONFIGURATION_TIMEOUT_MS', 15000),
    spawnTimeoutMs: envInt('MC_SPAWN_TIMEOUT_MS', 45000),
    // Mineflayer's own no-packet watchdog. Vanilla sends keep-alives every
    // ~15-20s, so 60s is three missed keep-alives. The old 120s value let a
    // zombie session sit on the dashboard long after the server had dropped it.
    keepAliveMs: envInt('MC_KEEPALIVE_MS', 60000),
    // A socket can die silently (NAT timeout, proxy restart) without emitting
    // 'end'. Mark a connected bot as stale when no packet arrives for this
    // long, so the dashboard never reports a dead socket as online. The vanilla
    // server sends keep-alives every ~15-20s. 45s is three missed keep-alives:
    // long enough for a lagging Aternos tick, short enough to reconnect before
    // the dashboard spends a minute showing a dead session as online.
    staleAfterMs: envInt('MC_STALE_AFTER_MS', 45000),
    // Hold a rejoin briefly after a real session ends. Ten simultaneous
    // reconnects were the fastest way to trip a per-IP throttle and to block
    // the event loop with ten chunk bursts.
    rejoinDelayMs: envInt('MC_REJOIN_DELAY_MS', 5000),
    // Conservative, positive spacing between initial connection tasks. The
    // operator can tune these, but zero is never the default: a burst of ten
    // logins made the server drop sessions and starved the tick loop.
    connectStaggerMs: envInt('MC_CONNECT_STAGGER_MS', 1500),
    connectJitterMs: envInt('MC_CONNECT_JITTER_MS', 750),
    // Paper/Bukkit can apply a per-IP connection throttle. Positive spacing
    // plus jitter keeps the fleet under it without serialising every join
    // behind a fully completed handshake.
    joinIntervalMs: envInt('MC_JOIN_INTERVAL_MS', 2000),
    joinJitterMs: envInt('MC_JOIN_JITTER_MS', 750),
    // Plugin authentication is opt-in. The default sends no /login or
    // /register at all. `MC_AUTH_PROFILE` selects a challenge-driven profile
    // (authme, simpleauth, generic, manual, offline, microsoft); the legacy
    // boolean is retained only for isolated parser tests and is still rejected
    // by config validation when true.
    authEnabled: envBool('MC_AUTH_ENABLED', false),
    authCommandsEnabled: false,
    authProfile: AUTH_PROFILE,
    authMode: AUTH_PROFILE === 'none' ? 'disabled' : AUTH_PROFILE,
    authRegistrationEnabled: envBool('MC_AUTH_REGISTRATION_ENABLED', false),
    authMaxAttempts: envInt('MC_AUTH_MAX_ATTEMPTS', 2),
    authRetryDelayMs: envInt('MC_AUTH_RETRY_DELAY_MS', 1500),
    // Optional per-server command forms. Empty means use the selected
    // profile's documented default. The older MC_LOGIN_COMMAND /
    // MC_REGISTER_COMMAND names still work when explicitly present.
    authLoginTemplate: env('MC_AUTH_LOGIN_TEMPLATE', process.env.MC_LOGIN_COMMAND ? env('MC_LOGIN_COMMAND') : ''),
    authRegisterTemplate: env('MC_AUTH_REGISTER_TEMPLATE', process.env.MC_REGISTER_COMMAND ? env('MC_REGISTER_COMMAND') : ''),
    credentialsFile: CREDENTIAL_FILE,
    credentials: CREDENTIALS.credentials,
    credentialsError: CREDENTIALS.error,
    // Legacy single-fleet credentials remain supported for the old parser
    // tests and for an operator who has not moved to the per-bot file yet.
    registerPassword: env('MC_REGISTER_PASSWORD', ''),
    loginPassword: env('MC_LOGIN_PASSWORD', ''),
    loginCommand: env('MC_LOGIN_COMMAND', '/login {password}'),
    registerCommand: env('MC_REGISTER_COMMAND', '/register {password} {password}'),
    registerOnFirstJoin: false,
    // If the server itself prints a login/register demand, the bot records
    // AUTH_REQUIRED_MANUAL and blocks gameplay. It still does not send a
    // command and does not disconnect a healthy spawned session.
    authDelayMs: envInt('MC_AUTH_DELAY_MS', 300),
    authTimeoutMs: envInt('MC_AUTH_TIMEOUT_MS', 12000),
    // A request to authenticate manually is informational; it never causes a
    // reconnect loop or a teardown.
    authManualPromptRe: /(?:please\s+(?:log\s?in|register)|you\s+(?:must|need\s+to)\s+(?:log\s?in|register|authenticate)|not\s+(?:logged\s+in|authenticated)|login\s+required|register\s+required|authenticate\s+to\s+play)/i,
    reconnect: {
      maxAttempts: envInt('MC_RECONNECT_MAX', 0), // 0 = unlimited
      baseDelayMs: envInt('MC_RECONNECT_BASE_MS', 5000),
      maxDelayMs: envInt('MC_RECONNECT_MAX_MS', 120000),
      throttleDelayMs: envInt('MC_THROTTLE_DELAY_MS', 90000),
      throttleMaxDelayMs: envInt('MC_THROTTLE_MAX_DELAY_MS', 600000),
      jitterMs: envInt('MC_RECONNECT_JITTER_MS', 4000)
    }
  },
  commands: {
    // Fleet fan-out is bounded: five bots mining at once saturates the host and
    // the server's chunk pipeline. Four at a time still completes a fleet task
    // quickly, with per-bot results so a partial failure is visible.
    fleetConcurrency: envInt('FLEET_CONCURRENCY', 4),
    fleetTaskLimit: envInt('FLEET_TASK_LIMIT', 0) // 0 = every roster member
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
    // The tenth bot becoming ready is not the same thing as its spawn chunks
    // having arrived. Starting ten pathfinders in the same second as the last
    // chunk burst froze the live event loop for 26s and cost four sessions.
    // Live autonomy waits this long after the last bot becomes ready.
    warmupMs: envInt('AUTONOMY_WARMUP_MS', 20000),
    // Bound how many bots may be inside a long action at once. Ten concurrent
    // mineflayer pathfinders starve tick_end; four still completes fleet work.
    maxConcurrentActions: envInt('AUTONOMY_CONCURRENCY', 4),
    // Mineflayer-pathfinder is cooperative, but its default budget still lets
    // one bot think for 5s and generate 40ms of work per turn. These smaller
    // budgets make it yield more often and stop searching before it can hold
    // the event loop long enough for the server to time the client out.
    pathfinderThinkTimeoutMs: envInt('PATHFINDER_THINK_TIMEOUT_MS', 2500),
    pathfinderTickTimeoutMs: envInt('PATHFINDER_TICK_TIMEOUT_MS', 10),
    pathfinderSearchRadius: envInt('PATHFINDER_SEARCH_RADIUS', 64),
    // A timer callback that arrives this late means the process was frozen
    // (event-loop block or host suspend). Movement is dropped until the client
    // tick loop has caught up, otherwise the first post-freeze packet is an
    // impossible jump and Paper kicks with invalid_player_movement.
    stallGuardMs: envInt('CLIENT_STALL_GUARD_MS', 2500),
    stallResumeMs: envInt('CLIENT_STALL_RESUME_MS', 1500),
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
  navigation: {
    // Destination validation is on by default. `strictDestinations: false`
    // exists only for a deliberately unvalidated diagnostic move.
    strictDestinations: envBool('NAV_STRICT_DESTINATIONS', true),
    maxDrop: envInt('NAV_MAX_DROP', 3),
    allowWater: envBool('NAV_ALLOW_WATER', true),
    // A routine task gets one path attempt; operator moves get a replan ladder.
    // `replan: true` opts an autonomous caller into the same bounded ladder.
    maxAttempts: envInt('NAV_TASK_ATTEMPTS', 1),
    operatorAttempts: envInt('NAV_OPERATOR_ATTEMPTS', 3),
    recoveryDelayMs: envInt('NAV_RECOVERY_DELAY_MS', 250),
    stuckWindowMs: envInt('NAV_STUCK_WINDOW_MS', 2500),
    waitForWorldMs: envInt('NAV_WAIT_FOR_WORLD_MS', 750),
    defaultTimeoutMs: envInt('NAV_DEFAULT_TIMEOUT_MS', 20000),
    // Follow/escort and autonomous task moves claim a stance so five bots do
    // not pile onto the same block.
    congestionRadius: Number(env('NAV_CONGESTION_RADIUS', '1.5')),
    congestionTtlMs: envInt('NAV_CONGESTION_TTL_MS', 5000),
    longDistance: envInt('NAV_LONG_DISTANCE', 64),
    segmentLength: envInt('NAV_SEGMENT_LENGTH', 32),
    maxNodes: envInt('NAV_MAX_NODES', 12000),
    // Pathfinder griefing controls: routine travel does not dig or scaffold.
    allowDig: envBool('NAV_ALLOW_DIG', false),
    allowScaffold: envBool('NAV_ALLOW_SCAFFOLD', false),
    openDoors: envBool('NAV_OPEN_DOORS', false),
    sprint: envBool('NAV_SPRINT', true)
  },
  survival: {
    eatAtFood: envInt('EAT_AT_FOOD', 18),
    eatAtHealth: envInt('EAT_AT_HEALTH', 14),
    criticalHealth: 8,
    fleeHealth: 10,
    lowFood: 6,
    // A freshly spawned bot is fragile: the server may have placed it inside a
    // zombie pack. During this window any hostile within 16m triggers an
    // escape rather than a task.
    spawnGuardMs: envInt('SPAWN_GUARD_MS', 8000),
    // A safety pass may move/fight, but it must return control to the scheduler
    // quickly. This is a hard target propagated into combat/path calls, not a
    // report-only timeout.
    emergencyBudgetMs: envInt('EMERGENCY_BUDGET_MS', 6000),
    // A long farming/mining step must not delay the first safety response.
    // The runtime checks the bot's damage/hazard state on this cadence while a
    // task is running and cancels the task if an emergency appears.
    safetyPreemptMs: envInt('SAFETY_PREEMPT_MS', 500),
    sleepStart: 12541,
    sleepEnd: 23459,
    bedSearchRadius: 32,
    shelterRadius: 8
  },
  reserves: { ...DEFAULT_RESERVES },
  workZone: {
    // One shared 100x100 area centred on home. Woodcutting and mining refuse
    // targets outside it, so a bot cannot chase a tree across the map and get
    // lost. Set WORK_ZONE_ENABLED=false only for a deliberate expedition.
    enabled: envBool('WORK_ZONE_ENABLED', true),
    size: envInt('WORK_ZONE_SIZE', 100),
    margin: envInt('WORK_ZONE_MARGIN', 2)
  },
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
    bots: BOT_NAMES.length,
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
    // The operator-requested V6 catalogue is 10,000 distinct, validated
    // structures. The old 1,120-design library remains the first slice; the
    // generator appends catalogue variants across every tier, so the original
    // high-tier designs are not replaced by small filler.
    minimumCount: 10000,
    targetCount: 10000,
    tiers: [
      { tier: 'beginner', label: 'Beginner', from: 1, to: 962, difficulty: 1 },
      { tier: 'novice', label: 'Novice', from: 963, to: 3809, difficulty: 2 },
      { tier: 'apprentice', label: 'Apprentice', from: 3810, to: 6924, difficulty: 3 },
      { tier: 'intermediate', label: 'Intermediate', from: 6925, to: 8228, difficulty: 4 },
      { tier: 'advanced', label: 'Advanced', from: 8229, to: 8910, difficulty: 6 },
      { tier: 'expert', label: 'Expert', from: 8911, to: 9415, difficulty: 7 },
      { tier: 'master', label: 'Master', from: 9416, to: 9742, difficulty: 9 },
      { tier: 'grandmaster', label: 'Grandmaster', from: 9743, to: 10000, difficulty: 10 }
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
 * `requireCredentials` is retained for callers, but automatic password auth is
 * disabled, so a live run without credentials is valid rather than an error.
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
  const survival = candidate.survival || {};
  const workZone = candidate.workZone || config.workZone || { enabled: true, size: 100, margin: 2 };
  const navigation = candidate.navigation || config.navigation || {};
  const reconnect = server.reconnect || {};

  text('server.host', server.host, 255);
  integer('server.port', server.port, 1, 65535);
  text('server.version', server.version, 64);
  if (server.auth !== 'offline' && server.auth !== 'microsoft') fail('server.auth', "must be 'offline' or 'microsoft'");
  integer('server.connectTimeoutMs', server.connectTimeoutMs, 1000, 600000);
  integer('server.dnsTimeoutMs', server.dnsTimeoutMs, 1000, 300000);
  const viewDistance = server.viewDistance;
  if (!(Number.isInteger(viewDistance) && viewDistance >= 2 && viewDistance <= 32)) {
    fail('server.viewDistance', `must be an integer from 2 to 32 (got ${viewDistance})`);
  }
  integer('server.viewDistanceMax', server.viewDistanceMax, 2, 32);
  const requestedViewDistance = server.requestedViewDistance;
  if (!(Number.isInteger(requestedViewDistance) && requestedViewDistance >= 2 && requestedViewDistance <= 32)
    && !['tiny', 'short', 'normal', 'far'].includes(requestedViewDistance)) {
    fail('server.requestedViewDistance', "must be tiny, short, normal, far or an integer from 2 to 32");
  }
  if (Number.isInteger(server.viewDistanceMax) && viewDistanceNumber(requestedViewDistance) > server.viewDistanceMax) {
    warn('server.viewDistance', `requested ${requestedViewDistance} is capped to ${server.viewDistanceMax} chunks for a five-bot process`);
  }
  integer('server.loginTimeoutMs', server.loginTimeoutMs, 1000, 600000);
  integer('server.configurationTimeoutMs', server.configurationTimeoutMs, 1000, 600000);
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
  boolean('server.authCommandsEnabled', server.authCommandsEnabled);
  boolean('server.registerOnFirstJoin', server.registerOnFirstJoin);
  integer('server.authDelayMs', server.authDelayMs, 0, 60000);
  integer('server.authTimeoutMs', server.authTimeoutMs, 1000, 300000);
  integer('server.authMaxAttempts', server.authMaxAttempts, 1, 5);
  integer('server.authRetryDelayMs', server.authRetryDelayMs, 250, 60000);
  text('server.authProfile', server.authProfile, 32);
  boolean('server.authRegistrationEnabled', server.authRegistrationEnabled);
  if (!PROFILE_IDS.includes(String(server.authProfile || '').toLowerCase())) {
    fail('server.authProfile', `must be one of ${PROFILE_IDS.join(', ')} (got ${server.authProfile})`);
  }
  if (server.authCommandsEnabled) {
    fail('server.authCommandsEnabled', 'the legacy boolean is not a profile; set MC_AUTH_PROFILE explicitly and leave MC_AUTH_COMMANDS_ENABLED unset');
  }
  if (server.authProfile && server.authProfile !== 'none') {
    try {
      const profile = resolveAuthProfile(server.authProfile, {
        loginTemplate: server.loginCommand,
        registerTemplate: server.registerCommand,
        registrationEnabled: server.authRegistrationEnabled === true,
        maxAttempts: server.authMaxAttempts,
        retryDelayMs: server.authRetryDelayMs
      });
      const checked = validateAuthProfile(profile);
      for (const error of checked.errors) fail(`server.authProfile(${profile.id})`, error);
      if (profile.registrationEnabled && !server.registerCommand) {
        fail('server.authRegistrationEnabled', 'registration requires server.registerCommand');
      }
    } catch (err) {
      fail('server.authProfile', err.message);
    }
    if (server.credentialsError) warn('server.credentialsFile', server.credentialsError);
    const known = Object.keys(server.credentials || {});
    if (!known.length && !server.loginPassword && !server.registerPassword) {
      warn('server.credentialsFile', `profile ${server.authProfile} has no per-bot credentials; the session will wait for a challenge and then report missing credentials`);
    }
  } else {
    if (server.authEnabled) warn('server.authEnabled', 'no auth profile is selected; no plugin command will be sent');
    if (server.credentialsError) warn('server.credentialsFile', server.credentialsError);
    if (Object.keys(server.credentials || {}).length) warn('server.credentialsFile', 'credentials are present but MC_AUTH_PROFILE=none; they will not be used');
  }
  text('server.loginCommand', server.loginCommand, 255);
  text('server.registerCommand', server.registerCommand, 255);
  if (server.authLoginTemplate) {
    text('server.authLoginTemplate', server.authLoginTemplate, 255);
    if (!/\{password\}/.test(server.authLoginTemplate)) fail('server.authLoginTemplate', 'must contain {password}');
  }
  if (server.authRegisterTemplate) {
    text('server.authRegisterTemplate', server.authRegisterTemplate, 255);
    if (!/\{password\}/.test(server.authRegisterTemplate)) fail('server.authRegisterTemplate', 'must contain {password}');
  }
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
  integer('survival.emergencyBudgetMs', survival.emergencyBudgetMs, 1000, 30000);
  integer('survival.safetyPreemptMs', survival.safetyPreemptMs, 100, 5000);
  boolean('workZone.enabled', workZone.enabled);
  integer('workZone.size', workZone.size, 16, 1000);
  integer('workZone.margin', workZone.margin, 0, 16);
  if (workZone.enabled && workZone.size % 2 !== 0) warn('workZone.size', 'odd sizes are rounded down to whole blocks; 100 keeps the intended 100x100 area');

  boolean('autonomy.enabled', autonomy.enabled);
  integer('autonomy.tickMs', autonomy.tickMs, 50, 60000);
  integer('autonomy.actionTimeoutMs', autonomy.actionTimeoutMs, 1000, 3600000);
  integer('autonomy.warmupMs', autonomy.warmupMs, 0, 600000);
  integer('autonomy.maxConcurrentActions', autonomy.maxConcurrentActions, 1, 50);
  integer('autonomy.pathfinderThinkTimeoutMs', autonomy.pathfinderThinkTimeoutMs, 100, 60000);
  integer('autonomy.pathfinderTickTimeoutMs', autonomy.pathfinderTickTimeoutMs, 1, 50);
  integer('autonomy.pathfinderSearchRadius', autonomy.pathfinderSearchRadius, 8, 512);
  integer('autonomy.stallGuardMs', autonomy.stallGuardMs, 500, 120000);
  integer('autonomy.stallResumeMs', autonomy.stallResumeMs, 0, 30000);
  integer('survival.spawnGuardMs', survival.spawnGuardMs, 0, 120000);
  boolean('navigation.strictDestinations', navigation.strictDestinations);
  integer('navigation.maxDrop', navigation.maxDrop, 0, 8);
  boolean('navigation.allowWater', navigation.allowWater);
  integer('navigation.maxAttempts', navigation.maxAttempts, 1, 5);
  integer('navigation.operatorAttempts', navigation.operatorAttempts, 1, 5);
  integer('navigation.recoveryDelayMs', navigation.recoveryDelayMs, 0, 10000);
  integer('navigation.stuckWindowMs', navigation.stuckWindowMs, 500, 60000);
  integer('navigation.waitForWorldMs', navigation.waitForWorldMs, 0, 10000);
  integer('navigation.defaultTimeoutMs', navigation.defaultTimeoutMs, 1000, 300000);
  if (!Number.isFinite(Number(navigation.congestionRadius)) || Number(navigation.congestionRadius) < 0.5 || Number(navigation.congestionRadius) > 8) {
    fail('navigation.congestionRadius', 'must be between 0.5 and 8');
  }
  integer('navigation.congestionTtlMs', navigation.congestionTtlMs, 500, 120000);
  integer('navigation.longDistance', navigation.longDistance, 8, 512);
  integer('navigation.segmentLength', navigation.segmentLength, 8, 128);
  integer('navigation.maxNodes', navigation.maxNodes, 100, 200000);
  boolean('navigation.allowDig', navigation.allowDig);
  boolean('navigation.allowScaffold', navigation.allowScaffold);
  boolean('navigation.openDoors', navigation.openDoors);
  boolean('navigation.sprint', navigation.sprint);
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

  // Credentials alone never send a command. The profile is the authority; the
  // default `none` keeps the live server's "no /login command" behaviour.
  if ((server.loginPassword || server.registerPassword) && (!server.authProfile || server.authProfile === 'none')) {
    warn('server.loginPassword', 'credentials are present but MC_AUTH_PROFILE=none; they will not be sent');
  }
  if (requireCredentials && simulate) {
    warn('server.loginPassword', 'ignored: plugin authentication is off in simulation');
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { config, BOT_NAMES, loadDotEnv, validateConfig, ROOT };
