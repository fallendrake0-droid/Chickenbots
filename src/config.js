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
const BOT_NAMES = Object.freeze(['_______', '1010100', '0101010', '1100110', '0011000']);
const DEFAULT_AUTH_PASSWORD = 'chickenbot12345';

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
    connectTimeoutMs: envInt('MC_CONNECT_TIMEOUT_MS', 45000),
    keepAliveMs: envInt('MC_KEEPALIVE_MS', 10000),
    // Aternos and vanilla proxies throttle rapid joins. Open one socket at a
    // time, with jitter, instead of starting all five bots simultaneously.
    connectStaggerMs: envInt('MC_CONNECT_STAGGER_MS', 7000),
    connectJitterMs: envInt('MC_CONNECT_JITTER_MS', 2000),
    // Registration / login (Aternos + AuthMe style plugins). Set
    // MC_AUTH_ENABLED=false for a server without a password plugin.
    authEnabled: envBool('MC_AUTH_ENABLED', true),
    registerPassword: env('MC_REGISTER_PASSWORD', DEFAULT_AUTH_PASSWORD),
    loginPassword: env('MC_LOGIN_PASSWORD', DEFAULT_AUTH_PASSWORD),
    loginCommand: env('MC_LOGIN_COMMAND', '/login {password}'),
    registerCommand: env('MC_REGISTER_COMMAND', '/register {password} {password}'),
    // AuthMe-style plugins confirm in chat; stay unready and frozen until that
    // confirmation arrives so no bot can move before authenticating.
    authDelayMs: envInt('MC_AUTH_DELAY_MS', 1000),
    authTimeoutMs: envInt('MC_AUTH_TIMEOUT_MS', 12000),
    reconnect: {
      maxAttempts: envInt('MC_RECONNECT_MAX', 0), // 0 = unlimited
      baseDelayMs: envInt('MC_RECONNECT_BASE_MS', 5000),
      maxDelayMs: envInt('MC_RECONNECT_MAX_MS', 120000),
      throttleDelayMs: envInt('MC_THROTTLE_DELAY_MS', 30000),
      jitterMs: envInt('MC_RECONNECT_JITTER_MS', 4000)
    }
  },
  dashboard: {
    host: env('DASHBOARD_HOST', '0.0.0.0'),
    port: envInt('DASHBOARD_PORT', 3000),
    bind127: envBool('DASHBOARD_LOCAL', false)
  },
  team: {
    names: BOT_NAMES,
    // Initial coordinator. Leadership is elected, never assumed.
    preferredLeader: '_______',
    coordinatorTickMs: envInt('TEAM_TICK_MS', 1000),
    claimTtlMs: envInt('TASK_CLAIM_TTL_MS', 45000),
    lockTtlMs: envInt('TASK_LOCK_TTL_MS', 30000),
    observationTtlMs: envInt('OBSERVATION_TTL_MS', 300000),
    maxObservations: envInt('MAX_OBSERVATIONS', 4000),
    formation: env('TEAM_FORMATION', 'FOLLOW'),
    // Autonomy is gated on a verified spawn + authentication.
    requireSpawnBeforeAutonomy: true
  },
  autonomy: {
    enabled: envBool('AUTONOMY_ENABLED', true),
    tickMs: envInt('AUTONOMY_TICK_MS', 750),
    actionTimeoutMs: envInt('ACTION_TIMEOUT_MS', 60000),
    maxConsecutiveFailures: envInt('MAX_ACTION_FAILURES', 4),
    pvp: envBool('PvP_ENABLED', false), // PvP is off by default, always.
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
  logging: { level: env('LOG_LEVEL', 'info') }
};

module.exports = { config, BOT_NAMES, loadDotEnv, ROOT };
