export const BOT_NAMES = ['________', '10101000', '01010100', '11001100', '00110000'];

export function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function attr(value) { return esc(value); }

export function num(value, fallback = '—') {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return new Intl.NumberFormat('en-GB').format(n);
}

export function compact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return num(n);
}

export function pct(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }

export function formatTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function formatDateTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function timeAgo(ts) {
  const then = Number(ts);
  if (!Number.isFinite(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  if (diff < 1000) return 'now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function duration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const totalMinutes = Math.floor(n / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (totalMinutes) return `${minutes}m`;
  return `${Math.floor(n / 1000)}s`;
}

export function humanize(name) {
  return String(name || '')
    .replace(/^minecraft:/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name) {
  const index = BOT_NAMES.indexOf(name);
  if (index >= 0) return String(index + 1).padStart(2, '0');
  return String(name || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '??';
}

export function botNumber(name) {
  const index = BOT_NAMES.indexOf(name);
  return index >= 0 ? index + 1 : null;
}

export function titleCase(value) {
  return String(value || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function healthTone(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'muted';
  if (n <= 6) return 'danger';
  if (n <= 12) return 'warn';
  return 'ok';
}

export function progressTone(value) {
  const n = clamp(value, 0, 100);
  if (n >= 100) return 'ok';
  if (n >= 50) return 'accent';
  if (n >= 20) return 'warn';
  return 'danger';
}

const CHART_COLORS = ['#39b8a5', '#5998e8', '#e5a947', '#a78bfa', '#e05b68', '#35b779'];
export function chartColor(nameOrIndex) {
  if (typeof nameOrIndex === 'number') return CHART_COLORS[nameOrIndex % CHART_COLORS.length];
  const index = BOT_NAMES.indexOf(nameOrIndex);
  if (index >= 0) return CHART_COLORS[index];
  let hash = 0;
  for (const c of String(nameOrIndex)) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return CHART_COLORS[Math.abs(hash) % CHART_COLORS.length];
}

const CATEGORY_COLORS = {
  ore: '#8a9bb0', ingot: '#b8c4d2', food: '#e5a947', tool: '#5998e8', weapon: '#e05b68',
  armor: '#a78bfa', block: '#39b8a5', log: '#a9754f', planks: '#c08a5a', plant: '#35b779',
  potion: '#d67ad6', utility: '#7d8b9c', redstone: '#d95d5d', treasure: '#e0c15b', other: '#657386'
};
export function categoryColor(category) { return CATEGORY_COLORS[String(category || '').toLowerCase()] || CATEGORY_COLORS.other; }

export function blockColor(name) {
  const n = String(name || '');
  if (n.includes('water')) return '#3d6f9e';
  if (n.includes('lava') || n.includes('magma') || n.includes('fire')) return '#d1662f';
  if (n.includes('leaves') || n.includes('grass') || n.includes('moss') || n.includes('fern')) return '#4e8c58';
  if (n.includes('log') || n.includes('wood')) return '#7a5a3a';
  if (n.includes('planks') || n.includes('fence') || n.includes('door')) return '#a97f52';
  if (n.includes('glass') || n.includes('pane')) return '#7fb6c9';
  if (n.includes('sand')) return '#d8c68a';
  if (n.includes('deepslate')) return '#4d5158';
  if (n.includes('cobble') || n.includes('stone') || n.includes('andesite') || n.includes('tuff')) return '#7c8288';
  if (n.includes('brick')) return '#9c5a4a';
  if (n.includes('snow') || n.includes('quartz') || n.includes('white')) return '#d9e2ea';
  if (n.includes('gold')) return '#d4b24a';
  if (n.includes('iron') || n.includes('anvil')) return '#b9c2cc';
  if (n.includes('diamond')) return '#63d3c2';
  if (n.includes('emerald')) return '#45c47f';
  if (n.includes('redstone')) return '#c94a4a';
  if (n.includes('lapis')) return '#4a66c9';
  if (n.includes('wool')) return '#c9c2b4';
  if (n.includes('lantern') || n.includes('torch') || n.includes('campfire')) return '#e8b85c';
  if (n.includes('dirt') || n.includes('path') || n.includes('mud')) return '#79573c';
  if (n.includes('blackstone') || n.includes('obsidian')) return '#2f3038';
  if (n.includes('purpur')) return '#a982a9';
  if (n.includes('nether')) return '#7a3b3b';
  return '#647386';
}

export function debounce(fn, wait = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 500) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args); }, remaining);
    }
  };
}

export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }
}

export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [path, queryString = ''] = raw.split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryString));
  return { path: segments.join('/'), segments, query };
}

export function relativePercent(value, total) {
  const v = Number(value) || 0;
  const t = Number(total) || 0;
  return t > 0 ? clamp((v / t) * 100, 0, 100) : 0;
}

export function sum(items, pick) {
  return (items || []).reduce((total, item) => total + (Number(pick ? pick(item) : item) || 0), 0);
}

export function uniqueBy(items, key) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const value = typeof key === 'function' ? key(item) : item[key];
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
