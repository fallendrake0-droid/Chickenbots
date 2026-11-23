'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createRuntime } = require('../src/runtime');

async function runtime() {
  return createRuntime({ simulate: true, dashboard: false });
}

test('the base plan stays active instead of failing on reachable work', async () => {
  const rt = await runtime();
  rt.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 16000));
    const objectives = rt.board.listObjectives();
    assert.equal(objectives.length, 1);
    assert.equal(objectives[0].status, 'ACTIVE');
    const failed = rt.board.listTasks().filter((task) => task.status === 'FAILED');
    assert.deepEqual(failed.map((task) => `${task.type}: ${task.lastError}`), []);
    const completed = rt.board.listTasks().filter((task) => task.status === 'COMPLETED');
    assert.ok(completed.length >= 1);
    assert.ok(rt.board.listTasks().every((task) => !/no handler/.test(task.lastError || '')));
  } finally {
    await rt.shutdown('test');
  }
});

test('stone mining sinks a safe shaft when no surface block is reachable', async () => {
  const rt = await runtime();
  try {
    const actions = rt.actions.bots.get('________');
    const before = actions.bot.countItem('cobblestone');
    const result = await actions.mining.mineBlocks({ block: 'stone', limit: 6 });
    assert.equal(result.ok, true, JSON.stringify(result.results.filter((r) => !r.ok).slice(0, 3)));
    assert.ok(result.mined >= 1);
    assert.ok(actions.bot.countItem('cobblestone') >= before, 'stone drops must be collected');
    assert.ok(actions.mining.stats.blocksDug >= 1);
  } finally {
    await rt.shutdown('test');
  }
});

test('all four survival-base phases place and verify real blocks on a shared anchor', async () => {
  const rt = await runtime();
  try {
    const first = rt.actions.bots.get('01010100');
    const second = rt.actions.bots.get('11001100');
    for (const phase of ['FOUNDATION', 'WALLS', 'ROOF', 'PERIMETER']) {
      const actor = phase === 'WALLS' ? second : first;
      const result = await actor.buildBasePhase(phase);
      assert.equal(result.ok, true, `${phase}: ${JSON.stringify(result.missing.slice(0, 3))}`);
      assert.ok(result.placed >= 1);
      assert.equal(result.missing.length, 0);
    }
    const anchor = rt.memory.getFact('base_anchor');
    assert.ok(anchor && Number.isFinite(anchor.x));
    const floor = rt.world.getBlock({ x: anchor.x, y: anchor.y, z: anchor.z });
    assert.equal(floor.name, 'cobblestone');
    const wall = rt.world.getBlock({ x: anchor.x + 1, y: anchor.y + 1, z: anchor.z });
    assert.equal(wall.name, 'oak_planks');
    const roof = rt.world.getBlock({ x: anchor.x, y: anchor.y + 3, z: anchor.z });
    assert.equal(roof.name, 'oak_planks');
  } finally {
    await rt.shutdown('test');
  }
});

test('storage discovery finds the real chest and deposits are verified', async () => {
  const rt = await runtime();
  try {
    const actions = rt.actions.bots.get('10101000');
    const storage = await actions.inventory.findStorage();
    assert.ok(storage, 'the world hut chest must be discovered');
    assert.equal(storage.position.x, 9);
    assert.equal(storage.position.y, 65);
    assert.equal(storage.position.z, 9);
    actions.bot.addItem('dirt', 12);
    const deposit = await actions.inventory.deposit('dirt', 4, storage.position);
    assert.equal(deposit.ok, true, deposit.error);
    assert.equal(deposit.count, 4);
    assert.equal(actions.bot.countItem('dirt'), 8);
    assert.ok(rt.ledger.storages.size >= 1);
  } finally {
    await rt.shutdown('test');
  }
});
