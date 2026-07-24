# COMP-CANON-GUARD — S1+S4 implementation blueprint (the prevention slice)

**Date:** 2026-07-24 · **Status:** IN PROGRESS · **Owner ruling this session:** build the S1+S4 prevention slice; leave S5/S6 for a separate re-spec pass (build-correlation model is dead — all 777 events carry `build_id: null`).

## Progress ledger

- **S1 — COMMITTED @27551dd.** `canon-registry.js` + `mcp-enforcement.js` refactor + contract test. Codex sol/xhigh gate: central ship-behavior claim approved (351-case equivalence, 0 mismatches); 2 findings fixed (deleted vestigial `_internals` shim; reconciled blueprint API names). CHANGELOG via `add_changelog_entry` (dogfood).
- **S4 — BUILT, guard INSTALLED, Codex round 1 done (3 findings fixed), round 2 in flight.** `lib/canon-guard.js` (pure decision + settings transforms), `.claude/hooks/canon-guard.mjs` (runtime wrapper), `bin/compose.js` guard CLI, `test/canon-guard.test.js`. E2E: hook denies judgment writes with tool-naming reason, allows non-canon/ROADMAP, fails open. `compose guard install` applied → `.claude/settings.json` PreToolUse group (existing hooks preserved). **Guard is LIVE in this repo's session.**
  - **Codex round-1 findings, all fixed + regression-tested:**
    1. *(High)* Firmlink/alias bypass — lexical path check let `/System/Volumes/Data/...` (same inode via macOS firmlink) slip a real canon write. Fix: `realpathCanonicalize` (realpath for symlink+case) + strip `/System/Volumes/Data`, applied to root & target. **First fix attempt (plain realpath) was WRONG** — realpath does not collapse firmlinks; verified the strip closes the real exploit E2E.
    2. *(High)* Sibling-hook data loss — group-level "any child ours → delete group" wiped unrelated sibling hooks. Fix: `pruneOurHooks` operates at the hook-entry level.
    3. *(Medium)* Weak ownership marker — loose `.includes` false-positived and misreported drift as absent. Fix: leaf-name regex `canon-guard.mjs`.
  - Deny envelope confirmed correct by Codex against the live hooks contract.
  - **Codex round-2 (confirm fixes) — 2 deeper edges; adjudicated, loop STOPPED at 2 of ~3 rounds:**
    - *R2-1 (symlink+`..`), root-cause FIXED:* `realpathCanonicalize` no longer `resolve()`s up front (that collapsed `..` before symlink resolution). Codex's demonstrated `/Volumes/Macintosh HD/../Users/...` vector now denies (E2E); portable symlinked-root regression added.
    - *R2-2 (ownership regex edges), partially fixed + documented:* widened the leaf boundary so a trailing-`;` drift is still `stale` (regression added). The `node other.mjs canon-guard.mjs` false-positive needs full shell parsing to kill — **accepted limit**, not chased.
  - **Accepted residual limits (runtime-scoped, Bash-bucket — closed only by S5/S6 tree-level backstop, NOT this slice):** exotic `..`-through-nested-symlink chains where `realpath`'s own `..` semantics vary; bind mounts; hardlinks; `filename-as-bare-argument` ownership false-positive. These require deliberately constructed paths/configs a normal Claude `Write` never emits. The hook canonicalizes against the realistic aliasing vectors (firmlink, symlinked root, case-fold); it is a write-time convenience for the dominant (Claude-authoring) failure mode, explicitly NOT a hardened sandbox.
  - Full node:test suite 4828 pass / 0 fail after all fixes.
- **Deferred (filed, not built):** override token protocol; hook-registering ROADMAP/feature.json (needs Decision 2 inventory + override); S5/S6.

**Grounded against source 2026-07-24** — read `lib/mcp-enforcement.js`, `.claude/settings.json`, `lib/hooks-status.js`, `server/mcp-tool-policy.js`, `server/compose-mcp.js`, `lib/judgment-gen.js`, `lib/judgment-writer.js`, `bin/git-hooks/`. This blueprint supersedes the design's rev-6 file:line assumptions where they drifted (corrections table below).

Related: [design.md](design.md) (the epic, 5 gate rounds), [COMP-JUDGMENT-WRITER](../COMP-JUDGMENT-WRITER/design.md) (S3, shipped @751cc96a).

---

## Corrections to the design (source review, per implement-blueprint)

