# COMP-PARITY-2 — Blueprint

**Status:** BLUEPRINT (all file:line refs read this session; no Boundary Map → Phase-5 verification folded in below)

Implements the chosen approach (Option B) from `design.md`: a new top-level launcher popover
(Fix / New / Resume), an additive `mode: 'new'` + `resume` extension to `POST /api/build/start`,
and a one-line passthrough in the shared `startBuild` helper. `App.jsx` only gains an
import + a mount.

---

## New files

### 1. `src/components/cockpit/LaunchPopover.jsx` (new)

Self-contained header launcher. Mirrors `StartBuildPopover`'s styling, `startBuild` usage,
error handling, and `data-testid` conventions, but is **item-independent** and adds Fix / New /
Resume modes. Props: `{ activeBuild, onClose }`.

```jsx
import React, { useState } from 'react';
import { startBuild } from '../../lib/startBuild.js';

/**
 * LaunchPopover — top-level cockpit launcher for the fix and new lifecycles
 * plus resume-an-aborted-fix (COMP-PARITY-2). Item-independent: unlike
 * StartBuildPopover it does not require an existing vision item.
 *
 *  - Fix:    POST /api/build/start { featureCode: <bug code>, mode:'bug', description }
 *  - New:    POST /api/build/start { mode:'new', description: <intent> }   (no featureCode)
 *  - Resume: POST /api/build/start { featureCode: <active bug code>, mode:'bug', resume:true }
 *            enabled only when activeBuild?.mode === 'bug'.
 *
 * @param {{ activeBuild: object|null, onClose: () => void }} props
 */
export default function LaunchPopover({ activeBuild, onClose }) {
  const resumableCode =
    activeBuild && activeBuild.mode === 'bug' && activeBuild.featureCode
      ? activeBuild.featureCode : '';
  const [lifecycle, setLifecycle] = useState('fix'); // 'fix' | 'new' | 'resume'
  const [bugCode, setBugCode] = useState('');
  const [intent, setIntent] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  async function handleSubmit(ev) {
    ev?.preventDefault();
    setErr(null);
    try {
      if (lifecycle === 'new') {
        const text = intent.trim();
        if (!text) { setErr('Product intent is required'); return; }
        setSubmitting(true);
        await startBuild({ mode: 'new', description: text });
      } else if (lifecycle === 'resume') {
        if (!resumableCode) { setErr('No active fix to resume'); return; }
        setSubmitting(true);
        await startBuild({ featureCode: resumableCode, mode: 'bug', resume: true });
      } else {
        const code = bugCode.trim();
        if (!code) { setErr('Bug code is required'); return; }
        setSubmitting(true);
        await startBuild({ featureCode: code, mode: 'bug', description: description.trim() });
      }
      onClose?.();
    } catch (e) {
      setErr(e.message || 'Failed to launch');
      setSubmitting(false);
    }
  }
  // … render: a `right-0`-anchored popover (header lives top-right) with a
  // radiogroup [Fix | New | Resume], a conditional input (bug code | intent),
  // an optional description field for Fix, an error <div role="alert">, and
  // Cancel/Launch buttons. testids below.
}
```

**`data-testid` contract (asserted by UI tests / referenced for E2E):**
`launch-popover`, `launch-mode-fix`, `launch-mode-new`, `launch-mode-resume`,
`launch-bugcode-input`, `launch-intent-input`, `launch-description`, `launch-cancel`,
`launch-submit`. The Resume radio is `disabled` (and `aria-disabled`) when `!resumableCode`.

Styling: copy the class strings from `StartBuildPopover.jsx` (`rounded-md border border-border
bg-popover shadow-lg z-50`, `text-[10px]` labels, accent radio buttons) but anchor the
container `right-0` (it opens from a header-right button) instead of `left-0`.

### 2. `test/launch-routes.test.js` (new) — server contract tests (node --test)

Mirrors `test/build-routes.test.js` exactly (express + injected `runBuild`/`runNew`/`abortBuild`/
`getDataDir`, `listen`, `request`, `TOKEN`). Note `attachBuildRoutes` must accept a new
`runNew` dep (see Server changes).

### 3. `test/launch-popover.test.js` (new) — component logic test (node --test)

