# COMP-PLAN-RIGOR — Front-of-Funnel Rigor + Parity (design)

**Status:** DESIGN (Phase 1 — review as a design/strategy doc, not shipped code)
**Date:** 2026-07-20
**Umbrella:** COMP-PLAN-RIGOR (proposed)

## Related Documents

- North-star this serves: [The Discovery Loop vision (2026-07-20)](../product/2026-07-20-discovery-loop-vision.md) — this design is **rungs 1–3** of that ladder (one idea-memory → close the loop → ideas compete on a market), built minimal-first. WS-A is rung 1 (the keystone); WS-B seeds rungs 3–4; WS-C makes the loop observable.
- Builds directly on: [COMP-ROADMAP planning-model design (2026-06-21)](../plans/2026-06-21-roadmap-planning-model-design.md) — that epic shipped the *spine* (COMP-ROADMAP-MODES + COMP-ROADMAP-PLAN both COMPLETE). This doc addresses the *quality* of the front half the spine enabled.
- **Reconciliation with prior Decision 4.** COMP-ROADMAP's Decision 4 settled that *ideation lives in the ideabox* (vs. a `roadmap.json` incubation section) and its dropped-list rejects a second incubation store. This doc **honors** that: the ideabox stays the ideation **funnel/surface**. What Decision 4 did **not** resolve — and what this doc addresses — is the *storage* split it left standing: Decision 1 and Decision 2 both enumerate "the ideabox funnel" **and** "vision items (`idea/thread/question/decision`)" as separate coexisting substrates. WS-A unifies that storage layer without moving the funnel out of the ideabox. Where this doc's recommendation reinterprets Decision 4, it is flagged inline (WS-A) for the owner to adjudicate — not assumed.
- Inherits open question: COMP-ROADMAP OQ2 (the `plan`→`build` handshake artifact contract) is still open upstream and constrains WS-B's decision-card/handshake shape.
- Prior art reused: `pipelines/plan.stratum.yaml` (the shipped 3-phase plan lifecycle), `server/vision-store.js:10` (planning-native types), the `compose-architect` fan-out (`.claude/agents/`), the ideabox stack (`server/ideabox-routes.js`, `src/components/vision/IdeaboxView.jsx`).
- Scope boundary: everything **downstream of the roadmap** (blueprint/implement/ship, cross-product graph, external providers) is explicitly out. This is the front half only: frame → ideate → converge → roadmap.

## Problem / framing

COMP-ROADMAP shipped a real product-planning lifecycle (`compose plan`) as a peer to `build`/`fix`. The pipe works and the **stage-4 handoff is excellent**: `plan` writes per-feature `design.md` + runs the canonical writer to emit `feature.json` → regenerates `ROADMAP.md`, and a ship phase verifies build-readiness. No hand-authored rows.

But the front half's **quality is inverted relative to the back half**: rigor is *lowest* exactly where product judgment is *hardest*.

- The back half fans **three competing architect mandates** (`compose-architect` ×3) just to choose an *architecture*.
- The front half chooses the **product itself** — the higher-leverage decision — with a *single narrative Claude step* writing `plan.md`.

Three structural defects follow from that inversion, all confirmed against the code:

1. **Convergence is narrative, not structured deliberation.** `pipelines/plan.stratum.yaml`'s `plan` phase is one agent pass. The vision store already has the primitives for structured deliberation — `idea / decision / question / thread` (`server/vision-store.js:10`) — and the plan lifecycle uses none of them.
2. **Ideation lives in two disconnected stores.** The markdown ideabox (`docs/product/ideabox.md`, full CLI + rich UI) and the vision store's `idea` type are separate substrates. Promoting an ideabox idea creates a *feature*, skipping the vision `idea` type entirely; the only graph linkage is a read-only `mapsTo` overlay (`GraphView.jsx:704`).
3. **The convergence engine is headless.** `/api/build/start` rejects `mode:'plan'` (`server/build-routes.js:69`); no UI launches or observes `plan`; its gates (`plan_design_gate`, `plan_converge_gate`) have zero references in `src/` and no label in `GATE_STEP_LABELS`. Planning-native vision types render only incidentally (dropped from the Dashboard, no Tree filter). The parity doc doesn't mention `plan` at all.

