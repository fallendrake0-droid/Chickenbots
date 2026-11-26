'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PlayerRegistry, cleanName } = require('../src/players/registry');
const { PlayerController } = require('../src/players/controller');
const { PvpPolicy } = require('../src/combat/players');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { CombatController } = require('../src/actions/combat');
const { createRuntime } = require('../src/runtime');

function entity(name, position = { x: 4, y: 65, z: 0 }, extra = {}) {
  return {
    id: `entity-${name}`, uuid: extra.uuid || null, type: 'player', username: name, name,
    position: { ...position }, health: 20, alive: true, hostile: false, ...extra
  };
}

function fixture() {
  const world = new MockWorld({ flat: true, seed: 1201 });
  const bot = new MockBot({ name: '10101000', world, inventory: { iron_sword: 1 }, position: { x: 0, y: 65, z: 0 } });
  const alex = entity('Alex');
  world.entities.push(alex);
  bot.serverPlayerList = [{ name: 'Alex', ping: 20, gamemode: 0 }];
  const registry = new PlayerRegistry();
  registry.observeBot(bot);
  const combat = new CombatController({ bot });
  const controller = new PlayerController({ bot, registry, combat });
  return { world, bot, alex, registry, combat, controller };
}

test('player identity is case-insensitive and a UUID rename merges instead of duplicating', () => {
  const registry = new PlayerRegistry();
  const uuid = '00000000-0000-4000-8000-000000000001';
  registry.observe('AlexOld', { uuid, position: { x: 1, y: 64, z: 2 }, source: 'entity', bot: '10101000' });
  registry.observe('alexold', { uuid, position: { x: 2, y: 64, z: 2 }, source: 'entity', bot: '01010100' });
  assert.equal(registry.list({ limit: 50 }).length, 1, 'case variants are one player');
  assert.equal(registry.list({ limit: 50 })[0].seenBy.length, 2);
  registry.observe('AlexNew', { uuid, position: { x: 3, y: 64, z: 2 }, source: 'entity', bot: '00110000' });
  const rows = registry.list({ limit: 50 });
  assert.equal(rows.length, 1, 'the UUID binds the new name to the existing identity');
  assert.equal(rows[0].name, 'AlexNew');
  assert.equal(rows[0].uuid, uuid.replace(/-/g, ''));
  assert.equal(rows[0].seenBy.length, 3);
  assert.equal(registry.history('AlexNew').events.some((event) => event.type === 'RENAMED'), true);
  assert.equal(registry.get('alexold'), null, 'the old name is no longer a separate entry');
  assert.equal(cleanName('________'), null);
  assert.equal(cleanName('bad\nname'), null);
});

test('presence distinguishes visible, tab-list online, stale position and offline', () => {
  let now = 1000;
  const registry = new PlayerRegistry({ now: () => now });
  registry.observe('Alex', {
    uuid: '00000000-0000-4000-8000-000000000002',
    position: { x: 5, y: 65, z: 1 }, source: 'entity', seenAt: now, bot: '10101000'
  });
  registry.observe('Alex', {
    uuid: '00000000-0000-4000-8000-000000000002',
    source: 'server_list', seenAt: now, bot: '10101000'
  });
  let row = registry.getRow('Alex');
  assert.equal(row.online, true);
  assert.equal(row.presence, 'visible');
  assert.equal(row.positionFresh, true);
  now += 6000;
  row = registry.getRow('Alex');
  assert.equal(row.online, true, 'the 15s online window survives a short render-distance loss');
  assert.equal(row.presence, 'online');
  assert.equal(row.positionFresh, false, 'a six-second-old coordinate is not sold as current');
  assert.equal(row.positionAgeMs >= 6000, true);
  now += 10000;
  row = registry.getRow('alex');
  assert.equal(row.online, false);
  assert.equal(row.presence, 'recent');
  assert.equal(row.distance, null, 'offline players do not keep a live distance');
});

