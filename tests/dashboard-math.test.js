'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MockWorld } = require('../src/bot/mockWorld');
const { MockBot } = require('../src/bot/mockBot');
const { worldSnapshot } = require('../src/dashboard/worldView');

async function loadMath() {
  const file = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'js', 'math3d.js');
  const source = fs.readFileSync(file, 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('column-major multiply keeps the camera target in front of the camera', async () => {
  const { mat4Identity, perspective, lookAt, multiply, project } = await loadMath();
  const target = [0, 70, 0];
  const yaw = -0.7;
  const pitch = 0.62;
  const distance = 58;
  const cp = Math.cos(pitch);
  const eye = [
    target[0] + Math.cos(yaw) * cp * distance,
    target[1] + Math.sin(pitch) * distance,
    target[2] + Math.sin(yaw) * cp * distance
  ];
  const projection = perspective(mat4Identity(), 55 * Math.PI / 180, 1.5, 0.1, 600);
  const view = lookAt(mat4Identity(), eye, target, [0, 1, 0]);
  const viewProj = multiply(mat4Identity(), projection, view);

  // The old transposed multiply produced clip-space w=0 here, so project()
  // returned null for the camera target and every terrain vertex vanished.
  const projected = project(viewProj, target);
  assert.ok(projected, 'camera target must project in front of the camera');
  assert.ok(Math.abs(projected[0]) < 0.001, `target x should be centred, got ${projected[0]}`);
  assert.ok(Math.abs(projected[1]) < 0.001, `target y should be centred, got ${projected[1]}`);
  assert.ok(projected[2] > 0 && projected[2] < 1.01, `target depth should be in the frustum, got ${projected[2]}`);

  const offset = project(viewProj, [20, 66, 20]);
  assert.ok(offset, 'terrain near the target must be visible');
  assert.ok(Math.abs(offset[0]) < 1 && Math.abs(offset[1]) < 1, 'nearby terrain must fall inside NDC');
});

test('identity and translation matrices compose in the expected order', async () => {
  const { mat4Identity, multiply, project } = await loadMath();
  const identity = mat4Identity();
  const translation = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]);
  const combined = multiply(new Float32Array(16), identity, translation);
  assert.ok(combined.every((value, index) => Math.abs(value - translation[index]) < 1e-6));
  const point = project(combined, [0, 0, -10]);
  assert.ok(point);
  assert.ok(Math.abs(point[0] - 10) < 1e-6, 'x=0 translated by +10 must land at x=10');
  assert.ok(Math.abs(point[2] - (-10)) < 1e-6, 'the same translation must leave z unchanged');
});

test('real world snapshot columns project into the visible frustum', async () => {
  const { mat4Identity, perspective, lookAt, multiply, project } = await loadMath();
  const world = new MockWorld({ seed: 'projection-test' });
  const bot = new MockBot({ name: '________', world, position: { x: 0, y: world.surfaceY(0, 0) + 1, z: 0 }, inventory: {} });
  const snap = worldSnapshot({ mode: 'simulation', bots: new Map([[bot.name, bot]]), runtime: { simulate: true } }, { bot: bot.name, radius: 12 });
  const target = [0, snap.center.y, 0];
  const yaw = -0.7;
  const pitch = 0.62;
  const distance = Math.max(20, Math.min(180, snap.radius * 2.4));
  const cp = Math.cos(pitch);
  const eye = [
    target[0] + Math.cos(yaw) * cp * distance,
    target[1] + Math.sin(pitch) * distance,
    target[2] + Math.sin(yaw) * cp * distance
  ];
  const viewProj = multiply(
    mat4Identity(),
    perspective(mat4Identity(), 55 * Math.PI / 180, 1.5, 0.1, 600),
    lookAt(mat4Identity(), eye, target, [0, 1, 0])
  );
  let visible = 0;
  for (const column of snap.columns) {
    const point = project(viewProj, [column[0], column[2] + 1, column[1]]);
    if (point && Math.abs(point[0]) <= 1 && Math.abs(point[1]) <= 1) visible++;
  }
  assert.ok(snap.columns.length > 400, `expected a full snapshot, got ${snap.columns.length} columns`);
  assert.ok(visible > snap.columns.length * 0.7, `only ${visible}/${snap.columns.length} terrain columns were visible`);
});
