import { icon } from '../icons.js';
import { state, bot as getBot, actionsFor, teamMember, tasksFor, botAlerts } from '../store.js';
import { esc, num, pct, clamp, formatTime, timeAgo, duration, healthTone, progressTone, humanize, initials, roster } from '../utils.js';
import { badge, botAvatar, statusDot, progress, kvRows, emptyState, metaList } from '../ui.js';
import { botStatus, botOnline } from '../botStatus.js';

export function snapshot() { return state.snapshot; }
export function teamState() { return (state.snapshot && state.snapshot.team && state.snapshot.team.state) || null; }
export function overview() { return (state.snapshot && state.snapshot.overview) || {}; }
export function bots() { return (state.snapshot && state.snapshot.bots) || []; }

export function ledger() {
  const value = state.snapshot && state.snapshot.inventory && state.snapshot.inventory.ledger;
  if (!value) return { rows: [], shortages: [], reservations: [], transfers: [], inventories: [], storages: [] };
  if (Array.isArray(value)) return { rows: value, shortages: [], reservations: [], transfers: [], inventories: [], storages: [] };
  return {
    rows: value.rows || [],
    shortages: value.shortages || [],
    reservations: value.reservations || [],
    transfers: value.transfers || [],
    inventories: value.inventories || [],
    storages: value.storages || []
  };
}

export function botNames() {
  const live = bots().map((entry) => entry.name);
  return live.length ? live : roster();
}

export function connectionLabel(bot) {
  const status = botStatus(bot);
  return { label: status.label, tone: status.tone, dot: status.dot, detail: status.detail, online: status.online };
}

export function botStatusBadge(bot) {
  const status = botStatus(bot);
  return `<span class="status" title="${esc(status.detail || status.label)}">${statusDot(status.dot, status.online)}${badge(status.label, status.tone)}</span>`;
}

export function taskTone(status) {
  switch (String(status || '').toUpperCase()) {
    case 'COMPLETED': return 'ok';
    case 'ACTIVE': return 'accent';
    case 'CLAIMED': return 'info';
    case 'PENDING': return 'neutral';
    case 'BLOCKED': return 'warn';
    case 'FAILED': return 'danger';
    case 'CANCELLED': return 'neutral';
    default: return 'neutral';
  }
}

export function alertTone(level) {
  if (level === 'critical' || level === 'error') return { css: 'danger', icon: 'alert-circle', tone: 'danger' };
  if (level === 'warn' || level === 'warning') return { css: 'warn', icon: 'alert', tone: 'warn' };
  return { css: 'info', icon: 'info', tone: 'info' };
}

export function alertsBlock(alerts, { limit = 5 } = {}) {
  const list = (alerts || []).slice(0, limit);
  if (!list.length) {
    return `<div class="list-item"><span class="status-dot status-dot--ok"></span><div class="list-main"><div class="list-title">No active alerts</div><div class="list-sub">Fleet and task checks are clear.</div></div></div>`;
  }
  return list.map((alert) => {
    const tone = alertTone(alert.level);
    return `<div class="alert-row alert-row--${tone.css}">
      ${icon(tone.icon)}
      <div class="list-main">
        <div>${alert.bot ? `<strong>${esc(alert.bot)}</strong> · ` : ''}${esc(alert.message)}</div>
        <div class="alert-meta">${esc(alert.level)}${alert.bot ? ' · bot alert' : ' · team alert'}</div>
      </div>
    </div>`;
  }).join('');
}

export function activityBlock(logs, { limit = 8, empty = 'Live activity will appear here as the team works.' } = {}) {
  const entries = (logs || []).slice(-limit).reverse();
  if (!entries.length) return emptyState('Waiting for activity', empty, 'activity');
  return entries.map((log) => {
    return `<div class="activity-item">
      <span class="activity-icon">${icon(log.level === 'error' ? 'alert-circle' : log.level === 'warn' ? 'alert' : log.scope.includes('dashboard') ? 'layout' : 'zap')}</span>
      <div class="activity-main">
        <div>${esc(log.msg)}</div>
        <div class="mono">${formatTime(log.ts)} · ${esc(log.scope)} · ${esc(log.level)}</div>
      </div>
      ${log.level === 'error' ? badge('ERROR', 'danger') : log.level === 'warn' ? badge('WARN', 'warn') : ''}
    </div>`;
  }).join('');
}

