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

## Acceptance criteria

- [ ] `idea`-type vision items are the single source of truth for ideabox entries (no second store).
- [ ] Ideabox mutation goes through a fluid-store provider interface (records + lifecycle + `capabilities()`), with the local/vision-store provider as the floor implementation; no caller binds the vision store directly.
- [ ] `docs/product/ideabox.md` is regenerated from vision `idea` items; it is not a write target.
- [ ] `compose ideabox add/list/promote/kill/pri/discuss/triage` write/read the vision store (behavior preserved, backing store swapped).
- [ ] `useIdeaboxStore` / `/api/ideabox` serve from vision `idea` items (existing UI unchanged from the user's view).
- [ ] Promote records the `idea → feature` transition in the graph (provenance link), not a bare feature creation.
- [ ] One-time migration: existing `docs/product/ideabox.md` entries import to vision `idea` items (parser is import-once, not a live round-trip).
- [ ] `mapsTo` overlay is superseded by real graph links (or kept as a rendered view of them).

## Non-goals (deferred to later rungs / features)

- Conviction scores / evidence accumulation (rung 3, COMP-PLAN-CONVERGE and later).
- Any UI beyond preserving today's ideabox surface (rung-3+ surfaces are separate features).
- Build-exhaust → idea-fuel wiring (rung 2).

## Open threads

- Exact migration shape for the ID scheme (ideabox `IDEA-N` anchors vs vision-item IDs).
- Whether `ideabox.md` regeneration reuses the `roadmap-gen.js` atomic-render pattern.