test('manual records and notes survive observation expiry, and disconnect clears activity', () => {
  let now = 1000;
  const registry = new PlayerRegistry({ now: () => now, ttlMs: 5000 });
  registry.add('ManualOne', { notes: 'keep this note', tags: ['supplier'] });
  now += 60000;
  registry.observe('SeenOne', { source: 'entity', seenAt: now });
  assert.equal(registry.getRow('ManualOne').notes[0].text, 'keep this note');
  assert.equal(registry.getRow('ManualOne').category, 'neutral');
  const disconnected = { name: '10101000', connected: false, ready: false, position: { x: 0, y: 64, z: 0 } };
  registry.observeBot(disconnected);
  assert.equal(registry.activity.size, 0);
});

test('relationships are categorised from policy without mutating the directory', () => {
  const registry = new PlayerRegistry();
  const policy = new PvpPolicy({ enabled: true });
  registry.attachPolicy(policy);
  registry.add('NeutralOne', { notes: 'supplier', tags: ['supplier'] });
  registry.observe('TargetOne', { source: 'server_list', position: { x: 1, y: 64, z: 1 } });
  registry.observe('ProtectedOne', { source: 'server_list', position: { x: 2, y: 64, z: 1 } });
  registry.observe('TrustedOne', { source: 'server_list', position: { x: 3, y: 64, z: 1 } });
  policy.addTarget('TargetOne');
  policy.protect('ProtectedOne');
  policy.trust('TrustedOne');
  assert.equal(registry.getRow('NeutralOne').category, 'neutral');
  assert.equal(registry.getRow('TargetOne').category, 'target');
  assert.equal(registry.getRow('ProtectedOne').category, 'protected');
  assert.equal(registry.getRow('TrustedOne').category, 'trusted');
  assert.deepEqual(registry.getRow('NeutralOne').tags, ['supplier']);
  assert.equal(registry.getRow('NeutralOne').notes[0].text, 'supplier');
  const counts = registry.categories();
  assert.equal(counts.target, 1);
  assert.equal(counts.protected, 1);
  assert.equal(counts.trusted, 1);
  assert.equal(counts.neutral, 1);
});

test('explicit, arena and defensive modes have distinct engagement semantics', () => {
  const policy = new PvpPolicy({ enabled: true, mode: 'EXPLICIT' });
  const target = { name: 'Alex', type: 'player', position: { x: 5, y: 65, z: 5 } };
  assert.equal(policy.addTarget('not a name!').ok, false);
  assert.equal(policy.addTarget('Alex').ok, true);
  assert.equal(policy.canEngage(target).ok, true);
  assert.equal(policy.canEngage(target, { explicit: false }).code, 'NOT_EXPLICIT');

  assert.equal(policy.setMode('ARENA').ok, true);
  assert.equal(policy.canEngage(target).code, 'ARENA_REQUIRED');
  assert.equal(policy.addArena({ name: 'test', min: { x: 0, y: 60, z: 0 }, max: { x: 10, y: 70, z: 10 } }).ok, true);
  assert.equal(policy.canEngage(target).ok, true);
  assert.equal(policy.canEngage({ ...target, position: { x: 100, y: 65, z: 100 } }).code, 'ARENA',
    'arena bounds are checked at the target, not at the attacker');

  assert.equal(policy.setMode('DEFENSIVE').ok, true);
  assert.equal(policy.canEngage(target).code, 'NOT_RETALIATION');
  assert.equal(policy.canEngage(target, { defending: true }).ok, true);

  assert.equal(policy.canEngage(target, { defending: true, online: false }).code, 'OFFLINE');
  assert.equal(policy.canEngage(target, { defending: true, positionFresh: false }).code, 'STALE_POSITION');
  assert.equal(policy.canEngage(target, { defending: true, dimension: 'nether', botDimension: 'overworld' }).code, 'DIMENSION');
});

test('policy construction accepts configured targets, protection and arenas', () => {
  const policy = new PvpPolicy({
    enabled: true, mode: 'ARENA',
    targets: ['Alex'], protectedPlayers: ['Steve'], trustedPlayers: ['Herobrine'],
    arenas: [{ name: 'spawn', min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 8, z: 8 } }]
  });
  assert.deepEqual(policy.list(), ['alex']);
  assert.deepEqual(policy.listProtected(), ['steve']);
  assert.deepEqual(policy.listTrusted(), ['herobrine']);
  assert.equal(policy.listArenas().length, 1);
  assert.equal(policy.audit.length >= 4, true, 'constructor additions are audited');
});

