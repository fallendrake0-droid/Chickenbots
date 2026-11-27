'use strict';

const { distance2d } = require('../util/vec');
const { toolTier, PICKAXES, AXES, SHOVELS, SWORDS, sumCategory } = require('../world/items');

const TOOL_TABLES = { pickaxe: PICKAXES, axe: AXES, shovel: SHOVELS, sword: SWORDS };

function botToolTier(bot, tool) {
  const table = TOOL_TABLES[tool];
  if (!table) return 0;
  if (bot.equipment && typeof bot.equipment[tool] === 'number') return bot.equipment[tool];
  let tier = 0;
  for (const [name, count] of Object.entries(bot.inventory || {})) {
    if (count > 0) tier = Math.max(tier, toolTier(name, table));
  }
  return tier;
}

function taskPosition(task) {
  if (task.params && task.params.position) return task.params.position;
  if (task.region) {
    return {
      x: (task.region.min.x + task.region.max.x) / 2,
      y: (task.region.min.y + task.region.max.y) / 2,
      z: (task.region.min.z + task.region.max.z) / 2
    };
  }
  return null;
}

/**
 * Score how well a bot fits a task. Higher is better; negative scores mean the
 * bot should not be assigned. The score is a deterministic function of state so
 * tests and dashboards agree.
 */
function scoreTaskForBot(task, bot, context = {}) {
  const reasons = [];
  let score = 0;
  if (!bot || bot.connected === false || bot.spawned === false) return { score: -Infinity, reasons: ['bot unavailable'] };
  if (task.status && !['PENDING', 'CLAIMED', 'ACTIVE'].includes(task.status)) return { score: -Infinity, reasons: [`task ${task.status}`] };
  if (task.claimedBy && task.claimedBy !== bot.name) return { score: -Infinity, reasons: ['claimed by another bot'] };
  if (task.dependsOn && task.dependsOn.length && !context.dependenciesSatisfied) return { score: -Infinity, reasons: ['dependencies not satisfied'] };

  score += (task.priority || 50) * 1.5;

  // Distance
  const pos = taskPosition(task);
  if (pos && bot.position) {
    const d = distance2d(bot.position, pos);
    const penalty = Math.min(35, d / 8);
    score -= penalty;
    if (d > 256) reasons.push(`far (${Math.round(d)}m)`);
  }

  // Health / food suitability
  const health = bot.health === undefined ? 20 : bot.health;
  const food = bot.food === undefined ? 20 : bot.food;
  if (health < 6) { score -= 120; reasons.push('critical health'); }
  else if (health < 12) { score -= 35; reasons.push('injured'); }
  else if (health >= 18) score += 6;
  if (food < 6) { score -= 60; reasons.push('starving'); }
  else if (food < 12) score -= 15;

  // Equipment requirements
  const requires = task.requires || {};
  if (requires.tool) {
    const need = requires.tier || 1;
    const have = botToolTier(bot, requires.tool);
    if (have === 0) { score -= 80; reasons.push(`no ${requires.tool}`); }
    else if (have < need) { score -= 45; reasons.push(`${requires.tool} tier ${have}<${need}`); }
    else { score += 18; reasons.push(`${requires.tool} tier ${have}`); }
  }
  if (requires.capability) {
    const caps = bot.capabilities || [];
    if (!caps.includes(requires.capability)) { score -= 100; reasons.push(`missing capability ${requires.capability}`); }
    else score += 12;
  }
  if (requires.items) {
    for (const [item, count] of Object.entries(requires.items)) {
      const have = item.startsWith('category:')
        ? sumCategory(bot.inventory || {}, item.slice('category:'.length))
        : ((bot.inventory || {})[item] || 0);
      if (have < count) { score -= 25 + (count - have); reasons.push(`needs ${item} ${have}/${count}`); }
      else score += 6;
    }
  }
  // Some deliverables can only be performed by the bot that actually carries
  // the item (a bed is placed from the claimant's own inventory). A normal
  // requirement only lowers the score, which let an empty-handed quartermaster
  // claim PLACE_BED, fail with "no bed available" and take the objective down
  // with it even though a teammate was holding the bed. `held` is a near-hard
  // gate: the holder wins the task, and while nobody holds the item the task
  // waits (and, when optional, is cancelled by required work completing).
  if (requires.held) {
    for (const [item, count] of Object.entries(requires.held)) {
      const have = item.startsWith('category:')
        ? sumCategory(bot.inventory || {}, item.slice('category:'.length))
        : ((bot.inventory || {})[item] || 0);
      if (have < count) { score -= 1000; reasons.push(`must hold ${item} ${have}/${count}`); }
      else score += 30;
    }
  }
  if (requires.minHealth !== undefined && health < requires.minHealth) { score -= 120; reasons.push('below minimum health'); }
  if (requires.minFood !== undefined && food < requires.minFood) { score -= 120; reasons.push('below minimum food'); }
  if (requires.armor) {
    const armor = (bot.equipment && bot.equipment.armor) || 0;
    if (armor < requires.armor) { score -= 30; reasons.push('under-armoured'); } else score += 8;
  }

  // Threat safety
  const threats = bot.threats || 0;
  if (threats > 0) {
    const risk = (task.metadata && task.metadata.risk) || 'normal';
    const weight = risk === 'high' ? 14 : risk === 'low' ? 3 : 7;
    score -= threats * weight;
    if (threats >= 2 && risk === 'high') reasons.push('dangerous surroundings');
  }

  // Skill / role variety: avoid monotonous assignment while honouring preference
  if (task.requires && task.requires.role && (bot.role === task.requires.role)) score += 10;
  if (bot.currentTaskId) score -= 25;
  if (Array.isArray(bot.recentTaskTypes)) {
    const repeats = bot.recentTaskTypes.filter((t) => t === task.type).length;
    score -= repeats * 4;
  }

  // Team need: prefer tasks closer to their deadline and nearer the goal
  if (task.units && task.units.target > 0) {
    const remaining = Math.max(0, task.units.target - (task.units.current || 0));
    score += Math.min(10, remaining / 32);
  }
  if (task.estimatedMs) score -= Math.min(8, task.estimatedMs / 120000);
  if (task.deadlineAt) {
    const left = task.deadlineAt - (context.now || Date.now());
    if (left < 0) { score += 15; reasons.push('overdue'); }
    else if (left < 60000) score += 8;
  }

  return { score: Number(score.toFixed(3)), reasons };
}

