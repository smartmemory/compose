# COMP-ROADMAP-RT — Deterministic Roadmap Roundtripping: Design

**Status:** DESIGN (Phase 1 gate — not yet implemented). Review as a design doc, not shipped code.
**Date:** 2026-05-29

## Related Documents

- Roadmap row: `ROADMAP.md` → Phase 6: MCP Writers → COMP-ROADMAP-RT
- Prior art (the machinery this hardens):
  - `lib/roadmap-gen.js` — `generateRoadmapFromBase()` pure transform (already carries fixed-point/self-healing reasoning in the dedupe block, lines ~108–124)
  - `lib/roadmap-preservers.js` — extract/reapply curated content (phase overrides, anon rows, preserved sections)
  - `lib/roadmap-drift.js` — `emitDrift()` phase-override-vs-rollup divergence events
  - `lib/roadmap-parser.js` — `parseRoadmap()` (known regex bug: requires trailing `-\d+`)
  - `lib/feature-validator.js` — `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON`, `ROADMAP_ROW_SCHEMA_VIOLATION`, et al.
  - `lib/feature-code.js` — canonical feature-code regex
  - `lib/feature-writer.js` — `addRoadmapEntry()`/`setFeatureStatus()` regen ROADMAP.md after each mutation
- Follow-up (scope cut, filed separately): **COMP-ROADMAP-XREF-SYNC** — external cross-reference reconciliation (network/provider subsystem)

---

## Problem

`feature.json` is the canonical source of truth; `ROADMAP.md` is a rendered view produced by `generateRoadmapFromBase()`. The render is *not pure rebuild* — it preserves hand-edited prose (phase intros, anonymous historical rows, `<!-- preserved-section -->` blocks, status overrides) by extracting them from the existing ROADMAP.md and splicing them back. That preservation layer is where roundtrip determinism is at risk. Three concrete hazards exist today:

1. **Fixed point is claimed, not proven.** The generator *reasons about* convergence (the dedupe comment in `roadmap-gen.js` explains how duplicate phases collapse so `4x/2x/1x → 1x`), but nothing asserts the general invariant `gen(gen(x)) == gen(x)`. The anonymous-row leftover path (`roadmap-gen.js` ~line 396 / `renderTableLines`) appends orphaned anon rows to table-end when their `predecessorCode` no longer exists. Because `predecessorCode` is re-derived from position on every regen (`readAnonymousRows`), a deleted predecessor can cause an anon row's anchor to shift between successive regens — a latent non-fixed-point.

2. **A real nondeterminism source.** `readPreamble()` calls `new Date().toISOString()` for the default preamble (`roadmap-gen.js` ~line 259). `gen` is therefore not a pure function of its inputs — two runs of a fresh-file generation differ by date.

3. **Three divergent feature-code regexes.** The parser (`roadmap-parser.js:15`, buggy — requires a trailing `-\d+`), the preservers (`FEATURE_CODE_RE`, strict), and `feature-code.js` (canonical) disagree on what a valid code is. `feature-validator.js` already works *around* the parser bug with a direct table scan (see its comment ~line 86). Divergent parsing means the same ROADMAP.md classifies rows differently depending on which reader runs — a determinism hazard by construction.

Beyond these: there is no write-time guarantee that a mutation produced a clean roundtrip (only a best-effort stderr drift warning), the `INITIATIVE→FEATURE→PHASE→TASK` hierarchy is convention with no structural validation, and roundtrip/drift problems surface only on stderr rather than through `validate_project`.

## Goal

Make ROADMAP.md generation a **proven deterministic fixed point** of `feature.json`, with roundtrip integrity enforced at write time and surfaced through validation.

