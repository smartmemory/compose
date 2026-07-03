---
date: 2026-07-03
session_number: 84
slug: smartmemory-coupling-opt-in
summary: "Unparked and shipped the opt-in SmartMemory coupling: fail-open ingest hooks + idempotent sync CLI + cockpit Recall tab, all default OFF"
feature_code: COMP-SMARTMEMORY-INGEST
closing_line: "The flag is the feature: everything works, and none of it exists until you ask for it."
---

# Session 84 — COMP-SMARTMEMORY-INGEST

**Date:** 2026-07-03
**Feature:** `COMP-SMARTMEMORY-INGEST`

## What happened

The human unparked the SmartMemory coupling (deferred since 2026-06-10) with one constraint: build it behind an optional flag, default OFF. Three parallel explorers mapped compose's write surfaces, SmartMemory's HTTP API, and the cockpit panel architecture — and immediately corrected the roadmap row's assumptions: 'decision events' aren't a persisted surface (they're SSE re-derived from gate-log + lifecycle), origin rides in context.origin not a top-level field, workspace_id is auth-derived, and there is no tier field. Mid-design the human asked whether we target SmartMemory Lite or the service API; verification showed the service cannot boot on Lite storage today (SQLiteBackend hard-rejects scope providers), so v1 is HTTP-API-only against a FalkorDB-backed deployment — compose codes against the wire contract, so a future single-tenant Lite service works unchanged. Designs took 8 Codex rounds (20 findings), blueprints 3 rounds (7 findings), and the implementation review loop 5 rounds (7 more findings, every fix TDD with a verified red step). A coverage sweep then closed 4 real gaps, the load-bearing one proving live-emit and sync render byte-identical POST bodies for the same event — the dedupe invariant the whole idempotency story rests on.

## What we built

COMP-SMARTMEMORY-INGEST: lib/smartmemory-config.js (strict-truthy flag reader, resolveProjectTag via deriveId), lib/smartmemory-client.js (raw-fetch client; malformed-2xx throws), lib/smartmemory-ingest.js (deterministic renderers, fail-open emitter, process-global circuit breaker), lib/smartmemory-sync.js (4-surface idempotent walker: feature-events, gate-log, journal newest-first with canonical filename gating, artifacts incl. audit.json; per-surface fault isolation), hooks in lib/feature-events.js + server/gate-log-store.js, compose smartmemory sync verb in bin/compose.js. COMP-SMARTMEMORY-RECALL: server/smartmemory-routes.js (degrade-never-fail GET /api/smartmemory/recall), cockpit Recall tab (DetailTabs tabs prop, useRecallEnabled workspace-keyed probe, RecallTab fetch-on-open keyed on featureCode+workspaceId). 106 new tests across 8 files (76 node:test smartmemory + 17 UI + 13 route). Full suite green: 4620 node + 581 UI + 100 tracker.

## What we learned

1. Origin-gated dedupe is a two-regime contract: cli:compose events rely on content-hash (immutable lines), import:compose files get source-path replace-in-place — stamping one blanket origin would silently break re-sync. 2. A helper built for display (getJournalEntries: 500-cap, silently drops malformed files) is the wrong substrate for a backfill walker — walk the directory with the canonical filename regex and account for every skip. 3. Nullish coalescing is not OR: row.code ?? row.feature_code wrongly excluded rows carrying both fields; the review loop caught what the golden fixture missed because the fixture never combined both fields on one row. 4. Malformed-2xx coercion (raw = {}) turns proxy error pages into fake successes that poison both failed-accounting and the recall availability signal — parse-or-throw at the client boundary. 5. The design gate needed the user's Lite-vs-API question answered with code evidence, not repo READMEs: the README says the service serves both backends; the tenancy layer says otherwise.

## Open threads

- [ ] Provider-routed mutation events (tracker.provider=github) never reach the local sink — a provider-layer hook is the documented follow-up if github-tracker workspaces ever need live ingest
- [ ] /memory/feedback reinforcement + channel_weights tuning are RECALL v2 candidates
- [ ] COMP-ORIGIN-TIER stays deferred (user unparked only INGEST/RECALL; SmartMemory has no tier field server-side anyway)
- [ ] If SmartMemory ships a single-tenant Lite service mode, compose works unchanged — worth a smoke test when that lands

---

*The flag is the feature: everything works, and none of it exists until you ask for it.*
