import { state, runCommand, payloadOf, refreshState } from '../store.js';
import { icon } from '../icons.js';
import { esc, num, timeAgo, formatTime } from '../utils.js';
import { badge, kvRows, emptyState, pageHeader, statCard, toast, setButtonLoading } from '../ui.js';
import { bots, botNames } from './shared.js';

let routePreview = null;

function navigationData() {
  return (state.snapshot && state.snapshot.navigation) || {};
}

function perBotNavigation() {
  return bots().map((bot) => ({ bot, navigation: (bot && bot.navigation) || null }));
}

function positionText(position) {
  if (!position) return '—';
  return `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
}

function telemetryOf(navigation) {
  return (navigation && navigation.telemetry) || {};
}

function targetText(navigation) {
  const active = telemetryOf(navigation).active;
  if (!active) return '—';
  const target = active.target || active.goal;
  return target ? positionText(target) : '—';
}

function recentEvents(rows) {
  return rows.flatMap(({ bot, navigation }) => {
    const events = telemetryOf(navigation).events || [];
    return events.map((event) => ({ ...event, bot: bot.name }));
  }).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 14);
}

function routeResultHtml(payload, request) {
  if (!payload) return `<div class="callout callout--warn">${icon('alert')}<div>The command returned no route result.</div></div>`;
  if (payload.ok === false) {
    return `<div class="callout callout--danger">${icon('x-circle')}<div><strong>No route.</strong> ${esc(payload.error || payload.reason || payload.code || 'The planner rejected the destination.')}</div></div>`;
  }
  const path = Array.isArray(payload.path) ? payload.path : [];
  const points = path.slice(0, 24).map((point) => `${point.x},${point.y},${point.z}`);
  return `
    <div class="callout callout--info">${icon('check-circle')}<div><strong>Route found.</strong> ${num(payload.steps || path.length || 0)} steps · cost ${payload.distance === null || payload.distance === undefined ? '—' : num(Math.round(payload.distance * 10) / 10)} · ${num(payload.expanded)} nodes expanded in ${num(payload.ms)} ms. Preview only; the bot has not moved.</div></div>
    <div class="chips" style="margin-top:10px">
      ${badge(payload.reachable ? 'reachable' : 'unreachable', payload.reachable ? 'ok' : 'danger')}
      ${badge(`goal ${positionText(payload.goal)}`, 'neutral', { mono: true })}
      ${badge(`from ${positionText(payload.from)}`, 'neutral', { mono: true })}
    </div>
    ${points.length ? `<div class="path-waypoints" aria-label="Route waypoints">${points.map((point, index) => `<span class="path-waypoint"><span class="tiny muted">${index + 1}</span><span class="mono">${esc(point)}</span></span>`).join('')}</div>` : '<div class="tiny muted" style="margin-top:10px">No waypoints: the bot is already at the resolved stance.</div>'}
    <div class="toolbar" style="margin-top:12px">
      <button class="button button--primary button--sm" type="button" data-route-go data-bot="${esc(request.bot)}" data-x="${esc(request.x)}" data-y="${esc(request.y)}" data-z="${esc(request.z)}">${icon('navigation')} Walk this route</button>
      <span class="tiny muted">Operator goto is owned by the movement arbiter; a task path cannot override it.</span>
    </div>`;
}

export const navigationPage = {
  title: 'Navigation & Pathfinding',
  render() {
    const data = navigationData();
    const policy = data.policy || {};
    const totals = data.totals || {};
    const fleet = { active: [], conflicts: 0, relocations: 0, ...(data.fleet || {}) };
    const rows = perBotNavigation();
    const events = recentEvents(rows);
    const first = rows.find((row) => row.bot && row.bot.position);
    const fallback = first && first.bot.position ? first.bot.position : { x: 0, y: 65, z: 0 };
    const moving = rows.filter(({ navigation }) => navigation && navigation.active);
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Fleet', title: 'Navigation & Pathfinding',
          description: 'The single movement owner every autonomous task and operator command goes through. Preview a real route, inspect per-bot telemetry and see the exact policy the live pathfinder is using.',
          actions: `<button class="button" type="button" data-refresh-state>${icon('refresh')} Refresh</button><a class="button button--primary" href="#/world">${icon('map')} Live World</a>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Moving now', value: `${num(totals.moving || 0)}<small> / ${rows.length}</small>`, iconName: 'navigation', tone: (totals.moving || 0) ? 'accent' : 'neutral', context: moving.length ? moving.map(({ bot }) => bot.name).join(', ') : 'No active path' })}
          ${statCard({ label: 'Attempts', value: num(totals.attempts || 0), iconName: 'route', tone: 'info', context: `${num(totals.success || 0)} arrived · ${num(totals.failed || 0)} failed` })}
          ${statCard({ label: 'Success rate', value: totals.successRate === null || totals.successRate === undefined ? '—' : `${totals.successRate}%`, iconName: 'check-circle', tone: totals.successRate === null || totals.successRate === undefined ? 'neutral' : totals.successRate >= 90 ? 'success' : totals.successRate >= 70 ? 'warning' : 'danger', context: 'Arrivals / attempted moves' })}
          ${statCard({ label: 'Stuck / no path', value: `${num(totals.stuck || 0)}<small> / ${num(totals.noPath || 0)}</small>`, iconName: 'alert', tone: (totals.stuck || totals.noPath) ? 'warning' : 'success', context: `${num(totals.arrivalUnverified || 0)} arrival checks failed` })}
          ${statCard({ label: 'Plan p95', value: totals.p95Ms === null || totals.p95Ms === undefined ? '—' : `${num(Math.round(totals.p95Ms))}<small> ms</small>`, iconName: 'clock', tone: 'neutral', context: 'Observed movement duration p95' })}
        </div>

        <div class="grid grid--main-side">
          <div class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('navigation')} Route planner</div><span class="badge badge--outline">preview only</span></div>
              <div class="card-body">
                <form data-route-form>
                  <div class="form-grid form-grid--3">
                    <div class="field"><label class="field-label" for="route-bot">Bot</label><select class="select" id="route-bot">${botNames().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select></div>
                    <div class="field"><label class="field-label" for="route-x">X</label><input class="input" id="route-x" type="number" value="${esc(Math.round(fallback.x))}" required></div>
                    <div class="field"><label class="field-label" for="route-y">Y</label><input class="input" id="route-y" type="number" value="${esc(Math.round(fallback.y))}" required></div>
                    <div class="field"><label class="field-label" for="route-z">Z</label><input class="input" id="route-z" type="number" value="${esc(Math.round(fallback.z))}" required></div>
                  </div>
                  <div class="toolbar" style="margin-top:10px">
                    <button class="button button--primary" type="submit">${icon('route')} Plan route</button>
                    <span class="tiny muted">Uses the same standability and A* rules as the simulator. No blocks are changed.</span>
                  </div>
                </form>
                <div data-route-result style="margin-top:12px">${routePreview ? routeResultHtml(routePreview.payload, routePreview.request) : emptyState('No route preview yet', 'Enter a destination and plan a route. The result is a real backend route, not a straight-line estimate.', 'route')}</div>
              </div>
            </section>

            <section class="card">
              <div class="card-header"><div class="card-title">${icon('users')} Fleet paths</div><span class="tiny muted">${rows.length} reported</span></div>
              <div class="table-wrap"><table class="table">
                <thead><tr><th>Bot</th><th>Position</th><th>Movement</th><th>Target</th><th>Attempts</th><th>Success</th><th>Stuck / no path</th><th>Last failure</th><th>Actions</th></tr></thead>
                <tbody>
                  ${rows.length ? rows.map(({ bot, navigation }) => {
                    const telemetry = telemetryOf(navigation);
                    const nav = navigation || {};
                    const stateBadge = nav.active
                      ? badge(`moving · ${nav.owner || nav.priority || 'path'}`, 'accent', { dot: true })
                      : badge(navigation && navigation.error ? 'status error' : 'idle', navigation && navigation.error ? 'danger' : 'neutral', { dot: true });
                    return `<tr>
                      <td><a class="link" href="#/bots/${encodeURIComponent(bot.name)}/navigation">${esc(bot.name)}</a></td>
                      <td class="mono tiny">${esc(positionText(bot.position))}</td>
                      <td>${stateBadge}</td>
                      <td class="mono tiny">${esc(targetText(navigation))}</td>
                      <td class="mono">${num(telemetry.attempts || 0)}</td>
                      <td class="mono">${telemetry.successRate === null || telemetry.successRate === undefined ? '—' : `${telemetry.successRate}%`}</td>
                      <td class="mono">${num(telemetry.stuck || 0)} / ${num(telemetry.noPath || 0)}</td>
                      <td class="tiny truncate" style="max-width:220px" title="${esc(telemetry.lastError || '')}">${esc(telemetry.lastError || '—')}</td>
                      <td><div class="row gap-2">
                        <button class="button button--sm" type="button" data-command="return home ${esc(bot.name)}">${icon('home')} Home</button>
                        <button class="button button--sm button--ghost" type="button" data-command="bot ${esc(bot.name)} stop">${icon('stop')} Stop</button>
                      </div></td>
                    </tr>`;
                  }).join('') : `<tr><td colspan="9">${emptyState('No navigation state', 'The runtime has not reported a navigation manager yet.', 'navigation')}</td></tr>`}
                </tbody>
              </table></div>
            </section>

            <section class="card">
              <div class="card-header"><div class="card-title">${icon('activity')} Recent movement events</div><span class="tiny muted">local observations</span></div>
              <div class="activity-list">
                ${events.length ? events.map((event) => `<div class="activity-item">
                  <span class="activity-icon">${icon(event.kind === 'stuck' ? 'alert' : event.kind === 'arrived' ? 'check-circle' : event.kind === 'cancelled' ? 'stop' : 'route')}</span>
                  <div class="activity-main">
                    <div>${esc(event.kind)}${event.owner ? ` · ${esc(event.owner)}` : ''}${event.code ? ` · ${esc(event.code)}` : ''}</div>
                    <div class="mono">${esc(event.bot)} · ${event.at ? esc(timeAgo(event.at)) : ''}${event.error ? ` · ${esc(event.error)}` : ''}</div>
                  </div>
                </div>`).join('') : '<div class="muted small" style="padding:8px">No movement events yet. Events appear after a bot plans or follows a path.</div>'}
              </div>
            </section>
          </div>

          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('shield')} Movement policy</div></div>
              <div class="card-body">${kvRows([
                ['Strict destinations', policy.strictDestinations ? 'on' : 'off'],
                ['Max safe drop', `${policy.maxDrop ?? '—'} blocks`],
                ['Water', policy.allowWater ? 'allowed' : 'refused'],
                ['Task attempts', num(policy.taskAttempts)],
                ['Operator attempts', num(policy.operatorAttempts)],
                ['Stuck window', policy.stuckWindowMs ? `${num(policy.stuckWindowMs)} ms` : '—'],
                ['Adaptive search', policy.adaptiveSearchRadius ? `on · ${num(policy.baseSearchRadius)} base / ${num(policy.searchRadiusMax)} cap` : 'off'],
                ['Think / tick budget', `${num(policy.thinkTimeoutMs)} / ${num(policy.tickTimeoutMs)} ms`],
                ['Sprint', policy.sprint ? 'on' : 'off'],
                ['Doors', policy.openDoors ? 'can open' : 'closed'],
                ['Dig / scaffold', `${policy.allowDig ? 'dig' : 'no dig'} / ${policy.allowScaffold ? 'scaffold' : 'no scaffold'}`]
              ])}</div>
            </section>

            <section class="card">
              <div class="card-header"><div class="card-title">${icon('map-pin')} Stance claims</div>${badge(`${fleet.active.length}`, fleet.active.length ? 'accent' : 'neutral')}</div>
              <div class="card-body">
                ${fleet.active.length ? `<div class="stack gap-2">${fleet.active.map((claim) => `<div class="list-item"><span class="list-icon">${icon('map-pin')}</span><div class="list-main"><div class="list-title">${esc(claim.owner)} <span class="mono tiny">${esc(positionText(claim.position))}</span></div><div class="list-sub">${esc(claim.kind || 'task')} · expires ${claim.expiresAt ? esc(formatTime(claim.expiresAt)) : '—'}</div></div></div>`).join('')}</div>` : '<div class="muted small">No bot currently holds a stance claim.</div>'}
                ${kvRows([
                  ['Conflicts relocated', num(fleet.relocations)],
                  ['Conflicts observed', num(fleet.conflicts)],
                  ['Claim radius', fleet.radius === undefined ? '—' : `${fleet.radius} blocks`]
                ])}
              </div>
            </section>

            <section class="card">
              <div class="card-header"><div class="card-title">${icon('info')} How it works</div></div>
              <div class="card-body tiny muted">
                Every autonomous task calls the same manager: destination validation, fleet stance claims, one motion owner per bot, bounded attempts, stuck/recovery, arrival evidence and telemetry. Mining and woodcutting dig their own access; routine travel never digs or scaffolds. Safety and operator moves outrank task movement.
              </div>
            </section>
          </aside>
        </div>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-route-form]');
    const resultHost = root.querySelector('[data-route-result]');
    const refresh = root.querySelector('[data-refresh-state]');
    if (refresh) refresh.addEventListener('click', () => refreshState().catch(() => {}));
    if (form && resultHost) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const request = {
          bot: form.querySelector('#route-bot').value,
          x: form.querySelector('#route-x').value,
          y: form.querySelector('#route-y').value,
          z: form.querySelector('#route-z').value
        };
        const button = form.querySelector('button[type="submit"]');
        setButtonLoading(button, true);
        try {
          const entry = await runCommand(`path ${request.x} ${request.y} ${request.z} ${request.bot}`);
          routePreview = { payload: payloadOf(entry), request };
          const host = root.querySelector('[data-route-result]');
          if (host) host.innerHTML = routeResultHtml(routePreview.payload, request);
        } catch (err) {
          routePreview = { payload: { ok: false, error: err.message }, request };
          const host = root.querySelector('[data-route-result]');
          if (host) host.innerHTML = routeResultHtml(routePreview.payload, request);
        } finally {
          setButtonLoading(button, false);
        }
      });
    }
    // The result panel is replaced with innerHTML after planning, so its
    // button cannot own a listener attached during mount. Delegate from the
    // page root; this also survives the live-morph renderer.
    root.addEventListener('click', async (event) => {
      const go = event.target.closest('[data-route-go]');
      if (!go) return;
      setButtonLoading(go, true);
      try {
        const entry = await runCommand(`bot ${go.dataset.bot} goto ${go.dataset.x} ${go.dataset.y} ${go.dataset.z}`);
        const payload = payloadOf(entry);
        toast(payload && payload.ok === false
          ? { type: 'error', title: 'Navigation failed', message: payload.error || 'The bot did not arrive.' }
          : { type: 'success', title: 'Navigation started', message: `${go.dataset.bot} is walking to ${go.dataset.x}, ${go.dataset.y}, ${go.dataset.z}.` });
      } catch (err) {
        toast({ type: 'error', title: 'Navigation failed', message: err.message });
      } finally {
        setButtonLoading(go, false);
      }
    });
  }
};
