'use strict';

const { BlockGrid, PHASES } = require('./blockGrid');
const { paletteFor } = require('./palettes');
const { Rng } = require('../util/rng');
const { geometryHash, exactHash, specHash } = require('./designHash');
const { parseBlock } = require('../building/blockStates');
const P = require('./primitives');

const TITLE = {
  1: 'Beginner', 2: 'Novice', 3: 'Apprentice', 4: 'Intermediate',
  5: 'Advanced', 6: 'Expert', 7: 'Master', 8: 'Grandmaster'
};
const DIFFICULTY = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 7, 7: 9, 8: 10 };

const ARCHETYPE_OF = {
  shelter: 'house', cabin: 'house', farm_shed: 'house', cottage: 'house', house: 'house', villa: 'house',
  mansion: 'house', inn: 'house', guildhall: 'house', library: 'house', academy: 'house', workshop: 'house',
  forge: 'house', barn: 'house', stable: 'house', mill: 'house', manor: 'house', warehouse: 'house',
  watchtower: 'fortress', keep: 'fortress', castle: 'fortress', citadel: 'fortress', fortress: 'fortress',
  gatehouse: 'fortress', mega_castle: 'fortress', colossal_castle: 'fortress', kingdom: 'fortress',
  fortress_city: 'fortress', mountain_keep: 'fortress',
  shrine: 'temple', chapel: 'temple', temple: 'temple', pagoda: 'temple', dojo: 'temple', cathedral: 'temple',
  grand_temple: 'temple', pyramid: 'temple', mausoleum: 'temple', cathedral_complex: 'temple',
  imperial_palace: 'temple', palace: 'temple',
  skyscraper: 'modern', office: 'modern', museum: 'modern', apartment: 'modern', station: 'modern',
  observatory: 'modern', city_block: 'modern', sky_city: 'modern', metropolis: 'modern',
  bridge: 'infrastructure', dock: 'infrastructure', pier: 'infrastructure', harbor: 'infrastructure',
  aqueduct: 'infrastructure', tunnel: 'infrastructure', railway: 'infrastructure', road: 'infrastructure',
  well: 'infrastructure', mine_entrance: 'infrastructure', grand_station: 'infrastructure',
  garden: 'garden', plaza: 'garden', park: 'garden', maze: 'garden', fountain: 'garden', statue: 'garden',
  greenhouse: 'garden', royal_gardens: 'garden', courtyard: 'garden',
  underground_room: 'underground', underground_base: 'underground', subterranean_city: 'underground',
  underground_metropolis: 'underground', sunken_city: 'underground', mine_complex: 'underground',
  quarry: 'underground', underground_kingdom: 'underground', bunker: 'underground',
  treehouse: 'fantasy', floating_island: 'fantasy', sky_fortress: 'fantasy', floating_citadel: 'fantasy',
  world_tree_palace: 'fantasy', arcane_academy: 'fantasy', titan_forge: 'fantasy', dark_tower: 'fantasy',
  mega_base: 'fantasy', eternal_library: 'fantasy'
};

const STYLE_OF_CATEGORY = {
  shelter: 'rustic', cabin: 'rustic', farm_shed: 'rustic', cottage: 'rustic',
  house: 'medieval', villa: 'royal', mansion: 'royal', inn: 'medieval', guildhall: 'medieval',
  library: 'royal', academy: 'royal', workshop: 'rustic', forge: 'industrial', barn: 'rustic',
  stable: 'rustic', mill: 'rustic', manor: 'medieval', warehouse: 'industrial',
  watchtower: 'medieval', keep: 'medieval', castle: 'medieval', citadel: 'nordic', fortress: 'nordic',
  gatehouse: 'medieval', mega_castle: 'royal', colossal_castle: 'dark', kingdom: 'royal',
  fortress_city: 'nordic', mountain_keep: 'nordic',
  shrine: 'japanese', chapel: 'medieval', temple: 'japanese', pagoda: 'japanese', dojo: 'japanese',
  cathedral: 'royal', grand_temple: 'fantasy', pyramid: 'desert', mausoleum: 'dark',
  cathedral_complex: 'royal', imperial_palace: 'royal', palace: 'royal',
  skyscraper: 'modern', office: 'modern', museum: 'modern', apartment: 'modern', station: 'industrial',
  observatory: 'modern', city_block: 'modern', sky_city: 'modern', metropolis: 'modern',
  bridge: 'medieval', dock: 'rustic', pier: 'rustic', harbor: 'oceanic', aqueduct: 'stone',
  tunnel: 'industrial', railway: 'industrial', road: 'stone', well: 'medieval',
  mine_entrance: 'industrial', grand_station: 'modern',
  garden: 'woodland', plaza: 'royal', park: 'woodland', maze: 'woodland', fountain: 'royal',
  statue: 'royal', greenhouse: 'fantasy', royal_gardens: 'royal', courtyard: 'medieval',
  underground_room: 'stone', underground_base: 'deepslate', subterranean_city: 'deepslate',
  underground_metropolis: 'deepslate', sunken_city: 'oceanic', mine_complex: 'industrial',
  quarry: 'stone', underground_kingdom: 'dark', bunker: 'deepslate',
  treehouse: 'woodland', floating_island: 'fantasy', sky_fortress: 'fantasy',
  floating_citadel: 'fantasy', world_tree_palace: 'fantasy', arcane_academy: 'fantasy',
  titan_forge: 'dark', dark_tower: 'dark', mega_base: 'fantasy', eternal_library: 'royal'
};

const STYLE_OVERRIDE = { stone: 'nordic' };

const SHAPES_BY_TIER = {
  1: ['rect'], 2: ['rect', 'L'], 3: ['rect', 'L', 'T', 'octagon'],
  4: ['rect', 'L', 'T', 'octagon', 'U'], 5: ['rect', 'octagon', 'circle', 'cross', 'T', 'U'],
  6: ['rect', 'octagon', 'circle', 'cross', 'L', 'U'], 7: ['rect', 'octagon', 'circle', 'cross', 'U'],
  8: ['rect', 'octagon', 'circle', 'cross', 'L', 'T', 'U']
};

const ROOFS_BY_TIER = {
  1: ['gable', 'flat'], 2: ['gable', 'flat', 'hip'], 3: ['gable', 'hip', 'pyramid', 'flat'],
  4: ['gable', 'hip', 'pyramid', 'dome', 'flat'], 5: ['gable', 'hip', 'pyramid', 'dome', 'stepped', 'flat'],
  6: ['hip', 'pyramid', 'dome', 'stepped', 'gable', 'flat'],
  7: ['hip', 'pyramid', 'dome', 'stepped', 'flat'],
  8: ['pyramid', 'dome', 'stepped', 'hip', 'flat']
};

const TIER_SETTINGS = {
  1: { w: [5, 9], l: [5, 9], floors: [1, 1], floorHeight: [3, 4], towers: [0, 0], wings: [0, 0], basement: [0, 0], decor: 1 },
  2: { w: [7, 11], l: [7, 12], floors: [1, 2], floorHeight: [3, 4], towers: [0, 1], wings: [0, 1], basement: [0, 0], decor: 2 },
  3: { w: [9, 15], l: [9, 16], floors: [1, 3], floorHeight: [4, 4], towers: [0, 2], wings: [0, 1], basement: [0, 1], decor: 3 },
  4: { w: [12, 20], l: [12, 22], floors: [2, 3], floorHeight: [4, 5], towers: [0, 4], wings: [0, 2], basement: [0, 1], decor: 4 },
  5: { w: [16, 28], l: [16, 30], floors: [2, 4], floorHeight: [4, 5], towers: [2, 4], wings: [0, 3], basement: [0, 2], decor: 5 },
  6: { w: [22, 40], l: [22, 42], floors: [3, 5], floorHeight: [4, 6], towers: [2, 6], wings: [1, 4], basement: [0, 2], decor: 6 },
  7: { w: [30, 60], l: [30, 62], floors: [3, 6], floorHeight: [5, 6], towers: [4, 8], wings: [2, 4], basement: [1, 2], decor: 7 },
  8: { w: [40, 88], l: [40, 90], floors: [4, 8], floorHeight: [5, 7], towers: [4, 8], wings: [2, 4], basement: [1, 3], decor: 8 }
};

const CORNERS = [
  { name: 'nw', fx: -1, fz: -1 }, { name: 'ne', fx: 1, fz: -1 },
  { name: 'sw', fx: -1, fz: 1 }, { name: 'se', fx: 1, fz: 1 }
];

function categoryOf(category) {
  return ARCHETYPE_OF[category] || 'house';
}

