'use strict';

const fs = require('fs');
const path = require('path');
const { CommandRegistry, CommandError } = require('./registry');
const { config, BOT_NAMES } = require('../config');
const { SchematicLibrary } = require('../schematics/library');
const { SchematicBuilder } = require('../builder/builder');
const { validateLibrary, formatValidationReport } = require('../schematics/validate');
const { toSpongeSchematic, toLegacySchematic, toJSON } = require('../schematics/format');
const { exportSchematic } = require('../building/schematicIO');
const { statusSnapshot } = require('../runtimeState');
const { connectionStatus } = require('../bot/status');
const { botWorldView } = require('../construction/constants');
const { normalizeMineTarget, isMineableTarget, isOreName, BLOCK_TIERS } = require('../actions/miningCatalog');
const { workZone } = require('../world/workZone');
const { planRoute } = require('../navigation/planner');
const { goalPosition } = require('../navigation/standability');
const { catalogue } = require('../woodcutting/catalog');

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

const UNSAFE_PARAM_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function mergeTaskParams(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (UNSAFE_PARAM_KEYS.has(key)) throw new CommandError(`unsafe task parameter '${key}'`);
    target[key] = value;
  }
}

/** Parse `key=value` / `--params <json>` task parameters without eval. */
function parseTaskParams(args) {
  // Null prototype: a JSON `__proto__` key must never mutate the parameter
  // object's prototype and make validation read an inherited value.
  const params = Object.create(null);
  const labelParts = [];
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i]);
    if (token === '--params') {
      const raw = args[++i];
      if (raw === undefined) throw new CommandError('--params requires a JSON object');
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { throw new CommandError('--params must be valid JSON'); }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new CommandError('--params must be a JSON object');
      mergeTaskParams(params, parsed);
      continue;
    }
    if (token.startsWith('{')) {
      const raw = args.slice(i).join(' ');
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { throw new CommandError('task parameters must be valid JSON'); }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new CommandError('task parameters must be a JSON object');
      mergeTaskParams(params, parsed);
      break;
    }
    const match = token.match(/^([a-zA-Z][a-zA-Z0-9_]*)=(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2];
      if (/^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
      else if (value === 'true' || value === 'false') value = value === 'true';
      else if (value === 'null') value = null;
      params[key] = value;
      continue;
    }
    labelParts.push(token);
  }
  return { params, label: labelParts.join(' ').trim() };
}

function validateTaskParams(type, params) {
  if (type === 'TRANSFER_ITEMS') {
    if (!params.item) throw new CommandError('TRANSFER_ITEMS requires item=<name>');
    if (!params.to && !params.recipient) throw new CommandError('TRANSFER_ITEMS requires to=<bot>');
  }
  if (type === 'STORE_ITEMS' && !params.item && !params.containers) {
    throw new CommandError('STORE_ITEMS requires item=<name> (deposit) or containers=<count> (place chests)');
  }
  if (type === 'BUILD_BLOCK' && !params.buildId) throw new CommandError('BUILD_BLOCK requires buildId=<id>');
  if (type === 'EXCAVATE_REGION' && params.volume !== undefined && !Number.isFinite(Number(params.volume))) {
    throw new CommandError('EXCAVATE_REGION volume must be a number');
  }
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
  // FLEET_WORDS includes '*'. Keeping a second literal list here made
  // `players follow Alex *` fail with "unknown bot" instead of fanning out.
  if (!value || isFleetTarget(value)) return allActions(services);
  return [actionsFor(services, pickBot(services, value).name)];
}

const SURVIVAL_FEATURES = ['eat', 'healing', 'armour', 'tools', 'crafting', 'shield'];
const MINE_BLOCK_TARGETS = new Set(Object.keys(BLOCK_TIERS));

function normalizeOre(value) {
  if (!value) return null;
  return normalizeMineTarget(value);
}

