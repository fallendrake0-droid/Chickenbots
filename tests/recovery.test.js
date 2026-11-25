'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryManager, RECOVERY_STATES } = require('../src/actions/recovery');
const { BotActions } = require('../src/actions');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { config } = require('../src/config');

function clock(start = 1000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a single death is a suspect watch, not a permanent stop', () => {
  const c = clock();
  const recovery = new RecoveryManager({ botName: '________', now: c.now });
  recovery.recordDeath({ position: { x: 1, y: 64, z: 1 }, cause: 'zombie', threats: [{ name: 'zombie', distance: 2, hostile: true }] });
  assert.equal(recovery.state, RECOVERY_STATES.SUSPECT);
  assert.equal(recovery.canWork(), true);
  assert.equal(recovery.deathLoop, false);
  assert.equal(recovery.status().deathsRecent, 1);
  c.advance(31000);
  recovery.update({ health: 20, food: 20, threats: 0 });
  assert.equal(recovery.state, RECOVERY_STATES.ACTIVE);
});

test('repeated deaths trigger recovery, task re-plan and a safe-hold period', () => {
  const c = clock();
  const recovery = new RecoveryManager({ botName: '10101000', now: c.now });
  for (let i = 0; i < 3; i++) {
    recovery.recordDeath({ position: { x: 2, y: 64, z: 2 }, cause: 'zombie', threats: [{ name: 'zombie', distance: 2, hostile: true }] });
    c.advance(10000);
  }
  assert.equal(recovery.state, RECOVERY_STATES.RECOVERING);
  assert.equal(recovery.deathLoop, true);
  assert.equal(recovery.canWork(), false);
  assert.equal(recovery.needsReplanning(), true);

  // The bot cannot leave recovery until the full window has elapsed.
  c.advance(30000);
  recovery.update({ health: 20, food: 20, threats: 0 });
  assert.equal(recovery.state, RECOVERY_STATES.RECOVERING);

  c.advance(61000);
  recovery.update({ health: 20, food: 20, threats: 0 });
  assert.equal(recovery.state, RECOVERY_STATES.TASK_REPLAN);
  assert.equal(recovery.consumeReplan(), true);
  assert.equal(recovery.state, RECOVERY_STATES.SAFE_HOLD);
  assert.equal(recovery.canWork(), false);

  c.advance(61000);
  recovery.update({ health: 20, food: 20, threats: 0 });
  assert.equal(recovery.state, RECOVERY_STATES.ACTIVE);
  assert.equal(recovery.deathLoop, false);
  assert.equal(recovery.canWork(), true);
});

test('an unsafe spawn keeps the bot in recovery and records the reason', () => {
  const c = clock();
  const recovery = new RecoveryManager({ botName: '01010100', now: c.now });
  const assessment = recovery.recordSpawn({
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    threats: [
      { name: 'zombie', distance: 2, hostile: true },
      { name: 'skeleton', distance: 3, hostile: true },
      { name: 'creeper', distance: 4, hostile: true }
    ]
  });
  assert.equal(assessment.safe, false);
  assert.equal(recovery.state, RECOVERY_STATES.RECOVERING);
  assert.ok(assessment.reasons.join(' ').includes('zombie'));
  const hazardous = recovery.assessSpawn({ threats: [], health: 20, food: 20, hazards: ['lava at spawn'] });
  assert.equal(hazardous.safe, false);
  assert.ok(hazardous.reasons.includes('lava at spawn'));
});

test('critical health enters recovery without inventing a death', () => {
  const c = clock();
  const recovery = new RecoveryManager({ botName: '11001100', now: c.now });
  recovery.update({ health: 4, food: 20, threats: 0 });
  assert.equal(recovery.state, RECOVERY_STATES.RECOVERING);
  assert.equal(recovery.status().deaths.length, 0);
  assert.equal(recovery.needsReplan, true);
});

test('death history is bounded and keeps real evidence', () => {
  const c = clock();
  const recovery = new RecoveryManager({ botName: '00110000', now: c.now, historyLimit: 4, longThreshold: 100 });
  for (let i = 0; i < 9; i++) {
    recovery.recordDeath({
      position: { x: i, y: 64, z: -i },
      cause: i % 2 ? 'zombie' : 'skeleton',
      healthBefore: 2,
      food: 7,
      deathMessage: `[${'00110000'}] was slain by Zombie`
    });
    c.advance(1000);
  }
  const status = recovery.status();
  assert.ok(status.deaths.length <= 4);
  assert.equal(status.deaths.at(-1).cause, 'skeleton');
  assert.ok(status.deaths.at(-1).deathMessage.includes('slain'));
});

