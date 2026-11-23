'use strict';

/** Architectural geometry primitives: footprints, shells, roofs, towers,
 * windows, stairs, colonnades, bridges, gardens and furnishings. */

const GLASS_BLOCKS = new Set(['glass', 'glass_pane', 'white_stained_glass_pane', 'gray_stained_glass_pane', 'black_stained_glass_pane', 'light_gray_stained_glass_pane', 'blue_stained_glass_pane', 'cyan_stained_glass_pane', 'tinted_glass', 'white_stained_glass']);

function footprint(shape, w, l) {
  const cx = (w - 1) / 2;
  const cz = (l - 1) / 2;
  const cut = Math.max(1, Math.floor(Math.min(w, l) * 0.18));
  return (x, z) => {
    if (x < 0 || z < 0 || x >= w || z >= l) return false;
    switch (shape) {
      case 'octagon': {
        const dx = Math.abs(x - cx);
        const dz = Math.abs(z - cz);
        return dx + dz <= cx + cz - cut || dx < cx - cut * 0.2 || dz < cz - cut * 0.2;
      }
      case 'circle': {
        const rx = w / 2;
        const rz = l / 2;
        return ((x - cx) ** 2) / (rx * rx) + ((z - cz) ** 2) / (rz * rz) <= 1;
      }
      case 'cross': {
        const armX = Math.floor(w * 0.32);
        const armZ = Math.floor(l * 0.32);
        return Math.abs(x - cx) <= armX || Math.abs(z - cz) <= armZ;
      }
      case 'L': return !(x > cx + w * 0.15 && z > cz + l * 0.15);
      case 'T': return !(x < w * 0.2 && z > l * 0.65) && !(x > w * 0.8 && z > l * 0.65);
      case 'U': return !(Math.abs(x - cx) < w * 0.22 && z > l * 0.45);
      default: return true;
    }
  };
}

function isBoundary(mask, x, z) {
  if (!mask(x, z)) return false;
  return !mask(x + 1, z) || !mask(x - 1, z) || !mask(x, z + 1) || !mask(x, z - 1);
}

function shell(grid, { w, l, shape = 'rect', floors = 1, floorHeight = 4, wallThickness = 1, palette, windowPattern = 'grid', doorSide = 'south', phase = 'WALLS', floorPhase = 'FLOORS', baseY = 0, parapet = false }) {
  const mask = footprint(shape, w, l);
  const floorYs = [];
  const wallTop = baseY + floors * floorHeight;
  for (let f = 0; f < floors; f++) {
    const y0 = baseY + f * floorHeight;
    floorYs.push(y0);
    // Floor slab (except ground floor, which sits on the foundation).
    if (f > 0) {
      for (let z = 0; z < l; z++) {
        for (let x = 0; x < w; x++) if (mask(x, z)) grid.set(x, y0, z, palette.floor, floorPhase);
      }
    } else {
      for (let z = 0; z < l; z++) {
        for (let x = 0; x < w; x++) if (mask(x, z)) grid.set(x, y0, z, palette.floor, floorPhase);
      }
    }
    for (let t = 0; t < wallThickness; t++) {
      for (let z = 0; z < l; z++) {
        for (let x = 0; x < w; x++) {
          if (!mask(x, z)) continue;
          const inner = x >= t && x < w - t && z >= t && z < l - t;
          if (!inner) continue;
          if (!isBoundary(mask, x, z)) {
            if (t === 0) continue;
          }
          for (let y = y0 + 1; y <= y0 + floorHeight; y++) {
            const heightInFloor = y - y0;
            const isWindowHeight = heightInFloor === Math.min(floorHeight - 1, 3);
            const boundary = isBoundary(mask, x, z);
            const corner = boundary && (!mask(x + 1, z) || !mask(x - 1, z)) && (!mask(x, z + 1) || !mask(x, z - 1));
            let name = palette.wall;
            if (corner) name = palette.frame;
            if (boundary && isWindowHeight) {
              const pattern = (x * 3 + z * 5 + f * 7) % (windowPattern === 'sparse' ? 9 : windowPattern === 'dense' ? 3 : 5);
              if (floorHeight >= 3 && pattern === 0) name = palette.glass;
            }
            // Doorway on the chosen side at ground level.
            if (f === 0 && boundary) {
              const midX = Math.floor(w / 2);
              const midZ = Math.floor(l / 2);
              const isDoor = (doorSide === 'south' && z === l - 1 && (x === midX || x === midX - 1)) ||
                (doorSide === 'north' && z === 0 && (x === midX || x === midX - 1)) ||
                (doorSide === 'east' && x === w - 1 && (z === midZ || z === midZ - 1)) ||
                (doorSide === 'west' && x === 0 && (z === midZ || z === midZ - 1));
              if (isDoor && heightInFloor <= 2) continue;
            }
            grid.set(x, y, z, name, phase);
          }
        }
      }
    }
  }
  if (parapet) {
    for (let z = 0; z < l; z++) {
      for (let x = 0; x < w; x++) {
        if (!mask(x, z) || !isBoundary(mask, x, z)) continue;
        grid.set(x, wallTop, z, palette.accent, phase);
      }
    }
  }
  return { mask, floorYs, wallTop, height: wallTop + 1, w, l, shape };
}

