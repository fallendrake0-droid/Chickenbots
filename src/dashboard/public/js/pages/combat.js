import { state, runCommand } from '../store.js';
import { icon } from '../icons.js';
import { esc, num, humanize, timeAgo, sum } from '../utils.js';
import { badge, progress, kvRows, emptyState, pageHeader, statCard, toast, setButtonLoading, resultMessage } from '../ui.js';
import { botNames, bots } from './shared.js';

function combatRows() {
  return (state.snapshot && state.snapshot.combat) || [];
}

function teamStatus() {
  return (state.snapshot && state.snapshot.combatTeam) || null;
}

function gearOf(row) {
  return (row && row.loadout && row.loadout.gear) || {};
}

function totemsOf(row) {
  return (row && row.totemStatus) || { count: (row && row.totems) || 0, equipped: false, reserve: 0 };
}

function suppliesOf(row) {
  const supplies = (row && row.supplies) || {};
  const food = Array.isArray(supplies.food) ? supplies.food : [];
  const potions = Array.isArray(supplies.potions) ? supplies.potions : [];
  return {
    goldenApples: Number(supplies.goldenApples || 0),
    enchantedGoldenApples: Number(supplies.enchantedGoldenApples || 0),
    food: sum(food, (item) => item.count || 0),
    potions: sum(potions, (item) => item.count || 0),
    milk: Number(supplies.milk || 0),
    potionList: potions
  };
}

function durabilityText(value) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return `${num(value.remaining)}/${num(value.max)}`;
  return num(value);
}

function rowFor(name) {
  return combatRows().find((row) => row.bot === name) || null;
}

function botFor(name) {
  return bots().find((bot) => bot.name === name) || null;
}

function botLinks(current, base) {
  return `<div class="chips">${botNames().map((name) => `<a class="chip${name === current ? ' is-active' : ''}" href="#/${base}/${encodeURIComponent(name)}">${esc(name)}</a>`).join('')}</div>`;
}

function commandButton(label, line, iconName, { danger = false, primary = false, title = '' } = {}) {
  return `<button class="button button--sm${danger ? ' button--danger-ghost' : primary ? ' button--primary' : ''}" type="button" data-command="${esc(line)}"${title ? ` title="${esc(title)}"` : ''}>${icon(iconName)}${esc(label)}</button>`;
}

function stateTone(value) {
  return ['FIGHTING', 'ATTACKING', 'ENGAGING', 'DEFENDING', 'RESCUING', 'REPOSITIONING', 'APPROACHING', 'DEAD'].includes(value) ? 'danger'
    : ['RETREATING', 'FLEEING', 'PANIC'].includes(value) ? 'warning'
      : ['ENGAGED', 'PREPARING', 'LOOTING', 'FOLLOWING'].includes(value) ? 'info' : 'neutral';
}

function counts() {
  const rows = combatRows();
  return {
    rows,
    pve: rows.filter((row) => row.armed && row.pveEnabled).length,
    pvp: rows.filter((row) => row.pvp && row.pvp.enabled).length,
    occupied: rows.filter((row) => !['IDLE', 'DEAD'].includes(row.state)).length,
    totems: sum(rows, (row) => totemsOf(row).count),
    targets: (rows[0] && rows[0].pvp && rows[0].pvp.targets) || []
  };
}

function combatSummaryStrip() {
  const data = counts();
  const team = teamStatus();
  return `<div class="grid grid--stats">
    ${statCard({ label: 'PvE combat', value: `${num(data.pve)}<small>/${num(data.rows.length)}</small>`, iconName: 'sword', tone: data.pve === data.rows.length && data.rows.length ? 'success' : data.pve ? 'warning' : 'neutral', context: data.pve ? 'Armed for hostile mobs' : 'Combat disarmed' })}
    ${statCard({ label: 'PvP authorisation', value: data.pvp ? 'On' : 'Off', iconName: 'target', tone: data.pvp ? 'warning' : 'neutral', context: data.targets.length ? `${data.targets.length} explicit target${data.targets.length === 1 ? '' : 's'}` : 'No players authorised' })}
    ${statCard({ label: 'Total totems', value: num(data.totems), iconName: 'shield-check', tone: data.totems >= 5 ? 'success' : data.totems ? 'warning' : 'danger', context: team ? `Team mode ${team.mode}` : 'Team coordinator offline' })}
    ${statCard({ label: 'Engaged now', value: `${num(data.occupied)}<small>/${num(data.rows.length)}</small>`, iconName: 'activity', tone: data.occupied ? 'info' : 'neutral', context: team && team.focus ? `Focus: ${humanize(team.focus.name || team.focus)}` : 'No focus target' })}
  </div>`;
}

