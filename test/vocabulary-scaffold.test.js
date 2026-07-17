/**
 * vocabulary-scaffold.test.js — STRAT-VOCAB-3, deliverable D1
 *
 * `compose init` scaffolds contracts/vocabulary.yaml (comments-only starter,
 * create-if-absent, idempotent).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'compose-vocab-'));
  temps.push(d);
  return d;
}
function makeEnv(cwd, home) {
  return { ...process.env, HOME: home };
}
function runCmd(cmd, cwd, env, extraArgs = []) {
  return execFileSync(process.execPath, [COMPOSE_BIN, cmd, ...extraArgs], { cwd, env, encoding: 'utf-8' });
}

describe('compose init — vocabulary scaffold', () => {
  test('creates contracts/vocabulary.yaml', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    assert.ok(existsSync(join(cwd, 'contracts', 'vocabulary.yaml')), 'vocabulary.yaml should exist');
  });

  test('scaffolded file is inert (comments only → parses to empty)', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const content = readFileSync(join(cwd, 'contracts', 'vocabulary.yaml'), 'utf-8');
    const parsed = YAML.parse(content);
    assert.ok(parsed === null || parsed === undefined, 'starter must be comments-only (no active entries)');
    assert.match(content, /reject:/, 'should document the format');
  });

  test('does not overwrite an existing vocabulary.yaml on re-init', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);
    runCmd('init', cwd, env);

    const p = join(cwd, 'contracts', 'vocabulary.yaml');
    writeFileSync(p, 'auth_token:\n  reject: [jwt]\n');
    runCmd('init', cwd, env);

    const content = readFileSync(p, 'utf-8');
    assert.match(content, /auth_token/, 'user-customized vocabulary should be preserved on re-init');
  });
});
