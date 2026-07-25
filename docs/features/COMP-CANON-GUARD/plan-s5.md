# COMP-CANON-GUARD S5 — judgment drift detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Detect careless/accidental corruption of `docs/judgment/**` canon (Codex/Bash edits the S4 write-time hook cannot see), at the git/filesystem level, without reusing the dead `build_id` correlation.

**Architecture:** One verifier (`verifyJudgmentCanon`) with three tiers — projection roundtrip (enforcement, records-anchored), full-tree inventory (enforcement, file-set), record sha256 manifest (careless-drift detection). Wired at pre-push, ship, and a standalone `compose guard verify`. Positioned everywhere as drift-detection, NOT enforcement (see spec F1 reframe).

**Tech Stack:** Node ESM, `node:test`, `node:crypto` sha256, `node:fs`. Compose lib/ + bin/compose.js + bin/git-hooks/.

**Spec:** [design-s5.md](design-s5.md). Read it first — especially "The honest reframe" and the 6 requirements R1-R6.

## Global Constraints

- **Test runner:** `node --test test/<file>.test.js` (node:test, NOT vitest). Full gate: `npm test`.
- **Naming/copy rule (R1):** every user-facing string (CLI help, report text, commit messages, comments) says "drift detection", NEVER "enforcement", for the record tier.
- **The S4 guard is LIVE** in `.claude/settings.json` — a raw `Write`/`Edit` to `docs/judgment/**` from Claude is DENIED. Author judgment fixtures in tests via `node:fs` inside tmpdirs (the hook only intercepts Claude tool calls, not `fs.writeFileSync`), or via the `judgment_*` MCP tools — never a raw editor on real judgment paths.
- **Commit direct to main.** No `Co-Authored-By`. Parked landmines (`ROADMAP.md` row 192, `docs/features/COMP-TRIAGE-POOL/`) — never stage. Stage explicitly.
- **MCP staleness:** editing `server/*.js` or the writer invalidates the session's MCP server. If a task edits a judgment writer path and needs a live MCP call, spawn a fresh server or restart before asserting.
- **Codex gate each task** (sol/xhigh, read-only) before commit, per project practice.

---

### Task 0: Map the record-mutation durability topology (DISCOVERY — gates Task 3)

F3 established there is NO single mutation/rollback wrapper. Before any stamping code, produce the exact list of stamp sites. **No production code in this task — it writes a findings doc.**

**Files:**
- Create: `docs/features/COMP-CANON-GUARD/s5-mutation-topology.md`

**Interfaces:**
- Produces: `STAMP_SITES` — the enumerated list of `(function, file:line, when-durable)` where a record becomes durable on disk, that Task 3 must stamp; and `NO_STAMP_SITES` — regeneration/read paths that must NEVER stamp.

- [ ] **Step 1:** Trace every path in `lib/judgment-writer.js` that writes a record to disk. Codex cited `commitWithProjections` (~212), the pending-intent persist (~836), intent publish/refuse/replay (~3144). Verify each against current line numbers; find any others (grep for record writes / `writeJson` / store mutation calls).
- [ ] **Step 2:** Confirm `regenerateProjections` (called by read-only `getJudgmentState` ~3303) writes ONLY projections, never records — so it must NOT stamp. Record it in `NO_STAMP_SITES`.
- [ ] **Step 3:** For each stamp site, note which record path(s) it makes durable, so Task 3 can call `stampRecord(cwd, recordRelPath)` per-record (NOT a whole-tree regen — a whole-tree regen would launder an unrelated tampered record).
- [ ] **Step 4:** Write `s5-mutation-topology.md` with the two lists + file:line evidence. Commit.

---

### Task 1: `lib/judgment-attest.js` — the record manifest (canonical set + fail-closed)

**Files:**
- Create: `lib/judgment-attest.js`
- Test: `test/judgment-attest.test.js`

**Interfaces:**
- Produces:
  - `recordFileSet(cwd) -> string[]` — the EXACT canonical record paths (R4): every file under `docs/judgment/records/**` INCLUDING `ledger.jsonl`, EXCLUDING `.attest.json`. Sorted, repo-relative.
  - `computeRecordHashes(cwd) -> { [relPath]: sha256hex }` — fail-closed: a record that is unreadable or (for `.json`) unparseable throws / marks drift, never silently omitted.
  - `readManifest(cwd) -> { [relPath]: sha256 } | null` (reads `.compose/judgment-attest.json` — see manifest-location note below).
  - `writeManifest(cwd, hashes)` — atomic, sorted keys, stable formatting.
  - `stampRecord(cwd, relPath)` — recompute ONE record's hash, merge into the manifest, write. (Per-record, not whole-tree.)
  - `verifyRecords(cwd) -> { ok, drift: [{path, kind: 'modified'|'added'|'removed'|'malformed'}] }`.

