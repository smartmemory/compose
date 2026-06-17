# COMP-PARITY-8 — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4) — verified against the live codebase 2026-06-17.

Cross-refs: `docs/features/COMP-PARITY-8/design.md`.

## Coexistence with COMP-PARITY-2 (read first)

PARITY-2 also edits `server/build-routes.js`, `src/App.jsx`, and
`src/lib/startBuild.js` (it adds `mode:'new'`/resume). **Every edit below to
those three files is an additive, anchored insertion** — a new branch, a new
import line, a new mount, or a new optional field. No shared block is rewritten;
no shared component is introduced. If a merge conflict arises it will be a
trivial adjacency conflict (two sibling branches / two sibling imports), not a
semantic one. My new `mode` values (`'all'`, `'gsd'`) are disjoint from
PARITY-2's (`'new'`), and my optional startBuild field is distinct from any
`resume` flag PARITY-2 adds.

---

## New files

### 1. `src/components/cockpit/BuildAllGsdControl.jsx` (new)

Self-contained header control. Mirrors `EnvironmentHealthPanel.jsx` (header
button + popover, `wsFetch`/context-free) for placement and
`StartBuildPopover.jsx` for popover styling and testid conventions. Does **not**
import or reuse PARITY-2's launcher.

Behavior:
- A header icon button (`compose-btn-icon`) labelled for batch builds,
  `data-testid="build-all-gsd-trigger"`, toggles an absolutely-positioned
  popover.
- Popover (`data-testid="build-all-gsd-popover"`) holds two actions:
  - **Build all PLANNED** button (`data-testid="build-all-submit"`). On click,
    `await confirm({ title: 'Build all PLANNED features?', body: '...roadmap-wide, expensive...' })`
    via `useConfirm()` from `src/components/ui/DialogProvider.jsx`
    (provider already wraps the app at `src/main.jsx:14`). If confirmed, call
    `startBuild({ mode: 'all' })` (no `featureCode`).
  - **GSD** section: a feature-code text input
    (`data-testid="build-gsd-feature-input"`) + a **Run GSD** button
    (`data-testid="build-gsd-submit"`, disabled until the input is non-empty).
    On submit, `startBuild({ featureCode: code.trim(), mode: 'gsd' })`.
- Error handling mirrors `StartBuildPopover`: catch the thrown `Error`
  (carries `.status`), render in a `role="alert"` block
  (`data-testid="build-all-gsd-error"`); on success close the popover.
- `submitting` state disables both buttons while a request is in flight.

Imports: `React, { useState }`, `{ startBuild } from '../../lib/startBuild.js'`,
`{ useConfirm } from '../ui/DialogProvider.jsx'`.

### 2. `test/build-all-gsd-routes.test.js` (new)

Node `node --test` server test. Mirrors `test/build-routes.test.js` exactly
(same `makeApp`/`listen`/`request` helpers, same `COMPOSE_API_TOKEN` token
setup). Injects mock `runBuildAll` / `runGsd` via the `deps` param. See **Tests
planned**.

### 3. `test/ui/build-all-gsd-control.test.jsx` (new)

Vitest UI test. Mirrors `test/ui/start-build-popover.test.jsx` (mock `fetch`,
`setSensitiveToken`). Wraps the control in a `DialogProvider` so `useConfirm`
resolves. See **Tests planned**.

---

## Server changes — `server/build-routes.js`

All edits are **inside the existing `POST /api/build/start` handler** (lines
39–58) plus the `attachBuildRoutes` deps block (lines 21–24) and the import
block (lines 16–19). Additive only.

### 3a. Import the two batch dispatchers (anchor: line 16 import block)

