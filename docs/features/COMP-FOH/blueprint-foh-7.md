# Blueprint — FOH-7 PORTFOLIO (one brain across products)

**Related documents**
- Design: [design-foh-7.md](design-foh-7.md) (D-FOH-7-1..9, scope fences, acceptance criteria)
- Progress + owner gate: [foh-7-progress.md](foh-7-progress.md)
- Predecessor: [blueprint-foh-6.md](blueprint-foh-6.md), [design-foh-6.md](design-foh-6.md)
- Epic anchor: [design.md](design.md)

Grounded 2026-09-06 by two independent readers (Codex on the backend seams, an explorer on the UI
and error surfaces). Every reference below was read, not inferred.

---

## Corrections table

The Phase 4 gate. **Nine of the design's premises did not survive contact with the code**, and three of
them change what gets built rather than merely where.

| # | Design assumed | Reality | Consequence |
|---|---|---|---|
| C1 | `unauthorized` is classified from a propagated `X-SM-Scope-Error` header | **No header handling exists.** `SmartmemoryHttpError` retains only `status` and `kind` (`lib/smartmemory-client.js:61-67`); the error conversion discards response headers (`:207-222`) | Either build header retention, or drop the criterion to "403 classified as `unauthorized`, reason undetermined". **Scope decision required — see D1 below.** |
| C2 | "the existing composer already caps at 35s" (Risk 2's basis for bounding fan-out) | The 35s `withDeadline` wraps **only** the three focused findings calls (`lib/colleague/context.js:29-32`, `:135-150`). It does not wrap provider construction, `findIdea`, unfocused `listRecords`, or the Maya chat (120s, `lib/maya-client.js:44-51`) | There is **no whole-turn bound to inherit.** An N-member fan-out needs its own explicit deadline. |
| C3 | Fluid config is read at `lib/maya-config.js:45` | That is a **lenient second reader** that swallows malformed JSON as `{}` (`:16-52`) and only ever looks at `fluid.smartmemory.workspaceId` and `fluid.provider`. The authoritative validating reader is `lib/fluid/factory.js:35`, which raises `FluidConfigError` (`lib/fluid/provider.js:200-206`) | `portfolio` MUST be parsed in `factory.js`, not `maya-config.js`. Parsing it in the lenient reader would make a malformed portfolio silently absent — the same two-readers failure just fixed in COMP-IDEABOX-MIGRATE-DIALECT. |
| C4 | Workspace-collision validation is extended to cover members | There is **no distinct-workspace check to extend.** The collision guard compares one identity claim against one configured workspace (`server/maya-routes.js:176-205`, `lib/maya-identity.js:197-201`); the factory does not reject two roots pointing at the same SmartMemory workspace | The member-collision check is **new code**, not a widened loop. |
| C5 | `capability-short` is a fifth omission reason | A missing capability produces **no omission at all, deliberately**: `section()` returns `null` before the try when `!ctx.provider.has(capability)` (`lib/colleague/context.js:136-138`). Structural absence is owned by the capability strip | **A contract change, not an extension.** Argued separately in D2 below. |
| C6 | The findings accordion's author allowlist is the trap to avoid | It is, and the exact-equality filter is confirmed (`ColleaguePanel.jsx:126-127`) — but there are **two more the design never names**: `key={b.author}` (`:140`) and `key={o}` on omissions (`:161`) both produce **duplicate React keys** when N sources emit the same author or the same failure prose, and `sent` is built with no dedup (`server/maya-routes.js:335`, `:398`) so the header renders "conviction · conviction · conviction" | Three defects, not one. |
| C7 | The panel can present results grouped by source | The accordion renders a **flat list with no grouping affordance** (`ColleaguePanel.jsx:138-146`) and reads only the **last** Maya message's blocks (`:562`) | Grouping is new UI, and the owner gate ruled group-by-source, so it is required rather than optional. |
| C8 | `misconfigured` is "a named funnel, never a silent downgrade" (D-FOH-7-8) | `handleTurnError` funnels **only** `auth` and `offline` (`ColleaguePanel.jsx:275-287`). Eight of ten kinds land as one line of inline chat text. **But `misconfigured`, `connect-smartmemory` and `workspace-collision` already have funnel views built** (`:573`, `:582`) — reachable only from `status.state` (`:496`), never from a turn error | Cheaper than designed: **wiring that exists but is not connected**, not a new screen. |
| C9 | `ColleaguePanel.jsx:240` (writeback default), `:432` (save-unconfirmed warning) | `:247` and `:436` | Line drift only. |

### Confirmed as designed

- The composer never calls `recall()` and never receives `text` (`lib/colleague/context.js`, `server/maya-routes.js:211`). D-FOH-7-8's turn contract is correctly scoped as new work.
- Maya's boundary really is flat `Array<{author, text}>`, sent directly as `channel_context` (`lib/maya-client.js:83-97`). The two-projection requirement stands.
- `RecallHit` is exactly `{handle, score, record}` with the provider's score passed through untouched (`lib/fluid/provider.js:89-109`, `lib/fluid/smartmemory-provider.js:1228-1260`). No source attribution exists. Group-by-source remains the only honest presentation.
- `fluidProviderFor(cwd)` has no cache or singleton (`lib/fluid/factory.js:85-87`); N independent providers for N roots are mechanically supported.
- `discoverWorkspaces()` is a bounded filesystem scanner (`lib/discover-workspaces.js:65-80`) used for workspace resolution and MCP inventory. Confirmed a false friend; not membership.
- `context.omissions` is the codebase's only named-partial-failure channel, wired end to end (`lib/colleague/context.js:101`, `server/maya-routes.js:336`/`:399`, `ColleaguePanel.jsx:154-165`). FOH-7 extends it.

---

## Two decisions this blueprint needs before implementation

**D1 — `unauthorized` classification (from C1). REVERSED at the blueprint gate.** The first draft
proposed classifying any 403 as `unauthorized` with the reason undetermined, on the grounds that
retaining headers would widen the blast radius across every SmartMemory caller. **That was wrong, and
the gate caught it.** The transport boundary already has the headers — `headers: res.headers` is
returned at `lib/smartmemory-client.js:141` — and `asHttpError` (`:207-222`) simply does not carry them
forward. Adding one optional normalized field to `SmartmemoryHttpError` is *additive*: no existing caller
reads a field that does not yet exist, so no existing behaviour changes. The design's criterion
distinguishes two different recovery actions ("you are not a member" vs "your key lacks scope"), which
is worth one field. **Retain and classify**, specified concretely so this does not stay an intention:

- `SmartmemoryHttpError` gains `scopeError: string | null` — the normalized `X-SM-Scope-Error` value,
  set in `asHttpError` (`lib/smartmemory-client.js:207-222`) from the headers already returned at `:141`.
  Optional and defaulted to `null`, so every existing caller is unaffected.
- Mapping, exhaustive: a 403 whose `scopeError` says the caller is not a member of the workspace →
  omission reason **"not a member"**; a 403 whose `scopeError` names a missing scope → **"key lacks
  scope"**; a 403 with no recognised `scopeError` → **"reason undetermined"**, never silently one of the
  other two.
- Tests: `test/smartmemory-client.test.js` pins header retention through `asHttpError` (present,
  absent, and unrecognised); `test/fluid-portfolio.test.js` pins one omission per branch, including the
  unknown one.

**D2 — `capability-short` (from C5).** Today a member lacking `recall` would contribute silently and the
capability strip would explain it — except the strip describes the DECLARING root, and a portfolio member
is not the declaring root, so nothing would explain it at all. That is the silent-omission failure the
whole feature is built to avoid. **Recommend making it an omission for members only**, leaving the
declaring root's behaviour untouched. This is a contract change and is called out as one — but the
gate is right that the blast radius above overstated it: it lives entirely in the portfolio result
contract, and ordinary `composeColleagueContext` stays **byte-identical**, pinned by test.

---

## Boundary Map

| Symbol | Kind | Slice | Depends on |
|---|---|---|---|
| `PortfolioMember` (new) | type | S0 | — |
| `parsePortfolioConfig` (new) | function | S0 | — |
| `FluidConfigError` | class | S0 | untouched (`lib/fluid/provider.js:200`) |
| `fluidProviderFor` | function | S1 | untouched (`lib/fluid/factory.js:85`) |
| `PortfolioSource` (new) | type | S1 | `PortfolioMember` from S0 |
| `PortfolioResult` (new) | type | S1 | `PortfolioSource` from S1 |
| `openPortfolio` (new) | function | S1 | `parsePortfolioConfig` from S0 |
| `recallAcrossPortfolio` (new) | function | S1 | `openPortfolio` from S1 |
| `composeColleagueContext` | function | S2 | `recallAcrossPortfolio` from S1 |
| `composePortfolioContext` (new) | function | S2 | `recallAcrossPortfolio` from S1 |
| `assertMemberWorkspacesDistinct` (new) | function | S3 | `openPortfolio` from S1 |
| `attachMayaRoutes` | function | S3 | `composePortfolioContext` from S2 |
| `FindingsAccordion` | component | S4 | — |
| `ContextNote` | component | S4 | — |
| `ColleaguePanel` | component | S4 | `FindingsAccordion` from S4, `attachMayaRoutes` from S3 |

Endpoint shapes, the omission vocabulary, and the two projections are specified in prose below rather
than as Boundary Map entries, per the template.

---

## Slices

### S0 — Config: `portfolio.members` (new)

**File:** `lib/fluid/factory.js` (existing) — the authoritative reader, per C3.

- `portfolio` absent → **exact FOH-6 behaviour preserved**, no portfolio state constructed.
- `portfolio.members[]`, each `{ id, root }`. `id` unique; duplicate `id` → `FluidConfigError`.
- `root` resolved relative to the declaring root; unresolvable → `FluidConfigError`.
- **A member must contain `.compose/compose.json`, not merely a `.compose/` directory.** An empty
  `.compose/` would otherwise pass and fall through to the local provider, contributing an empty corpus
  that looks like a product with no ideas rather than a misconfiguration. Per the design, a member root
  that is not a Compose project is `misconfigured`, **never silently skipped**.
- **The declaring root must list itself explicitly** to be part of its own portfolio
  (`design-foh-7.md:137-142`). Membership is a declared list, and inferring self-membership would be the
  discovery D-FOH-7-2 forbids — but omitting it silently excludes the one corpus the user is looking at,
  so its absence is worth a distinct, named diagnostic rather than a silent smaller result.
- Cap membership at a documented maximum well under the substrate's 100 (`auth_repository.py:730`).

**Not** parsed in `lib/maya-config.js` — see C3.

### S1 — The aggregator (new)

**File:** `lib/fluid/portfolio.js` (new). Sits **above** the provider seam (D-FOH-7-3); it is not a
`FluidProvider` and must not be registered as one.

- `openPortfolio(root)` constructs one provider per member via `fluidProviderFor(memberRoot)`,
  concurrently. Construction failure for a member is an **omission**, never a turn failure.
- `recallAcrossPortfolio(portfolio, query, opts)` fans out with `Promise.allSettled`, each member under
  its own deadline — **explicit, because there is no ambient one to inherit (C2)**.
- Returns `PortfolioResult`: `{ sources: PortfolioSource[], omissions: string[] }`, where each
  `PortfolioSource` is `{ id, root, hits: RecallHit[] }`. **`root` is carried, not just `id`**
  (`design-foh-7.md:180-206`): two products can hold the same handle, and the id alone is a label the
  user chose while the root is the thing that disambiguates. Scores are **passed through untouched and
  never merged across sources** — grouping is the presentation, per the owner gate and `provider.js:89`.
- **All members failed → an error, never an empty result set** (design acceptance criterion).
- A storage-only member contributes **listed, not searched** records plus a named `recall unavailable`
  omission, and never a synthesized query result.

### S2 — The composer (existing)

**File:** `lib/colleague/context.js` (existing).

- `composeColleagueContext(ctx, { focusId, scope, text })` — `scope` and `text` are new parameters;
  absent `scope` must be **byte-identically** today's behaviour (pinned by test).
- `composePortfolioContext` uses the turn `text` as the recall query (D-FOH-7-8) and emits one block per
  source, each carrying `source`.
- **Omissions extend the existing prose channel** (C5 note): each names its member id, which
  incidentally fixes the `key={o}` collision in C6. Reuse existing wording where it exists — the panel
  already says "SmartMemory unreachable" (`RecallTab.jsx:29`).
- Follow the shape precedent at `server/health-routes.js:85-113` (per-section availability rendered by
  name); the difference is dynamic rather than fixed cardinality.

### S3 — The turn (existing)

**File:** `server/maya-routes.js` (existing).

- Read `scope` from the request body alongside `text` and `focusId` (`:163-170`).
- **`scope` is a closed enum: absent, `'project'`, or `'portfolio'`. Anything else is refused as
  `invalid`.** Without this a typo (`portoflio`) falls through to a project-scoped answer — the exact
  silent downgrade D-FOH-7-8 exists to forbid, arriving through the door left open by not validating.
- `scope: 'portfolio'` + `focusId` → **refused**.
- `scope: 'portfolio'` with no `portfolio` declaration → `misconfigured`, **never a silent downgrade**.
- **A present `portfolio` that omits its own declaring root is also `misconfigured`**, with its own
  message. Without this the S0 rule has no production path: a `FluidConfigError` raised during
  composition currently lands in the generic `context` funnel (`server/maya-routes.js:210`), which tells
  the user nothing about membership. Tested through the **real route**, not an injected composer —
  otherwise the mapping is exactly the kind of wiring that passes its test and is dead in production.
- **The forwarding seam.** The route reaches composition through the injected `defaultComposeContext`
  wrapper (`server/maya-routes.js:70-73`), which today passes only `{ focusId }`. That wrapper must
  forward **all three** of `{ focusId, scope, text }`. This is the single most likely place for the
  feature to be built, tested, and still dead: S2 can be correct and S3's tests can pass against an
  injected stub while the production wrapper drops `scope` on the floor.
- `assertMemberWorkspacesDistinct` — **new** (C4). Every SmartMemory member's workspace is checked
  against **Maya's identity workspace**. **Member-vs-member distinctness is deliberately NOT imposed:**
  the first draft added it, and the gate correctly identified it as invented policy. The existing
  invariant is identity-vs-workspace only (`lib/maya-identity.js:187-201`, `design-foh-7.md:369-375`),
  and two explicitly declared products may legitimately share one workspace. Adding that rule would
  refuse a valid configuration on our opinion rather than on a design requirement.
- **The two projections, pinned by test, stated exactly:**
  - Maya receives `Array<{author, text}>` and nothing else, because `lib/maya-client.js:83-97` sends
    `channel_context` verbatim and its schema is flat. **The source must therefore survive inside
    `text`, in prose** — a projection that drops nested `source` and adds nothing hands Maya two
    identical handles from two products with no way to tell them apart. A test asserting "no nested
    `source` reaches Maya" would pass while doing exactly that.
  - The panel receives `{author, text, source: {id, root}}`.
  - **Pinned by a test that fails if source is dropped.** Both real transports forward
    `context.blocks` directly (`server/maya-routes.js:318` JSON, `:385` SSE), so the test drives **both**
    with two sources emitting blocks of identical author AND identical body, and asserts three things:
    the Maya-bound request contains only the keys `author` and `text`; each `text` carries its source's
    `id` and `root`; and the panel-bound response retains structured `source`. Asserting only "no nested
    `source` reaches Maya" passes when source is simply dropped, which is the failure being guarded
    against — the assertion has to be that the identity SURVIVED, not that the field is absent.
- `sent` must be **deduped** (C6) — `:335` and `:398`.
- Portfolio paths perform **no writes** (D-FOH-7-6), pinned by test.

### S4 — The panel (existing)

**File:** `src/components/colleague/ColleaguePanel.jsx` (existing).

- `FindingsAccordion` groups by `source` (C7) and keys on a composite of source + author, not `author`
  alone (C6). `ContextNote` keys omissions on index or a composite, not the string.
- Portfolio scope **clears focus and disables the writeback toggle** client-side; the backend is already
  safe (`server/maya-routes.js:231`). No "save unconfirmed" warning can arise on a portfolio turn — that
  warning fires at `:436` (not `:432`, per C9).
- The findings allowlist must still match every findings block once `source` is a sibling field rather
  than an author suffix (`:126-127`).
- **Connect the existing funnel views — but parameterize them first** (C8, corrected at the gate). The
  wiring is genuinely missing and cheap, but the copy is not generic: the `misconfigured` view states
  that "the `maya` block ... has no `baseUrl`" (`:573-579`). Routing a portfolio configuration error
  into it sends the user to fix a setting that is not the problem, which is worse than the inline text
  it replaces. Either parameterize the funnel's body or add a portfolio-specific case; connecting them
  as-is is not an option.
- **No new cockpit tab** — portfolio is a scope of a turn (design scope fence).

---

## Test plan

Homes are established; each slice lands in the file that already owns that seam.

| Slice | File | Harness |
|---|---|---|
| S0, S1, S2 | `test/colleague-context.test.js` (existing) | node:test, stub provider |
| S1 | `test/fluid-portfolio.test.js` (new) | node:test, real local providers over temp roots |
| S3 | `test/maya-routes.test.js` (existing) | node:test + real Express, deps injected via `attachMayaRoutes` (`server/maya-routes.js:114-128`) |
| S4 | `test/ui/colleague-panel.test.jsx` (existing) | vitest + jsdom + RTL, `wsFetch` mocked |

**S3 must exercise the REAL composer path, not only the injected stub.** `attachMayaRoutes` injects
fourteen dependencies, which makes the route trivially testable and makes it trivially possible to test
a route whose production wiring is dead: every S3 assertion can pass against a stub composer while
`defaultComposeContext` (`server/maya-routes.js:70-73`) silently drops `scope`. So S3 carries either a
test through the default composer path, or an explicit assertion that the injected composer receives all
three of `{focusId, scope, text}`. This is the one place in the plan where a green suite would prove
nothing.

Corrected at the gate: **`capability-short` does NOT need the live-fire.** A temporary local-floor member
deterministically proves "listed, not searched" plus the named `recall unavailable` omission in the S1
harness — the local provider genuinely lacks the capability, so the condition is real rather than
simulated. Only two criteria actually need the SmartMemory setup the owner authorized: the live
cross-product turn and the mixed-provider portfolio. Those are the live-fire gate at the end of S4.

## Scope fences carried forward, verbatim

No portfolio SmartMemory workspace is created. No cross-workspace edge writes are attempted. No writes at
all. Not a new `FluidProvider`. `discoverWorkspaces()` is not membership. CALIBRATION stays out. No new
cockpit tab.

---

## Verification table (Phase 5)

Every reference in this blueprint was re-read on disk 2026-09-06, independently of the two agents that
produced them. **Zero stale entries.**

| Reference | Claim | Verified |
|---|---|---|
| `lib/smartmemory-client.js:61-67` | `SmartmemoryHttpError` keeps only `status`, `kind` | yes — constructor sets exactly those |
| `lib/colleague/context.js:29-32` | `CAPABILITY_TIMEOUT_MS = 35000`, a section-level net | yes — comment reads "Safety net over the client-level deadlines" |
| `lib/colleague/context.js:136-138` | capability absence returns `null` before the try | yes — `if (!ctx.provider.has(capability)) return null;` |
| `lib/colleague/context.js:101` | omissions typed on the return | yes |
| `lib/maya-client.js:83-97` | `channel_context: [{author, text}]`, sent verbatim | yes — and documented as travelling verbatim |
| `lib/fluid/provider.js:89-109` | `RecallHit` = `{handle, score, record}`, score untouched | yes — "passed through untouched", score a sibling of record |
| `lib/fluid/provider.js:200-206` | `FluidConfigError` | yes — "Never swallowed" |
| `lib/fluid/factory.js:85-87` | `fluidProviderFor(cwd, opts)`, no cache | yes |
| `server/maya-routes.js:163-170` | reads `text`, `focusId`; no `scope` | yes |
| `server/maya-routes.js:171-174` | activation gate returns `connect-smartmemory` | yes |
| `server/maya-routes.js:114-128` | every dependency injected — the test seam | yes — 14 injected defaults |
| `server/maya-routes.js:335`, `:398` | `sent` built with no dedup | yes — `context.blocks.map((b) => b.author)` at both |
| `lib/discover-workspaces.js:65-80` | bounded FS scanner, not membership | yes |
| `ColleaguePanel.jsx:126-127` | exact-equality author allowlist | yes |
| `ColleaguePanel.jsx:140`, `:161` | `key={b.author}`, `key={o}` | yes — both present |
| `ColleaguePanel.jsx:247` | writeback default (design said `:240`) | yes — corrected in C9 |
| `ColleaguePanel.jsx:436` | save-unconfirmed warning (design said `:432`) | yes — corrected in C9 |
| `ColleaguePanel.jsx:275-287` | `handleTurnError` funnels `auth`/`offline` only | yes |
| `ColleaguePanel.jsx:573`, `:582` | funnel views exist, status-reachable only | yes |
| `ColleaguePanel.jsx:241-242` | `focusOverride` tri-state | yes — comment documents all three states |
| test homes | all three files exist | yes |

**Boundary Map validation:** `validateBoundaryMap` → `ok: true`, 0 violations, 0 warnings.

---

## Gate log

**Round 1 (Codex terra/high) — 8 findings, all accepted.** Two reversed decisions made in the first
draft: D1 (classify 403s vaguely rather than retain headers — the headers were already at the transport
boundary, so the cost I was avoiding did not exist) and C8's "the funnel views just need wiring" (their
copy is specific to the Maya `baseUrl`, so connecting them as-is would send the user to the wrong fix).
One invented policy removed: member-vs-member workspace distinctness, which the design does not require
and which would refuse a legitimate configuration. Five gaps closed: `scope` enum validation, `root` on
`PortfolioSource`, `.compose/compose.json` over `.compose/`, the declaring root listing itself, and the
`defaultComposeContext` forwarding seam.

**Round 2 — 3 findings, all accepted.** Every one had the same shape: a round-1 fix stated as an
intention rather than an executable contract. D1 named no field, no mapping, no tests. The two-projection
requirement had no test that would fail if source were dropped. The declaring-root rule had no production
error path, so it would have surfaced as the generic `context` funnel. All three now specify the field,
the branch, the route, and the assertion.

Round 2 confirmed the declaring-root rule is consistent with D-FOH-7-2's no-discovery fence (it validates
an explicit list, never infers from the filesystem) and found no remaining assumption that member
workspaces must be distinct.

**Round 3 not run.** The round-2 fixes are specification tightening against findings already adjudicated
— naming a field, stating an assertion, mapping an error to an existing kind. They introduce no new
design surface for a third pass to review, and the review budget caps at three rounds precisely so a gate
does not become a place to keep polishing. The blueprint is ready to implement from.
