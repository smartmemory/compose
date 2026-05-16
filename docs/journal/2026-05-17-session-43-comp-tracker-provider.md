---
date: 2026-05-17
session_number: 43
slug: comp-tracker-provider
summary: "COMP-TRACKER-PROVIDER: pluggable TrackerProvider ships — LocalFile (byte-identical default) + GitHubProvider (Issues, Projects v2, Contents API); T20 adversarial gate caught a critical integration break that the golden test missed."
feature_code: COMP-TRACKER-PROVIDER
closing_line: The adversarial gate caught what the golden test missed — production seam wiring bugs only surface when you drive through the real entry points.
---

# Session 43 — COMP-TRACKER-PROVIDER

**Date:** 2026-05-17
**Feature:** `COMP-TRACKER-PROVIDER`

## What happened

Full COMP-TRACKER-PROVIDER feature (T1–T21) implemented and shipped across a single worktree branch. 21 tasks executed sequentially; tracker test suite added to CI gate. Compose MCP was reachable throughout.

## What we built

A pluggable TrackerProvider abstraction that decouples feature/completion/changelog/event persistence from the filesystem:

- `lib/tracker/provider.js` — capability constants, typed errors, provider interface
- `lib/tracker/local-provider.js` — LocalFileProvider: wraps existing feature-events, changelog-writer, and file I/O; byte-identical output confirmed by regression golden tests
- `lib/tracker/github-provider.js` — GitHubProvider: Issues API (feature CRUD + status comments), Projects v2 GraphQL (memoized field/option resolution), Contents API (roadmap.md + changelog.md)
- `lib/tracker/op-log.js`, `cache.js`, `cas.js` — durable op-log, read cache with pending-op shadowing, CAS for conflict detection
- `lib/tracker/sync-engine.js`, `conflict-ledger.js` — reconciler (on-demand for v1) and conflict ledger
- `lib/tracker/factory.js` — providerFor() with fail-fast config validation
- `bin/compose.js` tracker verb — `compose tracker status` and `compose tracker sync`
- 11-file conformance suite in `tests/tracker/` covering both providers, sync engine, golden flows, GitHub integration, and regression byte-identicality
- CI wiring: `test:tracker` script + chained into `npm test`

## What we learned

**T4 conformance correction:** the initial conformance suite encoded fictional field shapes (completion/event); corrected to match the real writer contract (commit_sha field; event type vs tool normalization).

**T7/T8 factory cycle:** writers couldn't import factory.js directly (factory → local-provider → feature-writer → factory cycle). Fixed with lazy dynamic import inside each writer function — this is the right pattern for provider-aware writers in a CommonJS-style ESM codebase.

**T9 build.js raw persistence:** `build.js` lifecycle status flips use `persistFeatureRaw` under ALL providers (internal orchestration, not user-facing canonical transitions). This was reconciled in T20 FIX C by updating design.md's Mutation Inventory.

**T15 Projects v2:** the original implementation was a non-functional GraphQL placeholder. Reimplemented for real with memoized field/option resolution and errors-checked non-fatal handling.

**T20 adversarial gate — the critical integration break:** The production seam was wired to low-level primitives so under `provider:'github'`, changelog threw and events/Projects-v2/status-comments never fired. The orphaned composite methods (appendEvent, setStatus, etc.) were defined but never called from the production path. The golden test missed this because it called the provider directly. Three Codex review iterations to converge: FIX A rerouted event emission through `provider.appendEvent`; FIX B implemented GitHubProvider low-level getChangelog/putChangelog; FIX C fixed event-log key-order byte-identicality and added a regression assertion for the specific gap that let the break slip through.

**Lesson:** golden tests that call the provider directly rather than through the production entry point (feature-writer.js, build.js) don't catch wiring bugs. The github-integration tests that drive `addRoadmapEntry` and `setFeatureStatus` end-to-end are what ultimately verified the seam.

## Open threads

- CAS-quarantined ops let later same-code ops proceed (conflict-ledger-surfaced, v1-acceptable; revisit if conflict rates are high in practice)
- GitHub changelog get/put re-fetches sha at write time (slightly weaker atomicity than local synchronous read-splice-write)
- Orphaned provider composite methods (setStatus/recordCompletion/addRoadmapEntry/readEvents on GitHubProvider) retained but production delivers their behavior via the low-level seam — clean these up or promote them in v2
- Multi-repo support is out of scope for v1 (one repo per project)
- Projects v2 missing-option → warn+skip (no auto-create in v1)

---

*The adversarial gate caught what the golden test missed — production seam wiring bugs only surface when you drive through the real entry points.*
