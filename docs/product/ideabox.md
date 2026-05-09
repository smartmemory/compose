# Ideabox

**Purpose:** Capture raw ideas before they're ready for the roadmap.

## Conventions
- **ID:** `IDEA-N` (sequential, never reuse)
- **Status:** `NEW` | `DISCUSSING` | `PROMOTED` | `KILLED`
- **Priority:** `P0` (promote now) | `P1` (next up) | `P2` (backlog) | `—` (untriaged)
- **Source:** Where the idea came from
- **Tags:** `#ux` `#core` `#distribution` `#integration` `#research` `#infra`
- **Umbrella:** Ideas are grouped under thematic umbrellas. The umbrella name is a working label; ideas may move between umbrellas as they're discussed. IDs are stable.

## Ideas

---

### Umbrella A — Resilience: fail loud, recover fast

**Theme:** Compose treats too many failure modes as soft. This cluster makes failure visible, structured, and recoverable. Sub-ideas range from data integrity (byte-equal readback) through observability (typed errors, no silent fallback) to recovery primitives (continue.md markers, forensics commands, external-state reconciliation). Implementation order matters: typed errors (IDEA-2) underpin everything; readback (IDEA-1) and no-silent-fallback (IDEA-3) install the philosophy; resume + forensics + reconciliation (8/9/13) are the operator surface.

#### IDEA-1 — Byte-equal readback on persisted artifacts
**Status:** NEW | **Priority:** — | **Tags:** stratum integrity research-influence
**Source:** RealityLoopWhitePaper
**Idea:** Round-trip every JSON/text artifact (design.md, blueprint.md, plan.md, gate decisions, audit events) before allowing the next step to consume it. Reject mismatches with a typed error. Stratum builtin: `readback_matches(path)` usable in ensure clauses. Inspired by ContextGraph Reality Loop white paper (Royse, May 2026), where every persisted artifact is byte-equal-verified before it can influence the next decision. Catches partial writes, serialization regressions, and silent FS corruption before they propagate.

#### IDEA-2 — Typed GateError schema with structured fields
**Status:** NEW | **Priority:** — | **Tags:** errors gates contracts research-influence
**Source:** RealityLoopWhitePaper
**Idea:** Replace free-text gate decisions with a typed error shape: `error_code, field_path, remediation, details, source_of_truth`. Aligns with the canonical ReviewResult schema already at `compose/contracts/review-result.json` — extends the same pattern to all gate failures so the cockpit can render structured failures and audit traces become grep-able. ContextGraph paper makes every fail-closed gate a typed `RealityError` with these fields. **Foundation for IDEA-1, IDEA-3:** they all emit/consume this shape.

#### IDEA-3 — No-silent-fallback audit
**Status:** NEW | **Priority:** — | **Tags:** reliability tech-debt research-influence
**Source:** RealityLoopWhitePaper
**Idea:** Compose has multiple soft-fallback paths: stratum-mcp chunk-size error → general-purpose Agent fallback; codex unavailable → degrade; compose doctor missing dep → use fallback string; review_mode degrades when reviewer fails. Each soft fallback hides a real failure mode. Audit every fallback against "would I rather this fail loudly?" Convert genuine error conditions to fail-closed; keep only the fallbacks that represent legitimate degraded-but-correct operation. Pairs with IDEA-2: every kept-fallback emits a typed `Degradation` event with reason.

#### IDEA-8 — `continue.md` per-unit resume markers
**Status:** NEW | **Priority:** — | **Tags:** crash-recovery resumption stratum gsd
**Source:** gsd-build/gsd-2
**Idea:** Each active GSD-2 slice gets an ephemeral `continue.md` resume marker. On crash, the agent re-enters by reading this file directly instead of re-deriving state from the markdown checkboxes + DB. Compose has `checkpoint.md` for hard-bug fix mode (COMP-FIX-HARD); generalizing to all in-flight Stratum steps would make `compose <verb> --resume` work for every lifecycle, not just fix mode. Slot: writer in `lib/build.js` lifecycle-loop; reader in entry-scan. **Subsumes the existing checkpoint.md mechanism** as a generalization.

