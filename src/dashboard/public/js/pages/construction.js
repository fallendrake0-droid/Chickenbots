import { state, runCommand } from '../store.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { esc, num, humanize, duration, timeAgo, formatDateTime } from '../utils.js';
import { badge, progress, kvRows, emptyState, pageHeader, statCard, toast, confirmDialog, setButtonLoading, resultMessage, openModal } from '../ui.js';
import { schematicPreview } from '../charts.js';

function builds() {
  return (state.snapshot && state.snapshot.builder && state.snapshot.builder.builds) || [];
}

function buildStateTone(buildState) {
  if (buildState === 'COMPLETE') return 'ok';
  if (buildState === 'FAILED' || buildState === 'CANCELLED') return 'danger';
  if (buildState === 'PAUSED' || buildState === 'BLOCKED') return 'warn';
  return 'accent';
}

let builderDesign = '';

export const builderPage = {
  title: 'Builder',
  render() {
    const list = builds();
    const active = list.filter((build) => !['COMPLETE', 'FAILED', 'CANCELLED'].includes(build.state));
    const lib = (state.snapshot && state.snapshot.schematics && state.snapshot.schematics.stats) || {};
    const home = (state.snapshot && state.snapshot.homeBase) || {};
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Construction', title: 'Builder', description: 'Start validated schematic builds, follow placement progress and monitor conflicts or missing materials.',
          actions: `<a class="button" href="#/projects">${icon('hammer')} Build projects</a><button class="button button--primary" type="button" data-command-palette>${icon('terminal')} Command</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Active builds', value: num(active.length), iconName: 'hammer', tone: active.length ? 'accent' : 'neutral', context: `${num(list.length)} builds in this runtime` })}
          ${statCard({ label: 'Library', value: num(lib.count || 0), iconName: 'book-open', tone: 'info', context: `${num(lib.uniqueGeometry || 0)} unique geometries` })}
          ${statCard({ label: 'Average design size', value: num(lib.blocks ? lib.blocks.average : 0), iconName: 'blocks', tone: 'neutral', context: `largest ${num(lib.blocks ? lib.blocks.max : 0)} blocks` })}
          ${statCard({ label: 'Home base', value: home.home ? `${home.home.x}, ${home.home.y}, ${home.home.z}` : 'Not set', iconName: 'home', tone: home.home ? 'success' : 'warning', context: home.home ? 'Team home coordinates' : 'No home coordinates configured' })}
        </div>
        <div class="grid grid--main-side">
          <div class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('plus')} Start a build</div><span class="badge badge--outline">Validated designs only</span></div>
              <div class="card-body">
                <form data-build-form>
                  <div class="form-grid form-grid--3">
                    <div class="field field--span2"><label class="field-label" for="build-design">Design ID or name</label><input class="input" id="build-design" type="text" placeholder="e.g. 0001_beginner_shelter" value="${esc(builderDesign)}" required></div>
                    <div class="field"><label class="field-label" for="build-run">Execution</label><select class="select" id="build-run"><option value="">Plan only</option><option value="run">Plan and run (40 steps)</option></select></div>
                    <div class="field"><label class="field-label" for="build-x">Origin X</label><input class="input" id="build-x" type="number" value="0"></div>
                    <div class="field"><label class="field-label" for="build-y">Origin Y</label><input class="input" id="build-y" type="number" value="65"></div>
                    <div class="field"><label class="field-label" for="build-z">Origin Z</label><input class="input" id="build-z" type="number" value="0"></div>
                  </div>
                  <div class="row gap-2" style="margin-top:12px">
                    <button class="button button--primary" type="submit">${icon('hammer')} Start build</button>
                    <a class="button" href="#/schematics">${icon('search')} Browse library</a>
                  </div>
                  <p class="tiny muted" style="margin:10px 0 0">Starting a build requires confirmation and a conflict-free site. Placement is performed by the team.</p>
                </form>
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('hammer')} Builds</div><span class="tiny muted">${list.length}</span></div>
              <div class="table-wrap"><table class="table">
                <thead><tr><th>Build</th><th>Design</th><th>State</th><th>Progress</th><th>Blocks</th><th>Origin</th><th>Missing</th><th>Actions</th></tr></thead>
                <tbody>${active.length || list.length ? list.map((build) => `<tr>
                  <td class="mono tiny">${esc(build.buildId)}</td>
                  <td><a class="link" href="#/projects/${encodeURIComponent(build.buildId)}">${esc(build.name || build.schematicId || '—')}</a><div class="tiny muted">${esc(build.tier || '')}</div></td>
                  <td>${badge(build.state || '—', buildStateTone(build.state), { dot: true })}</td>
                  <td style="min-width:120px">${progress(build.percentComplete || 0, 100, { sm: true, tone: build.percentComplete >= 100 ? 'ok' : 'accent' })}</td>
                  <td class="mono tiny">${num(build.placedBlocks || 0)} / ${num(build.totalBlocks || 0)}</td>
                  <td class="mono tiny">${build.origin ? `${build.origin.x}, ${build.origin.y}, ${build.origin.z}` : '—'}</td>
                  <td class="mono">${num((build.missingMaterials || []).length)}</td>
                  <td><div class="row gap-2">${!['COMPLETE', 'CANCELLED', 'FAILED'].includes(build.state) ? `<button class="button button--sm" type="button" data-command="build run ${esc(build.buildId)} 40">Run</button><button class="button button--sm button--danger-ghost" type="button" data-command="build stop ${esc(build.buildId)}" data-danger="true" data-confirm-title="Stop build" data-confirm-message="Stop ${esc(build.name)}? Placed blocks remain in the world.">Stop</button>` : ''}</div></td>
                </tr>`).join('') : `<tr><td colspan="8">${emptyState('No builds', 'Start a build from a validated schematic, or browse the library.', 'hammer', '<a class="button button--primary" href="#/schematics">Schematic library</a>')}</td></tr>`}</tbody>
              </table></div>
            </section>
            ${home.perBot && home.perBot.length ? `<section class="card">
              <div class="card-header"><div class="card-title">${icon('home')} Home base status</div></div>
              <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Bot</th><th>Home</th><th>Design</th><th>Build</th><th>Available designs</th></tr></thead><tbody>${home.perBot.map((row) => `<tr><td>${esc(row.bot)}</td><td class="mono tiny">${row.home ? `${row.home.x}, ${row.home.y}, ${row.home.z}` : '—'}</td><td class="tiny">${esc(row.design ? (row.design.name || row.design.id || '—') : '—')}</td><td>${row.build ? badge(row.build.state || 'planned', buildStateTone(row.build.state)) : '<span class="muted tiny">none</span>'}</td><td class="mono">${num((row.availableDesigns || []).length)}</td></tr>`).join('')}</tbody></table></div>
            </section>` : ''}
          </div>
          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('layers')} Library snapshot</div><a class="tiny muted" href="#/schematics">Open</a></div>
              <div class="card-body">
                ${kvRows([
                  ['Designs', num(lib.count || 0)],
                  ['Minimum required', num(lib.minimumRequired || 0)],
                  ['Meets minimum', lib.meetsMinimum ? badge('Yes', 'ok') : badge('No', 'warn')],
                  ['Unique geometry', num(lib.uniqueGeometry || 0)],
                  ['Categories', num((lib.categories || []).length)],
                  ['Generated', lib.generatedAt ? esc(timeAgo(lib.generatedAt)) : '—']
                ])}
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('alert')} Build warnings</div></div>
              <div class="card-body card-body--tight">
                ${list.flatMap((build) => (build.recentEvents || []).filter((event) => event.level === 'warn' || event.level === 'error').map((event) => ({ ...event, build: build.name }))).length ? list.flatMap((build) => (build.recentEvents || []).filter((event) => event.level === 'warn' || event.level === 'error').map((event) => `<div class="alert-row alert-row--warn">${icon('alert')}<div class="list-main"><div>${esc(event.message || event.msg || '')}</div><div class="alert-meta">${esc(build.name)}</div></div></div>`)).join('') : '<div class="muted small" style="padding:8px">No build warnings reported.</div>'}
              </div>
            </section>
          </aside>
        </div>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-build-form]');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const design = form.querySelector('#build-design').value.trim();
      if (!design) {
        toast({ type: 'warn', title: 'Design required', message: 'Enter a design ID or name from the schematic library.' });
        return;
      }
      const line = `build ${design} ${form.querySelector('#build-x').value} ${form.querySelector('#build-y').value} ${form.querySelector('#build-z').value}${form.querySelector('#build-run').value ? ' run' : ''}`;
      const ok = await confirmDialog({
        title: 'Start build',
        message: `Start building ${design}?`,
        confirmLabel: 'Start build',
        details: 'The builder clears and places blocks around the origin. Conflicts with existing builds or protected regions will block placement.'
      });
      if (!ok) return;
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(line, { confirm: true });
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
        builderDesign = '';
      } catch (err) {
        toast({ type: 'error', title: 'Build failed', message: err.message, duration: 8000 });
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
};

const library = {
  q: '', tier: '', category: '', difficulty: '', maxWidth: '', material: '',
  offset: 0, limit: 12, data: null, loading: false, error: null, requestId: 0, loadedOnce: false
};

function queryForLibrary() {
  return {
    q: library.q || undefined,
    tier: library.tier || undefined,
    category: library.category || undefined,
    difficulty: library.difficulty || undefined,
    maxWidth: library.maxWidth || undefined,
    material: library.material || undefined,
    limit: library.limit,
    offset: library.offset
  };
}

async function loadLibrary({ force = false } = {}) {
  if (library.loading) return;
  if (library.loadedOnce && !force) return;
  library.loading = true;
  library.error = null;
  library.requestId++;
  const requestId = library.requestId;
  renderLibraryGrid();
  try {
    const result = await api.schematics(queryForLibrary());
    if (requestId !== library.requestId) return;
    library.data = result;
    library.loadedOnce = true;
  } catch (err) {
    if (requestId !== library.requestId) return;
    library.error = err.message;
  } finally {
    library.loading = false;
    renderLibraryGrid();
  }
}

function renderLibraryGrid() {
  const host = document.querySelector('[data-library-results]');
  if (!host) return;
  if (library.loading) {
    host.innerHTML = `<div class="skeleton-grid">${Array.from({ length: 6 }, () => '<div class="card skeleton-card"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--line"></div><div class="skeleton skeleton--line short"></div></div>').join('')}</div>`;
    return;
  }
  if (library.error) {
    host.innerHTML = `<div class="card">${emptyState('Library unavailable', library.error, 'alert-circle', '<button class="button" type="button" data-library-retry>Retry</button>')}</div>`;
    const retry = host.querySelector('[data-library-retry]');
    if (retry) retry.addEventListener('click', () => loadLibrary({ force: true }));
    return;
  }
  const data = library.data;
  if (!data) {
    host.innerHTML = `<div class="card">${emptyState('Loading schematic library', 'Querying the validated design manifest.', 'loader')}</div>`;
    return;
  }
  if (!data.designs.length) {
    host.innerHTML = `<div class="card">${emptyState('No designs match', 'Adjust the search or filters.', 'search')}</div>`;
    return;
  }
  host.innerHTML = `
    <div class="schematic-grid">${data.designs.map((design) => schematicCard(design)).join('')}</div>
    <div class="pagination">
      <span class="tiny muted">${num(data.offset + 1)}–${num(Math.min(data.offset + data.limit, data.total))} of ${num(data.total)} designs</span>
      <span class="grow"></span>
      <button class="button button--sm" type="button" data-library-page="-1" ${data.offset === 0 ? 'disabled' : ''}>${icon('chevron-left')} Previous</button>
      <button class="button button--sm" type="button" data-library-page="1" ${data.offset + data.limit >= data.total ? 'disabled' : ''}>Next ${icon('chevron-right')}</button>
    </div>`;
  host.querySelectorAll('[data-design-id]').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) return;
      openSchematic(card.dataset.designId);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSchematic(card.dataset.designId);
      }
    });
  });
  host.querySelectorAll('[data-library-page]').forEach((button) => {
    button.addEventListener('click', () => {
      library.offset = Math.max(0, library.offset + Number(button.dataset.libraryPage) * library.limit);
      loadLibrary({ force: true });
      const anchor = document.querySelector('[data-library-results]');
      if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function schematicCard(design) {
  return `<article class="card schematic-card" data-design-id="${esc(design.id)}" tabindex="0" role="button" aria-label="Open ${esc(design.name)}">
    <div class="schematic-visual" aria-hidden="true">
      <span class="schematic-tier">${esc(design.tier)}</span>
      <span class="schematic-glyph">${icon('blocks')}</span>
    </div>
    <div class="schematic-body">
      <div class="schematic-name">${esc(design.name)}</div>
      <div class="schematic-id mono">${esc(design.id)}</div>
      <div class="schematic-meta">
        ${badge(humanize(design.category), 'neutral')}
        ${badge(`${design.dimensions.width}×${design.dimensions.length}×${design.dimensions.height}`, 'outline')}
        <span class="tiny muted">${num(design.blocks)} blocks</span>
      </div>
      <div class="schematic-foot">
        <span class="tiny muted">difficulty ${esc(design.difficulty)} · ${esc(humanize(design.style || design.archetype || '—'))}</span>
        <span class="tiny accent">Preview ${icon('arrow-right')}</span>
      </div>
    </div>
  </article>`;
}

export const schematicsPage = {
  title: 'Schematic Library',
  render() {
    const libStats = (state.snapshot && state.snapshot.schematics && state.snapshot.schematics.stats) || {};
    const tiers = libStats.tiers || [];
    const categories = libStats.categories || [];
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Construction', title: 'Schematic Library', description: 'Browse the validated, generated build catalogue. Every design is deterministic and verified against its manifest entry.',
          actions: `<a class="button" href="#/builder">${icon('hammer')} Builder</a><span class="badge badge--outline">${num(libStats.count || 0)} designs</span>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Designs', value: num(libStats.count || 0), iconName: 'book-open', tone: 'info', context: `${num(libStats.meetsMinimum ? libStats.minimumRequired : 0)} minimum required` })}
          ${statCard({ label: 'Unique geometry', value: num(libStats.uniqueGeometry || 0), iconName: 'shapes', tone: 'accent', context: 'Distinct geometry hashes' })}
          ${statCard({ label: 'Total blocks', value: num(libStats.blocks ? libStats.blocks.total : 0), iconName: 'blocks', tone: 'neutral', context: `average ${num(libStats.blocks ? libStats.blocks.average : 0)} per design` })}
          ${statCard({ label: 'Tiers', value: num(tiers.length), iconName: 'layers', tone: 'neutral', context: tiers.map((tier) => `${tier.tier} ${tier.count}`).join(' · ') || '—' })}
        </div>
        <section class="card">
          <div class="toolbar toolbar--wrap">
            <div class="search-input">${icon('search')}<input class="input" type="search" data-library-q placeholder="Search name, ID or tag…" aria-label="Search schematics" value="${esc(library.q)}"></div>
            <select class="select" data-library-tier aria-label="Filter by tier"><option value="">All tiers</option>${tiers.map((tier) => `<option value="${esc(tier.tier)}"${library.tier === tier.tier ? ' selected' : ''}>${esc(tier.tier)} (${tier.count})</option>`).join('')}</select>
            <select class="select" data-library-category aria-label="Filter by category"><option value="">All categories</option>${categories.map((entry) => `<option value="${esc(entry.category)}"${library.category === entry.category ? ' selected' : ''}>${esc(humanize(entry.category))} (${entry.count})</option>`).join('')}</select>
            <select class="select" data-library-difficulty aria-label="Filter by difficulty"><option value="">Any difficulty</option>${[1,2,3,4,5,6,7,8,9,10].map((value) => `<option value="${value}"${String(library.difficulty) === String(value) ? ' selected' : ''}>Difficulty ${value}</option>`).join('')}</select>
            <input class="input" type="number" data-library-width placeholder="Max width" aria-label="Maximum width" min="1" value="${esc(library.maxWidth)}" style="width:110px">
            <input class="input" type="text" data-library-material placeholder="Material contains…" aria-label="Material filter" value="${esc(library.material)}" style="width:170px">
            <button class="button" type="button" data-library-reset>${icon('x')} Clear</button>
          </div>
          <div class="card-body" data-library-results data-preserve-children>
            <div class="card">${emptyState('Loading schematic library', 'Querying the validated design manifest.', 'loader')}</div>
          </div>
        </section>
      </div>`;
  },
  mount(root) {
    const results = root.querySelector('[data-library-results]');
    if (!results) return;
    const q = root.querySelector('[data-library-q]');
    const tier = root.querySelector('[data-library-tier]');
    const category = root.querySelector('[data-library-category]');
    const difficulty = root.querySelector('[data-library-difficulty]');
    const width = root.querySelector('[data-library-width]');
    const material = root.querySelector('[data-library-material]');
    let timer = null;
    const apply = (patch) => {
      Object.assign(library, patch);
      library.offset = 0;
      clearTimeout(timer);
      timer = setTimeout(() => loadLibrary({ force: true }), 280);
    };
    if (q) q.addEventListener('input', () => apply({ q: q.value.trim() }));
    if (tier) tier.addEventListener('change', () => apply({ tier: tier.value }));
    if (category) category.addEventListener('change', () => apply({ category: category.value }));
    if (difficulty) difficulty.addEventListener('change', () => apply({ difficulty: difficulty.value }));
    if (width) width.addEventListener('input', () => apply({ maxWidth: width.value }));
    if (material) material.addEventListener('input', () => apply({ material: material.value.trim() }));
    const reset = root.querySelector('[data-library-reset]');
    if (reset) reset.addEventListener('click', () => {
      Object.assign(library, { q: '', tier: '', category: '', difficulty: '', maxWidth: '', material: '', offset: 0, loadedOnce: false });
      if (q) q.value = ''; if (tier) tier.value = ''; if (category) category.value = '';
      if (difficulty) difficulty.value = ''; if (width) width.value = ''; if (material) material.value = '';
      loadLibrary({ force: true });
    });
    if (!library.loadedOnce || library.loading) loadLibrary({ force: !library.loadedOnce });
    else renderLibraryGrid();
  }
};

export function legacyLibraryReset() { library.loadedOnce = false; library.data = null; }

async function openSchematic(id) {
  const close = openModal({
    title: 'Schematic detail',
    description: 'Generated geometry and material list for this validated design.',
    wide: true,
    body: `<div class="skeleton skeleton--title"></div><div class="skeleton skeleton--line"></div><div class="skeleton skeleton--line short"></div>`,
    label: 'Schematic detail'
  });
  try {
    const result = await api.schematic(id);
    const design = result.design;
    const modal = document.querySelector('.modal');
    if (!modal) return;
    const body = modal.querySelector('.modal-body');
    const title = modal.querySelector('.modal-title');
    if (title) title.textContent = design.name;
    body.innerHTML = `
      <div class="schematic-detail">
        <div class="schematic-render">
          ${schematicPreview(result.preview)}
          <div class="tiny muted" style="text-align:center;margin-top:6px">Isometric render of the real height map (${num(result.preview.cells.length)} sampled cells)</div>
        </div>
        <div class="schematic-detail-side">
          ${kvRows([
            ['Design ID', esc(design.id), true],
            ['Tier', esc(`${design.tier} (${design.tierIndex})`)],
            ['Category', esc(humanize(design.category))],
            ['Archetype', esc(humanize(design.archetype))],
            ['Style', esc(design.style)],
            ['Difficulty', esc(design.difficulty)],
            ['Dimensions', esc(`${design.dimensions.width} × ${design.dimensions.length} × ${design.dimensions.height}`)],
            ['Phases', num((design.phases || []).length)],
            ['Seed', esc(design.seed), true],
            ['Version', esc(String(design.versionCompatibility || '—'))]
          ])}
          <div class="divider"></div>
          <div class="tiny muted" style="margin-bottom:6px">Top materials</div>
          <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Block</th><th>Count</th></tr></thead><tbody>${result.materials.slice(0, 14).map(([name, count]) => `<tr><td class="mono tiny">${esc(name)}</td><td class="mono">${num(count)}</td></tr>`).join('')}</tbody></table></div>
          <div class="row gap-2" style="margin-top:12px">
            <button class="button button--primary" type="button" data-use-design="${esc(design.id)}">${icon('hammer')} Use in builder</button>
            <a class="button" href="/api/schematics/${encodeURIComponent(design.id)}/download.schem">${icon('download')} Download .schem</a>
          </div>
        </div>
      </div>`;
    const use = body.querySelector('[data-use-design]');
    if (use) use.addEventListener('click', () => {
      builderDesign = design.id;
      close();
      location.hash = '#/builder';
    });
  } catch (err) {
    const modal = document.querySelector('.modal');
    if (modal) modal.querySelector('.modal-body').innerHTML = `<div class="callout callout--danger">${icon('alert-circle')}<div>${esc(err.message)}</div></div>`;
  }
}

export const buildProjectsPage = {
  title: 'Build Projects',
  render() {
    const list = builds();
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Construction', title: 'Build Projects', description: 'Every build the builder registry has created in this runtime, with placement progress and blockers.', actions: `<a class="button" href="#/builder">${icon('plus')} Start build</a>` })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Projects', value: num(list.length), iconName: 'folder', tone: 'info', context: `${num(list.filter((build) => build.state === 'COMPLETE').length)} complete` })}
          ${statCard({ label: 'Blocks placed', value: num(list.reduce((total, build) => total + (build.placedBlocks || 0), 0)), iconName: 'blocks', tone: 'accent', context: 'Across all builds' })}
          ${statCard({ label: 'Conflicts', value: num(list.reduce((total, build) => total + (build.conflicts || []).length, 0)), iconName: 'alert', tone: list.some((build) => (build.conflicts || []).length) ? 'warning' : 'success', context: 'Site conflicts reported by builders' })}
          ${statCard({ label: 'Missing materials', value: num(list.reduce((total, build) => total + (build.missingMaterials || []).length, 0)), iconName: 'package', tone: 'neutral', context: 'Shortfalls across active builds' })}
        </div>
        ${list.length ? `<div class="grid grid--2">${list.map((build) => `<article class="card">
          <div class="card-header"><div class="card-title">${esc(build.name || build.buildId)}</div>${badge(build.state, buildStateTone(build.state), { dot: true })}</div>
          <div class="card-body">
            ${progress(build.percentComplete || 0, 100, { lg: true, tone: build.percentComplete >= 100 ? 'ok' : 'accent', label: 'Build progress' })}
            ${kvRows([
              ['Build ID', esc(build.buildId), true],
              ['Tier', esc(build.tier || '—')],
              ['Dimensions', build.dimensions ? `${build.dimensions.width}×${build.dimensions.length}×${build.dimensions.height}` : '—'],
              ['Origin', build.origin ? `${build.origin.x}, ${build.origin.y}, ${build.origin.z}` : '—'],
              ['Placed', `${num(build.placedBlocks || 0)} / ${num(build.totalBlocks || 0)}`],
              ['Elapsed', build.elapsedMs ? esc(duration(build.elapsedMs)) : '—']
            ])}
            ${(build.missingMaterials || []).length ? `<div class="callout callout--warn" style="margin-top:10px">${icon('package')}<div>Missing: ${esc(build.missingMaterials.slice(0, 6).map((item) => typeof item === 'string' ? humanize(item) : `${humanize(item.item || '')} ×${item.count ?? item.missing ?? ''}`).join(', '))}</div></div>` : ''}
            <div class="row gap-2" style="margin-top:10px">
              ${!['COMPLETE', 'CANCELLED', 'FAILED'].includes(build.state) ? `<button class="button button--sm" type="button" data-command="build run ${esc(build.buildId)} 40">${icon('play')} Run steps</button><button class="button button--sm button--danger-ghost" type="button" data-command="build stop ${esc(build.buildId)}" data-danger="true" data-confirm-title="Stop build" data-confirm-message="Stop ${esc(build.name)}?">${icon('square')} Stop</button>` : ''}
              <a class="button button--sm" href="#/projects/${encodeURIComponent(build.buildId)}">${icon('arrow-up-right')} Detail</a>
            </div>
          </div>
        </article>`).join('')}</div>` : `<div class="card">${emptyState('No build projects', 'Builds appear here once the builder registry creates one.', 'folder', '<a class="button button--primary" href="#/builder">Start a build</a>')}</div>`}
      </div>`;
  }
};

