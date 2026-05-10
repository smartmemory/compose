# Boundary Map — Authoring Template

A **Boundary Map** is an opt-in `## Boundary Map` section inside `blueprint.md` that declares, at file→symbol granularity, what each slice (sub-feature, parallel task, or work unit) **produces** and **consumes**. The Phase 5 verifier runs `validateBoundaryMap` from `lib/boundary-map.js` against any Boundary Map present.

---

## When to author

If your feature has **2+ work units** (slices, sub-features, or parallel tasks under STRAT-PAR), append a `## Boundary Map` section **after `## File Plan`** and **before `## Verification Table`**.

Single-unit features have no boundaries to map — skip it.

---

## Format spec

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

---

## Grammar

- **Slice headings:** `### S## [: <human name>]`. The `S##` id is mandatory and must be unique within the blueprint. Names are human guidance, not parsed.
- **Produces entries:** `<file-path> → <symbol>[, <symbol>...] (<kind>)`. The `(<kind>)` parenthetical is **mandatory** on every Produces line.
- **Consumes entries:** `from S##: <file-path> → <symbol>[, <symbol>...]`. The trailing `(<kind>)` is optional and ignored — the kind already lives on the matching upstream Produces entry.
- **Leaf slices** (no upstream dependencies) use the literal form `Consumes: nothing`. An optional trailing parenthetical comment such as `(leaf node)` is ignored.
- **Sink slices** (no downstream-visible exports — integration-only slices) use the literal form `Produces: nothing`. An optional trailing parenthetical comment such as `(integration only)` is ignored.
- **Arrows:** both `→` (U+2192, preferred) and ASCII `->` are accepted.
- **File paths** are repo-relative.
- **Symbols** are identifiers expected to appear (or eventually appear) in the named file.

### Kind allow-list

`<kind>` must be one of:

```
interface, type, function, class, const, hook, component
```

### Symbol-only restriction

Boundary Map entries name **code symbols only**. Endpoints, event payloads, file formats, and invariants belong in the surrounding blueprint prose — they are not grep-checkable identifiers and are out of scope for the v1 validator.

---

## What the validator checks

Phase 5 runs `validateBoundaryMap({ blueprintText, blueprintPath, repoRoot })` and applies four checks in order:

1. **File-Plan-or-disk.** Every referenced file must either appear in the blueprint's File Plan with an allow-listed write action (`new`, `create`, `add`, `edit`, `modify`, `update`, `refactor`, `replace`) **or** exist on disk.
2. **Symbol presence.** For files **not** marked as planned writes that exist on disk, each declared symbol must appear (substring match) somewhere in the file. Files in the File Plan as planned writes are skipped — the symbol may legitimately not exist yet.
3. **Topology.** Every `from S##` reference must point to a slice that appears earlier in the map (backward edges only; the consumes-graph is acyclic by construction).
4. **Producer/consumer match.** Every consumed `(file, symbol)` must be declared as a Produces entry on the named upstream slice with a matching file and a superset of symbols.

Violations block the Phase 5 gate; warnings (`no_file_plan`, `unknown_action`) render as informational rows but do not block.

---

## Worked example: 3-slice auth feature

The example above (S01: auth primitives → S02: HTTP layer → S03: client integration) demonstrates:

- A **leaf slice** (S01) using `Consumes: nothing (leaf node)`.
- **Multiple kinds** in a single slice (S01 has both `interface` and `function` Produces).
- **Multi-symbol** Produces and Consumes entries (S01 produces three tokens; S02 consumes two of them).
- **Cross-slice fan-in** (S03 consumes from both S01 and S02).
- **Backward-only edges** — every `from S##` references an earlier slice.
