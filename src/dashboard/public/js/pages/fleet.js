import { state, runBotAction, bot as getBot, tasksFor, actionsFor, teamMember } from '../store.js';
import { icon } from '../icons.js';
import { esc, num, clamp, formatTime, timeAgo, duration, humanize, healthTone } from '../utils.js';
import { badge, progress, kvRows, emptyState, pageHeader, sectionHead, statCard, toast, botAvatar } from '../ui.js';
import { bots, botNames, overview, teamState, connectionLabel, botStatusBadge, botCard, botMenu, alertsBlock, taskColumns, taskCard, botAlerts, botStatus, botOnline } from './shared.js';
import { inventoryPanel } from './inventoryView.js';

const TABS = [
  ['summary', 'Summary'], ['survival', 'Survival'], ['inventory', 'Inventory'], ['equipment', 'Equipment'],
  ['combat', 'Combat'], ['navigation', 'Navigation'], ['tasks', 'Tasks'], ['logs', 'Logs']
];

export const botsPage = {
  title: 'All Bots',
  render() {
    const fleet = bots();
    const online = fleet.filter(botOnline);
    const avgHealth = online.length ? online.reduce((total, bot) => total + (Number(bot.health) || 0), 0) / online.length : 0;
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Fleet', title: 'All Bots', description: 'Live state for every bot in the roster — connection, vitals, assignment and position.',
          actions: `<button class="button" type="button" data-new-task>${icon('plus')} New task</button><button class="button button--primary" type="button" data-command-palette>${icon('terminal')} Command</button>`
        })}
        <div class="card fleet-actions" style="margin-bottom:16px">
          <div class="row gap-2 wrap">
            <strong style="margin-right:6px">Fleet actions</strong>
            <button class="button button--sm" type="button" data-fleet-command="chop oak">${icon('axe')} Chop oak — all</button>
            <button class="button button--sm" type="button" data-fleet-command="mine iron">${icon('pickaxe')} Mine iron — all</button>
            <button class="button button--sm" type="button" data-command="return home all">${icon('home')} Return home</button>
            <button class="button button--sm" type="button" data-command="bot all status">${icon('wifi')} Fleet status</button>
            <span class="grow"></span>
            <span class="tiny muted">One command fans out with bounded concurrency; results are per bot.</span>
          </div>
        </div>
        <div class="grid grid--stats">
          ${statCard({ label: 'Online', value: `${online.length}<small> / ${fleet.length || 10}</small>`, iconName: 'wifi', tone: fleet.length && online.length === fleet.length ? 'success' : online.length ? 'warning' : 'danger', context: `${fleet.filter((bot) => !botOnline(bot)).length} not online` })}
          ${statCard({ label: 'Average health', value: `${avgHealth.toFixed(1)}<small>/20</small>`, iconName: 'heart', tone: avgHealth >= 16 ? 'success' : avgHealth >= 10 ? 'warning' : 'danger', progressValue: avgHealth, progressMax: 20 })}
          ${statCard({ label: 'Active tasks', value: num(tasksForAll().filter((task) => task.status === 'ACTIVE').length), iconName: 'clipboard', tone: 'accent', context: `${num(tasksForAll().filter((task) => task.claimedBy).length)} claimed` })}
          ${statCard({ label: 'Alerts', value: num((overview().alerts || []).length), iconName: 'alert', tone: (overview().alerts || []).length ? 'warning' : 'success', context: 'Derived from live bot and task state' })}
        </div>

        <div class="toolbar card">
          <div class="search-input">${icon('search')}<input class="input" type="search" placeholder="Search bots or activity…" data-fleet-search aria-label="Search bots"></div>
          <select class="select" data-fleet-status aria-label="Filter by connection status">
            <option value="">All statuses</option><option value="online">Online</option><option value="joining">Joining</option><option value="offline">Offline</option>
          </select>
          <select class="select" data-fleet-sort aria-label="Sort bots">
            <option value="roster">Roster order</option><option value="health">Lowest health</option><option value="food">Lowest food</option><option value="name">Name</option>
          </select>
          <span class="grow"></span>
          <span class="tiny muted" data-fleet-count>${fleet.length} bots</span>
        </div>

        <div class="grid grid--bots" data-fleet-grid>
          ${fleet.length ? fleet.map((bot) => {
            const status = botStatus(bot);
            const filter = status.online ? 'online' : status.key === 'joining' || status.key === 'authenticating' ? 'joining' : 'offline';
            return `<div data-fleet-card data-name="${esc(bot.name)}" data-status="${filter}" data-state="${esc(status.key)}" data-health="${bot.health || 0}" data-food="${bot.food || 0}">${botCard(bot)}</div>`;
          }).join('') : `<div class="card">${emptyState('No bots reported', 'The runtime is not exposing bot summaries yet.', 'users')}</div>`}
        </div>
        <div class="card" data-fleet-empty hidden>${emptyState('No bots match', 'Adjust the search or status filter.', 'search')}</div>
      </div>`;
  },
  mount(root) {
    const search = root.querySelector('[data-fleet-search]');
    const status = root.querySelector('[data-fleet-status]');
    const sort = root.querySelector('[data-fleet-sort]');
    const apply = () => applyFleetFilters(root);
    if (search) search.addEventListener('input', apply);
    if (status) status.addEventListener('change', apply);
    if (sort) sort.addEventListener('change', apply);
    applyFleetFilters(root);
  },
  update(root) {
    applyFleetFilters(root);
  }
};

function applyFleetFilters(root) {
  const search = root.querySelector('[data-fleet-search]');
  const status = root.querySelector('[data-fleet-status]');
  const sort = root.querySelector('[data-fleet-sort]');
  const grid = root.querySelector('[data-fleet-grid]');
  const empty = root.querySelector('[data-fleet-empty]');
  const count = root.querySelector('[data-fleet-count]');
  if (!grid) return;
  const cards = [...grid.querySelectorAll('[data-fleet-card]')];
  const query = (search && search.value || '').trim().toLowerCase();
  const filter = status ? status.value : '';
  let visible = 0;
  for (const card of cards) {
    const matchesQuery = !query || card.textContent.toLowerCase().includes(query);
    const matchesStatus = !filter || card.dataset.status === filter;
    const show = matchesQuery && matchesStatus;
    card.hidden = !show;
    if (show) visible++;
  }
  if (count) count.textContent = `${visible} of ${cards.length} bots`;
  if (empty) empty.hidden = visible > 0;
  const mode = sort ? sort.value : 'roster';
  const ordered = [...cards].sort((a, b) => {
    if (mode === 'health') return Number(a.dataset.health) - Number(b.dataset.health);
    if (mode === 'food') return Number(a.dataset.food) - Number(b.dataset.food);
    if (mode === 'name') return a.dataset.name.localeCompare(b.dataset.name);
    return 0;
  });
  if (mode !== 'roster') for (const card of ordered) grid.appendChild(card);
}

function tasksForAll() {
  return (state.snapshot && state.snapshot.taskManager && state.snapshot.taskManager.tasks) || [];
}

function profilePageRender({ params }) {
  const name = params[0];
  const tab = params[1] || 'summary';
  const bot = getBot(name);
  if (!bot) {
    return `<div class="page">${pageHeader({ eyebrow: 'Fleet', title: 'Bot not found', description: `No bot named “${name}” is present in the current runtime snapshot.` })}<div class="card">${emptyState('Unknown bot', 'Check the roster in Settings or return to the fleet list.', 'user', '<a class="button button--primary" href="#/bots">Back to fleet</a>')}</div></div>`;
  }
  const team = teamMember(name);
  const actions = actionsFor(name) || {};
  return `
    <div class="page">
      <div class="profile-head card">
        ${botAvatar(name, 'avatar--lg')}
        <div class="profile-identity">
          <div class="profile-name">${esc(name)} ${botStatusBadge(bot)}</div>
          <div class="profile-sub">${esc(team ? team.role : 'IDLE')} · ${esc(team && team.assignment ? team.assignment : bot.activity || 'idle')} · joined ${team && team.uptimeMs ? esc(duration(team.uptimeMs)) : '—'}</div>
          <div class="meta-list">
            <span>${icon('map')} ${esc(positionText(bot.position))}</span>
            <span>${icon('globe')} ${esc(bot.dimension || 'overworld')}</span>
            <span>${icon('clock')} ${bot.uptimeMs ? esc(duration(bot.uptimeMs)) : 'uptime unavailable'}</span>
            <span>${icon('skull')} ${num(bot.deaths || 0)} deaths</span>
          </div>
        </div>
        <div class="profile-actions">
          <button class="button" type="button" data-command="eat ${esc(name)}">${icon('heart')} Eat</button>
          <button class="button" type="button" data-command="defend ${esc(name)}">${icon('shield')} Defend</button>
          <button class="button" type="button" data-command="bot ${esc(name)} come">${icon('home')} Recall</button>
          ${botMenu(name)}
        </div>
      </div>

      <div class="tabs" role="tablist">
        ${TABS.map(([key, label]) => `<a class="tab${tab === key ? ' is-active' : ''}" href="#/bots/${encodeURIComponent(name)}/${key}" role="tab" aria-selected="${tab === key}">${label}</a>`).join('')}
      </div>

      ${renderProfileTab(tab, bot, actions, team, name)}
    </div>`;
}

function renderProfileTab(tab, bot, actions, team, name) {
  switch (tab) {
    case 'survival': return profileSurvival(bot, actions, name);
    case 'inventory': return profileInventory(bot, name);
    case 'equipment': return profileEquipment(bot);
    case 'combat': return profileCombat(bot, actions, name);
    case 'navigation': return profileNavigation(bot, actions, name);
    case 'tasks': return profileTasks(name, team);
    case 'logs': return profileLogs(bot, name);
    default: return profileSummary(bot, actions, team, name);
  }
}

export const profilePage = {
  title: 'Bot Profile',
  render: profilePageRender
};

function profileSummary(bot, actions, team, name) {
  const alerts = botAlerts(name);
  return `
    <div class="grid grid--stats">
      ${miniStat('Health', `${bot.health ?? '—'}/20`, bot.health / 20, healthTone(bot.health), 'heart')}
      ${miniStat('Food', `${bot.food ?? '—'}/20`, bot.food / 20, healthTone(bot.food), 'sprout')}
      ${miniStat('Armour', `${bot.armor ?? 0}/20`, (bot.armor || 0) / 20, 'info', 'shield')}
      ${miniStat('Threats', num(bot.threats || 0), (bot.threats || 0) > 0 ? 1 : 0, (bot.threats || 0) > 0 ? 'danger' : 'success', 'sword')}
      ${miniStat('Saturation', (bot.saturation ?? '—'), (bot.saturation || 0) / 20, 'neutral', 'droplet')}
      ${miniStat('Oxygen', (bot.oxygen ?? '—'), (bot.oxygen || 0) / 20, 'info', 'wind')}
    </div>
    <div class="grid grid--main-side" style="margin-top:16px">
      <div class="stack gap-4">
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('activity')} Current operation</div>${badge(team ? team.status : 'UNKNOWN', team && team.status === 'ONLINE' ? 'ok' : 'neutral')}</div>
          <div class="card-body">
            ${kvRows([
              ['Role', esc(team ? team.role : '—')],
              ['Assignment', esc(team && team.assignment ? team.assignment : '—')],
              ['Task', esc(team && team.task ? team.task : bot.currentTaskId || '—')],
              ['Activity', esc(bot.activity || 'idle')],
              ['Detail', esc(bot.activityDetail || '—')],
              ['Last update', bot.lastUpdate ? esc(timeAgo(bot.lastUpdate)) : '—']
            ])}
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('wifi')} Connection</div>${botStatusBadge(bot)}</div>
          <div class="card-body">
            ${(() => {
              const status = botStatus(bot);
              const manualAuth = bot.authPending === true || bot.authRequiredManual === true;
              const lastPacket = Number.isFinite(bot.lastEventAgeMs)
                ? `${Math.max(0, Math.round(bot.lastEventAgeMs / 1000))}s ago`
                : bot.lastEventAt ? timeAgo(bot.lastEventAt) : '—';
              return kvRows([
                ['Overall status', badge(status.label, status.tone), true],
                ['Transport', bot.transportConnected === true || bot.connected === true ? badge('Connected', 'ok') : badge('Closed', 'danger')],
                ['Server player list', bot.serverPlayerListed === true ? badge('Listed', 'ok') : badge('Not listed', 'neutral')],
                ['Spawned in world', bot.spawned === true ? badge('Yes', 'ok') : badge('No', 'warn')],
                ['Manual auth', manualAuth ? badge('Required', 'danger') : badge('Not required', 'ok')],
                ['Authenticated', manualAuth ? badge('Blocked', 'danger') : bot.authenticated === true ? badge('Yes', 'ok') : status.key === 'auth_failed' ? badge('No', 'danger') : badge('Pending', 'warn')],
                ['Gameplay ready', bot.gameplayReady === true ? badge('Yes', 'ok') : badge('No', 'neutral')],
                ['Last packet', esc(lastPacket)],
                ['Dimension', esc(bot.dimension || '—')],
                ['Position', esc(positionText(bot.position)), true],
                ['Deaths', num(bot.deaths || 0)]
              ], { htmlValues: true });
            })()}
            <div class="row gap-2" style="margin-top:12px">
              <button class="button" type="button" data-bot-action="reconnect" data-bot="${esc(name)}">${icon('refresh')} Reconnect</button>
              <button class="button button--danger" type="button" data-bot-action="disconnect" data-bot="${esc(name)}" data-confirm="true">${icon('wifi-off')} Disconnect</button>
            </div>
          </div>
        </section>
      </div>
      <aside class="stack gap-4">
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('alert')} Alerts</div>${badge(`${alerts.length}`, alerts.length ? 'warn' : 'ok')}</div>
          <div class="card-body card-body--tight">${alerts.length ? alertsBlock(alerts, { limit: 8 }) : `<div class="list-item">${icon('check-circle')}<div class="list-main"><div class="list-title">No alerts</div><div class="list-sub">This bot is within all monitored thresholds.</div></div></div>`}</div>
        </section>
        ${deathPanel(name)}
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('zap')} Effects</div></div>
          <div class="card-body">${(bot.effects || []).length ? `<div class="chips">${bot.effects.map((effect) => `<span class="chip">${esc(typeof effect === 'string' ? effect : effect.name || effect.id)} ${effect.duration ? `· ${Math.round(effect.duration / 1000)}s` : ''}</span>`).join('')}</div>` : '<div class="muted small">No active status effects.</div>'}</div>
        </section>
      </aside>
    </div>`;
}

function deathPanel(name) {
  const recovery = ((state.snapshot && state.snapshot.recovery) || []).find((entry) => entry.bot === name);
  if (!recovery) {
    return `<section class="card"><div class="card-header"><div class="card-title">${icon('alert')} Death diagnostics</div></div><div class="card-body"><div class="muted small">The recovery monitor has not reported for this bot yet.</div></div></section>`;
  }
  const last = recovery.lastDeath || null;
  const spawn = recovery.spawnSafety;
  return `<section class="card">
    <div class="card-header"><div class="card-title">${icon('alert')} Death diagnostics</div>${badge(recovery.state, recovery.state === 'ACTIVE' ? 'ok' : recovery.deathLoop ? 'danger' : 'warn')}</div>
    <div class="card-body">
      ${kvRows([
        ['Recovery state', esc(recovery.reason || recovery.state)],
        ['Deaths (2m / 10m)', `${num(recovery.deathsRecent)} / ${num(recovery.deathsLong)}`],
        ['Death loop', recovery.deathLoop ? badge('Detected', 'danger') : badge('No', 'ok')],
        ['Last cause', last ? `${esc(last.cause)} ${badge(last.confidence || 'unknown', last.confidence === 'confirmed' ? 'ok' : last.confidence === 'likely' ? 'warn' : 'neutral')}` : '—'],
        ['Last position', esc(last && last.position ? positionText(last.position) : '—'), true],
        ['Last health / food', last ? `${last.healthBefore ?? '—'} / ${last.food ?? '—'}` : '—'],
        ['Task at death', esc(last && last.task ? (last.task.label || last.task.type || last.task.id || '—') : '—')],
        ['Hazards', esc(last && last.environment && last.environment.hazards && last.environment.hazards.length ? last.environment.hazards.join(', ') : 'none detected')],
        ['Equipment', esc(last && last.equipment ? [last.equipment.held, ...(last.equipment.armor || []).map((piece) => piece.item || piece)].filter(Boolean).join(', ') || 'none' : '—')],
        ['Death message', esc(last && last.deathMessage ? last.deathMessage : '—')],
        ['Spawn safety', spawn ? (spawn.safe ? badge('Safe', 'ok') : badge(`Unsafe — ${spawn.reasons.join(', ')}`, 'danger')) : 'not assessed']
      ], { htmlValues: true })}
      ${recovery.deaths && recovery.deaths.length ? `<div class="divider"></div><div class="tiny muted">Recent deaths</div><div class="death-list">${recovery.deaths.slice(-3).reverse().map((death) => `<div class="death-row"><span class="mono tiny">${esc(new Date(death.at).toLocaleTimeString())}</span><span>${esc(death.cause)}</span><span class="mono tiny">${death.position ? esc(positionText(death.position)) : ''}</span></div>`).join('')}</div>` : ''}
    </div>
  </section>`;
}

function miniStat(label, value, ratio, tone, iconName) {
  return `<div class="card mini-stat">
    <div class="mini-stat-head"><span>${icon(iconName)} ${esc(label)}</span></div>
    <div class="mini-stat-value">${esc(String(value))}</div>
    ${progress(clamp(ratio * 100, 0, 100), 100, { sm: true, tone: tone === 'neutral' ? null : tone })}
  </div>`;
}

function profileSurvival(bot, actions, name) {
  const survival = actions.survival;
  if (!survival) return `<div class="card">${emptyState('Survival telemetry unavailable', 'The survival action has not reported for this bot yet.', 'heart')}</div>`;
  return `
    <div class="grid grid--main-side">
      <div class="stack gap-4">
        <section class="card">
          <div class="card-header"><div class="card-title">Vitals</div>${badge(survival.needsFood ? `Needs ${survival.needsFood}` : 'Stable', survival.needsFood ? 'warn' : 'ok')}</div>
          <div class="card-body">
            <div class="vital-row"><span>${icon('heart')} Health</span><strong>${survival.health}/20</strong></div>${progress(survival.health, 20, { tone: healthTone(survival.health) })}
            <div class="vital-row"><span>${icon('sprout')} Food</span><strong>${survival.food}/20</strong></div>${progress(survival.food, 20, { tone: healthTone(survival.food) })}
            <div class="vital-row"><span>${icon('droplet')} Saturation</span><strong>${survival.saturation}</strong></div>${progress(survival.saturation, 20, { tone: 'info' })}
            <div class="vital-row"><span>${icon('shield')} Armour</span><strong>${survival.armour}/20</strong></div>${progress(survival.armour, 20, { tone: 'info' })}
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div class="card-title">Gear and environment</div></div>
          <div class="card-body">
            ${kvRows([
              ['Best food', esc(survival.bestFood ? `${humanize(survival.bestFood.name)} ×${survival.foodCount}` : '—')],
              ['Pickaxe', esc(survival.pickaxe ? survival.pickaxe.name : '—')],
              ['Sword', esc(survival.sword ? survival.sword.name : '—')],
              ['Shield', survival.hasShield ? badge('Equipped', 'ok') : badge('Missing', 'neutral')],
              ['In lava', survival.inLava ? badge('Yes', 'danger') : 'No'],
              ['In water', survival.inWater ? 'Yes' : 'No'],
              ['On fire', survival.onFire ? badge('Yes', 'danger') : 'No'],
              ['Last action', esc(survival.lastAction || '—')]
            ], { htmlValues: true })}
          </div>
        </section>
      </div>
      <aside class="stack gap-4">
        <section class="card">
          <div class="card-header"><div class="card-title">Automation</div></div>
          <div class="card-body">
            <div class="toggle-list">
              ${survivalToggleRows(name, survival)}
              ${toggleRow('Environmental safety', 'Lava, fire, water and fall clutches are always armed.', 'wind')}
            </div>
            <div class="callout callout--info" style="margin-top:12px">${icon('info')}<div>Toggles call the <span class="mono">survival</span> command for this bot and apply on the next autonomy tick. Environmental safety cannot be disabled.</div></div>
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div class="card-title">Counters</div></div>
          <div class="card-body">${kvRows(Object.entries(survival.stats || {}).map(([key, value]) => [humanize(key), num(value)]))}</div>
        </section>
        <button class="button" type="button" data-command="eat ${esc(name)}">${icon('heart')} Eat now</button>
      </aside>
    </div>`;
}

const SURVIVAL_TOGGLES = [
  ['eat', 'Auto eat', 'Consumes the best available food when hunger drops.', 'eat'],
  ['armour', 'Auto armour', 'Equips the best armour pieces from inventory.', 'shield'],
  ['tools', 'Auto tools', 'Checks for a usable pickaxe, axe and sword.', 'wrench'],
  ['crafting', 'Crafting', 'Crafts missing tools and supplies when possible.', 'hammer'],
  ['healing', 'Healing', 'Uses emergency healing when health is critical.', 'heart'],
  ['shield', 'Shield', 'Raises a shield when badly hurt.', 'shield']
];

function survivalToggleRows(name, survival) {
  return SURVIVAL_TOGGLES.map(([key, label, description, iconName]) => {
    const enabled = survival.features ? Boolean(survival.features[key]) : true;
    return `<div class="toggle-row">
      <span class="toggle-icon">${icon(iconName)}</span>
      <div><div class="toggle-label">${esc(label)}</div><div class="toggle-desc">${esc(description)}</div></div>
      <button class="switch${enabled ? ' is-on' : ''}" type="button" role="switch" aria-checked="${enabled}" aria-label="${esc(label)} for ${esc(name)}" data-command="survival ${esc(name)} ${key} ${enabled ? 'off' : 'on'}" data-success-title="${esc(label)} ${enabled ? 'disabled' : 'enabled'}"><span aria-hidden="true"></span></button>
    </div>`;
  }).join('');
}

function toggleRow(label, description, iconName) {
  return `<div class="toggle-row">
    <span class="toggle-icon">${icon(iconName)}</span>
    <div><div class="toggle-label">${esc(label)}</div><div class="toggle-desc">${esc(description)}</div></div>
    <span class="badge badge--outline">Backend routine</span>
  </div>`;
}

function profileInventory(bot, name) {
  return `
    <section class="card">
      <div class="card-header"><div class="card-title">${icon('package')} Inventory</div>${badge(`${num(bot.inventorySlots || Object.keys(bot.inventory || {}).length)} stacks`, 'neutral')}</div>
      <div class="card-body">${inventoryPanel(name)}</div>
    </section>
    <section class="card" style="margin-top:16px">
      <div class="card-header"><div class="card-title">${icon('layers')} Equipment slots</div><a class="tiny muted" href="#/bots/${encodeURIComponent(name)}/equipment">Open equipment</a></div>
      <div class="card-body">${equipmentGrid(bot)}</div>
    </section>`;
}

function equipmentGrid(bot) {
  const equipment = Object.entries(bot.equipment || {});
  if (!equipment.length) return emptyState('No equipment', 'The adapter reports no equipped items.', 'shield');
  return `<div class="slot-grid">${equipment.map(([slot, item]) => `<div class="slot"><span class="slot-label">${esc(humanize(slot))}</span><strong>${esc(item ? (typeof item === 'string' ? humanize(item) : item.name || '—') : '—')}</strong></div>`).join('')}</div>`;
}

function profileEquipment(bot) {
  const inventory = actionsFor(bot.name) && actionsFor(bot.name).inventory;
  const tools = (inventory && inventory.tools) || [];
  const best = (inventory && inventory.bestTools) || {};
  return `
    <div class="grid grid--main-side">
      <section class="card">
        <div class="card-header"><div class="card-title">${icon('shield')} Equipped</div></div>
        <div class="card-body">${equipmentGrid(bot)}</div>
      </section>
      <section class="card">
        <div class="card-header"><div class="card-title">${icon('wrench')} Best available tools</div></div>
        <div class="card-body">
          ${Object.keys(best).length ? kvRows(Object.entries(best).map(([key, value]) => [humanize(key), esc(value ? (typeof value === 'string' ? humanize(value) : value.name || '—') : '—')])) : '<div class="muted small">The inventory action reports no best-tool analysis yet.</div>'}
          ${tools.length ? `<div class="divider"></div><div class="tiny muted">${num(tools.length)} tool stacks in inventory</div>` : ''}
        </div>
      </section>
    </div>`;
}

function profileCombat(bot, actions, name) {
  const combat = actions.combat;
  if (!combat) return `<div class="card">${emptyState('Combat telemetry unavailable', 'The combat action has not reported for this bot.', 'sword')}</div>`;
  return `
    <div class="grid grid--stats">
      ${miniStat('Health', `${combat.health}/20`, combat.health / 20, healthTone(combat.health), 'heart')}
      ${miniStat('Threats', num(combat.threats), combat.threats > 0 ? 1 : 0, combat.threats ? 'danger' : 'success', 'alert')}
      ${miniStat('Kills', num(combat.stats && combat.stats.kills), 0, 'neutral', 'skull')}
      ${miniStat('Attacks', num(combat.stats && combat.stats.attacks), 0, 'neutral', 'sword')}
      ${miniStat('Retreats', num(combat.stats && combat.stats.retreats), 0, 'neutral', 'arrow-left')}
      ${miniStat('Assessments', num(combat.stats && combat.stats.threatAssessments), 0, 'neutral', 'eye')}
    </div>
    <div class="grid grid--main-side" style="margin-top:16px">
      <section class="card">
        <div class="card-header"><div class="card-title">${icon('shield')} Loadout</div>${combat.pvpEnabled ? badge('PVP enabled', 'warn') : badge('PVE only', 'info')}</div>
        <div class="card-body">
          ${kvRows([
            ['Sword', esc(combat.sword ? `${humanize(combat.sword.name)} (tier ${combat.sword.tier})` : '—')],
            ['Shield', combat.shield ? badge('Equipped', 'ok') : badge('Missing', 'neutral')],
            ['Nearest threat', esc(combat.nearestThreat ? `${combat.nearestThreat.name || combat.nearestThreat.type || 'hostile'} · ${combat.nearestThreat.distance ?? '?'}m` : 'None detected')],
            ['Last action', esc(combat.lastAction || '—')]
          ], { htmlValues: true })}
        </div>
      </section>
      <aside class="stack gap-4">
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('sliders')} Retreat thresholds</div></div>
          <div class="card-body">
            <div class="callout callout--info">${icon('info')}<div>Thresholds are configured in <span class="mono">src/config.js</span> and enforced by the combat action. The running values are not exposed by the status API, so they are not shown as editable fields.</div></div>
            ${kvRows([['PVP', combat.pvpEnabled ? 'Enabled by config' : 'Disabled by config'], ['Detection', 'Live threat scan'], ['Shield', combat.shield ? 'Equipped' : 'Not equipped']])}
          </div>
        </section>
        <button class="button button--danger" type="button" data-command="defend ${esc(name)}" data-danger="true" data-confirm-title="Engage defence" data-confirm-message="Send ${esc(name)} to defend the team?">${icon('shield')} Engage defence</button>
      </aside>
    </div>`;
}

function profileNavigation(bot, actions, name) {
  const exploration = actions.exploration;
  const sleep = actions.sleep;
  return `
    <div class="grid grid--main-side">
      <div class="stack gap-4">
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('map')} Position</div><a class="tiny muted" href="#/exploration">Exploration</a></div>
          <div class="card-body">
            ${kvRows([
              ['X', bot.position ? num(Math.round(bot.position.x)) : '—', true],
              ['Y', bot.position ? num(Math.round(bot.position.y)) : '—', true],
              ['Z', bot.position ? num(Math.round(bot.position.z)) : '—', true],
              ['Dimension', esc(bot.dimension || '—')],
              ['Yaw', bot.yaw !== undefined ? `${Math.round(bot.yaw)}°` : '—'],
              ['Home base', exploration && exploration.home ? `${exploration.home.x}, ${exploration.home.y}, ${exploration.home.z}` : '—', true]
            ])}
            <div class="row gap-2" style="margin-top:12px">
              <button class="button" type="button" data-command="bot ${esc(name)} come">${icon('home')} Return home</button>
              <button class="button" type="button" data-command="explore ${esc(name)}">${icon('compass')} Explore</button>
            </div>
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('compass')} Exploration state</div></div>
          <div class="card-body">${exploration ? kvRows([
            ['Radius', `${exploration.radius} blocks`],
            ['Waypoint', `${exploration.waypointIndex} / ${exploration.stats ? exploration.stats.waypoints : 0}`],
            ['Night', exploration.night ? 'Yes' : 'No'],
            ['Discoveries', num((exploration.discoveries || []).length)],
            ['Distance travelled', num(exploration.stats && exploration.stats.distance)]
          ]) : '<div class="muted small">No exploration status reported.</div>'}</div>
        </section>
      </div>
      <aside class="stack gap-4">
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('bed')} Rest</div></div>
          <div class="card-body">${sleep ? kvRows([
            ['World time', num(sleep.time)],
            ['Night', sleep.night ? 'Yes' : 'No'],
            ['Sleeping', sleep.sleeping ? 'Yes' : 'No'],
            ['Bed reservation', sleep.reservation ? esc(sleep.reservation.bed || sleep.reservation.id || 'reserved') : 'None'],
            ['Nearby beds', num((sleep.nearbyBeds || []).length)],
            ['Bed item', sleep.hasBedItem ? 'Yes' : 'No']
          ]) : '<div class="muted small">No sleep status reported.</div>'}
          <button class="button" type="button" style="margin-top:12px" data-command="sleep ${esc(name)}">${icon('bed')} Sleep now</button></div>
        </section>
      </aside>
    </div>`;
}

function profileTasks(name, team) {
  const tasks = tasksFor(name);
  return `
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div class="muted small">Tasks currently claimed by ${esc(name)}${team && team.assignment ? ` · assignment ${esc(team.assignment)}` : ''}</div>
      <button class="button" type="button" data-new-task>${icon('plus')} New task</button>
    </div>
    ${tasks.length ? `<div class="grid grid--2">${tasks.map((task) => `<div class="card card--pad">${taskCard(task)}</div>`).join('')}</div>` : `<div class="card">${emptyState('No tasks', 'This bot has no claimed tasks. Assign one from the task manager.', 'clipboard', '<a class="button" href="#/tasks">Open task manager</a>')}</div>`}`;
}

function profileLogs(bot, name) {
  const logs = state.logs.filter((log) => log.msg.includes(name) || log.scope.includes(name) || log.meta && log.meta.bot === name);
  return `
    <section class="card">
      <div class="card-header"><div class="card-title">${icon('list')} Bot log</div>${badge(`${logs.length} entries`, 'neutral')}</div>
      <div class="log-list">${logs.length ? logs.slice().reverse().slice(0, 120).map((log) => `<div class="log-line"><span class="log-time mono">${formatTime(log.ts)}</span><span class="log-level log-level--${log.level}">${esc(log.level)}</span><span class="log-scope mono">${esc(log.scope)}</span><span class="log-msg">${esc(log.msg)}</span></div>`).join('') : emptyState('No entries for this bot', 'Logs are captured from the live backend logger.', 'list')}</div>
    </section>`;
}

export const profilesPage = {
  title: 'Bot Profiles',
  render() {
    const fleet = bots();
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Fleet', title: 'Bot Profiles', description: 'A directory of every bot profile. Open a bot for its full survival, inventory, combat, navigation, task and log views.',
          actions: `<a class="button" href="#/bots">${icon('users')} All bots</a><a class="button button--primary" href="#/team">${icon('crown')} Team</a>`
        })}
        <div class="grid grid--bots">
          ${fleet.length ? fleet.map((bot) => {
            const team = teamMember(bot.name);
            const name = bot.name;
            const role = team ? team.role : 'IDLE';
            return `<section class="card card--pad">
              <div class="row gap-3" style="align-items:flex-start">
                ${botAvatar(name, 'avatar--lg')}
                <div class="grow">
                  <div class="profile-name" style="font-size:var(--text-md)">${esc(name)} ${botStatusBadge(bot)}</div>
                  <div class="tiny muted" style="margin-top:3px">${esc(role)} · ${esc(bot.activity || 'idle')}</div>
                </div>
              </div>
              <div class="vital-row"><span>${icon('heart')} Health</span><strong>${num(bot.health ?? 0)}/20</strong></div>
              ${progress(clamp((Number(bot.health) || 0) / 20 * 100, 0, 100), 100, { sm: true, tone: healthTone(bot.health) })}
              <div class="vital-row"><span>${icon('sprout')} Food</span><strong>${num(bot.food ?? 0)}/20</strong></div>
              ${progress(clamp((Number(bot.food) || 0) / 20 * 100, 0, 100), 100, { sm: true, tone: healthTone(bot.food) })}
              <div class="meta-list" style="margin-top:10px">
                <span>${icon('map')} ${esc(positionText(bot.position))}</span>
                <span>${icon('globe')} ${esc(bot.dimension || 'overworld')}</span>
                <span>${icon('clipboard')} ${num(tasksFor(name).length)} tasks</span>
              </div>
              <div class="row gap-2" style="margin-top:12px">
                <a class="button button--sm button--primary" href="#/bots/${encodeURIComponent(name)}">${icon('user')} Open profile</a>
                <a class="button button--sm" href="#/bots/${encodeURIComponent(name)}/inventory">Inventory</a>
                <a class="button button--sm" href="#/bots/${encodeURIComponent(name)}/logs">Logs</a>
              </div>
            </section>`;
          }).join('') : `<div class="card">${emptyState('No profiles', 'The runtime has not reported any bots yet.', 'users')}</div>`}
        </div>
      </div>`;
  }
};

