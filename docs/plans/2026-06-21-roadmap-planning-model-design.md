# COMP-ROADMAP — Planning Lifecycle, Structured Model + Integrations (epic anchor)

**Status:** DESIGN (Phase 1 — review as a design/strategy doc, not shipped code)
**Date:** 2026-06-21
**Umbrella:** COMP-ROADMAP

## Related Documents

- Constituent features (all under the COMP-ROADMAP umbrella): COMP-ROADMAP-MODES, COMP-ROADMAP-PLAN, COMP-ROADMAP-MIGRATE, COMP-ROADMAP-RETIRE, COMP-ROADMAP-PROVIDERS, COMP-ROADMAP-META, COMP-ROADMAP-COMPOSE, COMP-ROADMAP-GRAPH-3.
- Prior art this builds on: COMP-ROADMAP-GRAPH-2 (vision-store canonical projection), COMP-ROADMAP-RT (roundtrip), the `compose new` kickoff (`lib/new.js` + `pipelines/new.stratum.yaml`), the tracker-provider layer (`lib/tracker/`).
- Converged via 3 independent Codex architecture rounds (2026-06-21).

## Problem / framing

Compose is a **build** lifecycle (idea→design→blueprint→implement→ship) that assumes you already know "build X." The owner wants the front half — a **product-planning lifecycle** ("I want to build something" → "I want to build X" via framing, research, ideation, discussion, estimation, convergence) — plus a structured, de-sync-free roadmap model and the ability to **integrate** with external tools (trackers, docs, design, no-code) without rebuilding them. This epic maps all four axes onto one coherent, modular model.

## Decision 1: `plan` lifecycle WITHIN compose (peer to build/fix), extractable later

Not a separate product. The substrate is identical and already workspace-scoped/reusable: Stratum flows, gates, the vision store (which already has planning-native types `idea`/`thread`/`question`/`decision`, `server/vision-store.js:10`), the ideabox funnel, and workspace identity (`lib/resolve-workspace.js:72`, guard resources keyed by workspace root `server/lifecycle-guard.js:102`). A separate product re-implements all of it; compose's own identity is already "goal-to-product."

**The real work is mode-generalizing the lifecycle data**, which today is hard-coded to the build graph (`server/lifecycle-guard.js:31`, `server/vision-server.js:42`, `server/artifact-manager.js:12`) and only generalized feature-vs-bug (`lib/build.js:629`, `:4632`). That generalization is also what makes provider seams pluggable — it is the keystone.

**Extractable later:** keep `workspaceId`-based interfaces so that if planning grows its own gravity it can spin out into a planning *workspace* coordinated by the composable model — but we do not pre-pay that cost.

## Decision 2: Canon stays native + integration-agnostic; integrations are ports & adapters

The principle that makes integrations **modular within our domain**: the core lifecycle never imports a vendor SDK — it depends on **ports** (provider interfaces). The native canonical store (`feature.json` + the derived roadmap) is the integration-agnostic source of truth; adapters are opt-in, configured per-workspace (exactly how the tracker provider works today). A provider may *back* a surface (subsume) without changing the core API.

```
CORE DOMAIN (no vendor imports): plan→build→fix · feature.json canon · roadmap · gates · ideabox · vision items
        │ depends only on PORTS ↓
PORTS (seams)                         ADAPTERS (opt-in integrations)
  TrackerPort   (status/issues/board) → GitHub Issues · Linear · JIRA
  DocumentPort  (feature docs)         → Notion · Confluence
  DesignPort    (design artifacts)     → Figma · Canva
  BuildTargetPort (deploy surface)     → Base44 · Webflow
```

**How each surface changes when integrated (the map):**

| Surface | Native default | Integration makes it | Seam | Real today |
|---|---|---|---|---|
| Tracker/status | `feature.json`→`ROADMAP.md` | Linear/JIRA/GH-Issues mirror/own status | `TrackerProvider` (exists, `tracker/provider.js:15`) | REFERENCE/DRIVE/SYNC — **github only** |
| Feature docs | `docs/features/<code>/*.md` | Notion/Confluence host docs | `DocumentPort` (**new**) | none (local-only) |
| Design artifacts | local `artifacts[]` sidecar | Figma/Canva own them | `DesignPort` (**new**) | none |
| Build target | code repo | Base44/Webflow output | `BuildTargetPort` (**new**) | none |
| Cross-product view | the roadmap **graph** | provider-fed status | graph adapter | partial (drops external nodes, `vision-adapter.js:85`) |

