import { state, prefs, savePrefs, notifications, unreadNotifications, markNotificationsRead, fetchLogs } from '../store.js';
import { icon } from '../icons.js';
import { esc, num, formatTime, formatDateTime, timeAgo, duration, humanize, download } from '../utils.js';
import { badge, progress, kvRows, emptyState, pageHeader, sectionHead, statCard, toast } from '../ui.js';
import { bots, botNames, taskColumns, alertsBlock, ledger, overview, teamState } from './shared.js';

export const activityPage = {
  title: 'Live Activity',
  render() {
    const comms = ((state.snapshot && state.snapshot.team && state.snapshot.team.comms) || []).slice(-30).reverse();
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'General', title: 'Live Activity', description: 'A chronological stream of backend log entries and team bus messages. New entries arrive as the runtime works.',
          actions: `<button class="button" type="button" data-refresh-logs>${icon('refresh')} Refresh</button><a class="button button--primary" href="#/logs">${icon('list')} Logs & diagnostics</a>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Log entries', value: num(state.logs.length), iconName: 'list', tone: 'info', context: `last ${state.logStats ? state.logStats.total : 0} in ring buffer` })}
          ${statCard({ label: 'Errors', value: num(state.logs.filter((log) => log.level === 'error').length), iconName: 'alert-circle', tone: state.logs.some((log) => log.level === 'error') ? 'danger' : 'success', context: 'Error-level entries in view' })}
          ${statCard({ label: 'Warnings', value: num(state.logs.filter((log) => log.level === 'warn').length), iconName: 'alert', tone: state.logs.some((log) => log.level === 'warn') ? 'warning' : 'success', context: 'Warning-level entries in view' })}
          ${statCard({ label: 'Team messages', value: num(comms.length), iconName: 'message', tone: 'accent', context: 'Recent bus history' })}
        </div>
        <div class="grid grid--main-side">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('activity')} Log stream</div><span class="badge badge--outline">${state.connection === 'live' ? 'live' : state.connection}</span></div>
            <div class="log-list">${state.logs.length ? state.logs.slice().reverse().slice(0, 200).map(logLine).join('') : emptyState('Waiting for log entries', 'Backend logger output will stream here.', 'activity')}</div>
          </section>
          <aside class="stack gap-4">
            ${alertsBlock((overview().alerts) || [], { limit: 8 }) ? `<section class="card"><div class="card-header"><div class="card-title">${icon('alert')} Fleet alerts</div></div><div class="card-body card-body--tight">${alertsBlock(overview().alerts || [], { limit: 8 })}</div></section>` : ''}
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('message')} Team comms</div><span class="tiny muted">${comms.length}</span></div>
              <div class="activity-list">${comms.length ? comms.map((message) => `<div class="activity-item"><span class="activity-icon">${icon('message')}</span><div class="activity-main"><div>${esc(message.type)}</div><div class="mono">${esc(message.meta && message.meta.from || '—')} · ${message.at ? esc(timeAgo(message.at)) : ''}</div></div></div>`).join('') : emptyState('No team messages', 'Bus messages are created when the coordinator assigns work.', 'message')}</div>
            </section>
          </aside>
        </div>
      </div>`;
  }
};

function logLine(log) {
  return `<div class="log-line"><span class="log-time mono">${formatTime(log.ts)}</span><span class="log-level log-level--${log.level}">${esc(log.level)}</span><span class="log-scope mono">${esc(log.scope)}</span><span class="log-msg">${esc(log.msg)}</span></div>`;
}

