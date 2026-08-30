---
date: 2026-08-30
session_number: 111
slug: completion-gate-slice-3
summary: "COMP-COMPLETION-GATE slice 3: the gate owns every write, four back doors refused, self-verifying projection with three tiers; 3 Codex rounds"
feature_code: COMP-COMPLETION-GATE
closing_line: The front door only counts once you've locked the back ones — and then checked that the lock can't be picked from inside.
---

# Session 111 — COMP-COMPLETION-GATE

**Date:** 2026-08-30
**Feature:** `COMP-COMPLETION-GATE`

## What happened

We picked up COMP-COMPLETION-GATE where the last session left it: slices 1 and 2 had put a gate in front of the two paths that actually complete features, but the gate then handed the real writes to `setFeatureStatus` — itself one of the fourteen bypasses the audit had found. Slice 3 was the remaining half: make the gate own every write, refuse the four back doors (`setFeatureStatus`, the vision PATCH, stratum audit ingestion, direct `updateItemStatus`), and replace them with a projection that verifies instead of trusts.

The scope call we made before touching code turned out to matter most. The design keys the refusals on "build mode", but `modeOf(item)` defaults to build and the `compose new` kickoff item is a build-mode item with no feature.json — a mode-keyed refusal would have bricked `compose new`. We keyed the refusals on MANAGED items instead (bound to a code, build mode, feature.json exists). The full suite later proved the same key was needed on the cockpit route: three route suites completed unmanaged build items and 422'd until the route used it too.

The cockpit contract changed visibly and on purpose. `/lifecycle/complete` for a managed build item now goes through the gate: no commit SHA under the guard is a 422 (it used to mark the item complete and leave feature.json untouched — the exact drift the feature exists to end), an invalid SHA is a 422 with nothing written (it used to be 200 partial with the item shown complete and no record). `xref-push` to a local sibling with `expect: COMPLETE` now degrade-skips, which closed the local half of path 9 for free.

The slice-3 tests found a fail-open in slice-1 code: `currentGuardState` read any guard error whose MESSAGE contained "not found" as "legacy, unregistered" — so `stratum-mcp: command not found` would have waved a feature through as unguarded. The exact disguise §2.3b warns about, sitting in the module that warns about it.

