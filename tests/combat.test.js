'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { CombatController } = require('../src/actions/combat');
const { evaluateWeapons, selectWeapon, optimizeArmor, gearStatus, durabilityOf, upgradePlan } = require('../src/combat/equipment');
const { TotemManager, teamTotemLedger } = require('../src/combat/totems');
const { chooseFood, choosePotion, parsePotion, consumeItem } = require('../src/combat/supplies');
const { PvpPolicy } = require('../src/combat/players');
const { TeamCombatCoordinator } = require('../src/combat/team');
const { profileFor, isHostile, isNeutral, hostileRegistry, neutralRegistry } = require('../src/combat/mobs');
const { COMBAT_STATES, ACTION_PRIORITY } = require('../src/combat/constants');
const { TeamRuntime } = require('../src/runtime');
const { RealBot } = require('../src/bot/realBot');

const NAMES = ['______', '101010', '010101', '110011', '001100'];

function flatBot(name = NAMES[0], inventory = {}, position = { x: 0, y: 64, z: 0 }, meta = null) {
  const world = new MockWorld({ flat: true, seed: 101 });
  const bot = new MockBot({ name, world, inventory: { ...inventory }, position: { ...position } });
  if (meta) bot.itemMeta = meta;
  return { bot, world };
}

function players() {
  return [
    { id: 'p1', username: 'EnemyOne', name: 'EnemyOne', type: 'player', position: { x: 1, y: 64, z: 0 }, health: 20 },
    { id: 'p2', username: 'FriendOne', name: 'FriendOne', type: 'player', position: { x: 1, y: 64, z: 0 }, health: 20 }
  ];
}

test('weapon evaluation understands target-specific enchantments, axes and durability', () => {
  const inventory = {
    diamond_sword: 1, iron_sword: 1, diamond_axe: 1, bow: 1, arrow: 8,
    wooden_sword: 1
  };
  const meta = {
    diamond_sword: { enchantments: { sharpness: 1 }, durability: 1500, maxDurability: 1561 },
    iron_sword: { enchantments: { smite: 5 }, durability: 240, maxDurability: 250 },
    diamond_axe: { enchantments: { sharpness: 1 }, durability: 1500, maxDurability: 1561 },
    wooden_sword: { durability: 1, maxDurability: 59 }
  };
  const undead = selectWeapon({ inventory, meta, target: { name: 'zombie', hostile: true } });
  assert.equal(undead.ok, true);
  assert.equal(undead.weapon.name, 'iron_sword', 'Smite V must beat a Sharpness I diamond sword against undead');
  assert.equal(undead.smiteForUndead, true);
  const player = selectWeapon({ inventory, meta, target: { username: 'Enemy', type: 'player' } });
  assert.notEqual(player.weapon.name, 'iron_sword', 'Smite has no value against a player');
  const blocked = selectWeapon({ inventory, meta, target: { username: 'Enemy', type: 'player', blocking: true } });
  assert.ok(['diamond_axe', 'diamond_sword'].includes(blocked.weapon.name));
  const ranged = selectWeapon({ inventory, meta, target: { name: 'skeleton', hostile: true }, distance: 12 });
  assert.equal(ranged.weapon.cls, 'bow', 'a distant ranged target should select the bow when ammunition exists');
  const broken = evaluateWeapons({ inventory: { wooden_sword: 1 }, meta });
  assert.equal(broken[0].available, false);
  assert.equal(durabilityOf('iron_sword', meta.iron_sword).ratio, 0.96);
  assert.ok(ACTION_PRIORITY.TOTEM_EMERGENCY > ACTION_PRIORITY.ATTACK);
});

test('armour optimisation selects the best whole set for the expected threat', () => {
  const inventory = {
    diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1,
    iron_chestplate: 1, netherite_boots: 1, elytra: 1, shield: 1
  };
  const meta = {
    iron_chestplate: { enchantments: { projectile_protection: 4 } },
    diamond_chestplate: { enchantments: { protection: 2 } },
    netherite_boots: { enchantments: { feather_falling: 4 } },
    diamond_boots: { durability: 2, maxDurability: 429 }
  };
  const skeleton = optimizeArmor({ inventory, meta, target: { name: 'skeleton', hostile: true } });
  assert.equal(skeleton.pieces.torso.name, 'iron_chestplate', 'Projectile Protection IV must win against a skeleton');
  assert.equal(skeleton.pieces.feet.name, 'netherite_boots');
  assert.equal(skeleton.elytra, false, 'elytra must not displace a combat chestplate');
  const creeper = optimizeArmor({ inventory, meta, target: { name: 'creeper', hostile: true } });
  assert.ok(creeper.points >= 18);
  const flight = optimizeArmor({ inventory, meta, preferFlight: true });
  assert.equal(flight.elytra, true);
  const status = gearStatus({ inventory, meta, target: { username: 'Enemy', type: 'player' } });
  assert.ok(status.armor.points > 0);
  assert.equal(status.totems, 0);
});

