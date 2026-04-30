/**
 * build-stream-schema.js — JSON Schema validator for BuildStreamEvent envelopes.
 *
 * STRAT-PAR-STREAM-CONSUMER-VALIDATE: validates incoming progress notifications
 * in stratum-mcp-client.js#dispatchEvent against the v0.2.6 envelope schema.
 *
 * Design decisions:
 * - Uses AJV (already in compose deps) compiled once at module load.
 * - On validation failure the caller should warn+drop — never throw.
 * - KNOWN_VERSIONS: set of accepted schema_version strings. v0.2.5 accepted for
 *   one-cycle backward compatibility; v0.2.6 is current.
 * - reply_required (Option A, STRAT-PAR-STREAM-CONSUMER-VALIDATE design):
 *   optional boolean reserved for future gate/permission/question kinds.
 */

import Ajv2020 from 'ajv/dist/2020.js';

export const KNOWN_VERSIONS = new Set(['0.2.5', '0.2.6']);

// ---------------------------------------------------------------------------
// Envelope schema (top-level fields only; metadata shape is kind-specific)
// ---------------------------------------------------------------------------

const ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'flow_id', 'step_id', 'seq', 'ts', 'kind', 'metadata'],
  additionalProperties: true,
  properties: {
    schema_version: { type: 'string' },
    flow_id:        { type: 'string' },
    step_id:        { type: 'string' },
    seq:            { type: 'integer', minimum: 0 },
    ts:             { type: 'string' },
    kind:           { type: 'string' },
    task_id:        { type: ['string', 'null'] },
    reply_required: { type: 'boolean' },
    metadata:       { type: 'object' },
  },
};

// ---------------------------------------------------------------------------
// Per-kind closed metadata schemas (v0.2.6 CONTRACT)
// Source of truth: stratum-mcp/contracts/build-stream-event.v0.2.6.schema.json
// ---------------------------------------------------------------------------

const KIND_METADATA_SCHEMAS = {
  capability_profile: {
    type: 'object',
    required: ['agent', 'template'],
    additionalProperties: false,
    properties: {
      agent:           { type: 'string' },
      template:        { type: ['string', 'null'] },
      allowedTools:    { type: ['array', 'null'], items: { type: 'string' } },
      disallowedTools: { type: ['array', 'null'], items: { type: 'string' } },
    },
  },
  capability_violation: {
    type: 'object',
    required: ['agent', 'template', 'detail', 'severity'],
    additionalProperties: false,
    properties: {
      agent:    { type: 'string' },
      template: { type: ['string', 'null'] },
      detail:   { type: 'string' },
      severity: { type: 'string', enum: ['violation', 'warning'] },
    },
  },
  step_usage: {
    type: 'object',
    required: ['stepId', 'input_tokens', 'output_tokens', 'cost_usd'],
    additionalProperties: false,
    properties: {
      stepId:                      { type: 'string' },
      input_tokens:                { type: 'number', minimum: 0 },
      output_tokens:               { type: 'number', minimum: 0 },
      cache_creation_input_tokens: { type: 'number', minimum: 0 },
      cache_read_input_tokens:     { type: 'number', minimum: 0 },
      cost_usd:                    { type: 'number', minimum: 0 },
      model:                       { type: ['string', 'null'] },
    },
  },
  gate_tier_result: {
    type: 'object',
    required: ['stepId', 'tierId', 'passed'],
    additionalProperties: false,
    properties: {
      stepId:  { type: 'string' },
      tierId:  { type: 'string' },
      passed:  { type: 'boolean' },
      details: { type: ['string', 'null'] },
    },
  },
  health_score: {
    type: 'object',
    required: ['score', 'breakdown'],
    additionalProperties: false,
    properties: {
      score:     { type: 'number', minimum: 0, maximum: 100 },
      breakdown: { type: 'object', additionalProperties: { type: 'number' } },
      missing:   { type: 'array', items: { type: 'string' } },
    },
  },
  build_end: {
    type: 'object',
    required: ['status', 'featureCode'],
    additionalProperties: false,
    properties: {
      status:              { type: 'string', enum: ['complete', 'killed', 'crashed', 'failed'] },
      featureCode:         { type: 'string' },
      total_input_tokens:  { type: 'number', minimum: 0 },
      total_output_tokens: { type: 'number', minimum: 0 },
      total_cost_usd:      { type: 'number', minimum: 0 },
    },
  },
};

// ---------------------------------------------------------------------------
// AJV setup — compile once (Ajv2020 for draft-2020-12 feature support)
// ---------------------------------------------------------------------------

const ajv = new Ajv2020({ strict: false });
const validateEnvelope = ajv.compile(ENVELOPE_SCHEMA);

const compiledKindValidators = new Map(
  Object.entries(KIND_METADATA_SCHEMAS).map(([kind, schema]) => [kind, ajv.compile(schema)])
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a parsed BuildStreamEvent envelope.
 *
 * Returns { valid: true } on success.
 * Returns { valid: false, error: string } on failure.
 *
 * Validation rules:
 * 1. Envelope must pass top-level schema (required fields, correct types).
 * 2. schema_version must be a known accepted version.
 * 3. If the kind has a closed metadata schema, metadata must pass it.
 *
 * @param {object} envelope  Parsed event object
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateBuildStreamEvent(envelope) {
  // 1. Top-level envelope shape
  if (!validateEnvelope(envelope)) {
    const errMsg = ajv.errorsText(validateEnvelope.errors);
    return { valid: false, error: `envelope schema: ${errMsg}` };
  }

  // 2. schema_version check (accepts both 0.2.5 for backward compat and 0.2.6)
  if (!KNOWN_VERSIONS.has(envelope.schema_version)) {
    return {
      valid: false,
      error: `unknown schema_version "${envelope.schema_version}" (accepted: ${[...KNOWN_VERSIONS].join(', ')})`,
    };
  }

  // 3. Kind-specific metadata validation (only for the 6 closed kinds)
  const kindValidator = compiledKindValidators.get(envelope.kind);
  if (kindValidator) {
    if (!kindValidator(envelope.metadata)) {
      const errMsg = ajv.errorsText(kindValidator.errors);
      return { valid: false, error: `metadata for kind "${envelope.kind}": ${errMsg}` };
    }
  }

  return { valid: true };
}
