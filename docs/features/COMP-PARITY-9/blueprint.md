# COMP-PARITY-9 — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4 — verified against source, not yet implemented)
**Feature:** UI feature scaffolding (New Feature dialog)

Reuse contract (do **not** reimplement scaffolding):
- `addRoadmapEntry(cwd, args)` — `lib/feature-writer.js:99`. Creates `feature.json`
  (`provider.createFeature`), regenerates `ROADMAP.md` (`provider.renderRoadmap`),
  validates the code (`validateCode`), refuses duplicates, returns the **compact**
  object `{ code, phase, position, roadmap_path, roundtrip }`. Requires `code`,
  `description`, `phase`.
- `isFeatureCode(code)` — `lib/feature-code.js` (`FEATURE_CODE_RE_STRICT =
  /^[A-Z][A-Z0-9-]*[A-Z0-9]$/`). Client + server validation single source of truth.
- `requireSensitiveOrPaired as requireSensitiveToken` — `server/security.js:61`
  (same alias used in `server/build-routes.js:17`).
- `resolveFeaturesPathFromConfig` / `relForDisplay` — `lib/project-paths.js` (used by
  `ideabox-routes.js:28`) to resolve the absolute features dir for the seed
  `design.md` write + the display path in the response.

---

## New files

### 1. `server/feature-scaffold-routes.js` (new) — exports `attachFeatureScaffoldRoutes`

Mirrors `server/build-routes.js` exactly (auth alias, `deps` injection for tests,
compact JSON, status-code mapping). Default deps resolve the live project root.

