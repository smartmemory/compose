/**
 * COMP-GSD-2 T6: runGsd preconditions + gateCommands fallback unit tests.
 *
 * Full end-to-end golden flow lives in test/gsd.test.js (T7). These cover
 * the validation/fallback paths that runGsd owns directly.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runGsd, resolveGateCommands, validateAndRepairTaskGraph } =
  await import(`${REPO_ROOT}/lib/gsd.js`);

let cwd;
before(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gsd-runner-'));
});
after(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const VALID_BLUEPRINT = `# Test: Blueprint

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.js\` | new | A |

## Boundary Map

### S01: A

File Plan: \`a.js\` (new)

Produces:
  a.js → a (function)

Consumes: nothing
`;

// ---------- runGsd preconditions ----------

test('runGsd errors when blueprint.md is absent', async () => {
  await assert.rejects(
    () => runGsd('NOSUCH', { cwd }),
    /blueprint missing|compose build/i,
  );
});

test('runGsd errors with helpful message when Boundary Map is invalid', async () => {
  const code = 'BAD';
  const dir = join(cwd, 'docs', 'features', code);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'blueprint.md'),
    `# Bad: Blueprint\n\n## Boundary Map\n\n### S01: bad\n\nProduces:\n  malformed without arrow\n`,
  );
  await assert.rejects(
    () => runGsd(code, { cwd }),
    /Boundary Map invalid/i,
  );
});

test('runGsd refuses to start in a dirty git workspace (before Stratum side effects)', async () => {
  const code = 'DIRTY';
  const subCwd = mkdtempSync(join(tmpdir(), 'gsd-dirty-'));
  // Stub Stratum: every method throws so we know the dirty-tree guard fires
  // before any planner side effect — making the test hermetic and proving
  // the guard runs ahead of stratum.connect()/plan().
  const stubStratum = new Proxy({}, {
    get() {
      return () => { throw new Error('stratum stub: should not be called when workspace is dirty'); };
    },
  });
  try {
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd: subCwd });
    execSync('git config user.email test@example.com', { cwd: subCwd });
    execSync('git config user.name test', { cwd: subCwd });
    writeFileSync(join(subCwd, 'README.md'), '# initial\n');
    execSync('git add README.md && git commit -q -m initial', { cwd: subCwd });
    writeFileSync(join(subCwd, 'unrelated.txt'), 'preexisting changes\n');

    const dir = join(subCwd, 'docs', 'features', code);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blueprint.md'), VALID_BLUEPRINT);

    await assert.rejects(
      () => runGsd(code, { cwd: subCwd, stratum: stubStratum }),
      /clean|dirty|stash/i,
    );
  } finally {
    rmSync(subCwd, { recursive: true, force: true });
  }
});

// ---------- gateCommands fallback ----------

test('resolveGateCommands returns explicit override when provided', () => {
  const out = resolveGateCommands(cwd, ['custom check']);
  assert.deepEqual(out, ['custom check']);
});

test('resolveGateCommands reads compose.json gateCommands when present', () => {
  const subCwd = mkdtempSync(join(tmpdir(), 'gsd-cfg-'));
  try {
    mkdirSync(join(subCwd, '.compose'));
    writeFileSync(
      join(subCwd, '.compose', 'compose.json'),
      JSON.stringify({ gateCommands: ['cargo test', 'cargo clippy'] }),
    );
    const out = resolveGateCommands(subCwd);
    assert.deepEqual(out, ['cargo test', 'cargo clippy']);
  } finally {
    rmSync(subCwd, { recursive: true, force: true });
  }
});

test('resolveGateCommands falls back to defaults when compose.json lacks gateCommands', () => {
  const subCwd = mkdtempSync(join(tmpdir(), 'gsd-cfg-'));
  try {
    mkdirSync(join(subCwd, '.compose'));
    writeFileSync(
      join(subCwd, '.compose', 'compose.json'),
      JSON.stringify({ version: 2, capabilities: {} }),
    );
    const out = resolveGateCommands(subCwd);
    assert.deepEqual(out, ['pnpm lint', 'pnpm build', 'pnpm test']);
  } finally {
    rmSync(subCwd, { recursive: true, force: true });
  }
});

test('resolveGateCommands falls back to defaults when compose.json is absent', () => {
  const subCwd = mkdtempSync(join(tmpdir(), 'gsd-cfg-'));
  try {
    const out = resolveGateCommands(subCwd);
    assert.deepEqual(out, ['pnpm lint', 'pnpm build', 'pnpm test']);
  } finally {
    rmSync(subCwd, { recursive: true, force: true });
  }
});

// ---------- validateAndRepairTaskGraph ----------

test('validateAndRepairTaskGraph passes through descriptions containing all required sections', () => {
  const richDesc = [
    'Symbols you must produce: a',
    'Symbols you may consume from upstream tasks: (none)',
    'Boundary Map slice: contract goes here',
    'Upstream tasks: (none)',
    'GATES: pnpm test',
  ].join('\n');
  const tg = {
    tasks: [
      {
        id: 'T01',
        files_owned: ['a.js'],
        files_read: [],
        depends_on: [],
        description: richDesc,
      },
    ],
  };
  const result = validateAndRepairTaskGraph(tg, VALID_BLUEPRINT, ['pnpm test']);
  assert.equal(result.tasks[0].description, richDesc, 'rich description should pass through unchanged');
  assert.deepEqual(result.tasks[0].produces, [
    { file: 'a.js', symbols: ['a'], kind: 'function' },
  ]);
});

test('validateAndRepairTaskGraph repairs descriptions missing required section markers (length alone is insufficient)', () => {
  const longButMalformed = 'A long description that lacks the required section markers entirely. '.repeat(3);
  const tg = {
    tasks: [
      {
        id: 'T01',
        files_owned: ['a.js'],
        files_read: [],
        depends_on: [],
        description: longButMalformed,
      },
    ],
  };
  const result = validateAndRepairTaskGraph(tg, VALID_BLUEPRINT, ['pnpm test']);
  assert.notEqual(result.tasks[0].description, longButMalformed, 'long-but-malformed description must be repaired');
  assert.match(result.tasks[0].description, /Symbols you must produce/);
  assert.match(result.tasks[0].description, /GATES/);
});

test('validateAndRepairTaskGraph repairs tasks with empty descriptions', () => {
  const tg = {
    tasks: [
      {
        id: 'T01',
        files_owned: ['a.js'],
        files_read: [],
        depends_on: [],
        description: '',
      },
    ],
  };
  const result = validateAndRepairTaskGraph(tg, VALID_BLUEPRINT, ['pnpm test']);
  assert.match(result.tasks[0].description, /Symbols you must produce/);
});

test('validateAndRepairTaskGraph throws on structural mismatch (orphan task)', () => {
  const tg = {
    tasks: [
      {
        id: 'T01',
        files_owned: ['a.js'],
        files_read: [],
        depends_on: [],
        description: 'a sufficiently long description string for the threshold',
      },
      {
        id: 'T_ORPHAN',
        files_owned: ['nonexistent.js'],
        files_read: [],
        depends_on: [],
        description: 'orphan task with no matching slice (long enough description)',
      },
    ],
  };
  assert.throws(
    () => validateAndRepairTaskGraph(tg, VALID_BLUEPRINT, ['pnpm test']),
    /T_ORPHAN|orphan/i,
  );
});
