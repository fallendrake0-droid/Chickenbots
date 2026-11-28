#!/usr/bin/env node
'use strict';

const { config, BOT_NAMES, validateConfig } = require('./config');
const { createRuntime } = require('./runtime');
const { Logger } = require('./logger');
const { printStartupBanner } = require('./branding');
const { acquireLiveLock } = require('./liveLock');

function parseArgs(argv) {
  const args = { simulate: config.sim.enabled, dashboard: true, port: config.dashboard.port, host: config.dashboard.host, connect: true, allowInsecure: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--simulate' || arg === '--mock' || arg === '--sim') args.simulate = true;
    else if (arg === '--live') args.simulate = false;
    else if (arg === '--no-dashboard') args.dashboard = false;
    else if (arg === '--no-connect') args.connect = false;
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--allow-insecure') args.allowInsecure = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function usage() {
  process.stdout.write(`Chickenbots V6

Usage: node src/index.js [options]

Options:
  --simulate        Run the deterministic mock world (no network)
  --live            Connect to MC_HOST/MC_PORT (default)
  --no-dashboard    Do not start the dashboard
  --no-connect      Start the runtime without connecting bots (diagnostics)
  --port <port>     Dashboard port (default ${config.dashboard.port})
  --host <host>     Dashboard bind address (default ${config.dashboard.host})
  --allow-insecure  Allow an unauthenticated non-loopback bind (trusted preview only)
  -h, --help        Show this help

Default server: ${config.server.host}:${config.server.port} (version ${config.server.version})
Roster (fixed): ${BOT_NAMES.join(' ')}
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  printStartupBanner();
  if (args.allowInsecure) config.dashboard.allowInsecure = true;
  const logger = new Logger({ level: config.logging.level });
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(String(args.host).toLowerCase());
  if (args.dashboard && !loopback && !config.dashboard.token && !config.dashboard.allowInsecure) {
    process.stderr.write(`\nRefusing to expose the dashboard control plane on ${args.host} without authentication.\n`);
    process.stderr.write('Bind 127.0.0.1, set DASHBOARD_TOKEN, or pass --allow-insecure for a trusted local preview.\n\n');
    return 2;
  }
  const validation = validateConfig(config, {
    requireCredentials: !args.simulate && args.connect,
    simulate: args.simulate
  });
  for (const warning of validation.warnings) logger.warn(`config warning: ${warning}`);
  if (!validation.ok) {
    for (const error of validation.errors) logger.error(`config error: ${error}`);
    process.stderr.write('\nRefusing to start with an invalid configuration. Fix the above and retry.\n');
    return 2;
  }
  let liveLock = null;
  if (!args.simulate && args.connect) {
    liveLock = acquireLiveLock();
    if (!liveLock.ok) {
      logger.error(`another live runtime is already running (pid ${liveLock.pid}; lock ${liveLock.file}); use its dashboard at http://127.0.0.1:${config.dashboard.port} or stop it with \`kill ${liveLock.pid}\` before starting a second one to avoid duplicate-login kicks`);
      return 2;
    }
  }
  logger.info('runtime starting');
  logger.info(`roster: ${BOT_NAMES.join(', ')}`);
  logger.info(`join spacing: ${(config.server.joinIntervalMs / 1000).toFixed(1)}s between bot logins${config.server.joinJitterMs ? ` + up to ${(config.server.joinJitterMs / 1000).toFixed(1)}s jitter` : ''}`);
  logger.info(args.simulate ? 'mode: deterministic simulation' : `mode: live (${config.server.host}:${config.server.port}, version ${config.server.version})`);
  logger.info(`logging: ${config.logging.level} (per-packet traces ${config.logging.tracePackets ? 'on' : 'off; set MC_TRACE_PACKETS=true to enable'})`);
  if (!args.simulate) {
    const passwordConfigured = Boolean(config.server.loginPassword || config.server.registerPassword);
    const profile = String(config.server.authProfile || 'none').toLowerCase();
    // Credentials without a profile are inert by design. Saying "configured"
    // made an operator believe /login was being sent when MC_AUTH_PROFILE=none
    // guarantees it is not.
    if (passwordConfigured && profile === 'none') {
      logger.warn('password authentication: credentials present but MC_AUTH_PROFILE=none, so no /login or /register command is sent (value redacted)');
    } else if (passwordConfigured) {
      logger.info(`password authentication: configured for profile ${profile} (value redacted)`);
    } else {
      logger.info('password authentication: not configured (MC_LOGIN_PASSWORD / MC_REGISTER_PASSWORD empty)');
    }
  }
  const runtime = await createRuntime({
    simulate: args.simulate,
    connect: args.connect,
    dashboard: args.dashboard,
    port: args.port,
    host: args.host,
    logger
  });
  const started = await runtime.start();
  if (started.dashboardError) {
    process.stdout.write(`\n  Dashboard unavailable: ${started.dashboardError}\n`);
    process.stdout.write('  The bot runtime continues without a control plane; the full error is in the log above.\n\n');
  } else if (started.dashboard) {
    process.stdout.write(`\n  Dashboard: http://127.0.0.1:${started.dashboard.port}  (bound ${started.dashboard.host}:${started.dashboard.port})\n`);
    if (started.dashboard.build) process.stdout.write(`  Build: ${started.dashboard.build.buildId}\n`);
    process.stdout.write('  Live preview uses the sandbox proxy; the server accepts the forwarded host.\n');
    if (!config.dashboard.token) process.stdout.write(`  Control plane auth: ${config.dashboard.allowInsecure ? 'explicitly disabled for this trusted preview' : 'loopback only'}.\n`);
    process.stdout.write('\n');
  }
  if (args.simulate) {
    const state = runtime.state();
    process.stdout.write(`  Simulation ready: ${state.bots.filter((b) => b.ready).length}/${BOT_NAMES.length} bots, home ${state.home.x},${state.home.y},${state.home.z}\n`);
    process.stdout.write('  Try: node src/cli.js --simulate\n\n');
  } else if (args.connect) {
    process.stdout.write('  Autonomy is gated until all five bots connect, authenticate and spawn.\n');
    process.stdout.write(`  Connection errors are shown on the dashboard diagnostics tab.\n\n`);
  }
  let shuttingDown = false;
  const forceExit = (code = 130) => {
    process.stdout.write('\nForced exit.\n');
    process.exit(code);
  };
  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) { forceExit(exitCode || 130); return; }
    shuttingDown = true;
    process.stdout.write(`\n${signal}; shutting down…\n`);
    // Never let a stuck dashboard socket or reconnect timer keep the terminal
    // captive: Ctrl+C once is graceful, twice (or 5s) is immediate.
    const watchdog = setTimeout(() => forceExit(), 5000);
    if (watchdog.unref) watchdog.unref();
    try { await runtime.shutdown(signal); } catch (err) { logger.error(err.message); }
    clearTimeout(watchdog);
    process.exit(exitCode);
  };
  const fatal = (kind, error) => {
    if (shuttingDown) return;
    const detail = error && error.stack ? error.stack : (error && error.message ? error.message : String(error));
    logger.error(`${kind}: ${detail}`);
    // Continuing after an uncaught exception risks half-applied world actions
    // and a dashboard that lies about state. Shut down honestly instead.
    shutdown(kind, 1);
  };
  process.on('SIGINT', () => shutdown('Received SIGINT'));
  process.on('SIGTERM', () => shutdown('Received SIGTERM'));
  // A missed rejection (mineflayer-pathfinder stopping a superseded goal is
  // the common one) must not take five healthy sessions down. Log it with the
  // stack for a real fix; the per-action watchdog still bounds the task and
  // connection supervision keeps running. Uncaught synchronous exceptions stay
  // fatal because process state may be half-applied.
  process.on('unhandledRejection', (reason) => {
    const detail = reason && reason.stack ? reason.stack : (reason && reason.message ? reason.message : String(reason));
    logger.error(`unhandled rejection (runtime continues): ${detail}`);
  });
  process.on('uncaughtException', (err) => fatal('uncaught exception', err));
  return 0;
}

main().then((code) => {
  if (code) process.exit(code);
}).catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
