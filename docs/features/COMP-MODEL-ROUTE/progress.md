# COMP-MODEL-ROUTE — progress ledger

## 2026-09-10 — filed + design drafted
- Owner asked "what if we want dynamic routing to subagents based on difficulty". Clarified: not
  failure-based escalation; self-learning; scope = EVERY pipeline step; most keys stay static
  (preset/manual), learning mostly on plan + implement; the deliverable is a routing FRAMEWORK
  whose values are static or dynamic per key.
- Row added: COMP-MODEL-ROUTE (position 153, COMP-TEAMS phase, L, high). Links: supersedes
  COMP-FABLE-CALIBRATE (its calibration table = slice 2 here); depends_on COMP-FABLE-ASTRA.
- COMP-FABLE-CALIBRATE could NOT be flipped: PLANNED→SUPERSEDED is not a lifecycle transition,
  force is disabled under capabilities.guard, KILLED is lifecycle-owned and `kill_feature`
  needs the compose server (:4001, not running; not started unasked). TODO when server is up:
  kill_feature COMP-FABLE-CALIBRATE reason "superseded by COMP-MODEL-ROUTE".
- design.md written (Fable). Decisions D1–D7, slices S1–S3, 10 completion-evidence items.
- Owner directive mid-turn: "maximize usage of astra" → design review r1 dispatched to Codex
  gpt-6-astra/high, runId 7882a3be8644, report → reports/design-review-r1.md.

## 2026-09-10 — design review r1 (astra, run 7882a3be8644, 6 min, 1.24M tok) → 6 HIGH / 3 MEDIUM
Verdict: not buildable as written; three slices viable after changes. Report: reports/design-review-r1.md.
Adjudication (Fable) — ALL NINE ACCEPTED, rulings where the reviewer left a fork:
1. Acceptance ≠ final epoch. Derive from gate dispositions + acceptedDispatchToken + task lineage across
   waves; capture per-wave item bindings BEFORE the revise reset; labels accepted / repaired / re-implemented /
   retried-same-epoch / failed-or-cancelled / unknown(censored). Final epoch = freshness only.
2. Receipt attribution: Compose-side durable join routing-issuance → every model-call dispatch id (incl.
   normalization-repair calls). Rows with missing attribution or cost = incomplete evidence, EXCLUDED, never pooled.
3. Statistical key ≠ record identity. Record id = run + scoped step/stage + epoch + item/generation + issuance
   token; key is a field. Route receipt ids use the issuance token. Ledger materialization idempotent by record id.
4. Immutable START RECORD (policy, frozen evidence-table version, seed minted before plan, static resolutions +
   their digest) carried through fresh AND resume input handling; later wave decisions = immutable journal
   entries bound to the root + recorded wave input; unseen waves resolve from the PINNED table; missing/drifted
   routing record fails closed. Do not claim the sidecar guard or an appendable input provides this.
