import { icon } from './icons.js';
import { esc, timeAgo, humanize } from './utils.js';
import { openModal, isModalOpen, confirmDialog, toast, resultMessage, setButtonLoading } from './ui.js';
import {
  init, state, prefs, savePrefs, subscribe, unreadNotifications, notifications,
  markNotificationsRead, botNames, serverInfo, fleetHealth, runCommand, runBotAction, runQueueAction,
  fetchLogs, refreshCommands, payloadOf
} from './store.js';
import { resolveRoute, renderNav, NAV_ITEMS } from './router.js';
import { openAssignDialog, openPriorityDialog, openCreateDialog, openObjectiveDialog, findTask } from './taskActions.js';
import { applyDocumentPrefs } from './pages/system.js';

const dom = {};
let currentRoute = null;
let pending = false;
let lastLiveRender = 0;

function cacheDom() {
  for (const id of ['app', 'sidebar', 'nav', 'sidebar-status', 'sidebar-collapse', 'menu-toggle', 'sidebar-backdrop', 'breadcrumbs', 'server-host', 'server-status', 'fleet-count', 'notifications-toggle', 'notification-dot', 'notifications-panel', 'command-trigger', 'view', 'main', 'toasts', 'modal-root']) {
    dom[id] = document.getElementById(id);
  }
}

function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll('[data-icon]')) {
    const name = slot.dataset.icon;
    if (!name) continue;
    const wrapper = document.createElement('span');
    wrapper.innerHTML = icon(name);
    const svg = wrapper.querySelector('svg');
    if (slot.classList.contains('icon') && svg) {
      slot.replaceChildren(svg);
      slot.removeAttribute('data-icon');
    } else {
      slot.replaceWith(wrapper.firstElementChild);
    }
  }
}