The repo runs UI logic tests under `node --test` (no Playwright — see MEMORY). This file unit-tests
the **payload-shaping** branch by importing the pure decision logic. To keep it node-runnable
without a DOM, factor the payload builder into the component as an exported pure helper and assert
on it:

```js
// export from LaunchPopover.jsx (named export alongside default):
//   export function buildLaunchPayload(lifecycle, { bugCode, intent, description, resumableCode })
// returns { args } or { error }.
```

Asserts: fix → `{ featureCode, mode:'bug', description }`; new → `{ mode:'new', description:intent }`
(no `featureCode`); resume with `resumableCode` → `{ featureCode:resumableCode, mode:'bug', resume:true }`;
resume without `resumableCode` → `{ error }`; empty bug code / empty intent → `{ error }`.

---

## Server changes — `server/build-routes.js` (additive, backward-compatible)

Extend `attachBuildRoutes` to (a) inject `runNew`, (b) handle `mode: 'new'`, (c) handle
`resume: true`. Existing `feature`/`bug` payloads are byte-identical.

**Edit 1 — inject `runNew` dep (after existing imports, line 16):**
```js
import { runBuild as defaultRunBuild, abortBuild as defaultAbortBuild } from '../lib/build.js';
import { runNew as defaultRunNew } from '../lib/new.js';            // ← add
```
**Edit 2 — resolve dep (after line 24, `const getDataDir = …`):**
```js
  const runNew = deps.runNew || defaultRunNew;                      // ← add
```
**Edit 3 — accept new modes in the start handler.** Replace the validation + dispatch block at
lines 41–53 with the additive version:
```js
    const { featureCode, mode = 'feature', description = '', resume = false } = body;
    if (mode === 'new') {
      // Product-kickoff lifecycle: intent carried in `description`, no featureCode.
      const intent = (description || '').trim();
      if (!intent) return res.status(400).json({ error: 'description (intent) required for mode=new' });
      try {
        const result = await runNew(intent, {});
        return res.json(result ?? { ok: true });
      } catch (err) {
        const code = /already active/i.test(err?.message || '') ? 409 : 500;
        return res.status(code).json({ error: err.message || String(err) });
      }
    }
    if (!featureCode) {
      return res.status(400).json({ error: 'featureCode required' });
    }
    if (mode !== 'feature' && mode !== 'bug') {
      return res.status(400).json({ error: "mode must be 'feature', 'bug', or 'new'" });
    }
    try {
      let resumeFlowId = null;
      if (resume) {
        // Mirror CLI compose-fix --resume (bin/compose.js:2119-2138): read
        // active-build.json, require it belongs to this code in this mode.
        if (mode !== 'bug') return res.status(400).json({ error: 'resume is only supported for mode=bug' });
        const activePath = path.join(getDataDir(), 'active-build.json');
        let active = null;
        try { active = JSON.parse(fs.readFileSync(activePath, 'utf-8')); } catch { active = null; }
        if (!active || active.featureCode !== featureCode || !active.flowId) {
          return res.status(409).json({ error: `No active build to resume for ${featureCode}` });
        }
        if (active.mode && active.mode !== 'bug') {
          return res.status(409).json({ error: `Cannot resume: active build for ${featureCode} is in ${active.mode} mode` });
        }
        resumeFlowId = active.flowId;
      }
      const opts = mode === 'bug'
        ? { mode, template: 'bug-fix', description, ...(resumeFlowId ? { resumeFlowId } : {}) }
        : { mode, description };
      const result = await runBuild(featureCode, opts);
      res.json(result ?? { ok: true });
    } catch (err) {
      const code = /already active/i.test(err && err.message ? err.message : '') ? 409 : 500;
      res.status(code).json({ error: err.message || String(err) });
    }
```
**Edit 4 — add the two node `fs`/`path` imports** the resume branch needs (top of file, after
the existing imports):
```js
import fs from 'node:fs';
import path from 'node:path';
```
(`build-routes.js` does not currently import `fs`/`path`; verified — see table.)

Guard unchanged: the handler keeps `requireSensitiveToken` (= `requireSensitiveOrPaired`, line
17 alias), so `mode:'new'` and `resume` inherit the same sensitive-token / mobile-paired posture
as feature/bug starts. **No `vision-server.js` change** — we extend `build-routes.js` in place;
`attachBuildRoutes(app)` is already called at vision-server.js:159.

