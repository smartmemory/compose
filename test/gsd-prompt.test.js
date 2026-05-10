/**
 * COMP-GSD-2 T4: buildTaskDescription tests.
 *
 * Pure string assembly. Asserts all six sections appear; upstream tasks are
 * filtered by depends_on; gateCommands render verbatim; empty produces/consumes
 * render as "(none)".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildTaskDescription } = await import(`${REPO_ROOT}/lib/gsd-prompt.js`);

const TASK_T02 = {
  id: 'T02',
  files_owned: ['lib/bar.js'],
  files_read: ['contracts/foo.json'],
  depends_on: ['T01'],
  description: 'Implement bar() consuming Foo.',
  produces: [{ file: 'lib/bar.js', symbols: ['bar'], kind: 'function' }],
  consumes: [{ from: 'S01', file: 'contracts/foo.json', symbols: ['Foo'] }],
};

const SLICE_TEXT = `### S02: Bar implementation

File Plan: lib/bar.js (new)

Produces:
  lib/bar.js → bar (function)

Consumes:
  from S01: contracts/foo.json → Foo`;

const UPSTREAM_TASK_T01 = {
  id: 'T01',
  files_owned: ['contracts/foo.json'],
  description: 'do foo',
  produces: [{ file: 'contracts/foo.json', symbols: ['Foo'], kind: 'type' }],
  consumes: [],
};
const UPSTREAM_TASK_T99_UNRELATED = {
  id: 'T99',
  files_owned: ['lib/zzz.js'],
  description: 'unrelated',
  produces: [{ file: 'lib/zzz.js', symbols: ['zzz'], kind: 'function' }],
  consumes: [],
};

const GATE_COMMANDS = ['pnpm lint', 'pnpm build', 'pnpm test'];

test('contains all six required sections', () => {
  const out = buildTaskDescription({
    task: TASK_T02,
    slice: SLICE_TEXT,
    upstreamTasks: [UPSTREAM_TASK_T01],
    gateCommands: GATE_COMMANDS,
  });
  assert.match(out, /Symbols you must produce/);
  assert.match(out, /Symbols you may consume from upstream tasks/);
  assert.match(out, /Boundary Map slice/);
  assert.match(out, /Upstream tasks/);
  assert.match(out, /GATES/);
  assert.match(out, /Do NOT declare done while gates are red/);
});

test('renders task produces and consumes', () => {
  const out = buildTaskDescription({
    task: TASK_T02,
    slice: SLICE_TEXT,
    upstreamTasks: [UPSTREAM_TASK_T01],
    gateCommands: GATE_COMMANDS,
  });
  assert.match(out, /lib\/bar\.js/);
  assert.match(out, /bar.*function/);
  assert.match(out, /from S01.*contracts\/foo\.json/);
  assert.match(out, /Foo/);
});

test('embeds slice text verbatim', () => {
  const out = buildTaskDescription({
    task: TASK_T02,
    slice: SLICE_TEXT,
    upstreamTasks: [UPSTREAM_TASK_T01],
    gateCommands: GATE_COMMANDS,
  });
  assert.ok(out.includes(SLICE_TEXT), 'slice text should appear verbatim in description');
});

test('upstream filtered by depends_on — includes T01, excludes T99', () => {
  const out = buildTaskDescription({
    task: TASK_T02,
    slice: SLICE_TEXT,
    upstreamTasks: [UPSTREAM_TASK_T01, UPSTREAM_TASK_T99_UNRELATED],
    gateCommands: GATE_COMMANDS,
  });
  assert.match(out, /T01/);
  assert.match(out, /Foo/);
  assert.doesNotMatch(out, /T99/);
  assert.doesNotMatch(out, /zzz/);
});

test('renders N gate commands as N command lines under GATES section', () => {
  const cmds = ['cargo clippy --all-features', 'go vet ./...', 'pnpm test --run'];
  const out = buildTaskDescription({
    task: TASK_T02,
    slice: SLICE_TEXT,
    upstreamTasks: [UPSTREAM_TASK_T01],
    gateCommands: cmds,
  });
  // Extract the GATES section text up to the next blank line / end.
  const gatesIdx = out.indexOf('GATES');
  assert.ok(gatesIdx >= 0, 'GATES section must exist');
  const gatesBlock = out.slice(gatesIdx);
  for (const c of cmds) {
    assert.ok(gatesBlock.includes(c), `gates section must include "${c}"`);
  }
  // Each command should appear on its own line in the gates block.
  function reEscape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  for (const c of cmds) {
    const re = new RegExp('^\\s*-\\s*' + reEscape(c) + '\\s*$', 'm');
    assert.match(gatesBlock, re);
  }
});

test('does NOT preserve preexisting task.description as preamble (output is fresh)', () => {
  const taskWithStaleDesc = {
    ...TASK_T02,
    description: 'STALE_OLD_DESCRIPTION_THAT_MUST_NOT_APPEAR',
  };
  const out = buildTaskDescription({
    task: taskWithStaleDesc,
    slice: SLICE_TEXT,
    upstreamTasks: [UPSTREAM_TASK_T01],
    gateCommands: GATE_COMMANDS,
  });
  assert.doesNotMatch(out, /STALE_OLD_DESCRIPTION_THAT_MUST_NOT_APPEAR/);
  assert.match(out.slice(0, 60), /^Symbols you must produce/);
});

test('renders (none) for empty produces and consumes', () => {
  const noProducesNoConsumes = {
    ...TASK_T02,
    produces: [],
    consumes: [],
  };
  const out = buildTaskDescription({
    task: noProducesNoConsumes,
    slice: SLICE_TEXT,
    upstreamTasks: [],
    gateCommands: GATE_COMMANDS,
  });
  // Two (none) markers expected — one for produces, one for consumes.
  const matches = out.match(/\(none\)/g) || [];
  assert.ok(matches.length >= 2, `expected at least 2 "(none)" markers, got ${matches.length}: ${out}`);
});

test('renders empty Upstream tasks block when no depends_on', () => {
  const noDeps = { ...TASK_T02, depends_on: [], consumes: [] };
  const out = buildTaskDescription({
    task: noDeps,
    slice: SLICE_TEXT,
    upstreamTasks: [UPSTREAM_TASK_T01],
    gateCommands: GATE_COMMANDS,
  });
  // T01 should NOT appear — it's not in depends_on.
  assert.doesNotMatch(out, /T01/);
});