function commandBar() {
  return `<div class="card card--pad">
    <div class="row row--between row--wrap">
      <div>
        <div class="card-title">Combat controls</div>
        <p class="muted">Every control sends a real command. PvE runs only hostile profiles; PvP stays off until a player is explicitly authorised.</p>
      </div>
      <div class="row row--wrap">
        ${commandButton('PvE on', 'pve on', 'play', { primary: true })}
        ${commandButton('PvE off', 'pve off', 'pause')}
        ${commandButton('Arm team', 'combat on', 'shield-check')}
        ${commandButton('Disarm', 'combat off', 'stop', { danger: true })}
        ${commandButton('Stop all', 'combat stop', 'x-circle', { danger: true })}
        ${commandButton('Team retreat', 'team combat retreat', 'arrow-left', { danger: true })}
      </div>
    </div>
  </div>`;
}

function observedPlayerCard() {
  const threat = combatRows().map((row) => row.nearestThreat).find((entry) => entry && entry.username);
  if (!threat) return '<div class="card card--pad"><div class="card-title">Observed player</div><p class="muted">No authorised player is visible. Following or looking at a player never adds them to the target list.</p></div>';
  const gear = [...(Array.isArray(threat.equipment) ? threat.equipment : []), threat.heldItem].filter(Boolean);
  return `<div class="card card--pad"><div class="card-title">Observed player</div>
    ${kvRows([
      ['Name', esc(threat.username)], ['Distance', threat.distance === undefined ? '—' : `${num(threat.distance)} blocks`],
      ['Health', threat.health === undefined ? 'Not exposed' : `${num(threat.health)}/20`],
      ['Blocking', threat.blocking ? 'Yes' : 'No'], ['Visible gear', gear.length ? gear.map(esc).join(', ') : 'Not exposed']
    ])}
  </div>`;
}

function automationCard() {
  const features = [
    ['weapon', 'Weapon'], ['armour', 'Armour'], ['shield', 'Shield'], ['totem', 'Totem'],
    ['food', 'Food'], ['potions', 'Potions'], ['heal', 'Emergency heal']
  ];
  return `<div class="card card--pad">
    <div class="card-title">Combat automation</div>
    <p class="muted">These switches change real controller policy; they do not fabricate equipment or effects.</p>
    <div class="list">${features.map(([key, label]) => `<div class="list-row"><span>Auto ${esc(label.toLowerCase())}</span><div class="row">${commandButton('On', `auto ${key} on`, 'play')}${commandButton('Off', `auto ${key} off`, 'pause')}</div></div>`).join('')}</div>
  </div>`;
}

function wireCombatForms() {
  for (const form of document.querySelectorAll('[data-combat-form]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const name = String(data.get('player') || data.get('target') || '').trim();
      if (!name) { toast({ type: 'error', title: 'Name required', message: 'Enter an exact Minecraft username or team bot name.' }); return; }
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        let line;
        if (form.dataset.combatForm === 'protect') line = `target protect ${name}`;
        else if (form.dataset.combatForm === 'follow') line = `follow ${name} ${Number(data.get('distance') || 4)}`;
        else line = `target add ${name}`;
        const result = await runCommand(line, { confirm: false });
        toast({ type: result.ok ? 'success' : 'error', title: result.ok ? 'Command accepted' : 'Command refused', message: resultMessage(result) });
        if (result.ok) form.reset();
      } finally { setButtonLoading(button, false); }
    });
  }
}

