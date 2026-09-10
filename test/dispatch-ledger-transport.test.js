/**
 * COMP-BUILD-CANCEL S03-6 — the derived transport on the dispatch ledger (C44, C51).
 *
 * The ledger is default-deny (lib/dispatch-ledger.js), and `#recordAgentDispatch`
 * swallows the resulting throw, so populating an unregistered field does not produce a
 * bad row — it produces NO row, taking that dispatch's usage record with it. These
 * cases assert the PERSISTED row from a real tagged dispatch through the client, never
 * a hand-built event.
 *
 * The value is `transport_derived`, never `transport`: stratum reports no transport on
 * its ConnectorResult, so this is compose deriving a deterministic rule from its own
 * inputs (provider codex + a cancellationId sent implies exec), not an observation.
 */

process.env.NODE_ENV = 'test';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { StratumMcpClient } = await import('../lib/stratum-mcp-client.js');
const { readEvents, appendEvent } = await import('../lib/dispatch-ledger.js');

function makeClient() {
  const requests = [];
  const client = new StratumMcpClient();
  Object.defineProperty(client, '_testClient', {
    configurable: true,
    value: {
      async callTool({ name, arguments: args }) {
        requests.push({ name, args });
        return { content: [{ type: 'text', text: JSON.stringify({ text: '{}', usage: { tokens: 5 } }) }] };
      },
    },
  });
  return { client, requests };
}

function dispatchRows(project) {
  return readEvents(project).filter((row) => row.kind === 'dispatch');
}

describe('transport_derived on a persisted ledger row', () => {
  test('a real tagged codex dispatch persists transport_derived: exec, and carries a cancellationId', async () => {
    const project = mkdtempSync(join(tmpdir(), 'ledger-transport-'));
    try {
      const { client, requests } = makeClient();
      await client.agentRun('codex', 'work', {
        flow: { runId: 'run-1', stepId: 'work' },
        telemetry: { site: 'build-step', project_cwd: project, build_id: 'b1', feature_code: 'COMP-X' },
      });
      assert.deepEqual(requests[0].args.flow, { runId: 'run-1', stepId: 'work' });
      assert.ok(requests[0].args.cancellationId, 'every tagged request carries a cancellationId');

      const rows = dispatchRows(project);
      assert.equal(rows.length, 1, 'the row must survive the new field — a default-deny throw drops it entirely');
      assert.equal(rows[0].transport_derived, 'exec');
      assert.equal(rows[0].agent, 'codex');
      assert.equal(rows[0].tokens_total, 5, 'the usage record rides on the same row');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('an untagged, signal-less codex dispatch derives sdk', async () => {
    const project = mkdtempSync(join(tmpdir(), 'ledger-transport-sdk-'));
    try {
      const { client, requests } = makeClient();
      await client.runAgentText('codex', 'probe', {
        telemetry: { site: 'preflight', project_cwd: project, build_id: 'b1', feature_code: 'COMP-X' },
      });
      assert.equal(requests[0].args.cancellationId, undefined);
      assert.equal(dispatchRows(project)[0].transport_derived, 'sdk');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('a claude dispatch derives no transport — the rule is about codex only', async () => {
    const project = mkdtempSync(join(tmpdir(), 'ledger-transport-claude-'));
    try {
      const { client } = makeClient();
      await client.agentRun('claude', 'work', {
        flow: { runId: 'run-1', stepId: 'work' },
        telemetry: { site: 'build-step', project_cwd: project, build_id: 'b1', feature_code: 'COMP-X' },
      });
      const rows = dispatchRows(project);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].transport_derived, null);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('a failed dispatch still produces a row, with its derived transport', async () => {
    const project = mkdtempSync(join(tmpdir(), 'ledger-transport-err-'));
    try {
      const client = new StratumMcpClient();
      Object.defineProperty(client, '_testClient', {
        configurable: true,
        value: { async callTool() { throw new Error('agent blew up'); } },
      });
      await assert.rejects(() => client.agentRun('codex', 'work', {
        flow: { runId: 'run-1', stepId: 'work' },
        telemetry: { site: 'build-step', project_cwd: project, build_id: 'b1', feature_code: 'COMP-X' },
      }));
      const rows = dispatchRows(project);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, 'error');
      assert.equal(rows[0].transport_derived, 'exec');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('the validator accepts the field and still refuses an unregistered one', () => {
    const project = mkdtempSync(join(tmpdir(), 'ledger-transport-validate-'));
    try {
      appendEvent(project, {
        kind: 'dispatch', dispatch_id: 'd1', site: 'build-step', agent: 'codex',
        outcome: 'ok', transport_derived: 'exec',
      });
      appendEvent(project, {
        kind: 'dispatch', dispatch_id: 'd2', site: 'build-step', agent: 'claude',
        outcome: 'ok', transport_derived: null,
      });
      assert.equal(dispatchRows(project).length, 2, 'both readable back from disk');
      assert.throws(() => appendEvent(project, {
        kind: 'dispatch', dispatch_id: 'd3', site: 'build-step', agent: 'codex',
        outcome: 'ok', transport: 'exec',
      }), /unknown field "transport"/);
      assert.throws(() => appendEvent(project, {
        kind: 'dispatch', dispatch_id: 'd4', site: 'build-step', agent: 'codex',
        outcome: 'ok', transport_derived: 7,
      }));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