function titleCase(str) {
  return str.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

/** Build the structural spec for one design. */
function createSpec({ tier, category, variant, number, seed }) {
  const t = TIER_SETTINGS[tier];
  const rng = new Rng(`${seed}:${tier}:${category}:${variant}`);
  const archetype = categoryOf(category);
  const style = STYLE_OVERRIDE[STYLE_OF_CATEGORY[category]] || STYLE_OF_CATEGORY[category] || 'medieval';
  const shapes = SHAPES_BY_TIER[tier];
  const roofs = ROOFS_BY_TIER[tier];
  const shape = archetype === 'infrastructure' || archetype === 'garden' || archetype === 'underground'
    ? (archetype === 'underground' ? 'rect' : shapes[variant % shapes.length])
    : shapes[(variant + category.length) % shapes.length];
  const w = rng.int(t.w[0], t.w[1]);
  const l = rng.int(t.l[0], t.l[1]);
  const floors = rng.int(t.floors[0], t.floors[1]);
  const floorHeight = rng.int(t.floorHeight[0], t.floorHeight[1]);
  const roofType = roofs[(variant + number) % roofs.length];
  const towerCount = archetype === 'fortress'
    ? Math.max(4, rng.int(t.towers[0], t.towers[1]))
    : rng.int(t.towers[0], t.towers[1]);
  const towers = [];
  if (towerCount > 0) {
    for (let i = 0; i < Math.min(8, towerCount); i++) {
      const corner = CORNERS[i % 4];
      towers.push({
        corner: corner.name,
        fx: corner.fx,
        fz: corner.fz,
        size: Math.max(3, Math.min(11, 3 + Math.floor(tier / 2) + (i % 3))),
        height: Math.max(4, floors * floorHeight + 3 + rng.int(0, 2 + tier)),
        roof: rng.pick(tier >= 5 ? ['battlement', 'pyramid', 'spire'] : ['battlement', 'pyramid']),
        round: tier >= 6 && (i + variant) % 3 === 0,
        tierOffset: i
      });
    }
  }
  const wingCount = rng.int(t.wings[0], t.wings[1]);
  const wings = [];
  const sides = ['north', 'south', 'east', 'west'];
  for (let i = 0; i < wingCount; i++) {
    wings.push({
      side: sides[(variant + i) % 4],
      width: Math.max(5, Math.min(24, Math.round(w * 0.45) + i)),
      length: Math.max(4, Math.min(18, Math.round(l * 0.3) + i)),
      floors: Math.max(1, Math.min(floors, 1 + ((variant + i) % Math.max(1, floors)))),
      roof: rng.pick(['gable', 'hip', 'flat'])
    });
  }
  const basementLevels = rng.int(t.basement[0], t.basement[1]);
  const decor = {
    garden: rng.chance(0.5 + tier * 0.03),
    fountain: rng.chance(0.25 + tier * 0.02),
    trees: rng.int(0, tier),
    lanterns: rng.int(2, 4 + tier * 2),
    fence: rng.chance(0.4 + tier * 0.04),
    statue: rng.chance(tier >= 4 ? 0.3 : 0.08),
    path: rng.chance(0.7),
    chimney: rng.chance(0.5),
    balcony: rng.chance(tier >= 3 ? 0.5 : 0.1),
    moat: archetype === 'fortress' && tier >= 5 && rng.chance(0.5),
    dock: archetype === 'infrastructure' && rng.chance(0.6),
    maze: category === 'maze' || (archetype === 'garden' && rng.chance(0.25)),
    island: archetype === 'fantasy' ? rng.int(8, 12 + tier * 3) : 0,
    colonnade: archetype === 'temple' ? rng.int(4, 8 + tier) : 0,
    terraces: archetype === 'temple' ? rng.int(1, 1 + Math.floor(tier / 2)) : 0,
    pillars: archetype === 'underground' ? rng.int(4, 10 + tier * 2) : 0,
    moatWidth: 2 + (tier >= 7 ? 2 : 0),
    glow: rng.chance(0.3)
  };
  return {
    tier,
    tierName: TITLE[tier],
    difficulty: DIFFICULTY[tier] || tier,
    category,
    archetype,
    style,
    shape,
    w,
    l,
    floors,
    floorHeight,
    roofType,
    wallThickness: tier >= 6 ? rng.int(1, 2) : 1,
    windowPattern: rng.pick(['grid', 'dense', 'sparse']),
    doorSide: sides[variant % 4],
    towers,
    wings,
    courtyard: archetype === 'fortress' || archetype === 'temple' ? rng.chance(0.6) : rng.chance(0.15),
    basement: basementLevels,
    decor,
    variant,
    number,
    seed: String(seed)
  };
}

function foundationSpec(spec) {
  const depth = spec.basement > 0 ? 2 + spec.basement * 4 : (spec.tier <= 2 ? 2 : 3);
  return {
    depth,
    material: spec.tier >= 4 ? 'stone_bricks' : 'cobblestone',
    supports: [{ x: 0, z: 0 }, { x: spec.w - 1, z: 0 }, { x: 0, z: spec.l - 1 }, { x: spec.w - 1, z: spec.l - 1 }]
  };
}

function buildFoundation(grid, spec, palette, baseY) {
  const mask = P.footprint(spec.shape, spec.w, spec.l);
  for (let y = 0; y < baseY; y++) {
    for (let z = 0; z < spec.l; z++) {
      for (let x = 0; x < spec.w; x++) {
        if (!mask(x, z)) continue;
        const edge = x === 0 || z === 0 || x === spec.w - 1 || z === spec.l - 1;
        grid.set(x, y, z, edge ? palette.accent : 'stone', 'FOUNDATION');
      }
    }
  }
}

function roofOver(grid, info, spec, palette, rng) {
  const { wallTop } = info;
  switch (spec.roofType) {
    case 'flat': {
      const y = wallTop;
      for (let z = 0; z < info.l; z++) {
        for (let x = 0; x < info.w; x++) if (info.mask(x, z)) grid.set(x, y, z, palette.roofBase, 'ROOF');
      }
      // Parapet
      for (let z = 0; z < info.l; z++) {
        for (let x = 0; x < info.w; x++) {
          if (info.mask(x, z) && P.isBoundary(info.mask, x, z)) grid.set(x, y + 1, z, palette.accent, 'ROOF');
        }
      }
      if (spec.decor.glow) grid.set(Math.floor(info.w / 2), y + 1, Math.floor(info.l / 2), palette.light, 'LIGHTING');
      return y + 2;
    }
    case 'pyramid':
      return P.pyramidRoof(grid, 0, 0, info.w - 1, info.l - 1, wallTop, palette);
    case 'hip':
      return P.hipRoof(grid, info, palette);
    case 'dome': {
      const cx = Math.floor(info.w / 2);
      const cz = Math.floor(info.l / 2);
      const radius = Math.max(3, Math.floor(Math.min(info.w, info.l) / 2));
      return P.domeRoof(grid, cx, cz, radius, wallTop, palette);
    }
    case 'stepped': {
      const steps = 3 + Math.floor(spec.tier / 2);
      let y = wallTop;
      for (let i = 0; i < steps; i++) {
        const inset = i;
        for (let z = inset; z < info.l - inset; z++) {
          for (let x = inset; x < info.w - inset; x++) {
            if (!info.mask(x, z)) continue;
            grid.set(x, y, z, i % 2 === 0 ? palette.roofBase : palette.accent, 'ROOF');
          }
        }
        for (let z = inset; z < info.l - inset; z++) {
          for (let x = inset; x < info.w - inset; x++) {
            if (info.mask(x, z) && (x === inset || x === info.w - 1 - inset || z === inset || z === info.l - 1 - inset)) {
              grid.set(x, y + 1, z, palette.primary, 'ROOF');
            }
          }
        }
        y += 2;
      }
      return y;
    }
    case 'gable':
    default:
      return P.gableRoof(grid, info, palette, { axis: info.w >= info.l ? 'z' : 'x', overhang: 1 });
  }
}

function addWing(main, spec, palette, rng) {
  const wing = spec.wings[0];
  if (!wing) return;
  const wg = new BlockGrid();
  const info = P.shell(wg, {
    w: wing.width, l: wing.length, shape: 'rect', floors: wing.floors, floorHeight: spec.floorHeight,
    palette, windowPattern: spec.windowPattern, doorSide: wing.side, baseY: 0
  });
  if (wing.roof === 'flat') {
    for (let z = 0; z < wing.length; z++) for (let x = 0; x < wing.width; x++) {
      if (info.mask(x, z)) wg.set(x, info.wallTop, z, palette.roofBase, 'ROOF');
    }
  } else if (wing.roof === 'hip') {
    P.hipRoof(wg, info, palette);
  } else {
    P.gableRoof(wg, info, palette, { axis: wing.width >= wing.length ? 'z' : 'x' });
  }
  // Door connection back to the main building.
  const doorX = Math.floor(wing.width / 2);
  for (let y = 1; y <= 2; y++) wg.clear(doorX, y, wing.length - 1);
  const offsets = {
    north: { dx: Math.floor((spec.w - wing.width) / 2), dz: -wing.length },
    south: { dx: Math.floor((spec.w - wing.width) / 2), dz: spec.l },
    east: { dx: spec.w, dz: Math.floor((spec.l - wing.length) / 2) },
    west: { dx: -wing.width, dz: Math.floor((spec.l - wing.length) / 2) }
  }[wing.side] || { dx: spec.w, dz: 0 };
  main.merge(wg, offsets.dx, 0, offsets.dz);
}

function addTowers(main, spec, palette, baseY, tiers) {
  for (const tower of spec.towers) {
    const cx = tower.fx < 0 ? Math.floor(6 / 2) : spec.w - Math.floor(6 / 2);
    const cz = tower.fz < 0 ? Math.floor(6 / 2) : spec.l - Math.floor(6 / 2);
    const tg = new BlockGrid();
    if (tower.round) {
      P.roundTower(tg, { cx: 0, cz: 0, radius: Math.max(2, Math.floor(tower.size / 2)), baseY: 0, height: tower.height, palette });
    } else {
      P.squareTower(tg, { cx: 0, cz: 0, size: tower.size, baseY: 0, height: tower.height, palette, roof: tower.roof });
    }
    main.merge(tg, cx, baseY, cz);
  }
}

function houseArchetype(spec, palette, rng) {
  const grid = new BlockGrid();
  const foundation = foundationSpec(spec);
  const baseY = foundation.depth;
  buildFoundation(grid, spec, palette, baseY);
  const info = P.shell(grid, {
    w: spec.w, l: spec.l, shape: spec.shape, floors: spec.floors, floorHeight: spec.floorHeight,
    wallThickness: spec.wallThickness, palette, windowPattern: spec.windowPattern,
    doorSide: spec.doorSide, baseY, parapet: spec.roofType === 'flat'
  });
  P.windows(grid, { ...info, floorHeight: spec.floorHeight, palette, pattern: spec.windowPattern });
  // Stairs between floors.
  for (let f = 1; f < spec.floors; f++) {
    const y = baseY + f * spec.floorHeight;
    P.stairFlight(grid, { x: 1 + (f % Math.max(1, spec.w - 3)), y: y - spec.floorHeight + 1, z: 2, levels: Math.min(4, spec.floorHeight), palette, direction: 'north' });
  }
  addTowers(grid, spec, palette, baseY, spec.tier);
  addWing(grid, spec, palette, rng);
  const roofTop = roofOver(grid, info, spec, palette, rng);
  if (spec.decor.chimney) {
    const cx = Math.max(1, spec.w - 2);
    const cz = Math.max(1, spec.l - 2);
    for (let y = baseY; y < roofTop + 1; y++) grid.set(cx, y, cz, 'bricks', 'DECORATION');
    grid.set(cx, roofTop + 1, cz, 'campfire', 'DECORATION');
  }
  if (spec.decor.balcony && spec.floors > 1) {
    const y = baseY + (spec.floors - 1) * spec.floorHeight;
    for (let x = 0; x < spec.w; x++) {
      if (info.mask(x, 0)) {
        grid.set(x, y - 1, -1, palette.roofBase, 'DECORATION');
        if (x % 3 === 0) grid.set(x, y, -1, palette.accent, 'DECORATION');
      }
    }
  }
  P.interiorRooms(grid, {
    mask: info.mask, w: spec.w, l: spec.l, floorYs: info.floorYs, floorHeight: spec.floorHeight,
    palette, rng, phases: PHASES, tier: spec.tier
  });
  if (spec.basement > 0) {
    const bw = Math.min(spec.w - 2, 24);
    const bl = Math.min(spec.l - 2, 24);
    const bx = Math.floor((spec.w - bw) / 2);
    const bz = Math.floor((spec.l - bl) / 2);
    const by = 1;
    for (let y = by; y <= by + 3; y++) {
      for (let z = bz; z < bz + bl; z++) {
        for (let x = bx; x < bx + bw; x++) {
          const edge = x === bx || x === bx + bw - 1 || z === bz || z === bz + bl - 1;
          if (edge) grid.set(x, y, z, palette.accent, 'FOUNDATION');
          else if (y === by) grid.set(x, y, z, palette.floor, 'FLOORS');
          else grid.clear(x, y, z); // carve the room out of the foundation
        }
      }
    }
    for (let i = 0; i < Math.max(2, Math.floor(bw / 4)); i++) {
      grid.set(bx + 2 + i * 3, by + 1, bz + 2, 'chest', 'INTERIOR');
      grid.set(bx + 2 + i * 3, by + 2, bz + 2, palette.light, 'LIGHTING');
    }
    // Ladder shaft up to the ground floor.
    for (let y = baseY - 1; y >= by + 1; y--) grid.set(1, y, 1, 'ladder', 'STAIRS');
  }
  // Gardens and paths.
  if (spec.decor.path) {
    for (let z = spec.l; z < spec.l + 6; z++) for (let x = Math.floor(spec.w / 2) - 1; x <= Math.floor(spec.w / 2); x++) grid.set(x, baseY - 1, z, palette.path, 'DECORATION');
  }
  if (spec.decor.garden) {
    P.garden(grid, { x0: -6, z0: spec.l + 2, x1: -1, z1: spec.l + 8, y: baseY - 1, rng, palette });
  }
  if (spec.decor.fountain) {
    P.fountain(grid, { cx: Math.floor(spec.w / 2), cz: spec.l + 4, y: baseY - 1, radius: 2, palette });
  }
  if (spec.decor.statue) {
    P.statue(grid, { cx: -4, cz: spec.l + 3, y: baseY, palette, height: 3 + Math.floor(spec.tier / 2) });
  }
  for (let i = 0; i < spec.decor.trees; i++) {
    P.tree(grid, { x: -8 - i * 2, y: baseY, z: spec.l + 2 + i * 2, rng, size: 4 + (i % 3) });
  }
  if (spec.decor.fence) {
    for (let x = -10; x <= spec.w + 4; x++) {
      if (x % 2 === 0) grid.set(x, baseY, spec.l + 10, 'oak_fence', 'DECORATION');
    }
  }
  for (let i = 0; i < spec.decor.lanterns; i++) {
    const x = (i * 5) % Math.max(1, spec.w);
    const z = spec.l + 1;
    grid.set(x, baseY + 2, z, 'oak_fence', 'DECORATION');
    grid.set(x, baseY + 3, z, palette.light, 'LIGHTING');
  }
  return grid;
}

function fortressArchetype(spec, palette, rng) {
  const grid = new BlockGrid();
  const foundation = foundationSpec(spec);
  const baseY = foundation.depth;
  const outerW = spec.w;
  const outerL = spec.l;
  const wallHeight = Math.max(4, 3 + Math.floor(spec.tier / 2));
  // Outer wall
  for (let y = baseY; y < baseY + wallHeight; y++) {
    for (let z = 0; z < outerL; z++) {
      for (let x = 0; x < outerW; x++) {
        const edge = x < spec.wallThickness || x >= outerW - spec.wallThickness || z < spec.wallThickness || z >= outerL - spec.wallThickness;
        if (!edge) continue;
        const corner = (x < spec.wallThickness || x >= outerW - spec.wallThickness) && (z < spec.wallThickness || z >= outerL - spec.wallThickness);
        grid.set(x, y, z, corner ? palette.frame : (y % 4 === 3 ? palette.accent : palette.primary), 'WALLS');
      }
    }
  }
  P.battlements(grid, 0, 0, outerW - 1, outerL - 1, baseY + wallHeight, palette);
  // Gatehouse
  const gateX = Math.floor(outerW / 2);
  for (let y = baseY + 1; y <= baseY + 3; y++) {
    grid.set(gateX - 1, y, outerL - 1, 'air', 'WALLS');
    grid.set(gateX, y, outerL - 1, 'air', 'WALLS');
    grid.set(gateX + 1, y, outerL - 1, 'air', 'WALLS');
  }
  for (let y = baseY + 4; y <= baseY + 6; y++) {
    for (let x = gateX - 2; x <= gateX + 2; x++) {
      grid.set(x, y, outerL - 1, palette.primary, 'TOWERS');
      grid.set(x, y, outerL, palette.primary, 'TOWERS');
    }
  }
  P.battlements(grid, gateX - 2, outerL - 2, gateX + 2, outerL - 1, baseY + 7, palette);
  // Corner towers
  for (const tower of spec.towers.slice(0, 4)) {
    const cx = tower.fx < 0 ? spec.wallThickness + 1 : outerW - spec.wallThickness - 2;
    const cz = tower.fz < 0 ? spec.wallThickness + 1 : outerL - spec.wallThickness - 2;
    const tg = new BlockGrid();
    if (tower.round) P.roundTower(tg, { cx: 0, cz: 0, radius: Math.max(2, Math.floor(tower.size / 2)), baseY: 0, height: tower.height, palette });
    else P.squareTower(tg, { cx: 0, cz: 0, size: tower.size, baseY: 0, height: tower.height, palette, roof: tower.roof });
    grid.merge(tg, cx, baseY, cz);
  }
  // Inner keep: a scaled-down house archetype in the courtyard.
  const keepW = Math.max(7, Math.floor(outerW * 0.45));
  const keepL = Math.max(7, Math.floor(outerL * 0.45));
  const keepSpec = {
    ...spec, w: keepW, l: keepL, floors: Math.max(2, Math.min(4, spec.floors)), shape: 'rect',
    towers: spec.towers.slice(0, 2), wings: spec.wings.slice(0, 1), decor: { ...spec.decor, garden: false, fountain: false, trees: 0 },
    roofType: spec.tier >= 6 ? 'hip' : 'gable', basement: Math.max(1, spec.basement), tier: spec.tier
  };
  const keepGrid = houseArchetype(keepSpec, palette, rng);
  const kx = Math.floor((outerW - keepW) / 2);
  const kz = Math.floor((outerL - keepL) / 2);
  grid.merge(keepGrid, kx, 0, kz);
  // Courtyard features.
  if (spec.courtyard) {
    P.fountain(grid, { cx: Math.floor(outerW / 2), cz: Math.max(6, Math.floor(outerL / 4)), y: baseY - 1, radius: 3, palette });
    P.garden(grid, { x0: 2, z0: 2, x1: Math.floor(outerW / 3), z1: Math.floor(outerL / 3), y: baseY, rng, palette });
    for (let i = 0; i < Math.min(6, spec.decor.trees); i++) {
      P.tree(grid, { x: 3 + i * 4, y: baseY, z: outerL - 5, rng, size: 4 });
    }
  }
  // Moat
  if (spec.decor.moat) {
    const m = spec.decor.moatWidth;
    for (let z = -m; z < outerL + m; z++) {
      for (let x = -m; x < outerW + m; x++) {
        const outside = x < 0 || x >= outerW || z < 0 || z >= outerL;
        if (!outside) continue;
        grid.set(x, baseY - 1, z, 'water', 'DECORATION');
        grid.set(x, baseY - 2, z, 'stone', 'DECORATION');
      }
    }
  }
  // Barracks / storage along the walls.
  for (let i = 0; i < Math.max(2, Math.floor(spec.tier / 2)); i++) {
    const x = 2 + (i * 3) % Math.max(2, outerW - 4);
    grid.set(x, baseY, 2, 'chest', 'INTERIOR');
    grid.set(x + 1, baseY, 2, 'crafting_table', 'INTERIOR');
    grid.set(x, baseY + 2, 2, palette.light, 'LIGHTING');
  }
  return grid;
}

function templeArchetype(spec, palette, rng) {
  const grid = new BlockGrid();
  const foundation = foundationSpec(spec);
  const baseY = foundation.depth;
  const terraces = Math.max(1, spec.decor.terraces);
  let platformY = baseY;
  const insetStep = Math.max(1, Math.floor(Math.min(spec.w, spec.l) * 0.08));
  // Stepped platform
  for (let i = 0; i < terraces; i++) {
    const inset = i * insetStep;
    for (let z = inset; z < spec.l - inset; z++) {
      for (let x = inset; x < spec.w - inset; x++) {
        grid.set(x, platformY, z, i % 2 === 0 ? palette.primary : palette.accent, 'FOUNDATION');
        if (x === inset || x === spec.w - 1 - inset || z === inset || z === spec.l - 1 - inset) {
          grid.set(x, platformY + 1, z, palette.pillar, 'WALLS');
        }
      }
    }
    platformY += 1;
  }
  const innerW = Math.max(6, spec.w - 2 * insetStep);
  const innerL = Math.max(6, spec.l - 2 * insetStep);
  const info = P.shell(grid, {
    w: innerW, l: innerL, shape: 'rect', floors: Math.max(1, spec.floors - 1), floorHeight: spec.floorHeight,
    palette, windowPattern: 'sparse', doorSide: spec.doorSide, baseY: platformY
  });
  P.columns(grid, { x0: 1, z0: 1, x1: innerW - 2, z1: innerL - 2, y0: platformY + 1, y1: platformY + spec.floorHeight, palette, spacing: 3 });
  const roofTop = roofOver(grid, info, { ...spec, roofType: spec.roofType === 'flat' ? 'pyramid' : spec.roofType, decor: { ...spec.decor, glow: true } }, palette, rng);
  // Shrine / altar at the centre.
  const cx = Math.floor(innerW / 2);
  const cz = Math.floor(innerL / 2);
  grid.set(cx, platformY + 1, cz, 'enchanting_table', 'INTERIOR');
  grid.set(cx - 1, platformY + 1, cz, palette.pillar, 'INTERIOR');
  grid.set(cx + 1, platformY + 1, cz, palette.pillar, 'INTERIOR');
  grid.set(cx, roofTop, cz, 'gold_block', 'DECORATION');
  // Garden / pagoda fringe.
  P.garden(grid, { x0: -6, z0: -4, x1: -1, z1: spec.l + 4, y: baseY - 1, rng, palette });
  for (let i = 0; i < Math.max(2, spec.tier); i++) {
    P.tree(grid, { x: -9, y: baseY, z: 2 + i * 5, rng, size: 4 + (i % 2) });
  }
  for (let i = 0; i < spec.decor.lanterns; i++) {
    const x = (i * 3) % Math.max(1, spec.w);
    grid.set(x, baseY + 2, -3, 'oak_fence', 'DECORATION');
    grid.set(x, baseY + 3, -3, palette.light, 'LIGHTING');
  }
  if (spec.decor.statue) P.statue(grid, { cx: spec.w + 4, cz: Math.floor(spec.l / 2), y: baseY, palette, height: 4 + Math.floor(spec.tier / 2) });
  return grid;
}

function modernArchetype(spec, palette, rng) {
  const grid = new BlockGrid();
  const foundation = foundationSpec(spec);
  const baseY = foundation.depth;
  buildFoundation(grid, spec, palette, baseY);
  const floors = Math.max(3, spec.floors + 1);
  const floorHeight = 4;
  let w = spec.w;
  let l = spec.l;
  let ox = 0;
  let oz = 0;
  for (let f = 0; f < floors; f++) {
    const setback = f > 0 && f % 2 === 0 && spec.tier >= 5 ? 2 : 0;
    if (setback) { w -= 2; l -= 2; ox += 1; oz += 1; }
    const y0 = baseY + f * floorHeight;
    for (let z = 0; z < l; z++) {
      for (let x = 0; x < w; x++) {
        grid.set(ox + x, y0, oz + z, palette.floor, 'FLOORS');
        const edge = x === 0 || x === w - 1 || z === 0 || z === l - 1;
        if (!edge) continue;
        for (let y = 1; y < floorHeight; y++) {
          const glassBand = y <= 2 && f > 0;
          grid.set(ox + x, y0 + y, oz + z, glassBand ? palette.glass : palette.wall, 'WALLS');
        }
      }
    }
    // Roof deck / balconies.
    if (f === floors - 1) {
      for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
        if (x === 0 || x === w - 1 || z === 0 || z === l - 1) grid.set(ox + x, y0 + floorHeight, oz + z, palette.accent, 'ROOF');
        else grid.set(ox + x, y0 + floorHeight - 1, oz + z, palette.roofBase, 'ROOF');
      }
      if (spec.decor.garden) P.garden(grid, { x0: ox + 2, z0: oz + 2, x1: ox + w - 3, z1: oz + l - 3, y: y0 + floorHeight - 1, rng, palette });
      if (spec.decor.fountain) P.fountain(grid, { cx: ox + Math.floor(w / 2), cz: oz + Math.floor(l / 2), y: y0 + floorHeight - 1, radius: 2, palette });
    } else if (spec.decor.balcony) {
      for (let x = 0; x < w; x += 2) {
        grid.set(ox + x, y0 + 1, oz - 1, palette.accent, 'DECORATION');
        grid.set(ox + x, y0 + 2, oz - 1, palette.glass, 'DECORATION');
      }
    }
    // Lobby on the ground floor and offices above.
    for (let i = 0; i < 3; i++) {
      grid.set(ox + 2 + i * 3, y0 + 1, oz + 2, i === 0 ? 'crafting_table' : 'chest', 'INTERIOR');
    }
    grid.set(ox + Math.floor(w / 2), y0 + floorHeight - 1, oz + Math.floor(l / 2), palette.light, 'LIGHTING');
    // Elevator core.
    for (let y = y0 + 1; y <= y0 + floorHeight; y++) grid.set(ox + Math.floor(w / 2), y, oz + Math.floor(l / 2) + 1, 'ladder', 'STAIRS');
  }
  // Entrance plaza.
  for (let z = l + 1; z < l + 7; z++) {
    for (let x = Math.floor(w / 2) - 2; x <= Math.floor(w / 2) + 2; x++) grid.set(ox + x, baseY - 1, oz + z, palette.path, 'DECORATION');
  }
  for (let i = 0; i < Math.min(4, spec.decor.trees); i++) {
    P.tree(grid, { x: -3 - i * 3, y: baseY, z: 2 + i * 4, rng, size: 4 });
  }
  P.statue(grid, { cx: -4, cz: l + 3, y: baseY, palette, height: 5 });
  return { grid, roofTop: baseY + floors * floorHeight };
}

