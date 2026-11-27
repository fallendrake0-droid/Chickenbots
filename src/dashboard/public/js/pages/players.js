import { state, runCommand } from '../store.js';
import { subcommandValues, playerWatchCommand, commandPreview } from '../commands.js';
import { icon } from '../icons.js';
import { esc, num, timeAgo, humanize, duration } from '../utils.js';
import { badge, emptyState, pageHeader, statCard, kvRows, toast, setButtonLoading, resultMessage, confirmDialog } from '../ui.js';
import { botNames } from './shared.js';

// Roster bots never enter the player directory (cleanName rejects them), so a
// "team" filter would always be empty. Team presence is on the Bots page.
const CATEGORIES = ['trusted', 'protected', 'target', 'neutral', 'unknown', 'staff'];

function directory() {
  return (state.snapshot && state.snapshot.players) || { count: 0, online: 0, rows: [], categories: {}, recentEvents: [] };
}

function watches() {
  return (state.snapshot && state.snapshot.playerWatch) || [];
}

function rows() {
  const value = directory().rows || directory().players || [];
  return Array.isArray(value) ? value : [];
}

function policy() {
  const list = (state.snapshot && state.snapshot.combat) || [];
  const row = list.find((entry) => entry && entry.pvp);
  return row ? row.pvp : null;
}

function positionText(player) {
  if (!player.position) return 'Not visible yet';
  const base = `${Math.round(player.position.x)}, ${Math.round(player.position.y)}, ${Math.round(player.position.z)}`;
  return player.positionFresh ? base : `${base} <span class="tiny muted">(stale ${player.positionAgeMs === null ? 'unknown' : timeAgo(Date.now() - player.positionAgeMs)})</span>`;
}

function distanceText(player) {
  if (player.distance === null || player.distance === undefined) return '—';
  return `${num(player.distance)}<small>m · ${esc(player.nearestBot || 'fleet')}</small>`;
}

function presenceBadge(player) {
  if (player.presence === 'visible') return badge('Visible', 'success');
  if (player.online) return badge('Online', 'success');
  if (player.presence === 'recent') return badge('Recently seen', 'warn');
  return badge('Offline', 'neutral');
}

function categoryTone(category) {
  return ({
    target: 'danger', protected: 'success', trusted: 'info', team: 'accent',
    staff: 'info', neutral: 'neutral', unknown: 'neutral'
  })[category] || 'neutral';
}

function categoryBadge(player) {
  return badge(humanize(player.category || 'unknown'), categoryTone(player.category));
}

function commandButton(label, line, iconName, { primary = false, danger = false, title = '', confirm = '' } = {}) {
  return `<button class="button button--sm${primary ? ' button--primary' : ''}${danger ? ' button--danger-ghost' : ''}" type="button" data-command="${esc(line)}"${title ? ` title="${esc(title)}"` : ''}${confirm ? ` data-danger="true" data-confirm-title="Confirm player action" data-confirm-message="${esc(confirm)}"` : ''}>${icon(iconName)}${esc(label)}</button>`;
}

function playerButton(label, action, player, iconName, { primary = false, danger = false } = {}) {
  return `<button class="button button--sm${primary ? ' button--primary' : ''}${danger ? ' button--danger-ghost' : ''}" type="button" data-player-action="${esc(action)}" data-player="${esc(player)}">${icon(iconName)}${esc(label)}</button>`;
}

function playerCommand(root, action, player, args = '') {
  const bot = selectedBot(root);
  const distance = Math.max(1, Math.min(8, Number((root.querySelector('[data-player-distance]') || {}).value) || 3));
  if (action === 'follow') return playerWatchCommand('follow', player, bot, distance);
  if (action === 'unfollow') return playerWatchCommand('unfollow', player, bot);
  if (action === 'guard') return playerWatchCommand('guard', player, bot, args || 8);
  if (action === 'escort') return playerWatchCommand('escort', player, bot);
  if (action === 'observe') return playerWatchCommand('observe', player, bot);
  if (action === 'unwatch') return playerWatchCommand('unwatch', player, bot);
  if (action === 'come') return playerWatchCommand('come', player, bot);
  if (action === 'greet') return playerWatchCommand('greet', player, bot);
  if (action === 'drop') return commandPreview('players', ['drop', player, 'loot', bot]);
  return commandPreview('players', ['list']);
}

