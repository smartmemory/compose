# Design — FOH-7 PORTFOLIO (one brain across products)

**Status:** DRAFT r3 — self-adversary pass + **two Codex design gates, 12 findings, all accepted and
folded in** (r1: 3 P1/3 P2; r2 on the fixes: 3 P1/3 P2). Pending **owner gate** — see §Open for the
gate. Per the review-loop budget (~3 rounds), r3 goes to the owner rather than a third Codex pass:
the two open items are owner calls, not defects.
**Feature:** COMP-FOH FOH-7. **Mode:** build, full lifecycle.
**Depends on:** FOH-1/2 (provider + RECALL), FOH-3/4/5 (challenge/conviction/contradiction),
FOH-6 COLLEAGUE-PANEL @3ea4be4 (the consumer this extends).
**Related:** [design.md](design.md) §Open questions Q1 + §Scope topology, [architecture.md](architecture.md)
§Q1 (isolation adopted, rollup deferred), [foh-6-progress.md](foh-6-progress.md) (slice template).

## What this slice is

The ceiling framing calls it *"one brain across all products — a lesson from building one product
becomes a prior for the next; insight cross-pollinates instead of dying in a silo"*
([discovery-loop-vision.md:67](../../product/2026-07-20-discovery-loop-vision.md)). Today each
product is a sealed box: the colleague panel's "whole ideabox" mode means *all ideas in the current
project*, never all products. This slice makes a colleague turn able to draw on N products at once.

`design.md:110` names cross-workspace as the **only one of SmartMemory's three gaps that is
load-bearing** for the Discovery Loop. This is that gap.

## The open fork is RESOLVED BY SUBSTRATE — not by preference

`design.md:120` posed it as an open question: *"build cross-workspace rollup above SmartMemory, or
model portfolio as its own tenant/workspace with references down?"*

**Option (b) — portfolio-as-its-own-workspace with references down — buys nothing and costs more.**
Verified in SmartMemory source (2026-08-12), then **corrected at the design gate** — the first draft
of this section claimed structural impossibility, which was overstated. The accurate position:

- **Native graph edges across workspaces are unavailable to Compose.** The edge write matches both
  endpoints against one workspace (`falkordb.py:853`; bulk `:521`) and the service resolves both
  endpoints through current scope first (`links.py:19`, `secure_smart_memory.py:3544`).
  Escape hatches exist but are **internal-only and deliberately unexposed**: `is_global=True` skips
  workspace matching (`falkordb.py:490`), and `graph_bulk.py:8-15` states outright that it is
  *"intentionally NOT exposed via REST … must never be triggered by external API callers."*
  Raw Cypher likewise has no REST route (verified: no cypher route module exists). Compose is an
  external REST caller, so these are closed to it — but the constraint is a **supported-API
  boundary, not a law of the substrate**.
- **A stored foreign id IS followable** — this is the gate's correction. `{workspaceId, itemId}` in
  opaque metadata (`memory_item.py:65`) can be dereferenced by a *second* client call rebound to
  that workspace (`smartmemory-client.js:156`, `:315`). Not a graph traversal, but functional.

So option (b) is not dead, and — **corrected again at gate r2 (P2)** — it is not *dominated* either.
My r1 fix replaced an overstated impossibility claim with an overstated dominance claim; both were
the same error of pushing a true observation past its evidence. The accurate version:

A curated or indexed pointer set **can** be cheaper on reads. One scoped lookup in the portfolio
workspace, then `K` targeted item reads, costs `1 + K` calls where `K` may be far smaller than `N`
(`smartmemory-client.js:319`, `:338`, `:418`). For a narrow query against many products, that beats
fanning out over every member.

**D-FOH-7-1: rollup-above wins on a genuine trade-off, not by elimination.** What it buys:

- **no write side** — a pointer index must be *maintained*, and every maintenance path is a new way
  for the portfolio to lie about what exists
- **no staleness** — a fan-out reads live product state by construction; an index is only as true as
  its last update
