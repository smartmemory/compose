---
date: 2026-06-03
session_number: 50
slug: gsd-7-milestone-report
summary: "COMP-GSD-7: milestone HTML report generator — closes the COMP-GSD umbrella"
feature_code: COMP-GSD-7
closing_line: Two missing inputs, both already in our pocket — the Stratum boundary never had to move.
---

# Session 50 — COMP-GSD-7

**Date:** 2026-06-03
**Feature:** `COMP-GSD-7`

## What happened

We resumed from a stale `/flush` context (the resume doc pointed at scaffold-only work three weeks old; on-disk reality had moved well past it — a good reminder that observed state beats the doc). The real pickup, from `compose/.claude/session-context.md`, was the COMP-GSD umbrella: GSD-6 had shipped, and the last open ticket was COMP-GSD-7 — the milestone report generator.

The one-line spec said "auto-generated HTML report per completed feature… writes to `.compose/gsd/reports/<feature>.html`, renders via the existing cockpit asset pipeline." Three parallel explorers took that apart. Two findings reshaped the whole feature. First: **there is no cockpit asset pipeline for `.compose/`** — the file-watcher only serves `docs/`. So we relocated the output to `docs/gsd-reports/<feature>.html`, where the existing `DocsView` discovers and renders it for free, zero server changes. Second: of the inputs the spec named, two — per-task agent-time and worktree diffs — aren't captured anywhere. The user chose Full v1, and the happy surprise was that both already flow *through* compose (diffs in the worktree-merge poll payload; timing derivable from compose's own poll loop) — so capturing them was compose-side persistence, never a Stratum change.

The Codex design gate earned its keep twice. At design it flagged four wrong data-source assumptions (budget from the review/coverage ledger instead of the GSD budget surface; a timeline from a `feature-events.jsonl` the GSD runtime never writes; a timing-persistence seam that the contract-validated blackboard can't carry; no persisted completion timestamp for retroactive wall-clock). Fixing them actually simplified the design — a `timing.json` sidecar dropped the task-result contract change entirely. At the implementation gate it caught the one bug no unit test would have: `writeBudgetFinalSnapshot` on the clean-complete branch wasn't best-effort, so a derived-artifact write failure would have demoted a *successful* GSD run to `failed` via the outer catch.

## What we built

- `lib/gsd-timing.js` (new) — `timing.json` sidecar (atomic I/O) + pure `recordTaskStates` poll accumulator (first-sight startedAt, first-terminal completedAt+durationMs, idempotent).
- `lib/gsd-diff-capture.js` (new) — per-task diff snapshot persistence to `.compose/gsd/<f>/diffs/<id>.diff`; shared path helper with the report reader.
- `lib/gsd-milestone-report.js` (new) — `assembleReportModel` (joins state+blackboard+timing+diffs+budget), `renderReportHtml` (self-contained, inline CSS, HTML-escaped, 200 KB diff cap), `writeGsdReport` (atomic to `docs/gsd-reports/`), `generateGsdMilestoneReport` orchestrator.
- `lib/build.js` — poll-loop timing capture + diff snapshot at the merge site, both gated on `context.gsd === true` so build mode is byte-identical.
- `lib/gsd.js` — pass `context.gsd=true` at dispatch; on clean complete persist `completedAt` to `state.json` + a `budget-final.json` snapshot (best-effort) + best-effort report generation.
- `bin/compose.js` — `compose gsd report <feature>` retroactive CLI (mirrors `gsd query`; fixed a `--cwd`-value-as-code arg edge).
- Tests (37): `gsd-timing` (11), `gsd-milestone-report` (16), `gsd-diff-capture` (4), `gsd-report-wiring` (4), `gsd-dispatch-instrumentation` (2, real-git integration). Full suite 3192/3192.
- Docs: `docs/features/COMP-GSD-7/{design,blueprint,plan,report}.md`; CHANGELOG; ROADMAP (GSD-7 + umbrella → COMPLETE).

## What we learned

1. **Observed state beats the resume doc.** The first `/flush` doc found was three weeks stale and described scaffold-only work that had since shipped and been pushed. Trusting it blindly would have asked the user an obsolete question. The `/unflush` guidance to prefer on-disk reality is load-bearing.
2. **A wrong substrate is a design bug, not a code bug — catch it at the design gate.** Codex flagged `budget-ledger.readBudget` (review/coverage axes) as the wrong source for GSD's enforced budget *before* any code existed. Cheaper than discovering it in a test.
3. **Picking the right carrier removes work.** The blackboard is rebuilt from contract-validated agent files, so it can't carry compose-observed timing. A dedicated `timing.json` sidecar — read directly by the report — sidestepped both the contract change and the batch-write path. Less code than the 'obvious' approach.
4. **`featureCode` alone can't distinguish gsd from build mode** (build context carries it too). An explicit `context.gsd === true` marker is the honest gate, and the integration test proving build mode writes zero sidecars is the proof that matters.
5. **Best-effort must be total around derived artifacts.** Four of five report-side writes were wrapped; the fifth (`writeBudgetFinalSnapshot`) wasn't, and would have turned successes into failures. One un-wrapped write in a hot path is all it takes.
6. **`roadmap generate` clobbers hand-authored row prose.** It regenerates rows from terse `feature.json` descriptions — it overwrote the rich shipped-state prose for GSD-4 and GSD-6. The compose roadmap workflow is hand-maintained rows + roundtrip `roadmap check`, not `generate`.

## Open threads

- [ ] COMP-GSD-7-EVENTLOG — a true append-only GSD run-event log. GSD persists only snapshots today, so the v1 report timeline is snapshot-derived (start/completion/pause-stuck-budget markers), not an event stream.
- [ ] The auto-on-complete report path is exercised end-to-end only via the report module's unit tests + the dispatch-instrumentation integration test; a full `runGsd`→clean-complete→report E2E (through the real `ship_gsd` git commit) is still uncovered.
- [ ] Per-task elapsed is poll-granularity-approximate (bounded by the dispatch poll interval) — fine for a milestone report, documented in the report footer.
- [ ] COMP-GSD umbrella marked COMPLETE; the lone GSD-3 residual (per-task pre-merge gating + conflict-bounce) remains PARTIAL, carried by COMP-PAR-MERGE-QUEUE.

---

*Two missing inputs, both already in our pocket — the Stratum boundary never had to move.*
