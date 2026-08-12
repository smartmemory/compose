---
date: 2026-08-12
session_number: 109
slug: foh-6-colleague-panel-livefire
summary: "FOH-6 Maya colleague panel: 3-round review arc, live-fire E2E passed, and the append-only trail that wasn't — /memory/list serves ingest-time metadata forever (tracked locally)"
feature_code: COMP-FOH
closing_line: The panel worked on the first live turn; the bug we found was in the ground it stands on.
---

# Session 109 — COMP-FOH

**Date:** 2026-08-12
**Feature:** `COMP-FOH`

## What happened

FOH-6 gave the cockpit a colleague: Maya, summonable as a slide-over panel, briefed per-turn on the focused idea's contradictions, conviction and challenge findings, her reply written back into the idea's discussion trail. The implementation shipped last session (S1–S4, three Codex review rounds to CLEAN); this session was the stack-gated close-out — the live-fire against the real services.

The review arc that shaped the code is worth retelling. Round 1's sharpest finding: our workspace-isolation check decoded the colleague JWT and compared its workspace claim to the fluid workspace — and real SmartMemory tokens carry NO workspace claims, so the check was vacuous, passing everything. The fix verifies fail-closed via `GET /auth/me` → `default_team_id`, the service's own answer. Round 2 sharpened it again: we persisted a migrated identity before validating it, which pinned a colliding claim into the store — verify → validate → only then persist. Order is the contract.

The live-fire itself: throwaway fluid tenant, all seven `fluid_*` record types declared (FOH-4's recipe needed two updates — `/memory/ontology/types` now requires `X-Workspace-Id`, and the ideabox migration imports clusters, so three types aren't enough), IDEA-53 ("Postgres") set contradicting IDEA-54 ("Redis", decayed 1.0→0.5), our own server instance on scratch ports. The loop passed: status funnel `ready`, her reply named IDEA-53 and the Postgres conflict — the injected findings, reflected — and the write-back landed durably as `author:'maya'` with the message-id marker. Her colleague workspace held only her own turn-ingestion, zero fluid items: isolation verified end-to-end, closing VERIFY-3.

Then the retry test lied to us, and chasing the lie found the session's real discovery. The idempotent write-back retry returned `ok` — but not `deduped`, and the entry's timestamp was NEW. The reconcile scan reads through `/memory/list`, and list was serving the record as it was at CREATION, ignoring the update entirely — not lagging, never converging. A decisive probe confirmed the consequence: a second `addDiscussion` rebuilt the record from the creation-time base and silently dropped Maya's entry. On this backend, the append-only discussion trail keeps exactly one entry — the last write. Every provider read-modify-write shares the exposure. FOH-6's code behaves per its contract; the substrate violates the contract's read-your-writes assumption. Tracked locally in the FOH-6 ledger — owner directive: no GitHub issue filing; upstream is fixing it and tests it separately. Teardown left the tree byte-for-byte clean (shasum-verified), both tenants deleted, the colleague identity through the shipped reprovision action — which thereby live-fired too.

## What we built

No production code this session — the live-fire exercised what shipped at `e1500c0`:
- `lib/maya-{config,identity,client}.js`, `server/maya-routes.js` — status funnel, relay turn, identity actions, writeback-retry, all hit live
- `lib/colleague/{context,writeback}.js` — findings composition (idea + conviction + contradiction + challenge blocks) and reconcile-then-append write-back, both live
- `docs/features/COMP-FOH/foh-6-progress.md` — live-fire section: setup, PASSED items, the upstream P1 with repro and attribution
- Local upstream-defect record (FOH-6 ledger): `/memory/list` serves ingest-time metadata indefinitely after `updateItem` — repro preserved for the upstream fix's verification
- Scratch harness (session scratchpad): provision/seed/verify scripts, throwaway tenants `team_fce68e35699b` (fluid) and `team_994740c42d42` (colleague), both torn down

## What we learned

1. **A vacuous check is worse than no check** — the JWT-claim isolation test passed every token because real tokens carry no claims. If a guard's failure mode is "never fires," you must prove it CAN fire against real data before trusting it. The live-fire is where that proof lives.
2. **Verify → validate → persist; order is the contract.** Persisting a candidate identity before validating it pinned a colliding claim. The same shape as TOCTOU: the store must never hold a state you haven't already refused.
3. **Read-your-writes is an assumption, not a given.** The provider's read-modify-write (list-resolve → mutate → write blob) is only append-only if reads see writes. Against a backend where list serves ingest-time metadata forever, "append-only by API" degrades to "last-write-only" — silently, with every intermediate entry lost.
4. **The masked failure is the dangerous one.** The retry overwrote the original entry with identical content — entry count 1, text identical, outcome `ok`. Only the timestamp betrayed it. Assertions on counts and content would have passed; the `at` field was the tell.
5. **Provisioning recipes rot.** FOH-4's recipe (three types, no workspace header) failed twice in small ways this session. Live-fire notes are versioned observations of a moving service, not durable contracts.
6. **List-for-discovery, GET-for-truth** is the compose-side hardening shape if we take it: resolve candidates via list, re-GET by item_id before any mutation. One round-trip per write buys back the contract.

## Open threads

- [x] Owner decision (same day): WAIT for the upstream fix — no compose-side hardening; discussion trail is last-write-only on the real backend until it lands
- [ ] S5 streaming (design §S5: POST fetch-streaming on `/api/maya/message?stream=1`) — named stretch, not started
- [ ] FOH epic next candidates: exhaust-loop / portfolio rollup (design.md §Sequencing) — owner picks
- [ ] Upstream: smart-memory/maya#2 (channel_context field), smart-memory-service#6 (test re-auth), list-staleness fix (in progress upstream, tracked in the FOH-6 ledger) — watch for fixes
- [ ] COMP-FOH epic stays IN_PROGRESS

---

*The panel worked on the first live turn; the bug we found was in the ground it stands on.*
