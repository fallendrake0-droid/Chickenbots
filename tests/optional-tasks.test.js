'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TaskBoard } = require('../src/team/taskBoard');

function boardFixture() {
  const board = new TaskBoard({ now: () => 1000 });
  const objective = board.createObjective({ id: 'obj-optional', title: 'OPTIONAL WORK TEST' });
  const optional = board.addTask({
    objectiveId: objective.id,
    type: 'FARM_CROP',
    label: 'optional food quota',
    optional: true,
    maxAttempts: 1,
    units: { target: 1 }
  }).task;
  const critical = board.addTask({
    objectiveId: objective.id,
    type: 'FIND_SITE',
    label: 'required site',
    maxAttempts: 1,
    units: { target: 1 }
  }).task;
  return { board, objective, optional, critical };
}

test('a failed optional quota degrades the objective instead of failing it', () => {
  const { board, objective, optional, critical } = boardFixture();
  assert.equal(board.claim(optional.id, '10101000').ok, true);
  const failed = board.fail(optional.id, 'no soil within reach', { by: '10101000', retry: false });
  assert.equal(failed.ok, true);
  assert.equal(failed.optional, true);
  assert.equal(board.getTask(optional.id).status, 'FAILED');
  assert.equal(board.getObjective(objective.id).status, 'ACTIVE');
  assert.equal(board.getTask(critical.id).status, 'PENDING', 'sibling work must not be cancelled');
  assert.equal(board.getObjective(objective.id).optionalFailure.type, 'FARM_CROP');
  assert.match(board.getObjective(objective.id).optionalFailure.reason, /no soil/);
  assert.equal(board.events.some((event) => event.type === 'task.failed.optional'), true);
});

test('a failed optional dependency does not block dependent work forever', () => {
  const { board, objective, optional } = boardFixture();
  const dependent = board.addTask({
    objectiveId: objective.id,
    type: 'BUILD_PHASE',
    label: 'foundation with available materials',
    maxAttempts: 1,
    dependsOn: [optional.id],
    units: { target: 1 }
  }).task;
  assert.equal(board.dependenciesSatisfied(dependent), false);
  assert.equal(board.claim(optional.id, '11001100').ok, true);
  board.fail(optional.id, 'quota unreachable', { by: '11001100', retry: false });
  assert.equal(board.dependenciesSatisfied(dependent), true);
  const claimed = board.claim(dependent.id, '11001100');
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
});

test('required work completing cancels leftover optional work and completes the objective', () => {
  const { board, objective, optional, critical } = boardFixture();
  assert.equal(board.claim(critical.id, '00110000').ok, true);
  assert.equal(board.complete(critical.id, { by: '00110000', verified: true }).ok, true);
  assert.equal(board.getTask(optional.id).status, 'CANCELLED');
  const completed = board.getObjective(objective.id);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.progress.current, completed.progress.target, 'a completed objective reports full verified progress');
});

test('the survival-base plan marks quotas optional but keeps the site and build required', () => {
  const { TeamCoordinator } = require('../src/team/teamCoordinator');
  const coordinator = new TeamCoordinator({ now: () => 1000, autoPlan: true });
  const plan = coordinator.ensureObjectives();
  assert.ok(plan && plan.created);
  const tasks = coordinator.board.listTasks({ objectiveId: plan.objective.id });
  const byType = (type) => tasks.filter((task) => task.type === type);
  assert.equal(byType('FIND_SITE').every((task) => task.optional !== true), true);
  assert.equal(byType('BUILD_PHASE').some((task) => task.optional === true), false);
  assert.equal(byType('FARM_CROP').every((task) => task.optional === true), true);
  assert.equal(byType('CHOP_WOOD').every((task) => task.optional === true), true);
  assert.equal(byType('MINE_BLOCK').every((task) => task.optional === true), true);
  assert.equal(byType('STORE_ITEMS').every((task) => task.optional !== true), true, 'storage is named in the completion condition');
  assert.equal(byType('PLACE_BED').every((task) => task.optional !== true), true, 'beds are named in the completion condition');
  const row = coordinator.objectiveBoard().find((objective) => objective.id === plan.objective.id);
  assert.equal(row.tasks.find((task) => task.type === 'FARM_CROP').optional, true);
  assert.equal(row.optionalFailure, null);
  const farm = plan.tasks.find((task) => task.type === 'FARM_CROP');
  assert.equal(coordinator.board.claim(farm.id, '11001100').ok, true);
  coordinator.board.fail(farm.id, 'no tillable soil near home', { by: '11001100', retry: false });
  const degradedRow = coordinator.objectiveBoard().find((objective) => objective.id === plan.objective.id);
  assert.equal(degradedRow.status, 'ACTIVE', 'a failed food quota must not fail the base');
  assert.equal(degradedRow.optionalFailure.type, 'FARM_CROP');
  assert.match(degradedRow.optionalFailure.reason, /no tillable soil/);
  assert.equal(degradedRow.tasks.find((task) => task.id === farm.id).status, 'FAILED');
});
