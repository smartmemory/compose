# FOH-7 PORTFOLIO — progress ledger

**Feature:** COMP-FOH FOH-7 — one colleague view across N products. The rollup layer
[architecture.md](architecture.md) §Q1 deferred as "purely additive, build when a real consumer
exists".
**Status:** DESIGN r3 — **two Codex design gates run, 12 findings, all 12 accepted.** r1 (3 P1/3 P2)
on the draft; r2 (3 P1/3 P2) on the r1 fixes. Awaiting **owner gate** — the two remaining items are
owner calls, not defects. Review-loop budget says stop at ~3 rounds; a third Codex pass would be
ceremony.

## Owner decisions
- **Slice pick (2026-08-12):** portfolio rollup, chosen over the exhaust loop. Owner was presented
  both with the design fork disclosed; picked portfolio knowing it starts with a design gate.

## The §120 fork — RESOLVED BY SUBSTRATE, not preference

`design.md:120` asked: rollup-above vs. portfolio-as-its-own-workspace-with-references-down.
**Option (b) is structurally impossible.** A graph edge requires both endpoints in the same
workspace (`smart-memory-core/.../falkordb.py:853`, bulk path `:521`); the service resolves both
endpoints through current scope first (`links.py:19`, `secure_smart_memory.py:3544`). A foreign
item id survives only as opaque metadata (`memory_item.py:65`) — undereferenceable, untraversable
(`secure_smart_memory.py:1993`, `:1951`). A portfolio workspace of "references down" is a workspace
of dead strings.

Recorded as **D-FOH-7-1**. Re-open only if SmartMemory ships cross-workspace edges.
*Not* eliminated: a portfolio workspace holding synthesized/copied content (a different feature,
downstream of this one — you must read across products before you can synthesize across them).

## Substrate facts (Codex read-only investigation, 2026-08-12, run 53c7997b1862)

- **One request = one workspace id.** `auth/scope.py:81` takes a scalar; `secure_smart_memory.py:724`
  *pops* any caller-supplied `workspace_id`. No id-list, no tenant flag, no all-workspaces mode.
  → Portfolio is necessarily N calls merged client-side. There is no server fan-out to request.
- **Enumeration exists:** `GET /memory/teams` → `team_id[]` (`routes/teams.py:158`), needs
  `include_system=true` for system teams. `/auth/me` gives only `default_team_id` (`auth.py:703`).
- **One credential spans N workspaces within ONE tenant** (`jwt_provider.py:166`, `:399`);
  `X-Workspace-Id` is per-request (`AuthCore.js:86`). Cross-tenant is impossible → D-FOH-7-7.
- **403 on non-member workspace**, with `X-SM-Scope-Error` header (`auth/scope.py:161`, `:55`).
- **Personal-scope items already cross workspaces** (`scope_provider.py:248` OR-clause) — narrow,
  same-user only. Not a portfolio mechanism.
- Membership load capped at 100 rows (`auth_repository.py:730`) — far beyond v1, noted.

## Compose-side facts (Codex read-only inventory, 2026-08-12, run 61a6beb36e46)

Everything a portfolio needs is ABSENT: no project registry, no source attribution on `RecallHit`
(`provider.js:89`), no handle collision safety, no cross-provider merge contract, no per-source
partial envelope, no portfolio code at all. Every `portfolio`/`cross-workspace` repo hit is design
prose or a false positive (`vite.config.js` = Rollup bundler, `select.jsx` = `ScrollUp`); the one
live "cross-workspace" test proves *isolation on project switch*
(`test/ui/smartmemory-recall.test.jsx:185`).

Best precedent to imitate: `composeColleagueContext` itself (`lib/colleague/context.js:135`) —
concurrent reads, skip undeclared capabilities, name every failure, preserve survivors. The
portfolio layer is that same convention one level up.

## Measured, not assumed (2026-08-12)

- **`discoverWorkspaces()` is unfit as a membership source.** Measured from `/Users/ruze/reg`: it
  anchors at `$HOME` and returns **32 candidates**, including `compose-lab`, `compose-develop`, and
  a dozen scratch repos. From `my/forge` it returns 5. It answers "where are `.compose` dirs", not
  "what are my products". → D-FOH-7-2 (explicit declared membership).