function botCombatCard(row) {
  const bot = botFor(row.bot) || {};
  const health = Number(bot.health ?? row.health ?? 0);
  const food = Number(bot.food ?? row.food ?? 0);
  const gear = gearOf(row);
  const weapon = row.weapon || gear.bestWeapon;
  const armor = row.armorPoints !== undefined ? row.armorPoints : (gear.armor && gear.armor.points);
  const totem = totemsOf(row);
  const supplies = suppliesOf(row);
  const target = row.target || null;
  return `<article class="card card--pad bot-combat-card">
    <div class="row row--between">
      <div class="row">
        <span class="avatar">${esc((row.bot || '?').slice(0, 2))}</span>
        <div><div class="card-title">${esc(row.bot)}</div><div class="muted">${esc(humanize(row.role || 'UNASSIGNED'))} · ${esc(humanize(row.mode || 'BALANCED'))}</div></div>
      </div>
      ${badge(humanize(row.state || 'IDLE'), stateTone(row.state), { dot: true })}
    </div>
    <div class="stack stack--sm">
      <div class="row row--between"><span class="muted">Health</span><span>${num(health)}/20</span></div>
      ${progress(health, 20, { tone: health >= 16 ? 'success' : health >= 10 ? 'warning' : 'danger', sm: true })}
      <div class="row row--between"><span class="muted">Food</span><span>${num(food)}/20</span></div>
      ${progress(food, 20, { tone: food >= 16 ? 'success' : food >= 10 ? 'warning' : 'danger', sm: true })}
    </div>
    ${kvRows([
      ['Target', target ? `${esc(humanize(target.name || target))}${target.type ? ` · ${esc(target.type)}` : ''}` : '—'],
      ['Weapon', weapon ? `${esc(humanize(weapon.name || weapon))}${weapon.damage ? ` · ${esc(String(weapon.damage))} dmg` : ''}` : '—'],
      ['Armour score', armor === undefined ? '—' : esc(String(armor))],
      ['Totems', `${esc(String(totem.count ?? 0))}${totem.equipped ? ' · offhand' : ''}`],
      ['Golden apples', num(supplies.goldenApples)],
      ['Shield', row.shield ? 'Equipped' : 'None']
    ])}
    <div class="row row--wrap">
      ${commandButton('Fight', `combat on`, 'sword', { primary: true })}
      ${commandButton('Guard', 'guard 0 64 0', 'shield')}
      ${commandButton('Retreat', 'team combat retreat', 'arrow-left', { danger: true })}
      <a class="button button--sm" href="#/combat-gear/${encodeURIComponent(row.bot)}">${icon('layers')} Gear</a>
    </div>
  </article>`;
}

function eventFeed(limit = 12) {
  const events = combatRows().flatMap((row) => (row.events || []).map((event) => ({ ...event, bot: row.bot })))
    .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime()).slice(0, limit);
  if (!events.length) return emptyState('No combat events yet', 'Events appear when a bot engages a hostile mob, pops a totem, retreats or loots a kill.', 'sword');
  return `<div class="list">${events.map((event) => `<div class="list-row">
    <div><strong>${esc(event.bot)}</strong> ${esc(humanize(event.type || 'event'))}</div>
    <div class="muted">${esc(event.detail || event.target || event.reason || event.item || '')} · ${esc(timeAgo(new Date(event.at).getTime()))}</div>
  </div>`).join('')}</div>`;
}