export const notificationsPage = {
  title: 'Notifications',
  render() {
    const items = notifications();
    const unread = unreadNotifications();
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'General', title: 'Notifications', description: 'Alerts and warning/error log entries raised by the backend. Read state is stored in this browser only.',
          actions: `<button class="button" type="button" data-mark-read ${unread ? '' : 'disabled'}>${icon('check')} Mark all read</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Unread', value: num(unread), iconName: 'bell', tone: unread ? 'accent' : 'neutral', context: 'New since your last visit' })}
          ${statCard({ label: 'Total', value: num(items.length), iconName: 'inbox', tone: 'neutral', context: 'Derived from live alerts and logs' })}
          ${statCard({ label: 'Errors', value: num(items.filter((item) => item.level === 'error').length), iconName: 'alert-circle', tone: items.some((item) => item.level === 'error') ? 'danger' : 'success', context: 'Error-level notifications' })}
          ${statCard({ label: 'Warnings', value: num(items.filter((item) => item.level === 'warn').length), iconName: 'alert', tone: 'warning', context: 'Warning-level notifications' })}
        </div>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('bell')} Notification feed</div><span class="badge badge--outline">${unread} unread</span></div>
          <div class="card-body card-body--tight">
            ${items.length ? items.map((item) => `<div class="notification-row ${item.at > (prefs.notificationsReadAt || 0) ? 'is-unread' : ''}">
              <span class="notification-icon notification-icon--${item.level === 'error' ? 'danger' : item.level === 'warn' ? 'warn' : 'info'}">${icon(item.level === 'error' ? 'alert-circle' : item.level === 'warn' ? 'alert' : 'info')}</span>
              <div class="notification-main">
                <div class="notification-title">${esc(item.title)}</div>
                <div class="notification-detail">${esc(item.detail)} · ${esc(item.source)}</div>
              </div>
              <span class="notification-time tiny muted">${item.at ? esc(timeAgo(item.at)) : ''}</span>
            </div>`).join('') : emptyState('No notifications', 'The backend has not raised any alerts or warnings.', 'bell')}
          </div>
        </section>
        <div class="callout callout--info">${icon('info')}<div>Notifications are derived from the live alert list and warning/error log entries. The backend does not persist a notification record, so the feed reflects the current buffer rather than a long-term archive.</div></div>
      </div>`;
  },
  mount(root) {
    const button = root.querySelector('[data-mark-read]');
    if (!button) return;
    button.addEventListener('click', () => {
      markNotificationsRead();
      toast({ type: 'success', title: 'Notifications marked read', message: 'Unread counters were reset for this browser.' });
    });
  }
};

const taskFilter = { status: '', q: '', bot: '' };