test('RealBot records a real death with attacker evidence and clears it on spawn', () => {
  const { RealBot } = require('../src/bot/realBot');
  const handlers = new Map();
  const fake = {
    entity: { position: { x: 10, y: 64, z: -4 } },
    health: 20,
    food: 18,
    game: { dimension: 'overworld' },
    entities: {},
    on(event, cb) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(cb); return this; },
    emit(event) { for (const cb of handlers.get(event) || []) cb(); }
  };
  const real = new RealBot({ name: '________', createBot: () => fake, loginPassword: '', registerPassword: '' });
  real.bot = fake;
  real.connected = true;
  real.spawned = true;
  real.authenticated = true;
  real.spawnedAt = Date.now();
  real.position = { x: 10, y: 64, z: -4 };
  real._attachEvents();
  real._scheduleRespawn = () => {};
  assert.ok(handlers.has('death'));

  const attacker = { name: 'zombie', type: 'mob', position: { x: 11, y: 64, z: -4, distanceTo: () => 1 } };
  fake.entities = { 1: attacker };
  fake.health = 4;
  fake.emit('health');
  fake.health = 0;
  fake.emit('health');
  fake.emit('death');

  assert.equal(real.deaths, 1);
  assert.ok(real.lastDeath, 'death evidence must be recorded');
  assert.equal(real.lastDeath.position.x, 10);
  assert.equal(real.lastDeath.attacker.name, 'zombie');
  assert.equal(real.lastDeath.dimension, 'overworld');
  assert.equal(real.lastDeath.confidence, 'likely');
  assert.ok(real.lastDeath.summary.includes('Died at'));
  assert.ok(real.lastDeath.environment);
  assert.equal(real.deathHistory.length, 1);

  fake.health = 20;
  fake.emit('spawn');
  assert.ok(real.lastSpawn.at >= real.lastDeath.at);
  assert.equal(real.lastSpawn.respawned, true);
});

test('MockBot exposes the same death and respawn evidence shape', () => {
  const { MockBot } = require('../src/bot/mockBot');
const { config } = require('../src/config');
  const bot = new MockBot({ name: '10101000' });
  const result = bot.damage(40, 'zombie', { attacker: { name: 'zombie', type: 'zombie', distance: 2 } });
  assert.equal(result.dead, true);
  assert.ok(bot.lastDeath);
  assert.equal(bot.lastDeath.cause, 'zombie (2m)');
  assert.equal(bot.lastDeath.attacker.distance, 2);
  assert.equal(bot.lastDeath.confidence, 'likely');
  assert.ok(bot.lastDeath.environment);
  assert.equal(bot.deathHistory.length, 1);
  assert.equal(bot.deaths, 1);
  const spawn = bot.respawn();
  assert.equal(spawn.ok, true);
  assert.equal(bot.lastSpawn.respawned, true);
  assert.ok(bot.lastSpawn.at >= bot.lastDeath.at);
});

test('an unknown entity distance is reported as unknown, never NaNm', () => {
  const recovery = new RecoveryManager({ botName: '________' });
  const assessment = recovery.assessSpawn({
    threats: [
      { name: 'spider', type: 'spider', hostile: true, position: { x: 1, y: 64, z: 1 }, distance: undefined },
      { name: 'zombie', type: 'zombie', hostile: true, position: { x: 2, y: 64, z: 2 }, distance: 2.4 }
    ],
    health: 20,
    food: 20
  });
  assert.equal(Number.isNaN(assessment.score), false);
  assert.equal(assessment.nearest.name, 'zombie');
  assert.equal(assessment.nearest.distance, 2.4);
  assert.match(assessment.reasons.join(' '), /zombie 2.4m away/);
  assert.equal(assessment.reasons.join(' ').includes('NaN'), false);
});

test('a first spawn into a zombie pack runs a verified emergency retreat, not a task', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '________', world, speed: 0 });
  bot.position = { x: 0, y: 64, z: 0 };
  bot.health = 18;
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1]]) world.addMob('zombie', { x, y: 64, z });
  const actions = new BotActions({ bot, world });
  const assessment = actions.combat.assess(16);
  assert.equal(assessment.threats.length, 3);
  const before = { ...bot.position };
  const result = await actions._threatResponse(assessment);
  assert.equal(result.emergency, true);
  assert.equal(result.action, 'recovery-retreat');
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.notDeepEqual(bot.position, before, 'the bot must actually leave the threat cluster');
});