function botOptions() {
  return `<option value="all">All bots</option>${botNames().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}`;
}

function summaryStrip() {
  const list = rows();
  const data = directory();
  const cats = data.categories || {};
  const online = list.filter((player) => player.online);
  const guarding = watches().filter((row) => row.mode === 'GUARD' || row.mode === 'ESCORT');
  const following = watches().filter((row) => row.mode === 'FOLLOW' || row.mode === 'ESCORT');
  const observing = watches().filter((row) => row.mode === 'OBSERVE');
  return `<div class="grid grid--stats">
    ${statCard({ label: 'Players seen', value: num(data.count || list.length), iconName: 'users', tone: list.length ? 'accent' : 'neutral', context: `${online.length} online · ${num(cats.unknown || 0)} unclassified` })}
    ${statCard({ label: 'Targets', value: num(cats.target || 0), iconName: 'target', tone: (cats.target || 0) ? 'danger' : 'neutral', context: 'Explicit PvP authorisations' })}
    ${statCard({ label: 'Protected / trusted', value: `${num((cats.protected || 0) + (cats.trusted || 0))}`, iconName: 'shield-check', tone: 'success', context: `${num(cats.protected || 0)} protected · ${num(cats.trusted || 0)} trusted` })}
    ${statCard({ label: 'Following / escorting', value: num(following.length), iconName: 'route', tone: following.length ? 'info' : 'neutral', context: following.length ? following.map((row) => `${row.bot}→${row.target}`).join(', ') : 'No follow watch active' })}
    ${statCard({ label: 'Guarding', value: num(guarding.length), iconName: 'shield', tone: guarding.length ? 'success' : 'neutral', context: guarding.length ? guarding.map((row) => `${row.bot}→${row.target}`).join(', ') : 'No guard watch active' })}
    ${statCard({ label: 'Observing', value: num(observing.length), iconName: 'eye', tone: observing.length ? 'info' : 'neutral', context: observing.length ? observing.map((row) => `${row.bot}→${row.target}`).join(', ') : 'Passive watches only report presence' })}
  </div>`;
}

function controlBar() {
  return `<div class="card card--pad" style="margin-bottom:16px">
    <div class="row row--between row--wrap">
      <div>
        <div class="card-title">Player directory</div>
        <p class="muted">Follow, escort, guard and observe real players. Watch actions never grant PvP; target, protect and trust are separate policy decisions.</p>
      </div>
      <div class="row row--wrap">
        <label class="tiny muted" for="player-bot">Bot</label>
        <select class="select select--sm" id="player-bot" data-player-bot aria-label="Bot used for player actions">${botOptions()}</select>
        <label class="tiny muted" for="player-distance">Follow distance</label>
        <input class="input input--sm" id="player-distance" data-player-distance type="number" min="1" max="8" value="3" aria-label="Follow distance">
        <button class="button button--sm" type="button" data-command="players stop all" data-danger="true" data-confirm-title="Stop all watches" data-confirm-message="Clear follow, guard, escort and observe watches on every bot?">${icon('stop')} Stop all watches</button>
        <button class="button button--sm" type="button" data-command="players refresh">${icon('refresh')} Refresh</button>
      </div>
    </div>
    <div class="row row--wrap" style="margin-top:12px">
      <label class="tiny muted" for="player-filter">Category</label>
      <select class="select select--sm" id="player-filter" data-player-filter aria-label="Filter players by category">
        <option value="">All categories</option>${CATEGORIES.map((category) => `<option value="${category}">${humanize(category)}</option>`).join('')}
      </select>
      <input class="input input--sm grow" data-player-search placeholder="Search name or tag" aria-label="Search player names or tags">
      <span class="tiny muted" data-player-count>${rows().length} players</span>
    </div>
  </div>`;
}

