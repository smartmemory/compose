/**
 * Tests for stratum-client.js — single stratum-mcp adapter.
 *
 * Covers:
 *   - Single spawn module rule (static analysis)
 *   - Exit code → result mapping (0, 2, non-zero, timeout)
 *   - Query retry on timeout
 *   - Gate: approve, reject, revise, conflict, error
 *   - stderr never forwarded to callers
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = `${REPO_ROOT}/server`;

// ---------------------------------------------------------------------------
// Static guard: only stratum-client.js may spawn stratum-mcp
// ---------------------------------------------------------------------------

test('only stratum-client.js references execFile/spawn with stratum-mcp', () => {
  const files = readdirSync(SERVER_DIR).filter(f => f.endsWith('.js'));
  const violations = [];

  for (const file of files) {
    if (file === 'stratum-client.js') continue;
    const src = readFileSync(`${SERVER_DIR}/${file}`, 'utf-8');
    // Match execFile/spawn calls where stratum-mcp is the command (first arg), not just mentioned
    if (/(?:execFile|execFileSync|spawnSync|spawn)\s*\(\s*['"`]stratum-mcp['"`]/.test(src)) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, [],
    `These files spawn stratum-mcp directly (must go through stratum-client.js): ${violations.join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// Import stratum-client with injection support
// ---------------------------------------------------------------------------

const {
  _testOnly_setExecFile,
  queryFlows, queryFlow, queryGates,
  gateApprove, gateReject, gateRevise,
} = await import(`${SERVER_DIR}/stratum-client.js`);
const { LIVE_STRATUM_TS_CLI_BIN, probeStratumBin } = await import(`${REPO_ROOT}/lib/stratum-engine.js`);

/**
 * Build a mock execFile that replays the given response sequence.
 * Returns { exec, callCount, lastArgs } where exec is the injected function.
 */
function makeMock(responses) {
  let callCount = 0;
  let lastArgs = [];

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

    return { on: () => {} };
  }

  return { exec, get callCount() { return callCount; }, get lastArgs() { return lastArgs; } };
}

// ---------------------------------------------------------------------------
// Exit code 0 → parsed JSON result
// ---------------------------------------------------------------------------

