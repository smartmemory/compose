/**
 * COMP-DOGFOOD-EVIDENCE-GATE-1 fix r1 — a receipt backs only the claim it was
 * minted for, with the right kind (review-postland.md F1, F2 and QUESTION 1).
 * The first describe is the review's repros, verbatim in shape; the rest pin
 * the words table (contracts/evidence-words.json) row by row, the cite log and
 * the record check. Real git and real ps; only the clock is moved.
 */
import './helpers/git-env-scrub.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'evbind-'));
const STORE = join(SCRATCH, 'store', 'evidence.jsonl');
const TARGET = join(SCRATCH, 'workspace');
mkdirSync(join(TARGET, '.compose'), { recursive: true });
writeFileSync(join(TARGET, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { lifecycle: true } }));
process.env.COMPOSE_EVIDENCE_STORE = STORE;
process.env.COMPOSE_TARGET = TARGET;
delete process.env.COMPOSE_SESSION_NAME;

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
const ok = async () => ({ ok: true });

function makeRepo() {
  const cwd = mkdtempSync(join(SCRATCH, 'repo-'));
  const g = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(cwd, 'f.txt'), 'x');
  g('add', '.'); g('commit', '-q', '-m', 'init');
  return { cwd, g, sha: g('rev-parse', 'HEAD').stdout.trim() };
}

const shaReceipt = ({ cwd, sha }) => ({ kind: 'sha', repo: cwd, sha, at: AT(), by: BY });
const logFile = join(SCRATCH, 'run.log');
writeFileSync(logFile, 'start\nnode 12/12 pass\nend\n');
const logReceipt = () => ({ kind: 'log', path: logFile, line: '12/12 pass', at: AT(), by: BY });
const cmdReceipt = () => ({ kind: 'command', command: 'node --test', output_line: 'node 12/12', log: logFile, at: AT(), by: BY });
const storeLines = () => (existsSync(STORE) ? readFileSync(STORE, 'utf8').split('\n').filter(Boolean).length : 0);
const code = (c) => (e) => (e.code === c ? true : assert.fail(`expected ${c}, got ${e.code}: ${e.message}`));