function rankTasksForBot(tasks, bot, context = {}) {
  return tasks
    .map((task) => ({ task, ...scoreTaskForBot(task, bot, context) }))
    .filter((r) => Number.isFinite(r.score) && r.score > -Infinity)
    .sort((a, b) => b.score - a.score || String(a.task.id).localeCompare(String(b.task.id)));
}

/** Greedy team-level assignment: highest-priority tasks get the best bots. */
function assignBotsToTasks(tasks, bots, context = {}) {
  const assignments = [];
  const usedBots = new Set();
  const usedTasks = new Set();
  const open = tasks.filter((t) => t.status === 'PENDING' || !t.claimedBy);
  const ordered = open.slice().sort((a, b) => (b.priority || 50) - (a.priority || 50) || String(a.id).localeCompare(String(b.id)));
  for (const task of ordered) {
    let best = null;
    for (const bot of bots) {
      if (usedBots.has(bot.name)) continue;
      const scored = scoreTaskForBot(task, bot, context);
      if (!Number.isFinite(scored.score) || scored.score <= 0) continue;
      if (!best || scored.score > best.score) best = { bot, ...scored };
    }
    if (best) {
      assignments.push({ taskId: task.id, bot: best.bot.name, score: best.score, reasons: best.reasons });
      usedBots.add(best.bot.name);
      usedTasks.add(task.id);
    }
  }
  return assignments;
}

module.exports = { scoreTaskForBot, rankTasksForBot, assignBotsToTasks, botToolTier, taskPosition };
