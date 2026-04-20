import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CCSessionWatcher } from '../../server/cc-session-watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/cc-sessions');

let tmp;
let projectsRoot;
let sessionsFile;
let featureRoot;

function copyFx(src, destDir, asName) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, asName);
  fs.copyFileSync(path.join(FIXTURE_DIR, src), dest);
  return dest;
}

function writeSessions(records) {
  fs.writeFileSync(sessionsFile, JSON.stringify(records, null, 2));
}

function makeWatcher({ posts, broadcasts, itemMap, now = () => '2026-04-20T10:00:00Z' }) {
  return new CCSessionWatcher({
    projectsRoot,
    sessionsFile,
    featureRoot,
    findItemIdByFeatureCode: (fc) => itemMap[fc] || null,
    postBranchLineage: async (itemId, lineage) => { posts.push({ itemId, lineage }); },
    broadcastMessage: (msg) => broadcasts.push(msg),
    now,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-watcher-test-'));
  projectsRoot = path.join(tmp, 'cc-projects');
  sessionsFile = path.join(tmp, 'sessions.json');
  featureRoot = path.join(tmp, 'features');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(featureRoot, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('CCSessionWatcher — fullScan', () => {
  it('reads all sessions and emits one POST per bound feature', async () => {
    // Two different sessions bound to two different features
    copyFx('linear-session.jsonl', projectsRoot, 'sess-a.jsonl');
    copyFx('linear-session.jsonl', projectsRoot, 'sess-b.jsonl');
    writeSessions([
      { featureCode: 'FEAT-A', transcriptPath: '/cc/sess-a.jsonl' },
      { featureCode: 'FEAT-B', transcriptPath: '/cc/sess-b.jsonl' },
    ]);

    const posts = [], broadcasts = [];
    const w = makeWatcher({ posts, broadcasts, itemMap: { 'FEAT-A': 'item-A', 'FEAT-B': 'item-B' } });
    const res = await w.fullScan();

    assert.equal(res.files_scanned, 2);
    assert.deepEqual(res.features_touched.sort(), ['FEAT-A', 'FEAT-B']);
    assert.equal(posts.length, 2);
    assert.ok(posts.every(p => p.lineage.feature_code && p.lineage.last_scan_at));
  });

  it('unbound session skipped entirely; unbound_count bumped; no POST', async () => {
    copyFx('linear-session.jsonl', projectsRoot, 'orphan.jsonl');
    writeSessions([]); // no binding

    const posts = [], broadcasts = [];
    const w = makeWatcher({ posts, broadcasts, itemMap: {} });
    await w.fullScan();

    assert.equal(posts.length, 0);
    assert.equal(w.resolver.stats.unbound_count, 1);
  });

  it('feature with 2 sessions: lineage contains branches from BOTH (no overwrite)', async () => {
    const srcDir = path.join(FIXTURE_DIR, 'multi-session-same-feature');
    const files = fs.readdirSync(srcDir);
    for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(projectsRoot, f));

    writeSessions(
      files.map(f => ({
        featureCode: 'FEAT-MULTI',
        transcriptPath: `/cc/${f}`,
      }))
    );

    const posts = [], broadcasts = [];
    const w = makeWatcher({ posts, broadcasts, itemMap: { 'FEAT-MULTI': 'item-multi' } });
    await w.fullScan();

    assert.equal(posts.length, 1);
    const lineage = posts[0].lineage;
    assert.equal(lineage.feature_code, 'FEAT-MULTI');
    // Each fixture has at least one branch; aggregation must contain >= 2 total branches
    assert.ok(lineage.branches.length >= 2,
      `expected aggregated branches across sessions, got ${lineage.branches.length}`);
    const sessionIds = new Set(lineage.branches.map(b => b.cc_session_id));
    assert.ok(sessionIds.size >= 2, `branches from both sessions expected, saw ${sessionIds.size}`);
  });
});

describe('CCSessionWatcher — DecisionEvent emission + dedupe', () => {
  it('emits DecisionEvents only for NEW forks; re-scans do not replay', async () => {
    copyFx('forked-session-two-branches.jsonl', projectsRoot, 'fork.jsonl');
    writeSessions([{ featureCode: 'FEAT-FORK', transcriptPath: '/cc/fork.jsonl' }]);

    const posts = [], broadcasts = [];
    const w = makeWatcher({ posts, broadcasts, itemMap: { 'FEAT-FORK': 'item-fork' } });
    await w.fullScan();
    const firstEmit = broadcasts.filter(b => b.type === 'decisionEvent').length;
    assert.ok(firstEmit >= 2, `expected at least 2 decisionEvent emits for 2-branch fork, got ${firstEmit}`);

    broadcasts.length = 0;
    await w.fullScan();
    const replayed = broadcasts.filter(b => b.type === 'decisionEvent').length;
    assert.equal(replayed, 0, 'no DecisionEvent should replay after initial emission');
  });

  it('seedEmittedEventIds prevents initial emission on restart', async () => {
    copyFx('forked-session-two-branches.jsonl', projectsRoot, 'fork.jsonl');
    writeSessions([{ featureCode: 'FEAT-FORK', transcriptPath: '/cc/fork.jsonl' }]);

    // First run: collect emitted ids
    const posts1 = [], broadcasts1 = [];
    const w1 = makeWatcher({ posts: posts1, broadcasts: broadcasts1, itemMap: { 'FEAT-FORK': 'item-fork' } });
    await w1.fullScan();
    const persistedIds = posts1[0].lineage.emitted_event_ids;
    assert.ok(persistedIds.length >= 2);

    // Simulate restart: fresh watcher, seed from persisted ids
    const posts2 = [], broadcasts2 = [];
    const w2 = makeWatcher({ posts: posts2, broadcasts: broadcasts2, itemMap: { 'FEAT-FORK': 'item-fork' } });
    w2.seedEmittedEventIds('FEAT-FORK', persistedIds);
    await w2.fullScan();
    const restartEmits = broadcasts2.filter(b => b.type === 'decisionEvent').length;
    assert.equal(restartEmits, 0, 'seeded ids should suppress replay');
  });
});

describe('CCSessionWatcher — final_artifact feature-scope filter', () => {
  it('nulls out final_artifact whose path is not under docs/features/<feature_code>/', async () => {
    // Synthesize a tiny linear session that writes to a DIFFERENT feature folder.
    const sessionId = '99999999-9999-4999-8999-000000000001';
    const jsonlPath = path.join(projectsRoot, `${sessionId}.jsonl`);
    const lines = [
      { uuid: 'r', parentUuid: null, type: 'system', isSidechain: false, timestamp: '2026-04-20T10:00:00Z' },
      { uuid: 'u1', parentUuid: 'r', type: 'user', isSidechain: false, timestamp: '2026-04-20T10:00:01Z',
        message: { role: 'user', content: '[x]' } },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', isSidechain: false, timestamp: '2026-04-20T10:00:02Z',
        requestId: 'req-1',
        message: {
          role: 'assistant', stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'Edit', id: 't1', input: { file_path: 'docs/features/FEAT-OTHER/plan.md', new_string: 'x' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        } },
      { uuid: 'u2', parentUuid: 'a1', type: 'user', isSidechain: false, timestamp: '2026-04-20T10:00:03Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(jsonlPath, lines);

    writeSessions([{ featureCode: 'FEAT-TARGET', transcriptPath: `/cc/${sessionId}.jsonl` }]);

    const posts = [], broadcasts = [];
    const w = makeWatcher({ posts, broadcasts, itemMap: { 'FEAT-TARGET': 'item-target' } });
    await w.fullScan();

    assert.equal(posts.length, 1);
    const branch = posts[0].lineage.branches[0];
    assert.equal(branch.feature_code, 'FEAT-TARGET');
    assert.equal(branch.final_artifact, null,
      'artifact under docs/features/FEAT-OTHER/ must be nulled when feature_code is FEAT-TARGET');
  });

  it('keeps final_artifact whose path IS under docs/features/<feature_code>/', async () => {
    copyFx('linear-session.jsonl', projectsRoot, 'good.jsonl');
    writeSessions([{ featureCode: 'COMP-OBS-BRANCH', transcriptPath: '/cc/good.jsonl' }]);

    const posts = [], broadcasts = [];
    const w = makeWatcher({ posts, broadcasts, itemMap: { 'COMP-OBS-BRANCH': 'item-ok' } });
    await w.fullScan();

    const branch = posts[0].lineage.branches[0];
    assert.ok(branch.final_artifact, 'artifact should be kept when path matches feature scope');
    assert.ok(branch.final_artifact.path.includes('docs/features/COMP-OBS-BRANCH/'));
  });
});

describe('CCSessionWatcher — POST-before-broadcast ordering', () => {
  it('POST failure suppresses the DecisionEvent broadcast; retry on next scan emits it', async () => {
    copyFx('forked-session-two-branches.jsonl', projectsRoot, 'fork.jsonl');
    writeSessions([{ featureCode: 'FEAT-FORK', transcriptPath: '/cc/fork.jsonl' }]);

    const broadcasts = [];
    let shouldFail = true;
    const w = new (await import('../../server/cc-session-watcher.js')).CCSessionWatcher({
      projectsRoot,
      sessionsFile,
      featureRoot,
      findItemIdByFeatureCode: () => 'item-fork',
      postBranchLineage: async () => { if (shouldFail) throw new Error('simulated POST failure'); },
      broadcastMessage: (msg) => broadcasts.push(msg),
      now: () => '2026-04-20T10:00:00Z',
    });

    await w.fullScan();
    const firstRound = broadcasts.filter(b => b.type === 'decisionEvent').length;
    assert.equal(firstRound, 0, 'no DecisionEvent should broadcast when POST fails');

    // Retry scan with POST now succeeding
    shouldFail = false;
    await w.fullScan();
    const secondRound = broadcasts.filter(b => b.type === 'decisionEvent').length;
    assert.ok(secondRound >= 2,
      `events should replay and broadcast once POST succeeds, got ${secondRound}`);
  });
});

describe('CCSessionWatcher — in_progress_siblings', () => {
  it('running branches appear in lineage.in_progress_siblings; complete ones do not', async () => {
    copyFx('mid-progress-session.jsonl', projectsRoot, 'mp.jsonl');
    writeSessions([{ featureCode: 'FEAT-MP', transcriptPath: '/cc/mp.jsonl' }]);

    const posts = [], broadcasts = [];
    const w = makeWatcher({ posts, broadcasts, itemMap: { 'FEAT-MP': 'item-mp' } });
    await w.fullScan();

    const l = posts[0].lineage;
    const running = l.branches.filter(b => b.state === 'running');
    assert.equal(running.length, 1);
    assert.ok(l.in_progress_siblings.includes(running[0].branch_id));
    const complete = l.branches.find(b => b.state === 'complete');
    assert.ok(!l.in_progress_siblings.includes(complete.branch_id));
  });
});