- **The corpus is N=1.** Of 8 Compose projects on this machine, only `compose` has fluid records
  (39). The other 7 hold pre-migration `ideabox.md` and **zero** fluid records. All 8 lack a `fluid`
  block → all on the local floor → the Maya panel is in its `connect-smartmemory` funnel everywhere.
  This is the go/no-go risk: the slice cannot be felt or live-fired until a second product is
  populated. `ensureIdeaboxMigrated` (`lib/ideabox-cli.js:50`) converts on first ideabox command,
  so the fix is cheap — but it is a real precondition, not a footnote.
- Consequence for D-FOH-7-3: a portfolio requiring SmartMemory per member would be unusable on the
  actual corpus → the rollup sits above the seam and tolerates mixed providers.

## Design gate r1 (Codex sol/xhigh, run af9b411ca0b2) — NOT READY, 6/6 accepted

Verdict was correct on every count; I verified each against source before accepting (Codex is
high-recall, not high-precision — two of its citations needed narrowing, noted below).

**P1-1 — D-FOH-7-1 was overstated.** I claimed cross-workspace references were *structurally
impossible* and the pointers would be "dead strings". Both wrong:
- A stored `{workspaceId, itemId}` **is followable** by a second scoped client call
  (`smartmemory-client.js:156`, `:315`). Not traversal, but functional.
- Escape hatches exist (`is_global=True`, `falkordb.py:490`).
- *My narrowing:* those hatches are **REST-unexposed by design** — `graph_bulk.py:8-15` says
  *"intentionally NOT exposed via REST … must never be triggered by external API callers"*, and I
  verified no raw-Cypher route module exists. So they are closed to Compose. The constraint is a
  **supported-API boundary**, not a substrate law.
- Rewritten as a **dominance** argument, which survives: following a pointer costs one scoped call
  per foreign workspace — exactly what the rollup costs — so option (b) buys **no read efficiency**
  while owing a write side, staleness, and a second canon.
- **Lesson:** "impossible" claims need the exposure surface checked, not just the enforcement code.
  I had the `falkordb.py:853` evidence right and drew too strong a conclusion from it.

**P1-2 — D-FOH-7-7's same-tenant precondition was FALSE under my own D-FOH-7-3.** Each member
resolves through its own root's config, so each carries its own `baseUrl`/`apiKeyEnv`
(`factory.js:116`, `smartmemory-provider.js:384`) — one portfolio can read tenant A with credential
A and tenant B with credential B. The true claim is narrower: **one credential** spans N workspaces
within its own tenant (`jwt_provider.py:201`, `:440`). Now imposes nothing; same-tenant is offered as
an optional *trust policy* for the owner, not a constraint. Two decisions in one design contradicted
each other and I did not catch it.

**P1-3 — no turn contract: the slice could have shipped as a DARK API.** The highest-value finding.
I specified a read layer and never said how a turn invokes it. The panel posts
`{text, focusId, writeback}` (`ColleaguePanel.jsx:289`) and the composer gets **only `focusId`** —
the user's `text` never arrives and `recall()` is never called (`context.js:105`). So there was no
query to fan out. This is the exact FOH-3/4/5 failure (capabilities shipped with zero callers) and
`feedback_review_loops_catch_unwired` predicts it. Added **D-FOH-7-8**: explicit `scope` field,
`text`-as-query, source-qualified focus, portfolio turns unfocused-only in v1.

**P2-4 — I called two contract CHANGES "precedent".** Undeclared capability is *not* a named
omission today — `section()` returns `null` (`context.js:137`); only runtime failures are named. And
`X-SM-Scope-Error` is **unreachable above the seam**: `SmartmemoryHttpError` keeps only
`status`/`kind` and drops headers (`smartmemory-client.js:61`, `:207`), so `unauthorized` must be
derived from HTTP 403 alone in v1.