function pvpPanel() {
  const value = policy();
  if (!value) {
    return `<section class="card"><div class="card-header"><div class="card-title">${icon('shield')} PvP policy</div></div><div class="card-body"><p class="muted">No combat controller has reported yet. PvP stays disabled until the policy can be read from a live controller.</p></div></section>`;
  }
  const mode = value.mode || 'EXPLICIT';
  return `<section class="card" style="margin-bottom:16px">
    <div class="card-header">
      <div class="card-title">${icon('shield')} PvP policy <span class="badge badge--${value.enabled ? 'warn' : 'neutral'}">${value.enabled ? 'Enabled' : 'Disabled'}</span> <span class="badge badge--info">${esc(mode)}</span></div>
      <div class="row row--wrap">
        <button class="button button--sm${value.enabled ? ' button--danger-ghost' : ' button--primary'}" type="button" data-command="players pvp ${value.enabled ? 'off' : 'on'}">${icon(value.enabled ? 'lock' : 'unlock')} ${value.enabled ? 'Disable PvP' : 'Enable PvP'}</button>
        <button class="button button--sm" type="button" data-command="players target list">${icon('refresh')} Refresh policy</button>
      </div>
    </div>
    <div class="card-body">
      <div class="row row--wrap" style="margin-bottom:10px">
        <span class="tiny muted">Targeting mode</span>
        ${(() => {
          // Target modes come from the PvP policy enum exposed through the
          // registry; the page does not keep a second copy.
          const modes = subcommandValues('players', 'mode');
          if (!modes.length) return '<span class="tiny muted">Target mode catalogue unavailable.</span>';
          return modes.map((entry) => `<button class="button button--sm${entry === mode ? ' button--primary' : ''}" type="button" data-command="players mode ${entry}" title="${entry === 'EXPLICIT' ? 'Only named targets, anywhere allowed by arena bounds' : entry === 'ARENA' ? 'Named targets must be inside an authorised arena' : 'Only retaliation against a named player who attacked first'}">${humanize(entry)}</button>`).join('');
        })()}
      </div>
      <div class="grid grid--2">
        <div>
          <div class="tiny muted">Authorised targets</div>
          ${value.targets && value.targets.length ? `<div class="chips">${value.targets.map((name) => `<span class="chip">${esc(name)} <button class="chip-x" type="button" data-command="players target remove ${esc(name)}" title="Remove target ${esc(name)}">×</button></span>`).join('')}</div>` : emptyState('No authorised targets', 'A player is never attacked until an operator adds them here and PvP is enabled.', 'lock')}
          <form class="row row--wrap" data-target-form style="margin-top:10px">
            <input class="input input--sm" name="player" placeholder="exact player name" aria-label="Player to authorise as a PvP target" required pattern="[A-Za-z0-9_]{1,32}">
            <button class="button button--sm button--danger-ghost" type="submit">${icon('target')} Add target</button>
          </form>
        </div>
        <div>
          <div class="tiny muted">Protected and trusted</div>
          <div class="chips">
            ${(value.protectedPlayers || []).map((name) => `<span class="chip">${icon('shield-check')} ${esc(name)} <button class="chip-x" type="button" data-command="players unprotect ${esc(name)}" title="Remove protection">×</button></span>`).join('')}
            ${(value.trustedPlayers || []).map((name) => `<span class="chip">${icon('heart')} ${esc(name)} <button class="chip-x" type="button" data-command="players untrust ${esc(name)}" title="Remove trust">×</button></span>`).join('')}
          </div>
          ${(value.protectedPlayers || []).length || (value.trustedPlayers || []).length ? '' : '<p class="muted tiny">No player is protected or trusted.</p>'}
          <div class="tiny muted" style="margin-top:10px">Arenas</div>
          <div class="chips">${(value.arenas || []).map((arena) => `<span class="chip">${esc(arena.name || 'arena')} <span class="tiny muted">${arena.min ? `${arena.min.x},${arena.min.y},${arena.min.z} → ${arena.max.x},${arena.max.y},${arena.max.z}` : ''}</span> <button class="chip-x" type="button" data-command="players arena remove ${esc(arena.name || 'arena')}" title="Remove arena">×</button></span>`).join('') || '<span class="tiny muted">No arena restriction; named targets are authorised anywhere.</span>'}</div>
          <div class="row row--wrap" style="margin-top:8px">
            <button class="button button--sm" type="button" data-command="players arena on 24">${icon('square')} Add home arena</button>
            <button class="button button--sm button--danger-ghost" type="button" data-command="players arena clear" data-danger="true" data-confirm-title="Clear arenas" data-confirm-message="Remove every arena restriction? Named targets would then be attackable anywhere.">${icon('trash')} Clear arenas</button>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

function playerCard(player) {
  const name = player.name;
  const tags = player.tags || [];
  const notes = player.notes || [];
  const tasks = Object.entries(player.tasks || {}).flatMap(([mode, bots]) => bots.map((bot) => `${bot} ${mode}`));
  return `<div class="card card--pad" data-player-card data-player="${esc(name)}" data-category="${esc(player.category || 'unknown')}" data-search="${esc(`${name} ${tags.join(' ')}`)}">
    <div class="row row--between row--wrap">
      <div>
        <div class="card-title">${esc(name)} ${presenceBadge(player)} ${categoryBadge(player)}</div>
        <div class="tiny muted">${player.gamemode ? `${esc(humanize(player.gamemode))} · ` : ''}${player.ping === null || player.ping === undefined ? 'ping unknown' : `${num(player.ping)} ms`} · seen ${timeAgo(player.lastSeen)}${player.uuid ? ` · UUID ${esc(String(player.uuid).slice(0, 8))}…` : ''}</div>
      </div>
      <div class="row row--wrap">
        ${playerButton('Follow', 'follow', name, 'route')}
        ${playerButton('Unfollow', 'unfollow', name, 'x')}
        ${playerButton('Escort', 'escort', name, 'users')}
        ${playerButton('Guard', 'guard', name, 'shield-check')}
        ${playerButton('Observe', 'observe', name, 'eye')}
        ${playerButton('Unwatch', 'unwatch', name, 'eye')}
        ${playerButton('Come', 'come', name, 'map-pin')}
        ${playerButton('Greet', 'greet', name, 'activity')}
      </div>
    </div>
    <div class="grid grid--2" style="margin-top:12px">
      <div>${kvRows([
        ['Distance', distanceText(player)],
        ['Position', positionText(player)],
        ['Dimension', player.dimension ? esc(humanize(player.dimension)) : 'Unknown'],
        ['Health', player.health === null || player.health === undefined ? 'Not exposed' : `${num(player.health)}/20`],
        ['Presence source', esc(humanize(player.presenceSource || 'unknown'))],
        ['Seen by', (player.seenBy || []).length ? esc((player.seenBy || []).join(', ')) : 'Server list only'],
        ['Watched by', tasks.length ? esc(tasks.join(', ')) : 'No active watch']
      ])}</div>
      <div>
        <div class="row row--wrap" style="margin-bottom:8px">
          ${player.category === 'target' ? commandButton('Remove target', `players target remove ${name}`, 'target', { danger: true }) : commandButton('Authorise target', `players target add ${name}`, 'target', { danger: true, confirm: `Authorise ${name} as a PvP target? PvP must also be enabled and the player must satisfy the policy.` })}
          ${player.category === 'protected' ? commandButton('Unprotect', `players unprotect ${name}`, 'shield') : commandButton('Protect', `players protect ${name}`, 'shield-check')}
          ${player.category === 'trusted' ? commandButton('Untrust', `players untrust ${name}`, 'heart') : commandButton('Trust', `players trust ${name}`, 'heart')}
          ${commandButton('Forget', `players forget ${name}`, 'trash', { danger: true, confirm: `Remove ${name} from the seen-player directory? This does not change any PvP list.` })}
        </div>
        <div class="chips" style="margin-bottom:8px">
          ${tags.map((tag) => `<span class="chip">${esc(tag)} <button class="chip-x" type="button" data-command="players untag ${name} ${esc(tag)}" title="Remove tag">×</button></span>`).join('') || '<span class="tiny muted">No tags</span>'}
        </div>
        <form class="row row--wrap" data-player-tag data-player="${esc(name)}" style="margin-bottom:8px">
          <input class="input input--sm" name="tag" placeholder="tag (e.g. supplier)" aria-label="Tag ${esc(name)}" pattern="[A-Za-z0-9_-]{1,24}" required>
          <button class="button button--sm" type="submit">${icon('flag')} Tag</button>
        </form>
        <form class="row row--wrap" data-player-note data-player="${esc(name)}" style="margin-bottom:8px">
          <input class="input input--sm grow" name="note" maxlength="280" placeholder="Operator note" aria-label="Note about ${esc(name)}" required>
          <button class="button button--sm" type="submit">${icon('edit')} Save note</button>
        </form>
        ${notes.length ? `<div class="tiny muted" style="margin-bottom:8px">${notes.map((note) => `${esc(note.text)} · ${timeAgo(note.at)}`).join('<br>')}</div>` : ''}
        <form class="row row--wrap" data-player-give data-player="${esc(name)}" style="margin-bottom:8px">
          <input class="input input--sm" name="item" placeholder="item id (oak_log)" aria-label="Item to give ${esc(name)}" required>
          <input class="input input--sm" name="count" type="number" min="1" max="2304" value="1" aria-label="Item count">
          <button class="button button--sm button--primary" type="submit">${icon('package')} Give item</button>
        </form>
        <div class="row row--wrap" style="margin-bottom:8px">${playerButton('Drop loot', 'drop', name, 'package', { primary: true })}</div>
        <form class="row row--wrap" data-player-message data-player="${esc(name)}">
          <input class="input input--sm grow" name="text" maxlength="200" placeholder="Message ${esc(name)}" aria-label="Message ${esc(name)}" required>
          <button class="button button--sm" type="submit">${icon('activity')} Send</button>
        </form>
      </div>
    </div>
    <div class="tiny muted" style="margin-top:8px">Gear, tools, armour, totems and food reserves are never included in “Drop loot”. Explicit item gifts are delivered only when the player is visible.</div>
  </div>`;
}

function playersList() {
  const list = rows();
  if (!list.length) {
    return `<div class="card">${emptyState('No players seen yet', 'A player appears here after any bot sees them in render distance or in the server player list. Following or observing a player never authorises PvP.', 'users')}</div>`;
  }
  return `<div class="grid" style="gap:12px">${list.map(playerCard).join('')}</div>`;
}

function watchTable() {
  const list = watches();
  if (!list.length) return `<div class="card card--pad"><div class="card-title">No player watch reported</div><p class="muted">Per-bot follow, guard, escort and observe state appears here once a controller is registered.</p></div>`;
  const moveCell = (row) => {
    const move = row.lastMoveResult;
    if (!move) return '<span class="tiny muted">—</span>';
    const ok = move.ok !== false;
    const detail = [ok ? 'moved' : 'blocked', move.durationMs ? duration(move.durationMs) : null, move.attempts ? `${move.attempts} attempt${move.attempts === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
    return `<span class="tiny ${ok ? '' : 'muted'}" title="${esc(move.error || '')}">${badge(ok ? 'OK' : 'Failed', ok ? 'success' : 'warning')} ${esc(detail)}${row.lastMoveAt ? ` · ${timeAgo(row.lastMoveAt)}` : ''}</span>`;
  };
  return `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Bot</th><th>Mode</th><th>Target</th><th>Distance</th><th>Presence</th><th>Intercept</th><th>Last move</th><th>Last action</th><th></th></tr></thead><tbody>
    ${list.map((row) => `<tr>
      <td class="mono">${esc(row.bot)}</td>
      <td>${badge(row.mode || 'IDLE', row.mode ? 'info' : 'neutral')}${row.followCatchUp ? ` ${badge('Catch-up', 'warning')}` : ''}</td>
      <td>${esc(row.target || '—')}</td>
      <td>${row.distance === null || row.distance === undefined ? '—' : num(row.distance)}</td>
      <td>${row.visible ? badge('Visible', 'success') : row.targetOnline ? badge('Online', 'info') : badge('Offline', 'neutral')}</td>
      <td class="tiny muted">${row.followLeadMs === null || row.followLeadMs === undefined ? '—' : `${num(row.followLeadMs)} ms lead`}${row.targetVelocityAgeMs !== null && row.targetVelocityAgeMs !== undefined ? `<br>velocity ${duration(row.targetVelocityAgeMs)} old` : ''}</td>
      <td>${moveCell(row)}</td>
      <td class="tiny muted">${esc(row.lastAction || '—')}${row.lastActionAt ? ` · ${timeAgo(row.lastActionAt)}` : ''}</td>
      <td>${row.active ? `<button class="button button--sm button--danger-ghost" type="button" data-command="players stop ${esc(row.bot)}" data-danger="true" data-confirm-title="Stop watch" data-confirm-message="Stop the ${esc(row.mode || '')} watch on ${esc(row.bot)}?">${icon('stop')} Stop</button>` : ''}</td>
    </tr>`).join('')}
  </tbody></table></div></div>`;
}