export const combatPage = {
  title: 'Combat overview',
  render() {
    const team = teamStatus();
    const totals = combatRows().reduce((sums, entry) => {
      const stats = entry.stats || {};
      for (const key of ['kills', 'deaths', 'damageDealt', 'damageReceived', 'totemActivations', 'rescues', 'retreats', 'playerKills', 'verifiedKills', 'attacks', 'misses']) {
        sums[key] = (sums[key] || 0) + (Number(stats[key]) || 0);
      }
      return sums;
    }, {});
    return `<div class="page">
      ${pageHeader({
        eyebrow: 'Combat operations', title: 'Combat overview',
        description: 'PvE and explicit PvP state for the five-bot team. Health, food, weapons, totems, targets and events all come from the live combat controller.',
        actions: `<a class="button" href="#/combat-team">${icon('users')} Team fight</a><a class="button button--primary" href="#/combat-targets">${icon('target')} Targets</a>`
      })}
      ${combatSummaryStrip()}
      ${commandBar()}
      ${automationCard()}
      <div class="section">
        ${pageHeader({ title: 'Bot combat state', description: team ? `${team.bots.length} controllers · coordinator ${team.enabled ? 'enabled' : 'disabled'} · mode ${team.mode}` : 'Waiting for team coordinator state.' })}
        <div class="grid grid--cards">${combatRows().length ? combatRows().map(botCombatCard).join('') : emptyState('Combat controller unavailable', 'The runtime did not expose combat state yet.', 'sword')}</div>
      </div>
      <div class="grid grid--2">
        <div class="card card--pad"><div class="card-title">Engagement log</div>${eventFeed()}</div>
        <div class="card card--pad"><div class="card-title">Team statistics</div>${kvRows([
          ['Kills', num(totals.kills)], ['Verified kills', num(totals.verifiedKills)], ['Deaths', num(totals.deaths)],
          ['Damage dealt', num(totals.damageDealt)], ['Damage taken', num(totals.damageReceived)], ['Totems popped', num(totals.totemActivations)],
          ['Rescues', num((team && team.stats && team.stats.rescues) || totals.rescues)], ['Healing assists', num(team && team.stats && team.stats.heals)], ['Retreats', num(totals.retreats)],
          ['Focus target', team && team.focus ? esc(humanize(team.focus.name || team.focus)) : '—']
        ])}</div>
      </div>
    </div>`;
  }
};

export const combatTeamPage = {
  title: 'Team fight',
  render() {
    const team = teamStatus();
    if (!team) return `<div class="page">${pageHeader({ eyebrow: 'Combat operations', title: 'Team fight' })}${emptyState('Team coordinator offline', 'TeamCombatCoordinator was not attached to this runtime.', 'users')}</div>`;
    return `<div class="page">
      ${pageHeader({
        eyebrow: 'Combat operations', title: 'Team fight',
        description: 'Role assignment, focus fire, rescue priority and formation state for all five controllers.',
        actions: `${commandButton('Enable', 'team combat on', 'play', { primary: true })}${commandButton('Disable', 'team combat off', 'pause')}${commandButton('Regroup', 'team combat regroup', 'users')}${commandButton('Retreat', 'team combat retreat', 'arrow-left', { danger: true })}`
      })}
      ${statCard({ label: 'Formation', value: humanize(team.formation || team.mode || '—'), iconName: 'layout', tone: team.enabled ? 'success' : 'neutral', context: team.enabled ? 'Team coordination active' : 'Coordination disabled' })}
      <div class="section">
        ${pageHeader({ title: 'Roles', description: 'COORDINATOR, FRONTLINE, RANGED, SUPPORT and RESERVE are assigned from each bot’s real loadout.' })}
        <div class="grid grid--cards">${(team.bots || []).map((row) => `<article class="card card--pad">
          <div class="row row--between"><div class="card-title">${esc(row.bot)}</div>${badge(humanize(row.role || 'UNASSIGNED'), row.role === 'FRONTLINE' ? 'danger' : row.role === 'RANGED' ? 'info' : row.role === 'SUPPORT' ? 'success' : 'neutral')}</div>
          ${kvRows([
            ['Focus', row.focus ? esc(humanize(row.focus.name || row.focus)) : '—'],
            ['State', humanize(row.state || 'IDLE')],
            ['Retreating', row.retreating ? 'Yes' : 'No'],
            ['Distance', row.distance === undefined ? '—' : `${num(row.distance)} blocks`]
          ])}
          <a class="button button--sm" href="#/combat-gear/${encodeURIComponent(row.bot)}">${icon('layers')} Inspect loadout</a>
        </article>`).join('')}</div>
      </div>
      <div class="grid grid--2">
        <div class="card card--pad"><div class="card-title">Focus target</div>${team.focus ? kvRows([['Name', humanize(team.focus.name || team.focus)], ['Type', team.focus.type || '—'], ['Distance', team.focus.distance === undefined ? '—' : `${num(team.focus.distance)} blocks`], ['Priority', team.focus.priority || '—']]) : emptyState('No focus target', 'Focus is selected from real nearby threats during planning.', 'target')}</div>
        <div class="card card--pad"><div class="card-title">Mode</div>
          <div class="row row--wrap">${['TEAM_FIGHT', 'DEFENSIVE', 'GUARD', 'ARENA', 'BOSS', 'ESCORT', 'RETREAT'].map((mode) => commandButton(humanize(mode), `combat mode ${mode}`, 'sliders')).join('')}</div>
          ${kvRows([['Active mode', humanize(team.mode)], ['Enabled', team.enabled ? 'Yes' : 'No'], ['Engaged', num(team.engaged)]])}
        </div>
      </div>
      <div class="card card--pad"><div class="card-title">Follow</div>
        <p class="muted">Follow a teammate or a visible player at a safe distance. Following never authorises PvP by itself.</p>
        <form class="form-row" data-combat-form="follow">
          <div class="field"><label class="field-label" for="combat-follow-target">Bot or player</label><input class="input" id="combat-follow-target" name="target" maxlength="32" placeholder="e.g. 1010100 or an exact player name" required></div>
          <div class="field"><label class="field-label" for="combat-follow-distance">Distance</label><select class="input" id="combat-follow-distance" name="distance"><option value="3">3</option><option value="4" selected>4</option><option value="6">6</option><option value="8">8</option></select></div>
          <button class="button button--primary" type="submit">${icon('users')} Follow</button>
          ${commandButton('Stop following', 'follow stop', 'pause')}
        </form>
      </div>
    </div>`;
  },
  mount() { wireCombatForms(); }
};