#### IDEA-9 — Doctor / Forensics / Recover commands
**Status:** NEW | **Priority:** — | **Tags:** diagnostics ops cli gsd
**Source:** gsd-build/gsd-2
**Idea:** GSD-2 ships `gsd doctor`, `gsd forensics`, `gsd headless recover` as first-class diagnostic commands for stuck/wedged runs. Compose has `compose doctor` for dep checks but not for active-build introspection. Add `compose forensics <feature-code>` (dump active-build state, last N journal entries, Stratum trace, hypothesis ledger if bug-mode) and `compose recover <feature-code>` (reconcile active-build with disk state, prompt to resume / abort / kill). Operator surface for IDEA-8 markers.

#### IDEA-13 — External-state reconciliation mid-build
**Status:** NEW | **Priority:** — | **Tags:** reconciliation external-state safety symphony
**Source:** symphony
**Idea:** Symphony watches for ticket reassignment/closure externally and stops in-flight runs. Compose doesn't react to vision-item status changes during a build — if a user kills a feature in the cockpit while Phase 7 is running, the run keeps writing. Add a vision-state watcher in `lib/build.js`'s phase loop that polls or subscribes to changes; on `status: killed/blocked/parked` for the active feature, abort gracefully (write `continue.md`, log to journal, exit). Same pattern handles user-initiated cancel from cockpit.

---

### Umbrella B — Multi-feature concurrency

**Theme:** Compose is invocation-scoped and serializes via active-build last-writer-wins. To safely run more than one feature at a time, three primitives need to land together: bounded concurrency control, isolated workspaces, and (optionally) a daemon to drive it autonomously. None of these are sound in isolation — daemon without bounded concurrency burns budget; concurrency without worktrees corrupts state. Treat as a single feature when scoped. **Depends on COMP-WORKSPACE-ID** for workspace identity.

#### IDEA-11 — Bounded multi-feature concurrency
**Status:** NEW | **Priority:** — | **Tags:** concurrency parallelism orchestration symphony
**Source:** symphony
**Idea:** Symphony runs N tickets in parallel with isolated workspaces, queue-managed. Compose currently serializes via active-build last-writer-wins (project memory `project_compose_idempotency_gaps`). Add a build queue with bounded N (configurable per workspace), worktree-per-ticket isolation (IDEA-14), and a queue-manager that picks the next ticket when a slot frees.

#### IDEA-12 — Long-running daemon mode
**Status:** NEW | **Priority:** — | **Tags:** daemon autonomy distribution symphony
**Source:** symphony
**Idea:** Symphony runs as a long-running daemon polling a board, dispatching autonomously. Compose is invocation-scoped — every `/compose` is a fresh agent. Add `compose daemon` mode that polls vision-state for IN_PROGRESS items the user has explicitly tagged `auto:true`, dispatches Stratum runs, and surfaces results when complete. **Requires** IDEA-11 (bounded concurrency) + IDEA-13 (reconciliation, so user-cancel works) + hard budget caps (already filed as `idea_budget_ceilings`).

#### IDEA-14 — Per-feature deterministic workspaces
**Status:** NEW | **Priority:** — | **Tags:** worktree workspace isolation symphony
**Source:** symphony
**Idea:** Symphony spawns a deterministic workspace per ticket; compose uses cwd. Worktree-per-feature would isolate concurrent builds, eliminate the active-build last-writer-wins race, and match the worktree pattern compose already uses for tier-2 hard-bug escalation. Cost: every feature triggers `git worktree add`, more disk, slower iteration when switching features. Worth gating behind a `--worktree` flag first; promote to default only if telemetry shows it pays. **Foundation for IDEA-11.**

---

### Umbrella C — Mechanical verification & decision provenance

**Theme:** Compose's contracts and decisions are too prose-y. Codex review catches what it catches, but a structured-table contract with grep-able axes (Truths / Artifacts / Key Links) is mechanically checkable in ways `ensure: result.tests_pass == True` is not. Same applies to architectural decisions and tool policy — each lives in scattered free text today; lifting to structured artifacts makes them auditable.

#### IDEA-5 — Truths / Artifacts / Key Links triplet for Stratum contracts
**Status:** NEW | **Priority:** — | **Tags:** stratum contracts verification gsd
**Source:** gsd-build/gsd-2
**Idea:** GSD-2 splits each task's must-haves into three orthogonal axes: **Truths** (observable behaviors), **Artifacts** (files with min line counts), **Key Links** (import wiring between modules). Reported as a structured table, not prose. Cleaner mechanical-checkability than free-text `ensure` postconditions. Could become a Stratum contract subclass (`ContractTAK`) — postconditions emit the triplet and a Stratum builtin verifies each axis automatically (truths via test runner, artifacts via fs probes, key links via AST grep). Replaces current "is the ensure expression abstract enough that the LLM rubber-stamps it?" failure mode.