| Design assumption | Source reality | Correction |
|---|---|---|
| `GUARDED_FILES = {ROADMAP.md, CHANGELOG.md, feature.json}` (literal 3-set) | `mcp-enforcement.js:15` set is `{ROADMAP.md, CHANGELOG.md}` **plus** a path-prefix rule (`isGuardedPath:64`) for `*/feature.json` | Registry models **path patterns** (exact name, feature-json prefix, glob), not literals |
| One writer missing (`docs/judgment/**`) | S3 shipped: writer + 8 `judgment_*` tools + `get_judgment_state`; `docs/judgment/**` is **100% tool-covered** | No lockout risk registering judgment for the hook — no uncovered mutation, **no override needed for this slice** |
| `docs/judgment/**` is markdown | It is **records** (`docs/judgment/records/**`, 25 tracked JSON files, the source of truth) + **generated projections** (`REGISTER/LEDGER/OBJECTIVE/SITUATION/index.md`, `people/*.md`, `positions/*.md`; `judgment-gen.js:673` already drift-verifies them) | Hook denies raw writes to **both** records and projections under `docs/judgment/**`; the tools own records + regen |
| Hook install pattern from `bin/git-hooks` | Those are **git** hooks (`.git/hooks/`, `compose hooks install`). The Claude hook is a different mechanism: `.claude/settings.json` `hooks.PreToolUse` + a script file | S4 registers in `.claude/settings.json` (which **is git-tracked** → project-wide default, unlike gitignored `.compose/data/settings.json`). Marker/drift *pattern* from `hooks-status.js:22` transfers; install path does not |
| `.compose/data/settings.json` enables enforcement | It is **gitignored** and currently `{}` on this machine — S0's `'log'` was lost | Out of scope here (ship-scan mode). Note for S2 inventory: no tracked home for a project default |

## The load-bearing decision: one registry, per-path `enforcedBy`

Decision 1 says one registry, three enforcement points. But the points have **different real coverage**, and conflating them causes lockout:

- The **ship scan** (`mcp-enforcement.js`) enforces `ROADMAP.md`/`CHANGELOG.md`/`feature.json` today via build-event correlation. It **cannot** see `docs/judgment/**` (filtered out upstream at `build.js:3942` before `scanGuarded`) — until S5.
- The **hook** (S4) enforces at write-time on tool-call paths. It is safe on `docs/judgment/**` (fully tool-covered). It would **lock out** `ROADMAP.md` (can't open a preserved section) and `feature.json` (can't edit `description`) — the Decision 2 counterexamples — because those have legal mutations no tool covers yet.

So a shared registry must not imply shared coverage. Each entry declares which points enforce it:

```js
// lib/canon-registry.js
{
  pattern: 'docs/judgment/**', kind: 'glob',
  writer: 'lib/judgment-writer.js',
  tools: [ /* the 8 judgment_* write tools */ ],
  operations: [ /* covered: every mutation goes through a tool + regen */ ],
  enforcedBy: ['hook'],            // + 'pre-commit','ship' at S5
}
{
  pattern: 'ROADMAP.md', kind: 'exact',
  writer: 'lib/roadmap-gen.js', tools: TOOLS_FOR_ROADMAP,
  operations: [ /* open_preserved_section UNCOVERED — Decision 2 */ ],
  enforcedBy: ['ship'],            // NOT hook until override + inventory land
}
// CHANGELOG.md → ['ship']; docs/features/*/feature.json → ['ship'] (code-correlated)
```

**Each enforcement point consumes only its subset.** `mcp-enforcement.js` reads `enforcedBy.includes('ship')` → its behavior stays byte-identical to today. The hook reads `enforcedBy.includes('hook')` → only `docs/judgment/**` for this slice. The contract test asserts both subsets resolve from the one registry and that today's ship behavior is unchanged. This makes the coverage gap **explicit data**, not a hidden assumption — directly answering the design's "looks enabled, enforces nothing" trap.

A path enters `hook` enforcement **only** when fully tool-covered (Decision 2 inventory passes) or an override exists. `docs/judgment/**` qualifies today; `ROADMAP.md`/`feature.json` do not → deferred.

---

## S1 — the registry (bounded, mechanical, contract-gated)

**Files**
- `lib/canon-registry.js` (NEW) — pure declarative, no I/O (shape template: `server/mcp-tool-policy.js`). **Actual exports (as shipped):** `matchEntry(path, {featuresDir, point})` → entry|null, `isGuarded(path, {featuresDir, point})`, `toolsForPath(path, {featuresDir, point})`, `featureCodeForPath(path, {featuresDir})`, `guardedPatternIdsFor(point)`, plus `JUDGMENT_WRITE_TOOLS`. **S4 consumes `isGuarded`/`matchEntry` for path matching** — it does not need an enumerated-pattern list; `guardedPatternIdsFor` exists only for the contract test's subset-partition assertion.
- `lib/mcp-enforcement.js` (EDIT) — delete literal `GUARDED_FILES`/`TOOLS_FOR_*`; consume the registry's `'ship'` subset. Keep every exported signature (`readEnforcementMode`, `filterGuarded`, `isGuardedPath`, `expectedToolsForPath`, `featureCodeFromPath`, `scanGuarded`, `enforcementError`, `_internals`) so existing callers + `test/mcp-enforcement.test.js` stay green.
- `test/canon-registry-contract.test.js` (NEW) — the exit criterion.

