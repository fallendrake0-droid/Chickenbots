'use strict';

const zlib = require('zlib');

/**
 * Hard bounds for untrusted schematic/NBT input.
 *
 * The upload endpoint accepts operator-supplied files. A gzip bomb or a
 * declared 100000x100000x100000 region must be rejected before allocation, not
 * after the process has already exhausted its heap. These limits are well above
 * the largest catalogued design (517,650 blocks, 87 on its longest axis).
 */
const LIMITS = Object.freeze({
  MAX_INPUT_BYTES: 64 * 1024 * 1024,
  MAX_INFLATED_BYTES: 64 * 1024 * 1024,
  MAX_BLOCKS: 2_000_000,
  MAX_VOLUME: 4_000_000,
  MAX_DIMENSION: 4096,
  MAX_PALETTE: 65_536
});

function validateDimensions(width, height, length, { label = 'schematic' } = {}) {
  const values = [width, height, length].map(Number);
  if (!values.every(Number.isInteger) || values.some((value) => value <= 0)) {
    throw new Error(`${label} dimensions must be positive integers (got ${values.join('x')})`);
  }
  if (values.some((value) => value > LIMITS.MAX_DIMENSION)) {
    throw new Error(`${label} dimension exceeds ${LIMITS.MAX_DIMENSION} blocks (got ${values.join('x')})`);
  }
  const volume = values[0] * values[1] * values[2];
  if (!Number.isSafeInteger(volume) || volume > LIMITS.MAX_VOLUME) {
    throw new Error(`${label} volume ${values.join('x')} exceeds the ${LIMITS.MAX_VOLUME}-block import limit`);
  }
  return volume;
}

function assertInputSize(buffer, { label = 'schematic' } = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (buffer.length > LIMITS.MAX_INPUT_BYTES) {
    throw new Error(`${label} is ${buffer.length} bytes; the limit is ${LIMITS.MAX_INPUT_BYTES}`);
  }
  return buffer;
}

function safeGunzip(buffer, { label = 'schematic' } = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  assertInputSize(buffer, { label });
  return zlib.gunzipSync(buffer, { maxOutputLength: LIMITS.MAX_INFLATED_BYTES });
}

module.exports = { LIMITS, validateDimensions, assertInputSize, safeGunzip };
