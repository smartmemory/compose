/**
 * completion-writer.test.js — coverage for lib/completion-writer.js
 * (COMP-MCP-COMPLETION T1–T4).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, existsSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { recordCompletion, getCompletions } from '../lib/completion-writer.js';
import { readFeature, writeFeature } from '../lib/feature-json.js';
import { readEvents } from '../lib/feature-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FULL_SHA_A = 'a'.repeat(40);
const FULL_SHA_B = 'b'.repeat(40);
const FULL_SHA_C = 'c'.repeat(40);

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'completion-writer-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

function seedFeature(cwd, feature) {
  writeFeature(cwd, {
    created: '2026-05-02',
    updated: '2026-05-02',
    phase: 'Phase 1',
    position: 1,
    description: 'test feature',
    ...feature,
  });
}

// Sabotage ROADMAP.md by creating a directory at that path, so writeRoadmap
// will throw EISDIR (mirrors feature-writer.test.js pattern for test #11b).
function sabotageRoadmap(cwd) {
  const roadmapPath = join(cwd, 'ROADMAP.md');
  mkdirSync(roadmapPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// T1 — Validation + new-record append
// ---------------------------------------------------------------------------

describe('T1 — validation', () => {
  test('#1a bad feature_code throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    const err = await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'lowercase-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1b SHA shorter than 40 chars rejected: 7-char', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: 'abc1234',
        tests_pass: true, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1c SHA shorter than 40 chars rejected: 8-char', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: 'abcdef12',
        tests_pass: true, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1d SHA shorter than 40 chars rejected: 39-char', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: 'a'.repeat(39),
        tests_pass: true, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1e SHA non-hex throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: 'z'.repeat(40),
        tests_pass: true, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1f SHA empty string throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: '',
        tests_pass: true, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1g SHA not a string throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: 123,
        tests_pass: true, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1h tests_pass string "true" throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: 'true', files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1i tests_pass number 1 throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: 1, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1j files_changed not array throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: 'foo.js',
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1k files_changed entry non-string throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [42],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1l files_changed entry empty string throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [''],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1m files_changed entry with NUL throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: ['foo\0bar'],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1n files_changed entry absolute path throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: ['/etc/passwd'],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1o files_changed entry ".." escape throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: ['../foo'],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1p files_changed entry not normalized throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: ['./a/b'],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1q files_changed entry backslash throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: ['a\\b'],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1r notes non-string throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [], notes: 42,
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1s set_status non-boolean throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [], set_status: 'yes',
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#1t force non-boolean throws INVALID_INPUT', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [], force: 1,
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#2 FEATURE_NOT_FOUND when feature.json missing', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'MISSING-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [],
        set_status: false,
      }),
      e => e.code === 'FEATURE_NOT_FOUND'
    );
  });

  test('#3 deterministic completion_id = <CODE>:<full-40-char-sha>', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1',
      commit_sha: FULL_SHA_A,
      tests_pass: true,
      files_changed: [],
      set_status: false,
    });
    assert.equal(result.completion_id, `CODE-1:${FULL_SHA_A}`);
    assert.equal(result.commit_sha, FULL_SHA_A);
    assert.equal(result.commit_sha_short, FULL_SHA_A.slice(0, 8));
  });

  test('#3 SHA case-normalized to lowercase, whitespace trimmed', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const mixedSha = 'A'.repeat(40);
    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1',
      commit_sha: `  ${mixedSha}  `,
      tests_pass: true,
      files_changed: [],
      set_status: false,
    });
    const expectedSha = 'a'.repeat(40);
    assert.equal(result.commit_sha, expectedSha);
    assert.equal(result.completion_id, `CODE-1:${expectedSha}`);
  });

  test('#4 new-record append: pristine feature → array length 1, all required fields', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1',
      commit_sha: FULL_SHA_A,
      tests_pass: true,
      files_changed: ['src/foo.js', 'src/bar.js'],
      notes: 'clean ship',
      set_status: false,
    });
    assert.equal(result.idempotent, false);
    assert.equal(result.feature_code, 'CODE-1');

    const feature = readFeature(cwd, 'CODE-1');
    assert.ok(Array.isArray(feature.completions));
    assert.equal(feature.completions.length, 1);
    const rec = feature.completions[0];
    assert.equal(rec.completion_id, `CODE-1:${FULL_SHA_A}`);
    assert.equal(rec.feature_code, 'CODE-1');
    assert.equal(rec.commit_sha, FULL_SHA_A);
    assert.equal(rec.commit_sha_short, FULL_SHA_A.slice(0, 8));
    assert.equal(rec.tests_pass, true);
    assert.deepEqual(rec.files_changed, ['src/foo.js', 'src/bar.js']);
    assert.equal(rec.notes, 'clean ship');
    assert.ok(typeof rec.recorded_at === 'string');
    assert.ok(typeof rec.recorded_by === 'string');
  });

  test('#4 recorded_by reflects COMPOSE_ACTOR env', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const original = process.env.COMPOSE_ACTOR;
    process.env.COMPOSE_ACTOR = 'test:actor';
    try {
      await recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [], set_status: false,
      });
      const feature = readFeature(cwd, 'CODE-1');
      assert.equal(feature.completions[0].recorded_by, 'test:actor');
    } finally {
      if (original === undefined) delete process.env.COMPOSE_ACTOR;
      else process.env.COMPOSE_ACTOR = original;
    }
  });

  test('#5 multi-completion same feature: two distinct SHAs → length 2 in insertion order', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_B,
      tests_pass: false, files_changed: [], set_status: false,
    });
    const feature = readFeature(cwd, 'CODE-1');
    assert.equal(feature.completions.length, 2);
    assert.equal(feature.completions[0].commit_sha, FULL_SHA_A);
    assert.equal(feature.completions[1].commit_sha, FULL_SHA_B);
  });
});

// ---------------------------------------------------------------------------
// T2 — Idempotency + force replace + audit
// ---------------------------------------------------------------------------

describe('T2 — idempotency + force + audit', () => {
  test('#6 idempotent dedup (force=false): no array growth, no audit row', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    const eventsBefore = readEvents(cwd, { tool: 'record_completion' });

    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    assert.equal(result.idempotent, true);
    assert.equal(result.status_changed, null);

    const feature = readFeature(cwd, 'CODE-1');
    assert.equal(feature.completions.length, 1);

    const eventsAfter = readEvents(cwd, { tool: 'record_completion' });
    assert.equal(eventsAfter.length, eventsBefore.length, 'no new audit row on no-op');
  });

  test('#7 force replace: updates record in place, preserves array order, updates recorded_at', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    // Write two records
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: ['a.js'], notes: 'original', set_status: false,
    });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_B,
      tests_pass: true, files_changed: [], set_status: false,
    });

    // Small delay to ensure recorded_at differs
    await new Promise(r => setTimeout(r, 5));

    // Force-replace the first record
    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: false, files_changed: ['a.js', 'b.js'], notes: 'updated',
      force: true, set_status: false,
    });
    assert.equal(result.idempotent, false);

    const feature = readFeature(cwd, 'CODE-1');
    // Array order preserved: A is still index 0
    assert.equal(feature.completions.length, 2);
    assert.equal(feature.completions[0].commit_sha, FULL_SHA_A);
    assert.equal(feature.completions[0].tests_pass, false);
    assert.equal(feature.completions[0].notes, 'updated');
    assert.deepEqual(feature.completions[0].files_changed, ['a.js', 'b.js']);

    // Audit row carries force: true
    const events = readEvents(cwd, { tool: 'record_completion' });
    const forceEvent = events.find(e => e.force === true);
    assert.ok(forceEvent, 'audit row with force:true should exist');
  });

  test('#8 caller idempotency_key replay returns cached, no second mutation', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const r1 = await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [],
      set_status: false, idempotency_key: 'key-abc-123',
    });
    const r2 = await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [],
      set_status: false, idempotency_key: 'key-abc-123',
    });
    assert.deepEqual(r1, r2, 'replay returns identical result');
    const feature = readFeature(cwd, 'CODE-1');
    assert.equal(feature.completions.length, 1, 'no second record');
  });

  test('#16 audit not appended on idempotent no-op', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    const count1 = readEvents(cwd).length;
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    const count2 = readEvents(cwd).length;
    assert.equal(count2, count1, 'event count must not grow on idempotent no-op');
  });
});

// ---------------------------------------------------------------------------
// T3 — Status-flip integration
// ---------------------------------------------------------------------------

describe('T3 — status-flip', () => {
  test('#9 set_status: true happy path: PLANNED → COMPLETE', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [],
      set_status: true,
    });
    assert.deepEqual(result.status_changed, { from: 'PLANNED', to: 'COMPLETE' });
    assert.equal(result.status_flip_partial, false);

    const feature = readFeature(cwd, 'CODE-1');
    assert.equal(feature.status, 'COMPLETE');

    // Both record_completion and set_feature_status audit rows present
    const events = readEvents(cwd);
    assert.ok(events.some(e => e.tool === 'record_completion'), 'record_completion event');
    assert.ok(events.some(e => e.tool === 'set_feature_status'), 'set_feature_status event');
  });

  test('#10 set_status: true already COMPLETE: no setFeatureStatus call, status_changed: null', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'COMPLETE' });
    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [],
      set_status: true,
    });
    assert.equal(result.status_changed, null);

    const events = readEvents(cwd);
    assert.ok(!events.some(e => e.tool === 'set_feature_status'), 'no set_feature_status audit row');
    assert.ok(events.some(e => e.tool === 'record_completion'), 'record_completion audit row present');
  });

  test('#11 set_status: true from KILLED: completion persists, throws STATUS_FLIP_AFTER_COMPLETION_RECORDED', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'KILLED' });

    let thrown;
    try {
      await recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [],
        set_status: true,
      });
      assert.fail('should have thrown');
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'should throw');
    assert.equal(thrown.code, 'STATUS_FLIP_AFTER_COMPLETION_RECORDED');
    assert.ok(thrown.cause, 'should have err.cause');
    assert.match(thrown.cause.message, /invalid transition|KILLED/i);

    // On-disk completion record IS persisted
    const feature = readFeature(cwd, 'CODE-1');
    assert.ok(Array.isArray(feature.completions) && feature.completions.length > 0,
      'completion record must be persisted even after flip failure');

    // Status is still KILLED (not flipped)
    assert.equal(feature.status, 'KILLED');

    // No set_feature_status audit row
    const events = readEvents(cwd);
    assert.ok(!events.some(e => e.tool === 'set_feature_status'), 'no set_feature_status audit row');
  });

  test('#11b ROADMAP_PARTIAL_WRITE subcase: status flips but ROADMAP regen fails', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    // Sabotage ROADMAP.md so writeRoadmap throws EISDIR
    sabotageRoadmap(cwd);

    let thrown;
    try {
      await recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [],
        set_status: true,
      });
      assert.fail('should have thrown');
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'should throw');
    assert.equal(thrown.code, 'STATUS_FLIP_AFTER_COMPLETION_RECORDED');
    assert.ok(thrown.cause, 'should have err.cause');
    assert.equal(thrown.cause.code, 'ROADMAP_PARTIAL_WRITE', 'cause.code must be ROADMAP_PARTIAL_WRITE');

    // On-disk: completion IS persisted
    const feature = readFeature(cwd, 'CODE-1');
    assert.ok(Array.isArray(feature.completions) && feature.completions.length > 0,
      'completion record must be persisted');

    // On-disk: status DID flip to COMPLETE (the partial write scenario)
    assert.equal(feature.status, 'COMPLETE', 'status must have been flipped before ROADMAP failed');

    // Error message names the partial subcase
    assert.match(thrown.message, /ROADMAP_PARTIAL_WRITE/);
  });

  test('#12 set_status: false: status untouched, status_changed: null, no set_feature_status row', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'IN_PROGRESS' });
    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [],
      set_status: false,
    });
    assert.equal(result.status_changed, null);

    const feature = readFeature(cwd, 'CODE-1');
    assert.equal(feature.status, 'IN_PROGRESS');

    const events = readEvents(cwd);
    assert.ok(!events.some(e => e.tool === 'set_feature_status'));
  });

  test('#13 SHA full-form mixed-case → normalized lowercase, commit_sha_short is first 8', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const mixedSha = 'A'.repeat(40);
    const result = await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: mixedSha,
      tests_pass: true, files_changed: [], set_status: false,
    });
    assert.equal(result.commit_sha, 'a'.repeat(40));
    assert.equal(result.commit_sha_short, 'a'.repeat(8));
  });

  test('#13b SHA short-form rejected on write (8 chars)', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await assert.rejects(
      () => recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: 'abcdef12',
        tests_pass: true, files_changed: [],
      }),
      e => e.code === 'INVALID_INPUT'
    );
  });
});

// ---------------------------------------------------------------------------
// T4 — getCompletions + concurrency
// ---------------------------------------------------------------------------

describe('T4 — getCompletions', () => {
  test('#14a feature_code filter', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    seedFeature(cwd, { code: 'CODE-2', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    await recordCompletion(cwd, {
      feature_code: 'CODE-2', commit_sha: FULL_SHA_B,
      tests_pass: true, files_changed: [], set_status: false,
    });
    const result = getCompletions(cwd, { feature_code: 'CODE-1' });
    assert.equal(result.count, 1);
    assert.equal(result.completions[0].feature_code, 'CODE-1');
  });

  test('#14b commit_sha short prefix filter (≥4 chars, permissive at read time)', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    const result = getCompletions(cwd, { commit_sha: FULL_SHA_A.slice(0, 7) });
    assert.equal(result.count, 1);
  });

  test('#14c commit_sha full filter', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    const result = getCompletions(cwd, { commit_sha: FULL_SHA_A });
    assert.equal(result.count, 1);
    assert.equal(result.completions[0].commit_sha, FULL_SHA_A);
  });

  test('#14d since shorthand "7d" filter', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    const result = getCompletions(cwd, { since: '7d' });
    assert.ok(result.count >= 1);
  });

  test('#14e since ISO date filter', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    // filter since yesterday
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const result = getCompletions(cwd, { since: yesterday });
    assert.ok(result.count >= 1);
  });

  test('#14f limit cap defaults 50, ceiling 500', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    // Default limit
    const r1 = getCompletions(cwd, {});
    assert.ok(r1.completions.length <= 50);
    // Explicit limit
    const r2 = getCompletions(cwd, { limit: 5 });
    assert.ok(r2.completions.length <= 5);
    // Over-limit clamped to 500
    const r3 = getCompletions(cwd, { limit: 1000 });
    assert.ok(r3.completions.length <= 500);
  });

  test('#15 cross-feature no filter: returns all records sorted desc by recorded_at', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    seedFeature(cwd, { code: 'CODE-2', status: 'PLANNED' });

    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    await new Promise(r => setTimeout(r, 5)); // ensure distinct timestamps
    await recordCompletion(cwd, {
      feature_code: 'CODE-2', commit_sha: FULL_SHA_B,
      tests_pass: true, files_changed: [], set_status: false,
    });

    const result = getCompletions(cwd, {});
    assert.equal(result.count, 2);
    // Sorted desc: CODE-2 (newer) first
    assert.equal(result.completions[0].feature_code, 'CODE-2');
    assert.equal(result.completions[1].feature_code, 'CODE-1');
  });

  test('#15b reader returns feature_code verbatim from each record (Decision 11)', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
      tests_pass: true, files_changed: [], set_status: false,
    });
    const result = getCompletions(cwd, { feature_code: 'CODE-1' });
    assert.equal(result.completions[0].feature_code, 'CODE-1');
  });

  test('#15c concurrency: two parallel recordCompletion calls → both records present', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });

    // Fire both in parallel against the same feature with distinct SHAs
    await Promise.all([
      recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_A,
        tests_pass: true, files_changed: [], set_status: false,
      }),
      recordCompletion(cwd, {
        feature_code: 'CODE-1', commit_sha: FULL_SHA_B,
        tests_pass: false, files_changed: [], set_status: false,
      }),
    ]);

    const feature = readFeature(cwd, 'CODE-1');
    assert.equal(feature.completions.length, 2,
      'both records must be present (per-feature lock prevents clobber)');
    const ids = new Set(feature.completions.map(c => c.completion_id));
    assert.ok(ids.has(`CODE-1:${FULL_SHA_A}`), 'SHA_A completion present');
    assert.ok(ids.has(`CODE-1:${FULL_SHA_B}`), 'SHA_B completion present');
  });

  // Finding 2 — getCompletions SHA prefix floor
  test('#F2a commit_sha prefix shorter than 4 chars throws INVALID_INPUT', () => {
    const cwd = freshCwd();
    assert.throws(
      () => getCompletions(cwd, { commit_sha: 'abc' }),
      e => e.code === 'INVALID_INPUT'
    );
  });

  test('#F2b commit_sha exactly 4 chars succeeds', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: 'abcd' + 'e'.repeat(36),
      tests_pass: true, files_changed: [], set_status: false,
    });
    const result = getCompletions(cwd, { commit_sha: 'abcd' });
    assert.equal(result.count, 1);
  });

  test('#F2c commit_sha 8-char prefix still succeeds', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    await recordCompletion(cwd, {
      feature_code: 'CODE-1', commit_sha: 'abcdef12' + '3'.repeat(32),
      tests_pass: true, files_changed: [], set_status: false,
    });
    const result = getCompletions(cwd, { commit_sha: 'abcdef12' });
    assert.equal(result.count, 1);
  });

  // Finding 3 — feature_code normalization for legacy/hand-edited records
  test('#F3 legacy record lacking feature_code returns feature_code: null (not absent)', () => {
    const cwd = freshCwd();
    // Write a feature.json by hand with a completions entry that lacks feature_code
    const featureDir = join(cwd, 'docs', 'features', 'CODE-1');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'feature.json'), JSON.stringify({
      code: 'CODE-1',
      status: 'PLANNED',
      created: '2026-05-01',
      updated: '2026-05-01',
      phase: 'Phase 1',
      position: 1,
      description: 'legacy test feature',
      completions: [
        {
          // deliberately no feature_code
          completion_id: 'CODE-1:' + FULL_SHA_C,
          commit_sha: FULL_SHA_C,
          commit_sha_short: FULL_SHA_C.slice(0, 8),
          tests_pass: true,
          files_changed: [],
          recorded_at: new Date().toISOString(),
          recorded_by: 'hand',
        },
      ],
    }));

    const result = getCompletions(cwd, {});
    assert.equal(result.count, 1);
    const rec = result.completions[0];
    assert.ok(
      Object.prototype.hasOwnProperty.call(rec, 'feature_code'),
      'feature_code property must be present'
    );
    assert.strictEqual(rec.feature_code, null, 'feature_code must be null, not undefined or absent');
  });
});
