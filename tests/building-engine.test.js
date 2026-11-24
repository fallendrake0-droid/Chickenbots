'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { BuildEngine, STATUS, supportPositions } = require('../src/building/engine');
const {
  parseBlock, formatBlock, rotateBlock, mirrorBlock, rotatePosition, matchesBlock, placementItem
} = require('../src/building/blockStates');
const { BlockRegistry } = require('../src/building/blockRegistry');
const { importSchematic, exportSchematic, detectFormat } = require('../src/building/schematicIO');
const { CustomSchematicStore } = require('../src/building/customLibrary');
const { rotateSchematic, mirrorSchematic } = require('../src/schematics/format');
const { rotateSchematic: rotateProjectSchematic } = require('../src/construction/constants');

const DOOR = [
  'oak_door[facing=east,half=lower,hinge=left,open=false,powered=false]',
  'oak_door[facing=east,half=upper,hinge=left,open=false,powered=false]'
];

function doorSchematic() {
  return {
    id: 'door-test',
    name: 'Door test',
    palette: ['stone', ...DOOR, 'wall_torch[facing=east]', 'sand'],
    dimensions: { width: 3, height: 4, length: 3 },
    blocks: [
      [0, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [0, 1, 0, 1, 1],
      [0, 2, 0, 2, 1],
      [1, 1, 0, 3, 2],
      [2, 3, 0, 4, 2]
    ],
    materials: { stone: 2, oak_door: 1, torch: 1, sand: 1 }
  };
}

function makeEngine(schematic = doorSchematic(), options = {}) {
  const world = new MockWorld({ flat: true });
  // A floor under the door, outside the schematic footprint.
  for (let x = -1; x <= 3; x++) for (let z = -1; z <= 3; z++) world.setBlock({ x, y: 63, z }, 'stone');
  const bot = new MockBot({ name: '________', world, inventory: { stone: 8, oak_door: 4, torch: 8, sand: 4, dirt: 4 } });
  bot.position = { x: 2, y: 65, z: 2 };
  const engine = new BuildEngine({ schematic, origin: { x: 0, y: 64, z: 0 }, world, bots: [bot], ...options });
  return { engine, bot, world };
}

test('block states parse, format and transform exactly', () => {
  const parsed = parseBlock('minecraft:oak_stairs[facing=north,half=top,shape=inner_left]');
  assert.equal(parsed.name, 'oak_stairs');
  assert.deepEqual(parsed.properties, { facing: 'north', half: 'top', shape: 'inner_left' });
  assert.equal(formatBlock(parsed), 'oak_stairs[facing=north,half=top,shape=inner_left]');
  const rotated = rotateBlock(parsed, 1);
  assert.equal(rotated.properties.facing, 'east');
  assert.equal(rotated.properties.shape, 'inner_left', 'rotation keeps handedness relative to facing');
  const mirrored = mirrorBlock(parsed, 'x');
  assert.equal(mirrored.properties.facing, 'north');
  assert.equal(mirrored.properties.shape, 'inner_right', 'mirroring flips handedness');
  assert.deepEqual(rotatePosition(0, 0, 3, 5, 1), { x: 4, z: 0, width: 5, length: 3 });
  assert.equal(placementItem('wall_torch[facing=east]'), 'torch');
  assert.equal(placementItem('redstone_wire[power=1]'), 'redstone');
});

test('rotating and mirroring keep door, stair and rail states correct', () => {
  const schematic = {
    palette: [
      'stone',
      'oak_door[facing=east,half=lower,hinge=left]',
      'oak_door[facing=east,half=upper,hinge=left]',
      'oak_stairs[facing=north,shape=inner_left]'
    ],
    blocks: [[0, 0, 0, 0], [1, 0, 0, 1], [1, 1, 0, 2], [2, 0, 0, 3]],
    dimensions: { width: 3, height: 2, length: 1 }
  };
  const once = rotateSchematic(schematic, 1);
  assert.deepEqual(once.palette, [
    'stone',
    'oak_door[facing=south,half=lower,hinge=left]',
    'oak_door[facing=south,half=upper,hinge=left]',
    'oak_stairs[facing=east,shape=inner_left]'
  ]);
  assert.deepEqual(once.dimensions, { width: 1, height: 2, length: 3 });
  // The construction manager's degree-based wrapper must agree with format.js.
  assert.deepEqual(rotateProjectSchematic(schematic, 90).palette, once.palette);
  const roundTrip = rotateSchematic(once, 3);
  assert.deepEqual(roundTrip.palette, schematic.palette);
  const mirrored = mirrorSchematic(schematic, 'x');
  assert.deepEqual(mirrored.palette, [
    'stone',
    'oak_door[facing=west,half=lower,hinge=right]',
    'oak_door[facing=west,half=upper,hinge=right]',
    'oak_stairs[facing=north,shape=inner_right]'
  ]);
  assert.equal(rotateBlock('oak_door[facing=east,half=lower,hinge=left]', 1).properties.hinge, 'left', 'rotation must not flip hinge');
});

test('registry reports an exact or nearest version and refuses invented blocks', () => {
  const exact = new BlockRegistry({ version: '26.1' });
  assert.equal(exact.describe().compatibility, 'EXACT');
  const fallback = new BlockRegistry({ version: '26.3' });
  assert.equal(fallback.describe().compatibility, 'NEAREST_KNOWN');
  assert.equal(fallback.describe().version, '26.1');
  assert.match(fallback.describe().fallbackReason, /no 26\.3 registry/);
  assert.equal(fallback.validate('oak_stairs[facing=north]').ok, true);
  assert.equal(fallback.validate('oak_stairs[facing=sideways]').ok, false);
  assert.equal(fallback.validate('definitely_not_a_block').ok, false);
});

test('blueprint validation catches unknown blocks and missing door halves', () => {
  const bad = doorSchematic();
  bad.palette = [...bad.palette, 'not_a_real_block'];
  bad.blocks = bad.blocks.filter((block) => block[1] !== 2); // remove upper door half
  bad.blocks.push([2, 0, 2, 5, 0]);
  const { engine } = makeEngine(bad);
  const result = engine.validateBlueprint();
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.kind === 'INVALID_BLOCK'));
  assert.ok(result.issues.some((issue) => issue.kind === 'DOOR_HALF_MISSING'));
});

