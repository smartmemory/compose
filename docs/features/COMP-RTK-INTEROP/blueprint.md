# COMP-RTK-INTEROP: Implementation Blueprint

**Status:** BLUEPRINT — verified 2026-06-15
**Design:** [design.md](./design.md) (Approach A approved; extend manifest with `external_binaries`)

## Corrections Table (spec assumption vs verified reality)

| # | Assumption (roadmap row / design) | Verified reality | Resolution |
|---|-----------------------------------|------------------|------------|
| 1 | "route git diff, git status, npm test" — many sites | Most git shell-outs are PARSE-BOUND (`split('\n')`, regex SHA/shortstat) or CONTROL (output discarded). RTK is lossy → would corrupt them. | Wrap only LLM-bound sites. |
| 2 | `npm test` (`build.js:2253`) is LLM-bound | `${testCommand} 2>&1 \|\| true` — output **discarded**, run only to stage changes. | Not a target. The agent's *own* test runs (the real win) are covered by RTK's `rtk init -g` CC hook, not compose code. |
| 3 | `build.js:4087` `git diff --cached HEAD` is LLM-bound (explorer's claim) | The captured diff → `taskDiffs` → `.patch` file → **`git apply`** (`build.js:3553-3559`, `3739`). It is a mechanically re-applied patch. | **MUST NOT wrap** — RTK's lossy rewrite would break `git apply`. Dropped from scope. |
| 4 | 2 LLM-bound sites | After verifying #3, exactly **1**: `build.js:217`. | v1 wraps 1 site + helper + detection. |

**Net verified LLM-bound site:** `lib/build.js:217` only.

```js
// build.js:215-220 (verified)
let currentDiff = '';
try {
  currentDiff = execSync('git diff --no-color HEAD', {
    cwd: context.cwd, encoding: 'utf-8', timeout: 10_000,
  }).slice(0, 8000);
} catch { /* not a git repo or no diff */ }
```
`currentDiff` → `tier1CodexReview(..., currentDiff, ...)` (`build.js:225`) → read by Codex (LLM). Safe + beneficial to compress: denser context, less 8000-char truncation.

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/rtk.js` | new | `isRtkAvailable()` (memoized) + `rtkPrefix(command)` |
| `lib/build.js` | edit (1 site ~217 + import) | wrap the LLM-bound Codex-review diff |
| `.compose-deps.json` | edit | add `external_binaries` entry for `rtk` |
| `lib/deps.js` | edit | load + check + report `external_binaries` |
| `bin/compose.js` | edit (`runDoctor`) | report rtk availability + `rtk init -g` recommend |
| `test/rtk.test.js` | new | helper behavior + memoization + kill-switch |
| `test/rtk-deps.test.js` | new | manifest binaries load + `checkExternalBinaries` split |

## Work Units

### S1 — `lib/rtk.js` (new) — detection + prefix helper
- `isRtkAvailable()` — memoized once per process. Honors `COMPOSE_DISABLE_RTK=1` kill-switch (→ false). Probes via injectable `_prober` (default `spawnSync('rtk',['--version'])`, `status===0`, swallow throw → false).
- `rtkPrefix(command)` — `isRtkAvailable() ? \`rtk ${command}\` : command`. Pass only operator-free bare commands.
- Test seams: `_setRtkProber(fn)` (resets cache), `_resetRtkCache()`.
- Pattern reference: binary detection mirrors `bin/compose.js:349` (`spawnSync('which', ['stratum-mcp'])`).

### S2 — `lib/build.js` (edit, 1 site) — wrap the Codex-review diff
- Import `rtkPrefix` from `./rtk.js` (alongside imports near `build.js:15`).
- Line ~217: `execSync('git diff --no-color HEAD', …)` → `execSync(rtkPrefix('git diff --no-color HEAD'), …)`.
- No other site touched. Degrade path = original string verbatim → byte-identical when RTK absent.

### S3 — `.compose-deps.json` (edit) — add `external_binaries`
```json
"external_binaries": [
  {
    "id": "rtk",
    "detect": "rtk --version",
    "required_for": ["LLM-bound git-diff compression (build review)", "agent Bash output via `rtk init -g` hook"],
    "install": "brew install rtk  (or cargo install --git https://github.com/rtk-ai/rtk)",
    "recommend": "rtk init -g",
    "optional": true
  }
]
```

### S4 — `lib/deps.js` (edit) — load + check binaries
- `loadDeps`: accept optional `external_binaries` array (absent → `[]`). Per-entry validate `{id:string, detect:string, install:string, optional:boolean}`, `required_for` (array<string>, optional), `recommend` (string|null|absent). Skip-and-warn invalid; never null the whole manifest just because binaries are malformed.
- `checkExternalBinaries(deps, { probe } = {})` — `probe(detect)→boolean`; default splits `detect` on whitespace and `spawnSync(bin, args, {stdio:'pipe', timeout:3000}).status===0`. Returns `{ present, missing }`.
- `buildBinaryReport(result)` / `printBinaryReport(result)` — JSON + human (`✓`/`○ (optional) — install: … | recommend: …`).

### S5 — `bin/compose.js` (edit) — doctor reports rtk
- In `runDoctor`: after the skills report, `checkExternalBinaries(deps)` → human print via `printBinaryReport`; in `--json` branch add `binaries: buildBinaryReport(...)` to the single root document (`bin/compose.js:304-305`).
- Optional binaries never affect `--strict` exit code.

### S6 — Tests
- `test/rtk.test.js` (new): prober→true ⇒ `rtkPrefix` prepends `rtk `; prober→false ⇒ byte-identical passthrough; memoization (counting prober called once); `COMPOSE_DISABLE_RTK=1` overrides true prober.
- `test/rtk-deps.test.js` (new): `loadDeps` surfaces `external_binaries`; absent-binaries → `[]`; invalid binary entry skipped; `checkExternalBinaries` present/missing split via injected probe. (Existing T1 `external_skills.length===12` untouched.)

## Boundary Map

- `isRtkAvailable` — function — `lib/rtk.js` — memoized availability probe; consumed by `rtkPrefix`.
- `rtkPrefix` — function — `lib/rtk.js` — wraps an LLM-bound command; consumed by `lib/build.js` (S2, from S1).
- `checkExternalBinaries` — function — `lib/deps.js` — disk/binary probe; consumed by `bin/compose.js` doctor (S5, from S4).
- `buildBinaryReport` — function — `lib/deps.js` — JSON projection; consumed by `bin/compose.js` `--json` (S5, from S4).
- `printBinaryReport` — function — `lib/deps.js` — human report; consumed by `bin/compose.js` doctor (S5, from S4).

## Verification Table

| Ref | Check | Result |
|-----|-------|--------|
| `build.js:217` | `git diff --no-color HEAD` present, LLM-bound via `tier1CodexReview` | ✓ verified |
| `build.js:4087` | diff → `taskDiffs` → `git apply` (parse/patch-bound) | ✓ verified — excluded |
| `build.js:2253` | test output discarded (`\|\| true`) | ✓ verified — excluded |
| `lib/deps.js` | `loadDeps`/`buildDepReport`/`printDepReport` shape | ✓ verified |
| `bin/compose.js:287-326` | `runDoctor` structure, `--json` single-root | ✓ verified |
| `bin/compose.js:349` | binary-detect pattern (`spawnSync which`) | ✓ verified |
| test T1 | `external_skills.length===12` unaffected by additive `external_binaries` | ✓ verified |
