/**
 * Unit coverage for readFlowRound's two-store lookup (STRAT-PY-RETIRE).
 *
 * The human-gate golden drives the CLI prompt path, which re-prompts regardless
 * of the gate round, so it cannot observe the round read. The round is only
 * load-bearing on the server-delegated path (a stale resolved gate would
 * otherwise be replayed). This test locks the contract directly: TS store first
 * (STRATUM_STATE_ROOT-aware, 0-based), legacy Python store as fallback.
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { readFlowRound } from '../lib/flow-state.js';

const savedStateRoot = process.env.STRATUM_STATE_ROOT;

afterEach(() => {
  if (savedStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
  else process.env.STRATUM_STATE_ROOT = savedStateRoot;
});

describe('readFlowRound reads the TS store first, Python store as fallback', () => {
  test('TS store: returns the persisted rounds field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flow-round-ts-'));
    try {
      process.env.STRATUM_STATE_ROOT = root;
      await writeFile(join(root, 'flow-abc.json'), JSON.stringify({ id: 'flow-abc', rounds: 2 }));
      assert.equal(readFlowRound('flow-abc'), 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('TS store: a fresh run with no rounds field is round 0 (not 1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flow-round-fresh-'));
    try {
      process.env.STRATUM_STATE_ROOT = root;
      await writeFile(join(root, 'flow-fresh.json'), JSON.stringify({ id: 'flow-fresh' }));
      // 0 here is what makes a fresh gate and its post-first-revise re-entry
      // (rounds=1) mint different gate ids.
      assert.equal(readFlowRound('flow-fresh'), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('falls back to the legacy Python store when no TS file exists', async () => {
    // Point STRATUM_STATE_ROOT at an empty dir so the TS read misses, forcing
    // the Python-store fallback (~/.stratum/flows/<id>.json, field `round`).
    const emptyTsRoot = await mkdtemp(join(tmpdir(), 'flow-round-empty-'));
    const pyDir = join(homedir(), '.stratum', 'flows');
    const pyFile = join(pyDir, 'flow-legacy-test-xyz.json');
    try {
      process.env.STRATUM_STATE_ROOT = emptyTsRoot;
      await mkdir(pyDir, { recursive: true });
      await writeFile(pyFile, JSON.stringify({ round: 5 }));
      assert.equal(readFlowRound('flow-legacy-test-xyz'), 5);
    } finally {
      await rm(pyFile, { force: true });
      await rm(emptyTsRoot, { recursive: true, force: true });
    }
  });

  test('fail-open to 1 when neither store has the flow', async () => {
    const emptyTsRoot = await mkdtemp(join(tmpdir(), 'flow-round-none-'));
    try {
      process.env.STRATUM_STATE_ROOT = emptyTsRoot;
      assert.equal(readFlowRound('flow-does-not-exist-anywhere-zzz'), 1);
    } finally {
      await rm(emptyTsRoot, { recursive: true, force: true });
    }
  });
});
