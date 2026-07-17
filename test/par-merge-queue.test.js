import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runPreMergeGateLocal } from '../lib/build.js';
import { resolvePreMergeGate } from '../lib/gsd.js';

describe('TS consumer pre-merge gate', () => {
  const temp = () => mkdtempSync(join(tmpdir(), 'consumer-gate-'));

  it('returns null when all commands pass or no commands are configured', () => {
    assert.equal(runPreMergeGateLocal(temp(), ['git --version'], null, 30000), null);
    assert.equal(runPreMergeGateLocal(temp(), [], null, 30000), null);
  });

  it('returns a bounded failure diagnostic for the first failed command', () => {
    const failure = runPreMergeGateLocal(
      temp(),
      ['git --version', 'sh -c "echo boom >&2; exit 3"'],
      null,
      30000,
    );
    assert.equal(failure.reason, 'gate_failed');
    assert.equal(failure.exit_code, 3);
    assert.match(failure.excerpt, /boom/);
    assert.ok(failure.excerpt.length <= 2048);
  });

  it('reports changed files and bridges node_modules from the base tree', () => {
    const cwd = temp();
    execSync('git init -q', { cwd });
    writeFileSync(join(cwd, 'foo.txt'), 'work\n');
    assert.ok(runPreMergeGateLocal(cwd, ['false'], null, 30000).files.includes('foo.txt'));

    const base = temp();
    const worktree = temp();
    mkdirSync(join(base, 'node_modules', 'pkg'), { recursive: true });
    runPreMergeGateLocal(worktree, ['git --version'], base, 30000);
    assert.ok(existsSync(join(worktree, 'node_modules', 'pkg')));
  });
});

describe('resolvePreMergeGate', () => {
  function project(config) {
    const cwd = tempProject();
    if (config !== undefined) {
      mkdirSync(join(cwd, '.compose'), { recursive: true });
      writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify(config));
    }
    return cwd;
  }
  function tempProject() { return mkdtempSync(join(tmpdir(), 'consumer-gate-config-')); }

  it('defaults to lint and build', () => {
    assert.deepEqual(resolvePreMergeGate(project(), undefined), ['pnpm lint', 'pnpm build']);
  });

  it('honors an override or project configuration', () => {
    assert.deepEqual(resolvePreMergeGate(project(), ['cargo check']), ['cargo check']);
    assert.deepEqual(
      resolvePreMergeGate(project({ preMergeGate: ['npm run lint'] }), undefined),
      ['npm run lint'],
    );
  });

  it('derives the fast subset from gateCommands', () => {
    assert.deepEqual(
      resolvePreMergeGate(project({ gateCommands: ['pnpm lint', 'pnpm build', 'pnpm test'] }), undefined),
      ['pnpm lint', 'pnpm build'],
    );
  });
});