---

## Shared helper — `src/lib/startBuild.js` (one-line passthrough)

`startBuild`'s body already serializes `{ featureCode, mode, description }`. Add the optional
`resume` flag so the launcher can request a resume; defaults to `false`, so all existing callers
(StartBuildPopover, Past Builds retry) are unchanged.

**Edit — signature + body (lines 17, 21):**
```js
export async function startBuild({ featureCode, mode = 'feature', description = '', resume = false }) {
  const res = await wsFetch('/api/build/start', {
    method: 'POST',
    headers: withComposeToken({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ featureCode, mode, description, resume }),
  });
```
(`mode:'new'` sends `featureCode: undefined`, which `JSON.stringify` drops — the server treats
absent featureCode as fine for `new`. Confirmed by the `mode==='new'` early branch above.)

---

## Shared-File Integration  ← MOST IMPORTANT

Three shared files. Each edit is additive; old behavior preserved.

### `src/App.jsx`
- **Import** (anchor: the cockpit-component import cluster, after `OpsStrip` import at line 16
  and alongside `EnvironmentHealthPanel` at line 17):
  ```js
  import LaunchPopover from './components/cockpit/LaunchPopover.jsx';
  ```
- **State** (anchor: wherever sibling popover/modal toggles live, e.g. near `setPairDeviceOpen`
  used at App.jsx:1118 — add one boolean):
  ```js
  const [launchOpen, setLaunchOpen] = useState(false);
  ```
- **Mount** (anchor: the header controls cluster `<div className="flex items-center gap-2 shrink-0">`
  at App.jsx:1104, immediately before the Pair-mobile-device button at line 1116). Add a relative
  wrapper so the popover anchors to its trigger:
  ```jsx
  <div className="relative">
    <button
      className="compose-btn-icon"
      onClick={() => setLaunchOpen(v => !v)}
      title="Launch fix / new / resume"
      aria-label="Launch lifecycle"
      data-testid="launch-open"
    >{'\u{1F680}'}</button>
    {launchOpen && (
      <LaunchPopover activeBuild={activeBuild} onClose={() => setLaunchOpen(false)} />
    )}
  </div>
  ```
  `activeBuild` is already in scope here (passed to `AttentionQueueSidebar activeBuild={activeBuild}`
  at App.jsx:1207). No new data fetch needed.

### `server/build-routes.js`
- Edits 1–4 above: `runNew` import + dep, `fs`/`path` imports, `mode:'new'` branch, `resume`
  branch. Anchors: imports at lines 16–19; dep resolution at lines 22–24; validation/dispatch at
  lines 41–53 (the block replaced).

### `server/vision-server.js`
- **No change.** Build routes are attached in place via `attachBuildRoutes(app)` at line 159; the
  new modes ride the existing route. (Listed here only to record that it was checked.)

---

## Tests planned

| File (new) | Runner | Asserts |
|---|---|---|
| `test/launch-routes.test.js` | `node --test` | **Golden — launch fix:** POST `{featureCode:'BUG-7', mode:'bug', description:'…'}` → `runBuild('BUG-7', { mode:'bug', template:'bug-fix', description })`, 200. **Launch new:** POST `{mode:'new', description:'a CLI tool'}` → `runNew('a CLI tool', {})` called, 200, `runBuild` NOT called. **New without intent:** `{mode:'new'}` → 400 `/intent/`. **Resume fix:** seed `active-build.json` `{featureCode:'BUG-7', flowId:'f1', mode:'bug'}` in injected `getDataDir`, POST `{featureCode:'BUG-7', mode:'bug', resume:true}` → `runBuild` opts carry `resumeFlowId:'f1'`, 200. **Resume with no active:** 409 `/resume/i`. **Resume mode!=bug:** `{featureCode:'F', mode:'feature', resume:true}` → 400. **Back-compat:** existing `{mode:'feature'}` / `{mode:'bug'}` payloads still 200 and forward the same opts (no `resume`/`resumeFlowId` when `resume` falsy). **401** without token for `mode:'new'` too. |
| `test/launch-popover.test.js` | `node --test` | `buildLaunchPayload` pure helper: fix → `{featureCode, mode:'bug', description}`; new → `{mode:'new', description:intent}` (no featureCode); resume(resumableCode) → `{featureCode, mode:'bug', resume:true}`; resume(no code) → error; empty bug code → error; empty intent → error. |