- **no second canon** — the epic's whole canon story is fluid-vs-committed; a pointer index is a
  third thing that must be kept true against both
- **it works on the actual corpus today** — a pointer index needs a producer *and* a populated
  corpus; with N=1 populated product (Risk 1) there is nothing to index

What it costs: `N` calls on every portfolio turn, where a curated index could sometimes do fewer.
Accepted for v1 — correctness and zero maintenance over read efficiency at small N. **Re-open when N
is large enough that fan-out latency is felt**, which is a measurable trigger, not a matter of taste.

*Also not eliminated (self-adversary pass):* a portfolio workspace holding **synthesized content**
(digests, cross-product theses) rather than pointers. A different feature — needs a producer, a
staleness story, a crystallization rule — and *downstream* of this slice, since you must read across
products before you can synthesize across them. Named as a follow-up, not a rejected alternative.

The other half of `design.md:120` was already resolved: [architecture.md](architecture.md) §Q1
adopted workspace-per-product isolation and **rejected** the shared-pool alternative, explicitly
noting the rollup would then be *"purely additive — a new read-side component"*. This slice is that
additive component, built exactly as §Q1 predicted.

## Substrate constraints (verified, do not re-derive)

| Constraint | Evidence | Consequence for this slice |
|---|---|---|
| One request carries **one** workspace id. No id-list, no tenant-wide flag, no "all my workspaces" mode. | `auth/scope.py:81` normalizes a single scalar; `secure_smart_memory.py:724` *pops* any caller-supplied `workspace_id` | Portfolio = **N calls, merged client-side**. There is no server-side fan-out to ask for. |
| Cross-workspace edges impossible | `falkordb.py:853` | D-FOH-7-1 above |
| Workspace enumeration EXISTS | `GET /memory/teams` → `team_id[]` (`routes/teams.py:158`); `/auth/me` gives only `default_team_id` (`auth.py:703`) | We *can* discover which workspaces a credential may read — useful for validation, **not** as the membership source (see D-FOH-7-2) |
| One credential spans N workspaces **within one tenant**, given membership | `jwt_provider.py:166` builds full membership context; `X-Workspace-Id` is per-request (`AuthCore.js:86`) | Constrains **one member's** reach, not the portfolio's shape — each member carries its own credential. See D-FOH-7-7 (this row previously said cross-tenant must fail loud; that was wrong and is corrected there). |
| Membership load capped at 100 rows | `auth_repository.py:730` | Not a v1 concern; note it. |
| Unauthorized workspace → **403** with `X-SM-Scope-Error` | `auth/scope.py:161`, `:55` | A misconfigured member is distinguishable from an unreachable one. Map it to its own funnel, never a silent skip. |
| Personal-scope items already cross workspaces | `scope_provider.py:248` OR-clause | A pre-existing, narrow cross-workspace read — same-user personal items only. Not a portfolio mechanism; do not build on it. |

## Compose-side gaps (verified, all ABSENT today)

From the parallel read-only inventory of this repo:

- **No project registry.** `discoverWorkspaces()` (`lib/discover-workspaces.js:65`) is a *directory
  scanner*, not a product registry — from `/Users/ruze/reg` it anchors at `$HOME` and returns 32
  candidates including scratch and throwaway dirs (measured 2026-08-12). `set_workspace` binds one
  process to one directory, in memory, lost on restart (`compose-mcp-tools.js:804`).
- **No source attribution.** `RecallHit` is `{handle, score, record}` (`provider.js:89`) — no
  workspace, no product. Merged blind, results become unattributable.
- **No collision safety.** `IDEA-42` can exist in every product. Handles are project-scoped and
  nothing namespaces them.
- **No cross-provider merge contract** — no score normalization, dedup, or ordering across sources.
- **No per-source partial-result envelope.** The convention exists but only *within* one provider
  (`context.js:135` omissions).
