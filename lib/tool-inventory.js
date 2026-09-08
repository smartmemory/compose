/**
 * tool-inventory.js — COMP-COVERAGE-GATE slice 1.
 *
 * The single derived answer to "which MCP tools change state, and what canon do
 * they write". Pure, no I/O (shape template: server/mcp-tool-policy.js).
 *
 * WHY THIS EXISTS. Compose kept three hand-maintained lists that each partially
 * described the mutating surface — canon-registry's TOOLS_FOR_* /
 * JUDGMENT_WRITE_TOOLS, and mcp-tool-policy's IMPLEMENTER_DENY / REVIEWER_ALLOW
 * — and NONE of them was the inventory. Nothing enumerated every mutating tool,
 * and nothing cross-checked the three against the tool definitions themselves.
 * A tool added to server/compose-mcp.js was enforced only where an author
 * remembered to name it. Same shape as COMP-COMPLETION-GATE, where guard
 * coverage turned out to be 0/321 — discovered by audit, not by a check.
 *
 * The fix is to put the declaration ON the tool definition (`effect`, `writes`)
 * and DERIVE the sets from it. A side list is a fourth thing to forget; a
 * required field on the definition cannot be added without the author seeing it.
 *
 * FAIL-CLOSED HERE, FAIL-OPEN AT RUNTIME. A tool with no `effect` is reported as
 * `undeclared` and fails validate_project. That is safe because this module runs
 * at validate time and never in a request path — unlike canon-guard.js, which
 * fails open so a malformed input can never wedge a session.
 */

/** Valid `effect` values on a tool definition. */
export const EFFECTS = /** @type {const} */ (['read', 'mutating', 'setup']);

/**
 * Canon path ids a `writes` entry may name — the `id` field of each
 * lib/canon-registry.js REGISTRY entry. Kept as a literal rather than imported
 * so this module stays dependency-free and pure; `checkAuthorizationCoverage`
 * (slice 2) validates `writes` against the live registry, which is where a
 * drifted id must be caught. This set is only for the shape check below.
 */
export const CANON_IDS = new Set([
  'roadmap', 'changelog', 'feature-json', 'judgment',
]);

/**
 * Partition tool definitions by declared effect.
 *
 * @param {Array<{name?: string, effect?: string, writes?: string[]}>} toolDefs
 * @returns {{
 *   read: string[], mutating: string[], setup: string[],
 *   undeclared: Array<{ name: string, reason: string }>,
 *   writesByTool: Record<string, string[]>,
 * }}
 */
export function loadToolInventory(toolDefs) {
  const read = [];
  const mutating = [];
  const setup = [];
  const undeclared = [];
  /** @type {Record<string, string[]>} */
  const writesByTool = {};

  if (!Array.isArray(toolDefs)) return { read, mutating, setup, undeclared, writesByTool };

  for (const def of toolDefs) {
    const name = def && typeof def.name === 'string' ? def.name : null;
    if (!name) {
      undeclared.push({ name: '<unnamed>', reason: 'tool definition has no name' });
      continue;
    }

    const effect = def.effect;
    if (!EFFECTS.includes(effect)) {
      undeclared.push({
        name,
        reason: effect === undefined
          ? 'no `effect` field'
          : `unknown effect '${effect}' (expected ${EFFECTS.join('|')})`,
      });
      continue;
    }

    if (effect === 'read') { read.push(name); continue; }
    if (effect === 'setup') { setup.push(name); continue; }

    // effect === 'mutating' — `writes` is required, `[]` being a real answer
    // ("mutates state, but no CANON path"). Distinguishing "declared empty"
    // from "forgot to declare" is the entire point of requiring the field.
    if (!Array.isArray(def.writes)) {
      undeclared.push({ name, reason: 'mutating tool has no `writes` array (use [] for non-canon writes)' });
      continue;
    }
    const bad = def.writes.filter((w) => !CANON_IDS.has(w));
    if (bad.length > 0) {
      undeclared.push({ name, reason: `\`writes\` names unknown canon id(s): ${bad.join(', ')}` });
      continue;
    }
    mutating.push(name);
    writesByTool[name] = [...def.writes];
  }

  return { read, mutating, setup, undeclared, writesByTool };
}

/**
 * The derived mutating set. Deliberately a function of the definitions rather
 * than a literal — a literal is exactly the drift this feature exists to stop.
 *
 * @param {Array<{name?: string, effect?: string, writes?: string[]}>} toolDefs
 * @returns {Set<string>}
 */
export function mutatingTools(toolDefs) {
  return new Set(loadToolInventory(toolDefs).mutating);
}

/**
 * Tools that write a given canon path id, derived from `writes`.
 *
 * @param {Array<{name?: string, effect?: string, writes?: string[]}>} toolDefs
 * @param {string} canonId
 * @returns {string[]}
 */
export function toolsWritingCanon(toolDefs, canonId) {
  const { writesByTool } = loadToolInventory(toolDefs);
  return Object.keys(writesByTool).filter((t) => writesByTool[t].includes(canonId)).sort();
}
