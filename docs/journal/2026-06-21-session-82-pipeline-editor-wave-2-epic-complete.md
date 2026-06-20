---
date: 2026-06-21
session_number: 82
slug: pipeline-editor-wave-2-epic-complete
summary: "Pipeline editor Wave 2 (COMP-PIPE-EDIT-5/-6): YAML sync + sub-flow collapse/expand; the COMP-PIPE-EDIT epic (all 7) is COMPLETE"
feature_code: COMP-PIPE-EDIT-5
closing_line: A 7-feature epic that started by catching five features lying about being done, and ended with all seven actually done.
---

# Session 82 — COMP-PIPE-EDIT-5

**Date:** 2026-06-21
**Feature:** `COMP-PIPE-EDIT-5`

## What happened

Wave 2 — the complex pair — completing the visual pipeline editor epic. -6 bidirectional YAML sync and -5 sub-flow collapse/expand, both shipped end to end (design gate -> core -> UI -> review -> docs -> evidence-bound completion). The exploration corrected two roadmap premises before any code: -6's 'edit in Docs view' is impossible (Docs view is markdown-only, pipelines/ isn't watched), and a sub-flow has exactly one output, so collapse must be constrained. With -5 and -6 COMPLETE, the entire COMP-PIPE-EDIT epic (-1..-7) is done.

## What we built

-6: an in-editor YAML pane (bidirectional, debounced flush, active-editor guard, buffer that survives remount + flushes on close); conflict resolution via a server content-hash (GET returns hash, /save takes baseHash -> 409/force) + a pipelines/ file-watch emitting specChanged on the vision WS + a latched spec-wide save scope + a buffer-flush save gate. -5: collapseToSubflow (SESE/dependency-contiguous, single-output, boundary over ALL ref types, rejecting cuts through source/gate-routes, input ports preserving $.output.<field> suffixes), a new flow injected into _doc.flows + created on disk by a spec-wide save, expand via the flow-switcher, ports as node-label text. ~40 new tests; full node suite 4288; 555 UI tests.

## What we learned

1. Two roadmap premises were wrong and only source-reading caught them: the Docs view can't edit specs, and sub-flows are single-output (so unconstrained collapse is unrepresentable). Design gates grounded in real code beat taking the row text literally. 2. Wave 2 collided repeatedly with the flow-scoped/single-flow-save architecture from the foundation — spec-wide edits (YAML pane, collapse) needed a latched save scope, spec-wide validation, and a save that reconciles flows.input/functions/workflow.name + creates new flows. Retrofitting spec-wide semantics onto a flow-scoped editor was the dominant difficulty. 3. The Codex impl gate again did the heavy lifting: it caught field-suffix loss in collapse ports, cross-flow data loss on save, a stranded YAML buffer that silently blocked saves, and specChanged clobbering in-flight edits — none of which the green tests revealed until the gate named them. 4. record_completion's ROADMAP regen kept threatening to downgrade unrelated shipped rows from stale canon; surgical row edits after every completion are now routine.

## Open threads

- [ ] The whole COMP-PIPE-EDIT epic (-1..-7) is COMPLETE.
- [ ] Pre-existing ROADMAP-vs-canon drift on unrelated rows (STRAT-AGENT-INTERP etc.) still wants a separate reconciliation; record_completion regen would downgrade them.
- [ ] Known limitations carried forward: duplicate-step-id selection (foundation), YAML-pane rename loses disk-only comments, client-side structural validation only (no Stratum semantic validation wired), sub-flow type inference is best-effort string.
- [ ] All work committed to main (through 6e56848), NOT pushed.

---

*A 7-feature epic that started by catching five features lying about being done, and ended with all seven actually done.*
