---
date: 2026-06-21
session_number: 81
slug: pipeline-editor-wave-1
summary: "Pipeline editor Wave 1 (COMP-PIPE-EDIT-3/-4/-7): dependency wiring, contract editor, save-as-template; two-wave batch sequencing"
feature_code: COMP-PIPE-EDIT-3
closing_line: Contracts turned out to be referenced in three places, not one — the design gate caught it before the code could.
---

# Session 81 — COMP-PIPE-EDIT-3

**Date:** 2026-06-21
**Feature:** `COMP-PIPE-EDIT-3`

## What happened

Continuing the COMP-PIPE-EDIT epic, the human asked to build -3..-7. We agreed to split the five remaining features into two waves: Wave 1 (-3 wiring, -4 contract editor, -7 template save — moderate, mostly independent) and Wave 2 (-6 YAML sync, -5 sub-flows — the complex pair). This entry covers Wave 1, shipped end to end (design gate -> core -> UI -> review -> docs -> evidence-bound completion).

## What we built

Model lib: addDependency/removeDependency/wouldCreateCycle (self/dup/dangling/cycle guarded); contract ops addContract/renameContract/deleteContract/setContractField/removeContractField/renameContractField with TaskGraph fully locked and rename rewriting all three contract-ref sites; serializeContracts; specToModel deep-copies contracts. Backend: /save now persists the contracts block in place (comment-preserving) and reconciles flows.*.output/functions.*.output plus cross-flow step.output_contract on rename; new /save-as-template (create-only, metadata.id uniqueness, real metadata key). UI: connect-mode wiring on the cytoscape canvas, a ContractEditor panel, TaskGraph dropdown dedup, and a save-as-template dialog. ~42 new tests; full node suite green; 525 UI tests.

## What we learned

1. Contract names are referenced in THREE places (step.output_contract, flows.*.output, functions.*.output), not just steps — the Codex design gate caught the too-narrow rename/delete rule before implementation. 2. record_completion (the evidence-bound COMPLETE route) regenerates the whole ROADMAP.md from canon and, on a drifted repo, downgrades other already-shipped rows from stale feature.json — same hazard as last session; we again restored ROADMAP.md and edited only our rows surgically. Saved to memory. 3. The save path re-parses disk per save, so a contract rename touching non-selected flows' step.output_contract needed an explicit cross-flow reconcile pass; the per-flow step merge alone left broken refs. 4. cytoscape connect-mode needed a pending-source reset on graph rebuild or a flow switch mid-connection wires to a stale step id.

## Open threads

- [ ] Wave 2: COMP-PIPE-EDIT-6 (bidirectional YAML sync + conflict resolution) and -5 (sub-flow collapse/expand) remain PLANNED.
- [ ] Duplicate-step-id selection limitation (from the foundation) still stands.
- [ ] Authoritative Stratum semantic validation still not wired (client-side structural only).
- [ ] All work committed to main (through dddafd2), not pushed.

---

*Contracts turned out to be referenced in three places, not one — the design gate caught it before the code could.*