function infrastructureArchetype(spec, palette, rng) {
  const grid = new BlockGrid();
  const baseY = foundationSpec(spec).depth + 3;
  if (spec.category === 'bridge') {
    const span = Math.max(10, spec.l * 3);
    const width = Math.max(3, Math.min(9, spec.w));
    for (const x of [0, 1, span - 2, span - 1]) {
      for (let z = 0; z < width; z++) {
        for (let y = baseY - 6; y <= baseY; y++) grid.set(x, y, z, palette.frame, 'FOUNDATION');
      }
    }
    for (let x = 0; x < span; x++) {
      const arch = Math.round(Math.sin((x / span) * Math.PI) * Math.min(6, spec.tier + 1));
      for (let z = 0; z < width; z++) {
        grid.set(x, baseY + arch, z, palette.primary, 'FLOORS');
        grid.set(x, baseY + arch + 1, z, z === 0 || z === width - 1 ? 'oak_fence' : 'air', 'DECORATION');
      }
      // Arch supports
      if (x % 6 === 3) {
        for (let y = baseY + arch - 1; y > baseY - 6; y--) {
          const phase = y <= baseY - 4 ? 'FOUNDATION' : 'WALLS';
          grid.set(x, y, 0, palette.accent, phase);
          grid.set(x, y, width - 1, palette.accent, phase);
        }
      }
    }
    for (let x = 0; x < span; x += 5) {
      grid.set(x, baseY + 2, Math.floor(width / 2), palette.light, 'LIGHTING');
    }
    return grid;
  }
  if (spec.category === 'aqueduct') {
    const span = Math.max(12, spec.l * 2 + rng.int(-3, 7));
    const channelWidth = 3 + rng.int(0, spec.tier >= 5 ? 3 : 1);
    const height = 4 + rng.int(0, 4 + spec.tier);
    const archSpacing = rng.int(4, 9);
    const twinTier = spec.tier >= 5 && rng.chance(0.5);
    const walkway = rng.chance(0.6);
    for (let x = 0; x < span; x++) {
      for (let z = 0; z < channelWidth; z++) {
        grid.set(x, baseY + height, z, palette.accent, 'WALLS');
        const isChannel = z > 0 && z < channelWidth - 1;
        grid.set(x, baseY + height + 1, z, isChannel ? 'water' : palette.primary, 'DECORATION');
        if (walkway && z === channelWidth - 1) grid.set(x, baseY + height + 2, z, 'oak_fence', 'DECORATION');
      }
      // Tall supporting piers at regular spacing.
      if (x % archSpacing === 0) {
        grid.set(x, baseY, 0, palette.accent, 'FOUNDATION');
        grid.set(x, baseY, channelWidth - 1, palette.accent, 'FOUNDATION');
        for (let y = 1; y <= height; y++) {
          grid.set(x, baseY + y, 0, palette.primary, 'WALLS');
          grid.set(x, baseY + y, channelWidth - 1, palette.primary, 'WALLS');
          if (twinTier) {
            grid.set(x, baseY + Math.floor(y / 2), 1, palette.accent, 'WALLS');
            grid.set(x, baseY + Math.floor(y / 2), channelWidth - 2, palette.accent, 'WALLS');
          }
        }
        // Arch curve between piers.
        const archRise = Math.min(4, Math.floor(archSpacing / 2));
        for (let k = 1; k <= archRise; k++) {
          // L-shaped step so every arch block touches the previous step.
          for (const [ax, ay] of [[x + k, height - k], [x + k - 1, height - k]]) {
            grid.set(ax, baseY + ay, 0, palette.frame, 'WALLS');
            grid.set(ax, baseY + ay, channelWidth - 1, palette.frame, 'WALLS');
          }
        }
      }
      if (x % (archSpacing * 2) === 0) grid.set(x, baseY + height + 3, Math.floor(channelWidth / 2), palette.light, 'LIGHTING');
    }
    // End towers to mark the aqueduct.
    for (const endX of [0, span - 1]) {
      for (let y = 0; y <= height + 3; y++) {
        for (let z = -1; z <= channelWidth; z++) {
          const edge = y === height + 3 || z === -1 || z === channelWidth;
          if (edge) grid.set(endX, baseY + y, z, palette.frame, 'TOWERS');
        }
      }
    }
    return grid;
  }
  if (spec.category === 'dock' || spec.category === 'pier' || spec.category === 'harbor') {
    const len = Math.max(8, spec.l);
    const width = Math.max(4, Math.min(14, spec.w));
    for (let z = 0; z < len; z++) {
      for (let x = 0; x < width; x++) {
        grid.set(x, baseY, z, 'oak_planks', 'FLOORS');
        if (z % 5 === 0 && (x === 0 || x === width - 1)) {
          for (let y = baseY - 1; y > baseY - 5; y--) grid.set(x, y, z, 'oak_log', 'FOUNDATION');
        }
      }
    }
    // Crane + warehouse
    for (let y = baseY + 1; y <= baseY + 5; y++) {
      grid.set(width - 2, y, 2, 'oak_log', 'DECORATION');
      grid.set(width - 2, y, 5, 'oak_log', 'DECORATION');
    }
    for (let x = width - 2; x >= width - 6; x--) grid.set(x, baseY + 5, 2, 'oak_fence', 'DECORATION');
    grid.set(width - 6, baseY + 4, 2, 'iron_bars', 'DECORATION');
    const wh = houseArchetype({ ...spec, w: Math.max(7, Math.floor(width * 0.8)), l: 8, floors: 1, shape: 'rect', towers: [], wings: [], decor: { ...spec.decor, trees: 0, garden: false }, roofType: 'gable', tier: Math.min(spec.tier, 4) }, palette, rng);
    grid.merge(wh, width + 2, 0, 2);
    return grid;
  }
  if (spec.category === 'railway') {
    const length = Math.max(18, spec.l * 2 + rng.int(-4, 6));
    const tracks = 1 + rng.int(0, spec.tier >= 4 ? 2 : 1);
    const width = 4 + tracks * 2 + rng.int(0, 2);
    const clearance = 4 + rng.int(0, 2);
    const openCut = rng.chance(0.35);
    const station = rng.chance(0.5);
    const bridgeSegments = rng.int(0, 3 + Math.floor(spec.tier / 2));
    for (let x = 0; x < length; x++) {
      const isBridge = bridgeSegments > 0 && Math.floor(x / 12) % 2 === 0;
      for (let z = 0; z < width; z++) {
        // Roadbed
        grid.set(x, baseY, z, palette.floor, 'FOUNDATION');
        for (let t = 0; t < tracks; t++) {
          const trackZ = 1 + t * 2;
          grid.set(x, baseY + 1, trackZ, 'rail', 'DECORATION');
        }
        if (!openCut) {
          const edge = z === 0 || z === width - 1;
          for (let y = 1; y <= clearance; y++) {
            if (edge) grid.set(x, baseY + y + 1, z, y === clearance ? palette.accent : palette.primary, 'WALLS');
            else if (y === clearance) grid.set(x, baseY + y + 1, z, palette.accent, 'ROOF');
          }
        }
      }
      if (isBridge) {
        // Arched viaduct under the track bed.
        for (let z = 0; z < width; z += 2) {
          for (let y = baseY - 1; y > baseY - 6; y--) grid.set(x, y, z, palette.accent, 'FOUNDATION');
        }
        grid.set(x, baseY - 1, Math.floor(width / 2), palette.frame, 'FOUNDATION');
      }
      // Signals and lamps.
      if (x % 9 === 0) {
        grid.set(x, baseY + 2, 0, 'oak_fence', 'DECORATION');
        grid.set(x, baseY + 3, 0, palette.light, 'LIGHTING');
        grid.set(x, baseY + 4, 0, 'redstone_lamp', 'DECORATION');
      }
      if (station && x > length * 0.3 && x < length * 0.7 && x % 6 === 0) {
        for (let z = 0; z < width; z++) grid.set(x, baseY + clearance + 3, z, palette.glass, 'ROOF');
        for (let y = 2; y <= clearance + 2; y++) {
          grid.set(x, baseY + y, width - 1, palette.pillar, 'WALLS');
        }
        grid.set(x, baseY + 2, width - 1, 'white_bed', 'INTERIOR');
        grid.set(x, baseY + 2, 1, 'chest', 'INTERIOR');
        grid.set(x, baseY + 1, 1, 'crafting_table', 'INTERIOR');
      }
    }
    // End portal frames.
    for (const endX of [0, length - 1]) {
      for (let y = 0; y <= clearance + 3; y++) {
        for (let z = -1; z <= width; z++) {
          const edge = y === clearance + 3 || z === -1 || z === width;
          if (edge) grid.set(endX, baseY + y, z, palette.frame, 'WALLS');
        }
      }
    }
    return grid;
  }
  if (spec.category === 'tunnel' || spec.category === 'mine_entrance' || spec.category === 'railway') {
    const len = Math.max(10, spec.l * 2);
    const width = Math.max(3, Math.min(9, spec.w));
    for (let x = 0; x < len; x++) {
      for (let z = 0; z < width; z++) {
        grid.set(x, baseY - 5, z, palette.floor, 'FOUNDATION');
        for (let y = 0; y < 4; y++) {
          const edge = z === 0 || z === width - 1 || y === 0 || y === 3;
          if (edge) grid.set(x, baseY - 4 + y, z, y === 3 ? palette.accent : palette.primary, 'WALLS');
        }
        if (z === 1 || z === width - 2) grid.set(x, baseY - 4, z, 'rail', 'DECORATION');
      }
      if (x % 8 === 0) {
        for (let y = 0; y < 3; y++) {
          grid.set(x, baseY - 3 + y, 0, palette.frame, 'DECORATION');
          grid.set(x, baseY - 3 + y, width - 1, palette.frame, 'DECORATION');
        }
        grid.set(x, baseY - 1, Math.floor(width / 2), palette.light, 'LIGHTING');
      }
    }
    // Portal
    for (let y = 0; y < 6; y++) {
      for (let z = 0; z < width + 2; z++) {
        if (y === 0 || y === 5 || z === 0 || z === width + 1) grid.set(0, baseY - 5 + y, z - 1, palette.accent, 'WALLS');
      }
    }
    return grid;
  }
  if (spec.category === 'station' || spec.category === 'grand_station') {
    const len = Math.max(20, spec.l * 2);
    const width = Math.max(10, spec.w);
    for (let x = 0; x < len; x++) {
      for (let z = 0; z < width; z++) {
        grid.set(x, baseY - 1, z, 'stone_bricks', 'FOUNDATION');
        grid.set(x, baseY, z, palette.floor, 'FLOORS');
        if (z === 2 || z === width - 3) grid.set(x, baseY + 1, z, 'rail', 'DECORATION');
      }
      if (x % 10 === 0) {
        for (let z = 0; z < width; z++) {
          grid.set(x, baseY + 7, z, palette.glass, 'ROOF');
          grid.set(x, baseY + 8, z, palette.roofBase, 'ROOF');
        }
        for (let y = 1; y <= 7; y++) {
          grid.set(x, baseY + y, 0, palette.pillar, 'WALLS');
          grid.set(x, baseY + y, width - 1, palette.pillar, 'WALLS');
        }
      }
      if (x % 12 === 4) {
        grid.set(x, baseY + 2, 1, 'white_bed', 'INTERIOR');
        grid.set(x, baseY + 1, width - 2, 'chest', 'INTERIOR');
        grid.set(x, baseY + 6, Math.floor(width / 2), palette.light, 'LIGHTING');
      }
    }
    return grid;
  }
  // Well / road / plaza-style infrastructure.
  for (let z = -4; z < spec.l + 4; z++) {
    for (let x = -4; x < spec.w + 4; x++) {
      const edge = x === -4 || z === -4 || x === spec.w + 3 || z === spec.l + 3;
      grid.set(x, baseY - 3, z, 'stone', 'FOUNDATION');
      if (edge) for (let y = baseY - 2; y <= baseY - 1; y++) grid.set(x, y, z, palette.accent, 'WALLS');
    }
  }
  const r = Math.max(2, Math.floor(spec.w / 4));
  P.fountain(grid, { cx: Math.floor(spec.w / 2), cz: Math.floor(spec.l / 2), y: baseY - 1, radius: r, palette });
  for (let z = -2; z < spec.l + 2; z++) grid.set(Math.floor(spec.w / 2), baseY - 2, z, palette.path, 'DECORATION');
  for (let x = -2; x < spec.w + 2; x++) grid.set(x, baseY - 2, Math.floor(spec.l / 2), palette.path, 'DECORATION');
  P.garden(grid, { x0: 2, z0: 2, x1: 6, z1: 6, y: baseY - 1, rng, palette });
  return grid;
}

