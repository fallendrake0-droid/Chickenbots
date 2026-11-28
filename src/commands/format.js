'use strict';

/**
 * Human-readable command reports for the terminal and the dashboard log.
 *
 * The registry has always returned rich JSON, but the terminal only printed a
 * terse `✓ goto` (or nothing on success) and the server log printed only
 * failures. That made an operator unable to tell where a goto spent its time
 * or which bot failed a fleet command. This formatter is deliberately generic:
 * it extracts the stable result fields every handler already returns and never
 * invents numbers.
 */

const POSITION_KEYS = new Set(['from', 'position', 'target', 'goal', 'requested', 'anchor']);
const SCALAR_KEYS = [
  'bot', 'code', 'error', 'reason', 'owner', 'priority',
  'arrived', 'verified', 'arrivalUnverified', 'recovered', 'already', 'resumed',
  'descended', 'reachable', 'inRange', 'shortBy', 'attempts', 'steps', 'route',
  'searchRadius', 'durationMs', 'elapsedMs', 'commandMs',
  'mined', 'chopped', 'placed', 'planted', 'harvested', 'replanted', 'collected',
  'count', 'quantity', 'failed', 'completed'
];

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positionText(pos) {
  if (!pos || typeof pos !== 'object') return null;
  if (!finite(pos.x) || !finite(pos.y) || !finite(pos.z)) return null;
  const n = (value) => (Math.round(Number(value) * 10) / 10).toFixed(1);
  return `${n(pos.x)},${n(pos.y)},${n(pos.z)}`;
}

function scalarText(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
  return String(value);
}

function timingsText(timings) {
  if (!timings || typeof timings !== 'object') return null;
  const parts = [];
  if (finite(timings.totalMs)) parts.push(`total=${timings.totalMs}ms`);
  if (finite(timings.setupMs)) parts.push(`setup=${timings.setupMs}ms`);
  if (timings.planMs === null) parts.push('plan=none');
  else if (finite(timings.planMs)) parts.push(`plan=${timings.planMs}ms`);
  if (finite(timings.followMs)) parts.push(`follow=${timings.followMs}ms`);
  if (finite(timings.thinkTimeoutMs)) parts.push(`think-budget=${timings.thinkTimeoutMs}ms`);
  if (finite(timings.tickTimeoutMs)) parts.push(`slice=${timings.tickTimeoutMs}ms`);
  return parts.length ? parts.join(' ') : null;
}

function schedulingText(scheduling) {
  if (!scheduling || typeof scheduling !== 'object') return null;
  const parts = [];
  if (finite(scheduling.queuedMs)) parts.push(`queued=${scheduling.queuedMs}ms`);
  if (finite(scheduling.cancelWaitMs)) parts.push(`cancel-wait=${scheduling.cancelWaitMs}ms`);
  if (finite(scheduling.execMs)) parts.push(`exec=${scheduling.execMs}ms`);
  return parts.length ? parts.join(' ') : null;
}

function rowText(row, index = null) {
  if (!row || typeof row !== 'object') return `${index === null ? '' : `#${index + 1} `}${String(row)}`;
  const parts = [];
  if (index !== null) parts.push(`#${index + 1}`);
  if (row.bot) parts.push(String(row.bot));
  parts.push(row.ok === false ? 'FAILED' : 'ok');
  for (const key of ['code', 'error', 'reason', 'block', 'ore', 'mined', 'chopped', 'placed', 'harvested', 'replanted', 'count', 'quantity']) {
    if (row[key] === undefined || row[key] === null || row[key] === '') continue;
    if (key === 'error' && row.ok !== false) continue;
    parts.push(`${key}=${scalarText(row[key])}`);
  }
  const at = positionText(row.position);
  if (at) parts.push(`at=${at}`);
  return parts.join(' ');
}

/**
 * Build the short summary lines used by both the CLI and the logger.
 * `maxRows` caps a fan-out result; the omitted count is explicit.
 */
function summarizeResult(result, { maxRows = 12 } = {}) {
  if (!result || typeof result !== 'object') return [String(result)];
  const lines = [];
  const seen = new Set();
  for (const key of SCALAR_KEYS) {
    let value = result[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'error' && result.ok !== false) continue;
    if (Array.isArray(value)) value = `${value.length} item(s)`;
    else if (typeof value === 'object') continue;
    seen.add(key);
    if (POSITION_KEYS.has(key)) lines.push(`${key}=${positionText(value)}`);
    else lines.push(`${key}=${scalarText(value)}`);
  }
  for (const key of POSITION_KEYS) {
    if (seen.has(key) || !result[key]) continue;
    const text = positionText(result[key]);
    if (text) { lines.push(`${key}=${text}`); seen.add(key); }
  }
  if (Array.isArray(result.path) && result.path.length) lines.push(`path=${result.path.length} node(s)`);
  const timings = timingsText(result.timings);
  if (timings) lines.push(`timings: ${timings}`);
  const scheduling = schedulingText(result.scheduling);
  if (scheduling) lines.push(`scheduling: ${scheduling}`);
  const rows = Array.isArray(result.results) ? result.results
    : Array.isArray(result.bots) && result.bots.some((row) => row && typeof row === 'object') ? result.bots : [];
  if (rows.length) {
    const shown = rows.slice(0, maxRows);
    for (let i = 0; i < shown.length; i++) lines.push(`  ${rowText(shown[i], i)}`);
    if (rows.length > shown.length) lines.push(`  … ${rows.length - shown.length} more result(s)`);
  }
  return lines;
}

function commandHeader(entry) {
  const payload = entry && entry.result ? entry.result : entry || {};
  const ok = payload.ok !== false;
  const commandName = payload.command || entry.command || '';
  const duration = finite(entry.durationMs) ? `${entry.durationMs}ms` : finite(payload.durationMs) ? `${payload.durationMs}ms` : '?ms';
  const source = entry.source ? `${entry.source}/${entry.operator || 'console'}` : null;
  const identity = entry.id ? `${entry.id} ` : '';
  return `${identity}${ok ? 'ok' : 'FAILED'} ${commandName || 'command'} in ${duration}${source ? ` [${source}]` : ''}`;
}

/** Full terminal report: header, summary lines and the command line. */
function commandReport(entry, options = {}) {
  const payload = entry && entry.result ? entry.result : entry || {};
  const lines = [commandHeader(entry)];
  if (entry && entry.line) lines.push(`  line: ${entry.line}`);
  for (const line of summarizeResult(payload, options)) lines.push(`  ${line}`);
  return lines;
}

module.exports = {
  summarizeResult, commandHeader, commandReport, positionText, rowText
};
