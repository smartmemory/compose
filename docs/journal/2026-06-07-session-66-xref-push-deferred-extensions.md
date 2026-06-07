---
date: 2026-06-07
session_number: 66
slug: xref-push-deferred-extensions
summary: Built COMP-ROADMAP-XREF-PUSH-2 — xref-push's deferred MCP tool, local-provider push (sibling delegation), and additive relabel; fallback reviewer caught label-object + containment + union-not-subset traps.
feature_code: COMP-ROADMAP-XREF-PUSH-2
closing_line: The easy 80% was the MCP tool; the real work was teaching push to write other people's repos without breaking them.
---

# Session 66 — COMP-ROADMAP-XREF-PUSH-2

**Date:** 2026-06-07
**Feature:** `COMP-ROADMAP-XREF-PUSH-2`

## What happened

Follow-on to session 64: the user said "do the deferred pieces" — the three things COMP-ROADMAP-XREF-PUSH's design had parked: an MCP tool, local-provider push, and relabel. They differ sharply in risk, so we investigated before committing scope. MCP tool: trivial mirror of roadmap_graph. local push: feasible *and* safe only by delegating to the sibling repo's OWN setFeatureStatus (so its transition policy + ROADMAP regen apply) rather than raw-writing another repo's feature.json — and crucially the lifecycle guard lives in the MCP layer, not the lib, so the lib path is a legitimate caller. relabel: the one genuine destructive-policy call, which we put to the user — they chose additive-only (add missing, never remove). We then ran the full build lifecycle. The fallback reviewer agent (Codex was rate-limited all session) was unusually productive: it caught two must-fixes at design (GitHub returns label OBJECTS not strings; the sibling-containment guard was missing from the write path) and two should-fixes at blueprint (the xref-sync refactor would silently drop the to_code guard; the label PATCH must carry the full union, not the missing subset, or it deletes human labels).

## What we built

- `lib/xref-local.js` (new): `resolveSiblingRoot(cwd, repo)` — the lexical+realpath sibling-containment guard, extracted from xref-sync so Pull and Push share one implementation.
- `lib/xref-push.js`: pure `planLabels` (additive, case-sensitive, union); provider dispatch (github vs local); github `defaultResolve` now normalizes label objects → names and returns `{state, labels}`; `defaultWrite` takes a `{state?, labels?}` patch (combined PATCH); local handler resolves via the shared guard + reads sibling status, writes via the sibling's `setFeatureStatus` (no force/derived, degrade-skip on throw); back-compat result rows (flat from/to retained, structured state/labels/summary added).
- `lib/xref-sync.js`: local branch refactored onto `resolveSiblingRoot` (keeps its own `!to_code` guard + feature read).
- `expect_labels` carrier: schema (github-scoped, `expect_labels:false` on local/url), `feature-writer` validate+preserve+reject-non-github.
- `roadmap_xref_push` MCP tool (handler + 3 registration sites).
- ~30 new tests across `test/xref-push.test.js`, `test/xref-push-local.test.js` (real temp-sibling golden), `test/xref-local.test.js`, plus carrier/schema additions.

## What we learned

1. **Risk-triage deferred work before batch-building it.** "Do the deferred pieces" bundled a trivial mirror, a delegation-requiring cross-repo write, and a destructive-policy choice. Surfacing only the genuine decision (additive vs exact-set relabel) and choosing safe defaults for the rest kept momentum without rubber-stamping.
2. **Cross-repo writes must respect the target's ownership.** Local push works by delegating to the sibling's own `setFeatureStatus` — its transition table governs, its ROADMAP regenerates, and a disallowed transition naturally degrades to a skip. Raw-writing the sibling's feature.json would have bypassed all of that.
3. **External-shape assumptions bite.** GitHub returns label OBJECTS, not strings; a naive union would have reported phantom writes and PATCHed malformed objects. Normalize at the boundary.
4. **A full-replace API turns 'add' into a deletion trap.** GitHub's labels PATCH replaces the whole set, so the additive guarantee requires PATCHing `union(current, expect)` — sending the missing subset would delete every human-added label. The blueprint pseudocode had a field-name slip (`labelsTo` vs planLabels' `.to`) the reviewer caught before it became a bug.
5. **Shared guards need explicit scope boundaries.** Extracting `resolveSiblingRoot` was right, but it covers repo-token containment ONLY — each caller keeps its own `to_code` check and feature read, or the refactor silently drops a guard.

## Open threads

- [ ] Still no live `push:true` links / `xref:` citations / `expect_labels` anywhere — the whole xref-push family is forward-looking, no consumer yet.
- [ ] Not pushed to origin yet (awaiting user confirmation for the outward-facing action).
- [ ] Relabel is additive-only by decision; exact-set (remove extras) deferred. local label push and reserved providers remain out of scope.
- [ ] Codex was rate-limited the entire session; all gates ran on the general-purpose fallback reviewer (per the compose skill's documented fallback).

---

*The easy 80% was the MCP tool; the real work was teaching push to write other people's repos without breaking them.*