export const projectDetailPage = {
  title: 'Build project',
  render({ params = [] } = {}) {
    const id = params[0];
    const build = builds().find((entry) => String(entry.buildId) === String(id));
    if (!build) {
      return `<div class="page">${pageHeader({ eyebrow: 'Construction', title: 'Build not found', description: `No build with ID “${esc(id)}” exists in this runtime.` })}<div class="card">${emptyState('Unknown build', 'The builder registry has no record of this project.', 'folder', '<a class="button button--primary" href="#/projects">All projects</a>')}</div></div>`;
    }
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Construction', title: build.name || build.buildId,
          description: `Build project ${build.buildId} in state ${build.state}.`,
          actions: `<a class="button" href="#/projects">${icon('arrow-left')} Projects</a>${!['COMPLETE', 'CANCELLED', 'FAILED'].includes(build.state) ? `<button class="button button--danger-ghost" type="button" data-command="build stop ${esc(build.buildId)}" data-danger="true" data-confirm-title="Stop build" data-confirm-message="Stop ${esc(build.name)}?">${icon('square')} Stop build</button>` : ''}`
        })}
        <div class="grid grid--main-side">
          <section class="card">
            <div class="card-header"><div class="card-title">${icon('hammer')} Progress</div>${badge(build.state, buildStateTone(build.state), { dot: true })}</div>
            <div class="card-body">
              ${progress(build.percentComplete || 0, 100, { lg: true, tone: build.percentComplete >= 100 ? 'ok' : 'accent' })}
              ${kvRows([
                ['Build ID', esc(build.buildId), true],
                ['Schematic', esc(build.schematicId || '—'), true],
                ['Tier', esc(build.tier || '—')],
                ['Origin', build.origin ? `${build.origin.x}, ${build.origin.y}, ${build.origin.z}` : '—'],
                ['Dimensions', build.dimensions ? `${build.dimensions.width} × ${build.dimensions.length} × ${build.dimensions.height}` : '—'],
                ['Total blocks', num(build.totalBlocks)],
                ['To place', num(build.toPlace)],
                ['Placed', num(build.placedBlocks)],
                ['Started', build.startedAt ? esc(formatDateTime(build.startedAt)) : '—'],
                ['Elapsed', build.elapsedMs ? esc(duration(build.elapsedMs)) : '—']
              ])}
            </div>
          </section>
          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('alert')} Blockers</div></div>
              <div class="card-body">
                ${(build.conflicts || []).length ? `<div class="callout callout--danger">${icon('alert-circle')}<div>${num(build.conflicts.length)} site conflicts reported.</div></div>` : ''}
                ${(build.missingMaterials || []).length ? `<div class="callout callout--warn">${icon('package')}<div>Missing ${num(build.missingMaterials.length)} material types.</div></div>` : ''}
                ${build.blocked ? `<div class="callout callout--warn">${icon('lock')}<div>Build reported blocked: ${esc(build.blocked)}</div></div>` : ''}
                ${!(build.conflicts || []).length && !(build.missingMaterials || []).length && !build.blocked ? '<div class="muted small">No blockers reported by the builder.</div>' : ''}
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('clipboard')} Task phases</div></div>
              <div class="card-body">${build.tasks ? kvRows(Object.entries(build.tasks).map(([phase, count]) => [humanize(phase), num(count)])) : '<div class="muted small">No task breakdown reported.</div>'}</div>
            </section>
          </aside>
        </div>
        ${(build.recentEvents || []).length ? `<section class="card" style="margin-top:16px"><div class="card-header"><div class="card-title">${icon('activity')} Recent builder events</div></div><div class="activity-list">${build.recentEvents.slice(-15).reverse().map((event) => `<div class="activity-item"><span class="activity-icon">${icon(event.level === 'error' ? 'alert-circle' : event.level === 'warn' ? 'alert' : 'hammer')}</span><div class="activity-main"><div>${esc(event.message || event.msg || '')}</div><div class="mono">${esc(event.level || 'info')}${event.at ? ` · ${esc(formatDateTime(event.at))}` : ''}</div></div></div>`).join('')}</div></section>` : ''}
      </div>`;
  }
};

export const projectHistoryPage = {
  title: 'Project History',
  render() {
    const list = builds();
    const completed = list.filter((build) => ['COMPLETE', 'CANCELLED', 'FAILED'].includes(build.state));
    const events = state.logs.filter((log) => log.scope === 'builder' || log.scope === 'build' || /build/i.test(log.msg)).slice().reverse().slice(0, 120);
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Construction', title: 'Project History', description: 'Completed, cancelled and failed builds from this runtime, plus the builder log stream.', actions: `<a class="button" href="#/projects">${icon('folder')} Active projects</a>` })}
        <section class="card">
          <div class="card-header"><div class="card-title">${icon('check-circle')} Finished builds</div><span class="tiny muted">${completed.length}</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Build</th><th>Design</th><th>State</th><th>Placed</th><th>Elapsed</th><th>Started</th><th>Verification</th></tr></thead>
            <tbody>${completed.length ? completed.map((build) => `<tr>
              <td class="mono tiny">${esc(build.buildId)}</td>
              <td>${esc(build.name || '—')}</td>
              <td>${badge(build.state, buildStateTone(build.state), { dot: true })}</td>
              <td class="mono">${num(build.placedBlocks)} / ${num(build.totalBlocks)}</td>
              <td class="tiny">${build.elapsedMs ? esc(duration(build.elapsedMs)) : '—'}</td>
              <td class="tiny">${build.startedAt ? esc(formatDateTime(build.startedAt)) : '—'}</td>
              <td>${build.verification ? (build.verification.complete ? badge('Verified', 'ok') : badge(`${num(build.verification.remaining)} remaining`, 'warn')) : '<span class="muted tiny">not verified</span>'}</td>
            </tr>`).join('') : `<tr><td colspan="7">${emptyState('No finished builds', 'Completed and cancelled builds will be listed here. History resets when the runtime restarts.', 'history')}</td></tr>`}</tbody>
          </table></div>
        </section>
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('list')} Builder log</div><span class="tiny muted">${events.length} entries</span></div>
          <div class="log-list">${events.length ? events.map((log) => `<div class="log-line"><span class="log-time mono">${esc(new Date(log.ts).toLocaleTimeString('en-GB'))}</span><span class="log-level log-level--${log.level}">${esc(log.level)}</span><span class="log-scope mono">${esc(log.scope)}</span><span class="log-msg">${esc(log.msg)}</span></div>`).join('') : emptyState('No builder events', 'Builder activity will stream here as builds progress.', 'list')}</div>
        </section>
      </div>`;
  }
};
