'use strict';

/** Plain {x,y,z} vector helpers. Controllers use plain objects so they can be
 * unit-tested without a live Minecraft connection. */

const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const clone = (a) => ({ x: a.x, y: a.y, z: a.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a) => Math.sqrt(dot(a, a));
const distance = (a, b) => length(sub(a, b));
const distance2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const distanceSq = (a, b) => { const d = sub(a, b); return dot(d, d); };
const floor = (a) => ({ x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) });
const offset = (a, dx, dy, dz) => ({ x: a.x + dx, y: a.y + dy, z: a.z + dz });
const equals = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const normalize = (a) => { const l = length(a); return l === 0 ? v(0, 0, 0) : scale(a, 1 / l); };
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const center = (pos) => ({ x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5 });

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

function key(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

function parseKey(str) {
  const [x, y, z] = str.split(',').map(Number);
  return { x, y, z };
}

/** Iterate every integer coordinate in an inclusive box. */
function* iterateBox(min, max) {
  for (let y = min.y; y <= max.y; y++) {
    for (let z = min.z; z <= max.z; z++) {
      for (let x = min.x; x <= max.x; x++) yield { x, y, z };
    }
  }
}

function boxVolume(min, max) {
  const w = max.x - min.x + 1;
  const h = max.y - min.y + 1;
  const d = max.z - min.z + 1;
  return Math.max(0, w) * Math.max(0, h) * Math.max(0, d);
}

function boxesOverlap(a, b) {
  return a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z;
}

function boxContains(box, pos) {
  return pos.x >= box.min.x && pos.x <= box.max.x &&
    pos.y >= box.min.y && pos.y <= box.max.y &&
    pos.z >= box.min.z && pos.z <= box.max.z;
}

function boxIntersection(a, b) {
  const min = { x: Math.max(a.min.x, b.min.x), y: Math.max(a.min.y, b.min.y), z: Math.max(a.min.z, b.min.z) };
  const max = { x: Math.min(a.max.x, b.max.x), y: Math.min(a.max.y, b.max.y), z: Math.min(a.max.z, b.max.z) };
  if (min.x > max.x || min.y > max.y || min.z > max.z) return null;
  return { min, max };
}

function boxFromCorner(origin, width, height, length) {
  return { min: clone(origin), max: { x: origin.x + width - 1, y: origin.y + height - 1, z: origin.z + length - 1 } };
}

module.exports = {
  v, clone, add, sub, scale, dot, length, distance, distance2d, distanceSq, floor,
  offset, equals, normalize, lerp, center, manhattan, key, parseKey, iterateBox,
  boxVolume, boxesOverlap, boxContains, boxIntersection, boxFromCorner
};