- **No portfolio code of any kind.** Every `portfolio` / `cross-workspace` hit in the repo is design
  prose or unrelated (`vite.config.js` = the Rollup bundler; `select.jsx` = `ScrollUp`). The one live
  test containing "cross-workspace" proves *isolation on project switch*, not aggregation
  (`test/ui/smartmemory-recall.test.jsx:185`).

## Design decisions

### D-FOH-7-2: Portfolio membership is an EXPLICIT declared list, never discovery

Discovery answers *"where are there `.compose` dirs"*. Portfolio membership answers *"what are my
products"*. Those are different questions and the measurement above shows how far apart: 32
directory candidates vs. a handful of real products. A portfolio built from a filesystem scan would
silently ingest `compose-lab`, `compose-develop`, and a dozen scratch repos into the colleague's
worldview — polluting exactly the thing this slice exists to make trustworthy.

Membership is a curated statement, declared in `.compose/compose.json` of the project you are
sitting in:

```jsonc
{
  "portfolio": {
    "members": [
      { "id": "compose",    "root": "." },
      { "id": "scalemate",  "root": "../../ScaleMate" }
    ]
  }
}
```

- Roots resolve relative to the declaring project root. Absolute permitted.
- `id` is the **portfolio-local** product identity and the attribution label. Required, unique —
  a duplicate `id` is a `FluidConfigError`, not a silent last-wins.
- Absent `portfolio` block → the panel behaves exactly as FOH-6 does today (single product). The
  block's presence is the feature switch, matching the `maya`-block precedent (`maya-routes.js:136`).
- The declaring project **must** list itself to be included. No implicit self-membership: an
  explicit list that silently gains a member it does not name is the same trust bug as discovery.

**Rejected: a machine-level `~/.compose/portfolio.json`.** Compose deliberately keeps no machine-level
registry (the only `~/.compose` use is a version cache, `version-check.js:1`), and a portfolio is a
statement about a body of work, which belongs in a tracked file that survives a machine.

**Disclosed cost:** N declaring projects each carry their own list — duplication if the owner wants a
symmetric portfolio from every product. v1 accepts it. A shared/extends form is a named follow-up,
not scope here.

### D-FOH-7-3: The rollup sits ABOVE the provider seam, so members may use DIFFERENT providers

Each member resolves through its **own** `.compose/compose.json` → its own `fluidProviderFor(root)`
→ its own provider and workspace id. The portfolio layer never reaches into SmartMemory scoping
directly and never assumes a member is SmartMemory-backed.

This is not incidental. Of the eight Compose projects on this machine, **zero** have a `fluid` block
— all are on the local floor. A portfolio layer that required SmartMemory everywhere would be
unusable on the actual corpus. Above the seam, a local-floor member contributes its records while
its conviction/challenge sections report as unavailable — the existing capability convention, now
applied per member.

**Consequence for `COLLEAGUE-ALL-IN` — made explicit at the design gate.** The ruling stands: the
colleague hard-requires SmartMemory for *intelligence*. What the draft left unsaid is **which**
member must supply it. The shipped gate checks the *declaring* root only —
`hasSmartmemoryFluidProvider(root)` refuses the colleague entirely otherwise
(`maya-routes.js:169`, `:262`). v1 keeps exactly that rule:

| declaring root | members | v1 behavior |
|---|---|---|
| SmartMemory | any mix | colleague opens; local members contribute records, their intelligence sections omitted by name |
| local floor | any, incl. SmartMemory members | `connect-smartmemory` funnel, unchanged — **the portfolio does not rescue a local declaring root** |
| all local | — | funnel, correctly |

Rescuing a local declaring root via a SmartMemory member is rejected for v1: it would make the
colleague's availability depend on a *list*, so adding or removing a member could silently switch the
whole panel on or off.

### D-FOH-7-4: Every portfolio result is source-attributed at the envelope, never flattened