- [ ] **Step 1: Write failing tests** (`test/judgment-attest.test.js`, node:test, tmpdir fixtures):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFileSet, computeRecordHashes, writeManifest, verifyRecords, stampRecord } from '../lib/judgment-attest.js';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'jattest-'));
  mkdirSync(join(d, 'docs/judgment/records/joints'), { recursive: true });
  writeFileSync(join(d, 'docs/judgment/records/joints/x.json'), JSON.stringify({ id: 'x' }));
  writeFileSync(join(d, 'docs/judgment/records/ledger.jsonl'), '{"e":1}\n');
  return d;
}

test('recordFileSet includes ledger.jsonl, excludes .attest.json', () => {
  const d = repo();
  writeFileSync(join(d, 'docs/judgment/records/.attest.json'), '{}');
  const set = recordFileSet(d);
  assert.ok(set.some(p => p.endsWith('records/ledger.jsonl')));
  assert.ok(set.some(p => p.endsWith('joints/x.json')));
  assert.ok(!set.some(p => p.endsWith('.attest.json')));
});

test('verifyRecords: clean after stamping the full set', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  assert.equal(verifyRecords(d).ok, true);
});

test('verifyRecords: a content edit with stale manifest = modified drift', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  writeFileSync(join(d, 'docs/judgment/records/joints/x.json'), JSON.stringify({ id: 'TAMPERED' }));
  const r = verifyRecords(d);
  assert.equal(r.ok, false);
  assert.ok(r.drift.some(x => x.kind === 'modified' && x.path.endsWith('joints/x.json')));
});

test('verifyRecords: a malformed json record fails CLOSED (not silently omitted)', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  writeFileSync(join(d, 'docs/judgment/records/joints/x.json'), '{not json');
  const r = verifyRecords(d);
  assert.equal(r.ok, false);
  assert.ok(r.drift.some(x => x.kind === 'malformed'));
});

test('verifyRecords: added record with no manifest entry = added drift', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  writeFileSync(join(d, 'docs/judgment/records/joints/new.json'), JSON.stringify({ id: 'n' }));
  assert.ok(verifyRecords(d).drift.some(x => x.kind === 'added'));
});

test('stampRecord updates only its own entry (does not re-bless a sibling)', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  // tamper a sibling, then legitimately stamp a DIFFERENT record
  writeFileSync(join(d, 'docs/judgment/records/joints/x.json'), JSON.stringify({ id: 'TAMPERED' }));
  writeFileSync(join(d, 'docs/judgment/records/joints/y.json'), JSON.stringify({ id: 'y' }));
  stampRecord(d, 'docs/judgment/records/joints/y.json');
  // x must STILL be flagged — stamping y did not launder x
  assert.ok(verifyRecords(d).drift.some(p => p.path.endsWith('joints/x.json')));
});
```

- [ ] **Step 2: Run tests, verify they fail** — `node --test test/judgment-attest.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement `lib/judgment-attest.js`** — sha256 via `node:crypto`; `recordFileSet` walks `docs/judgment/records/**` (recursive), includes `ledger.jsonl`, excludes `.attest.json`; `computeRecordHashes` reads bytes, and for `.json` files attempts `JSON.parse` and marks `malformed` on failure (fail-closed); manifest is `.compose/judgment-attest.json` sorted-keys JSON (see note below); `stampRecord` is a read-merge-write of a single key.

> **Manifest-location note (FINAL — settled by the Task 1 + Task 2 reviews, 2026-07-24):**
> the manifest lives at **`.compose/judgment-attest.json`** — NOT at `records/.attest.json` as
> originally specced, and not at the interim `docs/judgment/.attest.json` either.
>
> Three review findings shared one root cause: **a baseline stored inside the tree it attests dies
> with that tree, and its absence reads as a false GREEN** (violating R4 fail-closed). Inside
> `records/`, an `rm -rf docs/judgment/records` erased canon and baseline together; one level up,
> `rm -rf docs/judgment` did the same. `.compose/` is git-tracked (only `.compose/data/` is
> gitignored), so this location is BOTH committed — a fresh clone can still verify — and immune to
> any deletion of the canon.
>
> Resulting contract, pinned by tests in `test/judgment-verify.test.js`:
> - canon wiped, manifest survives → every record reads `removed` → **RED**
> - no canon ever (no `docs/judgment/`, no manifest) → nothing to verify → **GREEN** (the
>   `hasNoCanon` short-circuit; without it, every project that never adopted the judgment layer
>   would fail pre-push and ship)
> - manifest deleted while records exist → all records read `added` → **RED**
>
> Because the manifest now sits outside `docs/judgment/**`, the Task 2 tree inventory does NOT
> include it in its expected set, and `syncManifest` must never attest it.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Codex gate (read-only), then commit** `lib/judgment-attest.js` + test.

