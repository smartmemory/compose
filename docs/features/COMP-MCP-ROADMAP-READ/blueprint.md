# COMP-MCP-ROADMAP-READ — `get_roadmap`: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-06-09
**Design:** [design.md](design.md)

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/get-roadmap.js` | new | core read logic — pure function `getRoadmap(root, opts)` |
| `server/compose-mcp-tools.js` | modify | export thin `toolGetRoadmap(args)` wrapper |
| `server/compose-mcp.js` | modify | import + tool-def + dispatch case |
| `test/get-roadmap.test.js` | new | golden, drift, narrative, filters, token-size, no-write |

Core logic lives in `lib/get-roadmap.js` (testable without the MCP layer); the tool fn is a thin wrapper, mirroring how the writers delegate to `lib/feature-writer.js`.

---

## Verified anchors (Phase 5 — all green)

| Reference | Verified |
|---|---|
| `generateRoadmap(cwd, opts)` returns string, no write | `lib/roadmap-gen.js:209` |
| `isNarrativeOwned(cwd)` | `lib/roadmap-config.js:23` |
| `parseRoadmap(text) → {code,description,status,phaseId,position}[]` | `lib/roadmap-parser.js:54` |
| `parseStatusToken`, `STATUS_TOKENS` (re-exported via roadmap-parser) | `lib/roadmap-heading.js:16,30` |
| `getTargetRoot()` | `server/project-root.js:46` |
| tool import block | `server/compose-mcp.js:3-46` |
| tool-def array entry shape (`get_vision_items`) | `server/compose-mcp.js:84-112` |
| dispatch switch | `server/compose-mcp.js:714-734` |
| existing read-tool wrapper shape (`toolGetVisionItems`) | `server/compose-mcp-tools.js:155` |

`STATUS_TOKENS = ['COMPLETE','IN_PROGRESS','PARTIAL','PLANNED','SUPERSEDED','PARKED','BLOCKED','KILLED']`.

---

## `lib/get-roadmap.js`

```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateRoadmap } from './roadmap-gen.js';
import { isNarrativeOwned } from './roadmap-config.js';
import { parseRoadmap, parseStatusToken } from './roadmap-parser.js';

const LAST_UPDATED_RE = /^\*\*Last updated:\*\*.*$/m;
const ACTIVE = new Set(['IN_PROGRESS', 'PARTIAL']);

// status token -> summary bucket
const BUCKET = {
  COMPLETE: 'complete', IN_PROGRESS: 'active', PARTIAL: 'active',
  PLANNED: 'planned', BLOCKED: 'blocked', PARKED: 'parked', SUPERSEDED: 'superseded',
};

