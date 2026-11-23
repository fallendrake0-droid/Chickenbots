'use strict';

const fs = require('fs');
const path = require('path');
const { CommandRegistry, CommandError } = require('./registry');
const { config, BOT_NAMES } = require('../config');
const { SchematicLibrary } = require('../schematics/library');
const { SchematicBuilder } = require('../builder/builder');
const { validateLibrary, formatValidationReport } = require('../schematics/validate');
const { toSpongeSchematic, toLegacySchematic, toJSON, fromSpongeSchematic, fromJSON } = require('../schematics/format');
const { statusSnapshot } = require('../runtimeState');

const TASK_TYPES = new Set([
  'CHOP_WOOD', 'MINE_ORE', 'MINE_BLOCK', 'FARM_CROP', 'FARM_ANIMAL', 'BUILD_BLOCK', 'BUILD_PHASE', 'EXCAVATE_REGION',
  'FIND_SITE', 'EXPLORE', 'STORE_ITEMS', 'TRANSFER_ITEMS', 'PLACE_BED', 'COMBAT_GUARD', 'DEFEND',
  'FISH', 'CRAFT', 'SMELT', 'RETURN_HOME'
]);

function intArg(value, name, { min = -300000, max = 300000 } = {}) {
  if (value === undefined) throw new CommandError(`missing ${name}`);
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new CommandError(`${name} must be an integer (got ${value})`);
  if (n < min || n > max) throw new CommandError(`${name} out of range (${min}..${max})`);
  return n;
}