function gardenArchetype(spec, palette, rng) {
  const grid = new BlockGrid();
  const baseY = 2;
  const w = Math.max(10, spec.w);
  const l = Math.max(10, spec.l);
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      const edge = x === 0 || z === 0 || x === w - 1 || z === l - 1;
      grid.set(x, baseY - 3, z, 'stone', 'FOUNDATION');
      if (edge) grid.set(x, baseY - 1, z, palette.accent, 'WALLS');
      else grid.set(x, baseY - 2, z, 'grass_block', 'TERRAIN');
    }
  }
  if (spec.decor.maze) {
    // Generated hedge maze with guaranteed central chamber.
    for (let z = 2; z < l - 2; z += 3) {
      for (let x = 2; x < w - 2; x++) {
        if (Math.abs(x - w / 2) < 3 && Math.abs(z - l / 2) < 3) continue;
        if ((x + z) % 5 !== 0) grid.set(x, baseY, z, 'oak_leaves', 'DECORATION');
      }
    }
    for (let x = 3; x < w - 3; x += 4) {
      for (let z = 3; z < l - 3; z++) {
        if (Math.abs(x - w / 2) < 3 && Math.abs(z - l / 2) < 3) continue;
        grid.set(x, baseY, z, 'oak_leaves', 'DECORATION');
      }
    }
  }
  P.fountain(grid, { cx: Math.floor(w / 2), cz: Math.floor(l / 2), y: baseY - 1, radius: Math.max(2, Math.floor(Math.min(w, l) / 8)), palette });
  for (let i = 0; i < Math.max(3, spec.decor.trees); i++) {
    P.tree(grid, { x: 3 + (i * 5) % (w - 6), y: baseY, z: 3 + (i * 7) % (l - 6), rng, size: 4 + (i % 3) });
  }
  P.garden(grid, { x0: 2, z0: 2, x1: 5, z1: 5, y: baseY - 1, rng, palette });
  if (spec.decor.statue) P.statue(grid, { cx: 3, cz: l - 4, y: baseY, palette, height: 5 + Math.floor(spec.tier / 2) });
  for (let i = 0; i < spec.decor.lanterns; i++) {
    const x = 2 + (i * 3) % (w - 4);
    grid.set(x, baseY, 0, 'oak_fence', 'DECORATION');
    grid.set(x, baseY + 1, 0, palette.light, 'LIGHTING');
  }
  // Central pavilion
  const pv = new BlockGrid();
  const info = P.shell(pv, { w: 7, l: 7, shape: 'octagon', floors: 1, floorHeight: 4, palette, doorSide: 'south', baseY: 0 });
  P.pyramidRoof(pv, 0, 0, 6, 6, info.wallTop, palette);
  P.interiorRooms(pv, { mask: info.mask, w: 7, l: 7, floorYs: info.floorYs, floorHeight: 4, palette, rng, phases: PHASES, tier: spec.tier });
  grid.merge(pv, Math.floor(w / 2) - 3, baseY - 1, Math.floor(l / 2) + 2);
  return grid;
}

