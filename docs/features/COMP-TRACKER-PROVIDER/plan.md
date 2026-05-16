# COMP-TRACKER-PROVIDER Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Compose's feature/roadmap/changelog/event persistence pluggable behind a `TrackerProvider` interface, with a behavior-identical local provider (default) and a GitHub provider (Issues + Projects v2 + committed roadmap), without changing any existing local behavior.

**Architecture:** A data-layer seam. The mutation layer (`feature-writer`, `completion-writer`, `changelog-writer`) and `build.js` call a `TrackerProvider` obtained from a `providerFor(cwd)` factory instead of `feature-json`/`roadmap-gen` directly. `LocalFileProvider` wraps today's exact code paths. `GitHubProvider` is canonical-remote with a write-through cache + durable op-log + async reconciler (CAS + conflict ledger). Capability gaps fall back to local.

**Tech Stack:** Node ESM (compose `lib/`), Vitest (compose test runner — `npm test`), GitHub REST + GraphQL (Projects v2), `gh` CLI token fallback.

**Source spec:** `docs/features/COMP-TRACKER-PROVIDER/design.md` (Codex-cleared, 5 review iterations).

**Commit/PR boundaries:** Phase 1 = PR1 (seam + local provider, zero behavior change). Phase 2 = PR2 (rewire callers). Phase 3 = PR3 (sync engine). Phase 4 = PR4 (GitHub provider). Phase 5 = PR5 (config/CLI/fallback). Phase 6 = PR6 (GitHub golden flow + docs/ship).

---

## File Structure

**New (`lib/tracker/`):**
- `provider.js` — `TrackerProvider` base class, `CAP` capability constants, typed error classes.
- `local-provider.js` — `LocalFileProvider`; delegates to existing `feature-json`/`roadmap-gen`/writer internals. Zero behavior change.
- `github-provider.js` — `GitHubProvider`.
- `github-api.js` — thin REST/GraphQL client (issues, Projects v2, contents API), rate-limit aware.
- `sync-engine.js` — op-log, cache, reconciler, CAS, conflict ledger. Used only by remote providers.
- `factory.js` — `providerFor(cwd)`: reads `.compose/compose.json` `tracker` key, wraps with capability-fallback proxy.

**New (tests, `tests/tracker/`):**
- `conformance.js` — shared `runProviderConformance(makeProvider)` suite both providers must pass.
- `local-provider.test.js`, `github-provider.test.js`, `sync-engine.test.js`, `factory.test.js`, `regression-golden.test.js`.
- `fixtures/github-server.js` — in-process recorded GitHub REST/GraphQL fixture server.

**Modified:**
- `lib/feature-writer.js` — call `provider.*` instead of `feature-json`/`roadmap-gen` directly.
- `lib/completion-writer.js`, `lib/changelog-writer.js` — same.
- `lib/build.js` — triage create → `provider.createFeature`; profile cache → `provider.putFeature`; lifecycle status flips → `provider.setStatus`.
- `.compose/compose.json` schema doc — add `tracker` key (no code; doc + factory parsing).

**Unchanged (asserted by regression golden):** `roadmap-gen.js` and `changelog-writer.js` *merge logic* (they get refactored only to take a string base instead of a fixed path), transition policy in `feature-writer.js`.

---

## Phase 1 — Interface + LocalFileProvider + Conformance (PR1, zero behavior change)

### Task 1: Capability constants + typed errors

**Files:**
- Create: `lib/tracker/provider.js`
- Test: `tests/tracker/provider.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/tracker/provider.test.js
import { describe, it, expect } from 'vitest';
import { CAP, TrackerConfigError, TrackerProvider } from '../../lib/tracker/provider.js';

describe('provider module', () => {
  it('exposes the six capability constants', () => {
    expect([...Object.values(CAP)].sort()).toEqual(
      ['CHANGELOG', 'EVENTS', 'FEATURES', 'JOURNAL', 'ROADMAP', 'VISION'].sort());
  });
  it('TrackerConfigError is an Error subclass carrying a code', () => {
    const e = new TrackerConfigError('bad scope', { missingScope: 'project' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('TrackerConfigError');
    expect(e.detail.missingScope).toBe('project');
  });
  it('TrackerProvider base methods throw "not implemented"', async () => {
    const p = new TrackerProvider();
    await expect(p.getFeature('X')).rejects.toThrow(/not implemented/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ruze/reg/my/forge/compose && npx vitest run tests/tracker/provider.test.js`
Expected: FAIL — cannot resolve `../../lib/tracker/provider.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/tracker/provider.js
export const CAP = Object.freeze({
  FEATURES: 'FEATURES', EVENTS: 'EVENTS', ROADMAP: 'ROADMAP',
  CHANGELOG: 'CHANGELOG', JOURNAL: 'JOURNAL', VISION: 'VISION',
});

export class TrackerConfigError extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'TrackerConfigError'; this.detail = detail; }
}
export class TrackerConflictError extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'TrackerConflictError'; this.detail = detail; }
}

const NI = (m) => { throw new Error(`TrackerProvider.${m}: not implemented`); };

export class TrackerProvider {
  name() { return NI('name'); }
  capabilities() { return new Set(); }
  async init(_cwd, _config) { return this; }
  async health() { return { ok: true, provider: this.name?.() ?? 'base', canonical: 'local', pendingOps: 0, conflicts: 0, mixedSources: [] }; }
  async getFeature(_code) { return NI('getFeature'); }
  async listFeatures() { return NI('listFeatures'); }
  async createFeature(_code, _obj) { return NI('createFeature'); }
  async putFeature(_code, _obj) { return NI('putFeature'); }
  async deleteFeature(_code) { return NI('deleteFeature'); }
  async setStatus(_code, _to, _meta) { return NI('setStatus'); }
  async recordCompletion(_code, _rec) { return NI('recordCompletion'); }
  async addRoadmapEntry(_args) { return NI('addRoadmapEntry'); }
  async appendEvent(_code, _event) { return NI('appendEvent'); }
  async readEvents(_code) { return NI('readEvents'); }
  async renderRoadmap() { return NI('renderRoadmap'); }
  async getChangelog() { return NI('getChangelog'); }
  async appendChangelog(_entry) { return NI('appendChangelog'); }
  async readJournal() { return NI('readJournal'); }
  async writeJournalEntry(_e) { return NI('writeJournalEntry'); }
  async getVisionState() { return NI('getVisionState'); }
  async putVisionState(_s) { return NI('putVisionState'); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tracker/provider.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
echo "$(date -Iseconds) | tracker provider interface + capability constants" >> .compose/breadcrumbs.log
git add lib/tracker/provider.js tests/tracker/provider.test.js
git commit -m "feat(COMP-TRACKER-PROVIDER): TrackerProvider interface + capability constants"
```

### Task 2: Conformance suite (the contract both providers must pass)

**Files:**
- Create: `tests/tracker/conformance.js`
- Test: `tests/tracker/conformance.selftest.test.js`

- [ ] **Step 1: Write the conformance suite + a self-test**

