'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { createDashboard, SHELL_ROUTES } = require('../src/dashboard/server');

const ROOT = path.resolve(__dirname, '..');

function request(port, requestPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function services() {
  return {
    mode: 'simulation',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: null,
    commands: null
  };
}

test('no Express route uses the legacy bare wildcard that path-to-regexp 8 rejects', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  const routePattern = /\b(?:app|router)\.(get|post|put|patch|delete|all|use)\(\s*(['"`])([^'"`]*)\2/g;
  const arrayWildcard = /\b(?:app|router)\.(get|post|put|patch|delete|all|use)\(\s*\[[^\]]*['"`](?:\*|\/\*)['"`][^\]]*\]/g;
  const invalid = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(routePattern)) {
      const routePath = match[3];
      // Express 5/path-to-regexp 8 throws while registering a string route
      // beginning with '*'. `/foo/*` is equally invalid now.
      if (/(^|\/)\*/.test(routePath)) invalid.push(`${path.relative(ROOT, file)}: ${match[1]}('${routePath}')`);
      // Optional parameters and zero-or-more/repeat modifiers were removed
      // from path-to-regexp 8 and throw at registration when used as strings.
      if (/:[A-Za-z_][A-Za-z0-9_]*[?+*]/.test(routePath)) invalid.push(`${path.relative(ROOT, file)}: ${match[1]}('${routePath}') legacy parameter modifier`);
    }
    for (const match of source.matchAll(arrayWildcard)) {
      invalid.push(`${path.relative(ROOT, file)}: ${match[1]}([... '*']) in a route array`);
    }
  }
  assert.deepEqual(invalid, [], `legacy wildcard route(s) found:\n${invalid.join('\n')}`);
});

test('shell route list covers every frontend navigation item', () => {
  const router = fs.readFileSync(path.join(ROOT, 'src/dashboard/public/js/router.js'), 'utf8');
  const navPaths = [...router.matchAll(/\{\s*path:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(navPaths.length >= 36, `expected navigation paths, got ${navPaths.length}`);
  const missing = navPaths.filter((name) => !SHELL_ROUTES.has(name));
  assert.deepEqual(missing, [], `frontend routes missing a server shell entry: ${missing.join(', ')}`);
  for (const shellPath of SHELL_ROUTES) {
    assert.doesNotMatch(shellPath, /[*.:?#]/, `invalid shell route segment: ${shellPath}`);
  }
});

test('routing keeps API JSON, static 404s and the SPA shell separate', async () => {
  const dash = createDashboard(services(), { port: 0, host: '127.0.0.1' });
  try {
    const started = await dash.start();
    const port = started.port;

    const root = await request(port, '/');
    assert.equal(root.status, 200);
    assert.match(root.headers['content-type'], /text\/html/);
    assert.match(root.body, /id="app"/);

    // A hash route is the same HTTP request as '/'; the fragment never leaves
    // the browser. Every direct path must still boot the same shell.
    for (const shellPath of SHELL_ROUTES) {
      const response = await request(port, `/${shellPath}`);
      assert.equal(response.status, 200, `/${shellPath} should serve the shell`);
      assert.match(response.headers['content-type'], /text\/html/, `/${shellPath} should be HTML`);
      assert.match(response.body, /id="app"/, `/${shellPath} should contain the shell root`);
    }
    const nested = await request(port, '/bots/________');
    assert.equal(nested.status, 200);
    assert.match(nested.body, /id="app"/);

    const headShell = await request(port, '/players', { method: 'HEAD' });
    assert.equal(headShell.status, 200);
    assert.equal(headShell.body, '');
    const headMissing = await request(port, '/js/does-not-exist.js', { method: 'HEAD' });
    assert.equal(headMissing.status, 404);
    assert.equal(headMissing.body, '');

    const unknownPage = await request(port, '/not-a-page', { headers: { Accept: 'text/html' } });
    assert.equal(unknownPage.status, 404);
    assert.match(unknownPage.body, /Page not found/);

    for (const missing of ['/js/does-not-exist.js', '/css/does-not-exist.css', '/images/missing.png', '/downloads/missing.schem']) {
      const response = await request(port, missing, { headers: { Accept: 'text/html' } });
      assert.equal(response.status, 404, `${missing} must 404`);
      assert.match(response.headers['content-type'], /text\/plain/, `${missing} must not return HTML`);
      assert.equal(response.body, 'Not found');
    }

    const api = await request(port, '/api/build');
    assert.equal(api.status, 200);
    assert.match(api.headers['content-type'], /application\/json/);
    assert.equal(JSON.parse(api.body).ok, true);

    for (const [method, apiPath] of [
      ['GET', '/api/nope'], ['POST', '/api/nope'], ['GET', '/api'], ['PUT', '/api/build']
    ]) {
      const response = await request(port, apiPath, { method });
      assert.equal(response.status, 404, `${method} ${apiPath} must 404`);
      assert.match(response.headers['content-type'], /application\/json/, `${method} ${apiPath} must stay JSON`);
      assert.equal(JSON.parse(response.body).ok, false);
    }

    // Unsupported methods must not be turned into the app shell.
    const postPage = await request(port, '/players', { method: 'POST' });
    assert.equal(postPage.status, 404);
    assert.doesNotMatch(postPage.body, /id="app"/);

    // Body-parser failures are JSON, not Express's HTML stack trace.
    const malformed = await request(port, '/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 1 },
      body: '{'
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers['content-type'], /application\/json/);
    assert.doesNotMatch(malformed.body, /<html|at parse|node_modules/i);

    // Encoded traversal attempts must never expose a file outside public/.
    for (const traversal of ['/%2e%2e/package.json', '/js/%2e%2e/%2e%2e/package.json']) {
      const response = await request(port, traversal);
      assert.ok([400, 404].includes(response.status), `${traversal} returned ${response.status}`);
      assert.doesNotMatch(response.body, /"name"\s*:\s*"chickenbots"/, `${traversal} leaked package.json`);
    }
  } finally {
    await dash.stop();
  }
});
