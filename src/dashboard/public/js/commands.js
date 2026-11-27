import { state } from './store.js';
import { roster } from './utils.js';

/**
 * Client-side view of the command catalogue served by /api/commands.
 *
 * The dashboard never invents a command: a control is only rendered when its
 * command exists in this catalogue. Execution still goes through the structured
 * API, so even a malformed control cannot bypass the server-side registry.
 */

const FORBIDDEN = /[;&|`$<>\\\n\r\t]|\.\.\//;

export function commandEntries() {
  return Array.isArray(state.commands) ? state.commands : [];
}

export function findCommand(name) {
  const key = String(name || '').toLowerCase();
  if (!key) return null;
  return commandEntries().find((entry) => entry.name === key || (entry.aliases || []).includes(key)) || null;
}

export function hasCommand(name) {
  return Boolean(findCommand(name));
}

function subcommandToken(command, args = []) {
  const first = String((args && args[0]) || '').toLowerCase();
  if (!first) return '';
  const subs = (command.subcommands || []).map((entry) => (typeof entry === 'string' ? entry : entry.name)).map((entry) => String(entry).toLowerCase());
  return subs.includes(first) ? first : '';
}

export function requiresConfirmation(name, args = []) {
  const command = findCommand(name);
  if (!command) return false;
  if (command.requiresConfirmation) return true;
  if (command.confirmation === 'always' || command.metadata?.confirmation === 'always') return true;
  const sub = subcommandToken(command, args);
  // `target list` is a read-only inspection, not a destructive action. The
  // metadata table groups target operations under one subcommand, so refine it
  // here rather than prompting for a harmless refresh.
  if (sub === 'target' && String(args[1] || 'add').toLowerCase() === 'list') return false;
  // `players pvp` is a read-only status unless the operator is flipping it.
  if (sub === 'pvp' && ['', 'status'].includes(String(args[1] || 'status').toLowerCase())) return false;
  const list = (command.confirmSubcommands || command.metadata?.confirmSubcommands || []).map((entry) => String(entry).toLowerCase());
  return Boolean(sub && list.includes(sub));
}

export function isReadOnly(name) {
  const command = findCommand(name);
  if (!command) return false;
  return command.readOnly === true || command.metadata?.readOnly === true;
}

export function commandForPage(page) {
  return commandEntries().filter((command) => command.page === page);
}

export function subcommandValues(name, subName) {
  const command = findCommand(name);
  if (!command) return [];
  const entry = (command.subcommands || []).find((item) => (typeof item === 'string' ? item : item.name) === subName);
  if (!entry || typeof entry === 'string') return [];
  const first = (entry.args || [])[0];
  return first && Array.isArray(first.values) ? first.values : [];
}

/** Command-level value groups exposed by the backend metadata. */
export function commandValues(name, key) {
  const command = findCommand(name);
  if (!command || !command.values) return [];
  const list = command.values[key];
  return Array.isArray(list) ? list : [];
}

export function targets() {
  return state.targets || null;
}

export function miningChoices() {
  const catalogue = targets();
  return catalogue && Array.isArray(catalogue.choices) ? catalogue.choices : [];
}

export function findMiningTarget(value) {
  const key = String(value || '').toLowerCase().replace(/^minecraft:/, '').trim();
  if (!key) return null;
  return miningChoices().find((entry) => entry.id === key || entry.target === key
    || (entry.aliases || []).includes(key) || (entry.variants || []).includes(key)) || null;
}

/** Bot names from the live roster (never a hard-coded list). */
export function botNames() {
  return roster();
}

/** Bot rows from the snapshot, for selectors that need online/leader state. */
export function botRows() {
  return (state.snapshot && Array.isArray(state.snapshot.bots)) ? state.snapshot.bots : [];
}

export function leaderName() {
  const rows = botRows();
  const flagged = rows.find((entry) => entry.leader === true || entry.role === 'leader');
  if (flagged) return flagged.name;
  const snapshot = state.snapshot || {};
  const team = snapshot.team || {};
  // `snapshot.team` is the coordinator status envelope; the elected leader is
  // inside `state.team`. `overview.leader` is the already-resolved fallback.
  const coordinator = (team.state && team.state.team) || team;
  if (coordinator.leader) {
    if (typeof coordinator.leader === 'string') return coordinator.leader;
    if (coordinator.leader.name) return coordinator.leader.name;
  }
  if (snapshot.overview && typeof snapshot.overview.leader === 'string' && snapshot.overview.leader) return snapshot.overview.leader;
  // No elected leader reported: prefer a bot that is actually online rather
  // than an arbitrary roster entry, so commands do not target a dead session.
  const online = rows.find((entry) => entry.online === true);
  return (online && online.name) || botNames()[0] || null;
}

export function fleetSelectors() {
  return ['all', 'fleet', 'team'];
}

export function isFleetSelector(value) {
  return fleetSelectors().includes(String(value || '').toLowerCase());
}

/**
 * Display-only serialisation. It mirrors the registry tokenizer rules so the
 * preview matches what the server will actually receive; the server remains the
 * authority and rejects anything this function could not quote safely.
 */
export function quoteArg(value) {
  const text = String(value);
  if (!text) throw new Error('Command argument cannot be empty');
  if (FORBIDDEN.test(text)) throw new Error('Illegal characters in command argument');
  if (/\s/.test(text) || /^["']/.test(text)) {
    if (text.includes('"')) throw new Error('Command argument cannot contain a double quote');
    return `"${text}"`;
  }
  return text;
}

/** Quote-aware tokenizer mirroring the registry; used to inspect a UI line. */
export function parseCommandLine(line) {
  const raw = String(line || '').trim();
  if (!raw) throw new Error('Command is empty');
  if (FORBIDDEN.test(raw)) throw new Error('Illegal characters in command');
  const tokens = [];
  let current = '';
  let quote = null;
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if ((char === '"' || char === "'") && current === '') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += char;
    }
  }
  if (quote) throw new Error('Unterminated quote');
  if (current) tokens.push(current);
  return { name: tokens[0] || '', args: tokens.slice(1), line: raw };
}

export function commandPreview(name, args = []) {
  const command = findCommand(name);
  const canonical = command ? command.name : String(name || '').trim();
  if (!canonical) return '';
  try {
    return [canonical, ...(args || []).map(quoteArg)].join(' ');
  } catch (_) {
    return `${canonical} …`;
  }
}

/**
 * Resolve an operator selection into the exact argument list the registry
 * expects. The leader uses the implicit form (`mine`, `mine diamonds`) because
 * `mine leader` is not grammar; every other bot is named explicitly.
 */
export function mineArguments({ bot = null, target = null, fleet = null, stop = false } = {}) {
  const leader = leaderName();
  const args = [];
  if (fleet && String(fleet).toLowerCase() !== 'leader') args.push(String(fleet).toLowerCase());
  // `mine stop` means *every* bot. Stopping one bot — including the leader —
  // must therefore name that bot explicitly.
  else if (bot && (bot !== leader || stop)) args.push(String(bot));
  // `stop` is a terminal token, never combined with a target: the backend
  // resolves `mine <bot> <ore>` and `mine <bot> stop` as separate grammars.
  if (!stop && target) args.push(String(target));
  if (stop) args.push('stop');
  return args;
}

export function minePreview(options = {}) {
  return commandPreview('mine', mineArguments(options));
}

/**
 * `follow <player|bot> [distance]` or `follow stop`. Both the Combat page form
 * and its preview call this one builder so the operator cannot see one command
 * and execute another.
 */
export function followArguments({ target = null, distance = 4, stop = false } = {}) {
  if (stop) return ['stop'];
  const args = [];
  if (target) args.push(String(target));
  const value = Number(distance);
  if (Number.isFinite(value)) args.push(String(Math.max(2, Math.min(16, Math.round(value)))));
  return args;
}

export function followPreview(options = {}) {
  return commandPreview('follow', followArguments(options));
}

/** Full player-watch grammar used by the Players page. */
export function playerWatchCommand(action, player, bot = 'all', value = null) {
  const args = [action, player, bot];
  if (value !== null && value !== undefined) args.push(String(value));
  return commandPreview('players', args);
}
