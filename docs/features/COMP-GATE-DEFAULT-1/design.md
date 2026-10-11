# COMP-GATE-DEFAULT-1 — a better offline gate default (design)

**Status:** IN_PROGRESS (design + held-out corpus first). **Owner ask 2026-10-12:** "do the better default".
**Parent:** COMP-GATE-JEV-1 (Jev picks the default when `JEV_API_KEY` is set). This feature is for everyone else, and is
also Jev's fallback.

## Related Documents

- Parent design + spike numbers: `docs/features/COMP-GATE-JEV-1/design.md` (existing)
- Spike corpus and reference labels: `/Users/ruze/reg/my/forge/scratch/2026-10-10-gate-jev-spike/` (`corpus.jsonl`, `preds-ref.jsonl`) (existing)
- Code: `lib/gate-prompt.js` `buildRecommendation()` (existing, regex at :49), gate seam `lib/build.js` ~:5956-5970 (existing)
- Origin of the gate default: COMP-UX-3b (ROADMAP)

## Problem

At a gate with a Stratum summary, Enter accepts a default picked by one regex,
`/(?<!\bno\s)(?<!\b0\s)\b(critical|error|fail|missing)\b/i`. Against `gpt-6.1-sol/high` reference labels on 51 real
summaries it agrees on 30/51, finds 4 of 15 REVISE cases, and raises 10 false REVISEs. A wrong APPROVE default is the
costly error (Enter ships a step that reported a problem), so REVISE recall matters most.

## Facts verified 2026-10-12

- The gate's predecessor history entry carries `outcome` (`lib/build.js:5630`, `result?.outcome ?? 'complete'`), but the
  gate seam passes only `summary`/`artifact` into `gateExtras` (`lib/build.js:5960-5961`). A step that reported
  `failed`/`blocked` still gets a prose-only default today. How often that happens at gates is unmeasured.
- `build_step_done` stream events do not carry `outcome` (118 events across 8 build streams: all `None`).
- Fresh summaries beyond the 51 in build streams: 14 (too few for a held-out test). `~/.stratum/flows` holds ~19.5K flow
  files with step results, mostly from test runs.

## Shape options

| Option | What | Verdict |
|---|---|---|
| A. Structured first, then a rewritten rule | Pass the predecessor `outcome` into the gate: anything other than `complete`/`done` defaults to REVISE. Otherwise a rewritten rule: negation scoped to the clause, a problem vocabulary (blocked, unable, could not, not yet, still failing, regression, unresolved, NOT CLEAN, skipped, deferred, TODO), and clean contexts that must not fire (`0 failures`, `no errors`, `fixed the error`, `all tests pass`). | **Recommended.** Deterministic, offline, explainable, and the structured signal cannot be fooled by wording. |
| B. Rewritten rule only | Same rule, no `outcome` wiring | Smaller, but ignores the one signal that is not prose. |
| C. Local learned classifier | Train on labeled summaries | Rejected: 51 labels is far too few, and it adds a model dependency to a CLI default. |

The default stays a suggestion that a human confirms. Jev, when enabled, still wins.

## Held-out corpus (built and frozen BEFORE any rule is written)

The 51 spike rows are the **dev set**: rule authors may read them. The bar is scored on a **separate held-out set** that
nobody tuning the rule has seen.

- Source: step results in `~/.stratum/flows/*.json` and build streams, real projects only. Exclude flows whose cwd is a
  temp/test dir or whose summary matches test fixtures. Exclude any summary in the dev set (exact and near-duplicate).
- Target n >= 80 distinct summaries, stratified so at least 20 are REVISE by the reference (if fewer exist, report the
  real count and stop for a decision).
- Labels: `gpt-6.1-sol/high`, one call per row, the same frozen question as the Jev spike (`question.txt`, sha recorded
  there). Freeze file + sha256 here before any rule work starts.
- Record `outcome` per row where the source has it, to size option A's structured signal.

## Pre-registered bar (scored on the held-out set only; do not edit after results exist)

All must hold:
1. REVISE recall >= old regex recall + 25 percentage points.
2. Agreement >= old regex agreement + 10% of n.
3. False REVISEs <= old regex false REVISEs (no trading one error for the other wholesale).
4. Old regex vs new rule are both scored by the same script, committed with the results.

Outcome: pass, build. Fail, record numbers and KILL (the old regex stays). Jev numbers on the held-out set are reported
for context only (it already shipped).

## Build (only after a pass)

- [ ] `buildRecommendation()` keeps its signature; the rule moves to `lib/gate-default.js` (new) as a pure function
      `offlineGateDefault({ summary, outcome }) -> 'approve' | 'revise'`.
- [ ] Gate seam passes the predecessor `outcome` into `gateExtras` (`lib/build.js` ~:5961).
- [ ] Recommendation sentence names the source: `(default by jev)`, `(default by step outcome)` or `(default by keyword)`.
- [ ] Table-driven test over every dev-set and held-out row (expected = the rule's frozen output) plus the structured cases.
- [ ] CHANGELOG entry in the same commit. README "Jev gate defaults" paragraph updated with the new keyword-rule numbers.

## Acceptance criteria

- [ ] Held-out corpus frozen with sha256 recorded here before any rule code exists
- [ ] Bar scored and recorded here, PASS or KILL
- [ ] On pass: build checklist above, tests green, Codex review CLEAN