Results are `{ source: { id, root }, ...hit }` — attribution attached at merge time by the layer that
knows the source, never inferred downstream. Rationale is correctness, not tidiness: with
`IDEA-42` live in two products, a flattened list is *actively wrong* — it invites the colleague to
reason about two different ideas as one.

**How source reaches the colleague blocks — revised at the design gate.** The draft proposed
suffixing the author (`compose:conviction scalemate`). That silently breaks the shipped UI: the
findings accordion filters on an **exact allowlist** of `compose:conviction`, `compose:contradiction`,
`compose:challenge` (`ColleaguePanel.jsx:127`), so every suffixed block would vanish from the panel —
findings computed, paid for, and never shown.

v1 instead carries source as a **structured field on the block** (`{author, text, source}`), leaving
the author grammar untouched so the existing accordion keeps matching.

**TWO PROJECTIONS, not one block shape — corrected at gate r2 (P1).** A structured `source` cannot go
on the wire to Maya: `channel_context` is typed `List[Dict[str, str]]` (`maya/…/routes.py:3241`), so a
nested object violates her schema, and she formats only `author` and `text` regardless
(`routes.py:718`). Today the relay passes `context.blocks` through unchanged
(`maya-routes.js:318`, `:383`) and the client serializes them directly (`maya-client.js:142`), so the
projection must be explicit:

| consumer | shape | source carried as |
|---|---|---|
| Maya (`channel_context`) | `{author, text}` — flat strings only | inside `text` (prose, which is what she reads) |
| Compose panel (response `context.blocks`) | `{author, text, source}` | the structured field |

The response path already preserves full blocks for the panel (`maya-routes.js:392`), so only the
Maya-bound projection is new work. **A blueprint that emits one shape for both breaks Maya's
validation.**

`compose:idea <handle>` is different: its author is already dynamic and is **not** on the accordion
allowlist (it is context, not findings), so qualifying it to `compose:idea scalemate/IDEA-42` is
safe and is adopted.

### D-FOH-7-5: Partiality is the normal case, and every absent source is NAMED

One unreachable product must never fail a portfolio turn — but it must never vanish either. Each
member read is independently wrapped with a per-source deadline, and each failure becomes a named
omission carrying the member id and the reason class:

- `unreachable` — transport/timeout
- `unauthorized` — SmartMemory 403 (`X-SM-Scope-Error` present); the credential lacks membership
- `misconfigured` — bad root, missing/invalid fluid config, unreadable declaration
- `capability` — member reachable, that capability undeclared

**Two contract CHANGES this requires — corrected at the design gate, which caught the draft calling
them "precedent":**

1. **Undeclared capability is currently NOT a named omission.** `section()` returns `null` outright
   when `has(capability)` is false (`context.js:137`); only *runtime failures* become omissions.
   That is deliberate — absence is structural and the panel's capability strip owns it. But a strip
   showing one global capability map cannot express *"conviction works for compose, not for
   scalemate"*. So per-member capability absence must become visible somewhere new. v1: name it as
   an omission (the `capability` class above), and leave the global strip alone.
2. **`X-SM-Scope-Error` must be propagated — status-only classification is unsound.**
   `SmartmemoryHttpError` keeps only `status`/`kind` and drops response headers
   (`smartmemory-client.js:61`, `:207`). The draft recommended deriving `unauthorized` from HTTP 403
   alone; **gate r2 falsified that (P2).** Recall goes through `POST /memory/search`
   (`smartmemory-client.js:418`), SmartMemory maps every POST to a *write* scope action
   (`auth/scope.py:203`), and an API key without that scope gets 403 with
   `X-SM-Scope-Error: insufficient_api_key_scope` — a different failure from the membership 403
   (`auth/scope.py:161`). Status alone therefore cannot tell *"this product isn't yours"* from
   *"your key can't search"*, and those need different owner actions.

   v1 propagates the header and classifies on it. This does widen a module three shipped features
   depend on, so the change is **additive only**: a new optional field on the error, no change to
   `status`/`kind` or to any existing branch. A 403 with no recognizable header stays
   `unauthorized` with the reason named as undetermined — never silently reclassified.