export const tasksPage = {
  title: 'Task Manager',
  render() {
    const tasks = (state.snapshot && state.snapshot.taskManager && state.snapshot.taskManager.tasks) || [];
    const stats = (state.snapshot && state.snapshot.taskManager && state.snapshot.taskManager.stats) || {};
    const objectives = (state.snapshot && state.snapshot.taskManager && state.snapshot.taskManager.objectives) || [];
    const byStatus = stats.byStatus || {};
    const filtered = tasks.filter((task) => {
      const matchesStatus = !taskFilter.status || task.status === taskFilter.status;
      const matchesBot = !taskFilter.bot || task.claimedBy === taskFilter.bot;
      const query = taskFilter.q.toLowerCase();
      const matchesQuery = !query || `${task.label || ''} ${task.type} ${task.id} ${task.claimedBy || ''}`.toLowerCase().includes(query);
      return matchesStatus && matchesBot && matchesQuery;
    });
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'System', title: 'Task Manager', description: 'The shared task board: create, assign, reprioritise, cancel and retry work claimed by the team.',
          actions: `<button class="button" type="button" data-new-objective>${icon('target')} New objective</button><button class="button" type="button" data-new-task>${icon('plus')} Create task</button><a class="button button--primary" href="#/team">${icon('users')} Team board</a>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Total tasks', value: num(tasks.length), iconName: 'clipboard', tone: 'info', context: `${num(byStatus.CLAIMED || 0)} claimed · ${num(byStatus.ACTIVE || 0)} active` })}
          ${statCard({ label: 'Completed', value: num(byStatus.COMPLETED || 0), iconName: 'check-circle', tone: 'success', context: `${num(byStatus.PENDING || 0)} pending` })}
          ${statCard({ label: 'Failed', value: num(byStatus.FAILED || 0), iconName: 'x-circle', tone: (byStatus.FAILED || 0) ? 'danger' : 'success', context: 'Retry available on failed tasks' })}
          ${statCard({ label: 'Objectives', value: num(objectives.length), iconName: 'target', tone: 'accent', context: `${num(stats.activeObjectives || 0)} active` })}
          ${statCard({ label: 'Locks / deadlocks', value: `${num(stats.locks || 0)}<small> / ${num(stats.deadlocks || 0)}</small>`, iconName: 'lock', tone: (stats.deadlocks || 0) ? 'danger' : 'neutral', context: `${num(stats.regions || 0)} protected regions` })}
        </div>
        ${objectives.length ? `<section class="card"><div class="card-header"><div class="card-title">${icon('target')} Objectives</div></div><div class="card-body">${objectives.map((objective) => `<div class="objective-row"><div class="objective-main"><div><strong>${esc(objective.title)}</strong> ${badge(objective.status, objective.status === 'ACTIVE' ? 'accent' : objective.status === 'COMPLETED' ? 'ok' : 'neutral')}</div><div class="tiny muted">Priority ${esc(objective.priority ?? '—')} · ${objective.progress ? `${num(objective.progress.current)} / ${num(objective.progress.target)} ${esc(objective.progress.unit || '')}` : 'No progress reported'}</div><div class="tiny muted">Assigned: ${(objective.assignedBots && objective.assignedBots.length) ? objective.assignedBots.map(esc).join(', ') : 'No bots assigned yet'}${objective.taskCount !== undefined ? ` · ${num(objective.taskCount)} linked tasks` : ''}</div></div>${objective.progress && objective.progress.target ? progress((objective.progress.current / objective.progress.target) * 100, 100, { sm: true, tone: 'accent' }) : ''}</div>`).join('')}</div></section>` : ''}
        <section class="card" style="margin-top:16px">
          <div class="toolbar toolbar--wrap">
            <div class="search-input">${icon('search')}<input class="input" type="search" placeholder="Search tasks…" data-task-search value="${esc(taskFilter.q)}" aria-label="Search tasks"></div>
            <select class="select" data-task-status aria-label="Filter by status">
              <option value="">All statuses</option>${['PENDING', 'CLAIMED', 'ACTIVE', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'].map((status) => `<option value="${status}"${taskFilter.status === status ? ' selected' : ''}>${humanize(status)} (${num(byStatus[status] || 0)})</option>`).join('')}
            </select>
            <select class="select" data-task-bot aria-label="Filter by bot"><option value="">All bots</option>${bots().map((bot) => `<option value="${esc(bot.name)}"${taskFilter.bot === bot.name ? ' selected' : ''}>${esc(bot.name)}</option>`).join('')}</select>
            <span class="grow"></span>
            <button class="button" type="button" data-new-task>${icon('plus')} New task</button>
            <span class="tiny muted">${filtered.length} of ${tasks.length}</span>
          </div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Task</th><th>Type</th><th>Status</th><th>Owner</th><th>Priority</th><th>Progress</th><th>Attempts</th><th>Last error</th><th>Actions</th></tr></thead>
            <tbody>${filtered.length ? filtered.map((task) => `<tr>
              <td><div class="list-title">${esc(task.label || task.type)}</div><div class="mono tiny">${esc(task.id)}</div>${task.claimExpiresAt && ['CLAIMED', 'ACTIVE'].includes(task.status) ? `<div class="tiny muted">claim until ${esc(new Date(task.claimExpiresAt).toLocaleTimeString())}</div>` : ''}${task.stallCycles ? `<div class="tiny text-danger">${num(task.stallCycles)} stalled cycle(s)</div>` : ''}</td>
              <td class="tiny">${esc(task.type)}</td>
              <td>${badge(task.status, task.status === 'COMPLETED' ? 'ok' : task.status === 'FAILED' ? 'danger' : task.status === 'ACTIVE' ? 'accent' : task.status === 'BLOCKED' ? 'warn' : 'neutral', { dot: true })}</td>
              <td class="tiny">${task.claimedBy ? `<a class="link" href="#/bots/${encodeURIComponent(task.claimedBy)}/tasks">${esc(task.claimedBy)}</a>` : '<span class="muted">unclaimed</span>'}</td>
              <td class="mono">${num(task.priority)}</td>
              <td style="min-width:110px">${task.units && task.units.target ? progress((task.units.current / task.units.target) * 100, 100, { sm: true, tone: 'accent' }) : '<span class="muted tiny">—</span>'}${task.progressNote ? `<div class="tiny muted">${esc(task.progressNote)}</div>` : ''}</td>
              <td class="mono">${num(task.attempts)}</td>
              <td class="tiny ${task.lastError ? 'text-danger' : 'muted'}">${esc(task.lastError || '—')}</td>
              <td><div class="row gap-1">
                ${!['COMPLETED', 'CANCELLED'].includes(task.status) ? `<button class="button button--sm button--ghost" type="button" data-task-assign="${esc(task.id)}" aria-label="Assign task">${icon('user-plus')}</button>` : ''}
                ${!['COMPLETED', 'CANCELLED'].includes(task.status) ? `<button class="button button--sm button--ghost" type="button" data-task-priority="${esc(task.id)}" aria-label="Reprioritise task">${icon('flag')}</button>` : ''}
                ${['FAILED'].includes(task.status) ? `<button class="button button--sm" type="button" data-command="task retry ${esc(task.id)}">Retry</button>` : ''}
                ${!['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status) ? `<button class="button button--sm button--danger-ghost" type="button" data-command="task cancel ${esc(task.id)}" data-danger="true" data-confirm-title="Cancel task" data-confirm-message="Cancel ${esc(task.label || task.type)}?">Cancel</button>` : ''}
              </div></td>
            </tr>`).join('') : `<tr><td colspan="9">${emptyState('No tasks match', 'Adjust filters or create a task.', 'clipboard')}</td></tr>`}</tbody>
          </table></div>
        </section>
        <section style="margin-top:16px">
          ${sectionHead('Board', { subtitle: 'Planned · Ready · In progress · Blocked · Completed · Failed' })}
          ${taskColumns(tasks)}
        </section>
      </div>`;
  },
  mount(root) {
    const search = root.querySelector('[data-task-search]');
    const status = root.querySelector('[data-task-status]');
    const bot = root.querySelector('[data-task-bot]');
    const apply = () => {
      taskFilter.q = search ? search.value : '';
      taskFilter.status = status ? status.value : '';
      taskFilter.bot = bot ? bot.value : '';
      document.dispatchEvent(new CustomEvent('app:rerender'));
    };
    let timer = null;
    if (search) search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 250); });
    if (status) status.addEventListener('change', apply);
    if (bot) bot.addEventListener('change', apply);
  }
};

