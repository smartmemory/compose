# COMP-PROVIDER-FALLBACK-1 — Review round 5 (Codex gpt-6-astra/medium, fresh read-only session, final narrow confirm, 2026-09-30)

The round-4 finding is resolved by the accepted scope cut. No P1/P2 findings within the requested scope.

- D7 explicitly sends interrupted auxiliary-parented substitutions in **both Path A and Path B** to `recovery-required`, with no replay, re-put or dispatch. D11 preserves that block across resume. S1, the deferred auxiliary-identity follow-up, and the specific resume acceptance items agree.
- Primary-parented substitutions retain lookup, replay and uncertain refusal.
- All primary stability citations check out: [model-router.js:106–110](/Users/ruze/reg/my/forge/compose/lib/model-router.js:106) hashes the stated issuance tuple; [routing-ledger.js:77](/Users/ruze/reg/my/forge/compose/lib/routing-ledger.js:77) enforces that identity; [routing-runtime.js:123](/Users/ruze/reg/my/forge/compose/lib/routing-runtime.js:123) excludes primary bindings from slot allocation, and [line 145](/Users/ruze/reg/my/forge/compose/lib/routing-runtime.js:145) binds directly to the issuance ID.

D7/D11 are internally consistent under the explicit scope restriction. This confirms the design only.

REVIEW CLEAN
