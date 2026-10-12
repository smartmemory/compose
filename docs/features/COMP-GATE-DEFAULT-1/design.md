# COMP-GATE-DEFAULT-1 — a better offline gate default (design)

**Status:** IN_PROGRESS (A2: owner narrowed to false alarms only 2026-10-12; rule authoring next). **Owner ask 2026-10-12:** "do the better default".
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

## Amendment A1 (2026-10-12, before any labels or rule code): population broadened

**Census result** (`/Users/ruze/reg/my/forge/scratch/2026-10-12-gate-default/CENSUS.md`): only **7** eligible interactive gate
encounters survive provenance + dedup (59 raw ever, all 7 survivors are `design_gate`, all predecessor outcomes `complete`).
That is below the 40-row floor, so the gate-only population cannot carry the bar.

**Change (coordinator, under the owner's "stop stopping" rule; owner may override):** the held-out population becomes
**completion summaries of real-project build steps**, i.e. the `summary` a step returns at completion, which is the exact
text a gate shows for its predecessor. Excluded: steps whose summary is produced programmatically or never shown at an
interactive gate (`review*`, `*_gate`, `execute_merge`, `decompose`, `review_triage`). All provenance, grouping and dedup
rules above still apply (sources: `~/.stratum/ts/flows` first, then legacy `~/.stratum/flows`, then build streams). The 7
true gate rows are scored separately and reported as a sanity check, not as the bar.
Known gap, stated: `plan_gate` inputs carry appended reality text that no stored flow records, so that variant is not covered.
Sample: draw uniformly at random (seed 20261012) from the eligible pool until n = 120, then label; if R < 20, draw further
in blocks of 40 until R >= 20 or the pool is exhausted (report which). No REVISE-targeted sampling, so agreement reflects
the real base rate.

**A1 corpus frozen (2026-10-12, before any labels or rule code).** Builder report
`/Users/ruze/reg/my/forge/scratch/2026-10-12-gate-default/CORPUS.md`. The eligible pool is **51 rows, exhausted** (the n = 120
draw is not reachable). 51 is above the 40-row floor, so all 51 are labeled; no further blocks exist, so R < 20 cannot be
topped up and is reported with its uncertainty. Pool: ts flows 43, legacy flows 8; forge 41, SmartMemory 7, music-gen 3.
sha256: `heldout-u1.jsonl` 441ce4309122cda7a1eb93f63f9fcc4defd381783cb45f8d1dbacb1f30525822, `gate7.jsonl`
4f7e8a938f14d9365771de485c55deacb63ee2ebbc14ddc208100b4f598d9400, `score.py`
6790fbc9352ec766b844712415595ee1f4721e0191b326c6f73221fb21936c13, `old_regex.js`
535fe14148672544754dfd4bf311718c1d53dfd5c3df2c63269c1caeebe9f6e8, `rubric.md`
cc97567918f1b420f9aeb4eb3c8e28fd422b56d0e38251be2be165eb8dbfd363. Scorer self-test on the dev set reproduces the
spike's regex numbers exactly (C 30/51, TP 4, R 15, FP 10).

**A1 labels (2026-10-12, before any rule code).** Two blind labelers on the frozen rubric over 109 rows (51 held-out,
51 dev, 7 gate): Codex `gpt-6.1-sol/high` (run 307e26dd240f) and Claude Opus. Agreement 107/109 (held-out 50/51, dev 50/51,
gate 7/7). Coordinator adjudication: p0044 APPROVE (only pre-existing env-failing tests excluded, one flake passes alone,
step reports done), g044 REVISE (a verification it ran left 2 stale refs unfixed, rubric "findings it did NOT fix").
Files in `/Users/ruze/reg/my/forge/scratch/2026-10-12-gate-default/label/`, sha256 `labels-final.jsonl`
8d62921bc7b228ded6238401efce3c5c9c1972cfe8f7f211d3e1c3d37c6711c3, `labels-heldout.jsonl`
578a5ebb92b1a63ab928e0424e65210621822fb2aaaab1b6655dddb49fe69e99.

| set | n | R (REVISE) | old regex C | old FP | old FN |
|---|---|---|---|---|---|
| held-out | 51 | **0** | 46 (90.2%) | 5 | 0 |
| gate7 (real gates) | 7 | 0 | 5 | 2 | 0 |
| dev (relabeled) | 51 | 11 | 34 | 10 | 7 |

Consequence under the bar below, read as written: R = 0 makes condition 1 vacuous (`4 x 0 >= 0`), old agreement 90.2% > 90%
makes condition 2 "regex already adequate", so only condition 3 (`FPnew <= 5`) remains, which an always-APPROVE function
passes. The held-out set cannot measure the costly error (a wrong APPROVE), because none occurred in 51 real summaries
(rule of three: true REVISE rate under about 6% at 95%). Outcome decision taken to the owner, recorded below.

## Amendment A2 (2026-10-12, owner pick, before any rule code): false alarms only

**Owner decision** (asked with the A1 label numbers above, options stop / false alarms only / wait): **"Fix only the false
alarms."** The original bar below stays as written and is recorded as unmeasurable on this population (R = 0). The work is
narrowed to: stop the keyword default from suggesting REVISE when a problem word is only the topic, negated, or already
resolved, without losing anything the old regex catches.

**Frozen synthetic table** `/Users/ruze/reg/my/forge/scratch/2026-10-12-gate-default/must-table.jsonl`, sha256
3108dbac95a8601f457a8fa13334d3afc4d1fa67cde0e51c8dfeaf48908c4502: 10 must-fire (m00-m09, expect REVISE) and 10 must-not-fire
(n00-n09, expect APPROVE), written by the coordinator before any rule. Old regex: 3/10 must-fire (m02, m04, m08), 5/10
must-not-fire. It matches only the bare words, so `fails`, `failed`, `errors` never fire.

**A2 bar, all must hold, scored once on the frozen candidate with `score.py` counts:**
1. Held-out (R = 0): `FPnew <= 2` (at least 3 of the old regex's 5 false alarms removed).
2. Gate7: `FPnew <= 2` (old 2).
3. Dev (relabeled, R = 11): `TPnew >= 4` and no paired regression on a dev REVISE row (every REVISE the old regex catches
   is still caught), and `FPnew <= 10`.
4. Must table: all 10 must-not-fire give APPROVE, and m02, m04, m08 still give REVISE. The other 7 must-fire rows are
   reported, not required (inflected forms are an improvement beyond the owner's scope, allowed only if 1-3 hold).

Pass: build per the checklist below. Fail: KILL with the numbers, the regex stays. The rule author gets the dev set, its
relabeled labels, the rubric and the must table, never the held-out or gate7 paths.

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
