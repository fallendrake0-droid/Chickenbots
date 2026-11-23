#!/usr/bin/env node
'use strict';

/**
 * Deployment sanity check. Fast, read-only and safe to run before commissioning:
 * verifies the frozen roster/config, V5 construction surface, dashboard assets
 * and browser-safe URLs. Pass --url to also probe a running dashboard over HTTP.
 *
 *   node scripts/deploy-check.js
 *   node scripts/deploy-check.js --url http://127.0.0.1:3000
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const baseUrl = urlIndex >= 0 ? args[urlIndex + 1] : null;

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || '' });
    process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (err) {
    results.push({ ok: false, name, detail: err.message });
    process.stdout.write(`FAIL ${name} — ${err.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relative) {
  const full = path.join(ROOT, relative);
  assert(fs.existsSync(full), `${relative} is missing`);
  return fs.readFileSync(full, 'utf8');
}

function requireLocal(relative) {
  return require(path.join(ROOT, relative));
}

async function main() {
  process.stdout.write(`Chickenbots deployment check${baseUrl ? ` (live: ${baseUrl})` : ''}\n\n`);

  check('Node runtime is supported', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    assert(major > 18 || (major === 18 && minor >= 17), `Node ${process.versions.node} is older than 18.17`);
    return `Node ${process.versions.node}`;
  });

  check('roster is the fixed five usernames', () => {
    const { config, BOT_NAMES } = requireLocal('src/config.js');
    const expected = ['______', '101010', '010101', '110011', '001100'];
    assert(BOT_NAMES.length === 5, `roster has ${BOT_NAMES.length} names`);
    assert(expected.every((name, index) => BOT_NAMES[index] === name), 'roster order changed');
    assert(config.team.names.every((name, index) => name === expected[index]), 'configured team names changed');
    return expected.join(', ');
  });

  check('server, PvP and AI defaults are safe', () => {
    const { config } = requireLocal('src/config.js');
    assert(config.server.host === 'cr3xlol.aternos.me', `unexpected host ${config.server.host}`);
    assert(Number(config.server.port) === 55742, `unexpected port ${config.server.port}`);
    assert(config.autonomy.pvp === false, 'PvP must stay disabled by default');
    assert(config.autonomy.ai.enabled === false, 'AI hook must stay disabled');
    return 'cr3xlol.aternos.me:55742, PvP off, AI off';
  });

  check('V5 construction modules are present', () => {
    const required = [
      'src/construction/constants.js', 'src/construction/siteSurvey.js', 'src/construction/sitePreparer.js',
      'src/construction/lighting.js', 'src/construction/materials.js', 'src/construction/storage.js',
      'src/construction/pipeline.js', 'src/construction/manager.js'
    ];
    for (const file of required) read(file);
    return `${required.length} modules`;
  });

  check('dashboard operations surface is routable', () => {
    const router = read('src/dashboard/public/js/router.js');
    const pages = read('src/dashboard/public/js/pages/operations.js');
    const routes = ['operations', 'builder-projects', 'site-survey', 'site-prep', 'lighting', 'material-plan', 'warehouse', 'crew', 'qa'];
    for (const route of routes) assert(router.includes(`'${route}'`), `route ${route} is not registered`);
    for (const page of ['operationsOverview', 'builderProjectsPage', 'siteSurveyPage', 'sitePreparationPage', 'lightingPage', 'materialPlanningPage', 'warehousePage', 'crewAssignmentsPage', 'qualityPage']) {
      assert(pages.includes(`export const ${page}`), `page export ${page} is missing`);
    }
    assert(router.includes('Builder Operations'), 'Builder Operations navigation group is missing');
    return `${routes.length} routes`;
  });

  check('browser assets do not call localhost', () => {
    const publicDir = path.join(ROOT, 'src/dashboard/public');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|css|html)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/https?:\/\/(127\.0\.0\.1|localhost)/.test(text)) offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(publicDir);
    assert(offenders.length === 0, `absolute local URLs in ${offenders.join(', ')}`);
    return 'relative URLs only';
  });

  check('package metadata is V5', () => {
    const pkg = JSON.parse(read('package.json'));
    assert(/^5\./.test(pkg.version), `version is ${pkg.version}`);
    assert(Boolean(pkg.scripts['deploy:check']), 'deploy:check script missing');
    assert(Boolean(pkg.scripts['test:construction']), 'test:construction script missing');
    return `version ${pkg.version}`;
  });

  if (baseUrl) {
    const base = baseUrl.replace(/\/$/, '');
    const probe = async (name, fn) => {
      try {
        const detail = await fn();
        results.push({ ok: true, name, detail: detail || '' });
        process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ''}\n`);
      } catch (err) {
        results.push({ ok: false, name, detail: err.message });
        process.stdout.write(`FAIL ${name} — ${err.message}\n`);
      }
    };
    const getJson = async (route) => {
      const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      assert(response.ok, `${route} returned HTTP ${response.status}`);
      return response.json();
    };

    await probe('live dashboard answers health checks', async () => {
      const health = await getJson('/healthz');
      assert(health.ok === true, 'healthz did not report ok');
      return `mode ${health.mode || 'unknown'}`;
    });

    await probe('live state exposes five bots and construction state', async () => {
      const body = await getJson('/api/state');
      assert(body.ok === true, 'state did not report ok');
      assert(Array.isArray(body.state.bots) && body.state.bots.length === 5, `got ${body.state.bots?.length} bots`);
      assert(body.state.construction, 'construction snapshot missing');
      assert(Array.isArray(body.state.construction.projects), 'construction projects missing');
      return `${body.state.bots.length} bots, ${body.state.construction.projects.length} project(s)`;
    });

    await probe('live command surface exposes V5 families', async () => {
      const body = await getJson('/api/commands');
      assert(body.ok === true, 'commands did not report ok');
      const names = new Set((body.commands || []).map((command) => command.name));
      for (const name of ['builder', 'site', 'materials', 'storage', 'build']) {
        assert(names.has(name), `${name} command family is missing`);
      }
      return `${names.size} command families`;
    });

    await probe('live dashboard serves the V5 shell', async () => {
      const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(8000) });
      assert(response.ok, `root returned HTTP ${response.status}`);
      const html = await response.text();
      assert(html.includes('id="view"'), 'dashboard shell is missing the view root');
      assert(html.includes('Chickenbots'), 'dashboard title missing');
      return `${html.length} bytes`;
    });
  }

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`deployment check crashed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
