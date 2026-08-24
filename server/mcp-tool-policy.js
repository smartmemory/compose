// server/mcp-tool-policy.js
//
// COMP-MCP-ENFORCE-1 — pure, declarative profile×phase policy for the compose
// MCP tool gate. No I/O: callers supply the resolved {profile, phase} and whether
// the tool's target matches the bound feature. See docs/features/COMP-MCP-ENFORCE-1/.

/** Agent-template name (server/agent-templates.js) → MCP profile. */
export const TEMPLATE_PROFILE_MAP = {
  'read-only-reviewer': 'reviewer',
  'read-only-researcher': 'reviewer',
  'security-auditor': 'reviewer',
  'implementer': 'implementer',
  'orchestrator': 'orchestrator',
};

/**
 * Tools that are NEVER gated — setup/query prerequisites. Denying these would
 * strand a restricted session (e.g. workspace selection precedes feature binding).
 * All read/`get_*`/`validate_*` tools are also implicitly safe but are listed in
 * the reviewer allowlist; this set is the cross-profile exemption.
 */
export const SETUP_TOOLS = new Set([
  'set_workspace', 'get_workspace', 'bind_session', 'get_current_session',
]);

/**
 * Management/approval/completion tools an implementer context must not wield.
 *
 * COMP-COVERAGE-GATE (2026-08-24) added the last two, found by
 * `checkAuthorizationCoverage`'s C4 check — mutating tools this list had never
 * been asked about. Both postdate COMP-MCP-ENFORCE-1's charter ("cannot
 * self-approve, self-complete, or mutate roadmap status") and no design ever
 * ruled that an implementer may call them:
 *
 *  - `canon_override_grant` — the escape hatch FROM canon enforcement was
 *    callable by the profile SUBJECT to it. COMP-CANON-OVERRIDE already reasoned
 *    that the override must not be grantable for its own governance state
 *    (`overrideEligible: false`); this is the same argument one level up, at the
 *    caller instead of the target. An implementer that hits a canon block must
 *    escalate, not self-authorise.
 *  - `roadmap_xref_push` — writes EXTERNAL trackers (github issues, sibling
 *    repos). An implementer session should not be reaching outside the repo.
 *
 * The eight `judgment_*` writers were the other eight C4 findings and are
 * deliberately NOT here: COMP-JUDGMENT-WRITER/design.md:137 rules that they
 * "stay implementer/orchestrator-only", so an implementer writing judgment is a
 * recorded decision, not an omission. That ruling is now recorded machine-side
 * in `C4_EXCEPTIONS` (lib/coverage-gate.js) so the gate stops re-raising it.
 *
 * Verified before adding the two: no pipeline spec, prompt template or server
 * flow invokes either from an implementer-profile session.
 */
const IMPLEMENTER_DENY = [
  'approve_gate', 'complete_feature', 'kill_feature',
  'set_feature_status', 'add_roadmap_entry', 'record_completion', 'propose_followup',
  // ── added by COMP-COVERAGE-GATE C4 ──
  'canon_override_grant',
  'roadmap_xref_push',
];

/** Reviewer (read-only) may call only these. */
const REVIEWER_ALLOW = [
  'get_vision_items', 'get_item_detail', 'get_phase_summary', 'get_blocked_items',
  'get_current_session', 'get_feature_lifecycle', 'get_feature_artifacts', 'get_feature_links',
  'get_pending_gates', 'get_changelog_entries', 'get_journal_entries', 'get_completions',
  'validate_feature', 'validate_project', 'roadmap_diff', 'get_roadmap', 'roadmap_graph_check', 'assess_feature_artifacts',
  'set_workspace', 'get_workspace', 'bind_session',
  'get_judgment_state', // COMP-JUDGMENT-WRITER: read-only; the eight judgment write tools stay reviewer-denied
  'get_judgment_trace', // COMP-JUDGMENT-PRECEDENT: read-only ancestry walk
];

export const PROFILE_POLICY = {
  orchestrator: { mode: 'unrestricted' },
  implementer: { mode: 'deny', tools: new Set(IMPLEMENTER_DENY) },
  reviewer: { mode: 'allowlist', tools: new Set(REVIEWER_ALLOW) },
};

/** phase → management tools re-permitted for DENY-mode profiles in that phase. */
export const PHASE_REFINEMENT = {
  ship: new Set(['complete_feature', 'record_completion']),
};

// Strictness ordering — a bind hint may only NARROW (raise strictness), never widen.
const RANK = { orchestrator: 0, implementer: 1, reviewer: 2 };
function _norm(p) {
  return (p && Object.prototype.hasOwnProperty.call(RANK, p)) ? p : 'orchestrator';
}

/**
 * Resolve the effective profile. `envProfile` (spawn-injected COMPOSE_SESSION_PROFILE)
 * is the trusted floor; `bindHint` (bind_session arg) may only narrow. Unknown
 * strings normalize to orchestrator (fail-open).
 */
export function resolveProfile(envProfile, bindHint) {
  const env = _norm(envProfile);
  const hint = _norm(bindHint);
  const rank = Math.max(RANK[env], RANK[hint]);
  return Object.keys(RANK).find((k) => RANK[k] === rank);
}

/**
 * Resolve the value to inject as COMPOSE_SESSION_PROFILE when spawning a
 * subagent. Accepts an explicit MCP `profile` or an agent-template `template`
 * (mapped via TEMPLATE_PROFILE_MAP). Returns the restrictive profile string to
 * inject, or null when the result is unrestricted/unknown (inject nothing →
 * the subagent runs as orchestrator, preserving current behavior).
 */
export function resolveSpawnProfile({ profile, template } = {}) {
  let p = null;
  if (profile && Object.prototype.hasOwnProperty.call(RANK, profile)) p = profile;
  else if (template && TEMPLATE_PROFILE_MAP[template]) p = TEMPLATE_PROFILE_MAP[template];
  return (p === 'implementer' || p === 'reviewer') ? p : null;
}

/**
 * Decide whether a tool may be called in a context.
 * @param {{tool:string, profile:string, phase?:string, targetMatchesBoundFeature?:boolean}} ctx
 * @returns {{allowed:boolean, reason:string}}
 */
export function isToolAllowed({ tool, profile, phase, targetMatchesBoundFeature = false }) {
  const prof = _norm(profile);
  const policy = PROFILE_POLICY[prof];

  if (policy.mode === 'unrestricted') return { allowed: true, reason: 'unrestricted profile' };
  if (SETUP_TOOLS.has(tool)) return { allowed: true, reason: 'setup/query tool (never gated)' };

  if (policy.mode === 'allowlist') {
    // Phase NEVER widens an allowlist (reviewer stays read-only in every phase).
    return policy.tools.has(tool)
      ? { allowed: true, reason: `allowlisted for ${prof}` }
      : { allowed: false, reason: `${tool} not in ${prof} allowlist` };
  }

  // deny-mode (implementer)
  if (!policy.tools.has(tool)) return { allowed: true, reason: `not denied for ${prof}` };
  const refinement = phase ? PHASE_REFINEMENT[phase] : null;
  if (refinement && refinement.has(tool)) {
    return targetMatchesBoundFeature
      ? { allowed: true, reason: `phase '${phase}' re-permits ${tool} on the bound feature` }
      : { allowed: false, reason: `phase '${phase}' re-permits ${tool} only for the bound feature (target differs)` };
  }
  return { allowed: false, reason: `${tool} denied for ${prof} in phase '${phase ?? 'unknown'}'` };
}
