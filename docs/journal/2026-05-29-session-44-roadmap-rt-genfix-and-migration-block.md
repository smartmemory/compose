---
date: 2026-05-29
session_number: 44
slug: roadmap-rt-genfix-and-migration-block
summary: Shipped GENFIX (T1–T5) for deterministic roadmap roundtripping; scratch migration revealed the real blocker is migrate parsing planning narratives as feature tables, not the sort
feature_code: COMP-ROADMAP-RT-GENFIX
closing_line: The sort was the bug we were told to fix; the migration was the bug that fixing it revealed.
---

# Session 44 — COMP-ROADMAP-RT-GENFIX

**Date:** 2026-05-29
**Feature:** `COMP-ROADMAP-RT-GENFIX`

## What happened

We resumed mid-flight on COMP-ROADMAP-RT-GENFIX, the five gen/parse defects standing between us and a deterministic migration of ~169 historical ROADMAP rows into feature.json. T1 and T2 were already committed and reviewed; T3 (symmetric pipe escaping) was committed but unreviewed. We ran Codex over T3 first — clean, no findings — then moved to T4, the one the prior session flagged as 'the blocker, most care.'

T4 was the NaN comparator: `listFeatures` sorted by `(a.position ?? 999) - (b.position ?? 999)`, which is NaN when a position is a ranged string like "141–144" (the migration emits those). A NaN comparator is not a total order, so typed-row emit order — and therefore where struck/anon rows anchor — was non-deterministic, and the roundtrip never reached a fixed point. We wrote a `positionSortKey` that parses the leading integer (numeric or ranged), falling back to a sentinel + code tie-break, and proved it red→green both as a unit test and an end-to-end convergence test (a `~~struck~~` row adjacent to a ranged-position row, two passes byte-identical). T5 made `readAnonymousRows` treat a case-insensitive strict-code match as typed (uppercased) instead of anon, killing phantom-duplicate churn.

Codex review of T4 earned its keep: it found a SECOND NaN comparator we'd missed — the `newPhases` sort in `roadmap-gen.js` using `Math.min(...map(f => f.position ?? 999))`. We routed it through the same `positionSortKey`, tightened the regex to anchor leading digits (so genuinely malformed positions hit the sentinel rather than grabbing mid-string digits), added coverage, and re-reviewed clean.

With T1–T5 done, reviewed, and the full suite green (node 2933 / vitest 139 / tracker 100), we merged `--no-ff` to main and pushed. Then the real test: a scratch-copy migrate → generate → check. It came back NOT A FIXED POINT. The divergence was fully localized to the `## Execution Sequencing` section — a curated planning narrative with `### Wave N` sub-headings and a non-standard `| Feature | Items | Effort | Rationale |` table schema. `migrate` was parsing those wave rows as feature tables, minting phantom bare-code feature.jsons (COMP-BUDGET pos 225 with description "141–144", COMP-TRIAGE, COMP-AGENT-CAPS…) that collide with the real COMP-BUDGET-1..4 living in their own phase. Their struck/anon neighbours duplicated and GREW on every regen pass. Wrapping the section in a preserved-section marker didn't help — migrate ignores the marker. We confirmed the wave features all have authoritative homes elsewhere (the waves are pure references), characterized the defect, left the real repo untouched (all testing on copies), and stopped to hand the data/code decision back to the human.

## What we built

- `lib/feature-json.js`: new exported `positionSortKey(position)` (leading-int, range-tolerant, sentinel fallback); `listFeatures` sort now uses it instead of the NaN-prone subtraction.
- `lib/roadmap-gen.js`: imports `positionSortKey`; `newPhases` sort uses it (was the second NaN comparator).
- `lib/roadmap-preservers.js`: `readAnonymousRows` treats a case-insensitive strict-code match as typed, anchored by the uppercased canonical code.
- `test/feature-json-sort.test.js` (new): deterministic total order with ranged positions; `positionSortKey` unit cases incl. malformed→sentinel.
- `test/roadmap-ranged-position-converge.test.js` (new): e2e fixed point with a struck row adjacent to a ranged position; new-phase numeric ordering.
- `test/roadmap-preservers.test.js`: T5 lowercase-code-is-typed case.
- `docs/features/COMP-ROADMAP-RT-GENFIX/plan.md`: status → COMPLETE with commit map.
- Commits: T4 `b56ea02`, T5 `eb77ec4`, T4 review-fix `7a68b55`, plan `deef16a`; merged to main as `548e0a5`.

## What we learned

1. **The assigned bug and the blocking bug are not always the same.** GENFIX (the sort) was real and worth fixing, but it was never what stopped the migration. Only running the actual migration on a copy surfaced the true blocker. Fix the named defect, then re-run the real workflow before declaring victory.
2. **Review loops catch what tests can't reach.** The full suite was green with the first NaN comparator still live in `newPhases` — no existing test exercised a new-phase-with-ranged-position. Codex's second-pass over the impl found it. This is the third time review-on-implementation (not just design) has caught an unwired/under-covered path.
3. **`migrate` has no schema discipline.** It treats any `| a | b | c | d |` row as a feature row and ignores preserved-section markers, so a curated planning narrative becomes phantom features. The roundtrip machinery downstream is correct; the parser feeding it is too permissive. The fix belongs in migrate (skip preserved-sections, require the canonical header, reject bare phase-name codes), paired with source cleanup.
4. **Monotonic-growth divergence ≠ reordering divergence.** The diff between passes was all additions, which told us the anon rows were re-emitting and accumulating, not just swapping places — a sharper signal than 'not a fixed point' alone.
5. **Scratch copies are cheap insurance.** rsync-minus-node_modules + a node_modules symlink let us run destructive migrations repeatedly with zero risk to the real ROADMAP and feature dirs.

## Open threads

- [ ] New feature (≈COMP-ROADMAP-RT-MIGRATE-PREP): make `migrate` skip `<!-- preserved-section -->` content, require the canonical `| # | Feature | Description | Status |` header, and reject bare phase-name codes — so planning narratives don't mint phantom features.
- [ ] Source cleanup: wrap `## Execution Sequencing` (and other curated narratives) in a preserved-section; dedupe the doubled `## Features`; remove/relabel the stray lowercase `## implementation`; review `## Backlog` / `## Standalone`.
- [ ] Re-attempt the ~169-row migration on a scratch copy until `roadmap check` is a clean fixed point; only then run it for real.
- [ ] HUMAN decision (don't auto-resolve): 2 genuine status drifts — `COMP-MCP-MIGRATION-2-1` (feature.json PARTIAL vs roadmap COMPLETE) and `COMP-MCP-MIGRATION-2-1-1-1` (PLANNED vs COMPLETE).

---

*The sort was the bug we were told to fix; the migration was the bug that fixing it revealed.*
