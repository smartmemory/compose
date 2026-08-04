# COMP-FOH — Architecture

**Status:** Proposed — pending gate approval
**Epic:** COMP-FOH
**Date:** 2026-08-04
**Input:** 3 competing `compose-architect` proposals (minimal-changes, clean-architecture, pragmatic-balance), synthesized below. Full proposals retained in session transcript, not reproduced here — this doc is the resolved decision, not a comparison table.

## Related Documents

- Design: [design.md](design.md) — the two open questions this doc resolves are named there (Sequencing section).
- Sibling in-flight: [COMP-PLAN-IDEA-UNIFY](../COMP-PLAN-IDEA-UNIFY/design.md) (S1+S2+**S3a** shipped and pushed @5cfe013; S3b + S4 open) — this architecture builds strictly on top of its fluid-store provider seam, does not duplicate it.
- Ruling: [what-to-build-vision.md §8k](../../product/2026-07-20-what-to-build-vision.md) — `PROVIDER-SEAM`, `BUNDLE-IS-SUGAR`, `COLLEAGUE-ALL-IN`.

## What all three proposals agreed on (adopted outright, not re-litigated)

1. **Transport: HTTP, extending `lib/smartmemory-client.js`.** Not MCP (that's Compose's outward agent-tool surface, a different consumer than a typed storage adapter — `server/compose-mcp-tools.js` already establishes that pattern in the other direction). Not in-process (SmartMemory is a separate Python/FalkorDB service; embedding it would contradict `BUNDLE-IS-SUGAR` and break byte-identical degrade). This matches the shipped `COMP-SMARTMEMORY-INGEST` transport and Maya's own HTTP-adapter pattern (`maya/server/maya/adapters/base.py`).
2. **New component: `lib/fluid/smartmemory-provider.js`.** A `FluidProvider` subclass (implementing `lib/fluid/provider.js`'s existing interface) that fills the reserved-but-stubbed branch at `lib/fluid/factory.js:91` (`if (name === 'smartmemory')` currently hard-fails with "configured but not yet implemented" — this is S1's deliberate placeholder, D6). This is the one unavoidable new module regardless of how Q1/Q3 resolve.
3. **Git-crystal boundary needs no change.** Verified two real call sites — `bin/compose.js:3260` (CLI `compose ideabox promote`) and `server/ideabox-routes.js:152` (HTTP `POST /api/ideabox/ideas/:id/promote`) — both call `writeFeature()` (`lib/feature-json.js`) to create the committed `feature.json`, then mark the source idea promoted via `lib/ideabox.js:524 promoteIdea()`. This ordering (git-canon write first, fluid-side mark second) is already correct: a `feature.json` missing its promotion backlink is a recoverable provenance gap; a fluid record marked "promoted" whose feature was never created is a lie. Once COMP-PLAN-IDEA-UNIFY S4 lands (`promoted_to` graph edge), swap the second step's direct markdown mutation for `provider.updateRecord()` + `provider.addLink()` — same ordering, same two call sites, no new boundary.
   *(Note: the CLI and HTTP paths are two independent implementations of the same promotion logic today — not a proposal artifact, a real minor duplication worth a follow-up, not blocking this feature.)*
4. **Hat catalog (Q4) is not architecture-relevant.** Reuses the existing gate/flag/skip autonomy dial and SmartMemory's own `provisional → promote` ontology mechanism — no new component. Catalog contents are a product decision, not a boundary decision.

## Resolved: Q1 — Portfolio / cross-workspace topology

**Decision: workspace-per-product isolation (not a shared pool), rollup orchestrator deferred until a real consumer exists.**

This synthesizes the two-way split in the proposals:

- **Rejected: shared single workspace with tag-only filtering** (the minimal-changes proposal). It's the cheapest option and "portfolio just works" as a side effect of not filtering — but it directly weakens the isolation `design.md:84` already states as a property ("Each product → its own workspace... Isolated"), and it reintroduces the shape of a bug class SmartMemory has already shipped and had to fix once (`CORE-SCOPE-2`, a cross-workspace leak via user-scope fallback — now tested and guarded, but a real precedent, not hypothetical risk). Trading a stated invariant for implementation convenience isn't the right call for a memory substrate meant to hold decisions and conviction.
- **Adopted: one SmartMemory workspace per product**, scoped via the `X-Workspace-Id` header — the same header pattern Maya's `self_scoped_adapter()` already uses (`maya_self/store.py:98-117`). This is what `SmartMemoryFluidProvider` does per-instance: real container isolation.

  > **CORRECTED 2026-08-04 at blueprint time (owner ruling, option (a) — see [blueprint.md](blueprint.md) C4).** This bullet originally said the workspace was "keyed by the *already-shipped* `resolveProjectTag()`/`deriveId()` … zero new identity scheme". That is false: the service validates the supplied workspace against the authenticated principal's memberships and returns **403** on a mismatch (`validate_team_membership`, `scope.py:145`), so a locally derived project tag is not a usable workspace id and nothing provisions one. FOH-1 therefore takes an explicitly configured `fluid.smartmemory.workspaceId` and fails loud when it is absent; `resolveProjectTag()` is not used. **The isolation decision itself is unaffected** — only its mechanism was under-specified.
