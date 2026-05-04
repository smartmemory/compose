# COMP-MCP-FOLLOWUP — Implementation Blueprint

Reference: `docs/features/COMP-MCP-FOLLOWUP/design.md`

## Files

| Path | Action | Purpose |
|---|---|---|
| `compose/lib/followup-writer.js` | new | `proposeFollowup(cwd, args)` orchestrator + `_internals` for tests |
| `compose/server/compose-mcp-tools.js` | edit | Add `toolProposeFollowup` thin wrapper (matches sibling pattern at lines 204-227) |
| `compose/server/compose-mcp.js` | edit | Tool definition (insert after `validate_project` block at line 351) + import + dispatch case (after line 584) |
| `compose/test/followup-writer.test.js` | new | Unit tests for orchestrator (mirrors `test/feature-writer.test.js`) |
| `compose/test/followup-writer-mcp.test.js` | new | MCP wrapper smoke test (mirrors `test/feature-writer-mcp.test.js`) |
| `compose/CHANGELOG.md` | edit | Entry under today's date for COMP-MCP-FOLLOWUP |
| `compose/ROADMAP.md` | edit (via `set_feature_status`) | Flip COMP-MCP-FOLLOWUP to COMPLETE |

## Library: `compose/lib/followup-writer.js`

### Imports

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { createHash } from 'crypto';

import { readFeature } from './feature-json.js';                    // signature verified at lib/feature-json.js:35
import { addRoadmapEntry, linkFeatures } from './feature-writer.js'; // signatures verified at lib/feature-writer.js:89, lib/feature-writer.js:433
import { writeRoadmap } from './roadmap-gen.js';
import { appendEvent } from './feature-events.js';                  // verified at lib/feature-events.js:44
import { checkOrInsert } from './idempotency.js';                   // verified at lib/idempotency.js:108
import { FEATURE_CODE_RE_STRICT } from './feature-code.js';         // verified at lib/feature-code.js:14
```

### Public API

```js
/**
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.parent_code
 * @param {string} args.description
 * @param {string} args.rationale
 * @param {'S'|'M'|'L'|'XL'} [args.complexity]
 * @param {string} [args.phase]
 * @param {string} [args.status]
 * @param {string} [args.idempotency_key]
 */
