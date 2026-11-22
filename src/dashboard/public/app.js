'use strict';

const TABS = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'team', label: 'TEAM CONTROL' },
  { id: 'survival', label: 'SURVIVAL' },
  { id: 'combat', label: 'COMBAT' },
  { id: 'inventory', label: 'INVENTORY' },
  { id: 'mining', label: 'MINING' },
  { id: 'excavation', label: 'EXCAVATION' },
  { id: 'woodcutting', label: 'WOODCUTTING' },
  { id: 'farming', label: 'FARMING' },
  { id: 'sleep', label: 'SLEEP' },
  { id: 'exploration', label: 'EXPLORATION' },
  { id: 'builder', label: 'BUILDER' },
  { id: 'schematics', label: 'SCHEMATICS' },
  { id: 'home', label: 'HOME BASE' },
  { id: 'tasks', label: 'TASK MANAGER' },
  { id: 'diagnostics', label: 'DIAGNOSTICS' }
];

let STATE = null;
let ACTIVE = 'overview';
let SCHEMATIC_LIST = null;

const $ = (sel) => document.querySelector(sel);
const esc = (value) => String(value === null || value === undefined ? '' : (typeof value === 'object' ? JSON.stringify(value) : value))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (n) => `${Math.round(Number(n) || 0)}%`;
const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
const rows = (pairs) => pairs.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${v}</span></div>`).join('');
const table = (headers, body) => `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${headers.length}" class="muted">no data</td></tr>`}</tbody></table>`;

function renderTabs() {
  $('#tabs').innerHTML = TABS.map((t) => `<button data-tab="${t.id}" class="${ACTIVE === t.id ? 'active' : ''}">${t.label}</button>`).join('');
  document.querySelectorAll('#tabs button').forEach((btn) => btn.addEventListener('click', () => { ACTIVE = btn.dataset.tab; renderTabs(); render(); }));
}

function renderHeader() {
  if (!STATE) return;
  const o = STATE.overview || {};
  $('#stat-online').textContent = `${o.online || 0}/${o.total || 0}`;
  $('#stat-leader').textContent = o.leader || 'none';
  $('#stat-tasks').textContent = o.tasks ? `${o.tasks.COMPLETED || 0}/${o.tasks.total || 0}` : '0';
  $('#stat-mode').textContent = (STATE.mode || 'live').toUpperCase();
  $('#stat-auto').textContent = o.autonomy ? (o.autonomy.paused ? 'PAUSED' : o.autonomy.running ? 'RUNNING' : 'IDLE') : 'OFF';
  $('#foot-status').textContent = `state ${new Date(STATE.generatedAt).toLocaleTimeString()} · ${STATE.bots.length} bots · ${o.alerts ? o.alerts.length : 0} alerts`;
}

