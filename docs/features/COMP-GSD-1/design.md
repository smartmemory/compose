# COMP-GSD-1: Boundary Map — Design

**Status:** DESIGN
**Date:** 2026-05-10

## Related Documents

- Roadmap: `../../../../ROADMAP.md` § COMP-GSD (this is GSD-1)
- Parent initiative: `docs/features/COMP-GSD/` (umbrella)
- Inspired by: [gsd-build/gsd-2](https://github.com/gsd-build/gsd-2) — `Boundary Map` section of `M###-ROADMAP.md`
- Adjacent prior art: STRAT-PAR `files_owned` / `files_read` / `depends_on` in `pipelines/build.stratum.yaml:45–46` and `../stratum/stratum-mcp/src/stratum_mcp/spec.py` (`no_file_conflicts`) — note: the stratum path is relative to the **forge monorepo root**, not the compose package root, since stratum is a sibling package under `forge/`.
- Examples to mirror: `docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md`, `docs/features/COMP-OBS-STREAM/blueprint.md`, `docs/features/COMP-UX-2a/blueprint.md`

> **Path convention in this doc:** all paths are relative to the compose package root (`/Users/ruze/reg/my/forge/compose`). External repos use explicit relative prefixes.

---

## Problem

Compose blueprints are free-form markdown. There is no contract enforcement on what a blueprint must declare about cross-component interfaces. When a feature spans two or more sequential work units (slices, sub-features, parallel tasks under STRAT-PAR), the contracts that cross the boundary — exported types, function signatures, event payloads, persisted record shapes — only exist implicitly inside the prose of the blueprint. Two failure modes follow:

1. **Cross-component drift.** Slice A's blueprint says "exports a `User` interface"; Slice B's blueprint says "consumes the user record." The two are written days apart by different agent runs, and the field names diverge. Drift surfaces only at integration test time, often after both slices have shipped tests of their own.
2. **STRAT-PAR conflicts caught too late.** STRAT-PAR's `no_file_conflicts` validator catches *file-level* ownership overlaps but says nothing about *symbol-level* contracts between disjoint files. Two parallel tasks can own different files yet still produce mismatched types.

Per the ROADMAP rationale: "Catches cross-component contract mismatches before code."

## Goal

Add a **Boundary Map** artifact to the blueprint phase. When a blueprint declares 2+ work units, authors are encouraged to include a Boundary Map declaring, at file→symbol granularity, what each unit `produces` and `consumes`. Phase 5 verification checks any Boundary Map that is present (validator runs on what's written; absence is not a verification failure in v1). Downstream phases (plan, execute, STRAT-PAR decompose) read the map as the ground truth for inter-unit contracts when present.

This is a **planning artifact**, not a runtime mechanism. It pays off immediately on any multi-unit feature that includes one.

### Non-Goals

- **Type compatibility checking.** Verifying that Slice A's `User.id: string` matches Slice B's `user_id: string` would require a TypeScript AST pass over real files. Out of scope for v1; v1 only checks that the named symbol exists in the named file.
- **Replacing STRAT-PAR's `files_owned` / `files_read`.** The Boundary Map is at file→symbol granularity for human-and-LLM consumption; STRAT-PAR's TaskGraph stays at file granularity for the parallel executor. Harmonization (Boundary Map → TaskGraph derivation) is parked as a follow-up under COMP-GSD-2/3.
- **Mandating the artifact in v1.** v1 ships the format, validator, and authoring guidance, but does not gate Phase 5 on Boundary Map presence. A follow-up may add a `<!-- boundary-map: required -->` declaration if shipping data shows authors routinely skipping it on multi-unit features.
- **Authoring it for trivial features.** Single-file or single-slice features have no boundaries to map.
- **A separate file format.** The Boundary Map is a section inside `blueprint.md`, not a `boundary-map.yaml` sidecar. Lowest friction; matches Compose's existing convention of `blueprint.md` as the single planning document.

---

## Decision 1: Format — per-slice markdown section embedded in `blueprint.md`

The blueprint template currently guarantees only `File Plan` and a Phase 5 `Verification Table` heading. The Boundary Map is a new top-level `## Boundary Map` section, placed after `File Plan` and before `Verification Table`. Format is **per-slice**, not per-edge — each slice gets one heading listing what it produces and what it consumes (and from where). This avoids fan-out/fan-in ambiguity (one slice consumed by two downstream consumers does not require duplicate `Produces:` blocks).

```markdown
## Boundary Map

### S01: auth primitives
Produces:
  src/lib/auth/types.ts → User, Session, AuthToken (interface)
  src/lib/auth/tokens.ts → generateToken, verifyToken, refreshToken (function)

Consumes: nothing (leaf node)

### S02: HTTP layer
Produces:
  src/server/api/auth/login.ts → loginHandler (function)
  src/server/middleware/auth.ts → authMiddleware (function)



Consumes:
  from S01: src/lib/auth/tokens.ts → generateToken, verifyToken

### S03: client integration
Produces:
  src/client/auth/useAuth.ts → useAuth (hook)

Consumes:
  from S01: src/lib/auth/types.ts → User, Session
  from S02: src/server/api/auth/login.ts → loginHandler
```

**Grammar (validator-checked):**

- `Produces:` entries: `<file-path> → <symbol>[, <symbol>...] (<kind>)` — `(<kind>)` is **mandatory**.
- `Consumes:` entries: `from S##: <file-path> → <symbol>[, <symbol>...]` — `(<kind>)` is **optional and ignored** (the kind is already declared on the matching upstream `Produces` entry).
- Leaf slices (no upstream dependencies) use the literal form `Consumes: nothing`. Sink slices (no downstream-visible exports — integration-only slices that wire existing primitives together) use the literal form `Produces: nothing`. An optional trailing parenthetical comment such as `(leaf node)` or `(integration only)` is ignored. These are the only valid zero-entry syntaxes.
- `<file-path>` is repo-relative.
- `<symbol>` is an identifier expected to appear (or eventually appear) in the named file.
- `<kind>` ∈ `{interface, type, function, class, const, hook, component}`. Other contract kinds (endpoints, event payloads, file formats, invariants) belong in the surrounding blueprint prose, not in Boundary Map entries — they are not grep-checkable symbols.

Slice IDs are local to the blueprint (`S01`, `S02`, …); the optional `: <name>` suffix on the heading is human guidance, not parsed. **Slice IDs must be unique within a blueprint** — a duplicate `### S##` heading is a hard validation error (`duplicate_slice_id`). `Consumes: from S##:` lines must reference a slice that has its own heading earlier in the map (topology check).

**Alternatives considered and rejected:**

- **Sidecar `boundary-map.yaml`.** Machine-parseable, but doubles the drift surface and forces every blueprint-writing agent to jump between two files. Rejected for v1; revisit if downstream tooling needs structured input.
- **Extend STRAT-PAR's TaskGraph.** TaskGraph is file-granular; Boundary Map is symbol-granular. Forcing symbols into TaskGraph either pollutes the file conflict validator or requires a parallel symbol-level field. Either way the artifact stops being human-readable in the blueprint. Rejected for v1; harmonization is the right move once GSD-2/3 land.
- **Edge-keyed format (`### S01 → S02`).** Original gsd-2 form. Breaks for fan-out (one producer, multiple consumers) — forces duplicate `Produces:` blocks, reintroducing drift inside the artifact itself. Rejected.
- **Inline in the Verification Table.** Corrections table is for "spec-vs-reality" findings during exploration; Boundary Map is forward-looking. Conflating them muddles both. Rejected.
- **Validate non-symbol contract kinds (endpoints, payloads).** Would require kind-specific validators (HTTP schema parser, JSON Schema check, etc.). Out of scope for v1 — the validator is strict file+symbol, and authors keep richer context in the blueprint prose where it has always lived.

## Decision 2: Authoring — Phase 4, opt-in but encouraged for multi-unit

The blueprint-writing agent's prompt is updated: "When the feature spans 2+ work units (slices, sub-features, or parallel tasks), append a `## Boundary Map` section per the format in `.claude/skills/compose/templates/boundary-map.md`. Each entry must name a concrete code symbol (interface, type, function, class, const, hook, or component) — not a vague area. Endpoints, event payloads, file formats, and invariants belong in the surrounding blueprint prose, not in Boundary Map entries."

The kind-restriction matches the validator contract from Decision 1. Other contract kinds (HTTP endpoints, JSON payloads, etc.) continue to be documented in the blueprint's narrative sections — they are simply not part of the *machine-checked* boundary surface.

**v1 requirement model:** Boundary Map is **opt-in**. The validator runs whatever is written; absence is not a verification failure. The "required for 2+ units" framing is a prompt-time author guideline, not a Phase 5 gate. Rationale: defining a machine-checkable trigger for "feature has 2+ work units" requires either a new structured marker in the blueprint preamble or heuristic counting — both add scope. v1 ships the validator and the authoring guidance; if surveys of shipped blueprints show authors routinely skipping the artifact on multi-unit features, a follow-up adds an explicit `<!-- boundary-map: required -->` declaration that Phase 5 enforces.

## Decision 3: Validation — four checks at Phase 5

The verification agent gets a new sub-task. It parses `## Boundary Map` and runs four checks:

1. **File-Plan-or-disk check (mandatory).** Every file path in a `Produces:` or `Consumes:` line must either exist on disk OR appear in the blueprint's File Plan table. The validator accepts any of the heading aliases observed in existing blueprints — `## File Plan`, `## Files`, `## File-by-File Plan` — and uses the first one found. New blueprints SHOULD use `## File Plan` (the canonical form). Action-value matching extracts the **leading verb** (first whitespace-delimited token, case-insensitive, stripped of trailing punctuation) before checking it against an **allow-list** of recognized write actions: `{"new", "create", "add", "edit", "modify", "update", "refactor", "replace"}`. Decorated values such as `MODIFY (existing, 119 lines)` therefore normalize to `modify` and pass. Leading verbs outside the allow-list (including `reference`, `unchanged`, `delete`, `remove`, or unknown tokens) are treated as **not** a planned write — the file must satisfy file-existence on disk, and unknown leading verbs emit a validator warning (`unknown_action`) so authors normalize their vocabulary.

   **No-File-Plan fallback.** Blueprints that have no recognizable File Plan heading (some older blueprints predate the convention) skip the File-Plan side of this check entirely — every referenced file must exist on disk. The validator emits an informational warning (`no_file_plan`) once per blueprint so authors are nudged toward adding one, but no entries are failed solely because the File Plan is absent.
2. **Symbol presence check (mandatory only for pre-existing untouched dependencies).** Symbol-presence is checked only when (a) the file exists on disk AND (b) the file is **not** listed in the File Plan with an allow-listed write action. Files with planned-write actions are skipped — the symbol may legitimately not exist yet. The check is only meant to catch hallucinated symbols in modules the slice does **not** touch.

   **v1 guarantee (name-mention only):** the v1 implementation is a substring grep — it confirms the symbol's identifier appears literally somewhere in the file. This catches gross hallucinations (the symbol name was invented) but does **not** prove the file actually defines or exports the symbol; mentions in comments, strings, or import-but-not-define would all pass. The trade-off is intentional for v1 (no AST, no language-specific tooling). A follow-up will tighten this to a definition/export-anchored regex per kind (e.g. `^export (interface|type|function|const|class) <symbol>` for TS). Filed as `COMP-GSD-1-FU-EXPORT-CHECK` (post-merge).
3. **Topology check (mandatory).** Every `from S##:` line must reference a slice that has its own heading earlier in the map. Because slice headings are read in document order and consumes-edges may only point backward, the consumes-graph is acyclic by construction; no separate cycle-detection pass is needed in v1. (If a future revision allows forward references, an explicit cycle check is added then.)
4. **Producer/consumer match check (mandatory).** Every `from S##: <file> → <symbol>` entry must have a matching `Produces:` entry on slice `S##` whose `<file>` and `<symbol>` set covers it. Specifically: the consumed file path must equal a produced file path on that slice, and every consumed symbol must appear in that producer's symbol list. This is the core anti-drift check — without it, a consumer can name any symbol in the producer's file and pass.

Failures append rows to the existing blueprint Verification Table; loop back to Phase 4 if any row is unresolved. This reuses the existing Phase 4↔5 loop — no new phase, no new gate.

## Decision 4: Downstream consumption — context-only for v1

The plan agent (Phase 6) and execute agent (Phase 7) are told the Boundary Map is the source of truth for the symbol-level contracts each work unit's tests must cover. Test guidance is split by symbol kind:

- **Runtime-assertable kinds** (`function`, `class`, `const`, `hook`, `component`): write integration/unit tests that exercise the symbol — call the function with boundary inputs, render the component, invoke the hook, etc.
- **Type-system-only kinds** (`interface`, `type`): the compose package does not currently run a TypeScript typecheck step (`package.json` has no `tsc` script or TypeScript dependency; tests are `node --test` + `vitest`). v1 coverage for type-only entries is therefore **author-attested**, not automated — the runtime tests exercise functions/hooks/components that consume the type, and a behavioral mismatch surfaces at runtime. Tightening this with a real typecheck pass is filed as `COMP-GSD-1-FU-TYPECHECK` (post-merge).

Endpoint shapes, event payloads, and other non-symbol contracts are not part of the Boundary Map and are exercised by tests written from the surrounding blueprint prose, not from this artifact.

v1 does not change the executor or STRAT-PAR's decompose step. The artifact is read by downstream agents as context; integration with TaskGraph derivation is a GSD-2/3 concern.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `.claude/skills/compose/templates/boundary-map.md` | new | Template + authoring guidance the blueprint agent reads |
| `.claude/skills/compose/SKILL.md` | edit | Update Phase 4 (blueprint) and Phase 5 (verification) sections to reference the Boundary Map |
| `lib/boundary-map.js` | new | Parser + four-check validator; called from the verification step |
| `lib/boundary-map.test.js` | new | Unit tests for parser and each of the four failure modes |
| `pipelines/build.stratum.yaml` | edit | Verification step's intent prompt references the new validator |
| `docs/features/COMP-OBS-STREAM/blueprint.md` | edit | Retroactively annotate as a worked example (read-only feature; this just adds a section) |

## Acceptance Criteria

- [ ] `.claude/skills/compose/templates/boundary-map.md` exists with format spec + 1 worked example
- [ ] Phase 4 blueprint prompt in `.claude/skills/compose/SKILL.md` instructs agents to author the section when feature has 2+ work units, and restricts entry kinds to symbols (interface/type/function/class/const/hook/component)
- [ ] Phase 5 verification adds four checks: File-Plan-or-disk, symbol-presence, DAG-topology, producer/consumer-match
- [ ] `lib/boundary-map.js` parses the markdown section and returns `{ ok: bool, violations: [Violation], warnings: [Warning] }`:
  - `Violation = { kind, scope: "parse" | "entry", slice?, file?, symbol?, message }`. Entry-level violations (the four semantic checks) populate `slice`, `file`, and `symbol`. Parse-level violations (duplicate slice IDs, malformed `Produces:`/`Consumes:` lines, missing required `(<kind>)`) set `scope: "parse"`, populate whichever locator fields are recoverable, and may omit the rest.
  - `Warning = { kind, scope: "blueprint" | "file-plan" | "entry", slice?, file?, symbol?, message }`. Blueprint-level warnings (`no_file_plan`) set `scope: "blueprint"` and may omit all locator fields. File-Plan-level warnings (`unknown_action`) set `scope: "file-plan"`, populate `file` from the offending row, and omit `slice`/`symbol` (one warning per File Plan row, deduplicated). Entry-level warnings populate `slice`/`file`/`symbol` from the Boundary Map entry.
  - `ok` is `false` only when `violations` is non-empty. Warnings never set `ok: false`. Violations drive the Phase 4↔5 loop; warnings render as informational rows in the Verification Table without blocking gate approval.
- [ ] Validator handles single-unit blueprints (returns `ok: true, violations: []` with no Boundary Map)
- [ ] Verification failures append to Verification Table and loop back to Phase 4 (no new gate)
- [ ] At least one existing multi-slice blueprint (e.g. `COMP-OBS-STREAM/blueprint.md`) is retroactively annotated as a worked example
- [ ] Tests: snapshot of a valid Boundary Map (including a leaf slice and a sink slice); snapshots of a Boundary Map with each of the four failure modes (missing file, missing symbol in untouched dependency, dangling consume / forward reference, producer/consumer mismatch); snapshot of a Boundary Map with an `unknown_action` warning.

## Open Questions

- **Slice ID convention.** Local-only (`S01`, `S02`) is simplest. Alternative: feature-code prefixed (`COMP-GSD-1.S01`). **Recommend local-only** — the blueprint is the scope; cross-blueprint references are out of scope for v1.
- ~~**Threshold for "2+ work units".**~~ **Resolved in Decision 2:** v1 is opt-in. Authors decide; the validator runs whatever is written. A follow-up may add an explicit `<!-- boundary-map: required -->` declaration if shipping data shows authors routinely skipping the artifact.

## Out-of-Scope (filed as follow-ups, do not block GSD-1)

- Type compat checking (TypeScript AST pass) — file as a separate enhancement when TS LSP integration lands
- TaskGraph derivation from Boundary Map — naturally part of GSD-2/3 design
- Visual rendering in cockpit — depends on COMP-UI region availability
