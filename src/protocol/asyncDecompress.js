'use strict';

/**
 * Mineflayer/minecraft-protocol inflate each compressed packet with
 * zlib.unzipSync inside a Transform. A chunk burst therefore occupies one
 * uninterrupted event-loop turn: the 20 tps tick_end loop, the keep-alive
 * auto-reply and every connection timer stop until the whole burst is done.
 *
 * This module replaces only the decompressor factory with an asynchronous
 * Transform using the libuv thread pool. Packet order is preserved by the
 * stream, and the next packet is not processed until this callback runs, so
 * timers get a turn between chunks without changing the wire protocol.
 */

let installed = false;

function installAsyncDecompression() {
  if (installed) return true;
  let compression;
  try {
    compression = require('minecraft-protocol/src/transforms/compression');
  } catch (_) {
    return false;
  }
  if (!compression || typeof compression.createDecompressor !== 'function') return false;
  const zlib = require('zlib');
  const { Transform } = require('stream');
  const [readVarInt] = require('protodef').types.varint;

  class AsyncDecompressor extends Transform {
    constructor(threshold = -1, hideErrors = false) {
      super();
      this.compressionThreshold = threshold;
      this.hideErrors = hideErrors;
    }

    _transform(chunk, enc, cb) {
      const { size, value, error } = readVarInt(chunk, 0);
      if (error) return cb(error);
      if (value === 0) {
        this.push(chunk.slice(size));
        return cb();
      }
      zlib.unzip(chunk.slice(size), { finishFlush: 2 }, (err, inflated) => {
        if (err) {
          // The original code logged and then silently continued, leaving the
          // stream desynchronised. Surface it so the connection fails cleanly.
          return cb(err);
        }
        this.push(inflated);
        return cb();
      });
    }
  }

  compression.createDecompressor = function createAsyncDecompressor(threshold, hideErrors) {
    return new AsyncDecompressor(threshold, hideErrors);
  };
  installed = true;
  return true;
}

module.exports = { installAsyncDecompression };
