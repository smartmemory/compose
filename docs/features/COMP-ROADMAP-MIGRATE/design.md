# COMP-ROADMAP-MIGRATE: forge-top narrative → structured

**Status:** DESIGN (Phase 1 — review as a design doc, not shipped code)
**Date:** 2026-06-21
**Umbrella:** COMP-ROADMAP · **Anchor:** [epic design](../../plans/2026-06-21-roadmap-planning-model-design.md)
**Supersedes the scrapped `COMP-NARRATIVE-MIGRATE` link-carrier design (option B dropped after Codex round 1-3).**

## Problem

forge-top (`/Users/ruze/reg/my/forge`) is `roadmap.narrative:true` — a hand-authored cross-product prose roadmap. Migrate it to structured (feature.json-backed, generated ROADMAP.md) as the precondition for retiring narrative mode (COMP-ROADMAP-RETIRE). Scoping: 99 item rows already carry real codes (so `migrate-anon` is a no-op), 51 already have a local `feature.json` + 48 don't, **~88 rows are `COMP-*`/`STRAT-*` owned by compose/stratum** (their `feature.json` lives in those repos), and a curated changelog header + "Roadmap Model" prose have no typed home.

## Decision 1: foreign-owned rows leave the live table (option C) — NOT link-carriers

A "link-carrier feature.json that renders the owner's status" (the earlier plan) is **unsound**: the renderer treats top-level `status` as row canon (`roadmap-gen.js:56`) but `xref-sync` only reconciles `links[].expect`, never top-level `status` (`xref-sync.js:102`). Under structured rendering it would render a placeholder status. Codex confirmed across 3 rounds.

So instead (epic Decision 3):
- **forge-top's `ROADMAP.md` becomes forge-OWNED-only.** A row is rendered iff the workspace owns the code (no `feature.json` in a sibling/owning repo AND the code isn't external-prefixed).
- **Foreign-owned codes are declared via `externalPrefixes`** in forge-top's `compose.json` — `isExternalCode` then suppresses the local-correspondence findings (`feature-validator.js:319`) and roundtrip ignores them (`roadmap-roundtrip.js:42`), so they don't demand a local folder and don't dirty `validate`.
- **The live cross-product view is the roadmap dependency graph** (COMP-ROADMAP-GRAPH-2's vision-store projection), which COMP-ROADMAP-GRAPH-3 extends to render external nodes. The graph — not ROADMAP.md rows — is the cross-product dashboard.

Ownership test per code: candidate owner from prefix convention (`COMP-*`→compose, `STRAT-*`→stratum) resolved via `resolveSiblingRoot`; owned-elsewhere iff `resolveFeaturesPath(siblingRoot)/<code>/feature.json` exists OR matches an `externalPrefix`. owned-here → scaffold a real `feature.json` (`migrate-roadmap.js:68-87`).

## Decision 2: prose preserved, never dropped

Before any flag flip (markers verbatim, `roadmap-preservers.js:25`): changelog header → `docs/roadmap-history.md` with a pointer (survives as preamble regardless, `roadmap-gen.js:230`); "Roadmap Model" → `<!-- preserved-section: roadmap-model -->`; oversized status-cell prose → each feature's `design.md`/`report.md`, cell reduced to the status token.

## Decision 3: one-time standalone script (not a productized verb)

No prod users → a throwaway `compose/scripts/migrate-forge-narrative.mjs` reusing existing libs (`parseRoadmap`, preservers, `writeFeature({validate:false})`, `migrateRoadmap` mapping, `xref-local`). Order of operations (the safety invariant — flag flip re-arms regen, `roadmap-gen.js:214`):
1. Classify every row (owned-here / owned-elsewhere).
2. Scaffold `feature.json` for every owned-here row; set `externalPrefixes` for owned-elsewhere.
3. Wrap/extract all stray prose into preserved-sections/docs.
4. **Dry-run `checkRoundtrip`** (`roadmap-roundtrip.js`) — prove the generated structured ROADMAP is a lossless fixed point.
5. Only then flip `roadmap.narrative:false` and regenerate; run `validate_project` (must be clean).
Dry-run by default; `--apply` to persist; idempotent.

## Files

| File | Action |
|---|---|
| `compose/scripts/migrate-forge-narrative.mjs` | new (throwaway) |
| `/Users/ruze/reg/my/forge/.compose/compose.json` | add `externalPrefixes`; later remove `roadmap.narrative` (in RETIRE) |
| `/Users/ruze/reg/my/forge/docs/features/<owned-code>/feature.json` | new (owned-here only) |
| `/Users/ruze/reg/my/forge/docs/roadmap-history.md` | new (extracted changelog) |
| `/Users/ruze/reg/my/forge/ROADMAP.md` | regenerated (forge-owned table + preserved prose) |

## Dependencies / open questions

- **Depends on COMP-ROADMAP-GRAPH-3** for the cross-product dashboard (else the 88 foreign items have no live visible surface after they leave ROADMAP.md).
- Decision the owner has approved: foreign items are visible in the GRAPH, not as ROADMAP.md rows.
- `externalPrefixes` value: probe (sibling feature.json) is ground truth; also set `["COMP-","STRAT-"]` so the external-skip engages. Confirm no forge-top-OWNED `COMP-*` exists (probe wins if so).
