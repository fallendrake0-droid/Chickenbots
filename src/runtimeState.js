'use strict';

const { config } = require('./config');
const { validateLibrary } = require('./schematics/validate');

/**
 * One coherent snapshot for the dashboard, CLI and command results. All values
 * come from live objects; nothing is synthesised to look healthy.
 */
function statusSnapshot(services) {
  const bots = [...(services.bots ? services.bots.values() : [])];
  const summaries = bots.map((bot) => (typeof bot.summary === 'function' ? bot.summary() : { name: bot.name, position: bot.position }));
  const actionList = services.actions ? services.actions.list() : [];
  const actionStatus = actionList.map((a) => a.status());
  const leader = services.coordinator ? services.coordinator.leader : null;
  const library = services.library && services.library.loaded ? services.library.stats() : null;
  const builds = [...(services.builders ? services.builders.values() : [])].map((b) => b.status());
  const excavationStatus = services.excavation ? services.excavation.status() : null;
  const board = services.taskBoard;
  const runtime = services.runtime ? services.runtime.state() : null;
  const byBot = {};
  for (const status of actionStatus) byBot[status.bot] = status;
  const online = summaries.filter((s) => s.connected !== false && s.spawned !== false).length;
  return {
    generatedAt: new Date().toISOString(),
    mode: services.mode || (config.sim.enabled ? 'simulation' : 'live'),
    uptimeMs: runtime ? runtime.uptimeMs : 0,
    bots: summaries,
    overview: {
      online,
      total: summaries.length,
      leader,
      autonomy: runtime,
      tasks: board ? board.stats() : null,
      excavation: excavationStatus ? {
        active: excavationStatus.active ? excavationStatus.active.map((e) => ({ id: e.id, state: e.state, mode: e.mode, percent: e.percent })) : [],
        counts: excavationStatus.counts || null
      } : null,
      builds: builds.map((b) => ({ id: b.buildId, name: b.name, state: b.state, percent: b.percentComplete, tasks: b.tasks })),
      library: library ? { count: library.count, unique: library.uniqueGeometry, minimum: library.minimumRequired } : null,
      alerts: buildAlerts(summaries, board, services)
    },
    team: {
      state: services.coordinator ? services.coordinator.getState() : null,
      memory: services.memory ? { stats: services.memory.stats, observations: services.memory.observations.slice(-25).map(publicObservation), facts: [...services.memory.facts.entries()].map(([key, value]) => ({ key, value })) } : null,
      locks: board ? [...board.locks.values()] : [],
      regions: board ? [...board.regions.values()] : [],
      deadlocks: board ? board.detectDeadlocks() : [],
      comms: services.comms ? services.comms.recent(25) : []
    },
    survival: actionStatus.map((a) => a.survival),
    combat: actionStatus.map((a) => a.combat),
    inventory: {
      ledger: services.ledger ? services.ledger.summary() : null,
      bots: actionStatus.map((a) => a.inventory)
    },
    mining: actionStatus.map((a) => a.mining),
    excavation: {
      status: excavationStatus,
      history: services.excavation ? services.excavation.history.slice(-15) : [],
      previews: services.excavation ? [...services.excavation.previews.values()].map((p) => ({ previewId: p.previewId, mode: p.mode, bounds: p.bounds, volume: p.volume, warnings: p.warnings, authorizationRequired: p.authorizationRequired })) : []
    },
    woodcutting: actionStatus.map((a) => a.woodcutting),
    farming: actionStatus.map((a) => a.farming),
    sleep: actionStatus.map((a) => a.sleep),
    exploration: actionStatus.map((a) => a.exploration),
    builder: {
      builds,
      atHome: byBot[leader] ? byBot[leader].homeBase : null,
      imported: services.imported ? [...services.imported.values()].map((s) => ({ id: s.id, name: s.name, blocks: s.blocks.length, dimensions: s.dimensions })) : []
    },
    schematics: {
      stats: library,
      categories: services.library && services.library.loaded ? services.library.categories().slice(0, 30) : [],
      recent: services.library && services.library.loaded ? services.library.manifest.generatedAt : null
    },
    homeBase: {
      home: services.runtime ? services.runtime.home : null,
      builds: builds.filter((b) => String(b.buildId).startsWith('home-') || String(b.name || '').length),
      perBot: actionStatus.map((a) => ({ bot: a.bot, ...a.homeBase }))
    },
    taskManager: {
      stats: board ? board.stats() : null,
      tasks: board ? board.listTasks().slice(-100).map(publicTask) : [],
      objectives: board ? board.listObjectives().map((o) => ({ id: o.id, title: o.title, status: o.status, progress: o.progress })) : []
    },
    diagnostics: {
      runtime,
      config: {
        roster: config.team.names,
        server: { host: config.server.host, port: config.server.port, version: config.server.version },
        dashboard: { host: config.dashboard.host, port: config.dashboard.port },
        pvp: config.autonomy.pvp,
        ai: config.autonomy.ai.enabled
      },
      bots: summaries.map((s) => ({ name: s.name, connected: s.connected, spawned: s.spawned, authenticated: s.authenticated, ready: s.ready !== undefined ? s.ready : s.connected && s.spawned, health: s.health, food: s.food, position: s.position, lastError: s.lastError || null })),
      commands: services.commands ? services.commands.recent(20) : []
    }
  };
}

