/**
 * CLI golden test for `compose hooks status` — guards that the refactor to the
 * shared lib/hooks-status.js module keeps the CLI output byte-identical.
 *
 * The `absent` and `foreign` states short-circuit before workspace-id
 * resolution, so they are deterministic regardless of the resolved workspace.
 * The installed-current / installed-stale string formatting is exhaustively
 * covered by unit tests in hooks-status.test.js (formatHookStatusLines).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const COMPOSE_BIN = resolve(fileURLToPath(import.meta.url), '..', '..', 'bin', 'compose.js');

describe('compose hooks status (CLI golden)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cphooks-cli-'));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    // Scaffold a .compose workspace so the command resolves a project root.
    execFileSync(process.execPath, [COMPOSE_BIN, 'init', '--no-stratum', '--no-lifecycle'], {
      cwd: dir,
      stdio: 'ignore',
    });
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('reports absent post-commit and foreign pre-push verbatim', () => {
    // pre-push exists but is not a Compose hook; post-commit absent.
    writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), '#!/usr/bin/env bash\necho not ours\n');
    const out = execFileSync(process.execPath, [COMPOSE_BIN, 'hooks', 'status'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    assert.equal(
      out,
      'post-commit: absent — no hook installed\npre-push: foreign — hook exists but is not a Compose hook\n',
    );
  });
});
