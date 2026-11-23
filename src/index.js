#!/usr/bin/env node
'use strict';

const { config, BOT_NAMES } = require('./config');
const { createRuntime } = require('./runtime');
const { Logger } = require('./logger');

function parseArgs(argv) {
  const args = { simulate: config.sim.enabled, dashboard: true, port: config.dashboard.port, host: config.dashboard.host, connect: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--simulate' || arg === '--mock' || arg === '--sim') args.simulate = true;
    else if (arg === '--live') args.simulate = false;
    else if (arg === '--no-dashboard') args.dashboard = false;
    else if (arg === '--no-connect') args.connect = false;
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function usage() {
  process.stdout.write(`Chickenbots V5

Usage: node src/index.js [options]

Options:
  --simulate        Run the deterministic mock world (no network)
  --live            Connect to MC_HOST/MC_PORT (default)
  --no-dashboard    Do not start the dashboard
  --no-connect      Start the runtime without connecting bots (diagnostics)
  --port <port>     Dashboard port (default ${config.dashboard.port})
  --host <host>     Dashboard bind address (default ${config.dashboard.host})
  -h, --help        Show this help

Default server: ${config.server.host}:${config.server.port} (version ${config.server.version})
Roster (fixed): ${BOT_NAMES.join(' ')}
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  const logger = new Logger({ level: config.logging.level });
  logger.info('Chickenbots V5 starting');
  logger.info(`roster: ${BOT_NAMES.join(', ')}`);
  logger.info(args.simulate ? 'mode: deterministic simulation' : `mode: live (${config.server.host}:${config.server.port}, version ${config.server.version})`);
  const runtime = await createRuntime({
    simulate: args.simulate,
    connect: args.connect,
    dashboard: args.dashboard,
    port: args.port,
    host: args.host,
    logger
  });
  const started = await runtime.start();
  if (started.dashboard) {
    process.stdout.write(`\n  Dashboard: http://127.0.0.1:${started.dashboard.port}  (bound ${started.dashboard.host}:${started.dashboard.port})\n`);
    process.stdout.write('  Live preview uses the sandbox proxy; the server accepts the forwarded host.\n\n');
  }
  if (args.simulate) {
    const state = runtime.state();
    process.stdout.write(`  Simulation ready: ${state.bots.filter((b) => b.ready).length}/5 bots, home ${state.home.x},${state.home.y},${state.home.z}\n`);
    process.stdout.write('  Try: node src/cli.js --simulate\n\n');
  } else if (args.connect) {
    process.stdout.write('  Autonomy is gated until all five bots connect, authenticate and spawn.\n');
    process.stdout.write(`  Connection errors are shown on the dashboard diagnostics tab.\n\n`);
  }
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal}; shutting down…\n`);
    try { await runtime.shutdown(signal); } catch (err) { logger.error(err.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error(`unhandled rejection: ${reason && reason.message ? reason.message : reason}`));
  process.on('uncaughtException', (err) => logger.error(`uncaught exception: ${err.stack || err.message}`));
  return 0;
}

main().then((code) => {
  if (code) process.exit(code);
}).catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