**Governing principle for the fix:** rigor should be highest where judgment is hardest. Put the back half's machinery — competing options, decision records, parallel generation, a north-star check — into the front half's *convergence* stage, and unify the two idea-stores so divergence is lossless and traceable.

## What is already good (do not rebuild)

- `compose plan` as a mode-generic peer lifecycle (COMP-ROADMAP-MODES keystone).
- The plan→build handshake artifact (canonical `feature.json` + `design.md`, ship-phase verified).
- Ideabox **capture**: full CLI (`add/list/promote/kill/pri/discuss/triage`, `bin/compose.js:2804`) and a real UI (IdeaboxView + matrix + triage + analytics + promote dialog).
- Gate machinery is pipeline-agnostic — plan gates would approve generically *if* emitted and labeled.

## Three workstreams

### WS-A — Unify ideation storage under the ideabox funnel (the keystone)

Separate **funnel** (settled: the ideabox owns it, Decision 4) from **storage** (unresolved: markdown ideabox vs. vision `idea` type). Today "an idea" is stored as two incompatible things — the markdown store (`server/ideabox-routes.js`, `useIdeaboxStore.js`) and the vision `idea` type — bridged only by a read-only `mapsTo` overlay (`GraphView.jsx:704`). Divergence, the widest and most lossless-critical point of the funnel, is fragmented at the storage layer. The funnel stays the ideabox; the question is which store backs it.

**Approaches (crux decision):**