function viewOverview() {
  const o = STATE.overview || {};
  const alerts = (o.alerts || []).map((a) => `<div class="row"><span>${esc(a.bot || 'team')}</span><span class="badge ${a.level === 'critical' ? 'crit' : a.level === 'error' ? 'crit' : 'warn'}">${esc(a.message)}</span></div>`).join('') || '<div class="muted small">No active alerts.</div>';
  const bots = table(['BOT', 'HEALTH', 'FOOD', 'POSITION', 'ACTIVITY', 'TASK'], STATE.bots.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.health)}</td><td>${esc(b.food)}</td><td class="small">${esc(b.position ? `${b.position.x}, ${b.position.y}, ${b.position.z}` : '–')}</td><td>${esc(b.activity)}</td><td class="small">${esc(b.currentTaskId || '–')}</td></tr>`).join(''));
  return `<h2>OVERVIEW</h2>
    <div class="grid">
      <div class="card"><h4>TEAM</h4>${rows([['Online', `${o.online}/${o.total}`], ['Leader', o.leader || 'none'], ['Mode', STATE.mode], ['Uptime', Math.round((STATE.uptimeMs || 0) / 1000) + 's'], ['Autonomy', o.autonomy ? (o.autonomy.paused ? 'paused' : 'running') : 'off']])}</div>
      <div class="card"><h4>TASKS</h4>${rows([['Completed', o.tasks ? o.tasks.COMPLETED : 0], ['Pending', o.tasks ? o.tasks.PENDING : 0], ['Active', o.tasks ? o.tasks.ACTIVE : 0], ['Failed', o.tasks ? o.tasks.FAILED : 0]])}</div>
      <div class="card"><h4>SCHEMATICS</h4>${rows([['Designs', o.library ? o.library.count : 'not generated'], ['Unique', o.library ? o.library.unique : '–'], ['Minimum', o.library ? o.library.minimum : '–'], ['Builds', (o.builds || []).length]])}</div>
      <div class="card"><h4>ALERTS</h4>${alerts}</div>
    </div>
    <h3>BOTS</h3>${bots}
    <h3>BUILDS</h3>${table(['BUILD', 'NAME', 'STATE', 'PROGRESS'], (o.builds || []).map((b) => `<tr><td class="small">${esc(b.id)}</td><td>${esc(b.name)}</td><td>${badge(b.state, b.state === 'COMPLETE' ? 'ok' : 'warn')}</td><td><div class="bar"><i style="width:${pct(b.percent)}"></i></div><span class="small muted">${pct(b.percent)}</span></td></tr>`).join(''))}`;
}

function viewTeam() {
  const t = STATE.team || {};
  const state = t.state || {};
  return `<h2>TEAM CONTROL</h2>
    <div class="grid">
      <div class="card"><h4>LEADERSHIP</h4>${rows([['Leader', state.leader || 'none'], ['Roles', Object.entries(state.roles || {}).map(([b, r]) => `${b}:${r}`).join(' ') || '–'], ['Formation', state.formation], ['Tick', state.ticks]])}</div>
      <div class="card"><h4>EMERGENCIES</h4>${(state.emergencies || []).map((e) => `<div class="row"><span>${esc(e.type)}</span><span>${esc(e.bot || e.target || '')}</span></div>`).join('') || '<span class="muted small">none</span>'}</div>
      <div class="card"><h4>SHARED MEMORY</h4>${rows([['Observations', t.memory ? t.memory.stats.added : 0], ['Expired', t.memory ? t.memory.stats.expired : 0], ['Facts', t.memory ? t.memory.facts.length : 0]])}</div>
      <div class="card"><h4>RESERVATIONS</h4>${rows([['Locks', (t.locks || []).length], ['Regions', (t.regions || []).length], ['Deadlocks', (t.deadlocks || []).length]])}</div>
    </div>
    <h3>LOCKS</h3>${table(['KEY', 'OWNER', 'LABEL', 'EXPIRES'], (t.locks || []).map((l) => `<tr><td>${esc(l.key)}</td><td>${esc(l.owner)}</td><td>${esc(l.label)}</td><td class="small">${esc(new Date(l.expiresAt).toLocaleTimeString())}</td></tr>`).join(''))}
    <h3>RECENT OBSERVATIONS</h3>${table(['TYPE', 'RESOURCE', 'POSITION', 'REPORTER', 'CONFIDENCE', 'STATUS'], ((t.memory && t.memory.observations) || []).slice(-15).reverse().map((o) => `<tr><td>${esc(o.type)}</td><td>${esc(o.resource)}</td><td class="small">${esc(o.position ? `${o.position.x},${o.position.y},${o.position.z}` : '')}</td><td>${esc(o.reportedBy)}</td><td>${esc(o.confidence)}</td><td>${esc(o.status)}</td></tr>`).join(''))}`;
}

function viewSurvival() {
  return `<h2>SURVIVAL</h2><p class="tablenote">Eat/heal/armour/tool maintenance and lava/fall clutches, driven by the deterministic survival controller.</p>` +
    `<div class="grid">${(STATE.survival || []).map((s) => `<div class="card"><h4>${esc(s.bot)}</h4>${rows([
      ['Health', s.health], ['Food', s.food], ['Armour', s.armour], ['Best food', s.bestFood ? s.bestFood.name : 'none'],
      ['Food count', s.foodCount], ['Needs food', s.needsFood || 'no'], ['Pickaxe', s.pickaxe ? s.pickaxe.name : 'none'],
      ['Shield', s.hasShield ? 'yes' : 'no'], ['State', s.inLava ? 'IN LAVA' : s.onFire ? 'ON FIRE' : 'ok'], ['Last action', s.lastAction || '–']
    ])}</div>`).join('')}</div>`;
}

function viewCombat() {
  return `<h2>COMBAT</h2><p class="tablenote">PvP is disabled by default. Teammates and ordinary players are never auto-attacked.</p>
    ${table(['BOT', 'HEALTH', 'THREATS', 'NEAREST', 'OUTMATCHED', 'PvP', 'SWORD', 'KILLS'], (STATE.combat || []).map((c) => `<tr><td>${esc(c.bot)}</td><td>${esc(c.health)}</td><td>${esc(c.threats)}</td><td>${esc(c.nearestThreat ? c.nearestThreat.name : '–')}</td><td>${c.outmatched ? badge('YES', 'warn') : 'no'}</td><td>${c.pvpEnabled ? badge('ON', 'crit') : badge('OFF', 'ok')}</td><td>${esc(c.sword ? c.sword.name : 'none')}</td><td>${esc(c.stats.kills)}</td></tr>`).join(''))}`;
}

function viewInventory() {
  const inv = STATE.inventory || {};
  const ledger = inv.ledger || {};
  return `<h2>INVENTORY &amp; RESERVES</h2>
    <div class="grid">
      <div class="card"><h4>LEDGER</h4>${rows([['Bots tracked', ledger.bots || (ledger.inventories ? Object.keys(ledger.inventories).length : 0)], ['Storages', ledger.storages ? Object.keys(ledger.storages).length : 0], ['Active reservations', ledger.activeReservations || 0], ['Transfers', ledger.transfers || 0]])}</div>
      ${(inv.bots || []).map((b) => `<div class="card"><h4>${esc(b.bot)}</h4>${rows([['Items', b.totalItems], ['Slots', b.slotsUsed], ['Food', b.food], ['Blocks', b.blocks], ['Reserves', b.reserves && b.reserves.satisfied ? badge('OK', 'ok') : badge('SHORT', 'warn')]])}</div>`).join('')}
    </div>
    <h3>PER-BOT ITEMS</h3>
    ${(inv.bots || []).map((b) => `<h4 class="small">${esc(b.bot)}</h4>${table(['ITEM', 'COUNT', 'CATEGORY'], (b.items || []).slice(0, 14).map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.count)}</td><td>${esc(i.category)}</td></tr>`).join(''))}`).join('')}`;
}

