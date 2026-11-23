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

function versionFromStatus(status, data = null, supportedVersions = null) {
  const source = data || require('minecraft-data');
  const supported = new Set(supportedVersions || require('minecraft-protocol').supportedVersions);
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
  const usable = (entry) => Boolean(entry && entry.minecraftVersion && supported.has(entry.minecraftVersion));
  // A proxy/ViaVersion status name can advertise a newer release than the
  // protocol it actually answered with (e.g. "26.3" with protocol 775). Never
  // trust the name over the protocol, and never pass a version that
  // minecraft-protocol itself does not list as supported.
  const exact = byName[name];
  if (usable(exact) && Number(exact.version) === protocol) {
    return { ok: true, version: exact.minecraftVersion, protocol, source: 'status-name' };
  }
  const match = name.match(/\b\d+\.\d+(?:\.\d+)?\b/);
  const named = match ? byName[match[0]] : null;
  if (usable(named) && Number(named.version) === protocol) {
    return { ok: true, version: named.minecraftVersion, protocol, source: 'status-name' };
  }

  const candidates = source.postNettyVersionsByProtocolVersion?.pc?.[protocol];
  if (Array.isArray(candidates) && candidates.length) {
    const known = candidates.find(usable);
    if (known) return { ok: true, version: known.minecraftVersion, protocol, source: 'protocol' };
  }

  return {
    ok: false,
    code: 'UNSUPPORTED_PROTOCOL',
    retryable: false,
    error: `server protocol ${protocol} (${name || 'unknown version'}) is not supported by minecraft-protocol ${require('minecraft-protocol/package.json').version}; run npm update`
  };
}

function configuredVersion(version, data = null, supportedVersions = null) {
  const source = data || require('minecraft-data');
  const supported = new Set(supportedVersions || require('minecraft-protocol').supportedVersions);
  const wanted = String(version || '').trim();
  if (!wanted) return { ok: false, code: 'INVALID_VERSION', retryable: false, error: 'MC_VERSION is empty' };
  const known = source.versionsByMinecraftVersion?.pc?.[wanted];
  if (known && known.minecraftVersion && supported.has(wanted)) {
    return { ok: true, version: wanted, protocol: known.version, source: 'configured' };
  }
  return {
    ok: false,
    code: 'UNSUPPORTED_VERSION',
    retryable: false,
    error: `MC_VERSION=${wanted} is not supported by minecraft-protocol; use one of ${[...supported].slice(-8).join(', ')} or auto`
  };
}

async function resolveServerVersion({
  host,
  port,
  version = 'auto',
  timeoutMs = 8000,
  ping = null,
  minecraftData = null,
  supportedVersions = null
} = {}) {
  const data = minecraftData || require('minecraft-data');
  const supported = supportedVersions || require('minecraft-protocol').supportedVersions;
  if (String(version).toLowerCase() !== 'auto') return configuredVersion(version, data, supported);

  const pingFn = ping || require('minecraft-protocol').ping;
  let timer;
  try {
    const status = await Promise.race([
      Promise.resolve(pingFn({ host, port, closeTimeout: timeoutMs, noPongTimeout: Math.min(4000, timeoutMs) })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`version probe timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })), timeoutMs);
      })
    ]);
    return versionFromStatus(status?.version, data, supported);
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

module.exports = { resolveServerVersion, versionFromStatus, configuredVersion };