test('totem manager equips, verifies activation, replaces a spare and reports reserves', async () => {
  const { bot } = flatBot(NAMES[0], { totem_of_undying: 2, shield: 1 });
  const manager = new TotemManager({ bot, reserve: 1 });
  const equipped = await manager.equip();
  assert.equal(equipped.ok, true);
  assert.equal(bot.getOffhand(), 'totem_of_undying');
  assert.equal(manager.equipped(), true);

  bot.health = 2;
  const damage = bot.damage(10, 'zombie');
  assert.equal(damage.totem, true);
  assert.equal(bot.health, 1);
  assert.equal(bot.countItem('totem_of_undying'), 1);
  const activations = manager.checkActivation();
  assert.equal(activations.length, 1);
  const handled = await manager.handleActivation();
  assert.equal(handled.ok, true);
  assert.equal(bot.getOffhand(), 'totem_of_undying');
  assert.equal(handled.totemsAfter, 1);
  assert.equal(handled.criticalReserveSafe, true);
  assert.equal(manager.status().activations, 1);

  bot.removeItem('totem_of_undying', 1);
  const empty = await manager.equip();
  assert.equal(empty.ok, false);
  assert.equal(manager.status().count, 0);
  const ledger = teamTotemLedger([{ totems: manager, bot }]);
  assert.equal(ledger.total, 0);
  assert.equal(ledger.reserveMet, 0);
});

test('food and potion policy distinguishes hunger from healing and conserves rare items', async () => {
  const full = chooseFood({ inventory: { cooked_beef: 4, golden_apple: 1 }, health: 20, food: 20 });
  assert.equal(full.ok, false);
  const hungry = chooseFood({ inventory: { cooked_beef: 2, bread: 3 }, health: 20, food: 12 });
  assert.equal(hungry.name, 'cooked_beef');
  const critical = chooseFood({ inventory: { golden_apple: 1 }, health: 6, food: 18 });
  assert.equal(critical.name, 'golden_apple');
  const enchanted = chooseFood({ inventory: { enchanted_golden_apple: 1 }, health: 4, food: 18, allowEnchanted: true, emergency: true });
  assert.equal(enchanted.name, 'enchanted_golden_apple');
  const conserved = chooseFood({ inventory: { enchanted_golden_apple: 1, bread: 1 }, health: 10, food: 10 });
  assert.equal(conserved.name, 'bread');

  assert.deepEqual(parsePotion('potion_of_healing').effect, 'healing');
  assert.equal(parsePotion('splash_potion_of_strong_healing').kind, 'splash');
  assert.equal(parsePotion('potion_of_swiftness').effect, 'swiftness');
  assert.equal(parsePotion('potion_of_regeneration').effect, 'regeneration');
  const bot = flatBot(NAMES[0], { potion_of_healing: 1 }).bot;
  bot.health = 7;
  const choice = choosePotion({ inventory: bot.inventory, bot, health: 7, threat: { name: 'zombie', hostile: true } });
  assert.equal(choice.effect, 'healing');
  const used = await consumeItem(bot, choice.name);
  assert.equal(used.consumed, true);
  assert.ok(bot.health > 7);
  bot.applyEffect('strength', { level: 2, duration: 100 });
  const duplicate = choosePotion({ inventory: { potion_of_strength: 1 }, bot, health: 20, threat: { name: 'zombie', hostile: true } });
  assert.equal(duplicate.ok, false, 'a weaker duplicate Strength must not be wasted');
  bot.applyEffect('poison', { level: 1, duration: 30 });
  const milk = choosePotion({ inventory: { milk_bucket: 1 }, bot, health: 16, threat: { name: 'spider', hostile: true } });
  assert.equal(milk.effect, 'milk');
});

