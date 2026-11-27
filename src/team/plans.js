'use strict';

/** Objective templates. These turn high-level goals into executable tasks with
 * real dependencies, quotas and priorities. All IDs are deterministic per
 * board so re-running a plan never duplicates work. */

let planSeq = 0;

function splitQuota(total, parts) {
  // A zero/NaN part count used to make Array.from({length: Infinity}) throw and
  // take the whole planner down. Clamp to a real number of tasks and a
  // non-negative integer quota.
  const count = Math.max(1, Math.min(1000, Math.floor(Number(parts) || 1)));
  const units = Math.max(0, Math.floor(Number(total) || 0));
  const base = Math.floor(units / count);
  const extra = units % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

function objectiveExists(board, template) {
  return board.listObjectives().find((o) => o.metadata && o.metadata.template === template && o.status === 'ACTIVE') || null;
}

function createSurvivalBasePlan(board, { botNames = [], template = 'SURVIVAL_BASE', bedStock = 0 } = {}) {
  const existing = objectiveExists(board, template);
  if (existing) return { objective: existing, created: false };
  // Never require ten beds when the team owns none. The old plan hard-coded a
  // quota of ten, then failed three attempts and restarted the whole base plan
  // forever. The quota is now bounded by real bed items the bots actually hold.
  const bedTarget = Math.max(0, Math.min(10, Math.floor(Number(bedStock) || 0)));
  const bedText = bedTarget > 0 ? `${bedTarget} bed${bedTarget === 1 ? '' : 's'}` : 'beds when materials allow';
  const objective = board.createObjective({
    id: `obj-${template.toLowerCase()}-${++planSeq}`,
    title: 'BUILD A PERMANENT SURVIVAL BASE',
    description: `Find a site, gather materials, excavate the foundation, build a secure base with storage, farms and ${bedText}.`,
    priority: 90,
    progress: { current: 0, target: 1, unit: 'phases' },
    completionCondition: `foundation, walls, roof, storage, ${bedText} and perimeter verified`,
    failureCondition: 'site unusable and no alternative within 256 blocks',
    recoveryStrategy: 're-plan site and reuse gathered materials',
    requirements: { oak_log: 256, stone: 128, iron_ingot: 32, food: 128, ...(bedTarget > 0 ? { bed: bedTarget } : {}) },
    metadata: { template, botNames, bedTarget }
  });

  const tasks = [];
  const add = (spec) => {
    const res = board.addTask({ objectiveId: objective.id, ...spec });
    if (res.ok) tasks.push(res.task);
    return res.ok ? res.task : null;
  };

  const site = add({
    type: 'FIND_SITE',
    label: 'Find suitable build site',
    priority: 95,
    requires: { capability: 'explore' },
    params: { searchRadius: 96, maxSlope: 3, nearWater: true },
    units: { target: 1 },
    maxAttempts: 5,
    estimatedMs: 120000
  });

  const quotas = splitQuota(256, 4);
  const woodTasks = quotas.map((q, i) => add({
    type: 'CHOP_WOOD',
    label: `Gather ${q} oak logs (${i + 1}/4)`,
    priority: 72,
    requires: { tool: 'axe', tier: 1 },
    params: { logType: 'oak', quota: q, replant: true },
    units: { target: q },
    optional: true,
    maxAttempts: 4,
    estimatedMs: q * 1800,
    metadata: { resource: 'oak_log', risk: 'low' }
  })).filter(Boolean);

  const stoneQuotas = splitQuota(128, 2);
  const stoneTasks = stoneQuotas.map((q, i) => add({
    type: 'MINE_BLOCK',
    label: `Mine ${q} stone (${i + 1}/2)`,
    priority: 66,
    requires: { tool: 'pickaxe', tier: 1, capability: 'mine' },
    params: { block: 'stone', quota: q, yRange: [-59, 62] },
    units: { target: q },
    optional: true,
    maxAttempts: 4,
    estimatedMs: q * 900,
    metadata: { risk: 'normal' }
  })).filter(Boolean);

  const ironQuotas = splitQuota(32, 2);
  ironQuotas.map((q, i) => add({
    type: 'MINE_ORE',
    label: `Mine ${q} iron ore (${i + 1}/2)`,
    priority: 64,
    requires: { tool: 'pickaxe', tier: 2, capability: 'mine' },
    params: { ore: 'iron_ore', quota: q, yRange: [-59, 62] },
    units: { target: q },
    optional: true,
    maxAttempts: 4,
    estimatedMs: q * 4000,
    metadata: { risk: 'high', resource: 'iron_ore' }
  })).filter(Boolean);

  const food = add({
    type: 'FARM_CROP',
    label: 'Establish food production (16 crops)',
    priority: 70,
    requires: { capability: 'farm' },
    params: { crop: 'wheat', count: 16, establish: true },
    units: { target: 16 },
    optional: true,
    maxAttempts: 3,
    estimatedMs: 300000,
    metadata: { risk: 'low' }
  });

  const foundation = add({
    type: 'BUILD_PHASE',
    label: 'Foundation',
    priority: 80,
    requires: { tool: 'pickaxe', tier: 1 },
    params: { template: 'survival_base', phase: 'FOUNDATION', siteTaskId: site ? site.id : null },
    region: site ? null : null,
    dependsOn: [site ? site.id : null, ...stoneTasks.map((t) => t.id)].filter(Boolean),
    units: { target: 1 },
    estimatedMs: 240000
  });

  const walls = add({
    type: 'BUILD_PHASE',
    label: 'Walls',
    priority: 78,
    requires: { tool: 'axe', tier: 1 },
    params: { template: 'survival_base', phase: 'WALLS' },
    dependsOn: foundation ? [foundation.id, ...woodTasks.map((t) => t.id)].filter(Boolean) : [],
    units: { target: 1 },
    estimatedMs: 300000
  });

  const roof = add({
    type: 'BUILD_PHASE',
    label: 'Roof',
    priority: 76,
    params: { template: 'survival_base', phase: 'ROOF' },
    dependsOn: walls ? [walls.id] : [],
    units: { target: 1 },
    estimatedMs: 180000
  });

  add({
    type: 'STORE_ITEMS',
    label: 'Install shared storage',
    priority: 60,
    requires: { items: { oak_planks: 8 } },
    params: { containers: 2 },
    dependsOn: foundation ? [foundation.id] : [],
    units: { target: 2 },
    estimatedMs: 90000
  });

  const beds = bedTarget > 0 ? add({
    type: 'PLACE_BED',
    label: `Install ${bedTarget} bed${bedTarget === 1 ? '' : 's'}`,
    priority: 74,
    requires: { items: { 'category:bed': 1 } },
    params: { count: bedTarget, reservedFor: botNames },
    dependsOn: foundation ? [foundation.id, roof ? roof.id : null].filter(Boolean) : [],
    units: { target: bedTarget },
    estimatedMs: 120000
  }) : null;

  const perimeter = add({
    type: 'BUILD_PHASE',
    label: 'Secure perimeter',
    priority: 62,
    params: { template: 'survival_base', phase: 'PERIMETER' },
    dependsOn: walls ? [walls.id] : [],
    units: { target: 1 },
    estimatedMs: 300000
  });

  board.refreshObjectiveProgress(objective.id);
  return { objective, tasks, created: true, food, perimeter, beds };
}

function createCollectPlan(board, { resource, count, method, parts = 4, priority = 60, template = null, label = null } = {}) {
  if (!resource || !(count > 0)) return { ok: false, error: 'resource and positive count required' };
  const templ = template || `COLLECT_${resource.toUpperCase()}`;
  const existing = objectiveExists(board, templ);
  if (existing) return { ok: true, objective: existing, created: false };
  const objective = board.createObjective({
    id: `obj-collect-${++planSeq}`,
    title: label || `COLLECT ${count} ${resource.toUpperCase()}`,
    priority,
    progress: { current: 0, target: count, unit: resource },
    metadata: { template: templ, resource }
  });
  const quotas = splitQuota(count, parts);
  const type = method === 'chop' ? 'CHOP_WOOD' : method === 'farm' ? 'FARM_CROP' : 'MINE_ORE';
  const tasks = quotas.map((q, i) => {
    const spec = {
      objectiveId: objective.id,
      type,
      label: `${label || 'Collect'} ${q} ${resource} (${i + 1}/${quotas.length})`,
      priority,
      params: method === 'chop' ? { logType: resource.replace('_log', ''), quota: q, replant: true }
        : method === 'farm' ? { crop: resource, count: q }
          : { ore: resource, quota: q },
      requires: type === 'MINE_ORE' ? { tool: 'pickaxe', tier: 2, capability: 'mine' }
        : type === 'CHOP_WOOD' ? { tool: 'axe', tier: 1 } : { capability: 'farm' },
      units: { target: q },
      maxAttempts: 4,
      metadata: { resource, risk: type === 'MINE_ORE' ? 'high' : 'low' }
    };
    const res = board.addTask(spec);
    return res.ok ? res.task : null;
  }).filter(Boolean);
  board.refreshObjectiveProgress(objective.id);
  return { ok: true, objective, tasks, created: true };
}

function createExcavationPlanTasks(board, { objectiveId, excavationId, regions, priority = 70 } = {}) {
  if (!objectiveId || !excavationId || !Array.isArray(regions) || !regions.length) {
    return { ok: false, error: 'objectiveId, excavationId and regions required' };
  }
  const objective = board.getObjective(objectiveId);
  if (!objective) return { ok: false, error: 'unknown objective' };
  const tasks = regions.map((region, i) => {
    const res = board.addTask({
      objectiveId,
      type: 'EXCAVATE_REGION',
      label: `Excavate region ${region.label || region.id || i + 1}`,
      priority,
      params: { excavationId, regionId: region.id || `R${i + 1}`, origin: region.origin || null },
      region: region.box,
      requires: { tool: 'pickaxe', tier: 2, capability: 'excavate' },
      units: { target: region.volume || 1 },
      maxAttempts: 3,
      estimatedMs: Math.max(60000, (region.volume || 100) * 1200),
      metadata: { excavationId, regionId: region.id || `R${i + 1}`, risk: 'normal' },
      lockKeys: [`excavation:${excavationId}:${region.id || `R${i + 1}`}`]
    });
    if (!res.ok) return { ok: false, error: res.error, region };
    return { ok: true, task: res.task, region };
  });
  board.refreshObjectiveProgress(objectiveId);
  return { ok: true, objective, tasks };
}

function createSchematicBuildPlan(board, { schematic, phases = [], priority = 75, buildSite = null } = {}) {
  if (!schematic || !schematic.id) return { ok: false, error: 'schematic required' };
  const template = `BUILD_${schematic.id}`;
  const existing = objectiveExists(board, template);
  if (existing) return { ok: true, objective: existing, created: false };
  const objective = board.createObjective({
    id: `obj-build-${++planSeq}`,
    title: `BUILD ${schematic.name || schematic.id}`,
    description: `${schematic.category || 'structure'} ${schematic.dimensions ? `${schematic.dimensions.width}x${schematic.dimensions.height}x${schematic.dimensions.length}` : ''}`,
    priority,
    progress: { current: 0, target: phases.length || 1, unit: 'phases' },
    metadata: { template, schematicId: schematic.id, tier: schematic.tier }
  });
  let previous = null;
  const tasks = [];
  for (const phase of phases) {
    const res = board.addTask({
      objectiveId: objective.id,
      type: 'BUILD_PHASE',
      label: `Build phase ${phase.name || phase.index}`,
      priority,
      params: { schematicId: schematic.id, phase: phase.name || String(phase.index), buildSite },
      requires: { tool: 'pickaxe', tier: 1, capability: 'build' },
      dependsOn: previous ? [previous.id] : [],
      units: { target: phase.blockCount || 1 },
      maxAttempts: 3,
      estimatedMs: Math.max(30000, (phase.blockCount || 1) * 400),
      metadata: { schematicId: schematic.id, phase: phase.name, risk: 'low' }
    });
    if (res.ok) { tasks.push(res.task); previous = res.task; }
  }
  board.refreshObjectiveProgress(objective.id);
  return { ok: true, objective, tasks, created: true };
}

module.exports = {
  createSurvivalBasePlan,
  createCollectPlan,
  createExcavationPlanTasks,
  createSchematicBuildPlan,
  splitQuota,
  objectiveExists
};