function viewMining() {
  return `<h2>MINING</h2><p class="tablenote">Ore detection, tool-tier checks, lava/water ceiling safety and tunnel lighting.</p>
    <div class="grid">${(STATE.mining || []).map((m) => `<div class="card"><h4>${esc(m.bot)}</h4>${rows([
      ['Pickaxe', m.pickaxe ? m.pickaxe.name : 'none'], ['Ores mined', Object.values(m.oresMined || {}).reduce((s, n) => s + n, 0)],
      ['Hazards avoided', m.stats.hazardsAvoided], ['Torches', m.stats.torchesPlaced], ['Tunnels', m.stats.tunnels]
    ])}</div>`).join('')}</div>
    <h3>NEARBY ORES</h3>${table(['BOT', 'ORE', 'POSITION', 'DISTANCE'], (STATE.mining || []).flatMap((m) => (m.nearbyOres || []).map((o) => `<tr><td>${esc(m.bot)}</td><td>${esc(o.name)}</td><td class="small">${esc(`${o.position.x},${o.position.y},${o.position.z}`)}</td><td>${esc(o.distance)}</td></tr>`)).join(''))}`;
}

function viewExcavation() {
  const ex = STATE.excavation || {};
  const status = ex.status || {};
  return `<h2>EXCAVATION</h2>
    <p class="tablenote">Preview is non-destructive; start requires confirmation. Protected blocks, ores, liquids and beds are never removed silently.</p>
    <div class="grid">
      <div class="card"><h4>ACTIVE</h4>${rows([['Active', status.active ? status.active.length : 0], ['Paused', status.counts ? status.counts.PAUSED : 0], ['Complete', status.counts ? status.counts.COMPLETE : 0], ['Incomplete', status.counts ? status.counts.INCOMPLETE : 0]])}</div>
      <div class="card"><h4>PREVIEWS</h4>${(ex.previews || []).length ? (ex.previews || []).slice(-4).map((p) => `<div class="row"><span>${esc(p.previewId)}</span><span>${esc(p.mode)} · ${esc(p.volume)} blocks</span></div>`).join('') : '<span class="muted small">none</span>'}</div>
    </div>
    ${table(['ID', 'STATE', 'MODE', 'VOLUME', 'PROGRESS', 'VERIFIED'], (status.active || []).map((e) => `<tr><td class="small">${esc(e.id)}</td><td>${badge(e.state, e.state === 'COMPLETE' ? 'ok' : 'warn')}</td><td>${esc(e.mode)}</td><td>${esc(e.volume)}</td><td><div class="bar"><i style="width:${pct(e.percent)}"></i></div><span class="small muted">${pct(e.percent)}</span></td><td>${e.verification && e.verification.complete ? badge('YES', 'ok') : 'no'}</td></tr>`).join(''))}
    <h3>COMMAND PREVIEW</h3>
    <div class="card small muted">excavate preview radius &lt;x&gt; &lt;y&gt; &lt;z&gt; &lt;radius&gt; &lt;depth&gt; · excavate preview quarry &lt;x&gt; &lt;y&gt; &lt;z&gt; &lt;w&gt; &lt;l&gt; &lt;d&gt; · excavate start &lt;previewId&gt; confirm<br/>excavate status · pause · resume · stop · undo-preview · assign &lt;bot&gt; · team</div>`;
}

