/**
 * TS-engine spec compatibility.
 *
 * COMP-PIPELINE-QUARANTINE: STRAT-PY-RETIRE converted only the two production
 * pipelines (build, gsd) from the v0.3 dialect to TS v1 — see compose commit
 * 9221548, "Both production pipelines (build, gsd) are re-authored as TS v1".
 * Everything else in pipelines/ and presets/ stayed behind — most on v0.3,
 * bug-fix on v0.1 — and the older execution paths were deleted, so those specs
 * cannot run at all: the engine
 * refuses them at `stratum_plan` with a bare `MCP error -32602: spec validation
 * failed`, which tells the user nothing about why.
 *
 * This module is the single place that answers "can the TS engine run this
 * spec". It reads the spec's OWN version stamp rather than consulting a list of
 * pipeline names — so migrating a spec to `version: 1` lifts its quarantine
 * automatically, with nothing here to remember to update.
 */

import { parse as parseYaml } from 'yaml';

/** The only spec dialect the TS engine accepts. */
export const TS_SPEC_VERSION = 1;

/**
 * The specs `compose init` seeds into a workspace's pipelines/ directory.
 *
 * Shared with resolveTemplatePath, which deliberately does NOT fall back to the
 * bundled copy for these: their absence means the workspace was never
 * initialized, and failing loudly with "Lifecycle spec not found" is the honest
 * answer. Silently running Compose's own bundled build pipeline against an
 * uninitialized project would be worse than the error. Every OTHER shipped
 * pipeline (content, coverage-sweep, refactor, research, review-fix) is never
 * copied by init, so the bundled copy is its only source and the fallback is the
 * only way `--template research` can resolve at all.
 */
export const INIT_PROVISIONED_SPECS = Object.freeze([
  'build',
  'build-quick',
  'bug-fix',
  'new',
  'plan',
]);

/**
 * Classify a spec's engine compatibility.
 *
 * Deliberately shallow: a `version: 1` stamp means "authored for this engine",
 * not "valid". Full validation belongs to the engine, which reports precise
 * errors. This exists to turn the common, uninformative failure — a spec from
 * the retired dialect — into a message that names the cause.
 *
 * @param {string} specText  Raw spec YAML
 * @returns {{compatible: boolean, version: unknown, reason: string|null}}
 */
export function tsCompatibilityOf(specText) {
  let parsed;
  try {
    parsed = parseYaml(specText);
  } catch (err) {
    return { compatible: false, version: null, reason: `spec is not parseable YAML: ${err.message}` };
  }
  const version = parsed?.version ?? null;
  if (version === TS_SPEC_VERSION) return { compatible: true, version, reason: null };
  if (version === null) {
    return { compatible: false, version, reason: 'spec declares no `version`' };
  }
  return {
    compatible: false,
    version,
    reason: `spec declares version ${JSON.stringify(version)}, but the TS engine only runs version ${TS_SPEC_VERSION}`,
  };
}

/** True iff the TS engine will accept this spec's dialect. */
export function isTsEngineSpec(specText) {
  return tsCompatibilityOf(specText).compatible;
}

/**
 * The message shown when a quarantined pipeline is invoked. Names the spec, the
 * cause, and the only two ways forward — never a raw engine error code.
 *
 * @param {string} specPath  Absolute path of the offending spec
 * @param {{reason: string|null}} compat  Result of tsCompatibilityOf
 */
export function quarantineMessage(specPath, compat) {
  // Only a spec that declares an OLDER dialect gets the migration story. A
  // malformed or version-less spec is far more likely to be a fresh typo, and
  // telling its author it was "left behind by STRAT-PY-RETIRE" is a confident
  // false history that sends them looking in the wrong place.
  const isRetiredDialect = typeof compat.version === 'string' && /^0\./.test(compat.version);
  const lines = [
    `This pipeline cannot run: ${specPath}`,
    `  ${compat.reason}.`,
  ];
  if (isRetiredDialect) {
    lines.push(
      '  It was left on a retired dialect when STRAT-PY-RETIRE cut the engine over to TS v1 and',
      '  deleted the older execution path, so it has been unrunnable since that cutover.',
    );
  }
  lines.push(`  The spec must declare \`version: ${TS_SPEC_VERSION}\` and use the TS v1 dialect.`);
  return lines.join('\n');
}
