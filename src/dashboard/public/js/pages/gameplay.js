import { state, runCommand, payloadOf } from '../store.js';
import { icon } from '../icons.js';
import { esc, num, clamp, humanize, healthTone, timeAgo, sum } from '../utils.js';
import { badge, progress, kvRows, emptyState, pageHeader, statCard, toast, confirmDialog, setButtonLoading, resultMessage } from '../ui.js';
import { bots, botNames, ledger } from './shared.js';
import { inventoryPanel, mountInventory, inventorySummary, applyInventoryFilter } from './inventoryView.js';

function perBot(key) {
  return (state.snapshot && state.snapshot[key]) || [];
}

function bedText(bed) {
  if (!bed) return '—';
  if (typeof bed === 'object') return `${bed.x}, ${bed.y}, ${bed.z}`;
  return String(bed);
}

function botLinks(current, base) {
  return `<div class="chips">${botNames().map((name) => `<a class="chip${name === current ? ' is-active' : ''}" href="#/${base}/${encodeURIComponent(name)}">${esc(name)}</a>`).join('')}</div>`;
}

function selectBots(id, label = 'Bot') {
  return `<div class="field"><label class="field-label" for="${id}">${esc(label)}</label><select class="select" id="${id}">${botNames().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select></div>`;
}

function actionButton(label, line, iconName, { danger = false, confirmTitle = '', confirmMessage = '' } = {}) {
  return `<button class="button button--sm${danger ? ' button--danger-ghost' : ''}" type="button" data-command="${esc(line)}"${danger ? ` data-danger="true" data-confirm-title="${esc(confirmTitle)}" data-confirm-message="${esc(confirmMessage)}"` : ''}>${icon(iconName)}${esc(label)}</button>`;
}

let survivalTarget = '';

const SURVIVAL_FEATURES = [
  ['eat', 'Auto eat', 'Eats before hunger becomes dangerous.'],
  ['healing', 'Emergency healing', 'Uses golden apples when health is critical.'],
  ['armour', 'Auto armour', 'Equips better armour pieces from the inventory.'],
  ['tools', 'Auto tools', 'Checks for a usable pickaxe, axe and sword.'],
  ['crafting', 'Crafting', 'Crafts a replacement tool when materials exist.'],
  ['shield', 'Shield', 'Raises a shield when badly hurt.']
];

