---
date: 2026-07-22
session_number: 93
slug: judgment-writer-ships
summary: "COMP-JUDGMENT-WRITER ships W1–W3: typed writer + provider seam, judgment canon cut over from hand-written markdown to tool-owned records; 4-round Codex loop 11→7→4→REVIEW CLEAN"
feature_code: COMP-JUDGMENT-WRITER
closing_line: The notebook everyone could scribble in is now a filing cabinet with six doors, and the scribbles that built it are filed inside.
---

# Session 93 — COMP-JUDGMENT-WRITER

**Date:** 2026-07-22
**Feature:** `COMP-JUDGMENT-WRITER`

## What happened

The judgment layer got its locked front door. Picking up from a plan parked at the boundary (design rev 5, blueprint with a binding corrections table, T1–T7 plan — all gate-clean from the prior session), we executed the whole build in one sitting: contract schema, tracked-floor records store behind a provider registry, the pure-leaf write guard encoding the edge→artifact table, OKF projections with a fixed-point roundtrip guard, the six-operation writer, the MCP surface, and the one-time importer. TDD throughout — every slice's test written first and watched fail.

Two discoveries shaped the build. First, the blueprint said to call the untouched `guardedTransition` adapter, but the adapter resolves its graph from the lifecycle-mode registry — so the joint state machine became a `judgment` mode entry, exactly the data-only extension the registry advertises. Second, the adversarial loop earned its keep: four Codex sol/xhigh rounds returned 11 → 7 → 4 → 0 findings. The best catches were architectural: the provider selector existed but production paths bypassed it; the intent-first crash-window recovery could strand or discard a payload the guard had already advanced; the advisory lock was stealable mid-guard-call; the EXT result package wasn't actually required, quietly voiding the pre-Answerer sequencing guarantee; and re-dispose could smuggle a method swap that erased a judgment-dispatch stamp. All fixed, each with a regression test.

The cutover was human-gated: the staged generated-vs-hand-written diff was presented, the owner approved, and the import ran — 3 positions, 18 joints, 100 ledger events, every record stamped `via: import` with original dates and grounding preserved (ASSERT tags carry citation-elicitations pointing at the imported source). The hand-written canon was frozen as test fixtures moments before it became a projection.

## What we built

- `contracts/judgment-record.schema.json` — position revisions (append-only chains, derived status), joints (edge-bound artifacts, ruled cost buckets and outcome vocabulary), predictions, kind-typed ledger events, pending intents
- `lib/judgment/schema.js`, `lib/judgment/store/records.js`, `lib/judgment/store/index.js` — memoized validator; atomic tracked-floor store; one-canon provider selector (smartmemory throws NOT_IMPLEMENTED at selection)
- `lib/judgment-write-guard.js` — schema + grounding/elicitation + edge→artifact table + method gates (EXT sharpened-or-dispatch, STRADDLE signal+kill, SILENT⇒inconclusive, EXT result package with evidence-address sources)
- `lib/judgment-gen.js` — REGISTER/LEDGER/OBJECTIVE/positions/index.md as pure output; OKF v0.1 frontmatter; fixed-point + orphan detection
- `lib/judgment-writer.js` — six ops; heartbeated owner-token advisory lock; intent-first transitions with a roll-forward reconciler and durable divergence drops; ONE-UNDER-TEST incl. pending-intent occupancy; rank changes atomic with their ledger event; prediction spawn/grade
- `lib/lifecycle-modes.js` — `judgment` mode (data-only) so the untouched guard adapter enforces the joint graph; surplus edges pinned by a parity test
- `server/compose-mcp.js`, `server/compose-mcp-tools.js`, `server/mcp-tool-policy.js` — six tools at all four registration sites; reviewer may read state, never write canon
- `bin/judgment-import.js` — staged, preflighted, crash-safe (copy + atomic rename) one-time importer; kept for provider migrations
- `lib/idempotency.js` — shared lock hardened with the same heartbeat + owner-token recipe
- 8 test files, 100+ tests incl. golden flow P1→P7, kill-between-steps replay, fake-guard integration, MCP e2e, import round-trip on frozen fixtures

## What we learned

1. **An untouchable adapter is a constraint you satisfy with data, not a wall.** The mode registry's 'new mode is a data-only add' contract turned 'the guard can't know the judgment graph' into a 30-line entry. Read the extension seams before concluding a design is blocked.
2. **Adversarial review convergence is a real signal.** 11→7→4→0 with each round strictly narrower meant the spec was sound and the loop was working; the rounds found genuinely different strata (wiring, crash windows, then ordering). The round-1 'provider selector never used' catch is the archetype of what tests miss: everything worked, through the wrong door.
3. **Crash-window semantics need a decision, not a pattern.** 'Intent-first + reconciler' sounds mechanical until you must choose: is a kept intent a promise (roll forward) or a request (drop on doubt)? We ruled roll-forward with guard-state authority for the edge, payload authority for the intent, and durable notes for every drop — and each Codex round found a corner where we hadn't applied our own ruling.
4. **Advisory locks that span subprocess calls need heartbeats.** The 5s-stale mkdir recipe is correct only while critical sections are fast; a 10s guard call made live locks stealable. Heartbeat + owner token + a documented sync-block bound is the portable fix.
5. **Import is transcription, and transcription is a fidelity contract.** The first importer draft 'improved' groundings (ASSERT→AGENT where unelicited) and got caught — the binding rule is preserve-verbatim and record the caveat in the citation, not editorialize history.

## Open threads

- [ ] W4 SmartMemory enrichment (own blueprint): `judgment.enrichment.smartmemory`, service-returned team_id, provider_ids → OKF resource URIs; file SmartMemory RFC items 1–3 when it starts
- [ ] EXT evidence writer ships with the Answerer slice; until then EXT resolutions are structurally impossible (enforced, not incidental)
- [ ] `capabilities.phaseScopedTools` stays OFF by owner call — reviewer denial is policy-table + tests until flipped
- [ ] Epic S4–S6 enforcement (hooks, attestation, guard-side closure of the auto-added killed/complete edges)
- [ ] smartmemory/stratum#25 — population-invariant guard predicates (ONE-UNDER-TEST class) filed upstream
- [ ] Dogfood track 2: feed one real build decision through P1–P3 by hand with the new tools — the product's first tool-written judgment

---

*The notebook everyone could scribble in is now a filing cabinet with six doors, and the scribbles that built it are filed inside.*
