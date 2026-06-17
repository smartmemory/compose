# COMP-PARITY-6 — Implementation Blueprint (verified)

**Status:** Phase 4 (blueprint) — verified against the real codebase. All file:line
refs in the Verification table were confirmed by reading the actual files.

## Related Documents
- Design: `docs/features/COMP-PARITY-6/design.md`
- Pattern source (server): `server/health-routes.js` · `attachHealthRoutes(app, deps?)`
- Pattern source (UI): `src/components/cockpit/EnvironmentHealthPanel.jsx`
- Validator (wrapped, unchanged): `lib/feature-validator.js`

---

## 0. Verified facts (shapes the blueprint depends on)

### Validator public API — `lib/feature-validator.js`
- `export async function validateFeature(cwd, code, options = {})` (line 763) →
  `{ scope: 'feature', feature_code: code, validated_at: <ISO>, findings: [...] }`
  (returns 775/781/795). On a strict-valid code that exists in no source it returns
  a single `FEATURE_NOT_FOUND` `error` finding (lines 770–774) — it does **not** throw.
- `export async function validateProject(cwd, options = {})` (line 1127) →
  `{ scope: 'project', validated_at: <ISO>, findings: [...] }` (line 1231).
- Finding shape (factory `finding()`, lines 312–317):
  `{ severity: 'error'|'warning'|'info', kind: <STRING>, detail: <STRING>, feature_code?: <CODE>, source?: <STRING> }`.
  Severity vocabulary confirmed at line 14 of the module header and throughout.
- `validateFeature` validates the code first via `validateCode(code)` (line 764),
  which throws `INVALID_INPUT` for a malformed code (CLI maps this to exit 2 at
  `bin/compose.js:1825`). The route must catch this and 400, never 500.
- `validateProject` accepts `options.external` (default falsy) to gate network xref
  resolution (line 1023, `runExternalRefChecks`). The route passes **no** `external`
  → local-only, no network. CLI default also omits it for feature scope.

### Workspace root source — `server/workspace-middleware.js`
- `req.workspace = { id, root, source, configPath? }` (header line 4). `root` is the
  resolved project root. `health-routes.js` reads `req.workspace?.root` (lines 189,
  212) — `validate-routes.js` does the same. Integration tests inject `req.workspace`
  via a one-line middleware (see `test/integration/health-routes.test.js:44-48`).

### Read-only endpoint pattern — `server/health-routes.js`
- `export function attachHealthRoutes(app, { … } = {})` (line 150). Read endpoint
  `app.get('/api/environment-health', async (req,res) => …)` (line 156) has **no**
  auth guard (read-only, default-deny-remote by non-allowlisted prefix — header
  lines 15–19). Injectable deps via the destructured second arg (lines 150–155).
- Registered in `server/vision-server.js` at line 92: `attachHealthRoutes(app);`
  inside `attach(httpServer, app)`. Import at line 30.

### UI fetch idiom — `EnvironmentHealthPanel.jsx`
- `import { wsFetch } from '../../lib/wsFetch.js'` (line 22) and
  `useWorkspace()` (line 21). Monotonic `reqIdRef` token guard (lines 108–130).
  Fetch on workspace resolve / identity change (lines 162–165). Manual `↻`
  refresh (lines 213–221). Note: a top-level **view** lives under
  `src/components/vision/` and imports wsFetch from `'../../lib/wsFetch.js'`
  (same depth as `SessionsView.jsx`).

### Tab wiring — three additive sites
- `src/components/cockpit/ViewTabs.jsx` `TAB_META` object (lines 17–29) + the
  `lucide-react` import line (line 15).
- `src/components/cockpit/viewTabsState.js` `DEFAULT_MAIN_TABS` array (lines 17–19).
- `src/App.jsx`: import (near line 57, `SessionsView`), `CockpitView` switch
  (`switch (activeView)` at line 247; add a `case 'validate':` near the
  `case 'sessions':` at line 313).

---

## 1. New files

### `server/validate-routes.js` (new)

Mirrors `health-routes.js`: a single exported attach fn, injectable deps for tests,
read-only GET, degrade-never-500. Wraps the validator; reimplements nothing.