test('queryFlows: exit 0 returns parsed JSON array', async () => {
  const flows = [{ _schema_version: '1', flow_id: 'abc' }];
  const m = makeMock([{ exitCode: 0, stdout: JSON.stringify(flows) }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlows();
  assert.ok(Array.isArray(result));
  assert.equal(result[0].flow_id, 'abc');
});

// ---------------------------------------------------------------------------
// Exit code 2 → conflict result, no error field
// ---------------------------------------------------------------------------

test('gateApprove: exit 2 returns conflict object', async () => {
  const payload = { conflict: true, flow_id: 'abc', step_id: 's1', detail: 'already resolved' };
  const m = makeMock([{ exitCode: 2, stdout: JSON.stringify(payload) }]);
  _testOnly_setExecFile(m.exec);
  const result = await gateApprove('abc', 's1', 'LGTM');
  assert.equal(result.conflict, true);
  assert.ok(!result.error, 'must not have error field on conflict');
});

// ---------------------------------------------------------------------------
// Non-zero exit → structured error, stderr NOT in result
// ---------------------------------------------------------------------------

test('queryFlow: non-zero exit returns error without stderr', async () => {
  const errPayload = { error: { code: 'NOT_FOUND', message: 'Flow not found', detail: '' } };
  const m = makeMock([{ exitCode: 1, stdout: JSON.stringify(errPayload), stderr: 'Traceback (most recent call last)...' }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlow('nonexistent');
  assert.equal(result.error.code, 'NOT_FOUND');
  assert.ok(!JSON.stringify(result).includes('Traceback'), 'stderr must not appear in result');
});

// ---------------------------------------------------------------------------
// Timeout: query retries once, mutation does not
// ---------------------------------------------------------------------------

test('queryFlows: retries once on timeout, returns TIMEOUT on second timeout', async () => {
  const m = makeMock([{ timeout: true }, { timeout: true }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlows();
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(m.callCount, 2, 'query must retry exactly once');
});

test('queryFlows: succeeds on retry after first timeout', async () => {
  const flows = [{ _schema_version: '1', flow_id: 'x' }];
  const m = makeMock([{ timeout: true }, { exitCode: 0, stdout: JSON.stringify(flows) }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlows();
  assert.ok(Array.isArray(result));
  assert.equal(result[0].flow_id, 'x');
  assert.equal(m.callCount, 2, 'must have called twice');
});

test('gateApprove: no retry on timeout — exactly one call', async () => {
  const m = makeMock([{ timeout: true }]);
  _testOnly_setExecFile(m.exec);
  const result = await gateApprove('abc', 'step1');
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(m.callCount, 1, 'mutation must NOT retry');
});

// ---------------------------------------------------------------------------
// Invalid JSON on success path → PARSE_ERROR (not a throw)
// ---------------------------------------------------------------------------

test('queryFlows: exit 0 with invalid JSON returns PARSE_ERROR', async () => {
  const m = makeMock([{ exitCode: 0, stdout: 'not json' }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlows();
  assert.equal(result.error.code, 'PARSE_ERROR');
});

test('gateApprove: exit 0 with invalid JSON returns PARSE_ERROR', async () => {
  const m = makeMock([{ exitCode: 0, stdout: 'bad output' }]);
  _testOnly_setExecFile(m.exec);
  const result = await gateApprove('f1', 's1');
  assert.equal(result.error.code, 'PARSE_ERROR');
});

// ---------------------------------------------------------------------------
// Gate commands pass correct CLI args
// ---------------------------------------------------------------------------

test('gateReject passes correct args including --note', async () => {
  const payload = { _schema_version: '1', ok: true, flow_id: 'f1', step_id: 's1', outcome: 'kill', result: 'killed' };
  const m = makeMock([{ exitCode: 0, stdout: JSON.stringify(payload) }]);
  _testOnly_setExecFile(m.exec);
  await gateReject('f1', 's1', 'not ready');
  assert.deepEqual(m.lastArgs, ['gate', 'reject', 'f1', 's1', '--note', 'not ready']);
});

test('gateRevise passes --resolved-by agent', async () => {
  const payload = { _schema_version: '1', ok: true, flow_id: 'f1', step_id: 's1', outcome: 'revise', result: 'execute_step' };
  const m = makeMock([{ exitCode: 0, stdout: JSON.stringify(payload) }]);
  _testOnly_setExecFile(m.exec);
  await gateRevise('f1', 's1', '', 'agent');
  assert.ok(m.lastArgs.includes('--resolved-by'));
  assert.ok(m.lastArgs.includes('agent'));
});

test('gateApprove omits --resolved-by when default human', async () => {
  const m = makeMock([{ exitCode: 0, stdout: JSON.stringify({ ok: true }) }]);
  _testOnly_setExecFile(m.exec);
  await gateApprove('f1', 's1');
  assert.ok(!m.lastArgs.includes('--resolved-by'), 'must not pass --resolved-by for default human');
});

// ---------------------------------------------------------------------------
// Engine selection (COMP-STRATUM-TS): TS default, python flag, guard pinned
// ---------------------------------------------------------------------------

const { resolveStratumEngine, guardHistory } = await import(`${SERVER_DIR}/stratum-client.js`);

/** Mock that also records which binary was spawned. */
function makeBinMock(responses) {
  const base = makeMock(responses);
  let lastBin = '';
  function exec(bin, args, opts, callback) {
    lastBin = bin;
    return base.exec(bin, args, opts, callback);
  }
  return { exec, get lastBin() { return lastBin; }, get lastArgs() { return base.lastArgs; } };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('engine defaults to TS: queries spawn stratum', async () => {
  await withEnv({ COMPOSE_STRATUM_ENGINE: undefined }, async () => {
    assert.equal(resolveStratumEngine(), 'ts');
    const m = makeBinMock([{ exitCode: 0, stdout: '[]' }]);
    _testOnly_setExecFile(m.exec);
    await queryFlows();
    // C1: the TS default is the live checkout's query/gate CLI, not a bare
    // `stratum` (which resolves to whatever is on $PATH).
    assert.equal(m.lastBin, LIVE_STRATUM_TS_CLI_BIN);
  });
});

test('COMPOSE_STRATUM_ENGINE=python keeps the legacy query path selectable', async () => {
  await withEnv({ COMPOSE_STRATUM_ENGINE: 'python' }, async () => {
    assert.equal(resolveStratumEngine(), 'python');
    const m = makeBinMock([{ exitCode: 0, stdout: '[]' }]);
    _testOnly_setExecFile(m.exec);
    await queryFlows();
    assert.equal(m.lastBin, 'stratum-mcp');
  });
});

test('COMPOSE_STRATUM_ENGINE=ts routes queries and gates to the stratum bin', async () => {
  await withEnv({ COMPOSE_STRATUM_ENGINE: 'ts', COMPOSE_STRATUM_TS_BIN: undefined }, async () => {
    assert.equal(resolveStratumEngine(), 'ts');
    const m = makeBinMock([{ exitCode: 0, stdout: '[]' }, { exitCode: 0, stdout: '{"ok":true}' }]);
    _testOnly_setExecFile(m.exec);
    await queryGates();
    assert.equal(m.lastBin, LIVE_STRATUM_TS_CLI_BIN);
    await gateApprove('f1', 's1');
    assert.equal(m.lastBin, LIVE_STRATUM_TS_CLI_BIN);
  });
});

test('COMPOSE_STRATUM_TS_BIN overrides the ts binary path', async () => {
  await withEnv({ COMPOSE_STRATUM_ENGINE: 'ts', COMPOSE_STRATUM_TS_BIN: '/opt/stratum-ts/bin/stratum' }, async () => {
    const m = makeBinMock([{ exitCode: 0, stdout: '[]' }]);
    _testOnly_setExecFile(m.exec);
    await queryFlows();
    assert.equal(m.lastBin, '/opt/stratum-ts/bin/stratum');
  });
});

test('guard calls stay pinned to python under engine=ts', async () => {
  await withEnv({ COMPOSE_STRATUM_ENGINE: 'ts' }, async () => {
    const m = makeBinMock([{ exitCode: 0, stdout: '{"resource_id":"r","current_state":"a","ledger":[]}' }]);
    _testOnly_setExecFile(m.exec);
    await guardHistory('r');
    assert.equal(m.lastBin, 'stratum-mcp');
  });
});

test('unknown engine fails loudly, never silently falls back', async () => {
  await withEnv({ COMPOSE_STRATUM_ENGINE: 'gemini' }, async () => {
    assert.throws(() => resolveStratumEngine(), /stratumEngine must be "python" or "ts"/);
    const m = makeBinMock([{ exitCode: 0, stdout: '[]' }]);
    _testOnly_setExecFile(m.exec);
    await assert.rejects(() => queryFlows(), /stratumEngine must be/);
  });
});

test('spawn failures with string codes surface as SPAWN errors, never PARSE_ERROR', async () => {
  function eaccesExec(_bin, _args, _opts, callback) {
    const err = new Error('spawn EACCES');
    err.code = 'EACCES';
    callback(err, '', '');
    return { on: () => {} };
  }
  _testOnly_setExecFile(eaccesExec);
  const query = await queryFlows();
  assert.equal(query.error.code, 'SPAWN');
  assert.match(query.error.message, /EACCES/);
  const mutation = await gateApprove('f1', 's1');
  assert.equal(mutation.error.code, 'SPAWN');
  const guard = await guardHistory('r');
  assert.equal(guard.error.code, 'SPAWN');
  assert.match(guard.error.message, /pip install stratum-mcp/);
});

test('capabilities.stratumEngine drives selection and env overrides config', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { switchProject, getTargetRoot } = await import(`${SERVER_DIR}/project-root.js`);
  const original = getTargetRoot();
  const root = mkdtempSync(join(tmpdir(), 'compose-engine-config-'));
  mkdirSync(join(root, '.compose'), { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({
    version: 1, capabilities: { stratum: true, stratumEngine: 'ts' },
  }));
  t.after(() => switchProject(original));

  await withEnv({ COMPOSE_STRATUM_ENGINE: undefined }, async () => {
    switchProject(root);
    assert.equal(resolveStratumEngine(), 'ts', 'config value selects the engine');
  });
  await withEnv({ COMPOSE_STRATUM_ENGINE: 'python' }, async () => {
    assert.equal(resolveStratumEngine(), 'python', 'env wins over config');
  });
});

test('spawn failure via the child error event settles as SPAWN, never an unhandled rejection', async () => {
  function eventErrorExec(_bin, _args, _opts, _callback) {
    return { on: (name, handler) => { if (name === 'error') { const err = new Error('spawn ENOENT'); err.code = 'ENOENT'; handler(err); } } };
  }
  _testOnly_setExecFile(eventErrorExec);
  const result = await queryFlows();
  assert.equal(result.error.code, 'SPAWN');
  assert.match(result.error.message, /TS stratum engine/);
});

test('non-spawn string codes are generic failures, not SPAWN remedies', async () => {
  function maxbufferExec(_bin, _args, _opts, callback) {
    const err = new Error('stdout maxBuffer length exceeded');
    err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    callback(err, '', '');
    return { on: () => {} };
  }
  _testOnly_setExecFile(maxbufferExec);
  const result = await queryFlows();
  assert.ok(result.error, 'must be an error result');
  assert.notEqual(result.error.code, 'SPAWN');
  assert.ok(!/pip install/.test(result.error.message ?? ''), 'must not suggest installing stratum');
});

// ---------------------------------------------------------------------------
// C1/D1: probeStratumBin must POSITIVELY identify the stratum query contract, not
// just check "output parses as an array" (which adversarial stubs emitting `[]` or
// `[{...}]` pass, and which a legitimately-empty fresh store also produces). It
// queries a nonexistent-but-valid run id and requires the NOT_FOUND projection
// echoing the sentinel — data-independent, unspoofable by an array stub.
// ---------------------------------------------------------------------------

const NOT_FOUND_FOR = (bin, args) => {
  assert.deepEqual(args.slice(0, 2), ['query', 'flow']);
  const sentinel = args[2];
  return JSON.stringify({ error: { code: 'NOT_FOUND', message: `Flow '${sentinel}' not found` } });
};

test('probeStratumBin accepts a binary that returns the NOT_FOUND projection (echoing the sentinel)', () => {
  assert.deepEqual(probeStratumBin('stratum', { execFileSync: NOT_FOUND_FOR }), { ok: true });
});

test('probeStratumBin REJECTS an incompatible binary (Unknown command / non-JSON)', () => {
  // Mirrors miniconda `stratum query …`: prints an error to stdout, exit 0.
  const execFileSync = () => "Unknown command: query\nRun 'stratum --help' for usage.\n";
  const result = probeStratumBin('stratum', { execFileSync });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not speak the stratum query contract|non-JSON/);
});

// D1 (adversarial stubs from the review): "output parses as an array" is not
// enough — these must be REJECTED.
test('probeStratumBin REJECTS an adversarial binary that returns an empty array', () => {
  const execFileSync = () => '[]';
  const result = probeStratumBin('stratum', { execFileSync });
  assert.equal(result.ok, false, 'a bare `[]` (adversarial OR legitimate-empty) must not identify the binary');
  assert.match(result.reason, /NOT_FOUND projection|query contract/);
});

test('probeStratumBin REJECTS an adversarial binary that returns a bogus array of objects', () => {
  const execFileSync = () => '[{"foo":"bar"}]';
  const result = probeStratumBin('stratum', { execFileSync });
  assert.equal(result.ok, false, 'an array of arbitrary objects must not pass');
  assert.match(result.reason, /NOT_FOUND projection|query contract/);
});

test('probeStratumBin REJECTS a binary whose response lacks the NOT_FOUND code', () => {
  const execFileSync = () => '{"error":{"code":"INVALID","message":"nope"}}';
  const result = probeStratumBin('stratum', { execFileSync });
  assert.equal(result.ok, false);
  assert.match(result.reason, /NOT_FOUND projection|query contract/);
});

test('probeStratumBin accepts the NOT_FOUND projection even when the CLI exits non-zero', () => {
  // The real CLI exits non-zero for NOT_FOUND (execFileSync throws) but writes the
  // JSON to stdout — the probe must read err.stdout, not treat it as a failure.
  const execFileSync = (bin, args) => {
    const err = new Error('Command failed');
    err.status = 1;
    err.stdout = JSON.stringify({ error: { code: 'NOT_FOUND', message: `Flow '${args[2]}' not found` } });
    throw err;
  };
  assert.deepEqual(probeStratumBin('stratum', { execFileSync }), { ok: true });
});

test('probeStratumBin REJECTS a binary that fails to run', () => {
  const execFileSync = () => { throw new Error('spawn ENOENT'); };
  const result = probeStratumBin('/no/such/stratum-cli', { execFileSync });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not an executable file|failed to run/);
});

test('probeStratumBin accepts the live TS CLI bin against the real query contract', () => {
  // No execFileSync injection — exercises the real live checkout CLI.
  const result = probeStratumBin(LIVE_STRATUM_TS_CLI_BIN);
  assert.equal(result.ok, true, `live CLI probe should pass: ${result.reason ?? ''}`);
});

// E2: a JSON argument-parrot that echoes the whole invocation inside a NOT_FOUND
// envelope must NOT pass — the message must EQUAL the exact projection format.
test('probeStratumBin REJECTS an argument-parrot echoing the sentinel in a bogus message', () => {
  const execFileSync = (bin, args) => JSON.stringify({
    error: { code: 'NOT_FOUND', message: `echo query flow ${args[2]}` },
  });
  const result = probeStratumBin('parrot', { execFileSync });
  assert.equal(result.ok, false, 'a message merely CONTAINING the sentinel must not pass');
  assert.match(result.reason, /exact NOT_FOUND projection|query contract/);
});

test('probeStratumBin REJECTS a NOT_FOUND whose message differs from the exact projection', () => {
  const execFileSync = (bin, args) => JSON.stringify({
    error: { code: 'NOT_FOUND', message: `flow ${args[2]} does not exist` },
  });
  const result = probeStratumBin('stratum', { execFileSync });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exact NOT_FOUND projection|query contract/);
});

// E3: a TIMEOUT / signal-terminated run with populated stdout must be a probe
// FAILURE, never trusted as a legitimate non-zero exit.
test('probeStratumBin REJECTS an ETIMEDOUT that still flushed parseable stdout', () => {
  const execFileSync = (bin, args) => {
    const err = new Error('spawnSync ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    err.stdout = JSON.stringify({ error: { code: 'NOT_FOUND', message: `Flow '${args[2]}' not found` } });
    throw err;
  };
  const result = probeStratumBin('stratum', { execFileSync });
  assert.equal(result.ok, false, 'a timed-out run must fail even if its stdout parses to the NOT_FOUND projection');
  assert.match(result.reason, /timed out or was terminated/);
});

test('probeStratumBin REJECTS a signal-killed run with populated stdout', () => {
  const execFileSync = (bin, args) => {
    const err = new Error('killed');
    err.killed = true;
    err.signal = 'SIGKILL';
    err.stdout = JSON.stringify({ error: { code: 'NOT_FOUND', message: `Flow '${args[2]}' not found` } });
    throw err;
  };
  const result = probeStratumBin('stratum', { execFileSync });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out or was terminated/);
});
