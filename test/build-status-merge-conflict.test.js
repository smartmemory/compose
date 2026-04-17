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

describe('terminal branch wiring for merge conflict', () => {
  // Documents the contract that the main loop's complete-branch must honor:
  // when response.status === 'complete' AND the helper returns 'failed',
  // the success-terminal side effects (updateFeature COMPLETE, vision complete,
  // active-build complete) must be skipped in favor of the failed-terminal branch.
  //
  // The helper is tested above. This test pins the *integration contract*
  // by asserting the branch selector logic in isolation — mirroring the
  // exact conditional used at build.js:1362-1365.
  it('response.status=complete + merge_status=conflict must NOT hit the success branch', () => {
    const response = {
      status: 'complete',
      output: { outcome: 'failed', merge_status: 'conflict' },
    };
    const buildStatus = resolveBuildStatusForCompleteResponse(response);

    // The main loop's success branch is guarded by this exact conjunction:
    const takesSuccessBranch = response.status === 'complete' && buildStatus === 'complete';
    const takesFailedBranch = !takesSuccessBranch && buildStatus === 'failed';

    assert.equal(takesSuccessBranch, false, 'conflict must NOT hit the success terminal');
    assert.equal(takesFailedBranch, true, 'conflict must hit the failed terminal');
  });

  it('response.status=complete with clean merge still hits the success branch', () => {
    const response = { status: 'complete', output: { tasks: [] } };
    const buildStatus = resolveBuildStatusForCompleteResponse(response);
    const takesSuccessBranch = response.status === 'complete' && buildStatus === 'complete';
    assert.equal(takesSuccessBranch, true);
  });
});