Anchor — the existing import on line 16:
```js
import { runBuild as defaultRunBuild, abortBuild as defaultAbortBuild } from '../lib/build.js';
```
Insert **after** it (new lines, distinct from PARITY-2's imports):
```js
// COMP-PARITY-8: batch dispatchers reused by mode:'all' / mode:'gsd'.
import { runBuildAll as defaultRunBuildAll } from '../lib/build-all.js';
import { runGsd as defaultRunGsd } from '../lib/gsd.js';
```

### 3b. Wire the deps (anchor: lines 22–24 deps block)

Anchor — the existing deps destructuring at lines 22–24:
```js
  const runBuild = deps.runBuild || defaultRunBuild;
  const abortBuild = deps.abortBuild || defaultAbortBuild;
  const getDataDir = deps.getDataDir || defaultGetDataDir;
```
Insert **after** the `getDataDir` line (additive):
```js
  // COMP-PARITY-8: injectable for tests, defaults to the CLI implementations.
  const runBuildAll = deps.runBuildAll || defaultRunBuildAll;
  const runGsd = deps.runGsd || defaultRunGsd;
```

### 3c. Widen validation + add the two mode branches (anchor: handler lines 40–53)

The current handler body (lines 40–53):
```js
    const body = req.body || {};
    const { featureCode, mode = 'feature', description = '' } = body;
    if (!featureCode) {
      return res.status(400).json({ error: 'featureCode required' });
    }
    if (mode !== 'feature' && mode !== 'bug') {
      return res.status(400).json({ error: "mode must be 'feature' or 'bug'" });
    }
    try {
      const opts = mode === 'bug'
        ? { mode, template: 'bug-fix', description }
        : { mode, description };
      const result = await runBuild(featureCode, opts);
      res.json(result ?? { ok: true });
```

**Edit — make `featureCode` conditional and add the branches. Backward-compatible:**
`mode:'feature'`/`'bug'` keep their exact existing behavior. PARITY-2's `mode:'new'`
(if it lands first) is a sibling branch in the same try block — both can coexist.

Replace the validation + dispatch region with (additive widening; the
`feature`/`bug` path is byte-identical to today):
```js
    const body = req.body || {};
    const { featureCode, mode = 'feature', description = '' } = body;
    // COMP-PARITY-8: mode:'all' is roadmap-wide and needs no featureCode.
    if (!featureCode && mode !== 'all') {
      return res.status(400).json({ error: 'featureCode required' });
    }
    // COMP-PARITY-8: 'all' and 'gsd' join the accepted modes. (PARITY-2 may
    // likewise add 'new' here — keep the allowed set as additive sibling checks.)
    if (mode !== 'feature' && mode !== 'bug' && mode !== 'all' && mode !== 'gsd') {
      return res.status(400).json({ error: "mode must be 'feature', 'bug', 'all', or 'gsd'" });
    }
    try {
      // COMP-PARITY-8: roadmap-wide batch build. No featureCode; reuses the
      // same auth + error mapping. runBuildAll reads ROADMAP.md under cwd.
      if (mode === 'all') {
        const result = await runBuildAll({});
        return res.json(result ?? { ok: true });
      }
      // COMP-PARITY-8: per-task fresh-context dispatch for one feature.
      if (mode === 'gsd') {
        const result = await runGsd(featureCode, {});
        return res.json(result ?? { ok: true });
      }
      const opts = mode === 'bug'
        ? { mode, template: 'bug-fix', description }
        : { mode, description };
      const result = await runBuild(featureCode, opts);
      res.json(result ?? { ok: true });
```

Notes:
- The `catch` (lines 54–57) is unchanged — `runGsd`'s "already active"-style
  throws still map to 409; everything else to 500.
- `runBuildAll({})` / `runGsd(code, {})` default `cwd` to `process.cwd()`, which
  is the server's project root — the same root the CLI uses. (`runBuildAll`
  signature: `lib/build-all.js:33`; `runGsd`: `lib/gsd.js:50`.)

---

## Shared-File Integration

### `server/build-routes.js`
- **What:** import 2 batch dispatchers (3a), wire 2 deps (3b), widen the
  `featureCode`/`mode` guards and add `if (mode === 'all')` + `if (mode === 'gsd')`
  branches (3c). All additive.
