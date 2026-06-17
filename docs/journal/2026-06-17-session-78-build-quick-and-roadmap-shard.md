---
date: 2026-06-17
session_number: 78
slug: build-quick-and-roadmap-shard
summary: Shipped COMP-BUILD-QUICK (compose build --quick trimmed lifecycle) via the full lifecycle, corrected a false-premise mirror, Codex caught two provisioning bugs; filed COMP-ROADMAP-SHARD; dogfood-closed the completion-report/journal warnings the new --quick path surfaced
feature_code: COMP-BUILD-QUICK
closing_line: The feature that makes builds quick was not, itself, quick — and the gate that proves it shipped found two bugs the happy path never would.
---

# Session 78 — COMP-BUILD-QUICK

**Date:** 2026-06-17
**Feature:** `COMP-BUILD-QUICK`

## What happened

Three threads in one session. First, we built COMP-BUILD-QUICK — a `compose build --quick` that collapses the 16-step build lifecycle to design → implement → ship, symmetric to fix mode's Quick path. The scoping doc told us to "mirror the --quick flag handling fix mode already has," but exploration found that flag does not exist: `compose fix` runs the full bug-fix pipeline, and fix's "Quick path" is a SKILL.md triage decision, not a CLI flag. The real mirror was the existing `--template` mechanism. We corrected the design (a C1–C4 corrections table), then implemented: a trimmed `build-quick.stratum.yaml` (delete prd/architecture/blueprint/verification/plan/plan_gate/report; keep workflow.name=build so the runner sees an identical flow; repoint decompose + review inputs to the design artifact), a `--quick` CLI flag (sugar for template:'build-quick', single-feature only), and SKILL.md/cli.md docs.

The Codex review loop earned its place: round 1 found that `--quick` would fail in already-initialized workspaces lacking the new pipeline (init seeds it, but the build auto-init guard didn't trigger on its absence and there's no preset fallback); round 2 found that the re-init fix called runInit without the resolved workspace root, so a subdir invocation would seed the wrong directory. Both fixed, then REVIEW CLEAN. Shipped to main; one flaky Bridge-to-SSE pre-push test aborted the first push, a clean retry went through.

Second, you flagged that compose's own ROADMAP.md is getting large and SmartMemory's is at 650KB+ — too big for an LLM to process. We filed COMP-ROADMAP-SHARD (PLANNED) in compose's roadmap (compose owns the parser/gen/roundtrip tooling, so every consuming project benefits), roundtrip-checked to a fixed point.

Third, you pointed `compose build --quick` at the two validate warnings the new feature surfaced (MISSING_COMPLETION_JOURNAL/REPORT). Investigation showed these fire for 122/158 COMPLETE features respectively — advisory, not special to COMP-BUILD-QUICK — and that --quick *deliberately* omits the report phase, so it will always trip MISSING_COMPLETION_REPORT. We wrote the owed session journal (this entry) and a hand-written report.md to close them for this feature, and noted the systemic validator gap.

## What we built

New: `pipelines/build-quick.stratum.yaml` (trimmed build lifecycle, sub-flows byte-identical to build.stratum.yaml), `test/build-quick.test.js` (15 tests — pipeline structure, template resolution, init seeding, CLI conflict guards), `docs/features/COMP-BUILD-QUICK/{design.md,blueprint.md,report.md}`, `docs/features/COMP-ROADMAP-SHARD/feature.json`.

Modified: `bin/compose.js` (--quick flag → template:'build-quick'; conflict guards vs --template and batch, fired before auto-init; build-quick added to init pipeline-seed list; --quick-aware auto-init threading the resolved buildCwd into runInit), `.claude/skills/compose/SKILL.md` (Mode Selection row + Build Quick path section), `docs/cli.md` (--quick flag + example + auto-init note), `CHANGELOG.md`, `ROADMAP.md` (COMP-BUILD-QUICK → COMPLETE @298 COMP-ROADMAP-SHARD → PLANNED), feature.json status flips.

Commits: 16ef85f (COMP-BUILD-QUICK), ef5d8ab (COMP-ROADMAP-SHARD filed), 6f13d15 (description-drift cleanup). All pushed to main.

## What we learned

1. Verify the thing you're told to mirror actually exists. The plan's load-bearing premise — a fix-mode `--quick` flag — was fiction; the reusable pattern was `--template`. A grep at design time turned a copy-the-flag task into a correct template-selection design.
2. Keeping `workflow.name` unchanged is how you trim a pipeline without touching the runner. `extractFlowName` prioritizes workflow.name, so build-quick reuses flow name `build` and every step-id coupling in build.js stays valid — only the step list shrinks.
3. Review the integration points, not just the diff. Both Codex findings were about provisioning (does the pipeline exist in an upgraded workspace? does re-init target the right root from a subdir?), invisible from the feature's own code.
4. A feature can surface its own tech debt. `--quick` omits the report phase by design, which means the existing MISSING_COMPLETION_REPORT validator rule will flag every --quick feature — the new capability exposed a validator gap that didn't exist before.
5. Roadmap tooling lives in compose, so roadmap-scale problems are compose features even when another project hits the wall first (SmartMemory's 662KB ROADMAP triggered COMP-ROADMAP-SHARD, but the fix is compose-substrate).

## Open threads

- [ ] COMP-ROADMAP-SHARD (PLANNED) — implement roadmap sharding so oversized ROADMAP.md files split into LLM-processable shards. SmartMemory (662KB) is the first consumer; compose's own (172KB) will follow.
- [x] Validator gap: `--quick`-built features always trip MISSING_COMPLETION_REPORT because the quick lifecycle omits the report phase. **Resolved by COMP-BUILD-QUICK-1** — the quick path stamps `built_via:'build-quick'` onto feature.json at ship (via recordCompletion, before the status flip), and feature-validator exempts marked features from the report check. Only the report check is exempted; a journal entry is still owed. 3 tests, Codex review CLEAN.
- [ ] 122/158 COMPLETE features trip MISSING_COMPLETION_JOURNAL/REPORT respectively — broad advisory debt, not addressed this session beyond COMP-BUILD-QUICK / COMP-BUILD-QUICK-1.

---

*The feature that makes builds quick was not, itself, quick — and the gate that proves it shipped found two bugs the happy path never would.*