function undergroundArchetype(spec, palette, rng) {
  const grid = new BlockGrid();
  const baseY = Math.max(4, spec.basement * 4 + 4);
  const w = Math.max(10, Math.min(spec.w, 56));
  const l = Math.max(10, Math.min(spec.l, 56));
  // Entrance stairwell from the surface.
  for (let i = 0; i < baseY; i++) {
    for (let d = 0; d < 2; d++) {
      grid.set(-1 - i, baseY + 2 - i, d, 'stone_bricks', 'FOUNDATION');
      grid.set(-1 - i, baseY + 3 - i, d, 'air', 'WALLS');
      grid.set(-1 - i, baseY + 4 - i, d, 'stone_bricks', 'FOUNDATION');
    }
  }
  const rooms = Math.max(2, Math.floor(spec.tier + rng.int(0, 2)));
  const roomW = Math.max(8, Math.floor(w / Math.max(2, Math.ceil(Math.sqrt(rooms)))));
  const roomL = Math.max(8, Math.floor(l / Math.max(2, Math.ceil(Math.sqrt(rooms)))));
  let idx = 0;
  for (let gz = 0; gz < l; gz += roomL + 2) {
    for (let gx = 0; gx < w; gx += roomW + 2) {
      idx++;
      const x0 = gx;
      const z0 = gz;
      for (let y = 0; y < 5; y++) {
        for (let z = z0; z < Math.min(l, z0 + roomL); z++) {
          for (let x = x0; x < Math.min(w, x0 + roomW); x++) {
            const edge = x === x0 || x === Math.min(w, x0 + roomW) - 1 || z === z0 || z === Math.min(l, z0 + roomL) - 1;
            if (y === 0) grid.set(x, baseY - 5, z, palette.floor, 'FLOORS');
            else if (edge) grid.set(x, baseY - 5 + y, z, palette.primary, 'WALLS');
            else if (y === 4) grid.set(x, baseY - 5 + y, z, palette.accent, 'ROOF');
          }
        }
      }
      // Doorways between rooms.
      const doorX = x0 + Math.floor(roomW / 2);
      const doorZ = z0 + Math.floor(roomL / 2);
      for (let y = 1; y <= 2; y++) {
        if (x0 > 0) grid.set(x0, baseY - 4 + y, doorZ, 'air', 'WALLS');
        if (z0 > 0) grid.set(doorX, baseY - 4 + y, z0, 'air', 'WALLS');
      }
      // Contents by room index.
      const type = idx % 5;
      if (type === 0) { grid.set(x0 + 2, baseY - 4, z0 + 2, 'chest', 'INTERIOR'); grid.set(x0 + 3, baseY - 4, z0 + 2, 'chest', 'INTERIOR'); }
      if (type === 1) { grid.set(x0 + 2, baseY - 4, z0 + 2, 'furnace', 'INTERIOR'); grid.set(x0 + 3, baseY - 4, z0 + 2, 'crafting_table', 'INTERIOR'); }
      if (type === 2) { grid.set(x0 + 2, baseY - 4, z0 + 2, 'enchanting_table', 'INTERIOR'); grid.set(x0 + 4, baseY - 4, z0 + 2, 'bookshelf', 'INTERIOR'); }
      if (type === 3) { grid.set(x0 + 2, baseY - 4, z0 + 2, 'white_bed', 'INTERIOR'); }
      if (type === 4) { grid.set(x0 + 2, baseY - 4, z0 + 2, 'brewing_stand', 'INTERIOR'); grid.set(x0 + 4, baseY - 4, z0 + 2, 'cauldron', 'INTERIOR'); }
      grid.set(x0 + 1, baseY - 1, z0 + 1, palette.light, 'LIGHTING');
    }
  }
  // Pillared central hall.
  const cx = Math.floor(w / 2);
  const cz = Math.floor(l / 2);
  for (let i = 0; i < spec.decor.pillars; i++) {
    const px = (i * 7) % Math.max(2, w - 2);
    const pz = (i * 5) % Math.max(2, l - 2);
    for (let y = baseY - 4; y <= baseY - 1; y++) grid.set(px, y, pz, palette.pillar, 'DECORATION');
  }
  grid.set(cx, baseY - 1, cz, 'sea_lantern', 'LIGHTING');
  return grid;
}

