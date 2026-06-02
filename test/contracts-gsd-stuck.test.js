/**
 * COMP-GSD-5 Task 1: Contract schema tests for gsd-stuck.json.
 *
 * The schema has two definitions — `stuck` (the halt diagnostic written to
 * stuck.json) and `pause` (the resume state written to pause.json). Both must
 * compile under ajv and validate hand-crafted positive + negative examples.
 * No mocking; pure JSON Schema validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Ajv = (await import('ajv')).default;

function loadSchema() {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'contracts', 'gsd-stuck.json'), 'utf-8'));
}

function compile(defName) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = loadSchema();
  // Register the whole schema so $ref between definitions resolves, then
  // compile a tiny wrapper that points at the chosen definition.
  ajv.addSchema(schema, 'gsd-stuck.json');
  return ajv.compile({ $ref: `gsd-stuck.json#/definitions/${defName}` });
}

const SAMPLE_STUCK = {
  feature: 'COMP-GSD-5',
  taskId: 'T02',
  signal: 'same_file',
  detail: 'lib/foo.js edited 3 times without progress',
  attemptCounts: { sameFileEdits: 3, errorRepeats: 0, noProgressCalls: 1 },
  partialDiff: 'diff --git a/lib/foo.js b/lib/foo.js',
  ts: '2026-06-02T12:00:00.000Z',
};

const SAMPLE_PAUSE = {
  flowId: 'F1',
  stepId: 'execute',
  stuckTaskId: 'T02',
  signal: 'same_file',
  detail: 'lib/foo.js edited 3 times without progress',
  decomposedTasks: [
    { id: 'T01', files_owned: ['a.js'], files_read: [], depends_on: [], description: 'x' },
    { id: 'T02', files_owned: ['b.js'], files_read: [], depends_on: ['T01'], description: 'y' },
  ],
  completedTaskIds: ['T01'],
  pid: 12345,
  mode: 'gsd',
  ts: '2026-06-02T12:00:00.000Z',
};

test('gsd-stuck.json — schema compiles under ajv with house-style metadata', () => {
  const ajv = new Ajv({ strict: false });
  const schema = loadSchema();
  assert.ok(ajv.compile(schema), 'schema should compile');
  assert.equal(schema._source, 'COMP-GSD-5', '_source must be COMP-GSD-5');
  assert.ok(schema._roadmap, '_roadmap must be set');
  assert.ok(schema.definitions.stuck, 'must define `stuck`');
  assert.ok(schema.definitions.pause, 'must define `pause`');
});

test('gsd-stuck.json — validates a sample stuck diagnostic', () => {
  const validate = compile('stuck');
  assert.ok(validate(SAMPLE_STUCK), JSON.stringify(validate.errors));
});

test('gsd-stuck.json — stuck accepts all four signal enum values', () => {
  const validate = compile('stuck');
  for (const signal of ['same_file', 'error_recurrence', 'no_progress', 'wall_clock']) {
    assert.ok(validate({ ...SAMPLE_STUCK, signal }), `${signal} should validate: ${JSON.stringify(validate.errors)}`);
  }
});

test('gsd-stuck.json — stuck rejects an unknown signal', () => {
  const validate = compile('stuck');
  assert.equal(validate({ ...SAMPLE_STUCK, signal: 'cosmic_rays' }), false);
});

test('gsd-stuck.json — stuck rejects a missing required field', () => {
  const validate = compile('stuck');
  const { taskId, ...withoutTaskId } = SAMPLE_STUCK;
  assert.equal(validate(withoutTaskId), false, 'taskId is required');
});

test('gsd-stuck.json — stuck partialDiff is optional', () => {
  const validate = compile('stuck');
  const { partialDiff, ...withoutDiff } = SAMPLE_STUCK;
  assert.ok(validate(withoutDiff), JSON.stringify(validate.errors));
});

test('gsd-stuck.json — validates a sample pause state', () => {
  const validate = compile('pause');
  assert.ok(validate(SAMPLE_PAUSE), JSON.stringify(validate.errors));
});

test('gsd-stuck.json — pause requires mode === "gsd"', () => {
  const validate = compile('pause');
  assert.equal(validate({ ...SAMPLE_PAUSE, mode: 'bug' }), false, 'mode must be gsd');
});

test('gsd-stuck.json — pause rejects missing decomposedTasks', () => {
  const validate = compile('pause');
  const { decomposedTasks, ...without } = SAMPLE_PAUSE;
  assert.equal(validate(without), false, 'decomposedTasks is required');
});

test('gsd-stuck.json — pause completedTaskIds may be empty', () => {
  const validate = compile('pause');
  assert.ok(validate({ ...SAMPLE_PAUSE, completedTaskIds: [] }), JSON.stringify(validate.errors));
});
