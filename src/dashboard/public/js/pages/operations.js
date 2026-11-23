import { state, runCommand } from '../store.js';
import { icon } from '../icons.js';
import { esc, num, humanize } from '../utils.js';
import { badge, progress, kvRows, emptyState, pageHeader, statCard, toast, setButtonLoading } from '../ui.js';
import { botStatus } from '../botStatus.js';

function construction() {
  return (state.snapshot && state.snapshot.construction) || { projects: [], active: null, warehouse: { containers: [], capacity: {} }, stats: {} };
}

function active() { return construction().active; }
function projects() { return construction().projects || []; }

function statusTone(status) {
  if (['COMPLETE'].includes(status)) return 'ok';
  if (['CANCELLED', 'BLOCKED', 'FAILED'].includes(status)) return 'danger';
  if (['PAUSED', 'AWAITING_MATERIALS', 'AWAITING_STORAGE'].includes(status)) return 'warn';
  return 'accent';
}

function phaseTone(status) {
  if (status === 'COMPLETE') return 'ok';
  if (status === 'ACTIVE') return 'accent';
  if (status === 'BLOCKED' || status === 'FAILED') return 'danger';
  if (status === 'SKIPPED') return 'neutral';
  return 'neutral';
}

function originText(origin) {
  return origin ? `${origin.x}, ${origin.y}, ${origin.z}` : '—';
}

function gate(label, command, message, className = 'button') {
  return `<button class="${className}" type="button" data-command="${esc(command)}" data-danger="true" data-confirm-title="${esc(label)}" data-confirm-message="${esc(message)}">${icon('shield')} ${esc(label)}</button>`;
}

function activeOrEmpty(body, title = 'No construction project', message = 'Create a project from the builder to start the pipeline.', actions = '') {
  if (!active()) return `<div class="card">${emptyState(title, message, 'folder', actions || '<button class="button button--primary" type="button" data-command-palette>Open command palette</button>')}</div>`;
  return typeof body === 'function' ? body() : body;
}

