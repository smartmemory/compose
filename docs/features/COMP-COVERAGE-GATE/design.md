# COMP-COVERAGE-GATE: Design

**Status:** SLICE 1 COMPLETE — SLICE 2 COMPLETE — C4 findings CLOSED
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

- [x] **C1 `MISSING_EFFECT`** (hard) — tool definition with no `effect` field
- [x] **C4 `UNGATED_MUTATION`** (headline — the enforced list) — an `effect: 'mutating'` tool in neither `IMPLEMENTER_DENY` nor `PHASE_REFINEMENT`, and not in `REVIEWER_ALLOW`: an implementer-profile session can call it and nothing records whether that is intended
- [x] **C3 `ORPHAN_REGISTRY_TOOL`** — a registry entry names a tool absent from the inventory (reverse drift; catches renames)
- [x] **C2 `UNCOVERED_WRITE`** (minor) — tool declares `writes: ['X']` but is absent from `X`'s registry tool list. Keeps the *remediation message* honest rather than closing a hole. Known instances: `complete_feature`, `kill_feature` → `feature.json` — **both fixed**, C2 is now zero
- [x] Wired into `validate_project` under a `coverage` section; absent from `validate_feature` (project-level property)
- [x] `MISSING_EFFECT` fails the overall validate result; C2–C4 report only
- [x] Table-driven error harness over the four codes (`test/coverage-gate.test.js`, 26 tests)
- [x] **Gate:** runs against the live registry, zero `MISSING_EFFECT`, zero `ORPHAN_REGISTRY_TOOL`, zero `UNCOVERED_WRITE`; the 10 `UNGATED_MUTATION` are pinned in the test and recorded below — see "the gate's first real output"

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

---

## Slice 2 implementation notes (2026-08-24)

**Files:**
- `lib/coverage-gate.js` (new) — `checkAuthorizationCoverage({ inventory, registry, policy })`, pure, plus the `C4_EXCEPTIONS` ruling list
- `lib/canon-registry.js` (modified) — new `canonEntries()` public accessor (`_internals` is test-only); `complete_feature`/`kill_feature` added to `TOOLS_FOR_FEATURE_JSON`
- `lib/feature-validator.js` (modified) — `runCoverageCheck()` called from `validateProject`; 5 kinds added to the catalog header
- `test/coverage-gate.test.js` (new) — 26 tests: error harness, clean cases, robustness, ranking, the live gate, the wiring

**No route change was needed.** Both `server/validate-routes.js` and
`toolValidateProject` (`server/compose-mcp-tools.js:579`) pass the validator
result through verbatim, so `coverage` surfaces on `GET /api/validate` and the
`validate_project` MCP tool for free.

**Findings go to two places on purpose.** They are pushed into the main
`findings` array (tagged `source: 'coverage'`) AND returned structured under
`result.coverage`. The array gives the CLI exit code, `--block-on` and the REST
severity rollup the right behavior with no per-consumer fork; the section gives
callers the codes and remediations without re-parsing prose.

### The gate's first real output

The feature was scoped "gated on slices 1–2 finding something real". It found
**twelve**, of which ten are open.

**C2 (2) — FIXED.** `complete_feature` and `kill_feature` added to
`TOOLS_FOR_FEATURE_JSON`. Verified safe first: `entry.tools` has ONE consumer
(`lib/canon-guard.js:128`, the deny message), and `expectedToolsForPath` — the
ship point's accessor for it — has **no production callers at all**, only tests.
The edit therefore widens no enforcement; it stops a rejection message from
omitting two legitimate alternatives. The contract test's "legacy byte-for-byte"
pin was updated deliberately, with the reason recorded next to it.

**C4 (10) — REAL, OPEN, deliberately NOT auto-fixed.** Each is a mutating tool an
implementer-profile session can call today with nothing recording whether that
was intended:

| Tool(s) | Why it matters |
|---|---|
| `canon_override_grant` | An implementer can mint its own canon bypass. The override was designed so it could not be turned on its own governance state — but nothing stops the profile that is *subject* to canon enforcement from granting itself an exemption from it. |
| the 8 `judgment_*` writers | `mcp-tool-policy.js` explicitly reasoned about these for the reviewer allowlist ("the eight judgment write tools stay reviewer-denied") and never about the implementer. The decision record is writable by the profile whose decisions it records. |
| `roadmap_xref_push` | Writes EXTERNAL trackers (github issues, sibling repos) from an implementer session. |