test('mob registry covers current hostiles, separates neutrals and applies special profiles', () => {
  const registry = hostileRegistry();
  assert.ok(registry.length >= 30, `only ${registry.length} hostiles discovered`);
  for (const name of ['zombie', 'skeleton', 'creeper', 'witch', 'pillager', 'evoker', 'ravager', 'drowned', 'guardian', 'breeze', 'warden', 'wither']) {
    assert.ok(registry.includes(name), `${name} missing from installed registry`);
    assert.equal(isHostile({ name }), true, `${name} should be hostile`);
  }
  assert.equal(isHostile({ name: 'cow' }), false);
  assert.equal(isNeutral({ name: 'enderman' }), true);
  assert.ok(neutralRegistry().includes('enderman'));
  assert.equal(profileFor({ name: 'creeper' }).explosive, true);
  assert.equal(profileFor({ name: 'skeleton' }).ranged, true);
  assert.equal(profileFor({ name: 'warden' }).avoid, true);
  assert.equal(profileFor({ name: 'zombie' }).undead, true);
  assert.equal(profileFor({ name: 'spider' }).arthropod, true);
  assert.equal(profileFor({ name: 'drowned' }).aquatic, true);
});

test('PvP policy is explicit, refuses teammates/protected players and requires enablement', () => {
  const policy = new PvpPolicy({ enabled: false });
  const [enemy, friend] = players();
  assert.equal(policy.canEngage(enemy).code, 'PVP_DISABLED');
  policy.setEnabled(true);
  assert.equal(policy.canEngage(enemy).code, 'NOT_AUTHORIZED');
  policy.addTarget('EnemyOne');
  assert.equal(policy.canEngage(enemy, { serverPvp: true }).ok, true);
  assert.equal(policy.canEngage(enemy, { serverPvp: false }).code, 'SERVER_PVP_DISABLED');
  policy.protect('FriendOne');
  assert.equal(policy.canEngage(friend, { serverPvp: true }).code, 'PROTECTED');
  assert.equal(policy.canEngage({ username: '______' }, { serverPvp: true }).code, 'TEAMMATE');
  assert.equal(policy.addTarget('001100').ok, false);
  policy.removeTarget('EnemyOne');
  assert.equal(policy.canEngage(enemy, { serverPvp: true }).code, 'NOT_AUTHORIZED');
});

test('combat controller prepares gear, kills real mobs and refuses unauthorised players', async () => {
  const { bot, world } = flatBot(NAMES[0], {
    diamond_sword: 1, iron_chestplate: 1, shield: 1, totem_of_undying: 1,
    golden_apple: 1, bread: 2
  });
  bot.itemMeta = { diamond_sword: { enchantments: { sharpness: 2 }, durability: 1500, maxDurability: 1561 } };
  const zombie = world.addMob('zombie', { x: 2, y: 64, z: 0 });
  const controller = new CombatController({ bot });
  const assessment = controller.assess(16);
  assert.equal(assessment.count, 1);
  assert.equal(assessment.threats[0].profile.undead, true);
  const engagement = await controller.engage({ maxAttacks: 6 });
  assert.equal(engagement.ok, true);
  assert.equal(engagement.targetDefeated, true, JSON.stringify(engagement.results));
  assert.equal(zombie.alive, false);
  assert.equal(controller.stats.kills, 1);
  assert.equal(controller.stats.verifiedKills, 1);
  assert.equal(bot.equipment.heldItem, 'diamond_sword');
  assert.equal(bot.getOffhand(), 'totem_of_undying');
  assert.ok(['LOOTING', 'RECOVERING', 'IDLE', 'DISENGAGED'].includes(controller.state) || COMBAT_STATES.includes(controller.state));

  const player = { id: 'player-1', username: 'EnemyOne', name: 'EnemyOne', type: 'player', position: { x: 2, y: 64, z: 0 }, health: 20 };
  const refused = await controller.attackEntity(player);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /PvP|not on the explicit/i);
  controller.addTarget('EnemyOne');
  controller.setPvp(true);
  const authorized = controller.pvp.canEngage(player, { serverPvp: true });
  assert.equal(authorized.ok, true);
  const teammate = world.addMob('______', { x: 1, y: 64, z: 0 });
  assert.equal((await controller.attackEntity(teammate)).ok, false);
  const cow = world.addMob('cow', { x: 1, y: 64, z: 0 });
  assert.equal((await controller.attackEntity(cow)).ok, false);
  controller.setPve(false);
  assert.equal(controller.assess(16).threats.length, 0, 'PvE off must hide hostile mobs');
  assert.equal((await controller.attackEntity(zombie)).ok, false);
  controller.setPve(true);
});

