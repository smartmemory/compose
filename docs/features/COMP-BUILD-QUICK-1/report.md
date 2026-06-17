# COMP-BUILD-QUICK-1 — Implementation Report

**Status:** COMPLETE (2026-06-17)
**Parent:** COMP-BUILD-QUICK

## Summary

Closes the contract gap COMP-BUILD-QUICK surfaced: the `--quick` lifecycle omits the report phase by design, so every quick-built COMPLETE feature would trip `MISSING_COMPLETION_REPORT`. Now the quick path stamps a marker on feature.json at ship and the validator exempts marked features.

## What changed

- **`lib/completion-writer.js`** — `recordCompletion` accepts an optional `built_via` (validated as a lowercase template slug), and persists it onto feature.json at step 5h, before the status flip. The flip (`setFeatureStatus`, 5i) re-reads the fresh feature, so the marker survives.
- **`lib/build.js`** — the build `context` now carries `templateName`; `executeShipStep` computes `builtVia = context.templateName === 'build-quick' ? 'build-quick' : null` and passes it to both `recordCompletion` call sites (git + no-git).
- **`lib/feature-validator.js`** — `MISSING_COMPLETION_REPORT` skips features whose feature.json has `built_via === 'build-quick'`.

## Tests

`test/build-quick-completion-exempt.test.js` (3): validator exempts a marked feature while still flagging an unmarked one; `recordCompletion` persists `built_via` (and omits it without); malformed `built_via` is rejected. Full node suite green (3924).

## Decisions

- **Marker on feature.json, not a folder heuristic.** The validator already reads feature.json; an explicit `built_via` is reliable, where "blueprint.md absent" would be ambiguous (full builds can skip phases too).
- **Only the report check is exempted.** A journal entry is owed for every session regardless of build path, so `MISSING_COMPLETION_JOURNAL` is intentionally NOT exempted.
- **Stamped at ship, not at start.** Ship is the completion moment and already owns the feature.json write via `recordCompletion`; no extra write or lock.

## Notes

Codex review: REVIEW CLEAN (1 round — confirmed the marker survives the 5h→5i status-flip sequence in both git and no-git paths).
