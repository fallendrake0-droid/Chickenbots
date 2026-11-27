'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PlayerRegistry } = require('../src/players/registry');
const { PlayerController } = require('../src/players/controller');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { CombatController } = require('../src/actions/combat');
const { createRuntime } = require('../src/runtime');

function player(name = 'Alex', position = { x: 5, y: 65, z: 0 }) {
  return { id: `player-${name}`, type: 'player', username: name, name, position: { ...position }, health: 20, alive: true, hostile: false };
}

function fixture(inventory = { iron_sword: 1, oak_log: 200 }, { playerPosition = { x: 5, y: 65, z: 0 } } = {}) {
  const world = new MockWorld({ flat: true, seed: 901 });
  const bot = new MockBot({ name: '10101000', world, inventory, position: { x: 0, y: 65, z: 0 } });
  const alex = player('Alex', playerPosition);
  world.entities.push(alex);
  bot.serverPlayerList = [{ name: 'Alex', ping: 44, gamemode: 0 }, { name: 'Steve', ping: 120, gamemode: 1 }];
  const registry = new PlayerRegistry();
  registry.observeBot(bot);
  const combat = new CombatController({ bot });
  const controller = new PlayerController({ bot, registry, combat });
  return { world, bot, alex, registry, combat, controller };
}

test('player directory excludes the team and records server-list players without positions', () => {
  const { registry } = fixture();
  const rows = registry.list();
  assert.deepEqual(rows.map((row) => row.name).sort(), ['Alex', 'Steve']);
  const alex = rows.find((row) => row.name === 'Alex');
  assert.equal(alex.online, true);
  assert.deepEqual(alex.position, { x: 5, y: 65, z: 0 });
  assert.equal(alex.health, 20);
  assert.equal(alex.ping, 44);
  assert.equal(alex.gamemode, 'survival');
  assert.deepEqual(alex.seenBy, ['10101000']);
  const steve = rows.find((row) => row.name === 'Steve');
  assert.equal(steve.position, null, 'server list gives no position');
  assert.equal(steve.health, null, 'missing health must not become zero');
  assert.equal(steve.ping, 120);
  assert.equal(steve.gamemode, 'creative');
  assert.equal(registry.observe('________', { bot: '10101000' }), null, 'team names are not players');
  assert.equal(registry.observe('bad\nname', { bot: '10101000' }), null, 'control characters are refused');
});

test('follow moves toward a real player and stop clears the watch', async () => {
  const { bot, controller } = fixture();
  const started = bot.position;
  const follow = controller.follow('Alex', { distance: 2 });
  assert.equal(follow.ok, true);
  assert.equal(follow.mode, 'FOLLOW');
  assert.equal(controller.isActive(), true);
  const tick = await controller.tick();
  assert.equal(tick.active, true);
  assert.equal(tick.visible, true);
  assert.ok(Math.hypot(bot.position.x - 5, bot.position.z - 0) < Math.hypot(started.x - 5, started.z - 0), 'bot moved closer');
  const stop = controller.stop();
  assert.equal(stop.ok, true);
  assert.equal(controller.isActive(), false);
  const missing = controller.follow('Ghost');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PLAYER_NOT_SEEN');
});

test('follow leads a running player and switches to the catch-up cadence', async () => {
  const { bot, controller, alex } = fixture();
  alex.position = { x: 40, y: 65, z: 0 };
  // Mineflayer reports velocity per tick. 0.3 blocks/tick is 6 blocks/s, far
  // enough to make interception matter.
  alex.velocity = { x: 0.3, y: 0, z: 0 };
  assert.equal(controller.follow('Alex', { distance: 2 }).ok, true);
  const calls = [];
  bot.goNear = async (goal, distance, options = {}) => {
    calls.push({ goal, distance, options });
    return { ok: true, arrived: true, attempts: 1, durationMs: 120 };
  };
  const tick = await controller.tick({ deadlineAt: Date.now() + 5000 });
  assert.equal(tick.ok, true, JSON.stringify(tick));
  assert.equal(tick.catchUp, true, 'a 40-block gap must use catch-up');
  assert.ok(tick.intercept.leadMs > 0, 'a moving target gets a lead');
  assert.ok(calls[0].goal.position.x > alex.position.x, 'the goal is ahead of the player, not behind them');
  assert.ok(calls[0].options.timeoutMs <= 3200);
  const status = controller.status();
  assert.equal(status.followCatchUp, true);
  assert.ok(status.followLeadMs > 0);
  assert.equal(status.lastMoveResult.ok, true);
  assert.equal(status.lastMoveResult.durationMs, 120);
});