test('placement strategies map Minecraft yaw and attachments correctly', () => {
  const schematic = {
    palette: ['oak_stairs[facing=north]', 'oak_door[facing=west,half=lower]', 'wall_torch[facing=east]', 'stone'],
    blocks: [[0, 0, 0, 0], [1, 0, 0, 1], [2, 0, 0, 2], [3, 0, 0, 3]],
    dimensions: { width: 4, height: 1, length: 1 }
  };
  const { engine } = makeEngine(schematic);
  assert.equal(engine._strategy(engine.byPosition.get('0,0,0')).yaw, 180, 'north is yaw 180');
  assert.equal(engine._strategy(engine.byPosition.get('1,0,0')).yaw, 90, 'west is yaw 90');
  assert.deepEqual(engine._strategy(engine.byPosition.get('2,0,0')).attach, [1, 0, 0], 'east-facing torch attaches to the block to its west');
});

test('dependency ordering places supports and lower halves first', () => {
  const { engine } = makeEngine();
  const plan = engine.buildPlan();
  assert.equal(plan.cycles.length, 0);
  const order = new Map(plan.order.map((key, index) => [key, index]));
  assert.ok(order.get('0,0,0') < order.get('0,1,0'), 'stone before lower door');
  assert.ok(order.get('0,1,0') < order.get('0,2,0'), 'lower door half before upper');
  assert.ok(order.get('1,0,0') < order.get('1,1,0'), 'wall support before wall torch');
  assert.ok(order.get('0,0,0') < order.get('2,3,0'), 'foundation before gravity block layer');
  const sandSupport = supportPositions(engine.byPosition.get('2,3,0'));
  assert.deepEqual(sandSupport.below, []);
  assert.equal(engine.registry.isGravityBlock('sand'), true);
});