test('controller detects a totem emergency, consumes a golden apple and retreats when health is critical', async () => {
  const { bot, world } = flatBot(NAMES[1], { totem_of_undying: 1, golden_apple: 1, iron_sword: 1 });
  const controller = new CombatController({ bot });
  await controller.totems.equip();
  const zombie = world.addMob('zombie', { x: 2, y: 64, z: 0 });
  bot.health = 2;
  bot.damage(20, 'zombie');
  assert.equal(bot.countItem('totem_of_undying'), 0);
  const engagement = await controller.engage({ target: controller.assess(16).threats[0], maxAttacks: 2 });
  assert.ok(controller.stats.totemActivations >= 1);
  assert.ok(['retreat', 'defend'].includes(engagement.action));
  assert.ok(zombie.health === 20 || zombie.alive === false);
  assert.ok(bot.health >= 1);
});

test('five-bot coordinator uses unique roles, one focus target and non-overlapping bearings', async () => {
  const world = new MockWorld({ flat: true, seed: 102 });
  const bots = NAMES.map((name, index) => new MockBot({
    name, world, inventory: { iron_sword: 1, bow: index === 2 ? 1 : 0, arrow: 8, iron_chestplate: 1 },
    position: { x: index, y: 64, z: 0 }
  }));
  const controllers = bots.map((bot) => new CombatController({ bot }));
  const coordinator = new TeamCombatCoordinator({ controllers });
  controllers.forEach((controller) => controller.attachTeam(coordinator));
  for (const controller of controllers) controller.setPolicy({ autoTotem: false, autoArmour: false });
  world.addMob('zombie', { x: 6, y: 64, z: 0 });
  world.addMob('skeleton', { x: 10, y: 64, z: 6 });
  const threats = controllers[0].assess(20).threats;
  const plans = controllers.map((controller) => coordinator.plan(controller, threats));
  const roles = plans.map((plan) => plan.role);
  assert.equal(new Set(roles).size, 5, `expected five distinct roles, got ${roles.join(',')}`);
  assert.ok(roles.includes('COORDINATOR'));
  assert.ok(roles.includes('RANGED'));
  assert.ok(roles.includes('SUPPORT'));
  assert.equal(new Set(plans.map((plan) => `${plan.offset.x},${plan.offset.z}`)).size >= 4, true);
  assert.equal(plans.every((plan) => plan.focus && plan.focus.id === plans[0].focus.id), true, 'focus fire must be shared');
  const status = coordinator.status();
  assert.equal(status.bots.length, 5);
  assert.equal(status.enabled, true);
  assert.ok(status.locks.length >= 1);
  const first = await coordinator.rescue(controllers[3]);
  assert.equal(first.rescuer !== controllers[3].bot.name, true);
  const retreat = await coordinator.retreat('test');
  assert.equal(retreat.ok, true);
  assert.equal(coordinator.mode, 'RETREAT');
});