function numArg(value, name, { min = 0, max = 100000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new CommandError(`${name} must be a number`);
  if (n < min || n > max) throw new CommandError(`${name} out of range (${min}..${max})`);
  return n;
}

function parseOrigin(args, start = 0) {
  return { x: intArg(args[start], 'x'), y: intArg(args[start + 1], 'y', { min: -64, max: 320 }), z: intArg(args[start + 2], 'z') };
}

function pickBot(services, name = null) {
  if (name) {
    const bot = services.bots.get(name);
    if (!bot) throw new CommandError(`unknown bot ${name}; roster: ${BOT_NAMES.join(', ')}`);
    return bot;
  }
  const leader = services.coordinator ? services.coordinator.leader : null;
  const bot = (leader && services.bots.get(leader)) || services.bots.values().next().value;
  if (!bot) throw new CommandError('no bots available');
  return bot;
}

function actionsFor(services, name) {
  if (!services.actions) throw new CommandError('action layer unavailable');
  const actions = services.actions.get(name);
  if (!actions) throw new CommandError(`no actions registered for ${name}`);
  return actions;
}

function allActions(services) {
  if (!services.actions) throw new CommandError('action layer unavailable');
  return services.actions.list();
}

function isBotName(services, value) {
  return Boolean(value) && Boolean(services.bots && services.bots.has(String(value)));
}

function targetActions(services, target) {
  const value = String(target || '').toLowerCase();
  if (!value || value === 'all' || value === 'fleet' || value === 'team') return allActions(services);
  return [actionsFor(services, pickBot(services, value).name)];
}

function requireCity(services) { return services; }

const SURVIVAL_FEATURES = ['eat', 'healing', 'armour', 'tools', 'crafting', 'shield'];
const ORE_ALIASES = {
  coal: 'coal', copper: 'copper', iron: 'iron', gold: 'gold', redstone: 'redstone',
  lapis: 'lapis', diamond: 'diamond', diamonds: 'diamond', emerald: 'emerald', emeralds: 'emerald'
};
const MINE_BLOCK_TARGETS = new Set(['stone', 'cobblestone', 'deepslate', 'dirt', 'sand', 'gravel']);

function normalizeOre(value) {
  if (!value) return null;
  const key = String(value).toLowerCase();
  return ORE_ALIASES[key] || key;
}

function orchestrateSurvival(services, target, feature, enabled) {
  const list = targetActions(services, target);
  if (!feature) {
    return { ok: true, features: SURVIVAL_FEATURES, routines: list.map((actions) => ({ bot: actions.bot.name, features: { ...actions.survival.features } })) };
  }
  if (!SURVIVAL_FEATURES.includes(feature)) throw new CommandError(`unknown survival routine '${feature}'; available: ${SURVIVAL_FEATURES.join(', ')}`);
  const results = list.map((actions) => actions.survival.setFeature(feature, enabled));
  return { ok: results.every((result) => result.ok), feature, enabled, results };
}

function findBuild(services, id) {
  if (!services.builders) return null;
  if (!id) return [...services.builders.values()].slice(-1)[0] || null;
  return services.builders.get(id) || [...services.builders.values()].find((builder) => String(builder.id).startsWith(String(id))) || null;
}

async function moveTeam(services, mode) {
  const coordinator = services.coordinator;
  if (!coordinator) throw new CommandError('no team coordinator');
  coordinator.setFormation(mode);
  const leaderName = coordinator.leader;
  const leader = leaderName && services.bots.get(leaderName);
  if (!leader) throw new CommandError('no elected leader');
  const anchors = coordinator.formationSlots().slots || [];
  const results = await Promise.all([...services.bots.values()].map(async (bot) => {
    const slot = anchors.find((entry) => entry.name === bot.name);
    const target = slot && slot.position ? { x: slot.position.x, y: leader.position.y, z: slot.position.z } : { ...leader.position };
    if (bot.name === leaderName) return { bot: bot.name, ok: true, leader: true };
    const result = await bot.goTo(target, { range: 3, timeoutMs: 15000 });
    return { bot: bot.name, ok: result.ok !== false, position: { ...bot.position }, target, error: result.error };
  }));
  return { ok: results.every((result) => result.ok), formation: mode, leader: leaderName, results };
}

function resolveDesign(services, query) {
  const library = services.library;
  if (!library || !library.loaded) throw new CommandError('schematic library is not generated; run npm run schematics:generate');
  if (library.get(query)) return library.get(query);
  const byNumber = library.manifest.designs.find((d) => String(d.number) === String(query));
  if (byNumber) return byNumber;
  if (/^\d+$/.test(query)) {
    const n = Number(query);
    const range = library.manifest.designs.find((d) => d.number === n);
    if (range) return range;
  }
  const matches = library.list({ q: query, limit: 5 });
  if (matches.length === 1) return library.get(matches[0].id);
  if (!matches.length) throw new CommandError(`no schematic matches '${query}'`);
  throw new CommandError(`ambiguous schematic '${query}': ${matches.map((m) => m.id).join(', ')}`);
}

function formatCheck(checks) {
  return checks.map((c) => ({ name: c.name, ok: Boolean(c.ok), detail: c.detail }));
}

async function buildDesign(services, design, { origin = null, confirm = false, run = false, runSteps = 30, kind = 'build' } = {}) {
  if (!services.world) throw new CommandError('no world available');
  const bots = [...services.bots.values()];
  if (!bots.length) throw new CommandError('no bots connected');
  const schematic = services.library.build(design.id);
  let buildOrigin = origin;
  if (!buildOrigin) {
    const base = services.runtime && services.runtime.home ? services.runtime.home : bots[0].position;
    buildOrigin = { x: Math.floor(base.x) + 4, y: Math.floor(base.y) + 1, z: Math.floor(base.z) + 4 };
  }
  const builder = new SchematicBuilder({
    schematic, origin: buildOrigin, world: services.world, bots,
    taskBoard: services.taskBoard, ledger: services.ledger, memory: services.memory,
    logger: services.logger, buildId: `${kind === 'home' ? 'home' : 'build'}-${design.id}-${Date.now().toString(36)}`
  });
  const started = builder.start({ confirm });
  if (!started.ok) return { ok: false, error: started.error, buildId: builder.id, analysis: builder.analyze(), needsConfirmation: started.needsConfirmation, conflicts: started.conflicts };
  services.builders.set(builder.id, builder);
  if (services.actions) for (const actions of services.actions.list()) actions.builders.set(builder.id, builder);
  let execution = null;
  if (run) {
    execution = await builder.run({ maxIterations: runSteps });
  }
  return {
    ok: true, buildId: builder.id, design: { id: design.id, name: design.name, tier: design.tier },
    origin: buildOrigin, tasks: started.tasks, analysis: builder.analyze(), execution, status: builder.status()
  };
}

function registerAll(services, registry) {
  registry.register({
    name: 'help', category: 'core', summary: 'List commands or show detailed help', usage: 'help [command]',
    execute: async (args) => (args.length ? registry.help(args[0]) : registry.help())
  });

  registry.register({
    name: 'status', aliases: ['state'], category: 'core', summary: 'Full team, task, ledger and connection snapshot', usage: 'status',
    execute: async () => {
      const bots = [...services.bots.values()].map((b) => (b.summary ? b.summary() : { name: b.name }));
      const library = services.library && services.library.loaded ? services.library.stats() : null;
      return {
        ok: true,
        bots,
        team: services.coordinator ? services.coordinator.getState() : null,
        tasks: services.taskBoard ? services.taskBoard.stats() : null,
        ledger: services.ledger ? services.ledger.summary() : null,
        excavations: services.excavation ? services.excavation.status() : null,
        builds: [...(services.builders ? services.builders.values() : [])].map((b) => b.status()),
        library: library ? { count: library.count, unique: library.uniqueGeometry, minimum: library.minimumRequired } : null,
        autonomy: services.runtime ? services.runtime.state() : null,
        ai: { enabled: false, mode: 'deterministic' }
      };
    }
  });

  registry.register({
    name: 'diagnostics', aliases: ['diag'], category: 'core', summary: 'Run real self-checks over config, library, team and dashboard', usage: 'diagnostics',
    execute: async () => {
      const checks = [];
      checks.push({ name: 'roster', ok: JSON.stringify(config.team.names) === JSON.stringify(BOT_NAMES) && config.team.names.length === 5, detail: config.team.names.join(', ') });
      checks.push({ name: 'server-default', ok: config.server.host === 'cr3xlol.aternos.me' && config.server.port === 55742 && config.server.version === 'auto', detail: `${config.server.host}:${config.server.port} (${config.server.version})` });
      checks.push({ name: 'pvp-disabled', ok: config.autonomy.pvp === false, detail: String(config.autonomy.pvp) });
      checks.push({ name: 'ai-disabled', ok: config.autonomy.ai.enabled === false, detail: 'deterministic local intelligence' });
      checks.push({ name: 'dashboard-sandbox-bind', ok: config.dashboard.host === '0.0.0.0', detail: `${config.dashboard.host}:${config.dashboard.port}` });
      const library = services.library;
      checks.push({ name: 'schematic-library', ok: Boolean(library && library.loaded && library.count >= config.schematics.minimumCount), detail: library && library.loaded ? `${library.count} designs` : 'not generated' });
      if (library && library.loaded) {
        const hashes = new Set(library.manifest.designs.map((d) => d.geometryHash));
        checks.push({ name: 'schematic-uniqueness', ok: hashes.size === library.count, detail: `${hashes.size}/${library.count} unique geometry hashes` });
      }
      checks.push({ name: 'bots-configured', ok: services.bots.size === 5, detail: `${services.bots.size} bots loaded` });
      const taskBoard = services.taskBoard;
      checks.push({ name: 'task-board', ok: Boolean(taskBoard), detail: taskBoard ? `${taskBoard.tasks.size} tasks` : 'missing' });
      const ledger = services.ledger;
      checks.push({ name: 'resource-ledger', ok: Boolean(ledger), detail: ledger ? `${ledger.inventories.size} inventories` : 'missing' });
      const connected = [...services.bots.values()].every((b) => b.connected && b.spawned);
      checks.push({ name: 'connection-gate', ok: Boolean(services.runtime && services.runtime.state().autonomyAllowed) === connected, detail: `connected=${connected}` });
      checks.push({ name: 'schematics-on-disk', ok: fs.existsSync(config.paths.schematicData), detail: config.paths.schematicData });
      const passed = checks.filter((c) => c.ok).length;
      return { ok: passed === checks.length, checks: formatCheck(checks), passed, total: checks.length };
    }
  });

  registry.register({
    name: 'ai', category: 'core', summary: 'AI integration status (disabled by default)', usage: 'ai [status|off]',
    execute: async (args) => {
      const sub = (args[0] || 'status').toLowerCase();
      if (sub === 'status') return { ok: true, enabled: false, provider: null, mode: 'deterministic', note: 'All decisions are local and deterministic; no API keys are used.' };
      if (sub === 'off') return { ok: true, enabled: false, message: 'AI hook is already disabled.' };
      if (sub === 'on' || sub === 'enable') {
        return { ok: false, error: 'The optional AI hook is not implemented and must stay disabled; deterministic mode is authoritative.' };
      }
      return { ok: false, error: `unknown ai subcommand '${sub}'` };
    }
  });

  registry.register({
    name: 'team', category: 'team', summary: 'Inspect team state and control formations, resources and coordination', usage: 'team [state|on|off|follow|regroup|retreat|defend|memory|locks|tasks|roles|leader|resources|objectives|reassign|formation <name>]',
    execute: async (args) => {
      const sub = (args[0] || 'state').toLowerCase();
      const coordinator = services.coordinator;
      if (!coordinator) return { ok: false, error: 'no coordinator' };
      if (sub === 'state' || sub === 'status') return { ok: true, state: coordinator.getState(), enabled: coordinator.enabled, formation: coordinator.formation };
      if (sub === 'leader') return { ok: true, leader: coordinator.leader, election: services.leadership ? services.leadership.status() : null };
      if (sub === 'on' || sub === 'off') return { ok: true, ...coordinator.setEnabled(sub === 'on') };
      if (sub === 'memory') {
        const type = args[1] ? args[1].toUpperCase() : null;
        const observations = services.memory.query(type ? { type } : {}).slice(0, 50);
        return { ok: true, observations, stats: services.memory.stats, facts: [...services.memory.facts.entries()].map(([key, value]) => ({ key, value })) };
      }
      if (sub === 'locks') {
        return { ok: true, locks: [...services.taskBoard.locks.values()], regions: [...services.taskBoard.regions.values()], deadlocks: services.taskBoard.detectDeadlocks() };
      }
      if (sub === 'tasks') {
        const status = args[1] ? args[1].toUpperCase() : null;
        return { ok: true, tasks: services.taskBoard.listTasks(status ? { status } : {}).slice(-60), stats: services.taskBoard.stats() };
      }
      if (sub === 'roles') return { ok: true, roles: Object.fromEntries(coordinator.roles), assignments: Object.fromEntries(coordinator.assignments) };
      if (sub === 'resources') return { ok: true, resources: services.ledger ? services.ledger.snapshot() : null, reserves: config.reserves };
      if (sub === 'objectives') return { ok: true, objectives: coordinator.objectiveBoard(), active: services.taskBoard.listObjectives('ACTIVE').length };
      if (sub === 'formation') {
        if (!args[1]) return { ok: true, formation: coordinator.formation };
        const formation = coordinator.setFormation(args[1]);
        return { ok: true, formation };
      }
      if (sub === 'follow' || sub === 'regroup') {
        const mode = sub === 'follow' ? 'FOLLOW' : 'REGROUP';
        return { ok: true, action: sub, ...(await moveTeam(services, mode)) };
      }
      if (sub === 'retreat') {
        coordinator.setFormation('RETREAT');
        if (!services.runtime) return { ok: false, error: 'no runtime home' };
        const results = await Promise.all([...services.bots.values()].map(async (bot) => {
          const result = await bot.goTo(services.runtime.home, { range: 3, timeoutMs: 20000 });
          return { bot: bot.name, ok: result.ok !== false, position: { ...bot.position }, error: result.error };
        }));
        return { ok: results.every((result) => result.ok), formation: 'RETREAT', home: services.runtime.home, results };
      }
      if (sub === 'defend') {
        coordinator.setFormation('DEFENSIVE');
        const results = await Promise.all(allActions(services).map(async (actions) => ({ bot: actions.bot.name, ...(await actions.combat.defend({ maxAttacks: 8 })) })));
        return { ok: true, formation: 'DEFENSIVE', results, threats: results.reduce((sum, result) => sum + (result.action === 'retreat' ? 1 : 0), 0) };
      }
      if (sub === 'reassign') {
        let released = 0;
        for (const [name, assignment] of [...coordinator.assignments]) {
          const task = services.taskBoard.getTask(assignment.taskId);
          if (task) { services.taskBoard.release(task.id, name, 'manual team reassign'); released++; }
          coordinator.assignments.delete(name);
          coordinator.roles.set(name, 'IDLE');
        }
        return { ok: true, released, note: 'idle bots will be reallocated on the next coordinator tick' };
      }
      return { ok: false, error: `unknown team subcommand '${sub}'` };
    }
  });

  registry.register({
    name: 'bot', category: 'team', summary: 'Per-bot status, movement and action controls', usage: 'bot <name|all> <status|goto x y z|come|follow|eat|mine [ore]|chop [type]|farm [crop]|fish|defend|explore|sleep|return home|where>',
    execute: async (args) => {
      const target = String(args[0] || '').toLowerCase();
      if (target === 'all') return { ok: true, bots: [...services.bots.values()].map((b) => (b.summary ? b.summary() : { name: b.name })) };
      const bot = pickBot(services, args[0]);
      const action = (args[1] || 'status').toLowerCase();
      const actions = actionsFor(services, bot.name);
      const leader = services.coordinator ? services.bots.get(services.coordinator.leader) : null;
      if (action === 'status') return { ok: true, bot: bot.summary ? bot.summary() : { name: bot.name } };
      if (action === 'where') return { ok: true, bot: bot.name, position: { ...bot.position }, dimension: bot.dimension };
      if (action === 'goto') {
        const pos = parseOrigin(args, 2);
        const result = await bot.goTo(pos, { range: 2, timeoutMs: 30000 });
        return { ok: result.ok !== false, ...result, position: { ...bot.position } };
      }
      if (action === 'come' || action === 'follow') {
        const destination = leader && leader !== bot ? leader.position : bot.position;
        const result = await bot.goTo(destination, { range: 2, timeoutMs: 30000 });
        return { ok: result.ok !== false, ...result, position: { ...bot.position }, followed: leader ? leader.name : null };
      }
      if (action === 'return') {
        const result = await bot.goTo(services.runtime ? services.runtime.home : actions.home, { range: 3, timeoutMs: 30000 });
        return { ok: result.ok !== false, ...result, position: { ...bot.position } };
      }
      if (action === 'eat') return actions.survival.eat();
      if (action === 'mine') {
        const ore = normalizeOre(args[2]);
        if (!ore) { const result = await actions.mining.mineNearby({ radius: 24, limit: 8 }); return { ok: Boolean(result.ok), ...result, status: actions.mining.status() }; }
        if (MINE_BLOCK_TARGETS.has(ore)) {
          const result = await actions.mining.mineBlocks({ block: ore, radius: 24, limit: 8 });
          return { ok: Boolean(result.ok), ...result };
        }
        const found = actions.mining.findOres({ radius: Math.max(48, config.mining.maxSearchRadius), limit: 200 }).find((entry) => entry.name.includes(ore));
        if (!found) return { ok: false, error: `no ${args[2]} found nearby` };
        const result = await actions.mining.mineOre(found);
        return { ok: Boolean(result.ok), ...result };
      }
      if (action === 'chop') {
        const types = args.slice(2).join(' ') || null;
        const result = await actions.woodcutting.tick({ maxTrees: 2, types });
        return { ok: result.ok !== false, ...result };
      }
      if (action === 'farm') {
        const crop = args.slice(2).join(' ') || null;
        const result = crop && /animal|breed/i.test(crop) ? await actions.farming.feedAnimals() : await actions.farming.harvestAll({ crop });
        return { ok: result.ok !== false, ...result };
      }
      if (action === 'fish') {
        const result = await actions.fishing.tick({ casts: Math.min(3, Number(args[2]) || 1) });
        return { ok: result.ok !== false, ...result };
      }
      if (action === 'defend') {
        const result = await actions.combat.defend({ maxAttacks: 10 });
        return { ok: result.ok !== false, ...result };
      }
      if (action === 'explore') {
        if (String(args[2] || '').toLowerCase() === 'stop') return actions.exploration.stop();
        const steps = args[2] ? intArg(args[2], 'steps', { min: 1, max: 20 }) : 2;
        const result = await actions.exploration.explore({ steps });
        return { ok: result.ok !== false, ...result };
      }
      if (action === 'sleep') return actions.sleep.tick();
      return { ok: false, error: `unknown bot action '${action}'` };
    }
  });

  registry.register({
    name: 'inventory', aliases: ['inv'], category: 'survival', summary: 'Inventory, reserves and tool status', usage: 'inventory [bot]',
    execute: async (args) => {
      const bot = pickBot(services, args[0]);
      return { ok: true, inventory: actionsFor(services, bot.name).inventory.status() };
    }
  });

  registry.register({
    name: 'survival', category: 'survival', summary: 'Inspect or toggle automatic survival routines', usage: 'survival [bot|all] [eat|healing|armour|tools|crafting|shield] [on|off] | survival on|off',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'on' || first === 'off') {
        const enabled = first === 'on';
        const results = allActions(services).flatMap((actions) => SURVIVAL_FEATURES.map((feature) => actions.survival.setFeature(feature, enabled)));
        return { ok: results.every((result) => result.ok), enabled, features: SURVIVAL_FEATURES, results };
      }
      if (!first || first === 'status') return orchestrateSurvival(services, 'all', null, true);
      let target = 'all';
      let rest = args;
      if (isBotName(services, args[0]) || first === 'all' || first === 'fleet') {
        target = first;
        rest = args.slice(1);
      }
      const feature = String(rest[0] || '').toLowerCase();
      if (!feature) return orchestrateSurvival(services, target, null, true);
      const value = String(rest[1] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) throw new CommandError('usage: survival [bot|all] <routine> on|off');
      return orchestrateSurvival(services, target, feature, value === 'on');
    }
  });

  registry.register({
    name: 'auto', category: 'survival', summary: 'Fleet or per-bot automatic routine switches', usage: 'auto <eat|healing|armour|tools|crafting|shield> [on|off] [bot|all]',
    execute: async (args) => {
      const feature = String(args[0] || '').toLowerCase();
      if (!feature || feature === 'status') return orchestrateSurvival(services, 'all', null, true);
      const value = String(args[1] || 'on').toLowerCase();
      if (!['on', 'off'].includes(value)) throw new CommandError('usage: auto <routine> [on|off] [bot|all]');
      const target = args[2] || 'all';
      return orchestrateSurvival(services, target, feature, value === 'on');
    }
  });

  registry.register({
    name: 'eat', category: 'survival', summary: 'Eat the best available food', usage: 'eat [bot]',
    execute: async (args) => {
      const bot = pickBot(services, args[0]);
      const result = await actionsFor(services, bot.name).survival.eat();
      return { ok: result.ok !== false, ...result };
    }
  });

  registry.register({
    name: 'mine', category: 'mining', summary: 'Mine ores or stone with safety checks; stop cancels active mining', usage: 'mine [bot] [ore|stone|stop]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop') {
        const results = allActions(services).map((actions) => actions.mining.stop());
        return { ok: true, stopped: true, results };
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const requested = String(named ? args[1] || '' : args[0] || '').toLowerCase();
      const bot = pickBot(services, named);
      const actions = actionsFor(services, bot.name);
      if (requested === 'stop') return { ok: true, ...actions.mining.stop() };
      if (requested && MINE_BLOCK_TARGETS.has(requested)) {
        const result = await actions.mining.mineBlocks({ block: requested, radius: 24, limit: 8 });
        return { ok: Boolean(result.ok), ...result, status: actions.mining.status() };
      }
      if (requested) {
        const oreKey = normalizeOre(requested);
        const ore = actions.mining.findOres({ radius: Math.max(48, config.mining.maxSearchRadius), limit: 200 })
          .find((entry) => entry.name.includes(oreKey));
        if (!ore) return { ok: false, error: `no ${requested} found nearby` };
        const result = await actions.mining.mineOre(ore);
        return { ok: Boolean(result.ok), ...result, status: actions.mining.status() };
      }
      const result = await actions.mining.mineNearby({ radius: 24, limit: 8 });
      return { ok: Boolean(result.ok), ...result, status: actions.mining.status() };
    }
  });

  registry.register({
    name: 'chop', aliases: ['wood'], category: 'woodcutting', summary: 'Chop and replant trees, optionally one species; stop cancels', usage: 'chop [bot] [wood|oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove|pale_oak|stop]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop') {
        const results = allActions(services).map((actions) => actions.woodcutting.stop());
        return { ok: true, stopped: true, results };
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const rest = named ? args.slice(1) : args;
      const requested = rest.join(' ').trim().toLowerCase();
      if (requested === 'stop') return { ok: true, ...actionsFor(services, pickBot(services, named).name).woodcutting.stop() };
      const bot = pickBot(services, named);
      const result = await actionsFor(services, bot.name).woodcutting.tick({ maxTrees: 2, types: requested && requested !== 'wood' ? requested : null });
      return { ok: result.ok !== false, ...result };
    }
  });

  registry.register({
    name: 'farm', category: 'farming', summary: 'Harvest/replant crops or feed animals; stop cancels active farming', usage: 'farm [bot] [harvest|wheat|carrots|potatoes|beetroot|pumpkin|melon|animals|stop]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop') {
        const results = allActions(services).map((actions) => actions.farming.stop());
        return { ok: true, stopped: true, results };
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const rest = named ? args.slice(1) : args;
      const requested = rest.join(' ').trim().toLowerCase();
      if (requested === 'stop') return { ok: true, ...actionsFor(services, pickBot(services, named).name).farming.stop() };
      const bot = pickBot(services, named);
      const actions = actionsFor(services, bot.name);
      if (/^animals?$|^breed$/.test(requested)) {
        const result = await actions.farming.feedAnimals();
        return { ok: result.ok !== false, ...result };
      }
      const result = await actions.farming.harvestAll({ crop: requested || null });
      return { ok: result.ok !== false, ...result };
    }
  });

  registry.register({
    name: 'fish', category: 'farming', summary: 'Fish from real water with a fishing rod', usage: 'fish [bot|all] [casts] | fish stop [bot|all]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop') {
        const target = String(args[1] || '').toLowerCase();
        const targets = target === 'all' || target === 'fleet' ? allActions(services) : [actionsFor(services, pickBot(services, args[1]).name)];
        const results = targets.map((actions) => actions.fishing.stop());
        return { ok: true, stopped: results };
      }
      if (first === 'all' || first === 'fleet') {
        const casts = args[1] === undefined ? 1 : intArg(args[1], 'casts', { min: 1, max: 3 });
        const results = await Promise.all(allActions(services).map(async (actions) => ({ bot: actions.bot.name, ...(await actions.fishing.tick({ casts })) })));
        return { ok: results.some((result) => result.caught > 0), results };
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const bot = pickBot(services, named);
      const rawCasts = named ? args[1] : args[0];
      const casts = rawCasts === undefined ? 1 : intArg(rawCasts, 'casts', { min: 1, max: 3 });
      const result = await actionsFor(services, bot.name).fishing.tick({ casts });
      return { ok: result.ok !== false, ...result };
    }
  });

  registry.register({
    name: 'sleep', category: 'survival', summary: 'Reserve a bed and sleep at night; auto toggles the automatic routine', usage: 'sleep [bot|all] | sleep auto on|off',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'auto') {
        const value = String(args[1] || '').toLowerCase();
        if (!['on', 'off'].includes(value)) return { ok: true, auto: allActions(services).map((actions) => ({ bot: actions.bot.name, auto: actions.sleep.auto })) };
        const results = allActions(services).map((actions) => actions.sleep.setAuto(value === 'on'));
        return { ok: results.every((result) => result.ok), auto: value === 'on', results };
      }
      if (first === 'all' || first === 'fleet') {
        const results = await Promise.all(allActions(services).map(async (actions) => ({ bot: actions.bot.name, ...(await actions.sleep.sleep()) })));
        return { ok: results.some((result) => result.ok !== false), results };
      }
      const bot = pickBot(services, args[0]);
      const actions = actionsFor(services, bot.name);
      if (String(args[1] || '').toLowerCase() === 'auto') {
        const value = String(args[2] || '').toLowerCase();
        if (!['on', 'off'].includes(value)) return { ok: true, bot: bot.name, auto: actions.sleep.auto };
        return actions.sleep.setAuto(value === 'on');
      }
      const result = await actions.sleep.sleep();
      return { ok: result.ok !== false, ...result };
    }
  });

  registry.register({
    name: 'defend', category: 'combat', summary: 'Defend against hostile mobs (PvP stays off); stop cancels', usage: 'defend [bot] | defend stop [bot|all]',
    execute: async (args) => {
      if (String(args[0] || '').toLowerCase() === 'stop') {
        const target = String(args[1] || 'all').toLowerCase();
        const targets = target === 'all' || target === 'fleet' ? allActions(services) : [actionsFor(services, pickBot(services, args[1]).name)];
        return { ok: true, stopped: targets.map((actions) => actions.combat.stop()) };
      }
      const bot = pickBot(services, args[0]);
      const result = await actionsFor(services, bot.name).combat.defend({ maxAttacks: 10 });
      return { ok: result.ok !== false, ...result };
    }
  });

  registry.register({
    name: 'explore', category: 'exploration', summary: 'Explore the spiral and record discoveries; stop cancels', usage: 'explore [bot] [steps] | explore stop [bot|all]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop') {
        const target = String(args[1] || 'all').toLowerCase();
        const targets = target === 'all' || target === 'fleet' ? allActions(services) : [actionsFor(services, pickBot(services, args[1]).name)];
        return { ok: true, stopped: targets.map((actions) => actions.exploration.stop()) };
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const bot = pickBot(services, named);
      const rawSteps = named ? args[1] : args[0];
      const steps = rawSteps === undefined ? 4 : intArg(rawSteps, 'steps', { min: 1, max: 20 });
      const result = await actionsFor(services, bot.name).exploration.explore({ steps });
      return { ok: result.ok !== false, ...result };
    }
  });

  registry.register({
    name: 'find', category: 'exploration', summary: 'Search nearby blocks for structures, caves, forests or ores', usage: 'find <village|mineshaft|temple|ruin|forest|cave|diamonds|emeralds|iron> [bot]',
    execute: async (args) => {
      const kind = String(args[0] || '').toLowerCase();
      if (!kind) throw new CommandError('usage: find <village|mineshaft|temple|ruin|forest|cave|diamonds|emeralds|iron> [bot]');
      const bot = pickBot(services, args[1]);
      const actions = actionsFor(services, bot.name);
      if (kind === 'forest') {
        const trees = actions.woodcutting.findTrees({ radius: 48, limit: 20 });
        return { ok: true, kind, found: trees.length > 0, trees, count: trees.length };
      }
      if (kind === 'cave') {
        const caves = actions.mining.caveScan({ radius: 24 });
        return { ok: true, kind, found: caves.length > 0, caves: caves.slice(0, 20), count: caves.length };
      }
      if (['diamonds', 'diamond', 'emeralds', 'emerald', 'iron', 'gold', 'coal', 'copper', 'redstone', 'lapis'].includes(kind)) {
        const ore = normalizeOre(kind);
        const found = actions.mining.findOres({ radius: 64, limit: 200 }).filter((entry) => entry.name.includes(ore));
        return { ok: true, kind: ore, found: found.length > 0, ores: found.slice(0, 20), count: found.length };
      }
      const clue = actions.exploration.findClue(kind, { radius: 48 });
      return { ok: clue.ok !== false, ...clue };
    }
  });

  registry.register({
    name: 'return', category: 'exploration', summary: 'Navigate one bot or the whole fleet back to the team home', usage: 'return home [bot|all]',
    execute: async (args) => {
      if (String(args[0] || 'home').toLowerCase() !== 'home') throw new CommandError('usage: return home [bot|all]');
      if (!services.runtime) return { ok: false, error: 'no runtime home' };
      const target = args[1] || 'all';
      const list = targetActions(services, target);
      const results = await Promise.all(list.map(async (actions) => {
        const result = await actions.bot.goTo(services.runtime.home, { range: 3, timeoutMs: 30000 });
        return { bot: actions.bot.name, ok: result.ok !== false, position: { ...actions.bot.position }, error: result.error };
      }));
      return { ok: results.every((result) => result.ok), home: services.runtime.home, results };
    }
  });

  registry.register({
    name: 'task', category: 'task', summary: 'Task manager: list, add, assign, cancel, retry, objectives', usage: 'task <list|add|assign|priority|cancel|retry|info|objective> ...',
    execute: async (args) => {
      const sub = (args[0] || 'list').toLowerCase();
      if (sub === 'list') {
        const status = args[1] ? args[1].toUpperCase() : null;
        return { ok: true, tasks: services.taskBoard.listTasks(status ? { status } : {}).slice(-80), stats: services.taskBoard.stats() };
      }
      if (sub === 'info') {
        const task = services.taskBoard.getTask(args[1]);
        return task ? { ok: true, task } : { ok: false, error: 'unknown task' };
      }
      if (sub === 'add') {
        const type = String(args[1] || '').toUpperCase();
        if (!TASK_TYPES.has(type)) throw new CommandError(`invalid task type '${type}'`);
        const label = args.slice(2).join(' ') || type;
        const result = services.taskBoard.addTask({ type, label, priority: 50 });
        return { ok: true, task: result.task };
      }
      if (sub === 'assign') {
        const task = services.taskBoard.getTask(args[1]);
        if (!task) return { ok: false, error: 'unknown task' };
        const bot = pickBot(services, args[2]);
        const claim = services.taskBoard.claim(task.id, bot.name, { force: true });
        if (!claim.ok) return { ok: false, error: claim.error };
        if (services.coordinator) services.coordinator.assignTask(bot.name, task.id);
        return { ok: true, task: claim.task, assignedTo: bot.name };
      }
      if (sub === 'cancel') {
        const result = services.taskBoard.cancel(args[1], 'cancelled by operator');
        return { ok: result.ok !== false, ...result };
      }
      if (sub === 'priority') {
        const task = services.taskBoard.getTask(args[1]);
        if (!task) return { ok: false, error: 'unknown task' };
        const priority = Number(args[2]);
        if (!Number.isFinite(priority) || priority < 0 || priority > 100) {
          throw new CommandError('priority must be a number between 0 and 100');
        }
        task.priority = Math.round(priority);
        return { ok: true, task };
      }
      if (sub === 'retry') {
        const task = services.taskBoard.getTask(args[1]);
        if (!task) return { ok: false, error: 'unknown task' };
        task.status = 'PENDING';
        task.claimedBy = null;
        task.lastError = null;
        return { ok: true, task };
      }
      if (sub === 'objective') {
        const title = args.slice(1).join(' ').trim();
        if (!title) throw new CommandError('objective title is required');
        const objective = services.taskBoard.createObjective({ title, description: 'Created from the dashboard task board.', priority: 50 });
        return { ok: true, objective };
      }
      return { ok: false, error: `unknown task subcommand '${sub}'` };
    }
  });

  registerExcavation(registry, services);
  registerBuild(registry, services);
  registerSchematics(registry, services);

  registry.register({
    name: 'pause', category: 'core', summary: 'Pause autonomous actions', usage: 'pause',
    execute: async () => {
      if (!services.runtime) return { ok: false, error: 'no runtime' };
      return services.runtime.pause();
    }
  });

  registry.register({
    name: 'resume', category: 'core', summary: 'Resume autonomous actions', usage: 'resume',
    execute: async () => {
      if (!services.runtime) return { ok: false, error: 'no runtime' };
      return services.runtime.resume();
    }
  });

  registry.register({
    name: 'stop', aliases: ['shutdown'], category: 'core', summary: 'Stop autonomy and disconnect the team', usage: 'stop',
    dangerous: true,
    execute: async () => {
      if (!services.runtime) return { ok: false, error: 'no runtime' };
      return services.runtime.shutdown('stopped by operator');
    }
  });
}