```js
// tests/tracker/conformance.js
import { describe, it, expect } from 'vitest';
import { CAP } from '../../lib/tracker/provider.js';

// makeProvider: async () => ({ provider, cwd, cleanup })
export function runProviderConformance(label, makeProvider) {
  describe(`TrackerProvider conformance: ${label}`, () => {
    it('createFeature is side-effect-free: persists record, NO event, NO roadmap regen', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-1', { code: 'CONF-1', description: 'd', status: 'PLANNED' });
        const f = await provider.getFeature('CONF-1');
        expect(f.status).toBe('PLANNED');
        expect(await provider.readEvents('CONF-1')).toEqual([]); // genesis emits no event
      } finally { await cleanup(); }
    });

    it('putFeature is metadata-only: rejects a status delta', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-2', { code: 'CONF-2', description: 'd', status: 'PLANNED' });
        await expect(provider.putFeature('CONF-2', { code: 'CONF-2', description: 'd', status: 'IN_PROGRESS' }))
          .rejects.toThrow(/status/i);
        // metadata-only change is allowed
        await provider.putFeature('CONF-2', { code: 'CONF-2', description: 'd2', status: 'PLANNED' });
        expect((await provider.getFeature('CONF-2')).description).toBe('d2');
      } finally { await cleanup(); }
    });

    it('putFeature is idempotent (same payload twice = no-op)', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-3', { code: 'CONF-3', description: 'd', status: 'PLANNED' });
        const obj = { code: 'CONF-3', description: 'x', status: 'PLANNED' };
        await provider.putFeature('CONF-3', obj);
        await provider.putFeature('CONF-3', obj);
        expect((await provider.getFeature('CONF-3')).description).toBe('x');
      } finally { await cleanup(); }
    });

    it('setStatus enforces nothing itself but persists + emits one event', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-4', { code: 'CONF-4', description: 'd', status: 'PLANNED' });
        await provider.setStatus('CONF-4', 'IN_PROGRESS', { by: 'test' });
        expect((await provider.getFeature('CONF-4')).status).toBe('IN_PROGRESS');
        const ev = await provider.readEvents('CONF-4');
        expect(ev.filter(e => e.type === 'status').length).toBe(1);
      } finally { await cleanup(); }
    });

    it('concurrent same-feature completions never lose or duplicate', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-5', { code: 'CONF-5', description: 'd', status: 'IN_PROGRESS' });
        await Promise.all([
          provider.recordCompletion('CONF-5', { sha: 'a'.repeat(40), notes: 'x' }),
          provider.recordCompletion('CONF-5', { sha: 'b'.repeat(40), notes: 'y' }),
        ]);
        const f = await provider.getFeature('CONF-5');
        const shas = (f.completions ?? []).map(c => c.sha).sort();
        expect(shas).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
      } finally { await cleanup(); }
    });

    it('listFeatures returns a stable, collision-free order under concurrent creates in one phase', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await Promise.all([
          provider.createFeature('CONF-A', { code: 'CONF-A', description: 'a', status: 'PLANNED', phase: 'P' }),
          provider.createFeature('CONF-B', { code: 'CONF-B', description: 'b', status: 'PLANNED', phase: 'P' }),
        ]);
        const list = await provider.listFeatures();
        const codes = list.map(f => f.code);
        expect(new Set(codes).size).toBe(codes.length); // no dupes
        const again = (await provider.listFeatures()).map(f => f.code);
        expect(again).toEqual(codes); // stable
      } finally { await cleanup(); }
    });

    it('capabilities() is a Set drawn only from CAP values', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        const caps = provider.capabilities();
        expect(caps instanceof Set).toBe(true);
        for (const c of caps) expect(Object.values(CAP)).toContain(c);
      } finally { await cleanup(); }
    });
  });
}
```

```js
// tests/tracker/conformance.selftest.test.js
import { it, expect } from 'vitest';
it('conformance module exports runProviderConformance', async () => {
  const m = await import('./conformance.js');
  expect(typeof m.runProviderConformance).toBe('function');
});
```

- [ ] **Step 2: Run the self-test**

Run: `npx vitest run tests/tracker/conformance.selftest.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/tracker/conformance.js tests/tracker/conformance.selftest.test.js
git commit -m "test(COMP-TRACKER-PROVIDER): provider conformance suite"
```

### Task 3: LocalFileProvider — features (createFeature/getFeature/putFeature/listFeatures)

**Files:**
- Create: `lib/tracker/local-provider.js`
- Modify: `lib/feature-json.js` (export an internal `writeFeatureRaw` that does NOT stamp `updated`, used by createFeature; keep `writeFeature` exact for putFeature) — verify current exports first via `grep "export" lib/feature-json.js`.
- Test: `tests/tracker/local-provider.test.js`

- [ ] **Step 1: Write the failing test (wires the conformance suite to the local provider)**

```js
// tests/tracker/local-provider.test.js
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runProviderConformance } from './conformance.js';
import { LocalFileProvider } from '../../lib/tracker/local-provider.js';

async function makeProvider() {
  const cwd = mkdtempSync(join(tmpdir(), 'ctp-local-'));
  const provider = await new LocalFileProvider().init(cwd, {});
  return { provider, cwd, cleanup: async () => rmSync(cwd, { recursive: true, force: true }) };
}
runProviderConformance('LocalFileProvider', makeProvider);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tracker/local-provider.test.js`
Expected: FAIL — `../../lib/tracker/local-provider.js` not found.

- [ ] **Step 3: Implement LocalFileProvider feature methods**

Reuse existing libs. `createFeature` writes the record WITHOUT a status event or roadmap regen (matches `build.js` triage). `putFeature` rejects a status delta. `setStatus`/`recordCompletion`/`addRoadmapEntry`/`appendChangelog`/`readEvents`/`renderRoadmap` delegate to the existing writers (added in later tasks of this phase).

```js
// lib/tracker/local-provider.js
import { readFeature, listFeatures as listFeaturesRaw, writeFeature } from '../feature-json.js';
import { loadFeaturesDir } from '../project-paths.js';
import { TrackerProvider, CAP } from './provider.js';

export class LocalFileProvider extends TrackerProvider {
  name() { return 'local'; }
  capabilities() { return new Set([CAP.FEATURES, CAP.EVENTS, CAP.ROADMAP, CAP.CHANGELOG, CAP.JOURNAL, CAP.VISION]); }
  async init(cwd) { this.cwd = cwd; this.featuresDir = loadFeaturesDir(cwd); return this; }

  async getFeature(code) { return readFeature(this.cwd, code, this.featuresDir); }
  async listFeatures() { return listFeaturesRaw(this.cwd, this.featuresDir); }

  async createFeature(code, obj) {
    const existing = readFeature(this.cwd, code, this.featuresDir);
    if (existing) return existing; // genesis is once; idempotent re-create is a no-op
    // Side-effect-free: writeFeature persists feature.json only (no event, no roadmap regen) —
    // identical to today's build.js:644 triage create.
    writeFeature(this.cwd, code, obj, this.featuresDir);
    return readFeature(this.cwd, code, this.featuresDir);
  }

  async putFeature(code, obj) {
    const cur = readFeature(this.cwd, code, this.featuresDir);
    if (cur && obj.status && obj.status !== cur.status) {
      throw new Error(`putFeature: status delta (${cur.status}->${obj.status}) not allowed; use setStatus`);
    }
    writeFeature(this.cwd, code, obj, this.featuresDir);
    return readFeature(this.cwd, code, this.featuresDir);
  }
}
```

- [ ] **Step 4: Run — feature conformance tests pass, others fail (expected)**

Run: `npx vitest run tests/tracker/local-provider.test.js -t "putFeature|createFeature|listFeatures|capabilities"`
Expected: those 4 PASS; `setStatus`/completion/order tests still fail (methods added next tasks).

- [ ] **Step 5: Commit**

```bash
echo "$(date -Iseconds) | LocalFileProvider feature CRUD via existing feature-json" >> .compose/breadcrumbs.log
git add lib/tracker/local-provider.js lib/feature-json.js tests/tracker/local-provider.test.js
git commit -m "feat(COMP-TRACKER-PROVIDER): LocalFileProvider feature CRUD"
```

### Task 4: LocalFileProvider — setStatus/recordCompletion/addRoadmapEntry/appendChangelog/events/render