Codex went three rounds. Round 1 found seven, five real and fixed: a present-but-malformed feature.json read as *unmanaged* (so the refusals didn't apply), `VisionStore._save` swallowing disk failures into a 200, vision-projection failures dropped from the writer-shaped result every caller returns, a status-less managed feature seeded as `document-derived` complete, and items complete before tiers existed never getting stamped. Round 2 reviewed the fixes and found the fix for #2 had opened a High: adding `completion_projection` to the store's update allowlist made the tier stamp writable through the generic PATCH — a legacy item could be relabelled `guarded` with a fake ledger ref. Round 3 found the downgrade path leaving a stale stamp. Each round's findings were on the previous round's fixes, which is what the round-2-targets-fixes rule predicts.

## What we built

- `lib/completion-gate.js` — step 6 is now the §2.3a write sequence: record → status via `persistFeatureRaw` → ROADMAP → vision → events; steps 1–2 abort and keep the intent, 3–5 collected as `{partial:true, failures[]}` and surfaced in `result` too. `currentGuardState` fail-open fixed; exported for the predicate.
- `lib/feature-writer.js` — `setFeatureStatus` refuses COMPLETE unconditionally (`COMPLETE_VIA_GATE_ONLY`); `roundtripGuard`/`safeAppendEvent` exported for the gate.
- `lib/completion-writer.js` — completing path delegates to the gate (`COMPLETION_REFUSED`); `set_status:false` is record-only; no in-writer flip.
- `server/completion-projection.js` (new) — `verifiedCompleteProjection`, `applyVerifiedProjection`, `isManagedBuildItem` (existence-based), `canonicalFile`, the three tiers.
- `lib/vision-writer.js` — `completeItem` (REST → endpoint, direct → predicate); `updateItemStatus('complete')` refuses managed build items in both transports.
- `server/vision-routes.js` — PATCH 422 for managed build items and for any body carrying `completion_projection`; `POST …/completion-projection`; `/lifecycle/complete` re-pointed at the gate for managed build items with an in-process projector; lifecycle-persist failure reported.
- `server/vision-store.js` — `lastSaveOk` recorded by `updateItem`/`updateLifecycle`; `completion_projection` allowed (server-owned).
- `server/feature-scan.js` — `seedCompletionTier`; complete items re-verified on every scan (stamp, downgrade, clear).
- `server/stratum-sync.js` — audit ingestion no longer flips status.
- `lib/feature-reconciler.js`, `lib/migrate-roadmap.js`, `lib/build.js`, `bin/compose.js`, `server/mcp-tool-defs.js`, `server/compose-mcp-tools.js` — seam routing, AC-17 logged exemption, build projector, CLI partial warning, tool descriptions.
- Tests: `test/completion-projection.test.js`, `test/vision-writer-complete-item.test.js`, `test/completion-seed-tiers.test.js`, `test/completion-write-allowlist.test.js` (AC-19, two-sided, includes `writeFeature(` and the PATCH pass-through), additions to the gate/migrate suites, five suites updated to the new contract.
- Docs: design §2.9b with all three Codex tables; `COMP-MCP-ENFORCE/report.md` §7 (AC-14); CHANGELOG; feature.json canon.

## What we learned

1. **Key a refusal on what the system manages, not on a mode default.** `modeOf` defaults to build, so "refuse for build mode" silently includes every item that never declared a mode. The honest key was existence of canon (feature.json) — the same line the document-derived tier draws. The full suite found the second place this mattered.
2. **A fix can open a bigger hole than it closes — and only the round that reviews the fix sees it.** Recording `lastSaveOk` needed `completion_projection` on the store's update allowlist; that made the verification stamp forgeable through PATCH. Round 2 targeting round-1 fixes is not ceremony.
3. **"Malformed" is not "absent".** Two independent code paths (managed check, startup tiering) collapsed an unparseable feature.json into "no feature.json" and fell open. Broken canon must refuse; absent canon may be display-only.
4. **A message-regex fallback is a fail-open waiting for the right error text.** `not found` matched a spawn failure. Match on codes; fall back to text only when there is no code.
5. **Equality short-circuits skip re-verification.** "status unchanged → skip" meant a stamped item was never re-checked when its canon rotted. Anything that is a *claim about canon* has to be re-derived from canon on every pass, cheaply.
6. **The tests must set the transport to a dead port.** A `VisionWriter` built inside the gate probes `resolvePort()` — with a cockpit running on :4001 the suite would have written to the live store. Several pre-existing suites still don't pin it.

## Open threads

- [ ] COMP-COMPLETION-GATE-REMOTE — paths 9 (GitHub half) and 15 (`GitHubProvider.setStatus`).
- [ ] COMP-COMPLETION-GATE-MODES — fix/plan completions; they still complete through `store.updateItem`/`updateItemStatus` (allowlisted, not gated).
- [ ] `VisionWriter` probe race (Codex r1 #6, pre-existing): one missed probe against a live server writes the file under the server's memory. Transport-level fix (probe retry / lease); every dual-dispatch op has it.
- [ ] Pre-existing suites that build a `VisionWriter` without pinning `COMPOSE_PORT` can hit a live cockpit on :4001.
- [ ] The running compose-mcp server still has pre-slice-3 code in memory until restarted; `record_completion` over MCP flips through the old path until then.
- [ ] `updateFeature()` (feature-json.js) is a generic Object.assign sink; its one caller passes no status, but nothing stops a future one.

---

*The front door only counts once you've locked the back ones — and then checked that the lock can't be picked from inside.*