export function objectiveBlock(objective, tasks = []) {
  if (!objective) {
    return emptyState('No active objective', 'The coordinator has not created a team objective yet.', 'target');
  }
  const related = tasks.filter((task) => task.objectiveId === objective.id);
  const done = related.filter((task) => task.status === 'COMPLETED').length;
  const total = related.length || 1;
  const percent = objective.progress && objective.progress.target ? (objective.progress.current / objective.progress.target) * 100 : (done / total) * 100;
  return `<div class="objective-card">
    <div class="objective-top">
      <div>
        <div class="objective-title">${esc(objective.title)}</div>
        <div class="objective-desc">${esc(objective.description || objective.completionCondition || 'Team objective')}</div>
      </div>
      ${badge(objective.status, objective.status === 'ACTIVE' ? 'accent' : objective.status === 'COMPLETED' ? 'ok' : 'warn')}
    </div>
    <div class="objective-progress">${progress(percent, 100, { tone: 'accent', label: 'Objective progress' })}</div>
    <div class="objective-meta">
      <span>${done}/${total} tasks · priority ${esc(objective.priority ?? '—')}</span>
      <span>${esc(objective.progress && objective.progress.unit ? `${num(objective.progress.current)} / ${num(objective.progress.target)} ${objective.progress.unit}` : '')}</span>
    </div>
    <div class="tiny muted" style="margin-top:6px">Assigned: ${(objective.assignedBots && objective.assignedBots.length) ? objective.assignedBots.map(esc).join(', ') : (related.filter((task) => task.claimedBy).map((task) => esc(task.claimedBy)).filter((name, index, list) => list.indexOf(name) === index).join(', ') || 'No bots claimed yet')}</div>
    ${objective.completionCondition ? `<div class="tiny muted" style="margin-top:8px">Done when: ${esc(objective.completionCondition)}</div>` : ''}
    ${objective.optionalFailure ? `<div class="callout callout--warn" style="margin-top:10px">${icon('alert')}<div>Optional work degraded — ${esc(objective.optionalFailure.label || objective.optionalFailure.type)}: ${esc(objective.optionalFailure.reason || 'no verified result')}. Required work continues.</div></div>` : ''}
  </div>`;
}

export function botMenu(name) {
  return `
    <div class="dropdown">
      <button class="button button--sm" type="button" data-dropdown="bot-menu-${esc(name)}" aria-haspopup="menu" aria-expanded="false">${icon('more')}<span class="sr-only">Actions for ${esc(name)}</span></button>
      <div class="dropdown-menu" id="bot-menu-${esc(name)}" role="menu" hidden>
        <div class="dropdown-label">Task</div>
        <button class="dropdown-item" role="menuitem" data-command="eat ${esc(name)}">${icon('heart')}Eat best food</button>
        <button class="dropdown-item" role="menuitem" data-command="defend ${esc(name)}">${icon('shield')}Defend</button>
        <button class="dropdown-item" role="menuitem" data-command="chop ${esc(name)}">${icon('axe')}Chop wood</button>
        <button class="dropdown-item" role="menuitem" data-command="farm ${esc(name)}">${icon('sprout')}Harvest farm</button>
        <button class="dropdown-item" role="menuitem" data-command="explore ${esc(name)}">${icon('compass')}Explore</button>
        <button class="dropdown-item" role="menuitem" data-command="bot ${esc(name)} come">${icon('home')}Return home</button>
        <div class="dropdown-sep"></div>
        <div class="dropdown-label">Connection</div>
        <button class="dropdown-item" role="menuitem" data-bot-action="reconnect" data-bot="${esc(name)}">${icon('refresh')}Reconnect</button>
        <button class="dropdown-item dropdown-item--danger" role="menuitem" data-bot-action="disconnect" data-bot="${esc(name)}">${icon('wifi-off')}Disconnect</button>
      </div>
    </div>`;
}