function viewWoodcutting() {
  return `<h2>WOODCUTTING</h2><p class="tablenote">Trees are chopped top-down and replanted on the original soil; saplings and logs are tracked.</p>
    <div class="grid">${(STATE.woodcutting || []).map((w) => `<div class="card"><h4>${esc(w.bot)}</h4>${rows([
      ['Axe', w.axe ? w.axe.name : 'none'], ['Logs', w.logs], ['Saplings', w.saplings], ['Trees chopped', w.treesChopped],
      ['Replanted', w.stats.replanted], ['Leaves cleared', w.stats.leavesCleared]
    ])}</div>`).join('')}</div>
    <h3>REPLANTED TREES</h3>${table(['BOT', 'POSITION', 'SAPLING'], (STATE.woodcutting || []).flatMap((w) => (w.replanted || []).map((r) => `<tr><td>${esc(w.bot)}</td><td class="small">${esc(`${r.position.x},${r.position.y},${r.position.z}`)}</td><td>${esc(r.sapling)}</td></tr>`)).join(''))}`;
}

function viewFarming() {
  return `<h2>FARMING</h2><p class="tablenote">Crops are harvested with real drops and replanted when seed stock allows.</p>
    <div class="grid">${(STATE.farming || []).map((f) => `<div class="card"><h4>${esc(f.bot)}</h4>${rows([
      ['Crops nearby', f.cropCount], ['Animals', f.animals], ['Harvested', f.stats.harvested], ['Replanted', f.stats.replanted], ['Animals fed', f.stats.animalsFed]
    ])}</div>`).join('')}</div>
    <h3>CROPS</h3>${table(['BOT', 'CROP', 'POSITION', 'DISTANCE'], (STATE.farming || []).flatMap((f) => (f.crops || []).map((c) => `<tr><td>${esc(f.bot)}</td><td>${esc(c.crop)}</td><td class="small">${esc(`${c.x},${c.y},${c.z}`)}</td><td>${esc(c.distance)}</td></tr>`)).join(''))}`;
}

function viewSleep() {
  return `<h2>SLEEP</h2><p class="tablenote">Beds are reserved through the shared task board, so two bots never claim the same bed.</p>
    ${table(['BOT', 'TIME', 'NIGHT', 'SLEEPING', 'BED', 'RESERVATION', 'SLEEPS'], (STATE.sleep || []).map((s) => `<tr><td>${esc(s.bot)}</td><td>${esc(s.time)}</td><td>${s.night ? 'yes' : 'no'}</td><td>${s.sleeping ? badge('YES', 'ok') : 'no'}</td><td>${esc(s.nearbyBeds && s.nearbyBeds[0] ? `${s.nearbyBeds[0].x},${s.nearbyBeds[0].y},${s.nearbyBeds[0].z}` : 'none')}</td><td>${esc(s.reservation ? s.reservation.key : '–')}</td><td>${esc(s.stats.sleeps)}</td></tr>`).join(''))}`;
}

