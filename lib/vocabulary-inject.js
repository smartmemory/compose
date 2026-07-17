/**
 * STRAT-VOCAB-3 — Compose integration for vocabulary enforcement.
 *
 * Wires Compose's deterministic vocabulary compliance check into the lifecycle:
 *   - VOCABULARY_TEMPLATE        : starter contracts/vocabulary.yaml (compose init)
 *   - vocabularyEnabled()        : gate — capability not disabled AND a vocab file exists
 *   - tagVocabularyViolations()  : mark vocab violation strings as must-fix for display
 *
 * Design: docs/features/STRAT-VOCAB-3/design.md
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Project-relative location of the vocabulary file (also the path baked into the ensure). */
export const VOCABULARY_FILE = 'contracts/vocabulary.yaml';

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