function assertMineable(value) {
  if (!isMineableTarget(value)) {
    throw new CommandError(`unknown mineable target '${value}'; use an ore (diamond, iron, coal...) or a block (stone, dirt, obsidian...)`);
  }
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

/** Run one bot's team action under the same exclusive slot as `bot <name>`.
 *  Team commands used to call goTo/defend/sleep directly, so an autonomous
 *  pathfinder or safety pass could own the bot at the same time. */
async function withBotExclusive(services, bot, fn) {
  if (!services.runtime || typeof services.runtime.runExclusive !== 'function') return fn();
  return services.runtime.runExclusive(bot.name, fn);
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
    const result = await withBotExclusive(services, bot, () => bot.goTo(target, {
      range: 3, timeoutMs: 15000, priority: 'operator', owner: `team-${mode.toLowerCase()}`, adjustY: true
    }));
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

function trimBuilders(services, max = 50) {
  if (!services.builders || services.builders.size <= max) return;
  const terminal = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);
  const removable = [...services.builders.values()].filter((builder) => terminal.has(builder.status().state));
  while (services.builders.size > max && removable.length) {
    const builder = removable.shift();
    services.builders.delete(builder.id);
    if (services.actions) for (const actions of services.actions.list()) actions.builders.delete(builder.id);
  }
}

async function buildDesign(services, design, { origin = null, confirm = false, run = false, runSteps = 30, kind = 'build' } = {}) {
  const bots = [...services.bots.values()];
  if (!bots.length) throw new CommandError('no bots connected');
  const world = services.world || botWorldView(bots[0]);
  if (!world) throw new CommandError('no world available');
  const schematic = services.library.build(design.id);
  let buildOrigin = origin;
  if (!buildOrigin) {
    const base = services.runtime && services.runtime.home ? services.runtime.home : bots[0].position;
    buildOrigin = { x: Math.floor(base.x) + 4, y: Math.floor(base.y) + 1, z: Math.floor(base.z) + 4 };
  }
  const builder = new SchematicBuilder({
    schematic, origin: buildOrigin, world, bots,
    taskBoard: services.taskBoard, ledger: services.ledger, memory: services.memory,
    logger: services.logger, buildId: `${kind === 'home' ? 'home' : 'build'}-${design.id}-${Date.now().toString(36)}`
  });
  const started = builder.start({ confirm });
  if (!started.ok) return { ok: false, error: started.error, buildId: builder.id, analysis: builder.analyze(), needsConfirmation: started.needsConfirmation, conflicts: started.conflicts };
  services.builders.set(builder.id, builder);
  if (services.actions) for (const actions of services.actions.list()) actions.builders.set(builder.id, builder);
  trimBuilders(services);
  let execution = null;
  if (run) {
    execution = await builder.run({ maxIterations: runSteps });
  }
  return {
    ok: true, buildId: builder.id, design: { id: design.id, name: design.name, tier: design.tier },
    origin: buildOrigin, tasks: started.tasks, analysis: builder.analyze(), execution, status: builder.status()
  };
}


const FLEET_WORDS = new Set(['all', 'fleet', 'team', '*']);

function isFleetTarget(value) {
  return FLEET_WORDS.has(String(value || '').toLowerCase());
}

/**
 * Run one real action per bot with bounded parallelism. Every row is produced
 * by actually calling that bot's action controller; a bot that is not
 * gameplay-ready is reported as skipped instead of being allowed to throw a
 * misleading success into the fleet result.
 */
async function runFleetActions(services, target, run, { concurrency = config.commands.fleetConcurrency } = {}) {
  const list = targetActions(services, target);
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      const actions = list[index];
      const bot = actions.bot;
      const status = connectionStatus(bot);
      if (!status.gameplayReady) {
        results[index] = {
          bot: bot.name, ok: false, skipped: true, code: 'BOT_NOT_READY',
          status: status.status, statusLabel: status.statusLabel,
          error: `not gameplay-ready (${status.statusLabel}): ${status.statusDetail}`
        };
        continue;
      }
      try {
        const result = await run(actions);
        results[index] = { bot: bot.name, ...(result || {}) };
        if (results[index].ok === undefined) results[index].ok = false;
      } catch (err) {
        results[index] = { bot: bot.name, ok: false, error: err.message };
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  const completed = results.filter((result) => result.ok).length;
  return {
    target: 'all',
    bots: results.length,
    completed,
    failed: results.filter((result) => !result.ok && !result.skipped).length,
    skipped: results.filter((result) => result.skipped).length,
    partial: completed > 0 && completed < results.length,
    ok: results.length > 0 && results.every((result) => result.ok),
    results
  };
}

function fleetStatus(services) {
  const results = [...services.bots.values()].map((bot) => {
    const status = connectionStatus(bot);
    // A status query succeeds even when a bot is offline; the online/ready
    // fields carry the verdict. `ok` keeps the fleet result row shape uniform.
    return { bot: bot.name, ok: true, ...status };
  });
  return {
    ok: true,
    // `bots` stays the array for older callers; `count` is the explicit total.
    bots: results,
    count: results.length,
    online: results.filter((row) => row.online).length,
    ready: results.filter((row) => row.gameplayReady).length,
    results
  };
}

const QUERY_ACTIONS = new Set(['status', 'where', 'combat', 'inventory', 'inv']);

/**
 * Operator goto is allowed to take as long as the walk needs, not 30 s. A
 * conservative 0.9 s per horizontal block plus 15 s covers terrain, and the
 * 110 s cap keeps the dashboard request inside its own 120 s timeout.
 */
function travelTimeoutMs(bot, pos) {
  const from = bot && bot.position;
  if (!from || !pos) return 30000;
  const distance = Math.hypot(Number(pos.x) - Number(from.x), Number(pos.z) - Number(from.z));
  if (!Number.isFinite(distance)) return 30000;
  return Math.max(30000, Math.min(110000, Math.round(distance * 900) + 15000));
}

async function runBotAction(services, bot, args, context = {}) {
  const action = (args[1] || 'status').toLowerCase();
  // Read-only views must stay instant. Every gameplay action takes an
  // exclusive slot so it cannot fight an autonomous pathfinder on the same bot.
  if (QUERY_ACTIONS.has(action) || !services.runtime || typeof services.runtime.runExclusive !== 'function') {
    return runBotActionExclusive(services, bot, args, context);
  }
  return services.runtime.runExclusive(bot.name, () => runBotActionExclusive(services, bot, args, context));
}

async function runBotActionExclusive(services, bot, args, context = {}) {
  const action = (args[1] || 'status').toLowerCase();
  const actions = actionsFor(services, bot.name);
  const leader = services.coordinator ? services.bots.get(services.coordinator.leader) : null;
  if (action === 'status') return { ok: true, bot: { ...(bot.summary ? bot.summary() : { name: bot.name }), ...connectionStatus(bot) } };
  // Gameplay is gated on one authoritative verdict. A spawned-but-not-ready or
  // AUTH_REQUIRED_MANUAL session may report its own status, but it may not be
  // told to chop, mine, move or fight.
  const health = connectionStatus(bot);
  if (!['where', 'combat'].includes(action) && !health.gameplayReady) {
    return {
      ok: false, code: 'BOT_NOT_READY', status: health.status,
      statusLabel: health.statusLabel, authPending: health.authPending,
      error: `${bot.name} is not gameplay-ready (${health.statusLabel}): ${health.statusDetail}`
    };
  }
  if (action === 'where') return { ok: true, bot: bot.name, position: { ...bot.position }, dimension: bot.dimension };
  if (action === 'goto') {
    const pos = parseOrigin(args, 2);
    const result = await bot.goTo(pos, {
      range: 2,
      // A 100-block walk can legitimately take longer than the old 30 s cap.
      // Keep the command bounded but let realistic operator distances finish.
      timeoutMs: travelTimeoutMs(bot, pos),
      priority: 'operator',
      owner: 'operator-goto',
      adjustY: true
    });
    return { ok: result.ok !== false, ...result, position: { ...bot.position } };
  }
  if (action === 'come' || action === 'follow') {
    const destination = leader && leader !== bot ? leader.position : bot.position;
    const result = await bot.goTo(destination, { range: 2, timeoutMs: 30000, priority: 'operator', owner: 'operator-come', adjustY: true });
    return { ok: result.ok !== false, ...result, position: { ...bot.position }, followed: leader ? leader.name : null };
  }
  if (action === 'return') {
    const result = await bot.goTo(services.runtime ? services.runtime.home : actions.home, { range: 3, timeoutMs: 30000, priority: 'operator', owner: 'operator-return' });
    return { ok: result.ok !== false, ...result, position: { ...bot.position } };
  }
  if (action === 'eat') return actions.survival.eat();
  if (action === 'inventory' || action === 'inv') {
    return { ok: true, bot: bot.name, inventory: actions.inventory.status() };
  }
  if (action === 'collect') {
    if (typeof bot.collectDrops !== 'function') return { ok: false, error: 'this adapter cannot collect drops' };
    const result = await bot.collectDrops(6);
    return { ok: result.ok !== false, ...result };
  }
  if (action === 'mine') {
    const ore = normalizeOre(args[2]);
    if (!ore) {
      const result = await actions.mining.mineNearby({ radius: 24, limit: 8 });
      return { ok: Boolean(result.ok), ...result, status: actions.mining.status() };
    }
    assertMineable(ore);
    if (MINE_BLOCK_TARGETS.has(ore)) {
      // Every block request uses the same tool gate; dirt/sand need no pick,
      // while obsidian needs a diamond pick and will bootstrap one.
      const result = await actions.mining.mineBlocks({ block: ore, radius: 24, limit: 8 });
      return {
        ok: Boolean(result.ok), ...result,
        verified: Boolean(result.ok),
        error: result.ok ? undefined : (result.error || `no ${ore} block was removed`)
      };
    }
    // A surface scan is not proof that ore is unreachable. Use the deep path:
    // it searches the local cube, then sinks safe shafts/branches toward the
    // requested ore. Success is only reported for an ore that was actually
    // removed; digging an access shaft is reported as work, not as the quota.
    const only = isOreName(ore) ? ore : `${ore}_ore`;
    const result = await actions.mining.mineOresDeep({
      radius: Math.max(48, config.mining.maxSearchRadius),
      limit: 4,
      maxDepth: 12,
      minY: config.mining.minY === undefined ? -59 : config.mining.minY,
      only
    });
    return {
      ok: result.mined > 0,
      ...result,
      mined: result.mined || 0,
      verified: result.mined > 0,
      error: result.mined > 0 ? undefined : (result.error || `no ${args[2]} ore was reached and removed`)
    };
  }
  if (action === 'chop') {
    const types = args.slice(2).join(' ') || null;
    const result = await actions.woodcutting.tick({ maxTrees: 2, types, relocate: true });
    // woodcutting.tick reports ok:true for "idle, no tree in range". A command
    // must not turn that into a claimed success: only removed logs count.
    const chopped = (result.results || []).reduce((sum, entry) => sum + (entry.chopped || 0), 0);
    const verified = chopped > 0;
    return {
      ...result,
      ok: verified,
      chopped,
      verified,
      error: verified ? undefined : (result.reason || (result.relocations || []).map((move) => move.error).filter(Boolean).join('; ') || 'no tree was chopped and verified')
    };
  }
  if (action === 'farm') {
    const words = args.slice(2).map((word) => String(word).toLowerCase());
    const crop = words.join(' ') || null;
    if (words[0] === 'plant') {
      const result = await actions.farming.plantCrops({
        crop: words[1] || 'wheat',
        count: words[2] === undefined ? 16 : intArg(words[2], 'count', { min: 1, max: 256 })
      });
      return { ok: result.ok !== false, ...result };
    }
    if (words[0] === 'maintain') {
      const result = await actions.farming.maintain();
      return { ok: result.ok !== false, ...result };
    }
    if (words[0] === 'status') return { ok: true, ...actions.farming.status() };
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
  if (action === 'combat') return { ok: true, bot: bot.name, combat: actions.combat.status() };
  if (action === 'guard') {
    const position = args.length >= 5 ? parseOrigin(args, 2) : null;
    return { ok: true, bot: bot.name, ...(await actions.combat.guard(position)) };
  }
  if (action === 'duel') {
    if (!args[2]) throw new CommandError('usage: bot <name> duel <authorised-player> confirm');
    if (!context.confirmed) return { ok: false, error: 'duel requires explicit confirmation (append confirm)', code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
    return { ok: true, bot: bot.name, ...(await actions.combat.duel(args[2])) };
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

function registerAll(services, registry) {
  registry.register({
    name: 'help', category: 'core', summary: 'List commands or show detailed help', usage: 'help [command]',
    execute: async (args) => (args.length ? registry.help(args[0]) : registry.help())
  });

  registry.register({
    name: 'status', aliases: ['state'], category: 'core', summary: 'Full team, task, ledger and connection snapshot', usage: 'status',
    execute: async () => {
      const bots = [...services.bots.values()].map((b) => ({
        ...(b.summary ? b.summary() : { name: b.name }),
        ...connectionStatus(b)
      }));
      const library = services.library && services.library.loaded ? services.library.stats() : null;
      return {
        ok: true,
        summary: {
          total: bots.length,
          online: bots.filter((bot) => bot.online === true).length,
          ready: bots.filter((bot) => bot.gameplayReady === true || bot.ready === true).length,
          authRequiredManual: bots.filter((bot) => bot.authPending === true || bot.authRequiredManual === true).length
        },
        bots,
        team: services.coordinator ? services.coordinator.getState() : null,
        tasks: services.taskBoard ? services.taskBoard.stats() : null,
        ledger: services.ledger ? services.ledger.summary() : null,
        excavations: services.excavation ? services.excavation.status() : null,
        builds: [...(services.builders ? services.builders.values() : [])].map((b) => b.status()),
        library: library ? { count: library.count, unique: library.uniqueGeometry, minimum: library.minimumRequired, fromSummary: Boolean(library.fromSummary) } : null,
        autonomy: services.runtime ? services.runtime.state() : null,
        ai: { enabled: false, mode: 'deterministic' }
      };
    }
  });

  registry.register({
    name: 'diagnostics', aliases: ['diag'], category: 'core', summary: 'Run real self-checks over config, library, team and dashboard', usage: 'diagnostics',
    execute: async () => {
      const checks = [];
      checks.push({ name: 'roster', ok: JSON.stringify(config.team.names) === JSON.stringify(BOT_NAMES) && config.team.names.length === BOT_NAMES.length, detail: config.team.names.join(', ') });
      checks.push({ name: 'server-default', ok: config.server.host === 'EmpiSMP.aternos.me' && config.server.port === 32990 && config.server.version === 'auto', detail: `${config.server.host}:${config.server.port} (${config.server.version})` });
      checks.push({ name: 'pve-enabled', ok: config.autonomy.pve !== false, detail: String(config.autonomy.pve) });
      checks.push({ name: 'pvp-explicit-only', ok: config.autonomy.pvp === true, detail: `${config.autonomy.pvp} (explicit target list still required)` });
      checks.push({ name: 'ai-disabled', ok: config.autonomy.ai.enabled === false, detail: 'deterministic local intelligence' });
      checks.push({ name: 'dashboard-safe-bind', ok: ['127.0.0.1', '::1', 'localhost'].includes(String(config.dashboard.host).toLowerCase()) || Boolean(config.dashboard.token) || config.dashboard.allowInsecure === true, detail: `${config.dashboard.host}:${config.dashboard.port}${config.dashboard.token ? ' (token)' : config.dashboard.allowInsecure ? ' (explicit insecure opt-in)' : ''}` });
      const library = services.library;
      const libraryStats = library && library.loaded ? library.stats() : null;
      checks.push({ name: 'schematic-library', ok: Boolean(libraryStats && libraryStats.count >= config.schematics.minimumCount), detail: libraryStats ? `${libraryStats.count} designs${libraryStats.fromSummary ? ' (summary)' : ''}` : 'not generated' });
      if (libraryStats) {
        // The manifest and the custom store are separate catalogues. Comparing
        // manifest hashes with the combined count made a valid 10,000-design
        // manifest fail as soon as one custom design existed. The aggregate
        // summary already carries the unique geometry count, so diagnostics
        // does not have to parse the 20 MB manifest.
        const custom = library.customStore ? library.customStore.count : 0;
        checks.push({
          name: 'schematic-uniqueness',
          ok: libraryStats.uniqueGeometry === libraryStats.count,
          detail: `${libraryStats.uniqueGeometry}/${libraryStats.count} unique manifest geometries${custom ? ` + ${custom} custom design(s)` : ''}`
        });
      }
      checks.push({ name: 'bots-configured', ok: services.bots.size === BOT_NAMES.length, detail: `${services.bots.size} bots loaded` });
      const zone = workZone(services.runtime ? services.runtime.home : null, { margin: config.workZone ? config.workZone.margin : 0 });
      checks.push({
        name: 'work-zone',
        ok: zone.enabled ? (zone.maxX - zone.minX + 1 === zone.size && zone.maxZ - zone.minZ + 1 === zone.size) : true,
        detail: zone.enabled
          ? `${zone.label} around ${zone.center.x},${zone.center.z} (x ${zone.minX}..${zone.maxX}, z ${zone.minZ}..${zone.maxZ})`
          : 'disabled'
      });
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
    name: 'team', category: 'team', summary: 'Inspect team state and control formations, resources and coordination', usage: 'team [state|on|off|follow|regroup|retreat|defend|memory|locks|tasks|roles|leader|resources|objectives|assignments|assist <bot>|sleep [bot|all]|reassign|formation <name>|combat heal]',
    execute: async (args) => {
      const sub = (args[0] || 'state').toLowerCase();
      const coordinator = services.coordinator;
      if (!coordinator) return { ok: false, error: 'no coordinator' };
      if (sub === 'state' || sub === 'status') return { ok: true, state: coordinator.getState(), enabled: coordinator.enabled, formation: coordinator.formation };
      if (sub === 'combat') {
        const teamCombat = combatCoordinator(services);
        const value = String(args[1] || 'status').toLowerCase();
        if (value === 'on' || value === 'off') return { ok: true, ...teamCombat.setEnabled(value === 'on'), status: teamCombat.status() };
        if (value === 'defend' || value === 'defensive') return { ok: true, ...teamCombat.setMode('DEFENSIVE') };
        if (value === 'retreat') return { ok: true, ...(await teamCombat.retreat('operator team combat retreat')) };
        if (value === 'regroup') return { ok: true, ...(await teamCombat.regroup()) };
        if (value === 'rescue') return { ok: true, ...(await teamCombat.autoRescue({ cooldownMs: 0 })) };
        if (value === 'heal') return { ok: true, ...(await teamCombat.assistHealing({ cooldownMs: 0 })) };
        if (value === 'attack') {
          if (!args[2]) throw new CommandError('usage: team combat attack <authorised-player>');
          return teamAttack(services, args[2]);
        }
        return { ok: true, combat: teamCombat.status() };
      }
      if (sub === 'attack') {
        if (!args[1]) throw new CommandError('usage: team attack <authorised-player>');
        return teamAttack(services, args[1]);
      }
      if (sub === 'leader') {
        const leadership = services.leadership || coordinator.leadership;
        if (!leadership) return { ok: true, leader: coordinator.leader, election: null, note: 'leadership model unavailable' };
        const states = [...services.bots.values()].map((bot) => ({
          name: bot.name, connected: bot.connected, spawned: bot.spawned,
          health: bot.health, food: bot.food, uptimeMs: bot.uptimeMs,
          taskLoad: coordinator.assignments && coordinator.assignments.has(bot.name) ? 1 : 0
        }));
        return {
          ok: true,
          leader: coordinator.leader || leadership.leader,
          preferred: leadership.preferred,
          succession: leadership.successionOrder(states).slice(0, 10),
          history: leadership.history.slice(-10),
          election: { preferred: leadership.preferred, candidates: states.length, history: leadership.history.length }
        };
      }
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
      if (sub === 'assignments' || sub === 'crew') {
        const project = services.construction ? services.construction.activeProject() : null;
        return {
          ok: true,
          project: project ? services.construction.summary(project) : null,
          crew: project ? project.teamAssignments : null,
          coordinator: { roles: Object.fromEntries(coordinator.roles), assignments: Object.fromEntries(coordinator.assignments) }
        };
      }
      if (sub === 'assist') {
        if (!services.construction) return { ok: false, error: 'construction manager unavailable' };
        const bot = pickBot(services, args[1]);
        return services.construction.assist(bot.name);
      }
      if (sub === 'sleep') {
        const target = args[1] && args[1] !== 'all' ? [actionsFor(services, pickBot(services, args[1]).name)] : allActions(services);
        const results = [];
        for (const actions of target) {
          results.push({ bot: actions.bot.name, ...(await withBotExclusive(services, actions.bot, () => actions.sleep.sleep())) });
        }
        return { ok: results.every((result) => result.ok !== false), results };
      }
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
          const result = await withBotExclusive(services, bot, () => bot.goTo(services.runtime.home, {
            range: 3, timeoutMs: 20000, priority: 'emergency', owner: 'team-retreat', adjustY: true
          }));
          return { bot: bot.name, ok: result.ok !== false, position: { ...bot.position }, error: result.error };
        }));
        return { ok: results.every((result) => result.ok), formation: 'RETREAT', home: services.runtime.home, results };
      }
      if (sub === 'defend') {
        coordinator.setFormation('DEFENSIVE');
        const results = await Promise.all(allActions(services).map(async (actions) => ({
          bot: actions.bot.name,
          ...(await withBotExclusive(services, actions.bot, () => actions.combat.defend({ maxAttacks: 8 })))
        })));
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
    name: 'goto', category: 'exploration', summary: 'Move a bot (or the leader) to coordinates', usage: 'goto <x> <y> <z> [bot] | goto <bot|all> <x> <y> <z>', examples: ['goto 100 65 -40', 'goto 10101000 100 65 -40', 'goto all 0 65 0'],
    execute: async (args, context = {}) => {
      const raw = args.map((value) => String(value));
      let target = null;
      let coordinateArgs = raw;
      if (raw.length === 4) {
        if (raw[0].toLowerCase() === 'all' || services.bots.has(raw[0])) {
          target = raw[0].toLowerCase() === 'all' ? 'all' : raw[0];
          coordinateArgs = raw.slice(1);
        } else if (services.bots.has(raw[3])) {
          target = raw[3];
          coordinateArgs = raw.slice(0, 3);
        }
      }
      if (coordinateArgs.length !== 3) {
        throw new CommandError('usage: goto <x> <y> <z> [bot] or goto <bot|all> <x> <y> <z>');
      }
      const pos = parseOrigin(coordinateArgs, 0);
      if (target === 'all') {
        return runFleetActions(services, 'all', (actions) => runBotAction(
          services, actions.bot, [actions.bot.name, 'goto', String(pos.x), String(pos.y), String(pos.z)], context
        ));
      }
      const bot = pickBot(services, target);
      return runBotAction(services, bot, [bot.name, 'goto', String(pos.x), String(pos.y), String(pos.z)], context);
    }
  });

  registry.register({
    name: 'path', category: 'exploration', summary: 'Plan (without moving) or inspect a bot navigation route', usage: 'path <x> <y> <z> [bot] | path [bot]', examples: ['path 100 65 -40', 'path 10101000 100 65 -40', 'path 10101000'],
    execute: async (args, context = {}) => {
      const raw = args.map((value) => String(value));
      if (!raw.length) throw new CommandError('usage: path <x> <y> <z> [bot] or path [bot]');
      // Status form: a single known bot (or the leader) and no coordinates.
      if (raw.length === 1 && services.bots.has(raw[0])) {
        const bot = pickBot(services, raw[0]);
        return { ok: true, bot: bot.name, navigation: bot.navigationStatus ? bot.navigationStatus() : null, position: { ...bot.position } };
      }
      let target = context.bot || services.coordinator?.leader || [...services.bots.keys()][0];
      let coordinateArgs = raw;
      if (raw.length === 4) {
        if (raw[0].toLowerCase() === 'all' || services.bots.has(raw[0])) {
          if (raw[0].toLowerCase() === 'all') throw new CommandError('path plans one route; name a single bot');
          target = raw[0];
          coordinateArgs = raw.slice(1);
        } else if (services.bots.has(raw[3])) {
          target = raw[3];
          coordinateArgs = raw.slice(0, 3);
        }
      }
      const bot = pickBot(services, target);
      const destination = parseOrigin(coordinateArgs, 0);
      const nav = config.navigation || {};
      const validation = goalPosition(bot, destination, {
        range: 1,
        adjustY: true,
        maxDrop: nav.maxDrop === undefined ? 3 : nav.maxDrop,
        allowWater: nav.allowWater !== false
      });
      if (!validation.ok) {
        return {
          ok: false, bot: bot.name, from: { ...bot.position }, target: destination,
          reachable: false, code: validation.code || 'NO_STANDABLE_DESTINATION',
          error: `no standable destination near ${destination.x},${destination.y},${destination.z}: ${validation.reason}`
        };
      }
      const route = planRoute({
        from: bot.position,
        to: validation.goal || destination,
        reader: bot,
        range: 1,
        maxNodes: Math.max(2000, Number(nav.maxNodes) || 12000),
        maxDrop: nav.maxDrop === undefined ? 3 : nav.maxDrop,
        allowWater: nav.allowWater !== false,
        allowHazard: false
      });
      return {
        ok: Boolean(route.ok), bot: bot.name, from: { ...bot.position }, target: destination,
        goal: validation.goal || destination, reachable: Boolean(route.ok),
        reason: route.reason || null, steps: route.path ? route.path.length : 0,
        distance: route.cost === Infinity ? null : route.cost,
        path: (route.path || []).slice(0, 200),
        expanded: route.expanded || 0, visited: route.visited || 0, ms: route.ms || 0,
        moved: false,
        error: route.ok ? undefined : `no route to ${destination.x},${destination.y},${destination.z}: ${route.reason}`
      };
    }
  });

  registry.register({
    name: 'bot', category: 'team', summary: 'Per-bot status, movement and action controls', usage: 'bot <name|all> <status|goto x y z|come|follow|eat|mine [ore]|chop [type]|farm [crop]|fish|defend|combat|guard [x y z]|duel <player>|explore|sleep|return home|where>',
    execute: async (args, context = {}) => {
      const target = String(args[0] || '').toLowerCase();
      const action = String(args[1] || 'status').toLowerCase();
      if (isFleetTarget(target)) {
        if (action === 'status') return fleetStatus(services);
        return runFleetActions(services, 'all', (actions) => runBotAction(
          services, actions.bot, [actions.bot.name, ...args.slice(1)], context
        ));
      }
      return runBotAction(services, pickBot(services, args[0]), args, context);
    }
  });

  registry.register({
    name: 'inventory', aliases: ['inv'], category: 'survival', summary: 'Inventory, reserves and tool status', usage: 'inventory [bot|all]',
    execute: async (args) => {
      if (isFleetTarget(args[0])) {
        return runFleetActions(services, 'all', (actions) => {
          const status = actions.inventory.status();
          return { ok: true, inventory: status, capacity: status.capacity, used: status.slotsUsed, free: status.slotsFree };
        });
      }
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
    name: 'auto', category: 'survival', summary: 'Fleet or per-bot automatic routine switches', usage: 'auto <eat|healing|armour|tools|crafting|shield|weapon|totem|potions|food|heal> [on|off] [bot|all]',
    execute: async (args) => {
      const rawFeature = String(args[0] || '').toLowerCase();
      const feature = rawFeature === 'armor' ? 'armour' : rawFeature;
      if (!feature || feature === 'status') return orchestrateSurvival(services, 'all', null, true);
      const value = String(args[1] || 'on').toLowerCase();
      if (!['on', 'off'].includes(value)) throw new CommandError('usage: auto <routine> [on|off] [bot|all]');
      const target = args[2] || 'all';
      const combatAutomation = ['weapon', 'totem', 'potions', 'food', 'armour', 'shield', 'heal'];
      if (combatAutomation.includes(feature)) {
        const combatResults = combatControllers(services)
          .filter((controller) => target === 'all' || controller.bot.name === target)
          .map((controller) => ({ bot: controller.bot.name, ...controller.setAuto(feature, value === 'on') }));
        const survivalResults = ['armour', 'shield'].includes(feature)
          ? [orchestrateSurvival(services, target, feature, value === 'on')]
          : [];
        return { ok: true, automation: feature, enabled: value === 'on', combat: combatResults, survival: survivalResults };
      }
      return orchestrateSurvival(services, target, feature, value === 'on');
    }
  });

  registry.register({
    name: 'eat', category: 'survival', summary: 'Eat the best available food, for one bot or the whole fleet', usage: 'eat [bot|all]',
    execute: async (args) => {
      if (isFleetTarget(args[0])) {
        return runFleetActions(services, 'all', (actions) => withBotExclusive(services, actions.bot, () => actions.survival.eat()));
      }
      const bot = pickBot(services, args[0]);
      return runBotAction(services, bot, [bot.name, 'eat'], {});
    }
  });

  registry.register({
    name: 'mine', category: 'mining', summary: 'Mine ores or any mineable block; bootstraps the pickaxe tier and confines work to home', usage: 'mine [bot|all] [ore|block|stop]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop') {
        const results = allActions(services).map((actions) => actions.mining.stop());
        return { ok: true, stopped: true, results };
      }
      if (isFleetTarget(first)) {
        const requested = String(args[1] || '').toLowerCase();
        if (requested === 'stop') {
          return { ok: true, stopped: true, results: allActions(services).map((actions) => actions.mining.stop()) };
        }
        const fleet = await runFleetActions(services, 'all', (actions) => runBotAction(
          services, actions.bot, [actions.bot.name, 'mine', ...args.slice(1)], {}
        ));
        const mined = (fleet.results || []).reduce((sum, row) => sum + (Number(row.mined) || 0), 0);
        const breakdown = (fleet.results || []).reduce((out, row) => {
          for (const [drop, count] of Object.entries(row.breakdown || {})) out[drop] = (out[drop] || 0) + count;
          return out;
        }, {});
        return {
          ...fleet, mined, breakdown, verified: mined > 0,
          ok: fleet.ok && mined > 0,
          error: mined > 0 ? undefined : (fleet.results || []).map((row) => row.error).filter(Boolean).join('; ') || 'no ore was reached and removed'
        };
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const requested = String(named ? args[1] || '' : args[0] || '').toLowerCase();
      const bot = pickBot(services, named);
      // `mine <bot> stop` is the per-bot counterpart of `mine stop`. Without
      // this, the dashboard's per-bot stop control would be interpreted as an
      // ore target and fail validation.
      if (requested === 'stop') return { ok: true, bot: bot.name, ...actionsFor(services, bot.name).mining.stop() };
      return runBotAction(services, bot, [bot.name, 'mine', ...(requested ? [requested] : [])], {});
    }
  });

  registry.register({
    name: 'chop', aliases: ['wood'], category: 'woodcutting', summary: 'Chop and replant trees, optionally one species; stop cancels', usage: 'chop [bot|all] [wood|oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove|pale_oak|stop]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop') {
        const results = allActions(services).map((actions) => actions.woodcutting.stop());
        return { ok: true, stopped: true, results };
      }
      if (isFleetTarget(first)) {
        const requested = args.slice(1).join(' ').trim().toLowerCase();
        if (requested === 'stop') {
          return { ok: true, stopped: true, results: allActions(services).map((actions) => actions.woodcutting.stop()) };
        }
        const fleet = await runFleetActions(services, 'all', (actions) => runBotAction(
          services, actions.bot, [actions.bot.name, 'chop', ...args.slice(1)], {}
        ));
        const chopped = (fleet.results || []).reduce((sum, row) => sum + (Number(row.chopped) || 0), 0);
        return {
          ...fleet, chopped, verified: chopped > 0,
          ok: fleet.ok && chopped > 0,
          error: chopped > 0 ? undefined : (fleet.results || []).map((row) => row.error).filter(Boolean).join('; ') || 'no tree was chopped and verified'
        };
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const rest = named ? args.slice(1) : args;
      const requested = rest.join(' ').trim().toLowerCase();
      if (requested === 'stop') return { ok: true, ...actionsFor(services, pickBot(services, named).name).woodcutting.stop() };
      const bot = pickBot(services, named);
      return runBotAction(services, bot, [bot.name, 'chop', ...(rest.length ? rest : [])], {});
    }
  });

  registry.register({
    name: 'woodcutting', aliases: ['forestry'], category: 'woodcutting',
    summary: 'Manage the woodcutting system: catalogue, tree identification, roles, storage and support',
    usage: 'woodcutting [status [bot|all]|trees [bot] [radius] [type]|catalog [version]|stats [bot|all]|chop [bot|all] [type]|plant [bot|all]|store [bot|all]|relocate [bot|all]|stop|team [status|assign <bot> <role>|auto]|support [status|request <bot> <kind> [detail]|fulfil <id>]]',
    execute: async (args) => {
      const sub = String(args[0] || 'status').toLowerCase();
      const team = services.woodcuttingTeam;
      const all = allActions(services);
      const rows = () => all.map((actions) => actions.woodcutting.status());
      const pick = (value) => {
        if (value === undefined || value === null || value === '' || isFleetTarget(value)) return null;
        return pickBot(services, value);
      };
      if (sub === 'status' || sub === 'stats') {
        const bot = pick(args[1]);
        const list = bot ? [actionsFor(services, bot.name).woodcutting.status()] : rows();
        const lifetime = list.reduce((out, row) => {
          for (const [key, value] of Object.entries(row.lifetime || row.stats || {})) {
            if (typeof value === 'number') out[key] = (out[key] || 0) + value;
          }
          return out;
        }, {});
        return {
          ok: true, command: `woodcutting ${sub}`, rows: list, lifetime,
          team: team ? team.status() : null,
          total: {
            logs: list.reduce((sum, row) => sum + (row.logs || 0), 0),
            saplings: list.reduce((sum, row) => sum + (row.saplings || 0), 0),
            treesChopped: list.reduce((sum, row) => sum + (row.treesChopped || 0), 0),
            replanted: list.reduce((sum, row) => sum + (row.replanted || 0), 0)
          }
        };
      }
      if (sub === 'catalog' || sub === 'species') {
        const version = args[1] || (services.runtime && services.runtime.serverVersion) || null;
        const list = catalogue({ version });
        return { ok: true, command: 'woodcutting catalog', version, species: list };
      }
      if (sub === 'trees' || sub === 'scan') {
        const named = args[1] && isBotName(services, args[1]) ? args[1] : null;
        const actions = named ? actionsFor(services, named) : all[0];
        if (!actions) throw new CommandError('no bot is available for a tree scan');
        const rest = args.slice(named ? 2 : 1);
        const numeric = rest.find((value) => /^\d+$/.test(String(value)));
        const radius = numeric ? intArg(numeric, 'radius', { min: 4, max: 64 }) : 32;
        const typeArg = rest.find((value) => !/^\d+$/.test(String(value)) && !isFleetTarget(value));
        const trees = actions.woodcutting.findTrees({ radius, limit: 20, types: typeArg || null });
        return {
          ok: true, command: 'woodcutting trees', bot: actions.bot.name, radius,
          type: typeArg || 'any', count: trees.length, trees,
          zone: actions.woodcutting.zone()
        };
      }
      if (sub === 'stop') {
        if (args[1] !== undefined && !isFleetTarget(args[1]) && !isBotName(services, args[1])) {
          throw new CommandError(`unknown bot or fleet target '${args[1]}'`);
        }
        const target = isBotName(services, args[1]) ? args[1] : null;
        const results = (target ? [actionsFor(services, target)] : all).map((actions) => ({ bot: actions.bot.name, ...actions.woodcutting.stop() }));
        return { ok: true, command: 'woodcutting stop', stopped: true, results };
      }
      if (sub === 'chop') {
        const namedTarget = args[1] && (isFleetTarget(args[1]) || isBotName(services, args[1])) ? args[1] : null;
        const types = args.slice(namedTarget ? 2 : 1).join(' ').trim();
        const line = [types || 'any'];
        if (namedTarget && isFleetTarget(namedTarget)) {
          const fleet = await runFleetActions(services, 'all', (actions) => runBotAction(
            services, actions.bot, [actions.bot.name, 'chop', ...line], {}
          ));
          const chopped = (fleet.results || []).reduce((sum, row) => sum + (Number(row.chopped) || 0), 0);
          return {
            ...fleet, command: 'woodcutting chop', chopped, verified: chopped > 0,
            ok: fleet.ok && chopped > 0,
            error: chopped > 0 ? undefined : (fleet.results || []).map((row) => row.error).filter(Boolean).join('; ') || 'no tree was chopped and verified'
          };
        }
        const bot = pick(namedTarget);
        const result = await runBotAction(services, bot, [bot.name, 'chop', ...line], {});
        return { ...result, command: 'woodcutting chop', verified: Number(result.chopped) > 0 };
      }
      if (sub === 'plant') {
        const target = args[1] && (isFleetTarget(args[1]) || isBotName(services, args[1])) ? args[1] : null;
        if (target && isFleetTarget(target)) {
          return runFleetActions(services, 'all', (actions) => actions.woodcutting.plantNearby({ limit: 3 }));
        }
        const bot = pick(target);
        return { ok: true, bot: bot.name, ...(await actionsFor(services, bot.name).woodcutting.plantNearby({ limit: 6 })) };
      }
      if (sub === 'store') {
        const target = args[1] && isBotName(services, args[1]) ? args[1] : null;
        if (!target && isFleetTarget(args[1])) {
          return runFleetActions(services, 'all', (actions) => actions.woodcutting.storeLoot());
        }
        const bot = pick(target || args[1]);
        return {
          ok: true, bot: bot.name,
          ...(await withBotExclusive(services, bot, () => actionsFor(services, bot.name).woodcutting.storeLoot()))
        };
      }
      if (sub === 'relocate') {
        const bot = pick(args[1]);
        const actions = bot ? actionsFor(services, bot.name) : all[0];
        if (!actions) throw new CommandError('no bot is available');
        return { ok: true, bot: actions.bot.name, ...(await actions.woodcutting.relocateForTrees()) };
      }
      if (sub === 'team') {
        if (!team) throw new CommandError('woodcutting team coordinator unavailable');
        const action = String(args[1] || 'status').toLowerCase();
        if (action === 'status') return { ok: true, command: 'woodcutting team', ...team.status() };
        if (action === 'auto') return { ok: true, command: 'woodcutting team auto', ...team.autoAssign({ reset: args[2] === 'reset' }) };
        if (action === 'assign' || action === 'role') {
          const bot = args[2];
          const role = args[3];
          if (!isBotName(services, bot) || !role) throw new CommandError('usage: woodcutting team assign <bot> <CHOPPER|SCOUT|HAULER|PLANTER|GUARD>');
          const result = team.setRole(bot, role);
          if (!result.ok) throw new CommandError(result.error);
          return { ok: true, command: 'woodcutting team assign', ...result, team: team.status() };
        }
        throw new CommandError('usage: woodcutting team [status|assign <bot> <role>|auto]');
      }
      if (sub === 'support') {
        if (!team) throw new CommandError('woodcutting team coordinator unavailable');
        const action = String(args[1] || 'status').toLowerCase();
        if (action === 'status') return { ok: true, command: 'woodcutting support', open: team.support({ status: 'open' }), recent: team.requests.slice(-10) };
        if (action === 'request') {
          const bot = args[2];
          if (!isBotName(services, bot)) throw new CommandError('usage: woodcutting support request <bot> <kind> [detail]');
          const kind = args[3] || 'HELP';
          const detail = args.slice(4).join(' ') || null;
          const actions = actionsFor(services, bot);
          return { ok: true, command: 'woodcutting support request', ...actions.woodcutting.requestSupport({ kind, detail }) };
        }
        if (action === 'fulfil' || action === 'fulfill') {
          if (!args[2]) throw new CommandError('usage: woodcutting support fulfil <id>');
          const result = team.fulfil(args[2], args[3] || 'operator');
          if (!result.ok) throw new CommandError(result.error);
          return { ok: true, command: 'woodcutting support fulfil', ...result };
        }
        throw new CommandError('usage: woodcutting support [status|request <bot> <kind> [detail]|fulfil <id>]');
      }
      throw new CommandError(`unknown woodcutting action '${sub}'`);
    }
  });

  registry.register({
    name: 'farm', category: 'farming', summary: 'Harvest mature crops, establish or maintain a tilled/watered farm, feed animals', usage: 'farm [bot|all] [harvest|wheat|carrots|potatoes|beetroot|pumpkin|melon|plant [crop] [count]|maintain|status|animals|stop]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop') {
        const results = allActions(services).map((actions) => actions.farming.stop());
        return { ok: true, stopped: true, results };
      }
      if (isFleetTarget(first)) {
        const requested = args.slice(1).join(' ').trim().toLowerCase();
        if (requested === 'stop') {
          return { ok: true, stopped: true, results: allActions(services).map((actions) => actions.farming.stop()) };
        }
        if (requested === 'status') {
          return { ok: true, bots: allActions(services).map((actions) => ({ bot: actions.bot.name, ...actions.farming.status() })) };
        }
        return runFleetActions(services, 'all', (actions) => runBotAction(
          services, actions.bot, [actions.bot.name, 'farm', ...args.slice(1)], {}
        ));
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const rest = named ? args.slice(1) : args;
      const requested = rest.join(' ').trim().toLowerCase();
      if (requested === 'stop') return { ok: true, ...actionsFor(services, pickBot(services, named).name).farming.stop() };
      const bot = pickBot(services, named);
      return runBotAction(services, bot, [bot.name, 'farm', ...(rest.length ? rest : [])], {});
    }
  });

  registry.register({
    name: 'fish', category: 'farming', summary: 'Fish from real water with a fishing rod', usage: 'fish [bot|all] [casts] | fish stop [bot|all]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop' || String(args[1] || '').toLowerCase() === 'stop') {
        // Both `fish stop all` and `fish all stop` are natural; accept either.
        const targetToken = first === 'stop' ? args[1] : args[0];
        const target = String(targetToken || 'all').toLowerCase();
        const targets = isFleetTarget(target) ? allActions(services) : [actionsFor(services, pickBot(services, targetToken).name)];
        const results = targets.map((actions) => actions.fishing.stop());
        return { ok: true, stopped: results };
      }
      if (isFleetTarget(first)) {
        const casts = args[1] === undefined ? 1 : intArg(args[1], 'casts', { min: 1, max: 3 });
        const fleet = await runFleetActions(services, 'all', (actions) => withBotExclusive(services, actions.bot, () => actions.fishing.tick({ casts })));
        return { ...fleet, ok: fleet.completed > 0 && fleet.results.every((result) => result.ok), caught: fleet.results.reduce((sum, result) => sum + (result.caught || 0), 0) };
      }
      const named = isBotName(services, args[0]) ? args[0] : null;
      const bot = pickBot(services, named);
      const rawCasts = named ? args[1] : args[0];
      const casts = rawCasts === undefined ? 1 : intArg(rawCasts, 'casts', { min: 1, max: 3 });
      return runBotAction(services, bot, [bot.name, 'fish', String(casts)], {});
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
        const results = await Promise.all(allActions(services).map(async (actions) => ({
          bot: actions.bot.name,
          ...(await withBotExclusive(services, actions.bot, () => actions.sleep.sleep()))
        })));
        return { ok: results.some((result) => result.ok !== false), results };
      }
      const bot = pickBot(services, args[0]);
      const actions = actionsFor(services, bot.name);
      if (String(args[1] || '').toLowerCase() === 'auto') {
        const value = String(args[2] || '').toLowerCase();
        if (!['on', 'off'].includes(value)) return { ok: true, bot: bot.name, auto: actions.sleep.auto };
        return actions.sleep.setAuto(value === 'on');
      }
      const health = connectionStatus(bot);
      if (!health.gameplayReady) return { ok: false, code: 'BOT_NOT_READY', status: health.status, error: `${bot.name} is not gameplay-ready (${health.statusLabel})` };
      const result = await withBotExclusive(services, bot, () => actions.sleep.sleep());
      return { ok: result.ok !== false, ...result };
    }
  });

  registry.register({
    name: 'defend', category: 'combat', summary: 'Defend against hostile mobs (PvP stays off); stop cancels', usage: 'defend [bot|all] | defend stop [bot|all]',
    execute: async (args) => {
      if (String(args[0] || '').toLowerCase() === 'stop') {
        const target = String(args[1] || 'all').toLowerCase();
        const targets = target === 'all' || target === 'fleet' ? allActions(services) : [actionsFor(services, pickBot(services, args[1]).name)];
        return { ok: true, stopped: targets.map((actions) => actions.combat.stop()) };
      }
      if (isFleetTarget(args[0])) {
        return runFleetActions(services, 'all', (actions) => runBotAction(
          services, actions.bot, [actions.bot.name, 'defend'], {}
        ));
      }
      const bot = pickBot(services, args[0]);
      return runBotAction(services, bot, [bot.name, 'defend'], {});
    }
  });

  registry.register({
    name: 'explore', category: 'exploration', summary: 'Explore the spiral and record discoveries; stop cancels', usage: 'explore [bot|all] [steps] | explore stop [bot|all]',
    execute: async (args) => {
      const first = String(args[0] || '').toLowerCase();
      if (first === 'stop' || String(args[1] || '').toLowerCase() === 'stop') {
        // Accept both `explore stop all` and `explore all stop`.
        const targetToken = first === 'stop' ? args[1] : args[0];
        const target = String(targetToken || 'all').toLowerCase();
        const targets = isFleetTarget(target) ? allActions(services) : [actionsFor(services, pickBot(services, targetToken).name)];
        return { ok: true, stopped: targets.map((actions) => actions.exploration.stop()) };
      }
      const fleet = isFleetTarget(args[0]);
      const named = fleet ? null : (isBotName(services, args[0]) ? args[0] : null);
      const rawSteps = fleet ? args[1] : (named ? args[1] : args[0]);
      const steps = rawSteps === undefined ? 4 : intArg(rawSteps, 'steps', { min: 1, max: 20 });
      if (fleet) {
        return runFleetActions(services, 'all', (actions) => runBotAction(
          services, actions.bot, [actions.bot.name, 'explore', String(steps)], {}
        ));
      }
      const bot = pickBot(services, named);
      return runBotAction(services, bot, [bot.name, 'explore', String(steps)], {});
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
      const home = services.runtime.home;
      const fleet = await runFleetActions(services, target, async (actions) => {
        const result = await withBotExclusive(services, actions.bot, () => actions.bot.goTo(home, {
          range: 3, timeoutMs: 30000, priority: 'operator', owner: 'return-home', adjustY: true
        }));
        return { ok: result.ok !== false, position: { ...actions.bot.position }, error: result.error };
      });
      return { ...fleet, home };
    }
  });

  registry.register({
    name: 'task', category: 'task', summary: 'Task manager: list, add, assign, cancel, retry, objectives', usage: 'task <list|add|assign|priority|cancel|retry|info|objective> ...',
    execute: async (args, context = {}) => {
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
        const parsed = parseTaskParams(args.slice(2));
        validateTaskParams(type, parsed.params);
        const label = parsed.label || type;
        const result = services.taskBoard.addTask({
          type, label, priority: 50, params: parsed.params,
          sourceCommand: context && context.line ? context.line : null,
          createdBy: context && context.operator ? context.operator : null
        });
        if (!result.ok) return result;
        return { ok: true, task: result.task, params: result.task.params };
      }
      if (sub === 'assign') {
        const task = services.taskBoard.getTask(args[1]);
        if (!task) return { ok: false, error: 'unknown task' };
        if (['COMPLETED', 'CANCELLED'].includes(task.status)) return { ok: false, error: `cannot assign a ${task.status.toLowerCase()} task` };
        const bot = pickBot(services, args[2]);
        const assigned = services.coordinator
          ? services.coordinator.assignTask(bot.name, task.id)
          : services.taskBoard.claim(task.id, bot.name, { force: true });
        if (!assigned.ok) return { ok: false, error: assigned.error };
        return { ok: true, task: assigned.task || task, assignedTo: bot.name, releasedPrevious: Boolean(assigned.releasedPrevious) };
      }
      if (sub === 'cancel') {
        const task = services.taskBoard.getTask(args[1]);
        const result = services.taskBoard.cancel(args[1], 'cancelled by operator');
        if (task && services.coordinator) {
          for (const [name, assignment] of [...services.coordinator.assignments]) {
            if (assignment.taskId === task.id) services.coordinator.clearAssignment(name);
          }
        }
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
        const owner = task.claimedBy;
        if (['CLAIMED', 'ACTIVE'].includes(task.status) && owner) {
          services.taskBoard.release(task.id, owner, 'operator retry');
        }
        task.status = 'PENDING';
        task.claimedBy = null;
        task.claimedAt = null;
        task.claimExpiresAt = null;
        task.completedAt = null;
        task.lastError = null;
        task.verification = null;
        task.attempts = 0;
        task.stallCycles = 0;
        task.noProgressSince = null;
        task.lastProgressValue = task.units ? task.units.current : 0;
        if (services.coordinator) {
          for (const [name, assignment] of [...services.coordinator.assignments]) {
            if (assignment.taskId === task.id || name === owner) services.coordinator.clearAssignment(name);
          }
        }
        return { ok: true, task };
      }
      if (sub === 'fleet' || sub === 'assignall') {
        const type = String(args[1] || '').toUpperCase();
        if (!TASK_TYPES.has(type)) throw new CommandError(`invalid task type '${type}'`);
        const parsed = parseTaskParams(args.slice(2));
        validateTaskParams(type, parsed.params);
        const objective = services.taskBoard.createObjective({
          title: `Fleet ${type}${parsed.label ? `: ${parsed.label}` : ''}`,
          description: 'One command, one task per roster member.',
          priority: 50,
          assignedBots: BOT_NAMES.slice(),
          metadata: { source: 'task fleet', params: parsed.params }
        });
        const assigned = [];
        for (const name of BOT_NAMES) {
          const created = services.taskBoard.addTask({
            type, label: `${parsed.label || type} (${name})`, priority: 50,
            params: { ...parsed.params },
            objectiveId: objective.id,
            sourceCommand: context && context.line ? context.line : null,
            createdBy: context && context.operator ? context.operator : null
          });
          if (!created.ok) { assigned.push({ bot: name, ok: false, error: created.error }); continue; }
          const claim = services.coordinator
            ? services.coordinator.assignTask(name, created.task.id)
            : services.taskBoard.claim(created.task.id, name, { force: true });
          assigned.push({ bot: name, ok: claim.ok !== false, taskId: created.task.id, error: claim.error });
        }
        return {
          ok: assigned.every((entry) => entry.ok),
          objectiveId: objective.id, type, params: parsed.params,
          tasks: assigned.filter((entry) => entry.taskId).length,
          assigned
        };
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
  registerCombat(registry, services);
  registerPlayers(registry, services);
  registerConstruction(registry, services);
  registerSchematics(registry, services);

  registry.register({
    name: 'batch', category: 'task', summary: 'Run several effectful actions in order, for one bot or the whole fleet', usage: 'batch <bot|all> <action> [args] then <action> [args] ...',
    execute: async (args, context = {}) => {
      if (!args.length) throw new CommandError('usage: batch <bot|all> <action> [args] then <action> [args] ...');
      const target = String(args[0]).toLowerCase();
      const fleet = isFleetTarget(target);
      if (!fleet && !isBotName(services, target)) throw new CommandError(`unknown bot ${target}; use a roster name or all`);
      const steps = [];
      let current = [];
      for (const token of args.slice(1)) {
        if (String(token).toLowerCase() === 'then') {
          if (current.length) steps.push(current);
          current = [];
        } else current.push(token);
      }
      if (current.length) steps.push(current);
      if (!steps.length) throw new CommandError('batch needs at least one action');
      const bot = fleet ? null : pickBot(services, target);
      const runOne = (step) => (fleet
        ? runFleetActions(services, 'all', (actions) => runBotAction(services, actions.bot, [actions.bot.name, ...step], context))
        : runBotAction(services, bot, [bot.name, ...step], context));
      const results = [];
      for (const step of steps) {
        // Steps are sequential: a later step such as "return home" must see the
        // world/inventory produced by the previous one.
        const result = await runOne(step);
        results.push({ action: step.join(' '), ...result });
        if (result.ok === false) break;
      }
      return {
        ok: results.length === steps.length && results.every((result) => result.ok !== false),
        target, steps: steps.length, completedSteps: results.length, results
      };
    }
  });

  registry.register({
    name: 'queue', category: 'core', summary: 'Inspect or repair the join/reconnect queue', usage: 'queue <status|retry <bot|all>|cooldown reset>',
    execute: async (args) => {
      if (!services.runtime) throw new CommandError('no runtime available');
      const action = args[0] || 'status';
      if (action === 'status') {
        const state = services.runtime.state();
        return {
          ok: true,
          joinQueue: state.joinQueue,
          bots: state.bots.map((bot) => ({ name: bot.name, ready: bot.ready, spawn: bot.lastSpawn ? { at: bot.lastSpawn.at, safe: bot.lastSpawn.safe } : null, timings: bot.stageTimings }))
        };
      }
      if (action === 'retry') {
        const target = args[1];
        if (!target) throw new CommandError('queue retry requires a bot name or "all"');
        const names = target === 'all' ? BOT_NAMES : [target];
        for (const name of names) if (!services.bots.has(name)) throw new CommandError(`unknown bot ${name}; roster: ${BOT_NAMES.join(', ')}`);
        const results = [];
        for (const name of names) results.push(await services.runtime.reconnectBot(name));
        return { ok: results.every((result) => result.ok !== false), results };
      }
      if (action === 'cooldown' && args[1] === 'reset') {
        const previous = { cooldownUntil: services.runtime.joinCooldownUntil || null, strikes: services.runtime.throttleStrikes || 0 };
        services.runtime.joinCooldownUntil = 0;
        services.runtime.throttleStrikes = 0;
        services.runtime.nextJoinAt = 0;
        return { ok: true, cleared: previous };
      }
      throw new CommandError('usage: queue <status|retry <bot|all>|cooldown reset>');
    }
  });

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
    const bots = [...services.bots.values()];
    if (!bots.length) throw new CommandError('no bots connected');
    const world = services.world || botWorldView(bots[0]);
    if (!world) throw new CommandError('no world available');
    const schematic = services.library.build(design.id);
    const base = origin || (services.runtime && services.runtime.home ? services.runtime.home : bots[0].position);
    const buildOrigin = origin || { x: Math.floor(base.x) + 4, y: Math.floor(base.y) + 1, z: Math.floor(base.z) + 4 };
    const builder = new SchematicBuilder({
      schematic, origin: buildOrigin, world, bots,
      taskBoard: services.taskBoard, ledger: services.ledger, memory: services.memory, logger: services.logger
    });
    return { design, builder, origin: buildOrigin, analysis: builder.analyze() };
  };

  registry.register({
    name: 'build', category: 'builder', summary: 'Select, preview, start and control validated schematic builds', usage: 'build select <id> | build preview [id] [x y z] | build start [run] | build status|list|pause|resume|stop|run [id] [steps] | build <id> [x y z] [run]',
    dangerous: true,
    execute: async (args, ctx) => {
      const sub = (args[0] || '').toLowerCase();
      if (['plan', 'phase', 'phases', 'progress', 'assign', 'verify', 'repair', 'finish', 'projects'].includes(sub)) {
        if (!services.construction) return { ok: false, error: 'construction manager unavailable' };
        const manager = services.construction;
        const project = manager.activeProject();
        if (sub === 'projects') return { ok: true, projects: manager.list(), activeId: manager.activeId };
        if (sub === 'phase' || sub === 'phases') {
          return project ? { ok: true, phase: manager.summary(project).phase, pipeline: project.buildPhases.map((phase) => ({ id: phase.id, status: phase.status, attempts: phase.attempts })), milestones: project.buildMilestones } : { ok: false, error: 'no active project' };
        }
        if (sub === 'progress') {
          return project ? { ok: true, project: manager.summary(project), builder: project.builderId && services.builders.get(project.builderId) ? services.builders.get(project.builderId).status() : null } : { ok: false, error: 'no active project' };
        }
        if (!project) return { ok: false, error: 'no active project; create one with builder create <schematic>' };
        if (sub === 'assign') {
          const bot = pickBot(services, args[1]);
          return manager.assign({ bot: bot.name, role: args.slice(2).join(' ') || 'FLEXIBLE' });
        }
        if (sub === 'plan') {
          if (!ctx.confirmed) return { ok: false, error: 'build planning can create cooperative tasks; append confirm', code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
          return manager.runPhase('BUILD_PLAN');
        }
        if (sub === 'verify') {
          const builder = project.builderId ? services.builders.get(project.builderId) : null;
          if (!builder) return { ok: false, error: 'no active builder for this project' };
          return { ok: true, verification: builder.verify({ includeExtras: true }), tripleCheck: builder.tripleCheck(), statuses: builder.engine.statusCounts() };
        }
        if (sub === 'repair') {
          if (!ctx.confirmed) return { ok: false, error: 'repair work requires confirmation (append confirm)', code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
          const builder = project.builderId ? services.builders.get(project.builderId) : null;
          if (!builder) return { ok: false, error: 'no active builder for this project' };
          builder.resume();
          const repair = await builder.repair(null, { includeExtras: args.includes('extras'), allowExtraRemoval: args.includes('extras') });
          return { ok: repair.complete, repair, verification: builder.verify({ includeExtras: true }) };
        }
        if (sub === 'finish') {
          if (!ctx.confirmed) return { ok: false, error: 'project handover requires confirmation (append confirm)', code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
          const quality = manager.runPhase('QUALITY_VERIFICATION');
          if (!quality.ok) return quality;
          return manager.runPhase('CLEANUP');
        }
      }
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
      if (sub === 'start' && (!args[1] || ['run', 'confirm'].includes(String(args[1]).toLowerCase()))) {
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
        if (changed.ok === false) return changed;
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
      if (sub === 'count') return { ok: true, count: library().count, minimum: library().minCount, meetsMinimum: library().count >= library().minCount };
      if (sub === 'tier') {
        const tier = args[1] || null;
        return { ok: true, tier, designs: library().list({ tier, limit: args[2] ? intArg(args[2], 'limit', { min: 1, max: 200 }) : 60 }) };
      }
      if (sub === 'preview') {
        const design = resolveDesign(services, args[1]);
        const schematic = library().build(design.id);
        return { ok: true, design: { id: design.id, name: design.name, tier: design.tier, dimensions: design.dimensions }, blocks: schematic.blocks.length, palette: schematic.palette, materials: design.materials };
      }
      if (sub === 'validate') {
        const sample = args[1] ? intArg(args[1], 'sample', { min: 1, max: 2000 }) : 40;
        const report = validateLibrary(library().manifest, { sampleSize: sample });
        return { ok: report.passed, report: { ...report, text: formatValidationReport(report) } };
      }
      if (sub === 'export') {
        const design = resolveDesign(services, args[1]);
        const format = (args[2] || 'schem').toLowerCase();
        const schematic = library().build(design.id);
        const dir = config.paths.exports;
        fs.mkdirSync(dir, { recursive: true });
        const modern = { litematic: 'litematic', nbt: 'vanilla-structure', structure: 'vanilla-structure', schem: 'sponge-schem', sponge: 'sponge-schem' }[format];
        if (modern) {
          const exported = exportSchematic(schematic, modern);
          const file = path.join(dir, `${design.id}${exported.extension}`);
          fs.writeFileSync(file, exported.buffer);
          return { ok: true, file, bytes: exported.buffer.length, format: modern, design: design.id, warnings: exported.warnings || [] };
        }
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
        if (!args[1]) return { ok: false, error: 'import requires a .schem/.litematic/.schematic/.nbt/.json file' };
        const store = library().customStore;
        if (!store) return { ok: false, error: 'custom schematic catalogue is disabled' };
        const file = path.resolve(args[1]);
        if (!fs.existsSync(file)) return { ok: false, error: `file not found: ${file}` };
        const name = args.slice(2).join(' ') || null;
        const result = store.importFile(file, { filename: path.basename(file), name, licence: 'UNKNOWN', source: 'cli' });
        if (!result.ok) return { ok: false, error: result.error || result.reason, duplicate: Boolean(result.duplicate), existing: result.existing || null };
        return {
          ok: true, id: result.entry.id, name: result.entry.name, format: result.entry.format,
          dimensions: result.entry.dimensions, blocks: result.entry.blocks,
          materials: Object.keys(result.entry.materials || {}).length,
          geometryHash: result.entry.geometryHash, validated: result.entry.validated,
          warnings: result.entry.warnings || [], buildWith: `build ${result.entry.id}`
        };
      }
      if (sub === 'custom') {
        const store = library().customStore;
        if (!store) return { ok: false, error: 'custom schematic catalogue is disabled' };
        const action = (args[1] || 'list').toLowerCase();
        if (action === 'scan') return { ok: true, ...store.scan({ persist: true }) };
        if (action === 'list') return { ok: true, count: store.count, stats: store.statsSummary(), designs: store.list({ limit: 200 }) };
        if (action === 'info') {
          const entry = store.get(args[2]);
          if (!entry) return { ok: false, error: `unknown custom schematic ${args[2] || ''}` };
          return { ok: true, design: entry, files: store.exportFormats || ['sponge-schem', 'litematic', 'vanilla-structure'] };
        }
        if (action === 'rename') return store.rename(args[2], args.slice(3).join(' '));
        if (action === 'tag') return store.tag(args[2], args.slice(3));
        if (action === 'licence' || action === 'license') return store.setLicence(args[2], args.slice(3).join(' '));
        if (action === 'duplicate') return store.duplicate(args[2], { name: args.slice(3).join(' ') || null });
        if (action === 'remove' || action === 'delete') return store.remove(args[2]);
        if (action === 'export') {
          const result = store.export(args[2], args[3] || 'sponge-schem');
          if (!result.ok) return result;
          fs.mkdirSync(config.paths.exports, { recursive: true });
          // The id came from an operator token. Never let it escape the export
          // directory: path.basename plus an allow-list of filename characters.
          const exportName = path.basename(String(args[2] || 'schematic')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'schematic';
          const file = path.join(config.paths.exports, `${exportName}${result.extension}`);
          fs.writeFileSync(file, result.buffer);
          return { ok: true, file, bytes: result.buffer.length, format: args[3] || 'sponge-schem' };
        }
        return { ok: false, error: `unknown custom action '${action}'` };
      }
      return { ok: false, error: `unknown schematics subcommand '${sub}'` };
    }
  });
}


function combatControllers(services) {
  if (!services.actions) throw new CommandError('action layer unavailable');
  return services.actions.list().map((actions) => actions.combat);
}

function combatCoordinator(services) {
  if (!services.combatTeam) throw new CommandError('team combat coordinator unavailable');
  return services.combatTeam;
}

async function teamAttack(services, playerName) {
  const name = String(playerName || '').toLowerCase();
  const controllers = combatControllers(services);
  for (const controller of controllers) {
    controller.addTarget(name);
    controller.setPvp(true);
  }
  const results = [];
  for (const controller of controllers) {
    const target = controller.bot.entitiesNear(64).find((entity) => String(entity.username || entity.name || '').toLowerCase() === name);
    if (!target) { results.push({ bot: controller.bot.name, ok: false, error: 'authorised player is not currently visible' }); continue; }
    results.push({ bot: controller.bot.name, ...(await withBotExclusive(services, controller.bot, () => controller.engage({ target, maxAttacks: 10 }))) });
  }
  return { ok: results.some((result) => result.ok !== false), target: name, results };
}

function registerCombat(registry, services) {
  const team = () => combatCoordinator(services);
  const controllers = () => combatControllers(services);

  registry.register({
    name: 'combat', category: 'combat', summary: 'Inspect or control the V6 combat engine and team fight', usage: 'combat [status|on|off|start|stop|mode|guard|duel|rescue|heal]',
    execute: async (args) => {
      const sub = String(args[0] || 'status').toLowerCase();
      if (sub === 'status') return { ok: true, team: team().status(), bots: controllers().map((controller) => controller.status()) };
      if (sub === 'on' || sub === 'off') {
        team().setEnabled(sub === 'on');
        const results = controllers().map((controller) => (sub === 'on' ? controller.arm() : controller.disarm()));
        return { ok: true, enabled: sub === 'on', results };
      }
      if (sub === 'start') {
        team().setEnabled(true);
        const results = [];
        for (const controller of controllers()) results.push({ bot: controller.bot.name, ...(await withBotExclusive(services, controller.bot, () => controller.engage({ maxAttacks: 10 }))) });
        return { ok: results.some((result) => result.ok !== false), results };
      }
      if (sub === 'stop') {
        const stopped = controllers().map((controller) => controller.stop());
        team().releaseLocks();
        return { ok: true, stopped, team: team().status() };
      }
      if (sub === 'mode') {
        if (!args[1]) return { ok: true, mode: team().mode, modes: ['TEAM_FIGHT', 'DEFENSIVE', 'GUARD', 'ARENA', 'RETREAT', 'ESCORT'] };
        return { ok: true, ...team().setMode(args[1]) };
      }
      if (sub === 'rescue') return { ok: true, ...(await team().autoRescue({ cooldownMs: 0 })) };
      if (sub === 'heal') return { ok: true, ...(await team().assistHealing({ cooldownMs: 0 })) };
      if (sub === 'guard') {
        const position = args.length >= 4 ? parseOrigin(args, 1) : null;
        const results = [];
        for (const controller of controllers()) results.push({ bot: controller.bot.name, ...(await withBotExclusive(services, controller.bot, () => controller.guard(position))) });
        return { ok: results.some((result) => result.ok !== false), results };
      }
      if (sub === 'duel') {
        if (!args[1]) throw new CommandError('usage: combat duel <authorised-player>');
        const results = controllers().map((controller) => ({ bot: controller.bot.name, ...controller.duel(args[1]) }));
        return { ok: results.every((result) => result.ok !== false), results };
      }
      return { ok: false, error: `unknown combat subcommand '${sub}'` };
    }
  });

  registry.register({
    name: 'pve', category: 'combat', summary: 'Enable or disable autonomous hostile-mob combat', usage: 'pve [on|off|status]',
    execute: async (args) => {
      const value = String(args[0] || 'status').toLowerCase();
      if (!['on', 'off', 'status'].includes(value)) throw new CommandError('usage: pve [on|off|status]');
      if (value === 'status') return { ok: true, pve: controllers().map((controller) => ({ bot: controller.bot.name, enabled: controller.pveEnabled, armed: controller.armed })) };
      const results = controllers().map((controller) => ({ bot: controller.bot.name, ...controller.setPve(value === 'on') }));
      return { ok: true, pveEnabled: value === 'on', results };
    }
  });

  registry.register({
    name: 'pvp', category: 'combat', summary: 'Explicit PvP gate; no random player is ever auto-targeted', usage: 'pvp [on|off|status]',
    execute: async (args) => {
      const value = String(args[0] || 'status').toLowerCase();
      if (!['on', 'off', 'status'].includes(value)) throw new CommandError('usage: pvp [on|off|status]');
      if (value === 'status') return { ok: true, pvp: controllers().map((controller) => ({ bot: controller.bot.name, ...controller.pvp.status() })), serverPvp: config.autonomy.serverPvp !== false };
      const results = controllers().map((controller) => ({ bot: controller.bot.name, ...controller.setPvp(value === 'on') }));
      return { ok: true, pvpEnabled: value === 'on', targets: controllers()[0] ? controllers()[0].pvp.list() : [], results };
    }
  });

  registry.register({
    name: 'target', aliases: ['targets'], category: 'combat', summary: 'Manage the explicit authorised PvP target list', usage: 'target <player> | target add <player> | target remove <player> | target clear | target list',
    execute: async (args) => {
      const sub = String(args[0] || 'list').toLowerCase();
      const list = controllers();
      if (sub === 'list') return { ok: true, targets: list[0] ? list[0].pvp.list() : [], protectedPlayers: list[0] ? list[0].pvp.listProtected() : [] };
      if (sub === 'clear') {
        for (const controller of list) { for (const target of controller.pvp.list()) controller.removeTarget(target); }
        return { ok: true, targets: [] };
      }
      const action = ['add', 'remove', 'protect', 'unprotect'].includes(sub) ? sub : 'add';
      const name = action === 'add' && sub !== 'add' ? args[0] : args[1];
      if (!name) throw new CommandError('usage: target <player> | target add|remove|protect|unprotect <player>');
      const results = list.map((controller) => {
        if (action === 'add') return { bot: controller.bot.name, ...controller.addTarget(name) };
        if (action === 'remove') return { bot: controller.bot.name, ...controller.removeTarget(name) };
        if (action === 'protect') return { bot: controller.bot.name, ...controller.protect(name) };
        return { bot: controller.bot.name, ...controller.unprotect(name) };
      });
      return { ok: results.every((result) => result.ok !== false), action, name, targets: list[0] ? list[0].pvp.list() : [], protectedPlayers: list[0] ? list[0].pvp.listProtected() : [], results };
    }
  });

  registry.register({
    name: 'gear', category: 'combat', summary: 'Evaluate weapons, armour, durability and upgrade priorities from real inventory', usage: 'gear [status|optimise|durability|progression|layout] [bot]',
    execute: async (args) => {
      const sub = String(args[0] || 'status').toLowerCase();
      const bot = pickBot(services, args[1] || null);
      const controller = actionsFor(services, bot.name).combat;
      if (sub === 'optimise' || sub === 'optimize') {
        // Equipping gear touches the same hands/inventory as a running task.
        // Take the operator lock so a concurrent mine/chop cannot be equipped
        // out from under and so the command cannot interleave two pathfinders.
        const prepared = await withBotExclusive(services, bot, () => controller.prepare(controller.assess().nearest));
        return { ok: true, bot: bot.name, prepared, gear: controller.gearStatus() };
      }
      if (sub === 'durability') return { ok: true, bot: bot.name, broken: controller.gearStatus().broken, weapon: controller.gearStatus().bestWeapon, shield: controller.gearStatus().shield };
      if (sub === 'layout') {
        if (typeof bot.layoutHotbar !== 'function') {
          const { itemSlot } = require('../combat/equipment');
          const layout = Object.keys(bot.inventory || {}).filter((name) => bot.countItem(name) > 0).map((name) => ({ name, slot: itemSlot(name) })).filter((row) => String(row.slot).startsWith('hotbar'));
          return { ok: true, bot: bot.name, applied: false, note: 'this adapter cannot reorder the hotbar; conceptual layout only', layout };
        }
        return { ok: true, bot: bot.name, ...(await withBotExclusive(services, bot, () => bot.layoutHotbar())) };
      }
      if (sub === 'progression' || sub === 'progress') {
        const { upgradePlan } = require('../combat/equipment');
        const plan = upgradePlan({ inventory: controller.bot.inventory || {}, meta: controller.meta || {}, target: controller.assess().nearest });
        return { ok: true, bot: bot.name, tier: plan.tier, next: plan.next, goals: plan.goals, objectives: plan.objectives, note: plan.note };
      }
      return { ok: true, bot: bot.name, gear: controller.gearStatus(), status: controller.status() };
    }
  });

  registry.register({
    name: 'totem', category: 'combat', summary: 'Inspect totems and refill reserves with verified physical transfers', usage: 'totem [status|reserve <n>|refill]',
    execute: async (args) => {
      const sub = String(args[0] || 'status').toLowerCase();
      const list = controllers();
      if (sub === 'status') return { ok: true, ledger: require('../combat/totems').teamTotemLedger(list), bots: list.map((controller) => controller.totemStatus()) };
      if (sub === 'reserve') {
        if (args[1] === undefined) return { ok: true, reserve: list[0] ? list[0].totems.reserve : 0, ledger: require('../combat/totems').teamTotemLedger(list) };
        const reserve = intArg(args[1], 'reserve', { min: 0, max: 9 });
        for (const controller of list) { controller.totems.reserve = reserve; controller.totems.criticalReserve = Math.min(reserve, 1); }
        return { ok: true, reserve, ledger: require('../combat/totems').teamTotemLedger(list) };
      }
      if (sub === 'refill') {
        const rows = [];
        for (const recipient of list) {
          if (recipient.totems.count() >= recipient.totems.reserve) { rows.push({ bot: recipient.bot.name, ok: true, already: true, totems: recipient.totems.count() }); continue; }
          const donor = list.find((entry) => entry !== recipient && entry.totems.count() > Math.max(entry.totems.reserve, 1) && entry.bot.countItem('totem_of_undying') > 0);
          if (!donor) { rows.push({ bot: recipient.bot.name, ok: false, error: 'no donor with surplus totems' }); continue; }
          await withBotExclusive(services, recipient.bot, () => recipient.bot.goNear(donor.bot, 2));
          const shared = await withBotExclusive(services, donor.bot, () => actionsFor(services, donor.bot.name).inventory.share('totem_of_undying', 1, recipient.bot));
          const equipped = shared.ok ? await withBotExclusive(services, recipient.bot, () => recipient.totems.equip({ force: true })) : { ok: false, error: shared.error };
          rows.push({ bot: recipient.bot.name, donor: donor.bot.name, shared, equipped, totems: recipient.totems.count() });
        }
        return { ok: rows.every((row) => row.ok !== false || row.already), rows, ledger: require('../combat/totems').teamTotemLedger(list) };
      }
      return { ok: false, error: `unknown totem subcommand '${sub}'` };
    }
  });

  registry.register({
    name: 'food', category: 'combat', summary: 'Show real food, golden apple and emergency supply inventory', usage: 'food [status] [bot]',
    execute: async (args) => {
      const name = String(args[0] || '').toLowerCase() === 'status' ? args[1] : args[0];
      const bot = pickBot(services, name);
      return { ok: true, bot: bot.name, supplies: actionsFor(services, bot.name).combat.foodStatus() };
    }
  });

  registry.register({
    name: 'potions', category: 'combat', summary: 'Show identified potions, effects and reserves', usage: 'potions status [bot]',
    execute: async (args) => {
      const bot = pickBot(services, args[1] || null);
      return { ok: true, bot: bot.name, supplies: actionsFor(services, bot.name).combat.foodStatus(), effects: { ...bot.effects } };
    }
  });

  registry.register({
    name: 'follow', category: 'combat', summary: 'Follow a teammate or visible player while defending against real threats', usage: 'follow <bot|player> [distance] | follow stop',
    execute: async (args) => {
      const requested = String(args[0] || '').trim();
      if (!requested) throw new CommandError('usage: follow <bot|player> [distance] | follow stop');
      if (requested.toLowerCase() === 'stop') {
        return { ok: true, stopped: combatControllers(services).map((controller) => ({ bot: controller.bot.name, ...controller.stopFollow() })) };
      }
      const distance = args[1] === undefined ? 4 : intArg(args[1], 'distance', { min: 2, max: 16 });
      const targetBot = services.bots ? services.bots.get(requested) : null;
      const results = [];
      for (const controller of combatControllers(services)) {
        if (targetBot && controller.bot === targetBot) { results.push({ bot: controller.bot.name, ok: true, skipped: 'follow target is this bot' }); continue; }
        const target = targetBot || requested.toLowerCase();
        results.push({ bot: controller.bot.name, ...(await controller.follow(target, { distance })) });
      }
      return { ok: results.some((result) => result.ok !== false), target: targetBot ? targetBot.name : requested.toLowerCase(), distance, results };
    }
  });

  registry.register({
    name: 'guard', category: 'combat', summary: 'Guard an area and attack hostile mobs that enter range', usage: 'guard <x> <y> <z> [bot] | guard stop',
    execute: async (args) => {
      if (String(args[0] || '').toLowerCase() === 'stop') return { ok: true, stopped: controllers().map((controller) => controller.stop()) };
      const position = parseOrigin(args, 0);
      const target = args[3] ? actionsFor(services, pickBot(services, args[3]).name).combat : controllers()[0];
      return { ok: true, ...(await withBotExclusive(services, target.bot, () => target.guard(position))) };
    }
  });

  registry.register({
    name: 'duel', category: 'combat', summary: 'Authorise one explicit duel target; server PvP rules still apply', usage: 'duel <authorised-player> [confirm]',
    dangerous: true,
    requiresConfirmation: true,
    execute: async (args) => {
      if (!args[0]) throw new CommandError('usage: duel <authorised-player> confirm');
      return { ok: true, results: controllers().map((controller) => ({ bot: controller.bot.name, ...controller.duel(args[0]) })) };
    }
  });

  registry.register({
    name: 'arena', category: 'combat', summary: 'Restrict PvP to an explicit arena around home or a supplied radius', usage: 'arena on [radius] | arena off',
    execute: async (args) => {
      const value = String(args[0] || 'status').toLowerCase();
      const list = controllers();
      if (value === 'off') {
        for (const controller of list) controller.pvp.arenas = [];
        return { ok: true, arenas: [] };
      }
      if (value === 'on') {
        const radius = intArg(args[1] === undefined ? 24 : args[1], 'radius', { min: 4, max: 128 });
        const home = services.runtime ? services.runtime.home : { x: 0, y: 64, z: 0 };
        const arena = { name: 'home-arena', enabled: true, min: { x: home.x - radius, y: home.y - 16, z: home.z - radius }, max: { x: home.x + radius, y: home.y + 32, z: home.z + radius } };
        for (const controller of list) controller.pvp.arenas = [arena];
        return { ok: true, arena };
      }
      return { ok: true, arenas: list[0] ? list[0].pvp.arenas : [] };
    }
  });
}

function registerPlayers(registry, services) {
  const registryForPlayers = () => {
    if (!services.players) throw new CommandError('player directory unavailable');
    return services.players;
  };
  const defaultTarget = () => pickBot(services).name;
  const controllerTargets = (target) => targetActions(services, target)
    .map((actions) => actions.players)
    .filter(Boolean);
  const targetOrDefault = (token) => (token && (isFleetTarget(token) || isBotName(services, token)) ? token : undefined);
  const validPlayer = (value) => {
    const name = String(value || '').trim();
    if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) throw new CommandError(`invalid player name '${value}'`);
    return name;
  };
  const validItem = (value) => {
    const name = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9_:]{1,64}$/.test(name)) throw new CommandError(`invalid item name '${value}'`);
    return name;
  };
  const runFor = async (target, fn) => {
    const list = targetActions(services, target);
    const results = [];
    for (const actions of list) {
      if (!actions.players) { results.push({ bot: actions.bot.name, ok: false, error: 'player controller unavailable' }); continue; }
      const health = connectionStatus(actions.bot);
      if (!health.gameplayReady) {
        results.push({
          bot: actions.bot.name, ok: false, skipped: true, code: 'BOT_NOT_READY',
          status: health.status, statusLabel: health.statusLabel,
          error: `not gameplay-ready (${health.statusLabel}): ${health.statusDetail}`
        });
        continue;
      }
      const run = services.runtime && typeof services.runtime.runExclusive === 'function'
        ? () => services.runtime.runExclusive(actions.bot.name, () => fn(actions))
        : () => fn(actions);
      try { results.push({ bot: actions.bot.name, ...(await run()) }); }
      catch (err) { results.push({ bot: actions.bot.name, ok: false, error: err.message }); }
    }
    const summary = runFleetSummary(results);
    return { ok: summary.ok, ...summary, results };
  };
  const runFleetSummary = (results) => {
    const completed = results.filter((row) => row.ok === true).length;
    return {
      completed,
      failed: results.filter((row) => row.ok === false).length,
      total: results.length,
      ok: completed > 0 && results.every((row) => row.ok !== false)
    };
  };

  registry.register({
    name: 'players', aliases: ['player'], category: 'players', maxArgs: 64,
    summary: 'Player directory, presence, teams/trust, follow/escort/observe, gifts and messages',
    usage: 'players [list [category]|near [radius]|info <player>|history <player>|events|refresh|follow <player> [bot|all] [distance]|escort <player> [bot|all]|guard <player> [bot|all] [radius]|observe <player> [bot|all]|unwatch [player] [bot|all]|unfollow [player] [bot|all]|come <player> [bot|all]|stop [bot|all]|give <player> <item> [count] [bot|all]|drop <player> [loot|item] [count] [bot|all]|message <player> <text>|greet <player>|note <player> <text>|tag <player> <tag>|untag <player> <tag>|forget <player>|pvp [status|on|off]|mode <EXPLICIT|ARENA|DEFENSIVE>|target [add|remove|list] [player]|protect|trust|unprotect|untrust <player>]',
    execute: async (args) => {
      const sub = String(args[0] || 'list').toLowerCase();
      const directory = registryForPlayers();
      if (sub === 'list' || sub === 'status') {
        const category = args[1] ? String(args[1]).toLowerCase() : null;
        // Roster bots are not player-directory entries; use `team state` for those.
        const categories = ['trusted', 'protected', 'target', 'neutral', 'unknown', 'staff'];
        if (category && !categories.includes(category)) throw new CommandError(`unknown player category '${args[1]}'; use ${categories.join('|')}`);
        const status = directory.status();
        const rows = category ? directory.list({ limit: 200, category }) : status.rows;
        return { ok: true, ...status, rows, players: rows, count: rows.length, filter: category };
      }
      if (sub === 'refresh' || sub === 'scan') {
        const bots = [...services.bots.values()].filter((bot) => bot.connected !== false && bot.ready !== false);
        for (const bot of bots) directory.observeBot(bot);
        const status = directory.status();
        return { ok: true, command: 'players refresh', scanned: bots.length, ...status, players: status.rows };
      }
      if (sub === 'events') {
        const limit = args[1] === undefined ? 25 : intArg(args[1], 'limit', { min: 1, max: 200 });
        return { ok: true, events: directory.recentEvents({ limit }), stats: directory.stats };
      }
      if (sub === 'near') {
        const radius = args[1] === undefined ? 64 : intArg(args[1], 'radius', { min: 1, max: 128 });
        const rows = directory.list({ limit: 200 }).filter((row) => row.distance !== null && row.distance <= radius);
        return { ok: true, radius, players: rows, count: rows.length };
      }
      if (sub === 'info') {
        const name = validPlayer(args[1]);
        const entry = directory.get(name);
        if (!entry) throw new CommandError(`${name} has not been seen by the fleet`);
        const watch = controllerTargets('all').map((controller) => controller.status()).filter((row) => String(row.target || '').toLowerCase() === name.toLowerCase());
        return {
          ok: true, player: directory.getRow(name), watch,
          history: directory.history(name, { limit: 25 })
        };
      }
      if (sub === 'history') {
        const name = validPlayer(args[1]);
        if (args[2] !== undefined) throw new CommandError('usage: players history <player> [limit]');
        const history = directory.history(name, { limit: 25 });
        if (!history) throw new CommandError(`${name} has not been seen by the fleet`);
        return { ok: true, ...history };
      }
      if (sub === 'note') {
        const name = validPlayer(args[1]);
        const text = args.slice(2).join(' ').trim();
        if (!text) throw new CommandError('usage: players note <player> <text>');
        return { command: 'players note', player: name, ...directory.note(name, text) };
      }
      if (sub === 'tag' || sub === 'untag') {
        const name = validPlayer(args[1]);
        if (!args[2]) throw new CommandError(`usage: players ${sub} <player> <tag>`);
        if (args[3] !== undefined) throw new CommandError(`usage: players ${sub} <player> <tag>`);
        return { command: `players ${sub}`, player: name, ...(sub === 'tag' ? directory.tag(name, args[2]) : directory.untag(name, args[2])) };
      }
      if (sub === 'forget' || sub === 'remove') {
        const name = validPlayer(args[1]);
        if (args[2] !== undefined) throw new CommandError('usage: players forget <player>');
        const result = directory.forget(name);
        return { command: 'players forget', player: name, ...result };
      }
      if (sub === 'pvp') {
        const action = String(args[1] || 'status').toLowerCase();
        const controller = targetActions(services, defaultTarget()).find((actions) => actions.combat);
        if (!controller) throw new CommandError('combat controller unavailable');
        if (action === 'status') {
          return { ok: true, command: 'players pvp', pvp: controller.combat.pvp.status(), serverPvp: config.autonomy.serverPvp !== false };
        }
        if (!['on', 'off'].includes(action)) throw new CommandError('usage: players pvp [status|on|off]');
        const results = targetActions(services, 'all').map((actions) => ({ bot: actions.bot.name, ...actions.combat.setPvp(action === 'on') }));
        return { ok: true, command: `players pvp ${action}`, enabled: action === 'on', pvp: controller.combat.pvp.status(), results };
      }
      if (sub === 'mode') {
        const mode = String(args[1] || '').toUpperCase();
        if (!mode) throw new CommandError('usage: players mode <EXPLICIT|ARENA|DEFENSIVE>');
        const controllers = targetActions(services, 'all').filter((actions) => actions.combat);
        if (!controllers.length) throw new CommandError('combat controller unavailable');
        const results = controllers.map((actions) => ({ bot: actions.bot.name, ...actions.combat.pvp.setMode(mode) }));
        if (results.every((row) => row.ok === false)) throw new CommandError(results[0].error || `unknown targeting mode ${mode}`);
        return { ok: true, command: 'players mode', mode, ...(controllers[0].combat.pvp.status()), results };
      }
      if (sub === 'target' || sub === 'targets') {
        const action = ['add', 'remove', 'list'].includes(String(args[1] || '').toLowerCase()) ? String(args[1]).toLowerCase() : 'add';
        const name = action === 'list' ? null : validPlayer(args[1] === action ? args[2] : args[1]);
        if (action === 'list') {
          const controller = targetActions(services, defaultTarget()).find((actions) => actions.combat);
          return {
            ok: true, command: 'players target list',
            targets: controller ? controller.combat.pvp.list() : [],
            protectedPlayers: controller ? controller.combat.pvp.listProtected() : [],
            trustedPlayers: controller ? controller.combat.pvp.listTrusted() : []
          };
        }
        const controllers = targetActions(services, 'all').filter((actions) => actions.combat);
        const results = controllers.map((actions) => ({
          bot: actions.bot.name,
          ...(action === 'add' ? actions.combat.addTarget(name) : actions.combat.removeTarget(name))
        }));
        return { ok: results.every((row) => row.ok !== false), command: `players target ${action}`, action, name, targets: controllers[0] ? controllers[0].combat.pvp.list() : [], results };
      }
      if (sub === 'arena') {
        const action = String(args[1] || 'list').toLowerCase();
        const controllers = targetActions(services, 'all').filter((actions) => actions.combat);
        if (!controllers.length) throw new CommandError('combat controller unavailable');
        const policy = controllers[0].combat.pvp;
        if (action === 'list' || action === 'status') {
          return { ok: true, command: 'players arena', arenas: policy.listArenas(), mode: policy.mode };
        }
        if (action === 'off' || action === 'clear') {
          const result = policy.clearArenas();
          return { ok: true, command: 'players arena clear', ...result };
        }
        if (action === 'on') {
          const radius = intArg(args[2] === undefined ? 24 : args[2], 'radius', { min: 4, max: 128 });
          const home = services.runtime ? services.runtime.home : { x: 0, y: 64, z: 0 };
          const result = policy.addArena({
            name: args[3] || 'home-arena', enabled: true,
            min: { x: home.x - radius, y: home.y - 16, z: home.z - radius },
            max: { x: home.x + radius, y: home.y + 32, z: home.z + radius }
          });
          if (!result.ok) throw new CommandError(result.error);
          return { ok: true, command: 'players arena on', radius, ...result };
        }
        if (action === 'add') {
          const name = args[2] && /^[A-Za-z0-9_-]{1,48}$/.test(args[2]) ? args[2] : null;
          if (!name) throw new CommandError('usage: players arena add <name> <x1> <y1> <z1> <x2> <y2> <z2>');
          if (args.length < 9) throw new CommandError('usage: players arena add <name> <x1> <y1> <z1> <x2> <y2> <z2>');
          const result = policy.addArena({
            name,
            min: { x: intArg(args[3], 'x1'), y: intArg(args[4], 'y1', { min: -64, max: 320 }), z: intArg(args[5], 'z1') },
            max: { x: intArg(args[6], 'x2'), y: intArg(args[7], 'y2', { min: -64, max: 320 }), z: intArg(args[8], 'z2') }
          });
          if (!result.ok) throw new CommandError(result.error);
          return { ok: true, command: 'players arena add', ...result };
        }
        if (action === 'remove' || action === 'delete') {
          if (!args[2]) throw new CommandError('usage: players arena remove <name>');
          return { ok: true, command: 'players arena remove', ...policy.removeArena(args[2]) };
        }
        throw new CommandError('usage: players arena [list|on [radius] [name]|add <name> <x1 y1 z1 x2 y2 z2>|remove <name>|clear]');
      }
      if (sub === 'protect' || sub === 'unprotect' || sub === 'trust' || sub === 'untrust') {
        const name = validPlayer(args[1]);
        if (args[2] !== undefined) throw new CommandError(`usage: players ${sub} <player>`);
        const controllers = targetActions(services, 'all').filter((actions) => actions.combat);
        const results = controllers.map((actions) => ({ bot: actions.bot.name, ...actions.combat[sub](name) }));
        return {
          ok: results.every((row) => row.ok !== false), command: `players ${sub}`, name, results,
          protectedPlayers: controllers[0] ? controllers[0].combat.pvp.listProtected() : [],
          trustedPlayers: controllers[0] ? controllers[0].combat.pvp.listTrusted() : []
        };
      }
      if (sub === 'following' || sub === 'watches') {
        if (args[2] !== undefined) throw new CommandError(`usage: players ${sub} [bot|all]`);
        if (args[1] !== undefined && !targetOrDefault(args[1])) throw new CommandError(`unknown bot or fleet target '${args[1]}'`);
        const target = targetOrDefault(args[1]) || 'all';
        const all = targetActions(services, target)
          .map((actions) => (actions.players ? actions.players.status() : null))
          .filter((row) => row && row.active);
        const results = sub === 'following' ? all.filter((row) => row.mode === 'FOLLOW') : all;
        return { command: `players ${sub}`, target, count: results.length, watches: results };
      }
      if (sub === 'stop') {
        if (args[2] !== undefined) throw new CommandError('usage: players stop [bot|all]');
        if (args[1] !== undefined && !targetOrDefault(args[1])) throw new CommandError(`unknown bot or fleet target '${args[1]}'`);
        const target = targetOrDefault(args[1]) || 'all';
        // Stop must clear a watch even for a bot that is currently offline;
        // otherwise it would resume following a stale player after reconnect.
        const results = targetActions(services, target).map((actions) => ({
          bot: actions.bot.name,
          ...(actions.players ? actions.players.stop() : { ok: false, error: 'player controller unavailable' })
        }));
        return { command: 'players stop', ok: results.every((row) => row.ok !== false), completed: results.length, results };
      }
      if (sub === 'unfollow') {
        // "unfollow" is narrower than "stop": it only clears a FOLLOW watch,
        // leaving a guard or escort in place. It also stays available for an
        // offline bot so a stale follow cannot resume after reconnect.
        const first = args[1];
        let player = null;
        let explicitTarget = first;
        if (first && !isFleetTarget(first) && !isBotName(services, first)) {
          player = validPlayer(first);
          explicitTarget = args[2];
          if (args[3] !== undefined) throw new CommandError('usage: players unfollow [player] [bot|all]');
        } else if (args[2] !== undefined) {
          // `players unfollow all Alex` must not silently ignore Alex and clear
          // every follow. Require the documented order.
          throw new CommandError('usage: players unfollow [player] [bot|all]');
        }
        if (explicitTarget !== undefined && !targetOrDefault(explicitTarget)) {
          throw new CommandError(`unknown bot or fleet target '${explicitTarget}'`);
        }
        const target = targetOrDefault(explicitTarget) || 'all';
        const results = targetActions(services, target).map((actions) => ({
          bot: actions.bot.name,
          ...(actions.players ? actions.players.unfollow(player) : { ok: false, error: 'player controller unavailable' })
        }));
        const cancelled = results.filter((row) => row.stopped).length;
        return {
          command: 'players unfollow', target, player,
          ok: results.every((row) => row.ok !== false),
          cancelled,
          already: results.filter((row) => row.already).length,
          completed: results.length,
          results
        };
      }
      if (sub === 'follow' || sub === 'guard' || sub === 'escort') {
        const name = validPlayer(args[1]);
        const numericTarget = args[2] !== undefined && /^\d+$/.test(String(args[2]));
        if (args[2] !== undefined && !numericTarget && !targetOrDefault(args[2])) {
          throw new CommandError(`unknown bot or fleet target '${args[2]}'`);
        }
        if (numericTarget && args[3] !== undefined) {
          throw new CommandError(`usage: players ${sub} <player> [bot|all] [${sub === 'follow' ? 'distance' : 'radius'}]`);
        }
        const target = numericTarget ? defaultTarget() : (targetOrDefault(args[2]) || defaultTarget());
        const rawValue = args[3] !== undefined ? args[3] : (numericTarget ? args[2] : undefined);
        const value = rawValue === undefined ? undefined : intArg(rawValue, sub === 'follow' ? 'distance' : 'radius', { min: sub === 'follow' ? 1 : 3, max: sub === 'follow' ? 8 : 16 });
        return {
          command: `players ${sub}`, target: name,
          ...(await runFor(target, (actions) => {
            if (sub === 'guard') return actions.players.guard(name, { radius: value });
            if (sub === 'escort') return actions.players.escort(name, { radius: value || 10, distance: 2 });
            return actions.players.follow(name, { distance: value });
          }))
        };
      }
      if (sub === 'observe' || sub === 'watch') {
        if (args[3] !== undefined) throw new CommandError(`usage: players ${sub} <player> [bot|all]`);
        if (args[2] !== undefined && !targetOrDefault(args[2])) throw new CommandError(`unknown bot or fleet target '${args[2]}'`);
        const name = validPlayer(args[1]);
        const target = targetOrDefault(args[2]) || defaultTarget();
        return { command: `players ${sub}`, target: name, ...(await runFor(target, (actions) => actions.players.observe(name))) };
      }
      if (sub === 'unwatch') {
        if (args[3] !== undefined) throw new CommandError('usage: players unwatch [player] [bot|all]');
        if (args[2] !== undefined && !targetOrDefault(args[2])) throw new CommandError(`unknown bot or fleet target '${args[2]}'`);
        const name = args[1] === undefined || isFleetTarget(args[1]) ? null : validPlayer(args[1]);
        const target = targetOrDefault(name ? args[2] : args[1]) || defaultTarget();
        const results = targetActions(services, target).map((actions) => ({ bot: actions.bot.name, ...(actions.players ? actions.players.unwatch(name) : { ok: false, error: 'player controller unavailable' }) }));
        return { ok: results.every((row) => row.ok !== false), command: 'players unwatch', target, stopped: results.filter((row) => row.stopped).length, results };
      }
      if (sub === 'come') {
        if (args[3] !== undefined) throw new CommandError('usage: players come <player> [bot|all]');
        if (args[2] !== undefined && !targetOrDefault(args[2])) throw new CommandError(`unknown bot or fleet target '${args[2]}'`);
        const name = validPlayer(args[1]);
        const target = targetOrDefault(args[2]) || defaultTarget();
        return { command: 'players come', target: name, ...(await runFor(target, (actions) => actions.players.come(name))) };
      }
      if (sub === 'give') {
        const name = validPlayer(args[1]);
        const item = validItem(args[2]);
        const rest = args.slice(3);
        const trailing = targetOrDefault(rest[rest.length - 1]);
        if (trailing) rest.pop();
        if (rest.length > 1) throw new CommandError('usage: players give <player> <item> [count] [bot|all]');
        const count = rest[0] === undefined ? 1 : intArg(rest[0], 'count', { min: 1, max: 2304 });
        const target = trailing || defaultTarget();
        return { command: 'players give', target: name, item, count, ...(await runFor(target, (actions) => actions.players.give(name, item, count))) };
      }
      if (sub === 'drop' || sub === 'loot') {
        const name = validPlayer(args[1]);
        const rest = args.slice(2);
        const trailing = targetOrDefault(rest[rest.length - 1]);
        if (trailing) rest.pop();
        if (rest.length > 2) throw new CommandError('usage: players drop <player> [loot|item] [count] [bot|all]');
        let item = 'loot';
        let count = null;
        if (rest[0] !== undefined && /^\d+$/.test(String(rest[0]))) {
          count = intArg(rest[0], 'count', { min: 1, max: 2304 });
        } else if (rest[0] !== undefined) {
          item = validItem(rest[0]);
          if (rest[1] !== undefined) count = intArg(rest[1], 'count', { min: 1, max: 2304 });
        }
        const target = trailing || defaultTarget();
        return { command: 'players drop', target: name, item, ...(await runFor(target, (actions) => actions.players.dropLoot(name, { item, count }))) };
      }
      if (sub === 'message' || sub === 'msg' || sub === 'tell') {
        const name = validPlayer(args[1]);
        const tokens = args.slice(2);
        let sender = defaultTarget();
        const flag = tokens.indexOf('--bot');
        if (flag >= 0) {
          const value = tokens[flag + 1];
          if (!value) throw new CommandError('--bot needs a roster name or all');
          // A message from the whole fleet would spam the player five times.
          // "all" therefore means "the leader speaks for the fleet".
          sender = isFleetTarget(value) ? defaultTarget() : value;
          if (!isBotName(services, sender)) throw new CommandError(`--bot needs a roster name, got '${value}'`);
          tokens.splice(flag, 2);
        }
        const text = tokens.join(' ');
        if (!text) throw new CommandError('players message needs text');
        return { command: 'players message', target: name, ...(await runFor(sender, (actions) => actions.players.message(name, text))) };
      }
      if (sub === 'greet' || sub === 'wave') {
        if (args[3] !== undefined) throw new CommandError('usage: players greet <player> [bot|all]');
        if (args[2] !== undefined && !targetOrDefault(args[2])) throw new CommandError(`unknown bot or fleet target '${args[2]}'`);
        const name = validPlayer(args[1]);
        const target = targetOrDefault(args[2]) || defaultTarget();
        return { command: 'players greet', target: name, ...(await runFor(target, (actions) => actions.players.greet(name))) };
      }
      throw new CommandError(`unknown players action '${sub}'`);
    }
  });
}

function registerConstruction(registry, services) {
  const manager = () => {
    if (!services.construction) throw new CommandError('construction manager unavailable');
    return services.construction;
  };
  const projectOrThrow = () => {
    const project = manager().activeProject();
    if (!project) throw new CommandError('no active project; create one with builder create <schematic> [x y z]');
    return project;
  };
  const compactCandidates = (candidates = []) => candidates.map((candidate) => ({
    id: candidate.id, origin: candidate.origin, score: candidate.score, factors: candidate.factors,
    reasons: candidate.reasons, stats: candidate.stats, overlaps: candidate.overlaps || []
  }));

  registry.register({
    name: 'builder', aliases: ['project'], category: 'builder',
    summary: 'Manage construction projects and the full site-to-handover pipeline',
    usage: 'builder [projects|create <schematic> [x y z]|select <id>|status|preview|advance [phases] confirm|run confirm|auto on/off|pause|resume|stop|phases|report|assign <bot> <role>|priority <id> <0-100>]',
    dangerous: true,
    execute: async (args, ctx) => {
      const sub = (args[0] || 'status').toLowerCase();
      const m = manager();
      if (sub === 'projects' || sub === 'list' || sub === 'history') return { ok: true, projects: m.list(), activeId: m.activeId };
      if (sub === 'create') {
        if (!args[1]) throw new CommandError('usage: builder create <schematicId|number|query> [x y z] [rotation]');
        const design = resolveDesign(services, args[1]);
        let origin = null;
        let rotation = 0;
        const numeric = args[2] !== undefined && Number.isFinite(Number(args[2]));
        if (numeric && args[4] !== undefined) origin = parseOrigin(args, 2);
        else if (numeric) origin = { x: intArg(args[2], 'x'), z: intArg(args[3], 'z') };
        if (args[5] !== undefined) rotation = intArg(args[5], 'rotation', { min: 0, max: 359 });
        if (![0, 90, 180, 270].includes(rotation)) throw new CommandError('rotation must be 0, 90, 180 or 270');
        const result = m.createProject({ schematicId: design.id, origin, rotation });
        return result;
      }
      if (sub === 'select' || sub === 'activate') {
        if (!args[1]) throw new CommandError('usage: builder select <projectId>');
        const result = m.setActive(args[1]);
        if (!result.ok) return result;
        return { ok: true, project: result.project };
      }
      if (sub === 'status' || sub === 'report') {
        if (sub === 'report') return m.report();
        const project = m.activeProject();
        return { ok: true, state: m.state(), report: project ? m.report() : null };
      }
      if (sub === 'phases') {
        const project = projectOrThrow();
        return { ok: true, pipeline: project.buildPhases.map((phase) => ({ id: phase.id, name: phase.name, status: phase.status, attempts: phase.attempts, detail: phase.detail })), milestones: project.buildMilestones };
      }
      if (sub === 'preview') return m.preview();
      if (sub === 'advance' || sub === 'run' || sub === 'start') {
        if (!ctx.confirmed) return { ok: false, error: `${sub} performs site preparation and world changes; append confirm`, code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
        projectOrThrow();
        m.setAutonomy(true);
        if (sub === 'advance') return m.advance({ maxPhases: args[1] ? intArg(args[1], 'phases', { min: 1, max: 19 }) : 1 });
        return m.run({ maxPhases: args[1] ? intArg(args[1], 'phases', { min: 1, max: 76 }) : 76 });
      }
      if (sub === 'auto') return m.setAutonomy(String(args[1] || 'on').toLowerCase() === 'on');
      if (sub === 'pause') return m.pause();
      if (sub === 'resume') return m.resume();
      if (sub === 'stop' || sub === 'cancel') return m.cancel();
      if (sub === 'assign') {
        if (!args[1]) throw new CommandError('usage: builder assign <bot> <role>');
        const bot = pickBot(services, args[1]);
        return m.assign({ bot: bot.name, role: args.slice(2).join(' ') || 'FLEXIBLE' });
      }
      if (sub === 'priority') {
        if (!args[1]) throw new CommandError('usage: builder priority <projectId> <0-100>');
        const priority = intArg(args[2], 'priority', { min: 0, max: 100 });
        return m.setPriority(args[1], priority);
      }
      return { ok: false, error: `unknown builder subcommand '${sub}'` };
    }
  });

  registry.register({
    name: 'site', category: 'builder', summary: 'Survey, select and prepare a construction site',
    usage: 'site [survey|candidates|select [x y z|site-id] confirm|boundaries|preview [clear|light]|clear confirm|excavate confirm|flatten confirm|drain confirm|light confirm|audit|secure confirm|status]',
    dangerous: true,
    execute: async (args, ctx) => {
      const sub = (args[0] || 'status').toLowerCase();
      const m = manager();
      if (sub === 'status') {
        const project = m.activeProject();
        if (!project) return { ok: true, active: false, project: null, message: 'No active construction project; create one with builder create.' };
        return {
          ok: true, active: true, project: m.summary(project), preparation: project.sitePreparation,
          boundaries: project.sitePreparation.boundaries, pipeline: project.buildPhases.filter((phase) => ['SURVEY', 'SITE_SELECTION', 'CLEARANCE', 'EXCAVATION', 'LEVELLING', 'DRAINAGE', 'LIGHTING', 'PERIMETER', 'TEMPORARY_STORAGE'].includes(phase.id))
        };
      }
      if (sub === 'survey' || sub === 'candidates') {
        projectOrThrow();
        const result = m.surveyActive({ candidates: true });
        if (!result.ok) return result;
        return { ok: true, survey: { origin: result.survey.origin, footprint: result.survey.footprint, samples: result.survey.samples, stats: result.survey.stats, hazards: result.survey.hazards }, score: result.score, candidates: compactCandidates(result.candidates), recommended: result.recommended ? { id: result.recommended.id, origin: result.recommended.origin, score: result.recommended.score } : null };
      }
      if (sub === 'select') {
        if (!ctx.confirmed) return { ok: false, error: 'site selection is a commitment; append confirm', code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
        projectOrThrow();
        let candidateId = null;
        let origin = null;
        if (args[1] && /^site-/.test(args[1])) candidateId = args[1];
        else if (args[1] && args[2] && args[3]) origin = parseOrigin(args, 1);
        else if (args[1]) candidateId = args[1];
        const result = m.selectSite({ candidateId, origin });
        return result;
      }
      if (sub === 'boundaries') return m.boundaries();
      if (sub === 'preview') {
        const kind = (args[1] || 'clear').toLowerCase();
        if (kind === 'light' || kind === 'lighting') {
          const light = m.lightingPreview();
          return { ...light, plan: light.plan ? { placements: light.plan.placements.length, uncovered: light.plan.uncovered.length, coverage: light.plan.coverage, source: light.plan.source, note: light.plan.note } : null };
        }
        return m.preview();
      }
      if (sub === 'clear') return m.clear({ confirm: ctx.confirmed, maxActions: args[1] ? intArg(args[1], 'actions', { min: 1, max: 2000 }) : 400 });
      if (sub === 'excavate') return m.excavate({ confirm: ctx.confirmed, maxActions: args[1] ? intArg(args[1], 'actions', { min: 1, max: 2000 }) : 800 });
      if (sub === 'flatten' || sub === 'level') return m.flatten({ confirm: ctx.confirmed, maxActions: args[1] ? intArg(args[1], 'actions', { min: 1, max: 2000 }) : 700 });
      if (sub === 'drain') return m.drain({ confirm: ctx.confirmed, maxActions: args[1] ? intArg(args[1], 'actions', { min: 1, max: 500 }) : 200 });
      if (sub === 'light' || sub === 'spawnproof') return m.light({ confirm: ctx.confirmed });
      if (sub === 'secure' || sub === 'perimeter') return m.secure({ confirm: ctx.confirmed });
      if (sub === 'audit') {
        const project = projectOrThrow();
        return { ok: true, lighting: project.sitePreparation.lighting || null, security: project.security || null };
      }
      return { ok: false, error: `unknown site subcommand '${sub}'` };
    }
  });

  registry.register({
    name: 'materials', aliases: ['bom'], category: 'builder',
    summary: 'Bill of materials, deficits, safe acquisition and reserve management',
    usage: 'materials [status|calculate|missing|readiness|gather confirm|reserve|locate <item>|deposit <item> <count> [bot]|retrieve <item> <count> [bot]]',
    execute: async (args, ctx) => {
      const sub = (args[0] || 'status').toLowerCase();
      const m = manager();
      if (sub === 'status' || sub === 'calculate' || sub === 'bom') {
        const result = m.materials();
        if (!result.ok) {
          if (sub === 'status' && /no active project/i.test(String(result.error || ''))) {
            return { ok: true, active: false, project: null, ready: false, message: 'No active construction project; start one with builder create.' };
          }
          return result;
        }
        return {
          ok: true, project: result.project, ready: result.ready, deficit: result.deficit,
          totalNeeded: result.totalNeeded, totalAvailable: result.totalAvailable,
          requirements: Object.fromEntries(Object.entries(result.requirements).slice(0, 80)),
          acquisitionPlan: result.acquisitionPlan.slice(0, 40), phaseReadiness: result.phaseReadiness,
          storage: result.storage
        };
      }
      if (sub === 'missing' || sub === 'deficit') return { ok: true, ...(await (async () => { const r = m.materials(); return { deficit: r.deficit, ready: r.ready }; })()) };
      if (sub === 'readiness' || sub === 'phases') return m.phaseReadiness();
      if (sub === 'gather') return m.gather({ confirm: ctx.confirmed });
      if (sub === 'reserve') return m.reserveMaterials();
      if (sub === 'locate') {
        if (!args[1]) throw new CommandError('usage: materials locate <item>');
        return { ok: true, item: args[1], locations: m.warehouse.locate(args[1]) };
      }
      if (sub === 'deposit' || sub === 'retrieve' || sub === 'transport') {
        if (!ctx.confirmed) return { ok: false, error: 'physical item transport is a world action; append confirm', code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
        if (!args[1]) throw new CommandError(`usage: materials ${sub} <item> <count> [bot]`);
        const count = intArg(args[2], 'count', { min: 1, max: 4096 });
        return m.storageMove({ action: sub === 'retrieve' ? 'retrieve' : 'deposit', item: args[1], count, bot: args[3] || null });
      }
      return { ok: false, error: `unknown materials subcommand '${sub}'` };
    }
  });

  registry.register({
    name: 'storage', aliases: ['warehouse'], category: 'builder',
    summary: 'Central warehouse scan, categorised storage, capacity and verified transfers',
    usage: 'storage [status|scan [bot]|containers|capacity|locate <item>|deposit <item> <count> [bot] confirm|retrieve <item> <count> [bot] confirm|organise confirm]',
    dangerous: true,
    execute: async (args, ctx) => {
      const sub = (args[0] || 'status').toLowerCase();
      const m = manager();
      if (sub === 'status') return { ok: true, warehouse: m.state().warehouse };
      if (sub === 'scan') return m.storageScan({ bot: args[1] || null });
      if (sub === 'containers') return { ok: true, containers: m.warehouse.state().containers, categories: m.warehouse.categories() };
      if (sub === 'capacity') return { ok: true, capacity: m.warehouse.capacity() };
      if (sub === 'locate') {
        if (!args[1]) throw new CommandError('usage: storage locate <item>');
        return { ok: true, item: args[1], locations: m.warehouse.locate(args[1]) };
      }
      if (sub === 'organise' || sub === 'organize') return m.storageOrganise();
      if (sub === 'deposit' || sub === 'retrieve') {
        if (!ctx.confirmed) return { ok: false, error: 'physical storage transfer requires confirmation (append confirm)', code: 'CONFIRMATION_REQUIRED', requiresConfirmation: true };
        if (!args[1]) throw new CommandError(`usage: storage ${sub} <item> <count> [bot]`);
        const count = intArg(args[2], 'count', { min: 1, max: 4096 });
        return m.storageMove({ action: sub, item: args[1], count, bot: args[3] || null });
      }
      return { ok: false, error: `unknown storage subcommand '${sub}'` };
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

module.exports = { createCommandHandler, CommandRegistry, CommandError, TASK_TYPES, resolveDesign, parseTaskParams, mergeTaskParams, UNSAFE_PARAM_KEYS };