function registerExcavation(registry, services) {
  const excavation = () => {
    if (!services.excavation) throw new CommandError('excavation manager unavailable');
    return services.excavation;
  };
  registry.register({
    name: 'excavate', aliases: ['dig'], category: 'excavation',
    summary: 'Preview and execute protected excavations', usage: 'excavate <preview|start|status|pause|resume|stop|undo-preview|assign|team> ...',
    minArgs: 1,
    execute: async (args, ctx) => {
      const sub = args[0].toLowerCase();
      const manager = excavation();
      const bot = services.bots.values().next().value;
      if (sub === 'preview') {
        const kind = (args[1] || 'box').toLowerCase();
        const authorized = args.includes('authorized');
        const rest = args.slice(2).filter((a) => a !== 'authorized');
        let opts = { authorized };
        if (kind === 'box' || kind === 'at' || kind === 'quarry') {
          opts = { ...opts, mode: kind === 'quarry' ? 'QUARRY' : kind === 'at' ? 'AT' : 'BOX', origin: parseOrigin(rest, 0) };
          opts.width = intArg(rest[3], 'width', { min: 1, max: 128 });
          opts.length = intArg(rest[4], 'length', { min: 1, max: 128 });
          opts.depth = intArg(rest[5] === undefined ? 4 : rest[5], 'depth', { min: 1, max: 120 });
        } else if (kind === 'radius') {
          opts = { ...opts, mode: 'RADIUS', origin: parseOrigin(rest, 0) };
          opts.radius = intArg(rest[3], 'radius', { min: 1, max: 64 });
          opts.depth = intArg(rest[4] === undefined ? 4 : rest[4], 'depth', { min: 1, max: 120 });
        } else if (kind === 'trench') {
          opts = { ...opts, mode: 'TRENCH', origin: parseOrigin(rest, 0) };
          opts.length = intArg(rest[3], 'length', { min: 1, max: 128 });
          opts.width = intArg(rest[4] === undefined ? 3 : rest[4], 'width', { min: 1, max: 16 });
          opts.depth = intArg(rest[5] === undefined ? 3 : rest[5], 'depth', { min: 1, max: 120 });
        } else if (kind === 'flatten') {
          opts = { ...opts, mode: 'FLATTEN', origin: parseOrigin(rest, 0) };
          opts.width = intArg(rest[3], 'width', { min: 1, max: 128 });
          opts.length = intArg(rest[4], 'length', { min: 1, max: 128 });
        } else if (kind === 'foundation') {
          const design = resolveDesign(services, rest[0]);
          const schematic = services.library.build(design.id);
          opts = { ...opts, mode: 'FOUNDATION', schematic, origin: parseOrigin(rest, 1) };
        } else {
          return { ok: false, error: `unknown preview kind '${kind}'` };
        }
        if (bot) opts.bot = bot.name;
        const result = manager.preview(opts);
        if (!result.ok) return result;
        return {
          ok: true, previewId: result.previewId, text: result.text,
          plan: {
            id: result.plan.previewId, mode: result.plan.mode, bounds: result.plan.bounds,
            volume: result.plan.volume, regions: result.plan.regions ? result.plan.regions.length : 0,
            warnings: result.plan.warnings || [], authorizationRequired: Boolean(result.plan.authorizationRequired)
          }
        };
      }
      if (sub === 'start') {
        if (!ctx.confirmed) return { ok: false, error: "excavation is destructive and requires explicit confirmation (append 'confirm')", code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
        const previewId = args[1] && !args[1].includes('authorized') ? args[1] : null;
        const authorized = args.includes('authorized');
        const team = args.includes('team');
        if (previewId && !manager.previews.has(previewId)) return { ok: false, error: `unknown preview ${previewId}; run 'excavate preview' first` };
        const result = manager.start({ previewId, confirm: true, authorized, team });
        if (!result.ok) return result;
        return {
          ok: true, excavation: result.excavation ? { id: result.excavation.id, state: result.excavation.state, tasks: result.excavation.tasks?.length } : null,
          text: result.text, assignments: result.assignments || result.excavation?.assignments || null
        };
      }
      if (sub === 'status') return { ok: true, status: manager.status(args[1] || null) };
      if (sub === 'pause') return { ok: true, ...manager.pause(args[1] || null) };
      if (sub === 'resume') return { ok: true, ...manager.resume(args[1] || null) };
      if (sub === 'stop') {
        const targetId = args[1] || null;
        return { ok: true, ...manager.stop(targetId, 'stopped by operator') };
      }
      if (sub === 'undo-preview') return { ok: true, ...manager.undoPreview(args[1] || null) };
      if (sub === 'assign') {
        const target = args[1] ? pickBot(services, args[1]) : pickBot(services, null);
        return { ok: true, ...manager.assign(target.name, args[2] || null) };
      }
      if (sub === 'team') {
        const status = manager.status(args[1] || null);
        return { ok: true, excavation: status };
      }
      return { ok: false, error: `unknown excavate subcommand '${sub}'` };
    }
  });
}

function registerBuild(registry, services) {
  const previewFor = (design, origin = null) => {
    if (!services.world) throw new CommandError('no world available');
    const bots = [...services.bots.values()];
    if (!bots.length) throw new CommandError('no bots connected');
    const schematic = services.library.build(design.id);
    const base = origin || (services.runtime && services.runtime.home ? services.runtime.home : bots[0].position);
    const buildOrigin = origin || { x: Math.floor(base.x) + 4, y: Math.floor(base.y) + 1, z: Math.floor(base.z) + 4 };
    const builder = new SchematicBuilder({
      schematic, origin: buildOrigin, world: services.world, bots,
      taskBoard: services.taskBoard, ledger: services.ledger, memory: services.memory, logger: services.logger
    });
    return { design, builder, origin: buildOrigin, analysis: builder.analyze() };
  };

  registry.register({
    name: 'build', category: 'builder', summary: 'Select, preview, start and control validated schematic builds', usage: 'build select <id> | build preview [id] [x y z] | build start [run] | build status|list|pause|resume|stop|run [id] [steps] | build <id> [x y z] [run]',
    dangerous: true,
    execute: async (args, ctx) => {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'status') {
        if (!services.builders) return { ok: false, error: 'no builder registry' };
        const builder = findBuild(services, args[1]);
        if (args[1]) return builder ? { ok: true, status: builder.status(), verification: builder.verify() } : { ok: false, error: 'unknown build' };
        return { ok: true, builds: [...services.builders.values()].map((b) => b.status()) };
      }
      if (sub === 'list') {
        return { ok: true, builds: [...(services.builders || new Map()).values()].map((b) => ({ id: b.id, name: b.schematic.name, state: b.status().state, percent: b.status().percentComplete })) };
      }
      if (sub === 'select') {
        if (!args[1]) throw new CommandError('usage: build select <designId|number|query>');
        const design = resolveDesign(services, args[1]);
        services.selectedBuild = design.id;
        return { ok: true, selected: { id: design.id, name: design.name, tier: design.tier, dimensions: design.dimensions, difficulty: design.difficulty } };
      }
      if (sub === 'preview') {
        const design = args[1] ? resolveDesign(services, args[1]) : (services.selectedBuild ? resolveDesign(services, services.selectedBuild) : null);
        if (!design) throw new CommandError('no design selected; use build select <id> or build preview <id>');
        const origin = args[2] !== undefined ? parseOrigin(args, 2) : null;
        const preview = previewFor(design, origin);
        return {
          ok: true, preview: true, design: { id: design.id, name: design.name, tier: design.tier },
          origin: preview.origin, analysis: preview.analysis, status: preview.builder.status()
        };
      }
      if (sub === 'pause' || sub === 'resume') {
        const builder = findBuild(services, args[1]);
        if (!builder) return { ok: false, error: 'no active build' };
        return sub === 'pause' ? builder.pause('paused by operator') : builder.resume();
      }
      if (sub === 'stop') {
        const builder = findBuild(services, args[1]);
        if (!builder) return { ok: false, error: 'no active build' };
        return { ok: true, status: builder.cancel('stopped by operator') };
      }
      if (sub === 'run') {
        const builder = findBuild(services, args[1]);
        if (!builder) return { ok: false, error: 'no active build' };
        const result = await builder.run({ maxIterations: args[2] ? intArg(args[2], 'steps', { min: 1, max: 500 }) : 40 });
        return { ok: result.status.state !== 'FAILED', ...result };
      }
      if (sub === 'start' && (!args[1] || String(args[1]).toLowerCase() === 'run')) {
        if (!services.selectedBuild) throw new CommandError('no design selected; use build select <id>');
        if (!ctx.confirmed) return { ok: false, error: "starting a build is destructive and requires explicit confirmation (append 'confirm')", code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
        const result = await buildDesign(services, resolveDesign(services, services.selectedBuild), { confirm: true, run: args.includes('run') });
        if (result.ok) services.selectedBuild = null;
        return result;
      }
      if (sub === 'start') {
        if (!ctx.confirmed) return { ok: false, error: "starting a build is destructive and requires explicit confirmation (append 'confirm')", code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
        const result = await buildDesign(services, resolveDesign(services, args[1]), { confirm: true, run: args.includes('run') });
        return result;
      }
      if (!ctx.confirmed) return { ok: false, error: "starting a build is destructive and requires explicit confirmation (append 'confirm')", code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
      const design = resolveDesign(services, args[0]);
      let origin = null;
      if (args[1] && args[1].toLowerCase() !== 'run') origin = parseOrigin(args, 1);
      const run = args.includes('run');
      const result = await buildDesign(services, design, { origin, confirm: true, run });
      return result;
    }
  });

  registry.register({
    name: 'home', category: 'builder', summary: 'Set/read the team home and build a home base', usage: 'home set x y z | home status | home build [tier] [run]',
    execute: async (args, ctx) => {
      const sub = (args[0] || 'status').toLowerCase();
      if (sub === 'set') {
        const pos = parseOrigin(args, 1);
        if (!services.runtime) return { ok: false, error: 'no runtime' };
        const changed = services.runtime.setHome(pos);
        return { ok: true, home: changed.home };
      }
      if (sub === 'status') return { ok: true, home: services.runtime ? services.runtime.home : null, actions: [...(services.actions ? services.actions.list() : [])].map((a) => a.homeBase.status()) };
      if (sub === 'build') {
        if (!ctx.confirmed) return { ok: false, error: "building a home base requires explicit confirmation (append 'confirm')", code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
        const tier = args[1] || 'Novice';
        const designs = services.library.list({ tier, limit: 1 });
        if (!designs.length) return { ok: false, error: `no designs for tier ${tier}` };
        const origin = services.runtime && services.runtime.home ? services.runtime.home : null;
        const result = await buildDesign(services, services.library.get(designs[0].id), {
          origin: origin ? { x: origin.x + 6, y: origin.y + 1, z: origin.z + 6 } : null,
          confirm: true, run: args.includes('run'), kind: 'home'
        });
        return { ...result, tier };
      }
      return { ok: false, error: `unknown home subcommand '${sub}'` };
    }
  });
}

function registerSchematics(registry, services) {
  const library = () => {
    if (!services.library || !services.library.loaded) throw new CommandError('schematic library is not generated; run npm run schematics:generate');
    return services.library;
  };
  registry.register({
    name: 'schematics', aliases: ['schem'], category: 'schematics',
    summary: 'Browse, inspect, validate, export and import schematics', usage: 'schematics <list|search|info|stats|validate|export|import> ...',
    execute: async (args) => {
      const sub = (args[0] || 'stats').toLowerCase();
      if (sub === 'list') {
        return { ok: true, designs: library().list({ tier: args[1] || null, limit: args[2] ? intArg(args[2], 'limit', { min: 1, max: 200 }) : 40 }) };
      }
      if (sub === 'search') {
        if (!args[1]) return { ok: false, error: 'search requires a query' };
        return { ok: true, designs: library().search(args.slice(1).join(' '), 30) };
      }
      if (sub === 'info') {
        const design = resolveDesign(services, args[1]);
        return { ok: true, design, materials: Object.entries(design.materials).sort((a, b) => b[1] - a[1]).slice(0, 30) };
      }
      if (sub === 'stats') return { ok: true, stats: library().stats() };
      if (sub === 'validate') {
        const sample = args[1] ? intArg(args[1], 'sample', { min: 1, max: 2000 }) : 40;
        const report = validateLibrary(library().manifest, { sampleSize: sample });
        return { ok: report.passed, report: { ...report, text: formatValidationReport(report) } };
      }
      if (sub === 'export') {
        const design = resolveDesign(services, args[1]);
        const format = (args[2] || 'schem').toLowerCase();
        const schematic = library().build(design.id);
        const dir = config.paths.schematics;
        fs.mkdirSync(dir, { recursive: true });
        if (format === 'schem' || format === 'sponge') {
          const file = path.join(dir, `${design.id}.schem`);
          fs.writeFileSync(file, toSpongeSchematic(schematic));
          return { ok: true, file, bytes: fs.statSync(file).size, format: 'sponge-schem-v2', design: design.id };
        }
        if (format === 'legacy' || format === 'schematic') {
          const file = path.join(dir, `${design.id}.schematic`);
          const result = toLegacySchematic(schematic);
          fs.writeFileSync(file, result.buffer);
          return { ok: true, file, bytes: fs.statSync(file).size, format: 'mcedit-schematic', substituted: result.substituted };
        }
        if (format === 'json') {
          const file = path.join(dir, `${design.id}.json`);
          fs.writeFileSync(file, JSON.stringify(toJSON(schematic)));
          return { ok: true, file, bytes: fs.statSync(file).size, format: 'json' };
        }
        return { ok: false, error: `unknown export format '${format}'` };
      }
      if (sub === 'import') {
        if (!args[1]) return { ok: false, error: 'import requires a file under schematics/' };
        const dir = path.resolve(config.paths.schematics);
        const file = path.resolve(args[1]);
        if (!file.startsWith(dir + path.sep)) return { ok: false, error: 'imports are restricted to the schematics/ directory' };
        if (!fs.existsSync(file)) return { ok: false, error: `file not found: ${file}` };
        const buffer = fs.readFileSync(file);
        let schematic;
        if (file.endsWith('.json')) schematic = fromJSON(JSON.parse(buffer.toString('utf8')));
        else if (file.endsWith('.schem')) schematic = fromSpongeSchematic(buffer);
        else return { ok: false, error: 'only .schem and .json imports are supported (legacy import is exposed through the API only)' };
        if (!schematic.blocks || !schematic.blocks.length) return { ok: false, error: 'imported schematic has no blocks' };
        const id = `imported-${path.basename(file, path.extname(file))}`;
        schematic.id = id;
        services.imported.set(id, schematic);
        return { ok: true, id, name: schematic.name, dimensions: schematic.dimensions, blocks: schematic.blocks.length, materials: Object.keys(schematic.materials).length, geometryHash: schematic.geometryHash };
      }
      return { ok: false, error: `unknown schematics subcommand '${sub}'` };
    }
  });
}

function createCommandHandler(services = {}) {
  if (!services.library) services.library = new SchematicLibrary();
  if (!services.builders) services.builders = new Map();
  if (!services.imported) services.imported = new Map();
  const registry = new CommandRegistry({ logger: services.logger });
  registerAll(services, registry);
  return {
    registry,
    services,
    list: (category) => registry.list(category),
    help: (name) => registry.help(name),
    execute: (line, options) => registry.execute(line, options),
    recent: (limit) => registry.recent(limit),
    taskTypes: [...TASK_TYPES],
    snapshot: () => statusSnapshot(services)
  };
}

module.exports = { createCommandHandler, CommandRegistry, CommandError, TASK_TYPES, resolveDesign };
