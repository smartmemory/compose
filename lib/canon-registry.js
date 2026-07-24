/**
 * canon-registry.js — COMP-CANON-GUARD S1.
 *
 * The single declaration of what is canon: path pattern → writer → typed tools
 * → enforcement points. Pure, no I/O (shape template: server/mcp-tool-policy.js).
 *
 * Consumed by BOTH:
 *   - lib/mcp-enforcement.js  (the ship-time scan — the 'ship' point)
 *   - .claude/hooks/canon-guard.mjs  (the write-time PreToolUse hook — 'hook')
 *
 * The load-bearing invariant (design Decision 1, corrected in blueprint-s1-s4):
 * ONE registry does NOT imply ONE coverage. Each entry declares `enforcedBy`,
 * and every enforcement point consumes only the subset that names it. This is
 * what keeps the shared registry from locking out paths a point cannot yet
 * legally guard:
 *   - docs/judgment/**  is 100% tool-covered (S3 shipped the 8 judgment_* tools
 *     + regen), so the write-time hook can guard it with no lockout → ['hook'].
 *   - ROADMAP.md / feature.json have legal mutations NO tool covers yet
 *     (open a preserved section; edit a feature description — Decision 2), so
 *     the always-deny hook would lock them out. They stay ['ship'] (their
 *     existing build-event correlation) until update_feature_fields /
 *     open_preserved_section + the override land.
 *
 * Adding a path here turns on real enforcement — register a path for 'hook'
 * ONLY once every legal mutation of it has a tool or an override.
 */

// ── Tool sets ────────────────────────────────────────────────────────────────
// Moved verbatim from the pre-refactor mcp-enforcement.js literal sets. The
// contract test pins these against the legacy values.
const TOOLS_FOR_ROADMAP = ['add_roadmap_entry', 'set_feature_status', 'propose_followup'];
const TOOLS_FOR_CHANGELOG = ['add_changelog_entry'];
const TOOLS_FOR_FEATURE_JSON = [
  'add_roadmap_entry',
  'set_feature_status',
  'link_artifact',
  'link_features',
  'record_completion',
  'propose_followup',
];

/**
 * The eight judgment WRITE tools (COMP-JUDGMENT-WRITER, shipped @751cc96a).
 * get_judgment_state is read-only and is deliberately NOT here. Every mutation
 * of docs/judgment/** — records under records/ and the generated projections
 * (REGISTER/LEDGER/OBJECTIVE/SITUATION/index.md, people/*.md, positions/*.md) —
 * goes through one of these, which regenerate the projections atomically.
 */
export const JUDGMENT_WRITE_TOOLS = [
  'judgment_position_create',
  'judgment_position_amend',
  'judgment_joint_add',
  'judgment_transition',
  'judgment_ledger_append',
  'judgment_person_write',
  'judgment_situation_write',
  'judgment_goal_write',
];

// ── Matchers ─────────────────────────────────────────────────────────────────
// A matcher is (path, { featuresDir }) => boolean. featuresDir is relative and
// project-configurable (loadFeaturesDir), so the feature.json matcher is
// parameterized; fixed-name and docs/judgment matchers ignore it.

function matchExact(name) {
  return (path) => path === name;
}

/** startsWith(<featuresDir>/) && endsWith(/feature.json) — mirrors the legacy
 * isGuardedPath exactly (does NOT require a single-segment middle; that
 * constraint lives only in code-correlation, below). */
function matchFeatureJson(path, featuresDir) {
  if (typeof path !== 'string' || !featuresDir) return false;
  const prefix = featuresDir.replace(/\/$/, '') + '/';
  if (!path.startsWith(prefix)) return false;
  return path.endsWith('/feature.json');
}

/** Anything under docs/judgment/ (records or projections). Fixed root — matches
 * lib/judgment-gen.js, which hardcodes docs/judgment/. */
function matchJudgment(path) {
  return typeof path === 'string' && path.startsWith('docs/judgment/');
}

// ── The registry ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} CanonEntry
 * @property {string} id            — stable identifier
 * @property {string} writer        — the module that legitimately produces this path
 * @property {string[]} tools       — typed tools authorised to write it
 * @property {Array<'ship'|'hook'|'pre-commit'>} enforcedBy — points that guard it
 * @property {(path:string, featuresDir:string)=>boolean} matches
 */

/** @type {CanonEntry[]} */
const REGISTRY = [
  {
    id: 'roadmap',
    writer: 'lib/roadmap-gen.js',
    tools: TOOLS_FOR_ROADMAP,
    enforcedBy: ['ship'],
    matches: matchExact('ROADMAP.md'),
  },
  {
    id: 'changelog',
    writer: 'lib/changelog-writer.js',
    tools: TOOLS_FOR_CHANGELOG,
    enforcedBy: ['ship'],
    matches: matchExact('CHANGELOG.md'),
  },
  {
    id: 'feature-json',
    writer: 'lib/feature-writer.js',
    tools: TOOLS_FOR_FEATURE_JSON,
    enforcedBy: ['ship'],
    matches: (path, featuresDir) => matchFeatureJson(path, featuresDir),
  },
  {
    id: 'judgment',
    writer: 'lib/judgment-writer.js',
    tools: JUDGMENT_WRITE_TOOLS,
    enforcedBy: ['hook'],
    matches: (path) => matchJudgment(path),
  },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the registry entry guarding `path` at enforcement `point`, or null.
 * Only entries whose `enforcedBy` includes the point are considered — this is
 * the per-point-subset invariant.
 *
 * @param {string} path
 * @param {{ featuresDir?: string, point: 'ship'|'hook'|'pre-commit' }} opts
 * @returns {CanonEntry|null}
 */
export function matchEntry(path, { featuresDir, point }) {
  for (const entry of REGISTRY) {
    if (!entry.enforcedBy.includes(point)) continue;
    if (entry.matches(path, featuresDir)) return entry;
  }
  return null;
}

/** True if `path` is guarded at `point`. */
export function isGuarded(path, opts) {
  return matchEntry(path, opts) !== null;
}

/** The typed tools authorised to write `path` at `point`, or [] if unguarded. */
export function toolsForPath(path, opts) {
  const entry = matchEntry(path, opts);
  return entry ? [...entry.tools] : [];
}

/**
 * The feature code for a feature.json path (single-segment middle), else null.
 * Used for ship-scan code correlation so an event for feature A cannot bless a
 * dirty edit to feature B's feature.json.
 *
 * @param {string} path
 * @param {{ featuresDir: string }} opts
 * @returns {string|null}
 */
export function featureCodeForPath(path, { featuresDir }) {
  if (typeof path !== 'string' || !featuresDir) return null;
  const prefix = featuresDir.replace(/\/$/, '') + '/';
  if (!path.startsWith(prefix) || !path.endsWith('/feature.json')) return null;
  const middle = path.slice(prefix.length, -'/feature.json'.length);
  if (!middle || middle.includes('/')) return null;
  return middle;
}

/** The entry ids guarded at `point` (for the contract test + introspection). */
export function guardedPatternIdsFor(point) {
  return REGISTRY.filter((e) => e.enforcedBy.includes(point)).map((e) => e.id);
}

export const _internals = {
  REGISTRY,
  TOOLS_FOR_ROADMAP,
  TOOLS_FOR_CHANGELOG,
  TOOLS_FOR_FEATURE_JSON,
  JUDGMENT_WRITE_TOOLS,
};
