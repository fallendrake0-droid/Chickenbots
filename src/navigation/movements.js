'use strict';

const { config } = require('../config');

const HAZARD_IDS = [
  'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush',
  'powder_snow', 'campfire', 'soul_campfire', 'wither_rose', 'pointed_dripstone'
];

/**
 * Apply Chickenbots' navigation policy to a mineflayer-pathfinder Movements
 * instance. Kept separate from RealBot so the policy is unit-testable without
 * a socket.
 *
 * Defaults are deliberately conservative: no digging, no scaffold towers, no
 * parkour leaps, bounded drops, expensive liquids and explicit hazard
 * exclusions. Mining/woodcutting dig their own access tunnels; routine travel
 * must not carve through a base or a player's farm.
 */
function configureMovements(movements, {
  bot = null,
  options = {},
  settings = null,
  registry = null
} = {}) {
  if (!movements) return null;
  const nav = settings || config.navigation || {};
  const reg = registry || (bot && bot.registry) || null;
  const allowDig = options.allowDig === undefined ? nav.allowDig === true : options.allowDig === true;
  const allowScaffold = options.allowScaffold === undefined ? nav.allowScaffold === true : options.allowScaffold === true;
  // Per-call overrides must reach the weight function too; reading only the
  // global config made `goTo(..., {allowWater:false})` still wade through water.
  const allowWater = options.allowWater === undefined ? nav.allowWater !== false : options.allowWater === true;
  movements.canDig = allowDig;
  movements.digCost = 4;
  movements.placeCost = 3;
  movements.liquidCost = Number(options.liquidCost) || 6;
  movements.entityCost = 2;
  const maxDropDown = options.maxDrop === undefined ? nav.maxDrop : options.maxDrop;
  movements.maxDropDown = maxDropDown === undefined ? 3 : Math.max(0, Number(maxDropDown) || 0);
  movements.allowParkour = options.allowParkour === true;
  movements.allowSprinting = options.sprint === undefined ? nav.sprint !== false : options.sprint === true;
  movements.allow1by1towers = allowScaffold;
  movements.allowFreeMotion = false;
  movements.canOpenDoors = options.openDoors === undefined ? nav.openDoors === true : options.openDoors === true;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.infiniteLiquidDropdownDistance = false;
  if (typeof movements.clearCollisionIndex === 'function') movements.clearCollisionIndex();
  if (typeof movements.updateCollisionIndex === 'function') {
    try { movements.updateCollisionIndex(); } catch (_) { /* fake/partial movement objects */ }
  }

  if (reg && reg.blocksByName) {
    const id = (name) => (reg.blocksByName[name] ? reg.blocksByName[name].id : null);
    const avoid = new Set();
    for (const name of HAZARD_IDS) {
      const blockId = id(name);
      if (blockId !== null) avoid.add(blockId);
    }
    if (movements.blocksToAvoid && typeof movements.blocksToAvoid.add === 'function') {
      for (const blockId of avoid) movements.blocksToAvoid.add(blockId);
    }
    if (allowScaffold && reg.itemsByName) {
      const scaffold = [];
      for (const name of ['dirt', 'cobblestone']) {
        if (reg.itemsByName[name]) scaffold.push(reg.itemsByName[name].id);
      }
      if (scaffold.length) movements.scafoldingBlocks = scaffold;
    } else {
      // Mineflayer defaults to dirt+cobblestone. Clear it unless the caller
      // explicitly opted into towers; otherwise a "walk home" can build a
      // one-block pillar through a roof.
      movements.scafoldingBlocks = [];
    }
    const avoidSet = avoid;
    const hazardWeight = (block) => {
      if (!block) return 0;
      if (block.liquid && block.name === 'lava') return 1000;
      if (avoidSet.has(block.type)) return 250;
      if (block.name === 'water' && !allowWater) return 1000;
      return 0;
    };
    movements.exclusionAreasStep = [hazardWeight];
    movements.exclusionAreasBreak = [hazardWeight];
    movements.exclusionAreasPlace = [hazardWeight];
  }
  return movements;
}

/** Serializable policy snapshot for `path status` and the dashboard. */
function movementPolicy(settings = null) {
  const nav = settings || config.navigation || {};
  return {
    canDig: nav.allowDig === true,
    canScaffold: nav.allowScaffold === true,
    allowParkour: false,
    allowSprint: nav.sprint !== false,
    maxDrop: nav.maxDrop,
    openDoors: nav.openDoors === true,
    liquidCost: 6,
    maxDropDown: nav.maxDrop,
    avoids: HAZARD_IDS.slice()
  };
}

module.exports = { configureMovements, movementPolicy, HAZARD_IDS };
