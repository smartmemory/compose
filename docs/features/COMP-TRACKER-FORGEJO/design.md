# COMP-TRACKER-FORGEJO — Forgejo Issue Triage/Promotion + Progress Reporting

**Status:** DESIGN (rev 4 — post 3rd Codex review)
**Date:** 2026-09-18
**Feature code:** COMP-TRACKER-FORGEJO

## Related Documents

- Forward: `blueprint.md` (to be written), `plan.md` (to be written)
- Precedent (do NOT rebuild): `docs/features/COMP-TRACKER-PROVIDER/design.md` (full canonical-provider model — considered, not chosen for this scope), `docs/features/COMP-ROADMAP-XREF-SYNC/design.md` (pull direction), `docs/features/COMP-ROADMAP-XREF-PUSH/design.md` (push direction — the model this feature extends)
- Context: `lib/tracker/github-api.js`, `lib/xref-citation.js`, `lib/feature-validator.js`, `lib/xref-push.js`, `lib/xref-sync.js`, `lib/feature-writer.js`, `lib/status-projection.js`, `contracts/feature-json.schema.json`, `server/mcp-tool-defs.js`, `server/compose-mcp-tools.js`

## Revision note

Rev 1 got a Codex review (`gpt-5.6-sol/high`, run `b3cfe6fc3e25`) with 11 findings; rev 2 addressed them and got a second review (run `753010bb2040`) with 5 more; rev 3 addressed those and got a third review (run `7bbc8bcaf9c2`) with 4 findings + 1 minor; this revision (4) folds all of it in and was reviewed clean apart from wording (run `29a5cb019141`). Corrections across all rounds:

