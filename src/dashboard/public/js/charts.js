import { chartColor, blockColor, esc, num, clamp } from './utils.js';
import { emptyState } from './ui.js';

/** Multi-series line chart from browser-side live samples. Real samples only. */
export function lineChart(samples, bots, { height = 190, metric = 'health', max = 20 } = {}) {
  if (!samples || samples.length < 2) {
    return `<div class="chart-empty">Collecting live samples…</div>`;
  }
  const width = 640;
  const pad = { left: 26, right: 8, top: 10, bottom: 18 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const count = samples.length;
  const xAt = (index) => pad.left + (index / Math.max(1, count - 1)) * innerW;
  const yAt = (value) => pad.top + innerH - (clamp(value, 0, max) / max) * innerH;
  const series = bots.map((name, index) => {
    const points = samples.map((sample, i) => {
      const state = sample.bots && sample.bots[name];
      return { i, value: state ? Number(state[metric]) : NaN };
    }).filter((point) => Number.isFinite(point.value));
    if (!points.length) return null;
    const path = points.map((point, i) => `${i === 0 ? 'M' : 'L'}${xAt(point.i).toFixed(1)},${yAt(point.value).toFixed(1)}`).join(' ');
    return { name, color: chartColor(index), path, last: points[points.length - 1].value };
  }).filter(Boolean);
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = pad.top + innerH - ratio * innerH;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"/><text class="chart-axis" x="2" y="${y + 3}">${Math.round(ratio * max)}</text>`;
  }).join('');
  const startLabel = new Date(samples[0].at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const endLabel = new Date(samples[samples.length - 1].at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const paths = series.map((entry) => `<path d="${entry.path}" fill="none" stroke="${entry.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>`).join('');
  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Live ${metric} samples for the fleet">
      <g class="chart-grid">${gridLines}</g>
      ${paths}
      <text class="chart-axis" x="${pad.left}" y="${height - 3}">${esc(startLabel)}</text>
      <text class="chart-axis" x="${width - pad.right}" y="${height - 3}" text-anchor="end">${esc(endLabel)}</text>
    </svg>`;
}

export function sparkline(values, { width = 120, height = 30, color = '#39b8a5', max = 20 } = {}) {
  if (!values || values.length < 2) return `<span class="muted tiny">—</span>`;
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((value, i) => `${(i * step).toFixed(1)},${(height - (clamp(value, 0, max) / max) * (height - 4) - 2).toFixed(1)}`).join(' ');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export function barList(rows, { max = null } = {}) {
  if (!rows.length) return emptyState('No tracked resources', 'The ledger has not recorded any item counts yet.', 'package');
  const ceiling = max || Math.max(...rows.map((row) => row.value), 1);
  return `<div class="resource-bars">${rows.map((row) => `
    <div>
      <div class="resource-bar-label"><span>${esc(row.label)}</span><span>${num(row.value)}</span></div>
      <div class="progress progress--sm"><div class="progress-bar${row.tone ? ` progress-bar--${row.tone}` : ''}" style="width:${clamp((row.value / ceiling) * 100, 0, 100)}%"></div></div>
    </div>`).join('')}</div>`;
}

export function donut(value, { size = 92, stroke = 8, label = '', caption = '' } = {}) {
  const percent = clamp(value, 0, 100);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (percent / 100) * circumference;
  return `
    <div class="donut" style="position:relative;width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)} ${percent.toFixed(0)} percent">
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#1f2a37" stroke-width="${stroke}"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#39b8a5" stroke-width="${stroke}" stroke-linecap="round"
          stroke-dasharray="${dash} ${circumference - dash}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      </svg>
      <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;line-height:1.1">
        <div><div style="font-size:17px;font-weight:650">${percent.toFixed(0)}%</div>${caption ? `<div class="tiny muted">${esc(caption)}</div>` : ''}</div>
      </div>
    </div>`;
}

/** Isometric render of the real regenerated schematic height map. */
export function schematicPreview(preview, { maxCubes = 2200 } = {}) {
  if (!preview || !preview.cells || !preview.cells.length) {
    return emptyState('No preview available', 'The schematic has no generated geometry to render.', 'cube');
  }
  const cells = preview.cells.slice(0, maxCubes);
  const unit = 4;
  const scaleX = 0.9;
  const points = cells.map((cell) => ({
    ...cell,
    isoX: (cell.x - cell.z) * unit * scaleX,
    isoY: (cell.x + cell.z) * unit * 0.42 - cell.y * unit * 0.62
  }));
  const xs = points.map((p) => p.isoX);
  const ys = points.map((p) => p.isoY);
  const minX = Math.min(...xs) - unit * 2;
  const maxX = Math.max(...xs) + unit * 2;
  const minY = Math.min(...ys) - unit * 2;
  const maxY = Math.max(...ys) + unit * 2;
  const vbW = Math.max(1, maxX - minX);
  const vbH = Math.max(1, maxY - minY);
  const viewBox = `${minX} ${minY} ${vbW} ${vbH}`;
  points.sort((a, b) => (a.x + a.z - a.y) - (b.x + b.z - b.y));
  const shapes = points.map((cell) => {
    const color = blockColor(cell.block);
    const x = cell.isoX;
    const y = cell.isoY;
    const w = unit * scaleX;
    const h = unit * 0.42;
    const top = `${x},${y - h} ${x + w},${y} ${x},${y + h} ${x - w},${y}`;
    const left = `${x - w},${y} ${x},${y + h} ${x},${y + h + unit * 0.62} ${x - w},${y + unit * 0.62}`;
    const right = `${x + w},${y} ${x},${y + h} ${x},${y + h + unit * 0.62} ${x + w},${y + unit * 0.62}`;
    return `<g><polygon points="${left}" fill="${shade(color, -0.22)}"/><polygon points="${right}" fill="${shade(color, -0.36)}"/><polygon points="${top}" fill="${color}"/></g>`;
  }).join('');
  return `<svg viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Isometric preview of schematic geometry">${shapes}</svg>`;
}

function shade(hex, amount) {
  const value = hex.replace('#', '');
  if (value.length !== 6) return hex;
  const numbers = [0, 2, 4].map((i) => clamp(Math.round(parseInt(value.slice(i, i + 2), 16) * (1 + amount)), 0, 255));
  return `#${numbers.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