test('protect and trust remove targets and cannot be bypassed by re-adding', () => {
  const policy = new PvpPolicy({ enabled: true });
  policy.addTarget('Alex');
  assert.equal(policy.isAuthorized({ name: 'Alex' }), true);
  assert.equal(policy.protect('Alex').ok, true);
  assert.deepEqual(policy.list(), []);
  assert.equal(policy.addTarget('Alex').ok, false);
  assert.equal(policy.canEngage({ name: 'Alex', position: { x: 0, y: 64, z: 0 } }).code, 'PROTECTED');
  assert.equal(policy.unprotect('Alex').removed, true);
  assert.equal(policy.addTarget('Alex').ok, true);
  assert.equal(policy.trust('Alex').ok, true);
  assert.equal(policy.isTrusted({ name: 'Alex' }), true);
  assert.equal(policy.addTarget('Alex').ok, false);
  assert.equal(policy.canEngage({ name: 'Alex', position: { x: 0, y: 64, z: 0 } }).error, 'player is trusted');
  assert.equal(policy.untrust('Alex').removed, true);
  assert.equal(policy.addTarget('Alex').ok, true);
  assert.equal(policy.addArena({ min: { x: 5, y: 5, z: 5 }, max: { x: 0, y: 0, z: 0 } }).arena.min.x, 0, 'bounds are normalised');
});

test('defensive mode only engages an authorised player after that player really attacked', async () => {
  const { world, bot, combat } = fixture();
  const alex = world.entities.find((entry) => entry.username === 'Alex');
  combat.pvp.setEnabled(true);
  combat.pvp.addTarget('Alex');
  combat.pvp.setMode('DEFENSIVE');
  const opening = await combat.attackEntity(alex);
  assert.equal(opening.ok, false);
  assert.equal(opening.code, 'NOT_RETALIATION');
  bot.damage(3, 'player', { attacker: { name: 'Alex', type: 'player' } });
  const retaliation = await combat.attackEntity(alex);
  assert.equal(retaliation.ok, true, JSON.stringify(retaliation));
  assert.equal(alex.health < 20, true);
  combat.pvp.setMode('EXPLICIT');
});

test('team bots are rejected as teammates, not reported as malformed player names', () => {
  const { controller } = fixture();
  const result = controller.follow('________');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEAMMATE');
});

test('observe never moves the bot, and unwatch only clears an observe mode', async () => {
  const { bot, controller } = fixture();
  const start = { ...bot.position };
  const watched = controller.observe('Alex');
  assert.equal(watched.ok, true);
  assert.equal(watched.mode, 'OBSERVE');
  const tick = await controller.tick();
  assert.equal(tick.observation, true);
  assert.deepEqual(bot.position, start, 'a passive watch does not path toward the player');
  assert.equal(controller.unfollow('Alex').stopped, false, 'unfollow is not an observe cancel');
  assert.equal(controller.unwatch('Alex').stopped, true);
  assert.equal(controller.isActive(), false);
  assert.equal(controller.escort('Alex').mode, 'ESCORT');
  assert.equal(controller.unfollow('Alex').stopped, false, 'unfollow leaves an escort intact');
  assert.equal(controller.mode, 'ESCORT');
  assert.equal(controller.stop().ok, true);
});

test('an offline target cancels the watch after the grace period instead of freezing', async () => {
  let clock = 1000;
  const world = new MockWorld({ flat: true, seed: 1202 });
  const bot = new MockBot({ name: '10101000', world, position: { x: 0, y: 65, z: 0 } });
  const alex = entity('Alex');
  world.entities.push(alex);
  bot.serverPlayerList = [{ name: 'Alex', ping: 20, gamemode: 0 }];
  const registry = new PlayerRegistry({ now: () => clock });
  registry.observeBot(bot);
  const controller = new PlayerController({ bot, registry });
  assert.equal(controller.follow('Alex').ok, true);
  world.entities = world.entities.filter((entry) => entry !== alex);
  bot.serverPlayerList = [];
  clock += 16000;
  controller.offlineSince = Date.now() - 61000;
  const tick = await controller.tick();
  assert.equal(tick.autoStopped, true);
  assert.equal(controller.isActive(), false);
  assert.equal(controller.stats.autoStops, 1);
  assert.equal(registry.activityFor('Alex').length, 0, 'shared watch state is cleared too');
});