5. RULING: manual = "replace the fallback" (today's mergeRuntimeProfiles semantics, off-mode byte-identical).
   No force-override in v1 (filed as follow-up). Provenance kept in the start record, not the merged profile.
   Learned per-item tiers get their own resolved-route map consulted at admission, NOT the default seam.
6. Repair floor becomes an explicit ADMISSION constraint applied after every source (manual, learned, preset).
   Floor = the tier that actually executed for the repaired task (lineage-recorded); absent lineage → refuse.
7. Supported boundary in v1: ordinary agent steps + single-stage consumer fanouts, via build AND gsd admission
   (broaden admitConsumerWave entry). Engine-dispatched fanouts, multi-stage fanouts, normalization subcalls:
   recorded as source:unsupported rows, never routed. Resolved-route map is stage-aware and separate from the
   profile map. S1/S3 + Files list the real touched paths.
8. Cold start: explicit recorded calibration TRIALS in shadow (`route_trials` per-key alternate tiers, bounded
   fraction, source:'trial', excluded on manual-overridden keys, repair waves, ceiling gates, assess). Unobserved
   cells reported as unknown, never projected. Provider-specific tier ladders; `coordinator` (Fable) is not a rung.
9. Planner calibration feedback gated separately (`calibration_feedback`, default OFF in shadow baseline);
   calibration string is an immutable start input; report cohorts labelled static vs calibration-influenced.
Next: astra revises design.md per rulings (fix run), then r2 review targets the fixes.

## 2026-09-10 — design revision r1 (astra fix run 606e18487868, 7.5 min, 568K tok)
design.md rewritten 289 → 448 lines: 11 decisions (start record, record identity vs statistical key,
supported boundary, receipt joins, acceptance labels with lineage, repair floor as admission rail,
cold-start trials, gated calibration feedback), S1 now carries persistence/joins/outcomes, 20 evidence
items, Files table lists build.js + gsd.js + consumer-fanout.js + result-normalizer.js + output-gate.js
+ 4 contracts. Fable read the full revision: consistent with all 9 rulings; no code claim contradicted
what r1 verified. Round 2 (targets the fixes) dispatched: astra run 973c7cb3e898 → reports/design-review-r2.md.

## 2026-09-10 — design review r2 (astra, run 973c7cb3e898) → 1 HIGH / 2 MEDIUM; r1 findings 2,3,5,6,7,9 RESOLVED, 1,4,8 RESOLVED-WITH-NEW-ISSUE
Report: reports/design-review-r2.md. Adjudication (Fable) — ALL ACCEPTED:
1. HIGH GSD resume = new engine run (gsd.js:294–304, filtered graph :1300–1320). RULING: participating GSD
   resume is a RECORDED CONTINUATION sharing the original start root (reviewer option A). Persist old→new
   engine-run link + the filtered-graph transformation; decisions carry by LOGICAL task id (the planner's
   task id, stable across the filtered graph) + logical wave id, never by array index; each actual redispatch
   gets a new issuance record; reconcile uncertain prior calls before continuing; one logical start = one
   breadth vote. Resuming the original engine run (option B) is NOT chosen — different recovery design.
2. MEDIUM ordinary-step routes at repair epochs: accept. Frozen initial candidate ≠ admitted route; at each new
   epoch check recorded repair context before issuing an ordinary call, suppress ineligible trial/explore to
   static baseline + floor, append to the root-bound journal; same-epoch retries reuse; resume reuses.
3. MEDIUM censored rows satisfy durability: accept. ONE acceptance-eligible population (attributed + cohort +
   final binary label) — all durability counts and breadth votes come from it; all-observation cost + censoring
   reported separately. RULING on partial label groups: confirmed cancellation = EXCLUDED (censored, not model
   evidence); retried-same-epoch = NEGATIVE (work did not stick).
S1 split ACCEPTED: S1a recorded routing lifecycle + recovery (incl. GSD continuation); S1b attributable shadow
outcomes (joins, pre-reset capture, acceptance, ledger). S2/S3 depend on S1b. Trials + floor stay in S3.
Next: astra fix run, then r3 targeted at these three fixes (round cap per feedback_review_loop_budget).

## 2026-09-10 — design revision r2 (astra fix run f0d07df96078, 3 min, 259K tok)
design.md 448 → 494 lines: GSD continuation protocol in D3 (shared root, logical task/wave ids, one breadth
vote per logical start), per-epoch ordinary admission separated from frozen candidate, single
acceptance-eligible population in D6/D8, S1 split S1a/S1b, evidence + Files updated. Fable spot-read D3
continuation, D8 population and Slices: matches rulings. r3 (final gate, targets the three fixes + split)
dispatched: astra run 63034084e627 → reports/design-review-r3.md.

## 2026-09-10 — design review r3 (astra, run 63034084e627) → REVIEW CLEAN (4/4 checks PASS)
Design gate closed at round 3 (cap). Total astra spend this gate: 3 reviews + 2 fix runs, ~2.4M tokens.
Feature stays PLANNED. Next step when ordered: blueprint for S1a (recorded routing lifecycle + recovery).
