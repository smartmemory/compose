/**
 * coverage-gate.js — COMP-COVERAGE-GATE slice 2.
 *
 * The check half of the feature. Slice 1 made the mutating surface DECLARED
 * (`effect`/`writes` on every tool definition, derived by lib/tool-inventory.js);
 * this module cross-checks that declaration against the two lists that are
 * supposed to govern it — lib/canon-registry.js entries and
 * server/mcp-tool-policy.js profile policy — and reports what neither accounts
 * for.
 *
 * Pure, no I/O. Callers supply the three inputs (shape template:
 * server/mcp-tool-policy.js).
 *
 * WHAT THIS ANSWERS. "Could this tool ever be enforced?" — not "was this call
 * allowed?". It is a static check over declarations and adds NO enforcement
 * point (design Decision 3); the runtime points (`hook`, `ship`, the MCP
 * CallTool dispatch) are untouched, and the blast radius is validate_project's
 * output.
 *
 * ADVISORY, WITH ONE HARD TIER (design Decision 2). Only MISSING_EFFECT is an
 * error: it is unambiguous and one-line-fixable. C2–C4 encode conventions that
 * can have legitimate exceptions, and a gate that blocks on a judgment call
 * gets disabled.
 *
 * EVERY FINDING CARRIES A REMEDIATION, NOT A VERDICT (design Decision 4) — a
 * specific instruction naming the file and the list to edit. That is the one
 * PolicyGuide (arXiv:2608.19861 §3.3) result that transfers at zero cost:
 * returning the required NEXT ACTION changes agent behavior where a bare
 * allow/deny does not.
 *
 * HONEST LIMIT. This checks declarations, not behavior. A tool declaring
 * `writes: []` while writing feature.json through a helper passes every check
 * here. Closing that needs runtime write-path attribution — the `ship` point's
 * correlation job, not this one.
 */

/**
 * C4 exceptions — mutating tools an implementer-profile session is INTENDED to
 * call, so their absence from IMPLEMENTER_DENY is a decision, not an omission.
 *
 * This list lives next to the check rather than in a doc on purpose: a doc
 * nobody loads is how the three lists drifted in the first place (design, Open
 * Questions). Adding a tool here is a recorded ruling and needs a reason.
 *
 * The bar: does an implementer doing ordinary feature work need it? Recording
 * its own artifacts, notes and iteration state — yes. Granting itself
 * authority, or writing the decision record — no.
 */
export const C4_EXCEPTIONS = {
  scaffold_feature: 'implementer creates the feature folder templates it then fills in',
  link_artifact: 'implementer records the artifacts it produced',
  link_features: 'implementer records dependencies it discovered while building',
  write_journal_entry: 'implementer progress notes — non-canon, append-only',
  write_checkpoint: 'implementer checkpoints its own run — non-canon',
  start_iteration_loop: 'the iteration loop is driven BY the implementer',
  report_iteration_result: 'the iteration loop is driven BY the implementer',
  abort_iteration_loop: 'the implementer must be able to stop its own loop',
  add_changelog_entry: 'CHANGELOG entry ships in the same commit as the code (documentation standard)',
};

/** Findings are reported in this order — most actionable first. */
const CODE_RANK = ['MISSING_EFFECT', 'UNGATED_MUTATION', 'ORPHAN_REGISTRY_TOOL', 'UNCOVERED_WRITE'];

/**
 * @param {object} args
 * @param {{read:string[], mutating:string[], setup:string[],
 *          undeclared:Array<{name:string,reason:string}>,
 *          writesByTool:Record<string,string[]>}} args.inventory
 *   — lib/tool-inventory.js loadToolInventory() result.
 * @param {Array<{id:string, display?:string, tools:string[]}>} args.registry
 *   — lib/canon-registry.js canonEntries().
 * @param {{PROFILE_POLICY:object, PHASE_REFINEMENT?:object}} args.policy
 *   — server/mcp-tool-policy.js.
 * @returns {{ findings: Array<{code:string, tool:string, path?:string,
 *             severity:'error'|'warning'|'info', remediation:string}> }}
 */