describe('step 1: the review repros (F1, F2, QUESTION 1)', () => {
  test('F1 repro 1: a log receipt does not back a claim whose table row names other kinds', async () => {
    let acted = false;
    await assert.rejects(() => tools.withEvidence('set_feature_status', { evidence: logReceipt() },
      { feature: 'EB-1', claim: 'COMPLETE' }, async () => { acted = true; }), code('EVIDENCE_WRONG_KIND'));
    assert.equal(acted, false);
  });

  test('F1 repro 2: an id minted for FEAT-A is refused for FEAT-B, and nothing new is stored', async () => {
    const a = await tools.withEvidence('record_completion', { evidence: shaReceipt(makeRepo()) },
      { feature: 'EB-FEAT-A', claim: 'COMPLETE' }, ok);
    const before = storeLines();
    await assert.rejects(() => tools.withEvidence('approve_gate', { evidence: a.evidence_id },
      { gate: 'g-1', outcome: 'approved', feature: 'EB-FEAT-B' }, ok), code('EVIDENCE_SUBJECT_MISMATCH'));
    assert.equal(storeLines(), before);
  });

  test('F1 repro 2 (cite keeps id): the same subject cites the original id, never a new one', async () => {
    const a = await tools.withEvidence('record_completion', { evidence: shaReceipt(makeRepo()) },
      { feature: 'EB-KEEP', claim: 'COMPLETE' }, ok);
    const before = storeLines();
    const again = await tools.withEvidence('complete_feature', { evidence: a.evidence_id }, { feature: 'EB-KEEP', claim: 'COMPLETE' }, ok);
    assert.equal(again.evidence_id, a.evidence_id);
    assert.equal(storeLines(), before, 'a cite mints no record');
    const cites = readFileSync(ev.citesPath(STORE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(cites.filter((c) => c.cites === a.evidence_id).map((c) => [c.tool, c.subject.feature, c.subject.claim]),
      [['complete_feature', 'EB-KEEP', 'COMPLETE']]);
  });

  test('F1 repro 3: a hand-appended {"id"} line is unknown to readEvidence and refused on cite', async () => {
    const id = 'ev:1111111111111111';
    mkdirSync(dirname(STORE), { recursive: true });
    appendFileSync(STORE, JSON.stringify({ id }) + '\n');
    assert.equal(ev.readEvidence(id), null);
    await assert.rejects(() => tools.withEvidence('complete_feature', { evidence: id }, { feature: 'EB-3', claim: 'COMPLETE' }, ok),
      code('EVIDENCE_UNKNOWN_REF'));
  });

  test('F2: a file receipt claiming an observation in 2000 is refused (now - at is bounded)', () => {
    const r = ev.verifyEvidence({ kind: 'file', path: join(REPO_ROOT, 'package.json'), line: '"name"', at: '2000-01-01T00:00:00Z', by: BY });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(' | '), /observed at 2000-01-01T00:00:00Z, more than 15 min before the check/);
  });

  test('F2: a sha that is not on the repo\'s default branch is refused', () => {
    const repo = makeRepo();
    repo.g('checkout', '-q', '-b', 'side');
    writeFileSync(join(repo.cwd, 'g.txt'), 'y');
    repo.g('add', '.'); repo.g('commit', '-q', '-m', 'side');
    const side = repo.g('rev-parse', 'HEAD').stdout.trim();
    const r = ev.verifyEvidence({ kind: 'sha', repo: repo.cwd, sha: side, at: AT(), by: BY });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /is not on the default branch \(main\)/);
    assert.equal(ev.verifyEvidence({ kind: 'sha', repo: repo.cwd, sha: repo.sha, at: AT(), by: BY }).ok, true, 'the main commit passes');
  });

  test('F2: pid 1 labelled seat-equalize is refused (the command does not name the label)', () => {
    const p = ev.psProbe(1);
    assert.equal(p.alive, true);
    const r = ev.verifyEvidence({ kind: 'process', pid: 1, launched_at: new Date(p.startedAt).toISOString(), label: 'seat-equalize', at: AT(), by: BY });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(' | '), /pid 1 runs .* which does not contain the label seat-equalize/);
  });

  test('QUESTION 1 (a): set_feature_status PLANNED to IN_PROGRESS needs no receipt; COMPLETE does', async () => {
    await tools.toolAddRoadmapEntry({ code: 'EB-Q1', description: 'q1 row', phase: 'Phase 1' });
    const r = await tools.toolSetFeatureStatus({ code: 'EB-Q1', status: 'IN_PROGRESS' });
    assert.equal(r.evidence_id, undefined);
    await assert.rejects(() => tools.toolSetFeatureStatus({ code: 'EB-Q1', status: 'COMPLETE' }), code('EVIDENCE_REQUIRED'));
  });
});

describe('the words table (contracts/evidence-words.json): one row each, a right kind passes and a wrong one is refused', () => {
  const KINDS = ['sha', 'process', 'file', 'log', 'screenshot', 'command', 'pixel'];
  const rows = {
    RUNNING: ['process'], LANDED: ['sha'], DEPLOYED: ['sha'], COMPLETE: ['sha', 'command'],
    READY: KINDS, CLEAN: KINDS, DONE: KINDS,
  };
  test('the table holds exactly these rows', () => {
    assert.deepEqual(Object.keys(ev.loadEvidenceWords().words).sort(), Object.keys(rows).sort());
  });
  for (const [word, kinds] of Object.entries(rows)) {
    test(`${word}: ${kinds.length === KINDS.length ? 'any kind' : kinds.join(' or ')}`, () => {
      for (const k of KINDS) assert.equal(ev.kindBacks(word, k), kinds.includes(k), `${word} ${k}`);
    });
  }
  test('a claim with no row (evidence-only, a gate approval) takes any kind', () => {
    for (const k of KINDS) assert.equal(ev.kindBacks('evidence-only', k), true);
    assert.equal(ev.kindBacks(undefined, 'log'), true);
  });
  test('COMPLETE through a tool: a command receipt passes, a log receipt is refused', async () => {
    const r = await tools.withEvidence('record_completion', { evidence: cmdReceipt() }, { feature: 'EB-T', claim: 'COMPLETE' }, ok);
    assert.match(r.evidence_id, /^ev:[0-9a-f]{16}$/);
    await assert.rejects(() => tools.withEvidence('record_completion', { evidence: logReceipt() }, { feature: 'EB-T', claim: 'COMPLETE' }, ok),
      (e) => e.code === 'EVIDENCE_WRONG_KIND' && /COMPLETE takes sha or command, not log/.test(e.message));
  });
});

