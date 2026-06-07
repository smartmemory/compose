# COMP-ROADMAP-XREF-PUSH-2 — Design / Scope

**Status:** COMPLETE — v1 shipped 2026-06-07 (`roadmap_xref_push` MCP tool, local-provider push, additive relabel) · **Complexity:** M · Parent: `COMP-ROADMAP-XREF-PUSH`.

> The three deferred pieces of `COMP-ROADMAP-XREF-PUSH`: (1) an MCP tool, (2) `local`-provider push, (3) additive relabel. Same safety posture throughout — dry-run by default, per-ref `push:true` opt-in, `--apply` to mutate, degrade = never write.

## Goal
Round out xref-push from "github issue open/closed, CLI only" to: a programmatic MCP surface, cross-repo `local` status push, and label reconciliation — without weakening any safety guarantee.

## Locked decisions
1. **MCP tool `roadmap_xref_push`.** Mirror the `roadmap_graph` registration pattern in `server/compose-mcp.js`. Args: `{ apply?: boolean }` (default dry-run). Returns the small summary object (`pushed/skipped/unchanged/scanned`), never a large body. Pull stayed CLI-only, but a programmatic push surface is the point of this slice.
2. **`local`-provider push delegates to the sibling.** A `local` push-opted link's `expect` is a feature status (`XREF_LOCAL_EXPECT` vocab). Push sets the sibling's status by calling the sibling repo's **own** `setFeatureStatus(siblingRoot, { code: to_code, status: expect })` — which enforces the sibling's transition policy AND regenerates the sibling's ROADMAP (lossless roundtrip). **Never `force`, never `derived`** (both bypass the transition table — we want the sibling's `TRANSITIONS` to genuinely govern). If the sibling rejects (disallowed transition, not found, roundtrip fault), it throws → we degrade-skip with the reason.
   - **siblingRoot containment is the push path's own job.** `setFeatureStatus(cwd, …)` trusts its `cwd` and does NO containment check; the only sibling-containment guard today lives inline in `xref-sync.js` `defaultResolve` (lexical direct-sibling check + realpath escape check). Push MUST run that same guard to turn `link.repo` into a vetted `siblingRoot` BEFORE calling `setFeatureStatus`, or a bad `repo` token writes outside the workspace parent. **Extract that guard into a shared helper** (`lib/xref-local.js` `resolveSiblingRoot(cwd, repo) → { root } | { skipped, reason }`) and use it from both Pull's resolver and Push.
   - **Security boundary (explicit):** the sibling's *MCP* lifecycle guard (`STATUS_OWNED_BY_LIFECYCLE`, server layer) is intentionally **not** consulted on cross-repo push — the sibling's `feature.json` transition table is the only gate, by parity with the compose CLI/build path. Reviewers should not assume the MCP guard runs.
3. **Additive relabel via `expect_labels`.** New carrier field `expect_labels: string[]` on **github** external links = labels that MUST be present. Push adds any missing ones and **never removes** labels a human added (additive, not exact-set). Idempotent: if all present, no write.
   - **Normalize label shape first.** GitHub returns `body.labels` as an array of label **objects** (`{name}`), not strings (cf. `github-provider.js:494` `l.name ?? l`). The resolver MUST normalize current labels to a `string[]` of names before any present-check or union, or every run falsely reports a write and the PATCH sends malformed objects. "Add" = PATCH `labels: union(currentNames, expect_labels)` (de-duped).
   - **Best-effort, not absolute.** GitHub's labels PATCH is a full-set replace with no conditional-update/ETag primitive, so union is a read-modify-write: a label a human adds *between* this run's read and its PATCH could be dropped. Mitigate by reading each issue immediately before its own PATCH; document the guarantee as **best-effort additive**, not a hard invariant.

## Provider/aspect model
Push now reconciles up to two aspects per link:
- **state** — github `open|closed` (decided by `planPush`, unchanged) OR local status (same pure compare).
- **labels** — github only, additive (`planLabels`, new).