Existing `test/build-routes.test.js` stays green unchanged (its `mode:'fix'` → 400 test still
passes; the error string changes to mention `'new'` but that test matches `/feature.*bug/i`,
which still matches `"mode must be 'feature', 'bug', or 'new'"`). **Verified** the regex against
the new message below.

---

## Verification table (every file:line ref read this session)

| Ref in blueprint | Actual | Match |
|---|---|---|
| `server/build-routes.js:16` import runBuild/abortBuild | `import { runBuild as defaultRunBuild, abortBuild as defaultAbortBuild } from '../lib/build.js';` | ✅ |
| `server/build-routes.js:17` requireSensitiveOrPaired aliased as requireSensitiveToken | `import { requireSensitiveOrPaired as requireSensitiveToken } from './security.js';` | ✅ |
| `server/build-routes.js:22-24` deps resolve (runBuild/abortBuild/getDataDir) | matches; `runNew` not yet present (we add) | ✅ |
| `server/build-routes.js` imports `fs`/`path`? | **Not imported** — only `build-history`/`project-root`/`build`/`security`. Edit 4 adds them | ✅ (confirmed absent) |
| `server/build-routes.js:39-58` start handler `requireSensitiveToken`, `mode in {feature,bug}`, 409 on "already active" | exact match (block we extend at 41–53) | ✅ |
| `src/lib/startBuild.js:17,21` `startBuild({featureCode, mode='feature', description=''})` + body `JSON.stringify({featureCode, mode, description})` | exact match | ✅ |
| `src/components/vision/StartBuildPopover.jsx` styling/testids/startBuild usage | exact (source for LaunchPopover patterns) | ✅ |
| `bin/compose.js:2141-2146` fix dispatch `runBuild(bugCode, { abort, template:'bug-fix', mode:'bug', description, resumeFlowId? })` | exact match | ✅ |
| `bin/compose.js:2119-2138` `--resume` reads `active-build.json`, requires `active.featureCode===bugCode && active.flowId`, refuses `active.mode!=='bug'`, sets `resumeFlowId=active.flowId` | exact match (server resume mirrors this) | ✅ |
| `bin/compose.js:807,929-931` `compose new` → `runNew(enrichedIntent, { cwd, projectName, skipResearch })` | exact match (we call `runNew(intent, {})` server-side) | ✅ |
| `lib/new.js:35` `export async function runNew(intent, opts = {})` | exact match | ✅ |
| `lib/build.js:582` `export async function runBuild(featureCode, opts = {})`; `opts.template`/`opts.mode`/`opts.description`/`opts.resumeFlowId` honored | exact (mode @591, resumeFlowId @879, template @577) | ✅ |
| `lib/build.js:879-916` resumeFlowId path: ownership/mode re-check, `stratum.resume(opts.resumeFlowId)` | exact match | ✅ |
| `server/vision-server.js:159` `attachBuildRoutes(app);` | exact match → no vision-server change needed | ✅ |
| `server/vision-server.js:162-174` `GET /api/build/state` returns `{ state }` from `active-build.json` | exact match (UI hydrates `activeBuild` here) | ✅ |
| `src/App.jsx:16-17` cockpit import cluster (OpsStrip / EnvironmentHealthPanel) | exact match (import anchor) | ✅ |
| `src/App.jsx:1104` `<div className="flex items-center gap-2 shrink-0">` header controls | exact match (mount anchor) | ✅ |
| `src/App.jsx:1116-1123` Pair-device button / `setPairDeviceOpen` | exact match (insert launcher before it) | ✅ |
| `src/App.jsx:1207` `<AttentionQueueSidebar activeBuild={activeBuild}` | exact match → `activeBuild` in scope at header | ✅ |
| `test/build-routes.test.js` express+injected-deps harness, `makeApp({runBuild,abortBuild,getDataDir})` | exact match (launch-routes.test.js clones it, adds `runNew`) | ✅ |
| `test/build-routes.test.js:114-126` invalid-mode test matches `/feature.*bug/i` | new message `"mode must be 'feature', 'bug', or 'new'"` still matches `/feature.*bug/i` | ✅ |

No Boundary Map present; Phase-5 verification is the table above.
