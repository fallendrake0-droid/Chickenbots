#!/usr/bin/env node
'use strict';

/**
 * Deployment sanity check. Fast, read-only and safe to run before commissioning:
 * verifies the frozen roster/config, V6 combat and V5 construction surfaces,
 * dashboard assets and browser-safe URLs. Pass --url to also probe a running dashboard over HTTP.
 *
 *   node scripts/deploy-check.js
 *   node scripts/deploy-check.js --url http://127.0.0.1:3000
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

  check('roster is the fixed ten usernames', () => {
    const { config, BOT_NAMES } = requireLocal('src/config.js');
    const expected = ['________', '10101000', '01010100', '11001100', '00110000', '11101000', '11101010', '10001000', '11001010', '11101001'];
    assert(BOT_NAMES.length === 10, `roster has ${BOT_NAMES.length} names`);
    assert(expected.every((name, index) => BOT_NAMES[index] === name), 'roster order changed');
    assert(config.team.names.every((name, index) => name === expected[index]), 'configured team names changed');
    return expected.join(', ');
  });

  check('configuration validates without a committed credential', () => {
    const { config, validateConfig } = requireLocal('src/config.js');
    const result = validateConfig(config);
    assert(result.ok, result.errors.join('; '));
    // Runtime credentials may come from an ignored local .env. What must never
    // happen is a literal password in the tracked default configuration.
    const defaults = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
    assert(!/(?:loginPassword|registerPassword|token)\s*:\s*['"`][^'"`\s]+['"`]/.test(defaults), 'a credential literal is committed in src/config.js');
    return `${result.warnings.length} warning(s); no committed credential literal`;
  });

  check('tracked tree contains no secret-shaped value', () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-secrets.js')], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    assert(run.status === 0, (run.stderr || run.stdout || 'secret check failed').trim());
    return 'values never printed';
  });

  check('server, PvP and AI defaults are safe', () => {
    const { config } = requireLocal('src/config.js');
    assert(config.server.host === 'EmpiSMP.aternos.me', `unexpected host ${config.server.host}`);
    assert(Number(config.server.port) === 32990, `unexpected port ${config.server.port}`);
    assert(config.autonomy.pve === true, 'PvE must be enabled by default');
    assert(config.autonomy.pvp === true, 'PvP feature must be enabled by default; PvpPolicy still requires explicit targets');
    assert(config.autonomy.ai.enabled === false, 'AI hook must stay disabled');
    return 'EmpiSMP.aternos.me:32990, PvE on, explicit-target PvP, AI off';
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

  check('V6 combat modules and commands are present', () => {
    const modules = [
      'src/combat/constants.js', 'src/combat/mobs.js', 'src/combat/equipment.js', 'src/combat/supplies.js',
      'src/combat/totems.js', 'src/combat/players.js', 'src/combat/team.js', 'src/actions/combat.js'
    ];
    for (const file of modules) read(file);
    const commands = read('src/commands/index.js');
    const families = ['combat', 'pve', 'pvp', 'target', 'follow', 'gear', 'totem', 'food', 'potions', 'guard', 'duel', 'arena'];
    for (const family of families) assert(commands.includes(`name: '${family}'`), `${family} command is missing`);
    for (const auto of ['weapon', 'totem', 'potions', 'food']) assert(commands.includes(`'${auto}'`), `auto ${auto} is missing`);
    return `${modules.length} modules, ${families.length} command families`;
  });

  check('live world viewer and bounded snapshot API are present', () => {
    const router = read('src/dashboard/public/js/router.js');
    read('src/dashboard/public/js/pages/world.js');
    read('src/dashboard/public/js/viewer3d.js');
    read('src/dashboard/worldView.js');
    assert(router.includes("'world'"), 'Live World route is not registered');
    assert(router.includes('Live World'), 'Live World navigation entry is missing');
    const server = read('src/dashboard/server.js');
    assert(server.includes('/api/world'), '/api/world endpoint is missing');
    return 'route + viewer + snapshot producer';
  });

  check('dashboard combat operations surface is routable', () => {
    const router = read('src/dashboard/public/js/router.js');
    const pages = read('src/dashboard/public/js/pages/combat.js');
    const routes = ['combat', 'combat-team', 'combat-gear', 'combat-supplies', 'combat-targets'];
    for (const route of routes) assert(router.includes(`'${route}'`), `combat route ${route} is not registered`);
    for (const page of ['combatPage', 'combatTeamPage', 'combatGearPage', 'combatSuppliesPage', 'combatTargetsPage']) {
      assert(pages.includes(`export const ${page}`), `combat page export ${page} is missing`);
    }
    assert(router.includes('Combat Operations'), 'Combat Operations navigation group is missing');
    assert(pages.includes('no player is auto-targeted'), 'explicit PvP safety copy is missing');
    return `${routes.length} routes`;
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

  check('package metadata is V6', () => {
    const pkg = JSON.parse(read('package.json'));
    assert(/^6\./.test(pkg.version), `version is ${pkg.version}`);
    assert(Boolean(pkg.scripts['deploy:check']), 'deploy:check script missing');
    assert(Boolean(pkg.scripts['test:construction']), 'test:construction script missing');
    assert(Boolean(pkg.scripts['test:combat']), 'test:combat script missing');
    return `version ${pkg.version}`;
  });

  if (baseUrl) {
    const base = baseUrl.replace(/\/$/, '');
    const { config } = requireLocal('src/config.js');
    const authHeaders = config.dashboard.token ? { authorization: `Bearer ${config.dashboard.token}` } : {};
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
      const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json', ...authHeaders } });
      assert(response.ok, `${route} returned HTTP ${response.status}`);
      return response.json();
    };

    await probe('live dashboard answers health checks', async () => {
      const health = await getJson('/healthz');
      assert(health.ok === true, 'healthz did not report ok');
      return `mode ${health.mode || 'unknown'}`;
    });

    await probe('live state exposes ten bots and construction state', async () => {
      const body = await getJson('/api/state');
      assert(body.ok === true, 'state did not report ok');
      assert(Array.isArray(body.state.bots) && body.state.bots.length === 10, `got ${body.state.bots?.length} bots`);
      assert(body.state.construction, 'construction snapshot missing');
      assert(Array.isArray(body.state.construction.projects), 'construction projects missing');
      assert(Array.isArray(body.state.combat) && body.state.combat.length === 10, 'combat state is missing');
      assert(body.state.combatTeam && Array.isArray(body.state.combatTeam.bots), 'team combat state is missing');
      return `${body.state.bots.length} bots, ${body.state.construction.projects.length} project(s), ${body.state.combat.length} combat controllers`;
    });

    await probe('live command surface exposes V5 and V6 families', async () => {
      const body = await getJson('/api/commands');
      assert(body.ok === true, 'commands did not report ok');
      const names = new Set((body.commands || []).map((command) => command.name));
      for (const name of ['builder', 'site', 'materials', 'storage', 'build']) {
        assert(names.has(name), `${name} command family is missing`);
      }
      for (const name of ['combat', 'pve', 'pvp', 'target', 'follow', 'gear', 'totem', 'guard', 'duel', 'arena']) {
        assert(names.has(name), `${name} combat command is missing`);
      }
      return `${names.size} command families`;
    });

    await probe('live dashboard serves the V6 shell', async () => {
      const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(8000), headers: authHeaders });
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