```js
/**
 * validate-routes.js — Read-only cross-artifact validation REST API (COMP-PARITY-6).
 *
 * Route:
 *   GET /api/validate?scope=feature|project&featureCode=<CODE>
 *     Surfaces `compose validate` (lib/feature-validator.js validateFeature/
 *     validateProject) as structured JSON for the cockpit Validate view.
 *     Read-only; local-only (no network xref resolution); degrades, never 500s.
 *
 * Deliberately NOT under an auth-allowlisted prefix (mirrors health-routes.js):
 * non-allowlisted → default-deny in remote mode, open on localhost.
 *
 * Reuses (no logic fork): lib/feature-validator.js validateFeature/validateProject.
 */
import {
  validateFeature as defaultValidateFeature,
  validateProject as defaultValidateProject,
} from '../lib/feature-validator.js';

const SEVERITIES = ['error', 'warning', 'info'];

/** Group a findings array into { error: n, warning: n, info: n }. */
export function summarizeFindings(findings = []) {
  const by = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    if (by[f?.severity] !== undefined) by[f.severity] += 1;
  }
  return by;
}

/**
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {Function} [deps.validateFeature] — injectable (default: lib validator)
 * @param {Function} [deps.validateProject] — injectable (default: lib validator)
 */
export function attachValidateRoutes(app, {
  validateFeature = defaultValidateFeature,
  validateProject = defaultValidateProject,
} = {}) {
  app.get('/api/validate', async (req, res) => {
    const root = req.workspace?.root;
    if (!root) {
      // No workspace to validate — a guarded failure, not a 500.
      return res.json({ scope: null, findings: [], bySeverity: summarizeFindings([]), unavailable: true });
    }
    const scope = req.query.scope === 'feature' ? 'feature' : 'project';
    const featureCode = typeof req.query.featureCode === 'string' ? req.query.featureCode : null;

    if (scope === 'feature' && !featureCode) {
      return res.status(400).json({ error: 'scope=feature requires featureCode' });
    }

    try {
      const result = scope === 'feature'
        ? await validateFeature(root, featureCode)        // local-only; no `external`
        : await validateProject(root, {});                // local-only; no `external`
      const findings = Array.isArray(result.findings) ? result.findings : [];
      // Pass the validator result through verbatim + add the severity rollup.
      return res.json({ ...result, bySeverity: summarizeFindings(findings) });
    } catch (err) {
      // validateCode throws INVALID_INPUT on a malformed feature code → 400.
      if (err && err.code === 'INVALID_INPUT') {
        return res.status(400).json({ error: err.message });
      }
      // Any other failure degrades to a non-500 unavailable body.
      return res.json({ scope, feature_code: featureCode, findings: [], bySeverity: summarizeFindings([]), unavailable: true, error: err?.message || 'validate failed' });
    }
  });
}
```

**Endpoint contract**
- `GET /api/validate` → project scope (default).
- `GET /api/validate?scope=feature&featureCode=COMP-PARITY-6` → feature scope.
- Success body: the validator result object (`scope`, `validated_at`,
  `feature_code?`, `findings[]`) **plus** `bySeverity: { error, warning, info }`.
- `400` only for missing `featureCode` on feature scope, or a malformed code
  (`INVALID_INPUT`). Everything else degrades to a 200 `{ unavailable: true }` body.
- Read-only; no auth guard (matches the health read endpoint).

### `src/components/vision/ValidateView.jsx` (new)

Top-level view. Mirrors the `EnvironmentHealthPanel` fetch idiom (wsFetch +
monotonic token + loading/error/empty) and the `SessionsView` shell (toolbar +
scrollable list + `EmptyState`). Read-only.

```jsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { wsFetch } from '../../lib/wsFetch.js';
import EmptyState from './shared/EmptyState.jsx';

const SEV_COLOR = {
  error:   'hsl(var(--destructive))',
  warning: 'hsl(var(--warning))',
  info:    'hsl(var(--muted-foreground))',
};
const SEV_ORDER = ['error', 'warning', 'info'];

/**
 * ValidateView — read-only `compose validate` findings surface (COMP-PARITY-6).
 *
 * Fetches GET /api/validate for the current scope (project by default; feature
 * when a feature is focused), groups findings by severity. Mirrors the
 * EnvironmentHealthPanel fetch pattern: monotonic request token, manual refresh,
 * degrades — never throws.
 *
 * Props:
 *   featureCode — active feature code (enables feature-scope toggle); from App.
 */
export default function ValidateView({ featureCode }) {
  const [scope, setScope] = useState('project');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqIdRef = useRef(0);

  // A feature-scope request needs a code; fall back to project if none.
  const effectiveScope = scope === 'feature' && featureCode ? 'feature' : 'project';

  const fetchFindings = useCallback(async () => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    try {
      const qs = effectiveScope === 'feature'
        ? `?scope=feature&featureCode=${encodeURIComponent(featureCode)}`
        : '?scope=project';
      const r = await wsFetch(`/api/validate${qs}`);
      const json = await r.json();
      if (myId !== reqIdRef.current) return;
      setData(json);
      setError(null);
    } catch (e) {
      if (myId !== reqIdRef.current) return;
      setData(null);
      setError(e?.message || 'unavailable');
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }, [effectiveScope, featureCode]);

  useEffect(() => { fetchFindings(); }, [fetchFindings]);

  const findings = Array.isArray(data?.findings) ? data.findings : [];
  const grouped = SEV_ORDER.map((sev) => [sev, findings.filter((f) => f.severity === sev)]);

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="validate-view">
      {/* Toolbar: scope toggle + counts + refresh */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <select
          data-testid="validate-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="text-xs px-1.5 py-0.5 h-6 rounded bg-muted text-foreground border border-border cursor-pointer"
        >
          <option value="project">Project</option>
          <option value="feature" disabled={!featureCode}>
            {featureCode ? `Feature: ${featureCode}` : 'Feature (none focused)'}
          </option>
        </select>
        {SEV_ORDER.map((sev) => (
          <span key={sev} className="flex items-center gap-1 text-[10px]">
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[sev], display: 'inline-block' }} />
            <span className="text-muted-foreground">{data?.bySeverity?.[sev] ?? 0} {sev}</span>
          </span>
        ))}
        <button
          data-testid="validate-refresh"
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          onClick={fetchFindings}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh validation findings"
        >
          ↻
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {error && <div className="px-3 py-2 text-destructive text-xs">Unavailable: {error}</div>}
        {data?.unavailable && !error && (
          <div className="px-3 py-2 text-muted-foreground text-xs">Validation unavailable{data.error ? `: ${data.error}` : ''}</div>
        )}
        {!error && !data?.unavailable && findings.length === 0 && (
          <EmptyState
            icon={ShieldCheck}
            title={loading ? 'Validating…' : 'No findings'}
            description="Cross-artifact validation found no issues for this scope"
            className="py-8"
          />
        )}
        {grouped.map(([sev, rows]) => rows.length > 0 && (
          <div key={sev} data-testid={`validate-group-${sev}`}>
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sticky top-0 bg-background">
              {sev} ({rows.length})
            </div>
            {rows.map((f, i) => (
              <div
                key={`${sev}-${i}`}
                data-testid={`validate-finding-${sev}`}
                className="flex items-start gap-2 px-3 py-2 border-b border-border/50 hover:bg-muted/30 transition-colors"
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[sev], display: 'inline-block', marginTop: 4, flexShrink: 0 }} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-foreground">{f.kind}</span>
                    {f.feature_code && (
                      <span className="text-[10px] font-mono text-blue-400">{f.feature_code}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{f.detail}</p>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
```

### `test/validate-routes.test.js` (new) — node --test
### `test/integration/validate-routes.test.js` (new) — node --test, real Express
### `test/ui/validate-view.test.jsx` (new) — vitest

(Contents under "Tests planned".)

---

## 2. Shared-File Integration (EXACT minimal additive edits)

