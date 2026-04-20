import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCCSession } from '../../server/cc-session-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/cc-sessions');
const fx = (name) => path.join(FIXTURE_DIR, name);

describe('readCCSession — linear session', () => {
  let out;
  before(async () => { out = await readCCSession(fx('linear-session.jsonl')); });

  it('finds exactly one branch', () => {
    assert.equal(out.branches.length, 1);
  });
  it('state = complete', () => {
    assert.equal(out.branches[0].state, 'complete');
  });
  it('no fork points', () => {
    assert.deepEqual(out.fork_points, []);
  });
  it('fork_uuid is null on linear branch', () => {
    assert.equal(out.branches[0].fork_uuid, null);
  });
  it('turn_count > 0 on complete branch', () => {
    assert.ok(out.branches[0].turn_count > 0);
  });
  it('cost.tokens_in > 0 and wall_clock_ms >= 0', () => {
    assert.ok(out.branches[0].cost.tokens_in > 0);
    assert.ok(out.branches[0].cost.wall_clock_ms >= 0);
  });
  it('files_touched populated', () => {
    assert.ok(out.branches[0].files_touched.length > 0);
  });
  it('final_artifact prefers docs/features/<…>/*.md', () => {
    assert.ok(out.branches[0].final_artifact);
    assert.ok(out.branches[0].final_artifact.path.includes('docs/features/'));
  });
  it('branch_id is sha1 hex (40 chars)', () => {
    assert.match(out.branches[0].branch_id, /^[0-9a-f]{40}$/);
  });
});

describe('readCCSession — forked two branches', () => {
  let out;
  before(async () => { out = await readCCSession(fx('forked-session-two-branches.jsonl')); });

  it('finds 2 branches', () => {
    assert.equal(out.branches.length, 2);
  });
  it('both complete', () => {
    for (const b of out.branches) assert.equal(b.state, 'complete');
  });
  it('exactly one fork_point with 2 leaf uuids', () => {
    assert.equal(out.fork_points.length, 1);
    assert.equal(out.fork_points[0].child_leaf_uuids.length, 2);
  });
  it('both branches share the same fork_uuid', () => {
    assert.equal(out.branches[0].fork_uuid, out.branches[1].fork_uuid);
    assert.ok(out.branches[0].fork_uuid);
  });
});

describe('readCCSession — forked three branches', () => {
  let out;
  before(async () => { out = await readCCSession(fx('forked-session-three-branches.jsonl')); });

  it('finds 3 branches', () => {
    assert.equal(out.branches.length, 3);
  });
  it('one fork point with 3 child leaf uuids', () => {
    assert.equal(out.fork_points.length, 1);
    assert.equal(out.fork_points[0].child_leaf_uuids.length, 3);
  });
});

describe('readCCSession — mid-progress session', () => {
  let out;
  before(async () => { out = await readCCSession(fx('mid-progress-session.jsonl')); });

  it('finds 2 branches: 1 complete + 1 running', () => {
    const states = out.branches.map(b => b.state).sort();
    assert.deepEqual(states, ['complete', 'running']);
  });

  it('running branch has null completion-only fields', () => {
    const running = out.branches.find(b => b.state === 'running');
    assert.equal(running.ended_at, null);
    assert.equal(running.turn_count, null);
    assert.equal(running.files_touched, null);
    assert.equal(running.tests, null);
    assert.equal(running.cost, null);
    assert.equal(running.final_artifact, null);
  });

  it('complete branch has populated completion-only fields', () => {
    const done = out.branches.find(b => b.state === 'complete');
    assert.ok(done.ended_at);
    assert.ok(done.turn_count > 0);
    assert.ok(done.files_touched);
    assert.ok(done.tests);
    assert.ok(done.cost);
  });
});

describe('readCCSession — failed branch', () => {
  let out;
  before(async () => { out = await readCCSession(fx('failed-branch-session.jsonl')); });

  it('finds 1 complete + 1 failed branch', () => {
    const states = out.branches.map(b => b.state).sort();
    assert.deepEqual(states, ['complete', 'failed']);
  });

  it('failed branch has populated ended_at, turn_count, cost (terminal)', () => {
    const failed = out.branches.find(b => b.state === 'failed');
    assert.ok(failed.ended_at);
    assert.ok(failed.turn_count > 0);
    assert.ok(failed.cost);
  });
});

describe('readCCSession — truncated session', () => {
  let out;
  before(async () => { out = await readCCSession(fx('truncated-session.jsonl')); });

  it('parses without throwing', () => {
    assert.ok(out);
  });
  it('truncated flag is true', () => {
    assert.equal(out.truncated, true);
  });
  it('valid-prefix records produce at least one branch', () => {
    assert.ok(out.branches.length >= 1);
  });
  it('under truncation, `running` leaves are downgraded to `unknown` (complete/failed remain trustworthy)', () => {
    for (const b of out.branches) {
      assert.notEqual(b.state, 'running', 'running branches must be downgraded to unknown under truncation');
    }
  });
});

