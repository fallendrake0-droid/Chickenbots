import { icon } from '../icons.js';
import { esc, num, humanize, categoryColor, sum } from '../utils.js';
import { badge, emptyState } from '../ui.js';
import { actionsFor } from '../store.js';
import { botNames, bots } from './shared.js';

const CATEGORY_ORDER = ['food', 'tool', 'weapon', 'armor', 'ore', 'ingot', 'block', 'log', 'planks', 'plant', 'potion', 'utility', 'redstone', 'treasure', 'other'];

export function inventorySummary(name) {
  const inv = actionsFor(name) && actionsFor(name).inventory;
  const bot = bots().find((entry) => entry.name === name);
  const items = (inv && inv.items) || Object.entries((bot && bot.inventory) || {}).map(([item, count]) => ({ name: item, count, category: 'other' }));
  const categories = {};
  for (const item of items) categories[item.category || 'other'] = (categories[item.category || 'other'] || 0) + item.count;
  return {
    items,
    categories,
    total: sum(items, (item) => item.count),
    slots: inv ? inv.slotsUsed : items.length,
    food: (inv && inv.food) || 0,
    blocks: (inv && inv.blocks) || 0,
    tools: (inv && inv.tools) || [],
    reserves: (inv && inv.reserves) || null,
    full: Boolean(inv && inv.full)
  };
}

export function inventoryPanel(name, { compact = false } = {}) {
  const summary = inventorySummary(name);
  if (!summary.items.length) return emptyState('Inventory is empty', 'The adapter reports no items for this bot.', 'package');
  const shield = summary.items.find((item) => /shield$/.test(item.name)) || null;
  return `
    <div class="inventory-toolbar" style="margin-bottom:10px">
      <div class="search-input" style="flex:0 1 230px;max-width:230px">${icon('search')}<input class="input input--sm" type="search" placeholder="Filter items…" data-inventory-search="${esc(name)}" aria-label="Filter ${esc(name)} inventory"></div>
      <select class="select select--sm" data-inventory-category="${esc(name)}" aria-label="Filter by category" style="width:150px">
        <option value="">All categories</option>
        ${CATEGORY_ORDER.filter((category) => summary.categories[category]).map((category) => `<option value="${category}">${esc(humanize(category))} (${num(summary.categories[category])})</option>`).join('')}
      </select>
      <span class="grow"></span>
      ${badge(`${num(summary.slots)} stacks`, 'neutral')}
      ${summary.full ? badge('Inventory full', 'danger') : badge('Space available', 'ok')}
    </div>
    <div class="inventory-grid" data-inventory-grid="${esc(name)}">
      ${summary.items.map((item) => itemTile(item)).join('')}
    </div>
    <div class="tiny muted" data-inventory-empty="${esc(name)}" hidden style="padding:18px;text-align:center">No items match this filter.</div>
    ${compact ? '' : `
      <div class="divider"></div>
      <div class="section-head"><div><div class="section-title">${icon('shield')} Armour and offhand</div><div class="section-sub">Pieces reported by the adapter. It exposes armour points and item totals, not per-slot positions.</div></div></div>
      <div class="slot-grid">
        ${armourSlots(summary.items).map((slot) => `<div class="slot"><span class="slot-label">${esc(slot.label)}</span><strong>${slot.item ? `${esc(humanize(slot.item.name))} <span class="muted tiny">×${num(slot.item.count)}</span>` : '<span class="muted">Not reported</span>'}</strong></div>`).join('')}
        <div class="slot"><span class="slot-label">Offhand</span><strong>${shield ? `${esc(humanize(shield.name))} <span class="muted tiny">×${num(shield.count)}</span>` : '<span class="muted">No shield reported</span>'}</strong></div>
      </div>
      <div class="meta-list" style="margin-top:12px">
        <span>${icon('package')} ${num(summary.total)} items</span>
        <span>${icon('sprout')} ${num(summary.food)} food</span>
        <span>${icon('cube')} ${num(summary.blocks)} blocks</span>
        <span>${icon('wrench')} ${summary.tools.length} tools</span>
      </div>
      <p class="tiny muted" style="margin:10px 0 0">Item totals, categories, reserves and armour pieces come from the adapter. Per-slot positions, durability and enchantments are not exposed, so no placeholder slots are drawn.</p>`}`;
}

function armourSlots(items) {
  const pieces = [
    ['Helmet', /_(helmet|cap|hood)$/],
    ['Chestplate', /_chestplate$/],
    ['Leggings', /_leggings$/],
    ['Boots', /_boots$/]
  ];
  return pieces.map(([label, pattern]) => ({ label, item: items.find((item) => pattern.test(item.name)) || null }));
}

export function itemTile(item) {
  const category = item.category || 'other';
  const color = categoryColor(category);
  return `<div class="item-tile" data-item-name="${esc(item.name)}" data-item-category="${esc(category)}" title="${esc(humanize(item.name))} · ${num(item.count)} · ${esc(category)}">
    <span class="item-tile-icon" style="background:${color}">${esc(humanize(item.name).slice(0, 1))}</span>
    <span class="item-tile-main">
      <span class="item-tile-name">${esc(humanize(item.name))}</span>
      <span class="item-tile-sub">${esc(category)}</span>
    </span>
    <span class="item-tile-count">${num(item.count)}</span>
  </div>`;
}

export function mountInventory(root, name) {
  const search = root.querySelector(`[data-inventory-search="${cssEscape(name)}"]`);
  const category = root.querySelector(`[data-inventory-category="${cssEscape(name)}"]`);
  if (!root.querySelector(`[data-inventory-grid="${cssEscape(name)}"]`)) return;
  const apply = () => applyInventoryFilter(root, name);
  if (search) search.addEventListener('input', apply);
  if (category) category.addEventListener('change', apply);
  applyInventoryFilter(root, name);
}

export function applyInventoryFilter(root, name) {
  const search = root.querySelector(`[data-inventory-search="${cssEscape(name)}"]`);
  const category = root.querySelector(`[data-inventory-category="${cssEscape(name)}"]`);
  const grid = root.querySelector(`[data-inventory-grid="${cssEscape(name)}"]`);
  const empty = root.querySelector(`[data-inventory-empty="${cssEscape(name)}"]`);
  if (!grid) return;
  const query = (search && search.value || '').trim().toLowerCase();
  const selected = category ? category.value : '';
  let visible = 0;
  for (const tile of grid.querySelectorAll('[data-item-name]')) {
    const matchesQuery = !query || tile.dataset.itemName.includes(query) || tile.textContent.toLowerCase().includes(query);
    const matchesCategory = !selected || tile.dataset.itemCategory === selected;
    const show = matchesQuery && matchesCategory;
    tile.hidden = !show;
    if (show) visible++;
  }
  if (empty) empty.hidden = visible > 0;
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

export function inventoryTabs() {
  return botNames().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
}