- **A1 — Vision `idea` items are canon; ideabox markdown becomes a projection.** The ideabox *remains the funnel and the UI* (Decision 4 honored), but its records are `idea`-type vision items — which already carry provenance, links, graph position, and sit next to `decision`/`question`/`thread`. `docs/product/ideabox.md` is regenerated from them, exactly as `ROADMAP.md` is regenerated from `feature.json` (Decision 3's projection pattern). Promote becomes a graph transition: `idea → [decision/thread] → feature`.
  - *Pro:* one substrate; graph-native; deliberation types adjacent (unblocks WS-B); matches the projection model the codebase already committed to in Decision 3. *Con:* re-backs the markdown-native ideabox tooling (CLI writers, `IdeaboxView` store) onto the vision store; most front-loaded churn. **Reinterprets Decision 4** from "ideabox is the store" to "ideabox is the funnel, vision store is the store" — owner must bless this.
- **A2 — Ideabox markdown stays canon; mirror into vision `idea` items.** Keep the markdown store as-is, sync a read-model of `idea` vision items for graph/deliberation.
  - *Pro:* least churn; most literal reading of Decision 4. *Con:* a second sync seam — the exact de-sync class COMP-ROADMAP spent an epic eliminating for the roadmap; "idea" still lives in two places, kept in step by machinery.
- **A3 — Bridge only (status quo+).** Formalize the `mapsTo` overlay, leave the stores separate.
  - *Pro:* cheapest. *Con:* doesn't fix the defect; enshrines two idea-substrates; WS-B's decision cards would have to reach across the seam.

**Recommendation: A1**, contingent on the owner blessing the Decision-4 reinterpretation. It's the only option that removes the fragmentation rather than managing it, and it's consistent with the projection philosophy Decision 3 already set (one canonical store, surfaces are projections — never a second source). If the owner reads Decision 4 as binding on *storage*, fall back to **A2** and accept the sync seam. **A3 is not recommended** — it leaves the keystone defect in place.

### WS-B — Structured convergence (the rigor)

Give the `plan` phase the deliberation machinery the `build` phase already has for lesser decisions.

- **B1 — Competing product framings.** A `compose-strategist` fan-out analogous to `compose-architect`: N candidate shortlists under distinct mandates (e.g. *minimal-viable* / *maximum-ambition* / *risk-first*), presented with trade-offs, one chosen. Runs in `explore_design`/`plan`, not a new phase.
- **B2 — Decision cards as first-class objects.** Convergence emits `decision` + `question` vision items (the types already exist), not just `plan.md` prose — each recording the option chosen, the options rejected, and why (killed-at-origin provenance). The narrative `plan.md` becomes a *render* of these, not the system of record.
- **B3 — Frame as a durable north-star + convergence check.** `explore_design`'s FRAME becomes a durable `thread`/`spec` vision item carrying the goal + success criteria. The `plan_converge_gate` gains one check: **does the chosen shortlist satisfy the frame's success criteria?** Today nothing tests convergence against the original intent.

### WS-C — Plan lifecycle UI / wiring parity

Make the convergence engine observable and launchable, and promote planning-native types to first-class. (Direct answer to the parity audit.)

- **C1 — Launch:** whitelist `plan` in `/api/build/start` (`server/build-routes.js:69`); add a plan option to the launcher (`StartBuildPopover.jsx`) or a dedicated plan entry; a plan tab or reuse of the Pipeline view with plan-aware rendering.
- **C2 — Gates:** add `plan_design_gate`/`plan_converge_gate` to `GATE_STEP_LABELS` (`constants.js:97`) so they surface and approve like build gates.
- **C3 — Ideation types first-class:** Tree filter chips for `idea/decision/question/thread` (`TreeView.jsx:22`); stop dropping non-`feature` types from the Dashboard (`DashboardView.jsx:318`) or add a dedicated ideation/convergence surface.
- **C4 — MCP coverage:** add `mcp__compose__*` tools for ideabox ops and plan-launch (both absent today); optionally vision-item mutation for the planning types.
- **C5 — Parity doc:** add the missing `plan` lifecycle row + a `COMP-PARITY` code so the asymmetry is tracked (it isn't today).

## Sequencing (minimal-first)

| # | Feature | Slice | Depends on |
|---|---|---|---|
| 1 | **COMP-PLAN-IDEA-UNIFY** | WS-A1: vision `idea` canon; ideabox markdown → projection; promote as graph transition | — (keystone) |
| 2 | **COMP-PLAN-CONVERGE** | WS-B1+B2+B3: strategist fan-out, decision cards, frame-as-north-star + convergence check | 1 (deliberation types must be canonical first) |
| 3 | **COMP-PLAN-UI** | WS-C1+C2+C3: launch plan, label gates, ideation types first-class | 1 (renders the unified substrate) |
| 4 | **COMP-PLAN-MCP** | WS-C4: ideabox + plan-launch MCP tools | 3 |
| 5 | **COMP-PLAN-PARITY-DOC** | WS-C5: track the gap | — (can land anytime) |

## Explicitly dropped / deferred

- Rebuilding ideabox capture UX — it's the strongest front-of-funnel surface; WS-A preserves it as a projection.
- A separate planning *product* — COMP-ROADMAP already decided plan stays a lifecycle within compose.
- Everything downstream of the roadmap (per scope).
- New vision types — `idea/decision/question/thread` already exist; the work is *using* them, not adding them.

## Open questions (for build-time)

1. WS-A migration: is `docs/product/ideabox.md` treated as legacy-import-once (like ROADMAP.md→feature.json migrate), or kept bidirectionally as a projection with a writer?
2. WS-B: does the strategist fan-out reuse `compose-architect`'s harness with new mandates, or is it a distinct agent? (Reuse is cheaper; mandates differ in kind — product vs architecture.)
3. WS-C: dedicated Plan tab vs. plan-aware rendering inside the existing Pipeline view — how much plan-specific UX is worth it before the lifecycle sees real dogfood use?