```js
/**
 * feature-scaffold-routes.js — POST /api/features/scaffold.
 *
 * Cockpit equivalent of `compose feature <CODE>`: scaffolds docs/features/<CODE>/
 * (feature.json + seed design.md) and the ROADMAP.md row. Reuses the typed writer
 * addRoadmapEntry (lib/feature-writer.js) — never reimplements scaffolding and
 * never echoes the regenerated roadmap back (the lib return is already compact).
 *
 * Sensitive (mutating). attachFeatureScaffoldRoutes(app, deps?) — deps is for tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';
import { addRoadmapEntry as defaultAddRoadmapEntry } from '../lib/feature-writer.js';
import { isFeatureCode } from '../lib/feature-code.js';
import { getTargetRoot as defaultGetProjectRoot } from './project-root.js';
import { resolveFeaturesPathFromConfig, relForDisplay } from '../lib/project-paths.js';

const DEFAULT_PHASE = 'Backlog';

export function attachFeatureScaffoldRoutes(app, deps = {}) {
  const addRoadmapEntry = deps.addRoadmapEntry || defaultAddRoadmapEntry;
  const getProjectRoot = deps.getProjectRoot || defaultGetProjectRoot;

  app.post('/api/features/scaffold', requireSensitiveToken, async (req, res) => {
    const body = req.body || {};
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const phase = (typeof body.phase === 'string' && body.phase.trim())
      || (typeof body.group === 'string' && body.group.trim())
      || DEFAULT_PHASE;

    if (!isFeatureCode(code)) {
      return res.status(400).json({ error: 'Invalid feature code (e.g. COMP-FOO-1)' });
    }
    if (!description) {
      return res.status(400).json({ error: 'description is required' });
    }

    const projectRoot = getProjectRoot();
    try {
      // 1. feature.json + ROADMAP.md row (compact return — no roadmap echo).
      const result = await addRoadmapEntry(projectRoot, { code, description, phase });

      // 2. Seed design.md stub (addRoadmapEntry does not write it). Idempotent.
      //    Resolve the ABSOLUTE features dir (may be relocated) — mirror ideabox.
      let featurePath = null;
      try {
        const composeJsonPath = path.join(projectRoot, '.compose', 'compose.json');
        let cfg = {};
        if (fs.existsSync(composeJsonPath)) {
          try { cfg = JSON.parse(fs.readFileSync(composeJsonPath, 'utf-8')); } catch {}
        }
        const featuresBase = resolveFeaturesPathFromConfig(projectRoot, cfg);
        const featureDir = path.join(featuresBase, code);
        const designPath = path.join(featureDir, 'design.md');
        if (!fs.existsSync(designPath)) {
          const today = new Date().toISOString().slice(0, 10);
          fs.mkdirSync(featureDir, { recursive: true });
          fs.writeFileSync(designPath,
            `# ${code}: ${description}\n\n**Status:** PLANNED\n**Created:** ${today}\n\n---\n\n## Intent\n\n${description}\n\n---\n\n## Notes\n\n_Seed design doc created by the New Feature dialog. \`compose build\` will expand it._\n`);
        }
        featurePath = relForDisplay(projectRoot, featureDir);
      } catch { /* design seed is best-effort; feature.json + roadmap already written */ }

      // COMPACT result — never the full roadmap (memory: MCP add_roadmap_entry echo
      // blows the token cap; the lib return is small, keep it small here too).
      return res.json({
        ok: true,
        code: result.code,
        phase: result.phase,
        position: result.position,
        roadmap_path: result.roadmap_path,
        featurePath,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const code409 = /already exists/i.test(msg);
      return res.status(code409 ? 409 : 400).json({ error: msg });
    }
  });
}
```

Notes:
- Root resolver: `server/project-root.js` exports `getTargetRoot()` (verified
  `project-root.js:47`) — there is **no** `getProjectRoot` export, so the default
  import aliases `getTargetRoot`. The attach site also deps-injects
  `getProjectRoot: () => getTargetRoot()` (the established pattern, e.g.
  `vision-server.js:135`), so the default import is only the test-path fallback.
- The handler does **not** broadcast; the cockpit re-hydrates the roadmap on the
  dialog's success callback. (A `broadcastMessage` dep can be added if a WS
  `roadmapUpdated`-style channel is later wired — out of scope for v1.)

### 2. `src/components/vision/NewFeatureDialog.jsx` (new) — default export `NewFeatureDialog`

Single-step dialog mirroring `IdeaboxPromoteDialog.jsx` (Dialog primitive, `Button`,
class conventions) but without the wizard. Uses `wsFetch` directly (auth + workspace
header injection — `src/lib/wsFetch.js`).

```jsx
import React, { useState, useRef, useEffect } from 'react';
import { FilePlus, Check } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog.jsx';
import { Button } from '@/components/ui/button.jsx';
import { wsFetch } from '@/lib/wsFetch.js';

const CODE_RE = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/; // mirror lib/feature-code.js FEATURE_CODE_RE_STRICT