#### IDEA-6 — Append-only DECISIONS.md with supersession-by-ID
**Status:** NEW | **Priority:** — | **Tags:** journal architecture decisions provenance gsd
**Source:** gsd-build/gsd-2
**Idea:** GSD-2 keeps an append-only `DECISIONS.md` per project with columns `When | Scope | Decision | Choice | Rationale | Revisable?`. Decisions are never edited; superseding a prior decision means a new row with `Supersedes: D-NN`. Cleaner than threading architectural decisions through compose's session journal — provides a grep-able decision log without losing history. Slots in next to `feedback_*.md` memory but at project-scope. Could be regenerated from journal entries that match a `**Decision:**` pattern.

#### IDEA-7 — Unit-typed tools-policy manifest
**Status:** NEW | **Priority:** — | **Tags:** stratum tool-policy security gsd
**Source:** gsd-build/gsd-2
**Idea:** GSD-2 declares per-unit-type tool surfaces in a `UnitContextManifest` (planning units cannot Write; execution units can; researchers cannot Edit). CI guards the manifest. Stratum already has per-step tool restrictions but they're per-call; lifting them to per-step-type with a CI-checked manifest is the same shape, sharper. Prevents drift like "the planner agent silently gained Edit and started writing code from a planning step."

---

### Umbrella D — Cockpit & loop ergonomics

**Theme:** The bits between agents and humans. Cheap polling for cockpit watchers; intelligent recovery from truncated review output. Both reduce the round-trip cost of "show me what's happening" and "I need more context."

#### IDEA-4 — Tee-recovery for review-fix loops
**Status:** NEW | **Priority:** — | **Tags:** review-loop ux research-influence
**Source:** rtk-ai/rtk
**Idea:** When a review lens or a coverage-sweep iteration ingests command output (`git diff`, `npm test`, etc.), feed the agent a compressed/filtered view by default but tee the full output to a recoverable artifact. If a later iteration's agent flags missing context ("the truncated log doesn't show line N"), the loop hands it the full saved output instead of re-running the command or asking the human. RTK already implements this with `tee.mode = "failures"` — we can either invoke RTK directly (see `COMP-RTK-INTEROP`) or implement a thin equivalent in `lib/review-lenses.js`. Cuts the "sorry, can you give me more context" round-trip that currently shows up in long fix loops.

#### IDEA-10 — Cheap query endpoint for cockpit polling
**Status:** NEW | **Priority:** — | **Tags:** cockpit performance ops gsd
**Source:** gsd-build/gsd-2
**Idea:** GSD-2's `gsd headless query` is ~50ms, no LLM, exit-code-driven status polling. Compose's cockpit currently polls vision-state and active-build via Express endpoints that touch the JSON store; fast enough for one tab, but not for many concurrent watchers (cron, CI, multiple cockpits). Add `compose query <feature-code> --json` with exit codes (0 ok, 10 blocked, 11 cancelled, 1 error) and a corresponding stripped-down REST endpoint that hits an in-memory cache only. Separates "show me state" from the heavier vision-state load path.

---

### Standalone: counter-pressure

#### IDEA-15 — Operational simplicity audit
**Status:** NEW | **Priority:** — | **Tags:** simplicity scope ops symphony meta
**Source:** symphony
**Idea:** Symphony's SPEC.md fits in one head. Compose is intentionally a deeper tool for deeper work — that's a feature, but it's also a cost. Audit: which compose primitives are load-bearing for advanced features but pure friction for simple ones? Candidates: 10-phase lifecycle (overkill for a typo fix; we have `/compose fix --quick`, but `/compose build` has no quick path), Stratum yaml authoring, the cockpit, ideabox triage flow. Output: a `compose simple <description>` command that runs design → implement → ship in 3 phases for trivially-scoped work, plus a written distillation of "the 5 things you actually need to know to use compose." **Run this audit BEFORE promoting any of Umbrellas A-D** — every umbrella adds primitives; this one removes them. Counter-pressure to feature creep.

## Killed Ideas