### A. `server/vision-server.js`
**Import** — add after the `attachHealthRoutes` import (existing line 30):
```js
import { attachValidateRoutes } from './validate-routes.js';
```
**Attach** — add immediately after `attachHealthRoutes(app);` (existing line 92),
inside `attach(httpServer, app)` (lines 79–238):
```js
    // ── Validate route (COMP-PARITY-6) ─────────────────────────────────────
    // Read-only GET /api/validate; wraps lib/feature-validator.js, reads
    // cwd off req.workspace.root (same source as health-routes).
    attachValidateRoutes(app);
```

### B. `src/components/cockpit/ViewTabs.jsx`
**Icon import** — `ShieldCheck` is already imported (line 15, used by `gates`).
No import change needed; reuse it (or `ListChecks` if a distinct glyph is wanted —
if so, add `ListChecks` to the line-15 import list).
**TAB_META** — add one entry inside the object (lines 17–29), e.g. after `gates`
(line 24):
```js
  validate:  { label: 'Validate',  icon: ShieldCheck,     tip: 'Cross-artifact validation findings (compose validate)' },
```

### C. `src/components/cockpit/viewTabsState.js`
**DEFAULT_MAIN_TABS** — add `'validate'` to the array (lines 17–19), e.g. after
`'gates'`:
```js
export const DEFAULT_MAIN_TABS = [
  'dashboard', 'graph', 'tree', 'docs', 'journal', 'design', 'gates', 'validate', 'pipeline', 'sessions', 'build-history', 'ideabox'
];
```
(`loadMainTabs` migration at lines 99–111 auto-inserts the new tab for existing
users with persisted tab lists — no extra migration code needed.)

### D. `src/App.jsx`
**Import** — add next to the other vision-view imports (after `SessionsView` import,
existing line 57):
```js
import ValidateView from './components/vision/ValidateView.jsx';
```
**CockpitView switch** — add a `case` inside `switch (activeView)` (line 247),
e.g. immediately after the `case 'sessions':` block (lines 313–323). `featureCode`
is already destructured in `CockpitView`'s props (line 240) and passed from
`AppInner` (line 1303), so no prop-plumbing change is needed:
```jsx
    case 'validate':
      return <ValidateView featureCode={featureCode} />;
```

> No change to `App.jsx` CockpitView prop list — `featureCode` (the active feature
> code) is already destructured (line 240) and threaded through (line 1303).

---

## 3. Tests planned

### `test/validate-routes.test.js` (node --test) — unit, pure helper + injectable route
Mirror `test/health-routes.test.js` (pure helper) + a lightweight Express harness
with **injected** `validateFeature`/`validateProject` stubs (no real validator,
no fs) and an injected `req.workspace`:
- [ ] `summarizeFindings` groups `[error, warning, info]` counts; ignores unknown
      severities; `[]` → `{ error:0, warning:0, info:0 }`.
- [ ] **project scope (default):** GET `/api/validate` → 200, body has
      `scope:'project'`, `findings`, and `bySeverity` matching the stub.
- [ ] **feature scope:** GET `/api/validate?scope=feature&featureCode=FOO-1` calls
      the injected `validateFeature` with `(root, 'FOO-1')`; returns its findings.
- [ ] **feature scope without code:** GET `/api/validate?scope=feature` → **400**
      `{ error: 'scope=feature requires featureCode' }`; validator not called.
- [ ] **malformed code (INVALID_INPUT):** injected `validateFeature` throws
      `Object.assign(new Error('bad'), { code: 'INVALID_INPUT' })` → **400**.
- [ ] **no workspace:** middleware injects `req.workspace = undefined` →
      200 `{ unavailable: true, findings: [] }`, never 500.
- [ ] **severity grouping:** mixed-severity stub findings → `bySeverity` rollup is
      correct and `findings` pass through verbatim (kind/detail/feature_code intact).

### `test/integration/validate-routes.test.js` (node --test) — real validator, real fs
Mirror `test/integration/health-routes.test.js`: real Express on an ephemeral port,
real `lib/feature-validator.js`, a tmp workspace fixture, `req.workspace` injected by
a one-line middleware. Confirms the wrap is wired to the actual validator:
- [ ] **feature scope, unknown feature:** strict-valid code that exists nowhere →
      200 with a `FEATURE_NOT_FOUND` `error` finding (validator's own contract,
      `feature-validator.js:770-774`).