test('watch state and directory events are visible to the dashboard snapshot', async () => {
  const { bot, registry, controller } = fixture();
  controller.observe('Alex');
  registry.note('Alex', 'delivers sand');
  registry.tag('Alex', 'supplier');
  const row = registry.getRow('Alex');
  assert.equal(row.tasks.observe[0], bot.name);
  assert.equal(row.watchedBy.length, 1);
  assert.equal(registry.recentEvents({ limit: 20 }).some((event) => event.type === 'NOTE'), true);
  assert.equal(registry.history('Alex').events.some((event) => event.type === 'TAG'), true);
  controller.stop();
});

test('the players commands manage the shared policy, notes, history, observe and arenas', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const bot = runtime.bots.get('________');
    runtime.world.entities.push(entity('Alex', { x: bot.position.x + 3, y: bot.position.y, z: bot.position.z }));
    runtime.players.observeBots(runtime.bots.values());

    const target = await runtime.commands.execute('players target add Alex', { source: 'cli' });
    assert.equal(target.ok, true, JSON.stringify(target.result));
    assert.equal(runtime.actions.list().every((actions) => actions.combat.pvp === runtime.actions.list()[0].combat.pvp), true,
      'the whole fleet shares one target policy');
    assert.equal(runtime.players.getRow('Alex').category, 'target');

    assert.equal((await runtime.commands.execute('players mode DEFENSIVE', { source: 'cli' })).ok, true);
    assert.equal(runtime.actions.list()[0].combat.pvp.mode, 'DEFENSIVE');
    assert.equal((await runtime.commands.execute('players mode EXPLICIT', { source: 'cli' })).ok, true);

    const protectedResult = await runtime.commands.execute('players protect Alex', { source: 'cli' });
    assert.equal(protectedResult.ok, true, JSON.stringify(protectedResult.result));
    assert.equal(runtime.players.getRow('Alex').category, 'protected');
    assert.equal((await runtime.commands.execute('players trust Alex', { source: 'cli' })).ok, true);
    assert.equal(runtime.players.getRow('Alex').category, 'trusted');
    assert.deepEqual(runtime.actions.list()[0].combat.pvp.list(), []);

    const note = await runtime.commands.execute('players note Alex delivers sand', { source: 'cli' });
    assert.equal(note.ok, true, JSON.stringify(note.result));
    const tag = await runtime.commands.execute('players tag Alex supplier', { source: 'cli' });
    assert.equal(tag.ok, true);
    assert.equal((await runtime.commands.execute('players history Alex', { source: 'cli' })).ok, true);
    assert.equal((await runtime.commands.execute('players list trusted', { source: 'cli' })).result.count, 1);

    const observe = await runtime.commands.execute('players observe Alex ________', { source: 'cli' });
    assert.equal(observe.ok, true, JSON.stringify(observe.result));
    const watches = await runtime.commands.execute('players watches ________', { source: 'cli' });
    assert.equal(watches.result.watches.some((row) => row.mode === 'OBSERVE'), true);
    const unwatch = await runtime.commands.execute('players unwatch Alex ________', { source: 'cli' });
    assert.equal(unwatch.result.stopped, 1);

    const arena = await runtime.commands.execute('players arena on 16 test-arena', { source: 'cli' });
    assert.equal(arena.ok, true, JSON.stringify(arena.result));
    assert.equal(runtime.actions.list()[0].combat.pvp.arenas.length, 1, 'all bots see one arena');
    assert.equal((await runtime.commands.execute('players arena remove test-arena', { source: 'cli' })).result.removed, 1);

    const remove = await runtime.commands.execute('players target remove Alex', { source: 'cli' });
    assert.equal(remove.ok, true);
    assert.equal((await runtime.commands.execute('players events 20', { source: 'cli' })).ok, true);
  } finally {
    await runtime.shutdown('players overhaul test');
  }
});