export const survivalPage = {
  title: 'Survival',
  render() {
    const rows = perBot('survival');
    const avgHealth = rows.length ? sum(rows, (row) => row.health) / rows.length : 0;
    const avgFood = rows.length ? sum(rows, (row) => row.food) / rows.length : 0;
    const hungry = rows.filter((row) => row.food <= 10 || row.needsFood);
    const foodCount = sum(rows, (row) => row.foodCount || 0);
    const risky = rows.filter((row) => row.inLava || row.onFire || row.health <= 8);
    const routineTarget = rows.find((row) => row.bot === survivalTarget) || rows[0] || null;
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Survival', description: 'Health, hunger, gear and environmental safety for every bot. Values come from the survival action status.',
          actions: `<button class="button" type="button" data-fleet-command="eat">${icon('heart')} Feed fleet</button><a class="button button--primary" href="#/bots">${icon('users')} Fleet</a>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Average health', value: `${avgHealth.toFixed(1)}<small>/20</small>`, iconName: 'heart', tone: avgHealth >= 16 ? 'success' : avgHealth >= 10 ? 'warning' : 'danger', progressValue: avgHealth, progressMax: 20 })}
          ${statCard({ label: 'Average food', value: `${avgFood.toFixed(1)}<small>/20</small>`, iconName: 'sprout', tone: avgFood >= 16 ? 'success' : avgFood >= 10 ? 'warning' : 'danger', progressValue: avgFood, progressMax: 20 })}
          ${statCard({ label: 'Needs feeding', value: num(hungry.length), iconName: 'alert', tone: hungry.length ? 'warning' : 'success', context: hungry.length ? hungry.map((row) => row.bot).join(', ') : 'All bots above the food threshold' })}
          ${statCard({ label: 'Food stocks', value: num(foodCount), iconName: 'package', tone: 'info', context: 'Total edible items across the fleet' })}
          ${statCard({ label: 'Environmental risk', value: num(risky.length), iconName: 'flame', tone: risky.length ? 'danger' : 'success', context: risky.length ? risky.map((row) => row.bot).join(', ') : 'No lava, fire or critical health' })}
        </div>
        ${risky.length ? `<div class="callout callout--danger">${icon('alert')}<div><strong>Immediate risk.</strong> ${esc(risky.map((row) => `${row.bot}${row.inLava ? ' in lava' : row.onFire ? ' on fire' : ` at health ${row.health}`}`).join(' · '))}</div></div>` : ''}
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('heart')} Fleet vitals</div><span class="tiny muted">${rows.length} bots reporting</span></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Bot</th><th>Health</th><th>Food</th><th>Saturation</th><th>Armour</th><th>Food stock</th><th>Best food</th><th>Pickaxe</th><th>Environment</th><th>Actions</th></tr></thead>
              <tbody>${rows.length ? rows.map((row) => `<tr>
                <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}/survival">${esc(row.bot)}</a></td>
                <td>${miniVital(row.health, 20, healthTone(row.health))}</td>
                <td>${miniVital(row.food, 20, healthTone(row.food))}</td>
                <td class="mono">${row.saturation}</td>
                <td class="mono">${row.armour}/20</td>
                <td class="mono">${num(row.foodCount)}</td>
                <td class="tiny">${esc(row.bestFood ? humanize(row.bestFood.name) : '—')}</td>
                <td class="tiny">${esc(row.pickaxe ? humanize(row.pickaxe.name) : '—')}</td>
                <td>${row.inLava ? badge('Lava', 'danger') : row.onFire ? badge('Fire', 'danger') : row.inWater ? badge('Water', 'info') : badge('Clear', 'ok')}</td>
                <td>${actionButton('Eat', `eat ${row.bot}`, 'heart')}</td>
              </tr>`).join('') : `<tr><td colspan="10">${emptyState('No survival status', 'The survival action has not reported yet.', 'heart')}</td></tr>`}</tbody>
            </table>
          </div>
        </section>
        <div class="grid grid--2" style="margin-top:16px">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('sliders')} Automatic routines</div>${routineTarget ? badge(routineTarget.bot, 'outline') : ''}</div>
            <div class="card-body">
              ${routineTarget ? `
                <div class="field" style="margin-bottom:12px">
                  <label class="field-label" for="survival-target">Apply to bot</label>
                  <select class="select" id="survival-target" data-survival-target>${rows.map((row) => `<option value="${esc(row.bot)}"${row.bot === routineTarget.bot ? ' selected' : ''}>${esc(row.bot)}</option>`).join('')}</select>
                </div>
                <div class="toggle-list">
                  ${SURVIVAL_FEATURES.map(([key, label, description]) => {
                    const enabled = routineTarget.features ? Boolean(routineTarget.features[key]) : true;
                    return `<div class="toggle-row">
                      <span class="toggle-icon">${icon(enabled ? 'check' : 'x')}</span>
                      <div><div class="toggle-label">${esc(label)}</div><div class="toggle-desc">${esc(description)}</div></div>
                      <button class="switch${enabled ? ' is-on' : ''}" type="button" role="switch" aria-checked="${enabled}" aria-label="${esc(label)} for ${esc(routineTarget.bot)}" data-command="survival ${esc(routineTarget.bot)} ${key} ${enabled ? 'off' : 'on'}" data-success-title="${esc(label)} ${enabled ? 'disabled' : 'enabled'}"><span aria-hidden="true"></span></button>
                    </div>`;
                  }).join('')}
                  <div class="toggle-row">
                    <span class="toggle-icon">${icon('shield')}</span>
                    <div><div class="toggle-label">Environmental safety</div><div class="toggle-desc">Lava, fire and fall clutches stay armed at all times.</div></div>
                    <span class="badge badge--ok">Always on</span>
                  </div>
                </div>
                <p class="tiny muted" style="margin:10px 0 0">Toggles call the <span class="mono">survival</span> command and take effect on the next autonomy tick. Environmental safety cannot be disabled.</p>` : `<div class="muted small">No survival routine status is reported yet.</div>`}
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('trending-up')} Counters</div></div>
            <div class="card-body">
              ${rows.length ? `<div class="table-wrap"><table class="table table--compact"><thead><tr><th>Bot</th><th>Eaten</th><th>Crafted</th><th>Armour</th><th>Clutches</th><th>Emergency heals</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.bot)}</td><td class="mono">${num(row.stats && row.stats.eaten)}</td><td class="mono">${num(row.stats && row.stats.crafted)}</td><td class="mono">${num(row.stats && row.stats.armourEquipped)}</td><td class="mono">${num(row.stats && row.stats.clutches)}</td><td class="mono">${num(row.stats && row.stats.emergencyHeals)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted small">No counters reported.</div>'}
            </div>
          </section>
        </div>
      </div>`;
  },
  mount(root) {
    const select = root.querySelector('[data-survival-target]');
    if (select) select.addEventListener('change', () => {
      survivalTarget = select.value;
      document.dispatchEvent(new CustomEvent('app:rerender'));
    });
  }
};

function miniVital(value, max, tone) {
  const percent = clamp((Number(value) || 0) / max * 100, 0, 100);
  return `<div style="min-width:82px"><div class="row" style="justify-content:space-between"><span class="mono">${value ?? '—'}</span><span class="tiny muted">${max}</span></div><div class="progress progress--sm"><div class="progress-bar progress-bar--${tone}" style="width:${percent}%"></div></div></div>`;
}

export const combatPage = {
  title: 'Combat',
  render() {
    const rows = perBot('combat');
    const pvp = (state.snapshot && state.snapshot.diagnostics && state.snapshot.diagnostics.config && state.snapshot.diagnostics.config.pvp) || false;
    const threats = sum(rows, (row) => row.threats || 0);
    const kills = sum(rows, (row) => (row.stats && row.stats.kills) || 0);
    const attacks = sum(rows, (row) => (row.stats && row.stats.attacks) || 0);
    const retreats = sum(rows, (row) => (row.stats && row.stats.retreats) || 0);
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Combat', description: 'PVE defence and PVP posture reported by each bot’s combat action. Statistics are lifetime counters from the running process.',
          actions: `<button class="button button--danger" type="button" data-fleet-command="defend" data-danger="true" data-confirm-title="Engage defence" data-confirm-message="Order every bot to defend against nearby hostiles?">${icon('shield')} Defend all</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Current threats', value: num(threats), iconName: 'alert', tone: threats ? 'danger' : 'success', context: threats ? 'Hostiles within detection range' : 'No hostiles detected' })}
          ${statCard({ label: 'Kills', value: num(kills), iconName: 'skull', tone: 'neutral', context: 'Lifetime kills in this runtime' })}
          ${statCard({ label: 'Attacks', value: num(attacks), iconName: 'sword', tone: 'neutral', context: `${num(retreats)} retreats recorded` })}
          ${statCard({ label: 'PVP', value: pvp ? 'Enabled' : 'Disabled', iconName: 'users', tone: pvp ? 'warning' : 'info', context: pvp ? 'Configured for player combat' : 'PVE defence only' })}
        </div>
        <div class="grid grid--2">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('sword')} PVE · hostile defence</div>${badge(threats ? 'Active threats' : 'Clear', threats ? 'danger' : 'ok', { dot: true })}</div>
            <div class="card-body">
              ${rows.length ? rows.map((row) => `<div class="combat-row">
                <div><strong>${esc(row.bot)}</strong><div class="tiny muted">${esc(row.nearestThreat ? `Nearest ${row.nearestThreat.name || row.nearestThreat.type || 'hostile'} · ${row.nearestThreat.distance ?? '?'}m` : 'No threat in range')}</div></div>
                <div class="row gap-2">${badge(`${row.threats} threats`, row.threats ? 'danger' : 'ok')}${row.shield ? badge('Shield', 'info') : badge('No shield', 'neutral')}</div>
                ${actionButton('Defend', `defend ${row.bot}`, 'shield', { danger: true, confirmTitle: 'Engage defence', confirmMessage: `Send ${row.bot} to defend?` })}
              </div>`).join('') : `<div class="muted small">No combat status reported.</div>`}
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('users')} PVP · player combat</div>${badge(pvp ? 'Enabled' : 'Disabled', pvp ? 'warning' : 'neutral')}</div>
            <div class="card-body">
              <div class="callout callout--${pvp ? 'warn' : 'info'}">${icon('shield')}<div>${pvp ? 'PVP is enabled in configuration. Aggressive player targeting still requires an explicit operator command.' : 'PVP is disabled in configuration. Bots only defend against hostile mobs and never attack players.'}</div></div>
              <div class="table-wrap" style="margin-top:12px"><table class="table table--compact"><thead><tr><th>Bot</th><th>PVP flag</th><th>Shield</th><th>Sword</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.bot)}</td><td>${row.pvpEnabled ? badge('Enabled', 'warning') : badge('Disabled', 'neutral')}</td><td>${row.shield ? 'Yes' : 'No'}</td><td class="tiny">${esc(row.sword ? row.sword.name : '—')}</td></tr>`).join('')}</tbody></table></div>
              <div class="divider"></div>
              <div class="tiny muted" style="margin-bottom:6px">Posture controls</div>
              ${kvRows([
                ['PVE defence', 'Always armed for hostile mobs'],
                ['Auto-defence', 'Backend combat routine; no API toggle'],
                ['PVP targeting', pvp ? 'Enabled by configuration' : 'Disabled by configuration'],
                ['Retreat threshold', 'Configured in src/config.js; not exposed at runtime'],
                ['Team assignments', 'Coordinator dispatches defenders automatically']
              ])}
              <p class="tiny muted" style="margin:8px 0 0">These are reported as read-only because the backend does not expose live combat configuration. No disabled control pretends to change it.</p>
            </div>
          </section>
        </div>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('bar-chart')} Combat detail</div><span class="tiny muted">Lifetime counters</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Bot</th><th>Health</th><th>Sword</th><th>Threats</th><th>Nearest</th><th>Attacks</th><th>Kills</th><th>Retreats</th><th>Assessments</th><th>Last action</th></tr></thead>
            <tbody>${rows.length ? rows.map((row) => `<tr>
              <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}/combat">${esc(row.bot)}</a></td>
              <td>${miniVital(row.health, 20, healthTone(row.health))}</td>
              <td class="tiny">${esc(row.sword ? `${humanize(row.sword.name)} · T${row.sword.tier}` : '—')}</td>
              <td class="mono">${num(row.threats)}</td>
              <td class="tiny">${esc(row.nearestThreat ? (row.nearestThreat.name || row.nearestThreat.type || 'hostile') : '—')}</td>
              <td class="mono">${num(row.stats && row.stats.attacks)}</td>
              <td class="mono">${num(row.stats && row.stats.kills)}</td>
              <td class="mono">${num(row.stats && row.stats.retreats)}</td>
              <td class="mono">${num(row.stats && row.stats.threatAssessments)}</td>
              <td class="tiny">${esc(row.lastAction || '—')}</td>
            </tr>`).join('') : `<tr><td colspan="10">${emptyState('No combat data', 'Combat status will appear once bots are live.', 'sword')}</td></tr>`}</tbody>
          </table></div>
        </section>
        <div class="callout callout--info">${icon('info')}<div><strong>Retreat thresholds</strong> are defined in the backend combat configuration and are enforced automatically. They are not exposed as runtime-tunable values by the API, so no threshold controls are shown.</div></div>
      </div>`;
  }
};

