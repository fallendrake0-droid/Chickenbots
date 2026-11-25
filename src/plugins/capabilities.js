'use strict';

/**
 * Conservative capability detection.
 *
 * A client cannot enumerate a Java server's plugins. This module reports what
 * the protocol actually exposed (server brand, advertised protocol, configured
 * auth profile) and marks everything else UNKNOWN. It never turns a guessed
 * plugin name into a DETECTED capability, and it has no anti-cheat bypass.
 */

const { CONFIDENCE } = require('../bot/authProfiles');

const SOFTWARE_PATTERNS = [
  { id: 'paper', label: 'Paper', re: /paper/i },
  { id: 'folia', label: 'Folia', re: /folia/i },
  { id: 'purpur', label: 'Purpur', re: /purpur/i },
  { id: 'spigot', label: 'Spigot', re: /spigot/i },
  { id: 'bukkit', label: 'Bukkit', re: /bukkit|craftbukkit/i },
  { id: 'velocity', label: 'Velocity', re: /velocity/i },
  { id: 'bungeecord', label: 'BungeeCord', re: /bungee/i },
  { id: 'waterfall', label: 'Waterfall', re: /waterfall/i },
  { id: 'fabric', label: 'Fabric', re: /fabric/i },
  { id: 'forge', label: 'Forge', re: /forge/i },
  { id: 'vanilla', label: 'Vanilla', re: /vanilla/i }
];

function brandText(value) {
  return String(value == null ? '' : value).replace(/\u00a7./g, '').trim().slice(0, 120);
}

function detectServerSoftware(brand) {
  const text = brandText(brand);
  if (!text) {
    return { id: 'unknown', label: 'Unknown', confidence: CONFIDENCE.UNKNOWN, source: 'no server brand exposed' };
  }
  const match = SOFTWARE_PATTERNS.find((entry) => entry.re.test(text));
  if (match) {
    return { id: match.id, label: match.label, confidence: CONFIDENCE.DETECTED, source: `server brand: ${text}` };
  }
  return { id: 'unknown', label: 'Unknown', confidence: CONFIDENCE.UNKNOWN, source: `unrecognised server brand: ${text}` };
}

function protocolCompatibility({ protocol = null, version = null, supported = null } = {}) {
  const p = Number(protocol);
  if (!Number.isFinite(p) || p <= 0) {
    return { status: 'UNKNOWN', protocol: null, version: version || null, detail: 'no validated protocol number' };
  }
  if (Array.isArray(supported) && supported.length) {
    return {
      status: supported.includes(p) ? 'SUPPORTED' : 'UNSUPPORTED',
      protocol: p,
      version: version || null,
      detail: supported.includes(p) ? 'protocol is in the installed supported set' : 'protocol is not in the installed supported set'
    };
  }
  return { status: 'VALIDATED', protocol: p, version: version || null, detail: 'protocol number was supplied by the version probe' };
}

function detectCapabilities({
  brand = null,
  protocol = null,
  version = null,
  supportedProtocols = null,
  authProfile = null,
  authPromptSeen = false,
  bedrockTransport = false
} = {}) {
  const software = detectServerSoftware(brand);
  const proxy = ['velocity', 'bungeecord', 'waterfall'].includes(software.id)
    ? { id: software.id, confidence: CONFIDENCE.DETECTED, detail: 'server brand identifies the proxy' }
    : { id: 'unknown', confidence: CONFIDENCE.UNKNOWN, detail: 'proxies are not enumerable through the play protocol' };
  const protocolInfo = protocolCompatibility({ protocol, version, supported: supportedProtocols });
  const auth = authProfile && authProfile.id && authProfile.id !== 'none'
    ? {
      profile: authProfile.id,
      plugin: authProfile.plugin || null,
      confidence: authPromptSeen ? CONFIDENCE.DETECTED : CONFIDENCE.CONFIGURED,
      challengeSeen: Boolean(authPromptSeen),
      detail: authPromptSeen ? 'server challenge matched the configured profile' : 'configured by the operator; no challenge observed yet'
    }
    : { profile: 'none', plugin: null, confidence: CONFIDENCE.UNKNOWN, challengeSeen: false, detail: 'no plugin authentication configured' };

  return {
    edition: 'java',
    software,
    proxy,
    protocol: protocolInfo,
    auth,
    viaVersion: { id: 'viaversion', confidence: CONFIDENCE.UNKNOWN, detail: 'not inferred from the status name; protocol number is authoritative' },
    viaBackwards: { id: 'viabackwards', confidence: CONFIDENCE.UNKNOWN, detail: 'not exposed by the play protocol' },
    geyser: { id: 'geyser', confidence: CONFIDENCE.UNKNOWN, detail: 'Java endpoint only; Geyser is not enumerable from this client' },
    floodgate: { id: 'floodgate', confidence: CONFIDENCE.UNKNOWN, detail: 'not exposed by the play protocol' },
    antiCheat: { id: 'unknown', confidence: CONFIDENCE.UNKNOWN, detail: 'detected only from the server kick reason, never guessed' },
    bedrock: bedrockTransport
      ? { id: 'bedrock', confidence: CONFIDENCE.CONFIGURED, detail: 'configured transport' }
      : { id: 'bedrock', confidence: CONFIDENCE.NOT_SUPPORTED, detail: 'native Bedrock transport is not implemented; this is a Java client' }
  };
}

module.exports = {
  SOFTWARE_PATTERNS,
  CONFIDENCE,
  detectServerSoftware,
  protocolCompatibility,
  detectCapabilities
};
