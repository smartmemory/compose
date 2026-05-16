# Implementation Report — COMP-TRACKER-PROVIDER

**Status:** COMPLETE  
**Completed:** 2026-05-17  
**Branch:** `worktree-comp-tracker-provider`

Related: [design.md](design.md) · [plan.md](plan.md)

---

## Summary

COMP-TRACKER-PROVIDER introduces a pluggable TrackerProvider abstraction for Compose. All feature/completion/changelog/event persistence is now routed through a provider interface rather than directly to the filesystem. The default `local` provider wraps the existing file I/O layer and produces byte-identical output — zero behavior change for all existing users. The `github` provider syncs features to GitHub Issues, status/events to issue comments, Projects v2 custom fields, and roadmap/changelog to repository Contents API. A 100-test suite covering both providers, sync engine, golden flows, GitHub integration, and byte-identicality regression is now wired into `npm test`.

---

## Delivered vs Planned

All 21 tasks delivered.

| Task | Description | Status |
|------|-------------|--------|
| T1 | Capability constants + typed errors (`lib/tracker/provider.js`) | DONE |
| T2 | Conformance suite | DONE |
| T3 | LocalFileProvider features CRUD | DONE |
| T4 | LocalFileProvider status/completion/changelog/events/render | DONE |
| T5 | Regression golden flow | DONE |
| T6 | `providerFor` factory + fallback proxy | DONE |
| T7 | Rewire `feature-writer.js` through provider | DONE |
| T8 | Rewire `completion-writer.js` + `changelog-writer.js` | DONE |
| T9 | Rewire `build.js` (create/put/setStatus) | DONE |
| T10 | Durable op-log | DONE |
| T11 | Read cache + pending-op shadowing + CAS | DONE |
| T12 | Reconciler + conflict ledger | DONE |
| T13 | GitHub API client + fixture | DONE |
| T14 | GitHubProvider features via cache+op-log | DONE |
| T15 | GitHubProvider status/completion/events + Projects v2 | DONE |
| T16 | GitHub roadmap/changelog via Contents API | DONE |
| T17 | `init` scope validation + `health` mixedSources | DONE |
| T18 | `compose tracker` CLI (`status`/`sync`) | DONE |
| T19 | GitHub golden flow + offline | DONE |
| T20 | Codex adversarial review loop on implementation | DONE |
| T21 | Docs + ship (this task) | DONE |

---

## Architecture and Key Decisions

### Provider interface

`lib/tracker/provider.js` defines capability constants (`FEATURES`, `CHANGELOG`, `ROADMAP`, `EVENTS`, `STATUS_COMMENTS`, `PROJECTS_V2`) and typed errors (`ProviderError`, `CapabilityError`, `ConflictError`, `AuthError`, `NetworkError`). Both providers declare their capability sets; callers guard with `provider.supports(CAP)` before calling optional operations.

### LocalFileProvider

Thin wrapper over the existing file I/O layer: `persistFeatureRaw`, `feature-events.js`, `changelog-writer.js`. Exposes low-level primitives (getChangelog/putChangelog, getFeatureRaw/persistFeatureRaw) used by the rewired writers, plus composite methods (appendEvent, setStatus, etc.) for the provider seam. Regression golden tests (`tests/tracker/regression-golden.test.js`) assert byte-identical JSON key ordering on the event log to prevent drift.

### GitHubProvider

Three GitHub surfaces per feature:
1. **Issues API** — one issue per feature (title, body with YAML frontmatter, labels). `listFeatures`/`createFeature`/`updateFeature`/`getFeature` map to Issues REST.
2. **Projects v2 GraphQL** — `Status` custom field set on each issue via `updateProjectV2ItemFieldValue`. Field ID and option IDs resolved via GraphQL at first use and memoized per provider instance. Missing options produce a warn+skip (no auto-create in v1).
3. **Contents API** — `roadmap.md` and `changelog.md` read/written as base64 blobs; SHA fetched fresh at write time for CAS semantics.

### Sync engine

`lib/tracker/sync-engine.js` reconciles the local op-log against the remote provider on demand (triggered by `compose tracker sync` and flushed in-band after mutations). Conflicts land in `lib/tracker/conflict-ledger.js` and are surfaced via `compose tracker status`. CAS-quarantined ops let subsequent same-code ops proceed — v1-acceptable given `spliceChangelog` idempotency.

### Factory and config

`lib/tracker/factory.js` exports `providerFor(cwd)`. Reads `.compose/compose.json` `tracker` block; defaults to `local`. Fails fast with a descriptive error if `provider:'github'` is configured but required fields (`repo`, `projectNumber`, `auth.tokenEnv`) are missing or the env var is unset.

---

## Controller plan-defect corrections made during execution

**T4 — conformance suite shape correction.** The initial conformance suite encoded fictional completion/event field shapes. Corrected to match the real writer contract: `commit_sha` (not `commitSha`); event `type` field (normalized from `tool` by the event writer). A spec bug, not an implementation bug — caught before any implementation ran.

**T7/T8 — factory cycle resolved with lazy dynamic import.** Writers couldn't statically import `factory.js` because `factory.js` imports `local-provider.js` which imports the writers, forming a load-time cycle. Resolution: `getProvider(cwd)` inside each writer uses `await import('./tracker/factory.js')` — dynamic import resolves at call time after all modules have loaded. Preserves byte-identical local path without restructuring module boundaries.

