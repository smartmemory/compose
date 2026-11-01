/**
 * pipeline-chat-routes.test.js — COMP-PIPE-EDIT-CHAT-PANE-1.
 *
 * Real Express on an ephemeral port with the chat routes and an INJECTED fake stratum,
 * so no model is ever called. Pins: the zero-tool Sonnet dispatch, the in-memory YAML
 * (the spec file does not exist on disk), the proposal contract, the 40K-token refusal
 * before dispatch, history keyed by spec file, cancel, and that /api/agent/* is untouched.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachPipelineChatRoutes, CHAT_MODEL, CHAT_SITE } = await import(`${ROOT}/server/pipeline-chat-routes.js`);
const prompt = await import(`${ROOT}/server/pipeline-chat-prompt.js`);

const SPEC = 'version: 1\ncontracts: {}\nflows:\n  main:\n    steps:\n      - id: a\n        agent: claude\n        intent: do a\n';
const PROPOSED = SPEC.replace('do a', 'do a better');

let baseUrl; let httpServer; let work; let dataDir;
let calls; let agentHits; let fake;

function makeFake() {
  const f = {
    validateResult: { valid: true },
    reply: 'Sure, tightened the intent.\n```yaml\n' + PROPOSED + '```\n',
    hold: null,
    onEvent() { return () => {}; },
    async validate(spec) { calls.validate.push(spec); return f.validateResult; },
    async agentRun(agent, p, opts) {
      calls.run.push({ agent, prompt: p, opts });
      if (f.hold) await new Promise((res, rej) => {
        f.hold.release = res;
        opts.signal?.addEventListener('abort', () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
      });
      return { text: f.reply };
    },
  };
  return f;
}

async function turn(body) {
  const res = await fetch(`${baseUrl}/api/pipeline/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const raw = await res.text();
  const frames = res.headers.get('content-type')?.includes('ndjson')
    ? raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: res.status, frames, json: frames.length ? null : (raw ? JSON.parse(raw) : null) };
}
const good = (over = {}) => ({ file: 'plan.stratum.yaml', message: 'tighten it', yaml: SPEC, selectedFlow: 'main', selectedStep: 'a', errors: ['x is wrong'], baseHash: 'h1', ...over });
const finalOf = (r) => r.frames.find((f) => f.type === 'final');

before(() => new Promise((ok) => {
  work = mkdtempSync(join(process.env.SM_SCRATCH_ROOT || tmpdir(), 'pipe-chat-'));
  dataDir = join(work, 'data'); mkdirSync(dataDir, { recursive: true });
  const app = express();
  // Production's global parser is express.json() at 100kb (server/index.js:128); a wider limit here
  // lets the 40K-token cap in the route itself be exercised. The client refuses first in production.
  app.use(express.json({ limit: '1mb' }));
  agentHits = [];
  app.use('/api/agent', (req, _res, next) => { agentHits.push(req.url); next(); });
  attachPipelineChatRoutes(app, {
    getDataDir: () => dataDir, getProjectRoot: () => work, getStratumClient: async () => fake,
  });
  httpServer = createServer(app).listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${httpServer.address().port}`; ok(); });
}));
after(() => new Promise((ok) => { httpServer.close(() => { rmSync(work, { recursive: true, force: true }); ok(); }); }));
beforeEach(async () => {
  calls = { run: [], validate: [] }; fake = makeFake();
  await fetch(`${baseUrl}/api/pipeline/chat?file=plan.stratum.yaml`, { method: 'DELETE' });
});

describe('dispatch contract', () => {
  test('one turn runs Sonnet with zero tools, low effort, pipe-chat telemetry', async () => {
    const r = await turn(good());
    assert.equal(r.status, 200);
    assert.equal(calls.run.length, 1);
    const { agent, opts } = calls.run[0];
    assert.equal(agent, 'claude');
    assert.equal(opts.modelID, 'claude-sonnet-5-5');
    assert.equal(CHAT_MODEL, 'claude-sonnet-5-5');
    assert.deepEqual(opts.allowedTools, []);
    assert.deepEqual(opts.disallowedTools, ['ToolSearch']);
    assert.equal(opts.effort, 'low');
    assert.equal(opts.telemetry.site, 'pipe-chat');
    assert.equal(CHAT_SITE, 'pipe-chat');
    assert.equal(opts.telemetry.project_cwd, work);
  });

  test('the prompt carries the in-memory yaml, flow, step and errors; the spec is not on disk', async () => {
    await turn(good());
    const p = calls.run[0].prompt;
    assert.match(p, /do a\b/);
    assert.match(p, /Selected flow: main/);
    assert.match(p, /Selected step: a/);
    assert.match(p, /- x is wrong/);
    assert.deepEqual(readdirSync(work).filter((f) => f.endsWith('.yaml')), []);
  });

  test('chat never touches /api/agent/*', async () => {
    await turn(good());
    await fetch(`${baseUrl}/api/pipeline/chat?file=plan.stratum.yaml`);
    assert.deepEqual(agentHits, []);
  });
});

describe('size cap', () => {
  test('a request over the 40K-token cap is refused before dispatch and stores nothing', async () => {
    const big = SPEC + '# ' + 'x'.repeat(prompt.MAX_INPUT_TOKENS * 4) + '\n';
    const r = await turn(good({ yaml: big }));
    assert.equal(r.status, 413);
    assert.equal(r.json.cap, 40000);
    assert.equal(calls.run.length, 0);
    const hist = await (await fetch(`${baseUrl}/api/pipeline/chat?file=plan.stratum.yaml`)).json();
    assert.deepEqual(hist.messages, []);
  });
});

describe('proposal', () => {
  test('a fenced yaml block becomes a validated proposal echoing the client baseHash', async () => {
    const f = finalOf(await turn(good()));
    assert.equal(f.proposal.valid, true);
    assert.equal(f.proposal.yaml, PROPOSED);
    assert.equal(f.proposal.baseHash, 'h1');
    assert.ok(!f.reply.includes('```'));
    assert.deepEqual(calls.validate, [PROPOSED]);
  });

  test('a Stratum validation failure marks the proposal invalid with the reason', async () => {
    fake.validateResult = { valid: false, error: 'bad ref' };
    const f = finalOf(await turn(good()));
    assert.equal(f.proposal.valid, false);
    assert.match(f.proposal.error, /bad ref/);
  });

  test('a block that does not parse is invalid and never reaches stratum_validate', async () => {
    fake.reply = 'Here:\n```yaml\nflows: [unclosed\n```';
    const f = finalOf(await turn(good()));
    assert.equal(f.proposal.valid, false);
    assert.match(f.proposal.error, /Invalid YAML/);
    assert.equal(calls.validate.length, 0);
  });

  test('a reply with no block has proposal null', async () => {
    fake.reply = 'It already looks right.';
    const f = finalOf(await turn(good()));
    assert.equal(f.proposal, null);
    assert.equal(f.reply, 'It already looks right.');
  });
});

describe('history, cancel, guards', () => {
  test('history is keyed by spec file, replays as a one-line proposed summary, and DELETE clears it', async () => {
    await turn(good());
    await turn(good({ message: 'again' }));
    const second = calls.run[1].prompt;
    assert.match(second, /User: tighten it/);
    assert.match(second, /\[proposed: Sure, tightened the intent\.\]/);
    assert.ok(!second.includes('do a better'), 'past proposal YAML must not be replayed');
    const other = await (await fetch(`${baseUrl}/api/pipeline/chat?file=build.stratum.yaml`)).json();
    assert.deepEqual(other.messages, []);
    const mine = await (await fetch(`${baseUrl}/api/pipeline/chat?file=plan.stratum.yaml`)).json();
    assert.equal(mine.messages.length, 4);
    await fetch(`${baseUrl}/api/pipeline/chat?file=plan.stratum.yaml`, { method: 'DELETE' });
    const gone = await (await fetch(`${baseUrl}/api/pipeline/chat?file=plan.stratum.yaml`)).json();
    assert.deepEqual(gone.messages, []);
  });

  test('a second turn while one runs is a 409, and cancel aborts the first', async () => {
    fake.hold = {};
    const first = turn(good());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await turn(good())).status, 409);
    const c = await (await fetch(`${baseUrl}/api/pipeline/chat/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'plan.stratum.yaml' }),
    })).json();
    assert.equal(c.cancelled, true);
    const r = await first;
    assert.equal(r.frames.at(-1).type, 'error');
    assert.equal(r.frames.at(-1).cancelled, true);
  });

  test('traversal and non-spec file names are 400; missing message or yaml is 400', async () => {
    for (const file of ['../x.stratum.yaml', 'a/b.stratum.yaml', 'plan.yaml', '']) {
      assert.equal((await turn(good({ file }))).status, 400, file);
    }
    assert.equal((await turn(good({ message: '  ' }))).status, 400);
    assert.equal((await turn(good({ yaml: '' }))).status, 400);
    assert.equal(calls.run.length, 0);
  });
});

describe('dispatch ledger attribution', () => {
  // Dispatch capture is fail-open (stratum-mcp-client.js), so a site the ledger enum rejects
  // is dropped silently. Found live 2026-11-01: 'pipe-chat' was missing and no row was written.
  test("a dispatch row with site 'pipe-chat' passes the ledger validator and reads back", async () => {
    const { appendEvent, readEvents, DISPATCH_SITES } = await import(`${ROOT}/lib/dispatch-ledger.js`);
    assert.ok(DISPATCH_SITES.includes(CHAT_SITE));
    appendEvent(work, {
      kind: 'dispatch', dispatch_id: 'pipe-chat-test', site: CHAT_SITE, agent: 'claude', outcome: 'ok',
      model: CHAT_MODEL, effort_intended: 'low', effort_executed: 'low',
      tokens_in: 10, tokens_out: 5, tokens_total: 15, usd: null, usd_source: null, duration_ms: 1, transport_derived: null,
    });
    const rows = readEvents(work, { kind: 'dispatch' }).filter((r) => r.site === 'pipe-chat');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'claude-sonnet-5-5');
  });
});

describe('prompt helpers', () => {
  test('extractProposal takes only the first yaml fence', () => {
    const r = prompt.extractProposal('a\n```yaml\none: 1\n```\nb\n```yaml\ntwo: 2\n```');
    assert.equal(r.yaml, 'one: 1\n');
    assert.ok(r.text.includes('a') && r.text.includes('b'));
  });
  test('history is capped to the last 12 turns', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    const p = prompt.buildPrompt({ yaml: SPEC, message: 'q', history });
    assert.ok(!p.includes('m17') && p.includes('m18') && p.includes('m29'));
  });
});
