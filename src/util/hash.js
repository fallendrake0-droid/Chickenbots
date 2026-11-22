'use strict';

const crypto = require('crypto');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashObject(obj, length = 32) {
  return sha256(stableStringify(obj)).slice(0, length);
}

function hashString(str, length = 16) {
  return sha256(str).slice(0, length);
}

module.exports = { stableStringify, sha256, hashObject, hashString };