test('player watch stopped during movement cannot crash on a null mode', async () => {
  const { bot, controller } = fixture();
  assert.equal(controller.follow('Alex', { distance: 2 }).ok, true);
  // This is the live race: the safety watchdog stops the controller while
  // goNear is still awaiting. tick() used to resume and read this.mode
  // (now null) with .toLowerCase(), which surfaced as
  // "safety tick failed: Cannot read properties of null".
  bot.goNear = async () => {
    controller.stop();
    return { ok: false, superseded: true, error: 'movement request was superseded' };
  };
  const tick = await controller.tick({ deadlineAt: Date.now() + 5000 });
  assert.equal(tick.ok, true);
  assert.equal(tick.cancelled, true, JSON.stringify(tick));
  assert.equal(controller.isActive(), false);
});

test('player watch movement is bounded by the safety deadline and defers', async () => {
  const { bot, controller } = fixture();
  assert.equal(controller.follow('Alex', { distance: 2 }).ok, true);
  const timeouts = [];
  bot.goNear = async (_entity, _distance, options = {}) => {
    timeouts.push(options.timeoutMs);
    return { ok: false, error: 'path timeout' };
  };
  const first = await controller.tick({ deadlineAt: Date.now() + 2000 });
  assert.equal(first.move.ok, false);
  assert.equal(timeouts.length, 1);
  assert.ok(timeouts[0] <= 1750, `move timeout ${timeouts[0]} must fit the remaining budget`);
  assert.ok(timeouts[0] >= 750);
  // The failed move starts a short cooldown; a low remaining budget defers
  // instead of starting another path that the safety pass would cancel.
  controller.lastMoveAt = 0;
  const second = await controller.tick({ deadlineAt: Date.now() + 500 });
  assert.equal(second.deferred, true, JSON.stringify(second));
  assert.equal(timeouts.length, 1, 'no second movement was launched');
});

test('unfollow clears only a follow watch and leaves a guard alone', async () => {
  const { controller } = fixture();
  assert.equal(controller.follow('Alex', { distance: 2 }).ok, true);
  const cleared = controller.unfollow('Alex');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.stopped, true);
  assert.equal(controller.isActive(), false);
  const again = controller.unfollow('Alex');
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(controller.guard('Alex', { radius: 8 }).ok, true);
  const guarded = controller.unfollow('Alex');
  assert.equal(guarded.ok, true);
  assert.equal(guarded.stopped, false, 'unfollow never disables guard');
  assert.equal(controller.mode, 'GUARD');
  assert.equal(controller.unfollow('bad name').ok, false);
});

test('guard attacks a hostile mob near the player and never the player', async () => {
  const { world, bot, alex, controller } = fixture({ iron_sword: 1 }, { playerPosition: { x: 3, y: 65, z: 0 } });
  const zombie = world.addMob('zombie', { x: 5, y: 65, z: 2 });
  const guard = controller.guard('Alex', { radius: 8 });
  assert.equal(guard.ok, true);
  const tick = await controller.tick();
  assert.equal(tick.active, true);
  assert.ok(tick.defence, JSON.stringify(tick));
  assert.ok(zombie.health < 20, 'the zombie took real damage');
  assert.equal(alex.health, 20, 'the guarded player is untouched');
  assert.equal(controller.stats.defences >= 1, true);
});

test('give verifies the inventory drop and refuses a missing item', async () => {
  const { bot, controller } = fixture({ iron_sword: 1, oak_log: 20 });
  const before = bot.countItem('oak_log');
  const given = await controller.give('Alex', 'oak_log', 5);
  assert.equal(given.ok, true, JSON.stringify(given));
  assert.equal(given.count, 5);
  assert.equal(bot.countItem('oak_log'), before - 5);
  const missing = await controller.give('Alex', 'diamond', 1);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_HELD');
  const unknown = await controller.give('Ghost', 'oak_log', 1);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'PLAYER_NOT_SEEN');
});

