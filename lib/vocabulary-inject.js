/**
 * STRAT-VOCAB-3 — Compose integration for vocabulary enforcement.
 *
 * Wires the already-shipped Stratum `vocabulary_compliance` ensure builtin
 * (stratum-mcp/src/stratum_mcp/spec.py) into the compose lifecycle:
 *   - VOCABULARY_TEMPLATE        : starter contracts/vocabulary.yaml (compose init)
 *   - vocabularyEnabled()        : gate — capability not disabled AND a vocab file exists
 *   - injectVocabularyEnsure()   : append the vocab ensure to the build flow's `review` step
 *   - tagVocabularyViolations()  : mark vocab violation strings as must-fix for display
 *
 * Design: docs/features/STRAT-VOCAB-3/design.md
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Project-relative location of the vocabulary file (also the path baked into the ensure). */
export const VOCABULARY_FILE = 'contracts/vocabulary.yaml';

/**
 * The ensure expression injected into the build flow's `review` step.
 * Empty-list literal + git_fallback=True: never references a possibly-missing
 * `result.*` attribute; scans the uncommitted working-tree diff vs HEAD (the
 * implementation changes are merged but not yet committed at review time).
 * Python-evaluated by the Stratum executor — hence `[]` and `True`.
 */
export const VOCABULARY_ENSURE = `vocabulary_compliance('${VOCABULARY_FILE}', [], True)`;

/** Starter vocabulary file: all comments, so `_load_vocabulary` returns {} (inert) until edited. */
export const VOCABULARY_TEMPLATE = `# contracts/vocabulary.yaml — project naming vocabulary (STRAT-VOCAB)
#
# Declare canonical names and the aliases that must NOT appear in code. During
# \`compose build\`, the review step scans the files changed by the build for any
# rejected alias (whole-word, case-sensitive) and fails until each is replaced
# with its canonical name. An empty / comments-only file is a no-op.
#
# Format — a flat map of canonical_name -> { reject: [...], reason: "..." }:
#
#   auth_token:
#     reject: [jwt, accessToken, JwtToken, authToken]
#     reason: "use auth_token everywhere for the session credential"
#
#   user_id:
#     reject: [uid, userId, UserId]
#
# Rules: canonical names and aliases must be identifiers; an alias may not also
# be a canonical name or be repeated across entries; \`reason\` is optional.
# Uncomment and edit the examples above (or add your own) to enable enforcement.
`;

/**
 * Is vocabulary enforcement active for this project?
 * Default-ON (honoring the roadmap's "by default") but gated on the file existing,
 * so the generated spec is byte-identical for any project without a vocab file.
 * Opt out with capabilities.vocabularyCompliance === false.
 */
export function vocabularyEnabled(cwd, composeConfig) {
  if (composeConfig?.capabilities?.vocabularyCompliance === false) return false;
  return existsSync(join(cwd, VOCABULARY_FILE));
}

/**
 * Append the vocabulary ensure to the EXECUTED flow's `review` step (idempotent).
 * Mutates and returns specObj. No-op when that flow has no `review` step.
 *
 * `flowName` must be the flow Stratum will actually run (build.js resolves it via
 * extractFlowName). Targeting it precisely matters because a sub-flow
 * (`review_check`) ALSO has a step id'd `review`; injecting there would be wrong.
 * When `flowName` is omitted/unknown, fall back to the `build` flow (or the first),
 * matching the shipped templates.
 */
export function injectVocabularyEnsure(specObj, flowName) {
  const flows = specObj?.flows ?? {};
  const keys = Object.keys(flows);
  const flowKey = flowName && keys.includes(flowName)
    ? flowName
    : (keys.includes('build') ? 'build' : keys[0]);
  const steps = flows[flowKey]?.steps ?? [];
  const review = steps.find((s) => s?.id === 'review');
  if (!review) return specObj;
  if (!Array.isArray(review.ensure)) review.ensure = [];
  if (!review.ensure.includes(VOCABULARY_ENSURE)) review.ensure.push(VOCABULARY_ENSURE);
  return specObj;
}

/**
 * Tag vocabulary failure strings as must-fix for the findings display.
 * The cli-progress parser classifies a string by keyword (defaults to `nit`);
 * vocab failures carry no marker, so prefix them with `must-fix:` — the parser
 * then classifies must-fix AND still extracts the file:line, and strips the
 * prefix for a clean description. Non-string / non-vocab items pass through
 * unchanged. Returns a new array (does not mutate input or stored violations).
 *
 * Matches every string the builtin emits — both alias hits
 * ("vocabulary violation: …") and a broken vocab file
 * ("vocabulary.yaml malformed: …" / "vocabulary.yaml schema error: …") — all of
 * which block the step and so deserve must-fix, not nit.
 */
export function tagVocabularyViolations(violations) {
  if (!Array.isArray(violations)) return violations;
  return violations.map((v) =>
    typeof v === 'string' && /^vocabulary[ .]/i.test(v) ? `must-fix: ${v}` : v
  );
}