- Today's `xref-push` eligibility is **GitHub is the only remote issue-tracker provider** (`xref-push.js:198-226`) — `local` links are also eligible, so "GitHub-only" (rev 1/2 wording) overstated it.
- The Forgejo/Gitea method name is `addIssueComment` (matching `github-api.js:64-65`'s actual name), not `createComment`.
- The CLI dispatch precedent is `bin/compose.js:1555-1583`, not `:1138` (Jest dependency detection, unrelated).
- `runExternalRefChecks`'s degrade posture: a **confirmed 404** is an error-level `XREF_TARGET_MISSING` (`feature-validator.js:943-949`), not a skip. Only genuine uncertainty (offline, no-token, rate-limit, non-2xx-ambiguous) degrades to skipped.
- The existing vision-state projection this design's Piece 3 was modeled on lives at `feature-writer.js:532` (not `:495-530` — that range is the transition/persist step it follows).
- `push` is a **common** external-link field in the schema (`feature-json.schema.json:101`), not one of the GitHub-only conditional fields — this correction applies everywhere `push` was listed alongside the genuinely GitHub-only conditionals, including Piece 2 below.
- **Most significant:** rev 2's Piece 3 hooked `setFeatureStatus` for the lifecycle→expect projection, but `setFeatureStatus` explicitly *refuses* to write `COMPLETE` (`feature-writer.js:459`) — real completions go through `completion-gate.js`'s `persistCompleteStatus` (`:650-661`), which writes `COMPLETE` directly via `persistFeatureRaw`, bypassing `setFeatureStatus` entirely. Hooking only `setFeatureStatus` would mean the single most important transition (shipping a feature) never updates the link. Rev 3 replaces the write-time-projection approach with a read-time-derivation approach — see Piece 3 below.

## Problem Statement

This project (a 1-dev system until now) is opening to outside contributors on a self-hosted Forgejo instance (`git.smartmemory.ai`). Contributors will file issues there directly — Compose's roadmap has no visibility into that, and once a roadmap item is triaged in from an issue, there's no way to reflect its resolution back without hand-editing the tracker (which `feedback_no_manual_roadmap_edits` already forbids for the local roadmap, and shouldn't be reintroduced via a second door).

## Prior art considered and why it wasn't chosen

`COMP-TRACKER-PROVIDER` already ships a full pluggable-tracker abstraction (`lib/tracker/{provider,local-provider,github-provider,github-api,sync-engine,factory}.js`) where, once configured, the remote tracker becomes **canonical** for every feature (write-through cache + op-log + reconciler + CAS). A `ForgejoProvider` matching `GitHubProvider` would work but is a large lift (the GitHub side was a 21-task build) and makes Forgejo canonical for *every* feature, which doesn't fit "community issues live in Forgejo with no `feature.json` behind them until triaged."

`COMP-ROADMAP-XREF-PUSH` (shipped 2026-06-07; GitHub is the only remote issue-tracker provider it supports today) does the narrower thing that fits: a `feature.json` external link with `push: true` gets its GitHub issue's `state` and `labels` (via `planPush`/`planLabels`, `xref-push.js:38`/`:120`) patched to match the link's declared `expect`/`expect_labels`, dry-run by default, degrade-to-skip on any doubt, never touches a link without the flag. `feature.json` stays canonical throughout. This feature extends that mechanism to Forgejo and adds the missing promotion step — but rev 1 underestimated how much of the *plumbing* (not just the transport) is GitHub-specific; see Design below.

## Goals

1. **Progress reporting (extend, not rebuild):** a `feature.json` external link with `provider: 'forgejo'` and `push: true` gets its Forgejo issue's state/labels patched by `xref-push`, the same intent as a `github` link today.
2. **Lifecycle → link projection (net-new, closes the loop):** a promotion-created link's desired issue state is derived from the feature's *current* status at every `xref-push` run (not stored and kept in sync), so completing a feature actually results in the issue closing on the next run — with no writer call site to keep hooked as the codebase evolves. Without this, goal 1 is inert (Codex finding 5, both rounds).
3. **Triage/promotion (net-new):** given a Forgejo issue, create a `feature.json` entry with the external link pre-wired (`push: true`, `derive_expect: true`), so it's immediately eligible for (1)/(2).
4. **Acceptance write-back (net-new, requested by owner):** promotion, under `--apply`, performs a one-time write to the issue at acceptance time: additively apply a label (e.g. `roadmap-tracked`, never removing any existing label) and post a comment naming the assigned feature code and pointing back at the roadmap.

## Non-Goals (v1)

- Making Forgejo canonical for any feature.
- Ongoing bidirectional sync of any field — all writes here are one-way, keyed by the stored link.
- Pulling arbitrary Forgejo issue state into `feature.json` beyond what promotion captures once, at triage time.
- Auto-promoting issues (promotion is a deliberate, human-triggered, `--apply`-gated action).
- Multi-repo Forgejo issue tracking beyond one configured `owner/repo` per link (matches today's GitHub scope).

## Design

### Piece 1 — Forgejo transport (`lib/tracker/forgejo-api.js`, new)

Unlike GitHub, Forgejo/Gitea's issue-edit endpoint does **not** accept `labels` in the same PATCH as `state` — labels are set via a dedicated endpoint, `PUT /issues/{index}/labels`, documented as a full replace of the issue's label set (Gitea API: "Replace an issue's labels"). This breaks the assumption baked into `xref-push.js:217`'s one-PATCH-does-both call. The transport therefore exposes them as **two distinct operations**, and the caller (Piece 2) is responsible for sequencing and partial-success reporting — it cannot inherit `xref-push`'s current single-write-then-report shape unmodified:

- `getIssueResult(number)` — `GET /repos/{owner}/{repo}/issues/{index}`, status-returning (mirrors `github-api.js:51`).
- `updateStateResult(number, {state})` — `PATCH /repos/{owner}/{repo}/issues/{index}` with only `{state}`, status-returning (mirrors `github-api.js:60`'s `updateIssueResult`, narrowed to state-only since that's all this endpoint safely covers here).
- `addLabelResult(number, labelName)` — `POST /repos/{owner}/{repo}/issues/{index}/labels`, **additive** (adds the managed label without touching any other label). Round 5 review caught that the previously-designed read-then-`PUT`-full-replace sequence is race-prone (a label added by a human between the read and the write is lost) — the additive endpoint removes the race entirely by construction, since it never needs to know the full current set. This feature never needs to *remove* a label, so the additive-only endpoint is sufficient; no full-replace call is used anywhere in this design.
- `listIssueComments(number)` — `GET /repos/{owner}/{repo}/issues/{index}/comments`, paginated, status-returning (mirrors `github-api.js:67`'s existing precedent) — needed so promotion's comment-idempotency check (Piece 4) can actually look for the hidden marker before posting, rather than only being able to post.
- `addIssueComment(number, body)` — `POST /repos/{owner}/{repo}/issues/{index}/comments` (name matches `github-api.js:64-65` for consistency, not `createComment`).

**Base URL / egress contract (Codex finding 9):** the client pins its origin to a single configured base URL (`https://git.smartmemory.ai` for this project), validated at construction, never derived from issue-body content or any caller-controlled value. The bearer token is attached only to requests to that pinned origin and is never forwarded across a redirect to a different host (mirrors the caution already implicit in `github-api.js` hardcoding `api.github.com`).

Auth: PAT via env (`COMPOSE_FORGEJO_TOKEN`), never written to disk. Required scope confirmed against the live instance before wiring (Open Question 3).

**Partial-success contract:** once `updateStateResult` or `addLabelResult` returns a 2xx, that write is real and must never be reported as "skipped" — only the *unattempted* half of a combined state+label push can degrade to skip. `xref-push`'s Forgejo branch reports state and label outcomes independently (`{statePushed, labelsPushed, errors[]}`), not a single boolean.

### Piece 2 — Register `forgejo` as a first-class provider (not just a set entry)

Rev 1 understated this to "add `forgejo` to a couple of sets." Four separate surfaces are GitHub-specific and each needs its own `forgejo` branch:

1. **Schema** (`contracts/feature-json.schema.json:96,114-121`) — the external-link `provider` enum rejects anything but its current allowed values, and field-shape rules for `repo`/`issue`/`expect`/`expect_labels` are written as GitHub-only conditionals (`push` is a separate, already-common field, not part of this conditional set). Add a `forgejo` branch with the same conditional field shape, plus `derive_expect` as a boolean **allowed only in the github/forgejo branches** (not common like `push` — see the `validateExternalArgs` bullet below for why).
2. **Citation grammar** (`lib/xref-citation.js:166` gives `owner/repo#issue` parsing only to `provider === 'github'`; everything else falls through to generic URL parsing at `:216`). Add an explicit `forgejo` branch parsing `<!-- xref: forgejo owner/repo#123 expect=open -->` the same way, not just a `RESOLVABLE_PROVIDERS` list entry.
3. **External-link identity key** (`feature-writer.js:1075-1088`) computes the dedupe/target key only for `provider === 'github'`; every other provider falls through to `undefined`, so two different Forgejo issues on the same feature would collide on the same key. Add a `forgejo` branch: key = `${provider}:${repo}#${issue}`.
4. **`validateExternalArgs`** (`feature-writer.js:995`) — add a `forgejo` branch mirroring the `github` branch (`:1002-1019`): repo format, integer issue ≥ 1, `expect` enum, `expect_labels` array. (`push` is already validated generically since it's a common field, not part of the per-provider branch.) `derive_expect` (Piece 3), by contrast, is **not** safe as a fully common field (round 5 finding): its mapping only ever produces `open`/`closed`, but a `local` link's `expect` is an uppercase feature-status value (`feature-json.schema.json:125`), so a `local` link with `derive_expect: true` would be silently nonsensical. Validate it as boolean only when `p === 'github' || p === 'forgejo'`; reject it outright for `local`/`url`/reserved providers, both in the schema conditional and here.

**MCP surface (Codex finding 7, corrected across rounds 2-3):** `roadmap_xref_push`'s tool schema (`server/mcp-tool-defs.js:395-404`) takes only `project`/`apply` — no provider parameter — and its wrapper (`server/compose-mcp-tools.js:634`) already delegates generically, so **no schema change** is needed for Forgejo there. But its public tool **description** (`mcp-tool-defs.js:398`) currently promises only GitHub/local behavior in prose, and needs updating to mention Forgejo plus the partial-success result shape from Piece 1 (`{statePushed, labelsPushed, errors[]}`), with a contract test asserting the description and the actual behavior stay in sync. `link_features` (`server/mcp-tool-defs.js:449-468`) is the real schema gap: exposes a provider enum but is missing `push`/`expect_labels`/`derive_expect` entirely (blocked on the writer plumbing fix above), so add `forgejo` to the enum and add all three fields, with contract tests. The implementer-role denial (`server/mcp-tool-policy.js:47-54`) covers only `roadmap_xref_push`, not `link_features` — state this precisely rather than implying both are denied.

**Validator degrade posture (Codex finding 8):** `runExternalRefChecks` resolves `forgejo` refs through the new transport with the *same* posture already used for GitHub — offline / no-token / rate-limit / ambiguous-non-2xx → `XREF_RESOLUTION_SKIPPED`; a confirmed 404 → `XREF_TARGET_MISSING` (error-level, not a skip). Do not collapse this distinction for the new provider.

### Piece 3 — Lifecycle → link projection, via read-time derivation (closes Codex finding 5, both rounds)

Write-time projection (rev 2's approach) requires hooking every place a feature's canonical status can change. There are at least two today (`setFeatureStatus` and `completion-gate.js`'s `persistCompleteStatus`) and no guarantee a third never appears — a projection tied to specific writer call sites is exactly the kind of thing that silently goes stale when a new writer shows up (this is why `feature-json.schema.json`'s vision-state projection is scoped as a best-effort *mirror*, tolerable to miss; a missed `expect` update here would mean an issue never closes, which isn't tolerable).

**Rev 3 instead derives the desired state at push time, not write time**, scoped to *promotion-created* links only (this is a deliberate, stated divergence from `COMP-ROADMAP-XREF-PUSH`'s locked decision #1 — "`expect=` is explicit human intent, not derived from feature status, to keep blast radius bounded and per-ref" — see rationale below):

- A promotion-created external link carries a new marker, `derive_expect: true` (alongside `push: true`, github/forgejo-only per the validator scoping above), instead of a stored `expect` value that needs to stay in sync. **This field must be plumbed through four surfaces or it is silently dropped or disagreed-upon**, confirmed against the actual code:
  1. Schema typing (`feature-json.schema.json:92` — currently untyped).
  2. `validateExternalArgs` (`feature-writer.js:995` — currently unvalidated).
  3. `linkFeatureExternal`'s entry construction (`feature-writer.js:1098` — currently copies only the fixed field list through `expect_labels`, so an unlisted field is dropped even if valid).
  4. **`runExternalRefChecks`'s normalized-ref path (round 5 finding, previously missed):** `feature-validator.js:892` currently discards fields it doesn't know about when building its normalized ref, and its no-`expect` fallback heuristic (`:917`) covers only a subset of statuses — it does not already implement the full `featureStatusToExternalExpect` mapping (missing `KILLED`/`PARTIAL`/`BLOCKED`, per round 5). Carry `derive_expect` into the normalized ref and have the validator call the *same* `featureStatusToExternalExpect` function Piece 3/`xref-push` uses, so `compose roadmap validate`'s drift check and `xref-push`'s actual push can never disagree about what a `derive_expect` link's target state should be.

  All four need the plumbing; a blueprint-level test must promote a link end-to-end (MCP `link_features` → `feature.json` → both `runExternalRefChecks` validation and `xref-push` resolution) and assert `derive_expect` survives every hop and both consumers agree, not just that the individual functions accept it in isolation.
- `xref-push.js`'s eligibility/resolution step, for a link with `derive_expect: true`: read the **current** `feature.json` status for the owning feature (already in hand — `xref-push` iterates features), compute `expect` via a new pure function `lib/status-projection.js::featureStatusToExternalExpect(status)` (`COMPLETE|SUPERSEDED|KILLED → 'closed'`; `PLANNED|IN_PROGRESS|PARTIAL|BLOCKED → 'open'`; `PARKED → null`, meaning "skip this link this run" — see Open Question 4), and push *that* value instead of reading a stored `expect` field.
- No writer needs to be hooked, no best-effort side-projection can go stale, and it's automatically correct for every current and future status-writing call site, because it reads the canonical status directly at the moment it's needed.
- A hand-authored citation (`<!-- xref: forgejo owner/repo#123 expect=open -->`, no `derive_expect`) keeps today's explicit-intent behavior unchanged — this divergence applies only to links promotion itself creates, not to the general citation mechanism.

**Rationale for diverging from the locked "expect is explicit intent" decision:** that decision was made for hand-curated GitHub citations, where a human deliberately declares "this issue should be closed" independent of any feature's lifecycle. Promotion-created Forgejo links are a different case by construction — they exist specifically to make a community-filed issue track a roadmap item's real status, so tying them to that status directly is the whole point, not an implicit side effect. The safety net (dry-run default, per-link opt-in via `push: true`, degrade-to-skip on any resolution doubt) is unchanged, so the blast-radius concern the original decision was guarding against still holds.

### Piece 4 — Triage/promotion (new)

New CLI command (sibling to `xref-sync`/`xref-push`, dispatch pattern at `bin/compose.js:1555-1583`, not `:1138`): `compose roadmap promote-issue --provider forgejo --repo <owner/name> --issue <n> --code <NEW-CODE> --phase <phase>`.

**Dry-run by default (Codex finding 2):** without `--apply`, the command performs **zero writes, local or remote** — it fetches the issue and prints the feature it would create, the link it would attach, the label it would apply, and the comment it would post. All mutation happens only under `--apply`, mirroring `xref-push.js:221`'s apply guard exactly (not "create locally always, apply externally conditionally" as rev 1 implied).

**PR guard (Codex finding 6):** before anything else, check `body.pull_request` on the fetched issue (mirrors `xref-push.js:64-79`'s existing guard) — a PR-backed record is refused with a clear error, never promoted, never labeled, never commented on.

**Retry-safe ordering (Codex finding 3, sharpened in round 2):** creating the feature (`addRoadmapEntry`, `feature-writer.js:184-186`/`:287-300`) and attaching the external link (`linkFeatures`, `:740`/`:1111`) are two separate writes, plus label-apply and comment-post. `feature-writer.js:246` treats *any* existing code as a conflict — it has no concept of "this code already exists because a prior promotion attempt got partway through," so a naive "does `feature.json` exist? then that phase is done" check cannot tell a resumed promotion apart from an unrelated code collision, and could silently attach the wrong feature to the Forgejo issue.

Fix: the feature created by promotion carries a **provenance stamp** — `{promoted_from: {provider: 'forgejo', repo, issue}}` — written in the same create call. This requires extending `addRoadmapEntry`'s typed creation path itself: it currently builds the new feature from an explicit, fixed field list and drops anything not on that list (`feature-writer.js:251-278`), so `promoted_from` needs to be added to that list (with schema typing to match) — it is not something the promotion command can smuggle in as an extra argument today. On any `promote-issue --apply` re-run for a given `--code`, the command reads the existing feature first: if `promoted_from` is absent → real conflict, refuse with a clear error (matches `feature-writer.js:246`'s existing conflict semantics); if present and it matches `--repo`/`--issue` → this is a resumed promotion, proceed to whichever phase didn't finish; if present but mismatched → refuse, this code belongs to a different promotion. Link existence (per repo#issue key), label presence (fresh fetch), and comment presence (stable hidden marker `<!-- compose-promotion:<code> -->`) are each checked before their respective write, same as before.

**Description safety (Codex finding 10):** the issue title (normalized to a single line, control characters stripped) becomes the feature's `description` — never the raw issue body. `roadmap-gen.js:22-26` escapes pipes but not newlines, so a multi-line body would corrupt the roadmap table if used directly. The full contributor-authored body is preserved separately (a `notes` field on the feature, or a linked file under the feature folder), never injected into the description cell.

## Open Questions

1. The label call shape is decided (`POST .../labels`, additive-only — round 5 replaced the earlier read-union-`PUT` design because it raced with concurrent human edits). What remains is deployment verification: confirm `git.smartmemory.ai`'s `/api/v1/version` supports this endpoint as documented before the transport calls it; fail closed (skip the label write, still complete state/comment writes) if it doesn't.
2. Acceptance label name — `roadmap-tracked`, or does the instance already have a triage-label convention to fit into (e.g. removing a `needs-triage` label as well as adding one)?
3. Auth scope needed on the Forgejo PAT for issue read/write + label read/write — confirm scope names for that instance's version.
4. Confirm the `featureStatusToExternalExpect` mapping in Piece 3 (especially the `PARKED → null` choice) matches intent before implementing — this determines when contributor-visible issues actually close.
