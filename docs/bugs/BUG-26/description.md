# BUG-26: `roadmap generate` emits a duplicate `## Features` section for phase-less features

**Status:** FIXED (2026-06-07) — see "Resolution" below.

## Source

Found 2026-06-07 while promoting `COMP-BUILD-QUICK` (ideabox IDEA-18). Worked around in the doc by backfilling `phase`/`position` on 7 features; the underlying generator defect remains.

## Problem

`compose roadmap generate` deterministically produces **two** `## Features — PARTIAL` headings whenever the project has features whose `feature.json` has an **empty/absent `phase`** AND the source `ROADMAP.md` also contains a curated `## Features`-titled section.

The two headings split content rather than merge:
- One `## Features` block from any feature whose `phase` is literally `"Features"` (rendered through the normal typed-phase path).
- A second `## Features` block synthesized from the **ungrouped bucket** — features with no `phase` — emitted via the hardcoded `'Features'` literal at `lib/roadmap-gen.js:179`.

The duplication is **self-stable**: `roadmap check` reports it as a "lossless fixed point," so the validator masks it, and hand-merging the two sections does not survive the next `generate` (it re-splits every time).

## Root cause

1. `lib/roadmap-gen.js:80-86` — a feature with `f.phase == null` (empty or absent) is pushed to `ungrouped`.
2. `lib/roadmap-gen.js:177-180` — `if (ungrouped.length > 0) sections.push(renderPhase('Features', …))`. The bucket name is the **hardcoded string `'Features'`**.
3. When the source `ROADMAP.md` *also* has a real `## Features — PARTIAL` section (curated, carrying those same rows), the phase-loop emits that preserved/source block too (`phaseBlocks` path), so the same logical group renders under two identical headings.
4. `compose roadmap check` treats the 2× output as a fixed point because `generate(parse(file)) === file` — the duplicate is reproduced identically, not flagged.

Net: the literal `'Features'` ungrouped-bucket name **collides** with any real user section named "Features," and there is no merge of two source blocks that share a phase identity.

## Repro

1. Create ≥1 feature whose `feature.json` omits `phase` (or sets it to `""`).
2. Ensure `ROADMAP.md` has a `## Features — PARTIAL` section listing those features as rows.
3. Run `compose roadmap generate`.
4. Observe **two** `## Features — PARTIAL` headings in the output (one may hold typed rows, the other the ungrouped rows).
5. Run `compose roadmap check` → "fixed point, lossless" (false clean).
6. Hand-merge into one section, re-run `generate` → re-splits into two.

## Expected

- The ungrouped bucket should merge with — not duplicate — an existing same-identity source section.
- Two source blocks that resolve to the same phase identity should be merged on generate (the dedupe at `roadmap-gen.js:111` covers `sourcePhaseOrder` but not block-level merge for the ungrouped/`'Features'` path).
- `roadmap check` / `validate` should flag duplicate `## ` headings rather than blessing them as a fixed point.

## Acceptance

- [ ] `generate` produces exactly one section per phase identity, even when ungrouped features coexist with a curated `## Features` section.
- [ ] Two source blocks sharing a phase identity merge (rows unioned, order preserved) instead of double-emitting.
- [ ] `validate` gains a `DUPLICATE_PHASE_HEADING` finding (so the masking can't recur silently).
- [ ] Regression test: fixture with phase-less features + a `## Features` source section → assert single heading and idempotent regen.

## Workaround applied (2026-06-07)

Backfilled `"phase": "Features"` + sequential `position` on the 7 phase-less features (`COMP-CLI-GLOBAL-FLAGS`, `COMP-MOBILE`, `COMP-MOBILE-REMOTE`, `COMP-WORKSPACE-{HTTP,ID,RESUME,WATCHERS}`) so they group under the typed phase instead of the ungrouped bucket. This collapsed the roadmap to one stable `## Features` section and cleared 7 validate findings (482 → 475). The generator defect itself is unfixed — any future phase-less feature will re-trigger it.

## Affected files

- `lib/roadmap-gen.js` (lines ~80-86 ungrouped collection; ~177-180 hardcoded `'Features'` emit; ~111 dedupe scope)
- `lib/roadmap-preservers.js` (`readAnonymousRows`, `readPhaseBlocks`)
- `lib/feature-validator.js` (add duplicate-heading detection)

## Resolution (2026-06-07)

**Root cause** turned out to be the **ungrouped bucket**, not block-merge: phase-less features (`f.phase` empty/absent) were collected into `ungrouped` and emitted via the hardcoded `renderPhase('Features', …)` at `roadmap-gen.js:179`, which collided with the curated `## Features` source section the phase loop already emitted.

**Fix:**
- `lib/roadmap-gen.js` — phase-less features now group under the conventional `Features` phase key (`f.phase || 'Features'`), the same identity a `## Features` heading parses to. The normal phase loop merges them into one section (splice into the source block when present, synthesize once when absent). Removed the separate `ungrouped` array and its emission. Convergence/idempotence proven by `test/roadmap-ungrouped-features-merge.test.js` (5 tests).
- `lib/feature-validator.js` — added project-level `DUPLICATE_PHASE_HEADING` warning (one per duplicated `## ` title; collected in `loadValidationContext`, emitted by `runDuplicatePhaseHeadingCheck`) so a never-regenerated duplicate can't hide as a "lossless fixed point" again. Covered by 2 tests in `test/feature-validator.test.js`.

Acceptance criteria 1, 2, 3 met. Criterion 4 (regression test fixture) delivered as the two test files above. The earlier per-repo workaround (backfilling 7 `feature.json` phases) remains in place and is now redundant-but-harmless — the generator would keep them single-section regardless.