test('safetyTick assesses the first spawn immediately and flags it unsafe', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '10101000', world, speed: 0 });
  bot.position = { x: 0, y: 64, z: 0 };
  world.addMob('zombie', { x: 1, y: 64, z: 0 });
  const actions = new BotActions({ bot, world });
  const result = await actions.safetyTick();
  assert.equal(result.emergency, true);
  assert.equal(actions.recovery.spawnSafety.safe, false);
  assert.match(actions.recovery.spawnSafety.reasons.join(' '), /zombie 1\.0m away/);
});

test('a creeper at melee range forces escape even when the bot is armed', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '11001100', world, speed: 0, inventory: { iron_sword: 1, shield: 1 } });
  bot.position = { x: 0, y: 64, z: 0 };
  world.addMob('creeper', { x: 3, y: 64, z: 0 });
  const actions = new BotActions({ bot, world });
  const result = await actions._threatResponse(actions.combat.assess(16));
  assert.equal(result.emergency, true);
  assert.equal(result.action, 'recovery-retreat');
  assert.equal(result.ok, true);
});

test('the action watchdog can stop long controller loops', () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '10101000', world, speed: 0 });
  const actions = new BotActions({ bot, world });
  const result = actions.cancelCurrent('test budget');
  assert.equal(result.ok, true);
  assert.deepEqual(result.stopped.sort(), ['combat', 'farming', 'mining', 'players', 'woodcutting']);
  assert.equal(actions.players.isActive(), false, 'a watchdog also clears a player watch');
  assert.equal(actions.woodcutting.stopRequested, true);
  assert.equal(actions.mining.stopRequested, true);
  assert.equal(actions.farming.stopRequested, true);
  assert.equal(actions.combat.stopRequested, true, 'combat loops must observe the same watchdog');
});

test('an unsafe spawn that turns out safe does not pin the bot in recovery for 90s', () => {
  const c = clock();
  const recovery = new RecoveryManager({ botName: '11001100', now: c.now });
  recovery.recordSpawn({
    position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, threats: [], hazards: ['suffocation risk']
  });
  assert.equal(recovery.state, RECOVERY_STATES.RECOVERING);
  assert.equal(recovery.deathLoop, false);
  // The hazard was a leaf at head height; once it is re-assessed as clear the
  // bot only serves the short suspect hold, not the death-loop hold.
  const recheck = recovery.assessSpawn({ position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, threats: [], hazards: [] });
  assert.equal(recheck.safe, true);
  c.advance(31000);
  recovery.update({ health: 20, food: 20, threats: 0, spawnSafe: true });
  assert.equal(recovery.state, RECOVERY_STATES.TASK_REPLAN);
});

test('a bot spawned inside a solid block has a real escape target', () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '01010100', world, speed: 0 });
  bot.position = { x: 0, y: 64, z: 0 };
  world.setBlock({ x: 0, y: 65, z: 0 }, 'oak_log');
  const actions = new BotActions({ bot, world });
  const target = actions._findSpawnEscape();
  assert.ok(target, 'a neighbouring standing position exists');
  assert.equal(world.getBlock(target).name, 'air');
  assert.equal(world.getBlock({ x: target.x, y: target.y + 1, z: target.z }).name, 'air');
});

test('safety reports each stage and re-scans equipment after a respawn', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '11001010', world, speed: 0, inventory: { iron_sword: 1, cooked_beef: 8 } });
  bot.position = { x: 0, y: 64, z: 0 };
  const actions = new BotActions({ bot, world });
  actions.combat.state = 'DEAD';
  actions.combat.lastArmorSignature = 'old-armour';
  actions.combat.lastWeapon = 'old-sword';
  const result = await actions.safetyTick();
  assert.equal(result.stages !== undefined, true);
  assert.equal(typeof result.totalMs, 'number');
  assert.equal(Object.keys(result.stages).length > 0, true);
  assert.equal(actions.combat.lastArmorSignature, null);
  assert.equal(actions.combat.lastWeapon, null);
  assert.ok(result.equipmentRescan, 'the respawn pass records the real inventory/equipment');
  assert.equal(result.equipmentRescan.food, bot.food);
});