**Files:**
- Modify: `lib/tracker/local-provider.js`
- Test: `tests/tracker/local-provider.test.js` (same file; conformance already wired)

- [ ] **Step 1: Run the still-failing conformance tests to confirm the gap**

Run: `npx vitest run tests/tracker/local-provider.test.js`
Expected: FAIL on `setStatus`, completions, order tests.

- [ ] **Step 2: Implement the delegating methods**

Delegate to the existing writers so behavior is identical. Verify exact signatures first: `grep -n "export" lib/feature-writer.js lib/completion-writer.js lib/changelog-writer.js`.

```js
// add to lib/tracker/local-provider.js
import { setFeatureStatus, addRoadmapEntry as addRoadmapEntryRaw } from '../feature-writer.js';
import { recordCompletion as recordCompletionRaw } from '../completion-writer.js';
import { addChangelogEntry } from '../changelog-writer.js';
import { readEvents as readEventsRaw } from '../feature-events.js';
import { generateRoadmap } from '../roadmap-gen.js';

// inside class LocalFileProvider:
async setStatus(code, to, meta = {}) {
  return setFeatureStatus(this.cwd, { code, status: to, ...meta }); // preserves ROADMAP_PARTIAL_WRITE
}
async recordCompletion(code, rec) {
  return recordCompletionRaw(this.cwd, { code, ...rec }); // preserves per-feature lock + STATUS_FLIP_AFTER_COMPLETION_RECORDED
}
async addRoadmapEntry(args) { return addRoadmapEntryRaw(this.cwd, args); }
async appendEvent(code, event) {
  // feature-events.js append; verify exact fn name with grep before wiring
  const { appendEvent } = await import('../feature-events.js');
  return appendEvent(this.cwd, code, event);
}
async readEvents(code) { return readEventsRaw(this.cwd, code); }
async renderRoadmap() { return generateRoadmap(this.cwd); }
async appendChangelog(entry) { return addChangelogEntry(this.cwd, entry); }
async getChangelog() {
  const { readFileSync, existsSync } = await import('fs');
  const p = join(this.cwd, 'CHANGELOG.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
async readJournal() { const { listJournal } = await import('../journal-writer.js'); return listJournal(this.cwd); }
async writeJournalEntry(e) { const { writeJournalEntry } = await import('../journal-writer.js'); return writeJournalEntry(this.cwd, e); }
async getVisionState() { const { loadVisionState } = await import('../../server/vision-store.js'); return loadVisionState(this.cwd); }
async putVisionState(s) { const { saveVisionState } = await import('../../server/vision-store.js'); return saveVisionState(this.cwd, s); }
```

> Engineer note: the import names above (`appendEvent`, `listJournal`, `loadVisionState`, `saveVisionState`) are the expected exports — confirm each with `grep -n "export" <file>` before wiring. If a name differs, use the actual export; do not invent a wrapper.

- [ ] **Step 3: Run full conformance for local**

Run: `npx vitest run tests/tracker/local-provider.test.js`
Expected: PASS (all 7 conformance tests).

- [ ] **Step 4: Commit**

```bash
git add lib/tracker/local-provider.js
git commit -m "feat(COMP-TRACKER-PROVIDER): LocalFileProvider status/completion/changelog/events/render"
```

### Task 5: Regression golden flow — prove LocalFileProvider is byte-identical to today

**Files:**
- Create: `tests/tracker/regression-golden.test.js`

- [ ] **Step 1: Write the golden flow test**

It runs a full lifecycle through the PROVIDER and asserts the on-disk artifacts and typed errors equal those produced by calling the legacy writers directly on a parallel temp dir.

```js
// tests/tracker/regression-golden.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalFileProvider } from '../../lib/tracker/local-provider.js';
import { addRoadmapEntry, setFeatureStatus } from '../../lib/feature-writer.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ctp-gold-')); }

describe('regression golden: LocalFileProvider == legacy direct calls', () => {
  it('scaffold→status→roadmap produces identical ROADMAP.md and feature.json', async () => {
    const a = tmp(), b = tmp();
    try {
      // Path A: through provider
      const p = await new LocalFileProvider().init(a, {});
      await p.addRoadmapEntry({ code: 'GOLD-1', description: 'g', phase: 'P1', status: 'PLANNED' });
      await p.setStatus('GOLD-1', 'IN_PROGRESS', { by: 'test' });
      // Path B: legacy direct
      await addRoadmapEntry(b, { code: 'GOLD-1', description: 'g', phase: 'P1', status: 'PLANNED' });
      await setFeatureStatus(b, { code: 'GOLD-1', status: 'IN_PROGRESS', by: 'test' });

      const fa = JSON.parse(readFileSync(join(a, 'docs/features/GOLD-1/feature.json'), 'utf8'));
      const fb = JSON.parse(readFileSync(join(b, 'docs/features/GOLD-1/feature.json'), 'utf8'));
      delete fa.updated; delete fb.updated; // timestamp is the only allowed difference
      expect(fa).toEqual(fb);

      const ra = readFileSync(join(a, 'ROADMAP.md'), 'utf8');
      const rb = readFileSync(join(b, 'ROADMAP.md'), 'utf8');
      expect(ra).toEqual(rb);
    } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/tracker/regression-golden.test.js`
Expected: PASS. If it fails, the LocalFileProvider delegation diverged — fix the provider, never the assertion.

- [ ] **Step 3: Run the FULL existing suite to confirm no regression**

Run: `npm test`
Expected: same pass/fail counts as `git stash && npm test` baseline (no new failures).

- [ ] **Step 4: Commit (closes PR1)**

```bash
git add tests/tracker/regression-golden.test.js
git commit -m "test(COMP-TRACKER-PROVIDER): regression golden — LocalFileProvider byte-identical to legacy"
```

---

## Phase 2 — Factory + rewire callers (PR2, still local-only, still zero behavior change)

### Task 6: providerFor factory + capability-fallback proxy

**Files:**
- Create: `lib/tracker/factory.js`
- Test: `tests/tracker/factory.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/tracker/factory.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { providerFor } from '../../lib/tracker/factory.js';

function projWith(trackerCfg) {
  const cwd = mkdtempSync(join(tmpdir(), 'ctp-fac-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose/compose.json'),
    JSON.stringify(trackerCfg ? { tracker: trackerCfg } : {}));
  return cwd;
}

describe('providerFor', () => {
  it('defaults to LocalFileProvider when tracker key absent', async () => {
    const cwd = projWith(null);
    try { const p = await providerFor(cwd); expect(p.name()).toBe('local'); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('uncapable entity calls fall back to local (mixed-source)', async () => {
    const cwd = projWith(null);
    try {
      const p = await providerFor(cwd);
      // local supports everything, so this just asserts the proxy passes through
      expect(typeof p.getVisionState).toBe('function');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run — FAIL** (`npx vitest run tests/tracker/factory.test.js`; no factory.js).

- [ ] **Step 3: Implement factory + proxy**

```js
// lib/tracker/factory.js
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { LocalFileProvider } from './local-provider.js';

function loadTrackerConfig(cwd) {
  const p = join(cwd, '.compose/compose.json');
  if (!existsSync(p)) return { provider: 'local' };
  try { return JSON.parse(readFileSync(p, 'utf8')).tracker ?? { provider: 'local' }; }
  catch { return { provider: 'local' }; }
}

