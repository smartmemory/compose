---
date: 2026-06-07
session_number: 64
slug: xref-push-write-side
summary: "Built COMP-ROADMAP-XREF-PUSH — the deferred write-side of xref-sync; dry-run default, push:true opt-in, degrade-never-write, PR-safe; Codex-gated through 3 phases."
feature_code: COMP-ROADMAP-XREF-PUSH
closing_line: Pull mirrors reality into the repo; Push mirrors the repo into the world — and the world needs more guards.
---

# Session 64 — COMP-ROADMAP-XREF-PUSH

**Date:** 2026-06-07
**Feature:** `COMP-ROADMAP-XREF-PUSH`

## What happened

The ask was `/compose build COMP-ROADMAP-XREF-SYNC` — but the entry scan found that feature already COMPLETE: v1 Pull (`compose roadmap xref-sync`) shipped 2026-05-29, and its design doc explicitly deferred the write-side "push" to a separate ticket. Rather than fabricate work against done code, we surfaced the discrepancy and asked what was actually wanted. The answer: build the deferred Push. We carved it as its own feature, COMP-ROADMAP-XREF-PUSH, and ran the full build lifecycle. Two load-bearing decisions went to the user up front: (1) intent model — `expect=` as desired-state (literal mirror of Pull) over feature-status-as-truth; (2) safety posture — dry-run default + per-ref `push:true` opt-in + `--apply`. Both were chosen for explicitness, since this is the first capability that mutates a system *outside* the repo. Codex gated every phase: design (3 findings → resolved), blueprint (3 findings, incl. a Boundary-Map-format fix and a schema/test-path gap), and implementation (2 findings — mock-only safety coverage, then a missing incomplete-ref guard on the exported write helper).

## What we built

- `lib/xref-push.js` (new): pure `planPush` (mirror of `reconcileExpect`) + orchestrator `pushExternalRefs` + exported `defaultResolve`/`defaultWrite` with an injectable `githubTransport`/`githubAuth` seam. Never mutates feature.json; degrade = never write.
- `lib/tracker/github-api.js`: `updateIssueResult(n, patch)` — status-returning PATCH sibling of `updateIssue`, so a non-2xx write degrades to a skip instead of a false success.
- `lib/xref-sync.js`: Pull now skips `push:true` links (cross-feature contract — push-managed ≠ pull-managed, else they oscillate).
- `lib/feature-writer.js` + `contracts/feature-json.schema.json`: `push` boolean carrier — validated, schema-typed, and preserved through the writer's entry reconstruction (it rebuilds links from a fixed field list, which silently dropped unknown keys).
- `bin/compose.js`: `compose roadmap xref-push [--apply]` + help line.
- Tests: `test/xref-push.test.js` (23: pure plan, golden dry-run/apply/idempotent, safety/degrade, real-path via stubbed transport), plus cross-feature regression in `xref-sync`, carrier preservation in `feature-linker`, schema accept/reject in `feature-json-schema-external`.

## What we learned

1. **Entry scan earns its keep.** The named feature was already done; the real work was a deferred follow-up the design had named but never filed. Verifying status-vs-disk before building avoided a no-op.
2. **Push needs guards Pull never did.** Pull only rewrites a local string, so it tolerates a bare resolver. Push writes externally, so it must additionally (a) reject PR-backed refs (GitHub treats PRs as issues — a state PATCH would close a PR), (b) use a status-returning write primitive so failures degrade, and (c) guard incomplete refs before building a client.
3. **A new opt-in field must be wired end-to-end.** `push:true` touched four layers: schema (type), write-guard (delegates to schema), typed writer (fixed-field reconstruction drops unknowns), and the consumer. Codex caught the schema+writer gaps the happy-path test would have missed.
4. **Mock-only tests overstate safety.** The first cut tested degrade paths via injected skips — the production github path was never exercised. Adding an injectable transport seam (mirroring the validator's) let the real PR-skip/404/no-token/non-2xx paths be tested without network.

## Open threads

- [ ] No live `xref:` citations or `push:true` links exist in any ROADMAP today — Push (like Pull) is forward-looking, no current consumer.
- [ ] Not pushed to origin yet (awaiting user confirmation for the outward-facing action).
- [ ] v1 is github-only; `local`-provider push, relabel/arbitrary patches, and an MCP tool are deferred (Pull is CLI-only too).

---

*Pull mirrors reality into the repo; Push mirrors the repo into the world — and the world needs more guards.*