test('loot drop keeps tools, totems, food and configured reserves', async () => {
  const inventory = {
    iron_sword: 1, totem_of_undying: 1, shield: 1,
    oak_log: 200, iron_ingot: 40, coal: 10, bread: 200
  };
  const { bot, controller } = fixture(inventory);
  const before = { ...bot.inventory };
  const result = await controller.dropLoot('Alex', { item: 'loot' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(bot.countItem('oak_log'), 128, 'log reserve preserved');
  assert.equal(bot.countItem('iron_ingot'), 32, 'ingot reserve preserved');
  assert.equal(bot.countItem('bread'), 128, 'food reserve preserved');
  assert.equal(bot.countItem('coal'), 0, 'excess loot was dropped');
  assert.equal(bot.countItem('iron_sword'), 1);
  assert.equal(bot.countItem('totem_of_undying'), 1);
  assert.equal(bot.countItem('shield'), 1);
  assert.deepEqual(result.dropped.map((entry) => entry.item).sort(), ['bread', 'coal', 'iron_ingot', 'oak_log']);
  assert.ok(result.total > 0);
  assert.equal(before.iron_sword, 1);
});

test('message refuses chat-command injection and prefixes the player name', async () => {
  const { bot, controller } = fixture();
  const injected = await controller.message('Alex', '/op Alex');
  assert.equal(injected.ok, false);
  assert.equal(injected.code, 'INVALID_MESSAGE');
  const sent = await controller.message('Alex', 'need wood?');
  assert.equal(sent.ok, true);
  assert.match(bot.lastChat, /^Alex: need wood\?$/);
  const greet = await controller.greet('Alex');
  assert.equal(greet.ok, true);
  assert.match(bot.lastChat, /Hello Alex/);
});

test('inventory all returns a real per-bot row with capacity arithmetic', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false, connect: false });
  await runtime.init();
  const result = await runtime.commands.execute('inventory all', { source: 'cli' });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  assert.equal(result.result.completed, runtime.bots.size);
  for (const row of result.result.results) {
    assert.equal(row.ok, true);
    assert.equal(typeof row.capacity, 'number');
    assert.equal(row.used + row.free, row.capacity);
  }
  await runtime.shutdown('inventory all test');
});

test('players command drives the fleet and reports every bot', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const leader = runtime.bots.get('________');
    runtime.world.entities.push(player('Alex', { x: leader.position.x + 3, y: leader.position.y, z: leader.position.z }));
    runtime.players.observeBots(runtime.bots.values());
    const list = await runtime.commands.execute('players', { source: 'cli' });
    assert.equal(list.ok, true);
    assert.ok(list.result.players.some((row) => row.name === 'Alex'));
    const follow = await runtime.commands.execute('players follow Alex all 2', { source: 'cli' });
    assert.equal(follow.ok, true, JSON.stringify(follow.result));
    assert.equal(follow.result.completed, runtime.bots.size);
    assert.equal(follow.result.results.every((row) => row.ok && row.mode === 'FOLLOW'), true);
    const bad = await runtime.commands.execute('players follow Alex all 999', { source: 'cli' });
    assert.equal(bad.ok, false, 'an out-of-range distance is a clear arg error, not a silent clamp');
    assert.equal(bad.result.code, 'COMMAND_ERROR');
    const following = await runtime.commands.execute('players following all', { source: 'cli' });
    assert.equal(following.ok, true);
    assert.equal(following.result.watches.length, runtime.bots.size);
    assert.equal(following.result.watches.every((row) => row.mode === 'FOLLOW' && row.target === 'Alex'), true);
    const unfollow = await runtime.commands.execute('players unfollow Alex all', { source: 'cli' });
    assert.equal(unfollow.ok, true, JSON.stringify(unfollow.result));
    assert.equal(unfollow.result.cancelled, runtime.bots.size);
    assert.equal(runtime.actions.list().every((actions) => actions.players.isActive() === false), true);
    assert.equal((await runtime.commands.execute('players guard Alex all 8', { source: 'cli' })).ok, true);
    const followingGuard = await runtime.commands.execute('players following all', { source: 'cli' });
    assert.equal(followingGuard.result.count, 0, 'guard is not a follow');
    const allWatches = await runtime.commands.execute('players watches all', { source: 'cli' });
    assert.equal(allWatches.result.count, runtime.bots.size, 'watches shows guard state');
    const stop = await runtime.commands.execute('players stop all', { source: 'cli' });
    assert.equal(stop.ok, true);
    const unknown = await runtime.commands.execute('players follow Ghost', { source: 'cli' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.result.results[0].code, 'PLAYER_NOT_SEEN');
    const ambiguous = await runtime.commands.execute('players unfollow all Alex', { source: 'cli' });
    assert.equal(ambiguous.ok, false, 'must not ignore Alex and clear every follow');
    assert.match(ambiguous.result.error, /usage: players unfollow/);
    const wildcard = await runtime.commands.execute('players follow Alex * 4', { source: 'cli' });
    assert.equal(wildcard.ok, true, JSON.stringify(wildcard.result));
    assert.equal(wildcard.result.completed, runtime.bots.size);
    await runtime.commands.execute('players stop all', { source: 'cli' });
  } finally {
    await runtime.shutdown('test');
  }
});

