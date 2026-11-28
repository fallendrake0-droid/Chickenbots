'use strict';

/**
 * Authoritative command metadata.
 *
 * The registered command handler remains the only executor. This table adds the
 * information an operator surface needs to build *correct* commands: argument
 * order/types, scope, mutability, confirmation policy and the page that owns the
 * control. `CommandRegistry` merges this with the registered definition, so a
 * command cannot be advertised here without a matching handler and a handler
 * cannot be missed by the metadata consistency test.
 *
 * Positional arguments are listed in the exact order the CLI tokenizer sees
 * them. `variants` documents grammars that legitimately accept more than one
 * shape (notably `mine`, where a token may be a bot, a target or `stop`).
 */

const { TEAM_COMBAT_MODES } = require('../combat/team');
const { TARGET_MODES } = require('../combat/players');
const { ROLES: WOODCUTTING_ROLES } = require('../actions/woodcutting');
const { SURVIVAL_FEATURES } = require('../actions/survival');
const { FORMATIONS } = require('../team/formations');

const VALID_TYPES = new Set([
  'bot', 'botOrFleet', 'player', 'playerOrBot', 'ore', 'block', 'mineTarget', 'integer', 'decimal',
  'boolean', 'coordinates', 'distance', 'radius', 'item', 'count', 'enum', 'text',
  'confirmation', 'subcommand', 'target', 'role', 'schematic', 'buildId', 'taskId'
]);

const arg = (name, type = 'text', options = {}) => ({ name, type, required: false, ...options });
const bot = (options = {}) => arg('bot', 'botOrFleet', { valuesFrom: 'roster+fleet', ...options });
const text = (name, options = {}) => arg(name, 'text', options);
const int = (name, options = {}) => arg(name, 'integer', { ...options });
const enumArg = (name, values, options = {}) => arg(name, 'enum', { values, ...options });
const sub = (name, options = {}) => arg(name, 'subcommand', options);
const coords = () => [
  arg('x', 'coordinates', { position: 0, required: true }),
  arg('y', 'coordinates', { position: 1, required: true }),
  arg('z', 'coordinates', { position: 2, required: true })
];

