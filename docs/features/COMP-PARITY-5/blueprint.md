**Feature ID:** `COMP-PARITY-5`
**Status:** BLUEPRINT (Phase 4 — verified against codebase, not yet implemented)
**Date:** 2026-06-16
**Design:** ./design.md

# COMP-PARITY-5 — Implementation Blueprint

Read-only view: surface the latest recorded completion (short commit SHA + tests-pass
badge + relative timestamp) next to the status control in `ItemDetailPanel.jsx`, and
flag divergence between the vision-state `status` and the recorded completion. No new
enforcement. The view is extracted into its own component; `ItemDetailPanel.jsx` gets
only an import + a single mount line.

---

## Why a server change is needed

Completions are **not** on the vision item object. Verified: `grep -rn "completions" src/`
returns **zero** hits, and `server/feature-scan.js` never reads `feature.json#completions[]`
into items (it only reads `group`). The cockpit talks REST (`wsFetch`), and `get_completions`
is an stdio MCP tool — unreachable from the browser. So a thin **read-only REST endpoint**
that wraps the existing `getCompletions(cwd, …)` lib fn is required.

---

## New files

### 1. `src/components/vision/shared/completionDivergence.js` (new)
Pure logic helper (mirrors `driftRibbonLogic.js`). No React. Separately unit-tested.

```js
/**
 * completionDivergence.js — pure divergence rule for COMP-PARITY-5.
 * Compares vision-state status (lowercase) with the latest recorded completion.
 */

/**
 * @param {string|null} status   item.status (lowercase: 'complete'|'in_progress'|…)
 * @param {object|null} latest   latest completion record (getCompletions sort desc), or null
 * @returns {{ kind: 'none'|'aligned'|'aligned-terminal'|'diverged',
 *             diverged: boolean, message: string|null }}
 */
export function computeDivergence(status, latest) {
  const s = (status || '').toLowerCase();
  if (!latest) {
    if (s === 'complete') {
      return {
        kind: 'diverged',
        diverged: true,
        message: 'Status complete but no recorded completion (no commit-bound evidence).',
      };
    }
    return { kind: 'none', diverged: false, message: null };
  }
  // latest completion exists
  if (s === 'complete') {
    return { kind: 'aligned', diverged: false, message: null };
  }
  if (s === 'killed') {
    // deliberate terminal action after a completion — not drift
    return { kind: 'aligned-terminal', diverged: false, message: null };
  }
  const sha = latest.commit_sha_short || (latest.commit_sha || '').slice(0, 8) || '—';
  return {
    kind: 'diverged',
    diverged: true,
    message: `Recorded complete (${sha}) but status is "${s || 'unknown'}".`,
  };
}
```

### 2. `src/components/vision/shared/CompletionBadge.jsx` (new)
Self-fetching presentational component. Pattern mirrors `SessionHistory`
(`ItemDetailPanel.jsx:141-176`): `wsFetch` + `AbortController`, keyed on `featureCode`.
Reuses `RelativeTime` for the timestamp. Style matches `StatusBadge.jsx` (small rounded
chips, `text-[10px]`, tailwind tokens). Renders only for lifecycle-bound items
(`item.lifecycle?.featureCode`).

```jsx
import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils.js';
import { wsFetch } from '../../../lib/wsFetch.js';
import RelativeTime from './RelativeTime.jsx';
import { computeDivergence } from './completionDivergence.js';

/**
 * CompletionBadge — read-only recorded-completion view (COMP-PARITY-5).
 * Shows the latest commit-SHA-bound completion next to the status control and
 * flags divergence vs the vision-state status. Read-only: never mutates.
 *
 * Props: { featureCode: string|null, status: string|null }
 */
export default function CompletionBadge({ featureCode, status }) {
  const [latest, setLatest] = useState(undefined); // undefined=loading, null=none
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!featureCode) { setLatest(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    wsFetch(`/api/completions?featureCode=${encodeURIComponent(featureCode)}&limit=1`,
      { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (controller.signal.aborted) return;
        const c = Array.isArray(data?.completions) ? data.completions[0] : null;
        setLatest(c || null);
      })
      .catch(() => { if (!controller.signal.aborted) setLatest(null); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [featureCode]);

  if (!featureCode || loading) return null;

  const div = computeDivergence(status, latest);

  return (
    <div className="space-y-1" data-testid="completion-badge">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Recorded Completion
      </p>
      {!latest ? (
        <p className="text-[10px] text-muted-foreground/70 italic" data-testid="completion-none">
          No recorded completion.
        </p>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-muted text-foreground"
            data-testid="completion-sha"
          >
            {latest.commit_sha_short || (latest.commit_sha || '').slice(0, 8) || '—'}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium',
              latest.tests_pass
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-rose-500/15 text-rose-400',
            )}
            data-testid="completion-tests"
          >
            {latest.tests_pass ? 'tests pass' : 'tests failed'}
          </span>
          <RelativeTime date={latest.recorded_at} className="text-[10px]" />
        </div>
      )}
      {div.diverged && (
        <div
          className="flex items-start gap-1.5 px-2 py-1 rounded bg-amber-400/10 border border-amber-400/20"
          data-testid="completion-divergence"
        >
          <span className="text-[10px] text-amber-400 leading-relaxed">⚠ {div.message}</span>
        </div>
      )}
    </div>
  );
}
```

