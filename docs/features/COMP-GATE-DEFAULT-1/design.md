# COMP-GATE-DEFAULT-1 — a better offline gate default (design)

**Status:** IN_PROGRESS (design revised after review r1; census + held-out corpus next). **Owner ask 2026-10-12:** "do the better default".
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

## Facts verified 2026-10-12 (corrected after design review r1)

- **The step `outcome` does not reach an interactive gate.** The history entry stores it (`lib/build.js:5630`), but a
  `failed` result becomes a failure envelope (`lib/build.js:5727`) and the engine retries, follows `on_fail` or terminates
  before any successor gate runs. `blocked` is not in the built-in `PhaseResult` enum (`pipelines/build.stratum.yaml:15`).
  So a structured "outcome" branch would almost never fire. It is dropped (see options) and only measured.
- **Not every summary is a gate input.** `review_gate` resolves programmatically (`lib/build.js:6242`). `plan_gate` appends
  the code-graph reality text to the summary (`lib/build.js:6225`). The input this feature changes is exactly the string
  `promptGate()` receives as `gateExtras.summary` for an interactive gate.
- Current flow state lives in `~/.stratum/ts/flows` (`lib/flow-state.js:33`, override `STRATUM_STATE_ROOT`), 515 files.
  `~/.stratum/flows` (~19.5K files) is the legacy store. Build streams hold no `outcome` key and almost no summaries beyond
  the dev set.
- The dev set has label noise: `g002` and `g003` are near-identical summaries from one flow with opposite reference labels.

## Shape options

| Option | What | Verdict |
|---|---|---|
| A. Structured outcome first, then a rewritten rule | Pass the predecessor `outcome` into the gate | **Dropped** for the build: the outcome cannot be non-success at an interactive gate in built-in pipelines (facts above). The census measures it, and A is reconsidered only if the census finds non-success outcomes at interactive gates. |
| B. Rewritten rule | Clause-scoped negation, a problem vocabulary (blocked, unable, could not, not yet, still failing, regression, unresolved, NOT CLEAN, deferred, TODO), clean contexts that must not fire (`0 failures`, `no errors`, `fixed the error`, `all tests pass`), and a defined policy for mixed clean/problem clauses | **Recommended.** Offline, deterministic, explainable. |
| C. Local learned classifier | Train on labeled summaries | Rejected: far too few labels, and a model dependency in a CLI default. |

The default stays a suggestion that a human confirms. Jev, when enabled, still wins.

## Behavioral contract (unchanged paths stay unchanged)

- No `gateExtras.summary`: the existing artifact-assessment path runs, unchanged.
- Summary present, Jev answered: Jev's answer, unchanged.
- Summary present, Jev off or failed: the new rule replaces the regex. It returns `approve` or `revise`, never null.
- The sentence names the source: `(default by jev)` or `(default by keyword)`, as today when Jev is enabled. With Jev
  disabled the sentence stays as today (no source suffix).

## Held-out corpus protocol

**Population.** Interactive gate encounters from real builds: a gate step other than `review_gate`, whose predecessor is
chosen exactly as `lib/build.js:5956-5961` does, and whose input is the final `gateExtras.summary` string (for `plan_gate`,
including the appended reality text if the flow recorded it, else flagged `reality_text_unknown`).

**Provenance (positive, all required).** The flow file is in `~/.stratum/ts/flows` or a build stream of a real project; its
cwd is under `/Users/ruze/reg/my/` and contains none of `/tmp/`, `/var/folders/`, `/test`, `fixture`, `scratch/`; the summary
string does not occur in any file under `compose/test/`, `stratum/ts/tests/`, `stratum/ts/test/`. Each kept row records flow
id, cwd, gate step id, predecessor step id, timestamp.

**Grouping and dedup.** Normalize (lowercase, collapse whitespace, digits to `0`). Near-duplicate = word-3-gram Jaccard
>= 0.6. Drop any held-out row that is a near-duplicate of a dev row. Within held-out keep at most one row per near-duplicate
cluster and at most 2 rows per (feature code or flow id) group, choosing the earliest.

**Size.** First a **census** reports how many rows survive provenance + dedup, before any labels. Target n >= 80 with
R >= 20 reference REVISEs. Stratification toward REVISE is allowed only if recorded (eligible population base rate and per-
stratum sampling probability). If the census finds fewer than 40 eligible rows, stop and take it to the owner (options:
lower n with stated uncertainty, or wait for more real builds).

**Who.** A corpus-builder agent (single use) builds, labels and freezes `heldout.jsonl` with its sha256 recorded here. The
rule author gets only the dev set and never the held-out path. The coordinator runs the frozen scorer once on the frozen
candidate.

**Labels.** A frozen rubric (`rubric.md`, committed with the corpus) defines REVISE: the step's own work reports a defect, a
failure, a missing required artifact or an unresolved blocker. Not REVISE: an optional item deferred on purpose, a
successful bug reproduction, an intentionally red TDD stage, findings already fixed. Two independent labelers of different
vendors, each blind to the other: `gpt-6.1-sol/high` and Claude Opus. Agreement -> that label. Disagreement -> the
coordinator adjudicates against the rubric before any rule exists, and the row records `adjudicated: true`. The labeler
agreement rate is reported. The dev set is relabeled the same way so dev and held-out use one standard.

## Pre-registered bar (held-out only; scorer and corpus frozen before any rule code; do not edit after results)

Definitions on the held-out rows: `n` rows, `R` reference REVISEs, `TP` predicted REVISE and reference REVISE, `FP`
predicted REVISE and reference APPROVE, `C` predictions equal to the reference. "old" = the current regex exactly as in
`lib/gate-prompt.js` at ddc8fd53. "new" = the complete candidate offline function. Both arms score the same row ids;
every row must get a valid label and a valid prediction or the run is void.

All must hold:
1. `4 × (TPnew − TPold) ≥ R` (REVISE recall up by at least 25 points)
2. `10 × (Cnew − Cold) ≥ n` (agreement up by at least 10% of n)
3. `FPnew ≤ FPold` (no new false alarms overall)

Headroom: if old recall > 75% or old agreement > 90% on the held-out set, the respective condition is impossible; record
"regex already adequate" for it and decide on the remaining conditions. Report also: class rates, the base rate, paired
regressions (rows old got right and new got wrong), and Jev's numbers for context.

Outcome: pass, build. Fail, record numbers and KILL (the regex stays).

## Build (only after a pass)

- [ ] `lib/gate-default.js` (new): pure `offlineGateDefault(summary) -> 'approve' | 'revise'`; `buildRecommendation()`
      keeps its signature and calls it in place of the regex.
- [ ] Table-driven test over every dev and held-out row (expected = the frozen candidate's output) plus the rubric's edge
      cases.
- [ ] Through the real gate seam: Jev answer wins, Jev off/failed uses the new rule, Enter accepts the displayed default.
- [ ] CHANGELOG entry in the same commit. README "Jev gate defaults" paragraph updated with the new numbers.

## Acceptance criteria

- [ ] Census reported (eligible count, base rate) before labeling
- [ ] Rubric, labels (with agreement rate), held-out corpus and scorer frozen with sha256s recorded here before rule code
- [ ] Bar scored once and recorded here, PASS or KILL
- [ ] On pass: build checklist above, tests green, Codex review CLEAN

Design review r1: `/Users/ruze/reg/my/forge/scratch/2026-10-12-gate-default/design-review-r1.md` (NOT CLEAN, all 7
accepted, revised here; no round 2 per the plan review rule).
