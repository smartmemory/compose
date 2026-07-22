/**
 * judgment-write-guard.test.js — coverage for lib/judgment-write-guard.js
 * (T3/S03): one refusal case per rule, error `kind` values asserted.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  JudgmentWriteValidationError,
  assertValidRecord,
  assertGrounding,
  assertEdgeArtifact,
  assertMethodGate,
} from '../lib/judgment-write-guard.js';

const provenance = {
  actor: 'agent',
  session: null,
  written_at: '2026-07-22T12:00:00Z',
};

const elicitation = {
  asked: 'q?',
  answered_at: '2026-07-22T11:00:00Z',
  answer_ref: 'ledger:decide:x',
};

function positionRevision(overrides = {}) {
  return {
    slug: 'alpha',
    claims: [{ id: 'c1', text: 't', grounding: 'INT', supports: [] }],
    conviction: { level: 'high', source: 'stated' },
    provenance,
    ...overrides,
  };
}

function joint(overrides = {}) {
  return {
    slug: 'j1',
    question: 'q?',
    branch_true: 'a',
    branch_false: 'b',
    resolve_by: 'INT',
    cost: 'days',
    rank: 'high',
    state: 'open',
    provenance,
    ...overrides,
  };
}

function refusal(fn, kind) {
  try {
    fn();
    assert.fail(`expected JudgmentWriteValidationError(${kind})`);
  } catch (err) {
    assert.ok(err instanceof JudgmentWriteValidationError, `wrong error type: ${err}`);
    assert.equal(err.kind, kind);
    assert.ok(Array.isArray(err.violations) && err.violations.length > 0);
  }
}

describe('assertValidRecord', () => {
  test('valid record passes silently', () => {
    assertValidRecord('position_revision', positionRevision());
  });

  test('schema violation refused with JUDGMENT_SCHEMA_VIOLATION', () => {
    refusal(
      () => assertValidRecord('joint', joint({ cost: 'minutes' })),
      'JUDGMENT_SCHEMA_VIOLATION',
    );
  });
});

describe('assertGrounding', () => {
  test('ASSERT without elicitation refused', () => {
    const rev = positionRevision({ claims: [{ id: 'c1', text: 't', grounding: 'ASSERT' }] });
    refusal(() => assertGrounding(rev), 'JUDGMENT_GROUNDING_VIOLATION');
  });

  test('ASSERT with elicitation passes', () => {
    const rev = positionRevision({
      claims: [{ id: 'c1', text: 't', grounding: 'ASSERT', elicitation }],
    });
    assertGrounding(rev);
  });

  test('owner-locked refused through tools, import/override paths named', () => {
    const rev = positionRevision({
      claims: [{ id: 'c1', text: 't', grounding: 'INT', owner_locked: true }],
    });
    try {
      assertGrounding(rev);
      assert.fail('expected refusal');
    } catch (err) {
      assert.equal(err.kind, 'JUDGMENT_GROUNDING_VIOLATION');
      const message = err.violations.join(' ');
      assert.match(message, /import/);
      assert.match(message, /override/);
    }
  });

  test("owner-locked allowed via: 'import' (historical transcription)", () => {
    const rev = positionRevision({
      claims: [{ id: 'c1', text: 't', grounding: 'INT', owner_locked: true }],
      provenance: { ...provenance, via: 'import' },
    });
    assertGrounding(rev, { via: 'import' });
  });
});

describe('assertEdgeArtifact — the edge→artifact table is law', () => {
  test('open → under_test legal with no artifact (method gate is separate)', () => {
    assertEdgeArtifact('open', 'under_test', {});
  });

  test('under_test → resolved requires resolution outcome resolved', () => {
    assertEdgeArtifact('under_test', 'resolved', {
      resolution: { outcome: 'resolved', evidence: 'e' },
    });
    refusal(() => assertEdgeArtifact('under_test', 'resolved', {}), 'JUDGMENT_ILLEGAL_EDGE');
    refusal(
      () => assertEdgeArtifact('under_test', 'resolved', { resolution: { outcome: 'inconclusive', learned: 'l', would_have_settled: 'w' } }),
      'JUDGMENT_ILLEGAL_EDGE',
    );
  });

  test('under_test → inconclusive requires inconclusive package', () => {
    assertEdgeArtifact('under_test', 'inconclusive', {
      resolution: { outcome: 'inconclusive', learned: 'l', would_have_settled: 'w' },
    });
    refusal(() => assertEdgeArtifact('under_test', 'inconclusive', {}), 'JUDGMENT_ILLEGAL_EDGE');
  });

  test('no free under_test → open — only failed_to_run', () => {
    assertEdgeArtifact('under_test', 'open', {
      resolution: { outcome: 'failed_to_run', reason: 'r' },
    });
    refusal(() => assertEdgeArtifact('under_test', 'open', {}), 'JUDGMENT_ILLEGAL_EDGE');
  });

  test('superseded requires its why-package from open or under_test', () => {
    assertEdgeArtifact('open', 'superseded', { resolution: { outcome: 'superseded', why: 'w' } });
    assertEdgeArtifact('under_test', 'superseded', { resolution: { outcome: 'superseded', why: 'w' } });
    refusal(() => assertEdgeArtifact('open', 'superseded', {}), 'JUDGMENT_ILLEGAL_EDGE');
  });

  test('dissolved requires the dissolution artifact, NOT a resolution', () => {
    assertEdgeArtifact('open', 'dissolved', { dissolution: { decomposed_into: ['x'] } });
    refusal(() => assertEdgeArtifact('open', 'dissolved', {}), 'JUDGMENT_ILLEGAL_EDGE');
    refusal(
      () => assertEdgeArtifact('under_test', 'dissolved', {
        dissolution: { decomposed_into: ['x'] },
        resolution: { outcome: 'superseded', why: 'w' },
      }),
      'JUDGMENT_ILLEGAL_EDGE',
    );
  });

  test('resolved → open requires shaken evidence (P6 reopen)', () => {
    assertEdgeArtifact('resolved', 'open', { reopen: { shaken_evidence_ref: 'ledger:5' } });
    refusal(() => assertEdgeArtifact('resolved', 'open', {}), 'JUDGMENT_ILLEGAL_EDGE');
  });

  test('inconclusive → under_test|open only via re-dispose', () => {
    assertEdgeArtifact('inconclusive', 'under_test', {
      redispose: { new_resolve_by: 'CONSTRUCT' },
    });
    assertEdgeArtifact('inconclusive', 'open', {
      redispose: { new_resolve_by: 'INT' },
    });
    refusal(() => assertEdgeArtifact('inconclusive', 'under_test', {}), 'JUDGMENT_ILLEGAL_EDGE');
  });

  test('unlisted edges are refused outright', () => {
    refusal(() => assertEdgeArtifact('resolved', 'under_test', {}), 'JUDGMENT_ILLEGAL_EDGE');
    refusal(() => assertEdgeArtifact('dissolved', 'open', {}), 'JUDGMENT_ILLEGAL_EDGE');
    refusal(() => assertEdgeArtifact('open', 'resolved', { resolution: { outcome: 'resolved', evidence: 'e' } }), 'JUDGMENT_ILLEGAL_EDGE');
  });
});

describe('assertMethodGate', () => {
  test('EXT cannot enter under_test unsharpened', () => {
    refusal(
      () => assertMethodGate(joint({ resolve_by: 'EXT' }), 'under_test'),
      'JUDGMENT_METHOD_GATE',
    );
  });

  test('EXT enters under_test via sharpened package or judgment-dispatch', () => {
    assertMethodGate(
      joint({ resolve_by: 'EXT', ext: { sharpened_question: 'q', bar: 'b', falsifier: 'f' } }),
      'under_test',
    );
    assertMethodGate(
      joint({ resolve_by: 'EXT', ext: { judgment_dispatch: true, reason: 'r' } }),
      'under_test',
    );
  });

  test('STRADDLE needs signal + kill criteria before under_test', () => {
    refusal(
      () => assertMethodGate(joint({ resolve_by: 'STRADDLE' }), 'under_test'),
      'JUDGMENT_METHOD_GATE',
    );
    assertMethodGate(
      joint({ resolve_by: 'STRADDLE', straddle: { discriminating_signal: 's', kill_criteria: 'k' } }),
      'under_test',
    );
  });

  test('non-gated methods enter under_test freely', () => {
    assertMethodGate(joint({ resolve_by: 'INT' }), 'under_test');
    assertMethodGate(joint({ resolve_by: 'CONSTRUCT' }), 'under_test');
  });

  test('SILENT ext result may only yield inconclusive', () => {
    const silent = {
      outcome: 'resolved',
      evidence: 'e',
      ext_result: {
        outcome: 'SILENT',
        sources: [],
        search_record: 's',
        found_or_provoked: 'found',
        judgment_not_evidence: true,
      },
    };
    refusal(
      () => assertMethodGate(joint({ resolve_by: 'EXT', ext: { sharpened_question: 'q', bar: 'b', falsifier: 'f' } }), 'resolved', { resolution: silent }),
      'JUDGMENT_METHOD_GATE',
    );
    // SILENT → inconclusive is the legal pairing
    assertMethodGate(
      joint({ resolve_by: 'EXT', ext: { sharpened_question: 'q', bar: 'b', falsifier: 'f' } }),
      'inconclusive',
      { resolution: { outcome: 'inconclusive', learned: 'l', would_have_settled: 'w', ext_result: { ...silent.ext_result } } },
    );
  });
});