function gableRoof(grid, shellInfo, palette, { axis = 'x', overhang = 0, phase = 'ROOF', material = null } = {}) {
  const { w, l, mask, wallTop } = shellInfo;
  const mat = material || palette.roof;
  const base = wallTop;
  if (axis === 'x') {
    const half = Math.ceil(l / 2);
    for (let step = 0; step < half; step++) {
      const z0 = -overhang + step;
      const z1 = l - 1 + overhang - step;
      const y = base + step;
      for (let x = -overhang; x < w + overhang; x++) {
        if (z0 >= 0 && z0 < l && !mask(x, z0)) continue;
        if (z1 >= 0 && z1 < l && !mask(x, z1)) continue;
        grid.set(x, y, z0, mat, phase);
        grid.set(x, y, z1, mat, phase);
        if (step > 0) grid.set(x, y - 1, z0, palette.roofBase, phase);
      }
      if (z1 - z0 <= 1) break;
    }
    for (let x = -overhang; x < w + overhang; x++) grid.set(x, base + half, Math.floor(l / 2), palette.roofBase, phase);
  } else {
    const half = Math.ceil(w / 2);
    for (let step = 0; step < half; step++) {
      const x0 = -overhang + step;
      const x1 = w - 1 + overhang - step;
      const y = base + step;
      for (let z = -overhang; z < l + overhang; z++) {
        if (x0 >= 0 && x0 < w && !mask(x0, z)) continue;
        if (x1 >= 0 && x1 < w && !mask(x1, z)) continue;
        grid.set(x0, y, z, mat, phase);
        grid.set(x1, y, z, mat, phase);
      }
      if (x1 - x0 <= 1) break;
    }
    for (let z = -overhang; z < l + overhang; z++) grid.set(Math.floor(w / 2), base + half, z, palette.roofBase, phase);
  }
  return base + Math.max(Math.ceil(w / 2), Math.ceil(l / 2)) + 1;
}

function pyramidRoof(grid, x0, z0, x1, z1, y, palette, { phase = 'ROOF', material = null, steps = null } = {}) {
  const mat = material || palette.roof;
  let minX = x0; let maxX = x1; let minZ = z0; let maxZ = z1;
  let level = 0;
  const maxSteps = steps || Math.ceil(Math.max(x1 - x0 + 1, z1 - z0 + 1) / 2) + 1;
  while (minX <= maxX && minZ <= maxZ && level < maxSteps) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (x === minX || x === maxX || z === minZ || z === maxZ || minX === maxX || minZ === maxZ) {
          grid.set(x, y + level, z, mat, phase);
        }
      }
    }
    minX++; maxX--; minZ++; maxZ--; level++;
  }
  return y + level;
}

