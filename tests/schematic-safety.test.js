'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const nbt = require('prismarine-nbt');
const { importSchematic, fromLitematic } = require('../src/building/schematicIO');
const { fromSpongeSchematic, fromLegacySchematic } = require('../src/schematics/format');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CustomSchematicStore } = require('../src/building/customLibrary');
const { LIMITS, validateDimensions } = require('../src/schematics/limits');

function gzip(value) {
  return zlib.gzipSync(Buffer.from(nbt.writeUncompressed(value, 'big')));
}

function spongeValue(width, height, length) {
  return {
    type: 'compound',
    name: '',
    value: {
      Schematic: {
        type: 'compound',
        value: {
          Width: { type: 'int', value: width },
          Height: { type: 'int', value: height },
          Length: { type: 'int', value: length },
          Palette: { type: 'compound', value: { '0': { type: 'string', value: 'minecraft:stone' } } },
          BlockData: { type: 'byteArray', value: [] }
        }
      }
    }
  };
}

test('schematic dimension limits reject impossible allocations', () => {
  assert.equal(validateDimensions(87, 64, 81), 87 * 64 * 81);
  assert.throws(() => validateDimensions(0, 1, 1), /positive integers/);
  assert.throws(() => validateDimensions(1.5, 1, 1), /positive integers/);
  assert.throws(() => validateDimensions(5000, 1, 1), /exceeds/);
  assert.throws(() => validateDimensions(2000, 2000, 2000), /volume/);
  assert.equal(LIMITS.MAX_VOLUME, 4_000_000);
});

test('a sponge schematic with a huge declared volume is rejected before decoding', () => {
  assert.throws(
    () => fromSpongeSchematic(gzip(spongeValue(100000, 100000, 100000))),
    /volume|dimension/
  );
});

test('a truncated sponge block-data array is rejected instead of inventing air', () => {
  const value = spongeValue(2, 1, 1);
  value.value.Schematic.value.BlockData = { type: 'byteArray', value: [0] };
  assert.throws(() => fromSpongeSchematic(gzip(value)), /truncated/);
});

test('a legacy schematic with a huge declared volume is rejected before looping', () => {
  const value = {
    type: 'compound',
    name: '',
    value: {
      Schematic: {
        type: 'compound',
        value: {
          Width: { type: 'int', value: 2000 },
          Height: { type: 'int', value: 2000 },
          Length: { type: 'int', value: 2000 },
          Blocks: { type: 'byteArray', value: [] }
        }
      }
    }
  };
  assert.throws(() => fromLegacySchematic(gzip(value)), /volume|dimensions|block ids/);
});

test('a litematic region with a huge size is rejected before packing an array', () => {
  const value = {
    type: 'compound',
    name: '',
    value: {
      Regions: {
        type: 'compound',
        value: {
          Region: {
            type: 'compound',
            value: {
              Position: { type: 'list', value: { type: 'int', value: [0, 0, 0] } },
              Size: { type: 'list', value: { type: 'int', value: [100000, 100000, 100000] } },
              Palette: {
                type: 'compound',
                value: { '0': { type: 'compound', value: { Name: { type: 'string', value: 'minecraft:stone' } } } }
              },
              BlockStates: { type: 'longArray', value: [] }
            }
          }
        }
      },
      Metadata: { type: 'compound', value: {} }
    }
  };
  assert.throws(() => fromLitematic(gzip(value)), /volume|dimension/);
});

test('native JSON import rejects malformed blocks and out-of-range palette indexes', () => {
  const malformed = importSchematic(Buffer.from(JSON.stringify({
    palette: ['minecraft:stone'],
    blocks: [['x', 0, 0, 0]],
    dimensions: { width: 1, height: 1, length: 1 }
  })), { filename: 'bad.json' });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /malformed block/);

  const outOfRange = importSchematic(Buffer.from(JSON.stringify({
    palette: ['minecraft:stone'],
    blocks: [[0, 0, 0, 4]],
    dimensions: { width: 1, height: 1, length: 1 }
  })), { filename: 'bad-index.json' });
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.error, /palette index/);
});

test('native JSON import rejects impossible dimensions', () => {
  const result = importSchematic(Buffer.from(JSON.stringify({
    palette: ['minecraft:stone'],
    blocks: [[0, 0, 0, 0]],
    dimensions: { width: 100000, height: 100000, length: 100000 }
  })), { filename: 'huge.json' });
  assert.equal(result.ok, false);
  assert.match(result.error, /volume|dimension/);
});

test('custom catalogue refuses an oversized file before reading it into memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-import-'));
  try {
    const file = path.join(dir, 'huge.schem');
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, LIMITS.MAX_INPUT_BYTES + 1);
    fs.closeSync(fd);
    const store = new CustomSchematicStore({ dir, watch: false });
    const result = store.importFile(file, { filename: 'huge.schem' });
    assert.equal(result.ok, false);
    assert.match(result.error, /import limit/);
    assert.equal(store.count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
