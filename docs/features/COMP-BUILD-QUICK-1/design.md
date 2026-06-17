# COMP-BUILD-QUICK-1 — Design

**Status:** COMPLETE (2026-06-17) · **Parent:** COMP-BUILD-QUICK

## Problem

`compose build --quick` collapses the build lifecycle and **omits the report phase by design**. But `feature-validator.js` flags every COMPLETE feature lacking `report.md` with `MISSING_COMPLETION_REPORT`. So every feature built via `--quick` would trip an advisory warning for an artifact it was never meant to produce — a contract gap the COMP-BUILD-QUICK feature surfaced on its own first run.

## Approach

Mark quick-built features and exempt them in the validator.

1. **Stamp at ship.** `recordCompletion` (the existing feature.json writer invoked at ship) accepts an optional `built_via` slug and persists it onto feature.json at step 5h, *before* the status flip (5i). `setFeatureStatus` re-reads the fresh feature, so the marker survives the flip.
2. **Thread the template.** The build `context` carries `templateName`; `executeShipStep` derives `built_via = 'build-quick'` when the template is `build-quick`, and passes it to both `recordCompletion` call sites (git + no-git).
3. **Exempt in the validator.** `MISSING_COMPLETION_REPORT` skips features whose feature.json has `built_via === 'build-quick'`.

## Decisions

- **Marker on feature.json, not a folder heuristic.** The validator already reads feature.json; `built_via` is an explicit, reliable signal where "blueprint.md absent" would be ambiguous (full builds can skip phases too).
- **Only the report check is exempted.** A journal entry is owed for every session regardless of build path — `MISSING_COMPLETION_JOURNAL` is intentionally NOT exempted.
- **Stamped at ship, not at start.** Ship is the completion moment and already owns the feature.json write; no extra write or lock.
- **Specific value, not a category.** v1 matches the literal `'build-quick'`. A future trimmed template would extend the check explicitly — preferred over a fuzzy "is this a quick template" guess.

## Acceptance Criteria

- [x] `recordCompletion` accepts + validates + persists `built_via` (lowercase template slug)
- [x] `--quick` ship stamps `built_via:'build-quick'` (both git and no-git paths)
- [x] Validator exempts `built_via === 'build-quick'` from `MISSING_COMPLETION_REPORT`; unmarked COMPLETE features still flagged
- [x] Marker survives the status flip
- [x] Tests: exemption + persistence + malformed-slug rejection
