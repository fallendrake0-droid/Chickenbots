'use strict';

const PIPELINE_PHASES = Object.freeze([
  'ANALYSIS', 'SURVEY', 'SITE_SELECTION', 'CLEARANCE', 'EXCAVATION', 'LEVELLING',
  'DRAINAGE', 'LIGHTING', 'PERIMETER', 'TEMPORARY_STORAGE', 'MATERIAL_CALCULATION',
  'GATHERING', 'WAREHOUSE_STORAGE', 'BUILD_PLAN', 'CONSTRUCTION', 'INTERIOR',
  'SECURITY_AUDIT', 'QUALITY_VERIFICATION', 'CLEANUP'
]);

const PIPELINE_LABELS = Object.freeze({
  ANALYSIS: 'Schematic analysis',
  SURVEY: 'Site survey',
  SITE_SELECTION: 'Site selection',
  CLEARANCE: 'Land clearance',
  EXCAVATION: 'Excavation',
  LEVELLING: 'Cut and fill levelling',
  DRAINAGE: 'Drainage and hazard control',
  LIGHTING: 'Lighting and spawn-proofing',
  PERIMETER: 'Perimeter security',
  TEMPORARY_STORAGE: 'Temporary storage and shelter',
  MATERIAL_CALCULATION: 'Material calculation',
  GATHERING: 'Resource collection',
  WAREHOUSE_STORAGE: 'Central warehouse staging',
  BUILD_PLAN: 'Build planning',
  CONSTRUCTION: 'Cooperative construction',
  INTERIOR: 'Interior and decoration',
  SECURITY_AUDIT: 'Security audit',
  QUALITY_VERIFICATION: 'Quality verification',
  CLEANUP: 'Cleanup and completion'
});

// The geometry engine uses ten schematic phases; the crew pipeline exposes
// sixteen construction milestones (including verification/handover gates) so
// that site preparation, build stages and handover remain separately visible.
const BUILD_PHASES = Object.freeze([
  { name: 'FOUNDATION', schematic: 'FOUNDATION' },
  { name: 'FLOORS', schematic: 'FLOORS' },
  { name: 'WALLS', schematic: 'WALLS' },
  { name: 'STRUCTURAL_FRAME', schematic: 'WALLS' },
  { name: 'WINDOWS_AND_OPENINGS', schematic: 'WALLS' },
  { name: 'DOORS', schematic: 'WALLS' },
  { name: 'STAIRS', schematic: 'STAIRS' },
  { name: 'UPPER_FLOORS', schematic: 'FLOORS' },
  { name: 'ROOF', schematic: 'ROOF' },
  { name: 'TOWERS', schematic: 'TOWERS' },
  { name: 'INTERIOR_WALLS', schematic: 'INTERIOR' },
  { name: 'FURNITURE', schematic: 'INTERIOR' },
  { name: 'DECORATION', schematic: 'DECORATION' },
  { name: 'INTERIOR_LIGHTING', schematic: 'LIGHTING' },
  { name: 'EXTERIOR_WORKS', schematic: 'TERRAIN' },
  { name: 'FINAL_QA', schematic: null }
]);

const STATUS = Object.freeze({
  PLANNING: 'PLANNING', PREPARING: 'PREPARING', BUILDING: 'BUILDING', AUDITING: 'AUDITING',
  COMPLETE: 'COMPLETE', PAUSED: 'PAUSED', CANCELLED: 'CANCELLED', BLOCKED: 'BLOCKED',
  AWAITING_MATERIALS: 'AWAITING_MATERIALS', AWAITING_STORAGE: 'AWAITING_STORAGE'
});

const INITIAL_ROLES = Object.freeze({
  '________': 'SITE_SUPERVISOR_AND_QC',
  '10101000': 'EXCAVATION_LEAD',
  '01010100': 'MATERIALS_AND_WOODCUTTING',
  '11001100': 'SECURITY_AND_LIGHTING',
  '00110000': 'STORAGE_AND_LOGISTICS'
});

const PHASE_STATUS = Object.freeze({
  PENDING: 'PENDING', ACTIVE: 'ACTIVE', COMPLETE: 'COMPLETE', BLOCKED: 'BLOCKED', FAILED: 'FAILED', SKIPPED: 'SKIPPED'
});

function rotateSchematic(schematic, rotation = 0) {
  const deg = ((Number(rotation) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(deg)) throw new Error('rotation must be 0, 90, 180 or 270');
  if (deg === 0) return schematic;
  const width = schematic.dimensions.width;
  const length = schematic.dimensions.length;
  const blocks = schematic.blocks.map(([x, y, z, palette, phase]) => {
    if (deg === 90) return [z, y, width - 1 - x, palette, phase];
    if (deg === 180) return [width - 1 - x, y, length - 1 - z, palette, phase];
    return [length - 1 - z, y, x, palette, phase];
  }).sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  return {
    ...schematic,
    blocks,
    dimensions: {
      width: deg === 90 || deg === 270 ? length : width,
      height: schematic.dimensions.height,
      length: deg === 90 || deg === 270 ? width : length
    },
    rotation: deg
  };
}

function botWorldView(bot) {
  if (!bot) return null;
  return {
    getBlock(pos) {
      const block = bot.getBlock(pos);
      // Unloaded/unknown is explicitly marked, never converted into air.
      return block || { name: 'unloaded' };
    },
    surfaceY(x, z) { return bot.surfaceAt(x, z); },
    blockNameAt(x, y, z) { const block = bot.getBlock({ x, y, z }); return block ? block.name : null; }
  };
}

module.exports = {
  PIPELINE_PHASES, PIPELINE_LABELS, BUILD_PHASES, STATUS, INITIAL_ROLES, PHASE_STATUS,
  rotateSchematic, botWorldView
};
