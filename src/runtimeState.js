'use strict';

const { config } = require('./config');
const { validateLibrary } = require('./schematics/validate');
const { connectionStatus } = require('./bot/status');

/**
 * One coherent snapshot for the dashboard, CLI and command results. All values
 * come from live objects; nothing is synthesised to look healthy.
 */
function statusSnapshot(services) {
  const startedAt = Date.now();
  const sections = {};
  let cursor = startedAt;
  const lap = (name) => {
    const at = Date.now();
    sections[name] = at - cursor;
    cursor = at;
    return at;
  };
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
  lap('bots');
  const actionList = services.actions ? services.actions.list() : [];
  const actionStatus = actionList.map((a) => {
    try { return a.status(); } catch (err) { return { bot: a.bot ? a.bot.name : 'unknown', error: err.message }; }
  });
  lap('actions');
  const leader = services.coordinator ? services.coordinator.leader : null;
  let library = null;
  // A snapshot never parses the 20 MB manifest. The generated aggregate
  // summary is enough for counts, categories and timestamps; individual
  // designs stay lazy until a schematics command/page asks for them.
  try { library = services.library && (services.library.summaryLoaded || services.library.loadedInMemory) ? services.library.stats() : null; }
  catch (err) { library = { error: `library stats failed: ${err.message}` }; }
  const buildValues = [...(services.builders ? services.builders.values() : [])];
  const builds = buildValues.map((b) => {
    try { return b.status(); }
    catch (err) {
      return { buildId: b.id, name: b.schematic && b.schematic.name ? b.schematic.name : b.id, state: 'ERROR', error: `status failed: ${err.message}`, percentComplete: 0, tasks: [] };
    }
  });
  lap('builds');
  const firstEngine = buildValues.find((b) => b.engine)?.engine || null;
  let excavationStatus = null;
  try { excavationStatus = services.excavation ? services.excavation.status() : null; }
  catch (err) { excavationStatus = { ok: false, error: `excavation status failed: ${err.message}`, active: [], counts: null }; }
  lap('excavation');
  let combatTeamStatus = null;
  let combatOverview = null;
  try {
    // Reuse the per-controller combat objects from the action snapshot instead
    // of asking every controller to reassess entities and equipment again.
    const combatStatusByBot = new Map();
    for (const status of actionStatus) {
      if (status && status.bot && status.combat) combatStatusByBot.set(status.bot, status.combat);
    }
    combatTeamStatus = services.combatTeam ? services.combatTeam.status({ controllerStatus: combatStatusByBot }) : null;
    lap('combat-team');
    combatOverview = services.combatTeam ? {
      enabled: services.combatTeam.enabled,
      mode: services.combatTeam.mode,
      focus: services.combatTeam.focus ? { id: services.combatTeam.focus.id, name: services.combatTeam.focus.name || services.combatTeam.focus.type } : null,
      roles: services.combatTeam.roles,
      totems: services.combatTeam.list().reduce((sum, controller) => sum + controller.totems.count(), 0),
      // One definition of "engaged" for the whole snapshot. The team status
      // already computed it; a second, narrower filter here made the overview
      // and the combat page disagree whenever a bot was healing or defending.
      engaged: combatTeamStatus && Number.isFinite(combatTeamStatus.engaged) ? combatTeamStatus.engaged : 0
    } : null;
  } catch (err) {
    combatTeamStatus = { error: `combat team status failed: ${err.message}` };
    combatOverview = { error: `combat team status failed: ${err.message}` };
  }
  let constructionState = null;
  try { constructionState = services.construction ? services.construction.state() : null; }
  catch (err) { constructionState = { error: `construction state failed: ${err.message}` }; }
  lap('construction');
  const board = services.taskBoard;
  const deadlocks = board ? board.detectDeadlocks() : [];
  const boardStats = board ? board.stats({ deadlocks }) : null;
  const runtime = services.runtime ? services.runtime.state({ combatTeamStatus }) : null;
  lap('runtime');
  const safetyByName = new Map((runtime && runtime.bots ? runtime.bots : []).map((bot) => [bot.name, bot.safety || null]));
  const byBot = {};
  for (const status of actionStatus) if (status && status.bot) byBot[status.bot] = status;
  // Controller status is cache-only. Before the startup warm-up has filled a
  // controller's slot, its section is null. Keeping those nulls in a per-bot
  // array made the browser pages read `row.health` / `row.ok` from null and
  // throw during a cold `/api/state`; an empty section is the honest, safe
  // representation of "not reported yet".
  const controllerRows = (key) => actionStatus.map((status) => status && status[key]).filter(Boolean);
  const online = summaries.filter((s) => s.online === true).length;
  const ready = summaries.filter((s) => s.gameplayReady === true).length;
  const alerts = buildAlerts(summaries, board, services, { excavationStatus, boardStats, deadlocks });
  lap('alerts');
  const snapshot = {
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
      tasks: boardStats,
      excavation: excavationStatus ? {
        active: excavationStatus.active ? excavationStatus.active.map((e) => ({ id: e.id, state: e.state, mode: e.mode, percent: e.percent })) : [],
        counts: excavationStatus.counts || null
      } : null,
      builds: builds.map((b) => ({ id: b.buildId, name: b.name, state: b.state, percent: b.percentComplete, tasks: b.tasks })),
      combat: combatOverview,
      construction: services.construction ? {
        activeId: services.construction.activeId,
        projects: services.construction.projects.size,
        activeStatus: services.construction.activeProject()?.status || null,
        activeProgress: services.construction.activeProject()?.progress || 0,
        phase: services.construction.activeProject()?.buildPhases.find((phase) => phase.status !== 'COMPLETE')?.id || null
      } : null,
      library: library ? { count: library.count, unique: library.uniqueGeometry, minimum: library.minimumRequired } : null,
      alerts,
    },
    team: {
      state: services.coordinator ? services.coordinator.getState() : null,
      memory: services.memory ? { stats: services.memory.stats, observations: services.memory.observations.slice(-25).map(publicObservation), facts: [...services.memory.facts.entries()].map(([key, value]) => ({ key, value })) } : null,
      locks: board ? [...board.locks.values()] : [],
      regions: board ? [...board.regions.values()] : [],
      deadlocks,
      comms: services.comms ? services.comms.recent(25) : []
    },
    survival: controllerRows('survival'),
    combat: controllerRows('combat'),
    recovery: controllerRows('recovery'),
    // Seen players are directory data only. Following or guarding a player
    // never adds them to the PvP target list.
    players: services.players ? services.players.status() : { count: 0, online: 0, rows: [], stats: null },
    playerWatch: controllerRows('players'),
    combatTeam: combatTeamStatus,
    inventory: {
      ledger: services.ledger ? services.ledger.snapshot() : null,
      bots: controllerRows('inventory')
    },
    mining: controllerRows('mining'),
    excavation: {
      status: excavationStatus,
      history: services.excavation ? services.excavation.history.slice(-15) : [],
      previews: services.excavation ? [...services.excavation.previews.values()].map((p) => ({ previewId: p.previewId, mode: p.mode, bounds: p.bounds, volume: p.volume, warnings: p.warnings, authorizationRequired: p.authorizationRequired })) : []
    },
    woodcutting: controllerRows('woodcutting'),
    farming: controllerRows('farming'),
    sleep: controllerRows('sleep'),
    fishing: controllerRows('fishing'),
    exploration: controllerRows('exploration'),
    construction: constructionState,
    builder: {
      builds,
      atHome: byBot[leader] ? byBot[leader].homeBase : null,
      imported: services.imported ? [...services.imported.values()].map((s) => ({ id: s.id, name: s.name, blocks: s.blocks.length, dimensions: s.dimensions })) : []
    },
    schematics: {
      stats: library,
      categories: library && Array.isArray(library.categories) ? library.categories.slice(0, 30) : [],
      recent: library ? (library.generatedAt || null) : null,
      custom: library && library.custom ? library.custom : null
    },
    building: {
      config: config.building,
      registry: firstEngine ? firstEngine.registry.describe() : null,
      builds: buildValues.map((builder, index) => {
        const status = builds[index] || { state: 'ERROR', percentComplete: 0 };
        let statuses = null;
        let verification = null;
        try { statuses = builder.engine ? builder.engine.statusCounts() : null; } catch (_) { statuses = null; }
        try { verification = builder.engine ? builder.engine.auditSummary() : null; } catch (_) { verification = null; }
        return {
          id: builder.id,
          name: builder.schematic && builder.schematic.name ? builder.schematic.name : builder.id,
          state: status.state,
          percent: status.percentComplete,
          statuses,
          verification
        };
      }),
      custom: services.library && services.library.custom ? services.library.custom.statsSummary() : null,
      projects: (() => { try { return services.construction ? services.construction.list() : []; } catch (_) { return []; } })()
    },
    workZone: services.runtime && services.runtime.actions ? (() => {
      const first = services.runtime.actions.list()[0];
      return first && first.mining ? first.mining.zone() : null;
    })() : null,
    reservations: services.runtime && services.runtime.reservations ? services.runtime.reservations.status() : null,
    homeBase: {
      home: services.runtime ? services.runtime.home : null,
      source: services.runtime ? services.runtime.homeSource : null,
      builds: builds.filter((b) => String(b.buildId).startsWith('home-')),
      perBot: actionStatus.filter((a) => a && a.homeBase).map((a) => ({ bot: a.bot, ...a.homeBase }))
    },
    taskManager: {
      stats: boardStats,
      tasks: board ? board.listTasks().slice(-100).map(publicTask) : [],
      objectives: board ? board.listObjectives().map((o) => {
        const linked = (o.tasks || []).map((id) => board.getTask(id)).filter(Boolean);
        const claimed = [...new Set(linked.map((task) => task.claimedBy).filter(Boolean))];
        return {
          id: o.id, title: o.title, description: o.description, status: o.status, priority: o.priority,
          progress: o.progress, assignedBots: [...new Set([...(o.assignedBots || []), ...claimed])],
          taskCount: linked.length, completionCondition: o.completionCondition,
          blockedReason: o.blockedReason || null, failure: o.failure || null
        };
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
          authProfile: config.server.authProfile,
          authCommandsEnabled: config.server.authCommandsEnabled,
          authRegistrationEnabled: config.server.authRegistrationEnabled,
          credentialCount: Object.keys(config.server.credentials || {}).length,
          credentialsError: config.server.credentialsError || null
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
        authProfile: s.authProfile || null,
        connectionAuth: s.connectionAuth || null,
        serverBrand: s.serverBrand || null,
        capabilities: s.compatibilities || null,
        safety: safetyByName.get(s.name) || null,
        keepAlive: s.keepAlive || null,
        ticker: s.ticker || null,
        lastDisconnect: s.lastDisconnect || null
      })),
      commands: services.commands ? services.commands.recent(20) : [],
      plugins: summaries.map((s) => ({
        name: s.name,
        authProfile: s.authProfile || null,
        connectionAuth: s.connectionAuth || null,
        serverBrand: s.serverBrand || null,
        capabilities: s.compatibilities || null
      }))
    }
  };
  // Measure after the whole tree (including task objectives and builder
  // projections) has been materialised, not just the early sections.
  const actionCache = actionStatus.map((a) => ({
    bot: a.bot || null,
    maxAgeMs: a.statusCache ? a.statusCache.maxAgeMs : null,
    refreshedAt: a.statusCache ? a.statusCache.refreshedAt : null,
    entries: a.statusCache ? a.statusCache.entries : null
  }));
  const cacheAges = actionCache.map((entry) => entry.maxAgeMs).filter((ms) => typeof ms === 'number');
  snapshot.freshness = {
    generatedAt: snapshot.generatedAt,
    actionStatus: actionCache,
    maxActionStatusAgeMs: cacheAges.length ? Math.max(...cacheAges) : null,
    // True when every controller section in `actions` is present and was
    // refreshed within two runtime state-sync periods (12 controllers at one
    // per tick). Anything older is surfaced instead of silently rendered.
    actionStatusFresh: cacheAges.length > 0 && Math.max(...cacheAges) < 12000
  };
  if (!snapshot.freshness.actionStatusFresh) {
    // A cache that stopped refreshing must be visible, not silently rendered
    // as if the last value were live.
    snapshot.overview.alerts.push({
      level: 'warn',
      message: `action status cache is stale (max age ${snapshot.freshness.maxActionStatusAgeMs === null ? 'unknown' : `${snapshot.freshness.maxActionStatusAgeMs}ms`})`
    });
  }
  snapshot.performance = { snapshotMs: Date.now() - startedAt, sections, statusCache: snapshot.freshness };
  return snapshot;
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

function buildAlerts(summaries, board, services, { excavationStatus = null, boardStats = null, deadlocks = null } = {}) {
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
    const failed = boardStats && boardStats.byStatus && Number.isFinite(boardStats.byStatus.FAILED)
      ? boardStats.byStatus.FAILED
      : board.listTasks({ status: 'FAILED' }).length;
    if (failed) alerts.push({ level: 'warn', message: `${failed} failed task(s)` });
    const stalled = deadlocks === null ? board.detectDeadlocks() : deadlocks;
    if (stalled.length) alerts.push({ level: 'error', message: `${stalled.length} deadlock(s)` });
  }
  if (excavationStatus && excavationStatus.counts && excavationStatus.counts.INCOMPLETE) {
    alerts.push({ level: 'warn', message: `${excavationStatus.counts.INCOMPLETE} incomplete excavation(s)` });
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