The *shape* of the convention still comes from `composeColleagueContext` (concurrent reads, preserve
survivors, name what is missing) — but it is being **extended**, not merely imitated.

A portfolio turn where *every* member failed is **not** an empty answer — it is an error. Returning
"nothing found across your products" when nothing was actually read is the exact lie the seam's
no-emulation rule exists to prevent.

### D-FOH-7-8: The turn contract — how a portfolio question actually reaches the panel

**Added at the design gate (P1).** The draft specified a portfolio *read layer* and never said how a
colleague turn invokes it — which would have let this slice ship as a **dark API**, the exact failure
FOH-3/4/5 hit (three capabilities shipped with zero production callers until FOH-6). Making one real
turn cross-product is the point of the slice, so the contract belongs here, not in the blueprint.

The shipped path proves the gap: the panel posts `{text, focusId, writeback}`
(`ColleaguePanel.jsx:289`), and the composer receives **only `focusId`** — the user's `text` never
reaches it, and it **never calls `recall()`** (`context.js:105`, `maya-routes.js:211`). So today
there is no query to fan out and no scope to fan out over.

v1 contract:

- **Portfolio is an explicit turn scope, not automatic.** The request gains `scope: 'project' |
  'portfolio'` (default `'project'` — absent field = today's behavior, byte-identical). Automatic
  promotion is rejected: silently widening a turn to N products changes what the colleague is
  reasoning about without the owner asking.
- **The turn `text` becomes the recall query** for portfolio-scoped turns. This is a real change —
  `text` must now be passed into context composition, which it is not today — and it is the wiring
  that makes `CAP.RECALL` a production capability for the first time.
- **Focus becomes source-qualified.** `focusId` alone is ambiguous the moment two products both hold
  `IDEA-42` (D-FOH-7-4 explicitly permits this). A focused portfolio turn carries
  `{sourceId, handle}`; a bare `focusId` keeps its current project-local meaning.
- **v1 ships portfolio turns UNFOCUSED only.** Focused-across-products is where writeback ambiguity
  lives (focused turns default to writing back — `maya-routes.js:231`), and D-FOH-7-6 forbids
  portfolio writes. Refusing focused+portfolio in v1 keeps that contradiction unreachable rather
  than relying on a runtime guard.

**Panel state when portfolio scope is selected — settled at gate r2 (P2).** The panel follows the
selected idea and defaults writeback on (`ColleaguePanel.jsx:240`), derives its writeback expectation
from that focus at send time (`:297`), and warns *"save unconfirmed"* when a terminal writeback event
never arrives (`:432`). Selecting portfolio scope while an idea is selected would therefore either
hit the mandated refusal or produce a false unconfirmed-save warning. Contract:

- Selecting portfolio scope **clears effective focus and disables the writeback toggle in the UI**,
  so the client never forms a writeback expectation it cannot satisfy. The backend is already safe
  (`writebackEnabled` requires `focusId` — `maya-routes.js:231`); this keeps the *client* honest too.
- `scope: 'portfolio'` with **no `portfolio` declaration** is `misconfigured` — a named funnel, never
  a silent downgrade to a project-scoped turn. A turn the owner asked to span their products must
  not quietly answer from one.

**What an unfocused portfolio turn actually contains — settled at gate r2 (P1).** The draft said
"local members contribute records while their intelligence is omitted", which is not implementable
as written: the local floor declares **storage only** (`local-provider.js:83`) and undeclared
`RECALL` **throws** by design (`provider.js:534`, no-emulation per `PROVIDER-SEAM`). Meanwhile the
shipped unfocused branch never reaches any capability section at all — it lists recent records and
returns (`context.js:112`). So "recall across members" and "unfocused turn" did not meet anywhere.

Per member, by declared capability — no invention left to the implementer:

| member declares | contributes on an unfocused portfolio turn |
|---|---|
| `RECALL` | ranked hits for the turn query, source-attributed |
| storage only (local floor) | its **recent records**, labelled in-band as *listed, not searched* — and a **named omission** `recall unavailable (local floor)` |

The floor's contribution is a *list*, never a query result, and is never presented as if it answered
the question. That is the no-emulation rule honored, not bent: nothing fabricates a search the floor
cannot do. A query approximation over the floor (substring matching, fake scores) is **explicitly
forbidden** — it is exactly the "real-looking result produced by machinery that does not exist" the
factory's own header rejects (`factory.js:12`).

**Findings on unfocused turns stay out of v1.** Conviction/challenge/contradiction are per-record
reads; running them across N members × K hits is an unbounded fan-out with no owner-set budget. v1
unfocused portfolio turns carry records and recall hits only, and the panel's findings accordion
stays empty for them — consistent with the shipped composer, which also produces no findings when
unfocused (`context.js:112`).

### D-FOH-7-6: Read-only in v1 — no cross-product writeback

FOH-6's writeback targets one root and one focused handle (`writeback.js:69`). A portfolio answer
synthesized from N products has no single target record, and inventing one (a "portfolio note"
record) would need a new store, a new kind, and a crystallization story. Out of scope, named as a
follow-up. Focused single-product turns keep their existing writeback unchanged.

### D-FOH-7-7: Same-tenant is NOT a constraint — each member carries its own credential

**Corrected at the design gate.** The first draft asserted a portfolio-wide same-tenant
precondition. That is false *under this design's own model*: because each member resolves through
its own root's config, `fluidProviderFor(root)` reads that project's own `baseUrl` and `apiKeyEnv`
(`factory.js:116`) and builds its own client (`smartmemory-provider.js:384`). One portfolio can
therefore read tenant A with credential A and tenant B with credential B. Local-floor members have
no tenant at all.

The true statement is narrower: **one credential** spans N workspaces only within its own tenant and
membership set (`jwt_provider.py:201`, `:440`). That constrains a single member's reach, not the
portfolio's shape.

**Decision: impose nothing.** Members are independently configured and independently authenticated;
cross-tenant portfolios are permitted because nothing technical forbids them and no owner policy
asks for it. A member whose credential cannot reach its workspace surfaces as `unauthorized`
(D-FOH-7-5), which is the correct and already-needed handling.

*If* the owner wants same-tenant as a **trust policy** (a reason to exist would be avoiding
accidental blending of a client's corpus with an internal one), it needs an explicit decision plus a
definition of credential/tenant comparison — and note there is no config-time tenant lookup today
(`smartmemory-provider.js:392` validates locally only, before constructing the client). Raised for
the gate, not assumed.

### D-FOH-7-9: Member roots are a TRUST boundary — two guards are mandatory

**Added at gate r2 (P1).** Permitting cross-tenant members (above) is only safe once the act of
naming a member root is recognized as privileged. A member entry causes Compose to load *that*
root's config and read *its* named credential from the ambient environment
(`factory.js:116`, `smartmemory-provider.js:392`), then feed the combined corpus to the **declaring**
root's Maya endpoint (`maya-routes.js:221`, `:383`). A declaring repo can name any path
(`../../anything`, absolute) — so an untrusted `compose.json` could enlist a corpus the owner never
meant to expose and ship it to its own colleague. Classic confused deputy.

Two guards, both blueprint-mandatory:

1. **Workspace-collision validation must cover EVERY SmartMemory member, not just the declaring
   root.** FOH-6's shallow-binding invariant refuses a colleague token whose workspace equals the
   fluid workspace (VERIFY-3), but the shipped guard takes exactly one `fluidWorkspaceId`
   (`maya-identity.js:187`) supplied only from the declaring root (`maya-routes.js:191`, `:283`). A
   member sharing Maya's identity workspace therefore slips past a guard that FOH-6 shipped
   specifically to catch it. **The collision check becomes set-valued.** This is a real regression
   risk against a shipped invariant, not a new nicety.
2. **A member root must be readable only by the owner's own consent.** v1 rule: member roots resolve
   **only** to paths the declaring project can already reach and the owner has declared by hand —
   the declaration is the consent, and it is why D-FOH-7-2 refuses discovery. The blueprint must
   additionally refuse a member root that is not a Compose project (no `.compose/compose.json`), and
   surface it as `misconfigured` rather than silently skipping it.

*Scope note:* this makes `portfolio.members` a security-relevant config key. It is not a reason to
narrow the feature — it is a reason the blueprint cannot treat member roots as ordinary paths.

## Scope fences (verbatim, for the blueprint)

- **No portfolio SmartMemory workspace is created.** D-FOH-7-1 killed the topology that would need it.
- **No cross-workspace edge writes are attempted** — the substrate refuses them; a "best-effort" try
  would be a known-failing call.
- **No writes at all** (D-FOH-7-6).
- **Not a new FluidProvider.** The portfolio is a consumer-side aggregator over N providers. Making it
  a provider would imply a store it does not have, and would put fan-out below the seam where
  capability semantics are per-workspace.
- **`discoverWorkspaces()` is a false friend** — it is used for cockpit project switching and must not
  be repurposed as membership (D-FOH-7-2).
- **CALIBRATION stays out**, unchanged from FOH-6 — still blocked upstream ("no subject").
- **No new cockpit tab.** Extend the existing colleague panel; portfolio is a *scope* of a turn, not a
  second surface.

## Risks

1. **The corpus is N=1 today.** Only this repo has fluid records (39); the other seven Compose projects
   have zero, holding pre-migration `ideabox.md` files instead. Cheap to fix — `ensureIdeaboxMigrated`
   (`lib/ideabox-cli.js:50`) converts on first ideabox command — but until a second product is
   populated, this slice cannot be live-fired meaningfully and its value cannot be felt. **This is the
   one risk that should gate the go/no-go, and it is a population problem, not a design problem.**
2. **N HTTP round trips per turn.** No server-side batching exists (`graph_read.py:72` batches node ids
   *within* one workspace only). Concurrent with per-source deadlines; the existing composer already
   caps at 35s (`context.js:32`). Portfolio turns are inherently slower — bound it, disclose it.
3. **Score comparability across sources.** `RecallHit.score` is *"the provider's relevance score, passed
   through untouched"* (`provider.js:89`). Scores from two different SmartMemory workspaces are
   probably comparable; a local-floor score and a SmartMemory score are **not**. v1 must not present a
   single globally-ranked list as if it were calibrated — group by source, or rank within source.
   Cross-source normalization is a real problem and is explicitly not solved here.
4. **Membership cap of 100** (`auth_repository.py:730`) — far beyond v1, noted so it is not rediscovered.

## Acceptance criteria

- [ ] `portfolio.members` parsed and validated; duplicate `id` and unresolvable `root` fail loud as
      `FluidConfigError`; absent block preserves exact FOH-6 single-product behavior
- [ ] N member providers constructed concurrently, each via its own `fluidProviderFor(root)`
- [ ] A portfolio recall returns source-attributed results; two identical handles in two products
      remain distinguishable (pinned by test)
- [ ] A member that is unreachable / unauthorized / misconfigured / capability-short yields a **named**
      omission and does not fail the turn (pinned by test, one per reason class)
- [ ] All-members-failed returns an error, never an empty result set (pinned by test)
- [x] Mixed-provider portfolio works: SmartMemory declaring root + local-floor member in one turn,
      with the local member's intelligence sections omitted **by name** (D-FOH-7-3 table)
- [ ] A **local declaring root still funnels** even with SmartMemory members declared (pinned by test —
      the portfolio must not rescue it)
- [x] `scope: 'portfolio'` reaches the composer, the turn `text` is used as the recall query, and
      **one real colleague turn returns cross-product findings** — not a dark API (D-FOH-7-8)
- [ ] Absent `scope` behaves byte-identically to today's turn (pinned by test)
- [ ] `scope: 'portfolio'` + a `focusId` is **refused** in v1 (pinned by test)
- [ ] Source reaches the panel as a structured block field; the findings accordion's existing author
      allowlist still matches every findings block (pinned by test — the suffix trap)
- [ ] **Two projections pinned:** Maya receives flat `{author, text}` only (no nested `source` — her
      schema is `List[Dict[str, str]]`), the panel receives `{author, text, source}` (pinned by test)
- [ ] A storage-only member contributes **listed, not searched** records plus a named
      `recall unavailable` omission — and never a synthesized query result (pinned by test)
- [ ] **Workspace-collision validation covers every SmartMemory member**, not only the declaring root
      (pinned by test — a member colliding with Maya's identity workspace must be refused)
- [ ] A member root that is not a Compose project is `misconfigured`, never silently skipped
- [ ] `unauthorized` is classified from the propagated `X-SM-Scope-Error`, distinguishing
      "not a member" from "key lacks scope"; an unrecognizable 403 names the reason as undetermined
- [ ] Portfolio scope clears focus and disables the writeback toggle client-side; no
      "save unconfirmed" warning can arise on a portfolio turn (pinned by test)
- [ ] `scope: 'portfolio'` with no `portfolio` declaration is `misconfigured`, never a silent
      downgrade to a project-scoped answer (pinned by test)
- [ ] No writes on any portfolio path (pinned by test)
- [x] Live-fire on a genuinely populated second product — **unblocked 2026-09-06** (owner gate: migrate
      forge-top's ideabox as the second product, and stand up a SmartMemory-backed declaring root)
      — **PASSED 2026-09-06**, evidence in [livefire-foh7/](livefire-foh7/RESULTS.md); two defects found and fixed

## Owner gate — RESOLVED 2026-09-06

1. **Go/no-go given N=1 → BUILD, after populating a second product.** Migrate forge-top's
   `docs/product/ideabox.md` (18 ideas) through `ensureIdeaboxMigrated` so the portfolio fans out over
   two genuinely populated products rather than a corpus of one.

2. **Result presentation → GROUP BY SOURCE** (the design's own recommendation). A single ranked list
   would imply a cross-source score calibration that does not exist (`provider.js:89` passes the
   provider's score through untouched).

3. **Same-tenant trust policy → NO POLICY.** Cross-tenant membership is permitted, per D-FOH-7-7 and
   guarded by D-FOH-7-9. Membership is an explicit declared list (D-FOH-7-2), so inclusion is already
   a deliberate act. No tenant lookup is added.

### Correction to Risk 1 found at gate time (2026-09-06)

Risk 1 named the corpus as the blocker. **The corpus was not the only blocker — it was the only one
this design wrote down.** Verified at gate time:

- Compose's own `.compose/compose.json` declares **no `fluid` block**, so
  `hasSmartmemoryFluidProvider()` (`lib/maya-config.js:52`) is false for this repo.
- `server/maya-routes.js:171` refuses every colleague turn with `connect-smartmemory` **before** any
  identity or upstream work. On this repo today no colleague turn runs at all.
- The 39 records are therefore **local-floor** records under the tracked
  `docs/product/fluid/records/` (`DEFAULT_RECORDS_ROOT`, `record-store.js:66`) — 32 `idea` + 7
  `cluster`.
- FOH-6's live-fire ran against a **throwaway provisioned tenant** on a local stack;
  `livefire-foh6/RESULTS.md` records the tenants as deleted and the tokens dead, and
  `fluid-identity.json` is absent.

Consequence: migrating a second product yields local + local, and a local declaring root still funnels
(the design's own pinned acceptance criterion). The live-fire additionally requires a SmartMemory-backed
declaring root — a provisioned tenant, Maya running on :9005, and a `fluid.provider: smartmemory` block.
**Owner authorized that full setup at the gate.** Recorded here so the next reader does not re-derive it.
