'use strict';

const { config } = require('./config');
const { validateLibrary } = require('./schematics/validate');
const { connectionStatus } = require('./bot/status');

/**
 * One coherent snapshot for the dashboard, CLI and command results. All values
 * come from live objects; nothing is synthesised to look healthy.
 */
function statusSnapshot(services) {
  const bots = [...(services.bots ? services.bots.values() : [])];
  const summaries = bots.map((bot) => {
    const status = connectionStatus(bot);
    try {
      const summary = typeof bot.summary === 'function' ? bot.summary() : { name: bot.name, position: bot.position };
      // The connection verdict is computed once, server-side, and attached to
      // every summary. Clients render this instead of re-deriving "online"
      // from three flags in several places. A ready/online session is
      // authenticated by definition, so a stale legacy flag cannot paint a
      // live bot as "Auth failed".
      return {
        ...summary,
        ...status,
        // One verdict, computed in src/bot/status.js. A spawned bot stays
        // online even when it is not gameplay-ready; conversely an auth-pending
        // session is online but never `ready`.
        connected: status.transportConnected,
        spawned: status.spawned,
        serverPlayerListed: status.serverPlayerListed,
        authenticated: status.authenticated,
        authPending: status.authPending,
        ready: status.gameplayReady,
        gameplayReady: status.gameplayReady
      };
    } catch (err) {
      // A broken disconnected adapter must not blank the whole dashboard and
      // leave the previous (possibly all-online) snapshot on screen.
      return {
        ...status,
        name: bot.name,
        connected: false,
        spawned: false,
        authenticated: false,
        ready: false,
        position: bot.position || null,
        health: 0,
        food: 0,
        lastError: `summary failed: ${err.message}`,
        online: false,
        status: 'offline',
        statusLabel: 'Offline',
        statusDetail: `Summary failed: ${err.message}`
      };
    }
  });
  const actionList = services.actions ? services.actions.list() : [];
  const actionStatus = actionList.map((a) => {
    try { return a.status(); } catch (err) { return { bot: a.bot ? a.bot.name : 'unknown', error: err.message }; }
  });
  const leader = services.coordinator ? services.coordinator.leader : null;
  const library = services.library && services.library.loaded ? services.library.stats() : null;
  const buildValues = [...(services.builders ? services.builders.values() : [])];
  const builds = buildValues.map((b) => b.status());
  const firstEngine = buildValues.find((b) => b.engine)?.engine || null;
  const excavationStatus = services.excavation ? services.excavation.status() : null;
  const board = services.taskBoard;
  const runtime = services.runtime ? services.runtime.state() : null;
  const byBot = {};
  for (const status of actionStatus) byBot[status.bot] = status;
  const online = summaries.filter((s) => s.online === true).length;
  const ready = summaries.filter((s) => s.gameplayReady === true).length;
  return {
    generatedAt: new Date().toISOString(),
    mode: services.mode || (config.sim.enabled ? 'simulation' : 'live'),
    uptimeMs: runtime ? runtime.uptimeMs : 0,
    bots: summaries,
    overview: {
      online,
      ready,
      total: summaries.length,
      leader,
      autonomy: runtime,
      tasks: board ? board.stats() : null,
      excavation: excavationStatus ? {
        active: excavationStatus.active ? excavationStatus.active.map((e) => ({ id: e.id, state: e.state, mode: e.mode, percent: e.percent })) : [],
        counts: excavationStatus.counts || null
      } : null,
      builds: builds.map((b) => ({ id: b.buildId, name: b.name, state: b.state, percent: b.percentComplete, tasks: b.tasks })),
      combat: services.combatTeam ? {
        enabled: services.combatTeam.enabled,
        mode: services.combatTeam.mode,
        focus: services.combatTeam.focus ? { id: services.combatTeam.focus.id, name: services.combatTeam.focus.name || services.combatTeam.focus.type } : null,
        roles: services.combatTeam.roles,
        totems: services.combatTeam.list().reduce((sum, controller) => sum + controller.totems.count(), 0),
        engaged: services.combatTeam.list().filter((controller) => ['ENGAGING', 'APPROACHING', 'RETREATING', 'TOTEM_EMERGENCY'].includes(controller.state)).length
      } : null,
      construction: services.construction ? {
        activeId: services.construction.activeId,
        projects: services.construction.projects.size,
        activeStatus: services.construction.activeProject()?.status || null,
        activeProgress: services.construction.activeProject()?.progress || 0,
        phase: services.construction.activeProject()?.buildPhases.find((phase) => phase.status !== 'COMPLETE')?.id || null
      } : null,
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
    recovery: actionStatus.map((a) => a.recovery).filter(Boolean),
    combatTeam: services.combatTeam ? services.combatTeam.status() : null,
    inventory: {
      ledger: services.ledger ? services.ledger.snapshot() : null,
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
    fishing: actionStatus.map((a) => a.fishing),
    exploration: actionStatus.map((a) => a.exploration),
    construction: services.construction ? services.construction.state() : null,
    builder: {
      builds,
      atHome: byBot[leader] ? byBot[leader].homeBase : null,
      imported: services.imported ? [...services.imported.values()].map((s) => ({ id: s.id, name: s.name, blocks: s.blocks.length, dimensions: s.dimensions })) : []
    },
    schematics: {
      stats: library,
      categories: services.library && services.library.loaded ? services.library.categories().slice(0, 30) : [],
      recent: services.library && services.library.loaded ? services.library.manifest.generatedAt : null,
      custom: services.library && services.library.customStore ? services.library.customStore.statsSummary() : null
    },
    building: {
      config: config.building,
      registry: firstEngine ? firstEngine.registry.describe() : null,
      builds: buildValues.map((builder) => ({
        id: builder.id,
        name: builder.schematic.name,
        state: builder.status().state,
        percent: builder.status().percentComplete,
        statuses: builder.engine ? builder.engine.statusCounts() : null,
        verification: builder.engine ? builder.engine.auditSummary() : null
      })),
      custom: services.library && services.library.customStore ? services.library.customStore.statsSummary() : null,
      projects: services.construction ? services.construction.list() : []
    },
    homeBase: {
      home: services.runtime ? services.runtime.home : null,
      source: services.runtime ? services.runtime.homeSource : null,
      builds: builds.filter((b) => String(b.buildId).startsWith('home-')),
      perBot: actionStatus.map((a) => ({ bot: a.bot, ...a.homeBase }))
    },
    taskManager: {
      stats: board ? board.stats() : null,
      tasks: board ? board.listTasks().slice(-100).map(publicTask) : [],
      objectives: board ? board.listObjectives().map((o) => {
        const linked = (o.tasks || []).map((id) => board.getTask(id)).filter(Boolean);
        const claimed = [...new Set(linked.map((task) => task.claimedBy).filter(Boolean))];
        return { id: o.id, title: o.title, description: o.description, status: o.status, priority: o.priority, progress: o.progress, assignedBots: [...new Set([...(o.assignedBots || []), ...claimed])], taskCount: linked.length, completionCondition: o.completionCondition };
      }) : []
    },
    diagnostics: {
      runtime,
      config: {
        roster: config.team.names,
        server: {
          host: config.server.host,
          port: config.server.port,
          version: config.server.version,
          resolvedVersion: runtime ? runtime.serverVersion : null,
          versionError: runtime ? runtime.serverVersionError : null,
          joinIntervalMs: config.server.joinIntervalMs,
          joinJitterMs: config.server.joinJitterMs,
          connectStaggerMs: config.server.connectStaggerMs,
          connectJitterMs: config.server.connectJitterMs,
          rejoinDelayMs: config.server.rejoinDelayMs,
          authMode: config.server.authMode,
          authCommandsEnabled: config.server.authCommandsEnabled
        },
        dashboard: { host: config.dashboard.host, port: config.dashboard.port, allowInsecure: config.dashboard.allowInsecure, tokenRequired: Boolean(config.dashboard.token) },
        pve: config.autonomy.pve,
        pvp: config.autonomy.pvp,
        ai: config.autonomy.ai.enabled
      },
      bots: summaries.map((s) => ({
        name: s.name,
        online: s.online,
        status: s.status,
        statusLabel: s.statusLabel,
        statusDetail: s.statusDetail,
        connected: s.connected,
        spawned: s.spawned,
        serverPlayerListed: s.serverPlayerListed,
        authenticated: s.authenticated,
        authPending: s.authPending,
        authRequiredManual: s.authRequiredManual,
        ready: s.ready === true,
        gameplayReady: s.gameplayReady === true,
        health: s.health,
        food: s.food,
        position: s.position,
        lastEventAt: s.lastEventAt || null,
        lastEventAgeMs: s.lastEventAgeMs,
        lastError: s.lastError || null,
        sessionId: s.sessionId || null,
        stage: s.stage || null,
        connection: s.connection || null,
        stageTimings: s.stageTimings || null,
        keepAlive: s.keepAlive || null,
        ticker: s.ticker || null,
        lastDisconnect: s.lastDisconnect || null
      })),
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
    claimedBy: task.claimedBy, objectiveId: task.objectiveId, region: task.region, units: task.units, dependsOn: task.dependsOn,
    attempts: task.attempts, maxAttempts: task.maxAttempts, lastError: task.lastError, verified: Boolean(task.verification),
    claimedAt: task.claimedAt, claimExpiresAt: task.claimExpiresAt, startedAt: task.startedAt, completedAt: task.completedAt,
    createdAt: task.createdAt, lastUpdateAt: task.lastUpdateAt || null, lastProgressAt: task.lastProgressAt || null,
    sourceCommand: task.sourceCommand || null, createdBy: task.createdBy || null,
    stallCycles: task.stallCycles || 0, noProgressSince: task.noProgressSince || null,
    verification: task.verification || null, progressNote: task.progressNote || null
  };
}

function buildAlerts(summaries, board, services) {
  const alerts = [];
  for (const bot of summaries) {
    if (bot.online !== true) {
      const level = bot.status === 'joining' || bot.status === 'authenticating' || bot.status === 'initialising' ? 'warn' : 'error';
      alerts.push({ level, bot: bot.name, message: bot.statusDetail || `not online (${bot.status || 'unknown'})` });
    }
    if (bot.health !== undefined && bot.health <= 8 && bot.online === true) alerts.push({ level: 'critical', bot: bot.name, message: `health ${bot.health}` });
    if (bot.food !== undefined && bot.food <= 6) alerts.push({ level: 'warn', bot: bot.name, message: `food ${bot.food}` });
    if (bot.inLava) alerts.push({ level: 'critical', bot: bot.name, message: 'in lava' });
    if (bot.lastError && bot.online === true) alerts.push({ level: 'warn', bot: bot.name, message: bot.lastError });
  }
  if (services.runtime && services.runtime.serverVersionError) {
    alerts.push({ level: 'error', message: `server version: ${services.runtime.serverVersionError}` });
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
  if (services.construction) {
    const project = services.construction.activeProject();
    if (project && ['BLOCKED', 'AWAITING_MATERIALS', 'AWAITING_STORAGE'].includes(project.status)) {
      alerts.push({ level: 'warn', message: `construction ${project.status.toLowerCase()}: ${project.blockedReason || project.id}` });
    }
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