export function botCard(bot) {
  const team = teamMember(bot.name);
  const actions = actionsFor(bot.name);
  const role = team ? team.role : 'IDLE';
  const activity = bot.activity || (actions && actions.survival && actions.survival.lastAction) || 'idle';
  const task = team && team.task ? team.task : null;
  const alerts = botAlerts(bot.name);
  const tone = healthTone(bot.health);
  const foodTone = healthTone(bot.food);
  const pos = bot.position ? `${Math.round(bot.position.x)}, ${Math.round(bot.position.y)}, ${Math.round(bot.position.z)}` : '—';
  const status = botStatus(bot);
  const navigation = bot.navigation;
  const activeTarget = navigation && navigation.telemetry && navigation.telemetry.active
    ? (navigation.telemetry.active.target || navigation.telemetry.active.goal) : null;
  const movementLine = navigation && navigation.active
    ? `<div class="bot-pos">${icon('navigation')} ${esc(navigation.owner || 'path')}${activeTarget ? ` → ${Math.round(activeTarget.x)}, ${Math.round(activeTarget.y)}, ${Math.round(activeTarget.z)}` : ''}</div>`
    : '';
  return `
    <article class="card bot-card card--interactive${status.online ? '' : ' bot-card--offline'}" title="${esc(status.detail || status.label)}">
      <div class="bot-card-head">
        ${botAvatar(bot.name)}
        <div class="bot-identity">
          <div class="bot-name">${esc(bot.name)} ${alerts.length ? badge(`${alerts.length} alert${alerts.length === 1 ? '' : 's'}`, 'danger') : ''}</div>
          <div class="bot-subline"><span class="role-pill">${esc(role)}</span><span>·</span><span class="truncate">${esc(task || activity)}</span></div>
        </div>
        ${botStatusBadge(bot)}
      </div>
      <div class="bot-card-body">
        <div class="bot-vitals">
          <div>
            <div class="vital-label"><span class="health-line">${icon('heart', 'health-icon')}Health</span><strong>${bot.health ?? '—'}/20</strong></div>
            ${progress(bot.health || 0, 20, { sm: true, tone: tone === 'ok' ? 'ok' : tone, label: 'Health' })}
          </div>
          <div>
            <div class="vital-label"><span class="health-line">${icon('sprout', 'food-icon')}Food</span><strong>${bot.food ?? '—'}/20</strong></div>
            ${progress(bot.food || 0, 20, { sm: true, tone: foodTone === 'ok' ? 'ok' : foodTone, label: 'Food' })}
          </div>
        </div>
        <div class="bot-activity">
          ${icon(activityIcon(activity))}
          <div><strong>${esc(task || activity)}</strong><span>${task ? humanize(activity) : `${esc(bot.armor ?? 0)} armour · ${bot.dimension || 'overworld'}`}</span></div>
        </div>
        <div class="bot-pos">${icon('map')} ${esc(pos)} <span class="muted">·</span> ${esc(bot.dimension || 'overworld')} ${bot.currentTaskId ? `<span class="muted">·</span> ${esc(bot.currentTaskId)}` : ''}</div>
        ${movementLine}
      </div>
      <div class="bot-card-foot">
        <a class="button button--sm" href="#/bots/${encodeURIComponent(bot.name)}">${icon('user')}Profile</a>
        <button class="button button--sm button--ghost" type="button" data-command="bot ${esc(bot.name)} come">${icon('home')}Recall</button>
        <span class="grow"></span>
        ${botMenu(bot.name)}
      </div>
    </article>`;
}

function activityIcon(activity) {
  const text = String(activity || '').toLowerCase();
  if (text.includes('min')) return 'pickaxe';
  if (text.includes('chop') || text.includes('wood')) return 'axe';
  if (text.includes('farm')) return 'sprout';
  if (text.includes('combat') || text.includes('defend')) return 'sword';
  if (text.includes('sleep')) return 'bed';
  if (text.includes('explor')) return 'compass';
  if (text.includes('build')) return 'hammer';
  return 'activity';
}

export function teamHealthCard() {
  return `
    <div class="card chart-card">
      <div class="chart-head">
        <div>
          <div class="card-title">${icon('heart')} Fleet vitals</div>
          <div class="card-subtitle">Live health samples since this page opened</div>
        </div>
        <span class="badge badge--outline">${state.samples.length} samples</span>
      </div>
      ${chartLegend(botNames())}
      ${importedLineChart()}
    </div>`;
}