- [ ] **project scope:** GET `/api/validate` on a minimal tmp workspace → 200,
      `scope:'project'`, `findings` an array, `bySeverity` present. (Local-only —
      asserts no network/xref by not setting `external`.)

### `test/ui/validate-view.test.jsx` (vitest) — mirror `test/ui/env-health-panel.test.jsx`
Mock `wsFetch` and `useWorkspace` (if needed) the same way:
- [ ] **fetches on mount (project scope):** asserts `wsFetch` called with
      `/api/validate?scope=project`; renders findings grouped by severity.
- [ ] **renders grouped findings:** a mixed-severity response renders
      `validate-group-error` / `-warning` / `-info` with the right counts and
      `validate-finding-*` rows (kind + detail visible).
- [ ] **empty state:** `findings: []` → "No findings" EmptyState (no error).
- [ ] **scope toggle to feature:** with a `featureCode` prop, selecting Feature
      refetches with `?scope=feature&featureCode=…`.
- [ ] **refresh:** clicking `validate-refresh` re-invokes `wsFetch`.
- [ ] **degrades:** `{ unavailable: true, error: '…' }` body → "Validation
      unavailable" message, no throw.

---

## 4. Verification table (every ref confirmed against the actual file)

| Claim | File:line | Verified |
|-------|-----------|----------|
| `validateFeature(cwd, code, options={})` signature + result shape | `lib/feature-validator.js:763`, returns `:775/:781/:795` | ✅ |
| `validateProject(cwd, options={})` signature + result shape | `lib/feature-validator.js:1127`, returns `:1231` | ✅ |
| Finding shape `{severity,kind,detail,feature_code?,source?}` | `lib/feature-validator.js:312-317` | ✅ |
| `FEATURE_NOT_FOUND` returned (not thrown) for nonexistent code | `lib/feature-validator.js:770-774` | ✅ |
| `validateCode` throws `INVALID_INPUT` on malformed code; CLI exit 2 | `lib/feature-validator.js:764`; `bin/compose.js:1825` | ✅ |
| `options.external` gates network xref (default off) | `lib/feature-validator.js:1023` | ✅ |
| Read endpoint pattern `attachHealthRoutes(app, {…}={})`, no auth on GET | `server/health-routes.js:150,156` | ✅ |
| Health route reads `req.workspace?.root` | `server/health-routes.js:189,212` | ✅ |
| `req.workspace = { id, root, source }` from middleware | `server/workspace-middleware.js:4,47,67` | ✅ |
| Health import in vision-server | `server/vision-server.js:30` | ✅ |
| Health attach inside `attach(httpServer, app)` | `server/vision-server.js:92` (fn body `:79-238`) | ✅ |
| UI fetch idiom (wsFetch + monotonic token + refresh) | `EnvironmentHealthPanel.jsx:22,108-130,162-165,213-221` | ✅ |
| `wsFetch` import path from a `vision/` view | `SessionsView.jsx` uses `'./...'`; views import wsFetch as `'../../lib/wsFetch.js'` (depth = EnvironmentHealthPanel `../../`) | ✅ |
| `ViewTabs` `TAB_META` object + `ShieldCheck` already imported | `ViewTabs.jsx:17-29,15` | ✅ |
| `DEFAULT_MAIN_TABS` array; `loadMainTabs` auto-migrates new tab | `viewTabsState.js:17-19,99-111` | ✅ |
| `CockpitView` switch on `activeView`; `case 'sessions'` anchor | `App.jsx:247,313-323` | ✅ |
| `featureCode` already destructured in CockpitView props + threaded | `App.jsx:240,1303` | ✅ |
| `SessionsView` import anchor for new view import | `App.jsx:57` | ✅ |
| Integration test harness (inject `req.workspace`, ephemeral port) | `test/integration/health-routes.test.js:44-56` | ✅ |
| Pure-helper unit test pattern | `test/health-routes.test.js:9-13` | ✅ |
| UI test mock pattern (wsFetch + useWorkspace) | `test/ui/env-health-panel.test.jsx:10-19` | ✅ |
| `EmptyState` shared component (icon/title/description) | `SessionsView.jsx:9,104-109` | ✅ |