**Success looks like:**
- [ ] `gen` is a pure function of `(baseText, features, now)` — no internal clock, no map-order nondeterminism.
- [ ] A `checkRoundtrip()` primitive proves both **fixed point** (`gen(gen(x)) == gen(x)`, byte-equal) and **losslessness** (`parse(gen(x))` recovers every feature's `{code, status, position, phase}`).
- [ ] One canonical feature-code regex, consumed by parser + preservers + validator; the parser's trailing-`-\d+` bug is fixed.
- [ ] Write-time guard (pre-commit dry run): a mutation either auto-canonicalizes to a fixed point (≤ `MAX_REGEN_PASSES`) and commits, or **aborts before persisting** and surfaces the diff (no canonical/rendered split).
- [ ] `compose roadmap check` exits nonzero on non-fixed-point / lossy / structural failure; `roadmap generate` iterates to a fixed point before writing.
- [ ] New validation findings: `ROUNDTRIP_NOT_FIXED_POINT`, `ROADMAP_LOSSY`, `HIERARCHY_DEPTH_INVALID`, `ORPHAN_PHASE`.

**Non-goals (explicit):**
- External cross-reference reconciliation (GitHub/Jira/Linear issue resolution) → **COMP-ROADMAP-XREF-SYNC**.
- A CI pipeline hook — the `--check` command is the gate; wiring it into CI is left to the consumer.
- Auto-rewriting hand-authored prose contradictions. Prose drift a human owns is **reported, never forced**.

---

## Decision 1: Posture — tiered, with auto-canonicalize as the write-time mechanism

The system controls the *structured* parts of the render (typed feature rows, phase rollups, ordering) but not the *prose* (intros, exit text, anon rows a human curated). The posture splits along that line:

- **Hard invariants the system owns** (fixed point, losslessness of typed data, hierarchy structure) → **enforced at write time**.
- **Soft contradictions a human owns** (prose that disagrees with feature.json beyond status/position) → **detected and reported**, never rewritten.

The write-time enforcement *mechanism* is auto-canonicalization, run as a **pre-commit dry run** to avoid a split-state outcome. Today's writers persist `feature.json` *before* rendering (`addRoadmapEntry` at `feature-writer.js:135`, `setFeatureStatus` at `:255`), so a render that blocks after the commit would leave canonical state ahead of the rendered view. To close that gap, the guard runs on the **prospective post-mutation feature set** (`checkRoundtrip` is pure and takes a `features` array, so it needs no persisted state):

1. Compute the post-mutation feature set in memory.
2. Run `checkRoundtrip` against it, iterating `gen` until output stabilizes (bounded to `MAX_REGEN_PASSES`, default 3).
3. **Converges →** persist `feature.json` *and* write the canonical ROADMAP.md (auto-canonicalize).
4. **Does not converge →** a generator/preserver bug, not user data. **Abort the whole mutation** before persisting `feature.json`; surface the inter-pass diff. Canonical state is untouched, so there is no split.

This makes the "write-time guarantee" real: a committed mutation has, by construction, a proven roundtrip. The only escape hatch is `force: true` (consistent with the existing transition-policy bypass), which persists anyway and records the unresolved diff as a `ROUNDTRIP_NOT_FIXED_POINT` finding for later `compose roadmap generate --write` recovery.

**Rejected:** byte-checksum manifest (only proves staleness, not fidelity); eliminating the roundtrip entirely (kills the curated-prose flexibility the preservers exist to protect).

---

## Decision 2: `checkRoundtrip()` is a pure primitive, reused everywhere

A single function backs the write-time guard, the CLI `--check`, and the validator findings — so all three agree by construction.

```
checkRoundtrip(baseText, features, opts) -> {   // opts carries { now, maxPasses }
  fixedPoint: boolean,        // gen(gen(base)) === gen(base)
  lossless:   boolean,        // every feature.json feature is recovered by parse(gen(base))
  canonical:  string,         // the converged fixed-point text (or last pass if non-converging)
  passes:     number,         // regen passes to reach stability (or maxPasses+1 if it never did)
  diffs:      Diff[],         // see Diff contract below
}
```

- **Purity & drift suppression.** `checkRoundtrip` is pure (no I/O). This is *not free*: `generateRoadmapFromBase()` today calls `emitDrift()` (stderr + audit append) whenever `opts.cwd` is set and an override diverges (`roadmap-gen.js:151`). The check must therefore invoke gen with **drift emission suppressed** — gen gains an explicit `opts.suppressDrift` (or check simply omits `cwd`), and `checkRoundtrip` always uses that path. A check pass must never write events or warnings.
- **Clock.** `now` is threaded through `opts` into gen so fresh-file generation is deterministic (see Decision 3a). The same `now` is used for both passes of the fixed-point comparison.
- **Fixed point:** generate once (`gen1`), generate again from `gen1` (`gen2`), compare byte-for-byte. Iterate up to `maxPasses` (default `MAX_REGEN_PASSES = 3`).
- **Losslessness — aggregate by code, not by row.** Generation emits **one row per sub-item** when any feature in a phase has `items[]`, repeating the feature code and substituting `item.position` for `feature.position` (`roadmap-gen.js:365–393`); `parseRoadmap()` records each such row as a separate entry with a global incrementing position (`roadmap-parser.js:106`). So losslessness is **not** row-equality. The check:
  1. Parses `gen1`, then **groups parsed rows by canonical feature code** (collapsing repeated sub-item rows under one code).
  2. For features **without** `items[]`: assert one parsed row whose `{status, position}` matches.
  3. For features **with** `items[]`: assert the grouped rows recover each `item`'s `{description, status}` (item position is presentational and excluded from the equality key).
  4. Reports `LOSSLESS_MISSING` (feature.json code absent from parse), `LOSSLESS_EXTRA`, `LOSSLESS_CHANGED` (status/phase/position mismatch).
- **Anonymous rows are excluded from the lossless diff.** Per Decision 1 they are human-owned prose. `parseRoadmap()` surfaces them as `_anon_*` entries (`roadmap-parser.js:23,104`); the check drops any parsed entry that is `_anon_*` or whose code fails `isFeatureCode()` **before** computing `extra`. `LOSSLESS_EXTRA` therefore fires only for a parsed row with a *valid canonical code* that has no backing feature.json — a genuine orphan, never a curated anon row.

---

## Decision 3: Unify feature-code parsing (and bring the parser to validator parity)

`feature-code.js` exports the one canonical regex plus an `isFeatureCode(s)` predicate; `roadmap-parser.js`, `roadmap-preservers.js`, and `feature-validator.js` all import it. The parser's trailing-`-\d+` requirement is removed (it drops valid codes like `COMP-ROADMAP-RT`). This is a prerequisite for losslessness — the check cannot prove recovery if the parser silently drops codes the generator emitted.

**Caveat (corrects an earlier overreach):** fixing the regex alone does **not** let the validator delete its workaround table-scan. The validator's scan recognizes broader header layouts than `parseRoadmap()` — `feature/code/item/name` and `status/state` columns (`feature-validator.js:122`), whereas `parseRoadmap()` only handles `ID | … | Status` 3-column tables and marks everything else anonymous (`roadmap-parser.js:149`). The plan is therefore: **first raise `parseRoadmap()`'s header recognition to validator parity**, *then* collapse onto a single parse path. If parity proves expensive, the fallback is to keep the validator's scan but have it consume the canonical regex — unification of the *regex* is the hard requirement; unification of the *scan* is the nice-to-have.

---

## Decision 3a: Deterministic clock

`generateRoadmapFromBase()` calls `new Date().toISOString()` in the default preamble (`roadmap-gen.js:259`). gen gains an `opts.now` (ISO date string); the default preamble uses it; callers that want today's date pass it explicitly. This makes gen pure over `(baseText, features, now)` and is what lets the fixed-point comparison be byte-stable.

---

## Decision 4: Hierarchy validation, scoped to the data model that exists

The documented `INITIATIVE→FEATURE→PHASE→TASK` is depth 2–4, but **`feature.json` has no initiative field** and no nesting schema — initiative is purely a ROADMAP-prose grouping with no machine representation. So hierarchy validation is scoped to what the data model can actually express:

- **Levels that exist:** `phase` (level 1) → feature (level 2) → `items[]` sub-items (level 3). Depth is `1 + (feature present) + (feature has non-empty items[])`.
- `HIERARCHY_DEPTH_INVALID` — a feature with **no `phase`** (depth < 2: ungrouped feature that the generator dumps into a synthetic "Features" section). `warning`.
- `ORPHAN_PHASE` — a `## ` phase heading present in ROADMAP.md that has **no feature.json features** AND for which `readPhaseBlocks()` returns no non-empty block AND no `readPreservedSections()` marker is anchored to it (per `readPreservedSectionAnchors`). "Preserved block backing it" = either a non-empty phase block or an anchored preserved section; absence of *both* means the heading is dead prose that will neither regenerate nor survive cleanly. `warning`, escalated to `error` when the dead heading itself carries an active status (its `readPhaseOverrides` token is `IN_PROGRESS`/`PARTIAL`) — a dead heading claiming live work is the dangerous case. (Note: an orphan phase by definition has no backing rows, so the active-status signal is the *heading's own* status token, not a row's.)
- **Initiative-level validation is explicitly deferred** to COMP-ROADMAP-XREF-SYNC or a future feature that adds an `initiative` field — it cannot be validated against data that doesn't exist.

---

## Decision 5: Diff contract

`Diff` is `{ kind, phaseId?, code?, detail }` with a closed set of `kind`s, each mapping to exactly one validator finding so the guard, CLI, and validator stay aligned:

| `Diff.kind` | Meaning | Validator finding |
|---|---|---|
| `FIXED_POINT_DIVERGENCE` | `gen1 !== gen2`; `detail` carries a unified text diff of the two passes | `ROUNDTRIP_NOT_FIXED_POINT` |
| `LOSSLESS_MISSING` / `LOSSLESS_EXTRA` / `LOSSLESS_CHANGED` | parse vs feature.json projection mismatch | `ROADMAP_LOSSY` |
| `HIERARCHY_DEPTH` | feature with no phase | `HIERARCHY_DEPTH_INVALID` |
| `ORPHAN_PHASE` | dead phase heading | `ORPHAN_PHASE` |

The write-time guard surfaces `FIXED_POINT_DIVERGENCE.detail` (the inter-pass text diff) verbatim in its error.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/roadmap-roundtrip.js` | new | `checkRoundtrip()` primitive (fixed-point + lossless), pure, no I/O |
| `lib/roadmap-gen.js` | modify | Inject `now` clock param + `suppressDrift` opt; remove internal `new Date()`; document canonical ordering invariants |
| `lib/feature-code.js` | modify | Export canonical regex + `isFeatureCode()` as the single source |
| `lib/roadmap-parser.js` | modify | Consume canonical regex; fix trailing-`-\d+` bug |
| `lib/roadmap-preservers.js` | modify | Consume canonical regex (replace local `FEATURE_CODE_RE`) |
| `lib/feature-writer.js` | modify | Pre-commit dry-run guard: `checkRoundtrip` on prospective feature set; converge → persist + canonicalize, else abort mutation (or `force` + record finding) |
| `lib/feature-validator.js` | modify | New findings: `ROUNDTRIP_NOT_FIXED_POINT`, `ROADMAP_LOSSY`, `HIERARCHY_DEPTH_INVALID`, `ORPHAN_PHASE`; consume canonical regex (keep scan unless parser reaches parity — see Decision 3) |
| `bin/compose.js` (`roadmap check` / `generate`) | modify | Harden the **existing** `roadmap check` subcommand (`bin/compose.js:1067`) to run `checkRoundtrip` (replacing its ad-hoc parse-compare), nonzero exit on fixed-point/lossless/structural failure. Make the **existing** `roadmap generate` (`:1040`) iterate to a fixed point before writing. No new subcommands or flags. |
| `test/roadmap-checkroundtrip.test.js` | new | `checkRoundtrip` unit + property + error harness. (Distinct from the existing `test/roadmap-roundtrip.test.js`, which tests preserver byte-equality — do not clobber it.) |
| `contracts/` | modify | Document new finding kinds if finding kinds are contract-tracked |

## Testing

Per the project testing hierarchy:
- **Golden roundtrip flow:** load the *actual* compose and forge `ROADMAP.md` as fixtures → `checkRoundtrip` must report `fixedPoint && lossless` (a regression guard on the live roadmaps).
- **Property-style:** generate randomized feature sets (varied phases, positions, sub-items, overrides, anon rows) → assert `gen(gen(x)) == gen(x)` for all.
- **Error harness (table-driven):** malformed inputs — duplicate phase headings, orphaned anon row (deleted predecessor), bad hierarchy depth, code the buggy parser would drop — each maps to an expected finding kind + the expected guard outcome (canonicalize vs block).

## Open Questions

- `MAX_REGEN_PASSES` default — 3 is proposed (one mutation should stabilize in ≤2; 3 gives margin). Confirm during impl whether any legitimate case needs more.
- `--check` exit policy on *prose drift* (soft, human-owned tier): warn-only, nonzero only for fixed-point/lossless/structural failures. Confirmed as the default; revisit only if a CI consumer needs prose drift to be blocking.
- Parser-to-validator parity (Decision 3): scope the header-recognition work during planning — if it balloons, fall back to "shared regex, separate scans" and don't block this feature on full parse unification.