export function getRoadmap(root, opts = {}) {
  const { status, phase, format = 'summary', check_drift = true } = opts;
  const roadmapPath = join(root, 'ROADMAP.md');
  const onDisk = existsSync(roadmapPath) ? readFileSync(roadmapPath, 'utf-8') : '';

  const narrative = isNarrativeOwned(root);
  const markdown = narrative ? onDisk : generateRoadmap(root, {});
  const source = narrative ? 'narrative' : 'rendered';

  const rows = parseRoadmap(markdown);

  // summary counts over ALL rows (anonymous included)
  const summary = { complete: 0, active: 0, planned: 0, blocked: 0, parked: 0, superseded: 0 };
  for (const r of rows) {
    const bucket = BUCKET[parseStatusToken(r.status)];
    if (bucket) summary[bucket]++;
  }

  // active/blocked lists exclude anonymous rows (code === '—' or falsy)
  const named = rows.filter(r => r.code && r.code !== '—');
  const matchFilter = (r) => {
    if (status) {
      const wanted = status.split(',').map(s => s.trim().toUpperCase());
      if (!wanted.includes(parseStatusToken(r.status))) return false;
    }
    if (phase && r.phaseId !== phase) return false;
    return true;
  };
  const pick = (r) => ({ code: r.code, description: r.description, status: parseStatusToken(r.status), phaseId: r.phaseId });
  const active = named.filter(r => ACTIVE.has(parseStatusToken(r.status))).filter(matchFilter).map(pick);
  const blocked = named.filter(r => parseStatusToken(r.status) === 'BLOCKED').filter(matchFilter).map(pick);

  const out = { source, path: roadmapPath, summary, active, blocked };

  if (check_drift) {
    if (narrative) {
      out.stale = false; // content IS the file
    } else {
      const strip = (t) => t.replace(LAST_UPDATED_RE, '').trimEnd();
      const drifted = strip(markdown) !== strip(onDisk);
      out.stale = drifted;
      if (drifted) out.drift = 'ROADMAP.md differs from feature.json render (run validate_project --fix)';
    }
  }

  if (format === 'markdown') out.markdown = markdown;
  return out;
}
```

Notes:
- `generateRoadmap` is NOT called on the narrative branch (avoids its `console.warn` and is a true no-op read).
- No `writeRoadmap` / `provider.renderRoadmap` anywhere → no file mutation (acceptance: mtime unchanged).
- `parseStatusToken` is applied to row status because the rendered status cell may carry suffixes
  (e.g. `PARTIAL (1a COMPLETE)`); the token is the canonical bucket key.

## `server/compose-mcp-tools.js` (wrapper, near line 155)

```js
export function toolGetRoadmap(args) {
  const { getRoadmap } = require('../lib/get-roadmap.js'); // or top import, match file's import style
  return getRoadmap(getTargetRoot(), args ?? {});
}
```
(Match the file's existing ESM dynamic-import style used by the writer wrappers — `const { getRoadmap } = await import(...)` and mark the fn `async` if that's the house style. `getTargetRoot` already imported there.)

## `server/compose-mcp.js` (3 edits)

1. Add `toolGetRoadmap,` to the import block (`:3-46`).
2. Add a tool-def to the `TOOLS` array (after `roadmap_diff`, `:350`):
```js
{
  name: 'get_roadmap',
  description: 'Read the current roadmap rendered from canon (feature.json) without writing. Returns status summary + active/blocked rows, and a staleness flag vs on-disk ROADMAP.md. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter rows by status (comma-separated): PLANNED, IN_PROGRESS, PARTIAL, BLOCKED, COMPLETE, …' },
      phase:  { type: 'string', description: 'Filter rows to a single phase (matched against phaseId)' },
      format: { type: 'string', description: 'summary (default, counts + lists) | markdown (full rendered text)' },
      check_drift: { type: 'boolean', description: 'Compare render vs on-disk ROADMAP.md (default true)' },
    },
  },
},
```
3. Add dispatch case (after `roadmap_diff`, `:735`): `case 'get_roadmap': result = toolGetRoadmap(args); break;`
   (use `await` iff the wrapper is async).

---

## Test plan (`test/get-roadmap.test.js`, node:test)

Use a tmp project dir fixture (mirror existing roadmap-gen / feature-writer tests for setup helpers).

- [ ] **no-write**: capture `statSync(ROADMAP.md).mtimeMs`, call `getRoadmap`, assert unchanged
- [ ] **rendered source**: feature.json workspace → `source === 'rendered'`, summary counts match fixture
- [ ] **narrative source**: workspace with `narrative:true` → `source === 'narrative'`, markdown === file verbatim, `stale === false`
- [ ] **drift true**: feature.json says IN_PROGRESS but ROADMAP.md hand-edited to PLANNED → `stale === true`
- [ ] **drift ignores Last updated**: only the `**Last updated:**` line differs → `stale === false`
- [ ] **status filter**: `status:'IN_PROGRESS'` returns only active rows
- [ ] **phase filter**: `phase:'<phaseId>'` returns only that phase's rows
- [ ] **format**: `summary` omits `markdown`; `markdown` includes it
- [ ] **token-size**: on a large fixture, `JSON.stringify(summary-format result).length` stays small (< ~4KB)

---

## Corrections Table

| Spec Assumption | Reality | Resolution |
|----------------|---------|------------|
| One shared roadmap parser backs validate_project + preservers | `parseRoadmap()` is reusable, but validator/preservers scan independently | Reuse `parseRoadmap()` specifically (Decision 4) |
| `Last updated:` plain literal, changes every call | `**Last updated:** <YYYY-MM-DD>`, date-only (per-day) | Strip whole line via regex, compare remainder (Decision 3) |
| `generateRoadmap` is a clean pure read | Narrative branch emits `console.warn` | Branch on `isNarrativeOwned` first, read file directly (Decision 1) |
| Output fields `title`, `phase` | parseRoadmap yields `description`, `phaseId`; row-level | Contract uses `code/description/status/phaseId`, row-level (Decision: contract) |