export const teamPage = {
  title: 'Team Management',
  render() {
    const team = teamState();
    const stateTeam = (team && team.team) || {};
    const members = (team && team.bots) || [];
    const tasks = tasksForAll();
    const objectives = (state.snapshot && state.snapshot.taskManager && state.snapshot.taskManager.objectives) || [];
    const ledger = (state.snapshot && state.snapshot.inventory && state.snapshot.inventory.ledger) || {};
    const leader = stateTeam.leader || overview().leader;
    const formations = ['FOLLOW', 'COMPACT', 'DEFENSIVE', 'EXPLORATION', 'MINING', 'FISHING', 'BUILDING', 'RETREAT', 'REGROUP'];
    const counts = tasks.reduce((acc, task) => { acc[task.status] = (acc[task.status] || 0) + 1; return acc; }, {});
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Fleet', title: 'Team Management', description: 'Leadership, formation, objectives and the shared task board — all sourced from the coordinator.',
          actions: `<button class="button" type="button" data-new-objective>${icon('target')} New objective</button><button class="button" type="button" data-new-task>${icon('plus')} Create task</button><a class="button button--primary" href="#/tasks">${icon('clipboard')} Task manager</a>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Leader', value: leader ? esc(leader) : 'Not elected', iconName: 'crown', tone: leader ? 'accent' : 'warning', context: `Formation ${esc(stateTeam.formation || '—')}` })}
          ${statCard({ label: 'Team online', value: `${stateTeam.online ?? members.filter((m) => m.online).length}<small> / ${members.length || 10}</small>`, iconName: 'users', tone: members.length && (stateTeam.online ?? members.filter((m) => m.online).length) === members.length ? 'success' : 'warning', context: `${num(members.filter((m) => m.emergency).length)} emergencies` })}
          ${statCard({ label: 'Task board', value: num(tasks.length), iconName: 'clipboard', tone: 'accent', context: `${num(counts.ACTIVE || 0)} active · ${num(counts.PENDING || 0)} pending · ${num(counts.FAILED || 0)} failed` })}
          ${statCard({ label: 'Locks / regions', value: `${num(stateTeam.separation ? Object.keys(stateTeam.separation).length : 0)}<small> sep</small>`, iconName: 'lock', tone: 'neutral', context: `${num((state.snapshot && state.snapshot.team && state.snapshot.team.locks || []).length)} locks · ${num((state.snapshot && state.snapshot.team && state.snapshot.team.deadlocks || []).length)} deadlocks` })}
        </div>

        <div class="grid grid--main-side">
          <div class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('crown')} Formation</div><span class="badge badge--accent">${esc(stateTeam.formation || '—')}</span></div>
              <div class="card-body">
                <div class="segmented" role="group" aria-label="Team formation">
                  ${formations.map((formation) => `<button class="segmented-item${formation === stateTeam.formation ? ' is-active' : ''}" type="button" data-command="team formation ${formation.toLowerCase()}">${humanize(formation)}</button>`).join('')}
                </div>
                <p class="tiny muted" style="margin:10px 0 0">Changing formation moves the coordinator's slot assignment on the next tick.</p>
              </div>
            </section>

            <section class="card">
              <div class="card-header"><div class="card-title">${icon('users')} Members</div><span class="tiny muted">${members.length} reported</span></div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Bot</th><th>Status</th><th>Role</th><th>Assignment</th><th>Health</th><th>Task</th><th></th></tr></thead>
                  <tbody>
                    ${members.length ? members.map((member) => `
                      <tr>
                        <td><a class="link" href="#/bots/${encodeURIComponent(member.name)}">${esc(member.name)}</a>${member.name === leader ? ` ${badge('leader', 'accent')}` : ''}</td>
                        <td>${badge(member.status || (member.online ? 'ONLINE' : 'OFFLINE'), member.online ? 'ok' : ['JOINING', 'AUTHENTICATING', 'NOT_READY'].includes(member.status) ? 'warn' : 'danger', { dot: true })}</td>
                        <td>${esc(member.role)}</td>
                        <td class="truncate" style="max-width:160px">${esc(member.assignment || '—')}</td>
                        <td>${miniBar(member.health, 20)}</td>
                        <td class="mono tiny">${esc(member.task || '—')}</td>
                        <td><a class="button button--sm button--ghost" href="#/bots/${encodeURIComponent(member.name)}" aria-label="Open ${esc(member.name)}">${icon('arrow-up-right')}</a></td>
                      </tr>`).join('') : `<tr><td colspan="7">${emptyState('No team state', 'The coordinator has not published members.', 'users')}</td></tr>`}
                  </tbody>
                </table>
              </div>
            </section>

            <section class="card">
              <div class="card-header"><div class="card-title">${icon('target')} Objectives</div><span class="tiny muted">${objectives.length}</span></div>
              <div class="card-body">
                ${objectives.length ? objectives.map((objective) => `
                  <div class="objective-row">
                    <div class="objective-main">
                      <div><strong>${esc(objective.title)}</strong> ${badge(objective.status, objective.status === 'ACTIVE' ? 'accent' : objective.status === 'COMPLETED' ? 'ok' : 'neutral')}</div>
                      <div class="tiny muted">${objective.progress ? `${num(objective.progress.current)} / ${num(objective.progress.target)} ${esc(objective.progress.unit || '')}` : 'No progress counter'}</div>
                    </div>
                    ${objective.progress && objective.progress.target ? progress((objective.progress.current / objective.progress.target) * 100, 100, { sm: true, tone: 'accent' }) : ''}
                  </div>`).join('') : emptyState('No objectives', 'Objectives are created by the coordinator when the team plans work.', 'target')}
              </div>
            </section>

            <section>
              ${sectionHead('Task board', { subtitle: 'Planned · Ready · In progress · Blocked · Completed · Failed', actions: `<button class="button button--sm" type="button" data-new-task>${icon('plus')} New</button>` })}
              ${taskColumns(tasks)}
            </section>
          </div>

          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('box')} Resource ledger</div><a class="tiny muted" href="#/inventory">Inventory</a></div>
              <div class="card-body card-body--tight">
                ${(ledger.rows || []).length ? `<div class="ledger-list">${ledger.rows.slice(0, 12).map((row) => `<div class="ledger-row"><span>${esc(humanize(row.item))}</span><span class="mono">${num(row.available)}</span>${badge(row.status, row.status === 'OK' ? 'ok' : row.status === 'DEFICIT' ? 'warn' : row.status === 'CRITICAL' ? 'danger' : 'neutral')}</div>`).join('')}</div>` : emptyState('Ledger empty', 'No resource rows reported.', 'box')}
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('database')} Shared memory</div></div>
              <div class="card-body">
                ${kvRows([
                  ['Observations', num(state.snapshot && state.snapshot.team && state.snapshot.team.memory && state.snapshot.team.memory.stats ? state.snapshot.team.memory.stats.total : 0)],
                  ['Facts', num(state.snapshot && state.snapshot.team && state.snapshot.team.memory ? (state.snapshot.team.memory.facts || []).length : 0)],
                  ['Locks', num((state.snapshot && state.snapshot.team && state.snapshot.team.locks || []).length)],
                  ['Regions', num((state.snapshot && state.snapshot.team && state.snapshot.team.regions || []).length)],
                  ['Deadlocks', num((state.snapshot && state.snapshot.team && state.snapshot.team.deadlocks || []).length)]
                ])}
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('message')} Team comms</div></div>
              <div class="activity-list">
                ${((state.snapshot && state.snapshot.team && state.snapshot.team.comms) || []).slice(-8).reverse().map((message) => `<div class="activity-item"><span class="activity-icon">${icon('message')}</span><div class="activity-main"><div>${esc(message.type || 'message')}</div><div class="mono">${esc(message.meta && message.meta.from || '—')} · ${formatTime(message.at)}</div></div></div>`).join('') || '<div class="muted small" style="padding:8px">No team messages yet.</div>'}
              </div>
            </section>
          </aside>
        </div>
      </div>`;
  }
};

