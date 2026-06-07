# COMP-ROADMAP-XREF-PUSH — Design / Scope

**Status:** COMPLETE — v1 shipped 2026-06-07 (`lib/xref-push.js`, `compose roadmap xref-push [--apply]`) · **Complexity:** M · Parent: `COMP-ROADMAP-XREF-SYNC` (the deferred "push" half).

> The write-side counterpart to the shipped Pull (`compose roadmap xref-sync`). Pull rewrites the **local** citation's `expect=` to match **external** reality. Push does the inverse: it writes the **external** tracker to match the **locally-declared** `expect=` intent. Because this mutates systems outside the repo, it is dry-run by default, per-ref opt-in, and degrades (never guesses, never writes) on any resolution failure.

## Goal
Let an operator make a GitHub tracker item reflect locally-declared truth — e.g. close an issue when its `feature.json` link says it should be closed — without ever leaving the repo or hand-editing the tracker. This is the "verifiable sync, write direction" the parent design (COMP-ROADMAP-XREF-SYNC §"sync direction", option 2) deferred to its own ticket.

## Problem
Today the lifecycle is read-only or pull-only:
- `validate` flags `XREF_DRIFT` (external state contradicts the cited `expect=`) — **read-only**.
- `xref-sync` resolves drift by rewriting the local `expect=` to match the external — **pull**, never writes external.

There is no supported way to push: when the repo is authoritative ("this issue *should* be closed now"), the only options are manual tracker edits or bespoke scripts against `updateIssue`. That is exactly the destructive, auth-scoped, blast-radius-sensitive operation the parent design refused to fold into Pull.

## What already exists (foundation — do NOT rebuild)
- **`lib/xref-sync.js`** — the Pull. Pure core `reconcileExpect(ref, liveState)` + orchestrator `syncExternalRefs(cwd, {dryRun, featuresDir, resolve})`. Scans `feature.json` `links[].kind === 'external'`, `RESOLVABLE = {github, local}`, injectable `resolve`, degrade-skip semantics, persists via `writeFeature`. **Push mirrors this structure exactly.**
- **`lib/tracker/github-api.js`** — `getIssueResult(n)` (GET, status-returning, read current state) **and** `updateIssue(n, patch)` (PATCH `/repos/:repo/issues/:n`). The write *transport* exists, but `updateIssue` returns only `.body` (drops HTTP status) — see Foundation edits below.

## Foundation edits (small, required before the Push core)
- **`github-api.js`: add `updateIssueResult(n, patch)`** — status-returning sibling of `updateIssue`, mirroring `getIssueResult` exactly: `return this._req('PATCH', …)` → `{status, body, headers}`, does **not** throw on 4xx. Push's degrade contract (treat `403`/`404`/`422`/non-2xx as `skipped`, never claim success) is impossible on `updateIssue` alone, which discards the status. `updateIssue` stays untouched. *(Resolves Codex finding 1.)*
- **`feature-writer.js`: preserve `push` on external links** — `validateExternalArgs` must admit `push` (boolean), and the external-link entry reconstruction (~L916) must carry `if (args.push != null) entry.push = args.push;`. Today the writer rebuilds the entry from a fixed field list (`repo/issue/to_code/url/expect/note`), so any later feature edit through the writer would **silently drop a hand-set `push:true`** and disarm the opt-in. v1 has no CLI to *set* `push` (operator hand-edits `feature.json`), but the writer must not lose it. *(Resolves Codex finding 3.)*
- **`lib/feature-validator.js` `runExternalRefChecks`** — the degrade canon: offline / no-token (`TrackerConfigError` `missing:'token'`) / rate-limit / 404 / non-2xx → reported skipped, never guessed. Push reuses the identical posture but for *writes*.
- **`bin/compose.js:1138`** — the `subcmd === 'xref-sync'` CLI dispatch block; Push adds a sibling `xref-push` block.