const COMMAND_METADATA = Object.freeze({
  help: {
    args: [text('command', { position: 0 })],
    scope: 'none', readOnly: true, mutates: false, confirmation: 'never', page: '', palette: true,
    errorCodes: []
  },
  status: {
    args: [], scope: 'none', readOnly: true, mutates: false, confirmation: 'never', page: 'overview', palette: true
  },
  diagnostics: {
    args: [], scope: 'none', readOnly: true, mutates: false, confirmation: 'never', page: 'logs', palette: true
  },
  ai: {
    args: [sub('action', { position: 0, values: ['status', 'off'] })],
    subcommands: [{ name: 'status' }, { name: 'off' }],
    scope: 'none', readOnly: true, mutates: false, confirmation: 'never', page: 'settings', palette: true
  },
  team: {
    args: [sub('action', { position: 0 }), text('value', { position: 1 })],
    subcommands: [
      { name: 'state' }, { name: 'on' }, { name: 'off' }, { name: 'plan', args: [enumArg('action', ['status', 'on', 'off'])] }, { name: 'follow' }, { name: 'regroup' },
      { name: 'retreat' }, { name: 'defend' }, { name: 'memory' }, { name: 'locks' }, { name: 'tasks' },
      { name: 'roles' }, { name: 'leader' }, { name: 'resources' }, { name: 'objectives' },
      { name: 'assignments' }, { name: 'assist', args: [bot()] }, { name: 'sleep' }, { name: 'reassign' },
      { name: 'formation', args: [enumArg('formation', Object.keys(FORMATIONS))] },
      { name: 'combat', args: [enumArg('action', ['status', 'on', 'off', 'defend', 'retreat', 'regroup', 'rescue', 'heal', 'attack'])] }
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['retreat', 'reassign'], page: 'team', palette: true
  },
  goto: {
    args: [
      bot({ position: 0 }),
      arg('x', 'coordinates', { position: 1, required: true }),
      arg('y', 'coordinates', { position: 2, required: true }),
      arg('z', 'coordinates', { position: 3, required: true })
    ],
    variants: [
      { name: 'leader', args: coords(), command: '<x> <y> <z>' },
      { name: 'bot', args: [bot(), ...coords()], command: '<bot|all> <x> <y> <z>' },
      { name: 'trailing-bot', args: [...coords(), bot()], command: '<x> <y> <z> <bot>' }
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'never', cancellable: true, page: 'world', palette: true
  },
  path: {
    args: [
      bot({ position: 0 }),
      arg('x', 'coordinates', { position: 1 }),
      arg('y', 'coordinates', { position: 2 }),
      arg('z', 'coordinates', { position: 3 })
    ],
    variants: [
      { name: 'status', args: [bot()], command: '[bot]' },
      { name: 'plan', args: [bot(), ...coords()], command: '<x> <y> <z> [bot]' }
    ],
    scope: 'bot', readOnly: true, mutates: false, confirmation: 'never', page: 'world', palette: true
  },
  bot: {
    args: [bot({ required: true, position: 0 }), sub('action', { position: 1, required: true })],
    subcommands: [
      { name: 'status' }, { name: 'where' }, { name: 'goto', args: coords() }, { name: 'come' },
      { name: 'follow' }, { name: 'eat' }, { name: 'mine', args: [arg('target', 'mineTarget')] },
      { name: 'chop', args: [text('type')] }, { name: 'farm', args: [text('crop')] },
      { name: 'fish' }, { name: 'defend' }, { name: 'combat' }, { name: 'guard', args: coords() },
      { name: 'duel', args: [arg('player', 'player')], requiresConfirmation: true }, { name: 'explore' },
      { name: 'sleep' }, { name: 'return', args: [enumArg('where', ['home'])] }, { name: 'inventory' }
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['duel'], page: 'bots', palette: true
  },
  inventory: {
    args: [bot()], scope: 'botOrFleet', readOnly: true, mutates: false, confirmation: 'never', page: 'inventory', palette: true
  },
  survival: {
    args: [bot(), enumArg('feature', [...SURVIVAL_FEATURES], { position: 1 }), enumArg('value', ['on', 'off'], { position: 2 })],
    subcommands: [{ name: 'status' }, { name: 'on' }, { name: 'off' }],
    values: { feature: [...SURVIVAL_FEATURES] },
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'never', page: 'survival', palette: true
  },
  auto: {
    args: [enumArg('routine', ['eat', 'healing', 'armour', 'tools', 'crafting', 'shield', 'weapon', 'totem', 'potions', 'food', 'heal'], { position: 0 }), enumArg('value', ['on', 'off'], { position: 1 }), bot({ position: 2 })],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'never', page: 'survival', palette: true
  },
  eat: {
    args: [bot()], scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'never', page: 'survival', palette: true
  },
  mine: {
    args: [arg('selector', 'botOrFleet', { position: 0 }), arg('target', 'mineTarget', { position: 1, valuesFrom: 'miningCatalog' })],
    variants: [
      { name: 'leader-default', args: [], command: 'mine', scope: 'bot' },
      { name: 'bot-default', args: [bot()], command: 'mine <bot>', scope: 'bot' },
      { name: 'leader-target', args: [arg('target', 'mineTarget', { required: true })], command: 'mine <ore|block>', scope: 'bot' },
      { name: 'bot-target', args: [bot(), arg('target', 'mineTarget', { required: true })], command: 'mine <bot> <ore|block>', scope: 'bot' },
      { name: 'fleet-default', args: [enumArg('fleet', ['all', 'fleet', 'team'])], command: 'mine all', scope: 'fleet' },
      { name: 'fleet-target', args: [enumArg('fleet', ['all', 'fleet', 'team']), arg('target', 'mineTarget', { required: true })], command: 'mine all <ore|block>', scope: 'fleet' },
      { name: 'stop-all', args: [enumArg('stop', ['stop'])], command: 'mine stop', scope: 'fleet' },
      { name: 'stop-bot', args: [bot(), enumArg('stop', ['stop'])], command: 'mine <bot> stop', scope: 'bot' },
      { name: 'stop-fleet', args: [enumArg('fleet', ['all', 'fleet', 'team']), enumArg('stop', ['stop'])], command: 'mine all stop', scope: 'fleet' }
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['stop'], cancellable: true, createsTasks: false,
    targetSource: 'miningCatalog', page: 'mining', palette: true,
    errorCodes: ['UNKNOWN_TARGET', 'TOOL_REQUIRED', 'TOOL_BOOTSTRAP_BUSY', 'OUTSIDE_WORK_ZONE', 'ORE_RESERVED', 'BOT_NOT_READY']
  },
  chop: {
    args: [bot(), enumArg('target', ['wood', 'oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak', 'stop'], { position: 1 })],
    variants: [
      { name: 'leader-default', args: [], command: 'chop', scope: 'bot' },
      { name: 'bot-default', args: [bot()], command: 'chop <bot>', scope: 'bot' },
      { name: 'leader-type', args: [text('type')], command: 'chop <type>', scope: 'bot' },
      { name: 'bot-type', args: [bot(), text('type')], command: 'chop <bot> <type>', scope: 'bot' },
      { name: 'fleet', args: [enumArg('fleet', ['all', 'fleet', 'team'])], command: 'chop all', scope: 'fleet' },
      { name: 'stop', args: [enumArg('stop', ['stop'])], command: 'chop stop', scope: 'fleet' },
      { name: 'stop-bot', args: [bot(), enumArg('stop', ['stop'])], command: 'chop <bot> stop', scope: 'bot' }
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['stop'],
    cancellable: true, page: 'woodcutting', palette: true,
    errorCodes: ['TOOL_REQUIRED', 'OUTSIDE_WORK_ZONE', 'TREE_RESERVED', 'BOT_NOT_READY']
  },
  woodcutting: {
    args: [sub('action', { position: 0 }), bot({ position: 1 }), text('value', { position: 2 })],
    subcommands: ['status', 'trees', 'catalog', 'stats', 'chop', 'plant', 'store', 'relocate', 'stop', 'team', 'support'],
    values: { role: [...WOODCUTTING_ROLES] },
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['chop', 'store', 'relocate', 'stop'], cancellable: true, page: 'woodcutting', palette: true
  },
  farm: {
    args: [bot(), text('action', { position: 1 })],
    variants: [
      { name: 'leader-harvest', args: [], command: 'farm', scope: 'bot' },
      { name: 'bot-harvest', args: [bot()], command: 'farm <bot>', scope: 'bot' },
      { name: 'crop', args: [enumArg('crop', ['harvest', 'wheat', 'carrots', 'potatoes', 'beetroot', 'pumpkin', 'melon'])], command: 'farm <crop>', scope: 'bot' },
      { name: 'plant', args: [enumArg('plant', ['plant']), text('crop'), int('count')], command: 'farm [bot|all] plant <crop> <count>', scope: 'botOrFleet' },
      { name: 'maintain', args: [enumArg('maintain', ['maintain'])], command: 'farm [bot|all] maintain', scope: 'botOrFleet' },
      { name: 'stop', args: [enumArg('stop', ['stop'])], command: 'farm stop', scope: 'fleet' }
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['stop'],
    cancellable: true, page: 'farming', palette: true
  },
  fish: {
    args: [bot(), int('casts', { min: 1, max: 3, position: 1 })],
    variants: [
      { name: 'leader', args: [], command: 'fish', scope: 'bot' },
      { name: 'bot', args: [bot()], command: 'fish <bot>', scope: 'bot' },
      { name: 'fleet', args: [enumArg('fleet', ['all', 'fleet', 'team']), int('casts', { min: 1, max: 3 })], command: 'fish all <casts>', scope: 'fleet' },
      { name: 'stop', args: [enumArg('stop', ['stop']), bot()], command: 'fish stop [bot|all]', scope: 'botOrFleet' }
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['stop'],
    cancellable: true, page: 'fishing', palette: true
  },
  sleep: {
    args: [bot(), sub('action', { position: 1 }), enumArg('value', ['on', 'off'], { position: 2 })],
    subcommands: [{ name: 'auto', args: [enumArg('value', ['on', 'off'])] }, { name: 'all' }, { name: 'stop' }],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['stop'], cancellable: true, page: 'sleep', palette: true
  },
  defend: {
    args: [bot(), enumArg('stop', ['stop'], { position: 1 })],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['stop'], cancellable: true, page: 'combat', palette: true
  },
  explore: {
    args: [bot(), int('steps', { min: 1, max: 20, position: 1 })],
    variants: [
      { name: 'leader', args: [int('steps', { min: 1, max: 20 })], command: 'explore [steps]', scope: 'bot' },
      { name: 'bot', args: [bot(), int('steps', { min: 1, max: 20 })], command: 'explore <bot> [steps]', scope: 'bot' },
      { name: 'fleet', args: [enumArg('fleet', ['all', 'fleet', 'team']), int('steps', { min: 1, max: 20 })], command: 'explore all [steps]', scope: 'fleet' },
      { name: 'stop', args: [enumArg('stop', ['stop']), bot()], command: 'explore stop [bot|all]', scope: 'botOrFleet' }
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['stop'], cancellable: true, page: 'exploration', palette: true
  },
  find: {
    args: [enumArg('kind', ['village', 'mineshaft', 'temple', 'ruin', 'forest', 'cave', 'diamonds', 'emeralds', 'iron'], { position: 0, required: true }), bot({ position: 1 })],
    scope: 'bot', readOnly: true, mutates: false, confirmation: 'never', page: 'exploration', palette: true
  },
  return: {
    args: [enumArg('where', ['home'], { position: 0, required: true }), bot({ position: 1 })],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'never', cancellable: true, page: 'bots', palette: true
  },
  task: {
    args: [sub('action', { position: 0 }), text('value', { position: 1 })],
    subcommands: [
      { name: 'list', args: [enumArg('status', ['PENDING', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED'])] },
      { name: 'add', args: [text('type'), text('label'), text('params')] },
      { name: 'assign', args: [arg('taskId', 'taskId'), bot()] },
      { name: 'priority', args: [arg('taskId', 'taskId'), int('priority', { min: 0, max: 100 })] },
      { name: 'cancel', args: [arg('taskId', 'taskId')] },
      { name: 'retry', args: [arg('taskId', 'taskId')] },
      { name: 'info', args: [arg('taskId', 'taskId')] },
      { name: 'objective', args: [text('title')] }
    ],
    scope: 'none', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['cancel'],
    createsTasks: true, page: 'tasks', palette: true
  },
  batch: {
    args: [bot({ required: true }), text('action'), text('then'), text('next')],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional', page: 'overview', palette: true
  },
  queue: {
    args: [sub('action', { position: 0 }), bot({ position: 1 })],
    subcommands: [{ name: 'status' }, { name: 'retry', args: [bot()] }, { name: 'cooldown', args: [enumArg('action', ['reset'])] }],
    scope: 'none', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['cooldown'], page: 'connections', palette: true
  },
  pause: { args: [], scope: 'none', mutates: true, readOnly: false, confirmation: 'never', page: 'overview', palette: true },
  resume: { args: [], scope: 'none', mutates: true, readOnly: false, confirmation: 'never', page: 'overview', palette: true },
  stop: { args: [], scope: 'none', mutates: true, readOnly: false, confirmation: 'always', page: 'overview', palette: true },
  excavate: {
    args: [sub('action', { position: 0 }), text('value', { position: 1 })],
    subcommands: [
      { name: 'preview', args: [enumArg('mode', ['box', 'radius', 'trench', 'flatten']), ...coords(), int('width'), int('length'), int('depth'), int('radius'), enumArg('authorized', ['authorized'])] },
      { name: 'start', args: [text('previewId')] }, { name: 'status' }, { name: 'pause', args: [text('id')] },
      { name: 'resume', args: [text('id')] }, { name: 'stop', args: [text('id')] },
      { name: 'undo-preview', args: [text('previewId')] }, { name: 'assign', args: [bot(), arg('role', 'role')] },
      { name: 'team', args: [text('teamAction')] }
    ],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['start', 'stop'], createsTasks: true, page: 'excavation', palette: true
  },
  build: {
    args: [sub('action', { position: 0 }), text('value', { position: 1 })],
    subcommands: [
      { name: 'select', args: [arg('schematic', 'schematic')] },
      { name: 'preview', args: [arg('schematic', 'schematic'), ...coords()] },
      { name: 'start', args: [enumArg('run', ['run'])] },
      { name: 'status' }, { name: 'list' }, { name: 'phase' }, { name: 'progress' },
      { name: 'pause', args: [arg('buildId', 'buildId')] }, { name: 'resume', args: [arg('buildId', 'buildId')] },
      { name: 'stop', args: [arg('buildId', 'buildId')], destructive: true },
      { name: 'run', args: [arg('buildId', 'buildId'), int('steps', { min: 1, max: 500 })], destructive: true },
      { name: 'verify', args: [arg('buildId', 'buildId')] },
      { name: 'repair', args: [arg('buildId', 'buildId'), arg('extras', 'text')] },
      { name: 'finish' }, { name: 'plan' }, { name: 'assign', args: [bot(), arg('role', 'role')] }
    ],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['start', 'run', 'stop', 'repair', 'finish', 'plan'], createsTasks: true,
    cancellable: true, page: 'builder', palette: true
  },
  home: {
    args: [
      sub('action', { position: 0 }),
      arg('x', 'coordinates', { position: 1 }),
      arg('y', 'coordinates', { position: 2 }),
      arg('z', 'coordinates', { position: 3 })
    ],
    subcommands: [{ name: 'status' }, { name: 'set', args: coords() }, { name: 'build', args: [text('tier'), enumArg('run', ['run'])] }],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['set', 'build'], createsTasks: true, page: 'home', palette: true
  },
  schematics: {
    args: [sub('action', { position: 0 }), text('value', { position: 1 })],
    subcommands: ['list', 'search', 'info', 'stats', 'count', 'tier', 'preview', 'validate', 'export', 'import', 'custom'],
    scope: 'none', mutates: false, readOnly: true, confirmation: 'never', page: 'schematics', palette: true
  },
  combat: {
    args: [sub('action', { position: 0 }), text('value', { position: 1 })],
    subcommands: [
      'status', 'on', 'off', 'start', 'stop', { name: 'mode', args: [enumArg('mode', [...TEAM_COMBAT_MODES])] },
      'guard', 'duel', 'rescue', 'heal'
    ],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['start', 'stop', 'duel'], page: 'combat', palette: true
  },
  pve: {
    args: [enumArg('value', ['on', 'off', 'status'], { position: 0 })],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'never', page: 'combat', palette: true
  },
  pvp: {
    args: [enumArg('value', ['on', 'off', 'status'], { position: 0 })],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['on'], page: 'combat-targets', palette: true
  },
  target: {
    args: [sub('action', { position: 0 }), arg('player', 'player', { position: 1 })],
    subcommands: ['add', 'remove', 'protect', 'unprotect', 'clear', 'list'],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['clear'], page: 'combat-targets', palette: true
  },
  gear: {
    args: [enumArg('action', ['status', 'optimise', 'durability', 'progression', 'layout'], { position: 0 }), bot({ position: 1 })],
    scope: 'bot', mutates: true, readOnly: false, confirmation: 'never', page: 'combat-gear', palette: true
  },
  totem: {
    args: [enumArg('action', ['status', 'reserve', 'refill'], { position: 0 }), int('reserve', { min: 0, max: 9, position: 1 })],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'never', page: 'combat-supplies', palette: true
  },
  food: {
    args: [enumArg('action', ['status'], { position: 0 }), bot({ position: 1 })],
    scope: 'bot', readOnly: true, mutates: false, confirmation: 'never', page: 'combat-supplies', palette: true
  },
  potions: {
    args: [enumArg('action', ['status'], { position: 0 }), bot({ position: 1 })],
    scope: 'bot', readOnly: true, mutates: false, confirmation: 'never', page: 'combat-supplies', palette: true
  },
  follow: {
    args: [arg('target', 'playerOrBot', { position: 0, required: true }), int('distance', { min: 2, max: 16, position: 1 })],
    variants: [
      { name: 'player', args: [arg('target', 'player'), int('distance', { min: 2, max: 16 })], command: '<player> [distance]' },
      { name: 'teammate', args: [bot(), int('distance', { min: 2, max: 16 })], command: '<bot> [distance]' },
      { name: 'stop', args: [enumArg('stop', ['stop'])], command: 'stop' }
    ],
    examples: ['follow Alex', 'follow Alex 3', 'follow 10101000 4', 'follow stop'],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'never', cancellable: true, page: 'players', palette: true
  },
  guard: {
    args: [...coords(), bot({ position: 3 })],
    variants: [{ name: 'guard-area', args: coords(), command: '<x> <y> <z> [bot]' }, { name: 'stop', args: [enumArg('stop', ['stop'])], command: 'stop' }],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['stop'], cancellable: true, page: 'combat', palette: true
  },
  duel: {
    args: [arg('player', 'player', { position: 0, required: true }), arg('confirm', 'confirmation', { position: 1 })],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'always', page: 'combat-targets', palette: true
  },
  arena: {
    args: [enumArg('value', ['on', 'off', 'status'], { position: 0 }), int('radius', { min: 4, max: 128, position: 1 })],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional', confirmSubcommands: ['on'], page: 'combat-targets', palette: true
  },
  players: {
    args: [sub('action', { position: 0 }), text('value', { position: 1 })],
    subcommands: [
      'list', 'near', 'info', 'history', 'events', 'refresh', { name: 'mode', args: [enumArg('mode', [...TARGET_MODES])] },
      'follow', 'escort', 'guard', 'observe',
      'unwatch', 'unfollow', 'come', 'stop', 'give', 'drop', 'message', 'greet', 'note', 'tag',
      'untag', 'forget', 'pvp', 'target', 'protect', 'trust', 'unprotect', 'untrust', 'arena'
    ],
    scope: 'botOrFleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['pvp', 'mode', 'target', 'protect', 'trust', 'unprotect', 'untrust', 'arena', 'forget'],
    page: 'players', palette: true
  },
  builder: {
    args: [sub('action', { position: 0 }), text('value', { position: 1 })],
    subcommands: [
      { name: 'projects' }, { name: 'create', args: [arg('schematic', 'schematic'), ...coords()] },
      { name: 'select', args: [arg('buildId', 'buildId')] }, { name: 'status' }, { name: 'preview' },
      { name: 'advance', args: [int('phases'), arg('confirm', 'confirmation')] },
      { name: 'run', args: [arg('confirm', 'confirmation')] },
      { name: 'auto', args: [enumArg('value', ['on', 'off'])] },
      { name: 'pause' }, { name: 'resume' }, { name: 'stop' }, { name: 'phases' }, { name: 'report' },
      { name: 'assign', args: [bot(), arg('role', 'role'), arg('phase', 'text', { flag: '--phase' })] },
      { name: 'priority', args: [arg('buildId', 'buildId'), int('priority', { min: 0, max: 100 })] }
    ],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['create', 'advance', 'run', 'stop'], createsTasks: true, page: 'builder', palette: true
  },
  site: {
    args: [sub('action', { position: 0 })],
    subcommands: ['survey', 'candidates', 'select', 'boundaries', 'preview', 'clear', 'excavate', 'flatten', 'drain', 'light', 'audit', 'secure', 'status'],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['select', 'clear', 'excavate', 'flatten', 'drain', 'light', 'secure'], createsTasks: true, page: 'site-prep', palette: true
  },
  materials: {
    args: [sub('action', { position: 0 })],
    subcommands: ['status', 'calculate', 'missing', 'readiness', 'gather', 'reserve', 'locate', 'deposit', 'retrieve'],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['gather', 'reserve', 'deposit', 'retrieve'], createsTasks: true, page: 'material-plan', palette: true
  },
  storage: {
    args: [sub('action', { position: 0 })],
    subcommands: ['status', 'scan', 'containers', 'capacity', 'locate', 'deposit', 'retrieve', 'organise'],
    scope: 'fleet', mutates: true, readOnly: false, confirmation: 'conditional',
    confirmSubcommands: ['deposit', 'retrieve', 'organise'], page: 'warehouse', palette: true
  }
});

for (const [name, meta] of Object.entries(COMMAND_METADATA)) {
  for (const entry of meta.args || []) {
    if (!VALID_TYPES.has(entry.type)) throw new Error(`command metadata ${name}: invalid argument type '${entry.type}'`);
  }
  for (const variant of meta.variants || []) {
    for (const entry of variant.args || []) {
      if (!VALID_TYPES.has(entry.type)) throw new Error(`command metadata ${name}.${variant.name}: invalid argument type '${entry.type}'`);
    }
  }
}

module.exports = { COMMAND_METADATA, VALID_TYPES };
