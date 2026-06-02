/**
 * Tests for the STRAT-GUARD adapter functions in stratum-client.js
 * (COMP-MCP-ENFORCE Slice 1). Verifies:
 *   - args shape: ['guard', <action>]
 *   - camelCase params are translated to the snake_case JSON kwargs the CLI forwards
 *   - the kwargs object is piped on stdin
 *   - exit-code → result mapping (0 / non-zero / timeout)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = `${REPO_ROOT}/server`;

const {
  _testOnly_setExecFile,
  guardRegister, guardTransition, guardOverride, guardHistory,
} = await import(`${SERVER_DIR}/stratum-client.js`);

/** Mock execFile that captures args + piped stdin and replays a response. */
function makeMock(responses) {
  let callCount = 0;
  let lastArgs = [];
  let lastStdin = '';

  function exec(_bin, args, _opts, callback) {
    const resp = responses[Math.min(callCount, responses.length - 1)];
    callCount++;
    lastArgs = args;
    if (!resp || resp.timeout) {
      const err = new Error('ETIMEDOUT');
      err.code = 'ETIMEDOUT';
      callback(err, '', '');
    } else if (resp.exitCode !== 0) {
      const err = new Error(`exit ${resp.exitCode}`);
      err.code = resp.exitCode;
      callback(err, resp.stdout ?? '', resp.stderr ?? '');
    } else {
      callback(null, resp.stdout ?? '', resp.stderr ?? '');
    }
    return {
      on: () => {},
      stdin: { write: (d) => { lastStdin += d; }, end: () => {} },
    };
  }

  return {
    exec,
    get callCount() { return callCount; },
    get lastArgs() { return lastArgs; },
    get lastStdin() { return lastStdin; },
  };
}

test('guardRegister: args, snake_case kwargs on stdin, parsed result', async () => {
  const m = makeMock([{ exitCode: 0, stdout: '{"guard_id":"compose:h:F1","checksum":"abc","status":"registered"}' }]);
  _testOnly_setExecFile(m.exec);

  const res = await guardRegister({
    resourceId: 'compose:h:F1',
    graph: { a: ['b'], b: [] },
    edgePredicates: { 'a->b': [] },
    initial: 'a',
    terminal: ['b'],
    workspaceRoot: '/tmp/ws',
  });

  assert.deepEqual(m.lastArgs, ['guard', 'register']);
  const piped = JSON.parse(m.lastStdin);
  assert.equal(piped.resource_id, 'compose:h:F1');
  assert.equal(piped.edge_predicates['a->b'].length, 0);
  assert.equal(piped.workspace_root, '/tmp/ws');
  assert.equal(piped.initial, 'a');
  assert.equal(res.status, 'registered');
});

test('guardTransition: translates fromState/toState/modifiedFiles, returns verdict', async () => {
  const m = makeMock([{ exitCode: 0, stdout: '{"status":"applied","current_state":"b","ledger_ref":"r1","verdict":{"met":true}}' }]);
  _testOnly_setExecFile(m.exec);

  const res = await guardTransition({
    resourceId: 'compose:h:F1',
    fromState: 'a',
    toState: 'b',
    artifacts: { commit_sha: 'deadbeef' },
    modifiedFiles: ['x.js'],
    idempotencyKey: 'k1',
    resolvedBy: 'agent',
  });

  assert.deepEqual(m.lastArgs, ['guard', 'transition']);
  const piped = JSON.parse(m.lastStdin);
  assert.equal(piped.from_state, 'a');
  assert.equal(piped.to_state, 'b');
  assert.deepEqual(piped.modified_files, ['x.js']);
  assert.equal(piped.idempotency_key, 'k1');
  assert.equal(piped.resolved_by, 'agent');
  assert.equal(piped.artifacts.commit_sha, 'deadbeef');
  assert.equal(res.status, 'applied');
});

test('guardTransition: refused verdict is a normal (exit 0) result, not an error', async () => {
  const m = makeMock([{ exitCode: 0, stdout: '{"status":"refused","current_state":"a","verdict":{"met":false}}' }]);
  _testOnly_setExecFile(m.exec);
  const res = await guardTransition({ resourceId: 'r', fromState: 'a', toState: 'b' });
  assert.equal(res.status, 'refused');
  assert.equal(res.error, undefined);
});

test('guardOverride: passes override_token + rationale', async () => {
  const m = makeMock([{ exitCode: 0, stdout: '{"status":"deviation","current_state":"b","ledger_ref":"r2"}' }]);
  _testOnly_setExecFile(m.exec);
  const res = await guardOverride({
    resourceId: 'r', fromState: 'a', toState: 'b',
    overrideToken: 'tok', rationale: 'manual', resolvedBy: 'human',
  });
  assert.deepEqual(m.lastArgs, ['guard', 'override']);
  const piped = JSON.parse(m.lastStdin);
  assert.equal(piped.override_token, 'tok');
  assert.equal(piped.rationale, 'manual');
  assert.equal(res.status, 'deviation');
});

test('guardHistory: minimal kwargs, parsed ledger', async () => {
  const m = makeMock([{ exitCode: 0, stdout: '{"resource_id":"r","current_state":"b","ledger":[]}' }]);
  _testOnly_setExecFile(m.exec);
  const res = await guardHistory('r');
  assert.deepEqual(m.lastArgs, ['guard', 'history']);
  assert.equal(JSON.parse(m.lastStdin).resource_id, 'r');
  assert.equal(res.current_state, 'b');
});

test('guard adapter: non-zero exit surfaces the canonical error dict', async () => {
  const m = makeMock([{ exitCode: 1, stdout: '{"status":"error","error_type":"IllegalEdge","message":"x->y is not a legal edge"}' }]);
  _testOnly_setExecFile(m.exec);
  const res = await guardTransition({ resourceId: 'r', fromState: 'x', toState: 'y' });
  assert.equal(res.status, 'error');
  assert.equal(res.error_type, 'IllegalEdge');
});

test('guard adapter: timeout maps to TIMEOUT error (no retry on mutation)', async () => {
  const m = makeMock([{ timeout: true }, { timeout: true }]);
  _testOnly_setExecFile(m.exec);
  const res = await guardTransition({ resourceId: 'r', fromState: 'a', toState: 'b' });
  assert.equal(m.callCount, 1);
  assert.equal(res.error.code, 'TIMEOUT');
});