export const operationsOverview = {
  title: 'Builder Overview',
  render() {
    const c = construction();
    const p = active();
    const summary = p ? p.summary : null;
    const pipeline = p ? p.pipeline : [];
    const ready = p?.materialPlan?.ready;
    const coverage = p?.sitePreparation?.lighting?.coverage;
    return `
      <div class="page">
        ${pageHeader({
          eyebrow: 'Builder Operations', title: 'Construction Command',
          description: 'One crew, one active project, and a deterministic pipeline from survey to verified handover. Every figure is read from the live runtime and the persisted project.',
          actions: `<a class="button" href="#/builder-projects">${icon('folder')} Projects</a><a class="button" href="#/site-survey">${icon('map')} Site survey</a><button class="button button--primary" type="button" data-command-palette>${icon('terminal')} Command</button>`
        })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Projects', value: num(c.projects.length), iconName: 'folder', tone: c.projects.length ? 'accent' : 'neutral', context: `${c.projects.filter((entry) => entry.status === 'COMPLETE').length} complete` })}
          ${statCard({ label: 'Active status', value: summary ? summary.status : 'IDLE', iconName: 'activity', tone: summary ? statusTone(summary.status) : 'neutral', context: summary ? summary.phase : 'No active project' })}
          ${statCard({ label: 'Pipeline', value: summary ? `${summary.progress}%` : '—', iconName: 'git-branch', tone: 'info', context: p ? `${pipeline.filter((phase) => phase.status === 'COMPLETE').length}/${pipeline.length} phases complete` : 'Not started' })}
          ${statCard({ label: 'Materials', value: ready === true ? 'READY' : ready === false ? 'DEFICIT' : '—', iconName: 'package', tone: ready === true ? 'success' : ready === false ? 'warning' : 'neutral', context: p?.materialPlan ? `${Object.keys(p.materialPlan.deficit || {}).length} short item(s)` : 'Not calculated' })}
          ${statCard({ label: 'Storage', value: num(c.warehouse?.capacity?.containers || 0), iconName: 'archive', tone: (c.warehouse?.capacity?.containers || 0) ? 'success' : 'neutral', context: `${num(c.warehouse?.capacity?.items || 0)} stored items` })}
          ${statCard({ label: 'Light coverage', value: coverage === undefined ? '—' : `${Math.round((coverage || 0) * 100)}%`, iconName: 'sun', tone: coverage >= 1 ? 'success' : coverage > 0 ? 'warning' : 'neutral', context: 'Observed spawnable surfaces' })}
          ${statCard({ label: 'Quality', value: p?.quality?.complete ? 'PASSED' : p?.quality ? 'CHECK' : '—', iconName: 'check-circle', tone: p?.quality?.complete ? 'success' : p?.quality ? 'warning' : 'neutral', context: p?.quality?.verification ? `${p.quality.verification.placed}/${p.quality.verification.total} blocks verified` : 'Not verified' })}
          ${statCard({ label: 'Team', value: num(Object.keys(summary?.assignments || {}).length), iconName: 'users', tone: 'info', context: 'Assigned crew members' })}
        </div>
        <div class="grid grid--main-side">
          <div class="stack gap-4">
            ${activeOrEmpty(() => `
              <section class="card">
                <div class="card-header"><div class="card-title">${icon('git-branch')} Pipeline — ${esc(summary.name)}</div>${badge(summary.status, statusTone(summary.status), { dot: true })}</div>
                <div class="card-body">
                  ${progress(summary.progress || 0, 100, { lg: true, tone: summary.progress >= 100 ? 'ok' : 'accent', label: 'Site-to-handover progress' })}
                  <div class="table-wrap" style="margin-top:12px"><table class="table table--compact">
                    <thead><tr><th>Phase</th><th>Status</th><th>Attempts</th><th>Detail</th></tr></thead>
                    <tbody>${pipeline.map((phase) => `<tr>
                      <td><span class="mono tiny">${esc(phase.id)}</span><div class="tiny muted">${esc(phase.name)}</div></td>
                      <td>${badge(phase.status, phaseTone(phase.status), { dot: true })}</td>
                      <td class="mono">${num(phase.attempts || 0)}</td>
                      <td class="tiny">${esc(typeof phase.detail === 'string' ? phase.detail : phase.detail ? JSON.stringify(phase.detail).slice(0, 140) : '—')}</td>
                    </tr>`).join('')}</tbody>
                  </table></div>
                </div>
              </section>
              <section class="card">
                <div class="card-header"><div class="card-title">${icon('map-pin')} Site and build</div><span class="tiny muted">${esc(summary.schematicId)}</span></div>
                <div class="card-body">
                  ${kvRows([
                    ['Project ID', esc(summary.id), true],
                    ['Origin', originText(summary.origin), true],
                    ['Rotation', `${summary.rotation}°`],
                    ['Dimensions', `${summary.dimensions.width}×${summary.dimensions.length}×${summary.dimensions.height}`],
                    ['Tier', esc(summary.tier || '—')],
                    ['Priority', num(summary.priority)],
                    ['Phases done', `${p.buildPhases.filter((phase) => phase.status === 'COMPLETE').length}/${p.buildPhases.length}`],
                    ['Blockers', summary.blockedReason || 'None']
                  ])}
                  <div class="row gap-2" style="margin-top:12px">
                    <button class="button button--sm" type="button" data-command="builder preview">${icon('eye')} Preview</button>
                    <button class="button button--sm" type="button" data-command="site status">${icon('map')} Site</button>
                    <button class="button button--sm" type="button" data-command="materials calculate">${icon('package')} BOM</button>
                    <button class="button button--sm" type="button" data-command="build verify">${icon('check-circle')} Verify</button>
                    <a class="button button--sm" href="#/qa">${icon('shield')} QA</a>
                  </div>
                </div>
              </section>`)}
          </div>
          <aside class="stack gap-4">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('users')} Crew assignments</div></div>
              <div class="card-body">
                ${summary ? `<div class="table-wrap"><table class="table table--compact"><thead><tr><th>Bot</th><th>Role</th></tr></thead><tbody>${Object.entries(summary.assignments || {}).map(([bot, role]) => `<tr><td class="mono">${esc(bot)}</td><td class="tiny">${esc(typeof role === 'string' ? role : role.role)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="tiny muted">No crew assignment yet.</p>'}
                <div class="divider"></div><a class="button button--sm" href="#/crew">${icon('arrow-up-right')} Team assignments</a>
              </div>
            </section>
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('alert')} Runtime</div></div>
              <div class="card-body">
                ${kvRows([
                  ['Active project', c.activeId || 'none', true],
                  ['Projects loaded', num(c.projects.length)],
                  ['Phase engine', `${c.stats?.advanced || 0} advances`],
                  ['Blocked phases', num(c.stats?.blocked || 0)],
                  ['Last error', c.lastError || 'none'],
                  ['Persisted state', c.persisted || '—']
                ])}
                ${p && ['BLOCKED', 'AWAITING_MATERIALS', 'AWAITING_STORAGE'].includes(summary.status) ? `<div class="callout callout--warn" style="margin-top:10px">${icon('alert')}<div>${esc(summary.blockedReason || summary.status)}</div></div>` : ''}
              </div>
            </section>
          </aside>
        </div>
      </div>`;
  }
};

export const builderProjectsPage = {
  title: 'Builder Projects',
  render() {
    const list = projects();
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Builder Operations', title: 'Projects', description: 'Persisted construction projects, priorities and phase progress. Only one project is active at a time and site selection refuses overlapping footprints.', actions: `<a class="button" href="#/operations">${icon('layout-dashboard')} Overview</a><button class="button button--primary" type="button" data-command-palette>${icon('plus')} New project</button>` })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Projects', value: num(list.length), iconName: 'folder', tone: 'info', context: `${list.filter((p) => p.status === 'COMPLETE').length} complete` })}
          ${statCard({ label: 'Active', value: list.find((p) => p.active)?.status || 'none', iconName: 'activity', tone: 'accent', context: list.find((p) => p.active)?.phase || 'No phase' })}
          ${statCard({ label: 'Awaiting', value: num(list.filter((p) => String(p.status).startsWith('AWAITING')).length), iconName: 'clock', tone: list.some((p) => String(p.status).startsWith('AWAITING')) ? 'warning' : 'success', context: 'Material or storage stops' })}
          ${statCard({ label: 'Blocked', value: num(list.filter((p) => p.status === 'BLOCKED').length), iconName: 'alert', tone: list.some((p) => p.status === 'BLOCKED') ? 'danger' : 'success', context: 'Explicit blockers, not hidden retries' })}
        </div>
        ${list.length ? `<section class="card"><div class="card-header"><div class="card-title">${icon('folder')} All projects</div><span class="tiny muted">${num(list.length)} persisted</span></div><div class="card-body"><div class="table-wrap"><table class="table">
          <thead><tr><th>Project</th><th>Status</th><th>Phase</th><th>Progress</th><th>Origin</th><th>Priority</th><th>Actions</th></tr></thead>
          <tbody>${list.map((p) => `<tr>
            <td><div class="strong">${esc(p.name)}</div><div class="tiny muted mono">${esc(p.id)}</div><div class="tiny">${esc(p.schematicId)} · ${esc(p.tier)}</div></td>
            <td>${badge(p.status, statusTone(p.status), { dot: true })}${p.active ? badge('ACTIVE', 'accent') : ''}</td>
            <td class="mono tiny">${esc(p.phase)}</td>
            <td style="min-width:130px">${progress(p.progress || 0, 100, { sm: true })}</td>
            <td class="mono tiny">${originText(p.origin)}</td>
            <td class="mono">${num(p.priority)}</td>
            <td><div class="row gap-1">
              ${!p.active ? `<button class="button button--sm" type="button" data-command="builder select ${esc(p.id)}">${icon('play')} Activate</button>` : `<a class="button button--sm" href="#/operations">${icon('arrow-up-right')} Open</a>`}
            </div></td>
          </tr>`).join('')}</tbody></table></div></div></section>` : `<div class="card">${emptyState('No projects yet', 'Create a project with builder create, then survey and confirm the site.', 'folder', '<button class="button button--primary" type="button" data-command-palette>Create project</button>')}</div>`}
        <section class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">${icon('plus')} Create project</div></div>
          <div class="card-body">
            <form data-project-create>
              <div class="form-grid form-grid--4">
                <div class="field"><label class="field-label" for="proj-design">Schematic</label><input class="input" id="proj-design" placeholder="0001 or shelter" required></div>
                <div class="field"><label class="field-label" for="proj-x">X</label><input class="input" id="proj-x" type="number" placeholder="auto"></div>
                <div class="field"><label class="field-label" for="proj-z">Z</label><input class="input" id="proj-z" type="number" placeholder="auto"></div>
                <div class="field"><label class="field-label" for="proj-priority">Priority</label><input class="input" id="proj-priority" type="number" value="50" min="0" max="100"></div>
              </div>
              <button class="button button--primary" type="submit" style="margin-top:10px">${icon('folder-plus')} Create project</button>
              <p class="tiny muted" style="margin:8px 0 0">Project creation is non-destructive. Site preparation and building begin only after an explicit run/advance confirmation.</p>
            </form>
          </div>
        </section>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-project-create]');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const design = form.querySelector('#proj-design').value.trim();
      const x = form.querySelector('#proj-x').value.trim();
      const z = form.querySelector('#proj-z').value.trim();
      if (!design) return;
      const origin = x !== '' && z !== '' ? ` ${x} ${z}` : '';
      const button = form.querySelector('button[type=submit]');
      setButtonLoading(button, true);
      try {
        await runCommand(`builder create ${design}${origin}`);
        form.reset();
        toast('Project created', 'ok');
      } catch (err) {
        toast(err.message || 'Could not create project', 'error');
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
};

