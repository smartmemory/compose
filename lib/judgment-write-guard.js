/**
 * lib/judgment-write-guard.js — write-time judgment-record validation (S03).
 *
 * Pure leaf validator in the feature-write-guard shape: schema conformance,
 * grounding/elicitation rules, the design's edge→artifact table, and the
 * method gates. The writer (lib/judgment-writer.js) and MCP surface call
 * into this module; it never imports them — imports are restricted to the
 * Ajv SchemaValidator and the judgment schema loader so the graph stays
 * acyclic (the feature-write-guard.js:20-23 discipline).
 *
 * Rules enforced here (design.md rev 5):
 *  - every record validates against contracts/judgment-record.schema.json
 *    (MCP inputSchema is advisory, never the enforcement)
 *  - grounding: ASSERT requires a structured elicitation block
 *  - [owner-locked] is unrepresentable through tools — import or the epic's
 *    future override only
 *  - every transition edge carries its bound artifact or is refused; there
 *    is no free under_test→open edge; dissolution is its own artifact
 *  - EXT needs sharpened-or-judgment-dispatch before under_test; STRADDLE
 *    needs signal+kill-criteria; a SILENT ext result may only yield the
 *    joint outcome `inconclusive`
 */
import { getJudgmentValidator } from './judgment/schema.js';

export class JudgmentWriteValidationError extends Error {
  /**
   * @param {'JUDGMENT_SCHEMA_VIOLATION'|'JUDGMENT_GROUNDING_VIOLATION'|'JUDGMENT_ILLEGAL_EDGE'|'JUDGMENT_METHOD_GATE'} kind
   * @param {string[]} violations
   */
  constructor(kind, violations) {
    super(`${kind}: ${violations.join('; ')}`);
    this.name = 'JudgmentWriteValidationError';
    this.code = kind;
    this.kind = kind;
    this.violations = violations;
  }
}

function refuse(kind, violations) {
  throw new JudgmentWriteValidationError(kind, violations);
}

/**
 * Validate a record against its contract definition. Throws
 * JUDGMENT_SCHEMA_VIOLATION with ajv error paths on mismatch.
 *
 * @param {'position_revision'|'joint'|'prediction'|'ledger_event'|'pending_intent'} defName
 * @param {object} record
 */
export function assertValidRecord(defName, record) {
  const { valid, errors } = getJudgmentValidator().validate(defName, record);
  if (valid) return;
  refuse(
    'JUDGMENT_SCHEMA_VIOLATION',
    (errors || []).map((e) => `${defName}${e.instancePath || ''}: ${e.message}`),
  );
}

/**
 * Grounding rules over a record's claims (position revisions; any record
 * carrying `claims[]`). `via: 'import'` — taken from opts or the record's own
 * provenance — is the only sanctioned owner-tag path in v1.
 *
 * @param {object} record
 * @param {{ via?: 'import' }} [opts]
 */
export function assertGrounding(record, opts = {}) {
  const via = opts.via ?? record?.provenance?.via;
  const violations = [];
  for (const claim of (Array.isArray(record?.claims) ? record.claims : [])) {
    if (claim.grounding === 'ASSERT' && !claim.elicitation) {
      violations.push(
        `claim ${claim.id}: grounding ASSERT requires an elicitation block { asked, answered_at, answer_ref } (assert-elicitation-amendment)`,
      );
    }
    if (claim.owner_locked === true && via !== 'import') {
      violations.push(
        `claim ${claim.id}: [owner-locked] is unrepresentable through tools — use the importer (via: 'import') or the epic's future override`,
      );
    }
  }
  if (violations.length > 0) refuse('JUDGMENT_GROUNDING_VIOLATION', violations);
}

/**
 * The design's edge→artifact table, verbatim. Each legal edge names the
 * exactly-one artifact the transition input must carry; anything else is
 * refused. Keys are `${from}→${to}`.
 *
 * @type {Record<string, (input: object) => string|null>}
 *   returns a violation string or null when satisfied
 */
const EDGE_TABLE = {
  'open→under_test': () => null, // method gate enforced by assertMethodGate
  'under_test→resolved': (input) =>
    input?.resolution?.outcome === 'resolved'
      ? null
      : 'requires resolution { outcome: resolved, evidence }',
  'under_test→inconclusive': (input) =>
    input?.resolution?.outcome === 'inconclusive'
      ? null
      : 'requires resolution { outcome: inconclusive, learned, would_have_settled }',
  'under_test→open': (input) =>
    input?.resolution?.outcome === 'failed_to_run'
      ? null
      : 'a free under_test→open edge does not exist — requires resolution { outcome: failed_to_run, reason }',
  'open→superseded': (input) =>
    input?.resolution?.outcome === 'superseded'
      ? null
      : 'requires resolution { outcome: superseded, why }',
  'under_test→superseded': (input) =>
    input?.resolution?.outcome === 'superseded'
      ? null
      : 'requires resolution { outcome: superseded, why }',
  'open→dissolved': (input) =>
    input?.dissolution && !input?.resolution
      ? null
      : 'requires dissolution { decomposed_into[] } — its own artifact, not a resolution',
  'under_test→dissolved': (input) =>
    input?.dissolution && !input?.resolution
      ? null
      : 'requires dissolution { decomposed_into[] } — its own artifact, not a resolution',
  'resolved→open': (input) =>
    input?.reopen?.shaken_evidence_ref
      ? null
      : 'reopen requires { shaken_evidence_ref } (P6)',
  'inconclusive→under_test': (input) => redisposeViolation(input),
  'inconclusive→open': (input) => redisposeViolation(input),
};

