---
date: 2026-06-07
session_number: 67
slug: e2e-ux-sweep-port-fix
summary: E2E UX sweep of the app; fixed the P0 port-default mismatch and filed cockpit-completeness gaps as COMP-COCKPIT + COMP-PARITY-8/9/10.
closing_line: The cockpit had a dozen missing rooms — but the front door was knocking on the wrong address the whole time.
---

# Session 67 — E2E UX sweep of the app; fixed the P0 port-default mismatch and filed cockpit-co

**Date:** 2026-06-07

## What happened

The human asked us to sweep the whole app for UX gaps that would stop a user from going end-to-end, then sharpened it: is the cockpit COMPLETE as a product — what features are missing or gaps to fill? We ran four parallel source-grounded sweeps (CLI journey, cockpit UI completeness, cross-surface continuity, first-run) instead of trusting the 3-week-old docs/ui-cli-parity.md. ~140 findings deduped. Three of the four sweeps independently flagged the same headline, which we then verified by hand: a port-default mismatch. The API server runs on 4001 (server/index.js, supervisor) but lib/resolve-port.js and several callers still defaulted to the pre-e139ec3 value 3001 (and `compose loops` to 3000). In a default install with no COMPOSE_PORT/PORT set, every CLI server-probe, MCP lifecycle call, agent-hook POST, and loops call hit a dead port — so gate delegation silently fell back to readline, completions/loops failed with ECONNREFUSED, and MCP lifecycle tools threw 'Compose server unreachable' while the cockpit was alive on 4001. The human chose: fix the P0 now, and file the UI-completeness gaps as roadmap. Before filing we ran a reconciliation pass against the live ROADMAP (the verify-vs-disk lesson) and found COMP-PARITY already covered several candidates (A1->PARITY-2, B1->PARITY-6, B3->PARITY-3) and COMP-OBS-COST-4 already shipped per-step cost — so we only filed genuinely-new gaps.

## What we built

Port fix (commit e7ae335): lib/resolve-port.js default 3001->4001; server/compose-mcp-tools.js (_getComposeApi, _httpRequest) and server/agent-hooks.js now route through resolvePort() instead of duplicating a stale literal; `compose loops` URL 3000->resolvePort() (bin/compose.js); stale comments fixed in supervisor.js + agent-server.js; stale port docs fixed in cockpit.md (UI is :5195), cli.md, e2e-checklist.md; corrected the vision-unification test that had asserted the buggy 3001 default; CHANGELOG entry. Relevant-surface suite green (242 tests). Roadmap filing (commit 6f4e3c6): new COMP-COCKPIT umbrella + 6 children (action feedback & native-dialog replacement, ChallengeModal hostname portability, run history, inline gate artifact, first-run empty-state CTAs, gate-kill guardrail consistency) and COMP-PARITY-8/9/10 (build-all/gsd launchers, UI feature scaffold, qa-scope panel). roadmap check: fixed point, lossless.

## What we learned

1. Convergence across independent sweeps is a strong signal but not proof — three agents flagged the port mismatch; verifying it by hand against server/index.js + resolve-port.js is what made it commit-worthy. 2. A test can encode the bug: vision-unification.test.js asserted resolvePort()===3001, locking in the wrong default; fixing the code means fixing the test to match reality, not weakening it. 3. Reconcile before filing. The ROADMAP already had a COMP-PARITY umbrella covering a third of the candidate gaps; naive filing would have created duplicate rows (the verify-roadmap-vs-disk lesson, 4th time). 4. Taxonomy honesty: capability-parity gaps extend COMP-PARITY; cockpit quality/correctness gaps got a sibling COMP-COCKPIT umbrella rather than being mis-filed as 'parity'. 5. add_roadmap_entry still blows the MCP token cap on its return — the mutation succeeds, so verify with grep + `roadmap check`, never retry.

## Open threads

- [ ] Neither commit is pushed — pre-push runs the full suite (proof-run hang risk) and the human only asked to fix, not push.
- [ ] Full `npm test` (UI vitest + tracker) not run; only the 242 relevant-surface tests. Run before pushing.
- [ ] COMP-COCKPIT-1..6 and COMP-PARITY-8/9/10 are PLANNED, unbuilt.
- [ ] docs/ui-cli-parity.md itself was not refreshed (the human picked fix+file, not the doc-rewrite option); it remains 3 weeks stale beyond the port refs we corrected.
- [ ] Cross-surface desync findings (UI status dropdown not writing feature.json + guard bypass) map to COMP-PARITY-5 reduced scope; not separately filed.
- [ ] D2 (raw failed-step agent log) folded into COMP-OBS-SURFACE-1/2; not separately filed.

---

*The cockpit had a dozen missing rooms — but the front door was knocking on the wrong address the whole time.*
