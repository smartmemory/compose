# Session 24 — COMP-OBS-BRANCH: First Ship of Wave 6

## What happened

The human ran `/compose build COMP-OBS-BRANCH`. The feature folder already had `feature.json`, `blueprint.md`, and `plan.md` — no `design.md`, no `prd.md`, no `architecture.md`. The blueprint had been through a Codex review pass (contract schema jumped to v0.2.2 because of it), and the plan had 11 tasks across 4 parallel tracks. This was the execution run.

Entry scan flagged two plan drifts:

1. **T0 assumed `ajv` was already a dep** — it wasn't. We installed `ajv` + `ajv-formats` (JSON Schema draft-07 needs `if/then/allOf` support, which draft-07 validators like Ajv do; and the contract uses `format: date-time` + `format: uuid`).
2. **T3 said extend `test/vision-store.test.js`** — but that file tests the *client* Zustand store, not the server `vision-store.js`. Created `test/vision-store-server.test.js` instead.

Both were minor, documented, and fixed inline rather than rewriting the plan.

We did foundation first: **T0** (schema validator) and **T10** (fixtures) in parallel — T10 dispatched to a subagent because it needed to scan real `~/.claude/projects/` JSONL files and produce deterministic scrubbed fixtures. The agent came back with more than just files: it flagged six T1 gotchas the plan hadn't anticipated:

- No standalone `type: "result"` records in real CC JSONL — closure is a `tool_result` inside a user message.
- `message.content` is polymorphic (string OR array) — handle both.
- Non-tracked top-level types exist in real sessions (`file-history-snapshot`, `queue-operation`, etc.) — log-and-skip.
- `sessionId` inside records can mismatch the filename — use filename basename as canonical.
- `is_error: true` lives on the `tool_result` content item, not the outer record.
- Truncation: final partial line isn't `\n`-terminated — `try/catch` per line, not around the whole file.

Those shaped T1's reader heuristics. Especially the `is_error` location — the failed-branch classifier would have been wrong without that note.

While the subagent worked, we did the independent backend pieces — T3 (lifecycle_ext store helper + preservation rule), T6 (deterministic uuidv5 event ids), T8 (Zustand slice). Then T7 (BranchComparePanel) — but ran into a wall: the codebase has **no React testing infrastructure** (no `@testing-library/react`, no jsdom/happy-dom, zero `.test.jsx` files). So we split: pure helpers (`summarizeLineage`, `pickInitialPair`, formatters) got extracted to `branchComparePanelLogic.js` and unit-tested (27 tests); the component itself gets its smoke coverage via T11 integration and the future Playwright layer.

T9 (mount in ItemDetailPanel) was cleaner than the plan suggested — `ItemDetailPanel` uses `<ScrollArea><div className="p-3 space-y-4">` as its layout container, so the panel slotted in as the first child before Status+Confidence. Added a tiny `BranchComparePanelMount` wrapper so the Zustand wiring stayed inside the file.

Then the backend chain: T1 (reader) → T2 (resolver) → T4 (route) → T5 (watcher). T1 was the biggest step — ~300 lines — and landed on the first try once the fixture gotchas were in hand. T5 is where the aggregation rule mattered: per-feature × per-session accumulator, so a feature with two CC sessions never has its lineage clobbered on the next POST. T11 E2E then verified the whole slice end-to-end on tmp dirs.

**Full suite: 1515/1515 pass, zero regressions.** The 31 existing `updateLifecycle` callsites were the big risk surface — the new "preserve `lifecycle_ext` when caller omits it" rule is additive, and the whole test matrix stayed green.

Wire-up in `vision-server.js` is **opt-in by default**. Set `capabilities.cc_session_watcher: true` in `compose.json` or `CC_SESSION_WATCHER=1` in the env to turn it on. Default off because enabling it scans real `~/.claude/projects/` on startup, and that's the kind of side effect that shouldn't light up the first time someone pulls main.

## What we built