function importedLineChart() {
  return `<div id="fleet-vitals-chart"></div>`;
}

export function chartLegend(names) {
  return `<div class="chart-legend">${names.map((name, index) => `<span class="legend-item"><span class="legend-swatch" style="background:${chartColorFor(index)}"></span>${esc(name)}</span>`).join('')}</div>`;
}

function chartColorFor(index) {
  const palette = ['#d2f65a', '#4ee3c0', '#6aa9ff', '#ffbf69', '#ff6b7a'];
  return palette[index % palette.length];
}

export function emptyTable(message) {
  return `<tr><td colspan="12"><div class="empty-state" style="padding:26px"><strong>${esc(message)}</strong></div></td></tr>`;
}

export function taskColumns(tasks) {
  const columns = [
    { key: 'PENDING', label: 'Planned' },
    { key: 'CLAIMED', label: 'Ready' },
    { key: 'ACTIVE', label: 'In progress' },
    { key: 'BLOCKED', label: 'Blocked' },
    { key: 'COMPLETED', label: 'Completed' },
    { key: 'FAILED', label: 'Failed' }
  ];
  return `<div class="task-board">${columns.map((column) => {
    const list = tasks.filter((task) => task.status === column.key);
    return `<section class="task-column">
      <div class="task-column-head"><span>${column.label}</span><span>${list.length}</span></div>
      <div class="task-column-body">
        ${list.length ? list.slice(0, 30).map((task) => taskCard(task)).join('') : '<div class="tiny muted" style="padding:8px">No tasks</div>'}
      </div>
    </section>`;
  }).join('')}</div>`;
}

export function taskCard(task) {
  const units = task.units || { current: 0, target: 1 };
  const percent = units.target ? (units.current / units.target) * 100 : 0;
  return `<article class="task-card">
    <div class="task-card-title">${esc(task.label || humanize(task.type))}</div>
    <div class="progress progress--sm" style="margin-top:6px"><div class="progress-bar progress-bar--${progressTone(percent)}" style="width:${clamp(percent, 0, 100)}%"></div></div>
    <div class="task-card-meta">
      <span>${esc(task.type)}</span>
      <span>${num(units.current)}/${num(units.target)}</span>
    </div>
    <div class="task-card-meta">
      <span>${task.claimedBy ? esc(task.claimedBy) : 'unclaimed'}</span>
      <span>P${esc(task.priority ?? '—')}</span>
    </div>
    ${task.lastError ? `<div class="tiny" style="color:var(--danger);margin-top:5px">${esc(task.lastError)}</div>` : ''}
    <div class="task-card-actions">
      ${!['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status) ? `<button class="button" type="button" data-task-assign="${esc(task.id)}" title="Assign to a bot" aria-label="Assign ${esc(task.id)} to a bot">${icon('user-plus')}</button>` : ''}
      ${!['COMPLETED', 'CANCELLED'].includes(task.status) ? `<button class="button" type="button" data-task-priority="${esc(task.id)}" title="Reprioritise" aria-label="Reprioritise task ${esc(task.id)}">${icon('flag')}</button>` : ''}
      ${task.status === 'FAILED' ? `<button class="button" type="button" data-command="task retry ${esc(task.id)}">Retry</button>` : ''}
      ${['PENDING', 'ACTIVE', 'CLAIMED', 'BLOCKED'].includes(task.status) ? `<button class="button" type="button" data-command="task cancel ${esc(task.id)}" data-danger="true" data-confirm-title="Cancel task" data-confirm-message="Cancel ${esc(task.label || task.type)}?">Cancel</button>` : ''}
      <a class="button" href="#/tasks" aria-label="Open task manager">${icon('arrow-up-right')}</a>
    </div>
  </article>`;
}

export function botDetailTabLink(name, tab, label, active) {
  return `<a class="tab${active ? ' is-active' : ''}" href="#/bots/${encodeURIComponent(name)}/${tab}">${esc(label)}</a>`;
}

export function taskStatusLabel(status) {
  return String(status || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export { esc, num, pct, formatTime, timeAgo, duration, healthTone, humanize, initials, progress, kvRows, metaList, badge, botAvatar, statusDot, icon, tasksFor, teamMember, actionsFor , getBot, botAlerts, botStatus, botOnline };
