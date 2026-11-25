'use strict';

/**
 * Bounded in-process log store. The dashboard reads from here so operators can
 * inspect real runtime events without scraping stdout. Nothing is synthesised:
 * entries are exactly what the logger emitted.
 */
const MAX_ENTRIES = 1000;
const entries = [];
let sequence = 0;

function record(entry) {
  const stored = {
    seq: ++sequence,
    ts: entry.ts || Date.now(),
    level: entry.level || 'info',
    scope: entry.scope || 'chickenbots',
    msg: String(entry.msg === undefined ? '' : entry.msg),
    meta: entry.meta === undefined ? null : entry.meta
  };
  entries.push(stored);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  return stored;
}

function recent({ limit = 100, level = null, scope = null, q = null, since = 0 } = {}) {
  const wanted = level ? String(level).toLowerCase() : null;
  const scopeFilter = scope ? String(scope).toLowerCase() : null;
  const query = q ? String(q).toLowerCase() : null;
  const sinceNumber = Number(since);
  const sinceSeq = Number.isFinite(sinceNumber) && sinceNumber >= 0 ? Math.floor(sinceNumber) : 0;
  return entries
    .filter((e) => e.seq > sinceSeq)
    .filter((e) => !wanted || e.level === wanted)
    .filter((e) => !scopeFilter || e.scope.toLowerCase().includes(scopeFilter))
    .filter((e) => !query || e.msg.toLowerCase().includes(query) || e.scope.toLowerCase().includes(query))
    .slice(-Math.min(500, Math.max(1, Number(limit) || 100)));
}

function stats() {
  const byLevel = {};
  for (const e of entries) byLevel[e.level] = (byLevel[e.level] || 0) + 1;
  return { total: entries.length, sequence, byLevel, oldest: entries.length ? entries[0].ts : null };
}

module.exports = { record, recent, stats, MAX_ENTRIES };