### 3. `test/completions-route.test.js` (new) — server (node --test)
### 4. `test/ui/completion-badge.test.jsx` (new) — UI (vitest)

---

## Server changes — new read endpoint

Add a single **read-only** route in `server/vision-routes.js`, inside
`attachVisionRoutes(...)` (alongside the other GET reads; reads stay open — no
`guardAuth`). Reuses `getCompletions` from `lib/completion-writer.js` and the already-imported
`getTargetRoot` (`server/vision-routes.js:45`). Returns the small `{ completions, count }`
summary — never large bodies.

```js
// COMP-PARITY-5: read-only recorded-completion surface for the cockpit.
// Wraps lib/completion-writer.js#getCompletions (same logic as the get_completions
// MCP tool). Read-only — no mutation, no guardAuth.
app.get('/api/completions', async (req, res) => {
  try {
    const { getCompletions } = await import('../lib/completion-writer.js');
    const featureCode = req.query.featureCode || undefined;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const result = getCompletions(getTargetRoot(), {
      feature_code: featureCode,
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

Notes:
- `getCompletions` is synchronous; the `await import` is only for lazy module load
  (matches the lazy-import convention used by the MCP `toolGetCompletions` and other
  vision-routes handlers). `getTargetRoot` resolves the bound workspace root.
- No new endpoint when called without `featureCode` returns all features' completions
  (existing lib behavior); the cockpit always passes `featureCode`.

---

## Shared-File Integration

### `src/components/vision/ItemDetailPanel.jsx` (existing) — import + one mount line

**Import** (add to the shared-component import block, after line 10 / 11):
```js
import CompletionBadge from './shared/CompletionBadge.jsx';
```
Anchor — existing line 10:
```
import ConfidenceBar from './shared/ConfidenceBar.jsx';
```

**Mount** — directly after the existing `ConfidenceBar` mount (current lines 466-467),
i.e. between the ConfidenceBar and the "Phase selector" block (line 469). This places the
recorded-completion view immediately under the status/confidence row, next to the status
control, as the row specifies.

Existing anchor (lines 466-468):
```jsx
          {/* COMP-UI-5: ConfidenceBar — read-only visual display (4-bar with color + label) */}
          <ConfidenceBar level={item.confidence || 0} />

```
Insert immediately below (single mount line + comment):
```jsx
          {/* COMP-PARITY-5: recorded-completion view + divergence flag (read-only) */}
          <CompletionBadge featureCode={item.lifecycle?.featureCode} status={item.status} />
```
`CompletionBadge` returns `null` for items without `lifecycle.featureCode` (free
ideabox items), so the unconditional mount is safe.

### `server/vision-server.js` — NO change
The new route is added inside the existing `attachVisionRoutes(...)` in
`server/vision-routes.js`, which is already imported and attached by `vision-server.js`.
No new route module, no new registration line.

---

## Tests planned

### `test/completions-route.test.js` (node --test) — server
Pattern: mirror `test/budget-ledger.test.js` route-integration (build an `express` app,
`attachVisionRoutes`, `http` request). Seed `docs/features/<CODE>/feature.json` with a
`completions[]` array via `lib/feature-json.js#writeFeature` (mirror
`test/completion-writer.test.js`), point `getTargetRoot()` at the temp root.

- [ ] **golden**: feature with one completion → `GET /api/completions?featureCode=<C>&limit=1`
      returns 200, `count === 1`, `completions[0].commit_sha_short` + `tests_pass` present.
- [ ] **no completion**: feature with no `completions[]` → 200, `count === 0`,
      `completions === []`.
- [ ] **unknown featureCode**: → 200, `count === 0` (not 404 — read returns empty).
- [ ] **limit honored**: feature with 2 completions, `limit=1` → returns the newest one
      only (sorted desc by `recorded_at`).
- [ ] **read is open**: route succeeds with no `x-compose-token` even when `guardAuth`
      capability is on (asserts it is not wrapped in `guardAuth`).

### `test/ui/completion-badge.test.jsx` (vitest) — UI
Mock `wsFetch` (the module that `CompletionBadge` imports) per the `drift-ribbon`/`SessionHistory`
fetch pattern; use `@testing-library/react` `render` + `findBy*` for the async fetch.