test('combat commands control the real five-bot fleet and never authorise a teammate', async () => {
  const runtime = new TeamRuntime({ simulate: true, connect: false, dashboard: false });
  await runtime.init();
  try {
    const run = (line) => runtime.commands.execute(line, { source: 'cli' });
    const help = runtime.commands.help();
    for (const name of ['combat', 'pve', 'pvp', 'target', 'gear', 'totem', 'food', 'potions', 'guard', 'duel', 'arena']) {
      assert.ok(help.categories.combat.some((command) => command.name === name), `${name} command is missing`);
    }
    const controllers = runtime.actions.list().map((entry) => entry.combat);
    assert.equal(controllers.length, 5);

    const status = await run('combat status');
    assert.equal(status.ok, true, status.result?.error);
    assert.equal(status.result.bots.length, 5);
    assert.equal(status.result.bots.every((row) => row.armed === true), true);

    const off = await run('pve off');
    assert.equal(off.ok, true);
    assert.equal(controllers.every((controller) => controller.pveEnabled === false), true);
    assert.equal((await run('pve on')).ok, true);
    assert.equal(controllers.every((controller) => controller.pveEnabled === true), true);

    assert.equal((await run('combat off')).ok, true);
    assert.equal(controllers.every((controller) => controller.armed === false), true);
    assert.equal((await run('combat on')).ok, true);
    assert.equal(controllers.every((controller) => controller.armed === true), true);

    assert.equal((await run('auto totem off')).ok, true);
    assert.equal(controllers.every((controller) => controller.policy.autoTotem === false), true);
    assert.equal((await run('auto weapon on')).ok, true);

    const pvp = await run('pvp on');
    assert.equal(pvp.ok, true);
    assert.equal(controllers.every((controller) => controller.pvp.enabled === true), true);
    assert.equal((await run('target add EnemyOne')).ok, true);
    assert.deepEqual(controllers[0].pvp.list(), ['enemyone']);
    const teammate = { id: 'mate', username: '______', name: '______', type: 'player', position: { x: 1, y: 64, z: 0 }, health: 20 };
    const refused = await controllers[0].attackEntity(teammate);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /team|teammate/i);
    assert.equal((await run('target clear')).ok, true);
    assert.deepEqual(controllers[0].pvp.list(), []);

    const protectedResult = await run('target protect FriendOne');
    assert.equal(protectedResult.ok, true);
    assert.deepEqual(controllers[0].pvp.listProtected(), ['friendone']);

    const gear = await run('gear status');
    assert.equal(gear.ok, true);
    assert.equal(gear.result.gear.bestWeapon.name, 'diamond_sword');

    const totems = await run('totem status');
    assert.equal(totems.ok, true);
    assert.equal(totems.result.bots.length, 5);

    const food = await run('food status 101010');
    assert.equal(food.ok, true);
    assert.ok(Array.isArray(food.result.supplies.food));

    const arena = await run('arena on 16');
    assert.equal(arena.ok, true);
    assert.equal(controllers.every((controller) => controller.pvp.arenas.length === 1), true);
    assert.equal((await run('arena off')).ok, true);

    const livePlayer = { id: 'pvp-team', username: 'EnemyOne', name: 'EnemyOne', type: 'player', position: { x: 1, y: runtime.home.y, z: 0 }, health: 20, hostile: false, alive: true };
    runtime.world.entities.push(livePlayer);
    const teamAttackResult = await run('team attack EnemyOne');
    assert.equal(teamAttackResult.ok, true, JSON.stringify(teamAttackResult.result?.results));
    assert.equal(livePlayer.alive, false, 'explicit team PvP kills the authorised player');
    await run('target clear');
    await run('pvp off');

    const duel = await run('duel EnemyOne');
    assert.equal(duel.ok, false);
    assert.equal(duel.result.code, 'CONFIRMATION_REQUIRED');
    const team = await run('team combat status');
    assert.equal(team.ok, true);
    assert.equal(team.result.combat.bots.length, 5);
  } finally {
    await runtime.shutdown('test');
  }
});


test('PvP respects an explicit server gate and the totem is never displaced by a shield', async () => {
  const { bot } = flatBot(NAMES[2], { diamond_sword: 1, shield: 1, totem_of_undying: 1 });
  const controller = new CombatController({ bot });
  await controller.totems.equip();
  const offhand = await controller.totems.chooseOffhand({ threat: { name: 'skeleton', type: 'hostile', position: { x: 8, y: 64, z: 0 } }, health: 20, totalThreats: 1 });
  assert.equal(offhand.offhand, 'totem_of_undying');
  assert.equal(bot.getOffhand(), 'totem_of_undying');
  controller.addTarget('EnemyOne');
  controller.setPvp(true);
  controller.serverPvp = false;
  const player = { id: 'p1', username: 'EnemyOne', name: 'EnemyOne', type: 'player', position: { x: 2, y: 64, z: 0 }, health: 20 };
  const refused = await controller.attackEntity(player);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'SERVER_PVP_DISABLED');
});

