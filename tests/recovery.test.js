'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryManager, RECOVERY_STATES } = require('../src/actions/recovery');

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
