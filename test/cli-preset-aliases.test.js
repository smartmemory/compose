/**
 * COMPOSE-UX-SIMPLIFY-2 cut 3 — preset/alias equivalence: `build --preset X` and
 * `pipeline X` reach the same runner as the old bare verbs (same stdout, stderr, exit code).
 * Uses the no-argument usage path, which every runner prints before doing any work.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'compose.js');

function run(args) {
  const cwd = mkdtempSync(join(tmpdir(), 'cli-preset-'));
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', input: '', timeout: 20000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ROWS = [
  { alias: ['fix'], routed: ['build', '--preset', 'fix'] },
  { alias: ['fix'], routed: ['build', '--preset=fix'] },
  { alias: ['plan'], routed: ['build', '--preset', 'plan'] },
  { alias: ['gsd'], routed: ['pipeline', 'gsd'] },
  { alias: ['experiment'], routed: ['pipeline', 'experiment'] },
  { alias: ['triage'], routed: ['pipeline', 'triage'] },
];

describe('CLI presets and aliases reach the same runner', () => {
  for (const { alias, routed } of ROWS) {
    test(`${routed.join(' ')} == ${alias.join(' ')}`, () => {
      const a = run(alias);
      const b = run(routed);
      assert.equal(b.status, a.status, 'same exit code');
      assert.equal(b.stderr, a.stderr, 'same stderr');
      assert.equal(b.stdout, a.stdout, 'same stdout');
      assert.match(a.stderr + a.stdout, /Usage: compose /, 'alias reached its runner usage');
    });
  }

  test('unknown preset is rejected with exit 1 and names the valid presets', () => {
    const r = run(['build', '--preset', 'bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--preset must be one of fix, plan/);
  });
});