- **Deferred, not built now: the cross-workspace rollup orchestrator** (`lib/fluid/portfolio.js` in the clean-architecture proposal). A repo-wide grep found zero code consumers of "portfolio" today — only two design docs. Building a fan-out/merge layer above N workspace-scoped providers for a capability nobody calls yet is exactly the premature abstraction the design doc's own "Sequencing (minimal-first, not yet sliced)" section warns against, and matches the substrate ruling's own framing of portfolio as a "parked rider." Because isolation is real from day one (previous bullet), adding the rollup later is purely additive — a new read-side component that calls `discoverWorkspaces()` + per-workspace `fluidProviderFor()` and merges — no migration, no re-tagging.

**Net effect:** COMP-FOH's stated north star ("one brain across products") is not reachable from the first slice alone. That's disclosed, not hidden — it becomes buildable the moment a real cross-product colleague session needs it, on unchanged foundations.

## Resolved: Q2 — Transport detail (typed CRUD surface)

Beyond the agreed HTTP-reuse (above), `lib/smartmemory-client.js` currently only has `health`/`ingest`/`search` — sufficient for the kitchen's unstructured-content ingest, not for typed fluid records (an `idea` with `status`/`priority`/`links`/`cluster` fields would be lossily flattened through `ingest()`'s free-text path). The pragmatic-balance proposal did the deepest verification here, citing SmartMemory's actual typed CRUD routes: `smart-memory-service/memory_service/api/routes/crud.py` — `POST /add` (:373), `GET /entities` (:637), `GET /{item_id}` (:863), `PATCH /{item_id}` (:1003), `DELETE /{item_id}` (:1198). *(The clean-architecture proposal flagged it had not verified this wire contract — pragmatic's grounding is adopted over that gap.)*

**Decision:** extend `lib/smartmemory-client.js` in place with `createEntity`/`getEntity`/`updateEntity`/`deleteEntity` against this route family, reusing the existing auth/timeout/error-shape conventions. `SmartMemoryFluidProvider` calls these, not `ingest()`, for record CRUD.

## Component boundaries

```
CLI (compose ideabox …) / HTTP routes (ideabox-routes.js) / future colleague UI
        │  createRecord / getRecord / listRecords / updateRecord / deleteRecord / addLink / recall
        ▼
lib/fluid/provider.js  — FluidProvider (existing seam, UNCHANGED)
        │  capability discovery: has(CAP) / require(CAP) — throws FluidCapabilityUnavailable, never fakes
        ├───────────────────────────┬─────────────────────────────┐
        ▼                            ▼                              ▼
LocalFluidProvider              SmartMemoryFluidProvider (NEW)   (future providers)
lib/fluid/local-provider.js     lib/fluid/smartmemory-provider.js
(existing, unchanged)                │  workspace-scoped per product (X-Workspace-Id = resolveProjectTag)
                                      ▼
                              lib/smartmemory-client.js (EXTENDED: +createEntity/getEntity/updateEntity/deleteEntity)
                                      │  HTTP, bearer auth, existing timeout/error conventions
                                      ▼
                              SmartMemory REST service (crud.py structured/typed-entity routes)

lib/fluid/factory.js — extended: fills the existing `smartmemory` stub (factory.js:91) to construct SmartMemoryFluidProvider

[deferred] lib/fluid/portfolio.js — fan-out/merge over discoverWorkspaces() + per-workspace fluidProviderFor();
           builds when a real cross-product consumer exists. Isolation model above makes this purely additive later.
```

`lib/smartmemory-ingest.js` / `lib/smartmemory-sync.js` / `server/smartmemory-routes.js` (the shipped `COMP-SMARTMEMORY-INGEST/RECALL` kitchen-exhaust pipeline) are **untouched** — different slice of the same fabric per design.md (kitchen/procedural vs front-of-house/strategic), sharing only the low-level `smartmemory-client.js` transport module.

## Secondary: Q3 — INDEXED vs FULL per entity kind

Fluid record kinds are fixed at 7 (`lib/fluid/provider.js`): `idea, position, joint, decision, thread, question, cluster`.

> **COUPLING FOUND AT BLUEPRINT TIME (2026-08-04) — FULL vs INDEXED is not a free policy dial.** This section reads as though recallability were a per-kind setting. It is not: SmartMemory generates a kind's embedding from the item's `content` field, so what a kind can be recalled *by* is decided by how the provider serializes a record into `content` — a storage-mapping choice, not a policy one. FOH-1 settles it as **D-FOH-1** ([blueprint.md](blueprint.md)): `content` is a searchable projection (title + body + discussion), `metadata` is the canonical record. Any later change to a kind's FULL/INDEXED status has to go through that serialization, and `PATCH` does not reindex — which is why reindexing is named as FOH-2's entry gate. Re-read this section together with D-FOH-1 before changing any kind's setting.