export const siteSurveyPage = {
  title: 'Site Survey',
  render() {
    const p = active();
    const survey = p?.sitePreparation?.survey;
    const stats = survey?.stats || {};
    const candidates = p?.sitePreparation?.candidates || [];
    const map = (survey?.heightMap || []).slice(0, 80);
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Builder Operations', title: 'Site Survey', description: 'Observed blocks only. The survey never treats an unloaded chunk as empty and never invents terrain. Candidates are ranked by flatness, hazards, space, access, excavation and observed resources.', actions: `<button class="button" type="button" data-command="site survey">${icon('refresh-cw')} Re-survey</button><a class="button" href="#/site-prep">${icon('hammer')} Site preparation</a>` })}
        ${activeOrEmpty(() => `
          <div class="grid grid--stats">
            ${statCard({ label: 'Samples', value: num(survey?.samples || 0), iconName: 'grid', tone: 'info', context: survey ? `stride ${survey.sampleStride || 1}` : 'No survey' })}
            ${statCard({ label: 'Flatness', value: stats.flatness !== undefined ? `${Math.round(stats.flatness * 100)}%` : '—', iconName: 'align-horizontal', tone: stats.flatness > 0.8 ? 'success' : stats.flatness ? 'warning' : 'neutral', context: stats.range !== undefined ? `height range ${stats.range}` : 'Not measured' })}
            ${statCard({ label: 'Liquids', value: num((stats.water || 0) + (stats.lava || 0)), iconName: 'droplet', tone: stats.lava ? 'danger' : stats.water ? 'warning' : 'success', context: 'Observed in sampled columns' })}
            ${statCard({ label: 'Caves', value: num(stats.caves || 0), iconName: 'mountain', tone: stats.caves ? 'warning' : 'success', context: 'Void below sampled surfaces' })}
            ${statCard({ label: 'Trees / plants', value: `${num(stats.trees || 0)} / ${num(stats.vegetation || 0)}`, iconName: 'trees', tone: stats.trees ? 'warning' : 'neutral', context: 'Recovered during clearance' })}
            ${statCard({ label: 'Existing structure', value: stats.structures ? num(stats.structures) : 'none', iconName: 'home', tone: stats.structures ? 'danger' : 'success', context: 'Protected from clearing' })}
            ${statCard({ label: 'Nearby ores', value: num(stats.nearbyOres || 0), iconName: 'gem', tone: stats.nearbyOres ? 'accent' : 'neutral', context: 'Observed, never cleared as junk' })}
            ${statCard({ label: 'Selected score', value: p.sitePreparation.selected?.score ?? '—', iconName: 'award', tone: 'info', context: p.sitePreparation.selected?.id || 'Not selected' })}
          </div>
          <div class="grid grid--main-side" style="margin-top:16px">
            <section class="card">
              <div class="card-header"><div class="card-title">${icon('map')} Candidate sites</div><span class="tiny muted">${candidates.length} candidate(s)</span></div>
              <div class="card-body">
                ${candidates.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Origin</th><th>Score</th><th>Factors</th><th>Notes</th><th>Action</th></tr></thead><tbody>${candidates.map((candidate) => `<tr>
                  <td class="mono">${esc(candidate.id)}</td>
                  <td class="mono tiny">${originText(candidate.origin)}</td>
                  <td><span class="strong">${num(candidate.score)}</span>/100</td>
                  <td class="tiny">${Object.entries(candidate.factors || {}).map(([key, value]) => `${esc(key)} ${num(value)}`).join(' · ')}</td>
                  <td class="tiny">${(candidate.reasons || []).length ? esc(candidate.reasons.join('; ')) : 'No observed blockers'}${(candidate.overlaps || []).length ? ` · overlaps ${esc(candidate.overlaps.join(', '))}` : ''}</td>
                  <td>${candidate.id === p.sitePreparation.selected?.id ? badge('SELECTED', 'ok') : `<button class="button button--sm" type="button" data-command="site select ${esc(candidate.id)}" data-danger="true" data-confirm-title="Select site" data-confirm-message="Commit to ${esc(candidate.id)} at ${originText(candidate.origin)}?">${icon('map-pin')} Select</button>`}</td>
                </tr>`).join('')}</tbody></table></div>` : emptyState('No candidates', 'Run the survey to rank real candidate footprints.', 'map')}
              </div>
            </section>
            <aside class="stack gap-4">
              <section class="card"><div class="card-header"><div class="card-title">${icon('info')} Observed terrain</div></div><div class="card-body">${kvRows([
                ['Origin', originText(survey?.origin), true],
                ['Footprint', survey?.footprint ? `${survey.footprint.width}×${survey.footprint.length}` : '—'],
                ['Average height', stats.average ?? '—'],
                ['Std deviation', stats.stddev ?? '—'],
                ['Estimated excavation', num(stats.estimatedExcavationBlocks || 0)],
                ['Water / lava', `${num(stats.water || 0)} / ${num(stats.lava || 0)}`],
                ['Structure ratio', stats.structureRatio !== undefined ? `${Math.round(stats.structureRatio * 100)}%` : '—'],
                ['Surveyed', survey?.surveyedAt ? new Date(survey.surveyedAt).toLocaleString() : '—']
              ])}</div></section>
              <section class="card"><div class="card-header"><div class="card-title">${icon('alert')} Hazards</div></div><div class="card-body">${Object.entries(survey?.hazards || {}).map(([key, value]) => `<div class="row" style="justify-content:space-between"><span class="tiny">${esc(humanize(key))}</span>${badge(value ? 'OBSERVED' : 'CLEAR', value ? 'warn' : 'ok')}</div>`).join('') || '<p class="tiny muted">No survey data.</p>'}</div></section>
            </aside>
          </div>
          <section class="card" style="margin-top:16px">
            <div class="card-header"><div class="card-title">${icon('grid')} Height map sample</div><span class="tiny muted">first ${map.length} sampled columns</span></div>
            <div class="card-body"><div class="table-wrap"><table class="table table--compact"><thead><tr><th>X</th><th>Z</th><th>Surface</th><th>Top block</th><th>Desired</th><th>Action</th><th>Notes</th></tr></thead><tbody>${map.length ? map.map((column) => `<tr><td class="mono">${column.x}</td><td class="mono">${column.z}</td><td class="mono">${column.surface}</td><td>${esc(column.top)}</td><td class="mono">${p.origin.y - 1}</td><td>${badge(column.surface > p.origin.y - 1 ? 'CUT' : column.surface < p.origin.y - 1 ? 'FILL' : 'KEEP', column.surface === p.origin.y - 1 ? 'ok' : 'warn')}</td><td class="tiny">${column.tree ? 'tree' : ''}${column.vegetation ? ' vegetation' : ''}${column.cave ? ' cave' : ''}${column.structure ? ' structure' : ''}${column.liquid ? ` ${column.liquid}` : ''}</td></tr>`).join('') : '<tr><td colspan="7">No height map yet.</td></tr>'}</tbody></table></div></div>
          </section>`)}
      </div>`;
  }
};

export const sitePreparationPage = {
  title: 'Site Preparation',
  render() {
    const p = active();
    const prep = p?.sitePreparation || {};
    const phases = (p?.buildPhases || []).filter((phase) => ['CLEARANCE', 'EXCAVATION', 'LEVELLING', 'DRAINAGE', 'LIGHTING', 'PERIMETER', 'TEMPORARY_STORAGE'].includes(phase.id));
    const boundaries = prep.boundaries || {};
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Builder Operations', title: 'Site Preparation', description: 'Clearance, excavation, cut-and-fill levelling, drainage, spawn-proofing, perimeter security and temporary storage. Every destructive action needs preview and confirmation.', actions: `<a class="button" href="#/site-survey">${icon('map')} Survey</a><button class="button" type="button" data-command="site preview">${icon('eye')} Preview</button>` })}
        ${activeOrEmpty(() => `
          <div class="grid grid--stats">
            ${statCard({ label: 'Clearance', value: num(prep.clearance?.actions || 0), iconName: 'trees', tone: 'info', context: `${Object.keys(prep.clearance?.recovered || {}).length} recovered item types` })}
            ${statCard({ label: 'Excavated', value: num(prep.excavation?.actions || 0), iconName: 'shovel', tone: 'accent', context: `${prep.excavation?.preserved || 0} valuable blocks preserved` })}
            ${statCard({ label: 'Levelled', value: num(prep.levelling?.actions || 0), iconName: 'align-horizontal', tone: 'info', context: `target y ${prep.levelling?.targetY ?? p.origin.y - 1}` })}
            ${statCard({ label: 'Drained', value: num(prep.drainage?.drained || 0), iconName: 'droplet', tone: prep.drainage?.drained ? 'accent' : 'neutral', context: 'Liquid hazards are stopped, never hidden' })}
            ${statCard({ label: 'Lights', value: num(prep.lighting?.placements || 0), iconName: 'sun', tone: prep.lighting?.coverage >= 1 ? 'success' : prep.lighting ? 'warning' : 'neutral', context: prep.lighting ? `${Math.round((prep.lighting.coverage || 0) * 100)}% coverage` : 'Not planned' })}
            ${statCard({ label: 'Perimeter', value: num(prep.perimeter?.placed || 0), iconName: 'shield', tone: prep.perimeter ? 'success' : 'neutral', context: prep.perimeter?.gate ? `gate ${prep.perimeter.gate.x},${prep.perimeter.gate.z}` : 'No fence yet' })}
            ${statCard({ label: 'Staging', value: prep.storage ? 'READY' : '—', iconName: 'archive', tone: prep.storage ? 'success' : 'neutral', context: prep.storage?.container || 'No container' })}
            ${statCard({ label: 'Boundaries', value: num(Object.keys(boundaries).length), iconName: 'maximize', tone: boundaries.main ? 'info' : 'neutral', context: boundaries.main ? `main ${boundaries.main.min.x},${boundaries.main.min.z} → ${boundaries.main.max.x},${boundaries.main.max.z}` : 'Not surveyed' })}
          </div>
          <section class="card" style="margin-top:16px">
            <div class="card-header"><div class="card-title">${icon('git-branch')} Preparation phases</div><span class="tiny muted">confirm every world-changing step</span></div>
            <div class="card-body">
              <div class="table-wrap"><table class="table"><thead><tr><th>Phase</th><th>Status</th><th>Attempts</th><th>Detail</th><th>Actions</th></tr></thead><tbody>${phases.map((phase) => `<tr>
                <td><span class="mono">${esc(phase.id)}</span><div class="tiny muted">${esc(phase.name)}</div></td>
                <td>${badge(phase.status, phaseTone(phase.status), { dot: true })}</td>
                <td class="mono">${num(phase.attempts)}</td>
                <td class="tiny">${esc(typeof phase.detail === 'string' ? phase.detail : phase.detail ? JSON.stringify(phase.detail).slice(0, 120) : '—')}</td>
                <td>${phase.id === 'CLEARANCE' ? `<button class="button button--sm" type="button" data-command="site clear" data-danger="true" data-confirm-title="Clear site" data-confirm-message="Clear trees and vegetation inside ${boundaries.clearance ? originText(boundaries.clearance.min) : 'the site'}? Valuable blocks and structures are preserved.">${icon('trees')} Clear</button>` : ''}${phase.id === 'EXCAVATION' ? `<button class="button button--sm" type="button" data-command="site excavate" data-danger="true" data-confirm-title="Excavate foundation" data-confirm-message="Excavate the authorised foundation footprint? Ores are preserved and work stops on hazards.">${icon('shovel')} Excavate</button>` : ''}${phase.id === 'LEVELLING' ? `<button class="button button--sm" type="button" data-command="site flatten" data-danger="true" data-confirm-title="Level footprint" data-confirm-message="Cut and fill the foundation footprint to the target level?">${icon('align-horizontal')} Level</button>` : ''}${phase.id === 'DRAINAGE' ? `<button class="button button--sm" type="button" data-command="site drain" data-danger="true" data-confirm-title="Drain foundation" data-confirm-message="Displace safe standing water with solid fill? Lava is refused.">${icon('droplet')} Drain</button>` : ''}${phase.id === 'LIGHTING' ? `<button class="button button--sm" type="button" data-command="site light" data-danger="true" data-confirm-title="Light site" data-confirm-message="Place real light blocks on observed spawnable surfaces?">${icon('sun')} Light</button>` : ''}${phase.id === 'PERIMETER' ? `<button class="button button--sm" type="button" data-command="site secure" data-danger="true" data-confirm-title="Build perimeter" data-confirm-message="Build a fenced perimeter with a gate?">${icon('shield')} Secure</button>` : ''}</td>
              </tr>`).join('')}</tbody></table></div>
              <div class="row gap-2" style="margin-top:12px">
                ${gate('Clear preview', 'site preview', 'Preview clearance only; no blocks are changed.')}
                <a class="button button--sm" href="#/lighting">${icon('sun')} Lighting</a>
                <a class="button button--sm" href="#/warehouse">${icon('archive')} Storage</a>
              </div>
            </div>
          </section>
          <section class="card" style="margin-top:16px">
            <div class="card-header"><div class="card-title">${icon('maximize')} Boundaries</div><span class="tiny muted">authorised footprint only</span></div>
            <div class="card-body"><div class="table-wrap"><table class="table table--compact"><thead><tr><th>Boundary</th><th>Min</th><th>Max</th><th>Purpose</th></tr></thead><tbody>${Object.entries(boundaries).map(([name, box]) => `<tr><td class="mono">${esc(name)}</td><td class="mono tiny">${box.min ? originText(box.min) : '—'}</td><td class="mono tiny">${box.max ? originText(box.max) : '—'}</td><td class="tiny">${esc(name === 'main' ? 'Building footprint' : name === 'foundation' ? 'Structural foundation' : name === 'clearance' ? 'Clearance and recovery' : name === 'work' ? 'Work zone and temporary lighting' : name === 'staging' ? 'Temporary staging' : name === 'storage' ? 'Warehouse / chests' : name === 'security' ? 'Lighting and patrol boundary' : name === 'authorized' ? 'Hard authorisation limit' : name)}</td></tr>`).join('') || '<tr><td colspan="4">No boundaries calculated.</td></tr>'}</tbody></table></div></div>
          </section>`)}
      </div>`;
  }
};

export const lightingPage = {
  title: 'Lighting & Spawn-proofing',
  render() {
    const p = active();
    const lighting = p?.sitePreparation?.lighting;
    const plan = p?.lightingPlan;
    const audit = lighting?.audit;
    const uncovered = (audit?.uncovered || []).slice(0, 30);
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Builder Operations', title: 'Lighting & Spawn-proofing', description: 'Real block-light emission values and conservative coverage. Modern Java hostile spawns generally need block light 0; spawners, raids, patrols and special mob rules are explicitly out of scope.', actions: `<button class="button" type="button" data-command="site preview light">${icon('eye')} Preview plan</button><button class="button button--primary" type="button" data-command="site light" data-danger="true" data-confirm-title="Place lights" data-confirm-message="Place real light blocks on observed spawnable surfaces outside the foundation?">${icon('sun')} Execute lighting</button>` })}
        ${activeOrEmpty(() => `
          <div class="grid grid--stats">
            ${statCard({ label: 'Surfaces', value: num(lighting?.surfaces || audit?.surfaces || 0), iconName: 'grid', tone: 'info', context: 'Observed spawnable surfaces' })}
            ${statCard({ label: 'Placements', value: num(lighting?.placements || 0), iconName: 'sun', tone: 'accent', context: plan?.source ? `source ${plan.source}` : 'No source selected' })}
            ${statCard({ label: 'Coverage', value: lighting ? `${Math.round((lighting.coverage || 0) * 100)}%` : '—', iconName: 'shield-check', tone: lighting?.coverage >= 1 ? 'success' : lighting ? 'warning' : 'neutral', context: 'Conservative line-of-sight coverage' })}
            ${statCard({ label: 'Uncovered', value: num(uncovered.length), iconName: 'alert', tone: uncovered.length ? 'warning' : 'success', context: 'Shown for inspection' })}
            ${statCard({ label: 'Failed', value: num(lighting?.failed || 0), iconName: 'x-circle', tone: lighting?.failed ? 'danger' : 'success', context: 'Placement failures are never hidden' })}
            ${statCard({ label: 'Lights reserved', value: num(plan?.placements?.length || 0), iconName: 'package', tone: 'neutral', context: 'Build-palette lights stay reserved' })}
          </div>
          <div class="grid grid--main-side" style="margin-top:16px">
            <section class="card"><div class="card-header"><div class="card-title">${icon('sun')} Light plan</div>${plan?.source ? badge(plan.source.toUpperCase(), 'accent') : ''}</div><div class="card-body">
              ${plan ? kvRows([
                ['Source', esc(plan.source || '—')],
                ['Available sources', Object.entries(plan.availableSources || {}).map(([item, count]) => `${esc(item)} ${num(count)}`).join(', ') || 'none'],
                ['Planned', num(plan.placements?.length || 0)],
                ['Uncovered in plan', num(plan.uncovered?.length || 0)],
                ['Coverage', `${Math.round((plan.coverage || 0) * 100)}%`],
                ['Note', esc(plan.note || '—')]
              ]) : '<p class="tiny muted">No lighting plan yet. Preview calculates observed surfaces and uses real inventory.</p>'}
            </div></section>
            <aside class="stack gap-4"><section class="card"><div class="card-header"><div class="card-title">${icon('shield')} Spawn rules</div></div><div class="card-body">
              <div class="callout callout--info">${icon('info')}<div>Ordinary Overworld hostiles: block light 0 on spawnable surfaces. This engine does not claim that lighting stops spawners, raids, patrols or special mobs.</div></div>
              ${kvRows([
                ['Surface rule', 'solid top + 2 air blocks'],
                ['Torch', '14'],
                ['Lantern', '15'],
                ['Glowstone / shroomlight / sea lantern', '15'],
                ['Soul torch / soul lantern', '10'],
                ['Spawners, raids, patrols', 'not light-controlled']
              ])}
            </div></section></aside>
          </div>
          <section class="card" style="margin-top:16px"><div class="card-header"><div class="card-title">${icon('alert')} Uncovered surfaces</div><span class="tiny muted">${uncovered.length} shown</span></div><div class="card-body">${uncovered.length ? `<div class="table-wrap"><table class="table table--compact"><thead><tr><th>X</th><th>Y</th><th>Z</th><th>Top block</th><th>Zone</th></tr></thead><tbody>${uncovered.map((surface) => `<tr><td class="mono">${surface.x}</td><td class="mono">${surface.y}</td><td class="mono">${surface.z}</td><td>${esc(surface.top || '—')}</td><td class="tiny">${surface.underground ? 'underground' : 'surface'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="callout callout--ok">${icon('check-circle')}<div>No uncovered surfaces in the last audit.</div></div>`}</div></section>`)}
      </div>`;
  }
};

export const materialPlanningPage = {
  title: 'Material Planning',
  render() {
    const p = active();
    const plan = p?.materialPlan;
    const req = plan?.requirements || {};
    const requirementRows = Object.entries(req).slice(0, 100);
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Builder Operations', title: 'Material Planning', description: 'A real BOM from the schematic palette, compared with bot inventories and verified warehouse counts. Acquisition routes are deterministic local actions, and structural substitution is refused without validation.', actions: `<button class="button" type="button" data-command="materials calculate">${icon('refresh-cw')} Recalculate</button><button class="button" type="button" data-command="materials reserve">${icon('lock')} Reserve</button><button class="button button--primary" type="button" data-command="materials gather" data-danger="true" data-confirm-title="Gather materials" data-confirm-message="Run local resource collection for the current deficit? Real blocks will be mined or chopped.">${icon('pickaxe')} Gather deficit</button>` })}
        ${activeOrEmpty(() => `
          <div class="grid grid--stats">
            ${statCard({ label: 'Required', value: num(plan?.totalNeeded || 0), iconName: 'package', tone: 'info', context: `${requirementRows.length} item types` })}
            ${statCard({ label: 'Covered', value: num(plan?.totalAvailable || 0), iconName: 'check-circle', tone: 'success', context: 'Inventory + verified storage' })}
            ${statCard({ label: 'Deficit', value: num(Object.keys(plan?.deficit || {}).length), iconName: 'alert', tone: Object.keys(plan?.deficit || {}).length ? 'warning' : 'success', context: plan?.ready ? 'Ready to build' : 'Not ready' })}
            ${statCard({ label: 'Acquisition tasks', value: num(plan?.acquisitionPlan?.length || 0), iconName: 'list', tone: 'accent', context: 'Mine, chop, craft or retrieve' })}
            ${statCard({ label: 'Warehouse slots', value: `${num(p?.warehouse?.capacity?.usedSlots || 0)}/${num(p?.warehouse?.capacity?.capacitySlots || 0)}`, iconName: 'archive', tone: 'neutral', context: `${num(p?.warehouse?.capacity?.containers || 0)} containers` })}
          </div>
          <div class="grid grid--main-side" style="margin-top:16px">
            <section class="card"><div class="card-header"><div class="card-title">${icon('package')} Bill of materials</div>${plan?.ready ? badge('READY', 'ok', { dot: true }) : badge('DEFICIT', 'warn', { dot: true })}</div><div class="card-body"><div class="table-wrap"><table class="table table--compact"><thead><tr><th>Item</th><th>Category</th><th>Needed</th><th>Have</th><th>Deficit</th><th>Status</th></tr></thead><tbody>${requirementRows.length ? requirementRows.map(([item, row]) => `<tr><td class="mono">${esc(item)}</td><td class="tiny">${esc(row.category)}</td><td class="mono">${num(row.needed)}</td><td class="mono">${num(row.have)}</td><td class="mono" style="color:${row.deficit ? 'var(--danger)' : 'inherit'}">${num(row.deficit)}</td><td>${row.ready ? badge('READY', 'ok') : badge('SHORT', 'warn')}</td></tr>`).join('') : '<tr><td colspan="6">No BOM calculated.</td></tr>'}</tbody></table></div></div></section>
            <aside class="stack gap-4"><section class="card"><div class="card-header"><div class="card-title">${icon('list')} Acquisition plan</div></div><div class="card-body">${(plan?.acquisitionPlan || []).length ? (plan.acquisitionPlan || []).slice(0, 12).map((entry) => `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div class="row" style="justify-content:space-between"><span class="mono">${esc(entry.item)}</span><span>${num(entry.missing)}</span></div><div class="tiny muted">${(entry.options || []).map((option) => `${esc(option.type)}${option.block ? ` ${esc(option.block)}` : ''}`).join(' · ')}</div></div>`).join('') : '<p class="tiny muted">No deficit.</p>'}</div></section>
            <section class="card"><div class="card-header"><div class="card-title">${icon('info')} Safe substitution</div></div><div class="card-body"><div class="callout callout--warn">${icon('alert')}<div>Redstone, utility, shape-specific and structural palette blocks are never substituted automatically. Only validated same-role full blocks may be swapped.</div></div><button class="button button--sm" type="button" data-command="materials readiness">${icon('layers')} Phase readiness</button></div></section></aside>
          </div>`)}
      </div>`;
  }
};

export const warehousePage = {
  title: 'Warehouse & Storage',
  render() {
    const c = construction();
    const warehouse = c.warehouse || { containers: [], capacity: {} };
    const containers = warehouse.containers || [];
    const categories = Object.entries(warehouse.capacity?.categories || {});
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Builder Operations', title: 'Storage', description: 'Categorised chest groups, capacity, locks and verified physical deposits/withdrawals. Counts come from opening real containers; shared inventory is never faked.', actions: `<button class="button" type="button" data-command="storage scan">${icon('search')} Scan</button><button class="button" type="button" data-command="storage organise" data-danger="true" data-confirm-title="Organise warehouse" data-confirm-message="Deposit bot inventories into categorised warehouse chests? Every transfer is verified.">${icon('archive')} Organise</button><a class="button" href="#/material-plan">${icon('package')} Materials</a>` })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Containers', value: num(warehouse.capacity?.containers || 0), iconName: 'archive', tone: containers.length ? 'success' : 'neutral', context: containers.length ? containers.map((entry) => entry.category).join(', ') : 'No container scanned' })}
          ${statCard({ label: 'Items', value: num(warehouse.capacity?.items || 0), iconName: 'package', tone: 'info', context: 'Total observed container items' })}
          ${statCard({ label: 'Used slots', value: `${num(warehouse.capacity?.usedSlots || 0)}/${num(warehouse.capacity?.capacitySlots || 0)}`, iconName: 'grid', tone: 'accent', context: 'Stack-name estimate, not contents slots' })}
          ${statCard({ label: 'Locks', value: num((warehouse.locks || []).length), iconName: 'lock', tone: (warehouse.locks || []).length ? 'warning' : 'success', context: 'Cooperative construction locks' })}
          ${statCard({ label: 'Chests placed', value: num(warehouse.stats?.chestsPlaced || 0), iconName: 'hammer', tone: 'neutral', context: 'Verified placements' })}
          ${statCard({ label: 'Deposits / withdrawals', value: `${num(warehouse.stats?.deposits || 0)} / ${num(warehouse.stats?.withdrawals || 0)}`, iconName: 'refresh-cw', tone: 'info', context: `${num(warehouse.stats?.failed || 0)} failed` })}
        </div>
        <div class="grid grid--main-side" style="margin-top:16px">
          <section class="card"><div class="card-header"><div class="card-title">${icon('archive')} Containers</div><span class="tiny muted">${containers.length} observed</span></div><div class="card-body">${containers.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Category</th><th>Position</th><th>Items</th><th>Capacity</th><th>Lock</th></tr></thead><tbody>${containers.map((entry) => `<tr><td><div class="mono tiny">${esc(entry.id)}</div><div class="tiny">${esc(entry.name)}</div></td><td>${badge(entry.category, 'accent')}</td><td class="mono tiny">${originText(entry.position)}</td><td class="tiny">${Object.entries(entry.items || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([item, count]) => `${esc(item)} ×${count}`).join('<br>') || 'empty'}</td><td class="mono">${entry.slotsUsed}/${entry.capacity}</td><td>${entry.locked ? badge('LOCKED', 'warn') : badge('OPEN', 'ok')}</td></tr>`).join('')}</tbody></table></div>` : emptyState('No containers observed', 'Scan the warehouse or let the pipeline place a staging chest.', 'archive', '<button class="button" type="button" data-command="storage scan">Scan storage</button>')}</div></section>
          <aside class="stack gap-4"><section class="card"><div class="card-header"><div class="card-title">${icon('layers')} Categories</div></div><div class="card-body"><div class="table-wrap"><table class="table table--compact"><thead><tr><th>Group</th><th>Chests</th><th>Items</th></tr></thead><tbody>${categories.length ? categories.map(([category, row]) => `<tr><td class="mono">${esc(category)}</td><td>${num(row.containers)}</td><td>${num(row.items)}</td></tr>`).join('') : '<tr><td colspan="3">No category data.</td></tr>'}</tbody></table></div></div></section>
          <section class="card"><div class="card-header"><div class="card-title">${icon('lock')} Locks</div></div><div class="card-body">${(warehouse.locks || []).length ? (warehouse.locks || []).map((lock) => `<div class="row" style="justify-content:space-between"><span class="mono tiny">${esc(lock.id)}</span>${badge(esc(lock.owner), 'warn')}</div>`).join('') : '<p class="tiny muted">No cooperative container lock is held.</p>'}</div></section></aside>
        </div>
      </div>`;
  }
};

