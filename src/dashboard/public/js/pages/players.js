import { state, runCommand } from '../store.js';
import { icon } from '../icons.js';
import { esc, num, timeAgo, humanize } from '../utils.js';
import { badge, emptyState, pageHeader, statCard, kvRows, toast, setButtonLoading, resultMessage } from '../ui.js';
import { botNames } from './shared.js';

function directory() {
  return (state.snapshot && state.snapshot.players) || { count: 0, online: 0, rows: [], stats: null };
}

function watches() {
  return (state.snapshot && state.snapshot.playerWatch) || [];
}

function rows() {
  const value = directory().rows || directory().players || [];
  return Array.isArray(value) ? value : [];
}

function positionText(position) {
  if (!position) return 'Not visible';
  return `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
}

function distanceText(player) {
  if (player.distance === null || player.distance === undefined) return '—';
  return `${num(player.distance)}<small>m · ${esc(player.nearestBot || 'fleet')}</small>`;
}

function statusBadge(player) {
  return player.online ? badge('Online', 'success') : badge('Offline', 'neutral');
}

function commandButton(label, line, iconName, { primary = false, danger = false, title = '' } = {}) {
  return `<button class="button button--sm${primary ? ' button--primary' : ''}${danger ? ' button--danger-ghost' : ''}" type="button" data-command="${esc(line)}"${title ? ` title="${esc(title)}"` : ''}>${icon(iconName)}${esc(label)}</button>`;
}

function playerButton(label, action, player, iconName, { primary = false, args = '' } = {}) {
  return `<button class="button button--sm${primary ? ' button--primary' : ''}" type="button" data-player-action="${esc(action)}" data-player="${esc(player)}"${args ? ` data-player-args="${esc(args)}"` : ''}>${icon(iconName)}${esc(label)}</button>`;
}

function playerCommand(root, action, player, args = '') {
  const bot = selectedBot(root);
  const distance = Math.max(1, Math.min(8, Number((root.querySelector('[data-player-distance]') || {}).value) || 3));
  if (action === 'follow') return `players follow ${player} ${bot} ${distance}`;
  if (action === 'unfollow') return `players unfollow ${player} ${bot}`;
  if (action === 'guard') return `players guard ${player} ${bot} ${args || 8}`;
  if (action === 'escort') return `players escort ${player} ${bot}`;
  if (action === 'come') return `players come ${player} ${bot}`;
  if (action === 'greet') return `players greet ${player} ${bot}`;
  if (action === 'drop') return `players drop ${player} loot ${bot}`;
  return `players list`;
}

function botOptions() {
  return `<option value="all">All five bots</option>${botNames().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}`;
}

function summaryStrip() {
  const list = rows();
  const data = directory();
  const online = list.filter((player) => player.online);
  const guarding = watches().filter((row) => row.mode === 'GUARD');
  const following = watches().filter((row) => row.mode === 'FOLLOW');
  const delivered = watches().reduce((sum, row) => sum + Number((row.stats && row.stats.delivered) || 0), 0);
  return `<div class="grid grid--stats">
    ${statCard({ label: 'Players seen', value: num(data.count || list.length), iconName: 'users', tone: list.length ? 'accent' : 'neutral', context: `${online.length} online now` })}
    ${statCard({ label: 'Guarding', value: `${num(guarding.length)}<small>/${num(watches().length || 5)}</small>`, iconName: 'shield-check', tone: guarding.length ? 'success' : 'neutral', context: guarding.length ? guarding.map((row) => `${row.bot}→${row.target}`).join(', ') : 'No guard watch active' })}
    ${statCard({ label: 'Following', value: num(following.length), iconName: 'route', tone: following.length ? 'info' : 'neutral', context: following.length ? following.map((row) => `${row.bot}→${row.target}`).join(', ') : 'No follow watch active' })}
    ${statCard({ label: 'Items delivered', value: num(delivered), iconName: 'package', tone: delivered ? 'success' : 'neutral', context: 'Verified inventory drops' })}
  </div>`;
}

function controlBar() {
  return `<div class="card card--pad" style="margin-bottom:16px">
    <div class="row row--between row--wrap">
      <div>
        <div class="card-title">Player watch</div>
        <p class="muted">Follow, guard and escort real players. These controls never add a player to the PvP target list.</p>
      </div>
      <div class="row row--wrap">
        <label class="tiny muted" for="player-bot">Bot</label>
        <select class="select select--sm" id="player-bot" data-player-bot aria-label="Bot used for player actions">${botOptions()}</select>
        <label class="tiny muted" for="player-distance">Follow distance</label>
        <input class="input input--sm" id="player-distance" data-player-distance type="number" min="1" max="8" value="3" aria-label="Follow distance">
        ${commandButton('Unfollow all', 'players unfollow all', 'user-x', { danger: true })}
        ${commandButton('Stop all watches', 'players stop all', 'stop', { danger: true })}
        ${commandButton('Refresh', 'players list', 'refresh')}
      </div>
    </div>
  </div>`;
}

function playerCard(player) {
  const name = player.name;
  return `<div class="card card--pad" data-player-card data-player="${esc(name)}">
    <div class="row row--between row--wrap">
      <div>
        <div class="card-title">${esc(name)} ${statusBadge(player)}</div>
        <div class="tiny muted">${player.gamemode ? `${esc(humanize(player.gamemode))} · ` : ''}${player.ping === null || player.ping === undefined ? 'ping unknown' : `${num(player.ping)} ms`} · last seen ${timeAgo(player.lastSeen)}</div>
      </div>
      <div class="row row--wrap">
        ${playerButton('Follow', 'follow', name, 'route')}
        ${playerButton('Unfollow', 'unfollow', name, 'user-x')}
        ${playerButton('Guard', 'guard', name, 'shield-check')}
        ${playerButton('Escort', 'escort', name, 'users')}
        ${playerButton('Come', 'come', name, 'map-pin')}
        ${playerButton('Greet', 'greet', name, 'activity')}
      </div>
    </div>
    <div class="grid grid--2" style="margin-top:12px">
      <div>${kvRows([
        ['Distance', distanceText(player)],
        ['Position', esc(positionText(player.position))],
        ['Health', player.health === null || player.health === undefined ? 'Not exposed' : `${num(player.health)}/20`],
        ['Seen by', (player.seenBy || []).length ? esc((player.seenBy || []).join(', ')) : 'Server list only']
      ])}</div>
      <div>
        <form class="row row--wrap" data-player-give data-player="${esc(name)}" style="margin-bottom:8px">
          <input class="input input--sm" name="item" placeholder="item id (oak_log)" aria-label="Item to give ${esc(name)}" required>
          <input class="input input--sm" name="count" type="number" min="1" max="2304" value="1" aria-label="Item count">
          <button class="button button--sm button--primary" type="submit">${icon('package')} Give item</button>
        </form>
        <div class="row row--wrap" style="margin-bottom:8px">
          ${playerButton('Drop loot', 'drop', name, 'package', { primary: true })}
        </div>
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
    return `<div class="card">${emptyState('No players seen yet', 'A player appears here after any bot sees them in render distance or in the server player list. Following a player never authorises PvP.', 'users')}</div>`;
  }
  return `<div class="grid" style="gap:12px">${list.map(playerCard).join('')}</div>`;
}