export default function NewFeatureDialog({ open, onClose, onCreated }) {
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { code, featurePath }
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setCode(''); setDescription(''); setPhase('');
      setError(''); setResult(null); setSubmitting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const submit = async () => {
    if (submitting) return;
    const c = code.trim().toUpperCase();
    if (!CODE_RE.test(c)) { setError('Use a code like COMP-FOO-1'); return; }
    if (!description.trim()) { setError('Description is required'); return; }
    setSubmitting(true); setError('');
    try {
      const res = await wsFetch('/api/features/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: c, description: description.trim(), phase: phase.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult({ code: data.code, featurePath: data.featurePath });
      onCreated?.(data);
    } catch (err) {
      setError(err.message || 'Failed to create feature');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FilePlus className="w-4 h-4 text-accent" />
            New Feature
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="px-6 pb-2 flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-10 h-10 rounded-full bg-emerald-400/20 flex items-center justify-center">
              <Check className="w-5 h-5 text-emerald-400" />
            </div>
            <p className="text-sm font-semibold text-foreground">Created!</p>
            <p className="text-[12px] text-muted-foreground">
              <span className="font-mono text-accent font-semibold">{result.code}</span>
              {result.featurePath && <> · <span className="font-mono">{result.featurePath}</span></>}
            </p>
            <Button size="sm" onClick={onClose} className="mt-1">Close</Button>
          </div>
        ) : (
          <>
            <div className="px-6 pb-2 space-y-3">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1.5">Feature Code</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={code}
                  onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                  placeholder="e.g. COMP-FOO-1"
                  className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring font-mono"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1.5">Description</span>
                <input
                  type="text"
                  value={description}
                  onChange={e => { setDescription(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                  placeholder="One-line description for the ROADMAP cell"
                  className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1.5">Phase <span className="opacity-60 normal-case">(optional)</span></span>
                <input
                  type="text"
                  value={phase}
                  onChange={e => setPhase(e.target.value)}
                  placeholder="Phase heading (default: Backlog)"
                  className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring"
                />
              </label>
              {error && <p className="text-[11px] text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
              <Button size="sm" onClick={submit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create Feature'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

### 3. `test/feature-scaffold-route.test.js` (new) — server golden + error harness (node --test)

Mirror `test/build-routes.test.js` (express app, `listen`/`request` helpers,
`COMPOSE_API_TOKEN` set in `before`, deps-injected `addRoadmapEntry` + `getProjectRoot`).

### 4. `test/ui/new-feature-dialog.test.jsx` (new) — dialog UI test (vitest)

Mirror `test/ui/challenge-modal-host.test.jsx` (`vi.mock('../../src/lib/wsFetch.js')`,
`render`, `fireEvent`, `waitFor`).

---

## Endpoint

`POST /api/features/scaffold` — auth-gated (`requireSensitiveOrPaired`).

| Case | Response |
|------|----------|
| valid `{ code, description, phase? }` | `200 { ok, code, phase, position, roadmap_path, featurePath }` |
| missing/empty `description` | `400 { error: 'description is required' }` |
| invalid `code` (fails `isFeatureCode`) | `400 { error: 'Invalid feature code …' }` |
| duplicate `code` (`addRoadmapEntry` throws `already exists`) | `409 { error }` |
| narrative-owned workspace refusal | `400 { error }` (clean message from `addRoadmapEntry`) |
| no `COMPOSE_API_TOKEN` / bad token | `503` / `401` (from `requireSensitiveToken`) |

Return is **compact** — the regenerated roadmap is never serialized into the body.

---

## Shared-File Integration

All edits are **discrete additive anchored insertions** (sibling import / attach /
mount lines). COMP-PARITY-2/-6/-8 also touch these files in parallel — never rewrite,
only insert next to the named anchor.

### `server/vision-server.js`

1. **Import** — insert a sibling import next to the other route-module imports.
   Anchor (verified `vision-server.js:35`):
   ```js
   import { attachBuildRoutes } from './build-routes.js';
   ```
   Insert immediately after it:
   ```js
   import { attachFeatureScaffoldRoutes } from './feature-scaffold-routes.js';
   ```

2. **Attach** — insert a sibling attach call next to `attachBuildRoutes(app);`.
   Anchor (verified `vision-server.js:158-159`):
   ```js
       // ── Build start/abort routes (sensitive) ───────────────────────────────
       attachBuildRoutes(app);
   ```
   Insert immediately after line 159:
   ```js
       // ── Feature scaffold route (sensitive) — COMP-PARITY-9 ──────────────────
       attachFeatureScaffoldRoutes(app, { getProjectRoot: () => getTargetRoot() });
   ```
   (`getTargetRoot` is the in-scope project-root resolver already used by the other
   attach calls, e.g. `vision-server.js:135` passes `() => getTargetRoot()`. Passing
   it as a dep avoids any ambiguity over `project-root.js`'s export surface and
   matches the established pattern.)

### `src/App.jsx`

1. **Import** — sibling to the existing dialog imports.
   Anchor (verified `App.jsx:67`):
   ```js
   import ItemFormDialog from './components/vision/shared/ItemFormDialog.jsx';
   ```
   Insert a sibling line after it:
   ```js
   import NewFeatureDialog from './components/vision/NewFeatureDialog.jsx';
   ```

2. **State** — sibling to the existing dialog-open state.
   Anchor (verified `App.jsx:539`):
   ```js
     const [pairDeviceOpen, setPairDeviceOpen] = useState(false);
   ```
   Insert after it:
   ```js
     const [newFeatureOpen, setNewFeatureOpen] = useState(false);
   ```

3. **Header button** — sibling icon button in the header controls block.
   Anchor (verified `App.jsx:1116-1123`, the "Pair mobile device" button inside
   `{/* Controls */}` at `App.jsx:1104`). Insert a sibling button immediately before
   the Pair button:
   ```jsx
             {/* New feature (COMP-PARITY-9) */}
             <button
               className="compose-btn-icon"
               onClick={() => setNewFeatureOpen(true)}
               title="New feature"
               aria-label="New feature"
             >
               {'➕'}
             </button>
   ```
   (Plain emoji glyph matches the existing icon-button convention at `App.jsx:1122`
   `'\u{1F4F1}'`. If a lucide icon is preferred in review, swap for `<FilePlus />`.)

4. **Dialog mount** — sibling to the existing dialog mounts near the end of the tree.
   Anchor (verified `App.jsx:1455-1458`, the `<PairDeviceModal …/>` mount). Insert a
   sibling mount immediately after it:
   ```jsx
         <NewFeatureDialog
           open={newFeatureOpen}
           onClose={() => setNewFeatureOpen(false)}
         />
   ```
   (`onCreated` is optional; the roadmap re-hydrates from the live WS / next poll. If
   an explicit refresh is desired, wire `onCreated` to the roadmap store's hydrate —
   out of scope for v1.)

---

## Tests planned

### `test/feature-scaffold-route.test.js` (node --test) — server

- **Golden:** valid POST with deps-injected `addRoadmapEntry` returns `200` and the
  compact body `{ ok:true, code, phase, position, roadmap_path }`; assert the
  injected `addRoadmapEntry` was called once with `{ code, description, phase }`.
- **Compact return / no roadmap echo:** assert the response body has **no** key
  containing the full roadmap text (e.g. body has no large `roadmap`/markdown field;
  only `roadmap_path` string). Inject an `addRoadmapEntry` that would *also* return a
  bulky field and assert the handler does not pass it through.
- **Invalid code → 400** (`addRoadmapEntry` never called).
- **Missing description → 400** (`addRoadmapEntry` never called).
- **Duplicate code → 409:** injected `addRoadmapEntry` throws `Error('feature-writer:
  feature "X" already exists')` → `409`.
- **Other writer error → 400:** injected throw with a non-"already exists" message.
- **Auth:** no token → `503`; wrong token → `401` (set/unset `COMPOSE_API_TOKEN` in
  `before`/`after`, exactly like `build-routes.test.js:75-83`).
- Optionally one **real-backend golden** against a temp project dir (mkdtemp + minimal
  `.compose/compose.json` + `ROADMAP.md`) asserting `docs/features/<CODE>/feature.json`,
  `design.md`, and a new `ROADMAP.md` row all exist on disk after a `200`. (Per testing
  rules: prefer real backends for the one golden flow.)

### `test/ui/new-feature-dialog.test.jsx` (vitest) — dialog

- `vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }))`.
- **Submit golden:** fill code + description, click Create → `wsFetch` called once
  with `'/api/features/scaffold'`, method `POST`, body containing the upper-cased
  code + description; success state shows the created code.
- **Client validation:** invalid code (e.g. `foo`) → error shown, `wsFetch` **not**
  called.
- **Server error surfaced:** `wsFetch` resolves `{ ok:false, status:409, json:async
  () => ({ error:'… already exists' }) }` → error text rendered, no success state.
- **No hardcoded host:** the called URL is relative (`not.toMatch(/localhost|:4001/)`),
  mirroring `challenge-modal-host.test.jsx`.

---

## Verification table

| Ref | File:line | Verified fact |
|-----|-----------|---------------|
| `addRoadmapEntry` | `lib/feature-writer.js:99` | `export async function addRoadmapEntry(cwd, args)`; validates code, requires `description`+`phase`, refuses duplicates (`already exists`), returns `{ code, phase, position, roadmap_path, roundtrip }` (compact) |
| `validateCode` / `isFeatureCode` | `lib/feature-code.js` | `FEATURE_CODE_RE_STRICT = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/`; `isFeatureCode` is the non-throwing predicate |
| auth alias | `server/security.js:61` | `export function requireSensitiveOrPaired(req,res,next)`; `requireSensitiveToken` at `:37` (503 no token / 401 bad token) |
| auth-import pattern | `server/build-routes.js:17` | `import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js'` |
| route-test template | `test/build-routes.test.js:21-86` | express app + `listen`/`request` helpers + token set in `before`/`after`; deps-injection via `attachBuildRoutes(app, { runBuild, … })` |
| MCP echo hazard | memory `reference_roadmap_tools_oversized_return.md` | the *MCP* `add_roadmap_entry` blows token cap by echoing full ROADMAP; lib `addRoadmapEntry` return is compact — call the lib, not the MCP tool |
| `scaffold_feature` is NOT the right reuse | `server/compose-mcp-tools.js:707` | `toolScaffoldFeature` → `ArtifactManager.scaffold` scaffolds phase-artifact stubs only; no feature.json / roadmap row |
| CLI verb (parity target) | `bin/compose.js:939`, seed design `:1046-1065` | inline scaffold: folder + feature.json + seed design.md + ROADMAP row |
| ideabox promote model | `server/ideabox-routes.js:152-209` | handler shape, `resolveFeaturesPathFromConfig` + `relForDisplay`, status-code-from-message mapping, absolute features-dir resolution |
| project-paths helpers | `lib/project-paths.js` (import at `ideabox-routes.js:28`) | `resolveFeaturesPathFromConfig`, `relForDisplay` exist and are imported elsewhere |
| store auth wrapper | `src/lib/wsFetch.js:58` | `wsFetch(url, opts)` injects `x-compose-token` / workspace header / `Authorization` per mode — the dialog's auth path |
| dialog UX model | `src/components/vision/IdeaboxPromoteDialog.jsx` | Dialog/Button/Badge primitives, class conventions, success step |
| vision-server import anchor | `server/vision-server.js:35` | `import { attachBuildRoutes } from './build-routes.js';` |
| vision-server attach anchor | `server/vision-server.js:158-159` | `// ── Build start/abort routes (sensitive) …` then `attachBuildRoutes(app);` |
| vision-server root resolver | `server/vision-server.js:135` | other attach calls receive `() => getTargetRoot()` — reuse for the new attach dep |
| App.jsx import anchor | `src/App.jsx:67` | `import ItemFormDialog from './components/vision/shared/ItemFormDialog.jsx';` |
| App.jsx state anchor | `src/App.jsx:539` | `const [pairDeviceOpen, setPairDeviceOpen] = useState(false);` |
| App.jsx header controls | `src/App.jsx:1104`, Pair button `:1116-1123` | `{/* Controls */}` flex row; `compose-btn-icon` button convention, emoji glyph `'\u{1F4F1}'` at `:1122` |
| App.jsx dialog mount anchor | `src/App.jsx:1455-1458` | `<PairDeviceModal open={pairDeviceOpen} onClose={…}/>` sibling-mount site |
| vitest config / setup | `vitest.config.js`, `test/ui/setup.js` | `include: ['test/ui/**/*.test.{js,jsx}']`, jsdom, `@`→`./src` alias |
| UI-test template | `test/ui/challenge-modal-host.test.jsx:1-40` | `vi.mock` wsFetch, `render`/`fireEvent`/`waitFor`, relative-URL assertion |
| root resolver export | `server/project-root.js:47` | `export function getTargetRoot()` is the project-root resolver; **no** `getProjectRoot` export — default import aliases `getTargetRoot`; attach site deps-injects `() => getTargetRoot()` |

All anchors verified against source; no open verification items.