const logView = {
  category: 'all',
  level: '',
  range: 'all',
  bot: '',
  q: '',
  autoscroll: true,
  paused: false,
  frozen: null
};

const LOG_CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'system', label: 'System' },
  { key: 'connections', label: 'Connections' },
  { key: 'auth', label: 'Auth' },
  { key: 'survival', label: 'Survival' },
  { key: 'combat', label: 'Combat' },
  { key: 'mining', label: 'Mining' },
  { key: 'excavation', label: 'Excavation' },
  { key: 'farming', label: 'Farming' },
  { key: 'building', label: 'Building' },
  { key: 'teamwork', label: 'Teamwork' },
  { key: 'errors', label: 'Errors' }
];

function categoryMatches(category, log) {
  if (category === 'all') return true;
  if (category === 'errors') return log.level === 'error' || log.level === 'warn';
  const text = `${log.scope} ${log.msg}`.toLowerCase();
  if (category === 'system') return /chickenbots|dashboard|runtime|system|command|config/.test(text);
  if (category === 'connections') return /connect|spawn|join|respawn|disconnect|bot/.test(text);
  if (category === 'auth') return /auth|login|password|session|token/.test(text);
  if (category === 'survival') return /survival|eat|food|health|hunger/.test(text);
  if (category === 'combat') return /combat|defend|threat|attack/.test(text);
  if (category === 'mining') return /mining|mine|ore|pickaxe/.test(text);
  if (category === 'excavation') return /excavat|dig|shovel/.test(text);
  if (category === 'farming') return /farm|crop|harvest|seed/.test(text);
  if (category === 'building') return /build|schematic|place|construct/.test(text);
  if (category === 'teamwork') return /team|coordinator|task|objective|coordinat/.test(text);
  return true;
}