function followingSection() {
  const list = watches().filter((row) => row.mode === 'FOLLOW');
  return `<section class="card" style="margin-bottom:16px">
    <div class="card-header">
      <div class="card-title">${icon('route')} Following players <span class="badge badge--info">${num(list.length)}</span></div>
      <div class="row row--wrap">
        ${commandButton('Unfollow all', 'players unfollow all', 'user-x', { danger: true })}
        ${commandButton('Refresh', 'players following all', 'refresh')}
      </div>
    </div>
    <div class="card-body">
      ${list.length ? `<table class="table"><thead><tr><th>Bot</th><th>Following</th><th>Distance</th><th>Visible</th><th>Last action</th><th></th></tr></thead><tbody>
        ${list.map((row) => `<tr>
          <td class="mono">${esc(row.bot)}</td>
          <td>${esc(row.target || '—')}</td>
          <td>${row.distance === null || row.distance === undefined ? '—' : num(row.distance)}</td>
          <td>${row.visible ? badge('Visible', 'success') : badge('No', 'warn')}</td>
          <td class="tiny muted">${esc(row.lastAction || '—')}${row.lastActionAt ? ` · ${timeAgo(row.lastActionAt)}` : ''}</td>
          <td>${commandButton('Unfollow', `players unfollow ${row.target || ''} ${row.bot || 'all'}`.trim(), 'user-x', { danger: true })}</td>
        </tr>`).join('')}
      </tbody></table>` : `<div class="muted">No bot is following a player. Use Follow on a player card to start; Unfollow only clears follow watches and leaves guard or escort running.</div>`}
    </div>
  </section>`;
}

