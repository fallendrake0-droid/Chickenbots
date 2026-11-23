import { api, ApiError } from './api.js';
import { botOnline } from './botStatus.js';
import { configureRoster } from './utils.js';

const PREFS_KEY = 'chickenbots.prefs.v1';
const SAMPLE_LIMIT = 80;
const LOG_LIMIT = 400;

function loadPrefs() {
  try {
    return { sidebarCollapsed: false, collapsedGroups: [], notificationsReadAt: 0, ...(JSON.parse(localStorage.getItem(PREFS_KEY)) || {}) };
  } catch (_) {
    return { sidebarCollapsed: false, collapsedGroups: [], notificationsReadAt: 0 };
  }
}

export const prefs = loadPrefs();

export function savePrefs(patch) {
  Object.assign(prefs, patch);
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* storage disabled */ }
  emit('prefs');
}

export const state = {
  snapshot: null,
  commands: [],
  commandHistory: [],
  taskTypes: [],
  settings: null,
  logs: [],
  logSeq: 0,
  logStats: null,
  samples: [],
  connection: 'connecting',
  connectionDetail: 'Connecting to the operations service…',
  lastStateAt: 0,
  lastLogAt: 0,
  error: null,
  loading: true,
  started: false
};

const listeners = new Set();
let eventSource = null;
let pollTimer = null;
let logTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(kind = 'state') {
  for (const listener of listeners) {
    try { listener(kind, state); } catch (err) { console.error('listener failed', err); }
  }
}

function setConnection(mode, detail) {
  state.connection = mode;
  state.connectionDetail = detail;
  emit('connection');
}

export async function init() {
  if (state.started) return;
  state.started = true;
  const [stateResult, commandsResult, settingsResult] = await Promise.allSettled([
    api.state(), api.commands(), api.settings()
  ]);
  if (stateResult.status === 'fulfilled') applySnapshot(stateResult.value.state);
  else setStateError(stateResult.reason);
  if (commandsResult.status === 'fulfilled') {
    state.commands = commandsResult.value.commands || [];
    state.commandHistory = commandsResult.value.history || [];
    state.taskTypes = commandsResult.value.taskTypes || [];
  }
  if (settingsResult.status === 'fulfilled') {
    state.settings = settingsResult.value.settings;
    configureRoster(state.settings && state.settings.roster);
  }
  state.loading = false;
  emit('init');
  connectEvents();
  startLogPolling();
}

function setStateError(err) {
  state.error = err instanceof ApiError ? err.message : (err && err.message) || 'Unable to load state';
  state.loading = false;
  if (state.connection === 'connecting') setConnection('offline', 'The operations service is not responding.');
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  state.snapshot = snapshot;
  state.lastStateAt = Date.now();
  if (Array.isArray(snapshot.bots) && snapshot.bots.length && !state.settings) {
    configureRoster(snapshot.bots.map((entry) => entry.name));
  }
  state.error = null;
  const point = { at: Date.now(), bots: {} };
  for (const bot of snapshot.bots || []) {
    point.bots[bot.name] = { health: bot.health, food: bot.food };
  }
  state.samples.push(point);
  if (state.samples.length > SAMPLE_LIMIT) state.samples.splice(0, state.samples.length - SAMPLE_LIMIT);
  setConnection('live', 'Live state stream connected');
  emit('state');
}

function connectEvents() {
  if (eventSource) {
    try { eventSource.close(); } catch (_) { /* already closed */ }
    eventSource = null;
  }
  if (typeof EventSource === 'undefined') {
    startPolling();
    return;
  }
  setConnection(reconnectAttempts ? 'reconnecting' : 'connecting', reconnectAttempts ? 'Reconnecting to the live state stream…' : 'Opening live state stream…');
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('state', (event) => {
    try {
      applySnapshot(JSON.parse(event.data));
      reconnectAttempts = 0;
      stopPolling();
    } catch (err) {
      console.error('bad state event', err);
    }
  });
  eventSource.onopen = () => {
    reconnectAttempts = 0;
    setConnection('live', 'Live state stream connected');
  };
  eventSource.onerror = () => {
    if (eventSource) { try { eventSource.close(); } catch (_) { /* ignore */ } eventSource = null; }
    reconnectAttempts++;
    setConnection('reconnecting', 'Live stream interrupted — using fallback polling.');
    startPolling();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(15000, 1000 * Math.pow(1.6, Math.min(5, reconnectAttempts)));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!eventSource) connectEvents();
  }, delay);
}