- [ ] **golden — completion shows SHA + pass**: featureCode resolves to a completion with
      `commit_sha_short:'c149a4e5'`, `tests_pass:true`; assert `completion-sha` shows
      `c149a4e5` and `completion-tests` shows "tests pass" (emerald), no `completion-divergence`.
- [ ] **tests-failed badge**: `tests_pass:false` → `completion-tests` shows "tests failed" (rose).
- [ ] **divergence — completion but status not complete**: `status:'in_progress'` + a
      completion → `completion-divergence` present, message mentions the SHA and `in_progress`.
- [ ] **divergence — status complete but no completion**: `status:'complete'`, fetch returns
      `{completions:[]}` → `completion-divergence` present, message "no recorded completion".
- [ ] **neutral — no completion, status not complete**: `status:'planned'`, empty fetch →
      `completion-none` present, NO `completion-divergence`.
- [ ] **aligned — complete + completion**: `status:'complete'` + completion → badge shown,
      NO `completion-divergence`.
- [ ] **no featureCode**: `featureCode=undefined` (free item) → component renders nothing
      (`queryByTestId('completion-badge')` is null).

### `test/ui/completion-divergence.test.jsx` (vitest) OR a `describe` block in the above — pure logic
Direct unit tests of `computeDivergence(status, latest)` covering the 5 design.md rule rows:
- [ ] no completion + non-complete → `{diverged:false, kind:'none'}`
- [ ] no completion + complete → `{diverged:true}`
- [ ] completion + complete → `{diverged:false, kind:'aligned'}`
- [ ] completion + in_progress → `{diverged:true}` (message has SHA)
- [ ] completion + killed → `{diverged:false, kind:'aligned-terminal'}`

---

## Verification table

| Ref in this blueprint | Claim | Verified against actual file |
|---|---|---|
| `ItemDetailPanel.jsx:10` | `import ConfidenceBar from './shared/ConfidenceBar.jsx';` (import-block anchor) | ✅ confirmed (line 10) |
| `ItemDetailPanel.jsx:466-467` | `ConfidenceBar` mount; "Phase selector" begins line 469 | ✅ confirmed (mount 466-467, Phase block at 469-482) |
| `ItemDetailPanel.jsx:449-464` | Status `<select>` (PATCH via `onUpdate`) + ConfidenceControl row | ✅ confirmed |
| `ItemDetailPanel.jsx:141-176` | `SessionHistory` self-fetch pattern (`wsFetch`+`AbortController`, keyed on featureCode, null when empty) | ✅ confirmed |
| `ItemDetailPanel.jsx` uses `item.lifecycle?.featureCode` | item carries lifecycle.featureCode (used at line 444-445, 551-552) | ✅ confirmed |
| `item.status` lowercase (`complete`,`in_progress`,…) | normalizeStatus in feature-scan emits lowercase keys | ✅ confirmed (`feature-scan.js:84-96`) |
| no `completions` in `src/` | needs server endpoint (not on item object) | ✅ confirmed (`grep -rn completions src/` → 0 hits) |
| `lib/completion-writer.js#getCompletions(cwd, opts)` → `{completions,count}`, sorted desc by `recorded_at`, records carry `commit_sha_short`/`tests_pass`/`recorded_at` | reuse for endpoint + divergence | ✅ confirmed (`completion-writer.js:436-508`; live sample records confirm fields) |
| `getCompletions` is synchronous | `await import` is for module load only | ✅ confirmed (`export function getCompletions` — not async) |
| `vision-routes.js:45` imports `getTargetRoot` | available to new handler | ✅ confirmed |
| `vision-routes.js:97,171` other GET reads are unwrapped (no `guardAuth`) | new read endpoint stays open | ✅ confirmed (only mutations use `guardAuth`) |
| `vision-routes.js:79` `attachVisionRoutes(...)` is the registration site; `vision-server.js` attaches it | no `vision-server.js` edit needed | ✅ confirmed (route added inside existing fn) |
| `shared/RelativeTime.jsx` props `{date, className}` | reused for timestamp | ✅ confirmed |
| `shared/StatusBadge.jsx` chip style (`text-[10px]`, rounded-full, tailwind tokens) | style match for CompletionBadge chips | ✅ confirmed |
| `shared/driftRibbonLogic.js` pure-helper + `drift-ribbon.test.jsx` | precedent for `completionDivergence.js` + its test | ✅ confirmed (helper imported & tested directly) |
| `test/budget-ledger.test.js` route-integration shape (`express`+`attachVisionRoutes`+`http`) | server test pattern | ✅ confirmed |
| `test/completion-writer.test.js` (`writeFeature` seed of completions[]) | server test seeding pattern | ✅ confirmed |
| `test/ui/item-detail-start-button.test.jsx` (render ItemDetailPanel) / `drift-ribbon.test.jsx` (render + helper) | UI test patterns | ✅ confirmed |