export const combatGearPage = {
  title: 'Equipment',
  render(params = {}) {
    const current = params.bot || (combatRows()[0] && combatRows()[0].bot) || '';
    const row = rowFor(current);
    if (!row) return `<div class="page">${pageHeader({ eyebrow: 'Combat operations', title: 'Equipment' })}${emptyState('No combat state', 'Equipment is reported per bot by the combat controller.', 'layers')}</div>`;
    const gear = gearOf(row);
    const weapons = gear.weapons || [];
    const armorPieces = (gear.armor && gear.armor.selected) || [];
    const armor = Array.isArray(armorPieces) ? armorPieces : Object.values(gear.armor.pieces || {});
    return `<div class="page">
      ${pageHeader({ eyebrow: 'Combat operations', title: `Equipment · ${current}`, description: 'Weapon damage, enchantments, durability and armour evaluation from the bot’s actual inventory.', actions: `${commandButton('Optimise', `gear optimise ${current}`, 'wrench', { primary: true })}${commandButton('Progression', `gear progression ${current}`, 'arrow-up-right')}${commandButton('Auto weapon on', 'auto weapon on', 'sword')}` })}
      ${botLinks(current, 'combat-gear')}
      <div class="grid grid--stats">
        ${statCard({ label: 'Best weapon', value: gear.bestWeapon ? humanize(gear.bestWeapon.name) : 'None', iconName: 'sword', tone: gear.bestWeapon ? 'success' : 'danger', context: gear.bestWeapon ? `${num(gear.bestWeapon.effectiveDamage || gear.bestWeapon.damage)} damage · ${durabilityText(gear.bestWeapon.durability)} durability` : 'No usable weapon in inventory' })}
        ${statCard({ label: 'Armour score', value: num(row.armorPoints !== undefined ? row.armorPoints : (gear.armor && gear.armor.points)), iconName: 'shield', tone: (row.armorPoints || 0) >= 15 ? 'success' : row.armorPoints ? 'warning' : 'danger', context: gear.broken && gear.broken.length ? `${gear.broken.length} broken piece(s)` : 'All pieces serviceable' })}
        ${statCard({ label: 'Offhand', value: row.shield ? 'Shield' : totemsOf(row).equipped ? 'Totem' : 'Empty', iconName: 'shield-check', tone: row.shield || totemsOf(row).equipped ? 'success' : 'neutral', context: `${num(totemsOf(row).count)} totem(s) carried` })}
        ${statCard({ label: 'Projectile protection', value: num(gear.armor && gear.armor.protection), iconName: 'shield-alert', tone: gear.armor && gear.armor.protection ? 'success' : 'warning', context: 'Weighted enchant evaluation' })}
      </div>
      <div class="grid grid--2">
        <div class="card card--pad"><div class="card-title">Weapons</div>
          ${weapons.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Weapon</th><th>Damage</th><th>Durability</th><th>Enchants</th></tr></thead><tbody>${weapons.map((weapon) => `<tr><td>${esc(humanize(weapon.name))}</td><td>${num(weapon.effectiveDamage !== undefined ? weapon.effectiveDamage : weapon.damage)}</td><td>${durabilityText(weapon.durability)}</td><td>${Object.keys(weapon.enchantments || {}).length ? Object.entries(weapon.enchantments).map(([name, level]) => `${esc(humanize(name))} ${esc(String(level))}`).join(', ') : '—'}</td></tr>`).join('')}</tbody></table></div>` : emptyState('No weapons', 'Craft or withdraw a sword, axe or bow.', 'sword')}
        </div>
        <div class="card card--pad"><div class="card-title">Armour</div>
          ${armor.length ? kvRows(armor.map((piece) => [humanize(piece.slot || piece.name), `${humanize(piece.name)}${piece.protection && piece.protection.general ? ` · Prot ${piece.protection.general}` : ''}${piece.durability !== undefined ? ` · ${durabilityText(piece.durability)} dura` : ''}`])) : emptyState('No armour', 'Equip armour from the inventory to raise the score.', 'shield')}
        </div>
      </div>
      <div class="card card--pad"><div class="card-title">Broken or nearly broken</div>
        ${gear.broken && gear.broken.length ? `<div class="list">${gear.broken.map((item) => `<div class="list-row"><span>${esc(humanize(item.name || item))}</span>${badge('Replace', 'danger')}</div>`).join('')}</div>` : '<p class="muted">No broken gear reported.</p>'}
      </div>
    </div>`;
  }
};

export const combatSuppliesPage = {
  title: 'Totems & supplies',
  render() {
    const rows = combatRows();
    const total = sum(rows, (row) => totemsOf(row).count);
    const reserve = rows[0] ? totemsOf(rows[0]).reserve : 0;
    return `<div class="page">
      ${pageHeader({ eyebrow: 'Combat operations', title: 'Totems & supplies', description: 'Offhand totems, reserve policy and consumables counted from real inventories. Refills move totems between nearby bots and verify the equip.', actions: `${commandButton('Refill', 'totem refill', 'refresh-cw', { primary: true })}${commandButton('Auto totem on', 'auto totem on', 'shield-check')}${commandButton('Auto potions on', 'auto potions on', 'droplet')}` })}
      <div class="grid grid--stats">
        ${statCard({ label: 'Team totems', value: num(total), iconName: 'shield-check', tone: total >= 5 ? 'success' : total ? 'warning' : 'danger', context: `Reserve policy ${reserve} per bot` })}
        ${statCard({ label: 'Bots below reserve', value: num(rows.filter((row) => totemsOf(row).count < reserve).length), iconName: 'alert', tone: rows.some((row) => totemsOf(row).count < reserve) ? 'warning' : 'success', context: 'Use Refill to transfer surplus totems' })}
        ${statCard({ label: 'Golden apples', value: num(sum(rows, (row) => suppliesOf(row).goldenApples)), iconName: 'heart', tone: 'neutral', context: 'Emergency healing inventory' })}
        ${statCard({ label: 'Potions', value: num(sum(rows, (row) => suppliesOf(row).potions)), iconName: 'droplet', tone: 'neutral', context: 'Healing, fire resistance, strength, swiftness' })}
      </div>
      <div class="card card--pad"><div class="card-title">Per-bot ledger</div>
        ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Bot</th><th>Totems</th><th>Offhand</th><th>Golden apples</th><th>Food</th><th>Potions</th><th>Action</th></tr></thead><tbody>${rows.map((row) => `<tr>
          <td>${esc(row.bot)}</td><td>${num(totemsOf(row).count)}</td><td>${totemsOf(row).equipped ? badge('Equipped', 'success') : badge('Not equipped', 'neutral')}</td>
          <td>${num(suppliesOf(row).goldenApples)}</td><td>${num(suppliesOf(row).food)}</td><td>${num(suppliesOf(row).potions)}</td>
          <td>${commandButton('Equip', 'totem refill', 'shield')}</td>
        </tr>`).join('')}</tbody></table></div>` : emptyState('No supply state', 'The combat controller has not reported inventories.', 'package')}
      </div>
    </div>`;
  }
};