### New files
- `server/schema-validator.js` — ajv wrapper, hard-pinned to the contract path.
- `server/cc-session-reader.js` — JSONL → parent-pointer tree → classified BranchOutcomes with §6.5 metrics.
- `server/cc-session-feature-resolver.js` — cc_session_id → feature_code, three-tier with mtime-keyed cache.
- `server/decision-event-id.js` — deterministic uuidv5 + pure dedupe helper.
- `server/cc-session-watcher.js` — orchestrator with injectable `projectsRoot`, debounced `fs.watch`, polling fallback, per-feature aggregation.
- `src/components/vision/BranchComparePanel.jsx` + `branchComparePanelLogic.js` — UI + its testable core.
- `test/comp-obs-branch/` — 7 test files covering validator, reader, resolver, event id, watcher, route, panel logic.
- `test/fixtures/cc-sessions/` — 6 fixtures + multi-session dir + README + byte-deterministic `capture.js`.
- `test/vision-store-server.test.js` — 11 tests for the new store semantics.
- `test/wave-6-integration.test.js` — 6-test E2E.

### Modified files
- `server/vision-store.js` — preservation rule + `updateLifecycleExt`.
- `server/vision-routes.js` — `POST /lifecycle/branch-lineage` + schema validator import.
- `server/vision-server.js` — opt-in CCSessionWatcher wire-up.
- `src/components/vision/useVisionStore.js` — `selectedBranches` Zustand slice.
- `src/components/vision/ItemDetailPanel.jsx` — mount point + wrapper.
- `package.json` / lockfile — `ajv` + `ajv-formats`.
- `CHANGELOG.md` — this feature.

## What we learned

1. **Subagent reports are richer than the files they produce.** The T10 fixture agent surfaced six CC JSONL gotchas — format details that no amount of plan review would have caught, because the plan was written from an outside-in view of the data. Treat subagent reports as upstream intel, not deliverables to skim past. One of them (the `is_error` placement) would have silently produced wrong classifications.
2. **"Existing dep" assumptions in plans decay.** T0 said ajv was already present; it wasn't. Plan drift is normal and cheap to catch on entry-scan — but only if you spot-check the claim before starting. The cost of one `grep '"ajv"' package.json` is much less than the cost of writing a wrapper against a non-existent dep.
3. **Extract pure logic when test infra isn't there yet.** No `@testing-library/react`, no jsdom, no `.test.jsx` in the repo. Rather than blocking on setting that up (and bloating this feature's surface), we extracted pure helpers from the component and unit-tested those. Component integration comes via the E2E. Ship narrow, leave the test-infra pickup as its own roadmap item.
4. **Default OFF is the right call for read-your-homedir features.** The CCSessionWatcher hits `~/.claude/projects/` on startup. Even though it's read-only, surprising side effects on first-pull from main is the kind of thing that burns trust. Opt-in via config or env var; defaults off; advertised in the CHANGELOG.
5. **Aggregation rules are never obvious on the first read.** T5's "per-feature × per-session accumulator" sounds pedantic until you realize that without it, a feature with two live CC sessions has its second POST overwrite the first's branches. The T5 test that would have caught that regression is the `feature with 2 sessions` case — earning its keep.
6. **The 31 updateLifecycle callsites were the real risk.** The whole `lifecycle_ext` preservation rule exists because `feature-scan.js:397,479` writes partial lifecycle objects in a loop, and under the old full-replace semantics any Wave 6 addition would vanish the next time that ran. Fixing at the store layer, not at every caller, is the right granularity.

## Open threads

- [ ] UI not manually verified in a browser. `npm run build` is green; the E2E exercises the backend slice; the component path is covered by pure-logic tests. Full visual verification belongs in the next session or a Playwright pass.
- [ ] Codex review pass on the implementation itself (as distinct from the blueprint review that already happened). Worth running before merging if the scope of this lands in user-visible code.
- [ ] COMP-OBS-SURFACE's decision timeline is the consumer of the `decisionEvent` events we now emit. Events broadcast but nothing listens yet. SURFACE blueprint needs its Wave 6 rev — flagged in the blueprint §7 corrections table.
- [ ] `open_loops_produced[]` stays empty in v1; wiring waits on COMP-OBS-LOOPS.
- [ ] Drift axis injection into `BranchComparePanel` metric rows stays stubbed (the `extraMetricsForBranch` prop is the hook) — waits on COMP-OBS-DRIFT.
- [ ] `final_artifact.snapshot` is null — v2 lazy-load from `path` at scan time.

Wave 6 has its structural validator. Next branch says whether the rest of the batch is shippable.