A single github link may carry `expect` and/or `expect_labels`; both reconcile in **one** PATCH. The orchestrator dispatches by `link.provider` to a small handler (`{ eligible, resolve, write, label }`); the pure planners stay provider-agnostic.

**Eligibility / aspect combinations (github), making the gate ordering explicit** — the shipped `pushExternalRefs` gates on `isGithubState(link.expect)` and emits a `malformed expect` skip otherwise; that ordering breaks the labels-only case and must change:
| `expect` | `expect_labels` | Outcome |
|---|---|---|
| absent | absent | not eligible — `push:true` with no intent → not scanned (clean no-op) |
| `open\|closed` | absent | state aspect only (unchanged from -PUSH) |
| absent | `string[]` | **labels aspect only** — the `expect`-must-be-state check fires ONLY when `expect` is present |
| `open\|closed` | `string[]` | both aspects → **one** PATCH carrying `{state, labels}` |
| not `open\|closed` | any | skip `malformed expect` (only when `expect` is present) |

**Resolve coupling caveat:** github `resolve` rejects PR-backed refs wholesale (`body.pull_request`), so a link pointing at a PR can push *neither* state nor labels (both skip with the PR reason). Acceptable — we never mutate a PR. `local` has only the state aspect (no labels).

## Carrier / schema / writer (wire end-to-end — lesson from -PUSH)
- `contracts/feature-json.schema.json`: add `"expect_labels"` **scoped to the github `if/then` branch only** (not the top-level `links.items.properties`, which would leak it onto local/url links and contradict the "no local label push" non-goal): `"expect_labels": { "type": "array", "items": { "type": "string", "minLength": 1 } }`.
- `lib/feature-writer.js`: `validateExternalArgs` github branch admits `expect_labels` (array of non-empty strings) AND **rejects it on non-github providers** (carrier-equivalence with the schema). The entry reconstruction is an explicit allowlist (`feature-writer.js:919-926`) — add `if (args.expect_labels != null) entry.expect_labels = args.expect_labels;` or the field is silently dropped (same trap as `push` in -PUSH).
- `lib/feature-validator.js` write-guard delegates to the schema (no change needed beyond schema).

## Safety (unchanged from -PUSH, extended)
- Dry-run default; `--apply`/`apply:true` to mutate.
- Per-ref `push:true` opt-in; nothing eligible without it.
- Degrade = never write: github offline/no-token/404/rate-limit/non-2xx/unparseable, PR-backed ref, and **local** sibling-not-found / disallowed-transition / containment-escape → skipped with reason.
- Idempotent per aspect: state skip if already matches; labels skip if all present.
- `local` never `force`s a transition; github never touches a PR; github `expect` still must be `open|closed`, `expect_labels` must be a string array.

## Non-goals (v1)
- Exact-set relabel (remove extra labels) — additive only; file a follow-up if needed.
- `local` label push (local features have no GitHub-style labels).
- `local` push that creates a missing sibling feature (404 → skip, never create).
- Reserved providers (jira/linear/notion/obsidian).

## Testing (golden flow)
- **Pure** `planLabels`: all-present→none; some-missing→add union; empty expect→none.
- **github labels**: dry-run reports add, 0 writes; `--apply` → one PATCH with `labels: union`; idempotent second run (all present) → 0 writes; combined state+labels → single PATCH carries both.
- **local push**: injected `setFeatureStatus` spy — drift (sibling PLANNED, expect COMPLETE) → dry-run reports, `--apply` calls setFeatureStatus once; idempotent (sibling already == expect) → 0 calls; sibling throws (disallowed transition) → skipped with reason; containment-escape repo token → skipped.
- **MCP tool**: `roadmap_xref_push` dry-run returns summary; `apply:true` threads through; default is dry-run.
- **Safety regressions** from -PUSH still hold (no opt-in → not scanned; PR-skip; non-2xx skip).

## Related
- `COMP-ROADMAP-XREF-PUSH` (parent), `COMP-ROADMAP-XREF-SYNC` (Pull), `COMP-MCP-XREF-SCHEMA` (#15 grammar).