**P2-5 — the author-suffix would have silently blanked the findings UI.** The accordion filters on an
**exact** allowlist (`ColleaguePanel.jsx:127`), so `compose:conviction scalemate` would be computed,
paid for, and never displayed. Source now rides as a structured block field; author grammar
untouched. (`compose:idea <handle>` is already dynamic and not on the allowlist, so qualifying it is
safe.)

**P2-6 — mixed-provider activation vs COLLEAGUE-ALL-IN was unspecified.** The shipped gate checks the
**declaring** root only (`maya-routes.js:169`, `:262`). v1 keeps that: a local declaring root still
funnels even with SmartMemory members, because otherwise the panel's availability would depend on a
list and adding/removing a member could silently switch the whole colleague on or off.

## Design gate r2 (Codex sol/xhigh, run df6407dada41) — NOT READY, 6/6 accepted

Round 2 reviewed **the r1 fixes**, per `feedback_review_round2_targets_fixes`. It earned its keep:
four of six findings are defects my r1 fixes *introduced*.

**P1-1 — cross-tenant permission (my r1 fix) opened a real trust hole, and left a contradiction.**
Two parts:
- *Contradiction:* the substrate table still said cross-tenant "must fail loud" while D-FOH-7-7 now
  permitted it. Fixed — the table row was mine and stale.
- *Trust hole (the substantive part):* naming a member root makes Compose load **that root's config
  and its ambient credential** (`factory.js:116`, `smartmemory-provider.js:392`) and ship the
  combined corpus to the **declaring** root's Maya (`maya-routes.js:221`, `:383`). A declaring repo
  can name any path. **Worse: it defeats a shipped FOH-6 invariant** — the workspace-collision guard
  takes exactly one `fluidWorkspaceId` (`maya-identity.js:187`) from the declaring root only
  (`maya-routes.js:191`), so a member sharing Maya's identity workspace slips past the very guard
  VERIFY-3 shipped to catch. Added **D-FOH-7-9**: set-valued collision validation + member-root
  consent rules. `portfolio.members` is a security-relevant key.

**P1-2 — "local members contribute records" was not implementable.** The floor declares storage only
(`local-provider.js:83`) and undeclared `RECALL` throws by design (`provider.js:534`); the shipped
unfocused branch never reaches a capability section at all (`context.js:112`). So "recall across
members" and "unfocused turn" never met. Settled with a per-capability table: `RECALL` members give
ranked hits, floor members give **listed, not searched** records plus a named omission. A query
approximation over the floor is explicitly forbidden — that is the no-emulation rule, honored rather
than bent. Findings (conviction/challenge/contradiction) stay out of unfocused turns: N members × K
hits is unbounded fan-out with no budget.

**P1-3 — my structured `source` field breaks Maya's wire schema.** `channel_context` is
`List[Dict[str, str]]` (`maya/…/routes.py:3241`); a nested object violates it, and she formats only
`author`/`text` anyway (`routes.py:718`). The relay passes blocks through unchanged
(`maya-routes.js:318`). Now **two explicit projections**: flat `{author,text}` to Maya with source in
the prose, `{author,text,source}` retained for the panel (already preserved at `maya-routes.js:392`).
Note this is the *second* time source-attribution encoding broke a downstream consumer — r1 caught
the UI allowlist, r2 caught Maya's schema.

**P2-4 — my status-only 403 recommendation was unsound.** Recall is `POST /memory/search`
(`smartmemory-client.js:418`), SmartMemory maps every POST to a **write** scope action
(`auth/scope.py:203`), and a key lacking it gets 403 with `insufficient_api_key_scope` — distinct
from the membership 403 (`auth/scope.py:161`). Status alone cannot separate "this product isn't
yours" from "your key can't search", and those need different owner actions. Now propagates the
header, additively (new optional field; no change to `status`/`kind` or existing branches).

**P2-5 — panel state on scope switch was undefined.** The panel follows the selected idea, defaults
writeback on (`ColleaguePanel.jsx:240`), and warns "save unconfirmed" on a missing terminal event
(`:432`) — so portfolio+selected-idea yields either the refusal or a false warning. Now: portfolio
scope clears focus and disables the writeback toggle client-side (backend was already safe via
`maya-routes.js:231`), and `scope:'portfolio'` without a declaration is `misconfigured`, never a
silent downgrade to a one-product answer.

