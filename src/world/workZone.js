'use strict';

const { config } = require('../config');

/**
 * The team work zone. It is centred on home, not on each bot: five bots that
 * each pick their own centre can drift apart until one is lost. A 100x100
 * zone means 100 whole blocks on each horizontal axis.
 */
function workZoneSize(size = config.workZone && config.workZone.size) {
  const wanted = Math.floor(Number(size));
  if (!Number.isFinite(wanted) || wanted < 16) return 100;
  return Math.min(wanted, 1000);
}

function workZone(home, { size = null, margin = null } = {}) {
  const enabled = !(config.workZone && config.workZone.enabled === false);
  const blocks = workZoneSize(size);
  if (!enabled || !home || !Number.isFinite(Number(home.x)) || !Number.isFinite(Number(home.z))) {
    return {
      enabled: false, size: blocks, label: `${blocks}x${blocks}`,
      center: null, minX: null, maxX: null, minZ: null, maxZ: null,
      margin: margin === null ? 0 : Math.max(0, Math.floor(Number(margin) || 0))
    };
  }
  const centerX = Math.floor(Number(home.x));
  const centerZ = Math.floor(Number(home.z));
  const half = Math.floor(blocks / 2);
  return {
    enabled: true,
    size: blocks,
    label: `${blocks}x${blocks}`,
    center: { x: centerX, z: centerZ },
    minX: centerX - half,
    maxX: centerX + half - 1,
    minZ: centerZ - half,
    maxZ: centerZ + half - 1,
    margin: margin === null ? 0 : Math.max(0, Math.floor(Number(margin) || 0))
  };
}

function inWorkZone(pos, home, options = {}) {
  const zone = workZone(home, options);
  if (!zone.enabled) return true;
  if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.z))) return false;
  const x = Math.floor(Number(pos.x));
  const z = Math.floor(Number(pos.z));
  return x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ;
}

function clampToWorkZone(pos, home, options = {}) {
  const zone = workZone(home, options);
  if (!zone.enabled) return { ...pos };
  const margin = Math.max(0, Math.min(zone.margin, Math.floor(zone.size / 2) - 1));
  const minX = zone.minX + margin;
  const maxX = zone.maxX - margin;
  const minZ = zone.minZ + margin;
  const maxZ = zone.maxZ - margin;
  return {
    ...pos,
    x: Math.max(minX, Math.min(maxX, Math.floor(Number(pos.x) || zone.center.x))),
    z: Math.max(minZ, Math.min(maxZ, Math.floor(Number(pos.z) || zone.center.z)))
  };
}

function outsideWorkZone(pos, home, options = {}) {
  const zone = workZone(home, options);
  if (!zone.enabled || inWorkZone(pos, home, options)) return null;
  const x = Math.floor(Number(pos && pos.x));
  const z = Math.floor(Number(pos && pos.z));
  const dx = x < zone.minX ? zone.minX - x : x > zone.maxX ? x - zone.maxX : 0;
  const dz = z < zone.minZ ? zone.minZ - z : z > zone.maxZ ? z - zone.maxZ : 0;
  return { zone, distance: Math.hypot(dx, dz) };
}

module.exports = { workZone, workZoneSize, inWorkZone, clampToWorkZone, outsideWorkZone };
