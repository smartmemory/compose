# Blueprint review round 2 — 2026-09-05 (Codex gpt-6-astra/high, on the round-1 fixes)

13 findings (7 P1, 5 P2, 1 P3). Controller adjudication: **all confirmed**. (D) = design-level.

| # | Finding (short) | Sev | Resolution |
|---|---|---|---|
| 1 | Merge validates the terminal pair against `transitionsOf(mode)`, which lacks `complete_backfilled` | P1 | Validate the final terminal edge against the augmented `buildPhaseGraph(mode)`; caller occurrences against the forward graph |
| 2 | Recovery goes through `guardedTransition`, which calls `ensureGuard` first; a second descriptor makes registration refuse before replay | P1 | Recovery replays via the raw transition transport (`stratum-client.js guardTransition`) with the persisted envelope, no `ensureGuard`; test after cache clear/restart |
| 3 | Recovery DTO lacks the validated write plan (`probe.history`, written/skipped, `guardInitial`, `upgrade`, `files_changed`) | P1 | Persist the complete validated write plan + full request in the intent before the transition; recovery restores every write input from it; history divergence handled explicitly |
| 4 | Persisted `guarded` flag loaded but §5.8 branches on live config | P1 | One effective guard flag from the intent during recovery, incl. projection; test both config flips |
| 5 | `originals` aliases the merge candidates; comparison compares rewritten closures to themselves; `from:null` marker destroyed | P1 | Immutable snapshot by temp id, independent clones, marker detection on the snapshot before rewriting `from`; closed-interval mismatch test |
| 6 | Every `g.applied` incl. `replayed` accepted; replay returns historical verdict + current state without checking later transitions | P1 | Distinguish fresh apply from replay; every recovery success requires the applied ledger entry under the key, current state `complete_backfilled`, no later transition entry |
| 7 | Persisted checksum P is not atomic with the transition, which hashes checksum Q under stratum's lock | P1 | **(D)** Stratum `guard transition` gains optional `expected_policy_checksum`; refused atomically under the resource lock if the registry checksum differs (`STRAT-GUARD-EXPECTED-CHECKSUM`, 0.4.4). Compose sends the persisted checksum on every fresh backfill transition |
| 8 | Bootstrap registers before evidence/history validation; registration is a durable write | P2 | Compute proposed initial without registering → validate evidence + history → register → upgrade → persist intent → transition |
| 9 | fix/plan finalize with `item.status` unchanged (`updateLifecycle` does not touch it) | P2 | Durable `item.status = 'complete'` write for `tracksFeatureJson:false` modes, with rollback + failure collection; assert in Flow B |
| 10 | Smoke command `--help` exits 2 on a healthy CLI | P2 | Capture status/stdout/stderr; run `guard` with no action expecting exit 1 and the usage text |
| 11 | Package-local `node_modules` may be partially hoisted | P2 | For every declared dependency, resolve `<dep>/package.json` from the real package context; if all live under one `node_modules` symlink it, else build a temp `node_modules` of per-dependency symlinks; smoke run |
| 12 | Heartbeat test sleeps 2 s but reclaim needs 20 s staleness | P2 | Assert heartbeat progress during the running child, or contend with a second locker past the stale threshold |
| 13 | Two prose citations still stale (`guard.ts:90`→`:107`, `lifecycle-modes.js:137`→`:133`) | P3 | Fix in prose, not only tables |