**Integration-depth ladder** (what "change" means): REFERENCE (read-only resolve) → DRIVE (compose writes out) → SYNC (bidirectional) → SUBSUME (the tool *is* the surface). Today only **github-as-tracker** reaches SYNC/SUBSUME; the `xref` enum *reserves* `jira|linear|notion|obsidian` but they are **inert recorded pointers** (`feature-validator.js:1044`), not real integrations.

## Decision 3: Cross-product roadmap view = the graph, not ROADMAP.md rows (foreign-rows fork → C)

`ROADMAP.md` renders only local `feature.json` (`roadmap-gen.js:56`); `xref-sync` reconciles `links[].expect`, never top-level `status` (`xref-sync.js:102`). So a "rendered-reference / link-carrier row" (option B) is a second ad-hoc source that fights the render model — **dropped**. Instead: forge-top's `ROADMAP.md` becomes **forge-owned-only**, and the live cross-product dashboard is the **roadmap dependency graph** (the COMP-ROADMAP-GRAPH-2 vision-store projection), which is the only clean cross-product render seam. Needs COMP-ROADMAP-GRAPH-3 to stop dropping external nodes.

## Decision 4: Ideation stays in the ideabox; narrative mode is a migration-era bridge

- Ideation lives in the **ideabox** (the existing pre-roadmap funnel with a promote-to-feature path), not in a new `roadmap.json` incubation section (that duplicates the funnel). Portfolio-level need → a top-level ideabox, not roadmap.json.
- Narrative mode (`roadmap.narrative:true`) is a **compatibility bridge**, deleted **last**, gated on demonstrated forge-top structured parity — not a permanent boundary. End-state is structured-only.

## Ordered slices (minimal-first)

| # | Feature | Slice | When |
|---|---|---|---|
| 1 | **COMP-ROADMAP-MODES** | Mode-generalize lifecycle data (transitions/gates/artifact-maps/phase→status) out of build-only globals (`server/lifecycle-guard.js:31`, `server/vision-server.js:42`, `server/artifact-manager.js:12`, `lib/build.js:629`). Keystone — unblocks `plan` AND pluggable ports. | v1 |
| 2 | **COMP-ROADMAP-PLAN** | `plan` lifecycle v1 on native state: ideabox→vision items→estimate/converge→build-handshake artifact (promoted `feature.json` + spec docs). Absorb `compose new`. | v1 |
| 3 | **COMP-ROADMAP-GRAPH-3** | Graph renders external/cross-product nodes — the cross-product dashboard MIGRATE's option C cuts over to. Lands **before** MIGRATE's cutover. | v1 (prereq for MIGRATE cutover) |
| 4 | **COMP-ROADMAP-MIGRATE** | forge-top narrative→structured (option C: ROADMAP.md forge-owned-only; one-time standalone script; prose→docs/preserved-sections). May be **prepared** in parallel but **cut over only after GRAPH-3** lands (else foreign items have no live surface). | v1 |
| 5 | **COMP-ROADMAP-RETIRE** | Prohibit narrative mode (delete `isNarrativeOwned` + the 6 gates). Gated on MIGRATE parity. | after MIGRATE |
| 6 | **COMP-ROADMAP-PROVIDERS** | TrackerProvider v2 (Linear/JIRA/GH-Issues) + new DocumentPort/DesignPort/BuildTargetPort seams. REFERENCE-only attach in v1; live integration here. | post-v1 |
| 7 | **COMP-ROADMAP-META** | Narrow coordination `roadmap.json` (workspaces[]/sharedMilestones[]/integrationItems[] only). | deferred |
| 8 | **COMP-ROADMAP-COMPOSE** | Composable nested workspaces (workspaceId-based parent→child refs, cross-workspace rollup). | deferred |

## Explicitly dropped

- Link-carrier / rendered-reference roadmap rows (option B).
- The assumption that the `xref` enum already provides JIRA/Linear/Notion (inert pointers only).
- Incubation inside `roadmap.json` (ideabox owns it).
- `roadmap.json` as a fat second tracker (themes/GTM/initiatives crammed in) — keep it narrow or defer.
- Native backlog/board features whose only purpose is to clone Linear/JIRA.
- Narrative mode as a permanent end-state.
- Treating `feature.json.phase` or `VisionStore.phase` as the new lifecycle truth (consolidate on `lifecycle.currentPhase`).

## Open questions (for build-time)

1. GTM/initiatives/tracking metadata — deferred entirely, or a thin slice of COMP-ROADMAP-META once a real consumer exists? (No render consumer today.)
2. `plan` build-handshake artifact contract — exact shape `build` resumes from.
3. The phase-vocabulary consolidation (`VisionStore.phase` vs `lifecycle.currentPhase` vs `feature-scan` inference) — prerequisite cleanup for MODES.
