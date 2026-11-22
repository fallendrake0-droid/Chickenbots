'use strict';

/** Binary heap priority queue with stable ordering by insertion sequence for
 * equal priorities (deterministic behaviour). */
class PriorityQueue {
  constructor(compare) {
    this.compare = compare; // returns <0 when a has higher priority than b
    this.items = [];
    this.seq = 0;
  }

  get size() { return this.items.length; }
  isEmpty() { return this.items.length === 0; }

  push(value, priority = 0) {
    const node = { value, priority, seq: this.seq++ };
    this.items.push(node);
    this._up(this.items.length - 1);
    return node;
  }

  peek() { return this.items.length ? this.items[0].value : undefined; }

  pop() {
    if (!this.items.length) return undefined;
    const root = this.items[0];
    const last = this.items.pop();
    if (this.items.length) { this.items[0] = last; this._down(0); }
    return root.value;
  }

  drain() {
    const out = [];
    while (!this.isEmpty()) out.push(this.pop());
    return out;
  }

  _less(a, b) {
    const c = this.compare(a.value, b.value);
    if (c !== 0) return c < 0;
    return a.seq < b.seq;
  }

  _up(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._less(this.items[i], this.items[parent])) {
        [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
        i = parent;
      } else break;
    }
  }

  _down(i) {
    const n = this.items.length;
    for (;;) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this._less(this.items[l], this.items[smallest])) smallest = l;
      if (r < n && this._less(this.items[r], this.items[smallest])) smallest = r;
      if (smallest === i) break;
      [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
      i = smallest;
    }
  }
}

module.exports = { PriorityQueue };