export async function proposeFollowup(cwd, args) { ... }
```

### Internal helpers (not exported except `_internals`)

```js
function sha16(s)            // sha256(s).slice(0, 16) — used for filenames
function ledgerPath(cwd, key) // .compose/inflight-followups/<sha16(key)>.json
function lockPath(cwd, parent_code) // .compose/locks/followup-<sha16(parent)>.lock
function fingerprint(args)   // sha256 of canonicalized {parent, description, rationale, phase, status, complexity}
function acquireParentLock(cwd, parent_code, timeoutMs=5000)  // mkdir-based, mirrors idempotency.js:42 pattern
function readLedger(cwd, key)
function writeLedger(cwd, key, payload)  // wx mode for first write; non-exclusive overwrite for stage advancement
function deleteLedger(cwd, key)
function nextNumberedCode(cwd, parent_code)  // listFeatures + regex /^<parent>-(\d+)$/, max+1
function scaffoldDesignWithRationale(cwd, code, rationale)  // ArtifactManager + rationale insert + rollback on failure
```

### Validation (top of `proposeFollowup`)

| Check | Error code |
|---|---|
| `parent_code` matches `FEATURE_CODE_RE_STRICT` | `INVALID_INPUT` |
| `description` non-empty trimmed string | `INVALID_INPUT` |
| `rationale` non-empty trimmed string | `INVALID_INPUT` |
| `complexity` ∈ `{S,M,L,XL}` if present | `INVALID_INPUT` |
| `readFeature(cwd, parent_code)` returns truthy | `PARENT_NOT_FOUND` |
| Parent status ∉ `{KILLED, SUPERSEDED}` | `PARENT_TERMINAL` |
| `status` ∈ `{PLANNED, IN_PROGRESS, PARTIAL, COMPLETE, BLOCKED, KILLED, PARKED, SUPERSEDED}` if present | `INVALID_INPUT` |

Errors are thrown with `err.code` set, mirroring `feature-code.js:23`.

### Orchestrator flow

```
1. validate args (above table)
2. if idempotency_key:
     cacheKey = `propose_followup:${parent_code}:${idempotency_key}`
     hit = checkOrInsert(cwd, cacheKey) cache lookup only — but checkOrInsert
       has no read-only mode; instead: probe readEntries(cwd) directly via the
       _internals exposed for it. Since lib/idempotency.js doesn't currently
       export a read helper, follow-up implementation will route both the
       success-cache and the inflight-resume through a new local helper that
       reads idempotency-keys.jsonl directly. (Adds a tiny dependency on the
       cache file format — acceptable since it's the same lib.)
     if hit: return hit.result
     ledger = readLedger(cwd, idempotency_key)
     if ledger:
       verify ledger.idempotency_key === idempotency_key
       verify ledger.parent_code === parent_code
       verify ledger.request_fingerprint === fingerprint(args)
       (else throw INVALID_INPUT with appropriate message)
       resume from ledger.stage  // see Resume below
   else:
     ledger = null

3. take per-parent lock (only when ledger is null OR ledger.stage === 'pending')
4. compute allocated_code (only when ledger is null)
5. write inflight ledger payload {idempotency_key, parent_code, allocated_code,
   stage: 'pending', request_fingerprint, ts} with `wx` mode
6. call addRoadmapEntry(cwd, {code, description, phase, complexity, status,
   parent: parent_code})
   - on success: advance ledger to 'roadmap_done', release lock
   - on ROADMAP_PARTIAL_WRITE: advance ledger to
     'roadmap_committed_regen_failed', release lock, throw PARTIAL_FOLLOWUP
   - on other error: release lock, delete ledger, rethrow
7. call linkFeatures(cwd, {from_code: allocated_code, to_code: parent_code,
   kind: 'surfaced_by'})
   - on success: advance ledger to 'link_done'
   - on error: advance ledger to 'link_failed', throw PARTIAL_FOLLOWUP
8. call scaffoldDesignWithRationale(cwd, allocated_code, rationale)
   - on success: advance ledger to 'scaffold_done'
   - on error: helper rolls back its own design.md write before throwing;
     advance ledger to 'scaffold_failed', throw PARTIAL_FOLLOWUP
9. emit composite audit event via appendEvent — wrap in try/catch (best-effort)
10. write success cache via checkOrInsert with the namespaced key (just to
    persist the result — checkOrInsert's "already-cached" branch is fine
    because we only reach here on the first success; if it has somehow been
    cached already, that's a noop)
11. delete the inflight ledger
12. return the result
```

### Resume rules (replay path)

- `stage === 'pending'`: take per-parent lock; reattempt step 6 with the
  stored `allocated_code`. On "feature already exists" duplicate error, call
  `writeRoadmap(cwd)` to bring ROADMAP.md current, then advance to
  `roadmap_done`. Release lock. Continue from step 7.
- `stage === 'roadmap_committed_regen_failed'`: do NOT call addRoadmapEntry
  again. Call `writeRoadmap(cwd)` directly. Advance to `roadmap_done`.
  Continue from step 7. (No lock — no allocation race possible at this
  stage.)
- `stage === 'roadmap_done'`: continue from step 7.
- `stage === 'link_failed'`: continue from step 7.
- `stage === 'link_done'`: continue from step 8.
- `stage === 'scaffold_failed'`: continue from step 8.
- `stage === 'scaffold_done'`: continue from step 9.

### Concurrency: per-parent lock

Mirrors `idempotency.js:42-71` (mkdir-based, stale-lock recovery at 5 s
timeout). Lock dir: `.compose/locks/followup-<sha16(parent_code)>.lock`. The
lock guards only the allocation + step-6 span; release immediately after
step 6 advances ledger to `roadmap_done` (or `roadmap_committed_regen_failed`).
On 5 s acquisition timeout, throw `FOLLOWUP_BUSY` (Error with `err.code =
'FOLLOWUP_BUSY'`).

### Error envelopes thrown to caller

- `INVALID_INPUT` — validation failures (parent_code regex, empty
  description/rationale, bad complexity, bad status, replay arg drift).
- `PARENT_NOT_FOUND` — `readFeature` returned null.
- `PARENT_TERMINAL` — parent status in `{KILLED, SUPERSEDED}`.
- `FOLLOWUP_BUSY` — per-parent lock acquisition timed out.
- `PARTIAL_FOLLOWUP` — step 6/7/8 partial failure. Payload on `err`:
  `{ code: 'PARTIAL_FOLLOWUP', stage, created_code, cause? }` where `stage`
  is one of `'roadmap_regen' | 'link' | 'scaffold'` and `cause` is the
  underlying error (e.g. the original `ROADMAP_PARTIAL_WRITE`).

### `scaffoldDesignWithRationale(cwd, code, rationale)`

```js
const { ArtifactManager } = await import('../server/artifact-manager.js');
const featureRoot = resolve(cwd, 'docs', 'features');
mkdirSync(featureRoot, { recursive: true });
const manager = new ArtifactManager(featureRoot);
const scaffolded = manager.scaffold(code, { only: ['design.md'] });
const designPath = join(featureRoot, code, 'design.md');
let backupExisted = false;
let backupContent = null;
try {
  backupContent = readFileSync(designPath, 'utf-8');
  backupExisted = true;
  const whyBlock = `## Why\n\n${rationale.trim()}\n\n`;
  // Insert above the first heading or at top — preserve template H1
  const lines = backupContent.split('\n');
  const firstH1Idx = lines.findIndex(l => /^# /.test(l));
  let insertIdx;
  if (firstH1Idx === -1) {
    insertIdx = 0;
  } else {
    insertIdx = firstH1Idx + 1;
    while (insertIdx < lines.length && lines[insertIdx].trim() === '') insertIdx++;
  }
  // Idempotency: if a `## Why` block already exists at insertIdx, skip.
  const existingWhy = lines.slice(insertIdx, insertIdx + 2).join('\n');
  if (!/^## Why\b/m.test(existingWhy)) {
    lines.splice(insertIdx, 0, '', whyBlock.trimEnd(), '');
    writeFileSync(designPath, lines.join('\n'), 'utf-8');
  }
  return scaffolded;
} catch (err) {
  // Rollback on failure: only if we just created the file in this call
  if (backupExisted && scaffolded.created.includes('design.md')) {
    try { unlinkSync(designPath); } catch { /* best-effort */ }
  } else if (backupExisted) {
    // We didn't just create it; restore the prior content so we don't leave
    // a partial rationale insert
    try { writeFileSync(designPath, backupContent, 'utf-8'); } catch { /* best-effort */ }
  }
  throw err;
}
```

## MCP wrapper: `compose/server/compose-mcp-tools.js`

Insert after `toolGetFeatureLinks` (around line 237):

```js
// ---------------------------------------------------------------------------
// Follow-up filing — COMP-MCP-FOLLOWUP
// ---------------------------------------------------------------------------

export async function toolProposeFollowup(args) {
  const { proposeFollowup } = await import('../lib/followup-writer.js');
  return proposeFollowup(getTargetRoot(), args);
}
```

## Tool definition: `compose/server/compose-mcp.js`

Insert tool definition after the `validate_project` block (line 351):

```js
{
  name: 'propose_followup',
  description: 'File a follow-up feature against a parent. Auto-numbers the next code in the parent\'s namespace (parent_code-N), adds the ROADMAP row, links surfaced_by from new → parent, and scaffolds design.md with a "## Why" rationale block. Idempotent on (parent_code, idempotency_key); resumes across partial failures via an inflight ledger.',
  inputSchema: {
    type: 'object',
    required: ['parent_code', 'description', 'rationale'],
    properties: {
      parent_code: { type: 'string', description: 'Parent feature code (e.g. "COMP-MCP-MIGRATION"). Must exist; must not be KILLED/SUPERSEDED.' },
      description: { type: 'string', description: 'One-line description for the ROADMAP cell.' },
      rationale: { type: 'string', description: 'Why this follow-up exists. Persisted as a "## Why" block in the new design.md and in the audit event.' },
      complexity: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
      phase: { type: 'string', description: 'Phase heading. Defaults to the parent\'s phase if omitted.' },
      status: { type: 'string', enum: ['PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE', 'BLOCKED', 'KILLED', 'PARKED', 'SUPERSEDED'] },
      idempotency_key: { type: 'string', description: 'Optional retry-safety key. Without it, repeated calls allocate new codes.' },
    },
  },
},
```

Add import (after line 50):

```js
  toolProposeFollowup,
```

Add dispatch case (after line 584):

```js
      case 'propose_followup':         result = await toolProposeFollowup(args); break;
```

## Tests: `compose/test/followup-writer.test.js`

Mirror style of `feature-writer.test.js`. Coverage matrix:

- happy path with cold-start parent (no numbered children) → first follow-up `<PARENT>-1`
- happy path with existing numbered children → next is N+1
- design.md contains `## Why` block with rationale verbatim
- audit event written with `tool: 'propose_followup'`
- link is `surfaced_by` from new → parent (verify via `feature.links` on the new feature)
- phase defaults to parent.phase when omitted
- `INVALID_INPUT` on bad parent_code, empty rationale, empty description, bad complexity
- `PARENT_NOT_FOUND` when parent doesn't exist
- `PARENT_TERMINAL` when parent is KILLED or SUPERSEDED
- idempotent: same key returns same result without mutating
- idempotent: cache key namespacing — same key, different parents, two distinct codes
- `INVALID_INPUT` with fingerprint message: same key reused with different description
- partial-state resume (link stage): seed a ledger at `roadmap_done`, call again with same key → completes without re-allocating
- concurrent allocation under per-parent lock: two sequential calls produce N and N+1 (no `propose_followup` collisions; the lock serializes them)

## Tests: `compose/test/followup-writer-mcp.test.js`

Mirror `feature-writer-mcp.test.js`. Single happy-path smoke test through the MCP wrapper.

## CHANGELOG entry

```md
- **COMP-MCP-FOLLOWUP** — propose_followup MCP tool. Files a numbered
  follow-up feature against a parent: auto-numbers `<parent>-N`, adds
  ROADMAP row, links `surfaced_by` new → parent, scaffolds design.md with
  rationale. Inflight ledger + per-parent lock for retry safety; namespaced
  idempotency cache.
```

## File:line verification

| Reference | Verified |
|---|---|
| `lib/feature-writer.js:89` `addRoadmapEntry` | ✓ matches read |
| `lib/feature-writer.js:433` `linkFeatures` | ✓ matches read |
| `lib/feature-json.js:35` `readFeature` signature | ✓ |
| `lib/feature-events.js:44` `appendEvent` | ✓ |
| `lib/idempotency.js:108` `checkOrInsert` | ✓ |
| `lib/idempotency.js:42-71` mkdir-lock pattern | ✓ |
| `lib/feature-code.js:14` `FEATURE_CODE_RE_STRICT` | ✓ |
| `server/artifact-manager.js:208` `scaffold(featureCode, options)` returns `{created, skipped}` | ✓ |
| `server/compose-mcp.js:351` insertion point after `validate_project` | ✓ |
| `server/compose-mcp.js:584` dispatch insertion point | ✓ |
| `server/compose-mcp-tools.js:237` insertion point after `toolGetFeatureLinks` | ✓ |
| `feature-writer.js:516` `ArtifactManager` dynamic-import precedent | ✓ |

All references verified against current source.
