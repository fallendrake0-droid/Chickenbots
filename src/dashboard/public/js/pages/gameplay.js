import { state, runCommand, runStructuredCommand, refreshState, payloadOf } from '../store.js';
import { commandPreview, commandValues, mineArguments, miningChoices, findMiningTarget, leaderName } from '../commands.js';
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

// Display copy only; the routine keys come from command metadata.
const SURVIVAL_COPY = {
  eat: ['Auto eat', 'Eats before hunger becomes dangerous.'],
  healing: ['Emergency healing', 'Uses golden apples when health is critical.'],
  armour: ['Auto armour', 'Equips better armour pieces from the inventory.'],
  tools: ['Auto tools', 'Checks for a usable pickaxe, axe and sword.'],
  crafting: ['Crafting', 'Crafts a replacement tool when materials exist.'],
  shield: ['Shield', 'Raises a shield when badly hurt.']
};

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
                  ${commandValues('survival', 'feature').map((key) => {
                    const [label, description] = SURVIVAL_COPY[key] || [humanize(key), 'Reported by the survival controller.'];
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

function minedEntries(row) {
  const value = row && row.oresMined;
  if (!value) return [];
  if (typeof value === 'number') return [['ore', value]];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.entries(value).map(([name, count]) => [name, Number(count) || 0]);
  return [];
}

function minedTotal(row) {
  return minedEntries(row).reduce((total, [, count]) => total + (Number(count) || 0), 0);
}

function pickaxeText(pickaxe) {
  if (!pickaxe) return '—';
  const name = typeof pickaxe === 'string' ? pickaxe : pickaxe.name;
  const tier = typeof pickaxe === 'object' ? pickaxe.tier : null;
  return `${humanize(name || 'unknown')}${tier !== null && tier !== undefined ? ` · T${tier}` : ''}`;
}

let miningResult = null;

function miningSnapshot() {
  const snapshot = new Map();
  const live = new Map(((state.snapshot && state.snapshot.bots) || []).map((bot) => [bot.name, bot]));
  for (const row of perBot('mining')) {
    const bot = live.get(row.bot) || {};
    const inventory = {};
    for (const [item, count] of Object.entries(bot.inventory || {})) {
      const value = Number(count);
      if (Number.isFinite(value)) inventory[item] = value;
    }
    snapshot.set(row.bot, { total: minedTotal(row), entries: Object.fromEntries(minedEntries(row)), inventory, stopped: Boolean(row.stopped) });
  }
  return snapshot;
}

/** Item drops that can prove the mine actually removed a block. */
function miningDropDelta(before, after, bot, payload, target) {
  const row = ((payload && payload.results) || []).find((entry) => entry && entry.bot === bot);
  const breakdown = (row && row.breakdown) || (payload && payload.breakdown) || null;
  const items = new Set(Object.keys(breakdown || {}));
  if (target && target.drop) items.add(target.drop);
  if (target && target.target === 'stone') items.add('cobblestone');
  if (!items.size) return 0;
  const beforeInv = (before.get(bot) && before.get(bot).inventory) || {};
  const afterInv = (after.get(bot) && after.get(bot).inventory) || {};
  let delta = 0;
  for (const item of items) delta += Math.max(0, (afterInv[item] || 0) - (beforeInv[item] || 0));
  return delta;
}

function miningRows(payload) {
  const candidates = [payload && payload.results, payload && payload.rows, payload && payload.fleet];
  return candidates.find((value) => Array.isArray(value)) || [];
}

function miningReported(row) {
  if (!row || typeof row !== 'object') return 0;
  const value = row.mined !== undefined ? row.mined : (row.minedCount !== undefined ? row.minedCount : (row.count || 0));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function miningScopeBots(scope) {
  if (scope === 'all') return botNames();
  if (scope === 'leader') return [leaderName()].filter(Boolean);
  return [scope];
}

function miningVerdict({ payload, before, after, scope, stop, target }) {
  if (!payload) return { tone: 'danger', label: 'No result', detail: 'The backend returned no payload.' };
  if (payload.requiresConfirmation) return { tone: 'warning', label: 'Confirmation required', detail: payload.error || 'This action needs explicit confirmation.' };
  const names = miningScopeBots(scope);
  if (stop) {
    if (payload.ok === false) return { tone: 'danger', label: 'Rejected', detail: `${payload.code || 'ERROR'}: ${payload.error || 'the backend rejected the stop command.'}` };
    const stillRunning = names.filter((name) => after.has(name) && after.get(name).stopped !== true);
    if (stillRunning.length) return { tone: 'warning', label: 'Stop accepted, not observed', detail: `Still reporting active mining: ${stillRunning.join(', ')}.` };
    return { tone: 'success', label: 'Mining stopped', detail: `${names.length} bot${names.length === 1 ? '' : 's'} report stopped in live state.` };
  }
  const changes = names.map((name) => ({
    name,
    delta: ((after.get(name) && after.get(name).total) || 0) - ((before.get(name) && before.get(name).total) || 0),
    items: miningDropDelta(before, after, name, payload, target),
    reported: miningReported((payload.results || []).find((row) => row && row.bot === name) || (names.length === 1 ? payload : null))
  }));
  // Counter and inventory evidence can describe the same drop. Take the
  // stronger per-bot signal instead of double-counting one mined item twice.
  const verified = changes.reduce((total, row) => total + Math.max(0, row.delta, row.items), 0);
  const reported = changes.reduce((total, row) => total + Math.max(0, row.reported), 0);
  const rowErrors = miningRows(payload).filter((row) => row && row.ok === false);
  // A fleet command is `ok:false` when any bot failed. That is not a total
  // rejection: report verified work as partial rather than hiding it.
  if (verified > 0) {
    if (payload.ok === false || rowErrors.length) {
      const failed = rowErrors.map((row) => row.bot).filter(Boolean);
      return { tone: 'warning', label: 'Partial success', detail: `${verified} mined item${verified === 1 ? '' : 's'} verified${target ? ` for ${target.label}` : ''}; ${failed.length ? `${failed.join(', ')} failed` : 'the backend reported a partial fleet result'}.` };
    }
    return { tone: 'success', label: 'Verified', detail: `${verified} mined item${verified === 1 ? '' : 's'} confirmed by live counters or inventory${target ? ` for ${target.label}` : ''}.` };
  }
  if (reported > 0) {
    return { tone: 'warning', label: 'Reported, not yet observed', detail: `The handler reported ${reported} mined item${reported === 1 ? '' : 's'} but no state delta is visible yet. Accepted is not completion.` };
  }
  if (payload.ok === false) return { tone: 'danger', label: 'Rejected', detail: `${payload.code || 'ERROR'}: ${payload.error || 'the backend rejected the command.'}` };
  const rowError = rowErrors[0];
  if (rowError) return { tone: 'danger', label: 'No ore mined', detail: `${rowError.bot || 'fleet'}: ${rowError.code || 'ERROR'} ${rowError.error || ''}`.trim() };
  const code = payload.code || (payload.skipped && payload.skipped.length ? 'SKIPPED' : null);
  return { tone: 'warning', label: 'Accepted, no ore verified', detail: `${code ? `${code}: ` : ''}No state delta was observed. The command ran, but it did not mine${target ? ` ${target}` : ''}.` };
}

function miningResultHtml() {
  if (!miningResult) {
    return `<div class="callout callout--info">${icon('shield-check')}<div><strong>Verified, not assumed.</strong> The result card compares the live mined counters before and after the command. An accepted command with no ore removed will be reported as accepted, never as success.</div></div>`;
  }
  const { line, verdict, payload, before, after, at, scope, target } = miningResult;
  const rows = miningRows(payload);
  const names = miningScopeBots(scope);
  const tone = verdict.tone === 'success' ? 'ok' : verdict.tone === 'danger' ? 'danger' : 'warn';
  return `<div class="callout callout--${verdict.tone === 'success' ? 'success' : verdict.tone === 'danger' ? 'danger' : 'warning'}">${icon(verdict.tone === 'success' ? 'shield-check' : 'alert-circle')}<div><strong>${esc(verdict.label)}</strong> ${esc(verdict.detail)}</div></div>
    <div class="row gap-2" style="flex-wrap:wrap;margin:10px 0"><span class="badge badge--outline mono">${esc(line)}</span>${badge(verdict.label, tone)}<span class="tiny muted">${scope === 'all' ? 'Fleet' : scope === 'leader' ? `Leader · ${esc(leaderName() || 'none')}` : esc(scope)}${target ? ` · ${esc(target)}` : ' · auto target'} · ${timeAgo(at)}</span></div>
    <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Bot</th><th>Reported</th><th>Counter delta</th><th>Item delta</th><th>Result</th></tr></thead><tbody>${names.map((name) => {
      const row = rows.find((entry) => entry && entry.bot === name) || (names.length === 1 ? payload : null);
      const delta = ((after.get(name) && after.get(name).total) || 0) - ((before.get(name) && before.get(name).total) || 0);
      const items = miningDropDelta(before, after, name, payload, target ? findMiningTarget(target) : null);
      const rowOk = row && row.ok === false ? false : row && row.ok === true ? true : null;
      return `<tr><td>${esc(name)}</td><td class="mono">${num(miningReported(row))}</td><td class="mono">${delta > 0 ? `+${num(delta)}` : num(delta)}</td><td class="mono">${items > 0 ? `+${num(items)}` : num(items)}</td><td class="tiny">${verdict.tone === 'danger' && rowOk === false ? esc(`${row.code || 'ERROR'} ${row.error || ''}`) : rowOk === false ? badge('Failed', 'danger') : rowOk === true ? badge('Handler ok', 'ok') : '—'}</td></tr>`;
    }).join('')}</tbody></table></div>
    ${payload.skipped && payload.skipped.length ? `<div class="tiny muted" style="margin-top:8px">Skipped: ${esc(payload.skipped.map((entry) => (typeof entry === 'string' ? entry : entry.bot || entry.reason || JSON.stringify(entry))).join(', '))}</div>` : ''}`;
}

function miningArgsFor(scope, target, stop = false) {
  if (scope === 'all') return mineArguments({ fleet: 'all', target: target || null, stop });
  if (scope === 'leader') return mineArguments({ bot: leaderName(), target: target || null, stop });
  return mineArguments({ bot: scope, target: target || null, stop });
}

function previewMineLine(scope, targetId) {
  const target = targetId ? findMiningTarget(targetId) : null;
  return commandPreview('mine', miningArgsFor(scope, target ? target.id : null));
}

function targetChoicesHtml(selected = '') {
  const choices = miningChoices();
  if (!choices.length) return '<option value="">Target catalogue unavailable</option>';
  const group = (kind, label) => {
    const rows = choices.filter((entry) => entry.kind === kind);
    if (!rows.length) return '';
    return `<optgroup label="${esc(label)}">${rows.map((entry) => {
      const suffix = `${entry.tier !== null ? `tier ${entry.tier}` : ''}${entry.drop && entry.drop !== entry.target ? ` · ${humanize(entry.drop)}` : ''}`;
      return `<option value="${esc(entry.id)}"${entry.id === selected ? ' selected' : ''}>${esc(entry.label)}${suffix ? ` — ${esc(suffix)}` : ''}</option>`;
    }).join('')}</optgroup>`;
  };
  return `<option value="">Auto — nearest exposed ore</option>${group('ore', 'Ores')}${group('block', 'Blocks')}`;
}

export const miningPage = {
  title: 'Mining',
  render() {
    const rows = perBot('mining');
    const oreTotals = new Map();
    for (const row of rows) {
      for (const [name, count] of minedEntries(row)) oreTotals.set(name, (oreTotals.get(name) || 0) + count);
    }
    const totalMined = [...oreTotals.values()].reduce((total, count) => total + count, 0);
    const nearby = sum(rows, (row) => (row.nearbyOres || []).length);
    const stopped = rows.filter((row) => row.stopped).length;
    const reserved = sum(rows, (row) => (row.reservations && row.reservations.count) || 0);
    const scannedAt = rows.reduce((latest, row) => Math.max(latest, (row.scan && row.scan.at) || 0), 0);
    const oreNames = [...new Set(rows.flatMap((row) => (row.nearbyOres || []).map((ore) => ore.name)))];
    const nearest = rows
      .flatMap((row) => (row.nearbyOres || []).map((ore) => ({ ...ore, bot: row.bot })))
      .sort((left, right) => (left.distance || 0) - (right.distance || 0))[0] || null;
    const leader = leaderName();
    const scopeOptions = [
      `<option value="leader"${leader ? '' : ' disabled'}>${esc(leader || 'Leader unavailable')} — leader (implicit)</option>`,
      ...botNames().filter((name) => name !== leader).map((name) => `<option value="${esc(name)}">${esc(name)}</option>`),
      '<option value="all">All bots — fleet fan-out</option>'
    ].join('');
    const preview = previewMineLine('leader', null);
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Mining', description: 'Mine exposed ore or bootstrap a missing pickaxe tier. Deep targets are reached by safe shafts; every target is constrained to the shared work zone.',
          actions: `<button class="button button--danger-ghost" type="button" data-mining-quick="stop-all">${icon('square')} Stop all</button><button class="button button--primary" type="button" data-mining-quick="leader">${icon('pickaxe')} Mine leader</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Ores mined', value: num(totalMined), iconName: 'pickaxe', tone: totalMined ? 'accent' : 'neutral', context: `${num(oreTotals.size)} ore types across ${num(rows.length)} reporting bots` })}
          ${statCard({ label: 'Nearby sampled', value: num(nearby), iconName: 'gem', tone: nearby ? 'info' : 'neutral', context: scannedAt ? `Cached status scan · ${timeAgo(scannedAt)}` : 'No status scan has run yet' })}
          ${statCard({ label: 'Jobs stopped', value: `${num(stopped)}<small> / ${num(rows.length)}</small>`, iconName: 'square', tone: stopped ? 'warning' : 'success', context: 'Stopped jobs resume only when mining is issued again' })}
          ${statCard({ label: 'Ore reservations', value: num(reserved), iconName: 'scan', tone: reserved ? 'info' : 'neutral', context: 'Short fleet-wide leases on concrete targets' })}
        </div>
        <div class="grid grid--main-side">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('target')} Start mining</div><span class="badge badge--outline">Work-zone confined</span></div>
            <div class="card-body">
              <form data-mining-form class="form-grid form-grid--2">
                <div class="field"><label class="field-label" for="mine-scope">Who</label>
                  <select class="select" id="mine-scope" name="scope">${scopeOptions}</select>
                  <div class="field-hint">The leader uses the implicit grammar (<span class="mono">mine</span> / <span class="mono">mine diamonds</span>). Other bots are named explicitly; <span class="mono">mine leader</span> is not valid.</div>
                </div>
                <div class="field"><label class="field-label" for="mine-target">Ore or block</label>
                  <select class="select" id="mine-target" name="target">${targetChoicesHtml()}</select>
                  <div class="field-hint">Targets come from the server mining catalogue. Leave blank to mine the nearest exposed ores; named targets use the deep path and must verify an ore was removed.</div>
                </div>
                <div class="field field--full"><div class="tiny muted">${icon('terminal')} <span class="mono" data-mining-preview>${esc(preview)}</span> · preview is produced from the same registry metadata and argument order used by execution.</div></div>
                <div class="field field--full"><div class="tiny muted">${icon('scan')} Command scans use a 24-block radius and up to 8 targets. The telemetry card samples a 5-block radius with a per-bot cache so a snapshot cannot stall the tick loop.</div></div>
                <div class="field field--full"><button class="button button--primary" type="submit">${icon('pickaxe')} Start mining</button></div>
              </form>
              <div data-mining-result style="margin-top:14px">${miningResultHtml()}</div>
            </div>
          </section>
          <aside class="card">
            <div class="card-header"><div class="card-title">${icon('gem')} Detected ores</div><span class="tiny muted">${num(nearby)} sampled</span></div>
            <div class="card-body card-body--tight">
              ${oreNames.length ? oreNames.sort().slice(0, 14).map((ore) => {
                const samples = rows.flatMap((row) => (row.nearbyOres || []).filter((entry) => entry.name === ore));
                const closest = samples.sort((left, right) => (left.distance || 0) - (right.distance || 0))[0];
                return `<div class="list-item"><span class="list-icon">${icon('gem')}</span><div class="list-main"><div class="list-title">${esc(humanize(ore))}</div><div class="list-sub">${num(samples.length)} sampled${closest ? ` · closest ${num(closest.distance)} blocks` : ''}</div></div></div>`;
              }).join('') : '<div class="muted small" style="padding:8px">No ores detected in the cached status scans.</div>'}
              ${nearest ? `<div class="callout callout--info" style="margin:10px">${icon('map-pin')}<div><strong>${esc(humanize(nearest.name))}</strong> at ${num(nearest.distance)} blocks from <span class="mono">${esc(nearest.bot)}</span>.</div></div>` : ''}
            </div>
          </aside>
        </div>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('pickaxe')} Mining status</div><span class="tiny muted">${scannedAt ? `scan ${timeAgo(scannedAt)}` : 'awaiting telemetry'}</span></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Bot</th><th>State</th><th>Pickaxe</th><th>Work zone</th><th>Mined</th><th>Sampled nearby</th><th>Reservations</th><th>Actions</th></tr></thead>
              <tbody>${rows.length ? rows.map((row) => {
                const entries = minedEntries(row).sort((left, right) => right[1] - left[1]);
                const rowNearby = row.nearbyOres || [];
                const zone = row.zone || {};
                const mineLine = commandPreview('mine', mineArguments({ bot: row.bot }));
                const stopLine = commandPreview('mine', mineArguments({ bot: row.bot, stop: true }));
                return `<tr>
                  <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}">${esc(row.bot)}</a><div class="mono tiny muted">${row.position ? `${num(row.position.x)}, ${num(row.position.y)}, ${num(row.position.z)}` : 'position unknown'}</div></td>
                  <td>${row.stopped ? badge('Stopped', 'warn') : badge('Ready', 'ok')}</td>
                  <td class="tiny">${esc(pickaxeText(row.pickaxe))}</td>
                  <td class="tiny">${zone.enabled === false ? badge('Disabled', 'neutral') : esc(zone.label || '—')}${row.stats ? `<div class="muted">${Object.entries(row.stats).slice(0, 2).map(([key, value]) => `${esc(humanize(key))} ${num(value)}`).join(' · ')}</div>` : ''}</td>
                  <td class="mono">${num(minedTotal(row))}${entries.length ? `<div class="tiny muted">${entries.slice(0, 2).map(([name, count]) => `${esc(humanize(name))} ${num(count)}`).join(' · ')}</div>` : ''}</td>
                  <td class="mono">${num(rowNearby.length)}${rowNearby.length ? `<div class="tiny muted">${rowNearby.slice(0, 2).map((ore) => `${esc(humanize(ore.name))} ${num(ore.distance)}m`).join(' · ')}</div>` : ''}</td>
                  <td class="tiny">${row.reservations ? `${num(row.reservations.count)} held · ${num(row.reservations.stats && row.reservations.stats.rejected)} conflicts` : '—'}</td>
                  <td><div class="row gap-1"><button class="button button--sm" type="button" data-mining-quick="bot" data-mining-bot="${esc(row.bot)}" title="${esc(mineLine)}">${icon('pickaxe')} Mine</button>${row.stopped ? '' : `<button class="button button--sm" type="button" data-mining-quick="stop-bot" data-mining-bot="${esc(row.bot)}" title="${esc(stopLine)}">${icon('square')} Stop</button>`}</div></td>
                </tr>`;
              }).join('') : `<tr><td colspan="8">${emptyState('No mining status', 'Mining telemetry will appear when the action starts reporting.', 'pickaxe')}</td></tr>`}</tbody>
            </table>
          </div>
        </section>
        ${miningLogs()}
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-mining-form]');
    const scopeSelect = form && form.querySelector('#mine-scope');
    const targetSelect = form && form.querySelector('#mine-target');
    const previewSlot = form && form.querySelector('[data-mining-preview]');
    const resultSlot = root.querySelector('[data-mining-result]');
    const refreshPreview = () => {
      if (!form || !scopeSelect || !targetSelect || !previewSlot) return;
      const target = targetSelect.value ? findMiningTarget(targetSelect.value) : null;
      const args = miningArgsFor(scopeSelect.value, target ? target.id : null);
      previewSlot.textContent = commandPreview('mine', args);
    };
    if (scopeSelect) scopeSelect.addEventListener('change', refreshPreview);
    if (targetSelect) targetSelect.addEventListener('change', refreshPreview);
    refreshPreview();

    const runMining = async (scope, targetId, { stop = false, button = null } = {}) => {
      const target = targetId ? findMiningTarget(targetId) : null;
      if (targetId && !target) {
        toast({ type: 'error', title: 'Unknown target', message: `${targetId} is not in the server mining catalogue.`, duration: 8000 });
        return;
      }
      if (stop) {
        const ok = await confirmDialog({ title: 'Stop mining', message: `Stop mining for ${scope === 'all' ? 'the whole fleet' : scope === 'leader' ? `the leader (${leaderName()})` : scope}?`, confirmLabel: 'Stop mining', tone: 'danger' });
        if (!ok) return;
      }
      const args = miningArgsFor(scope, target ? target.id : null, stop);
      const line = commandPreview('mine', args);
      const before = miningSnapshot();
      if (button) setButtonLoading(button, true);
      try {
        const result = await runStructuredCommand('mine', args, { confirm: stop });
        const payload = payloadOf(result) || {};
        try { await refreshState(); } catch (_) { /* the verdict below reports an unobserved state honestly */ }
        const after = miningSnapshot();
        const verdict = miningVerdict({ payload, before, after, scope, stop, target });
        miningResult = { line, verdict, payload, before, after, at: Date.now(), scope, target: target ? target.id : null };
        if (resultSlot) resultSlot.innerHTML = miningResultHtml();
        toast({
          type: verdict.tone === 'success' ? 'success' : verdict.tone === 'danger' ? 'error' : 'warn',
          title: verdict.label,
          message: verdict.detail,
          duration: verdict.tone === 'success' ? 4500 : 9000
        });
      } catch (err) {
        const payload = err.payload || { ok: false, code: err.code || 'REQUEST_FAILED', error: err.message };
        miningResult = { line, payload, before, after: before, at: Date.now(), scope, target: target ? target.id : null, verdict: { tone: 'danger', label: 'Command failed', detail: err.message || 'The backend did not answer.' } };
        if (resultSlot) resultSlot.innerHTML = miningResultHtml();
        toast({ type: 'error', title: 'Mining failed', message: err.message, duration: 9000 });
      } finally {
        if (button) setButtonLoading(button, false);
      }
    };

    if (form) form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      await runMining(scopeSelect && scopeSelect.value ? scopeSelect.value : 'leader', targetSelect ? targetSelect.value : null, { button });
    });

    root.querySelectorAll('[data-mining-quick]').forEach((button) => button.addEventListener('click', async () => {
      const mode = button.getAttribute('data-mining-quick');
      const bot = button.getAttribute('data-mining-bot');
      if (mode === 'leader') return runMining('leader', null, { button });
      if (mode === 'bot') return runMining(bot || 'leader', null, { button });
      if (mode === 'stop-bot') return runMining(bot || 'leader', null, { stop: true, button });
      if (mode === 'stop-all') return runMining('all', null, { stop: true, button });
      return null;
    }));
  }
};

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
        // Trench width is 1–16 in the backend, while box/flatten accept 1–128.
        const width = form.querySelector('#exc-width');
        if (width) width.max = mode.value === 'trench' ? '16' : '128';
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
      ], { htmlValues: true })}
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
          ${statCard({ label: 'Rods ready', value: `${rows.filter((row) => row.rod).length}<small> / ${rows.length || botNames().length}</small>`, iconName: 'package', tone: rows.some((row) => row.rod) ? 'info' : 'warning', context: 'Bots holding a fishing rod' })}
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
    const team = (state.snapshot && state.snapshot.woodcuttingTeam) || null;
    const catalog = (state.snapshot && state.snapshot.woodcuttingCatalog) || [];
    const taskTrees = sum(rows, (row) => (row.task && row.task.treesChopped) || 0);
    const lifeTrees = sum(rows, (row) => (row.lifetime && row.lifetime.treesChopped) || (row.stats && row.stats.treesChopped) || 0);
    const taskLogs = sum(rows, (row) => (row.task && row.task.logsCollected) || 0);
    const lifeLogs = sum(rows, (row) => (row.lifetime && row.lifetime.logsCollected) || (row.stats && row.stats.logsCollected) || 0);
    const stored = sum(rows, (row) => (row.lifetime && row.lifetime.stored) || 0);
    const openSupport = (team && team.openSupport) || [];
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Gameplay', title: 'Woodcutting', description: 'Version-aware tree identification, verified chopping, species-correct replanting, storage and fleet roles. Counters are split between the current task and the process lifetime.',
          actions: `<button class="button button--primary" type="button" data-fleet-command="chop">${icon('axe')} Chop fleet</button><button class="button" type="button" data-wood-scan="${esc((rows[0] && rows[0].bot) || '')}">${icon('scan')} Scan trees</button><button class="button" type="button" data-command="woodcutting plant all">${icon('sprout')} Plant</button><button class="button button--danger-ghost" type="button" data-command="woodcutting stop" data-danger="true" data-confirm-title="Stop woodcutting" data-confirm-message="Stop chopping on every bot? Verified logs already collected are kept.">${icon('stop')} Stop all</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Logs held', value: num(sum(rows, (row) => row.logs || 0)), iconName: 'axe', tone: 'accent', context: 'Live inventory across the fleet' })}
          ${statCard({ label: 'Saplings', value: num(sum(rows, (row) => row.saplings || 0)), iconName: 'sprout', tone: 'success', context: 'Available for species-correct replanting' })}
          ${statCard({ label: 'Task trees', value: num(taskTrees), iconName: 'trees', tone: 'info', context: 'Verified in the current task window' })}
          ${statCard({ label: 'Lifetime trees', value: num(lifeTrees), iconName: 'trees', tone: 'neutral', context: 'Verified removals since process start' })}
          ${statCard({ label: 'Task logs', value: num(taskLogs), iconName: 'package', tone: 'info', context: `Lifetime ${num(lifeLogs)} verified log drops` })}
          ${statCard({ label: 'Stored / support', value: `${num(stored)}<small> / ${num(openSupport.length)}</small>`, iconName: 'boxes', tone: openSupport.length ? 'warn' : 'success', context: 'Logs deposited at real storage · open support requests' })}
        </div>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('axe')} Woodcutting status</div><span class="tiny muted">${rows.length} bots · ${num(openSupport.length)} open support</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Bot</th><th>Role</th><th>Axe</th><th>Logs</th><th>Saplings</th><th>Task</th><th>Lifetime</th><th>Last tree</th><th>Actions</th></tr></thead>
            <tbody>${rows.length ? rows.map((row) => {
              const task = row.task || {};
              const life = row.lifetime || row.stats || {};
              const tree = row.lastTree;
              return `<tr>
                <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}">${esc(row.bot)}</a>${row.stopped ? ` ${badge('Stopped', 'warn')}` : ''}</td>
                <td>${badge(row.role || 'CHOPPER', row.role === 'CHOPPER' ? 'neutral' : 'info')}</td>
                <td class="tiny">${esc(row.axe ? humanize(row.axe.name || row.axe) : 'hand')}${row.axe && row.axe.durability !== undefined && row.axe.durability !== null ? `<br><span class="muted">${num(row.axe.durability)}${row.axe.maxDurability ? ` / ${num(row.axe.maxDurability)}` : ''}</span>` : ''}</td>
                <td class="mono">${num(row.logs)}</td>
                <td class="mono">${num(row.saplings)}</td>
                <td class="tiny">${num(task.treesChopped || 0)} trees<br>${num(task.logsCollected || 0)} logs<br>${num(task.replanted || 0)} planted</td>
                <td class="tiny">${num(life.treesChopped || 0)} trees<br>${num(life.logsCollected || 0)} logs<br>${num(life.stored || 0)} stored</td>
                <td class="tiny">${tree ? `${esc(humanize(tree.type || 'tree'))}<br>${num(tree.chopped)} logs · ${esc(tree.footprint || '')}<br><span class="muted">${tree.confidence !== undefined ? `${Math.round(tree.confidence * 100)}% confidence` : ''}</span>` : '—'}</td>
                <td><div class="row row--wrap">
                  ${actionButton('Chop', `woodcutting chop ${row.bot}`, 'axe')}
                  <button class="button button--sm" type="button" data-wood-scan="${esc(row.bot)}">${icon('scan')} Scan</button>
                  ${actionButton('Plant', `woodcutting plant ${row.bot}`, 'sprout')}
                  ${actionButton('Store', `woodcutting store ${row.bot}`, 'boxes')}
                  ${actionButton('Relocate', `woodcutting relocate ${row.bot}`, 'compass')}
                  ${actionButton('Stop', `woodcutting stop ${row.bot}`, 'stop', { danger: true, confirmTitle: 'Stop this bot', confirmMessage: `Stop woodcutting on ${row.bot}?` })}
                </div></td>
              </tr>`;
            }).join('') : `<tr><td colspan="9">${emptyState('No woodcutting status', 'The action has not reported yet.', 'axe')}</td></tr>`}</tbody>
          </table></div>
        </section>
        <div class="grid grid--2" style="align-items:start;gap:16px;margin-top:16px">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('users')} Fleet roles</div><span class="tiny muted">${team ? Object.entries(team.byRole || {}).map(([role, count]) => `${esc(humanize(role))} ${num(count)}`).join(' · ') : 'No team state'}</span></div>
            <div class="card-body">
              <p class="muted">CHOPPER harvests, SCOUT explores farther, HAULER deposits logs, PLANTER plants spare saplings, GUARD keeps a defensive watch. Roles change support behaviour, never verification.</p>
              <form class="row row--wrap" data-wood-role>
                <select class="select select--sm" name="bot" aria-label="Woodcutting bot">${botNames().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select>
                <select class="select select--sm" name="role" aria-label="Woodcutting role">${(() => {
                  const roles = commandValues('woodcutting', 'role');
                  return roles.length ? roles.map((role) => `<option value="${role}">${humanize(role)}</option>`).join('') : '<option value="">Role catalogue unavailable</option>';
                })()}</select>
                <button class="button button--sm" type="submit">${icon('check')} Assign role</button>
                <button class="button button--sm" type="button" data-command="woodcutting team auto">${icon('zap')} Auto-assign</button>
              </form>
              <div class="table-wrap" style="margin-top:10px"><table class="table"><thead><tr><th>Bot</th><th>Role</th><th>Task trees</th><th>Lifetime</th></tr></thead><tbody>
                ${team && team.rows ? team.rows.map((row) => `<tr><td class="mono">${esc(row.bot)}</td><td>${badge(row.role, 'info')}</td><td class="mono">${num((row.task && row.task.treesChopped) || 0)}</td><td class="mono">${num(row.treesChopped || 0)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">No team rows.</td></tr>'}
              </tbody></table></div>
            </div>
          </section>
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('flag')} Support requests</div><span class="tiny muted">${num(openSupport.length)} open</span></div>
            <div class="card-body">
              ${openSupport.length ? openSupport.map((request) => `<div class="row row--between" style="gap:10px;margin-bottom:8px"><span class="tiny"><strong>${esc(request.bot || 'fleet')}</strong> · ${esc(request.kind)}${request.detail ? ` · ${esc(request.detail)}` : ''}</span><button class="button button--sm" type="button" data-command="woodcutting support fulfil ${esc(request.id)}">Fulfil</button></div>`).join('') : emptyState('No open support requests', 'Bots ask for help when a tree, axe or storage trip needs another pair of hands.', 'flag')}
              <form class="row row--wrap" data-wood-support style="margin-top:10px">
                <select class="select select--sm" name="bot" aria-label="Requesting bot">${botNames().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select>
                <input class="input input--sm" name="kind" placeholder="kind (axe/storage/tree)" maxlength="24">
                <button class="button button--sm" type="submit">${icon('flag')} Request help</button>
              </form>
            </div>
          </section>
        </div>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('book-open')} Tree catalogue</div><span class="tiny muted">Version-aware · newer species are flagged when the server predates them</span></div>
          <div class="card-body chips">
            ${catalog.length ? catalog.map((entry) => `<span class="chip" title="${esc((entry.logs || []).join(', '))}">${esc(entry.label)} <span class="tiny muted">since ${esc(entry.since)} · ${entry.footprint === 2 ? '2x2' : '1x1'}${entry.supported ? '' : ' · newer than server'}</span></span>`).join('') : '<span class="muted">Catalogue unavailable.</span>'}
          </div>
        </section>
        <div class="callout callout--info">${icon('info')}<div>Every harvested tree is confirmed block-by-block. A failed dig, an unreachable upper log or a full inventory is reported honestly instead of being counted as wood. Replanting uses the harvested species, including dark oak's 2x2 sapling rule.</div></div>
      </div>`;
  },
  mount(root) {
    for (const button of root.querySelectorAll('[data-wood-scan]')) {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        const bot = button.dataset.woodScan || (botNames()[0] || '');
        if (!bot) return;
        setButtonLoading(button, true);
        try {
          const result = await runCommand(`woodcutting trees ${bot} 32`);
          const payload = payloadOf(result);
          const trees = payload.trees || [];
          const message = trees.length
            ? trees.slice(0, 4).map((tree) => `${humanize(tree.label || tree.type || 'tree')} at ${tree.base.x},${tree.base.y},${tree.base.z} · ${tree.count} logs · ${Math.round((tree.confidence || 0) * 100)}%`).join(' · ')
            : (payload.error || 'No tree passed the confidence and work-zone checks in 32 blocks.');
          toast({
            type: trees.length ? 'success' : 'info',
            title: `${trees.length} tree${trees.length === 1 ? '' : 's'} identified`,
            message,
            duration: 8000
          });
        } catch (err) {
          toast({ type: 'error', title: 'Tree scan failed', message: err.message });
        } finally {
          setButtonLoading(button, false);
        }
      });
    }
    const roleForm = root.querySelector('[data-wood-role]');
    if (roleForm) roleForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(roleForm);
      const button = roleForm.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(`woodcutting team assign ${data.get('bot')} ${data.get('role')}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
      } catch (err) {
        toast({ type: 'error', title: 'Role assignment failed', message: err.message });
      } finally {
        setButtonLoading(button, false);
      }
    });
    const supportForm = root.querySelector('[data-wood-support]');
    if (supportForm) supportForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(supportForm);
      const kind = String(data.get('kind') || 'HELP').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'HELP';
      const button = supportForm.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(`woodcutting support request ${data.get('bot')} ${kind}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
        supportForm.reset();
      } catch (err) {
        toast({ type: 'error', title: 'Support request failed', message: err.message });
      } finally {
        setButtonLoading(button, false);
      }
    });
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
          actions: `<button class="button button--primary" type="button" data-fleet-command="farm">${icon('sprout')} Harvest all</button><button class="button" type="button" data-fleet-command="farm plant wheat 16">${icon('leaf')} Plant wheat</button><button class="button" type="button" data-fleet-command="farm maintain">${icon('refresh')} Maintain farms</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Crops ready', value: num(sum(rows, (row) => row.matureCount || 0)), iconName: 'sprout', tone: 'accent', context: 'Mature crops detected in scans' })}
          ${statCard({ label: 'Seed stocks', value: num(sum(rows, (row) => sum(row.seeds || [], (seed) => seed.count))), iconName: 'package', tone: 'info', context: 'Seeds available for replanting' })}
          ${statCard({ label: 'Animals', value: num(sum(rows, (row) => row.animals || 0)), iconName: 'heart', tone: 'neutral', context: 'Nearby animals reported' })}
          ${statCard({ label: 'Harvested', value: num(sum(rows, (row) => (row.stats && row.stats.harvested) || 0)), iconName: 'wheat', tone: 'success', context: 'Lifetime harvest counter' })}
          ${statCard({ label: 'Replanted', value: num(sum(rows, (row) => (row.stats && row.stats.replanted) || 0)), iconName: 'leaf', tone: 'info', context: 'Successful replants after harvest' })}
          ${statCard({ label: 'Breeds', value: num(sum(rows, (row) => (row.stats && row.stats.animalsBred) || 0)), iconName: 'heart', tone: 'success', context: 'Successful animal breeding operations' })}
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
              <div class="row gap-2" style="margin-top:10px">${actionButton('Harvest', `farm ${row.bot}`, 'sprout')}${actionButton('Plant', `farm ${row.bot} plant wheat 16`, 'leaf')}${actionButton('Maintain', `farm ${row.bot} maintain`, 'refresh')}<a class="button button--sm" href="#/bots/${encodeURIComponent(row.bot)}/inventory">Inventory</a></div>
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
          actions: `<button class="button button--primary" type="button" data-fleet-command="sleep">${icon('bed')} Sleep now</button><button class="button" type="button" data-command="sleep spawn all">${icon('map-pin')} Set spawn (all)</button><button class="button" type="button" data-command="sleep auto on">${icon('moon')} Auto on</button><button class="button" type="button" data-command="sleep auto off">${icon('square')} Auto off</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Sleeping', value: `${sleeping.length}<small> / ${rows.length}</small>`, iconName: 'moon', tone: sleeping.length ? 'info' : 'neutral', context: sleeping.length ? sleeping.map((row) => row.bot).join(', ') : 'No bot is asleep' })}
          ${statCard({ label: 'Night', value: rows.some((row) => row.night) ? 'Yes' : 'No', iconName: 'moon', tone: rows.some((row) => row.night) ? 'info' : 'neutral', context: rows.length ? `World time ${num(rows[0].time)}` : 'No time reported' })}
          ${statCard({ label: 'Nearby beds', value: num(sum(rows, (row) => (row.nearbyBeds || []).length)), iconName: 'bed', tone: 'neutral', context: `${num(rows.filter((row) => row.spawnSet).length)} bot(s) with a spawn point` })}
          ${statCard({ label: 'Reservations', value: num(rows.filter((row) => row.reservation).length), iconName: 'lock', tone: 'accent', context: 'Beds locked by the sleep manager' })}
          ${statCard({ label: 'Auto sleep', value: rows.length && rows.every((row) => row.auto !== false) ? 'Enabled' : 'Mixed', iconName: 'moon', tone: rows.length && rows.every((row) => row.auto !== false) ? 'success' : 'warning', context: 'Automatic night routine per bot' })}
        </div>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('bed')} Sleep status</div></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Bot</th><th>World time</th><th>Night</th><th>Auto</th><th>Sleeping</th><th>Reservation</th><th>Spawn point</th><th>Nearby beds</th><th>Bed item</th><th>Counters</th><th>Actions</th></tr></thead>
            <tbody>${rows.length ? rows.map((row) => `<tr>
              <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}/navigation">${esc(row.bot)}</a></td>
              <td class="mono">${num(row.time)}</td>
              <td>${row.night ? badge('Night', 'info') : badge('Day', 'neutral')}</td>
              <td>${row.auto !== false ? badge('On', 'ok') : badge('Off', 'warn')}</td>
              <td>${row.sleeping ? badge('Sleeping', 'accent', { dot: true }) : badge('Awake', 'neutral')}</td>
              <td class="tiny mono">${esc(row.reservation ? bedText(row.reservation.bed || row.reservation.bedId || row.reservation.id) : '—')}</td>
              <td class="tiny mono">${row.spawnPoint ? esc(bedText(row.spawnPoint)) : (row.spawnSet ? 'Set' : badge('Not set', 'warn'))}</td>
              <td class="mono">${num((row.nearbyBeds || []).length)}</td>
              <td>${row.hasBedItem ? badge('Yes', 'ok') : badge('No', 'neutral')}</td>
              <td class="tiny">${Object.entries(row.stats || {}).slice(0, 3).map(([key, value]) => `${esc(humanize(key))} ${num(value)}`).join(' · ') || '—'}</td>
              <td><div class="row gap-1">${actionButton('Sleep', `sleep ${row.bot}`, 'bed')}${actionButton('Set spawn', `sleep spawn ${row.bot}`, 'map-pin')}${actionButton(row.auto !== false ? 'Auto off' : 'Auto on', `sleep ${row.bot} auto ${row.auto !== false ? 'off' : 'on'}`, 'moon')}</div></td>
            </tr>`).join('') : `<tr><td colspan="11">${emptyState('No sleep status', 'The sleep action has not reported yet.', 'bed')}</td></tr>`}</tbody>
          </table></div>
        </section>
        <div class="grid grid--2" style="margin-top:16px">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('bed')} Detected beds</div></div>
            <div class="card-body card-body--tight">
              ${rows.flatMap((row) => (row.nearbyBeds || []).map((bed) => ({ ...bed, bot: row.bot }))).length ? rows.flatMap((row) => (row.nearbyBeds || []).map((bed) => `<div class="list-item"><span class="list-icon">${icon('bed')}</span><div class="list-main"><div class="list-title">${esc(humanize(bed.name || 'bed'))} ${bed.spawn ? badge('Spawn', 'ok') : ''}${bed.occupied ? badge('Occupied', 'warn') : ''}</div><div class="list-sub mono">${bed.x}, ${bed.y}, ${bed.z} · ${esc(row.bot)} · ${num(bed.distance)}m${bed.reservedBy ? ` · ${esc(bed.reservedBy)}` : ''}</div></div></div>`)).join('') : '<div class="muted small" style="padding:8px">No beds detected nearby.</div>'}
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
