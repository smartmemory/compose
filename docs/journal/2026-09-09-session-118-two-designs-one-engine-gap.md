---
date: 2026-09-09
session_number: 118
slug: two-designs-one-engine-gap
summary: Reviewed two Codex/astra designs; archive proposal cut from five features to one, Fable/Astra loop found inexpressible in the engine and re-filed as an epic with two Stratum prerequisites
closing_line: Two designs cited the right files and were wrong about both; the review earned its keep at the seams.
---

# Session 118 — Reviewed two Codex/astra designs; archive proposal cut from five features to one

**Date:** 2026-09-09

## What happened

The ask was to review the designs Codex/astra had produced that day: COMP-ROADMAP-ARCHIVE (automatic roadmap archival) and COMP-FABLE-ASTRA (Fable planning and reviewing waves of Astra workers). Both were uncommitted, both cited real files, and every file they cited existed. That was the easy part.

The archive design had the right diagnosis and asked for five features under one L ticket: a new DEFERRED status across every surface, a transactional multi-file publisher, GitHub tree-commit parity, cross-root link rewriting, and automatic edits to narrative-owned roadmaps. We cut it to the slice that produces the user-visible result and recorded four decisions so blueprint cannot reopen them: PARKED plus a persisted reason instead of DEFERRED, generated mode only, local provider only, and a settled boundary with COMP-ROADMAP-SHARD.

The Fable/Astra design read as a charter. It called Fable's identity an open question (it is claude-fable-5-1; the stale part is the Claude tier table), it never mentioned COMP-AGT-COORD, and it did not say whether Fable's decisions enter the run as recorded step outputs or as a live controller. We rewrote it as steps plus the engine's gate revise edge and left one Stratum question for blueprint. Codex answered that question in round 1: a fanout over a downstream step's output is a routing cycle, and the revise reset deletes the output anyway. Round 2 showed a bare revise payload is still not enough (no value on the first pass or a merge retry), that foreground flows have no durable cancel, that worktrees start from HEAD so a repair wave would repair the wrong tree, and that merge never checks files_owned. The preset became an XL epic with two Stratum prerequisites and three Compose seams.

We ran two Codex sol/high rounds per design, folded every finding, stopped at two rounds, committed both as PLANNED, and filed STRAT-LOOP-CARRY and STRAT-FLOW-CANCEL-FG in stratum.

## What we built

- `docs/features/COMP-ROADMAP-ARCHIVE/{design,plan,feature.json}` — v1 scope, seam inventory including `compose feature`, build start reactivating PARKED rows, lane-gate and follow-up recovery; stage-then-intent-then-rename publication with a persisted baseline; placement rules for anonymous rows, rowless phase blocks and item rows; two-round review log.
- `docs/features/COMP-FABLE-ASTRA/{design,feature.json}` — step shape plan, execute, merge gate, verify, review, assess, assess gate; dependencies D1 to D5; numeric budget with the engine's round semantics; cost ceiling pauses the gate instead of killing.
- `docs/features/COMP-ROADMAP-SHARD/feature.json` — active/archived shape recorded as superseded.
- stratum `docs/features/STRAT-LOOP-CARRY`, `STRAT-FLOW-CANCEL-FG` (@ad3a518) — the two engine prerequisites, with the Codex evidence attached.
- compose @78e9cd1, CHANGELOG entries in both repos.

## What we learned

1. **A design that lists files is not grounded; a design that says what each seam cannot do is.** Both drafts cited the right files and were still wrong about what those files did (merge does not check ownership, cancellation does not reach the flow, the gate clears its own intent). The review value came from checking behaviour at each seam, not existence.
2. **The engine's revise edge is a back-edge with amnesia.** `resetFrom` clears the target and every descendant, and output references are dependency edges, so no preset can loop over a re-planned list today. Anything that wants a real repair loop needs a loop-carried flow value, not a prompt trick.
3. **A synonym status is a schema change.** DEFERRED would have touched eight surfaces to say what PARKED plus a reason already says. The cost of a vocabulary word is the width of the status enum's fan-out.
4. **Codex design review converges when the doc names decisions.** Round 2 on both designs produced only refinements of the fixes and zero re-litigation of the recorded decisions, because the prompts pointed at the decision list and the docs carried it.
5. **Typed cross-repo links do not exist yet.** The validator resolves link targets against local sources only; a STRAT dependency lives in the description until COMP-XREF-SCHEMA ships.

## Open threads

- [ ] STRAT-LOOP-CARRY and STRAT-FLOW-CANCEL-FG are PLANNED; COMP-FABLE-ASTRA slices 2 onward are blocked on them. Slice 1 (tier bump, `coordinator` tier, fail-closed sidecar preflight) is independent and can go first.
- [ ] COMP-ROADMAP-ARCHIVE is ready for blueprint; the remaining risk is in the publication transaction detail, not in the design.
- [ ] Pre-existing tree noise not touched: COMP-GUARD-CLAIM-1's IN_PROGRESS to PLANNED flip and audit.json from 09-07, and a stranded link edit in the July `compose-develop` worktree.
- [ ] Pre-existing validate errors: COMP-SEMVER-STRICT vision-state mismatch (local gitignored state).

---

*Two designs cited the right files and were wrong about both; the review earned its keep at the seams.*
