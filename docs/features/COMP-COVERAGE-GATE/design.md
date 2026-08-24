# COMP-COVERAGE-GATE: Design

**Status:** SLICE 1 COMPLETE — slice 2 not started
**Date:** 2026-08-24

## Related Documents

- ROADMAP row: `ROADMAP.md` → Backlog #7 (COMP-COVERAGE-GATE)
- Origin note: `docs/plans/2026-08-24-authorization-coverage-gate-design.md` (stub → this file)
- Prior art: PolicyGuide, arXiv:2608.19861 §3.3 Stage 6 — "mutating-tool authorization coverage"
- Consumes: `lib/canon-registry.js` (path → writer → tools → enforcement points)
- Consumes: `server/mcp-tool-policy.js` (profile × phase tool policy)
- Extends: `lib/feature-validator.js`, `server/validate-routes.js`, `validate_project`
- Related: COMP-CANON-GUARD, COMP-MCP-ENFORCE-1, COMP-COMPLETION-GATE

---

## Problem

Compose keeps three hand-maintained lists that each partially describe which MCP
tools mutate state:

| List | File | Purpose |
|---|---|---|
| `TOOLS_FOR_ROADMAP` / `_CHANGELOG` / `_FEATURE_JSON` / `_OVERRIDE` / `JUDGMENT_WRITE_TOOLS` | `lib/canon-registry.js` | which tools legally write a canon path |
| `IMPLEMENTER_DENY` | `server/mcp-tool-policy.js` | management tools an implementer must not wield |
| `REVIEWER_ALLOW` | `server/mcp-tool-policy.js` | read-only allowlist |

**No list is the inventory.** Nothing enumerates "every tool that mutates state",
and nothing cross-checks the three against each other or against the 51 tool
definitions in `server/compose-mcp.js`. A tool added to `compose-mcp.js` is
enforced only where an author remembered to name it.

Same class of hole as COMP-COMPLETION-GATE, where guard coverage was found to be
0/321 by audit rather than by a check. PolicyGuide's Stage 6 makes the equivalent
property a **compile-time refusal**: a workflow does not load unless every
mutating tool is enabled by some authorization node.

### Current state (measured 2026-08-24)

A heuristic classification (name not matching
`get_|validate_|roadmap_diff|roadmap_graph|assess_`, minus the three
`SETUP_TOOLS`) yields 26 mutating tools of 51. Ten are named by no
`canon-registry` entry: `kill_feature`, `complete_feature`,
`start_iteration_loop`, `report_iteration_result`, `abort_iteration_loop`,
`scaffold_feature`, `approve_gate`, `roadmap_xref_push`, `write_journal_entry`,
`write_checkpoint`.

**Traced 2026-08-24 — the originating hunch was largely disconfirmed:**

- `scaffold_feature` — **clear.** Writes only the six markdown templates
  (`design.md`, `prd.md`, `architecture.md`, `blueprint.md`, `plan.md`,
  `report.md`) via `ArtifactManager.scaffold()`. `feature.json` is not in
  `ARTIFACT_SCHEMAS` and the string does not appear in
  `server/artifact-manager.js`.
- `complete_feature` / `kill_feature` — **do write `feature.json`**, server-side
  via `_postLifecycle` → `server/vision-routes.js` (status write-back at :366,
  kill→KILLED at :451), and neither is in `TOOLS_FOR_FEATURE_JSON`. Real, but
  minor — see below.
- The remaining seven write non-canon paths or delegate to REST. Correctly absent.

### What the trace reframed

**`entry.tools` has exactly one consumer.** `lib/canon-guard.js:128` joins it into
the deny message ("use one of these tools instead"). It is never an input to an
allow/deny decision. And `feature.json` is `enforcedBy: ['ship']`, so the
write-time hook never consults its entry at all.

`TOOLS_FOR_FEATURE_JSON` is therefore **help text, not a boundary.** The
`complete_feature` omission means an agent denied a raw edit would be handed an
incomplete list of alternatives — a usability defect, not a guard hole.

This demotes C2 from the headline check to a minor one and promotes C4, which
tests `PROFILE_POLICY` — the list that *is* enforced, at `server/compose-mcp.js`
dispatch.

## Goal

`validate_project` reports, mechanically, which mutating tools are unaccounted
for in each of the three lists — and refuses outright when a tool declares no
effect at all.

**In scope:** the tool surface (slices 1–2).
**Not in scope:** the pipeline graph (unreachable steps, per-step `authorizes:`)
— split out, gated on slices 1–2 finding something real. Also not in scope: the
paper's online verifier (turn-boundary firing, persisted graph position,
remediation injection). That is a much larger bet — they measure 5.5× wall-clock
and ~$0.40/conversation — and should not be taken until the static half proves
the graph is well-formed.

