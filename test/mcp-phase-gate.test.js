/**
 * COMP-MCP-ENFORCE-1 — assertToolPhaseAllowed gate (server/compose-mcp-tools.js).
 * Uses the _testCtx seam to drive flag/profile/phase/target without disk or env.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { assertToolPhaseAllowed } = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);

const OFF = { phaseScopedTools: false };
const ON = (extra) => ({ phaseScopedTools: true, ...extra });

test('flag OFF → no-op for any tool/profile (parity)', () => {
  assert.doesNotThrow(() => assertToolPhaseAllowed('complete_feature', {}, { ...OFF, profile: 'implementer', phase: 'execute' }));
});

test('flag ON, orchestrator → allowed', () => {
  assert.doesNotThrow(() => assertToolPhaseAllowed('complete_feature', {}, ON({ profile: 'orchestrator', phase: 'execute' })));
});

test('flag ON, implementer in execute → approve_gate denied (PHASE_TOOL_DENIED)', () => {
  assert.throws(
    () => assertToolPhaseAllowed('approve_gate', {}, ON({ profile: 'implementer', phase: 'execute' })),
    (e) => e.code === 'PHASE_TOOL_DENIED' && e.profile === 'implementer' && e.phase === 'execute',
  );
});

test('flag ON, implementer in execute → lane tool (link_artifact) allowed', () => {
  assert.doesNotThrow(() => assertToolPhaseAllowed('link_artifact', {}, ON({ profile: 'implementer', phase: 'execute' })));
});

test('flag ON, implementer at ship, target IS bound feature → complete allowed', () => {
  assert.doesNotThrow(() =>
    assertToolPhaseAllowed('complete_feature', { id: 'x' }, ON({ profile: 'implementer', phase: 'ship', targetMatches: true })));
});

test('flag ON, implementer at ship, target is OTHER feature → complete denied', () => {
  assert.throws(
    () => assertToolPhaseAllowed('complete_feature', { id: 'y' }, ON({ profile: 'implementer', phase: 'ship', targetMatches: false })),
    (e) => e.code === 'PHASE_TOOL_DENIED',
  );
});

test('flag ON, reviewer at ship → completion still denied (allowlist never widened)', () => {
  assert.throws(
    () => assertToolPhaseAllowed('complete_feature', {}, ON({ profile: 'reviewer', phase: 'ship', targetMatches: true })),
    (e) => e.code === 'PHASE_TOOL_DENIED',
  );
});

test('flag ON but phase unresolved (null) → fail-open for phase-refined tools, profile base still applies', () => {
  // implementer with unknown phase: completion is in the deny list and no phase
  // re-permits it → denied (profile base). This is NOT fail-open for denied tools.
  assert.throws(() => assertToolPhaseAllowed('complete_feature', {}, ON({ profile: 'implementer', phase: null })));
  // but a lane tool stays allowed
  assert.doesNotThrow(() => assertToolPhaseAllowed('write_journal_entry', {}, ON({ profile: 'implementer', phase: null })));
});

/**
 * AMENDED 2026-09-07: the override-token escape is GONE from this gate too, with
 * the other two (docs/decisions/2026-09-07-override-token-audit.md). This test
 * used to assert the token ADMITTED a denied tool; it now asserts the opposite,
 * because the behaviour deliberately changed. The env var is deliberately set:
 * the strongest form of the claim is that a caller holding what used to be the
 * key is denied anyway.
 */
test('flag ON, denied tool + the retired override token → still denied', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'tok';
  try {
    assert.throws(
      () => assertToolPhaseAllowed('approve_gate', { override_token: 'tok' }, ON({ profile: 'implementer', phase: 'execute' })),
      (e) => e.code === 'PHASE_TOOL_DENIED' && /no override token/i.test(e.message),
      'a token matching the server env must not re-open a phase-denied tool',
    );
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

test('setup tools (set_workspace/bind_session) never gated even for reviewer', () => {
  assert.doesNotThrow(() => assertToolPhaseAllowed('set_workspace', {}, ON({ profile: 'reviewer', phase: 'execute' })));
  assert.doesNotThrow(() => assertToolPhaseAllowed('bind_session', {}, ON({ profile: 'implementer', phase: 'execute' })));
});