function startPolling() {
  if (pollTimer) return;
  setConnection('polling', 'Polling the operations service every 4 seconds.');
  pollTimer = setInterval(async () => {
    try {
      const result = await api.state();
      applySnapshot(result.state);
      // Keep polling until the SSE listener reports a frame; stopping here
      // would leave the dashboard frozen after its first fallback fetch.
      if (!eventSource && (state.connection === 'polling' || state.connection === 'reconnecting')) {
        setConnection('polling', 'Fallback polling active.');
      }
    } catch (err) {
      setStateError(err);
      setConnection('offline', 'The operations service is unreachable.');
    }
  }, 4000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startLogPolling() {
  if (logTimer) return;
  fetchLogs();
  logTimer = setInterval(() => fetchLogs(), 5000);
}

export async function fetchLogs({ reset = false } = {}) {
  try {
    const since = reset ? 0 : state.logSeq;
    const result = await api.logs({ limit: reset ? 300 : 200, since });
    const incoming = result.logs || [];
    if (reset) {
      state.logs = incoming;
      state.logSeq = incoming.length ? incoming[incoming.length - 1].seq : 0;
    } else if (incoming.length) {
      const seen = new Set(state.logs.map((entry) => entry.seq));
      for (const entry of incoming) if (!seen.has(entry.seq)) state.logs.push(entry);
      state.logs.sort((a, b) => a.seq - b.seq);
      if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
      state.logSeq = state.logs[state.logs.length - 1].seq;
    }
    state.logStats = result.stats || null;
    state.lastLogAt = Date.now();
    emit('logs');
  } catch (_) {
    /* log panel shows its own empty state */
  }
}

export async function refreshCommands() {
  try {
    const result = await api.commands();
    state.commands = result.commands || [];
    state.commandHistory = result.history || [];
    state.taskTypes = result.taskTypes || state.taskTypes;
    emit('commands');
  } catch (_) { /* palette falls back to navigation */ }
}

export async function runCommand(line, { confirm = false, operator = 'dashboard' } = {}) {
  const trimmed = String(line || '').trim();
  if (!trimmed) throw new ApiError('Command is empty', { code: 'EMPTY' });
  try {
    const result = await api.execute(trimmed, { confirm, operator });
    await fetchLogs();
    // Commands change backend state immediately; refresh in the background so
    // controls reflect the confirmed result without waiting for the next tick.
    refreshState().catch(() => {});
    return result;
  } catch (err) {
    await fetchLogs();
    throw err;
  }
}

export async function refreshState() {
  const result = await api.state();
  applySnapshot(result.state);
}

export function payloadOf(result) {
  return result && result.result ? result.result : result;
}

export async function runBotAction(name, action) {
  const result = await api.botAction(name, action);
  await fetchLogs();
  refreshState().catch(() => {});
  return result;
}

export function bot(name) {
  return (state.snapshot && state.snapshot.bots || []).find((entry) => entry.name === name) || null;
}

export function actionsFor(name) {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const pick = (list) => (list || []).find((entry) => entry.bot === name) || null;
  return {
    survival: pick(snapshot.survival),
    combat: pick(snapshot.combat),
    mining: pick(snapshot.mining),
    woodcutting: pick(snapshot.woodcutting),
    farming: pick(snapshot.farming),
    sleep: pick(snapshot.sleep),
    exploration: pick(snapshot.exploration),
    inventory: pick(snapshot.inventory && snapshot.inventory.bots),
    homeBase: pick(snapshot.homeBase && snapshot.homeBase.perBot),
    builder: pick(snapshot.builder && snapshot.builder.builds)
  };
}

export function teamMember(name) {
  const team = state.snapshot && state.snapshot.team;
  return (team && team.state && team.state.bots || []).find((entry) => entry.name === name) || null;
}

export function tasksFor(name) {
  const tasks = state.snapshot && state.snapshot.taskManager && state.snapshot.taskManager.tasks || [];
  return tasks.filter((task) => task.claimedBy === name);
}

export function botAlerts(name) {
  const alerts = state.snapshot && state.snapshot.overview && state.snapshot.overview.alerts || [];
  return alerts.filter((alert) => alert.bot === name);
}

export function notifications() {
  const snapshot = state.snapshot || {};
  const overview = snapshot.overview || {};
  const items = [];
  for (const alert of overview.alerts || []) {
    items.push({
      id: `alert:${alert.level}:${alert.bot || 'team'}:${alert.message}`,
      at: Date.now(),
      level: alert.level === 'critical' ? 'error' : alert.level,
      title: alert.bot ? `${alert.bot} · ${alert.message}` : alert.message,
      detail: alert.bot ? 'Fleet alert' : 'Team alert',
      source: 'fleet'
    });
  }
  for (const log of state.logs.slice(-40)) {
    if (log.level !== 'error' && log.level !== 'warn') continue;
    items.push({
      id: `log:${log.seq}`,
      at: log.ts,
      level: log.level,
      title: log.msg,
      detail: log.scope,
      source: 'log'
    });
  }
  const seen = new Set();
  const unique = [];
  for (const item of items.reverse()) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique.sort((a, b) => b.at - a.at).slice(0, 60);
}

export function unreadNotifications() {
  return notifications().filter((item) => item.at > (prefs.notificationsReadAt || 0)).length;
}

export function markNotificationsRead() {
  savePrefs({ notificationsReadAt: Date.now() });
  emit('notifications');
}

export function botNames() {
  return (state.snapshot && state.snapshot.bots || []).map((bot_) => bot_.name);
}

export function serverInfo() {
  const diagnostics = state.snapshot && state.snapshot.diagnostics;
  if (diagnostics && diagnostics.config) return diagnostics.config.server;
  if (state.settings && state.settings.server) return state.settings.server;
  return null;
}

export function fleetHealth() {
  const bots = state.snapshot && state.snapshot.bots || [];
  const online = bots.filter(botOnline);
  const health = online.length ? online.reduce((total, b) => total + (Number(b.health) || 0), 0) / online.length : 0;
  const food = online.length ? online.reduce((total, b) => total + (Number(b.food) || 0), 0) / online.length : 0;
  return { online: online.length, total: bots.length, health, food };
}
