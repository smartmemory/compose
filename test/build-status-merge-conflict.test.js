import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildStatusForCompleteResponse } from '../lib/build.js';

describe('resolveBuildStatusForCompleteResponse', () => {
  it('returns complete for a plain complete response', () => {
    assert.equal(resolveBuildStatusForCompleteResponse({ status: 'complete' }), 'complete');
  });

  it('returns complete when output exists but has no merge_status', () => {
    assert.equal(
      resolveBuildStatusForCompleteResponse({ status: 'complete', output: { tasks: [] } }),
      'complete',
    );
  });

  it('returns failed when output.merge_status is "conflict"', () => {
    assert.equal(
      resolveBuildStatusForCompleteResponse({
        status: 'complete',
        output: { outcome: 'failed', merge_status: 'conflict' },
      }),
      'failed',
    );
  });

  it('returns complete when output.outcome is "failed" but merge_status is not conflict (narrow check)', () => {
    // Unrelated failure flavors should not flip buildStatus here — only the
    // client-side merge conflict case is scoped to this helper.
    assert.equal(
      resolveBuildStatusForCompleteResponse({
        status: 'complete',
        output: { outcome: 'failed' },
      }),
      'complete',
    );
  });

  it('returns complete when output is null/undefined', () => {
    assert.equal(resolveBuildStatusForCompleteResponse({ status: 'complete', output: null }), 'complete');
    assert.equal(resolveBuildStatusForCompleteResponse({ status: 'complete' }), 'complete');
  });
});
