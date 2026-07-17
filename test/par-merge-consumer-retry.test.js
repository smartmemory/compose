import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFresh } from '../lib/build.js';

function tmpDataDir() {
  return mkdtempSync(join(tmpdir(), 'cmqcr-data-'));
}

function captureStratum() {
  const calls = [];
  return {
    calls,
    async plan(specYaml, flowName, planInputs) {
      calls.push({ specYaml, flowName, planInputs });
      return { status: 'ready', runId: 'flow-1', ready: [] };
    },
  };
}

const SPEC_YAML = `
version: 1
flows:
  entry: build
  build:
    input: {}
    output: {}
    steps: []
`;

describe('startFresh — pre_merge_gate opt-in', () => {
  it('omits pre_merge_gate when the caller does not supply it', async () => {
    const stratum = captureStratum();
    await startFresh(stratum, SPEC_YAML, 'FEAT-X', 'do the thing', tmpDataDir(), 'build', 'feature');
    assert.deepEqual(stratum.calls[0].planInputs, {
      featureCode: 'FEAT-X',
      description: 'do the thing',
      implementer_agent: 'claude',
      reviewer_agent: 'codex',
    });
  });

  it('includes pre_merge_gate when provided', async () => {
    const stratum = captureStratum();
    await startFresh(
      stratum,
      SPEC_YAML,
      'FEAT-X',
      'do the thing',
      tmpDataDir(),
      'build',
      'feature',
      ['pnpm lint', 'pnpm build'],
    );
    assert.deepEqual(stratum.calls[0].planInputs.pre_merge_gate, ['pnpm lint', 'pnpm build']);
  });

  it('threads an explicitly empty pre_merge_gate', async () => {
    const stratum = captureStratum();
    await startFresh(stratum, SPEC_YAML, 'FEAT-X', 'd', tmpDataDir(), 'build', 'feature', []);
    assert.deepEqual(stratum.calls[0].planInputs.pre_merge_gate, []);
  });

  it('does not add pre_merge_gate to bug flow inputs', async () => {
    const stratum = captureStratum();
    await startFresh(
      stratum,
      SPEC_YAML,
      'BUG-1',
      'fix it',
      tmpDataDir(),
      'bug-fix',
      'bug',
      ['pnpm lint'],
    );
    assert.deepEqual(stratum.calls[0].planInputs, { task: 'fix it' });
  });
});
