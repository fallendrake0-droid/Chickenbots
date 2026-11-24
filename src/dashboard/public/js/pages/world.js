import { icon } from '../icons.js';
import { esc, num } from '../utils.js';
import { pageHeader, statCard, badge, emptyState } from '../ui.js';
import { state, botNames, bots } from '../store.js';
import { createWorldViewer } from '../viewer3d.js';
import { api } from '../api.js';

const view = {
  selected: null,
  radius: 20,
  follow: true,
  viewer: null,
  data: null,
  error: null,
  loading: false,
  lastFetch: 0,
  stats: null,
  root: null,
  timer: null
};

function onlineBots() {
  return bots().filter((bot) => bot.online === true);
}

function defaultBot() {
  const online = onlineBots();
  const leader = state.snapshot && state.snapshot.overview && state.snapshot.overview.leader;
  if (leader && botNames().includes(leader)) return leader;
  return (online[0] && online[0].name) || botNames()[0] || null;
}

function timeLabel(time) {
  if (!time || !Number.isFinite(Number(time.timeOfDay))) return '—';
  const day = Number(time.day) || 1;
  const hours = (((Number(time.timeOfDay) / 1000) + 6) % 24 + 24) % 24;
  const hh = String(Math.floor(hours)).padStart(2, '0');
  const mm = String(Math.floor((hours % 1) * 60)).padStart(2, '0');
  return `day ${day} · ${hh}:${mm}`;
}

function recoveryFor(name) {
  const list = (state.snapshot && state.snapshot.recovery) || [];
  return list.find((entry) => entry.bot === name) || null;
}

