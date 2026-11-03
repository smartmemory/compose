/**
 * COMP-DOGFOOD-EVIDENCE-GATE-1 — no state claim without a receipt the server
 * can check. Real backends where the brief names one: a real git repo for
 * `sha`, real `ps` on real child pids for `process` (only the clock is moved),
 * real PNG files for `pixel`. The exit-77 rows use a copy of tonight's
 * seat-ceiling refusal (test/fixtures/evidence/, never the live unit folder).
 */
import './helpers/git-env-scrub.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(REPO_ROOT, 'test', 'fixtures', 'evidence');
const SCRATCH = mkdtempSync(join(tmpdir(), 'evgate-'));
const STORE = join(SCRATCH, 'store', 'evidence.jsonl');
const TARGET = join(SCRATCH, 'workspace');
mkdirSync(join(TARGET, '.compose'), { recursive: true });
writeFileSync(join(TARGET, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { lifecycle: true } }));
process.env.COMPOSE_EVIDENCE_STORE = STORE;
process.env.COMPOSE_TARGET = TARGET;

const ev = await import(`${REPO_ROOT}/lib/evidence.js`);
const tools = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);
const { TOOLS } = await import(`${REPO_ROOT}/server/mcp-tool-defs.js`);

const children = [];
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(SCRATCH, { recursive: true, force: true });
});

const AT = () => new Date().toISOString();
const BY = 'test-runner';

function makeRepo() {
  const cwd = mkdtempSync(join(SCRATCH, 'repo-'));
  const g = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(cwd, 'f.txt'), 'x');
  g('add', '.'); g('commit', '-q', '-m', 'init');
  return { cwd, sha: g('rev-parse', 'HEAD').stdout.trim() };
}

/** A real 8-bit RGB PNG, every pixel `rgb`, except (1,1) which is `dot`. */
function writePng(path, w, h, rgb, dot = rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    // alternate filters (0 none, 1 sub, 2 up) so the decoder's unfilter is exercised
    const f = y % 3;
    const raw = [];
    for (let x = 0; x < w; x++) raw.push(...(x === 1 && y === 1 ? dot : rgb));
    const prev = y > 0 ? rows[y - 1].raw : null;
    const enc = raw.map((v, i) => (f === 1 ? (v - (i >= 3 ? raw[i - 3] : 0)) : f === 2 ? (v - (prev ? prev[i] : 0)) : v) & 0xff);
    rows.push({ raw, line: Buffer.from([f, ...enc]) });
  }
  const idat = deflateSync(Buffer.concat(rows.map((r) => r.line)));
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}

function deadPid() {
  const r = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' });
  return parseInt(r.stdout.trim(), 10);
}

describe('contract', () => {
  test('the schema accepts each kind and the ev:<id> form, and refuses a bad shape', () => {
    const ok = [
      { kind: 'sha', repo: '/r', sha: 'abc1234', at: AT(), by: BY },
      { kind: 'process', pid: 42, launched_at: AT(), label: 'job', at: AT(), by: BY },
      { kind: 'file', path: '/f', at: AT(), by: BY },
      { kind: 'log', path: '/f', line: 'x', at: AT(), by: BY },
      { kind: 'screenshot', path: '/s.png', region: { x: 0, y: 0, w: 1, h: 1 }, at: AT(), by: BY },
      { kind: 'command', command: 'ls', output_line: 'x', log: '/l', at: AT(), by: BY },
      { kind: 'pixel', path: '/p.png', point: { x: 0, y: 0 }, expected: '#dc2626', at: AT(), by: BY },
      'ev:0123456789abcdef',
    ];
    for (const o of ok) assert.equal(ev.validateEvidence(o).ok, true, JSON.stringify(o));
    assert.equal(ev.validateEvidence({ kind: 'log', path: '/f', at: AT(), by: BY }).ok, false, 'log needs a line');
    assert.equal(ev.validateEvidence({ kind: 'sha', repo: 'relative', sha: 'abc1234', at: AT(), by: BY }).ok, false);
    assert.equal(ev.validateEvidence('ev:NOTHEX').ok, false);
    assert.equal(ev.validateEvidence({ kind: 'sha', repo: '/r', sha: 'abc1234', at: AT(), by: BY, trust_me: true }).ok, false);
  });

  test('every tool def that takes a receipt names the contract', () => {
    for (const name of ['record_completion', 'set_feature_status', 'complete_feature', 'approve_gate']) {
      const t = TOOLS.find((d) => d.name === name);
      assert.match(t.inputSchema.properties.evidence.description, /contracts\/evidence\.schema\.json/, name);
    }
    // set_feature_status left: its receipt depends on the status (fix r1, QUESTION 1 (a)); test/evidence-binding.test.js pins it
    for (const name of ['record_completion', 'complete_feature']) {
      assert.ok(TOOLS.find((d) => d.name === name).inputSchema.required.includes('evidence'), name);
    }
  });
});

