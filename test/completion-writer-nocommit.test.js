/**
 * completion-writer-nocommit.test.js — commit-less completions
 * (COMP-PATHS-EXTERNAL S3, Decision 6b). A build whose workspace root is
 * non-git records completion without a commit; the writer stamps git's
 * null-SHA sentinel (40 zeros, schema-valid) instead of failing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { recordCompletion, getCompletions } from '../lib/completion-writer.js';
import { readFeature, writeFeature } from '../lib/feature-json.js';

const NULL_SHA = '0'.repeat(40);

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'cw-nocommit-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}
function seed(cwd, feature) {
  writeFeature(cwd, { created: '2026-06-15', updated: '2026-06-15', phase: 'Phase 1', position: 1, description: 'd', ...feature });
}

describe('commit-less completion (Decision 6b)', () => {
  test('omitted commit_sha → null-SHA sentinel, flips status, schema-valid record', async () => {
    const cwd = freshCwd();
    seed(cwd, { code: 'EXT-1', status: 'IN_PROGRESS' });

    const res = await recordCompletion(cwd, {
      feature_code: 'EXT-1',
      // commit_sha omitted — non-git workspace
      tests_pass: true,
      files_changed: [],
    });

    assert.equal(res.commit_sha, NULL_SHA, 'stamps the null-SHA sentinel');
    assert.match(res.completion_id, /^EXT-1:nocommit:/, 'commit-less id is distinct from the sha (no aliasing)');
    assert.deepEqual(res.status_changed, { from: 'IN_PROGRESS', to: 'COMPLETE' });

    assert.equal(readFeature(cwd, 'EXT-1').status, 'COMPLETE');
    const { completions } = getCompletions(cwd, { feature_code: 'EXT-1' });
    assert.equal(completions[0].commit_sha, NULL_SHA);
  });

  test('explicit null commit_sha behaves the same', async () => {
    const cwd = freshCwd();
    seed(cwd, { code: 'EXT-2', status: 'IN_PROGRESS' });
    const res = await recordCompletion(cwd, { feature_code: 'EXT-2', commit_sha: null, tests_pass: true, files_changed: [] });
    assert.equal(res.commit_sha, NULL_SHA);
    assert.equal(readFeature(cwd, 'EXT-2').status, 'COMPLETE');
  });

  test('two commit-less completions of one feature are DISTINCT records (no id collision)', async () => {
    const cwd = freshCwd();
    seed(cwd, { code: 'EXT-4', status: 'IN_PROGRESS' });
    const a = await recordCompletion(cwd, { feature_code: 'EXT-4', tests_pass: true, files_changed: [], set_status: false });
    const b = await recordCompletion(cwd, { feature_code: 'EXT-4', tests_pass: true, files_changed: [], set_status: false });
    assert.notEqual(a.completion_id, b.completion_id, 'null-SHA completions must not alias onto one id');
    assert.notEqual(b.idempotent, true, 'second completion is a real record, not an idempotent no-op');
    const { count } = getCompletions(cwd, { feature_code: 'EXT-4' });
    assert.equal(count, 2);
  });

  test('a PRESENT but malformed commit_sha is still rejected', async () => {
    const cwd = freshCwd();
    seed(cwd, { code: 'EXT-3', status: 'IN_PROGRESS' });
    await assert.rejects(
      () => recordCompletion(cwd, { feature_code: 'EXT-3', commit_sha: 'abc123', tests_pass: true, files_changed: [] }),
      e => e.code === 'INVALID_INPUT',
    );
  });
});