---

### Task 2: `lib/judgment-verify.js` — combined verifier (full-tree inventory + lock)

**Files:**
- Create: `lib/judgment-verify.js`
- Test: `test/judgment-verify.test.js`

**Interfaces:**
- Consumes: `verifyRecords` (Task 1), `checkProjectionRoundtrip` (`lib/judgment-gen.js`, existing), the judgment write-lock primitive (find it in `lib/judgment-writer.js` ~948 — Task 0 notes its name).
- Produces: `verifyJudgmentCanon(cwd) -> { ok, treeDrift: [{path, kind}], projectionDrift, recordDrift }`. `EXPECTED_TREE` — the exact allowlist of every non-record file under `docs/judgment/**` (the 5 projections + `index.md` + `people/*.md` + `positions/*.md`), against which unexpected files/dirs/symlinks are rejected (R2).

- [ ] **Step 1: Write failing tests** — cover: (a) clean tree → ok; (b) a stray `docs/judgment/FAKE.md` → treeDrift `unexpected`; (c) a stray `docs/judgment/people/fake.txt` → treeDrift; (d) a symlink under `docs/judgment/` → treeDrift; (e) projection drift surfaces from `checkProjectionRoundtrip`; (f) record drift surfaces from `verifyRecords`. (Author real code in the test — mirror Task 1's fixture style, adding projection files.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — enumerate the actual tree under `docs/judgment/` (recursive, incl. dirs + `lstat` for symlinks), classify each against `EXPECTED_TREE` ∪ `recordFileSet`, reject anything else; run `checkProjectionRoundtrip` + `verifyRecords`; wrap all reads in the judgment lock (R6) or a single consistent snapshot. Combine into one report.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Codex gate, then commit.**

---

### Task 3: Stamp the manifest at every record-durability boundary (uses Task 0)

**Files:**
- Modify: `lib/judgment-writer.js` — at each `STAMP_SITES` entry from Task 0.
- Test: `test/judgment-writer-attest.test.js` (or extend the writer's existing test).

**Interfaces:**
- Consumes: `stampRecord` (Task 1), `verifyJudgmentCanon` (Task 2), `STAMP_SITES`/`NO_STAMP_SITES` (Task 0).

> **Code is Task-0-gated.** Exact edits are written after Task 0 maps the sites. Requirement: after ANY legit record mutation, the manifest is synced for the touched records within the same durability boundary (so a crash between record-write and sync does not leave a false-drift). `regenerateProjections` MUST NOT sync.
>
> **CORRECTED (Task 0 + Task 3 review, 2026-07-24):** two statements in this task's original text were wrong.
> 1. **`getJudgmentState` is NOT a pure read.** It calls `replayIntentsLocked` at its head, so when a pending intent exists it publishes it and legitimately mutates records — and therefore MUST sync. The invariant is narrower than "a read never stamps": the *projection/aggregation* half must never sync, while the *replay* half must. Asserting "getJudgmentState never changes the manifest" would fail a correct implementation.
> 2. **Per-site `stampRecord` is not the strategy.** `UndoLog.restore` compensation bypasses the store's write primitive, so the exhaustive boundary is the three mutation orchestrators, synced via `syncManifest(cwd, undo.touchedPaths())` on a final-state basis (exists → stamp, gone → remove). See `s5-mutation-topology.md` "Recommended stamping strategy".
> 3. The topology enumeration covers `lib/judgment-writer.js` **and** `bin/judgment-import.js` — the importer was missed in the first pass and establishes a trust-on-first-use baseline for promoted records.

- [ ] **Step 1: Write failing integration tests** — for EACH legit op (create, amend, joint_add, transition, pending-intent persist, intent publish, replay, person_write, situation_write, goal_write): run the op on a fixture, then assert `verifyJudgmentCanon(cwd).ok === true` (no false "forged" verdict). Plus `getJudgmentState` in BOTH cases: with no pending intents it must not launder a pre-existing raw record edit (the edit stays `modified` drift); with a pending intent it publishes and the manifest legitimately changes, leaving verify GREEN.
- [ ] **Step 2: Run, verify fail** (ops don't stamp yet → verify flags them as drift).
- [ ] **Step 3: Implement** — add `stampRecord` at each `STAMP_SITES` entry; confirm no stamp on read/regeneration paths.
- [ ] **Step 4: Run, verify pass. Then run the FULL suite** (`npm test`) — the writer is load-bearing.
- [ ] **Step 5: Codex gate, then commit.**

---

### Task 4: `compose guard verify [--fix]` CLI

**Files:**
- Modify: `bin/compose.js` — extend the `guard` command block (added in S4, after the `hooks` block).
- Test: `test/canon-guard-cli.test.js` (or a bin smoke test invoking `node bin/compose.js guard verify` against a fixture repo).

**Interfaces:**
- Consumes: `verifyJudgmentCanon` (Task 2), `writeManifest`/`computeRecordHashes` (Task 1), `regenerateProjections` (existing).

- [ ] **Step 1: Write failing test** — `compose guard verify` in a clean fixture exits 0; after a stray-file / record-tamper, exits 1 and prints the drift. `--fix` regenerates projections only, and a raw RECORD edit still fails after `--fix` (R1 — `--fix` never blesses a record edit). **CORRECTED AS BUILT:** the "re-stamps the manifest for a legit desync" clause was removed in the Task 4 review — `--fix` never writes the record manifest at all, because `verifyJudgmentCanon` releases the judgment lock before returning, so any re-stamp would run on a stale verdict and could launder an edit that landed in between.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the `verify` subcommand: run `verifyJudgmentCanon`; on drift print each `{path, kind}` and exit 1; `--fix` = `regenerateProjections(cwd)` (projections only), explicitly documented/tested to NOT resolve record `modified` drift (report it, exit 1). All output says "drift", never "enforcement". **CORRECTED AS BUILT:** no manifest re-stamp — see Step 1. Baselining is `compose guard init` only.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Codex gate, then commit.**

---

### Task 5: Ship wiring — verify before the build's commit

**Files:**
- Modify: `lib/build.js` — before the plain `git commit` (~4668-4690), after staging.
- Test: extend the build test that exercises the commit path, or a focused unit around the new gate.

**Interfaces:**
- Consumes: `verifyJudgmentCanon` (Task 2).

- [ ] **Step 1: Write failing test** — a build whose working tree has a judgment drift fails with a clear error; a clean tree proceeds. (Mirror the existing mcp-enforcement build-gate test shape.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — call `verifyJudgmentCanon(cwd)` before commit; on drift, throw a typed error (`JUDGMENT_CANON_DRIFT`) that aborts the build. Do NOT touch `scanGuarded` / `build_id`.
- [ ] **Step 4: Run, verify pass. Full suite.**
- [ ] **Step 5: Codex gate, then commit.**

---

### Task 6: Pre-push gate + hook version detection (R5)

**Files:**
- Modify: `bin/git-hooks/pre-push.template` — add a `compose guard verify` gate for pushes touching `docs/judgment/**`.
- Modify: `lib/hooks-status.js` — add a template version/content check so a pre-S5 installed hook reports `stale`.
- Test: `test/hooks-status.test.js` (extend) — an installed pre-push lacking the S5 marker/version reports `installed-stale`.

**Interfaces:**
- Consumes: the `compose guard verify` CLI (Task 4).

- [ ] **Step 1: Write failing test** — `computeHooksStatus` on a hook file missing the S5 version marker returns `state: 'installed-stale'` with a version-drift reason; a current one returns `installed-current`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — bump a `HOOK_VERSION` baked into the template + a marker; `hooks-status.js` compares the baked version to the expected and reports stale on mismatch. Add the verify gate to the template (hard-fail on judgment drift; place it OUTSIDE the docs-only test-skip so judgment-doc pushes are always checked; note `--no-verify` bypass in a comment).
- [ ] **Step 4: Run, verify pass. Full suite.**
- [ ] **Step 5: Codex gate, then commit. Then `compose hooks install --pre-push` to roll out locally, and `compose guard init` once to write the initial baseline manifest (trust-on-first-use).** **CORRECTED AS BUILT:** `guard verify --fix` cannot do this — it refuses to write the record manifest, which is exactly why `guard init` exists.

---

## Bootstrap note (trust-on-first-use)

The first `.attest.json` is written by stamping the CURRENT records as the baseline (they are trusted as-is — there is no prior attestation to verify against). This is the honest starting point and is stated in the spec's honest-limits. Do it once via **`compose guard init`** after Task 6. **CORRECTED AS BUILT:** `guard verify --fix` is NOT an alternative — it refuses to write the record manifest, so following the original instruction would leave the canon uninitialized forever with every record reported as `added`.

## Self-Review (done)

- **Spec coverage:** R1→Task 4 + naming constraint; R2→Task 2; R3→Task 0+3; R4→Task 1; R5→Task 6; R6→Task 2. All acceptance criteria map to a task's test.
- **Placeholders:** Task 3's exact edits are Task-0-gated by design (F3: topology unknown until mapped) — NOT a placeholder but an explicit discovery dependency, with the requirement + tests fully specified.
- **Type consistency:** `stampRecord(cwd, relPath)`, `verifyRecords(cwd)→{ok,drift}`, `verifyJudgmentCanon(cwd)→{ok,treeDrift,projectionDrift,recordDrift}` used consistently across tasks.