export function checkAuthorizationCoverage({ inventory, registry, policy } = {}) {
  const findings = [];

  const inv = inventory || {};
  const undeclared = Array.isArray(inv.undeclared) ? inv.undeclared : [];
  const mutating = Array.isArray(inv.mutating) ? inv.mutating : [];
  const writesByTool = inv.writesByTool || {};
  const entries = Array.isArray(registry) ? registry : [];

  // Every name the inventory has SEEN, declared or not — an undeclared tool
  // still exists, so it must not also be reported as an orphan (C3).
  const known = new Set([
    ...(inv.read || []), ...mutating, ...(inv.setup || []),
    ...undeclared.map((u) => u.name),
  ]);

  // ── C1 MISSING_EFFECT (hard) ───────────────────────────────────────────────
  // Fail-closed on the declaration. This is the only check that can fail a
  // validate run, because the fix is a single field with no judgment in it.
  for (const { name, reason } of undeclared) {
    findings.push({
      code: 'MISSING_EFFECT',
      tool: name,
      severity: 'error',
      remediation: `add \`effect: 'read' | 'mutating' | 'setup'\` to the '${name}' definition in server/mcp-tool-defs.js (${reason}); a mutating tool also needs \`writes: []\``,
    });
  }

  // ── C4 UNGATED_MUTATION (the headline) ─────────────────────────────────────
  // PROFILE_POLICY is the only one of the three lists that is actually
  // ENFORCED — at the server/compose-mcp.js CallTool dispatch. A mutating tool
  // named by none of its lists is callable by an implementer-profile session
  // and nothing anywhere records whether that was intended.
  const profilePolicy = (policy && policy.PROFILE_POLICY) || {};
  const denyTools = _toolSet(profilePolicy.implementer);
  const allowTools = _toolSet(profilePolicy.reviewer);
  const refinementTools = new Set();
  for (const set of Object.values((policy && policy.PHASE_REFINEMENT) || {})) {
    for (const t of _iter(set)) refinementTools.add(t);
  }

  for (const tool of mutating) {
    if (Object.prototype.hasOwnProperty.call(C4_EXCEPTIONS, tool)) continue;
    if (denyTools.has(tool) || refinementTools.has(tool) || allowTools.has(tool)) continue;
    findings.push({
      code: 'UNGATED_MUTATION',
      tool,
      severity: 'warning',
      remediation: `'${tool}' mutates state but is named by no profile list — add it to IMPLEMENTER_DENY in server/mcp-tool-policy.js, or record why an implementer may call it in C4_EXCEPTIONS (lib/coverage-gate.js)`,
    });
  }

  // ── C3 ORPHAN_REGISTRY_TOOL ────────────────────────────────────────────────
  // Reverse drift: the registry names a tool that no longer exists. Catches
  // renames, which are otherwise silent — a renamed tool leaves its old name
  // in a deny message that will never match anything again.
  for (const entry of entries) {
    for (const tool of entry.tools || []) {
      if (known.has(tool)) continue;
      findings.push({
        code: 'ORPHAN_REGISTRY_TOOL',
        tool,
        path: entry.id,
        severity: 'warning',
        remediation: `canon entry '${entry.id}' names tool '${tool}', which is not in the tool inventory — remove it from lib/canon-registry.js, or restore the tool definition in server/mcp-tool-defs.js if it was renamed`,
      });
    }
  }

  // ── C2 UNCOVERED_WRITE (minor) ─────────────────────────────────────────────
  // `entry.tools` has exactly ONE consumer — lib/canon-guard.js joins it into
  // the deny message ("use one of these tools instead"). It is never an
  // allow/deny input. So this keeps the REMEDIATION MESSAGE honest; it does not
  // close a hole. Ranked last for that reason.
  const entryById = new Map(entries.map((e) => [e.id, e]));
  for (const tool of mutating) {
    for (const canonId of writesByTool[tool] || []) {
      const entry = entryById.get(canonId);
      if (!entry) continue; // an unknown canon id is tool-inventory's `undeclared` job
      if ((entry.tools || []).includes(tool)) continue;
      findings.push({
        code: 'UNCOVERED_WRITE',
        tool,
        path: canonId,
        severity: 'info',
        remediation: `'${tool}' declares it writes '${entry.display || canonId}' but is absent from that entry's tool list — add it in lib/canon-registry.js so a denied raw edit is offered it as an alternative`,
      });
    }
  }

  findings.sort((a, b) => {
    const r = CODE_RANK.indexOf(a.code) - CODE_RANK.indexOf(b.code);
    return r !== 0 ? r : a.tool.localeCompare(b.tool);
  });
  return { findings };
}

/** PROFILE_POLICY entries carry `tools` as a Set; tolerate an array or absence. */
function _toolSet(profile) {
  return new Set(_iter(profile && profile.tools));
}

function _iter(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return v;
  return [];
}