- **`idea`, `thread`, `question`** → **FULL** (recallable). Associative "have we discussed this" recall is core to these types; all three proposals agree.
- **`cluster`** → **INDEXED** only. A hand-authored grouping label, never a fuzzy-recall target (matches existing D7 in COMP-PLAN-IDEA-UNIFY's own s2-progress.md).
- **`decision`** → **INDEXED** (real, disclosed disagreement — 2 of 3 proposals said FULL). Adopting INDEXED: canon needs exact field lookup (`get_active_decisions`-style precision), and fuzzy recall risks surfacing a *superseded* decision as if it were live. Upgradeable to FULL later if a genuine "search past decisions by vibe" need shows up — not built ahead of demand. **This is the one open item still worth a second look at blueprint time**, not fully closed by this synthesis.
- **`position`, `joint`** → ~~default to FULL~~ **CONTESTED as of 2026-08-04.** No proposal addressed these with specificity, and COMP-PLAN-IDEA-UNIFY S3a's **D12** now argues they should not be fluid records on any provider: the judgment layer already owns both kinds, with its own tracked store (`docs/judgment/records/{positions,joints}/`) and its own write tools (`judgment_position_create`, `judgment_joint_add`). Accepting them here would give one kind two stores and two canons. The local floor already refuses them (`supportedKinds()` is `idea, decision, thread, question, cluster`). **Resolve before any slice touches these kinds; FOH-1 is `idea`-only, so it is not blocked.**
- **`feature`/roadmap-item** → explicitly **not** a fluid/SmartMemory type — stays git-canon per Decision 2. The kitchen-side `lib/smartmemory-sync.js:153-185` already ingests feature artifacts (design/blueprint/plan/report) as INDEXED content; registering a typed schema for that is a SmartMemory-side concern, not a new Compose component.

## Sequencing — first buildable slices

Two slices, sitting **behind** COMP-PLAN-IDEA-UNIFY's caller-side work (S3/S4), not parallel to or duplicating it:

1. **FOH-1 — `SmartMemoryFluidProvider`, storage-only.** Declares `STORAGE_CAP` only (no `RECALL`/`CHALLENGE`/etc yet), kind `idea` only (matches the pilot kind COMP-PLAN-IDEA-UNIFY S1 already scoped). Fills the `factory.js:91` stub. Independently testable exactly like `local-provider.js` (own suite, real backend, provider constructed against a disposable scope). Can build in parallel with COMP-PLAN-IDEA-UNIFY S3b since it's a new file behind an existing interface.

   *Corrected 2026-08-04 after S3a landed:* the original wording said "injected-store style". That test pattern no longer exists — S3a removed `LocalFluidProvider`'s `config.store` injection (present at `8a6b687:201-202`) along with its `VisionStore` dependency, replacing `dataDir` with `recordsRoot`. FOH-1's analogous knob is a workspace id, not an injected store.
2. **FOH-2 — RECALL.** Declares `CAP.RECALL`, implemented over the already-shipped `client.search()`. Cheapest real "colleague" capability to reach — no new SmartMemory-side machinery, just wiring a search endpoint that already works end-to-end for a different purpose (`server/smartmemory-routes.js`).

Everything else — `CHALLENGE`/`CONVICTION`/`CALIBRATION`/`CONTRADICTION` capabilities, additional record kinds beyond `idea`, the portfolio rollup, the hat catalog, a dedicated `lib/colleague/` orchestration namespace — deferred past these two slices. Each needs either SmartMemory-side ontology work not yet scoped, or a real consumer that doesn't exist yet.

## What's explicitly deferred (disclosed, not hidden)

- Cross-workspace portfolio rollup (Q1) — buildable additively later, foundations laid now.
- `position`/`joint` INDEXED-vs-FULL confirmation — default set, worth a second pass at blueprint.
- A dedicated `lib/colleague/` domain-layer namespace (raised by the clean-architecture proposal, real insight) — worth adopting once an actual colleague orchestrator is being built, not needed to unblock FOH-1/FOH-2.
- Hat catalog v1 contents — product decision, not architecture.
- CLI/HTTP promotion-path duplication (`bin/compose.js` vs `server/ideabox-routes.js`) — pre-existing, unrelated to COMP-FOH, filed as a follow-up rather than fixed here.

## Trade-offs of this synthesis vs. picking one proposal wholesale

Costs slightly more than the pure minimal-changes path (real per-workspace isolation instead of a shared pool — worth it, given the leak-bug precedent). Ships sooner than the pure clean-architecture path (no portfolio orchestrator or `lib/colleague/` namespace built speculatively). The result is closest to pragmatic-balance's sequencing with clean-architecture's isolation model swapped in for Q1, since isolation was a stated design invariant, not a nice-to-have.