function viewExploration() {
  return `<h2>EXPLORATION</h2><p class="tablenote">Deterministic spiral waypoints; structures, water and lava are recorded with reporter and confidence.</p>
    <div class="grid">${(STATE.exploration || []).map((e) => `<div class="card"><h4>${esc(e.bot)}</h4>${rows([
      ['Home', `${e.home.x}, ${e.home.y}, ${e.home.z}`], ['Radius', e.radius], ['Waypoints', e.stats.waypoints], ['Discoveries', e.stats.discoveries], ['Night returns', e.stats.nightReturns]
    ])}</div>`).join('')}</div>
    <h3>DISCOVERIES</h3>${table(['BOT', 'TYPE', 'POSITION', 'AT'], (STATE.exploration || []).flatMap((e) => (e.discoveries || []).map((d) => `<tr><td>${esc(e.bot)}</td><td>${esc(d.type)}</td><td class="small">${esc(`${d.position.x},${d.position.y},${d.position.z}`)}</td><td class="small">${esc(new Date(d.at).toLocaleTimeString())}</td></tr>`)).join(''))}`;
}

function viewBuilder() {
  const b = STATE.builder || {};
  return `<h2>BUILDER</h2><p class="tablenote">Phased cooperative placement with material delivery, obstacle clearing and a real world rescan before completion.</p>
    ${table(['BUILD', 'NAME', 'STATE', 'PLACED', 'PROGRESS', 'TASKS'], (b.builds || []).map((x) => `<tr><td class="small">${esc(x.buildId)}</td><td>${esc(x.name)}</td><td>${badge(x.state, x.state === 'COMPLETE' ? 'ok' : 'warn')}</td><td>${esc(x.placedBlocks)}/${esc(x.toPlace)}</td><td><div class="bar"><i style="width:${pct(x.percentComplete)}"></i></div><span class="small muted">${pct(x.percentComplete)}</span></td><td class="small">${esc(x.tasks ? `${x.tasks.COMPLETED}/${x.tasks.total}` : '–')}</td></tr>`).join(''))}
    <h3>IMPORTED</h3>${table(['ID', 'NAME', 'BLOCKS', 'SIZE'], (b.imported || []).map((i) => `<tr><td>${esc(i.id)}</td><td>${esc(i.name)}</td><td>${esc(i.blocks)}</td><td>${esc(`${i.dimensions.width}x${i.dimensions.height}x${i.dimensions.length}`)}</td></tr>`).join(''))}`;
}

async function loadSchematics() {
  if (SCHEMATIC_LIST) return;
  try {
    const res = await fetch('api/schematics?limit=60');
    const data = await res.json();
    SCHEMATIC_LIST = data.designs || [];
    render();
  } catch (_) { /* server offline */ }
}

function viewSchematics() {
  if (!SCHEMATIC_LIST) { loadSchematics(); return '<h2>SCHEMATICS</h2><div class="loading">Loading library…</div>'; }
  const stats = (STATE.schematics || {}).stats || {};
  return `<h2>SCHEMATICS</h2>
    <p class="tablenote">${stats.count || 0} validated designs · ${stats.uniqueGeometry || 0} unique geometry hashes · minimum ${stats.minimumRequired || 1100}</p>
    <div class="grid">
      <div class="card"><h4>LIBRARY</h4>${rows([['Designs', stats.count], ['Unique', stats.uniqueGeometry], ['Average blocks', stats.blocks ? stats.blocks.average : '–'], ['Largest', stats.blocks ? stats.blocks.max : '–']])}</div>
      <div class="card"><h4>TIERS</h4>${(stats.tiers || []).map((t) => `<div class="row"><span>${esc(t.tier)}</span><span>${esc(t.count)}</span></div>`).join('')}</div>
    </div>
    <h3>DESIGNS</h3>${table(['ID', 'NAME', 'TIER', 'SIZE', 'BLOCKS', 'FILE', 'ACTION'], SCHEMATIC_LIST.map((d) => `<tr><td class="small">${esc(d.id)}</td><td>${esc(d.name)}</td><td>${esc(d.tier)}</td><td class="small">${esc(`${d.dimensions.width}x${d.dimensions.height}x${d.dimensions.length}`)}</td><td>${esc(d.blocks)}</td><td><a href="api/schematics/${encodeURIComponent(d.id)}/download.schem">.schem</a></td><td><button class="small" data-quick="build ${esc(d.id)} confirm">build</button></td></tr>`).join(''))}`;
}