- **Coexists with PARITY-2:** PARITY-2 adds a `mode:'new'` branch + its own
  import/deps in the same regions. My modes (`'all'`,`'gsd'`) are disjoint; the
  validation `if` is widened with additional `&&`-clauses that PARITY-2 can
  extend the same way. Sibling-adjacency only.

### `src/App.jsx`
- **What:** one import line + one mount in the header controls region.
- **Anchor (import):** after the existing cockpit import block, e.g. after
  line 17 (`import EnvironmentHealthPanel from './components/cockpit/EnvironmentHealthPanel.jsx';`):
  ```js
  import BuildAllGsdControl from './components/cockpit/BuildAllGsdControl.jsx'; // COMP-PARITY-8
  ```
- **Anchor (mount):** inside the header `Controls` `<div className="flex items-center gap-2 shrink-0">`
  (opens at **line 1104**). Insert the element directly **after**
  `<EnvironmentHealthPanel />` (line 1113) and before the Pair-mobile button
  (line 1116):
  ```jsx
  {/* Batch build launchers (COMP-PARITY-8) */}
  <BuildAllGsdControl />
  ```
- **Coexists with PARITY-2:** PARITY-2 mounts its own launcher in the same
  controls `<div>`. Two sibling JSX elements + two sibling import lines — no
  shared element edited.

### `src/lib/startBuild.js`
- **What:** make `featureCode` optional so `mode:'all'` can dispatch without a
  code. The helper already forwards `mode`; the only change is the
  signature/body guard.
- **Anchor:** the function signature + body (lines 17–22):
  ```js
  export async function startBuild({ featureCode, mode = 'feature', description = '' }) {
    const res = await wsFetch('/api/build/start', {
      method: 'POST',
      headers: withComposeToken({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ featureCode, mode, description }),
    });
  ```
- **Edit (additive, backward-compatible):** default `featureCode` to `undefined`
  and omit it from the body when absent so existing callers (which always pass a
  code) serialize identically:
  ```js
  export async function startBuild({ featureCode, mode = 'feature', description = '' }) {
    // COMP-PARITY-8: mode:'all' is roadmap-wide and carries no featureCode.
    const payload = { mode, description };
    if (featureCode) payload.featureCode = featureCode;
    const res = await wsFetch('/api/build/start', {
      method: 'POST',
      headers: withComposeToken({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
  ```
  - **Note:** existing `feature`/`bug` callers always pass `featureCode`, so the
    `{ featureCode, mode, description }` shape is preserved for them (key order
    differs but the JSON contract `{featureCode, mode, description}` is
    unchanged — `start-build-popover.test.jsx:42` asserts via `toEqual`, which
    is order-insensitive). Verify that test still passes; if strict order is
    ever required, keep `featureCode` first in `payload`.
  - **Coexists with PARITY-2:** PARITY-2 may add a `resume` flag here. Keep my
    change scoped to the optional-`featureCode` guard — a distinct field/concern
    from `resume`.

---

## Tests planned

### `test/build-all-gsd-routes.test.js` (node --test) — golden + error harness
Mirror `test/build-routes.test.js` scaffolding (`makeApp` accepts
`runBuildAll`/`runGsd` deps; `COMPOSE_API_TOKEN` + `x-compose-token`).
- [ ] `mode:'all'` with token → calls `runBuildAll`, returns its
      `{built,failed,skipped,...}` result; no `featureCode` required (200).
- [ ] `mode:'all'` **without** token → 401.
- [ ] `mode:'gsd'` with `featureCode` + token → calls `runGsd(featureCode, ...)`,
      returns `{status,flowId,blackboardEntries}` (200).
- [ ] `mode:'gsd'` **without** `featureCode` → 400 (`/featureCode/`).
- [ ] `mode:'gsd'` without token → 401.
- [ ] invalid `mode` (e.g. `'wat'`) → 400 (`/feature.*bug.*all.*gsd/i` or
      message match).
- [ ] `runGsd` throwing "already active" → 409 (reuses existing catch mapping);
      other throw → 500.
