'use strict';

/**
 * Resolve the Minecraft version before any bot opens a login socket.
 *
 * minecraft-protocol's `autoVersion` path pings the server and immediately
 * dereferences `versions[0]`. When Aternos is asleep/starting it can answer the
 * status ping with protocol -1 (or no version block at all), which produces the
 * misleading `Unsupported protocol version '-1'` error followed by a
 * `Cannot read properties of undefined (reading 'minecraftVersion')` crash.
 * We probe once, validate the response, and hand Mineflayer an explicit,
 * known-good version instead.
 */

const NOT_READY_CODES = new Set(['SERVER_NOT_READY', 'SERVER_UNREACHABLE']);

function versionFromStatus(status, data = null) {
  const source = data || require('minecraft-data');
  const name = String(status?.name || '').replace(/\u00a7./g, '').trim();
  const protocol = Number(status?.protocol);
  if (!Number.isFinite(protocol) || protocol <= 0) {
    return {
      ok: false,
      code: 'SERVER_NOT_READY',
      retryable: true,
      error: `server is offline or still starting (status protocol ${status?.protocol ?? 'missing'})`
    };
  }

  const byName = source.versionsByMinecraftVersion?.pc || {};
  const exact = byName[name];
  if (exact && exact.minecraftVersion) {
    return { ok: true, version: exact.minecraftVersion, protocol, source: 'status-name' };
  }
  const match = name.match(/\b\d+\.\d+(?:\.\d+)?\b/);
  const named = match ? byName[match[0]] : null;
  if (named && named.minecraftVersion) {
    return { ok: true, version: named.minecraftVersion, protocol, source: 'status-name' };
  }

  const candidates = source.postNettyVersionsByProtocolVersion?.pc?.[protocol];
  if (Array.isArray(candidates) && candidates.length) {
    const known = candidates.find((entry) => entry && entry.minecraftVersion);
    if (known) return { ok: true, version: known.minecraftVersion, protocol, source: 'protocol' };
  }

  return {
    ok: false,
    code: 'UNSUPPORTED_PROTOCOL',
    retryable: false,
    error: `server protocol ${protocol} (${name || 'unknown version'}) is newer than this install; run npm update`
  };
}

function configuredVersion(version, data = null) {
  const source = data || require('minecraft-data');
  const wanted = String(version || '').trim();
  if (!wanted) return { ok: false, code: 'INVALID_VERSION', retryable: false, error: 'MC_VERSION is empty' };
  const known = source.versionsByMinecraftVersion?.pc?.[wanted];
  if (known && known.minecraftVersion) {
    return { ok: true, version: wanted, protocol: known.version, source: 'configured' };
  }
  return {
    ok: false,
    code: 'UNSUPPORTED_VERSION',
    retryable: false,
    error: `MC_VERSION=${wanted} is not known to minecraft-data; use a supported release or auto`
  };
}

async function resolveServerVersion({
  host,
  port,
  version = 'auto',
  timeoutMs = 8000,
  ping = null,
  minecraftData = null
} = {}) {
  const data = minecraftData || require('minecraft-data');
  if (String(version).toLowerCase() !== 'auto') return configuredVersion(version, data);

  const pingFn = ping || require('minecraft-protocol').ping;
  let timer;
  try {
    const status = await Promise.race([
      Promise.resolve(pingFn({ host, port, closeTimeout: timeoutMs, noPongTimeout: Math.min(4000, timeoutMs) })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`version probe timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })), timeoutMs);
      })
    ]);
    return versionFromStatus(status?.version, data);
  } catch (err) {
    const code = err && err.code ? err.code : 'PROBE_FAILED';
    return {
      ok: false,
      code: 'SERVER_UNREACHABLE',
      retryable: true,
      cause: code,
      error: `server version probe failed (${code}): ${err && err.message ? err.message : err}`
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { resolveServerVersion, versionFromStatus, configuredVersion, NOT_READY_CODES };