**T9 — `build.js` uses `persistFeatureRaw` for internal status flips.** `build.js` lifecycle status transitions use the raw `persistFeatureRaw` primitive under ALL providers. This is correct: these are internal orchestration writes, not user-facing canonical transitions. The design.md Mutation Inventory was reconciled to this reality in T20 FIX C.

**T15 — Projects v2 was a non-functional placeholder.** Reimplemented with memoized field/option resolution via GraphQL and errors-checked non-fatal handling.

**T20 — adversarial gate caught a critical integration break.** After T19 passed the golden test, Codex review found that under `provider:'github'`, changelog threw and events/Projects-v2/status-comments never fired. Root cause: the production seam (`feature-writer.js`, `build.js`) called `provider.appendEvent`, `provider.getChangelog`, `provider.putChangelog` — but GitHubProvider had `appendEvent` as an unimplemented stub and no `getChangelog`/`putChangelog`. The composite methods (`setStatus` etc.) were defined but never called from production. The golden test missed this because it called the provider directly, bypassing the production entry points.

Three fixes:
- **FIX A:** `feature-writer.js` event emission rerouted through `provider.appendEvent`. LocalFileProvider delegates to `feature-events.js` (byte-identical). GitHubProvider posts a compose-event comment on the issue AND mirrors to Projects v2.
- **FIX B:** GitHubProvider `getChangelog`/`putChangelog` implemented via Contents API, making the changelog path work end-to-end under `github`.
- **FIX C:** Event-log key-order byte-identicality tightened; regression assertion added to `regression-golden.test.js` for the exact gap that let the break slip through.

Three Codex review iterations to reach REVIEW CLEAN.

---

## Test Coverage

**Tracker suite (100 tests, 11 files):**
- `conformance.selftest.test.js` — conformance harness self-checks
- `provider.test.js` — capability constants and typed errors
- `factory.test.js` — providerFor fail-fast and fallback
- `local-provider.test.js` — LocalFileProvider full surface
- `github-provider.test.js` — GitHubProvider against mock API
- `github-api.test.js` — GitHub API client fixtures
- `github-integration.test.js` — drives production entry points (`addRoadmapEntry`, `setFeatureStatus`, etc.) through GitHubProvider; this is what catches production seam wiring bugs
- `github-golden.test.js` — offline golden flow for GitHub
- `sync-engine.test.js` — op-log reconciliation and conflict ledger
- `cli.test.js` — `compose tracker status` / `compose tracker sync` verbs
- `regression-golden.test.js` — byte-identical event-log key ordering under LocalFileProvider

**Full suite (unregressed):** 2815 node:test + 122 vitest(UI) + 100 vitest(tracker). All green. Tracker suite now included in `npm test` via `test:tracker` script.

---

## Open Questions Resolution

From `design.md`:

1. **Reconciler cadence** — on-demand only for v1: triggered by `compose tracker sync` and flushed in-band after mutations. No background polling.
2. **Projects v2 field bootstrapping** — field ID and option IDs resolved via GraphQL at first use, memoized. Missing option → warn+skip (no auto-create in v1).
3. **Multi-repo** — out of scope for v1. One repo per project, configured in `.compose/compose.json` `tracker.github.repo`.

---

## Known Limitations / Tech Debt

- **GitHub changelog atomicity:** `putChangelog` re-fetches blob SHA at write time rather than holding it from `getChangelog`. Slightly weaker than local synchronous read-splice-write, but bounded by `spliceChangelog` idempotency.
- **Orphaned composite methods:** `setStatus`, `recordCompletion`, `addRoadmapEntry`, `readEvents` exist on GitHubProvider but production delivers their behavior via the low-level seam. Retained for potential future use; recommend cleaning up or promoting in v2.
- **CAS quarantine is non-blocking:** a conflict on one op lets subsequent same-code ops proceed. Conflicts surfaced in ledger via `compose tracker status`. Acceptable for v1.
- **Projects v2 missing options silently skip:** if the `Status` field lacks an option matching the feature status string, the operation warns and skips rather than failing.

---

## Files Changed

**New — `lib/tracker/`:**
- `provider.js`, `local-provider.js`, `github-provider.js`, `github-api.js`, `factory.js`, `sync-engine.js`, `cli.js`
- `op-log.js`, `cache.js`, `cas.js`, `conflict-ledger.js` (durable persistence layer)

**New — `tests/tracker/`:** 11 test files + `fixtures/` (GitHub API mock responses)

**Modified — existing writers rewired through provider seam:**
- `lib/feature-writer.js` — lazy `providerFor` import, `provider.appendEvent`, unused `appendEvent` import removed
- `lib/completion-writer.js` — provider-aware completion writes
- `lib/changelog-writer.js` — `provider.getChangelog` / `provider.putChangelog`
- `lib/build.js` — `provider.persistFeatureRaw` for create/put; internal orchestration status flips

**Modified — CLI and config:**
- `bin/compose.js` — `tracker` verb routing
- `package.json` — `test:tracker` script chained into `test`

**New — docs:**
- `docs/features/COMP-TRACKER-PROVIDER/report.md` (this file)
- `docs/journal/2026-05-17-session-43-comp-tracker-provider.md`

---

## Tracking Note

`mcp__compose__set_feature_status` returned "feature not found" — COMP-TRACKER-PROVIDER has no `feature.json` in the worktree (tracked in `specs/`, not registered as a Compose vision item). ROADMAP.md has no pre-existing COMP-TRACKER-PROVIDER row. MCP journal entry written as session 43. CHANGELOG updated via MCP.
