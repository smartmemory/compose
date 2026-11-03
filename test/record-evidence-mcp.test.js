/**
 * COMP-DOGFOOD-RECORD-EVIDENCE-1 — an MCP session mints a checked receipt id.
 * Real backends: the real evidence store (scratch file), the real CLI, a real
 * spawned MCP server for the tools/list and profile rows.
 */
import './helpers/git-env-scrub.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'recev-'));
const STORE = join(SCRATCH, 'store', 'evidence.jsonl');
const TARGET = join(SCRATCH, 'workspace');
mkdirSync(join(TARGET, '.compose'), { recursive: true });
writeFileSync(join(TARGET, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { lifecycle: true } }));
process.env.COMPOSE_EVIDENCE_STORE = STORE;
process.env.COMPOSE_TARGET = TARGET;
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const ev = await import(`${REPO_ROOT}/lib/evidence.js`);
const tools = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);
const { isToolAllowed } = await import(`${REPO_ROOT}/server/mcp-tool-policy.js`);

const lines = () => (existsSync(STORE) ? readFileSync(STORE, 'utf8').split('\n').filter(Boolean).length : 0);
const AT = () => new Date().toISOString();
const BY = 'record-evidence-test';
const SUBJECT = { unit: 'COMP-DOGFOOD-RECORD-EVIDENCE-1', claim: 'DONE' };
const log = join(SCRATCH, 'run.log');
writeFileSync(log, 'node 7/7 pass\n');
const cmdReceipt = () => ({ kind: 'command', command: 'node --test test/record-evidence-mcp.test.js', output_line: '7/7 pass', log, at: AT(), by: BY });
const refusal = async (p) => p.then(() => assert.fail('expected a refusal'), (e) => e);

describe('record_evidence tool', () => {
  test('a command receipt mints an id; the CLI shows the same record with its subject; the id passes checkEvidence', async () => {
    const out = await tools.toolRecordEvidence({ evidence: cmdReceipt(), subject: SUBJECT });
    assert.match(out.evidence_id, /^ev:[0-9a-f]{16}$/);
    assert.deepEqual(out.subject, SUBJECT);
    const show = spawnSync('node', [join(REPO_ROOT, 'lib', 'evidence-cli.js'), 'show', out.evidence_id], { encoding: 'utf8', env: process.env });
    assert.equal(show.status, 0, show.stderr);
    const rec = JSON.parse(show.stdout);
    assert.equal(rec.id, out.evidence_id);
    assert.deepEqual(rec.subject, SUBJECT);
    assert.equal(rec.evidence.kind, 'command');
    assert.equal(ev.checkEvidence(out.evidence_id, 'record_completion').cites, out.evidence_id);
  });

  test('a sha receipt for a sha that does not exist is refused and the store is unchanged', async () => {
    const before = lines();
    const e = await refusal(tools.toolRecordEvidence({
      evidence: { kind: 'sha', repo: REPO_ROOT, sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', at: AT(), by: BY },
      subject: SUBJECT,
    }));
    assert.equal(e.code, 'EVIDENCE_REFUSED');
    assert.equal(lines(), before);
  });

  test('an ev: string is refused EVIDENCE_REF_NOT_MINTABLE and writes nothing', async () => {
    const before = lines();
    const e = await refusal(tools.toolRecordEvidence({ evidence: 'ev:0123456789abcdef', subject: SUBJECT }));
    assert.equal(e.code, 'EVIDENCE_REF_NOT_MINTABLE');
    assert.equal(lines(), before);
  });

  test('a missing or incomplete subject is refused and writes nothing', async () => {
    const before = lines();
    for (const subject of [undefined, {}, { unit: 'X' }, { claim: 'DONE' }, 'COMP-X']) {
      const e = await refusal(tools.toolRecordEvidence({ evidence: cmdReceipt(), subject }));
      assert.equal(e.code, 'EVIDENCE_SUBJECT_REQUIRED');
    }
    assert.equal(lines(), before);
  });

  test('the CLI stores the same subject with --subject', () => {
    const r = spawnSync('node', [join(REPO_ROOT, 'lib', 'evidence-cli.js'), 'record', JSON.stringify(cmdReceipt()), '--subject', JSON.stringify(SUBJECT)], { encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.subject, SUBJECT);
    assert.deepEqual(ev.readEvidence(out.evidence_id).subject, SUBJECT);
  });
});

describe('record_evidence policy', () => {
  test('implementer and reviewer are refused, the default profile may call it', () => {
    assert.equal(isToolAllowed({ tool: 'record_evidence', profile: 'implementer' }).allowed, false);
    assert.equal(isToolAllowed({ tool: 'record_evidence', profile: 'reviewer' }).allowed, false);
    assert.equal(isToolAllowed({ tool: 'record_evidence', profile: 'orchestrator' }).allowed, true);
  });
});

function listTools(surface) {
  return new Promise((res, rej) => {
    const proc = spawn('node', [join(REPO_ROOT, 'server', 'compose-mcp.js')], {
      env: { ...process.env, COMPOSE_TOOL_SURFACE: surface },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    const timer = setTimeout(() => { proc.kill(); rej(new Error('tools/list timed out')); }, 8000);
    proc.stdout.on('data', (c) => {
      buf += c.toString();
      for (const l of buf.split('\n')) {
        try {
          const m = JSON.parse(l);
          if (m.id === 1) { clearTimeout(timer); proc.kill(); res(m.result.tools.map((t) => t.name)); return; }
        } catch { /* partial line */ }
      }
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  });
}

describe('record_evidence on the surfaces', () => {
  test('core lists it, lean does not', async () => {
    assert.ok((await listTools('core')).includes('record_evidence'));
    assert.ok(!(await listTools('lean')).includes('record_evidence'));
  });
});
