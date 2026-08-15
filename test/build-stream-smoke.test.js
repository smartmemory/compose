/**
 * Smoke test: BuildStreamBridge -> SSE endpoint.
 *
 * Creates a minimal Express server with the bridge wired to an SSE endpoint,
 * writes JSONL events, and verifies they arrive via SSE with correct shapes.
 *
 * This validates the bridge-to-SSE path without importing the full agent-server
 * (which has SDK dependencies and module-level side effects).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, unlinkSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

import { BuildStreamBridge } from '../server/build-stream-bridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJsonlLine(filePath, event, seq) {
  const line = JSON.stringify({ ...event, _seq: seq, _ts: Date.now() }) + '\n';
  appendFileSync(filePath, line);
}

/**
 * Poll until `predicate()` is true. Replaces fixed sleeps used as "the bridge
 * has surely drained by now" preconditions — those hold on an idle machine and
 * break under full-suite load, which is exactly when the whole suite reds.
 * Throws on timeout so a genuinely stalled bridge still fails the test.
 */
async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${message}`);
}

/**
 * Collect SSE messages from a server for a given duration.
 *
 * The returned promise carries a `.connected` promise that settles when THIS
 * request has its response. Callers that must not write events until the client
 * is attached should await that, never a count of `sseClients`: a prior test's
 * response is removed asynchronously on close, so the set can drop and re-grow
 * to the same size and a "wait until size increases" check would hang forever.
 */
function collectSSE(port, durationMs = 2000) {
  let markConnected;
  const connected = new Promise((resolve) => { markConnected = resolve; });
  const done = new Promise((resolve) => {
    const messages = [];
    const req = http.get(`http://127.0.0.1:${port}/stream`, (res) => {
      markConnected();
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              messages.push(JSON.parse(line.slice(6)));
            } catch { /* skip malformed */ }
          }
        }
      });
    });

    setTimeout(() => {
      req.destroy();
      resolve(messages);
    }, durationMs);
  });
  done.connected = connected;
  return done;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Bridge-to-SSE smoke test', () => {
  let tmpDir;
  let server;
  let port;
  let sseClients;
  let broadcastFn;
  /** Every message the bridge has broadcast, in order — the drain signal. */
  let broadcasts;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sse-smoke-'));

    sseClients = new Set();
    broadcasts = [];

    broadcastFn = function broadcast(msg) {
      broadcasts.push(msg);
      const line = `data: ${JSON.stringify(msg)}\n\n`;
      for (const client of sseClients) {
        try { client.write(line); } catch { sseClients.delete(client); }
      }
    };

    const app = express();
    app.get('/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
    });

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(() => {
    server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('SSE messages arrive with correct shapes and _source: "build"', async () => {
    const composeDir = join(tmpDir, 'test1');
    mkdirSync(composeDir, { recursive: true });
    const jsonlPath = join(composeDir, 'build-stream.jsonl');

    const bridge = new BuildStreamBridge(composeDir, broadcastFn, { crashTimeoutMs: 60000 });
    bridge.start();

    try {
      const collecting = collectSSE(port, 1500);
      await new Promise(r => setTimeout(r, 200));

      let seq = 0;
      writeFileSync(jsonlPath, '');
      writeJsonlLine(jsonlPath, { type: 'build_start', featureCode: 'SMOKE-1', flowId: 'f1' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_step_start', stepId: 'design', stepNum: 1, totalSteps: 2, agent: 'claude', flowId: 'f1' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'tool_use', tool: 'Read', input: { file_path: '/tmp/x.md' } }, seq++);
      writeJsonlLine(jsonlPath, { type: 'assistant', content: 'Working on design...' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_step_done', stepId: 'design', summary: 'Done', flowId: 'f1' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_end', status: 'complete', featureCode: 'SMOKE-1' }, seq++);

      const messages = await collecting;

      assert.ok(messages.length >= 6, `expected >= 6 SSE messages, got ${messages.length}`);

      for (const msg of messages) {
        assert.equal(msg._source, 'build', `all messages should have _source:"build"`);
      }

      const buildStart = messages.find(m => m.type === 'system' && m.subtype === 'build_start');
      assert.ok(buildStart, 'should have build_start SSE message');
      assert.equal(buildStart.featureCode, 'SMOKE-1');

      const buildStep = messages.find(m => m.type === 'system' && m.subtype === 'build_step');
      assert.ok(buildStep, 'should have build_step SSE message');
      assert.equal(buildStep.stepId, 'design');

      const toolUse = messages.find(m => m.type === 'assistant' && m.message?.content?.[0]?.type === 'tool_use');
      assert.ok(toolUse, 'should have tool_use SSE message wrapped as assistant');

      const stepDone = messages.find(m => m.type === 'system' && m.subtype === 'build_step_done');
      assert.ok(stepDone, 'should have build_step_done SSE message');

      const buildEnd = messages.find(m => m.type === 'system' && m.subtype === 'build_end');
      assert.ok(buildEnd, 'should have build_end SSE message');
      assert.equal(buildEnd.status, 'complete');
    } finally {
      bridge.stop();
    }
  });

  test('events arrive in order', async () => {
    const composeDir = join(tmpDir, 'test2');
    mkdirSync(composeDir, { recursive: true });
    const jsonlPath = join(composeDir, 'build-stream.jsonl');

    const bridge = new BuildStreamBridge(composeDir, broadcastFn, { crashTimeoutMs: 60000 });
    bridge.start();

    try {
      const collecting = collectSSE(port, 1500);
      await new Promise(r => setTimeout(r, 200));

      let seq = 0;
      writeFileSync(jsonlPath, '');
      writeJsonlLine(jsonlPath, { type: 'build_start', featureCode: 'ORDER-1', flowId: 'f2' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f2' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_step_done', stepId: 's1', summary: 'ok', flowId: 'f2' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_end', status: 'complete', featureCode: 'ORDER-1' }, seq++);

      const messages = await collecting;
      const subtypes = messages
        .filter(m => m.type === 'system')
        .map(m => m.subtype);

      const startIdx = subtypes.indexOf('build_start');
      const stepIdx = subtypes.indexOf('build_step');
      const doneIdx = subtypes.indexOf('build_step_done');
      const endIdx = subtypes.indexOf('build_end');

      assert.ok(startIdx >= 0, 'should have build_start');
      assert.ok(stepIdx >= 0, 'should have build_step');
      assert.ok(doneIdx >= 0, 'should have build_step_done');
      assert.ok(endIdx >= 0, 'should have build_end');
      assert.ok(startIdx < stepIdx, 'build_start before build_step');
      assert.ok(stepIdx < doneIdx, 'build_step before build_step_done');
      assert.ok(doneIdx < endIdx, 'build_step_done before build_end');
    } finally {
      bridge.stop();
    }
  });

  test('late-connecting client does not receive replayed history', async () => {
    const composeDir = join(tmpDir, 'test3');
    mkdirSync(composeDir, { recursive: true });
    const jsonlPath = join(composeDir, 'build-stream.jsonl');

    const bridge = new BuildStreamBridge(composeDir, broadcastFn, { crashTimeoutMs: 60000 });
    bridge.start();

    try {
      // The bridge started BEFORE this file existed, so it is watching the
      // DIRECTORY and only becomes live once its watcher (2s poll + debounce)
      // notices the new file. Writing the events we depend on into that window is
      // a race: the drain wait then expires having never seen them, which is
      // exactly how this test failed under full-suite load. Prove liveness with a
      // sentinel first, and only then write the events the assertion rests on.
      let seq = 0;
      writeFileSync(jsonlPath, '');
      writeJsonlLine(jsonlPath, { type: 'build_start', featureCode: 'SENTINEL', flowId: 'f0' }, seq++);
      await waitUntil(
        () => broadcasts.some(m => m.featureCode === 'SENTINEL'),
        'the bridge to pick up the stream file at all',
      );

      // Now the bridge is demonstrably reading this file. Events written from
      // here are guaranteed to be seen, so the drain wait below measures drain
      // and not startup.
      const drainedBefore = broadcasts.length;
      writeJsonlLine(jsonlPath, { type: 'build_start', featureCode: 'LATE-1', flowId: 'f3' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f3' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_end', status: 'complete', featureCode: 'LATE-1' }, seq++);

      // Wait for the bridge to actually broadcast all three to zero clients.
      // A fixed sleep here was the suite's most frequent flake: under load the
      // bridge had not drained yet, so LATE-1 was still in flight when the
      // client connected and arrived as "replayed history" it never sent.
      // Counted against a baseline, not by featureCode: the bridge stamps
      // build_step_start with no featureCode, so only 2 of these 3 lines carry
      // 'LATE-1' — which is precisely the leaked count the assertion below sees.
      await waitUntil(
        () => broadcasts.length - drainedBefore >= 3,
        'bridge to broadcast all three pre-connection events',
      );

      // NOW connect the SSE client and write new events. Wait for THIS request's
      // own response rather than a guessed 200ms or a client-count increase —
      // see collectSSE's note on why counting races with prior-client teardown.
      const collecting = collectSSE(port, 1500);
      await collecting.connected;

      // Write NEW events (seq continues monotonically)
      writeJsonlLine(jsonlPath, { type: 'build_start', featureCode: 'LATE-2', flowId: 'f4' }, seq++);
      writeJsonlLine(jsonlPath, { type: 'build_end', status: 'complete', featureCode: 'LATE-2' }, seq++);

      const messages = await collecting;

      // LATE-1 events were broadcast before this client connected, so shouldn't be seen
      const late1 = messages.filter(m => m.featureCode === 'LATE-1');
      assert.equal(late1.length, 0, 'late-connecting client should not see history from before connection');

      const late2 = messages.filter(m => m.featureCode === 'LATE-2');
      assert.ok(late2.length > 0, 'should see events written after connection');
    } finally {
      bridge.stop();
    }
  });

  test('SSE reconnect receives new events after reconnect', async () => {
    const composeDir = join(tmpDir, 'test4');
    mkdirSync(composeDir, { recursive: true });
    const jsonlPath = join(composeDir, 'build-stream.jsonl');

    const bridge = new BuildStreamBridge(composeDir, broadcastFn, { crashTimeoutMs: 60000 });
    bridge.start();

    try {
      // First connection — write some events
      let seq = 0;
      writeFileSync(jsonlPath, '');

      const collecting1 = collectSSE(port, 800);
      await new Promise(r => setTimeout(r, 200));
      writeJsonlLine(jsonlPath, { type: 'build_start', featureCode: 'RECON-1', flowId: 'f5' }, seq++);
      const messages1 = await collecting1;
      assert.ok(messages1.length > 0, 'first connection should get events');

      // "Disconnect" (collectSSE ended) — write more events
      writeJsonlLine(jsonlPath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f5' }, seq++);

      // Second connection — should see new events written after reconnect
      const collecting2 = collectSSE(port, 1500);
      await new Promise(r => setTimeout(r, 200));

      writeJsonlLine(jsonlPath, { type: 'build_end', status: 'complete', featureCode: 'RECON-1' }, seq++);
      const messages2 = await collecting2;

      const buildEnd = messages2.find(m => m.type === 'system' && m.subtype === 'build_end');
      assert.ok(buildEnd, 'reconnected client should receive build_end');
      assert.equal(buildEnd.status, 'complete');
    } finally {
      bridge.stop();
    }
  });
});