function viewHome() {
  const h = STATE.homeBase || {};
  return `<h2>HOME BASE</h2>
    <div class="grid">
      <div class="card"><h4>HOME</h4>${h.home ? rows([['X', h.home.x], ['Y', h.home.y], ['Z', h.home.z]]) : '<span class="muted small">not set</span>'}</div>
      ${(h.perBot || []).map((p) => `<div class="card"><h4>${esc(p.bot)}</h4>${rows([['Designs', p.availableDesigns], ['Builds', p.stats && p.stats.builds || 0], ['Completed', p.stats && p.stats.completed || 0]])}</div>`).join('')}
    </div>
    <h3>COMMANDS</h3><div class="card small muted">home set &lt;x&gt; &lt;y&gt; &lt;z&gt; · home build Beginner · build &lt;designId&gt; confirm run</div>`;
}

function viewTasks() {
  const t = STATE.taskManager || {};
  const stats = t.stats || {};
  return `<h2>TASK MANAGER</h2>
    <div class="grid"><div class="card"><h4>TOTALS</h4>${rows([['Total', stats.total], ['Pending', stats.PENDING], ['Active', stats.ACTIVE], ['Completed', stats.COMPLETED], ['Failed', stats.FAILED]])}</div>
    <div class="card"><h4>OBJECTIVES</h4>${(t.objectives || []).slice(-6).map((o) => `<div class="row"><span>${esc(o.title)}</span><span>${esc(o.status)}</span></div>`).join('') || '<span class="muted small">none</span>'}</div></div>
    ${table(['ID', 'TYPE', 'LABEL', 'STATUS', 'OWNER', 'UNITS', 'VERIFIED'], (t.tasks || []).slice().reverse().map((x) => `<tr><td class="small">${esc(x.id)}</td><td>${esc(x.type)}</td><td>${esc(x.label)}</td><td>${badge(x.status, x.status === 'COMPLETED' ? 'ok' : x.status === 'FAILED' ? 'crit' : '')}</td><td>${esc(x.claimedBy || '–')}</td><td class="small">${esc(x.units ? `${x.units.current}/${x.units.target}` : '')}</td><td>${x.verified ? 'yes' : 'no'}</td></tr>`).join(''))}`;
}

function viewDiagnostics() {
  const d = STATE.diagnostics || {};
  const c = d.config || {};
  const checks = [
    ['Five fixed usernames', JSON.stringify(c.roster) === JSON.stringify(['______', '101010', '010101', '110011', '001100'])],
    ['Default server', c.server && c.server.host === 'cr3xlol.aternos.me' && c.server.port === 55742],
    ['PvP disabled', c.pvp === false],
    ['AI disabled', c.ai === false],
    ['Dashboard bind 0.0.0.0', c.dashboard && c.dashboard.host === '0.0.0.0'],
    ['Library >= 1100', STATE.schematics && STATE.schematics.stats ? STATE.schematics.stats.count >= 1100 : false]
  ];
  return `<h2>DIAGNOSTICS</h2>
    <div class="grid">
      <div class="card"><h4>SYSTEM CHECKS</h4>${checks.map(([name, ok]) => `<div class="row"><span>${esc(name)}</span><span>${ok ? badge('PASS', 'ok') : badge('FAIL', 'crit')}</span></div>`).join('')}</div>
      <div class="card"><h4>RUNTIME</h4>${rows([['Mode', STATE.mode], ['Uptime', Math.round((STATE.uptimeMs || 0) / 1000) + 's'], ['Bots', STATE.bots.length], ['Autonomy', d.runtime ? (d.runtime.paused ? 'paused' : d.runtime.running ? 'running' : 'idle') : 'off']])}</div>
    </div>
    <h3>CONNECTIONS</h3>${table(['BOT', 'CONNECTED', 'SPAWNED', 'AUTH', 'READY', 'HEALTH', 'POSITION', 'ERROR'], (d.bots || []).map((b) => `<tr><td>${esc(b.name)}</td><td>${b.connected ? 'yes' : 'NO'}</td><td>${b.spawned ? 'yes' : 'NO'}</td><td>${b.authenticated ? 'yes' : 'NO'}</td><td>${b.ready ? badge('READY', 'ok') : badge('GATED', 'warn')}</td><td>${esc(b.health)}</td><td class="small">${esc(b.position ? `${b.position.x},${b.position.y},${b.position.z}` : '–')}</td><td class="small">${esc(b.lastError || '')}</td></tr>`).join(''))}
    <h3>RECENT COMMANDS</h3>${table(['AT', 'SOURCE', 'LINE', 'RESULT', 'MS'], (d.commands || []).slice().reverse().map((c2) => `<tr><td class="small">${esc(new Date(c2.at).toLocaleTimeString())}</td><td>${esc(c2.source)}</td><td class="small">${esc(c2.line)}</td><td>${c2.ok ? badge('OK', 'ok') : badge('ERR', 'crit')} <span class="small">${esc(c2.result && c2.result.error ? c2.result.error : '')}</span></td><td>${esc(c2.durationMs)}</td></tr>`).join(''))}`;
}

