'use strict';

/** Deterministic helpers. These are used by the schematic generator and by
 * tests; gameplay decisions are deterministic functions of world state. */

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.seed = typeof seed === 'number' ? seed >>> 0 : fnv1a(String(seed));
    this._next = mulberry32(this.seed);
  }

  next() { return this._next(); }
  int(min, max) { // inclusive
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }
  float(min, max) { return min + this.next() * (max - min); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
  pickN(arr, n) {
    const copy = arr.slice();
    this.shuffle(copy);
    return copy.slice(0, n);
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  fork(label) { return new Rng(fnv1a(`${this.seed}:${label}`)); }
  weighted(entries) {
    // entries: [{ weight, value }]
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let roll = this.next() * total;
    for (const e of entries) {
      roll -= e.weight;
      if (roll <= 0) return e.value;
    }
    return entries[entries.length - 1].value;
  }
}

module.exports = { Rng, fnv1a, mulberry32 };
