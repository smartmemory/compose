# COMP-MCP-ROADMAP-READ — `get_roadmap` read primitive: Design

**Status:** DESIGN
**Date:** 2026-06-09
**Owner:** compose
**Type:** internal / MCP surface

## Related Documents

- ROADMAP.md → COMP-MCP-ROADMAP-READ row
- Sibling write tools: `add_roadmap_entry`, `set_feature_status` (COMP-MCP-ROADMAP-WRITER)
- `validate_project` (drift detector this tool reports against)
- Global skill edited downstream: `~/.claude/skills/roadmap/SKILL.md`

---

## Problem

The compose MCP roadmap surface is **write-complete but read-incomplete**. There are writers
(`add_roadmap_entry`, `set_feature_status`) and adjacent reads (`get_vision_items` → vision-state,
`roadmap_diff` → event log), but **no tool returns the rendered roadmap**. Every reader — including the
global `/roadmap` skill — falls back to `Read`-ing `ROADMAP.md` directly.

On feature.json-backed workspaces (e.g. `compose/` itself) that means reading a **rendered artifact** that
can drift from canon (`docs/features/<code>/feature.json`). The `/roadmap` skill's rule "don't guess — read
the source" then makes it *confidently* report a stale view as truth, because its notion of "the source" is
the markdown file, not the canon. The validator (`validate_project`) exists precisely because that drift
happens.

This gap is also the root cause of the direct-read leak: there is no in-band alternative to `Read ROADMAP.md`.

## Goal

Add a single **read-only** MCP tool, `get_roadmap`, that returns the roadmap rendered from canon, plus a
staleness signal — then wire the `/roadmap` skill to prefer it when a compose MCP server is connected.