function miniBar(value, max) {
  return `<div style="min-width:70px">${progress(value || 0, max, { sm: true, tone: healthTone(value) })}</div>`;
}

export const connectionsPage = {
  title: 'Connection Management',
  render() {
    const diagnostics = (state.snapshot && state.snapshot.diagnostics) || {};
    const config = diagnostics.config || {};
    const rows = diagnostics.bots || [];
    const lifecycleRows = rows.filter((row) => row.connection && row.connection.generation > 0);
    const runtime = diagnostics.runtime || {};
    const fleet = bots();
    const server = config.server || {};
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Fleet', title: 'Connection Management', description: 'Inspect authentication, spawn state and connection errors for each bot, then reconnect or disconnect individual sessions.',
          actions: `<a class="button" href="/api/diagnostics/export" download>${icon('download')} Export diagnostics</a><button class="button" type="button" id="reconnect-all">${icon('refresh')} Reconnect all</button><button class="button button--primary" type="button" data-command-palette>${icon('terminal')} Command</button>`
        })}
        ${server.versionError ? `<div class="callout callout--danger">${icon('alert')}<div><strong>Server version unresolved.</strong> <span class="mono">${esc(server.versionError)}</span> No bot login sockets are opened until a valid version is resolved.</div></div>` : ''}
        <div class="callout callout--info">${icon('shield')}<div><strong>Connection gate.</strong> The runtime currently reports <span class="mono">${runtime.autonomyAllowed ? 'autonomy allowed' : 'autonomy gated'}</span>. Bots use <span class="mono">${esc(((config.server && config.server.joinIntervalMs) ?? 0) / 1000)}s</span> artificial join spacing, at <span class="mono">${esc(server.host || '—')}:${esc(server.port || '—')}</span> (${esc(server.resolvedVersion || server.version || 'version unknown')}). Reconnect and disconnect are real runtime actions.</div></div>
        <div class="grid grid--stats">
          ${statCard({ label: 'Configured roster', value: num((config.roster || []).length || 10), iconName: 'users', tone: 'neutral', context: 'Fixed usernames from config' })}
          ${statCard({ label: 'Gameplay ready', value: `${num(rows.filter((bot) => bot.ready || bot.gameplayReady).length)}<small> / ${rows.length}</small>`, iconName: 'check-circle', tone: rows.length && rows.every((bot) => bot.ready || bot.gameplayReady) ? 'success' : 'warning', context: 'Online is counted separately from gameplay readiness' })}
          ${statCard({ label: 'Auth failures', value: num(rows.filter((bot) => bot.status === 'auth_failed').length), iconName: 'key', tone: rows.some((bot) => bot.status === 'auth_failed') ? 'warning' : 'success', context: 'Password rejected or timed out' })}
          ${statCard({ label: 'Errors reported', value: num(rows.filter((bot) => bot.lastError).length), iconName: 'alert', tone: rows.some((bot) => bot.lastError) ? 'danger' : 'success', context: 'Latest adapter error per bot' })}
        </div>
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('wifi')} Bot sessions</div><span class="tiny muted">Mode ${esc(state.snapshot && state.snapshot.mode || '—')}</span></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Bot</th><th>Connection</th><th>Authenticated</th><th>Spawned</th><th>Position</th><th>Uptime</th><th>Last error</th><th>Actions</th></tr></thead>
              <tbody>${fleet.map((bot) => {
                const diag = rows.find((row) => row.name === bot.name) || {};
                const status = connectionLabel(bot);
                return `<tr>
                  <td><a class="link" href="#/bots/${encodeURIComponent(bot.name)}">${esc(bot.name)}</a></td>
                  <td><span class="status">${statusDotFor(status)}${badge(status.label, status.tone)}</span></td>
                  <td>${bot.authenticated ? badge('Yes', 'ok') : botStatus(bot).key === 'auth_failed' ? badge('No', 'danger') : badge('Pending', 'warn')}</td>
                  <td>${bot.spawned ? badge('Yes', 'ok') : badge('No', 'warn')}</td>
                  <td class="mono tiny">${esc(positionText(bot.position))}</td>
                  <td class="mono tiny">${bot.uptimeMs ? esc(duration(bot.uptimeMs)) : '—'}</td>
                  <td class="tiny ${diag.lastError ? 'text-danger' : 'muted'}">${esc(diag.lastError || '—')}</td>
                  <td><div class="row gap-2">
                    <button class="button button--sm" type="button" data-bot-action="reconnect" data-bot="${esc(bot.name)}">Reconnect</button>
                    <button class="button button--sm button--danger-ghost" type="button" data-bot-action="disconnect" data-bot="${esc(bot.name)}" data-confirm="true">Disconnect</button>
                  </div></td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>
        </section>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('activity')} Lifecycle and login timeline</div><span class="tiny muted">One session id per attempt; stale events are rejected</span></div>
          <div class="card-body">
            ${lifecycleRows.length ? `<div class="grid grid--2">${lifecycleRows.map((row) => {
              const c = row.connection || {};
              const timeline = (c.timeline || []).slice(-8).reverse();
              const stateTone = c.state === 'ready' ? 'ok' : c.state === 'failed' ? 'danger' : c.state === 'closed' || c.state === 'idle' ? 'neutral' : 'warn';
              const keep = row.keepAlive || {};
              const ticker = row.ticker || {};
              const stall = row.stall || {};
              const movement = row.movement || {};
              const last = row.lastDisconnect || null;
              const retry = row.retry || null;
              return `<section class="card card--inset">
                <div class="card-header"><div class="card-title">${esc(row.name)} ${badge(c.label || row.statusLabel || 'Unknown', stateTone)}</div><span class="mono tiny">session ${esc(c.generation ?? '—')}</span></div>
                <div class="card-body card-body--tight">
                  ${kvRows([
                    ['Stage', esc(`${c.stageLabel || c.stage || '—'}${c.stageElapsedMs != null ? ` · ${(c.stageElapsedMs / 1000).toFixed(1)}s` : ''}`)],
                    ['Stage budget', c.stageTimeoutMs ? `${(c.stageTimeoutMs / 1000).toFixed(0)}s` : '—'],
                    ['Session elapsed', c.elapsedMs != null ? duration(c.elapsedMs) : '—'],
                    ['Keep-alive', `${num(keep.received || 0)} received · ${num(keep.replies || 0)} replied · max gap ${keep.maxGapMs ? duration(keep.maxGapMs) : '—'}`],
                    ['Client ticks', ticker.tickEnds != null ? `${num(ticker.tickEnds)} tick_end · ${ticker.tickRate || 20} tps${ticker.frozen ? ' · frozen' : ''}${ticker.stalls ? ` · ${num(ticker.stalls)} late` : ''}` : 'not active'],
                    ['Freeze guard', `${num(stall.recoveries || 0)} ${Number(stall.recoveries) === 1 ? 'recovery' : 'recoveries'} · ${num(stall.forcedReanchors || 0)} teleport ${Number(stall.forcedReanchors) === 1 ? 'reanchor' : 'reanchors'} · ${num(stall.droppedMovements || 0)} packets held${stall.blockedUntil && stall.blockedUntil > Date.now() ? ' · resyncing' : ''}`],
                    ['Movement owner', movement.owner ? `${esc(String(movement.owner))} · priority ${esc(String(movement.priority))}${Number(movement.invalidDrops) ? ` · ${num(movement.invalidDrops)} malformed dropped` : ''}` : `idle${Number(movement.invalidDrops) ? ` · ${num(movement.invalidDrops)} malformed dropped` : ''}`],
                    ['Last inbound', c.lastEventAgeMs != null ? `${duration(c.lastEventAgeMs)} ago` : '—'],
                    ['Last failure', c.failure ? esc(`${c.failure.code} in ${c.failure.stage}: ${c.failure.error}`) : '—'],
                    ['Retry', retry ? `attempt ${num(retry.attempt || 0)}${retry.nextRetryAt ? ` · next in ${duration(Math.max(0, retry.nextRetryAt - Date.now()))}` : ''}${retry.lastError ? ` · ${esc(String(retry.lastError).slice(0, 120))}` : ''}` : '—'],
                    ['Last disconnect', last ? esc(`${last.reason} · ${last.state} · spawned=${last.spawned} auth=${last.authenticated} · ${new Date(last.at).toLocaleTimeString()}`) : '—']
                  ])}
                  <div class="timeline" style="margin-top:8px">
                    ${timeline.map((entry) => `<div class="activity-item"><span class="activity-icon">${icon('chevron-right')}</span><div class="activity-main"><div>${esc(entry.kind === 'state' ? `${entry.from || '—'} → ${entry.to}` : entry.kind === 'stage' ? `stage: ${entry.stage}` : entry.kind === 'event' ? `event: ${entry.event}` : entry.kind)}</div><div class="mono">${esc(new Date(entry.at).toLocaleTimeString())}${entry.detail ? ` · ${esc(entry.detail)}` : ''}</div></div></div>`).join('') || '<div class="muted small">No lifecycle events recorded.</div>'}
                  </div>
                </div>
              </section>`;
            }).join('')}</div>` : emptyState('No connection records', 'No bot has attempted a live connection yet.', 'wifi')}
          </div>
        </section>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('server')} Endpoint</div></div>
          <div class="card-body">
            ${kvRows([
              ['Host', esc(server.host || '—'), true],
              ['Port', esc(server.port || '—'), true],
              ['Protocol version', esc(server.version || '—'), true],
              ['Dashboard', esc(`${(config.dashboard && config.dashboard.host) || '0.0.0.0'}:${(config.dashboard && config.dashboard.port) || 3000}`), true],
              ['PVP', config.pvp ? 'Enabled' : 'Disabled'],
              ['AI planner', config.ai ? 'Enabled' : 'Disabled'],
              ['Event loop', runtime.eventLoop ? (runtime.eventLoop.samples ? `mean ${runtime.eventLoop.meanMs}ms · p99 ${runtime.eventLoop.p99Ms}ms · max ${runtime.eventLoop.maxMs}ms` : 'collecting samples') : '—'],
              ['Readiness', `${rows.filter((r) => r.gameplayReady || r.ready).length}/${rows.length} ready · ${rows.filter((r) => r.online).length} online · ${rows.filter((r) => ['joining', 'reconnecting'].includes(r.status)).length} connecting · ${rows.filter((r) => r.authPending || r.status === 'auth_required_manual').length} manual auth · ${rows.filter((r) => ['offline'].includes(r.status)).length} offline`]
            ])}
          </div>
        </section>
      </div>`;
  },
  mount(root) {
    const button = root.querySelector('#reconnect-all');
    if (!button) return;
    button.addEventListener('click', async () => {
      const names = botNames();
      button.disabled = true;
      const original = button.innerHTML;
      button.innerHTML = '<span class="spinner"></span> Reconnecting…';
      let ok = 0;
      const failures = [];
      for (const name of names) {
        try {
          await runBotAction(name, 'reconnect');
          ok++;
        } catch (err) {
          failures.push(`${name}: ${err.message}`);
        }
      }
      button.disabled = false;
      button.innerHTML = original;
      if (failures.length) toast({ type: 'warn', title: `${ok} reconnected`, message: failures.join(' · ').slice(0, 300), duration: 9000 });
      else toast({ type: 'success', title: 'Reconnect requested', message: `${ok} bot sessions were asked to reconnect.` });
    });
  }
};

function statusDotFor(status) {
  return `<span class="status-dot status-dot--${status.dot}" aria-hidden="true"></span>`;
}

function positionText(position) {
  if (!position) return 'Position unavailable';
  return `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
}
