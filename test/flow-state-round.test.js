import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFlowRound } from '../lib/flow-state.js';

const savedStateRoot = process.env.STRATUM_STATE_ROOT;
afterEach(() => {
  if (savedStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
  else process.env.STRATUM_STATE_ROOT = savedStateRoot;
});

describe('readFlowRound reads only the TS store', () => {
  test('returns a persisted rounds field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flow-round-ts-'));
    try {
      process.env.STRATUM_STATE_ROOT = root;
      await writeFile(join(root, 'flow-abc.json'), JSON.stringify({ rounds: 2 }));
      assert.equal(readFlowRound('flow-abc'), 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('uses round 0 for fresh, missing, invalid, or unreadable TS state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flow-round-default-'));
    try {
      process.env.STRATUM_STATE_ROOT = root;
      await writeFile(join(root, 'fresh.json'), JSON.stringify({ id: 'fresh' }));
      await writeFile(join(root, 'invalid.json'), 'not json');
      assert.equal(readFlowRound('fresh'), 0);
      assert.equal(readFlowRound('invalid'), 0);
      assert.equal(readFlowRound('missing'), 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
