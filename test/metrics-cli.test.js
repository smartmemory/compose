import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendEvent } from '../lib/dispatch-ledger.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'compose.js');

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'metrics-cli-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 1 }));
  appendEvent(cwd, {
    kind: 'dispatch', dispatch_id: 'cli-1', site: 'build-step', agent: 'codex', outcome: 'ok',
    feature_code: 'COMP-CLI', model: null, effort_intended: null, effort_executed: null,
    tokens_in: null, tokens_out: null, tokens_total: null, usd: null, duration_ms: null,
  });
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [bin, 'metrics', ...args], {
    cwd, encoding: 'utf8', timeout: 15_000,
  });
}

test('compose metrics --json emits only stable pretty JSON', () => {
  const cwd = fixture();
  try {
    const result = run(cwd, ['--feature', 'COMP-CLI', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.endsWith('\n'), true);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report), [
      'v', 'filters', 'coverage', 'model_effort', 'sites', 'acrr', 'known_limitations',
    ]);
    assert.equal(result.stdout, `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(report.model_effort[0].model, null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('compose metrics rejects unknown flags and missing flag values', () => {
  const cwd = fixture();
  try {
    for (const args of [['--wat'], ['--since'], ['--feature']]) {
      const result = run(cwd, args);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /metrics/i);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
