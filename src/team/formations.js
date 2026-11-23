'use strict';

const { distance2d } = require('../util/vec');

const FORMATIONS = {
  FOLLOW: { spacing: 2.5, radius: 0, roles: ['lead', 'follow', 'follow', 'follow', 'follow'] },
  COMPACT: { spacing: 1.8, radius: 2, roles: ['lead', 'guard', 'guard', 'guard', 'guard'] },
  DEFENSIVE: { spacing: 3, radius: 4, roles: ['lead', 'guard', 'guard', 'guard', 'support'] },
  EXPLORATION: { spacing: 4, radius: 6, roles: ['lead', 'scout', 'scout', 'scout', 'scout'] },
  MINING: { spacing: 2, radius: 0, roles: ['lead', 'miner', 'miner', 'guard', 'supply'] },
  FISHING: { spacing: 3, radius: 4, roles: ['lead', 'fisher', 'fisher', 'guard', 'supply'] },
  BUILDING: { spacing: 3.5, radius: 5, roles: ['lead', 'builder', 'builder', 'builder', 'supply'] },
  RETREAT: { spacing: 2, radius: 0, roles: ['lead', 'guard', 'guard', 'medic', 'guard'] },
  REGROUP: { spacing: 1.5, radius: 1.5, roles: ['lead', 'follow', 'follow', 'follow', 'follow'] }
};

function normalizeFormation(name) {
  const key = String(name || 'FOLLOW').toUpperCase();
  return FORMATIONS[key] ? key : 'FOLLOW';
}

/** Relative slots in the leader's local frame: +z is behind the leader. */
function slotOffsets(formation, count) {
  const key = normalizeFormation(formation);
  const def = FORMATIONS[key];
  const offsets = [{ x: 0, z: 0, role: def.roles[0] }];
  const remaining = Math.max(0, count - 1);
  if (!remaining) return offsets;
  if (key === 'MINING' || key === 'RETREAT' || key === 'FOLLOW') {
    for (let i = 1; i <= remaining; i++) {
      offsets.push({
        x: key === 'FOLLOW' ? (i % 2 === 0 ? def.spacing / 2 : -def.spacing / 2) : 0,
        z: i * def.spacing,
        role: def.roles[Math.min(i, def.roles.length - 1)]
      });
    }
    return offsets;
  }
  // Ring formations
  const radius = Math.max(def.radius, def.spacing * Math.ceil(remaining / 4));
  for (let i = 0; i < remaining; i++) {
    const angle = (i / remaining) * Math.PI * 2;
    offsets.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      role: def.roles[Math.min(i + 1, def.roles.length - 1)]
    });
  }
  return offsets;
}

function rotate(offset, headingRadians) {
  const cos = Math.cos(headingRadians);
  const sin = Math.sin(headingRadians);
  return { x: offset.x * cos - offset.z * sin, z: offset.x * sin + offset.z * cos };
}

/**
 * Assign concrete slots to members. Bots already near a slot keep it, which
 * prevents the team from swapping places every tick.
 */
function computeSlots({ leader, members, formation = 'FOLLOW', heading = 0, positions = {} }) {
  const key = normalizeFormation(formation);
  const memberNames = (members || []).filter((m) => m !== leader).map((m) => (typeof m === 'string' ? m : m.name));
  const ordered = [leader, ...memberNames.filter((m) => m !== leader)];
  const offsets = slotOffsets(key, ordered.length);
  const slots = offsets.map((o, i) => {
    const r = rotate(o, heading);
    return {
      name: ordered[i],
      position: {
        x: Math.round((positions[leader] ? positions[leader].x : 0) + r.x),
        z: Math.round((positions[leader] ? positions[leader].z : 0) + r.z)
      },
      role: o.role,
      index: i
    };
  });
  // Greedy nearest-slot reassignment for followers keeps movement minimal.
  const leaderSlot = slots[0];
  const followers = slots.slice(1);
  const free = followers.slice();
  const assigned = [leaderSlot];
  for (const name of memberNames) {
    const pos = positions[name];
    let bestIdx = 0;
    if (pos) {
      let bestD = Infinity;
      free.forEach((slot, idx) => {
        const d = distance2d(pos, slot.position);
        if (d < bestD) { bestD = d; bestIdx = idx; }
      });
    }
    const slot = free.splice(bestIdx, 1)[0];
    if (slot) assigned.push({ ...slot, name });
  }
  return { formation: key, slots: assigned, spacing: FORMATIONS[key].spacing };
}

/** Separation steering so bots do not stack into one block or block doors. */
function separation(positions, { minDistance = 1.6, strength = 0.6 } = {}) {
  const names = Object.keys(positions);
  const adjustments = {};
  for (const name of names) adjustments[name] = { x: 0, z: 0 };
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = positions[names[i]];
      const b = positions[names[j]];
      const dx = a.x - b.x;
      const dz = a.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d === 0) {
        adjustments[names[i]].x += strength * 0.5;
        adjustments[names[j]].x -= strength * 0.5;
        continue;
      }
      if (d < minDistance) {
        const push = ((minDistance - d) / minDistance) * strength;
        const nx = dx / d;
        const nz = dz / d;
        adjustments[names[i]].x += nx * push;
        adjustments[names[i]].z += nz * push;
        adjustments[names[j]].x -= nx * push;
        adjustments[names[j]].z -= nz * push;
      }
    }
  }
  return adjustments;
}

function formationForTask(type) {
  switch (type) {
    case 'EXCAVATE_REGION': return 'MINING';
    case 'BUILD_PHASE': return 'BUILDING';
    case 'EXPLORE': case 'FIND_SITE': return 'EXPLORATION';
    case 'COMBAT_GUARD': case 'DEFEND': return 'DEFENSIVE';
    case 'RETREAT': return 'RETREAT';
    case 'REGROUP': return 'REGROUP';
    case 'MINE_ORE': case 'MINE_BLOCK': return 'MINING';
    case 'FISH': return 'FISHING';
    default: return 'FOLLOW';
  }
}

module.exports = { FORMATIONS, normalizeFormation, slotOffsets, computeSlots, separation, formationForTask };