/**
 * Re-dispose carries `{ new_resolve_by, new method package }` for BOTH target
 * states (the table is explicit): a gated method may not be re-disposed
 * without its package even when the joint returns to open.
 */
function redisposeViolation(input) {
  const redispose = input?.redispose;
  if (!redispose?.new_resolve_by) {
    return 're-dispose requires { new_resolve_by, new method package } (P3 retry-with-different-method)';
  }
  if (redispose.new_resolve_by === 'EXT' && !redispose.ext) {
    return 're-dispose to EXT requires its ext package (sharpened or judgment-dispatch)';
  }
  if (redispose.new_resolve_by === 'STRADDLE' && !redispose.straddle) {
    return 're-dispose to STRADDLE requires straddle { discriminating_signal, kill_criteria }';
  }
  return null;
}

/**
 * The legal edge set, exported for the graph-parity contract test (the
 * judgment lifecycle mode and this table must agree edge-for-edge).
 */
export const LEGAL_EDGES = Object.freeze(Object.keys(EDGE_TABLE));

/**
 * Assert a transition edge is legal and carries its bound artifact.
 *
 * @param {string} from current joint state
 * @param {string} to target joint state
 * @param {object} input transition input ({ resolution?, dissolution?, reopen?, redispose? })
 */
export function assertEdgeArtifact(from, to, input = {}) {
  const edge = `${from}→${to}`;
  const rule = EDGE_TABLE[edge];
  if (!rule) {
    refuse('JUDGMENT_ILLEGAL_EDGE', [`edge ${edge} is not in the edge→artifact table — refused`]);
  }
  const violation = rule(input);
  if (violation) refuse('JUDGMENT_ILLEGAL_EDGE', [`edge ${edge}: ${violation}`]);
}

/**
 * Method gates (P3 / external-signal contract), applied to the joint as it
 * would stand AFTER the transition (i.e. with any re-disposed method/package
 * already merged by the caller):
 *  - EXT → under_test needs `ext` (sharpened package or judgment-dispatch)
 *  - STRADDLE → under_test needs `straddle { discriminating_signal, kill_criteria }`
 *  - an ext_result of SILENT may only accompany the joint outcome `inconclusive`
 *
 * @param {object} joint the joint record (post-merge view)
 * @param {string} to target state
 * @param {object} [input] transition input (for resolution inspection)
 */
export function assertMethodGate(joint, to, input = {}) {
  const violations = [];
  if (to === 'under_test') {
    if (joint.resolve_by === 'EXT' && !joint.ext) {
      violations.push(
        'EXT joint cannot enter under_test without ext { sharpened_question, bar, falsifier } or ext { judgment_dispatch: true, reason } (BAR-OR-JUDGMENT)',
      );
    }
    if (joint.resolve_by === 'STRADDLE' && !joint.straddle) {
      violations.push(
        'STRADDLE joint cannot enter under_test without straddle { discriminating_signal, kill_criteria } (STRADDLE-NEEDS-SIGNAL, KILL-CRITERIA-FIRST)',
      );
    }
  }
  // EXT resolutions MUST carry the ruled result package. Since only the
  // Answerer slice can produce evidence packages, this is also what makes
  // "no EXT resolution can occur before the Answerer exists" structural.
  if (joint.resolve_by === 'EXT' && (to === 'resolved' || to === 'inconclusive')) {
    const extResult = input?.resolution?.ext_result;
    if (!extResult) {
      violations.push(
        'an EXT resolution requires the ruled ext_result package { outcome, sources, search_record, found_or_provoked, judgment_not_evidence }',
      );
    } else {
      if (['FOUND', 'CONTRARY'].includes(extResult.outcome)) {
        const sources = Array.isArray(extResult.sources) ? extResult.sources : [];
        if (sources.length === 0) {
          violations.push(`ext_result ${extResult.outcome} requires at least one source address`);
        }
        for (const source of sources) {
          if (!String(source).startsWith('records/evidence/')) {
            violations.push(`ext_result source "${source}" must address an immutable records/evidence/ package`);
          }
        }
      }
      if (joint.ext?.judgment_dispatch === true && extResult.judgment_dispatch !== true) {
        violations.push('the judgment-dispatch stamp propagates permanently: ext_result.judgment_dispatch must be true on a BAR-OR-JUDGMENT joint');
      }
    }
  }
  const extOutcome = input?.resolution?.ext_result?.outcome;
  if (extOutcome === 'SILENT' && to !== 'inconclusive') {
    violations.push('a SILENT external-signal result may only yield the joint outcome inconclusive');
  }
  if (violations.length > 0) refuse('JUDGMENT_METHOD_GATE', violations);
}
