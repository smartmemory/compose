import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { runGsd, recordTsAgentUsage, recordGsdUsageFromState } from '../lib/gsd.js';
import { readLedger } from '../lib/budget-ledger.js';

const FEATURE = 'COMP-GSD-2-FIX';
const FIXTURE_BLUEPRINT = `# ${FEATURE}: Blueprint

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`lib/shared.js\` | new | Shared module |

## Boundary Map

### S01: Shared module

File Plan: \`lib/shared.js\` (new)

Produces:
  lib/shared.js → shared (function)

Consumes: nothing
`;

const CONFLICT_TASKGRAPH = {
  tasks: [
    { id: 'A01', files_owned: ['lib/shared.js'], files_read: [], depends_on: [] },
    { id: 'A02', files_owned: ['lib/shared.js'], files_read: [], depends_on: [] },
  ],
};

function initProject() {
  const cwd = mkdtempSync(join(tmpdir(), 'gsd-ts-'));
  execSync('git init -q', { cwd });
  execSync('git config user.email test@example.com', { cwd });
  execSync('git config user.name test', { cwd });
  writeFileSync(join(cwd, '.gitignore'), '.compose/data/locks/\n');
  execSync('git add .gitignore && git commit -q -m initial', { cwd });
  const featureDir = join(cwd, 'docs', 'features', FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'blueprint.md'), FIXTURE_BLUEPRINT);
  execSync('git add . && git commit -q -m scaffold', { cwd });
  return cwd;
}

function makeConflictTsStub({ agentRunCalls, stepDoneEnvelopes }) {
  const readyDecompose = (attempt, token) => ({
    status: 'ready',
    runId: 'F1',
    ready: [{ id: 'decompose_gsd', agent: 'claude', do: 'decompose', attempt, epoch: attempt, dispatchToken: token }],
  });
  return {
    plan: async () => readyDecompose(1, 'tok-1'),
    audit: async () => ({}),
    agentRun: async (agentType) => {
      agentRunCalls.push({ agentType });
      return { text: JSON.stringify(CONFLICT_TASKGRAPH) };
    },
    stepDone: async (flowId, stepId, envelope) => {
      stepDoneEnvelopes.push({ flowId, stepId, envelope });
      return stepDoneEnvelopes.length === 1
        ? readyDecompose(2, 'tok-2')
        : { status: 'failed', runId: 'F1' };
    },
  };
}

test('TS GSD reports decompose ownership conflicts as retryable failure envelopes', async () => {
  const cwd = initProject();
  try {
    const agentRunCalls = [];
    const stepDoneEnvelopes = [];
    await runGsd(FEATURE, {
      cwd,
      stratum: makeConflictTsStub({ agentRunCalls, stepDoneEnvelopes }),
    });
    assert.match(stepDoneEnvelopes[0].envelope.failure, /conflict/i);
    assert.equal(stepDoneEnvelopes[0].envelope.output, undefined);
    assert.equal(agentRunCalls.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('TS GSD terminal fold records only the engine-only usage delta', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gsd-usage-'));
  try {
    const ctx = { cwd, featureCode: 'F-G4' };
    for (let i = 0; i < 3; i += 1) {
      recordTsAgentUsage(ctx, { input_tokens: 100, output_tokens: 0, cost_usd: 0.1, duration_ms: 1000 });
    }
    recordGsdUsageFromState(
      cwd,
      'F-G4',
      { consumed: { tokens: 350, dollars: 0.35, dispatches: 4, wall_s: 3 } },
      ctx.recordedUsage,
    );
    const feature = readLedger(join(cwd, '.compose')).features['F-G4'];
    assert.equal(feature.totalTokens, 350);
    assert.ok(Math.abs(feature.totalCostUsd - 0.35) < 1e-9);
    assert.equal(feature.sessions.reduce((sum, row) => sum + (row.dispatches ?? 0), 0), 4);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