describe('RUNNING on cite: re-verified, and checked within 15 min', () => {
  const procRecord = (pid, startedAt, label, checkedAt) => ({
    id: 'ev:aaaaaaaaaaaaaaaa', checked_at: new Date(checkedAt).toISOString(), checks: [],
    evidence: { kind: 'process', pid, launched_at: new Date(startedAt).toISOString(), label, at: AT(), by: BY },
  });
  test('a live pid whose command names the label passes; 16 min after the check it is stale; a dead pid fails', async () => {
    const child = spawn('/bin/sleep', ['61'], { stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 150));
    const p = ev.psProbe(child.pid);
    const now = p.startedAt + 130_000;
    const fresh = procRecord(child.pid, p.startedAt, 'sleep', now - 60_000);
    assert.deepEqual(ev.checkCite(fresh, 'RUNNING', { now }).ok, true, JSON.stringify(ev.checkCite(fresh, 'RUNNING', { now })));
    const stale = ev.checkCite(procRecord(child.pid, p.startedAt, 'sleep', now - 16 * 60_000), 'RUNNING', { now });
    assert.equal(stale.code, 'EVIDENCE_STALE');
    assert.match(stale.reasons[0], /checked .* ago; RUNNING takes a receipt checked within 15 min/);
    const r = ev.checkCite(procRecord(child.pid, p.startedAt, 'sleep', now - 60_000), 'RUNNING', { now, ps: () => ({ alive: false }) });
    assert.equal(r.code, 'EVIDENCE_REFUSED');
  });
});

describe('records are validated; a subject-less record is cited only by its own session', () => {
  test('recordEvidence refuses to write a record that would not validate (unknown subject key)', () => {
    const before = storeLines();
    assert.throws(() => ev.recordEvidence(logReceipt(), { subject: { unit: 'X', claim: 'DONE', note: 'y' } }), code('EVIDENCE_INVALID'));
    assert.equal(storeLines(), before);
  });

  test('a record_evidence subject {unit, claim} is a valid record, and its unit binds the cite', async () => {
    const rec = ev.recordEvidence(logReceipt(), { subject: { unit: 'EB-UNIT-1', claim: 'DONE' } });
    assert.ok(ev.readEvidence(rec.id));
    await assert.rejects(() => tools.withEvidence('approve_gate', { evidence: rec.id }, { gate: 'g', outcome: 'approved', feature: 'EB-OTHER' }, ok),
      code('EVIDENCE_SUBJECT_MISMATCH'));
    const r = await tools.withEvidence('approve_gate', { evidence: rec.id }, { gate: 'g', outcome: 'approved', feature: 'EB-UNIT-1' }, ok);
    assert.equal(r.evidence_id, rec.id);
  });

  test('a CLI record (no subject, by codex): refused for an unnamed caller and for s2-coord, accepted for codex', async () => {
    const stored = ev.recordEvidence({ ...cmdReceipt(), by: 'codex' }, {});
    const cite = () => tools.withEvidence('complete_feature', { evidence: stored.id }, { feature: 'EB-CLI', claim: 'COMPLETE' }, ok);
    await assert.rejects(cite, (e) => e.code === 'EVIDENCE_SUBJECT_MISMATCH' && /COMPOSE_SESSION_NAME is unset/.test(e.message));
    process.env.COMPOSE_SESSION_NAME = 's2-coord';
    try {
      await assert.rejects(cite, (e) => e.code === 'EVIDENCE_SUBJECT_MISMATCH' && /by codex; this caller is s2-coord/.test(e.message));
      process.env.COMPOSE_SESSION_NAME = 'codex';
      assert.equal((await cite()).evidence_id, stored.id);
    } finally { delete process.env.COMPOSE_SESSION_NAME; }
  });
});

describe('tool defs: evidence is required by status, not statically, for set_feature_status', () => {
  test('set_feature_status does not list evidence as required; record_completion and complete_feature still do', () => {
    const req = (n) => TOOLS.find((d) => d.name === n).inputSchema.required;
    assert.equal(req('set_feature_status').includes('evidence'), false);
    assert.equal(req('record_completion').includes('evidence'), true);
    assert.equal(req('complete_feature').includes('evidence'), true);
  });
});