function hipRoof(grid, shellInfo, palette, { phase = 'ROOF' } = {}) {
  const { w, l, mask, wallTop } = shellInfo;
  const mat = palette.roof;
  const layers = Math.ceil(Math.min(w, l) / 2);
  for (let level = 0; level < layers; level++) {
    const inset = level;
    for (let z = inset; z < l - inset; z++) {
      for (let x = inset; x < w - inset; x++) {
        if (!mask(x, z)) continue;
        const edge = x === inset || x === w - 1 - inset || z === inset || z === l - 1 - inset;
        if (edge) grid.set(x, wallTop + level, z, mat, phase);
      }
    }
  }
  return wallTop + layers + 1;
}

function domeRoof(grid, cx, cz, radius, baseY, palette, { phase = 'ROOF', material = null } = {}) {
  const mat = material || palette.accent;
  for (let dy = 0; dy <= radius; dy++) {
    const r = Math.sqrt(Math.max(0, radius * radius - dy * dy));
    for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d <= r + 0.5 && d >= r - 0.9) {
          grid.set(cx + dx, baseY + dy, cz + dz, mat, phase);
        }
      }
    }
  }
  grid.set(cx, baseY + radius + 1, cz, palette.light, 'LIGHTING');
  return baseY + radius + 2;
}

function battlements(grid, x0, z0, x1, z1, y, palette, phase = 'TOWERS') {
  for (let x = x0; x <= x1; x++) {
    if ((x - x0) % 2 === 0) {
      grid.set(x, y, z0, palette.primary, phase);
      grid.set(x, y + 1, z0, palette.accent, phase);
      grid.set(x, y, z1, palette.primary, phase);
      grid.set(x, y + 1, z1, palette.accent, phase);
    }
  }
  for (let z = z0; z <= z1; z++) {
    if ((z - z0) % 2 === 0) {
      grid.set(x0, y, z, palette.primary, phase);
      grid.set(x0, y + 1, z, palette.accent, phase);
      grid.set(x1, y, z, palette.primary, phase);
      grid.set(x1, y + 1, z, palette.accent, phase);
    }
  }
}

function squareTower(grid, { cx, cz, size, baseY, height, palette, roof = 'battlement', phase = 'TOWERS', floorPhase = 'FLOORS' }) {
  const half = Math.floor(size / 2);
  const x0 = cx - half;
  const x1 = cx + half;
  const z0 = cz - half;
  const z1 = cz + half;
  for (let y = baseY; y < baseY + height; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        if (!edge) continue;
        let name = palette.primary;
        if ((x === x0 || x === x1) && (z === z0 || z === z1)) name = palette.frame;
        if ((y - baseY) % 5 === 3 && !((x === x0 || x === x1) && (z === z0 || z === z1))) name = palette.glass;
        grid.set(x, y, z, name, phase);
      }
    }
  }
  // Interior floors + ladder access.
  for (let step = 0; step < height; step += 4) {
    for (let z = z0 + 1; z < z1; z++) for (let x = x0 + 1; x < x1; x++) grid.set(x, baseY + step, z, palette.floor, floorPhase);
    grid.set(cx, baseY + step + 1, cz, 'ladder', 'STAIRS');
  }
  const top = baseY + height;
  if (roof === 'battlement') {
    battlements(grid, x0, z0, x1, z1, top, palette, phase);
    return top + 2;
  }
  if (roof === 'pyramid') return pyramidRoof(grid, x0, z0, x1, z1, top, palette, { phase });
  if (roof === 'spire') {
    for (let i = 0; i < size; i++) {
      const r = Math.max(0, half - i);
      for (let z = -r; z <= r; z++) for (let x = -r; x <= r; x++) grid.set(cx + x, top + i, cz + z, palette.accent, phase);
    }
    return top + size;
  }
  return top;
}