function applySidebarState() {
  document.documentElement.classList.toggle('sidebar-collapsed', Boolean(prefs.sidebarCollapsed));
  document.body.classList.toggle('sidebar-collapsed', Boolean(prefs.sidebarCollapsed));
  const collapse = dom['sidebar-collapse'];
  if (!collapse) return;
  collapse.setAttribute('aria-expanded', String(!prefs.sidebarCollapsed));
  collapse.setAttribute('aria-label', prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
  const label = collapse.querySelector('.sidebar-collapse-label');
  if (label) label.textContent = prefs.sidebarCollapsed ? 'Expand' : 'Collapse';
}

function buildShell() {
  applySidebarState();
  dom.nav.innerHTML = renderNav('');
  applyNavGroupState();
  hydrateIcons(document);
  applyDocumentPrefs();
}

function applyNavGroupState() {
  const collapsed = Array.isArray(prefs.collapsedGroups) ? prefs.collapsedGroups : [];
  for (const group of dom.nav.querySelectorAll('[data-nav-group]')) {
    const label = group.dataset.navGroup;
    const isCollapsed = collapsed.includes(label);
    group.classList.toggle('is-collapsed', isCollapsed);
    const toggle = group.querySelector('[data-nav-group-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', String(!isCollapsed));
  }
}

function setActiveNav(path) {
  for (const link of dom.nav.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === path;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function updateChrome(route) {
  setActiveNav(route.key === 'not-found' ? '' : route.key);
  const crumbs = `<a href="#/">Chickenbots</a> <span aria-hidden="true">/</span> <span>${esc(route.group)}</span> <span aria-hidden="true">/</span> <strong>${esc(route.label)}</strong>`;
  dom.breadcrumbs.innerHTML = crumbs;
  const info = serverInfo();
  if (dom['server-host']) dom['server-host'].textContent = info ? `${info.host}:${info.port}` : 'server not configured';
  const status = dom['server-status'];
  if (status) {
    const tone = state.connection === 'live' ? 'ok' : state.connection === 'offline' ? 'danger' : 'warn';
    status.innerHTML = `<span class="status-dot status-dot--${tone}"></span> ${esc(state.connection === 'live' ? 'telemetry live' : state.connection === 'offline' ? 'telemetry offline' : 'telemetry ' + state.connection)}`;
    status.title = state.connectionDetail || 'Dashboard live-update connection';
  }
  const fleet = fleetHealth();
  if (dom['fleet-count']) dom['fleet-count'].textContent = `${fleet.online} / ${fleet.total}`;
  const unread = unreadNotifications();
  if (dom['notification-dot']) {
    dom['notification-dot'].hidden = unread === 0;
    dom['notification-dot'].textContent = unread > 9 ? '9+' : String(unread || '');
  }
  if (dom['notifications-toggle']) dom['notifications-toggle'].setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
  const sidebar = dom['sidebar-status'];
  if (sidebar) {
    const tone = state.connection === 'live' ? 'ok' : state.connection === 'offline' ? 'danger' : 'warn';
    sidebar.innerHTML = `<span class="status-dot status-dot--${tone}${tone === 'ok' ? ' status-dot--pulse' : ''}"></span><span>${esc(state.connection === 'live' ? `Live · ${fleet.online}/${fleet.total} online` : state.connectionDetail)}</span>`;
  }
  document.title = `${route.label} · Chickenbots`;
  updateBanner();
}

function updateBanner() {
  const main = dom.main;
  if (!main) return;
  let banner = document.getElementById('connection-banner');
  const degraded = state.connection === 'offline' || state.connection === 'reconnecting';
  if (!degraded) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'connection-banner';
    banner.className = 'callout callout--warn global-banner';
    banner.setAttribute('role', 'status');
    const anchor = document.getElementById('view');
    main.insertBefore(banner, anchor);
  }
  banner.innerHTML = `${icon('wifi-off')}<div><strong>${state.connection === 'offline' ? 'Backend unreachable' : 'Reconnecting'}</strong> ${esc(state.connectionDetail)}${state.lastStateAt ? ` Last state ${esc(timeAgo(state.lastStateAt))}.` : ''}</div>`;
}

function captureForms(root) {
  return [...root.querySelectorAll('input, select, textarea')].map((element) => ({
    value: element.value,
    checked: element.checked
  }));
}

function restoreForms(root, saved) {
  const elements = [...root.querySelectorAll('input, select, textarea')];
  saved.forEach((entry, index) => {
    const element = elements[index];
    if (!element) return;
    if (element.type === 'checkbox' || element.type === 'radio') element.checked = entry.checked;
    else if (element.value !== entry.value) element.value = entry.value;
  });
}

function focusedFormIndex(root) {
  const active = document.activeElement;
  if (!active || !root.contains(active)) return -1;
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return -1;
  return [...root.querySelectorAll('input, select, textarea')].indexOf(active);
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function isTypingInsideView() {
  const active = document.activeElement;
  if (!active || !dom.view.contains(active)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
}

/* --------------------------------------------------------- live DOM morph */

const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function childKey(node) {
  if (node.nodeType === 3) return '#text';
  if (node.nodeType !== 1) return '#other';
  const tag = node.tagName;
  const id = node.id ? `#${node.id}` : '';
  let signature = '';
  for (const attribute of node.attributes) {
    if (attribute.name.startsWith('data-') && attribute.name !== 'data-icon' && attribute.name !== 'data-busy') {
      signature = `[${attribute.name}=${attribute.value}]`;
      break;
    }
  }
  return `${tag}${id}${signature}.${node.className || ''}`;
}

function canMorph(oldNode, newNode) {
  if (oldNode.nodeType !== newNode.nodeType) return false;
  if (oldNode.nodeType === 1 && oldNode.tagName !== newNode.tagName) return false;
  return true;
}

function morphElement(oldNode, newNode) {
  if (oldNode.nodeType === 1 && oldNode.classList.contains('icon')) {
    if (oldNode.innerHTML !== newNode.innerHTML) oldNode.innerHTML = newNode.innerHTML;
    return oldNode;
  }
  if (oldNode.nodeType === 1 && newNode.nodeType === 1) {
    if (newNode.hasAttribute('data-preserve-children') || oldNode.hasAttribute('data-preserve-children')) return oldNode;
    const oldForm = FORM_TAGS.has(oldNode.tagName);
    for (const attribute of [...newNode.attributes]) {
      if (oldForm && (attribute.name === 'value' || attribute.name === 'checked')) continue;
      if (oldNode.getAttribute(attribute.name) !== attribute.value) oldNode.setAttribute(attribute.name, attribute.value);
    }
    for (const attribute of [...oldNode.attributes]) {
      if (!newNode.hasAttribute(attribute.name) && !(oldForm && attribute.name === 'value')) oldNode.removeAttribute(attribute.name);
    }
  }
  if (oldNode.nodeType === 3) {
    if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
    return oldNode;
  }
  if (oldNode.nodeType !== 1) return oldNode;
  morphChildren(oldNode, newNode);
  return oldNode;
}

function morphChildren(oldParent, newParent) {
  if (newParent.hasAttribute && newParent.hasAttribute('data-preserve-children')) return;
  const pools = new Map();
  for (const child of [...oldParent.childNodes]) {
    const key = childKey(child);
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(child);
  }
  let cursor = 0;
  for (const newChild of [...newParent.childNodes]) {
    const key = childKey(newChild);
    const pool = pools.get(key) || [];
    const match = pool.shift();
    let node;
    if (match && canMorph(match, newChild)) {
      const busy = match.nodeType === 1 && (match.dataset.busy === 'true' || match.classList.contains('is-loading'));
      node = busy ? match : morphElement(match, newChild);
    } else node = document.importNode(newChild, true);
    if (node.parentNode === oldParent) {
      const current = oldParent.childNodes[cursor];
      if (current !== node) oldParent.insertBefore(node, current || null);
    } else {
      oldParent.insertBefore(node, oldParent.childNodes[cursor] || null);
    }
    cursor++;
  }
  while (oldParent.childNodes.length > cursor) oldParent.removeChild(oldParent.lastChild);
}

function liveMorph(holder) {
  const existing = dom.view.querySelector('.view-inner');
  if (!existing) return false;
  if (existing.hasAttribute('data-page-key') && holder.getAttribute('data-page-key') !== existing.getAttribute('data-page-key')) return false;
  morphChildren(existing, holder);
  return true;
}

function render(options = {}) {
  const { routeChange = false, force = false } = options;
  if (!force && isModalOpen()) return;
  if (!force && !routeChange && isTypingInsideView()) return;
  const route = resolveRoute();
  const sameRoute = currentRoute && currentRoute.key === route.key && JSON.stringify(currentRoute.params) === JSON.stringify(route.params);
  if (currentRoute && !sameRoute && currentRoute.page && typeof currentRoute.page.unmount === 'function') {
    try { currentRoute.page.unmount(); } catch (err) { console.error('unmount failed', err); }
  }
  if (!routeChange && !force && sameRoute && Date.now() - lastLiveRender < 350) return;
  lastLiveRender = Date.now();
  const scrollY = window.scrollY;
  const formIndex = focusedFormIndex(dom.view);
  const forms = !routeChange && sameRoute ? captureForms(dom.view) : null;
  const holder = document.createElement('div');
  holder.className = 'view-inner';
  holder.setAttribute('data-page-key', `${route.key}:${(route.params || []).join('/')}`);
  let html = '';
  try {
    html = route.page.render({ params: route.params || [], query: route.query || {}, route });
  } catch (err) {
    console.error('render failed', err);
    html = `<div class="page"><div class="card"><div class="empty-state"><strong>This view failed to render</strong><p>${esc(err.message)}</p><button class="button" type="button" data-refresh-view>Reload view</button></div></div></div>`;
  }
  holder.innerHTML = html;
  const live = sameRoute && !routeChange && !force && liveMorph(holder);
  if (!live) {
    dom.view.replaceChildren(holder);
    try {
      if (route.page.mount) route.page.mount(holder, route.params || [], route.query || {});
    } catch (err) {
      console.error('mount failed', err);
    }
    hydrateIcons(holder);
    if (forms) {
      restoreForms(holder, forms);
      if (formIndex >= 0) {
        const focusTarget = [...holder.querySelectorAll('input, select, textarea')][formIndex];
        if (focusTarget) focusTarget.focus({ preventScroll: true });
      }
    }
  }
  if (live && route.page.update) {
    try { route.page.update(dom.view.querySelector('.view-inner'), route.params || [], route.query || {}); }
    catch (err) { console.error('update failed', err); }
  }
  currentRoute = route;
  updateChrome(route);
  if (routeChange) {
    window.scrollTo(0, 0);
    closeNotifications();
    closeDropdowns();
  } else {
    window.scrollTo({ top: scrollY, left: 0 });
  }
}

function scheduleRender(options = {}) {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    render(options);
  }, 120);
}

function loadingView() {
  dom.view.innerHTML = `
    <div class="page">
      <div class="skeleton skeleton--title"></div>
      <div class="skeleton skeleton--line short"></div>
      <div class="grid grid--stats" style="margin-top:20px">${Array.from({ length: 4 }, () => '<div class="card skeleton-card"><div class="skeleton skeleton--line short"></div><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--line"></div></div>').join('')}</div>
      <div class="grid grid--2" style="margin-top:16px">${Array.from({ length: 2 }, () => '<div class="card skeleton-card"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--line"></div><div class="skeleton skeleton--line"></div><div class="skeleton skeleton--line short"></div></div>').join('')}</div>
    </div>`;
}

/* ---------------------------------------------------------------- toasts */

function notify(type, title, message, duration) {
  toast({ type, title, message, duration });
}

/* ------------------------------------------------------------ command run */

async function executeLine(line, { danger = false, confirmTitle = 'Confirm command', confirmMessage = '', successTitle = null } = {}) {
  if (danger) {
    const ok = await confirmDialog({
      title: confirmTitle,
      message: confirmMessage || `Run “${line}”?`,
      confirmLabel: 'Run command',
      details: 'This command changes live team or world state and cannot be undone from the dashboard.'
    });
    if (!ok) return null;
  }
  const result = await runCommand(line, { confirm: danger });
  const payload = payloadOf(result);
  if (payload && payload.requiresConfirmation) {
    const ok = await confirmDialog({
      title: 'Backend confirmation required',
      message: payload.error || 'This action requires explicit confirmation.',
      confirmLabel: 'Confirm and run',
      details: 'The backend rejected the first attempt and asked for explicit confirmation.'
    });
    if (!ok) return null;
    const retried = await runCommand(line, { confirm: true });
    const message = resultMessage(retried);
    notify(message.type, successTitle || message.title, message.message, message.type === 'error' ? 8000 : 4200);
    return retried;
  }
  const message = resultMessage(result);
  notify(message.type, successTitle || message.title, message.message, message.type === 'error' ? 8000 : 4200);
  return result;
}

async function onCommandButton(button) {
  if (button.dataset.busy === 'true') return;
  button.dataset.busy = 'true';
  setButtonLoading(button, true);
  try {
    await executeLine(button.dataset.command, {
      danger: button.dataset.danger === 'true',
      confirmTitle: button.dataset.confirmTitle || 'Confirm command',
      confirmMessage: button.dataset.confirmMessage || '',
      successTitle: button.dataset.successTitle || null
    });
    refreshCommands();
  } catch (err) {
    notify('error', 'Command failed', err.message || 'The backend rejected the command.', 8000);
  } finally {
    button.dataset.busy = 'false';
    setButtonLoading(button, false);
  }
}

async function onFleetCommand(button) {
  const base = button.dataset.fleetCommand;
  if (!base) return;
  if (button.dataset.danger === 'true') {
    const ok = await confirmDialog({
      title: button.dataset.confirmTitle || 'Confirm fleet command',
      message: button.dataset.confirmMessage || `Run “${base}” for every bot?`,
      confirmLabel: 'Run for all bots',
      details: 'Each bot receives the command individually. Failures are reported per bot.'
    });
    if (!ok) return;
  }
  setButtonLoading(button, true);
  const failures = [];
  let ok = 0;
  for (const name of botNames()) {
    try {
      const result = await runCommand(`${base} ${name}`);
      const payload = payloadOf(result);
      if (payload && payload.ok === false) failures.push(`${name}: ${payload.error || 'rejected'}`);
      else ok++;
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  setButtonLoading(button, false);
  if (failures.length) notify('warn', `${ok} succeeded`, failures.slice(0, 3).join(' · '), 9000);
  else notify('success', 'Fleet command complete', `${ok} bots accepted “${base}”.`);
  fetchLogs();
}

async function onBotAction(button) {
  const name = button.dataset.bot;
  const action = button.dataset.botAction;
  if (!name || !action) return;
  if (action === 'disconnect') {
    const ok = await confirmDialog({
      title: `Disconnect ${name}`,
      message: `Disconnect the session for ${name}?`,
      confirmLabel: 'Disconnect',
      details: 'The bot will leave the server. Autonomy may reconnect it depending on the connection gate.'
    });
    if (!ok) return;
  }
  setButtonLoading(button, true);
  try {
    const result = await runBotAction(name, action);
    if (result && result.ok === false) notify('error', 'Action failed', result.error || 'Backend rejected the action.', 8000);
    else notify('success', `${humanize(action)} ${action === 'state' ? 'read' : 'requested'}`, `${name}: ${result && result.text ? result.text : 'backend confirmed'}`, 4500);
  } catch (err) {
    notify('error', 'Action failed', err.message, 8000);
  } finally {
    setButtonLoading(button, false);
  }
}

async function onQueueAction(button) {
  const action = button.dataset.queueAction;
  if (!action) return;
  if (action === 'reset-cooldown') {
    const ok = await confirmDialog({
      title: 'Clear join queue cooldown',
      message: 'Clear the fleet-wide join cooldown and throttle strike counter?',
      confirmLabel: 'Clear cooldown',
      details: 'Only do this when you know the server throttle has expired. Hammering a live throttle can extend it.'
    });
    if (!ok) return;
  }
  setButtonLoading(button, true);
  try {
    const result = await runQueueAction(action);
    if (result && result.ok === false) notify('error', 'Queue action failed', result.error || 'Backend rejected the action.', 8000);
    else notify('success', 'Join queue updated', action === 'retry-all' ? `${result.queued || 0} reconnect(s) queued` : 'Cooldown cleared', 4500);
  } catch (err) {
    notify('error', 'Queue action failed', err.message, 8000);
  } finally {
    setButtonLoading(button, false);
  }
}

/* --------------------------------------------------------------- dropdown */

function closeDropdowns(except = null) {
  for (const menu of document.querySelectorAll('.dropdown-menu')) {
    if (menu === except) continue;
    menu.hidden = true;
    const trigger = document.querySelector(`[data-dropdown="${cssEscape(menu.id)}"]`);
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
}

function toggleDropdown(trigger) {
  const id = trigger.dataset.dropdown;
  const menu = document.getElementById(id);
  if (!menu) return;
  const willOpen = menu.hidden;
  closeDropdowns(menu);
  menu.hidden = !willOpen;
  trigger.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    const first = menu.querySelector('button, a');
    if (first) setTimeout(() => first.focus(), 20);
  }
}

/* ------------------------------------------------------------ notifications */

function openNotifications() {
  const panel = dom['notifications-panel'];
  if (!panel) return;
  const items = notifications();
  panel.innerHTML = `
    <div class="panel-header">
      <div><strong>Notifications</strong><span class="tiny muted">${unreadNotifications()} unread</span></div>
      <button class="icon-button" type="button" data-panel-close aria-label="Close notifications">${icon('x')}</button>
    </div>
    <div class="panel-body">
      ${items.length ? items.slice(0, 18).map((item) => `<div class="notification-row ${item.at > (prefs.notificationsReadAt || 0) ? 'is-unread' : ''}">
        <span class="notification-icon notification-icon--${item.level === 'error' ? 'danger' : item.level === 'warn' ? 'warn' : 'info'}">${icon(item.level === 'error' ? 'alert-circle' : item.level === 'warn' ? 'alert' : 'info')}</span>
        <div class="notification-main"><div class="notification-title">${esc(item.title)}</div><div class="notification-detail">${esc(item.detail)} · ${item.at ? esc(timeAgo(item.at)) : ''}</div></div>
      </div>`).join('') : `<div class="empty-state" style="padding:26px"><strong>No notifications</strong><p>Fleet alerts and warning/error entries appear here.</p></div>`}
    </div>
    <div class="panel-footer">
      <button class="button button--sm" type="button" data-panel-read>${icon('check')} Mark all read</button>
      <a class="button button--sm button--primary" href="#/notifications">View all</a>
    </div>`;
  panel.hidden = false;
  dom['notifications-toggle'].setAttribute('aria-expanded', 'true');
  panel.querySelector('[data-panel-close]').addEventListener('click', closeNotifications);
  panel.querySelector('[data-panel-read]').addEventListener('click', () => {
    markNotificationsRead();
    openNotifications();
    updateChrome(currentRoute || resolveRoute());
  });
}

function closeNotifications() {
  const panel = dom['notifications-panel'];
  if (!panel) return;
  panel.hidden = true;
  if (dom['notifications-toggle']) dom['notifications-toggle'].setAttribute('aria-expanded', 'false');
}

function toggleNotifications() {
  const panel = dom['notifications-panel'];
  if (!panel) return;
  if (panel.hidden) openNotifications();
  else closeNotifications();
}

/* --------------------------------------------------------------- palette */

function openPalette() {
  const navItems = NAV_ITEMS.map((item) => ({ type: 'nav', id: item.path, label: item.label, meta: item.group, icon: item.icon }));
  const commandItems = state.commands.map((command) => ({ type: 'command', id: command.name, label: command.name, meta: command.summary || command.category, usage: command.usage, dangerous: command.dangerous, icon: 'terminal' }));
  let filtered = [];
  let index = 0;
  const close = openModal({
    title: 'Command palette',
    label: 'Command palette',
    body: `
      <div class="palette">
        <div class="palette-input">${icon('search')}<input class="input" type="text" data-palette-input autofocus placeholder="Search pages or type a command…" aria-label="Search pages or type a command" autocomplete="off" spellcheck="false"></div>
        <div class="palette-list" data-palette-list role="listbox" aria-label="Results"></div>
        <div class="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Enter</kbd> select · <kbd>Esc</kbd> close</div>
      </div>`,
    wide: false,
    onMount: (modal, closeFn) => {
      const input = modal.querySelector('[data-palette-input]');
      const list = modal.querySelector('[data-palette-list]');
      const runText = (text) => {
        if (!text.trim()) return;
        closeFn();
        const name = text.trim().split(/\s+/)[0].toLowerCase();
        const meta = state.commands.find((command) => command.name === name || (command.aliases || []).includes(name));
        executeLine(text.trim(), meta && meta.dangerous ? { danger: true, confirmTitle: `Run ${name}`, confirmMessage: `Run “${text.trim()}”?` } : {})
          .catch((err) => notify('error', 'Command failed', err.message, 8000));
      };
      const renderList = () => {
        const query = input.value.trim().toLowerCase();
        const rank = (items, extra) => items
          .map((item) => ({ item, score: fuzzyScore(`${item.label} ${item.meta} ${extra ? extra(item) : ''}`, query) }))
          .filter((entry) => entry.score >= 0)
          .sort((left, right) => right.score - left.score)
          .map((entry) => entry.item);
        const navMatches = rank(navItems).slice(0, 6);
        const cmdMatches = rank(commandItems, (item) => item.usage || '').slice(0, 10);
        filtered = [];
        let html = '';
        if (query) {
          filtered.push({ type: 'run', id: input.value.trim() });
          html += paletteRow({ type: 'run', label: `Run “${input.value.trim()}”`, meta: 'Send to the backend', icon: 'terminal', index: filtered.length - 1, active: index === filtered.length - 1 });
        }
        for (const item of navMatches) {
          filtered.push(item);
          html += paletteRow({ ...item, index: filtered.length - 1, active: index === filtered.length - 1 });
        }
        if (cmdMatches.length) {
          html += `<div class="palette-section">Commands</div>`;
          for (const item of cmdMatches) {
            filtered.push(item);
            html += paletteRow({ ...item, usage: item.usage, index: filtered.length - 1, active: index === filtered.length - 1 });
          }
        }
        list.innerHTML = html || `<div class="palette-empty">No matches. Type a full command to run it.</div>`;
        list.querySelectorAll('[data-palette-index]').forEach((row) => row.addEventListener('click', () => activate(Number(row.dataset.paletteIndex))));
      };
      const activate = (at) => {
        const item = filtered[at];
        if (!item) return;
        if (item.type === 'run') runText(item.id);
        else if (item.type === 'nav') { closeFn(); location.hash = `#/${item.id}`; }
        else {
          input.value = `${item.label} `;
          input.focus();
          index = 0;
          renderList();
        }
      };
      const keydown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          index = Math.min(filtered.length - 1, index + 1);
          renderList();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          index = Math.max(0, index - 1);
          renderList();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (filtered[index]) activate(index);
          else if (input.value.trim()) runText(input.value);
        }
      };
      input.addEventListener('input', () => { index = 0; renderList(); });
      input.addEventListener('keydown', keydown);
      renderList();
      setTimeout(() => input.focus(), 40);
    }
  });
  return close;
}

function fuzzyScore(text, query) {
  const haystack = String(text || '').toLowerCase();
  if (!query) return 1;
  const direct = haystack.indexOf(query);
  if (direct >= 0) return 1000 - direct + query.length * 8;
  let at = 0;
  let score = 0;
  let streak = 0;
  for (const char of query) {
    if (char === ' ') continue;
    const found = haystack.indexOf(char, at);
    if (found < 0) return -1;
    streak = found === at ? streak + 1 : 0;
    score += 10 + streak * 6;
    at = found + 1;
  }
  return score - Math.min(80, at);
}

function paletteRow(item) {
  return `<button class="palette-row${item.active ? ' is-active' : ''}" type="button" role="option" aria-selected="${Boolean(item.active)}" data-palette-index="${item.index}">
    <span class="palette-icon">${icon(item.icon || 'chevron-right')}</span>
    <span class="palette-main"><span class="palette-label">${esc(item.label)}</span><span class="palette-meta">${esc(item.meta || '')}</span></span>
    ${item.dangerous ? '<span class="badge badge--danger">dangerous</span>' : ''}
    ${item.type === 'nav' ? '<span class="palette-key">go</span>' : '<span class="palette-key">↵</span>'}
  </button>`;
}

/* ---------------------------------------------------------------- wiring */

function wireShell() {
  const shortcut = document.querySelector('#command-trigger kbd');
  if (shortcut) shortcut.textContent = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K';
  const menu = dom['menu-toggle'];
  if (menu) menu.addEventListener('click', () => {
    const open = !document.body.classList.contains('sidebar-open');
    document.body.classList.toggle('sidebar-open', open);
    dom['sidebar-backdrop'].hidden = !open;
    menu.setAttribute('aria-expanded', String(open));
  });
  if (dom['sidebar-backdrop']) dom['sidebar-backdrop'].addEventListener('click', () => {
    document.body.classList.remove('sidebar-open');
    dom['sidebar-backdrop'].hidden = true;
    dom['menu-toggle'].setAttribute('aria-expanded', 'false');
  });
  const collapse = dom['sidebar-collapse'];
  if (collapse) collapse.addEventListener('click', () => {
    savePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed });
    applySidebarState();
  });
  if (dom['command-trigger']) dom['command-trigger'].addEventListener('click', openPalette);
  if (dom['notifications-toggle']) dom['notifications-toggle'].addEventListener('click', (event) => {
    event.stopPropagation();
    toggleNotifications();
  });
  dom.nav.addEventListener('click', (event) => {
    const groupToggle = event.target.closest('[data-nav-group-toggle]');
    if (groupToggle) {
      const label = groupToggle.dataset.navGroupToggle;
      const collapsed = new Set(Array.isArray(prefs.collapsedGroups) ? prefs.collapsedGroups : []);
      if (collapsed.has(label)) collapsed.delete(label);
      else collapsed.add(label);
      savePrefs({ collapsedGroups: [...collapsed] });
      applyNavGroupState();
      return;
    }
    const link = event.target.closest('[data-nav]');
    if (!link) return;
    if (window.innerWidth <= 780) {
      document.body.classList.remove('sidebar-open');
      dom['sidebar-backdrop'].hidden = true;
      dom['menu-toggle'].setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('click', (event) => {
    const dropdownTrigger = event.target.closest('[data-dropdown]');
    if (dropdownTrigger) {
      event.preventDefault();
      toggleDropdown(dropdownTrigger);
      return;
    }
    if (!event.target.closest('.dropdown-menu')) closeDropdowns();
    if (!event.target.closest('#notifications-panel') && !event.target.closest('#notifications-toggle')) closeNotifications();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (!isModalOpen()) openPalette();
    }
    if (event.key === 'Escape') {
      closeNotifications();
      closeDropdowns();
      if (document.body.classList.contains('sidebar-open')) {
        document.body.classList.remove('sidebar-open');
        dom['sidebar-backdrop'].hidden = true;
        dom['menu-toggle'].setAttribute('aria-expanded', 'false');
        dom['menu-toggle'].focus();
      }
    }
    if (event.key === '/' && !isModalOpen() && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      event.preventDefault();
      openPalette();
    }
  });
  dom['server-chip'] && dom['server-chip'].addEventListener('click', () => { location.hash = '#/connections'; });
  dom['fleet-chip'] && dom['fleet-chip'].addEventListener('click', () => { location.hash = '#/bots'; });
}

function wireGlobalActions() {
  document.addEventListener('click', async (event) => {
    const commandButton = event.target.closest('[data-command]');
    if (commandButton) {
      event.preventDefault();
      closeDropdowns();
      await onCommandButton(commandButton);
      return;
    }
    const fleetButton = event.target.closest('[data-fleet-command]');
    if (fleetButton) {
      event.preventDefault();
      await onFleetCommand(fleetButton);
      return;
    }
    const botAction = event.target.closest('[data-bot-action]');
    if (botAction) {
      event.preventDefault();
      await onBotAction(botAction);
      return;
    }
    const queueAction = event.target.closest('[data-queue-action]');
    if (queueAction) {
      event.preventDefault();
      await onQueueAction(queueAction);
      return;
    }
    const assign = event.target.closest('[data-task-assign]');
    if (assign) {
      const task = findTask(assign.dataset.taskAssign);
      if (task) openAssignDialog(task);
      else notify('warn', 'Task not found', 'The task board changed before the dialog opened.');
      return;
    }
    const priority = event.target.closest('[data-task-priority]');
    if (priority) {
      const task = findTask(priority.dataset.taskPriority);
      if (task) openPriorityDialog(task);
      return;
    }
    if (event.target.closest('[data-new-task]')) {
      openCreateDialog();
      return;
    }
    if (event.target.closest('[data-new-objective]')) {
      event.preventDefault();
      openObjectiveDialog();
      return;
    }
    if (event.target.closest('[data-command-palette]')) {
      openPalette();
      return;
    }
    if (event.target.closest('[data-refresh-logs]')) {
      fetchLogs();
      notify('info', 'Logs refreshed', 'Requested the latest log entries from the backend.', 2500);
      return;
    }
    if (event.target.closest('[data-refresh-view]')) {
      render({ force: true, routeChange: true });
    }
  });
}

function start() {
  cacheDom();
  buildShell();
  wireShell();
  wireGlobalActions();
  loadingView();
  subscribe((kind) => {
    if (kind === 'logs') scheduleRender();
    else if (kind === 'state' || kind === 'connection' || kind === 'init' || kind === 'commands' || kind === 'notifications') scheduleRender();
    else if (kind === 'prefs') scheduleRender();
  });
  window.addEventListener('hashchange', () => render({ routeChange: true, force: true }));
  document.addEventListener('app:rerender', () => render({ force: true }));
  document.addEventListener('app:sidebar-pref', applySidebarState);
  init().then(() => {
    render({ force: true, routeChange: true });
    refreshCommands();
  }).catch((err) => {
    console.error(err);
    render({ force: true, routeChange: true });
    notify('error', 'Startup failed', err.message || 'Unable to reach the backend.', 10000);
  });
}

start();