test('team focus accepts an authorised player and auto-rescue chooses a healthy non-victim', async () => {
  const world = new MockWorld({ flat: true, seed: 103 });
  const bots = NAMES.map((name, index) => new MockBot({ name, world, inventory: { iron_sword: 1 }, position: { x: index, y: 64, z: 0 } }));
  const controllers = bots.map((bot) => new CombatController({ bot }));
  const coordinator = new TeamCombatCoordinator({ controllers });
  controllers.forEach((controller) => controller.attachTeam(coordinator));
  const player = { id: 'pvp-1', username: 'EnemyOne', name: 'EnemyOne', type: 'player', position: { x: 8, y: 64, z: 0 }, health: 20, hostile: false, alive: true };
  world.entities.push(player);
  controllers[0].addTarget('EnemyOne');
  controllers[0].setPvp(true);
  const threats = controllers[0].assess(20).threats;
  assert.equal(threats.length, 1);
  const focus = coordinator.chooseFocus(threats);
  assert.equal(focus.id, 'pvp-1');
  bots[3].health = 6;
  const rescue = await coordinator.autoRescue({ cooldownMs: 0 });
  assert.equal(rescue.victim, NAMES[3]);
  assert.notEqual(rescue.rescuer, NAMES[3]);
  assert.equal(rescue.ok, true);
  const tooSoon = await coordinator.autoRescue({ cooldownMs: 8000 });
  assert.equal(tooSoon.reason, 'rescue cooldown');
  const roles = coordinator.assignRoles({ force: true });
  assert.equal(Object.keys(roles).length, 5);
});


test('follow keeps distance without granting PvP, and death clears target before respawn', async () => {
  const { bot } = flatBot(NAMES[0], { iron_sword: 1 });
  const leader = flatBot(NAMES[1], { iron_sword: 1 }, { x: 0, y: 64, z: 12 }).bot;
  const controller = new CombatController({ bot });
  const started = await controller.follow(leader, { distance: 3 });
  assert.equal(started.ok, true);
  assert.equal(controller.mode, 'FOLLOW');
  const tick = await controller.followTick();
  assert.equal(tick.visible, true);
  assert.ok(Math.hypot(bot.position.x - leader.position.x, bot.position.z - leader.position.z) < 12, 'follow moved the bot toward its leader');

  controller.addTarget('EnemyOne');
  controller.setPvp(false);
  const playerTick = await controller.follow('EnemyOne', { distance: 3 });
  assert.equal(playerTick.mode, 'FOLLOW');
  assert.equal(controller.pvp.canEngage('EnemyOne').ok, false, 'following a player never enables PvP');
  controller.stopFollow();
  assert.equal(controller.followTarget, null);
  assert.equal(controller.mode, 'BALANCED');

  const releases = [];
  controller.combatTeam = { releaseBot: (name) => releases.push(name) };
  controller.target = { id: 'zombie-1', name: 'zombie' };
  controller.onDeath('test');
  assert.equal(controller.state, 'DEAD');
  assert.equal(controller.target, null);
  assert.equal(controller.stats.deaths, 1);
  assert.deepEqual(releases, [NAMES[0]]);
  controller.onDeath('test again');
  assert.equal(controller.stats.deaths, 1, 'death is counted once');
  controller.onRespawn();
  assert.equal(controller.state, 'RECOVERING');
  assert.equal(controller.stopRequested, false);
});


