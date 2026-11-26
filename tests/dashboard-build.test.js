'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { buildInfo, PUBLIC_DIR } = require('../src/dashboard/buildInfo');
const { createRuntime } = require('../src/runtime');
const { createDashboard } = require('../src/dashboard/server');

function httpGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('build identity fingerprints the frontend and backend with one comparable build id', () => {
  const first = buildInfo();
  const second = buildInfo();
  assert.match(first.buildId, /^\d+\.\d+\.\d+\+[0-9a-z.]+$/);
  assert.equal(first.buildId, second.buildId, 'build identity must be stable between calls');
  assert.match(first.frontendHash, /^[0-9a-f]{12}$/);
  assert.match(first.backendHash, /^[0-9a-f]{12}$/);
  assert.notEqual(first.frontendHash, first.backendHash);
  assert.equal(first.buildId, `${first.appVersion}+${first.gitShort}.${first.frontendHash}.${first.backendHash}`);
  assert.ok(first.files.frontend >= 20, `expected the frontend inventory, got ${first.files.frontend}`);
  assert.ok(first.files.backend > 100, `expected the backend inventory, got ${first.files.backend}`);
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'js', 'app.js')));
  // Changing a real frontend byte must change the URL fingerprint. This is the
  // property a stale browser cache depends on.
  const probe = path.join(PUBLIC_DIR, 'js', '.build-probe.js');
  fs.writeFileSync(probe, 'export const probe = 1;\n');
  try {
    const changed = buildInfo();
    assert.notEqual(changed.frontendHash, first.frontendHash);
    assert.notEqual(changed.buildId, first.buildId);
  } finally {
    fs.unlinkSync(probe);
  }
});

test('dashboard serves a no-store shell, immutable hashed assets and bounded deep links', async () => {
  const runtime = await createRuntime({ simulate: true, dashboard: false });
  const dash = createDashboard(runtime.services, { port: 0, host: '127.0.0.1' });
  try {
    const started = await dash.start();
    const port = started.port;
    const build = buildInfo();

    const index = await httpGet(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['cache-control'], /no-store/);
    assert.equal(index.headers['x-chickenbots-build'], build.buildId);
    assert.match(index.body, /<meta name="chickenbots-build"/);
    assert.match(index.body, new RegExp(`<meta name="chickenbots-frontend" content="${build.frontendHash}"`));
    assert.match(index.body, new RegExp(`js/app\\.js\\?v=${build.frontendHash}`));
    assert.match(index.body, new RegExp(`css/tokens\\.css\\?v=${build.frontendHash}`));

    const plainAsset = await httpGet(port, '/js/app.js');
    assert.equal(plainAsset.status, 200);
    assert.match(plainAsset.headers['cache-control'], /no-cache/);

    const hashedAsset = await httpGet(port, `/js/router.js?v=${build.frontendHash}`);
    assert.equal(hashedAsset.status, 200);
    assert.match(hashedAsset.headers['cache-control'], /immutable/);
    assert.match(hashedAsset.headers['content-type'], /javascript/);
    assert.match(hashedAsset.body, /from '\.\/utils\.js\?v=[0-9a-f]{12}'/);

    const css = await httpGet(port, `/css/tokens.css?v=${build.frontendHash}`);
    assert.equal(css.status, 200);
    assert.match(css.headers['cache-control'], /immutable/);

    const api = await httpGet(port, '/api/build');
    const payload = JSON.parse(api.body);
    assert.equal(api.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.build.buildId, build.buildId);
    assert.match(api.headers['cache-control'], /no-store/);

    const health = JSON.parse((await httpGet(port, '/healthz')).body);
    assert.equal(health.ok, true);
    assert.equal(health.build.buildId, build.buildId);

    const deepLink = await httpGet(port, '/players');
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.body, /Chickenbots/);
    assert.match(deepLink.headers['cache-control'], /no-store/);

    assert.equal((await httpGet(port, '/nope')).status, 404);
    assert.equal((await httpGet(port, '/api/nope')).status, 404);
  } finally {
    await dash.stop();
    await runtime.shutdown('test');
  }
});
