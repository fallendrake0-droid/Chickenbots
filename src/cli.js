#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { config, validateConfig } = require('./config');
const { createRuntime } = require('./runtime');
const { Logger } = require('./logger');
const { printStartupBanner } = require('./branding');
const { acquireLiveLock } = require('./liveLock');

function usage() {
  process.stdout.write(`Chickenbots V6 CLI

Usage: node src/cli.js [--live] [--no-dashboard] ["command"]

Without a command, an interactive prompt is opened. The CLI uses exactly the
same validated command handler as the dashboard and the internal API.

Examples:
  node src/cli.js --simulate "status"
  node src/cli.js --simulate "schematics stats"
  node src/cli.js --simulate "excavate preview radius 100 64 100 8 4"
`);
}

function printResult(result) {
  const payload = result.result || result;
  const text = JSON.stringify(payload, null, 2);
  const ok = payload.ok !== false;
  process.stdout.write(`${ok ? '✓' : '✗'} ${result.command || ''}\n`);
  process.stdout.write(text.length > 8000 ? `${text.slice(0, 8000)}\n… truncated` : text);
  process.stdout.write('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { usage(); return; }
  const live = args.includes('--live');
  const simulate = !live || args.includes('--simulate');
  const commandArgs = args.filter((a) => !a.startsWith('--'));
  const logger = new Logger({ level: config.logging.level });
  const validation = validateConfig(config, { requireCredentials: live && !simulate, simulate });
  for (const warning of validation.warnings) logger.warn(`config warning: ${warning}`);
  if (!validation.ok) {
    for (const error of validation.errors) logger.error(`config error: ${error}`);
    process.stderr.write('\nRefusing to start with an invalid configuration. Fix the above and retry.\n');
    return 2;
  }
  if (!commandArgs.length) printStartupBanner();
  let liveLock = null;
  if (live && !simulate) {
    liveLock = acquireLiveLock();
    if (!liveLock.ok) {
      logger.error(`another live runtime is already running (pid ${liveLock.pid}); use its dashboard instead of opening a second set of logins`);
      return 2;
    }
  }
  const runtime = await createRuntime({ simulate, connect: live && !simulate, dashboard: false, logger });
  await runtime.start();
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await runtime.shutdown(reason); } catch (err) { process.stderr.write(`shutdown error: ${err.message}\n`); }
    if (liveLock && typeof liveLock.release === 'function') liveLock.release();
  };
  const stop = async (signal) => {
    process.stdout.write(`\n${signal}; shutting down…\n`);
    const watchdog = setTimeout(() => process.exit(130), 5000);
    if (watchdog.unref) watchdog.unref();
    await shutdown(signal);
    clearTimeout(watchdog);
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  if (simulate) {
    process.stdout.write(`Simulation ready: ${runtime.bots.size} bots, home ${runtime.home.x},${runtime.home.y},${runtime.home.z}\n`);
  } else {
    process.stdout.write('Live mode: connections are negotiated in the background; autonomy stays gated until every bot is ready.\n');
  }
  if (commandArgs.length) {
    const line = commandArgs.join(' ');
    const result = await runtime.executeCommand(line, { source: 'cli', operator: 'cli' });
    printResult(result);
    await shutdown('cli command complete');
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'chickenbots> ' });
  process.stdout.write("Type 'help' for commands, 'exit' to quit.\n");
  rl.prompt();
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }
    if (['exit', 'quit'].includes(trimmed)) {
      rl.close();
      return;
    }
    try {
      const result = await runtime.executeCommand(trimmed, { source: 'cli', operator: 'cli', confirmed: /\bconfirm\b/.test(trimmed) });
      printResult(result);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
    }
    rl.prompt();
  });
  rl.on('close', async () => {
    await shutdown('cli exit');
    process.stdout.write('\nbye\n');
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
