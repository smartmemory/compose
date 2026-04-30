/**
 * build-stream-validate.test.js — STRAT-PAR-STREAM-CONSUMER-VALIDATE
 *
 * Table-driven tests for BuildStreamEvent envelope validation.
 * Covers the validator used by stratum-mcp-client.js#makeProgressHandler.
 *
 * Design: tests the pure validator function (build-stream-schema.js), not the
 * full StratumMcpClient integration. Integration is covered by the smoke test
 * (build-stream-smoke.test.js). Golden flow: valid → pass; invalid → drop.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateBuildStreamEvent, KNOWN_VERSIONS } from '../lib/build-stream-schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid v0.2.6 envelope builder */
function makeEnvelope(overrides = {}) {
  return {
    schema_version: '0.2.6',
    flow_id:        'flow-1',
    step_id:        'execute',
    seq:            0,
    ts:             '2026-04-29T00:00:00.000Z',
    kind:           'agent_relay',
    metadata:       { text: 'hello', role: 'assistant' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Case 1: valid v0.2.6 envelope passes
// ---------------------------------------------------------------------------

describe('validateBuildStreamEvent — valid envelopes', () => {
  it('accepts a well-formed v0.2.6 agent_relay envelope', () => {
    const result = validateBuildStreamEvent(makeEnvelope());
    assert.equal(result.valid, true, `expected valid but got: ${result.error}`);
  });

  it('accepts v0.2.5 envelopes (backward-compat window)', () => {
    const result = validateBuildStreamEvent(makeEnvelope({ schema_version: '0.2.5' }));
    assert.equal(result.valid, true, 'v0.2.5 should still be accepted for backward compat');
  });

  it('accepts a valid capability_profile metadata envelope', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'capability_profile',
      metadata: {
        agent: 'claude:read-only-reviewer',
        template: 'read-only-reviewer',
        allowedTools: ['Read', 'Bash'],
        disallowedTools: ['Edit', 'Write'],
      },
    }));
    assert.equal(result.valid, true, `expected valid but got: ${result.error}`);
  });

  it('accepts a valid step_usage metadata envelope', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'step_usage',
      metadata: {
        stepId: 'execute',
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 200,
        cost_usd: 0.005,
        model: 'claude-sonnet-4-6',
      },
    }));
    assert.equal(result.valid, true, `expected valid but got: ${result.error}`);
  });

  it('accepts a valid build_end metadata envelope', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'build_end',
      metadata: {
        status: 'complete',
        featureCode: 'STRAT-1',
        total_input_tokens: 5000,
        total_output_tokens: 2000,
        total_cost_usd: 0.05,
      },
    }));
    assert.equal(result.valid, true, `expected valid but got: ${result.error}`);
  });

  it('accepts reply_required: true on the envelope', () => {
    // Option A (STRAT-PAR-STREAM-CONSUMER-VALIDATE): reply_required is a valid boolean field.
    // None of the live 6 kinds use it today, but the schema must accept it for future kinds.
    const result = validateBuildStreamEvent(makeEnvelope({
      reply_required: true,
      kind: 'agent_relay',
      metadata: { text: 'awaiting answer', role: 'assistant' },
    }));
    assert.equal(result.valid, true, 'reply_required: true must be accepted by the envelope schema');
  });

  it('accepts reply_required: false on the envelope', () => {
    const result = validateBuildStreamEvent(makeEnvelope({ reply_required: false }));
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Case 2: missing schema_version drops with validation failure
// ---------------------------------------------------------------------------

describe('validateBuildStreamEvent — missing required fields', () => {
  it('rejects envelope missing schema_version', () => {
    const env = makeEnvelope();
    delete env.schema_version;
    const result = validateBuildStreamEvent(env);
    assert.equal(result.valid, false, 'must reject missing schema_version');
    assert.ok(result.error.includes('schema_version'), `error should mention field: ${result.error}`);
  });

  it('rejects envelope missing flow_id', () => {
    const env = makeEnvelope();
    delete env.flow_id;
    const result = validateBuildStreamEvent(env);
    assert.equal(result.valid, false);
  });

  it('rejects envelope missing kind', () => {
    const env = makeEnvelope();
    delete env.kind;
    const result = validateBuildStreamEvent(env);
    assert.equal(result.valid, false);
  });

  it('rejects envelope missing metadata', () => {
    const env = makeEnvelope();
    delete env.metadata;
    const result = validateBuildStreamEvent(env);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Case 3: unknown schema_version drops with warn
// ---------------------------------------------------------------------------

describe('validateBuildStreamEvent — unknown schema_version', () => {
  it('rejects schema_version 0.1.0 (too old)', () => {
    const result = validateBuildStreamEvent(makeEnvelope({ schema_version: '0.1.0' }));
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('schema_version'), `error: ${result.error}`);
  });

  it('rejects schema_version 0.3.0 (future, not yet accepted)', () => {
    const result = validateBuildStreamEvent(makeEnvelope({ schema_version: '0.3.0' }));
    assert.equal(result.valid, false);
  });

  it('KNOWN_VERSIONS set contains exactly 0.2.5 and 0.2.6', () => {
    assert.ok(KNOWN_VERSIONS.has('0.2.5'), '0.2.5 backward-compat');
    assert.ok(KNOWN_VERSIONS.has('0.2.6'), '0.2.6 current');
    assert.equal(KNOWN_VERSIONS.size, 2, 'no other versions accepted');
  });
});

// ---------------------------------------------------------------------------
// Case 4: mismatched metadata shape drops with warn
// ---------------------------------------------------------------------------

describe('validateBuildStreamEvent — metadata shape mismatches (closed kinds)', () => {
  it('rejects capability_violation metadata missing required severity', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'capability_violation',
      metadata: {
        agent: 'claude',
        template: 'read-only-reviewer',
        detail: 'Edit is disallowed',
        // severity intentionally omitted
      },
    }));
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('capability_violation'), `error: ${result.error}`);
  });

  it('rejects step_usage metadata with unknown extra field (additionalProperties: false)', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'step_usage',
      metadata: {
        stepId: 'review',
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.001,
        unexpected_field: 'this should not be here',
      },
    }));
    assert.equal(result.valid, false, 'additionalProperties must be rejected for step_usage');
  });

  it('rejects gate_tier_result metadata with wrong type for passed field', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'gate_tier_result',
      metadata: {
        stepId: 'review',
        tierId: 'T3',
        passed: 'yes',   // should be boolean
      },
    }));
    assert.equal(result.valid, false);
  });

  it('rejects health_score metadata with score > 100', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'health_score',
      metadata: {
        score: 150,   // out of range
        breakdown: { quality: 80 },
      },
    }));
    assert.equal(result.valid, false);
  });

  it('rejects build_end metadata with invalid status enum value', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'build_end',
      metadata: {
        status: 'success',   // not in enum: ['complete', 'killed', 'crashed', 'failed']
        featureCode: 'FEAT-1',
      },
    }));
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Case 5: open kinds (not in the closed set) pass with any metadata shape
// ---------------------------------------------------------------------------

describe('validateBuildStreamEvent — open kinds (metadata not closed)', () => {
  it('accepts agent_relay with arbitrary metadata fields', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'agent_relay',
      metadata: { text: 'hello', role: 'assistant', extra: 'any field ok' },
    }));
    assert.equal(result.valid, true, 'open kinds should not reject extra metadata fields');
  });

  it('accepts tool_use_summary with any shape', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'tool_use_summary',
      metadata: { tool: 'Read', summary: '/tmp/x', ok: true, duration_ms: 42, some_future_field: true },
    }));
    assert.equal(result.valid, true);
  });

  it('accepts agent_started with any shape', () => {
    const result = validateBuildStreamEvent(makeEnvelope({
      kind: 'agent_started',
      metadata: { agent: 'claude', model: 'claude-sonnet-4-6', prompt_chars: 1000 },
    }));
    assert.equal(result.valid, true);
  });
});