test('death attribution does not blame the nearest entity without damage evidence', () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '________', world, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  const actions = new BotActions({ bot });
  bot.entitiesNear = () => [
    { name: 'chicken', type: 'animal', hostile: false, distance: 5.8, position: { x: 1, y: 64, z: 0 } },
    { name: 'zombie', type: 'zombie', hostile: true, distance: 2.0, position: { x: 0, y: 64, z: 2 } }
  ];
  bot.lastDeath = { at: Date.now(), position: { x: 0, y: 64, z: 0 }, confidence: 'unknown' };
  actions._recordDeath();
  const entry = actions.recovery.lastDeath;
  assert.equal(entry.cause, 'UNKNOWN_CAUSE', 'a nearby zombie is not proof it dealt the killing blow');
  assert.equal(entry.confidence, 'unknown');
  assert.ok(entry.threats.length >= 1, 'threat context is still retained');

  // The live log's `item (1.3m)` attribution is not a death cause.
  const itemBot = new MockBot({ name: '01010100', world, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  const itemActions = new BotActions({ bot: itemBot });
  itemBot.entitiesNear = () => [{ name: 'item', type: 'object', distance: 1.3, position: { x: 0, y: 64, z: 1 } }];
  itemBot.lastDeath = {
    at: Date.now(), position: { x: 0, y: 64, z: 0 }, cause: 'item (1.3m)',
    attacker: { name: 'item', type: 'object', distance: 1.3 }, confidence: 'unknown'
  };
  itemActions._recordDeath();
  assert.equal(itemActions.recovery.lastDeath.cause, 'UNKNOWN_CAUSE');
  assert.equal(itemActions.recovery.lastDeath.confidence, 'unknown');

  // When the adapter records an actual attacker/damage source, use it.
  const real = new MockBot({ name: '10101000', world, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  const realActions = new BotActions({ bot: real });
  real.entitiesNear = () => [{ name: 'chicken', type: 'animal', hostile: false, distance: 0.8, position: { x: 0, y: 64, z: 1 } }];
  real.lastDeath = { at: Date.now(), position: { x: 0, y: 64, z: 0 }, cause: 'skeleton', confidence: 'likely' };
  realActions._recordDeath();
  const attributed = realActions.recovery.lastDeath;
  assert.equal(attributed.cause, 'skeleton');
  assert.equal(attributed.confidence, 'likely');
});

test('safetyTick turns the configured budget into a hard deadline for retreat', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '01010100', world });
  world.addMob('zombie', { x: 2, y: 64, z: 0 });
  const actions = new BotActions({ bot, world });
  const previous = config.survival.emergencyBudgetMs;
  config.survival.emergencyBudgetMs = 1234;
  let seen = null;
  actions._emergencyRetreat = async (_threat, options) => {
    seen = options;
    return { ok: true, action: 'escape' };
  };
  try {
    const started = Date.now();
    await actions.safetyTick();
    assert.ok(seen && seen.deadlineAt >= started + 1000 && seen.deadlineAt <= Date.now() + 1234,
      `retreat must receive the configured deadline: ${JSON.stringify(seen)}`);
  } finally {
    config.survival.emergencyBudgetMs = previous;
  }
});

test('a failed close-range escape is retried on the next safety pass, not rate-limited', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '11001100', world });
  world.addMob('zombie', { x: 0.8, y: 64, z: 0 });
  const actions = new BotActions({ bot, world });
  const assessment = actions.combat.assess(16);
  let calls = 0;
  actions._emergencyRetreat = async () => {
    calls++;
    return { action: 'recovery-retreat', ok: false, verified: false, reason: 'blocked' };
  };
  const first = await actions._threatResponse(assessment);
  const second = await actions._threatResponse(assessment);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(calls, 2, 'a failed retreat must not start a 1.2s cooldown while a zombie is in melee range');
});

test('a safety pass that hangs is released at the configured budget', async () => {
  const world = new MockWorld({ flat: true });
  const bot = new MockBot({ name: '00110000', world, position: { x: 0, y: 64, z: 0 }, inventory: {} });
  const actions = new BotActions({ bot });
  const previous = config.survival.emergencyBudgetMs;
  config.survival.emergencyBudgetMs = 1000;
  actions._safetyTickBody = () => new Promise(() => {});
  try {
    const started = Date.now();
    const result = await actions.safetyTick();
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(elapsed >= 1000 && elapsed < 2500, `released after ${elapsed}ms`);
    assert.equal(actions.combat.stopRequested, true, 'the hung controller was told to stop');
  } finally {
    config.survival.emergencyBudgetMs = previous;
  }
});