function watchTable() {
  const list = watches();
  if (!list.length) return `<div class="card card--pad"><div class="card-title">No player watch reported</div><p class="muted">Per-bot follow and guard state appears here once a controller is registered.</p></div>`;
  return `<div class="card"><table class="table"><thead><tr><th>Bot</th><th>Mode</th><th>Target</th><th>Distance</th><th>Visible</th><th>Last action</th><th>Error</th></tr></thead><tbody>
    ${list.map((row) => `<tr>
      <td class="mono">${esc(row.bot)}</td>
      <td>${badge(row.mode || 'IDLE', row.mode ? 'info' : 'neutral')}</td>
      <td>${esc(row.target || '—')}</td>
      <td>${row.distance === null || row.distance === undefined ? '—' : num(row.distance)}</td>
      <td>${row.visible ? badge('Visible', 'success') : badge('No', 'warn')}</td>
      <td>${esc(row.lastAction || '—')}${row.lastActionAt ? ` · ${timeAgo(row.lastActionAt)}` : ''}</td>
      <td class="tiny muted">${esc(row.lastError || '')}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function selectedBot(root) {
  const select = root.querySelector('[data-player-bot]');
  return select && select.value ? select.value : 'all';
}

function wireForms(root) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-player-action]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const line = playerCommand(root, button.dataset.playerAction, button.dataset.player, button.dataset.playerArgs || '');
    setButtonLoading(button, true);
    try {
      const result = await runCommand(line);
      const message = resultMessage(result);
      toast({ type: message.type, title: message.title, message: message.message });
    } catch (err) {
      toast({ type: 'error', title: 'Player action failed', message: err.message });
    } finally {
      setButtonLoading(button, false);
    }
  });
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
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(`players give ${player} ${item} ${count} ${selectedBot(root)}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
      } catch (err) {
        toast({ type: 'error', title: 'Give failed', message: err.message });
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
  for (const form of root.querySelectorAll('[data-player-message]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const player = form.dataset.player;
      // The command line tokeniser treats quotes and shell characters as
      // syntax. Strip those from free text; the backend still validates the
      // message again and refuses a leading '/'.
      const text = String(data.get('text') || '').replace(/["'\\`;$|&<>]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(`players message ${player} --bot ${selectedBot(root)} ${text}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
        form.reset();
      } catch (err) {
        toast({ type: 'error', title: 'Message failed', message: err.message });
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
}

export const playersPage = {
  title: 'Players',
  render() {
    return `<div class="page">
      ${pageHeader({
        eyebrow: 'Fleet', title: 'Players',
        description: 'Every player the fleet has seen, with follow, guard, escort, give, loot-drop and message controls. PvP remains explicit-target only.',
        actions: `<button class="button" type="button" data-command="players list">${icon('refresh')} Rescan</button>`
      })}
      ${summaryStrip()}
      ${controlBar()}
      ${followingSection()}
      <div class="grid grid--2" style="align-items:start; gap:16px">
        <div>
          <div class="section-title">Seen players</div>
          ${playersList()}
        </div>
        <div>
          <div class="section-title">Watch status</div>
          ${watchTable()}
          <div class="card card--pad" style="margin-top:12px">
            <div class="card-title">How this stays safe</div>
            <p class="muted">Following or guarding never grants PvP. Guard only attacks hostile mobs that approach the player; a player is attacked only through the separate PvP target list with server PvP enabled.</p>
          </div>
        </div>
      </div>
    </div>`;
  },
  mount(root) {
    // Follow/guard buttons read the current bot and distance fields at click
    // time, so changing those controls needs no page re-render.
    wireForms(root);
  }
};