**Tests (TDD, write first)**
- [ ] Contract: for `ROADMAP.md`/`CHANGELOG.md`/`docs/features/X/feature.json`, registry-resolved tools == the old hardcoded sets (byte-for-byte; pin the old sets as literals in the test).
- [ ] Contract: `guardedPatternsFor('ship')` == exactly the 3 legacy shapes; `guardedPatternsFor('hook')` == exactly `docs/judgment/**`.
- [ ] Lockout invariant: a synthetic unregistered path (`docs/whatever.md`) is guarded by **neither** point.
- [ ] `docs/judgment/records/joints/x.json` and `docs/judgment/LEDGER.md` resolve to the judgment entry under `'hook'`, and to **nothing** under `'ship'`.
- [ ] Existing `test/mcp-enforcement.test.js` passes unchanged.

**Gate:** `./node_modules/.bin/vitest run test/canon-registry-contract.test.js test/mcp-enforcement.test.js` green.

## S4 — the PreToolUse hook + management CLI (prevention)

**PreToolUse contract — VERIFIED 2026-07-24 against code.claude.com/docs/en/hooks:**
- stdin JSON carries `tool_name` and `tool_input` (`tool_input.file_path` for `Write`/`Edit`/`NotebookEdit`), plus `cwd`.
- **Deny** = exit 0 + stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<names the tool>"}}`. **Allow/no-opinion** = exit 0 with no deny output (omit / `"defer"`). Exit 2 + stderr also blocks (fallback), but Method B gives Claude a clean reason.
- **Registration** in `.claude/settings.json`: `hooks.PreToolUse` → array of `{ matcher, hooks:[{type:'command', command}] }`. Use `matcher: "Write|Edit|NotebookEdit"`; `command: "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/canon-guard.mjs\""` (invoke via node — no shebang/chmod portability worry).
- **Path normalization:** `tool_input.file_path` may be absolute or relative. Derive projectRoot from the hook's own location (`import.meta.url` → `../..`), then `relPath = path.relative(projectRoot, path.resolve(cwd, file_path))` and match against the registry's repo-relative patterns. **Fail open** (allow) on any parse/resolve error — never wedge the session.

**Files**
- `.claude/hooks/canon-guard.mjs` (NEW) — reads PreToolUse payload on stdin; for `Write`/`Edit`/`NotebookEdit`, normalizes `file_path` to repo-relative, resolves against `guardedPatternsFor('hook')`; if matched → **deny**, message names the covering tool ("`docs/judgment/**` is tool-owned — use `judgment_position_create` / `judgment_joint_add` / … , not a raw edit"). Unregistered path → allow (lockout invariant). Fail-open on malformed input (never wedge the session).
- `bin/compose.js` (EDIT) — `compose guard install|status|uninstall`:
  - `install`: write/refresh `.claude/hooks/canon-guard.mjs`; add the `PreToolUse` entry to `.claude/settings.json` (idempotent; marker-tagged).
  - `status`: mirror `formatHookStatusLines` — installed(current)/absent/foreign/stale, drift on script path.
  - `uninstall`: remove the entry + script.
- `.claude/settings.json` (EDIT, via install) — add `hooks.PreToolUse` → `canon-guard.mjs`.

**Tests (TDD)**
- [ ] Hook denies raw `Write` to `docs/judgment/records/joints/x.json`, names a `judgment_*` tool.
- [ ] Hook denies raw `Edit` to `docs/judgment/LEDGER.md` (a projection).
- [ ] Hook **allows** `Write` to `ROADMAP.md` (ship-enforced, not hook-enforced this slice) and to an unregistered path.
- [ ] Hook fails open (allow) on malformed stdin.
- [ ] `compose guard status` reports absent → installed → drifted, mirroring `compose hooks status`.

**Gate:** hook + CLI tests green; full suite green; `compose guard install` then a manual raw edit attempt to a judgment path is denied end-to-end.

## Explicitly deferred (filed as follow-ups, NOT built here)

- `canon_override_grant` + ledger-first single-use token protocol (Decision 4). Not needed while only `docs/judgment/**` is hook-registered (fully tool-covered).
- Registering `ROADMAP.md`/`feature.json` for the **hook** — needs `update_feature_fields` + roadmap `open_preserved_section` (Decision 2 inventory) + the override first.
- S5 (non-feature-scoped ship scan + pre-commit git hook + build-independent attestation) and S6 (content attestation hash chain) — blocked on re-speccing the dead build-correlation model.
- Codex/Bash bypass of the hook — known runtime-scoped gap (design rev 6, finding 1); closed only by S5/S6.

## Honest coverage after this slice

Hand-editing `docs/judgment/**` **via Claude Write/Edit/NotebookEdit** is denied at write-time, pointing you at the tools. Codex-dispatched edits and `Bash` (`sed -i`, heredoc) still bypass — the runtime-neutral backstop is S5/S6. This is prevention for the dominant path (the 88%-hand-written failure was Claude authoring), stated as runtime-scoped per the design's own rule.
