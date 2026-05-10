/**
 * COMP-GSD-2 T3: enrichTaskGraph tests.
 *
 * Pure function — no fs, no I/O. Inputs: bare TaskGraph + blueprint text.
 * Output: TaskGraphGsd with produces/consumes attached per task.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { enrichTaskGraph } = await import(`${REPO_ROOT}/lib/gsd-decompose-enrich.js`);
const Ajv = (await import('ajv')).default;

const VALID_BLUEPRINT = `
# Test Feature: Blueprint

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`contracts/foo.json\` | new | Foo contract |
| \`lib/bar.js\` | new | Bar module |

## Boundary Map

### S01: Contracts

File Plan: \`contracts/foo.json\` (new)

Produces:
  contracts/foo.json → Foo (type)

Consumes: nothing

### S02: Bar implementation

File Plan: \`lib/bar.js\` (new)

Produces:
  lib/bar.js → bar (function)

Consumes:
  from S01: contracts/foo.json → Foo
`;

const BARE_TASKGRAPH = {
  tasks: [
    { id: 'T01', files_owned: ['contracts/foo.json'], files_read: [], depends_on: [], description: 'do foo' },
    { id: 'T02', files_owned: ['lib/bar.js'], files_read: ['contracts/foo.json'], depends_on: ['T01'], description: 'do bar' },
  ],
};

test('happy path output validates against contracts/taskgraph-gsd.json', () => {
  const ajv = new Ajv({ strict: false });
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, 'contracts', 'taskgraph-gsd.json'), 'utf-8'),
  );
  const validate = ajv.compile(schema);
  const result = enrichTaskGraph(BARE_TASKGRAPH, VALID_BLUEPRINT);
  const ok = validate(result);
  assert.ok(ok, `enriched TaskGraphGsd should pass schema: ${JSON.stringify(validate.errors)}`);
});

test('throws on slice/task File Plan mismatch (extra file in File Plan)', () => {
  // Slice S01 declares both contracts/foo.json AND contracts/extra.json in File Plan,
  // but only contracts/foo.json appears in any task's files_owned.
  const mismatchBP = `
## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`contracts/foo.json\` | new | Foo contract |
| \`contracts/extra.json\` | new | Extra contract |
| \`lib/bar.js\` | new | Bar module |

## Boundary Map

### S01: Contracts

File Plan: \`contracts/foo.json\` (new), \`contracts/extra.json\` (new)

Produces:
  contracts/foo.json → Foo (type)

Consumes: nothing

### S02: Bar implementation

File Plan: \`lib/bar.js\` (new)

Produces:
  lib/bar.js → bar (function)

Consumes:
  from S01: contracts/foo.json → Foo
`;
  // Same TaskGraph as VALID — T01 owns only contracts/foo.json (NOT contracts/extra.json).
  // Old implementation matched on produces.file (which only included foo.json) and would
  // have wrongly accepted this. New implementation matches on File Plan files and rejects.
  assert.throws(() => enrichTaskGraph(BARE_TASKGRAPH, mismatchBP), /S01|orphan|extra\.json/i);
});

test('happy path — enriches each task with produces/consumes', () => {
  const result = enrichTaskGraph(BARE_TASKGRAPH, VALID_BLUEPRINT);
  assert.equal(result.tasks.length, 2);

  const t01 = result.tasks.find((t) => t.id === 'T01');
  assert.deepEqual(t01.produces, [
    { file: 'contracts/foo.json', symbols: ['Foo'], kind: 'type' },
  ]);
  assert.deepEqual(t01.consumes, []);

  const t02 = result.tasks.find((t) => t.id === 'T02');
  assert.deepEqual(t02.produces, [
    { file: 'lib/bar.js', symbols: ['bar'], kind: 'function' },
  ]);
  assert.deepEqual(t02.consumes, [
    { from: 'S01', file: 'contracts/foo.json', symbols: ['Foo'] },
  ]);
});

test('preserves description, files_owned, files_read, depends_on', () => {
  const result = enrichTaskGraph(BARE_TASKGRAPH, VALID_BLUEPRINT);
  const t02 = result.tasks.find((t) => t.id === 'T02');
  assert.equal(t02.description, 'do bar');
  assert.deepEqual(t02.files_owned, ['lib/bar.js']);
  assert.deepEqual(t02.files_read, ['contracts/foo.json']);
  assert.deepEqual(t02.depends_on, ['T01']);
});

test('throws on empty Boundary Map', () => {
  const blueprintNoBM = `# foo\n\n## File Plan\n| File | Action | Purpose |\n|---|---|---|\n| \`x\` | new | y |\n`;
  assert.throws(() => enrichTaskGraph(BARE_TASKGRAPH, blueprintNoBM), /Boundary Map/i);
});

test('throws on Boundary Map with parse violations', () => {
  const malformed = `## Boundary Map

### S01: bad

Produces:
  malformed line without arrow
`;
  assert.throws(() => enrichTaskGraph({ tasks: [{ id: 'T01', files_owned: [], files_read: [], depends_on: [], description: 'x' }] }, malformed), /Boundary Map/i);
});

test('throws on orphaned slice (no task owns its produces files)', () => {
  const orphanedTaskGraph = {
    tasks: [
      { id: 'T01', files_owned: ['contracts/foo.json'], files_read: [], depends_on: [], description: 'do foo' },
      // T02 missing — no task owns lib/bar.js
    ],
  };
  assert.throws(() => enrichTaskGraph(orphanedTaskGraph, VALID_BLUEPRINT), /S02|orphan|lib\/bar\.js/i);
});

test('throws on orphaned task (no slice maps to it)', () => {
  const extraTask = {
    tasks: [
      { id: 'T01', files_owned: ['contracts/foo.json'], files_read: [], depends_on: [], description: 'do foo' },
      { id: 'T02', files_owned: ['lib/bar.js'], files_read: [], depends_on: [], description: 'do bar' },
      { id: 'T03', files_owned: ['lib/extra.js'], files_read: [], depends_on: [], description: 'extra' },
    ],
  };
  assert.throws(() => enrichTaskGraph(extraTask, VALID_BLUEPRINT), /T03|orphan/i);
});

test('throws on ambiguous slice→task mapping (slice produces files spread across multiple tasks)', () => {
  const splitBP = `
## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.js\` | new | a |
| \`b.js\` | new | b |

## Boundary Map

### S01: Both

File Plan: \`a.js\` (new), \`b.js\` (new)

Produces:
  a.js → a (function)
  b.js → b (function)

Consumes: nothing
`;
  const splitTG = {
    tasks: [
      { id: 'T01', files_owned: ['a.js'], files_read: [], depends_on: [], description: 'a' },
      { id: 'T02', files_owned: ['b.js'], files_read: [], depends_on: [], description: 'b' },
    ],
  };
  assert.throws(() => enrichTaskGraph(splitTG, splitBP), /S01|ambiguous|split/i);
});