export const logsPage = {
  title: 'Logs & Diagnostics',
  render() {
    const logs = logView.paused && logView.frozen ? logView.frozen : state.logs;
    const now = Date.now();
    const rangeMs = logView.range === '5m' ? 300000 : logView.range === '1h' ? 3600000 : 0;
    const query = logView.q.toLowerCase();
    const filtered = logs.filter((log) => {
      if (!categoryMatches(logView.category, log)) return false;
      if (logView.level && log.level !== logView.level) return false;
      if (rangeMs && now - log.ts > rangeMs) return false;
      if (logView.bot && !`${log.msg} ${log.scope} ${log.meta && log.meta.bot ? log.meta.bot : ''}`.includes(logView.bot)) return false;
      if (query && !`${log.msg} ${log.scope} ${log.level}`.toLowerCase().includes(query)) return false;
      return true;
    });
    const runtime = (state.snapshot && state.snapshot.diagnostics && state.snapshot.diagnostics.runtime) || {};
    const config = (state.snapshot && state.snapshot.diagnostics && state.snapshot.diagnostics.config) || {};
    const botDiag = bots().map((bot) => ({ bot, diag: ((state.snapshot && state.snapshot.diagnostics && state.snapshot.diagnostics.bots) || []).find((entry) => entry.name === bot.name) || {} }));
    const commandHistory = state.commandHistory || [];
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'System', title: 'Logs & Diagnostics', description: 'Searchable backend log output plus runtime, command and connection diagnostics. Secrets are never rendered.',
          actions: `<button class="button" type="button" data-log-export>${icon('download')} Export</button><button class="button button--primary" type="button" data-refresh-logs>${icon('refresh')} Refresh</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Runtime', value: runtime.running ? (runtime.paused ? 'Paused' : 'Running') : 'Stopped', iconName: 'activity', tone: runtime.running ? (runtime.paused ? 'warning' : 'success') : 'danger', context: runtime.uptimeMs ? esc(duration(runtime.uptimeMs)) : 'uptime unavailable' })}
          ${statCard({ label: 'Autonomy ticks', value: num(runtime.ticks || 0), iconName: 'rotate', tone: 'info', context: runtime.lastTickMs ? `last tick ${runtime.lastTickMs} ms` : 'no tick timing' })}
          ${statCard({ label: 'Log buffer', value: num(state.logStats ? state.logStats.sequence : logs.length), iconName: 'database', tone: 'neutral', context: `${num(logs.length)} retained in this view` })}
          ${statCard({ label: 'Errors / warnings', value: `${num(logs.filter((log) => log.level === 'error').length)}<small> / ${num(logs.filter((log) => log.level === 'warn').length)}</small>`, iconName: 'alert', tone: logs.some((log) => log.level === 'error') ? 'danger' : 'success', context: 'In the current buffer' })}
          ${statCard({ label: 'Commands run', value: num(commandHistory.length), iconName: 'terminal', tone: 'accent', context: 'Recent command history' })}
        </div>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('list')} Log viewer</div><span class="badge badge--outline">${filtered.length} shown${logView.paused ? ' · paused' : ''}</span></div>
          <div class="log-toolbar">
            <div class="chips chips--scroll" role="group" aria-label="Log category">
              ${LOG_CATEGORIES.map((category) => `<button class="chip${logView.category === category.key ? ' is-active' : ''}" type="button" data-log-category="${category.key}">${esc(category.label)}</button>`).join('')}
            </div>
            <div class="toolbar toolbar--wrap">
              <div class="search-input">${icon('search')}<input class="input" type="search" placeholder="Search messages…" data-log-search value="${esc(logView.q)}" aria-label="Search log messages"></div>
              <select class="select" data-log-level aria-label="Filter by severity">
                <option value="">All severities</option>${['debug', 'info', 'warn', 'error'].map((level) => `<option value="${level}"${logView.level === level ? ' selected' : ''}>${humanize(level)}</option>`).join('')}
              </select>
              <select class="select" data-log-bot aria-label="Filter by bot">
                <option value="">All bots</option>${botNames().map((name) => `<option value="${esc(name)}"${logView.bot === name ? ' selected' : ''}>${esc(name)}</option>`).join('')}
              </select>
              <select class="select" data-log-range aria-label="Time range">
                <option value="all"${logView.range === 'all' ? ' selected' : ''}>All time</option>
                <option value="5m"${logView.range === '5m' ? ' selected' : ''}>Last 5 minutes</option>
                <option value="1h"${logView.range === '1h' ? ' selected' : ''}>Last hour</option>
              </select>
              <button class="button button--sm" type="button" data-log-pause>${icon(logView.paused ? 'play' : 'pause')} ${logView.paused ? 'Resume' : 'Pause'}</button>
              <label class="checkbox tiny"><input type="checkbox" data-log-autoscroll ${logView.autoscroll ? 'checked' : ''}> Autoscroll</label>
              <span class="grow"></span>
              <button class="button button--sm" type="button" data-log-export>${icon('download')} Export filtered</button>
            </div>
          </div>
          <div class="log-view" data-log-view>
            ${filtered.length ? filtered.slice().reverse().slice(0, 300).map(logLine).join('') : emptyState('No log entries match', 'Adjust the category, severity, time range or search.', 'search')}
          </div>
        </section>
        <div class="grid grid--2" style="margin-top:16px">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('server')} Runtime</div></div>
            <div class="card-body">
              ${kvRows([
                ['Mode', esc(state.snapshot && state.snapshot.mode || '—')],
                ['Running', runtime.running ? badge('Yes', 'ok') : badge('No', 'danger')],
                ['Paused', runtime.paused ? badge('Yes', 'warn') : 'No'],
                ['Autonomy gate', runtime.autonomyAllowed ? badge('Open', 'ok') : badge('Closed', 'warn')],
                ['Ticks', num(runtime.ticks || 0)],
                ['Uptime', runtime.uptimeMs ? esc(duration(runtime.uptimeMs)) : '—'],
                ['Server', `${esc(config.server && config.server.host || '—')}:${esc(config.server && config.server.port || '—')}`],
                ['Dashboard', `${esc(config.dashboard && config.dashboard.host || '—')}:${esc(config.dashboard && config.dashboard.port || '—')}`],
                ['PVP', config.pvp ? 'Enabled' : 'Disabled'],
                ['AI planner', config.ai ? 'Enabled' : 'Disabled']
              ], { htmlValues: true })}
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('wifi')} Bot diagnostics</div></div>
            <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Bot</th><th>Status</th><th>Auth</th><th>Health</th><th>Last error</th></tr></thead><tbody>${botDiag.map(({ bot, diag }) => {
              const going = diag.status === 'joining' || diag.status === 'authenticating' || diag.status === 'initialising';
              return `<tr><td>${esc(bot.name)}</td><td>${diag.online ? badge(diag.statusLabel || 'Online', 'ok') : badge(diag.statusLabel || 'Offline', going ? 'warn' : 'danger')}</td><td>${diag.authenticated ? badge('Yes', 'ok') : diag.status === 'auth_failed' ? badge('No', 'danger') : badge('Pending', 'warn')}</td><td class="mono">${diag.health ?? '—'}</td><td class="tiny ${diag.lastError ? 'text-danger' : 'muted'}">${esc(diag.lastError || '—')}</td></tr>`;
            }).join('')}</tbody></table></div>
          </section>
        </div>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('terminal')} Command history</div><span class="tiny muted">${commandHistory.length}</span></div>
          <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Command</th><th>Result</th><th>Source</th><th>When</th></tr></thead><tbody>${commandHistory.length ? commandHistory.slice().reverse().slice(0, 20).map((entry) => `<tr><td class="mono tiny">${esc(entry.line || entry.command || '—')}</td><td>${entry.ok === false ? badge('Failed', 'danger') : badge('OK', 'ok')}</td><td class="tiny">${esc(entry.source || entry.operator || '—')}</td><td class="tiny">${entry.at ? esc(formatDateTime(entry.at)) : '—'}</td></tr>`).join('') : `<tr><td colspan="4" class="muted small">No commands executed yet.</td></tr>`}</tbody></table></div>
        </section>
        <div class="callout callout--info">${icon('shield')}<div>Server credentials and tokens are deliberately excluded from every API response used by this page.</div></div>
      </div>`;
  },
  mount(root) {
    const rerender = () => document.dispatchEvent(new CustomEvent('app:rerender'));
    root.querySelectorAll('[data-log-category]').forEach((button) => button.addEventListener('click', () => {
      logView.category = button.dataset.logCategory;
      rerender();
    }));
    const level = root.querySelector('[data-log-level]');
    if (level) level.addEventListener('change', () => { logView.level = level.value; rerender(); });
    const range = root.querySelector('[data-log-range]');
    if (range) range.addEventListener('change', () => { logView.range = range.value; rerender(); });
    const bot = root.querySelector('[data-log-bot]');
    if (bot) bot.addEventListener('change', () => { logView.bot = bot.value; rerender(); });
    const search = root.querySelector('[data-log-search]');
    let timer = null;
    if (search) search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { logView.q = search.value.trim(); rerender(); }, 250);
    });
    const pause = root.querySelector('[data-log-pause]');
    if (pause) pause.addEventListener('click', () => {
      logView.paused = !logView.paused;
      logView.frozen = logView.paused ? state.logs.slice() : null;
      rerender();
    });
    const autoscroll = root.querySelector('[data-log-autoscroll]');
    if (autoscroll) autoscroll.addEventListener('change', () => {
      logView.autoscroll = autoscroll.checked;
      if (autoscroll.checked) scrollLogs();
    });
    root.querySelectorAll('[data-log-export]').forEach((button) => button.addEventListener('click', () => {
      const now = Date.now();
      const rangeMs = logView.range === '5m' ? 300000 : logView.range === '1h' ? 3600000 : 0;
      const query = logView.q.toLowerCase();
      const entries = (logView.paused && logView.frozen ? logView.frozen : state.logs).filter((log) => {
        if (!categoryMatches(logView.category, log)) return false;
        if (logView.level && log.level !== logView.level) return false;
        if (rangeMs && now - log.ts > rangeMs) return false;
        if (logView.bot && !`${log.msg} ${log.scope} ${log.meta && log.meta.bot ? log.meta.bot : ''}`.includes(logView.bot)) return false;
        if (query && !`${log.msg} ${log.scope} ${log.level}`.toLowerCase().includes(query)) return false;
        return true;
      });
      download(`chickenbots-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), count: entries.length, logs: entries }, null, 2), 'application/json');
      toast({ type: 'success', title: 'Log export ready', message: `${entries.length} entries written to your downloads.` });
    }));
    if (logView.autoscroll && !logView.paused) scrollLogs();
    const refresh = root.querySelector('[data-refresh-logs]');
    if (refresh) refresh.addEventListener('click', () => fetchLogs());
  }
};

function scrollLogs() {
  const view = document.querySelector('[data-log-view]');
  if (view) view.scrollTop = 0;
}

export const settingsPage = {
  title: 'Settings',
  render() {
    const settings = state.settings;
    if (!settings) {
      return `<div class="page">${pageHeader({ eyebrow: 'System', title: 'Settings', description: 'Configuration is loaded from the running backend.' })}<div class="card">${emptyState('Settings unavailable', state.error || 'The settings endpoint did not respond.', 'settings')}</div></div>`;
    }
    const runtime = (state.snapshot && state.snapshot.diagnostics && state.snapshot.diagnostics.runtime) || {};
    const data = ledger();
    const survival = (state.snapshot && state.snapshot.survival) || [];
    const combat = (state.snapshot && state.snapshot.combat) || [];
    const pveEnabled = combat.length ? combat.every((entry) => entry.pveEnabled !== false) : settings.pve !== false;
    const pvpEnabled = settings.pvp === true;
    const routineEnabled = (feature) => survival.length ? survival.every((entry) => !entry.features || entry.features[feature] !== false) : true;
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'System', title: 'Settings', description: 'Runtime configuration reported by the backend. Values marked read-only are owned by the server process and its config file.',
          actions: `<a class="button" href="#/logs">${icon('list')} Diagnostics</a>`
        })}
        <div class="grid grid--2">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('server')} Server</div>${badge(state.snapshot && state.snapshot.mode === 'live' ? 'Live' : 'Simulation', 'info')}</div>
            <div class="card-body">
              ${kvRows([
                ['Host', esc(settings.server.host), true],
                ['Port', esc(settings.server.port), true],
                ['Protocol version', esc(settings.server.version || '—'), true],
                ['Authentication mode', esc(settings.server.auth || 'offline')],
                ['Dashboard bind', esc(`${settings.dashboard.host}:${settings.dashboard.port}`), true],
                ['Control-plane auth', settings.security && settings.security.tokenRequired ? 'Token required' : 'No token (local demo only)']
              ])}
              <p class="tiny muted" style="margin:10px 0 0">Credentials are never returned by the settings API.</p>
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('users')} Roster</div><span class="tiny muted">${settings.roster.length} bots</span></div>
            <div class="card-body">
              <div class="chips">${settings.roster.map((name) => `<span class="chip mono">${esc(name)}</span>`).join('')}</div>
              <div class="divider"></div>
              ${kvRows([['Leader', esc((teamState() && teamState().team && teamState().team.leader) || overview().leader || 'not elected')], ['Formation', esc((teamState() && teamState().team && teamState().team.formation) || '—')]])}
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('sliders')} Autonomy</div>${runtime.paused ? badge('Paused', 'warn') : badge('Running', 'ok', { dot: true })}</div>
            <div class="card-body">
              ${kvRows([
                ['Tick interval', `${num(settings.autonomy.tickMs)} ms`],
                ['Enabled', settings.autonomy.enabled ? badge('Yes', 'ok') : badge('No', 'danger')],
                ['Paused', settings.autonomy.paused ? badge('Yes', 'warn') : 'No'],
                ['AI planner', settings.ai.enabled ? badge(`Enabled (${settings.ai.provider || 'provider'})`, 'info') : badge('Disabled', 'neutral')],
                ['PvE (hostile mobs)', pveEnabled ? badge('Enabled', 'ok') : badge('Disabled', 'danger'), true],
                ['PvP (explicit targets)', pvpEnabled ? badge('Enabled — no auto-targeting', 'warning') : badge('Disabled', 'neutral'), true],
                ['Recovery gate', (state.snapshot && state.snapshot.recovery || []).filter((entry) => entry.state !== 'ACTIVE').length ? badge(`${(state.snapshot.recovery || []).filter((entry) => entry.state !== 'ACTIVE').length} bot(s) held`, 'warn') : badge('Clear', 'ok'), true]
              ], { htmlValues: true })}
              <div class="row gap-2" style="margin-top:12px">
                <button class="button" type="button" data-command="pause">${icon('pause')} Pause</button>
                <button class="button" type="button" data-command="resume">${icon('play')} Resume</button>
                <button class="button" type="button" data-command="pve ${pveEnabled ? 'off' : 'on'}">${icon('sword')} PvE ${pveEnabled ? 'off' : 'on'}</button>
                <button class="button" type="button" data-command="pvp ${pvpEnabled ? 'off' : 'on'}">${icon('target')} PvP ${pvpEnabled ? 'off' : 'on'}</button>
              </div>
              <div class="callout callout--info" style="margin-top:10px">${icon('info')}<div>Pause and resume are real runtime actions; they stop and restart autonomous ticks without disconnecting bots.</div></div>
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('sliders')} Limits & reserves</div></div>
            <div class="card-body">
              ${kvRows([
                ['Excavation max blocks', num(settings.excavation.maxBlocks || 0)],
                ['Command rate limit', `${num(settings.limits.commandRatePerMinute)} / minute / IP`],
                ['Request body limit', `${num(settings.limits.requestBodyMb)} MB`],
                ['Reserve targets', num(Object.keys(settings.reserves || {}).length)]
              ])}
              ${Object.keys(settings.reserves || {}).length ? `<div class="divider"></div><div class="table-wrap"><table class="table table--compact"><thead><tr><th>Item</th><th>Target</th><th>Available</th><th>Status</th></tr></thead><tbody>${Object.entries(settings.reserves).map(([item, target]) => {
                const row = data.rows.find((entry) => entry.item === item);
                return `<tr><td>${esc(humanize(item))}</td><td class="mono">${num(target)}</td><td class="mono">${row ? num(row.available) : '—'}</td><td>${row ? badge(row.status, row.status === 'OK' ? 'ok' : row.status === 'CRITICAL' ? 'danger' : 'warn') : badge('TRACKED', 'neutral')}</td></tr>`;
              }).join('')}</tbody></table></div>` : ''}
            </div>
          </section>
        </div>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('sliders')} Safe automation</div><span class="tiny muted">Runtime values from the action controllers</span></div>
          <div class="card-body">
            <div class="grid grid--3 automation-grid">
              ${[
                ['eat', 'Eat before starving'], ['healing', 'Emergency healing'], ['armour', 'Equip armour'],
                ['tools', 'Keep tools ready'], ['crafting', 'Craft missing basics'], ['shield', 'Raise shield when low']
              ].map(([feature, label]) => `<div class="setting-row"><div><div class="setting-label">${label}</div><div class="setting-desc mono">auto ${feature} · ${routineEnabled(feature) ? 'enabled' : 'disabled'}</div></div><button class="button button--sm" type="button" data-command="auto ${feature} ${routineEnabled(feature) ? 'off' : 'on'}">${routineEnabled(feature) ? 'Disable' : 'Enable'}</button></div>`).join('')}
            </div>
            <div class="callout callout--info" style="margin-top:12px">${icon('info')}<div>PvE and safe survival automation are on by default. PvP is enabled as a feature, but <span class="mono">PvpPolicy</span> only attacks players on the explicit target list; teammates, protected players and unauthorised positions are always refused.</div></div>
          </div>
        </section>
        <div class="grid grid--2" style="margin-top:16px">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('monitor')} Browser preferences</div></div>
            <div class="card-body">
              <div class="setting-row"><div><div class="setting-label">Sidebar collapsed by default</div><div class="setting-desc">Stored locally in this browser.</div></div><button class="switch${prefs.sidebarCollapsed ? ' is-on' : ''}" type="button" role="switch" aria-checked="${prefs.sidebarCollapsed}" data-pref-toggle="sidebarCollapsed"><span></span></button></div>
              <div class="setting-row"><div><div class="setting-label">Reduced motion</div><div class="setting-desc">Disable animated transitions in this browser.</div></div><button class="switch${prefs.reducedMotion ? ' is-on' : ''}" type="button" role="switch" aria-checked="${prefs.reducedMotion}" data-pref-toggle="reducedMotion"><span></span></button></div>
              <div class="setting-row"><div><div class="setting-label">Compact density</div><div class="setting-desc">Tighter table rows and card spacing.</div></div><button class="switch${prefs.compact ? ' is-on' : ''}" type="button" role="switch" aria-checked="${prefs.compact}" data-pref-toggle="compact"><span></span></button></div>
              <p class="tiny muted" style="margin:10px 0 0">These preferences only affect this browser; they are not sent to the server.</p>
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('shield')} Safety</div></div>
            <div class="card-body">
              ${kvRows([
                ['Dangerous commands', 'Require explicit confirmation'],
                ['Confirmation channel', 'Dashboard confirm dialog + backend flag'],
                ['Excavation starts', 'Confirm + optional authorisation'],
                ['Build starts', 'Confirm + site checks'],
                ['Secrets in UI', 'Never rendered']
              ])}
              <div class="callout callout--danger" style="margin-top:10px">${icon('alert')}<div>The <span class="mono">stop</span> command disconnects every bot and stops the runtime. It is confirmation-gated in the dashboard and refuses to run from chat. Use it deliberately.</div></div>
            </div>
          </section>
        </div>
      </div>`;
  },
  mount(root) {
    root.querySelectorAll('[data-pref-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.prefToggle;
        savePrefs({ [key]: !prefs[key] });
        button.classList.toggle('is-on', Boolean(prefs[key]));
        button.setAttribute('aria-checked', String(Boolean(prefs[key])));
        applyDocumentPrefs();
        if (key === 'sidebarCollapsed') document.dispatchEvent(new CustomEvent('app:sidebar-pref'));
      });
    });
  }
};

export function applyDocumentPrefs() {
  document.documentElement.classList.toggle('reduce-motion', Boolean(prefs.reducedMotion));
  document.documentElement.classList.toggle('compact-density', Boolean(prefs.compact));
}
