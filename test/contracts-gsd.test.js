/**
 * COMP-GSD-2 T1: Contract schema tests for taskgraph-gsd.json and task-result.json.
 *
 * Both schemas must compile under ajv and validate hand-crafted positive +
 * negative examples. No mocking; pure JSON Schema validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Ajv = (await import('ajv')).default;

function loadSchema(name) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'contracts', name), 'utf-8'));
}

test('taskgraph-gsd.json — schema compiles under ajv', () => {
  const ajv = new Ajv({ strict: false });
  const schema = loadSchema('taskgraph-gsd.json');
  assert.ok(ajv.compile(schema), 'schema should compile');
  assert.equal(schema._roadmap, 'COMP-GSD-2', 'must declare _roadmap');
  assert.equal(schema._source, 'docs/features/COMP-GSD-2/blueprint.md', '_source must point to the blueprint exactly');
});

test('taskgraph-gsd.json — accepts valid TaskGraphGsd', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(loadSchema('taskgraph-gsd.json'));
  const valid = {
    tasks: [
      {
        id: 'T01',
        files_owned: ['contracts/foo.json'],
        files_read: [],
        depends_on: [],
        description: 'Implement T01.',
        produces: [
          { file: 'contracts/foo.json', symbols: ['Foo'], kind: 'type' },
        ],
        consumes: [],
      },
      {
        id: 'T02',
        files_owned: ['lib/bar.js'],
        files_read: ['contracts/foo.json'],
        depends_on: ['T01'],
        description: 'Implement T02.',
        produces: [
          { file: 'lib/bar.js', symbols: ['bar'], kind: 'function' },
        ],
        consumes: [
          { from: 'S01', file: 'contracts/foo.json', symbols: ['Foo'] },
        ],
      },
    ],
  };
  assert.ok(validate(valid), `valid TaskGraphGsd should pass: ${JSON.stringify(validate.errors)}`);
});

test('taskgraph-gsd.json — rejects task missing required fields', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(loadSchema('taskgraph-gsd.json'));
  const invalid = {
    tasks: [
      { id: 'T01' /* missing files_owned, produces, consumes, description */ },
    ],
  };
  assert.equal(validate(invalid), false, 'should reject task missing required fields');
});

test('taskgraph-gsd.json — rejects produces entry with unknown kind', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(loadSchema('taskgraph-gsd.json'));
  const invalid = {
    tasks: [
      {
        id: 'T01',
        files_owned: ['x'],
        files_read: [],
        depends_on: [],
        description: 'x',
        produces: [{ file: 'x', symbols: ['X'], kind: 'gizmo' }],
        consumes: [],
      },
    ],
  };
  assert.equal(validate(invalid), false, 'should reject unknown produces kind');
});

test('task-result.json — schema compiles under ajv', () => {
  const ajv = new Ajv({ strict: false });
  const schema = loadSchema('task-result.json');
  assert.ok(ajv.compile(schema), 'schema should compile');
  assert.equal(schema._roadmap, 'COMP-GSD-2');
  assert.equal(schema._source, 'docs/features/COMP-GSD-2/blueprint.md');
});

test('task-result.json — accepts valid TaskResult', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(loadSchema('task-result.json'));
  const valid = {
    status: 'passed',
    files_changed: ['lib/bar.js'],
    summary: 'Implemented bar()',
    produces: { bar: 'function bar(x: number): number' },
    gates: [
      { command: 'pnpm lint', status: 'pass', output: '' },
      { command: 'pnpm test', status: 'pass', output: '12 tests passed' },
    ],
    attempts: 1,
  };
  assert.ok(validate(valid), `valid TaskResult should pass: ${JSON.stringify(validate.errors)}`);
});

test('task-result.json — accepts arbitrary gate command names', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(loadSchema('task-result.json'));
  const valid = {
    status: 'passed',
    files_changed: [],
    summary: 'noop',
    produces: {},
    gates: [
      { command: 'cargo clippy', status: 'pass', output: '' },
      { command: 'go vet ./...', status: 'pass', output: '' },
    ],
    attempts: 1,
  };
  assert.ok(validate(valid), 'arbitrary gate commands should pass');
});

test('task-result.json — rejects unknown status value', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(loadSchema('task-result.json'));
  const invalid = {
    status: 'maybe',
    files_changed: [],
    summary: '',
    produces: {},
    gates: [],
    attempts: 0,
  };
  assert.equal(validate(invalid), false, 'should reject unknown status');
});

test('task-result.json — rejects gate entry with unknown status', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(loadSchema('task-result.json'));
  const invalid = {
    status: 'passed',
    files_changed: [],
    summary: '',
    produces: {},
    gates: [{ command: 'x', status: 'maybe', output: '' }],
    attempts: 0,
  };
  assert.equal(validate(invalid), false, 'should reject gate entry with unknown status');
});
