'use strict';

/**
 * Exercise every registered command without touching a live server.
 *
 *  - every command and alias must resolve through the shared registry;
 *  - every command must answer `<name> --help` without side effects;
 *  - every command has at least one safe, real invocation in the deterministic
 *    simulation, except `stop` (which shuts the runtime down).
 *
 * A failure is reported with the actual command result. Nothing is marked PASS
 * because the command merely exists.
 */

const { createRuntime } = require('../src/runtime');

const SAFE_INVOCATIONS = Object.freeze({
  help: 'help',
  status: 'status',
  diagnostics: 'diagnostics',
  ai: 'ai status',
  queue: 'queue status',
  pause: 'pause',
  resume: 'resume',
  stop: null,
  bot: 'bot all status',
  goto: 'goto 0 65 0',
  team: 'team state',
  inventory: 'inventory all',
  survival: 'survival status',
  auto: 'auto eat off',
  eat: 'eat all',
  sleep: 'sleep auto',
  defend: 'defend all',
  explore: 'explore all stop',
  find: 'find forest',
  return: 'return home all',
  task: 'task list',
  batch: 'batch all status then status',
  players: 'players list',
  combat: 'combat status',
  food: 'food status',
  gear: 'gear status',
  potions: 'potions status',
  pve: 'pve status',
  pvp: 'pvp status',
  target: 'target list',
  totem: 'totem status',
  arena: 'arena off',
  follow: 'follow stop',
  guard: 'guard stop',
  duel: 'duel Alex',
  chop: 'chop stop',
  woodcutting: 'woodcutting status',
  mine: 'mine all stop',
  farm: 'farm all status',
  fish: 'fish all stop',
  home: 'home status',
  build: 'build status',
  builder: 'builder status',
  site: 'site status',
  materials: 'materials status',
  storage: 'storage status',
  excavate: 'excavate status',
  schematics: 'schematics stats'
});

// These are honest refusals/state answers, not internal command failures.
const EXPECTED_CODES = new Set(['CONFIRMATION_REQUIRED']);
const EXPECTED_ERRORS = [/not night/i];

function classify(entry) {
  if (entry.ok) return 'PASS';
  if (entry.result && EXPECTED_CODES.has(entry.result.code)) return 'EXPECTED';
  const error = String((entry.result && entry.result.error) || '');
  if (EXPECTED_ERRORS.some((pattern) => pattern.test(error))) return 'EXPECTED';
  return 'FAIL';
}

async function auditCommands({ logger = null } = {}) {
  const runtime = await createRuntime({ simulate: true, dashboard: false, connect: false, logger });
  await runtime.init();
  const rows = [];
  try {
    const commands = runtime.commands.list();
    for (const command of commands) {
      const help = await runtime.commands.execute(`${command.name} --help`, { source: 'internal' });
      const helpOk = help.ok === true && Boolean(help.result && help.result.help && help.result.help.usage);
      const aliases = (command.aliases || []).map((alias) => {
        const found = runtime.commands.registry.get(alias);
        return { alias, ok: Boolean(found && found.name === command.name) };
      });
      const safe = Object.prototype.hasOwnProperty.call(SAFE_INVOCATIONS, command.name)
        ? SAFE_INVOCATIONS[command.name]
        : undefined;
      let execution = null;
      if (safe) {
        execution = await runtime.commands.execute(safe, { source: 'internal' });
      }
      const executionStatus = safe ? classify(execution) : (command.name === 'stop' ? 'SKIPPED' : 'NO_PROBE');
      rows.push({
        name: command.name,
        category: command.category,
        aliases,
        help: helpOk,
        probe: safe,
        execution,
        status: !helpOk || aliases.some((a) => !a.ok) ? 'FAIL' : executionStatus
      });
    }
  } finally {
    await runtime.shutdown('command-audit');
  }
  const failures = rows.filter((row) => row.status === 'FAIL');
  const covered = rows.filter((row) => row.status === 'PASS' || row.status === 'EXPECTED').length;
  return { ok: failures.length === 0, total: rows.length, covered, failures, rows };
}

if (require.main === module) {
  auditCommands().then((report) => {
    for (const row of report.rows) {
      const detail = row.execution && row.execution.ok === false
        ? ` :: ${row.execution.result && row.execution.result.error}`
        : '';
      console.log(`${row.status.padEnd(8)} ${row.category.padEnd(12)} ${row.name}${row.probe ? ` <- ${row.probe}` : ''}${detail}`);
    }
    console.log(`\n${report.covered}/${report.total} commands executed or help-audited; ${report.failures.length} failure(s)`);
    if (!report.ok) process.exitCode = 1;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { auditCommands, SAFE_INVOCATIONS };