Non-goals:
- No mutation / write path (that's the existing writers).
- No reconciliation of feature.json↔ROADMAP.md drift (that's `validate_project --fix`). This tool *reports*
  drift; it does not fix it.

---

## Decision 1: Render in memory via `generateRoadmap`, but branch on narrative explicitly

`generateRoadmap(cwd, opts)` in `lib/roadmap-gen.js:211` does **not write files**: it returns the markdown
string. For a feature.json workspace it renders fresh from `listFeatures()`; for a `narrative=true` workspace
it returns the on-disk file verbatim — but on that narrative branch it first emits `console.warn(...)`
(`roadmap-gen.js:215`). For a quiet read primitive used frequently by the skill, `get_roadmap` will call
`isNarrativeOwned(root)` itself first: if narrative, read `ROADMAP.md` directly (no warn, `source:"narrative"`);
otherwise call `generateRoadmap` (`source:"rendered"`). Either path is read-only — it must NOT call
`writeRoadmap` / `provider.renderRoadmap()` (those mutate).

**Why this stays "read-only":** it renders in memory / reads the file and returns a string; it never writes.
This does not violate the `/roadmap` skill's read-only contract, and it lets the skill drop direct `Read
ROADMAP.md`.

## Decision 2: `summary` is the default format (token-cap safety)

The sibling write tools return the full ROADMAP and routinely blow the MCP token cap. To avoid repeating that,
`format:"summary"` (the default) omits the raw markdown and returns parsed counts + active/blocked lists.
`format:"markdown"` is opt-in for when the caller actually wants the text.

## Decision 3: Drift is reported, not fixed; strip the whole `Last updated:` line

`check_drift` (default `true`) compares the in-memory render against on-disk `ROADMAP.md`. The non-narrative
`generateRoadmap` stamps `**Last updated:** <YYYY-MM-DD>` (`roadmap-gen.js:269`, date-only via
`toISOString().slice(0,10)` at `:223`). Note this is date-only, so it does **not** change on every call — it
changes once per day. The comparison MUST strip the **entire** `**Last updated:** …` markdown line regardless
of its date value (not match a literal), then compare the remainder. For narrative workspaces the content *is*
the file, so drift is always `false`.

## Decision 4: Reuse `parseRoadmap()` as the row parser

Row parsing reuses `parseRoadmap()` in `lib/roadmap-parser.js:54` — the existing reusable read parser. Note:
`validate_project`'s `loadValidationContext()` (`lib/feature-validator.js:130`) and the preservers do their
**own** table scans; they do NOT share `parseRoadmap()` today. So the reuse target is specifically
`parseRoadmap()`, not "the parser validate_project uses." A second hand-rolled regex is forbidden (it would be
a new source of parse drift).

---

## Tool contract

`get_roadmap` — read-only, never mutates the filesystem.

**Inputs** (all optional):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `status` | string | — | comma-list filter (`PLANNED,IN_PROGRESS,…`) applied to parsed rows |
| `phase` | string | — | filter to a single phase heading |
| `format` | `"markdown"` \| `"summary"` | `"summary"` | full rendered md, or parsed counts + active/blocked lists |
| `check_drift` | boolean | `true` | compare fresh render vs on-disk `ROADMAP.md` |

**Output** — `summary`/`active`/`blocked` are **row-level** entries (parseRoadmap emits one entry per table
row; a feature with `items[]` yields multiple rows — `roadmap-gen.js:369`). Field names match
`parseRoadmap`'s `FeatureEntry`: `code`, `description`, `status`, `phaseId` — **not** `title`/`phase`.
Anonymous rows (`code === '—'`) are excluded from `active`/`blocked` lists but counted in `summary`.

```
{
  source: "narrative" | "rendered",   // which path produced the content
  path: "<abs path to ROADMAP.md>",
  summary: { complete, active, planned, blocked, parked, superseded },  // counts over all rows
  active: [ { code, description, status, phaseId } ],   // status ∈ {IN_PROGRESS, PARTIAL}
  blocked: [ { code, description, status, phaseId } ],  // status == BLOCKED
  stale: boolean,                     // present when check_drift
  drift?: "<one-line description>",   // present when stale
  markdown?: "<rendered md>"          // present only when format=="markdown"
}
```

**Behavior:**
1. If `isNarrativeOwned(root)`: read `ROADMAP.md` directly (`source:"narrative"`). Else render in memory via
   `generateRoadmap(root, {})` (`source:"rendered"`).
2. If `check_drift`: read on-disk `ROADMAP.md`, strip the whole `**Last updated:** …` line from both sides,
   compare the remainder; set `stale` + one-line `drift` when they diverge. Narrative drift is always `false`.
3. Parse rows via `parseRoadmap(text)`; apply filters — `status` is a comma-list matched against the
   normalized status token, `phase` is matched against `phaseId` (exact). Compute `summary` counts (mapping
   `parseStatusToken` tokens → buckets) and `active`/`blocked` lists.
4. `format:"summary"` (default) omits `markdown`; `format:"markdown"` includes it.

## Skill reconciliation

Edit `~/.claude/skills/roadmap/SKILL.md` "Finding the Roadmap":
- **New step 0:** if a `compose` MCP server is connected, call `get_roadmap` (format: summary) — it returns
  canon-rendered state and a `stale` flag; prefer it over reading the file.
- Fall through to the existing file-path convention when no compose server is present (keeps the skill
  product-agnostic; forge-top already correct via narrative passthrough).
- Keep "read-only" intact — the primitive renders read-side.

This edit lands in the user's **global** `~/.claude/skills/`, outside the compose repo — tracked separately
in the report.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/compose-mcp-tools.js` | modify | add `toolGetRoadmap(args)` near `toolGetVisionItems`; import `generateRoadmap` |
| `server/compose-mcp.js` | modify | register `get_roadmap` in the tool list + dispatch |
| `lib/roadmap-gen.js` | read-only ref | `generateRoadmap` (render) + `isNarrativeOwned` |
| `lib/roadmap-parser.js` | read-only ref | reused `parseRoadmap` + `parseStatusToken` |
| `test/…get-roadmap.test.js` | new | golden + drift + narrative + token-size tests |
| `~/.claude/skills/roadmap/SKILL.md` | modify (external) | prefer `get_roadmap` when compose MCP present |

## Acceptance criteria

- [ ] `get_roadmap` returns rendered markdown for a feature.json workspace **without writing any file**
      (assert `ROADMAP.md` mtime unchanged across the call)
- [ ] Returns `source:"narrative"` + file-verbatim content for a `narrative=true` workspace
- [ ] `check_drift` flags a workspace where feature.json and ROADMAP.md diverge, **ignoring** the
      `Last updated:` line
- [ ] `format:"summary"` response stays well under the MCP token cap on a large (≈149-row) roadmap
- [ ] `status` / `phase` filters parse the rendered rows correctly
- [ ] tool registered in `server/compose-mcp.js` and dispatchable
- [ ] `/roadmap` skill prefers `get_roadmap` when compose MCP present, falls back to file-read otherwise

## Open Questions

- None remaining. Parser reuse pinned to `parseRoadmap()` (Decision 4); narrative branch pinned to an
  explicit `isNarrativeOwned()` check (Decision 1).