export const worldPage = {
  title: 'Live World',
  render() {
    const names = botNames();
    const selected = view.selected && names.includes(view.selected) ? view.selected : defaultBot();
    view.selected = selected;
    const data = view.data;
    const recovery = selected ? recoveryFor(selected) : null;
    const online = onlineBots().length;
    return `
      <div class="page page--world">
        ${pageHeader({
          eyebrow: 'General',
          title: 'Live World',
          description: 'A real 3D view of the surfaced terrain around a bot: block heights, entities and the fleet, rendered in one batched mesh with a bounded radius.',
          actions: `<button class="button" type="button" data-world-reset>${icon('compass')} Reset camera</button><button class="button" type="button" data-world-fullscreen>${icon('scan')} Fullscreen</button><button class="button button--primary" type="button" data-world-refresh>${icon('refresh')} Refresh</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Online', value: `${num(online)}<small> / ${names.length || 10}</small>`, iconName: 'users', tone: online === names.length ? 'success' : online ? 'warning' : 'danger', context: online ? 'Spawned and authenticated' : 'Waiting for the connection gate' })}
          ${statCard({ label: 'View radius', value: `${num(view.radius)}<small> m</small>`, iconName: 'cube', tone: 'info', context: 'Server clamps 4–32m' })}
          ${statCard({ label: 'Columns', value: num(data && data.counts ? data.counts.columns : 0), iconName: 'grid', tone: 'neutral', context: data ? `${num(data.counts.chunks)} chunks · ${num(data.counts.entities)} entities` : 'No snapshot yet' })}
          ${statCard({ label: 'Render', value: view.stats ? `${num(view.stats.fps)}<small> fps</small>` : '—', iconName: 'activity', tone: view.stats && view.stats.fps >= 30 ? 'success' : 'warning', context: view.stats ? `${num(view.stats.triangles)} triangles · ${esc(view.stats.mode)}` : 'Measuring the first frames' })}
        </div>
        <div class="world-layout">
          <section class="card world-stage">
            <div class="world-stage-head">
              <div class="row gap-2 world-controls">
                <label class="field-label" for="world-bot">Centre</label>
                <select class="select select--sm" id="world-bot" data-world-bot-select>
                  ${names.map((name) => `<option value="${esc(name)}"${name === selected ? ' selected' : ''}>${esc(name)}${onlineBots().some((bot) => bot.name === name) ? '' : ' (offline)'}</option>`).join('')}
                </select>
                <label class="field-label" for="world-radius">Radius</label>
                <select class="select select--sm" id="world-radius" data-world-radius>
                  ${[12, 20, 28, 32].map((value) => `<option value="${value}"${value === view.radius ? ' selected' : ''}>${value}m</option>`).join('')}
                </select>
                <button class="button button--sm${view.follow ? ' button--primary' : ''}" type="button" data-world-follow aria-pressed="${view.follow}">${icon('target')} Follow</button>
              </div>
              <div class="row gap-2 tiny muted">
                <span data-world-source>${data ? esc(data.source) : 'waiting'}</span>
                <span>·</span>
                <span class="mono" data-world-center>${data ? `${data.center.x}, ${data.center.y}, ${data.center.z}` : '—'}</span>
                <span>·</span>
                <span data-world-time>${data ? esc(timeLabel(data.time)) : '—'}</span>
              </div>
            </div>
            <div class="world-canvas-wrap" data-world-canvas-wrap>
              <canvas id="world-canvas" class="world-canvas" aria-label="3D view of the Minecraft world around the selected bot"></canvas>
              <canvas id="world-overlay" class="world-overlay" aria-hidden="true"></canvas>
              <div class="world-hud" data-world-hud>
                <div class="world-hud-title">${icon('cube')} <span data-world-hud-bot>${esc(selected || '—')}</span></div>
                <div class="world-hud-grid">
                  <span>FPS</span><strong data-world-fps>—</strong>
                  <span>Mode</span><strong data-world-mode>${view.stats ? esc(view.stats.mode) : '—'}</strong>
                  <span>Frame</span><strong data-world-frame>—</strong>
                  <span>Triangles</span><strong data-world-tris>—</strong>
                  <span>Draws</span><strong data-world-draws>—</strong>
                  <span>Entities</span><strong data-world-entities>—</strong>
                </div>
              </div>
              <div class="world-error" data-world-error ${view.error ? '' : 'hidden'}>${view.error ? `<strong>World view unavailable.</strong> ${esc(view.error)}` : ''}</div>
              <div class="world-loading" data-world-loading ${view.loading ? '' : 'hidden'}>Loading real chunk data…</div>
              <div class="world-help">Drag to orbit · wheel to zoom · shift-drag to pan · click a bot to centre</div>
            </div>
          </section>
          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('users')} Fleet</div><span class="tiny muted">${online.length}/${names.length}</span></div>
              <div class="card-body card-body--tight world-bot-list">
                ${names.map((name) => {
                  const bot = bots().find((entry) => entry.name === name) || { name, online: false };
                  const rec = recoveryFor(name);
                  const task = bot.task || (bot.assignment && bot.assignment.label) || null;
                  return `<button class="world-bot${name === selected ? ' is-active' : ''}" type="button" data-world-bot="${esc(name)}">
                    <span class="status-dot status-dot--${bot.online ? 'ok' : 'danger'}"></span>
                    <span class="world-bot-main"><strong>${esc(name)}</strong><span class="tiny muted">${bot.online ? `health ${num(bot.health)} · food ${num(bot.food)}` : 'offline'}</span></span>
                    ${rec && rec.state !== 'ACTIVE' ? badge(rec.state, rec.deathLoop ? 'danger' : 'warn') : ''}
                    ${task ? `<span class="world-bot-task tiny">${esc(task)}</span>` : ''}
                  </button>`;
                }).join('')}
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('layers')} Snapshot</div><span class="badge badge--outline">${data ? 'real data' : 'no data'}</span></div>
              <div class="card-body">
                <div class="kv">
                  <div class="kv-row"><span class="kv-key">Dimension</span><span class="kv-value mono">${esc(data ? data.dimension : '—')}</span></div>
                  <div class="kv-row"><span class="kv-key">Chunks</span><span class="kv-value">${num(data ? data.counts.chunks : 0)}</span></div>
                  <div class="kv-row"><span class="kv-key">Bot entities</span><span class="kv-value">${num(data ? data.counts.bots : 0)}</span></div>
                  <div class="kv-row"><span class="kv-key">Mobs / players</span><span class="kv-value">${num(data ? data.counts.entities : 0)}</span></div>
                  <div class="kv-row"><span class="kv-key">Fetch</span><span class="kv-value">${data ? `${num(data.ms || 0)} ms${data.cached ? ' (cached)' : ''}` : '—'}</span></div>
                </div>
                ${recovery && recovery.state !== 'ACTIVE' ? `<div class="callout callout--warn" style="margin-top:10px">${icon('alert')}<div><strong>Recovery ${esc(recovery.state)}.</strong> ${esc(recovery.reason)}${recovery.spawnSafety && recovery.spawnSafety.reasons && recovery.spawnSafety.reasons.length ? ` Spawn: ${esc(recovery.spawnSafety.reasons.join(', '))}.` : ''}</div></div>` : ''}
                <div class="divider"></div>
                <div class="tiny muted">Rendering uses the exposed surface (one block per column) plus live entities. Caves and interior blocks are not sent; the server scans only the bounded radius shown above.</div>
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('map-pin')} Nearby entities</div><span class="tiny muted">${data ? data.entities.length : 0}</span></div>
              <div class="card-body card-body--tight">
                ${data && data.entities.length ? `<div class="entity-list">${data.entities.slice(0, 12).map((entity) => `<div class="entity-row"><span class="status-dot status-dot--${entity.hostile ? 'danger' : 'neutral'}"></span><span>${esc(entity.name)}</span><span class="tiny muted mono">${entity.position.map((n) => Math.round(n)).join(', ')}</span></div>`).join('')}</div>` : emptyState('No entities nearby', state.snapshot ? 'The selected bot has no visible mobs or players.' : 'Waiting for the first world snapshot.', 'eye')}
              </div>
            </section>
          </aside>
        </div>
      </div>`;
  },
  mount(root) {
    view.root = root;
    const canvas = root.querySelector('#world-canvas');
    const overlay = root.querySelector('#world-overlay');
    if (canvas && !view.viewer) {
      try {
        view.viewer = createWorldViewer({
          canvas,
          overlay,
          onSelect: (hit) => {
            if (hit.kind !== 'bot' || !hit.name) return;
            view.selected = hit.name;
            view.viewer.setSelected(hit.name);
            for (const button of root.querySelectorAll('.world-bot[data-world-bot]')) button.classList.toggle('is-active', button.dataset.worldBot === hit.name);
            const select = root.querySelector('[data-world-bot-select]');
            if (select) select.value = hit.name;
            fetchWorld(true);
          },
          onStats: (stats) => updateStats(root, stats)
        });
      } catch (err) {
        view.error = err.message;
      }
    }
    const select = root.querySelector('[data-world-bot-select]');
    if (select) select.addEventListener('change', () => { view.selected = select.value; view.viewer && view.viewer.setSelected(view.selected); fetchWorld(true); });
    const radius = root.querySelector('[data-world-radius]');
    if (radius) radius.addEventListener('change', () => { view.radius = Number(radius.value) || 20; fetchWorld(true); });
    const follow = root.querySelector('[data-world-follow]');
    if (follow) follow.addEventListener('click', () => {
      view.follow = !view.follow;
      follow.classList.toggle('button--primary', view.follow);
      follow.setAttribute('aria-pressed', String(view.follow));
      if (view.viewer) view.viewer.setFollow(view.follow);
    });
    const reset = root.querySelector('[data-world-reset]');
    if (reset) reset.addEventListener('click', () => view.viewer && view.viewer.resetCamera());
    const refresh = root.querySelector('[data-world-refresh]');
    if (refresh) refresh.addEventListener('click', () => fetchWorld(true));
    const fullscreen = root.querySelector('[data-world-fullscreen]');
    if (fullscreen) fullscreen.addEventListener('click', () => {
      const card = root.querySelector('.world-stage');
      if (!card) return;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => null);
      else if (card.requestFullscreen) card.requestFullscreen().catch(() => null);
    });
    root.querySelectorAll('.world-bot[data-world-bot]').forEach((button) => button.addEventListener('click', () => {
      view.selected = button.dataset.worldBot;
      if (view.viewer) view.viewer.setSelected(view.selected);
      const selectEl = root.querySelector('[data-world-bot-select]');
      if (selectEl) selectEl.value = view.selected;
      root.querySelectorAll('.world-bot').forEach((entry) => entry.classList.toggle('is-active', entry.dataset.worldBot === view.selected));
      fetchWorld(true);
    }));
    if (view.data && view.viewer) {
      view.viewer.setData(view.data);
      view.viewer.setSelected(view.selected);
    }
    fetchWorld(true);
    if (view.timer) clearInterval(view.timer);
    view.timer = setInterval(() => fetchWorld(false), 3000);
  },
  update(root) {
    view.root = root;
    if (!view.viewer) return;
    const now = Date.now();
    if (!view.loading && now - view.lastFetch > 2200) fetchWorld(false);
  },
  unmount() {
    if (view.timer) clearInterval(view.timer);
    view.timer = null;
    if (view.viewer) view.viewer.dispose();
    view.viewer = null;
    view.root = null;
  }
};

async function fetchWorld(force) {
  if (view.loading) return;
  if (!force && view.data && Date.now() - view.lastFetch < 2500) return;
  view.loading = true;
  toggleLoading(true);
  try {
    const payload = await api.world({ bot: view.selected, radius: view.radius });
    view.lastFetch = Date.now();
    if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || 'world endpoint returned no data');
    view.data = payload;
    view.error = null;
    if (view.viewer) {
      view.viewer.setData(payload);
      view.viewer.setSelected(view.selected);
    }
    if (!view.selected && payload.bot) view.selected = payload.bot;
    updateHud(payload);
  } catch (err) {
    view.error = err.message || 'world request failed';
    view.lastFetch = Date.now();
    showError(view.error);
  } finally {
    view.loading = false;
    toggleLoading(false);
  }
}

function toggleLoading(show) {
  if (!view.root) return;
  const el = view.root.querySelector('[data-world-loading]');
  if (el) el.hidden = !show;
}

function showError(message) {
  if (!view.root) return;
  const el = view.root.querySelector('[data-world-error]');
  if (!el) return;
  el.hidden = !message;
  el.innerHTML = message ? `<strong>World view unavailable.</strong> ${esc(message)}` : '';
}

function updateHud(data) {
  if (!view.root) return;
  const set = (selector, text) => {
    const el = view.root.querySelector(selector);
    if (el) el.textContent = text;
  };
  set('[data-world-source]', data.source || '—');
  set('[data-world-center]', `${data.center.x}, ${data.center.y}, ${data.center.z}`);
  set('[data-world-time]', timeLabel(data.time));
  set('[data-world-hud-bot]', data.bot || view.selected || '—');
  set('[data-world-entities]', String((data.entities || []).length));
  showError(null);
}

function updateStats(root, stats) {
  view.stats = stats;
  const set = (selector, text) => {
    const el = root.querySelector(selector);
    if (el) el.textContent = text;
  };
  set('[data-world-fps]', String(stats.fps));
  set('[data-world-mode]', stats.mode);
  set('[data-world-frame]', `${stats.frameMs} ms`);
  set('[data-world-tris]', num(stats.triangles));
  set('[data-world-draws]', String(stats.drawCalls));
  set('[data-world-entities]', String(stats.entities));
}
