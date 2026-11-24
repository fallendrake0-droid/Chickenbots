import { state } from '../store.js';
import { icon } from '../icons.js';
import { esc, num, duration, sum } from '../utils.js';
import { statCard, badge, emptyState, sectionHead } from '../ui.js';
import { lineChart } from '../charts.js';
import { snapshot, overview, bots, botNames, teamState, alertsBlock, activityBlock, objectiveBlock, botCard, statusDot, ledger, botStatus, botOnline } from './shared.js';

export default {
  title: 'Overview',
  render() {
    const snap = snapshot();
    if (!snap) {
      return `<div class="card">${emptyState('Waiting for data', 'The dashboard is connecting to the Chickenbots runtime.', 'activity')}</div>`;
    }
    const ov = overview();
    const fleet = bots();
    const online = fleet.filter(botOnline);
    const tasks = ov.tasks || {};
    const byStatus = tasks.byStatus || {};
    const activeTasks = (byStatus.ACTIVE || 0) + (byStatus.CLAIMED || 0);
    const avgHealth = online.length ? online.reduce((total, bot) => total + (Number(bot.health) || 0), 0) / online.length : 0;
    const ledgerData = ledger();
    const tracked = sum(ledgerData.rows, (row) => row.total);
    const builds = (snap.builder && snap.builder.builds) || [];
    const activeBuilds = builds.filter((build) => !['COMPLETE', 'CANCELLED', 'FAILED'].includes(build.state));
    const objective = ((snap.taskManager && snap.taskManager.objectives) || []).find((entry) => entry.status === 'ACTIVE') || null;
    const leader = (teamState() && teamState().leader) || ov.leader;
    const runtime = snap.diagnostics && snap.diagnostics.runtime;
    const modeBadge = badge(snap.mode === 'live' ? 'Live server' : 'Simulation', snap.mode === 'live' ? 'ok' : 'info', { dot: true });
    const server = (snap.diagnostics && snap.diagnostics.config && snap.diagnostics.config.server) || {};
    const autonomyPaused = runtime && runtime.paused;
    const uptime = runtime && runtime.uptimeMs;
    const rosterNames = botNames();

    return `
      <div class="page">
        <section class="overview-hero">
          <div>
            <div class="eyebrow">Operations overview</div>
            <h1>Welcome to Chickenbots</h1>
            <p>Ten autonomous bots, one coordinated team. This is the live operational picture.</p>
            <div class="hero-meta">
              <span class="status">${icon('server')} ${esc(server.host || 'server not configured')}:${esc(server.port || '—')}</span>
              <span class="status">${modeBadge}</span>
              <span class="status">${statusDot(online.length === fleet.length && fleet.length ? 'ok' : online.length ? 'warn' : 'danger', true)} ${online.length}/${fleet.length || rosterNames.length} bots online</span>
              ${leader ? `<span class="status">${icon('users')} Leader <strong style="color:var(--text)">${esc(leader)}</strong></span>` : ''}
              ${runtime ? `<span class="status">${autonomyPaused ? badge('Autonomy paused', 'warn') : badge('Autonomy running', 'ok', { dot: true })}</span>` : ''}
            </div>
            <div class="chips" aria-label="Bot roster" style="margin-top:.85rem">
              ${rosterNames.map((name) => {
                const bot = fleet.find((entry) => entry.name === name);
                const status = botStatus(bot);
                return `<span class="chip mono chip--status" title="${esc(bot ? `${name}: ${status.label} — ${status.detail}` : `${name}: not reported by the runtime`)}">${statusDot(status.dot, status.online)}${esc(name)}</span>`;
              }).join('')}
            </div>
          </div>
          <div class="hero-actions">
            <button class="button" type="button" data-command="${autonomyPaused ? 'resume' : 'pause'}">${icon(autonomyPaused ? 'play' : 'pause')} ${autonomyPaused ? 'Resume autonomy' : 'Pause autonomy'}</button>
            <button class="button button--primary" type="button" data-command-palette>${icon('terminal')} Run command</button>
          </div>
        </section>

        <div class="grid grid--stats">
          ${statCard({
            label: 'Bots online', value: `${online.length}<small> / ${fleet.length || rosterNames.length}</small>`,
            iconName: 'users', tone: fleet.length && online.length === fleet.length ? 'success' : online.length ? 'warning' : 'danger',
            context: `${online.filter((bot) => bot.authenticated !== false).length} authenticated · ${fleet.filter((bot) => !botOnline(bot)).length} not online`,
            progressValue: online.length, progressMax: fleet.length || rosterNames.length
          })}
          ${statCard({
            label: 'Active tasks', value: num(activeTasks),
            iconName: 'clipboard', tone: activeTasks ? 'accent' : 'neutral',
            context: `${num(byStatus.PENDING || 0)} planned · ${num(byStatus.COMPLETED || 0)} completed · ${num(byStatus.FAILED || 0)} failed`
          })}
          ${statCard({
            label: 'Team health', value: `${avgHealth.toFixed(1)}<small> / 20</small>`,
            iconName: 'heart', tone: avgHealth >= 16 ? 'success' : avgHealth >= 10 ? 'warning' : 'danger',
            context: `Average across ${online.length} online bot${online.length === 1 ? '' : 's'}`,
            progressValue: avgHealth, progressMax: 20
          })}
          ${statCard({
            label: 'Tracked resources', value: num(tracked),
            iconName: 'package', tone: 'info',
            context: `${num(ledgerData.rows.length)} item types · ${num(ledgerData.reservations.length)} reservations`
          })}
          ${statCard({
            label: 'Construction', value: num(activeBuilds.length),
            iconName: 'hammer', tone: activeBuilds.length ? 'accent' : 'neutral',
            context: `${num((snap.schematics && snap.schematics.stats && snap.schematics.stats.count) || 0)} validated designs available`
          })}
          ${statCard({
            label: 'System uptime', value: uptime ? esc(duration(uptime)) : '—',
            iconName: 'clock', tone: 'neutral',
            context: runtime ? `${num(runtime.ticks)} autonomy ticks · ${runtime.autonomyAllowed ? 'gate open' : 'gate closed'}` : 'Runtime telemetry unavailable'
          })}
        </div>

        <div class="section grid grid--main-side">
          <div>
            ${sectionHead('Fleet overview', {
              subtitle: 'All ten fixed usernames, with their current activity and vitals.',
              actions: `<a class="button button--sm" href="#/bots">All bots ${icon('arrow-right')}</a>`
            })}
            <div class="grid grid--bots">
              ${fleet.length ? fleet.map((bot) => botCard(bot)).join('') : `<div class="card">${emptyState('No fleet data', 'The runtime has not reported bot summaries yet.', 'users')}</div>`}
            </div>
            <div class="section">${sectionHead('Team vitals', { subtitle: 'Health samples captured in this browser since the page opened.' })}
              <div class="card chart-card" id="overview-vitals" data-preserve-children></div>
            </div>
          </div>

          <aside class="stack gap-4 sticky-side">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('alert')} Attention</div>${badge(`${(ov.alerts || []).length}`, (ov.alerts || []).length ? 'warn' : 'ok')}</div>
              <div class="card-body card-body--tight">${alertsBlock(ov.alerts || [], { limit: 6 })}</div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('target')} Current objective</div><a class="tiny muted" href="#/tasks">Task manager</a></div>
              <div class="card-body card-body--tight">${objectiveBlock(objective, (snap.taskManager && snap.taskManager.tasks) || [])}</div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('activity')} Live activity</div><a class="tiny muted" href="#/activity">View all</a></div>
              <div class="activity-list">${activityBlock(state.logs, { limit: 9 })}</div>
            </section>
          </aside>
        </div>
      </div>`;
  },
  mount(root) {
    this.update(root);
  },
  update(root) {
    const host = root.querySelector('#overview-vitals');
    if (!host) return;
    host.setAttribute('data-preserve-children', '');
    host.innerHTML = `
      <div class="chart-head">
        <div>
          <div class="card-title">${icon('heart')} Fleet health</div>
          <div class="card-subtitle">Real samples collected since this page opened (${state.samples.length})</div>
        </div>
        <div class="chart-legend">${botNames().map((name, index) => `<span class="legend-item"><span class="legend-swatch" style="background:${['#39b8a5','#5998e8','#e5a947','#a78bfa','#e05b68','#4ecdc4','#f78c6b','#8bd450','#c77dff','#ffb703'][index % 10]}"></span>${esc(name)}</span>`).join('')}</div>
      </div>
      ${lineChart(state.samples, botNames(), { metric: 'health', max: 20 })}`;
  }
};
