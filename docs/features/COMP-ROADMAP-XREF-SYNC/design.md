# COMP-ROADMAP-XREF-SYNC — Design / Scope

**Status:** PARTIAL — v1 PULL shipped 2026-05-29 (`lib/xref-sync.js`, `compose roadmap xref-sync`); push deferred · **Complexity:** M · Split from COMP-ROADMAP-RT.

> **Shipped (v1 Pull):** `compose roadmap xref-sync [--dry-run]` and `lib/xref-sync.js` reconcile every feature.json external `links[]` entry's `expect=` to the live target state (github via `getIssueResult`, local via the sibling feature.json status), with an injectable resolver and the validator's degrade semantics (offline/no-token/404 → reported skipped, never guessed). Pull only — never writes external. Structured-carrier only, so no markdown rewrite and no roundtrip impact. **Push (option 2 below) remains unbuilt** — file `COMP-ROADMAP-XREF-PUSH` if wanted.

## Goal
Turn the **read-only** `XREF_DRIFT` warning into **verifiable sync** — reconcile inline external cross-references against their live targets instead of only flagging divergence.

## What already exists (foundation — do NOT rebuild)
- **`lib/xref-citation.js`** — pure parser for `<!-- xref: <provider> <target> [expect=…] [note="…"] -->` citations embedded in ROADMAP/description cells. Providers: `github`/`local`/`url` (resolvable), `jira`/`linear`/`notion`/`obsidian` (reserved, url-class, unresolved in v1).
- **`lib/feature-validator.js` `runExternalRefChecks`** — resolves `github` (via `gh.getIssueResult`) and `local` (filesystem) refs, comparing live state to the citation's `expect=`. Emits findings: `XREF_DRIFT` (cited state contradicts reality), `XREF_TARGET_MISSING` (404), `XREF_RESOLUTION_SKIPPED` (offline/no-token/rate-limit/≥500), `XREF_MALFORMED`, `XREF_URL_UNCHECKED`.
- **`lib/tracker/github-api.js`** — `getIssueResult(n)` (GET) **and** `updateIssue(n, patch)` (PATCH). So external *writes* are already technically available.

## The defining decision: sync direction
`XREF_DRIFT` fires when, e.g., a row cites `expect=open` but the GitHub issue is `closed`. "Sync" can mean three different things:

1. **Pull (reconcile local → match external).** Rewrite the citation's `expect=` (and optionally the row's note/status) to the resolved live state. No external writes. Safe, idempotent, mirrors how `roadmap generate` canonicalizes local state. Drift becomes an auto-applicable local fix.
2. **Push (write external → match local).** When local truth says a feature shipped, `updateIssue` to close/relabel the tracker item. Potentially destructive to systems outside this repo; needs auth scope, dry-run, and per-ref opt-in.
3. **Bidirectional / interactive.** Report each drift and let the operator choose direction per ref.

**Recommendation: v1 = Pull only.** It's the safe, high-value 80%: it makes `XREF_DRIFT` actionable without ever mutating an external system. Push is a separate, larger feature (write auth, blast-radius controls, confirmation UX) and should be its own ticket (`COMP-ROADMAP-XREF-PUSH`) if wanted.

## Proposed v1 (Pull) shape — if approved
- CLI: `compose roadmap xref-sync [--dry-run]` (and an MCP tool). Resolves every citation (reusing `runExternalRefChecks`' resolution path, refactored to return resolved state, not just findings), and for each `XREF_DRIFT` rewrites the `expect=`/`note=` in the ROADMAP description cell to match reality.
- Reuse the existing offline/rate-limit degrade behavior — skipped refs are reported, never guessed.
- Round-trip safety: citations live inside description cells, so any rewrite must go through the same generate/parse path and keep `roadmap check` a fixed point. A test fixture with a drifting citation must converge after one sync.
- Non-goals v1: external writes (push); resolving reserved providers (jira/linear/notion/obsidian stay url-class).

## Notes
- **No live `xref:` citations exist in the ROADMAP today** (`grep -c` = 0), so this has no current consumer — purely forward-looking. Worth deferring until a citation actually lands, unless we want to ship the capability ahead of need.

## Related
- COMP-ROADMAP-RT (parent), COMP-MCP-XREF-SCHEMA (#15, citation grammar), COMP-MCP-XREF-VALIDATE (#16, read-only checks).