- [ ] regression: `mode:'feature'` still forwards `{mode,description}` and
      `mode:'bug'` still forwards `template:'bug-fix'` (copy the two existing
      assertions to prove the additive edit didn't regress them).

### `test/ui/build-all-gsd-control.test.jsx` (vitest) — golden
Mirror `test/ui/start-build-popover.test.jsx` (mock `fetch`,
`setSensitiveToken('test-token')`); render inside `<DialogProvider>`.
- [ ] Clicking the trigger opens the popover (`build-all-gsd-popover` visible).
- [ ] **Build all**: click → confirm dialog appears → click
      `dialog-confirm` → `POST /api/build/start` body is `{ mode: 'all',
      description: '' }` (no `featureCode`), token header present.
- [ ] **Build all** cancel: click → dialog `dialog-cancel` → **no** fetch fired.
- [ ] **GSD**: type a code → click `build-gsd-submit` → body is
      `{ featureCode: '<CODE>', mode: 'gsd', description: '' }`.
- [ ] GSD submit disabled when the code input is empty.
- [ ] server 409 → `build-all-gsd-error` alert shown, popover stays open.

---

## Verification table (refs confirmed against live files 2026-06-17)

| Ref | Claim | Verified |
|---|---|---|
| `server/build-routes.js:16` | `import { runBuild ... } from '../lib/build.js'` (import-anchor) | ✓ |
| `server/build-routes.js:22-24` | deps destructuring `runBuild/abortBuild/getDataDir` | ✓ |
| `server/build-routes.js:39` | `app.post('/api/build/start', requireSensitiveToken, ...)` | ✓ |
| `server/build-routes.js:41` | `const { featureCode, mode = 'feature', description = '' } = body` | ✓ |
| `server/build-routes.js:42-47` | `featureCode required` 400 + mode-validation 400 | ✓ |
| `server/build-routes.js:54-57` | catch → 409 on "already active", else 500 | ✓ |
| `server/build-routes.js:17` | auth = `requireSensitiveOrPaired as requireSensitiveToken` | ✓ |
| `lib/build-all.js:33` | `runBuildAll(opts={})` → `{built,failed,skipped,skippedComplete}`; cwd defaults to `process.cwd()` | ✓ |
| `lib/gsd.js:50` | `runGsd(featureCode, opts={})` → `{status,flowId,blackboardEntries}`; cwd defaults to `process.cwd()`; requires `blueprint.md` | ✓ |
| `src/lib/startBuild.js:17-22` | `startBuild({featureCode, mode, description})` posts `{featureCode,mode,description}` | ✓ |
| `src/components/vision/StartBuildPopover.jsx` | popover styling + testid conventions to mirror | ✓ |
| `src/components/cockpit/EnvironmentHealthPanel.jsx:20-22` | header-button + popover pattern to mirror | ✓ |
| `src/App.jsx:1104` | header Controls `<div className="flex items-center gap-2 shrink-0">` (mount anchor) | ✓ |
| `src/App.jsx:1113` | `<EnvironmentHealthPanel />` (insert-after anchor) | ✓ |
| `src/App.jsx:17` | `import EnvironmentHealthPanel ...` (import-after anchor) | ✓ |
| `src/components/ui/DialogProvider.jsx:175` | `export const useConfirm = () => useDialogContext().confirm` | ✓ |
| `src/components/ui/DialogProvider.jsx:69` | `confirm({title, body}) => Promise<boolean>` | ✓ |
| `src/main.jsx:14` | `<DialogProvider>` wraps the app (useConfirm available app-wide) | ✓ |
| `test/build-routes.test.js:28-33` | `makeApp({runBuild,abortBuild,getDataDir})` deps-injection harness to mirror | ✓ |
| `test/ui/start-build-popover.test.jsx:10-19,42` | fetch mock + `toEqual` body assertion to mirror | ✓ |
| `server/vision-server.js:159` | `attachBuildRoutes(app)` mount (import at :35) | ✓ |
