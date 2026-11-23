'use strict';

/**
 * Central secret redaction.
 *
 * The bot never logs its password intentionally, but chat echoes, error
 * strings and future debug calls can carry one accidentally. Redact both
 * structural forms (`/login secret`, `password=secret`, bearer headers) and
 * the exact configured values, so a password cannot reach the terminal, the
 * bounded log store or the dashboard through a log message.
 */

const { config } = require('../config');

function knownSecrets() {
  return [config.server.loginPassword, config.server.registerPassword, config.dashboard.token]
    .filter((value) => typeof value === 'string' && value.length >= 4);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactString(input) {
  let text = String(input === undefined || input === null ? '' : input);
  // Commands and their complete argument tail. Auth commands never have a
  // useful non-secret argument, so removing the whole tail is safest.
  text = text.replace(/(\/\s*(?:login|register)\s+)([^\r\n]*)/gi, '$1[redacted]');
  text = text.replace(/((?<![.\w])\b(?:password|passwd|token|secret|api[_-]?key)\b\s*[:=]\s*)([^\s,;}\]]+)/gi, '$1[redacted]');
  text = text.replace(/(Authorization\s*:\s*(?:Basic|Bearer)\s+)(\S+)/gi, '$1[redacted]');
  text = text.replace(/(MC_(?:LOGIN|REGISTER)_PASSWORD\s*=\s*)([^\s]+)/gi, '$1[redacted]');
  for (const secret of knownSecrets()) {
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[redacted]');
  }
  return text;
}

/** Redact objects/arrays recursively without throwing on cycles or DAGs. */
function redactValue(value, seen = new Map(), depth = 0, ancestors = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactString(value.message);
  if (depth >= 6) return '[truncated]';
  // A true cycle is an ancestor that is still being copied. A shared child
  // (bestWeapon is also weapons[0]) must keep its data, so reuse its clone
  // instead of reporting it as circular.
  if (ancestors.has(value)) return '[circular]';
  if (seen.has(value)) return seen.get(value);
  const out = Array.isArray(value) ? [] : {};
  seen.set(value, out);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) out.push(redactValue(item, seen, depth + 1, ancestors));
  } else {
    const secretKey = /^(?:authorization|cookie|password|passwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)$/i;
    for (const [key, item] of Object.entries(value)) {
      out[key] = secretKey.test(key) ? '[redacted]' : redactValue(item, seen, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
  return out;
}

module.exports = { redactString, redactValue };