**Success:** a tool added to `server/compose-mcp.js` without an `effect`
declaration fails `validate_project`. Every C2–C4 finding is either fixed or
carries a recorded exception next to the check.

---

## Decision 1: The inventory is declared at the tool definition, not in a side list

`server/compose-mcp.js` already holds all 51 tools in one array literal. Each
gains two fields. A side list would be a fourth thing to forget; a field on the
definition cannot be added without the author seeing it.

```js
{
  name: 'record_completion',
  writes: ['feature.json'],        // canon-registry path keys, or [] for none
  effect: 'mutating',              // 'read' | 'mutating' | 'setup'
  ...
}
```

`effect` is required. A tool with no `effect` fails validation — **fail-closed on
the declaration, fail-open on the runtime** (matching `canon-guard.js`, which
fails open so a malformed input never wedges a session).

## Decision 2: Advisory by default, with one hard tier

Following PolicyGuide's advisory runtime, findings are reported, not thrown —
except `MISSING_EFFECT`, which is a hard failure because it is unambiguous and
one-line-fixable. Everything else can have a legitimate exception, and a gate
that blocks on a judgment call gets disabled.

## Decision 3: No new enforcement point

The gate is a *static* check over declarations. It does not intercept calls. It
answers "could this tool ever be enforced?", not "was this call allowed?" The
runtime points (`hook`, `ship`) are unchanged. Blast radius is confined to
`validate_project` output.

## Decision 4: Findings carry a remediation, not a verdict