export const inventoryPage = {
  title: 'Inventory',
  render({ params = [] } = {}) {
    const names = botNames();
    const name = params[0] && names.includes(params[0]) ? params[0] : names[0];
    if (!name) return `<div class="page">${emptyState('No bots', 'The runtime has not reported a roster.', 'package')}</div>`;
    const summary = inventorySummary(name);
    const data = ledger();
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Inventory', description: 'Per-bot inventory, fleet stock ledger and reservations. Counts are read straight from the adapter and resource ledger.',
          actions: `<a class="button" href="#/team">${icon('users')} Team ledger</a><button class="button button--primary" type="button" data-command-palette>${icon('terminal')} Command</button>`
        })}
        <div class="page-subbar">${botLinks(name, 'inventory')}<span class="grow"></span><span class="badge badge--outline">${esc(name)}</span></div>
        <div class="grid grid--stats">
          ${statCard({ label: 'Stacks used', value: num(summary.slots), iconName: 'layers', tone: summary.full ? 'danger' : 'neutral', context: summary.full ? 'Inventory reported full' : 'Space available' })}
          ${statCard({ label: 'Total items', value: num(summary.total), iconName: 'package', tone: 'info', context: `${summary.items.length} distinct item types` })}
          ${statCard({ label: 'Food', value: num(summary.food), iconName: 'sprout', tone: 'success', context: 'Edible items counted by the inventory action' })}
          ${statCard({ label: 'Blocks', value: num(summary.blocks), iconName: 'cube', tone: 'neutral', context: `${num(summary.tools.length)} tool stacks` })}
          ${statCard({ label: 'Fleet availability', value: num(sum(data.rows, (row) => row.available)), iconName: 'box', tone: 'accent', context: `${data.rows.length} tracked item types` })}
        </div>
        <div class="grid grid--main-side">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('package')} ${esc(name)} inventory</div><a class="tiny muted" href="#/bots/${encodeURIComponent(name)}/inventory">Open in profile</a></div>
            <div class="card-body">${inventoryPanel(name)}</div>
          </section>
          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('shield')} Protected items</div></div>
              <div class="card-body">
                <div class="callout callout--info">${icon('info')}<div>The ledger marks tools, food reserves and build materials as protected before transfers and drops. Protection is enforced in <span class="mono">src/team/resourceLedger.js</span>; the snapshot exposes reservations, not the per-bot protected list.</div></div>
                ${data.reservations.length ? `<div class="divider"></div><div class="tiny muted">${data.reservations.length} active reservation${data.reservations.length === 1 ? '' : 's'}</div>` : ''}
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('alert')} Shortages</div>${badge(`${data.shortages.length}`, data.shortages.length ? 'warn' : 'ok')}</div>
              <div class="card-body card-body--tight">
                ${data.shortages.length ? data.shortages.slice(0, 8).map((shortage) => `<div class="list-item"><span class="status-dot status-dot--warn"></span><div class="list-main"><div class="list-title">${esc(humanize(shortage.item))}</div><div class="list-sub">short by ${num(shortage.shortfall ?? shortage.missing ?? shortage.amount ?? 0)}</div></div></div>`).join('') : '<div class="list-item">' + icon('check-circle') + '<div class="list-main"><div class="list-title">No shortages</div><div class="list-sub">All reserve targets are met.</div></div></div>'}
              </div>
            </section>
          </aside>
        </div>

        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('box')} Fleet resource ledger</div><span class="tiny muted">${data.rows.length} items</span></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Item</th><th>Total</th><th>Available</th><th>Reserved</th><th>Target</th><th>Status</th><th>Coverage</th></tr></thead>
              <tbody>${data.rows.length ? data.rows.map((row) => `<tr>
                <td>${esc(humanize(row.item))}</td>
                <td class="mono">${num(row.total)}</td>
                <td class="mono">${num(row.available)}</td>
                <td class="mono">${num(row.reserved)}</td>
                <td class="mono">${row.target ? num(row.target) : '—'}</td>
                <td>${badge(row.status, row.status === 'OK' ? 'ok' : row.status === 'DEFICIT' ? 'warn' : row.status === 'CRITICAL' ? 'danger' : 'neutral')}</td>
                <td style="min-width:110px">${row.target ? progress(clamp((row.available / row.target) * 100, 0, 100), 100, { sm: true, tone: row.available >= row.target ? 'ok' : 'warn' }) : '<span class="muted tiny">tracked only</span>'}</td>
              </tr>`).join('') : `<tr><td colspan="7">${emptyState('Ledger empty', 'No resource rows have been reported.', 'box')}</td></tr>`}</tbody>
            </table>
          </div>
        </section>

        <div class="grid grid--2" style="margin-top:16px">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('lock')} Active reservations</div></div>
            <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Item</th><th>Amount</th><th>Purpose</th><th>Owner</th></tr></thead><tbody>${data.reservations.length ? data.reservations.map((reservation) => `<tr><td>${esc(humanize(reservation.item || '—'))}</td><td class="mono">${num(reservation.amount)}</td><td class="tiny">${esc(reservation.purpose || '—')}</td><td class="tiny">${esc(reservation.owner || '—')}</td></tr>`).join('') : `<tr><td colspan="4" class="muted small">No active reservations.</td></tr>`}</tbody></table></div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('database')} Storages</div></div>
            <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Storage</th><th>Items</th><th>Position</th><th>Updated</th></tr></thead><tbody>${data.storages.length ? data.storages.map((store) => `<tr><td class="mono tiny">${esc(store.id || '—')}</td><td class="mono">${num(Object.keys(store.counts || {}).length)}</td><td class="mono tiny">${store.position ? `${store.position.x}, ${store.position.y}, ${store.position.z}` : '—'}</td><td class="tiny">${store.updatedAt ? esc(timeAgo(store.updatedAt)) : '—'}</td></tr>`).join('') : `<tr><td colspan="4" class="muted small">No storage locations reported.</td></tr>`}</tbody></table></div>
          </section>
        </div>
      </div>`;
  },
  mount(root, params = []) {
    const names = botNames();
    const name = params[0] && names.includes(params[0]) ? params[0] : names[0];
    if (name) mountInventory(root, name);
  },
  update(root, params = []) {
    const names = botNames();
    const name = params[0] && names.includes(params[0]) ? params[0] : names[0];
    if (name) applyInventoryFilter(root, name);
  }
};

export const miningPage = {
  title: 'Mining',
  render() {
    const rows = perBot('mining');
    const ores = new Set();
    for (const row of rows) for (const ore of row.nearbyOres || []) ores.add(ore.name);
    const mined = sum(rows, (row) => row.oresMined || 0);
    const nearby = sum(rows, (row) => (row.nearbyOres || []).length);
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Mining', description: 'Scan nearby ores and mine them with the bot’s best pickaxe. Targets come from a live world scan, not a static list.',
          actions: `<button class="button button--primary" type="button" data-command="mine">${icon('pickaxe')} Mine leader</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Ores mined', value: num(mined), iconName: 'pickaxe', tone: 'accent', context: 'Lifetime counter across the fleet' })}
          ${statCard({ label: 'Nearby ores', value: num(nearby), iconName: 'gem', tone: 'info', context: 'Within each bot’s scan radius' })}
          ${statCard({ label: 'Bots scanning', value: num(rows.length), iconName: 'radar', tone: 'neutral', context: 'Mining action status sources' })}
          ${statCard({ label: 'Best pickaxe', value: esc(bestTier(rows)), iconName: 'wrench', tone: 'success', context: 'Highest tier reported; durability is not exposed by the adapter' })}
        </div>
        <div class="grid grid--main-side">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('target')} Mine nearby</div></div>
            <div class="card-body">
              <form data-mining-form class="form-grid form-grid--3">
                ${selectBots('mine-bot')}
                <div class="field"><label class="field-label" for="mine-ore">Ore target</label>
                  <select class="select" id="mine-ore"><option value="">Nearest ores (auto)</option>${[...ores].sort().map((ore) => `<option value="${esc(ore)}">${esc(humanize(ore))}</option>`).join('')}</select>
                </div>
                <div class="field"><label class="field-label" for="mine-radius">Scan radius</label><input class="input" id="mine-radius" type="number" value="24" min="4" max="32" readonly title="Backend mineNearby uses a 24 block radius"></div>
                <div class="field field--full"><div class="tiny muted">The backend scans a 24-block radius and mines up to 8 ores per invocation. Selecting a specific ore requires it to be present in the live scan.</div></div>
                <div class="field field--full"><button class="button button--primary" type="submit">${icon('pickaxe')} Start mining</button></div>
              </form>
            </div>
          </section>
          <aside class="card">
            <div class="card-header"><div class="card-title">${icon('gem')} Detected ores</div></div>
            <div class="card-body card-body--tight">
              ${ores.size ? [...ores].sort().slice(0, 14).map((ore) => `<div class="list-item"><span class="list-icon">${icon('gem')}</span><div class="list-main"><div class="list-title">${esc(humanize(ore))}</div><div class="list-sub">in live scan</div></div></div>`).join('') : '<div class="muted small" style="padding:8px">No ores detected in the current scans.</div>'}
            </div>
          </aside>
        </div>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('pickaxe')} Mining status</div></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Bot</th><th>Pickaxe</th><th>Position</th><th>Ores mined</th><th>Nearby</th><th>Top ores</th><th>Counters</th><th>Actions</th></tr></thead>
              <tbody>${rows.length ? rows.map((row) => `<tr>
                <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}">${esc(row.bot)}</a></td>
                <td class="tiny">${esc(row.pickaxe ? humanize(row.pickaxe.name || row.pickaxe) : '—')}</td>
                <td class="mono tiny">${row.position ? `${row.position.x}, ${row.position.y}, ${row.position.z}` : '—'}</td>
                <td class="mono">${num(row.oresMined)}</td>
                <td class="mono">${num((row.nearbyOres || []).length)}</td>
                <td class="tiny">${esc((row.nearbyOres || []).slice(0, 3).map((ore) => ore.name).join(', ') || '—')}</td>
                <td class="tiny">${Object.entries(row.stats || {}).slice(0, 3).map(([key, value]) => `${esc(humanize(key))} ${num(value)}`).join(' · ') || '—'}</td>
                <td>${actionButton('Mine', `mine ${row.bot}`, 'pickaxe')}</td>
              </tr>`).join('') : `<tr><td colspan="8">${emptyState('No mining status', 'Mining telemetry will appear when the action starts reporting.', 'pickaxe')}</td></tr>`}</tbody>
            </table>
          </div>
        </section>
        ${miningLogs()}
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-mining-form]');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const bot = form.querySelector('#mine-bot').value;
      const ore = form.querySelector('#mine-ore').value;
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(`mine ${bot}${ore ? ` ${ore}` : ''}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
      } catch (err) {
        toast({ type: 'error', title: 'Mining failed', message: err.message, duration: 8000 });
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
};

function bestTier(rows) {
  let best = null;
  for (const row of rows) {
    const tier = row.pickaxe && (row.pickaxe.tier ?? row.pickaxe);
    if (typeof tier === 'number' && (!best || tier > best)) best = tier;
  }
  return best === null ? '—' : `Tier ${best}`;
}

function miningLogs() {
  const logs = state.logs.filter((log) => log.scope === 'mining' || /mine| ore/i.test(log.msg)).slice(-8).reverse();
  if (!logs.length) return '';
  return `<section class="card" style="margin-top:16px"><div class="card-header"><div class="card-title">${icon('history')} Recent mining activity</div></div><div class="activity-list">${logs.map((log) => `<div class="activity-item"><span class="activity-icon">${icon('pickaxe')}</span><div class="activity-main"><div>${esc(log.msg)}</div><div class="mono">${esc(log.scope)} · ${esc(log.level)}</div></div></div>`).join('')}</div></section>`;
}

let excavationPreview = null;
let excavationError = null;

export const excavationPage = {
  title: 'Excavation',
  render() {
    const excavation = (state.snapshot && state.snapshot.excavation) || {};
    const status = excavation.status || {};
    const active = status && status.ok ? (status.excavation ? [status.excavation] : status.active || []) : [];
    const previews = excavation.previews || [];
    const history = excavation.history || [];
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Excavation', description: 'Preview volumes, then authorise and run protected digging work. Destructive starts require explicit confirmation.',
          actions: `<button class="button button--primary" type="button" data-command-palette>${icon('terminal')} Command</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Active jobs', value: num(active.length), iconName: 'shovel', tone: active.length ? 'accent' : 'neutral', context: `${num(previews.length)} stored previews` })}
          ${statCard({ label: 'History', value: num(history.length), iconName: 'history', tone: 'neutral', context: 'Recent excavation events in this runtime' })}
          ${statCard({ label: 'Last preview volume', value: excavationPreview && excavationPreview.plan ? num(excavationPreview.plan.volume) : (previews.length ? num(previews[previews.length - 1].volume) : '—'), iconName: 'cube', tone: 'info', context: 'Blocks in the most recent preview' })}
          ${statCard({ label: 'Warnings', value: num(sum(previews, (preview) => (preview.warnings || []).length)), iconName: 'alert', tone: 'warning', context: 'Protection and safety warnings raised by previews' })}
        </div>
        ${excavationError ? `<div class="callout callout--danger">${icon('alert-circle')}<div>${esc(excavationError)}</div></div>` : ''}
        <div class="excavation-layout">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('crosshair')} New excavation</div><span class="badge badge--outline">Preview first</span></div>
            <div class="card-body">
              <form data-excavation-form>
                <div class="form-grid form-grid--3">
                  <div class="field"><label class="field-label" for="exc-mode">Mode</label>
                    <select class="select" id="exc-mode" name="mode">
                      <option value="box">Box</option><option value="radius">Radius</option><option value="trench">Trench</option><option value="flatten">Flatten</option>
                    </select>
                  </div>
                  <div class="field"><label class="field-label" for="exc-x">X</label><input class="input" id="exc-x" name="x" type="number" value="0" required></div>
                  <div class="field"><label class="field-label" for="exc-y">Y</label><input class="input" id="exc-y" name="y" type="number" value="64" required></div>
                  <div class="field"><label class="field-label" for="exc-z">Z</label><input class="input" id="exc-z" name="z" type="number" value="0" required></div>
                  <div class="field" data-mode-group="box trench flatten"><label class="field-label" for="exc-width">Width</label><input class="input" id="exc-width" name="width" type="number" min="1" max="128" value="8"></div>
                  <div class="field" data-mode-group="box trench flatten"><label class="field-label" for="exc-length">Length</label><input class="input" id="exc-length" name="length" type="number" min="1" max="128" value="8"></div>
                  <div class="field" data-mode-group="box radius trench"><label class="field-label" for="exc-depth">Depth</label><input class="input" id="exc-depth" name="depth" type="number" min="1" max="120" value="4"></div>
                  <div class="field" data-mode-group="radius"><label class="field-label" for="exc-radius">Radius</label><input class="input" id="exc-radius" name="radius" type="number" min="1" max="64" value="8"></div>
                  <div class="field field--full"><label class="checkbox"><input type="checkbox" id="exc-authorized" name="authorized"> <span>Authorised dig (bypass protected-region refusal)</span></label></div>
                </div>
                <div class="row gap-2" style="margin-top:14px">
                  <button class="button button--primary" type="submit">${icon('eye')} Generate preview</button>
                  <span class="tiny muted">Preview does not modify the world.</span>
                </div>
              </form>
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('eye')} Preview</div>${excavationPreview ? badge('Ready', 'ok') : badge('None', 'neutral')}</div>
            <div class="card-body" data-preview-panel>${excavationPreview ? renderPreview(excavationPreview) : emptyState('No preview yet', 'Generate a preview to see its volume, bounds and warnings before starting.', 'eye')}</div>
          </section>
        </div>

        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('play')} Active excavations</div><span class="tiny muted">${active.length} running</span></div>
          <div class="card-body">
            ${active.length ? active.map((job) => `<div class="excavation-row">
              <div class="excavation-main">
                <div><strong>${esc(job.id)}</strong> ${badge(job.status || 'ACTIVE', job.paused ? 'warn' : 'accent')} ${job.mode ? badge(job.mode, 'neutral') : ''}</div>
                <div class="tiny muted">${job.bounds ? esc(boundsText(job.bounds)) : ''} ${job.volume ? `· ${num(job.volume)} blocks` : ''} ${job.assignments ? `· ${num(job.assignments.length)} assignments` : ''}</div>
              </div>
              <div class="row gap-2">
                <button class="button button--sm" type="button" data-excavate-action="pause" data-id="${esc(job.id)}">${icon('pause')} Pause</button>
                <button class="button button--sm" type="button" data-excavate-action="resume" data-id="${esc(job.id)}">${icon('play')} Resume</button>
                <button class="button button--sm button--danger-ghost" type="button" data-excavate-action="stop" data-id="${esc(job.id)}">${icon('square')} Stop</button>
              </div>
              ${job.progressRatio !== undefined ? progress(job.progressRatio * 100, 100, { sm: true, tone: 'accent', label: 'Excavation progress' }) : ''}
            </div>`).join('') : emptyState('No active excavation', 'No digging job is running right now.', 'shovel')}
          </div>
        </section>

        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('layers')} Stored previews</div><span class="tiny muted">${previews.length}</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Preview</th><th>Mode</th><th>Volume</th><th>Bounds</th><th>Warnings</th><th>Authorisation</th><th></th></tr></thead>
            <tbody>${previews.length ? previews.map((preview) => `<tr>
              <td class="mono tiny">${esc(preview.previewId)}</td>
              <td>${badge(preview.mode, 'neutral')}</td>
              <td class="mono">${num(preview.volume)}</td>
              <td class="mono tiny">${esc(boundsText(preview.bounds))}</td>
              <td class="tiny">${(preview.warnings || []).length ? esc((preview.warnings || []).map(warningText).join('; ')) : '—'}</td>
              <td>${preview.authorizationRequired ? badge('Required', 'warn') : badge('Not required', 'ok')}</td>
              <td><button class="button button--sm" type="button" data-excavate-start="${esc(preview.previewId)}">Start</button></td>
            </tr>`).join('') : `<tr><td colspan="7">${emptyState('No stored previews', 'Previews created through the form or CLI appear here.', 'eye')}</td></tr>`}</tbody>
          </table></div>
        </section>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('history')} History</div></div>
          <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Event</th><th>Mode</th><th>Volume</th><th>Status</th><th>When</th></tr></thead><tbody>${history.length ? history.slice().reverse().map((event) => `<tr><td class="mono tiny">${esc(event.id || event.event || '—')}</td><td>${esc(event.mode || '—')}</td><td class="mono">${num(event.volume)}</td><td>${esc(event.status || event.state || '—')}</td><td class="tiny">${esc(event.at || event.stoppedAt || event.createdAt || '—')}</td></tr>`).join('') : `<tr><td colspan="5" class="muted small">No excavation history in this runtime.</td></tr>`}</tbody></table></div>
        </section>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-excavation-form]');
    if (form) {
      const mode = form.querySelector('#exc-mode');
      const applyMode = () => {
        for (const group of form.querySelectorAll('[data-mode-group]')) {
          group.hidden = !group.dataset.modeGroup.split(' ').includes(mode.value);
        }
      };
      mode.addEventListener('change', applyMode);
      applyMode();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"]');
        const value = (id) => form.querySelector(id).value;
        const modeValue = mode.value;
        let line = `excavate preview ${modeValue} ${value('#exc-x')} ${value('#exc-y')} ${value('#exc-z')}`;
        if (modeValue === 'box') line += ` ${value('#exc-width')} ${value('#exc-length')} ${value('#exc-depth')}`;
        if (modeValue === 'radius') line += ` ${value('#exc-radius')} ${value('#exc-depth')}`;
        if (modeValue === 'trench') line += ` ${value('#exc-length')} ${value('#exc-width')} ${value('#exc-depth')}`;
        if (modeValue === 'flatten') line += ` ${value('#exc-width')} ${value('#exc-length')}`;
        if (form.querySelector('#exc-authorized').checked) line += ' authorized';
        setButtonLoading(submit, true);
        excavationError = null;
        try {
          const result = await runCommand(line);
          const payload = payloadOf(result);
          if (payload && payload.ok) {
            excavationPreview = payload;
            toast({ type: 'success', title: 'Preview generated', message: payload.text ? payload.text.split('\n')[0] : `Preview ${payload.previewId} ready.` });
            document.dispatchEvent(new CustomEvent('app:rerender'));
          } else {
            excavationError = (payload && payload.error) || 'Preview failed.';
            toast({ type: 'error', title: 'Preview failed', message: excavationError });
            document.dispatchEvent(new CustomEvent('app:rerender'));
          }
        } catch (err) {
          excavationError = err.message;
          toast({ type: 'error', title: 'Preview failed', message: err.message });
          document.dispatchEvent(new CustomEvent('app:rerender'));
        } finally {
          setButtonLoading(submit, false);
        }
      });
    }
    const panel = root.querySelector('[data-preview-panel]');
    if (panel) {
      panel.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-start-preview]');
        if (!button) return;
        const previewId = button.dataset.startPreview;
        const ok = await confirmDialog({
          title: 'Start excavation',
          message: `Start digging preview ${previewId}?`,
          confirmLabel: 'Start digging',
          details: 'Excavation removes blocks from the live world. Protected regions are refused unless the preview was authorised.'
        });
        if (!ok) return;
        setButtonLoading(button, true);
        try {
          const result = await runCommand(`excavate start ${previewId}`, { confirm: true });
          const message = resultMessage(result);
          toast({ type: message.type, title: message.title, message: message.message });
          excavationPreview = null;
          document.dispatchEvent(new CustomEvent('app:rerender'));
        } catch (err) {
          toast({ type: 'error', title: 'Start failed', message: err.message });
          setButtonLoading(button, false);
        }
      });
    }
    root.addEventListener('click', async (event) => {
      const start = event.target.closest('[data-excavate-start]');
      if (start) {
        const previewId = start.dataset.excavateStart;
        const ok = await confirmDialog({ title: 'Start excavation', message: `Start digging preview ${previewId}?`, confirmLabel: 'Start digging', details: 'This removes blocks in the live world.' });
        if (!ok) return;
        setButtonLoading(start, true);
        try {
          const result = await runCommand(`excavate start ${previewId}`, { confirm: true });
          const message = resultMessage(result);
          toast({ type: message.type, title: message.title, message: message.message });
          document.dispatchEvent(new CustomEvent('app:rerender'));
        } catch (err) {
          toast({ type: 'error', title: 'Start failed', message: err.message });
          setButtonLoading(start, false);
        }
        return;
      }
      const action = event.target.closest('[data-excavate-action]');
      if (!action) return;
      const kind = action.dataset.excavateAction;
      if (kind === 'stop') {
        const ok = await confirmDialog({ title: 'Stop excavation', message: `Stop excavation ${action.dataset.id}?`, confirmLabel: 'Stop job', details: 'Bots will cease digging immediately. Progress is retained.' });
        if (!ok) return;
      }
      setButtonLoading(action, true);
      try {
        const result = await runCommand(`excavate ${kind} ${action.dataset.id}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
        document.dispatchEvent(new CustomEvent('app:rerender'));
      } catch (err) {
        toast({ type: 'error', title: `${humanize(kind)} failed`, message: err.message });
        setButtonLoading(action, false);
      }
    });
  }
};

function renderPreview(preview) {
  const plan = preview.plan || {};
  return `
    <div class="preview-summary">
      ${kvRows([
        ['Preview ID', esc(preview.previewId || plan.id || '—'), true],
        ['Mode', esc(plan.mode || '—')],
        ['Volume', num(plan.volume ?? 0)],
        ['Regions', num(plan.regions ?? 0)],
        ['Bounds', esc(boundsText(plan.bounds))],
        ['Authorisation', plan.authorizationRequired ? badge('Required', 'warn') : badge('Not required', 'ok')]
      ])}
      ${(plan.warnings || []).length ? `<div class="callout callout--warn" style="margin-top:10px">${icon('alert')}<div>${plan.warnings.map((warning) => esc(warningText(warning))).join('<br>')}</div></div>` : ''}
      <button class="button button--danger" type="button" data-start-preview="${esc(preview.previewId || plan.id)}" style="margin-top:12px">${icon('shovel')} Start this excavation</button>
    </div>`;
}

function warningText(warning) {
  if (typeof warning === 'string') return warning;
  if (!warning) return '';
  return warning.message || warning.reason || warning.text || warning.code || JSON.stringify(warning);
}

function boundsText(bounds) {
  if (!bounds) return '—';
  if (bounds.min && bounds.max) return `${bounds.min.x},${bounds.min.y},${bounds.min.z} → ${bounds.max.x},${bounds.max.y},${bounds.max.z}`;
  return JSON.stringify(bounds);
}

export const fishingPage = {
  title: 'Fishing',
  render() {
    const rows = perBot('fishing');
    const caught = (row) => sum(Object.values(row.caught || {}), (count) => Number(count) || 0);
    const totalCaught = sum(rows, caught);
    const casts = sum(rows, (row) => (row.stats && row.stats.casts) || 0);
    const failed = sum(rows, (row) => (row.stats && row.stats.failed) || 0);
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Fishing',
          description: 'Rod and water checks, casts and real catch counts. A cast is only counted as a catch when the fish appears in the live inventory.',
          actions: `<button class="button button--primary" type="button" data-command="fish all 1">${icon('fish')} Fish all</button><button class="button" type="button" data-command="fish stop all">${icon('square')} Stop all</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Fish caught', value: num(totalCaught), iconName: 'fish', tone: totalCaught ? 'success' : 'neutral', context: 'Inventory-confirmed catches' })}
          ${statCard({ label: 'Casts', value: num(casts), iconName: 'target', tone: 'accent', context: 'Lifetime cast attempts' })}
          ${statCard({ label: 'Empty casts', value: num(failed), iconName: 'alert', tone: failed ? 'warning' : 'neutral', context: 'No catch, no water or no rod' })}
          ${statCard({ label: 'Rods ready', value: `${rows.filter((row) => row.rod).length}<small> / ${rows.length || 5}</small>`, iconName: 'package', tone: rows.some((row) => row.rod) ? 'info' : 'warning', context: 'Bots holding a fishing rod' })}
        </div>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('fish')} Shore status</div><span class="tiny muted">${rows.length} bots</span></div>
          <div class="card-body">
            <form data-fish-form class="row gap-2" style="align-items:flex-end;flex-wrap:wrap">
              <div class="field"><label class="field-label" for="fish-bot">Bot</label><select class="select" id="fish-bot">${botNames().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select></div>
              <div class="field"><label class="field-label" for="fish-casts">Casts</label><input class="input" id="fish-casts" type="number" min="1" max="3" value="1"></div>
              <button class="button button--primary" type="submit">${icon('fish')} Cast</button>
            </form>
            <div class="divider"></div>
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Bot</th><th>Rod</th><th>Water blocks</th><th>Nearest water</th><th>Casts</th><th>Caught</th><th>Fish</th><th>State</th><th>Actions</th></tr></thead>
              <tbody>${rows.length ? rows.map((row) => {
                const fish = Object.entries(row.caught || {});
                return `<tr>
                  <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}">${esc(row.bot)}</a></td>
                  <td>${row.rod ? badge('HELD', 'ok') : badge('MISSING', 'warn')}</td>
                  <td class="mono">${num(row.water)}</td>
                  <td class="mono tiny">${row.nearestWater ? `${row.nearestWater.x}, ${row.nearestWater.y}, ${row.nearestWater.z}${row.nearestWater.distance !== undefined ? ` · ${row.nearestWater.distance} m` : ''}` : '—'}</td>
                  <td class="mono">${num(row.stats && row.stats.casts)}</td>
                  <td class="mono">${num(caught(row))}</td>
                  <td class="tiny">${fish.length ? fish.map(([name, count]) => `${esc(humanize(name))} ${num(count)}`).join(' · ') : '—'}</td>
                  <td>${row.stopped ? badge('STOPPED', 'warn') : row.water ? badge('READY', 'ok') : badge('NO WATER', 'neutral')}</td>
                  <td><div class="row gap-1">${actionButton('Fish', `fish ${row.bot} 1`, 'fish')}${actionButton('Stop', `fish stop ${row.bot}`, 'square', { danger: true, confirmTitle: 'Stop fishing', confirmMessage: `Stop fishing for ${row.bot}?` })}</div></td>
                </tr>`;
              }).join('') : `<tr><td colspan="9">${emptyState('No fishing status', 'The fishing action has not reported yet.', 'fish')}</td></tr>`}</tbody>
            </table></div>
          </div>
        </section>
        <div class="callout callout--info">${icon('info')}<div>Fishing requires a fishing rod and water in range. If either is missing the action reports the exact precondition instead of counting a catch.</div></div>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-fish-form]');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const bot = form.querySelector('#fish-bot').value;
      const casts = clamp(Number(form.querySelector('#fish-casts').value) || 1, 1, 3);
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(`fish ${bot} ${casts}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
      } catch (err) {
        toast({ type: 'error', title: 'Fishing failed', message: err.message, duration: 7000 });
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
};

export const woodcuttingPage = {
  title: 'Woodcutting',
  render() {
    const rows = perBot('woodcutting');
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Woodcutting', description: 'Log stocks, sapling reserves and replanting across the fleet. Each run chops nearby trees and replants where possible.',
          actions: `<button class="button button--primary" type="button" data-fleet-command="chop">${icon('axe')} Chop all</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Logs collected', value: num(sum(rows, (row) => row.logs || 0)), iconName: 'axe', tone: 'accent', context: 'Current log stock across inventories' })}
          ${statCard({ label: 'Saplings', value: num(sum(rows, (row) => row.saplings || 0)), iconName: 'sprout', tone: 'success', context: 'Available for replanting' })}
          ${statCard({ label: 'Trees chopped', value: num(sum(rows, (row) => row.treesChopped || 0)), iconName: 'trees', tone: 'neutral', context: 'Lifetime counter' })}
          ${statCard({ label: 'Replanted', value: num(sum(rows, (row) => row.replanted || 0)), iconName: 'leaf', tone: 'success', context: 'Saplings placed by the action' })}
        </div>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('axe')} Woodcutting status</div><span class="tiny muted">${rows.length} bots</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Bot</th><th>Axe</th><th>Logs</th><th>Saplings</th><th>Reserve target</th><th>Trees chopped</th><th>Replanted</th><th>Counters</th><th>Actions</th></tr></thead>
            <tbody>${rows.length ? rows.map((row) => `<tr>
              <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}">${esc(row.bot)}</a></td>
              <td class="tiny">${esc(row.axe ? humanize(row.axe.name || row.axe) : '—')}</td>
              <td class="mono">${num(row.logs)}</td>
              <td class="mono">${num(row.saplings)}</td>
              <td class="mono">${row.reserveTarget ?? '—'}</td>
              <td class="mono">${num(row.treesChopped)}</td>
              <td class="mono">${num(row.replanted)}</td>
              <td class="tiny">${Object.entries(row.stats || {}).slice(0, 3).map(([key, value]) => `${esc(humanize(key))} ${num(value)}`).join(' · ') || '—'}</td>
              <td>${actionButton('Chop', `chop ${row.bot}`, 'axe')}</td>
            </tr>`).join('') : `<tr><td colspan="9">${emptyState('No woodcutting status', 'The action has not reported yet.', 'axe')}</td></tr>`}</tbody>
          </table></div>
        </section>
        <div class="callout callout--info">${icon('info')}<div>Replanting is attempted automatically for every harvested tree when saplings are available. Sapling counts above come from live inventories.</div></div>
      </div>`;
  }
};

export const farmingPage = {
  title: 'Farming',
  render() {
    const rows = perBot('farming');
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Farming', description: 'Crop plots, seed stocks and animal counts reported by the farming action, per bot.',
          actions: `<button class="button button--primary" type="button" data-fleet-command="farm">${icon('sprout')} Harvest all</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Crops ready', value: num(sum(rows, (row) => (row.crops || []).length)), iconName: 'sprout', tone: 'accent', context: 'Mature crops detected in scans' })}
          ${statCard({ label: 'Seed stocks', value: num(sum(rows, (row) => sum(row.seeds || [], (seed) => seed.count))), iconName: 'package', tone: 'info', context: 'Seeds available for replanting' })}
          ${statCard({ label: 'Animals', value: num(sum(rows, (row) => row.animals || 0)), iconName: 'heart', tone: 'neutral', context: 'Nearby animals reported' })}
          ${statCard({ label: 'Harvested', value: num(sum(rows, (row) => (row.stats && row.stats.harvested) || 0)), iconName: 'wheat', tone: 'success', context: 'Lifetime harvest counter' })}
          ${statCard({ label: 'Replanted', value: num(sum(rows, (row) => (row.stats && row.stats.replanted) || 0)), iconName: 'leaf', tone: 'info', context: 'Successful replants after harvest' })}
        </div>
        <div class="grid grid--2">
          ${rows.length ? rows.map((row) => `<section class="card">
            <div class="card-header"><div class="card-title">${icon('sprout')} ${esc(row.bot)}</div>${badge(`${(row.crops || []).length} crops`, (row.crops || []).length ? 'accent' : 'neutral')}</div>
            <div class="card-body">
              <div class="meta-list">
                <span>${icon('leaf')} ${num(row.cropCount)} crop blocks</span>
                <span>${icon('heart')} ${num(row.animals)} animals</span>
                <span>${icon('map')} ${num((row.farms || []).length)} farms</span>
                <span>${icon('package')} ${num(sum(row.seeds || [], (seed) => seed.count))} seeds</span>
              </div>
              <div class="divider"></div>
              ${(row.seeds || []).length ? `<div class="chips">${row.seeds.map((seed) => `<span class="chip">${esc(humanize(seed.crop))} · ${num(seed.count)}</span>`).join('')}</div>` : '<div class="muted small">No seeds in inventory.</div>'}
              ${(row.crops || []).length ? `<div class="table-wrap" style="margin-top:10px"><table class="table table--compact"><thead><tr><th>Crop</th><th>Position</th><th>Mature</th></tr></thead><tbody>${row.crops.slice(0, 8).map((crop) => `<tr><td>${esc(humanize(crop.name || crop.type || 'crop'))}</td><td class="mono tiny">${crop.position ? `${crop.position.x}, ${crop.position.y}, ${crop.position.z}` : '—'}</td><td>${crop.mature === false ? badge('Growing', 'warn') : badge('Mature', 'ok')}</td></tr>`).join('')}</tbody></table></div>` : ''}
              ${(row.farms || []).length ? `<div class="divider"></div><div class="tiny muted" style="margin-bottom:6px">Harvested plots remembered by this bot</div><div class="table-wrap"><table class="table table--compact"><thead><tr><th>Crop</th><th>Plot position</th><th>Last harvest</th></tr></thead><tbody>${row.farms.map((plot) => `<tr><td>${esc(humanize(plot.crop || 'crop'))}</td><td class="mono tiny">${plot.position ? `${plot.position.x}, ${plot.position.y}, ${plot.position.z}` : '—'}</td><td class="tiny">${plot.at ? esc(timeAgo(plot.at)) : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
              <div class="row gap-2" style="margin-top:10px">${actionButton('Harvest', `farm ${row.bot}`, 'sprout')}<a class="button button--sm" href="#/bots/${encodeURIComponent(row.bot)}/inventory">Inventory</a></div>
            </div>
          </section>`).join('') : `<div class="card">${emptyState('No farming status', 'The farming action has not reported yet.', 'sprout')}</div>`}
        </div>
        <div class="callout callout--info">${icon('info')}<div>Farm plots and animal counts are discovered by live world scans; the dashboard does not invent fixed plots.</div></div>
      </div>`;
  }
};

export const explorationPage = {
  title: 'Exploration',
  render() {
    const rows = perBot('exploration');
    const discoveries = rows.flatMap((row) => (row.discoveries || []).map((discovery) => ({ ...discovery, bot: row.bot })));
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Exploration', description: 'Coordinate-based exploration state. There is deliberately no synthetic map — positions and waypoints are the source of truth.',
          actions: `<button class="button button--primary" type="button" data-fleet-command="explore">${icon('compass')} Explore</button>`
        })}
        <div class="callout callout--info">${icon('map')}<div><strong>Coordinate interface.</strong> The dashboard does not render a world map because the backend exposes waypoints, not terrain tiles. Use the coordinates and the go-to form below.</div></div>
        <div class="grid grid--stats">
          ${statCard({ label: 'Distance travelled', value: num(sum(rows, (row) => (row.stats && row.stats.distance) || 0)), iconName: 'route', tone: 'accent', context: 'Cumulative blocks walked by exploration' })}
          ${statCard({ label: 'Waypoints', value: num(sum(rows, (row) => (row.stats && row.stats.waypoints) || 0)), iconName: 'flag', tone: 'neutral', context: 'Spiral waypoints visited' })}
          ${statCard({ label: 'Discoveries', value: num(discoveries.length), iconName: 'sparkles', tone: 'success', context: 'Recorded points of interest' })}
          ${statCard({ label: 'Night returns', value: num(sum(rows, (row) => (row.stats && row.stats.nightReturns) || 0)), iconName: 'moon', tone: 'info', context: 'Returns home before nightfall' })}
        </div>
        <div class="grid grid--main-side">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('compass')} Exploration state</div></div>
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Bot</th><th>Position</th><th>Home</th><th>Radius</th><th>Waypoint</th><th>Discoveries</th><th>Night</th><th>Distance</th><th>Actions</th></tr></thead>
              <tbody>${rows.length ? rows.map((row) => `<tr>
                <td>${esc(row.bot)}</td>
                <td class="mono tiny">${esc(posText(currentPosition(row.bot)))}</td>
                <td class="mono tiny">${row.home ? `${row.home.x}, ${row.home.y}, ${row.home.z}` : '—'}</td>
                <td class="mono">${num(row.radius)}</td>
                <td class="mono">${num(row.waypointIndex)}</td>
                <td class="mono">${num((row.discoveries || []).length)}</td>
                <td>${row.night ? badge('Night', 'info') : badge('Day', 'neutral')}</td>
                <td class="mono">${num(row.stats && row.stats.distance)}</td>
                <td>${actionButton('Explore', `explore ${row.bot}`, 'compass')}</td>
              </tr>`).join('') : `<tr><td colspan="9">${emptyState('No exploration status', 'The exploration action has not reported yet.', 'compass')}</td></tr>`}</tbody>
            </table></div>
          </section>
          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('navigation')} Go to coordinates</div></div>
              <div class="card-body">
                <form data-goto-form>
                  ${selectBots('goto-bot')}
                  <div class="form-grid form-grid--3" style="margin-top:8px">
                    <div class="field"><label class="field-label" for="goto-x">X</label><input class="input" id="goto-x" type="number" value="0" required></div>
                    <div class="field"><label class="field-label" for="goto-y">Y</label><input class="input" id="goto-y" type="number" value="65" required></div>
                    <div class="field"><label class="field-label" for="goto-z">Z</label><input class="input" id="goto-z" type="number" value="0" required></div>
                  </div>
                  <button class="button button--primary" type="submit" style="margin-top:10px">${icon('navigation')} Navigate</button>
                </form>
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('sparkles')} Discoveries</div>${badge(`${discoveries.length}`, discoveries.length ? 'success' : 'neutral')}</div>
              <div class="card-body card-body--tight">
                ${discoveries.length ? discoveries.slice(0, 10).map((discovery) => `<div class="list-item"><span class="list-icon">${icon('sparkles')}</span><div class="list-main"><div class="list-title">${esc(humanize(discovery.type || discovery.kind || 'discovery'))}</div><div class="list-sub mono">${discovery.position ? `${discovery.position.x}, ${discovery.position.y}, ${discovery.position.z}` : esc(discovery.bot)}</div></div></div>`).join('') : '<div class="muted small" style="padding:8px">No discoveries recorded yet.</div>'}
              </div>
            </section>
          </aside>
        </div>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-goto-form]');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const bot = form.querySelector('#goto-bot').value;
      const x = form.querySelector('#goto-x').value;
      const y = form.querySelector('#goto-y').value;
      const z = form.querySelector('#goto-z').value;
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(`bot ${bot} goto ${x} ${y} ${z}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
      } catch (err) {
        toast({ type: 'error', title: 'Navigation failed', message: err.message });
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
};

function currentPosition(name) {
  const bot = bots().find((entry) => entry.name === name);
  return bot ? bot.position : null;
}

function posText(position) {
  if (!position) return 'unavailable';
  return `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
}

export const sleepPage = {
  title: 'Sleep',
  render() {
    const rows = perBot('sleep');
    const sleeping = rows.filter((row) => row.sleeping);
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Sleep', description: 'Automatic night sleep, bed reservations, world time and night state. Bots only attempt sleep when conditions allow.',
          actions: `<button class="button button--primary" type="button" data-fleet-command="sleep">${icon('bed')} Sleep now</button><button class="button" type="button" data-command="sleep auto on">${icon('moon')} Auto on</button><button class="button" type="button" data-command="sleep auto off">${icon('square')} Auto off</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Sleeping', value: `${sleeping.length}<small> / ${rows.length}</small>`, iconName: 'moon', tone: sleeping.length ? 'info' : 'neutral', context: sleeping.length ? sleeping.map((row) => row.bot).join(', ') : 'No bot is asleep' })}
          ${statCard({ label: 'Night', value: rows.some((row) => row.night) ? 'Yes' : 'No', iconName: 'moon', tone: rows.some((row) => row.night) ? 'info' : 'neutral', context: rows.length ? `World time ${num(rows[0].time)}` : 'No time reported' })}
          ${statCard({ label: 'Nearby beds', value: num(sum(rows, (row) => (row.nearbyBeds || []).length)), iconName: 'bed', tone: 'neutral', context: 'Detected within scan range' })}
          ${statCard({ label: 'Reservations', value: num(rows.filter((row) => row.reservation).length), iconName: 'lock', tone: 'accent', context: 'Beds locked by the sleep manager' })}
          ${statCard({ label: 'Auto sleep', value: rows.length && rows.every((row) => row.auto !== false) ? 'Enabled' : 'Mixed', iconName: 'moon', tone: rows.length && rows.every((row) => row.auto !== false) ? 'success' : 'warning', context: 'Automatic night routine per bot' })}
        </div>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('bed')} Sleep status</div></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Bot</th><th>World time</th><th>Night</th><th>Auto</th><th>Sleeping</th><th>Reservation</th><th>Nearby beds</th><th>Bed item</th><th>Counters</th><th>Actions</th></tr></thead>
            <tbody>${rows.length ? rows.map((row) => `<tr>
              <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}/navigation">${esc(row.bot)}</a></td>
              <td class="mono">${num(row.time)}</td>
              <td>${row.night ? badge('Night', 'info') : badge('Day', 'neutral')}</td>
              <td>${row.auto !== false ? badge('On', 'ok') : badge('Off', 'warn')}</td>
              <td>${row.sleeping ? badge('Sleeping', 'accent', { dot: true }) : badge('Awake', 'neutral')}</td>
              <td class="tiny mono">${esc(row.reservation ? bedText(row.reservation.bed || row.reservation.bedId || row.reservation.id) : '—')}</td>
              <td class="mono">${num((row.nearbyBeds || []).length)}</td>
              <td>${row.hasBedItem ? badge('Yes', 'ok') : badge('No', 'neutral')}</td>
              <td class="tiny">${Object.entries(row.stats || {}).slice(0, 3).map(([key, value]) => `${esc(humanize(key))} ${num(value)}`).join(' · ') || '—'}</td>
              <td><div class="row gap-1">${actionButton('Sleep', `sleep ${row.bot}`, 'bed')}${actionButton(row.auto !== false ? 'Auto off' : 'Auto on', `sleep ${row.bot} auto ${row.auto !== false ? 'off' : 'on'}`, 'moon')}</div></td>
            </tr>`).join('') : `<tr><td colspan="10">${emptyState('No sleep status', 'The sleep action has not reported yet.', 'bed')}</td></tr>`}</tbody>
          </table></div>
        </section>
        <div class="grid grid--2" style="margin-top:16px">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('bed')} Detected beds</div></div>
            <div class="card-body card-body--tight">
              ${rows.flatMap((row) => (row.nearbyBeds || []).map((bed) => ({ ...bed, bot: row.bot }))).length ? rows.flatMap((row) => (row.nearbyBeds || []).map((bed) => `<div class="list-item"><span class="list-icon">${icon('bed')}</span><div class="list-main"><div class="list-title">${esc(humanize(bed.name || 'bed'))}</div><div class="list-sub mono">${bed.x}, ${bed.y}, ${bed.z} · ${esc(row.bot)}</div></div></div>`)).join('') : '<div class="muted small" style="padding:8px">No beds detected nearby.</div>'}
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('shield')} Behaviour</div></div>
            <div class="card-body">
              <div class="callout callout--info">${icon('info')}<div>Bots reserve a bed before sleeping to avoid two bots claiming the same one. Sleep is only attempted at night or during thunderstorms; otherwise the action reports “not night”. Turning auto off suppresses the routine without disabling a deliberate manual sleep.</div></div>
              ${kvRows([['Sleeps', num(sum(rows, (row) => (row.stats && row.stats.sleeps) || 0))], ['Reservations', num(sum(rows, (row) => (row.stats && row.stats.reservations) || 0))], ['Denied attempts', num(sum(rows, (row) => (row.stats && row.stats.denied) || 0))], ['Beds placed', num(sum(rows, (row) => (row.stats && row.stats.bedsPlaced) || 0))]])}
            </div>
          </section>
        </div>
      </div>`;
  }
};
