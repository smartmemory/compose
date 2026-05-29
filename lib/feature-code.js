/**
 * Strict feature-code regex used by every typed writer to validate input.
 * Contract: starts with uppercase letter, contains uppercase/digits/hyphens,
 * ends in uppercase or digit (no trailing hyphen, no leading hyphen).
 *
 * Consumed by feature-writer, completion-writer, journal-writer, AND (via
 * isFeatureCode) the roadmap parser/preservers/validator.
 *
 * Introduced by COMP-MCP-VALIDATE.
 */

export const FEATURE_CODE_RE_STRICT = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/;

/**
 * Throws an Error with `code: 'INVALID_INPUT'` if `code` is not a strict
 * feature code. Otherwise returns silently.
 *
 * @param {unknown} code
 * @throws {Error & { code: 'INVALID_INPUT' }}
 */
export function validateCode(code) {
  if (typeof code !== 'string' || !FEATURE_CODE_RE_STRICT.test(code)) {
    const err = new Error(`Invalid feature code: ${JSON.stringify(code)}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
}

/**
 * Non-throwing predicate form of the canonical feature-code contract.
 * Single source of truth for "is this string a feature code?" — consumed by
 * the roadmap parser, preservers, and validator.
 *
 * @param {unknown} code
 * @returns {boolean}
 */
export function isFeatureCode(code) {
  return typeof code === 'string' && FEATURE_CODE_RE_STRICT.test(code);
}
