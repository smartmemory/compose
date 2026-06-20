---
date: 2026-06-20
session_number: 80
slug: pipeline-editor-foundation
summary: "Visual pipeline editor foundation (COMP-PIPE-EDIT-1/-2): cytoscape canvas + step inspector + metadata-preserving save round-trip; roadmap drift reconciled"
feature_code: COMP-PIPE-EDIT-1
closing_line: The gate that was supposed to confirm kept discovering — and each discovery was a real bug we'd have shipped.
---

# Session 80 — COMP-PIPE-EDIT-1

**Date:** 2026-06-20
**Feature:** `COMP-PIPE-EDIT-1`

## What happened

The human ran /compose build COMP-PIPE-EDIT. The entry scan turned up a roadmap-integrity problem first: features -3 through -7 of the epic were marked COMPLETE in canon with no backing code, git, or audit trail — a false bulk-set. An Explore agent confirmed the whole epic was unbuilt (PipelineView.jsx is a read-only dagre status view, not an editor). We reconciled -3..-7 back to PLANNED (the capabilities.guard makes COMPLETE terminal, so we corrected the corrupt canon by direct feature.json edit, the guard's only sanctioned route being an unmintable token), then built the foundation: -1 (step canvas) + -2 (step inspector) plus the save-to-disk round-trip (core of -7) per the human's decisions to reuse cytoscape and save now.

## What we built

A pure flow-scoped model lib (src/lib/pipeline-model.js): specToModel/flowSteps/validateFlow/renameStep/deleteStep, with step identity (flowName,id) so multi-flow specs with duplicate ids across flows round-trip. Backend: GET /api/pipeline/specs (filename discovery), GET /api/pipeline/spec (raw text), POST /api/pipeline/save (in-place YAML Document mutation preserving the # metadata: comment header, untouched flows, and unsurfaced step fields; symlink/traversal-safe). UI: a new 'pipeline-editor' view, a cytoscape PipelineEditorCanvas, and a StepInspector with live structural validation, wired through a useVisionStore editor slice. ~63 new tests; full node suite green, 504 UI tests.

## What we learned

1. Roadmap drift in this repo is heavy and bidirectional — both 'false COMPLETE' (the -3..-7 bulk-set) and 'stale-canon downgrades' (record_completion's full ROADMAP regen tried to revert the already-shipped STRAT-AGENT-INTERP from stale feature.json). Always verify rows vs shipped code, and apply completion ROADMAP edits surgically. 2. Two explorers disagreed with Codex on whether metadata was a YAML key vs comment, and on where v0.1 steps live — reading the actual loader settled it (Codex was right both times). Verify load-bearing facts against source. 3. The Codex design gate caught a flat-model assumption that would have corrupted multi-flow specs; the impl gate then caught five more (inputs $.steps refs, _extra loss, symlink escape, flow-name aliasing, rename-chain id reuse, Zustand re-render-by-reference). Gates should confirm — these discovered, which means our self-adversarial pass was too shallow on the serialization edges.

## Open threads

- [ ] COMP-PIPE-EDIT-3..7 remain PLANNED (dependency wiring, contract editor, sub-flows, bidirectional YAML sync, save-as-new-template).
- [ ] Duplicate step ids in one flow: nodes not independently selectable/deletable (instance-uid refactor deferred; state is save-blocked).
- [ ] Authoritative Stratum semantic validation not wired (client-side structural only).
- [ ] Pre-existing ROADMAP-vs-canon drift on STRAT-AGENT-INTERP/COMP-CODEX-IMPL-SPIKE rows (canon stale vs shipped) — separate reconciliation needed.
- [ ] Work committed to main (through 8092d69), not pushed.

---

*The gate that was supposed to confirm kept discovering — and each discovery was a real bug we'd have shipped.*
