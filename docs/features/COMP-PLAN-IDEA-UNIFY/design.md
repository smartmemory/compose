# COMP-PLAN-IDEA-UNIFY — Unify ideation storage under the ideabox funnel

**Status:** PLANNED
**Epic:** COMP-PLAN-RIGOR (Front-of-Funnel Rigor + Parity)
**Rung:** 1 of the Discovery Loop ladder (the keystone)

## Related Documents

- North-star: [The Discovery Loop vision](../../product/2026-07-20-discovery-loop-vision.md)
- Epic anchor: [Front-of-Funnel Rigor + Parity design](../../design/2026-07-20-front-funnel-rigor-design.md) — this feature is WS-A.
- Substrate ruling: [`PROVIDER-SEAM`, what-to-build §8k (2026-07-21)](../../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives) — this feature is the fluid-store provider seam's **pilot workload**.
- Honors: COMP-ROADMAP Decision 4 (ideation lives in the ideabox) — see "Decision" below.

## Problem

"An idea" is stored as two incompatible things: the markdown ideabox (`docs/product/ideabox.md`, served by `server/ideabox-routes.js`, hydrated by `src/components/vision/useIdeaboxStore.js`, full CLI `compose ideabox …`) and the vision store's `idea` type (`server/vision-store.js:10`). They are bridged only by a read-only `mapsTo` overlay in the graph (`GraphView.jsx:704`). Promoting an ideabox idea creates a *feature*, skipping the vision `idea` type entirely.

The whole Discovery Loop stands on ideas being first-class graph objects — able to accumulate evidence, carry conviction scores (rung 3), link to adversary/wind-tunnel results (rung 4), and sit next to `decision/question/thread` (rung 6). A markdown bullet cannot hold any of that. So storage must unify onto the vision store, or the loop cannot be built.

## Decision (settled; refined 2026-07-21 by `PROVIDER-SEAM`)

**A1 — vision `idea` items are canon; `ideabox.md` becomes a read-only generated view.**

*Refinement (owner ruling, 2026-07-21):* the canonical store is formally the **fluid-store provider interface** — a zero-install local floor implemented over the vision store's `idea` type (so A1's substrate stands), with SmartMemory as the capability-rich reference provider able to back the same records later. Concretely for this feature: mutation routes through the provider interface rather than binding callers to the vision store directly, and this feature is the seam's pilot — the interface it forces into existence (typed record CRUD + lifecycle + capability discovery, semantics never abstracted) is the one positions/joints/decisions adopt next. Pattern precedent: the tracker-provider `capabilities()` seam.

- The **ideabox stays the funnel and the UI** — capture, cluster, triage, promote. This honors Decision 4, which pinned the *funnel interface*, not the *storage implementation*. Swapping the backing store behind a stable port is encapsulation, not a reversal.
- `docs/product/ideabox.md` is **regenerated** from `idea`-type vision items (the `ROADMAP.md ← feature.json` projection pattern from Decision 3). It becomes read-only output.
- **All mutation** routes through CLI / UI / MCP against the vision store. Direct hand-editing of `ideabox.md` is dropped (confirmed unused) — the CLI (`compose ideabox add/triage/promote/…`) covers capture ergonomically. No bidirectional markdown↔store sync (avoids the trap Decision 3 closed for the roadmap).
- Promote becomes a graph transition `idea → [decision/thread] → feature`, not a markdown→feature.json jump.

*Second refinement (owner ruling, 2026-08-04 — S3's entry gate; see [s3-progress.md](s3-progress.md) D10):* **the substrate is git-tracked record files, not vision-store items.** The clause above ("a zero-install local floor implemented over the vision store's `idea` type") does not survive the durability question: `.compose/data/vision-state.json` is gitignored, so records hosted there are untracked and single-machine, while the `ideabox.md` this feature turns into a generated projection is tracked. Cutover would have moved canon from a tracked file to an ignored one. The floor now persists to `docs/product/fluid/records/<HANDLE>.json` plus `docs/product/fluid/events.jsonl`, mirroring `docs/judgment/`. **A1 stands in substance** — one canonical store, ideabox as generated view, provider interface as the port — and only its implementation substrate changed. Canon inverts with it: the record file is canon, and a vision item is now an optional derived projection.

## Acceptance criteria

- [x] Fluid records are the single source of truth for ideabox entries (no second store). *(S1; substrate corrected in S3 — records are tracked files, not vision items.)*
- [x] Ideabox mutation goes through a fluid-store provider interface (records + lifecycle + `capabilities()`), with the local file-backed provider as the floor implementation; no caller binds the vision store directly. *(S1/S3.)*
- [x] `docs/product/ideabox.md` is regenerated from fluid records; it is not a write target. *(Renderer S2; CLI cutover S3b-1; the API's write path S3b-2. Every surface now writes records and re-renders.)*
- [x] `compose ideabox add/list/promote/kill/pri/discuss/triage` write/read through the provider (behavior preserved, backing store swapped). *(S3b-1; rebased onto the shared ops in S3b-2, which also added `resurrect`.)*
- [x] `useIdeaboxStore` / `/api/ideabox` serve from fluid records (existing UI unchanged from the user's view). *(S3b-2. Reads go through `lib/fluid/ideabox-view.js`, NOT by parsing the generated markdown — that would be correct only on the local provider.)*
- [x] Promote records the `idea → feature` transition in the graph (provenance link), not a bare feature creation. *(S3b-1/S3b-2: a typed `promoted_to` edge, asserted from both surfaces.)*
- [x] One-time migration: existing `docs/product/ideabox.md` entries import to fluid records (parser is import-once, not a live round-trip). *(S2; runs at cutover.)*
- [x] `mapsTo` overlay is superseded by real graph links (or kept as a rendered view of them). *(Stored as a typed `maps_to` link; the markdown `**Maps to:**` line is a rendering of it.)*

## Non-goals (deferred to later rungs / features)

- Conviction scores / evidence accumulation (rung 3, COMP-PLAN-CONVERGE and later).
- Any UI beyond preserving today's ideabox surface (rung-3+ surfaces are separate features).
- Build-exhaust → idea-fuel wiring (rung 2).

## Open threads

- ~~Exact migration shape for the ID scheme (ideabox `IDEA-N` anchors vs vision-item IDs).~~ **RESOLVED (S1/S2):** the record carries both — a provider-assigned `id` and a stable external `handle` holding the `IDEA-N` anchor verbatim. Handles survive a provider swap and are never reused, because they are cited in docs and commits (this ruling cites IDEA-20).
- ~~Whether `ideabox.md` regeneration reuses the `roadmap-gen.js` atomic-render pattern.~~ **RESOLVED (S2):** yes, temp + rename.
- **NEW, and it gates S3 — where do the floor's records live, and are they tracked?** `.compose/data/` is gitignored, so cutting over as designed moves idea canon from a tracked file to untracked local state and leaves a committed GENERATED file with no source of truth on any other clone. Arguably intended (fluid lives in the provider, not git), but the ruling parked *backup cadence* for this layer and that rider is now load-bearing. **Owner ruled 2026-08-04: defer the cutover to S3 and answer this first.** See [s2-progress.md](s2-progress.md).
