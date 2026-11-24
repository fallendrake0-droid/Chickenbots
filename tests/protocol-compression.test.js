'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint;
const { installAsyncDecompression } = require('../src/protocol/asyncDecompress');
const compression = require('minecraft-protocol/src/transforms/compression');

function frame(payload, compressed = true) {
  if (!compressed) {
    const raw = Buffer.alloc(sizeOfVarInt(0) + payload.length);
    const offset = writeVarInt(0, raw, 0);
    payload.copy(raw, offset);
    return raw;
  }
  const body = zlib.deflateSync(payload);
  const out = Buffer.alloc(sizeOfVarInt(payload.length) + body.length);
  const offset = writeVarInt(payload.length, out, 0);
  body.copy(out, offset);
  return out;
}

function decompress(buffer) {
  return new Promise((resolve, reject) => {
    const stream = compression.createDecompressor(1, false);
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.end(buffer);
  });
}

test('the async decompressor is installed idempotently', () => {
  assert.equal(installAsyncDecompression(), true);
  assert.equal(installAsyncDecompression(), true);
  assert.equal(typeof compression.createDecompressor, 'function');
});

test('async decompression preserves the compressed wire payload', async () => {
  installAsyncDecompression();
  const payload = Buffer.from('chunk-data '.repeat(5000));
  const result = await decompress(frame(payload));
  assert.equal(result.length, payload.length);
  assert.equal(result.equals(payload), true);
});

test('async decompression preserves uncompressed frames', async () => {
  installAsyncDecompression();
  const payload = Buffer.from('uncompressed packet');
  const result = await decompress(frame(payload, false));
  assert.equal(result.equals(payload), true);
});

test('async decompression surfaces an invalid compressed frame', async () => {
  installAsyncDecompression();
  const body = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const header = Buffer.alloc(sizeOfVarInt(100));
  const size = writeVarInt(100, header, 0);
  await assert.rejects(decompress(Buffer.concat([header.slice(0, size), body])));
});