// Wrap `active` so calls for entities not in active.capabilities() route to `local`.
function withFallback(active, local) {
  const ENTITY_METHODS = {
    JOURNAL: ['readJournal', 'writeJournalEntry'],
    VISION: ['getVisionState', 'putVisionState'],
  };
  const caps = active.capabilities();
  const handler = {
    get(target, prop) {
      for (const [cap, methods] of Object.entries(ENTITY_METHODS)) {
        if (methods.includes(prop) && !caps.has(cap)) {
          return (...args) => local[prop](...args);
        }
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  };
  return new Proxy(active, handler);
}

export async function providerFor(cwd) {
  const cfg = loadTrackerConfig(cwd);
  const local = await new LocalFileProvider().init(cwd, {});
  if (!cfg.provider || cfg.provider === 'local') return local;
  if (cfg.provider === 'github') {
    const { GitHubProvider } = await import('./github-provider.js');
    const gh = await new GitHubProvider().init(cwd, cfg.github ?? {});
    return withFallback(gh, local);
  }
  throw new (await import('./provider.js')).TrackerConfigError(`unknown tracker provider "${cfg.provider}"`);
}
```

- [ ] **Step 4: Run — PASS.** Commit:

```bash
git add lib/tracker/factory.js tests/tracker/factory.test.js
git commit -m "feat(COMP-TRACKER-PROVIDER): providerFor factory + capability-fallback proxy"
```

### Task 7: Rewire `feature-writer.js` internals to call the provider

**Files:**
- Modify: `lib/feature-writer.js` (the file-read/write calls only — transition policy + idempotency stay)
- Test: existing `npm test` + `tests/tracker/regression-golden.test.js`

- [ ] **Step 1: Confirm baseline green**

Run: `npm test` — note pass count.

- [ ] **Step 2: Replace direct `feature-json`/`roadmap-gen` calls with `providerFor(cwd)`**

In `feature-writer.js`, the read-before-write and persist calls become provider calls. Transition validation (the `TRANSITIONS` map at `feature-writer.js:41-50`) stays exactly where it is — it runs BEFORE `provider.putFeature`/`provider.setStatus`. Do not move the policy. Replace only the persistence primitives (`readFeature`/`writeFeature`/`generateRoadmap`) with the provider instance obtained once per call: `const provider = await providerFor(cwd);`.

> Engineer note: keep `maybeIdempotent`/`checkOrInsert` exactly as-is — idempotency wraps the whole op at the writer level (design "Idempotency keys & replay"). The provider's op-log dedupe is an additional layer added in Phase 3, not a replacement here.

- [ ] **Step 3: Run regression golden + full suite**

Run: `npx vitest run tests/tracker/regression-golden.test.js && npm test`
Expected: golden PASS; suite pass count unchanged.

- [ ] **Step 4: Commit**

```bash
echo "$(date -Iseconds) | rewire feature-writer persistence through provider" >> .compose/breadcrumbs.log
git add lib/feature-writer.js
git commit -m "refactor(COMP-TRACKER-PROVIDER): feature-writer persists via TrackerProvider"
```

### Task 8: Rewire `completion-writer.js` and `changelog-writer.js`

**Files:**
- Modify: `lib/completion-writer.js`, `lib/changelog-writer.js`
- Test: `npm test` + golden

- [ ] **Step 1: Baseline green** (`npm test`).
- [ ] **Step 2: Replace persistence calls with `providerFor(cwd)`** — preserve the per-feature advisory lock in `completion-writer.js:56` and the completion-before-status-flip ordering (`:305`). `changelog-writer.js` keeps its parse-and-rewrite logic; only the final file write becomes `provider.appendChangelog` (local provider still writes the file the same way). The `changelog-writer` parse/splice functions must be refactored to take the current changelog string as input (so a remote provider can pass a fetched blob) and return the new string; the local provider reads/writes the file around that pure function.
- [ ] **Step 3: Run golden + suite.** Expected: unchanged.
- [ ] **Step 4: Commit**

```bash
git add lib/completion-writer.js lib/changelog-writer.js
git commit -m "refactor(COMP-TRACKER-PROVIDER): completion/changelog persist via TrackerProvider"
```

### Task 9: Rewire `build.js` (createFeature / putFeature / setStatus)

**Files:**
- Modify: `lib/build.js` (lines ~644, ~653, ~755, ~1834, ~1845, ~1854 — re-grep before editing; line numbers drift)
- Test: `npm test`

- [ ] **Step 1: Locate the call sites**

Run: `grep -n "readFeature\|writeFeature" lib/build.js`

- [ ] **Step 2: Re-point each**
  - Triage create (missing feature.json, status PLANNED) → `await (await providerFor(cwd)).createFeature(code, { code, description, status: 'PLANNED' })`.
  - Profile metadata cache write → `provider.putFeature(code, {...current, profile, complexity})` (no status change → passes the metadata-only guard).
  - Lifecycle status flips → `provider.setStatus(code, NEW_STATUS, { by: 'build' })` (NOT raw write — these are canonical transitions).

- [ ] **Step 3: Run the build-path tests + full suite**

Run: `npm test`
Expected: pass count unchanged (build tests still green; local provider preserves behavior).

- [ ] **Step 4: Commit (closes PR2)**

```bash
git add lib/build.js
git commit -m "refactor(COMP-TRACKER-PROVIDER): build.js routes feature mutations through TrackerProvider"
```

---

## Phase 3 — Sync Engine (PR3; no provider uses it yet, fully unit-tested in isolation)

### Task 10: Durable op-log (append + fsync + FIFO drain + idempotency dedupe)

**Files:**
- Create: `lib/tracker/sync-engine.js` (op-log portion)
- Test: `tests/tracker/sync-engine.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/tracker/sync-engine.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpLog } from '../../lib/tracker/sync-engine.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ctp-oplog-')); }