function roundTower(grid, { cx, cz, radius, baseY, height, palette, phase = 'TOWERS' }) {
  for (let y = baseY; y < baseY + height; y++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > radius + 0.5 || d < radius - 0.8) continue;
        let name = palette.primary;
        if ((y - baseY) % 6 === 4) name = palette.glass;
        grid.set(cx + dx, y, cz + dz, name, phase);
      }
    }
  }
  const top = baseY + height;
  battlements(grid, cx - radius, cz - radius, cx + radius, cz + radius, top, palette, phase);
  return top + 2;
}

function stairFlight(grid, { x, y, z, levels, palette, direction = 'north', phase = 'STAIRS', material = null }) {
  const mat = material || palette.primary;
  for (let i = 0; i < levels; i++) {
    const y0 = y + i;
    const z0 = direction === 'north' ? z - i : z + i;
    grid.set(x, y0, z0, palette.floor, phase);
    grid.set(x, y0 + 1, z0, mat, phase);
    grid.set(x, y0 + 2, z0, 'air', phase);
  }
}

function columns(grid, { x0, z0, x1, z1, y0, y1, palette, spacing = 4, phase = 'WALLS', material = null }) {
  const mat = material || palette.pillar;
  for (let x = x0; x <= x1; x += spacing) {
    for (let y = y0; y <= y1; y++) {
      grid.set(x, y, z0, mat, phase);
      grid.set(x, y, z1, mat, phase);
    }
  }
  for (let z = z0; z <= z1; z += spacing) {
    for (let y = y0; y <= y1; y++) {
      grid.set(x0, y, z, mat, phase);
      grid.set(x1, y, z, mat, phase);
    }
  }
}

function windows(grid, { mask, w, l, floorYs, floorHeight, palette, pattern = 'grid', phase = 'WALLS' }) {
  for (const y0 of floorYs) {
    for (let z = 0; z < l; z++) {
      for (let x = 0; x < w; x++) {
        if (!mask(x, z) || !isBoundary(mask, x, z)) continue;
        const key = (x * 7 + z * 3) % (pattern === 'dense' ? 2 : pattern === 'sparse' ? 7 : 4);
        if (key !== 0) continue;
        grid.set(x, y0 + Math.min(floorHeight - 1, 3), z, palette.glass, phase);
      }
    }
  }
}

function interiorRooms(grid, { mask, w, l, floorYs, floorHeight, palette, rng, phases, tier }) {
  const types = ['storage', 'bedroom', 'workshop', 'kitchen', 'library', 'hall', 'enchanting'];
  for (let f = 0; f < floorYs.length; f++) {
    const y = floorYs[f] + 1;
    const count = 1 + (rng.int(0, Math.min(3, 1 + Math.floor(tier / 2))));
    for (let r = 0; r < count; r++) {
      const x = rng.int(1, Math.max(1, w - 3));
      const z = rng.int(1, Math.max(1, l - 3));
      if (!mask(x, z) || !mask(x + 1, z + 1)) continue;
      const type = rng.pick(types);
      furnish(grid, { x, y, z, type, palette, rng });
    }
    // Lighting across the floor.
    for (let i = 0; i < Math.max(1, Math.floor((w * l) / 90)); i++) {
      const x = rng.int(1, Math.max(1, w - 2));
      const z = rng.int(1, Math.max(1, l - 2));
      if (mask(x, z) && !grid.has(x, y + floorHeight - 1, z)) grid.set(x, y + floorHeight - 1, z, palette.light, 'LIGHTING');
    }
  }
}