export const combatTargetsPage = {
  title: 'PvP & targets',
  render() {
    const rows = combatRows();
    const first = rows[0] || {};
    const policy = first.pvp || {};
    const team = teamStatus();
    const arenas = policy.arenas || [];
    return `<div class="page">
      ${pageHeader({ eyebrow: 'Combat operations', title: 'PvP & targets', description: 'PvP is off by default. A player must be explicitly authorised here before any bot may attack; teammates are always excluded.', actions: `${commandButton('PvP on', 'pvp on', 'target', { primary: true })}${commandButton('PvP off', 'pvp off', 'lock', { danger: true })}` })}
      <div class="card card--pad">
        <div class="card-title">Explicit target list</div>
        <p class="muted">Only names in this list can be attacked. The policy still refuses teammates, protected players, unauthorised players and any server with PvP disabled.</p>
        <form class="form-row" data-combat-form="target">
          <div class="field"><label class="field-label" for="combat-target-name">Player name</label><input class="input" id="combat-target-name" name="player" maxlength="32" placeholder="Exact Minecraft username" required></div>
          <button class="button button--primary" type="submit">${icon('plus')} Authorise</button>
          ${commandButton('Clear all', 'target clear', 'trash', { danger: true })}
        </form>
        ${policy.targets && policy.targets.length ? `<div class="chips">${policy.targets.map((name) => `<span class="chip">${esc(name)} <button class="chip-x" type="button" data-command="${esc(`target remove ${name}`)}" title="Remove ${esc(name)}">×</button></span>`).join('')}</div>` : emptyState('No authorised players', 'No bot can attack a player until one is added here.', 'lock')}
      </div>
      <div class="grid grid--2">
        <div class="card card--pad"><div class="card-title">Protection list</div>
          <form class="form-row" data-combat-form="protect"><div class="field"><label class="field-label" for="combat-protect-name">Never attack</label><input class="input" id="combat-protect-name" name="player" maxlength="32" placeholder="Ally or trader name" required></div><button class="button" type="submit">${icon('shield')} Protect</button></form>
          ${policy.protectedPlayers && policy.protectedPlayers.length ? `<div class="chips">${policy.protectedPlayers.map((name) => `<span class="chip">${esc(name)} <button class="chip-x" type="button" data-command="${esc(`target unprotect ${name}`)}" title="Unprotect">×</button></span>`).join('')}</div>` : '<p class="muted">No protected players.</p>'}
        </div>
        <div class="card card--pad"><div class="card-title">Arena</div>
          <p class="muted">PvP is allowed only inside an explicit arena box when one is configured.</p>
          <div class="row row--wrap">${commandButton('Arena on', 'arena on 24', 'target', { primary: true })}${commandButton('Arena off', 'arena off', 'x')}</div>
          ${arenas.length ? kvRows(arenas.map((arena) => [arena.name || 'arena', `${arena.min.x}, ${arena.min.y}, ${arena.min.z} → ${arena.max.x}, ${arena.max.y}, ${arena.max.z}`])) : '<p class="muted">No arena configured; server PvP rules and explicit targets still apply.</p>'}
        </div>
      </div>
      <div class="grid grid--2">
        <div class="card card--pad"><div class="card-title">Policy state</div>
          ${kvRows([
            ['PvP enabled', policy.enabled ? 'Yes' : 'No'],
            ['Server PvP', policy.serverPvp === undefined ? 'From server config' : policy.serverPvp ? 'Enabled' : 'Disabled'],
            ['Authorised targets', num((policy.targets || []).length)],
            ['Protected players', num((policy.protectedPlayers || []).length)],
            ['Policy mode', humanize(policy.mode || 'EXPLICIT')]
          ])}
          <div class="row row--wrap">${commandButton('Guard area', 'guard 0 64 0', 'shield')}${commandButton('Duel…', 'duel', 'sword', { danger: true })}</div>
        </div>
        <div class="card card--pad"><div class="card-title">Team state</div>
          ${team ? kvRows([['Mode', humanize(team.mode)], ['Enabled', team.enabled ? 'Yes' : 'No'], ['Focus', team.focus ? humanize(team.focus.name || team.focus) : '—'], ['Engaged', num(team.engaged)]]) : '<p class="muted">Coordinator unavailable.</p>'}
        </div>
        ${observedPlayerCard()}
      </div>
    </div>`;
  },
  mount() { wireCombatForms(); }
};
