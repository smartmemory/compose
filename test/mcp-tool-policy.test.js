/**
 * COMP-MCP-ENFORCE-1 — pure profile×phase policy (server/mcp-tool-policy.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  isToolAllowed, resolveProfile, resolveSpawnProfile, TEMPLATE_PROFILE_MAP, PROFILE_POLICY, PHASE_REFINEMENT,
} = await import(`${REPO_ROOT}/server/mcp-tool-policy.js`);

// --- resolveProfile: trusted env wins; hint may only narrow ---

test('resolveProfile: neither env nor hint → orchestrator (unrestricted)', () => {
  assert.equal(resolveProfile(null, null), 'orchestrator');
  assert.equal(resolveProfile(undefined, undefined), 'orchestrator');
});

test('resolveProfile: env sets the floor; a widening hint is ignored', () => {
  assert.equal(resolveProfile('implementer', 'orchestrator'), 'implementer', 'cannot widen via hint');
  assert.equal(resolveProfile('reviewer', 'implementer'), 'reviewer', 'cannot widen via hint');
});

test('resolveProfile: a narrowing hint is honored', () => {
  assert.equal(resolveProfile('implementer', 'reviewer'), 'reviewer', 'narrow implementer→reviewer');
  assert.equal(resolveProfile(null, 'implementer'), 'implementer', 'narrow from default');
});

test('resolveProfile: unknown profile string normalizes to orchestrator', () => {
  assert.equal(resolveProfile('wizard', null), 'orchestrator');
});

test('TEMPLATE_PROFILE_MAP: read-only/security templates → reviewer; implementer → implementer', () => {
  assert.equal(TEMPLATE_PROFILE_MAP['read-only-reviewer'], 'reviewer');
  assert.equal(TEMPLATE_PROFILE_MAP['read-only-researcher'], 'reviewer');
  assert.equal(TEMPLATE_PROFILE_MAP['security-auditor'], 'reviewer');
  assert.equal(TEMPLATE_PROFILE_MAP['implementer'], 'implementer');
  assert.equal(TEMPLATE_PROFILE_MAP['orchestrator'], 'orchestrator');
});

// --- isToolAllowed ---

const ALLOW = (r) => assert.equal(r.allowed, true, r.reason);
const DENY = (r) => assert.equal(r.allowed, false, `expected deny, got allow: ${r.reason}`);

test('orchestrator: everything allowed', () => {
  ALLOW(isToolAllowed({ tool: 'complete_feature', profile: 'orchestrator', phase: 'execute' }));
  ALLOW(isToolAllowed({ tool: 'set_feature_status', profile: 'orchestrator', phase: 'execute' }));
});

test('implementer: management tools denied in a work phase', () => {
  for (const t of ['approve_gate', 'complete_feature', 'kill_feature', 'set_feature_status', 'add_roadmap_entry', 'record_completion', 'propose_followup']) {
    DENY(isToolAllowed({ tool: t, profile: 'implementer', phase: 'execute', targetMatchesBoundFeature: true }));
  }
});

test('implementer: lane tools allowed (artifacts/links/journal/reads/setup)', () => {
  for (const t of ['link_artifact', 'write_journal_entry', 'add_changelog_entry', 'get_vision_items', 'set_workspace', 'bind_session', 'validate_feature']) {
    ALLOW(isToolAllowed({ tool: t, profile: 'implementer', phase: 'execute', targetMatchesBoundFeature: false }));
  }
});

test('implementer + ship + target IS bound feature → completion re-permitted', () => {
  ALLOW(isToolAllowed({ tool: 'complete_feature', profile: 'implementer', phase: 'ship', targetMatchesBoundFeature: true }));
  ALLOW(isToolAllowed({ tool: 'record_completion', profile: 'implementer', phase: 'ship', targetMatchesBoundFeature: true }));
});

test('implementer + ship + target is ANOTHER feature → still denied (feature-scoped)', () => {
  DENY(isToolAllowed({ tool: 'complete_feature', profile: 'implementer', phase: 'ship', targetMatchesBoundFeature: false }));
});

test('implementer + execute → completion denied even on own feature (phase refinement is ship-only)', () => {
  DENY(isToolAllowed({ tool: 'complete_feature', profile: 'implementer', phase: 'execute', targetMatchesBoundFeature: true }));
});

test('reviewer: allowlist of reads/setup; every mutation denied', () => {
  ALLOW(isToolAllowed({ tool: 'get_vision_items', profile: 'reviewer', phase: 'execute' }));
  ALLOW(isToolAllowed({ tool: 'set_workspace', profile: 'reviewer', phase: 'execute' }));
  DENY(isToolAllowed({ tool: 'link_artifact', profile: 'reviewer', phase: 'execute' }));
  DENY(isToolAllowed({ tool: 'set_feature_status', profile: 'reviewer', phase: 'execute' }));
});

test('reviewer: phase refinement NEVER widens the allowlist (read-only even at ship, own feature)', () => {
  DENY(isToolAllowed({ tool: 'complete_feature', profile: 'reviewer', phase: 'ship', targetMatchesBoundFeature: true }));
  DENY(isToolAllowed({ tool: 'record_completion', profile: 'reviewer', phase: 'ship', targetMatchesBoundFeature: true }));
});

test('resolveSpawnProfile: explicit restrictive profile injected; orchestrator/unknown → null', () => {
  assert.equal(resolveSpawnProfile({ profile: 'implementer' }), 'implementer');
  assert.equal(resolveSpawnProfile({ profile: 'reviewer' }), 'reviewer');
  assert.equal(resolveSpawnProfile({ profile: 'orchestrator' }), null, 'unrestricted → inject nothing');
  assert.equal(resolveSpawnProfile({ profile: 'wizard' }), null);
  assert.equal(resolveSpawnProfile({}), null);
});

test('resolveSpawnProfile: agent-template mapped to MCP profile', () => {
  assert.equal(resolveSpawnProfile({ template: 'read-only-reviewer' }), 'reviewer');
  assert.equal(resolveSpawnProfile({ template: 'implementer' }), 'implementer');
  assert.equal(resolveSpawnProfile({ template: 'orchestrator' }), null);
});

test('PHASE_REFINEMENT: only ship re-permits, and only completion tools', () => {
  assert.deepEqual([...PHASE_REFINEMENT.ship].sort(), ['complete_feature', 'record_completion']);
  assert.equal(PHASE_REFINEMENT.execute, undefined);
});