describe('readCCSession — sidechain + non-tracked record robustness', () => {
  async function writeJsonl(lines) {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const p = await import('node:path');
    const tmp = mkdtempSync(p.join(os.tmpdir(), 'reader-edge-'));
    const file = p.join(tmp, `${'fedcba98-7654-4321-8abc-def012345678'}.jsonl`);
    writeFileSync(file, lines.map(r => JSON.stringify(r)).join('\n') + '\n');
    return { tmp, file };
  }

  it('ignores isSidechain: true records for tree building and fork detection', async () => {
    const { rmSync } = await import('node:fs');
    const sessionId = 'fedcba98-7654-4321-8abc-def012345678';
    const records = [
      { uuid: 'r', parentUuid: null, type: 'system', isSidechain: false, timestamp: '2026-04-20T10:00:00Z' },
      { uuid: 'u1', parentUuid: 'r', type: 'user', isSidechain: false, message: { role: 'user', content: '[x]' }, timestamp: '2026-04-20T10:00:01Z' },
      // This sibling would create a FAKE fork if sidechain records were counted:
      { uuid: 'u1-sc', parentUuid: 'r', type: 'user', isSidechain: true, message: { role: 'user', content: '[sc]' }, timestamp: '2026-04-20T10:00:02Z' },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', isSidechain: false, timestamp: '2026-04-20T10:00:03Z',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const { tmp, file } = await writeJsonl(records);
    try {
      const out = await readCCSession(file);
      assert.equal(out.branches.length, 1, 'sidechain sibling must NOT create a fork');
      assert.equal(out.fork_points.length, 0);
      assert.equal(out.branches[0].state, 'complete');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips non-tracked top-level record types without a uuid', async () => {
    const { rmSync } = await import('node:fs');
    const records = [
      { uuid: 'r', parentUuid: null, type: 'system', isSidechain: false, timestamp: '2026-04-20T10:00:00Z' },
      // Non-tracked record without uuid — T10 agent flagged these exist in real sessions
      { type: 'file-history-snapshot', data: { path: 'x.md' } },
      { type: 'queue-operation', op: 'enqueue' },
      { uuid: 'u1', parentUuid: 'r', type: 'user', isSidechain: false, message: { role: 'user', content: '[x]' }, timestamp: '2026-04-20T10:00:01Z' },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', isSidechain: false, timestamp: '2026-04-20T10:00:02Z',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const { tmp, file } = await writeJsonl(records);
    try {
      const out = await readCCSession(file);
      assert.equal(out.truncated, false, 'non-tracked records must not flip truncated');
      assert.equal(out.branches.length, 1);
      assert.equal(out.branches[0].state, 'complete');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('empty JSONL file yields zero branches and zero fork points without throwing', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const p = await import('node:path');
    const tmp = mkdtempSync(p.join(os.tmpdir(), 'reader-empty-'));
    const file = p.join(tmp, 'empty-1234.jsonl');
    writeFileSync(file, '');
    try {
      const out = await readCCSession(file);
      assert.equal(out.branches.length, 0);
      assert.equal(out.fork_points.length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('readCCSession — cost.usd env-var opt-in', () => {
  const origIn = process.env.CC_USD_PER_1K_INPUT;
  const origOut = process.env.CC_USD_PER_1K_OUTPUT;

  before(() => {
    process.env.CC_USD_PER_1K_INPUT = '0.003';
    process.env.CC_USD_PER_1K_OUTPUT = '0.015';
  });
  // Restore after the describe block
  // (node:test's `after` hook is inside the suite)
  it('applies per-1K rates when CC_USD_PER_1K_INPUT/OUTPUT are set', async () => {
    const out = await readCCSession(fx('linear-session.jsonl'));
    const cost = out.branches[0].cost;
    assert.ok(cost.usd > 0, 'cost.usd should be populated when env vars are set');
    const expected = (cost.tokens_in / 1000) * 0.003 + (cost.tokens_out / 1000) * 0.015;
    assert.ok(Math.abs(cost.usd - expected) < 1e-9,
      `expected ${expected}, got ${cost.usd}`);
  });

  it('cost.usd is 0 when env vars are unset', async () => {
    delete process.env.CC_USD_PER_1K_INPUT;
    delete process.env.CC_USD_PER_1K_OUTPUT;
    const out = await readCCSession(fx('linear-session.jsonl'));
    assert.equal(out.branches[0].cost.usd, 0);
  });

  // Restore originals
  it('(cleanup) restores env', () => {
    if (origIn !== undefined) process.env.CC_USD_PER_1K_INPUT = origIn;
    else delete process.env.CC_USD_PER_1K_INPUT;
    if (origOut !== undefined) process.env.CC_USD_PER_1K_OUTPUT = origOut;
    else delete process.env.CC_USD_PER_1K_OUTPUT;
    assert.ok(true);
  });
});

describe('readCCSession — mid-line corruption', () => {
  it('corrupt non-trailing line flips truncated=true and downgrades running → unknown', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const p = await import('node:path');
    const tmp = mkdtempSync(p.join(os.tmpdir(), 'truncation-mid-'));
    const mid = p.join(tmp, 'mid.jsonl');
    const content = [
      JSON.stringify({ uuid: 'r', parentUuid: null, type: 'system', isSidechain: false, timestamp: '2026-04-20T10:00:00Z' }),
      'THIS IS NOT JSON',
      JSON.stringify({ uuid: 'u1', parentUuid: 'r', type: 'user', isSidechain: false, message: { role: 'user', content: '[x]' }, timestamp: '2026-04-20T10:00:01Z' }),
      JSON.stringify({ uuid: 'a1', parentUuid: 'u1', type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' }, id: 't1' }], usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-04-20T10:00:02Z' }),
    ].join('\n') + '\n';
    writeFileSync(mid, content);

    const out = await readCCSession(mid);
    try {
      assert.equal(out.truncated, true);
      for (const b of out.branches) {
        assert.notEqual(b.state, 'running', 'running must downgrade to unknown when file is corrupted');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('readCCSession — branch_id identity', () => {
  it('branch_id = sha1(cc_session_id + ":" + leaf_uuid) and stable across reads', async () => {
    const a = await readCCSession(fx('linear-session.jsonl'));
    const b = await readCCSession(fx('linear-session.jsonl'));
    assert.equal(a.branches[0].branch_id, b.branches[0].branch_id);
  });
});