## Locked decisions
1. **Intent model: `expect=` as desired-state.** Literal mirror of Pull. For each eligible link, resolve the current external state; if `expect` ≠ current, write the external to `expect`. (Rejected: feature-status-as-truth — introduces an implicit status→state mapping and a larger blast radius. `expect=` keeps the human's intent explicit and per-ref.)
2. **Safety: dry-run default + per-ref opt-in + `--apply` to write.**
   - The command **prints what it would write and changes nothing** unless `--apply` is passed.
   - A link is **eligible only if it carries `push: true`** in `feature.json`. No marker → never touched, even with `--apply`.
   - **Degrade = never write:** offline / no-token / rate-limit / 404 / non-2xx / unparseable state → skipped with a reason, exactly like Pull's resolver.
   - **Idempotent:** read current state first; if already == `expect`, count as unchanged and issue no PATCH.
3. **Provider scope: `github` only in v1.** `local` refs resolve to a sibling `feature.json` status — "writing" a sibling's lifecycle is a different operation (and the sibling owns its own status); out of scope. `url` / reserved (`jira|linear|notion|obsidian`) stay untouched.
4. **`expect` must be a valid github state (`open`|`closed`).** Anything else on a `push:true` github link → skipped as malformed (don't PATCH a garbage state).
5. **Never write PR-backed refs.** GitHub's Issues API treats pull requests as issues, so `owner/repo#123` may resolve to a PR — and a state PATCH would close/reopen that PR. The resolve step inspects the fetched body: if `body.pull_request` is present, the ref is **skipped with reason `target is a pull request, not an issue`**, never written. (Pull's resolver doesn't need this guard — it only rewrites a local string — but Push does.) *(Resolves Codex finding 2.)*

## Cross-feature contract (Pull ↔ Push) — REQUIRED
Pull (`syncExternalRefs`) rewrites `expect` to live reality. If a link is push-opted (`push:true`) and Pull runs first, Pull would overwrite the declared push intent (`expect=closed`) with current reality (`open`) **before Push ever runs** — the two would oscillate and the intent would be silently lost. Therefore **Pull must skip `push:true` links.** This is a one-line guard added to `xref-sync.js`'s eligibility check, plus a regression test asserting a push-opted link is left untouched by `xref-sync`. A link is either pull-managed or push-managed, never both.

## Proposed v1 (Push) shape
- **Pure core** `planPush(link, liveState)` → `{action: 'none'|'write', from?, to?}`. Mirror of `reconcileExpect`: no `expect` → none; unresolved (`liveState == null`) → none; `expect === liveState` → none (idempotent); else `write` from `liveState` to `expect`.
- **Orchestrator** `pushExternalRefs(cwd, {apply, featuresDir, resolve, write})` → `{pushed, skipped, unchanged, scanned}`. Eligibility: `link.kind==='external' && link.provider==='github' && link.push===true && isGithubState(link.expect)`. `resolve` returns `{state, isPullRequest}` (skips PR-backed refs per decision 5) or a `{skipped, reason}` degrade; `write` performs the PATCH via `updateIssueResult` and maps non-2xx → `{skipped, reason}`. Both are **injectable** so the golden flow never touches real GitHub. Push reconciliation never mutates `feature.json` (unlike Pull) — `expect` is the unchanged source of intent.
- **CLI** `compose roadmap xref-push [--apply]` — sibling of the `xref-sync` block: default dry-run, `--apply` mutates, same `resolveCwdWithWorkspace(args)`, summarises pushed / skipped / unchanged with per-ref reasons.

## Non-goals (v1)
- `local`-provider push; relabel or arbitrary issue patches (state open/closed only); reserved providers; an MCP tool (Pull is CLI-only — match it; file a follow-up if a programmatic caller appears); bulk confirmation UX beyond dry-run/`--apply`; creating issues that don't exist (404 → skip, never create).

## Testing (golden flow)
- **Pure** `planPush` table: idempotent (expect==live→none), drift (expect!=live→write), no-expect→none, unresolved→none, malformed expect→ineligible.
- **Golden integration:** a `feature.json` github link `{expect:'closed', push:true}`, fake resolver returns `open`, fake write transport records the PATCH. Dry-run → records intent, **zero** write calls; `--apply` → exactly one write `{state:'closed'}`; **second `--apply` run idempotent** (resolver now returns `closed` → unchanged, no write).
- **Safety:** a github link **without** `push:true` is never scanned even under `--apply`; no-token / 404 / rate-limit → skipped with reason, no write; **PR-backed ref** (`body.pull_request` present) → skipped, no write; **write returns non-2xx** (e.g. 403/422 via `updateIssueResult`) → skipped with reason, not counted as pushed.
- **Cross-feature regression:** `syncExternalRefs` leaves a `push:true` link's `expect` untouched.
- **Carrier preservation:** `feature-writer` round-trips a `push:true` external link without dropping the flag (write a feature with the flag, re-write via the typed path, assert `push` survives).

## Related
- `COMP-ROADMAP-XREF-SYNC` (parent / Pull half), `COMP-MCP-XREF-SCHEMA` (#15, citation grammar), `COMP-MCP-XREF-VALIDATE` (#16, read-only checks).