function publicObservation(obs) {
  return {
    id: obs.id, type: obs.type, resource: obs.resource, position: obs.position, reportedBy: obs.reportedBy,
    timestamp: obs.timestamp, confidence: obs.confidence, status: obs.status, expiresAt: obs.expiresAt, data: obs.data
  };
}

function publicTask(task) {
  return {
    id: task.id, type: task.type, label: task.label, status: task.status, priority: task.priority,
    claimedBy: task.claimedBy, region: task.region, units: task.units, dependsOn: task.dependsOn,
    attempts: task.attempts, lastError: task.lastError, verified: Boolean(task.verification)
  };
}

function buildAlerts(summaries, board, services) {
  const alerts = [];
  for (const bot of summaries) {
    if (bot.connected === false) alerts.push({ level: 'error', bot: bot.name, message: 'disconnected' });
    else if (bot.spawned === false) alerts.push({ level: 'warn', bot: bot.name, message: 'not spawned' });
    if (bot.health !== undefined && bot.health <= 8) alerts.push({ level: 'critical', bot: bot.name, message: `health ${bot.health}` });
    if (bot.food !== undefined && bot.food <= 6) alerts.push({ level: 'warn', bot: bot.name, message: `food ${bot.food}` });
    if (bot.inLava) alerts.push({ level: 'critical', bot: bot.name, message: 'in lava' });
    if (bot.lastError) alerts.push({ level: 'warn', bot: bot.name, message: bot.lastError });
  }
  if (board) {
    const failed = board.listTasks({ status: 'FAILED' });
    if (failed.length) alerts.push({ level: 'warn', message: `${failed.length} failed task(s)` });
    const deadlocks = board.detectDeadlocks();
    if (deadlocks.length) alerts.push({ level: 'error', message: `${deadlocks.length} deadlock(s)` });
  }
  if (services.excavation) {
    const status = services.excavation.status();
    if (status && status.counts && status.counts.INCOMPLETE) alerts.push({ level: 'warn', message: `${status.counts.INCOMPLETE} incomplete excavation(s)` });
  }
  return alerts;
}

/** Compact validation for the dashboard diagnostics tab. */
function quickLibraryCheck(services) {
  if (!services.library || !services.library.loaded) return { ok: false, detail: 'library not generated' };
  const report = validateLibrary(services.library.manifest, { regenerate: false });
  return { ok: report.passed, detail: `${report.totalEntries} designs, ${report.uniqueDesigns} unique` };
}

module.exports = { statusSnapshot, quickLibraryCheck, publicObservation, publicTask };