export const crewAssignmentsPage = {
  title: 'Team Assignments',
  render() {
    const p = active();
    const team = state.snapshot?.team?.state || {};
    const roles = Object.fromEntries(Object.entries(team.roles || {}));
    const occupants = p?.teamAssignments || {};
    const bots = state.snapshot?.bots || [];
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Builder Operations', title: 'Team Assignments', description: 'Initial specialist roles plus dynamic task-board allocation. A bot can change role; assignments are persisted with the active project and exposed to the coordinator.', actions: `<button class="button" type="button" data-command="team assignments">${icon('refresh-cw')} Refresh</button><a class="button" href="#/team">${icon('users')} Team</a>` })}
        <div class="grid grid--stats">
          ${statCard({ label: 'Crew', value: num(bots.length), iconName: 'users', tone: bots.length === 5 ? 'success' : 'warning', context: bots.map((bot) => bot.name).join(', ') })}
          ${statCard({ label: 'Assigned roles', value: num(Object.keys(occupants).length), iconName: 'badge', tone: 'info', context: 'Project-level roles' })}
          ${statCard({ label: 'Coordinator roles', value: num(Object.keys(roles).length), iconName: 'crown', tone: 'accent', context: 'Live allocation state' })}
          ${statCard({ label: 'Active project', value: p ? p.summary.status : 'IDLE', iconName: 'activity', tone: p ? statusTone(p.summary.status) : 'neutral', context: p?.summary.name || 'None' })}
        </div>
        <section class="card" style="margin-top:16px"><div class="card-header"><div class="card-title">${icon('users')} Project crew</div><span class="tiny muted">${p ? esc(p.summary.id) : 'no project'}</span></div><div class="card-body"><div class="table-wrap"><table class="table"><thead><tr><th>Bot</th><th>Role</th><th>Phase focus</th><th>Coordinator role</th><th>Task</th><th>Status</th></tr></thead><tbody>${bots.map((bot) => {
          const entry = occupants[bot.name];
          const role = entry ? (typeof entry === 'string' ? entry : entry.role) : '—';
          const assignment = team.assignments ? team.assignments[bot.name] : null;
          const status = botStatus(bot);
          return `<tr><td class="mono"><a class="link" href="#/bots/${encodeURIComponent(bot.name)}">${esc(bot.name)}</a></td><td>${badge(role || '—', role && role !== '—' ? 'accent' : 'neutral')}</td><td class="tiny">${esc(entry?.phase || 'all phases')}</td><td class="tiny">${esc(roles[bot.name] || '—')}</td><td class="mono tiny">${esc(assignment?.taskId || '—')}</td><td>${badge(status.label.toUpperCase(), status.tone, { dot: true })}</td></tr>`;
        }).join('')}</tbody></table></div></div></section>
        <section class="card" style="margin-top:16px"><div class="card-header"><div class="card-title">${icon('badge')} Assign a bot</div></div><div class="card-body"><form data-crew-assign><div class="form-grid form-grid--3"><div class="field"><label class="field-label" for="crew-bot">Bot</label><select class="select" id="crew-bot">${bots.map((bot) => `<option value="${esc(bot.name)}">${esc(bot.name)}</option>`).join('')}</select></div><div class="field"><label class="field-label" for="crew-role">Role</label><input class="input" id="crew-role" placeholder="e.g. ROOF_SPECIALIST" required></div><div class="field"><label class="field-label" for="crew-phase">Phase focus</label><input class="input" id="crew-phase" placeholder="optional pipeline phase"></div></div><button class="button button--primary" type="submit" style="margin-top:10px">${icon('user-plus')} Assign</button></form></div></section>
      </div>`;
  },
  mount(root) {
    const form = root.querySelector('[data-crew-assign]');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const bot = form.querySelector('#crew-bot').value;
      const role = form.querySelector('#crew-role').value.trim().replace(/\s+/g, '_');
      if (!bot || !role) return;
      try {
        await runCommand(`builder assign ${bot} ${role}`);
        toast('Assignment saved', 'ok');
        form.reset();
      } catch (err) { toast(err.message || 'Assignment failed', 'error'); }
    });
  }
};

export const qualityPage = {
  title: 'Quality & Security',
  render() {
    const p = active();
    const quality = p?.quality;
    const verification = quality?.verification;
    const structural = quality?.structural;
    const security = p?.security;
    const audit = security?.lighting;
    return `
      <div class="page">
        ${pageHeader({ eyebrow: 'Builder Operations', title: 'QA & Security', description: 'Post-placement world verification, palette and dimension checks, lighting audit and hostile observations. A completed builder task is only accepted after re-reading the world.', actions: `<button class="button" type="button" data-command="build verify">${icon('check-circle')} Verify</button><button class="button button--danger-ghost" type="button" data-command="build repair" data-danger="true" data-confirm-title="Repair build" data-confirm-message="Run remaining builder tasks and verify placement?">${icon('wrench')} Repair</button><button class="button button--primary" type="button" data-command="build finish" data-danger="true" data-confirm-title="Finish project" data-confirm-message="Run quality verification and cleanup/handover?">${icon('flag')} Finish</button>` })}
        ${activeOrEmpty(() => `
          <div class="grid grid--stats">
            ${statCard({ label: 'Verification', value: verification?.complete ? 'PASS' : verification ? 'INCOMPLETE' : '—', iconName: 'check-circle', tone: verification?.complete ? 'success' : verification ? 'danger' : 'neutral', context: verification ? `${verification.placed}/${verification.total} blocks` : 'Not run' })}
            ${statCard({ label: 'Missing', value: num(verification?.missingCount ?? 0), iconName: 'alert', tone: verification?.missingCount ? 'danger' : 'success', context: 'Blocks re-read from the world' })}
            ${statCard({ label: 'Wrong block', value: num(verification?.wrongCount ?? 0), iconName: 'x-circle', tone: verification?.wrongCount ? 'danger' : 'success', context: 'Present but not the expected palette' })}
            ${statCard({ label: 'Structural QA', value: structural?.ok ? 'PASS' : structural ? 'CHECK' : '—', iconName: 'layers', tone: structural?.ok ? 'success' : structural ? 'warning' : 'neutral', context: structural ? `palette ${structural.checks?.palette ? 'ok' : 'mismatch'}` : 'Not run' })}
            ${statCard({ label: 'Light coverage', value: audit ? `${Math.round((audit.coverage || 0) * 100)}%` : '—', iconName: 'sun', tone: audit?.coverage >= 1 ? 'success' : audit ? 'warning' : 'neutral', context: audit ? `${audit.surfaces} surfaces audited` : 'Not audited' })}
            ${statCard({ label: 'Hostiles', value: num(security?.hostile?.count || 0), iconName: 'sword', tone: security?.hostile?.creeper ? 'danger' : security?.hostile?.count ? 'warning' : 'success', context: security?.hostile?.creeper ? 'Creeper observed' : 'Observed near site' })}
          </div>
          <div class="grid grid--main-side" style="margin-top:16px">
            <section class="card"><div class="card-header"><div class="card-title">${icon('layers')} Quality report</div>${verification?.complete ? badge('VERIFIED', 'ok', { dot: true }) : badge('UNVERIFIED', 'warn')}</div><div class="card-body">
              ${verification ? kvRows([
                ['Build ID', esc(verification.buildId), true],
                ['Total blocks', num(verification.total)],
                ['Placed correctly', num(verification.placed)],
                ['Percent complete', `${verification.percentComplete}%`],
                ['Missing', num(verification.missingCount)],
                ['Wrong', num(verification.wrongCount)],
                ['Checked', quality?.checkedAt ? new Date(quality.checkedAt).toLocaleString() : '—']
              ]) : '<p class="tiny muted">No verification yet.</p>'}
              ${structural ? `<div class="divider"></div>${kvRows([
                ['Dimensions', `${structural.dimensions?.width}×${structural.dimensions?.length}×${structural.dimensions?.height}`],
                ['Palette check', structural.checks?.palette ? 'pass' : 'mismatch'],
                ['Alignment check', structural.checks?.alignment ? 'pass' : 'missing blocks'],
                ['Wrong palette blocks', (structural.wrongPalette || []).map((entry) => `${entry.name} ×${entry.count}`).join(', ') || 'none'],
                ['Roof / symmetry / doors / stairs', 'reported from schematic phase completion, not guessed']
              ])}` : ''}
            </div></section>
            <aside class="stack gap-4">
              <section class="card"><div class="card-header"><div class="card-title">${icon('shield')} Security audit</div></div><div class="card-body">${audit ? kvRows([
                ['Surfaces', num(audit.surfaces)],
                ['Covered', num(audit.covered)],
                ['Uncovered', num(audit.uncovered?.length || 0)],
                ['Coverage', `${Math.round((audit.coverage || 0) * 100)}%`],
                ['Perimeter posts', num(p.sitePreparation?.perimeter?.placed || 0)],
                ['Gate', p.sitePreparation?.perimeter?.gate ? originText(p.sitePreparation.perimeter.gate) : '—'],
                ['Hostiles', JSON.stringify(security?.hostile?.counts || {})],
                ['Creeper protocol', security?.hostile?.creeper ? 'ACTIVE' : 'clear']
              ]) : '<p class="tiny muted">No security audit yet.</p>'}<div class="callout callout--info" style="margin-top:10px">${icon('info')}<div>${esc(security?.hostile?.note || 'Lighting does not stop spawners, raids, patrols or special mob rules.')}</div></div></div></section>
              <section class="card"><div class="card-header"><div class="card-title">${icon('alert')} Blocking issues</div></div><div class="card-body">${p.summary.blockedReason ? `<div class="callout callout--warn">${icon('alert')}<div>${esc(p.summary.blockedReason)}</div></div>` : '<div class="callout callout--ok">No current blocker.</div>'}</div></section>
            </aside>
          </div>`)}
      </div>`;
  }
};