describe('OpLog', () => {
  it('append is durable and FIFO', async () => {
    const d = tmp();
    try {
      const log = new OpLog(d);
      await log.append({ op: 'setStatus', code: 'A', payload: { to: 'IN_PROGRESS' } });
      await log.append({ op: 'setStatus', code: 'B', payload: { to: 'COMPLETE' } });
      const log2 = new OpLog(d); // reopen — must survive
      const pending = await log2.pending();
      expect(pending.map(o => o.code)).toEqual(['A', 'B']);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('idempotencyKey dedupe: re-append returns prior op id, no duplicate', async () => {
    const d = tmp();
    try {
      const log = new OpLog(d);
      const a = await log.append({ op: 'recordCompletion', code: 'A', idempotencyKey: 'k1', payload: {} });
      const b = await log.append({ op: 'recordCompletion', code: 'A', idempotencyKey: 'k1', payload: {} });
      expect(b.id).toBe(a.id);
      expect((await log.pending()).length).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('resolve removes an op; quarantine moves it aside', async () => {
    const d = tmp();
    try {
      const log = new OpLog(d);
      const op = await log.append({ op: 'setStatus', code: 'A', payload: {} });
      await log.resolve(op.id);
      expect((await log.pending()).length).toBe(0);
      const op2 = await log.append({ op: 'setStatus', code: 'B', payload: {} });
      await log.quarantine(op2.id, 'conflict');
      expect((await log.pending()).length).toBe(0);
      expect((await log.quarantined()).length).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run — FAIL** (`npx vitest run tests/tracker/sync-engine.test.js`).

- [ ] **Step 3: Implement OpLog**

```js
// lib/tracker/sync-engine.js
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const OPLOG = 'tracker-oplog.jsonl';
const QUAR  = 'tracker-quarantine.jsonl';

export class OpLog {
  constructor(dataDir) {
    this.dir = dataDir;
    this.path = join(dataDir, OPLOG);
    this.quarPath = join(dataDir, QUAR);
  }
  _all() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }
  async pending() { return this._all().filter(o => o.state === 'pending'); }
  async quarantined() {
    if (!existsSync(this.quarPath)) return [];
    return readFileSync(this.quarPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }
  async append(op) {
    if (op.idempotencyKey) {
      const dup = this._all().find(o => o.idempotencyKey === op.idempotencyKey);
      if (dup) return dup;
    }
    const rec = { id: randomUUID(), ts: Date.now(), state: 'pending', attempts: 0, ...op };
    const fd = openSync(this.path, 'a');
    try { writeSync(fd, JSON.stringify(rec) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    return rec;
  }
  _rewrite(records) {
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
    renameSync(tmp, this.path);
  }
  async resolve(id) { this._rewrite(this._all().filter(o => o.id !== id)); }
  async bumpAttempt(id) {
    const all = this._all();
    const o = all.find(x => x.id === id); if (o) o.attempts += 1;
    this._rewrite(all);
    return o;
  }
  async quarantine(id, reason) {
    const all = this._all();
    const o = all.find(x => x.id === id);
    if (o) {
      const fd = openSync(this.quarPath, 'a');
      try { writeSync(fd, JSON.stringify({ ...o, state: 'quarantined', reason }) + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
      this._rewrite(all.filter(x => x.id !== id));
    }
  }
}
```

- [ ] **Step 4: Run — PASS.** Commit:

```bash
git add lib/tracker/sync-engine.js tests/tracker/sync-engine.test.js
git commit -m "feat(COMP-TRACKER-PROVIDER): durable op-log with idempotency dedupe + quarantine"
```

### Task 11: Read cache with pending-op shadowing + CAS version stamps

**Files:**
- Modify: `lib/tracker/sync-engine.js` (add `Cache` class)
- Test: `tests/tracker/sync-engine.test.js` (add cases)

- [ ] **Step 1: Add failing tests**

```js
// append to tests/tracker/sync-engine.test.js
import { Cache } from '../../lib/tracker/sync-engine.js';

describe('Cache shadowing + CAS', () => {
  it('getFeature returns post-op value while an op is pending (no rollback)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctp-cache-'));
    try {
      const c = new Cache(d);
      await c.put('A', { code: 'A', status: 'PLANNED' }, { version: 'v1' });
      await c.markPending('A');
      await c.put('A', { code: 'A', status: 'IN_PROGRESS' }, { version: 'v1', pending: true });
      // a remote pull tries to roll back to PLANNED/v2 — must be ignored for A (pending)
      await c.applyRemote('A', { code: 'A', status: 'PLANNED' }, { version: 'v2' });
      expect((await c.get('A')).status).toBe('IN_PROGRESS');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('applyRemote updates entries with no pending op', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctp-cache2-'));
    try {
      const c = new Cache(d);
      await c.put('B', { code: 'B', status: 'PLANNED' }, { version: 'v1' });
      await c.applyRemote('B', { code: 'B', status: 'COMPLETE' }, { version: 'v9' });
      expect((await c.get('B')).status).toBe('COMPLETE');
      expect(await c.version('B')).toBe('v9');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `Cache`**

```js
// add to lib/tracker/sync-engine.js
import { mkdirSync } from 'fs';

export class Cache {
  constructor(dataDir) {
    this.dir = join(dataDir, 'tracker-cache');
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, 'features.json');
  }
  _load() { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}; }
  _save(s) { const t = this.path + '.tmp'; writeFileSync(t, JSON.stringify(s, null, 2)); renameSync(t, this.path); }
  async get(code) { return this._load()[code]?.value ?? null; }
  async version(code) { return this._load()[code]?.version ?? null; }
  async put(code, value, { version, pending = false } = {}) {
    const s = this._load();
    s[code] = { value, version: version ?? s[code]?.version ?? null,
                pending: pending || s[code]?.pending || false };
    this._save(s);
  }
  async markPending(code) { const s = this._load(); if (s[code]) { s[code].pending = true; this._save(s); } }
  async clearPending(code) { const s = this._load(); if (s[code]) { s[code].pending = false; this._save(s); } }
  async applyRemote(code, value, { version }) {
    const s = this._load();
    if (s[code]?.pending) return; // shadow: never roll back an entry with a pending op
    s[code] = { value, version, pending: false };
    this._save(s);
  }
}
```

- [ ] **Step 4: Run — PASS.** Commit:

```bash
git add lib/tracker/sync-engine.js
git commit -m "feat(COMP-TRACKER-PROVIDER): read cache with pending-op shadowing + CAS versions"
```

### Task 12: Reconciler (backoff, rate-limit awareness, CAS conflict → ledger)

**Files:**
- Modify: `lib/tracker/sync-engine.js` (add `Reconciler` + `ConflictLedger`)
- Test: `tests/tracker/sync-engine.test.js`

- [ ] **Step 1: Add failing tests** (stub a fake remote applier):

```js
// append to tests/tracker/sync-engine.test.js
import { Reconciler, ConflictLedger } from '../../lib/tracker/sync-engine.js';

describe('Reconciler', () => {
  it('flushes pending ops in FIFO and resolves them', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctp-rec-'));
    try {
      const log = new OpLog(d); const cache = new Cache(d);
      await log.append({ op: 'setStatus', code: 'A', payload: { to: 'IN_PROGRESS' }, baseVersion: 'v1' });
      const applied = [];
      const apply = async (op) => { applied.push(op.code); return { version: 'v2' }; };
      const r = new Reconciler({ log, cache, dir: d, apply });
      await r.flush();
      expect(applied).toEqual(['A']);
      expect((await log.pending()).length).toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('CAS mismatch quarantines the op and writes a conflict ledger entry', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctp-rec2-'));
    try {
      const log = new OpLog(d); const cache = new Cache(d);
      const op = await log.append({ op: 'setStatus', code: 'A', payload: { to: 'X' }, baseVersion: 'v1' });
      const apply = async () => { const e = new Error('stale'); e.casMismatch = { remoteVersion: 'v7' }; throw e; };
      const r = new Reconciler({ log, cache, dir: d, apply });
      await r.flush();
      expect((await log.quarantined()).map(o => o.id)).toContain(op.id);
      expect((await new ConflictLedger(d).all()).length).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```js
// add to lib/tracker/sync-engine.js
export class ConflictLedger {
  constructor(dir) { this.path = join(dir, 'tracker-conflicts.jsonl'); }
  async record(entry) {
    const fd = openSync(this.path, 'a');
    try { writeSync(fd, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  async all() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }
}

export class Reconciler {
  constructor({ log, cache, dir, apply, maxAttempts = 5 }) {
    this.log = log; this.cache = cache; this.dir = dir;
    this.apply = apply; this.maxAttempts = maxAttempts;
    this.ledger = new ConflictLedger(dir);
  }
  async flush() {
    for (const op of await this.log.pending()) {
      try {
        const res = await this.apply(op); // throws .casMismatch on stale, .rateLimit{resetMs} on 429
        await this.cache.clearPending(op.code);
        if (res?.version) {
          const cur = await this.cache.get(op.code);
          if (cur) await this.cache.applyRemote(op.code, cur, { version: res.version });
        }
        await this.log.resolve(op.id);
      } catch (e) {
        if (e.casMismatch) {
          await this.ledger.record({ code: op.code, opId: op.id, kind: 'cas',
            baseVersion: op.baseVersion, remoteVersion: e.casMismatch.remoteVersion });
          await this.log.quarantine(op.id, 'cas');
          continue;
        }
        if (e.rateLimit) { await new Promise(r => setTimeout(r, Math.min(e.rateLimit.resetMs ?? 1000, 60000))); }
        const bumped = await this.log.bumpAttempt(op.id);
        if (bumped && bumped.attempts >= this.maxAttempts) {
          await this.ledger.record({ code: op.code, opId: op.id, kind: 'poison', error: String(e) });
          await this.log.quarantine(op.id, 'poison');
        }
        break; // FIFO: stop on first unresolved op so ordering is preserved
      }
    }
  }
}
```

- [ ] **Step 4: Run — PASS.** Commit (closes PR3):

```bash
git add lib/tracker/sync-engine.js
git commit -m "feat(COMP-TRACKER-PROVIDER): reconciler with backoff, CAS conflicts, poison quarantine"
```

---

## Phase 4 — GitHub Provider (PR4)

### Task 13: GitHub API client (auth resolution + rate-limit parse)

**Files:**
- Create: `lib/tracker/github-api.js`
- Test: `tests/tracker/github-api.test.js` (uses the fixture server)
- Create: `tests/tracker/fixtures/github-server.js`

- [ ] **Step 1: Build the fixture server + a failing client test**

```js
// tests/tracker/fixtures/github-server.js
// Minimal in-process recorder: maps (method,path) -> handler returning {status, body, headers}.
export function makeGitHubFixture() {
  const issues = new Map(); let n = 0;
  return {
    async request(method, path, body) {
      if (method === 'POST' && path === '/repos/o/r/issues') {
        n += 1; const issue = { number: n, node_id: `gid_${n}`, title: body.title, body: body.body,
          labels: (body.labels ?? []).map(name => ({ name })), state: 'open', updated_at: `t${n}` };
        issues.set(n, issue); return { status: 201, body: issue, headers: {} };
      }
      if (method === 'GET' && path === '/repos/o/r/issues/' + path.split('/').pop()) {
        const i = issues.get(Number(path.split('/').pop()));
        return i ? { status: 200, body: i, headers: {} } : { status: 404, body: {}, headers: {} };
      }
      if (method === 'GET' && path.startsWith('/search/issues')) {
        return { status: 200, body: { items: [...issues.values()] }, headers: {} };
      }
      return { status: 404, body: {}, headers: {} };
    },
    _issues: issues,
  };
}
```

```js
// tests/tracker/github-api.test.js
import { describe, it, expect } from 'vitest';
import { GitHubApi } from '../../lib/tracker/github-api.js';
import { makeGitHubFixture } from './fixtures/github-server.js';

describe('GitHubApi', () => {
  it('resolves token from configured env var', () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    expect(api.token).toBe('tok');
  });
  it('throws TrackerConfigError when token missing', () => {
    expect(() => new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'NOPE_MISSING' } }, makeGitHubFixture()))
      .toThrow(/token/i);
  });
  it('createIssue round-trips through transport', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    const issue = await api.createIssue({ title: '[X] d', body: 'b', labels: ['compose-feature'] });
    expect(issue.number).toBe(1);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement the client**

```js
// lib/tracker/github-api.js
import { execFileSync } from 'child_process';
import { TrackerConfigError } from './provider.js';

function resolveToken(auth = {}) {
  if (auth.tokenEnv && process.env[auth.tokenEnv]) return process.env[auth.tokenEnv];
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

export class GitHubApi {
  constructor(cfg, transport = null) {
    this.repo = cfg.repo;
    if (!this.repo || !/^[^/]+\/[^/]+$/.test(this.repo)) {
      throw new TrackerConfigError(`tracker.github.repo must be "owner/name" (got "${this.repo}")`);
    }
    this.token = resolveToken(cfg.auth);
    if (!this.token) {
      throw new TrackerConfigError('no GitHub token: set tracker.github.auth.tokenEnv or run `gh auth login`',
        { missing: 'token' });
    }
    this.transport = transport; // injected fixture in tests; real fetch in prod
  }
  async _req(method, path, body) {
    if (this.transport) return this.transport.request(method, path, body);
    const res = await fetch(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.status === 403 && remaining === 0) {
      const e = new Error('rate limited'); e.rateLimit = { resetMs: reset * 1000 - Date.now() }; throw e;
    }
    return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  }
  async createIssue({ title, body, labels }) {
    const r = await this._req('POST', `/repos/${this.repo}/issues`, { title, body, labels });
    return r.body;
  }
  async getIssue(number) { return (await this._req('GET', `/repos/${this.repo}/issues/${number}`)).body; }
  async searchFeatureIssues() {
    return (await this._req('GET', `/search/issues?q=repo:${this.repo}+label:compose-feature`)).body.items ?? [];
  }
}
```

- [ ] **Step 4: Run — PASS.** Commit:

```bash
git add lib/tracker/github-api.js tests/tracker/github-api.test.js tests/tracker/fixtures/github-server.js
git commit -m "feat(COMP-TRACKER-PROVIDER): GitHub API client + fixture transport"
```

### Task 14: GitHubProvider — features (createFeature/getFeature/putFeature/listFeatures) via cache+oplog

**Files:**
- Create: `lib/tracker/github-provider.js`
- Test: `tests/tracker/github-provider.test.js` (wires the conformance suite with the fixture)

- [ ] **Step 1: Wire conformance with injected fixture transport**

```js
// tests/tracker/github-provider.test.js
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runProviderConformance } from './conformance.js';
import { GitHubProvider } from '../../lib/tracker/github-provider.js';
import { makeGitHubFixture } from './fixtures/github-server.js';

async function makeProvider() {
  process.env.CTP_TEST_TOKEN = 'tok';
  const cwd = mkdtempSync(join(tmpdir(), 'ctp-gh-'));
  const provider = await new GitHubProvider().init(cwd,
    { repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' }, _transport: makeGitHubFixture() });
  return { provider, cwd, cleanup: async () => rmSync(cwd, { recursive: true, force: true }) };
}
runProviderConformance('GitHubProvider', makeProvider);
```

- [ ] **Step 2: Run — FAIL** (no `github-provider.js`).

- [ ] **Step 3: Implement GitHubProvider features**

Feature ⇄ Issue mapping: body carries a fenced ```compose-feature``` JSON block (canonical metadata); `getFeature` reads the cache (refreshed from the issue on stale/miss); writes go to cache+op-log then reconcile. `createFeature` opens the issue but its native "issue opened" timeline entry is NOT surfaced by `readEvents`.

```js
// lib/tracker/github-provider.js
import { mkdirSync } from 'fs';
import { join } from 'path';
import { TrackerProvider, CAP } from './provider.js';
import { GitHubApi } from './github-api.js';
import { OpLog, Cache, Reconciler } from './sync-engine.js';

const FENCE = /```compose-feature\n([\s\S]*?)\n```/;
function encodeBody(obj) { return `${obj.description ?? ''}\n\n\`\`\`compose-feature\n${JSON.stringify(obj, null, 2)}\n\`\`\``; }
function decodeBody(body) { const m = FENCE.exec(body ?? ''); return m ? JSON.parse(m[1]) : null; }

export class GitHubProvider extends TrackerProvider {
  name() { return 'github'; }
  capabilities() { return new Set([CAP.FEATURES, CAP.EVENTS, CAP.ROADMAP, CAP.CHANGELOG]); }

  async init(cwd, cfg) {
    this.cwd = cwd; this.cfg = cfg;
    const dataDir = join(cwd, '.compose/data'); mkdirSync(dataDir, { recursive: true });
    this.api = new GitHubApi(cfg, cfg._transport ?? null);
    this.log = new OpLog(dataDir);
    this.cache = new Cache(dataDir);
    this.idmap = new Cache(join(dataDir, 'idmap')); // code -> {issueNumber,nodeId}
    this._locks = new Map();
    this.reconciler = new Reconciler({ log: this.log, cache: this.cache, dir: dataDir,
      apply: (op) => this._applyOp(op) });
    return this;
  }

  _lock(code, fn) {
    const prev = this._locks.get(code) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this._locks.set(code, next.catch(() => {}));
    return next;
  }

  async getFeature(code) { return this.cache.get(code); }
  async listFeatures() {
    const s = JSON.parse(JSON.stringify(this.cache._load?.() ?? {}));
    return Object.values(s).map(e => e.value)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.code.localeCompare(b.code));
  }

  async createFeature(code, obj) {
    return this._lock(code, async () => {
      if (await this.cache.get(code)) return this.cache.get(code);
      await this.cache.put(code, obj, { version: null, pending: true });
      await this.cache.markPending(code);
      await this.log.append({ op: 'createFeature', code, payload: obj, baseVersion: null });
      await this.reconciler.flush();
      return this.cache.get(code);
    });
  }
  async putFeature(code, obj) {
    return this._lock(code, async () => {
      const cur = await this.cache.get(code);
      if (cur && obj.status && obj.status !== cur.status) {
        throw new Error(`putFeature: status delta not allowed; use setStatus`);
      }
      await this.cache.put(code, obj, { pending: true });
      await this.cache.markPending(code);
      await this.log.append({ op: 'putFeature', code, payload: obj,
        baseVersion: await this.cache.version(code) });
      await this.reconciler.flush();
      return this.cache.get(code);
    });
  }

  async _applyOp(op) {
    if (op.op === 'createFeature') {
      const issue = await this.api.createIssue({
        title: `[${op.code}] ${op.payload.description ?? ''}`,
        body: encodeBody(op.payload),
        labels: ['compose-feature', `status:${op.payload.status}`],
      });
      await this.idmap.put(op.code, { issueNumber: issue.number, nodeId: issue.node_id },
        { version: issue.updated_at });
      return { version: issue.updated_at };
    }
    if (op.op === 'putFeature' || op.op === 'setStatus') {
      const id = await this.idmap.get(op.code);
      const issue = await this.api.getIssue(id.issueNumber);
      if (op.baseVersion && issue.updated_at !== op.baseVersion) {
        const e = new Error('stale'); e.casMismatch = { remoteVersion: issue.updated_at }; throw e;
      }
      const next = op.op === 'setStatus'
        ? { ...decodeBody(issue.body), status: op.payload.to }
        : op.payload;
      const updated = await this.api.updateIssue(id.issueNumber, {
        body: encodeBody(next),
        labels: ['compose-feature', `status:${next.status}`],
        state: ['COMPLETE', 'KILLED', 'SUPERSEDED'].includes(next.status) ? 'closed' : 'open',
      });
      return { version: updated.updated_at };
    }
    throw new Error(`_applyOp: unknown op ${op.op}`);
  }
}
```

> Engineer note: add `updateIssue(number, patch)` to `github-api.js` (PATCH `/repos/{repo}/issues/{number}`) and the matching fixture handler before this test passes. Add it as Step 3a here (same TDD micro-cycle: fixture handler → api method → rerun).

- [ ] **Step 3a: Add `updateIssue` to api + fixture**, rerun the api test, commit nothing yet.

- [ ] **Step 4: Run conformance for github**

Run: `npx vitest run tests/tracker/github-provider.test.js`
Expected: feature/createFeature/putFeature/list/capabilities tests PASS; setStatus/completion tests fail (added next task).

- [ ] **Step 5: Commit**

```bash
echo "$(date -Iseconds) | GitHubProvider feature mapping via cache+oplog" >> .compose/breadcrumbs.log
git add lib/tracker/github-provider.js lib/tracker/github-api.js tests/tracker/github-provider.test.js tests/tracker/fixtures/github-server.js
git commit -m "feat(COMP-TRACKER-PROVIDER): GitHubProvider feature mapping (issues + cache + op-log)"
```

### Task 15: GitHubProvider — setStatus/recordCompletion/events + Projects v2 status field

**Files:**
- Modify: `lib/tracker/github-provider.js`, `lib/tracker/github-api.js` (GraphQL Projects v2 + issue comments), fixture
- Test: `tests/tracker/github-provider.test.js`

- [ ] **Step 1: Confirm the failing conformance cases** (`npx vitest run tests/tracker/github-provider.test.js`).
- [ ] **Step 2: Implement `setStatus`** (cache+op-log+reconcile; `_applyOp` updates the Projects v2 single-select via GraphQL `updateProjectV2ItemFieldValue` AND mirrors the `status:` label; closes the issue on terminal status), `recordCompletion` (per-`code` `_lock`, appends a `<!--compose-event-->` comment + completion to the feature JSON), `appendEvent`/`readEvents` (write/parse ONLY `<!--compose-event {json}-->` comments — native timeline entries are never surfaced). Add the matching `github-api.js` methods (`addIssueComment`, `listIssueComments`, `graphql`) and fixture handlers in the same micro-cycle.
- [ ] **Step 3: Run — full github conformance PASS** (`npx vitest run tests/tracker/github-provider.test.js`).
- [ ] **Step 4: Commit**

```bash
git add lib/tracker/github-provider.js lib/tracker/github-api.js tests/tracker/github-provider.test.js tests/tracker/fixtures/github-server.js
git commit -m "feat(COMP-TRACKER-PROVIDER): GitHubProvider status/completion/events + Projects v2"
```

### Task 16: GitHubProvider — roadmap & changelog via Contents API with provider-canonical merge base

**Files:**
- Modify: `lib/tracker/github-provider.js`, `lib/tracker/github-api.js` (contents API), `lib/roadmap-gen.js` + `lib/changelog-writer.js` (extract pure string-in/string-out merge fn — already started in Task 8), fixture
- Test: `tests/tracker/github-provider.test.js`

- [ ] **Step 1: Failing test — `renderRoadmap` fetches remote ROADMAP.md as merge base, commits merged result**

```js
// append to tests/tracker/github-provider.test.js
import { describe, it, expect } from 'vitest';
describe('GitHubProvider roadmap merge base', () => {
  it('uses fetched remote ROADMAP.md (curated prose preserved), commits merged file', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const cwd = mkdtempSync(join(tmpdir(), 'ctp-ghr-'));
    try {
      const fx = makeGitHubFixture();
      fx.setFile?.('ROADMAP.md', '# Roadmap\n\n<!--preserve-->\nCurated intro\n<!--/preserve-->\n');
      const p = await new GitHubProvider().init(cwd, { repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' }, _transport: fx });
      await p.createFeature('R-1', { code: 'R-1', description: 'r', status: 'PLANNED', phase: 'P1' });
      await p.renderRoadmap();
      const committed = fx.getFile?.('ROADMAP.md');
      expect(committed).toContain('Curated intro');   // merge base preserved
      expect(committed).toContain('R-1');             // regenerated row spliced in
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run — FAIL.** Add `getFile/putFile/setFile` to fixture, `getContents/putContents` to `github-api.js` (Contents API with base blob SHA optimistic lock; 409 → refetch+retry once).
- [ ] **Step 3: Implement** `renderRoadmap()`: fetch remote `roadmapPath` blob → pass as base string to the extracted pure `generateRoadmapFromBase(base, features)` → `putContents` with the fetched SHA. `appendChangelog(entry)`: fetch remote `CHANGELOG.md` → pure `spliceChangelog(base, entry)` → `putContents`. Both reuse the existing merge logic unchanged (just string-in/out).
- [ ] **Step 4: Run — PASS.** Commit (closes PR4):

```bash
git add lib/tracker/github-provider.js lib/tracker/github-api.js lib/roadmap-gen.js lib/changelog-writer.js tests/tracker/github-provider.test.js tests/tracker/fixtures/github-server.js
git commit -m "feat(COMP-TRACKER-PROVIDER): GitHub roadmap/changelog via Contents API w/ provider-canonical merge base"
```

---

## Phase 5 — Config, init validation, CLI surface, mixed-source health (PR5)

### Task 17: `init()` scope validation + `health()` mixedSources

**Files:**
- Modify: `lib/tracker/github-provider.js` (init validates token can read the repo + project; health reports mixedSources)
- Test: `tests/tracker/github-provider.test.js`

- [ ] **Step 1: Failing tests** — `init` with a transport that returns 403 on repo read throws `TrackerConfigError` naming the missing scope; `health()` returns `{ provider:'github', canonical:'github', mixedSources:['journal','vision'], pendingOps:N, conflicts:M }`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**: `init` does a cheap authenticated probe (`GET /repos/{repo}`) and a Projects v2 access probe; on 403/404 throw `TrackerConfigError` with `detail.missingScope`. `health()` reads `OpLog.pending().length`, `ConflictLedger.all().length`, and the static `['journal','vision']` (entities GitHubProvider does not declare).
- [ ] **Step 4: Run — PASS.** Commit.

```bash
git add lib/tracker/github-provider.js tests/tracker/github-provider.test.js
git commit -m "feat(COMP-TRACKER-PROVIDER): GitHub init scope validation + health mixedSources"
```

### Task 18: `compose tracker` CLI (status / sync)

**Files:**
- Modify: `bin/compose.js` (add `tracker` verb — re-grep for the verb dispatch switch first)
- Create: `lib/tracker/cli.js`
- Test: `tests/tracker/cli.test.js`

- [ ] **Step 1: Failing test** — `runTrackerCli(cwd, ['status'])` returns a string containing provider name, pendingOps, conflicts, mixedSources; `runTrackerCli(cwd, ['sync'])` triggers `reconciler.flush()` and reports drained/quarantined counts.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `lib/tracker/cli.js` (`runTrackerCli(cwd, argv)`): builds `providerFor(cwd)`, calls `health()` for `status`; for `sync` calls the provider's reconciler flush (expose `provider.sync()` that delegates to `reconciler.flush()`; local provider's `sync()` is a no-op returning `{drained:0}`). Wire `case 'tracker':` in `bin/compose.js` to `runTrackerCli`.
- [ ] **Step 4: Run — PASS** + `npm test` unchanged. Commit (closes PR5):

```bash
echo "$(date -Iseconds) | compose tracker status/sync CLI" >> .compose/breadcrumbs.log
git add bin/compose.js lib/tracker/cli.js tests/tracker/cli.test.js
git commit -m "feat(COMP-TRACKER-PROVIDER): compose tracker status/sync CLI"
```

---

## Phase 6 — GitHub golden flow, offline, docs, ship (PR6)

### Task 19: GitHub golden flow + offline behavior

**Files:**
- Create: `tests/tracker/github-golden.test.js`

- [ ] **Step 1: Write the golden flow** — against the fixture: `createFeature → setStatus → recordCompletion → renderRoadmap (commit) → readEvents` end to end; assert issue created, Projects v2 field set, ROADMAP committed with merged content, events are ONLY the compose-event comments (no native timeline). Plus an **offline** case: make the fixture throw a network error for N calls → assert writes still succeed locally (cache+op-log), `health().pendingOps > 0`, then restore connectivity → `provider.sync()` drains the log and `health().pendingOps === 0`.
- [ ] **Step 2: Run — PASS** (`npx vitest run tests/tracker/github-golden.test.js`).
- [ ] **Step 3: Run the FULL suite** (`npm test`) — confirm zero regressions vs baseline.
- [ ] **Step 4: Commit**

```bash
git add tests/tracker/github-golden.test.js
git commit -m "test(COMP-TRACKER-PROVIDER): GitHub golden flow + offline reconcile"
```

### Task 20: Codex review loop on the implementation

- [ ] **Step 1:** `mcp__stratum__stratum_agent_run(type="codex")` — review `lib/tracker/**` + the rewired callers against `design.md`. Open-ended prompt; output `REVIEW CLEAN` when done.
- [ ] **Step 2:** Apply every finding yourself (never have Codex edit). Re-run until `REVIEW CLEAN` or 5 iterations. If 5 without converging, surface to the user (spec too broad).
- [ ] **Step 3:** Commit any fixes per iteration with `fix(COMP-TRACKER-PROVIDER): address Codex R<n>`.

### Task 21: Docs + ship

**Files:**
- Modify: `CHANGELOG.md` (via `mcp__compose__add_changelog_entry`, code `COMP-TRACKER-PROVIDER`), `README.md` (tracker provider config section), `.compose/compose.json` schema doc, `docs/features/COMP-TRACKER-PROVIDER/report.md` (new), `docs/journal/` entry (via `write_journal_entry`)

- [ ] **Step 1:** Write `report.md` (delivered vs planned, deviations, test coverage, known gaps incl. the 3 design Open Questions and whether resolved).
- [ ] **Step 2:** CHANGELOG entry naming: `TrackerProvider` interface, `LocalFileProvider` (default, zero behavior change), `GitHubProvider`, `compose tracker` CLI, the `.compose/compose.json` `tracker` key.
- [ ] **Step 3:** README: document `tracker: { provider, github: {...} }` config + `COMPOSE_GH_TOKEN`/`gh` auth + `compose tracker status|sync`.
- [ ] **Step 4:** Set feature status COMPLETE via `mcp__compose__set_feature_status` (or scaffold first if the feature folder isn't tracked), bind ship commit SHA.
- [ ] **Step 5:** Full suite green (`npm test`), then commit + journal entry. Do NOT push (user pushes per CI/CD rule).

```bash
git add CHANGELOG.md README.md docs/features/COMP-TRACKER-PROVIDER/report.md docs/journal/
git commit -m "docs(COMP-TRACKER-PROVIDER): CHANGELOG, README, report, journal — ship v1"
```

---

## Self-Review

**Spec coverage:** Interface (T1) ✓ · capability model + fallback (T6) ✓ · LocalFileProvider zero-change (T3–T5, regression golden) ✓ · mutation-path inventory incl. build.js create/put/setStatus (T9) ✓ · typed partial-commit semantics preserved by delegation (T4, T8) ✓ · idempotency keys + op-log dedupe (T10) ✓ · per-feature lock (T4 local via existing lock, T14/T15 github `_lock`) ✓ · pending-op shadowing + CAS (T11–T12) ✓ · curated-merge roadmap/changelog provider-canonical base (T16) ✓ · GitHub Issues+Projects v2+Contents+events-only-structured (T14–T16) ✓ · config/auth + init scope validation (T6, T17) ✓ · CLI + mixedSources health (T17–T18) ✓ · GitHub golden + offline (T19) ✓ · Codex gate + docs/ship (T20–T21) ✓. Three design Open Questions (reconciler cadence, Projects v2 field bootstrapping, multi-repo) are flagged in `report.md` (T21) — reconciler cadence is "on-demand only for v1" (T18 `sync()`); field bootstrapping handled in T17 init (create-if-missing); multi-repo explicitly out of scope.

**Placeholder scan:** No "TBD"/"similar to"/"add error handling" — every code step shows code; the few "engineer note: verify export name with grep" items are deliberate guardrails against drift, not deferred work.

**Type consistency:** `createFeature/putFeature/setStatus/recordCompletion/addRoadmapEntry/appendEvent/readEvents/renderRoadmap/appendChangelog` consistent across provider.js, local-provider.js, github-provider.js, conformance.js. `OpLog`/`Cache`/`Reconciler`/`ConflictLedger` signatures consistent T10→T12→T14. `CAP` constants consistent. `providerFor` returns either raw local or fallback-proxied remote, consistently.
