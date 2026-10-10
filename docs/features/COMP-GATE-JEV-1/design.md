# COMP-GATE-JEV-1 — Jev for the gate approve/revise default (design)

**Status:** PLANNED (filed 2026-10-10). **Value spike:** PENDING. Build only if the spike passes.
**Origin:** redirected from `stratum/docs/features/STRAT-JUDGE-JEV-1/design.md` (PARKED 2026-10-10: its `stakes: cheap`
target has zero real callers). Owner pick: "redirect Jev to a live call site".

## Related Documents

- Parked predecessor: `/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-JUDGE-JEV-1/design.md` (existing)
- Survey: `/Users/ruze/reg/my/forge/scratch/2026-10-10-jev-fit/report.md` (existing)
- Prior Jev spike (method and client reused): `/Users/ruze/reg/my/SmartMemory/scratch/2026-10-10-maya-jev-intent/REPORT.md` (existing)
- Spike folder: `/Users/ruze/reg/my/forge/scratch/2026-10-10-gate-jev-spike/` (new)
- Code: `lib/gate-prompt.js` (existing), `buildRecommendation()` at :42, keyword regex at :49; callers `lib/build.js:32`, `lib/new.js:12`

## Problem

When Stratum sends a step summary, `buildRecommendation()` picks the gate's default answer with one regex:
`/(?<!\bno\s)(?<!\b0\s)\b(critical|error|fail|missing)\b/i`. A summary that says "returned false" or "not a defect"
can flip it either way. The default is what Enter accepts, so a wrong "approve" default is the costly error.

Honest size of the win: this is a suggested default that a human confirms. The value is modest, so the build stays small.

## Value spike (run BEFORE any build)

Pre-registered here before any run. Do not edit this section after results exist.

- **Corpus:** `scratch/2026-10-10-gate-jev-spike/corpus.jsonl`, 51 distinct real `build_step_done` summaries from four
  projects' `.compose/build-stream.jsonl`. sha256 `93ac13b2ddd13a6c9c5614902fb056cca6193314f6babff3734b00b358581284`.
  The regex verdict is stored per row (14 revise, 37 approve).
- **Question (all arms):** "This is the summary of a finished lifecycle step, shown at a review gate. Should the default
  answer be APPROVE (the step reports its work done, nothing blocking) or REVISE (it reports a defect, failure, missing
  artifact or unresolved blocker in the step's own work)?"
- **Reference:** `gpt-6.1-sol/high`, one call per row.
- **Arms:** (1) the current regex; (2) `gpt-6-luna/low`, one call per row; (3) Jev `choice`, one call per row.
  Jev wording is frozen before the run. No tuning rounds (n is too small for a dev split).
- **Pre-registered bar, all four must hold:**
  1. Jev agreement with the reference >= regex agreement **+ 3 rows** (fewer is noise at n=51).
  2. Jev REVISE recall (vs the reference) >= regex REVISE recall.
  3. Jev agreement >= luna agreement.
  4. Jev p95 latency < 1 s, measured from this Mac.
- **Outcome:** pass, build below. Fail, mark KILLED with the numbers. If the regex already agrees on >= 49/51, record
  "regex is good enough" and kill.

## Build (only after a pass)

- [ ] `buildRecommendation()` asks Jev when `COMPOSE_GATE_JEV=1` and `JEV_API_KEY` is set. Off by default.
- [ ] Jev error, timeout (budget 1500 ms) or missing key: log one WARNING and use the regex. Never block the gate.
- [ ] The key is read by name only. No key value in code, logs, fixtures or docs.
- [ ] Table-driven test over: Jev approve, Jev revise, Jev error, Jev timeout, flag off, key missing.
- [ ] CHANGELOG entry in the same commit.

## Acceptance criteria

- [ ] Spike run, results recorded in this file against the bar
- [ ] Spike artifacts and a README in the spike folder, `JEV_API_KEY` absent from all of them
- [ ] On pass: the build checklist above, with tests green. On fail: status KILLED with numbers