test('follow <player> starts a persistent player watch and follow stop clears both layers', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const leader = runtime.bots.get('________');
    runtime.world.entities.push(player('Alex', { x: leader.position.x + 5, y: leader.position.y, z: leader.position.z }));
    runtime.players.observeBots(runtime.bots.values());
    const follow = await runtime.commands.execute('follow Alex 16', { source: 'cli' });
    assert.equal(follow.ok, true, JSON.stringify(follow.result));
    assert.equal(follow.result.kind, 'player');
    assert.equal(follow.result.results.length, runtime.bots.size);
    assert.equal(follow.result.results.every((row) => row.ok !== false && row.distance === 16), true);
    // A player follow is a PlayerController watch, not bare CombatController
    // entity chasing: it must survive a temporary entity gap from the last
    // known position and report its own movement state.
    assert.equal(runtime.actions.list().every((actions) => actions.players.mode === 'FOLLOW' && actions.players.target === 'Alex'), true);
    const watch = runtime.actions.list()[0].players.status();
    assert.ok(Object.hasOwn(watch, 'followLeadMs'));
    assert.ok(Object.hasOwn(watch, 'followCatchUp'));
    assert.ok(Object.hasOwn(watch, 'lastMoveResult'));
    await runtime._warmStatusCaches();
    const { statusSnapshot } = require('../src/runtimeState');
    const snapshot = statusSnapshot(runtime.services);
    const row = snapshot.playerWatch.find((entry) => entry.mode === 'FOLLOW');
    assert.ok(row, 'the Players page receives the watch row');
    assert.ok(Object.hasOwn(row, 'followLeadMs'));
    assert.ok(Object.hasOwn(row, 'followCatchUp'));
    const botFollow = await runtime.commands.execute('follow 10101000 4', { source: 'cli' });
    assert.equal(botFollow.ok, true, JSON.stringify(botFollow.result));
    assert.equal(botFollow.result.kind, 'bot');
    const stop = await runtime.commands.execute('follow stop', { source: 'cli' });
    assert.equal(stop.ok, true, JSON.stringify(stop.result));
    assert.equal(runtime.actions.list().every((actions) => actions.players.isActive() === false), true);
    assert.equal(runtime.actions.list().every((actions) => actions.combat.followTarget === null), true);
  } finally {
    await runtime.shutdown('follow command test');
  }
});

test('the dashboard exposes players and per-bot player watch', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  try {
    const { statusSnapshot } = require('../src/runtimeState');
    // Status is cache-only by contract; the runtime warms it before serving a
    // dashboard. A cold snapshot intentionally reports no controller sections.
    await runtime._warmStatusCaches();
    const snapshot = statusSnapshot(runtime.services);
    assert.equal(snapshot.players.count, 0);
    assert.ok(Array.isArray(snapshot.players.rows));
    assert.equal(snapshot.playerWatch.length, runtime.bots.size);
    assert.equal(snapshot.playerWatch.every((row) => row.mode === null), true);
  } finally {
    await runtime.shutdown('test');
  }
});