describe('process receipt (the exit-77 incident)', () => {
  test('tonight\'s case: exit file 77 + SEAT CEILING GATE log, checked at +120 s, is refused with the gate line quoted', () => {
    const launched = Date.parse('2026-11-03T21:11:00+08:00');
    const r = ev.verifyEvidence({
      kind: 'process', pid: deadPid(), launched_at: new Date(launched).toISOString(), label: 'seat-equalize',
      exit_file: join(FIX, 'seat-equalize.exit'), log: join(FIX, 'seat-equalize.log'), at: AT(), by: 's2-coord',
    }, { now: launched + 121_000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EVIDENCE_REFUSED');
    const joined = r.reasons.join(' | ');
    assert.match(joined, /seat-equalize exited 77 at a launch gate: WORK MODEL GATE \(claude shim\): SEAT CEILING GATE/);
    assert.match(joined, /is gone at launch \+ 121 s/);
  });

  test('a live pid older than 120 s passes (real ps, clock moved)', async () => {
    const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 150));
    const probe = ev.psProbe(child.pid);
    assert.equal(probe.alive, true);
    assert.ok(Number.isFinite(probe.startedAt), 'ps lstart parsed');
    const r = ev.verifyEvidence({
      kind: 'process', pid: child.pid, launched_at: new Date(probe.startedAt).toISOString(), label: 'sleep', at: AT(), by: BY,
    }, { now: probe.startedAt + 121_000 });
    assert.equal(r.ok, true, r.reasons.join('; '));
    assert.match(r.checks[0], /alive at launch \+ 121 s/);
  });

  test('a check at +30 s is refused as too early', () => {
    const launched = Date.now();
    const r = ev.verifyEvidence({ kind: 'process', pid: process.pid, launched_at: new Date(launched).toISOString(), label: 'j', at: AT(), by: BY },
      { now: launched + 30_000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EVIDENCE_TOO_EARLY');
    assert.match(r.reasons[0], /too early: checked at launch \+ 30 s/);
  });

  test('a live pid that started long before the claimed launch is a reused pid', () => {
    const launched = Date.now() - 600_000;
    const r = ev.verifyEvidence({ kind: 'process', pid: 77777, launched_at: new Date(launched).toISOString(), label: 'j', at: AT(), by: BY },
      { now: Date.now(), ps: () => ({ alive: true, startedAt: launched - 3_600_000 }) });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /a reused pid/);
  });
});

describe('sha receipt', () => {
  test('a real sha passes and a made-up sha fails', () => {
    const { cwd, sha } = makeRepo();
    assert.equal(ev.verifyEvidence({ kind: 'sha', repo: cwd, sha, at: AT(), by: BY }).ok, true);
    const bad = ev.verifyEvidence({ kind: 'sha', repo: cwd, sha: 'deadbeef'.repeat(5), at: AT(), by: BY });
    assert.equal(bad.ok, false);
    assert.match(bad.reasons[0], /commit deadbeef\w+ not found in/);
  });
});

describe('pixel and screenshot receipts', () => {
  const png = join(SCRATCH, 'shot.png');
  writePng(png, 4, 4, [0xdc, 0x26, 0x26], [0x10, 0x20, 0x30]);

  test('a point of the right colour passes (within tolerance) and a wrong one fails', () => {
    assert.equal(ev.verifyEvidence({ kind: 'pixel', path: png, point: { x: 2, y: 3 }, expected: '#dc2626', at: AT(), by: BY }).ok, true);
    assert.equal(ev.verifyEvidence({ kind: 'pixel', path: png, point: { x: 2, y: 3 }, expected: '#d8292a', at: AT(), by: BY }).ok, true,
      'off by 4 is inside PIXEL_TOLERANCE');
    const wrong = ev.verifyEvidence({ kind: 'pixel', path: png, point: { x: 1, y: 1 }, expected: '#dc2626', at: AT(), by: BY });
    assert.equal(wrong.ok, false);
    assert.match(wrong.reasons[0], /pixel 1,1 is #102030, not #dc2626/);
    const out = ev.verifyEvidence({ kind: 'pixel', path: png, point: { x: 9, y: 0 }, expected: '#dc2626', at: AT(), by: BY });
    assert.match(out.reasons[0], /outside the 4x4/);
  });

  test('a screenshot region must lie inside the image', () => {
    assert.equal(ev.verifyEvidence({ kind: 'screenshot', path: png, region: { x: 0, y: 0, w: 4, h: 4 }, at: AT(), by: BY }).ok, true);
    assert.equal(ev.verifyEvidence({ kind: 'screenshot', path: png, region: { x: 2, y: 2, w: 4, h: 4 }, at: AT(), by: BY }).ok, false);
  });
});

describe('file, log and command receipts', () => {
  const log = join(SCRATCH, 'run.log');
  writeFileSync(log, 'start\nnode 12/12 pass\nend\n');

  test('a claimed line present in a fresh file passes; an absent line, a stale file, a missing file fail', () => {
    assert.equal(ev.verifyEvidence({ kind: 'log', path: log, line: '12/12 pass', at: AT(), by: BY }).ok, true);
    assert.match(ev.verifyEvidence({ kind: 'log', path: log, line: '13/13', at: AT(), by: BY }).reasons[0], /holds no line containing/);
    const old = join(SCRATCH, 'old.log');
    writeFileSync(old, 'x\n');
    const t = (Date.now() - 3_600_000) / 1000;
    utimesSync(old, t, t);
    assert.match(ev.verifyEvidence({ kind: 'file', path: old, at: AT(), by: BY }).reasons[0], /older than the claimed at/);
    assert.match(ev.verifyEvidence({ kind: 'file', path: join(SCRATCH, 'nope'), at: AT(), by: BY }).reasons[0], /does not exist/);
  });

  test('command: the output line must be in the named log; the command is never run', () => {
    const marker = join(SCRATCH, 'must-not-exist');
    const cmd = `touch ${marker}`;
    assert.equal(ev.verifyEvidence({ kind: 'command', command: cmd, output_line: 'node 12/12', log, at: AT(), by: BY }).ok, true);
    assert.equal(ev.verifyEvidence({ kind: 'command', command: cmd, output_line: 'node 99/99', log, at: AT(), by: BY }).ok, false);
    assert.equal(existsSync(marker), false);
  });
});

describe('the four state tools refuse a claim without a receipt', () => {
  const cases = [
    ['set_feature_status (COMPLETE)', () => tools.toolSetFeatureStatus({ code: 'EVG-1', status: 'COMPLETE' })],
    ['record_completion', () => tools.toolRecordCompletion({ feature_code: 'EVG-1', commit_sha: 'a'.repeat(40), tests_pass: true, files_changed: [] })],
    ['complete_feature', () => tools.toolCompleteFeature({ id: 'EVG-1', commit_sha: 'a'.repeat(40), tests_pass: true })],
    ['approve_gate (approved)', () => tools.toolApproveGate({ gateId: 'g-1', outcome: 'approved' })],
  ];
  for (const [name, call] of cases) {
    test(`${name} with no evidence → EVIDENCE_REQUIRED`, async () => {
      await assert.rejects(call, (e) => e.code === 'EVIDENCE_REQUIRED' && /an `evidence` object is required/.test(e.message));
    });
  }

  test('a schema-invalid receipt → EVIDENCE_INVALID; an unknown ev:<id> → EVIDENCE_UNKNOWN_REF', async () => {
    await assert.rejects(() => tools.toolSetFeatureStatus({ code: 'EVG-1', status: 'COMPLETE', evidence: { kind: 'sha' } }),
      (e) => e.code === 'EVIDENCE_INVALID');
    await assert.rejects(() => tools.toolSetFeatureStatus({ code: 'EVG-1', status: 'COMPLETE', evidence: 'ev:ffffffffffffffff' }),
      (e) => e.code === 'EVIDENCE_UNKNOWN_REF');
  });

  test('a receipt that fails its re-check is refused before the tool acts', async () => {
    let acted = false;
    const { cwd } = makeRepo();
    await assert.rejects(() => tools.withEvidence('set_feature_status',
      { evidence: { kind: 'sha', repo: cwd, sha: 'deadbeef', at: AT(), by: BY } }, { feature: 'EVG-1', claim: 'X' },
      async () => { acted = true; }), (e) => e.code === 'EVIDENCE_REFUSED');
    assert.equal(acted, false);
  });
});

describe('withEvidence stores the receipt only after the tool succeeded', () => {
  test('success → stored with the server-filled subject and returned as evidence_id; citing the id keeps the id', async () => {
    const { cwd, sha } = makeRepo();
    const res = await tools.withEvidence('set_feature_status', { evidence: { kind: 'sha', repo: cwd, sha, at: AT(), by: BY } },
      { feature: 'EVG-2', claim: 'IN_PROGRESS' }, async () => ({ ok: true }));
    assert.match(res.evidence_id, /^ev:[0-9a-f]{16}$/);
    const rec = ev.readEvidence(res.evidence_id);
    assert.deepEqual(rec.subject, { tool: 'set_feature_status', feature: 'EVG-2', claim: 'IN_PROGRESS' });
    assert.equal(rec.evidence.sha, sha);
    const again = await tools.withEvidence('set_feature_status', { evidence: res.evidence_id }, { feature: 'EVG-2', claim: 'PARKED' },
      async () => ({ ok: true }));
    assert.equal(again.evidence_id, res.evidence_id, 'a cite keeps the id (fix r1, F1 (b)): it never mints a second record');
  });

  test('the tool throws → nothing stored', async () => {
    const { cwd, sha } = makeRepo();
    const before = existsSync(STORE) ? readFileSync(STORE, 'utf8') : '';
    await assert.rejects(() => tools.withEvidence('record_completion', { evidence: { kind: 'sha', repo: cwd, sha, at: AT(), by: BY } },
      { feature: 'EVG-3', claim: 'COMPLETE' }, async () => { throw new Error('gate refused'); }), /gate refused/);
    assert.equal(existsSync(STORE) ? readFileSync(STORE, 'utf8') : '', before);
  });

  test('capabilities.evidence false → the tool acts unchecked and ONE warning per process names it', async () => {
    ev._resetEvidenceWarning();
    const warned = [];
    const orig = console.warn;
    console.warn = (m) => warned.push(String(m));
    try {
      for (let i = 0; i < 2; i++) {
        const r = await tools.withEvidence('set_feature_status', {}, { feature: 'EVG-4' }, async () => 'acted',
          { config: { capabilities: { evidence: false } } });
        assert.equal(r, 'acted');
      }
    } finally { console.warn = orig; }
    assert.equal(warned.length, 1);
    assert.match(warned[0], /capabilities\.evidence is false .* UNCHECKED/);
  });

  test('approve_gate with revised or killed does not ask for a receipt', () => {
    assert.equal(tools.EVIDENCE_GATE_OUTCOMES.has('revised'), false);
    assert.equal(tools.EVIDENCE_GATE_OUTCOMES.has('killed'), false);
    assert.equal(tools.EVIDENCE_GATE_OUTCOMES.has('approved'), true);
  });
});

describe('the CLI and the read route', () => {
  test('the CLI records and shows a receipt, and exits 2 on a refused one (a non-MCP runner\'s path)', () => {
    const { cwd, sha } = makeRepo();
    const env = { ...process.env, COMPOSE_EVIDENCE_STORE: STORE };
    const cli = join(REPO_ROOT, 'lib', 'evidence-cli.js');
    const ok = spawnSync(process.execPath, [cli, 'record', JSON.stringify({ kind: 'sha', repo: cwd, sha, at: AT(), by: 'codex' })], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const id = JSON.parse(ok.stdout).evidence_id;
    const show = spawnSync(process.execPath, [cli, 'show', id], { env, encoding: 'utf8' });
    assert.equal(JSON.parse(show.stdout).evidence.by, 'codex');
    const bad = spawnSync(process.execPath, [cli, 'record', JSON.stringify({ kind: 'sha', repo: cwd, sha: 'feedface', at: AT(), by: 'codex' })], { env, encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.equal(JSON.parse(bad.stderr).code, 'EVIDENCE_REFUSED');
  });

  test('GET /api/evidence lists a feature\'s receipts, GET /api/evidence/:id reads one', async () => {
    const { attachEvidenceRoutes } = await import(`${REPO_ROOT}/server/evidence-routes.js`);
    const routes = {};
    attachEvidenceRoutes({ get: (p, h) => { routes[p] = h; } }, { storePath: STORE });
    const call = (p, req) => new Promise((done) => {
      const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { done({ code: this.code, body: b }); } };
      routes[p](req, res);
    });
    const list = await call('/api/evidence', { query: { feature: 'EVG-2' } });
    assert.ok(list.body.records.length >= 1);
    assert.equal(list.body.records[0].kind, 'sha');
    const one = await call('/api/evidence/:id', { params: { id: list.body.records[0].id } });
    assert.equal(one.body.id, list.body.records[0].id);
    assert.equal((await call('/api/evidence/:id', { params: { id: 'ev:0000000000000000' } })).code, 404);
    assert.equal((await call('/api/evidence', { query: {} })).code, 400);
  });
});