const VIEWS = { overview: viewOverview, team: viewTeam, survival: viewSurvival, combat: viewCombat, inventory: viewInventory, mining: viewMining, excavation: viewExcavation, woodcutting: viewWoodcutting, farming: viewFarming, sleep: viewSleep, exploration: viewExploration, builder: viewBuilder, schematics: viewSchematics, home: viewHome, tasks: viewTasks, diagnostics: viewDiagnostics };

function render() {
  if (!STATE) return;
  renderHeader();
  $('#tab-content').innerHTML = (VIEWS[ACTIVE] || viewOverview)();
  bindQuickButtons();
}

function bindQuickButtons() {
  document.querySelectorAll('[data-quick]').forEach((btn) => btn.addEventListener('click', () => {
    $('#command-input').value = btn.dataset.quick;
    $('#command-input').focus();
  }));
}

async function refresh() {
  try {
    const res = await fetch('api/state', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok) { STATE = data.state; render(); }
  } catch (_) {
    $('#foot-status').textContent = 'dashboard cannot reach the API';
  }
}

function logCommand(text, ok) {
  const out = $('#output');
  const div = document.createElement('div');
  div.className = ok ? 'ok' : 'err';
  div.textContent = text;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

async function runCommand(line) {
  if (!line.trim()) return;
  logCommand(`> ${line}`, true);
  try {
    const res = await fetch('api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line, confirm: /(^|\s)confirm(\s|$)/.test(line) }) });
    const result = await res.json();
    const payload = result.result || result;
    const text = payload.ok === false ? `✗ ${payload.error || 'failed'}` : `✓ ${payload.message || payload.text || summaryOf(payload)}`;
    logCommand(text, payload.ok !== false);
    if (payload.text) logCommand(payload.text, true);
    refresh();
  } catch (err) {
    logCommand(`✗ ${err.message}`, false);
  }
}

function summaryOf(payload) {
  const clone = { ...payload };
  delete clone.ok;
  delete clone.command;
  const text = JSON.stringify(clone);
  return text.length > 600 ? text.slice(0, 600) + '…' : text;
}

function boot() {
  renderTabs();
  const quick = ['status', 'diagnostics', 'inventory', 'team state', 'task list', 'excavate status', 'excavate team', 'schematics stats', 'build status', 'help'];
  $('#quick').innerHTML = quick.map((q) => `<button data-quick="${q}">${q}</button>`).join('');
  bindQuickButtons();
  $('#command-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#command-input').value;
    $('#command-input').value = '';
    runCommand(value);
  });
  refresh();
  try {
    const source = new EventSource('api/events');
    source.addEventListener('state', (event) => {
      try { STATE = JSON.parse(event.data); render(); } catch (_) { /* ignore malformed frame */ }
    });
    source.onerror = () => { $('#foot-status').textContent = 'SSE reconnecting…'; };
  } catch (_) {
    setInterval(refresh, 3000);
  }
}

document.addEventListener('DOMContentLoaded', boot);