function fantasyArchetype(spec, palette, rng) {
  const grid = new BlockGrid();
  const baseY = 8;
  if (spec.category === 'treehouse' || spec.category === 'world_tree_palace') {
    const trunkH = spec.category === 'world_tree_palace' ? 18 + spec.tier * 2 : 9 + spec.tier;
    const cx = Math.floor(spec.w / 2);
    const cz = Math.floor(spec.l / 2);
    const trunkR = Math.max(1, Math.floor(spec.tier / 3));
    for (let y = 0; y < trunkH; y++) {
      for (let dz = -trunkR; dz <= trunkR; dz++) {
        for (let dx = -trunkR; dx <= trunkR; dx++) {
          if (Math.hypot(dx, dz) <= trunkR + 0.3) grid.set(cx + dx, y, cz + dz, 'oak_log', 'FOUNDATION');
        }
      }
    }
    // Canopy
    for (let dy = 0; dy < 8; dy++) {
      const r = 7 - Math.floor(dy / 2);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.hypot(dx, dz) > r) continue;
          if (!grid.has(cx + dx, trunkH + dy, cz + dz)) grid.set(cx + dx, trunkH + dy, cz + dz, 'oak_leaves', 'DECORATION');
        }
      }
    }
    // Platform village in the canopy.
    const platformY = trunkH - 2;
    const pw = Math.max(9, Math.min(spec.w, 30));
    const pl = Math.max(9, Math.min(spec.l, 30));
    for (let z = 0; z < pl; z++) {
      for (let x = 0; x < pw; x++) {
        if (Math.hypot(x - pw / 2, z - pl / 2) > pw / 2) continue;
        grid.set(cx - Math.floor(pw / 2) + x, platformY, cz - Math.floor(pl / 2) + z, palette.floor, 'FLOORS');
      }
    }
    const hut = new BlockGrid();
    const info = P.shell(hut, { w: 9, l: 9, shape: 'octagon', floors: 1, floorHeight: 4, palette, doorSide: 'south', baseY: 0 });
    P.pyramidRoof(hut, 0, 0, 8, 8, info.wallTop, palette);
    P.interiorRooms(hut, { mask: info.mask, w: 9, l: 9, floorYs: info.floorYs, floorHeight: 4, palette, rng, phases: PHASES, tier: spec.tier });
    grid.merge(hut, cx - 4, platformY + 1, cz - 4);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      const lx = Math.round(cx + Math.cos(ang) * (pw / 2 - 2));
      const lz = Math.round(cz + Math.sin(ang) * (pl / 2 - 2));
      grid.set(lx, platformY + 3, lz, 'oak_fence', 'DECORATION');
      grid.set(lx, platformY + 4, lz, palette.light, 'LIGHTING');
    }
    return grid;
  }
  if (spec.category === 'dark_tower' || spec.category === 'arcane_academy') {
    const radius = Math.max(4, Math.floor(spec.w / 4));
    const height = 16 + spec.tier * 5;
    for (let dz = -radius - 2; dz <= radius + 2; dz++) {
      for (let dx = -radius - 2; dx <= radius + 2; dx++) {
        if (Math.hypot(dx, dz) > radius + 2) continue;
        grid.set(radius + dx, baseY - 1, radius + dz, 'stone', 'FOUNDATION');
        grid.set(radius + dx, baseY - 2, radius + dz, 'deepslate', 'FOUNDATION');
      }
    }
    for (let y = 0; y < height; y++) {
      const r = radius - Math.floor(y / 12);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dz);
          if (d > r + 0.4 || d < r - 0.9) continue;
          const isWindow = y % 7 === 4;
          grid.set(radius + dx, y + baseY, radius + dz, isWindow ? palette.glass : (y % 5 === 0 ? palette.frame : palette.primary), 'WALLS');
        }
      }
      if (y % 6 === 0) {
        for (let dz = -r + 1; dz < r - 1; dz++) for (let dx = -r + 1; dx < r - 1; dx++) {
          if (Math.hypot(dx, dz) < r - 1) grid.set(radius + dx, y + baseY, radius + dz, palette.floor, 'FLOORS');
        }
      }
    }
    P.domeRoof(grid, radius, radius, radius, baseY + height, palette);
    P.fountain(grid, { cx: radius, cz: radius * 2 + 4, y: baseY, radius: 2, palette });
    for (let i = 0; i < spec.decor.lanterns; i++) {
      grid.set(radius - radius + 2 + i * 2, baseY + 2, radius * 2 + 3, palette.light, 'LIGHTING');
    }
    return grid;
  }
  // Floating island / sky fortress / citadel / mega base / titan forge
  const r = Math.max(8, Math.min(20, spec.decor.island));
  const cx = r;
  const cz = r;
  // Inverted island underside
  for (let dy = 0; dy < Math.floor(r * 0.8); dy++) {
    const rr = Math.max(1, r - dy);
    for (let dz = -rr; dz <= rr; dz++) {
      for (let dx = -rr; dx <= rr; dx++) {
        if (Math.hypot(dx, dz) > rr) continue;
        const edge = Math.hypot(dx, dz) > rr - 1.5;
        if (dy === 0) grid.set(cx + dx, baseY - dy, cz + dz, 'grass_block', 'TERRAIN');
        else if (edge) grid.set(cx + dx, baseY - dy, cz + dz, dy < rr * 0.4 ? 'stone' : 'deepslate', 'FOUNDATION');
      }
    }
  }
  // Surface
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.hypot(dx, dz) > r) continue;
      grid.set(cx + dx, baseY, cz + dz, 'grass_block', 'TERRAIN');
    }
  }
  const buildW = Math.max(9, Math.min(spec.w, r * 2 - 4));
  const buildL = Math.max(9, Math.min(spec.l, r * 2 - 4));
  const keepGrid = new BlockGrid();
  const info = P.shell(keepGrid, {
    w: buildW, l: buildL, shape: spec.shape === 'rect' ? 'octagon' : spec.shape, floors: Math.max(2, spec.floors),
    floorHeight: spec.floorHeight, palette, windowPattern: spec.windowPattern, doorSide: spec.doorSide, baseY: 0
  });
  roofOver(keepGrid, info, { ...spec, roofType: spec.roofType }, palette, rng);
  P.interiorRooms(keepGrid, { mask: info.mask, w: buildW, l: buildL, floorYs: info.floorYs, floorHeight: spec.floorHeight, palette, rng, phases: PHASES, tier: spec.tier });
  grid.merge(keepGrid, cx - Math.floor(buildW / 2), baseY + 1, cz - Math.floor(buildL / 2));
  // Towers
  for (const tower of spec.towers.slice(0, 4)) {
    const tx = cx + tower.fx * Math.floor(buildW / 2);
    const tz = cz + tower.fz * Math.floor(buildL / 2);
    const tg = new BlockGrid();
    P.squareTower(tg, { cx: 0, cz: 0, size: tower.size, baseY: 0, height: tower.height, palette, roof: tower.roof });
    grid.merge(tg, tx, baseY + 1, tz);
  }
  // Sky bridges and waterfalls for scale.
  if (spec.tier >= 7) {
    for (let i = 0; i < 3; i++) {
      const bx = cx - r + 4 + i * 7;
      grid.set(bx, baseY - 1, cz - r, 'water', 'DECORATION');
      for (let y = 1; y < 12; y++) grid.set(bx, baseY - 1 - y, cz - r, 'water', 'DECORATION');
    }
  }
  P.tree(grid, { x: cx - r + 4, y: baseY + 1, z: cz + r - 4, rng, size: 4 });
  P.fountain(grid, { cx, cz: cz + Math.floor(r / 2), y: baseY + 1, radius: 2, palette });
  return grid;
}