test('team healing hands a spare golden apple to the most injured teammate and records it', async () => {
  const world = new MockWorld({ flat: true, seed: 104 });
  const bots = NAMES.map((name, index) => new MockBot({ name, world, inventory: { iron_sword: 1 }, position: { x: index, y: 64, z: 0 } }));
  const controllers = bots.map((bot) => new CombatController({ bot }));
  const coordinator = new TeamCombatCoordinator({ controllers });
  controllers.forEach((controller) => controller.attachTeam(coordinator));
  bots[0].inventory.golden_apple = 3;
  bots[4].health = 7;
  const result = await coordinator.assistHealing({ cooldownMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.victim, NAMES[4]);
  assert.equal(result.donor, NAMES[0]);
  assert.equal(bots[0].countItem('golden_apple'), 2);
  assert.equal(bots[4].countItem('golden_apple'), 1);
  assert.equal(coordinator.status().stats.heals, 1);
  const soon = await coordinator.assistHealing({ cooldownMs: 5000 });
  assert.equal(soon.reason, 'healing cooldown');
});


test('gear progression derives upgrade goals only from carried items', () => {
  const weak = upgradePlan({ inventory: { stone_sword: 1, iron_helmet: 1, golden_apple: 1 }, meta: {} });
  assert.ok(weak.goals.some((goal) => goal.includes('totem')));
  assert.ok(weak.goals.some((goal) => goal.includes('missing')));
  assert.equal(weak.tier, 'stone');
  const ready = upgradePlan({
    inventory: { netherite_sword: 1, diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1, shield: 1, totem_of_undying: 1, golden_apple: 3 },
    meta: { netherite_sword: { enchantments: { sharpness: 5 } } }
  });
  assert.equal(ready.next, null, JSON.stringify(ready.goals));
  assert.equal(ready.objectives.every((objective) => objective.ok), true);
  const mace = evaluateWeapons({ inventory: { mace: 1 }, meta: { mace: { enchantments: { density: 5, breach: 4 } } } });
  assert.ok(mace[0].effectiveDamage > 6, 'mace density and breach are scored');
});


test('ranged profiles use a bow at distance and creepers are hit-and-run, never chased to a standstill', async () => {
  const { bot, world } = flatBot(NAMES[4], { bow: 1, arrow: 16, diamond_sword: 1 });
  const controller = new CombatController({ bot });
  world.addMob('skeleton', { x: 8, y: 64, z: 0 });
  const ranged = await controller.engage({ maxAttacks: 8 });
  assert.equal(ranged.targetDefeated, true, JSON.stringify(ranged.results));
  assert.equal(bot.heldItem, 'bow');
  assert.ok(bot.countItem('arrow') < 16, 'real arrows were consumed');

  const second = flatBot(NAMES[4], { diamond_sword: 1 });
  const melee = new CombatController({ bot: second.bot });
  second.world.addMob('creeper', { x: 5, y: 64, z: 0 });
  const creeper = await melee.engage({ maxAttacks: 8 });
  assert.equal(creeper.targetDefeated, true, JSON.stringify(creeper.results));
  assert.ok(creeper.results.some((entry) => entry.reason === 'creeper hit-and-run'));
  assert.ok(second.bot.health >= 10, 'the bot backs out of blast range');
});


test('pre-fight potion buffs are consumed from the real inventory and raise damage', async () => {
  const { bot, world } = flatBot(NAMES[3], { iron_sword: 1, potion_of_strength: 1 });
  const controller = new CombatController({ bot });
  world.addMob('zombie', { x: 3, y: 64, z: 0 });
  const result = await controller.engage({ maxAttacks: 5 });
  assert.equal(result.targetDefeated, true, JSON.stringify(result.results));
  assert.equal(bot.countItem('potion_of_strength'), 0);
  assert.ok(bot.effects.strength, 'strength effect is active');
  assert.equal(controller.stats.potions, 1);
  assert.ok(controller.stats.damageDealt >= 27, `expected strength damage, got ${controller.stats.damageDealt}`);
});


test('live adapter maps equipped armour, offhand, potions and nearby entities into the combat contract', () => {
  const fake = {
    inventory: {
      items: () => [
        { name: 'diamond_sword', count: 1, enchants: [], durabilityUsed: 1, maxDurability: 1561 },
        { name: 'potion', count: 2, nbt: { value: { Potion: { value: 'strong_healing' } } } }
      ],
      slots: {
        5: { name: 'diamond_helmet', count: 1 },
        45: { name: 'totem_of_undying', count: 1 }
      }
    },
    heldItem: null,
    entities: {
      1: { id: 1, name: 'zombie', type: 'hostile', position: { x: 2, y: 64, z: 0 }, health: 20 },
      2: { id: 2, name: 'EnemyOne', username: 'EnemyOne', type: 'player', position: { x: 4, y: 64, z: 0 } }
    },
    entity: { position: { x: 0, y: 64, z: 0 } },
    time: { timeOfDay: 1000, day: 1 }
  };
  const real = new RealBot({ name: '______', createBot: () => fake });
  real.bot = fake;
  real.position = { x: 0, y: 64, z: 0 };
  real._syncInventory();
  assert.equal(real.countItem('diamond_helmet'), 1, 'equipped armour is owned');
  assert.equal(real.countItem('totem_of_undying'), 1, 'offhand totem is owned');
  assert.equal(real.countItem('potion_of_strong_healing'), 2, 'potion type comes from NBT');
  assert.equal(real.getOffhand(), 'totem_of_undying');
  assert.equal(real._findItem('potion_of_strong_healing').name, 'potion');
  const near = real.entitiesNear(8);
  assert.equal(near.length, 2);
  assert.equal(near.find((entity) => entity.username === 'EnemyOne').name, 'EnemyOne');
  assert.equal(near.find((entity) => entity.name === 'zombie').hostile, true);
});