function eventList() {
  const events = directory().recentEvents || [];
  if (!events.length) return `<div class="card card--pad"><div class="card-title">Directory events</div><p class="muted">Join, protection and target changes appear here as they happen.</p></div>`;
  return `<section class="card"><div class="card-header"><div class="card-title">${icon('activity')} Directory events</div><span class="tiny muted">${events.length} recent</span></div><div class="card-body">
    ${events.slice().reverse().map((event) => `<div class="row row--between" style="gap:12px;margin-bottom:6px"><span class="tiny">${badge(humanize(event.type), event.type === 'ONLINE' ? 'success' : 'neutral')} ${esc(event.name || '')}${event.source ? ` <span class="muted">via ${esc(humanize(event.source))}</span>` : ''}</span><span class="tiny muted">${timeAgo(event.at)}</span></div>`).join('')}
  </div></section>`;
}

function selectedBot(root) {
  const select = root.querySelector('[data-player-bot]');
  return select && select.value ? select.value : 'all';
}

function applyFilter(root) {
  const category = String((root.querySelector('[data-player-filter]') || {}).value || '');
  const search = String((root.querySelector('[data-player-search]') || {}).value || '').toLowerCase().trim();
  let visible = 0;
  for (const card of root.querySelectorAll('[data-player-card]')) {
    const matchCategory = !category || card.dataset.category === category;
    const matchSearch = !search || String(card.dataset.search || '').toLowerCase().includes(search);
    const show = matchCategory && matchSearch;
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  const count = root.querySelector('[data-player-count]');
  if (count) count.textContent = `${visible} player${visible === 1 ? '' : 's'}`;
}

async function runLine(button, line, { title = 'Player action failed' } = {}) {
  setButtonLoading(button, true);
  try {
    const result = await runCommand(line);
    const message = resultMessage(result);
    toast({ type: message.type, title: message.title, message: message.message });
  } catch (err) {
    toast({ type: 'error', title, message: err.message });
  } finally {
    setButtonLoading(button, false);
  }
}

function wireForms(root) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-player-action]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    await runLine(button, playerCommand(root, button.dataset.playerAction, button.dataset.player, button.dataset.playerArgs || ''));
  });
  for (const input of root.querySelectorAll('[data-player-filter], [data-player-search]')) {
    input.addEventListener('input', () => applyFilter(root));
    input.addEventListener('change', () => applyFilter(root));
  }
  const targetForm = root.querySelector('[data-target-form]');
  if (targetForm) {
    targetForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(targetForm);
      const player = String(data.get('player') || '').trim();
      if (!/^[A-Za-z0-9_]{1,32}$/.test(player)) {
        toast({ type: 'error', title: 'Invalid player', message: 'Use an exact Minecraft name.' });
        return;
      }
      const ok = await confirmDialog({
        title: 'Authorise PvP target',
        message: `Allow the fleet to attack ${player} when PvP and all policy gates permit it?`,
        confirmLabel: 'Authorise target',
        tone: 'danger',
        details: 'This adds an explicit player target. Protection and trust still override it, and no player is auto-targeted.'
      });
      if (!ok) return;
      await runLine(targetForm.querySelector('button[type="submit"]'), `players target add ${player}`, { title: 'Target authorisation failed' });
      targetForm.reset();
    });
  }
  for (const form of root.querySelectorAll('[data-player-give]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const player = form.dataset.player;
      const item = String(data.get('item') || '').trim().toLowerCase();
      const count = Math.max(1, Math.min(2304, Number(data.get('count')) || 1));
      if (!/^[a-z0-9_:]{1,64}$/.test(item)) {
        toast({ type: 'error', title: 'Invalid item', message: 'Use a Minecraft item id such as oak_log.' });
        return;
      }
      await runLine(form.querySelector('button[type="submit"]'), `players give ${player} ${item} ${count} ${selectedBot(root)}`, { title: 'Give failed' });
    });
  }
  for (const form of root.querySelectorAll('[data-player-message]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const player = form.dataset.player;
      // The command line tokeniser treats quotes and shell characters as
      // syntax. Strip those from free text; the backend validates again.
      const text = String(data.get('text') || '').replace(/["'\\`;$|&<>]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return;
      await runLine(form.querySelector('button[type="submit"]'), `players message ${player} --bot ${selectedBot(root)} ${text}`, { title: 'Message failed' });
      form.reset();
    });
  }
  for (const form of root.querySelectorAll('[data-player-note]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const text = String(data.get('note') || '').replace(/["'\\`;$|&<>]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return;
      await runLine(form.querySelector('button[type="submit"]'), `players note ${form.dataset.player} ${text}`, { title: 'Note failed' });
      form.reset();
    });
  }
  for (const form of root.querySelectorAll('[data-player-tag]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const tag = String(data.get('tag') || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,24}$/.test(tag)) {
        toast({ type: 'error', title: 'Invalid tag', message: 'Tags are letters, digits, _ or -.' });
        return;
      }
      await runLine(form.querySelector('button[type="submit"]'), `players tag ${form.dataset.player} ${tag}`, { title: 'Tag failed' });
      form.reset();
    });
  }
}

export const playersPage = {
  title: 'Players',
  render() {
    return `<div class="page">
      ${pageHeader({
        eyebrow: 'Fleet', title: 'Players',
        description: 'Presence, identity and relationship management for every player the fleet has seen. Watch actions, PvP authorisation, protection and trust are separate decisions.',
        actions: `<button class="button" type="button" data-command="players refresh">${icon('refresh')} Rescan</button><button class="button" type="button" data-command="players events 50">${icon('activity')} Events</button>`
      })}
      ${summaryStrip()}
      ${controlBar()}
      ${pvpPanel()}
      <div class="grid grid--2" style="align-items:start; gap:16px">
        <div>
          <div class="section-title">Seen players</div>
          ${playersList()}
        </div>
        <div>
          <div class="section-title">Following players &amp; watches</div>
          ${watchTable()}
          <div style="margin-top:12px">${eventList()}</div>
          <div class="card card--pad" style="margin-top:12px">
            <div class="card-title">Follow diagnostics</div>
            <p class="muted tiny"><span class="mono">Intercept</span> is the lead used to meet a moving player, capped at 4 blocks and derived from per-tick velocity (or a positional delta under 2.5 s). <span class="mono">Catch-up</span> starts when the gap exceeds follow distance + 6 and shortens the movement cadence to 500 ms. A failed move is retried after an 800 ms penalty rather than every tick.</p>
          </div>
          <div class="card card--pad" style="margin-top:12px">
            <div class="card-title">Safety model</div>
            <p class="muted">Follow, escort, guard and observe never grant PvP. Guard and escort attack hostile mobs only. A player is attacked only when named on the explicit target list, PvP is enabled, server PvP is on, the player is protected neither by trust nor protection, and the active targeting mode accepts the engagement.</p>
          </div>
        </div>
      </div>
    </div>`;
  },
  mount(root) {
    wireForms(root);
    applyFilter(root);
  }
};