Each finding is `{ code, tool, path?, severity, remediation }`, where
`remediation` is a specific instruction ("add `complete_feature` to
`TOOLS_FOR_FEATURE_JSON`"). PolicyGuide's result is that returning the *required
next action* is what changes agent behavior where a bare verdict does not — the
one finding from the paper that transfers at zero cost.

---

## Files

### Slice 1 — Declare the inventory

- `server/compose-mcp.js` (existing) — add `effect` to all 51 tool defs; add `writes` to every mutating one
- `lib/tool-inventory.js` (new) — pure `loadToolInventory(toolDefs)` → `{ read, mutating, setup, undeclared }`; no I/O, shape template `server/mcp-tool-policy.js`
- `test/` (new) — contract test pinning the derived mutating set against the 26-tool heuristic result, each intentional difference annotated

Acceptance criteria:

- [x] `effect: 'read' | 'mutating' | 'setup'` on all 51 tool definitions
- [x] `writes: string[]` on every `effect: 'mutating'` tool (`[]` when it writes no canon path)
- [x] `mutatingTools(toolDefs)` returns a derived `Set`, not a literal
- [x] Contract test pins the derived set; each difference from the heuristic annotated with its reason (`test/tool-inventory.test.js`, 15 tests)
- [x] **Gate:** `loadToolInventory` returns `undeclared: []` against the live tool array — PASSING

Three tools need an explicit ruling recorded in the file, because the naming
heuristic gets them wrong or cannot decide:

- `approve_gate` — mutates gate state, writes no canon path → `mutating`, `writes: []`
- `roadmap_xref_push` — **corrected during slice 1.** Writes EXTERNAL trackers
  (github issues, sibling repos via their own `setFeatureStatus`), never this
  repo's ROADMAP.md → `mutating`, `writes: []`. The design's original ruling was
  wrong; a third guess about this surface from the tool name alone.
- `compose_resume` — reads state to produce a resume prompt → `read`

### Slice 2 — The coverage check

- `lib/coverage-gate.js` (new) — pure `checkAuthorizationCoverage({ inventory, registry, policy })` → `{ findings }`
- `lib/feature-validator.js` (existing) — wire the `coverage` section
- `server/validate-routes.js` (existing) — surface it on `validate_project`

Acceptance criteria:

- [ ] **C1 `MISSING_EFFECT`** (hard) — tool definition with no `effect` field
- [ ] **C4 `UNGATED_MUTATION`** (headline — the enforced list) — an `effect: 'mutating'` tool in neither `IMPLEMENTER_DENY` nor `PHASE_REFINEMENT`, and not in `REVIEWER_ALLOW`: an implementer-profile session can call it and nothing records whether that is intended
- [ ] **C3 `ORPHAN_REGISTRY_TOOL`** — a registry entry names a tool absent from the inventory (reverse drift; catches renames)
- [ ] **C2 `UNCOVERED_WRITE`** (minor) — tool declares `writes: ['X']` but is absent from `X`'s registry tool list. Keeps the *remediation message* honest rather than closing a hole. Known instances: `complete_feature`, `kill_feature` → `feature.json`
- [ ] Wired into `validate_project` under a `coverage` section; absent from `validate_feature` (project-level property)
- [ ] `MISSING_EFFECT` fails the overall validate result; C2–C4 report only
- [ ] Table-driven error harness over the four codes
- [ ] **Gate:** runs against the live registry, zero `MISSING_EFFECT`; every C2–C4 finding fixed or exception-recorded

---

## Open Questions

- **C4's exception list.** C4 encodes a convention, not a rule, and will produce
  findings that are correct-as-designed. Where does the exceptions list live?
  Proposal: next to the check in `lib/coverage-gate.js`, not in a doc — a doc
  nobody loads is how the three lists drifted in the first place.
- **Is `writes` worth its cost given C2's demotion?** C2 is now the weakest
  check, and `writes` exists mostly to feed it. Counter-argument for keeping it:
  it is the only field that would make the pipeline-graph slice possible later,
  and it is cheap to declare while someone is already touching all 51 defs.
  Decide before slice 1, not during.
- **Does anything else consume `entry.tools`?** Verified one consumer today
  (`canon-guard.js:128`). Re-check before relying on that in slice 2 — the
  finding is what demoted C2, so it is load-bearing.

---

## Honest limits

- The gate checks *declarations*, not behavior. A tool declaring `writes: []`
  while writing `feature.json` through a helper passes. Closing that needs
  runtime write-path attribution — the `ship`-point correlation's job.
- Nothing here helps with the Bash/Codex bypass already documented as an honest
  limit of `canon-guard.js`. Same runtime-scoped bucket.
- The 26-tool heuristic in "Current state" is a regex over tool names and is
  PLAUSIBLE, not CONFIRMED, except for the four tools traced individually.
  Slice 1 exists to replace it with a declaration.

---

## Slice 1 implementation notes (2026-08-24)

**Files:**
- `server/mcp-tool-defs.js` (new) — the 51 definitions, extracted data-only
- `server/compose-mcp.js` (modified) — imports `TOOLS`; strips `effect`/`writes` at the ListTools boundary
- `lib/tool-inventory.js` (new) — `loadToolInventory`, `mutatingTools`, `toolsWritingCanon`, `CANON_IDS`
- `test/tool-inventory.test.js` (new) — 15 tests

**Final partition:** 4 setup / 21 read / 26 mutating = 51.

**Two things the work surfaced that the design got wrong:**

1. **`roadmap_xref_push` writes external trackers, not our ROADMAP.** Corrected
   above. That is now three name-based guesses about this tool surface, two of
   them wrong (`scaffold_feature`, `roadmap_xref_push`) — which is the argument
   for the declaration, made better by the design than by the design's author.

2. **The definitions had to be extracted before they could be read.**
   `server/compose-mcp.js` connects a `StdioServerTransport` at module load, so
   importing it for `TOOLS` hangs the importer — the contract test hit this
   immediately. Hence `server/mcp-tool-defs.js`. Unplanned, and the right shape
   anyway: data with no imports and no I/O.

**One defect found and fixed en route.** `ListTools` returned `TOOLS` directly,
so once annotated, `effect` and `writes` appeared in every `tools/list` response
on the wire. Stripped via `toWire()` at the single handler boundary, with a
contract test pinning the wire shape. Verified over stdio: 51 tools listed, keys
exactly `['description', 'inputSchema', 'name']`.

**Four text-scanning tests broke, and only the full suite caught them.**
`test/artifact-manager.test.js`, `test/lifecycle-routes.test.js`, and two in
`test/judgment-writer-mcp.test.js` read `server/compose-mcp.js` as a STRING and
asserted `name: '<tool>'` appeared in it — invisible to grep for imports of
`TOOLS`, and green in every targeted MCP suite I ran first. Fixed by pointing the
definition half at `server/mcp-tool-defs.js` and leaving the dispatch-switch half
on `server/compose-mcp.js`. This is [[feedback_strict_contract_seams]] again:
enumerate every runtime that READS a declaration, not just the ones that import it.

Full suite after the fixes: 5884 pass, 1 pre-existing failure
(`ts-cutover-consumer-fanout-golden`, a 90s timeout under full-suite parallelism;
40/40 in isolation — the known proof-run hang, unrelated).

**Not done:** slice 2. The inventory now exists; whether C2–C4 earn their keep is
a question to answer against it, not ahead of it.