They report as **advisory warnings**, not errors, because closing them means
editing `IMPLEMENTER_DENY`, which changes what implementer sessions may do at
runtime. That is a policy decision with its own blast radius, not a coverage fix,
and it is the natural next slice. Until then the set is pinned in
`test/coverage-gate.test.js` so an eleventh cannot appear silently.

**The C4 exception list lives in `lib/coverage-gate.js`**, resolving the design's
open question. Nine tools are excepted (`scaffold_feature`, `link_artifact`,
`link_features`, `write_journal_entry`, `write_checkpoint`, the three
iteration-loop tools, `add_changelog_entry`) — each with a one-line reason, and a
gate test asserts every exception still names a live mutating tool, so a rename
or deletion turns a stale exception into a failure rather than a silent hole.

### The other open question, answered

*"Is `writes` worth its cost given C2's demotion?"* — Yes, narrowly. C2 found
exactly the two instances predicted and they are now closed, so as a *check* it
is spent. But `writes` is what made C3 (`ORPHAN_REGISTRY_TOOL`) and the
registry↔inventory join possible at all, and it remains the only field a
pipeline-graph slice could build on. Keep it; expect no further findings from C2.

### Not done

The pipeline-graph slice (unreachable steps, per-step `authorizes:`) and the
online verifier remain out of scope, unchanged from the original ruling.


---

## C4 closure (2026-08-24, same day)

The ten `UNGATED_MUTATION` findings were left open above pending a policy call.
That call was made, and it split two ways. The live gate now returns **zero
findings of any code**, and the pinned-set test became a zero-findings
assertion — a new mutating tool nobody rules on now FAILS the suite rather than
becoming a warning nobody reads.

**Two DENIED — added to `IMPLEMENTER_DENY`.** `canon_override_grant` and
`roadmap_xref_push`. Both postdate COMP-MCP-ENFORCE-1's charter ("cannot
self-approve, self-complete, or mutate roadmap status") and no design ever ruled
that an implementer may call them. The override case is the sharper one:
COMP-CANON-OVERRIDE reasoned that the override must not be grantable for its own
governance state (`overrideEligible: false`), and this is the same argument one
level up — at the caller instead of the target. Verified first that no pipeline
spec, prompt template or server flow invokes either from an implementer session.

**Eight RECORDED AS AN EXISTING RULING — added to `C4_EXCEPTIONS`.** The eight
`judgment_*` writers. `COMP-JUDGMENT-WRITER/design.md:137` rules that the write
tools "stay implementer/orchestrator-only", with a provenance argument aimed
squarely at reviewers. Denying them would have silently reversed a design
decision under the cover of a coverage fix.

**How that was caught is the interesting part.** The first attempt denied all
ten. Targeted runs were green; the FULL suite failed on
`test/judgment-writer-mcp.test.js:668` — "implementer and orchestrator may write
judgment canon", a test whose *name* is the ruling. This is the third time on
this feature that only the full suite caught a cross-cutting break
([[reference_dead_paths_under_green_suites]]), and the first time the thing it
protected was a DECISION rather than a wiring path.

It also revalidates the gate's own premise from the other direction: C4's job is
to force the question, and for eight of ten the correct answer was "already
answered, in prose, where no check could see it". Recording the ruling in
`C4_EXCEPTIONS` is what moves it somewhere a check CAN see.

**One defect the fix introduced, and closed.** `lib/canon-guard.js` ends every
deny message with "mint a single-use grant with `canon_override_grant`" — now a
tool the implementer profile cannot call. An implementer subagent hitting a canon
block would have been sent straight into its own tool gate and looped.
`decideCanonGuard` now takes an optional `profile` (the hook wrapper passes the
spawn-injected, un-rewritable `COMPOSE_SESSION_PROFILE`) and swaps the escape
sentence for an escalate-instead instruction when the caller is restricted. It
changes the message only, never the verdict, asserted directly in
`test/canon-guard.test.js`.

That is [[feedback_strict_contract_seams]] one level out: tightening an
authorization list silently invalidated a *remediation string* that pointed at
the thing being tightened. Enumerate what READS a policy, not just what enforces
it.

**Open for the user, not for the gate.** Whether an implementer should be able to
write the judgment record at all is a live question — the provenance argument
that keeps reviewers out ("a second unattributed author") is not obviously
weaker for implementers. But reversing it is a revisit of COMP-JUDGMENT-WRITER,
with `test/judgment-writer-mcp.test.js` as the starting point, not a coverage
fix.

**Files:** `server/mcp-tool-policy.js`, `lib/coverage-gate.js`,
`lib/canon-guard.js`, `.claude/hooks/canon-guard.mjs`,
`test/coverage-gate.test.js`, `test/canon-guard.test.js`.