function furnish(grid, { x, y, z, type, palette, rng }) {
  switch (type) {
    case 'bedroom':
      grid.set(x, y, z, 'white_bed', 'INTERIOR');
      grid.set(x + 1, y, z, 'white_bed', 'INTERIOR');
      grid.set(x + 1, y, z + 1, 'chest', 'INTERIOR');
      break;
    case 'storage':
      for (let i = 0; i < 3; i++) grid.set(x + i, y, z, 'chest', 'INTERIOR');
      grid.set(x, y + 1, z, 'barrel', 'INTERIOR');
      break;
    case 'workshop':
      grid.set(x, y, z, 'crafting_table', 'INTERIOR');
      grid.set(x + 1, y, z, 'furnace', 'INTERIOR');
      grid.set(x, y, z + 1, 'anvil', 'INTERIOR');
      break;
    case 'kitchen':
      grid.set(x, y, z, 'furnace', 'INTERIOR');
      grid.set(x + 1, y, z, 'smoker', 'INTERIOR');
      grid.set(x, y, z + 1, 'barrel', 'INTERIOR');
      break;
    case 'library':
      for (let i = 0; i < 4; i++) grid.set(x + i, y, z, 'bookshelf', 'INTERIOR');
      grid.set(x + 1, y, z + 1, 'lectern', 'INTERIOR');
      break;
    case 'enchanting':
      grid.set(x, y, z, 'enchanting_table', 'INTERIOR');
      grid.set(x + 2, y, z, 'bookshelf', 'INTERIOR');
      grid.set(x - 1, y, z, 'bookshelf', 'INTERIOR');
      break;
    case 'hall':
      for (let i = 0; i < 2; i++) {
        grid.set(x + i * 2, y + 1, z, 'oak_fence', 'INTERIOR');
        grid.set(x + i * 2, y + 2, z, 'white_carpet', 'INTERIOR');
      }
      break;
    default:
      grid.set(x, y, z, 'crafting_table', 'INTERIOR');
  }
}

function tree(grid, { x, y, z, rng, size = 5, log = 'oak_log', leaves = 'oak_leaves', phase = 'DECORATION' }) {
  const height = size + rng.int(0, 3);
  for (let i = 0; i < height; i++) grid.set(x, y + i, z, log, phase);
  const top = y + height;
  for (let dy = -2; dy <= 2; dy++) {
    const r = dy <= 0 ? 2 : dy === 1 ? 1 : 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r) continue;
        if (!grid.has(x + dx, top + dy, z + dz)) grid.set(x + dx, top + dy, z + dz, leaves, phase);
      }
    }
  }
}

function garden(grid, { x0, z0, x1, z1, y, rng, palette, phase = 'DECORATION' }) {
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const edge = x === x0 || x === x1 || z === z0 || z === z1;
      if (edge) grid.set(x, y, z, palette.path === 'dirt_path' ? 'dirt_path' : 'dirt', phase);
      else {
        const r = rng.next();
        if (r < 0.12) grid.set(x, y, z, rng.pick(['poppy', 'dandelion', 'short_grass', 'fern']), phase);
        else if (r < 0.14) tree(grid, { x, y, z, rng, size: 3 });
      }
    }
  }
}

function fountain(grid, { cx, cz, y, radius, palette, phase = 'DECORATION' }) {
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dz);
      if (d <= radius + 0.4) grid.set(cx + dx, y, cz + dz, d > radius - 0.6 ? palette.accent : 'water', phase);
    }
  }
  for (let i = 1; i <= 2; i++) grid.set(cx, y + i, cz, palette.pillar, phase);
  grid.set(cx, y + 3, cz, 'sea_lantern', 'LIGHTING');
}

function statue(grid, { cx, cz, y, palette, height = 5, phase = 'DECORATION' }) {
  for (let i = 0; i < height; i++) grid.set(cx, y + i, cz, palette.primary, phase);
  grid.set(cx - 1, y + height, cz, palette.primary, phase);
  grid.set(cx + 1, y + height, cz, palette.primary, phase);
  grid.set(cx, y + height, cz - 1, palette.primary, phase);
  grid.set(cx, y + height, cz + 1, palette.primary, phase);
  grid.set(cx, y + height + 1, cz, palette.accent, phase);
  grid.set(cx, y + 2, cz, palette.frame, phase);
}

module.exports = {
  GLASS_BLOCKS, footprint, isBoundary, shell, gableRoof, pyramidRoof, hipRoof,
  domeRoof, battlements, squareTower, roundTower, stairFlight, columns, windows,
  interiorRooms, furnish, tree, garden, fountain, statue
};