test('placement is only verified after the world reports the exact block state', async () => {
  const { engine, bot, world } = makeEngine();
  const stone = engine.byPosition.get('0,0,0');
  assert.equal((await engine.place(stone, bot, { retries: 0 })).ok, true);
  const lower = engine.byPosition.get('0,1,0');
  const result = await engine.place(lower, bot, { retries: 0 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, STATUS.VERIFIED);
  const observed = world.getBlock({ x: 0, y: 65, z: 0 });
  assert.equal(observed.name, 'oak_door');
  assert.equal(observed.properties.half, 'lower');
  assert.equal(observed.properties.facing, 'east');
  // The mock server creates the upper half from the lower placement. Its state
  // must match the blueprint before it can count as verified.
  const upper = engine.byPosition.get('0,2,0');
  assert.equal(matchesBlock(world.getBlock({ x: 0, y: 66, z: 0 }), upper.desired), true);
  const verified = await engine.place(upper, bot, { retries: 0 });
  assert.equal(verified.ok, true);
  assert.equal(verified.alreadyPresent, true);
});

test('a non-throwing placement API call is never trusted without a world check', async () => {
  const { engine, bot, world } = makeEngine();
  const original = bot.placeBlock.bind(bot);
  bot.placeBlock = async (...args) => { await original(...args); return { ok: true }; };
  // Break the world write after the API reports success, as a desynced server
  // would. The engine must fail the block instead of counting it.
  const target = engine.byPosition.get('0,0,0');
  bot.placeBlock = async () => ({ ok: true });
  const result = await engine.place(target, bot, { retries: 0, confirmAttempts: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.status, STATUS.FAILED);
  assert.match(result.error, /placed|mismatch|did not report/i);
});

test('verification detects wrong states and repair corrects them', async () => {
  const { engine, bot, world } = makeEngine();
  await engine.placeMany(bot, { retries: 0 });
  let audit = engine.verify({ includeExtras: true });
  assert.equal(audit.verified, true, JSON.stringify(audit.wrong.slice(0, 3)));
  // Corrupt one state in the world.
  world.setBlock({ x: 0, y: 65, z: 0 }, 'oak_door', { facing: 'west', half: 'lower', hinge: 'left', open: false, powered: false });
  audit = engine.verify({ includeExtras: false });
  assert.equal(audit.verified, false);
  assert.equal(audit.wrongCount, 1);
  assert.equal(audit.wrong[0].propertyMismatch.facing.expected, 'east');
  const repair = await engine.repair(bot);
  assert.equal(repair.complete, true, JSON.stringify(repair.failures));
  assert.ok(repair.repaired >= 1);
});

test('extra-block audit reports stray blocks without touching the ground layer', async () => {
  const { engine } = makeEngine();
  const world = engine.world;
  world.setBlock({ x: 2, y: 66, z: 2 }, 'dirt');
  const extras = engine.auditExtras();
  assert.ok(extras.some((entry) => entry.x === 2 && entry.y === 66 && entry.z === 2));
  world.setBlock({ x: 2, y: 66, z: 2 }, 'air');
  assert.equal(engine.auditExtras().length, 0);
});

test('schematic IO preserves block states across Sponge, litematic and vanilla NBT', () => {
  const schematic = {
    id: 'io', name: 'IO test',
    palette: ['stone', 'oak_stairs[facing=east,half=top]', 'oak_door[facing=south,half=lower]'],
    blocks: [[0, 0, 0, 0], [1, 0, 0, 1], [0, 1, 0, 2]],
    dimensions: { width: 2, height: 2, length: 1 },
    materials: { stone: 1, oak_stairs: 1, oak_door: 1 }
  };
  for (const format of ['sponge-schem', 'litematic', 'vanilla-structure']) {
    const exported = exportSchematic(schematic, format);
    assert.equal(detectFormat(exported.buffer, `build${exported.extension}`), format);
    const imported = importSchematic(exported.buffer, { filename: `build${exported.extension}` });
    assert.equal(imported.ok, true, imported.error);
    const stairs = imported.schematic.palette.find((entry) => parseBlock(entry).name === 'oak_stairs');
    assert.deepEqual(parseBlock(stairs).properties, { facing: 'east', half: 'top' }, `${format} lost stairs state`);
    assert.equal(imported.schematic.blocks.length, 3);
    assert.deepEqual(imported.schematic.materials, schematic.materials);
  }
});

test('custom catalogue imports, deduplicates, renames, exports and removes lazily', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chickenbots-custom-'));
  try {
    const schematic = {
      id: 'custom-source', name: 'Custom source',
      palette: ['stone', 'oak_planks'],
      blocks: [[0, 0, 0, 0], [1, 0, 0, 1]],
      dimensions: { width: 2, height: 1, length: 1 },
      materials: { stone: 1, oak_planks: 1 }
    };
    const buffer = exportSchematic(schematic, 'sponge-schem').buffer;
    fs.writeFileSync(path.join(dir, 'my_house.schem'), buffer);
    const store = new CustomSchematicStore({ dir, watch: false });
    const scan = store.scan({ persist: false });
    assert.equal(scan.imported, 1);
    assert.equal(store.count, 1);
    const entry = store.list()[0];
    assert.equal(entry.blocks, 2);
    assert.equal(entry.licence, 'UNKNOWN');
    assert.ok(store.build(entry.id));
    const duplicate = store.importFile(buffer, { filename: 'same.schem' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.duplicate, true);
    assert.match(duplicate.reason, /identical|geometry|same/);
    assert.equal(store.rename(entry.id, 'Beach house').ok, true);
    assert.equal(store.get(entry.id).name, 'Beach house');
    const exported = store.export(entry.id, 'litematic');
    assert.equal(exported.ok, true);
    assert.ok(exported.buffer.length > 100);
    const removed = store.remove(entry.id);
    assert.equal(removed.ok, true);
    assert.equal(store.count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
