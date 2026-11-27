import { state, runCommand, refreshState, botNames } from '../store.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { esc, num, humanize, duration, timeAgo, formatDateTime } from '../utils.js';
import { badge, progress, kvRows, emptyState, pageHeader, statCard, toast, confirmDialog, setButtonLoading, resultMessage, openModal } from '../ui.js';
import { schematicPreview } from '../charts.js';
import { quoteArg } from '../commands.js';

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

export const homeBasePage = {
  title: 'Home Base',
  render() {
    const snap = state.snapshot || {};
    const base = snap.homeBase || {};
    const home = base.home || (snap.diagnostics && snap.diagnostics.runtime && snap.diagnostics.runtime.home) || null;
    const perBot = base.perBot || [];
    const sleep = new Map((snap.sleep || []).map((row) => [row.bot, row]));
    const inventory = new Map(((snap.inventory && snap.inventory.bots) || []).map((row) => [row.bot, row]));
    const builds = ((snap.builder && snap.builder.builds) || []).filter((build) => String(build.buildId).startsWith('home-'));
    // Tiers come from the loaded schematic library, not a page-local list.
    const tiers = ((snap.schematics && snap.schematics.stats && snap.schematics.stats.tiers) || [])
      .map((entry) => entry.tier)
      .filter(Boolean);
    const defaultTier = tiers.includes('Novice') ? 'Novice' : (tiers[0] || '');
    const beds = [...inventory.values()].reduce((sum, row) => sum + ((row.items || []).filter((item) => /_bed$/.test(item.name || item) || item.name === 'bed').reduce((n, item) => n + (item.count || 0), 0)), 0);
    const sleeping = [...sleep.values()].filter((row) => row.sleeping).length;
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Construction', title: 'Home Base', description: 'The shared home coordinate, bed availability and base construction state. Coordinates come from the runtime; bed counts come from live inventories.',
          actions: `<a class="button" href="#/builder">${icon('hammer')} Builder</a><a class="button" href="#/schematics">${icon('book-open')} Library</a><button class="button button--primary" type="button" data-command="return home all">${icon('home')} Return all home</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Home', value: home ? `${home.x}, ${home.y}, ${home.z}` : 'Not set', iconName: 'home', tone: home ? 'success' : 'warning', context: home ? 'Shared team home coordinate' : 'Set a home with the form below' })}
          ${statCard({ label: 'Beds held', value: num(beds), iconName: 'bed', tone: beds >= (perBot.length || botNames().length) ? 'success' : beds ? 'warning' : 'danger', context: 'Bed items in live inventories' })}
          ${statCard({ label: 'Sleeping', value: `${sleeping}<small> / ${perBot.length || botNames().length}</small>`, iconName: 'moon', tone: sleeping ? 'info' : 'neutral', context: 'Current sleep state' })}
          ${statCard({ label: 'Home builds', value: num(builds.length), iconName: 'hammer', tone: builds.length ? 'accent' : 'neutral', context: builds.length ? builds.map((build) => build.state).join(', ') : 'No home build registered' })}
        </div>
        <div class="grid grid--main-side">
          <div class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('home')} Team home</div>${home ? badge('SET', 'ok', { dot: true }) : badge('UNSET', 'warn')}</div>
              <div class="card-body">
                <form data-home-form>
                  <div class="form-grid form-grid--3">
                    <div class="field"><label class="field-label" for="home-x">X</label><input class="input" id="home-x" type="number" value="${home ? home.x : 0}" required></div>
                    <div class="field"><label class="field-label" for="home-y">Y</label><input class="input" id="home-y" type="number" value="${home ? home.y : 65}" required></div>
                    <div class="field"><label class="field-label" for="home-z">Z</label><input class="input" id="home-z" type="number" value="${home ? home.z : 0}" required></div>
                  </div>
                  <div class="row gap-2" style="margin-top:10px"><button class="button" type="submit">${icon('map')} Set home</button><button class="button" type="button" data-command="home status">${icon('info')} Home status</button></div>
                </form>
                <div class="divider"></div>
                <div class="table-wrap"><table class="table table--compact">
                  <thead><tr><th>Bot</th><th>Home</th><th>Bed item</th><th>Sleeping</th><th>Distance</th><th>Design</th><th>Action</th></tr></thead>
                  <tbody>${perBot.length ? perBot.map((row) => {
                    const bot = (snap.bots || []).find((entry) => entry.name === row.bot) || {};
                    const bed = sleep.get(row.bot) || {};
                    const dist = home && bot.position ? Math.round(Math.hypot(bot.position.x - home.x, bot.position.z - home.z)) : null;
                    return `<tr>
                      <td><a class="link" href="#/bots/${encodeURIComponent(row.bot)}">${esc(row.bot)}</a></td>
                      <td class="mono tiny">${row.home ? `${row.home.x}, ${row.home.y}, ${row.home.z}` : home ? `${home.x}, ${home.y}, ${home.z}` : '—'}</td>
                      <td>${bed.hasBedItem ? badge('HELD', 'ok') : badge('NONE', 'warn')}</td>
                      <td>${bed.sleeping ? badge('SLEEPING', 'info') : badge('AWAKE', 'neutral')}</td>
                      <td class="mono">${dist === null ? '—' : `${dist} m`}</td>
                      <td class="tiny">${esc(row.design ? (row.design.name || row.design.id || '—') : '—')}</td>
                      <td><button class="button button--sm" type="button" data-command="return home ${esc(row.bot)}">${icon('navigation')} Return</button></td>
                    </tr>`;
                  }).join('') : `<tr><td colspan="7">${emptyState('No home state', 'The home manager has not reported yet.', 'home')}</td></tr>`}</tbody>
                </table></div>
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('hammer')} Home construction</div><span class="tiny muted">${builds.length} build(s)</span></div>
              <div class="card-body">
                <form data-home-build-form>
                  <div class="form-grid form-grid--2">
                    <div class="field"><label class="field-label" for="home-tier">Schematic tier</label><select class="select" id="home-tier">${tiers.length ? tiers.map((tier) => `<option value="${esc(tier)}"${tier === defaultTier ? ' selected' : ''}>${esc(tier)}</option>`).join('') : '<option value="">Tier catalogue unavailable</option>'}</select></div>
                    <div class="field"><label class="field-label" for="home-run">Execution</label><select class="select" id="home-run"><option value="run">Plan and run</option><option value="">Plan only</option></select></div>
                  </div>
                  <button class="button button--primary" type="submit" style="margin-top:10px">${icon('home')} Build home base</button>
                  <p class="tiny muted" style="margin:10px 0 0">The builder validates materials and site clearance before placing blocks. Starting requires explicit confirmation.</p>
                </form>
                ${builds.length ? `<div class="divider"></div><div class="table-wrap"><table class="table table--compact"><thead><tr><th>Build</th><th>Design</th><th>State</th><th>Progress</th></tr></thead><tbody>${builds.slice(0, 8).map((build) => `<tr><td class="mono tiny"><a class="link" href="#/projects/${encodeURIComponent(build.buildId)}">${esc(build.buildId)}</a></td><td>${esc(build.name || '—')}</td><td>${badge(build.state || '—', build.state === 'COMPLETE' ? 'ok' : build.state === 'FAILED' ? 'danger' : build.state === 'PAUSED' ? 'warn' : 'accent')}</td><td style="min-width:110px">${progress(build.percentComplete || 0, 100, { sm: true })}</td></tr>`).join('')}</tbody></table></div>` : ''}
              </div>
            </section>
          </div>
          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('info')} Base readiness</div></div>
              <div class="card-body">
                ${kvRows([
                  ['Home coordinate', home ? `${home.x}, ${home.y}, ${home.z}` : 'unset', true],
                  ['Bots reporting', `${perBot.length} / ${botNames().length}`],
                  ['Bed items', num(beds)],
                  ['Sleeping now', num(sleeping)],
                  ['Home builds', num(builds.length)]
                ])}
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('shield')} Safety</div></div>
              <div class="card-body"><div class="callout callout--info">${icon('info')}<div>Home coordinates are navigation targets, not a claim that a structure exists there. The builder rescans the world and only verifies blocks it actually placed.</div></div></div>
            </section>
          </aside>
        </div>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-home-form]');
    if (form) form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const x = form.querySelector('#home-x').value;
      const y = form.querySelector('#home-y').value;
      const z = form.querySelector('#home-z').value;
      try {
        const result = await runCommand(`home set ${x} ${y} ${z}`);
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
      } catch (err) {
        toast({ type: 'error', title: 'Home not updated', message: err.message });
      }
    });
    const buildForm = root.querySelector('[data-home-build-form]');
    if (buildForm) buildForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const tier = buildForm.querySelector('#home-tier').value;
      if (!tier) {
        toast({ type: 'warn', title: 'No schematic tier available', message: 'The schematic library has not reported any tiers yet.' });
        return;
      }
      const run = buildForm.querySelector('#home-run').value;
      const ok = await confirmDialog({
        title: 'Build home base',
        message: `Plan ${tier} home-base construction at the shared home?`,
        confirmLabel: 'Build',
        details: 'The builder checks the site and materials first. Blocks are only claimed as placed after a world rescan.'
      });
      if (!ok) return;
      const button = buildForm.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const result = await runCommand(`home build ${tier}${run ? ' run' : ''}`, { confirm: true });
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
      } catch (err) {
        toast({ type: 'error', title: 'Home build failed', message: err.message, duration: 8000 });
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
};

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
                  <td><div class="row gap-2">${!['COMPLETE', 'CANCELLED', 'FAILED'].includes(build.state) ? `<button class="button button--sm" type="button" data-command="build run ${esc(build.buildId)} 40">Run</button>${build.state === 'PAUSED' ? `<button class="button button--sm" type="button" data-command="build resume ${esc(build.buildId)}">Resume</button>` : `<button class="button button--sm" type="button" data-command="build pause ${esc(build.buildId)}">Pause</button>`}<button class="button button--sm button--danger-ghost" type="button" data-command="build stop ${esc(build.buildId)}" data-danger="true" data-confirm-title="Stop build" data-confirm-message="Stop ${esc(build.name)}? Placed blocks remain in the world.">Stop</button>` : ''}</div></td>
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
                ], { htmlValues: true })}
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
      const x = form.querySelector('#build-x').value.trim();
      const y = form.querySelector('#build-y').value.trim();
      const z = form.querySelector('#build-z').value.trim();
      if (![x, y, z].every((value) => value !== '' && Number.isInteger(Number(value)))) {
        toast({ type: 'warn', title: 'Origin required', message: 'Origin X, Y and Z must all be numbers before a build can be previewed.' });
        return;
      }
      const run = Boolean(form.querySelector('#build-run').value);
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const designArg = quoteArg(design);
        const previewResponse = await runCommand(`build preview ${designArg} ${x} ${y} ${z}`);
        const preview = previewResponse.result || previewResponse;
        if (!preview.ok) throw new Error(preview.error || 'preview failed');
        const analysis = preview.analysis || {};
        if (analysis.feasible === false) {
          const missing = Object.entries(analysis.missingMaterials || {}).map(([item, count]) => `${count}× ${item}`).join(', ');
          const blocked = (analysis.blocked || []).length;
          const conflicts = (analysis.conflicts || []).length;
          toast({
            type: 'error',
            title: 'Preview blocked',
            message: [missing ? `missing ${missing}` : '', blocked ? `${blocked} blocked blocks` : '', conflicts ? `${conflicts} conflicts` : ''].filter(Boolean).join(' · ') || 'the site cannot be prepared',
            duration: 9000
          });
          return;
        }
        const ok = await confirmDialog({
          title: 'Start build',
          message: `Start building ${design}?`,
          confirmLabel: 'Start build',
          details: `Preview: ${num(analysis.toPlace || 0)} blocks to place, ${num(analysis.alreadyBuilt || 0)} already present, ${num((analysis.conflicts || []).length)} conflicts and ${num((analysis.blocked || []).length)} blocked positions. The builder rescans the world and only counts verified placements.`
        });
        if (!ok) return;
        const line = `build ${quoteArg(design)} ${x} ${y} ${z}${run ? ' run' : ''}`;
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
            ['Version', esc(String(design.versionCompatibility || '—'))],
            ...(design.custom ? [
              ['Format', esc(design.format)],
              ['Licence', esc(design.licence || 'UNKNOWN')],
              ['Source', esc(design.source && design.source.kind ? design.source.kind : 'local')],
              ['Validated', design.validated === false ? 'no — unknown blocks present' : 'yes']
            ] : [])
          ])}
          ${(design.warnings || []).length ? `<div class="callout callout--warn">${icon('alert')}<div>${esc((design.warnings || []).map((warning) => warning.detail || warning.kind).join(' · '))}</div></div>` : ''}
          <div class="divider"></div>
          <div class="tiny muted" style="margin-bottom:6px">Top materials</div>
          <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Block</th><th>Count</th></tr></thead><tbody>${result.materials.slice(0, 14).map(([name, count]) => `<tr><td class="mono tiny">${esc(name)}</td><td class="mono">${num(count)}</td></tr>`).join('')}</tbody></table></div>
          <div class="row gap-2" style="margin-top:12px">
            <button class="button button--primary" type="button" data-use-design="${esc(design.id)}">${icon('hammer')} Use in builder</button>
            <a class="button" href="/api/schematics/${encodeURIComponent(design.id)}/download.schem">${icon('download')} Download .schem</a>
            ${design.custom ? `<a class="button" href="/api/schematics/${encodeURIComponent(design.id)}/export?format=litematic">${icon('download')} .litematic</a><a class="button" href="/api/schematics/${encodeURIComponent(design.id)}/export?format=vanilla-structure">${icon('download')} .nbt</a>` : ''}
          </div>
          ${design.custom ? `<div class="row gap-2" style="margin-top:8px;flex-wrap:wrap">
            <button class="button button--sm" type="button" data-custom-rename="${esc(design.id)}">${icon('edit')} Rename</button>
            <button class="button button--sm" type="button" data-custom-tag="${esc(design.id)}">${icon('flag')} Add tag</button>
            <button class="button button--sm" type="button" data-custom-licence="${esc(design.id)}">${icon('file')} Licence</button>
            <button class="button button--sm" type="button" data-custom-duplicate="${esc(design.id)}">${icon('copy')} Duplicate</button>
            <button class="button button--sm button--danger-ghost" type="button" data-custom-delete="${esc(design.id)}">${icon('trash')} Delete</button>
          </div>` : ''}
        </div>
      </div>`;
    const use = body.querySelector('[data-use-design]');
    if (use) use.addEventListener('click', () => {
      builderDesign = design.id;
      close();
      location.hash = '#/builder';
    });
    const customAction = async (action, promptText, field) => {
      const value = window.prompt(promptText);
      if (value === null) return;
      try {
        const result = await api.customAction(design.id, action, { [field]: value });
        toast({ type: 'success', title: `Schematic ${action} complete`, message: result.entry ? result.entry.name : design.id });
        close();
        legacyLibraryReset();
        await refreshState();
      } catch (err) {
        toast({ type: 'error', title: `Could not ${action}`, message: err.message });
      }
    };
    const rename = body.querySelector('[data-custom-rename]');
    if (rename) rename.addEventListener('click', () => customAction('rename', 'New display name', 'name'));
    const tag = body.querySelector('[data-custom-tag]');
    if (tag) tag.addEventListener('click', () => {
      const value = window.prompt('Tag to add');
      if (!value) return;
      api.customAction(design.id, 'tag', { tags: [value] }).then(() => { toast({ type: 'success', title: 'Tag added', message: value }); close(); legacyLibraryReset(); return refreshState(); })
        .catch((err) => toast({ type: 'error', title: 'Tag failed', message: err.message }));
    });
    const licence = body.querySelector('[data-custom-licence]');
    if (licence) licence.addEventListener('click', () => customAction('licence', 'Licence / attribution', 'licence'));
    const duplicate = body.querySelector('[data-custom-duplicate]');
    if (duplicate) duplicate.addEventListener('click', () => {
      api.customAction(design.id, 'duplicate', {}).then((result) => { toast({ type: 'success', title: 'Duplicate imported', message: result.entry.name }); close(); legacyLibraryReset(); return refreshState(); })
        .catch((err) => toast({ type: 'error', title: 'Duplicate failed', message: err.message }));
    });
    const remove = body.querySelector('[data-custom-delete]');
    if (remove) remove.addEventListener('click', () => {
      if (!window.confirm(`Delete ${design.name} from the custom catalogue? The original file is not removed.`)) return;
      api.customDelete(design.id).then(() => { toast({ type: 'success', title: 'Removed from catalogue', message: design.name }); close(); legacyLibraryReset(); return refreshState(); })
        .catch((err) => toast({ type: 'error', title: 'Delete failed', message: err.message }));
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

/**
 * Building workspace: catalogue + custom imports + live per-block evidence and
 * controls. Every button calls a real API or command endpoint.
 */
export const buildingPage = {
  title: 'Building',
  render() {
    const snap = state.snapshot || {};
    const building = snap.building || {};
    const custom = building.custom || (snap.schematics && snap.schematics.custom) || {};
    const lib = (snap.schematics && snap.schematics.stats) || {};
    const registry = building.registry || {};
    const builds = building.builds || [];
    const compatible = registry.compatibility === 'EXACT';
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Construction', title: 'Building workspace',
          description: 'Validated catalogue, custom schematics, exact block-state placement evidence and build controls. Unsupported versions or blocks are reported, never guessed.',
          actions: `<a class="button" href="#/schematics">${icon('book-open')} Full library</a><a class="button button--primary" href="#/builder">${icon('hammer')} Start build</a>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Catalogue', value: num(lib.count || 0), iconName: 'book-open', tone: 'info', context: `${num(lib.uniqueGeometry || 0)} unique geometries` })}
          ${statCard({ label: 'Custom schematics', value: num(custom.count || 0), iconName: 'folder', tone: custom.count ? 'accent' : 'neutral', context: `${num(custom.validated || 0)} validated · ${num(custom.duplicates || 0)} duplicates rejected` })}
          ${statCard({ label: 'Block registry', value: registry.version || '—', iconName: 'database', tone: compatible ? 'success' : 'warning', context: compatible ? 'Exact requested version' : (registry.requestedVersion && registry.requestedVersion !== 'auto' ? `Requested ${registry.requestedVersion} · nearest known` : 'Requested version auto') })}
          ${statCard({ label: 'Active builds', value: num(builds.filter((build) => !['COMPLETE', 'FAILED', 'CANCELLED'].includes(build.state)).length), iconName: 'hammer', tone: 'accent', context: `${num(builds.length)} builder registrations` })}
        </div>
        ${!compatible ? `<div class="callout callout--warn">${icon('alert')}<div>${esc(registry.fallbackReason || 'Block registry version is not exact. Blueprint validation uses the nearest known minecraft-data version; live placement still uses the server’s own state ids.')}</div></div>` : ''}
        <div class="grid grid--main-side">
          <div class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('upload')} Import a schematic</div><span class="badge badge--outline">.schem v1–v3 · .litematic · .schematic · .nbt</span></div>
              <div class="card-body">
                <form data-import-form>
                  <div class="form-grid form-grid--2">
                    <div class="field"><label class="field-label" for="import-file">File</label><input class="input" id="import-file" type="file" accept=".schem,.litematic,.schematic,.nbt,.json" required></div>
                    <div class="field"><label class="field-label" for="import-name">Display name (optional)</label><input class="input" id="import-name" placeholder="Defaults to the file name"></div>
                    <div class="field"><label class="field-label" for="import-licence">Licence / attribution</label><input class="input" id="import-licence" placeholder="e.g. CC-BY-4.0, own work" value="UNKNOWN"></div>
                    <div class="field"><label class="field-label" for="import-source">Source</label><input class="input" id="import-source" placeholder="Where did this file come from?" value="local"></div>
                  </div>
                  <button class="button button--primary" type="submit" style="margin-top:10px">${icon('upload')} Import and validate</button>
                  <p class="tiny muted" style="margin:10px 0 0">Imports are indexed, not built. Identical content and duplicate geometry are rejected; block states and unknown blocks are reported honestly.</p>
                </form>
                <div class="divider"></div>
                <div class="row gap-2">
                  <button class="button button--sm" type="button" data-custom-scan>${icon('refresh-cw')} Rescan folder</button>
                  <span class="tiny muted">Watching: ${custom.watching ? 'yes' : 'no'} · ${esc(custom.dir || '')}</span>
                </div>
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('list')} Builds and evidence</div><span class="tiny muted">${builds.length}</span></div>
              <div class="card-body" data-building-builds>
                ${builds.length ? `<div class="table-wrap"><table class="table table--compact"><thead><tr><th>Build</th><th>State</th><th>Verified</th><th>Missing / wrong</th><th>Controls</th></tr></thead><tbody>${builds.map((build) => {
                  const verification = build.verification || {};
                  return `<tr>
                    <td><a class="link" href="#/projects/${encodeURIComponent(build.id)}">${esc(build.name || build.id)}</a><div class="tiny muted mono">${esc(build.id)}</div></td>
                    <td>${badge(build.state || '—', buildStateTone(build.state))}</td>
                    <td class="mono">${num(verification.placed || 0)} / ${num(verification.total || 0)}</td>
                    <td class="mono">${num(verification.missingCount || 0)} / ${num(verification.wrongCount || 0)}</td>
                    <td><div class="row gap-1">
                      ${!['COMPLETE', 'CANCELLED', 'FAILED'].includes(build.state) ? `<button class="button button--sm" type="button" data-build-action="pause" data-build-id="${esc(build.id)}">${icon('pause')} Pause</button><button class="button button--sm" type="button" data-build-action="resume" data-build-id="${esc(build.id)}">${icon('play')} Resume</button>` : ''}
                      <button class="button button--sm" type="button" data-build-action="verify" data-build-id="${esc(build.id)}">${icon('shield-check')} Verify</button>
                      <button class="button button--sm" type="button" data-build-action="repair" data-build-id="${esc(build.id)}">${icon('wrench')} Repair</button>
                      <button class="button button--sm button--danger-ghost" type="button" data-build-action="cancel" data-build-id="${esc(build.id)}" data-danger="true">${icon('square')} Stop</button>
                      <button class="button button--sm" type="button" data-block-evidence="${esc(build.id)}">${icon('layers')} Blocks</button>
                    </div></td>
                  </tr>`;
                }).join('')}</tbody></table></div>` : emptyState('No builds yet', 'Start a build from the library and its per-block evidence will appear here.', 'hammer', '<a class="button button--primary" href="#/builder">Start a build</a>')}
              </div>
            </section>
          </div>
          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('settings')} Building policy</div></div>
              <div class="card-body">${kvRows([
                ['Verification', String(building.config?.verification ?? true)],
                ['Triple check', String(building.config?.tripleCheck ?? true)],
                ['Auto-repair', String(building.config?.autoRepair ?? false)],
                ['Deterministic placement', String(building.config?.deterministic ?? true)],
                ['Random placement', String(building.config?.randomPlacement ?? false)],
                ['Explosives', String(building.config?.allowExplosives ?? false)],
                ['Custom schematics', String(building.config?.customSchematics ?? true)],
                ['Library target', num(building.config?.libraryTarget ?? 10000)]
              ])}</div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('alert')} Honest limitations</div></div>
              <div class="card-body">
                <div class="callout callout--info">${icon('info')}<div>Construction correctness does not prove redstone logic or farm productivity. Those require a separate live functional test.</div></div>
                <div class="callout callout--warn">${icon('database')}<div>${esc(registry.compatibility === 'EXACT' ? 'The requested block registry is installed. Server-side mods may still add blocks that are not in it.' : (registry.fallbackReason || 'No block registry loaded. Unknown blocks cannot be validated.'))}</div></div>
              </div>
            </section>
          </aside>
        </div>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-import-form]');
    if (form) form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const file = form.querySelector('#import-file').files[0];
      if (!file) return;
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true);
      try {
        const query = new URLSearchParams({
          filename: file.name,
          licence: form.querySelector('#import-licence').value || 'UNKNOWN',
          source: form.querySelector('#import-source').value || 'local'
        });
        const name = form.querySelector('#import-name').value.trim();
        if (name) query.set('name', name);
        const response = await fetch(`/api/schematics/upload?${query.toString()}`, {
          method: 'POST', body: file, credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name }
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'import failed');
        toast({ type: 'success', title: 'Schematic imported', message: `${payload.entry.name} (${payload.entry.format}, ${num(payload.entry.blocks)} blocks)` });
        if ((payload.warnings || []).length) toast({ type: 'warn', title: 'Import warning', message: payload.warnings[0].detail || payload.warnings[0].kind, duration: 12000 });
        form.reset();
        await refreshState();
      } catch (err) {
        toast({ type: 'error', title: 'Import rejected', message: err.message, duration: 12000 });
      } finally {
        setButtonLoading(button, false);
      }
    });
    const scan = root.querySelector('[data-custom-scan]');
    if (scan) scan.addEventListener('click', async () => {
      try {
        const result = await api.customScan();
        toast({ type: 'info', title: 'Custom folder scanned', message: `${num(result.imported || 0)} imported, ${num(result.rejected || 0)} rejected` });
        await refreshState();
      } catch (err) {
        toast({ type: 'error', title: 'Scan failed', message: err.message });
      }
    });
    root.querySelectorAll('[data-build-action]').forEach((button) => button.addEventListener('click', async () => {
      const id = button.getAttribute('data-build-id');
      const action = button.getAttribute('data-build-action');
      if (action === 'cancel' && !window.confirm('Cancel this build? Pending tasks stop and no further blocks are placed.')) return;
      // Repair resumes placement and may remove extra blocks. It must not run
      // from a single click just because the command gateway marks it confirmed.
      if (action === 'repair' && !window.confirm('Repair this build? Remaining work resumes and the world is rescanned; only verified placements count.')) return;
      // The endpoint now enforces the same confirmation contract as the CLI.
      // Only send `confirm` after the dialog above has actually been accepted.
      const confirmedAction = ['cancel', 'stop', 'repair', 'run'].includes(action);
      setButtonLoading(button, true);
      try {
        const result = await api.buildAction(id, action, confirmedAction ? { confirm: true } : {});
        const message = resultMessage(result);
        toast({ type: message.type, title: message.title, message: message.message });
        await refreshState();
      } catch (err) {
        toast({ type: 'error', title: `Build ${action} failed`, message: err.message });
      } finally {
        setButtonLoading(button, false);
      }
    }));
    root.querySelectorAll('[data-block-evidence]').forEach((button) => button.addEventListener('click', async () => {
      const id = button.getAttribute('data-block-evidence');
      setButtonLoading(button, true);
      try {
        const detail = await api.build(id);
        const statuses = detail.verification?.blockStatuses || {};
        const entries = (detail.blocks && detail.blocks.entries) || [];
        const close = openModal({
          title: `Per-block evidence · ${detail.build?.name || id}`,
          description: 'Each row is read back from the world and compared against the exact name and properties.',
          wide: true,
          body: `<div class="row gap-2" style="flex-wrap:wrap;margin-bottom:10px">${Object.entries(statuses).filter(([, count]) => count > 0).map(([status, count]) => badge(`${status} ${count}`, status === 'VERIFIED' ? 'ok' : status === 'FAILED' || status === 'REPAIR_REQUIRED' ? 'danger' : 'warn')).join('')}</div>
            <div class="callout callout--info">${icon('shield-check')}<div>${detail.tripleCheck?.ok ? 'Triple check passed: blueprint, placements and independent world audit agree.' : 'Triple check has not passed. See missing/wrong counts and block rows below.'}</div></div>
            <div class="table-wrap" style="max-height:55vh;overflow:auto"><table class="table table--compact"><thead><tr><th>Position</th><th>Expected</th><th>Observed</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
            <tbody>${entries.length ? entries.slice(0, 500).map((block) => `<tr><td class="mono tiny">${block.world.x}, ${block.world.y}, ${block.world.z}</td><td class="mono tiny">${esc(block.block)}</td><td class="mono tiny">${esc(block.observed || '—')}</td><td>${badge(block.status, block.status === 'VERIFIED' ? 'ok' : block.status === 'FAILED' || block.status === 'REPAIR_REQUIRED' ? 'danger' : 'warn')}</td><td class="mono">${num(block.attempts)}</td><td class="tiny">${esc(block.error || '')}</td></tr>`).join('') : '<tr><td colspan="6">No block rows returned.</td></tr>'}</tbody></table></div>`,
          label: 'Per-block evidence'
        });
        const footer = document.querySelector('.modal-footer');
        if (footer) footer.innerHTML = `<button class="button" type="button" data-close-modal>${icon('x')} Close</button>`;
        const closer = document.querySelector('[data-close-modal]');
        if (closer) closer.addEventListener('click', close);
      } catch (err) {
        toast({ type: 'error', title: 'Evidence unavailable', message: err.message });
      } finally {
        setButtonLoading(button, false);
      }
    }));
  }
};