**P2-6 — the dominance claim was also overstated.** A curated/indexed pointer set costs `1 + K` calls
where `K < N`, so it CAN be cheaper for narrow queries (`smartmemory-client.js:319`, `:338`, `:418`).
**This is the same error twice:** r1 caught "structurally impossible", and my fix replaced it with
"dominated" — both pushed a true observation past its evidence. Now an honest trade-off (no write
side, no staleness, no third canon, works at N=1) with a **measurable** re-open trigger: when
fan-out latency is felt at larger N.

*Gate r2 confirmed sound:* the `is_global`/raw-Cypher narrowing (REST-unexposed, `graph_bulk.py:8`,
`:65`; no caller-supplied Cypher route exists), and that the activation gate reads the declaring
root's `fluid.provider` (`maya-config.js:45`, `maya-routes.js:171`).

**Standing lesson for this epic:** every one of my three overstatements was a strong claim built on
correct evidence — "impossible", "dominated", "unambiguous". The evidence was never wrong; the
quantifier was. Check the exposure surface and the alternative's best case before writing an absolute.

## Artifacts

- [design-foh-7.md](design-foh-7.md) — the design r3 (D-FOH-7-1..9, scope fences, acceptance criteria)

## Open for the owner gate

Both gates independently reached the same conclusion on (1): *"populate a real second product before
authorizing implementation."*

1. **Go/no-go given N=1** — build now against one populated product, or populate a second first?
   Only one of 8 Compose projects has fluid records (39); the rest hold pre-migration `ideabox.md`.
2. **Result presentation** — group-by-source vs. single ranked list. Recommendation: group-by-source;
   `RecallHit.score` is passed through untouched (`provider.js:89`) so local-floor and SmartMemory
   scores are not comparable, and a single ranked list would imply a calibration we do not have.
3. **(new, from D-FOH-7-7)** Same-tenant as an optional **trust policy** — not required technically,
   but it would prevent accidentally blending, say, a client's corpus with an internal one. Costs a
   config-time tenant lookup that does not exist today. Default if you say nothing: **no policy**,
   cross-tenant permitted, guarded by D-FOH-7-9.

---

## Owner gate RESOLVED — 2026-09-06

All three questions answered. Recorded in full in [design-foh-7.md](design-foh-7.md#owner-gate--resolved-2026-09-06).

1. **Go/no-go → BUILD**, after migrating forge-top's ideabox (18 ideas) as a genuine second product.
2. **Presentation → group by source** (the design's own recommendation).
3. **Trust policy → none**; cross-tenant permitted, guarded by D-FOH-7-9.

Owner additionally authorized the **full live-fire setup** (provision a throwaway tenant, run Maya on
:9005, point this repo at a SmartMemory-backed declaring root).

### Risk 1 was understated — found at gate time, not by the design

The design named the corpus (N=1) as the go/no-go blocker. Verification at gate time found a second,
unwritten blocker sitting in front of it: **this repo has no `fluid` block at all**, so
`server/maya-routes.js:171` refuses every colleague turn with `connect-smartmemory` before anything
else runs. The 39 records are local-floor records, and FOH-6's live-fire ran on a throwaway tenant whose
credentials are dead. Populating a second product alone would have produced local + local, which the
design's own pinned test says must still funnel.

**Lesson, and it is the fourth instance of this epic's standing lesson.** The three earlier ones were
overstated *claims* ("impossible", "dominated", "unambiguous"). This one is the inverse and more
dangerous: an **understated risk**. Risk 1 was true, specific, and cited real evidence — and it was
still the wrong quantifier, because it enumerated the blockers the design had thought about rather than
the blockers between here and the acceptance criterion. A risk register is only as good as its
completeness, and completeness is exactly what a design cannot self-assess. **Check what stands between
the work and its own acceptance criterion, not what the risk section already lists.**
