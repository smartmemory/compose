/**
 * smartmemory-cli.test.js — COMP-SMARTMEMORY-INGEST T6
 *
 * CLI integration tests for `compose smartmemory sync`. These spawn the real
 * CLI binary as a child process (via spawnSync) to prove flag parsing, cwd
 * resolution, and exit-code/error-message wiring.
 *
 * NOTE: this dev sandbox blocks loopback network connections *from a
 * spawnSync-spawned child process* back to an HTTP server bound in the
 * parent test process (verified with a minimal, product-independent repro:
 * plain node:http + spawnSync, no smartmemory code involved — sibling
 * processes launched independently CAN talk to each other; a spawned child
 * specifically cannot reach its parent's listening sockets here). So this
 * file does not attempt to prove "the CLI successfully POSTs to a live
 * service" through an actual subprocess boundary — that exact code path
 * (runSync → createSmartmemoryClient → fetch) is already proven at the lib
 * level, in-process, by the golden-flow test in test/smartmemory-sync.test.js
 * and the hook integration tests in test/smartmemory-hooks.test.js. What's
 * covered here instead: the CLI wires flags/cwd into runSync correctly,
 * fails open (exit 0, reported failed count) when the configured service is
 * unreachable, honors --dry-run and --feature, and rejects unknown
 * subcommands with exit 1 + usage.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');

function seedProject(dir, { baseUrl = 'http://127.0.0.1:1' } = {}) {
  mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
    smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_CLI_KEY' },
  }));
  appendFileSync(join(dir, '.compose', 'data', 'feature-events.jsonl'), JSON.stringify({
    ts: '2026-07-03T10:00:00.000Z', tool: 'set_feature_status', code: 'FOO-1', actor: 'mcp:agent',
  }) + '\n');
}

function runCLI(args, env = {}) {
  return spawnSync(process.execPath, [COMPOSE_BIN, 'smartmemory', ...args], {
    encoding: 'utf8',
    env: { ...process.env, SM_CLI_KEY: 'test-key', ...env },
    timeout: 15000,
  });
}

describe('compose smartmemory sync', () => {
  test('fails open against an unreachable service: exit 0, reports failed count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-cli-unreachable-'));
    seedProject(dir); // baseUrl defaults to a refusing port (127.0.0.1:1)
    try {
      const r = runCLI(['sync'], { COMPOSE_TARGET: dir });
      assert.equal(r.status, 0, `CLI should fail open (exit 0), got: ${r.stderr}`);
      assert.match(r.stdout, /ingested=0/);
      assert.match(r.stdout, /failed=1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--dry-run reports counts without constructing a client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-cli-dry-'));
    seedProject(dir);
    try {
      const r = runCLI(['sync', '--dry-run'], { COMPOSE_TARGET: dir });
      assert.equal(r.status, 0, `CLI exited non-zero: ${r.stderr}`);
      assert.match(r.stdout, /ingested=1/);
      assert.match(r.stdout, /failed=0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--feature CODE filters to the matching feature only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-cli-feature-'));
    seedProject(dir);
    appendFileSync(join(dir, '.compose', 'data', 'feature-events.jsonl'), JSON.stringify({
      ts: '2026-07-03T10:01:00.000Z', tool: 'set_feature_status', code: 'BAR-1', actor: 'mcp:agent',
    }) + '\n');
    try {
      const r = runCLI(['sync', '--dry-run', '--feature', 'FOO-1'], { COMPOSE_TARGET: dir });
      assert.equal(r.status, 0, `CLI exited non-zero: ${r.stderr}`);
      assert.match(r.stdout, /ingested=1/); // only the FOO-1 event, not BAR-1
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unknown subcommand exits 1 with usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartmemory-cli-usage-'));
    try {
      const r = runCLI(['bogus'], { COMPOSE_TARGET: dir });
      assert.equal(r.status, 1);
      assert.ok(/usage/i.test(r.stderr), r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