const BUILDERS = {
  house: houseArchetype,
  fortress: fortressArchetype,
  temple: templeArchetype,
  modern: modernArchetype,
  infrastructure: infrastructureArchetype,
  garden: gardenArchetype,
  underground: undergroundArchetype,
  fantasy: fantasyArchetype
};

/** Generate one complete schematic from a structural spec. */

/**
 * Fix physically impossible standing torches before a schematic is emitted.
 * A torch needs a solid block below; a torch that has a solid horizontal
 * neighbour instead becomes the correct wall-torch block state. If neither
 * exists the blueprint is defective and generation fails rather than shipping
 * a floating light.
 */

/** Add the post/ground a generated decoration needs to be physically valid. */
function ensureVerticalSupports(grid) {
  const isFence = (name) => {
    const parsed = parseBlock(name);
    return parsed.name.endsWith('_fence') || parsed.name.endsWith('_fence_gate') || parsed.name.endsWith('_wall');
  };
  const solid = (x, y, z) => {
    const name = grid.get(x, y, z);
    if (!name) return false;
    const parsed = parseBlock(name);
    return !['air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'oak_leaves', 'birch_leaves', 'spruce_leaves'].includes(parsed.name);
  };
  const fenceCells = [...grid.cells.entries()].filter(([, name]) => isFence(name));
  for (const [key, name] of fenceCells) {
    const [x, y, z] = key.split(',').map(Number);
    if (solid(x, y - 1, z)) continue;
    for (let cursor = y - 1; cursor >= 0; cursor--) {
      const existing = grid.get(x, cursor, z);
      if (existing && solid(x, cursor, z)) break;
      grid.set(x, cursor, z, cursor === 0 ? 'dirt_path' : name, grid.phaseOf.get(key) || 'DECORATION');
      if (cursor === 0) break;
    }
  }
  const groundPlants = new Set(['short_grass', 'grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'blue_orchid',
    'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'oak_sapling', 'birch_sapling',
    'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'dead_bush',
    'brown_mushroom', 'red_mushroom', 'end_rod', 'lantern', 'soul_lantern', 'white_bed', 'red_bed', 'blue_bed',
    'chest', 'barrel', 'furnace', 'crafting_table', 'campfire']);
  for (const [key, name] of [...grid.cells]) {
    const parsed = parseBlock(name);
    if (!groundPlants.has(parsed.name)) continue;
    if (parsed.properties?.hanging === true) continue;
    const [x, y, z] = key.split(',').map(Number);
    if (solid(x, y - 1, z)) continue;
    if (y > 0) {
      const support = ['short_grass', 'grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'blue_orchid', 'allium',
        'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'oak_sapling', 'birch_sapling',
        'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'dead_bush',
        'brown_mushroom', 'red_mushroom'].includes(parsed.name) ? 'grass_block' : 'dirt_path';
      grid.set(x, y - 1, z, support, grid.phaseOf.get(key) || 'DECORATION');
    } else if (!grid.get(x, y, z) || parsed.name === 'end_rod') {
      throw new Error(`floating ${parsed.name} at ${key} has no support`);
    }
  }
}

function normalizeAttachments(grid) {
  const solids = new Set(['stone', 'cobblestone', 'stone_bricks', 'deepslate', 'deepslate_bricks', 'oak_planks', 'spruce_planks',
    'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
    'bricks', 'sandstone', 'smooth_stone', 'terracotta', 'nether_bricks', 'blackstone', 'quartz_block', 'prismarine', 'andesite',
    'diorite', 'granite', 'tuff', 'calcite', 'mud_bricks', 'packed_mud', 'copper_block', 'iron_block', 'bookshelf', 'barrel', 'crafting_table']);
  const isSolid = (x, y, z) => {
    const name = grid.get(x, y, z);
    if (!name) return false;
    const parsed = parseBlock(name);
    return solids.has(parsed.name) || parsed.name.endsWith('_log') || parsed.name.endsWith('_wood') || parsed.name.endsWith('_planks')
      || parsed.name.endsWith('_bricks') || parsed.name.endsWith('_block') && !parsed.name.endsWith('_leaves');
  };
  const directions = [
    { name: 'north', dx: 0, dz: -1 }, { name: 'south', dx: 0, dz: 1 },
    { name: 'east', dx: 1, dz: 0 }, { name: 'west', dx: -1, dz: 0 }
  ];
  for (const [key, name] of [...grid.cells]) {
    const parsed = parseBlock(name);
    if (!['torch', 'soul_torch', 'redstone_torch'].includes(parsed.name)) continue;
    const [x, y, z] = key.split(',').map(Number);
    if (isSolid(x, y - 1, z)) continue;
    let fixed = null;
    for (const dir of directions) {
      if (!isSolid(x + dir.dx, y, z + dir.dz)) continue;
      // Wall torch `facing` points away from its supporting wall.
      const facing = dir.name === 'north' ? 'south' : dir.name === 'south' ? 'north' : dir.name === 'east' ? 'west' : 'east';
      fixed = `${parsed.name.replace(/_?torch$/, '')}${parsed.name === 'torch' ? 'wall_torch' : parsed.name.replace('torch', 'wall_torch')}[facing=${facing}]`;
      break;
    }
    if (!fixed) {
      // No wall to attach to. Give the torch a real floor mount instead of
      // emitting a floating light; if even that is impossible, fail loudly.
      if (y <= 0) throw new Error(`floating ${parsed.name} at ${key} has no support`);
      grid.set(x, y - 1, z, 'cobblestone', 'DECORATION');
      continue;
    }
    grid.set(x, y, z, fixed, grid.phaseOf.get(key) || 'LIGHTING');
  }
}

function generateSchematic(spec, { id, name } = {}) {
  const rng = new Rng(`${spec.seed}:build:${spec.variant}`);
  const palette = paletteFor(spec.style, (list) => rng.pick(list));
  const builder = BUILDERS[spec.archetype] || houseArchetype;
  const result = builder(spec, palette, rng);
  const grid = result && result.grid ? result.grid : result;
  if (!grid || !grid.cells.size) throw new Error(`generator produced no blocks for ${spec.archetype}`);
  ensureVerticalSupports(grid);
  normalizeAttachments(grid);
  grid.shiftToOrigin();
  const bounds = grid.bounds();
  if (!bounds || bounds.width > 400 || bounds.length > 400 || bounds.height > 400) throw new Error('generated structure out of bounds');
  if (grid.cells.size > 80000) throw new Error(`generated structure too large (${grid.cells.size} blocks)`);
  const compiled = grid.compile();
  const materials = grid.materials();
  const phaseCounts = grid.countByPhase();
  const phases = PHASES.filter((p) => phaseCounts[p]).map((p, i) => ({ name: p, index: i, blockCount: phaseCounts[p] }));
  const schematic = {
    id,
    name,
    tier: spec.tierName,
    tierIndex: spec.tier,
    difficulty: spec.difficulty,
    category: spec.category,
    archetype: spec.archetype,
    style: spec.style,
    seed: spec.seed,
    dimensions: { width: bounds.width, height: bounds.height, length: bounds.length },
    palette: compiled.palette,
    blocks: compiled.blocks,
    phases,
    materials,
    foundation: foundationSpec(spec),
    supports: foundationSpec(spec).supports,
    estimatedCost: { blocks: compiled.blocks.length, uniqueMaterials: compiled.palette.length },
    buildPhases: phases.map((p) => p.name),
    tags: [spec.tierName.toLowerCase(), spec.category, spec.archetype, spec.style, spec.roofType, spec.shape],
    versionCompatibility: ['1.20.1', '1.20.4', '1.21', '1.21.4'],
    structural: {
      shape: spec.shape, floors: spec.floors, floorHeight: spec.floorHeight, roofType: spec.roofType,
      wallThickness: spec.wallThickness, windowPattern: spec.windowPattern, doorSide: spec.doorSide,
      towers: spec.towers.length, wings: spec.wings.length, courtyard: spec.courtyard,
      basement: spec.basement, decor: spec.decor
    },
    spec: { ...spec }
  };
  schematic.geometryHash = geometryHash(schematic.blocks, schematic.palette);
  schematic.exactHash = exactHash(schematic.blocks, schematic.palette);
  schematic.specHash = specHash(spec);
  return schematic;
}

module.exports = {
  generateSchematic, createSpec, ARCHETYPE_OF, STYLE_OF_CATEGORY, TIER_SETTINGS,
  SHAPES_BY_TIER, ROOFS_BY_TIER, categoryOf, titleCase, BUILDERS
};
