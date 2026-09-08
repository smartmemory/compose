<!-- wasGeneratedBy: explore_design -->
# COMP-SEMVER-STRICT — Strict semver parsing in `compareVersions`

**Status:** DESIGN — 2026-08-30
**Complexity:** S (single parser + focused tests)
**Phase:** Distribution

## Related Documents

- Defective function: `lib/version-check.js` (`compareVersions`)
- Direct tests: `test/version-check.test.js`
- Doctor shape smoke test: `test/comp-deps-package.test.js`
- Feature spec: `docs/features/COMP-SEMVER-STRICT/feature.json`
- ROADMAP.md:1557 (Distribution section, COMP-SEMVER-STRICT row)

---

## 1. The problem

`compareVersions` in `lib/version-check.js` uses `Number.parseInt(n, 10)` to parse each
dot-separated component of a semver string. `parseInt` is lenient: it reads the leading
numeric characters and silently discards any trailing junk.

```
Number.parseInt('3garbage', 10)  // → 3  (not NaN)
```

So `compareVersions('1.2.3garbage', '1.2.4')` returns `-1` ("behind") instead of `null`
("unparseable"), violating the function's own JSDoc contract (line 72: *"null if either
unparseable"*).

The current guard on line 80 only catches `NaN` — it never fires for trailing-junk inputs
because `parseInt` never produces `NaN` for a string that starts with a digit.

### Strict-core inputs pinned by tests

| Input | `parseInt` result | Guard fires? | Returns |
|---|---|---|---|
| `'1.2.x'` | `NaN` on `'x'` | yes | `null` ✓ |
| `'v1.2.3'` | `NaN` on `'v1'` | yes | `null` ✓ |
| `''` (empty component) | `NaN` | yes | `null` ✓ |

### Input that is broken

| Input | `parseInt` result | Guard fires? | Returns |
|---|---|---|---|
| `'1.2.3garbage'` | `3` (junk stripped) | no | wrong numeric result ✗ |

The first strict-parser implementation also exposed two decomposition defects. Build metadata
remained attached to the patch component, so a valid version such as `1.2.3+build1` became
unparseable. Separately, splitting on every hyphen discarded part of a prerelease such as
`alpha-1`, causing `1.2.3-alpha-1` and `1.2.3-alpha-2` to compare equal.

---

## 2. Scope and blast radius

`compareVersions` is called internally by `checkPackageVersion`, which feeds the version-nudge
path. Callers null-guard malformed versions, but build metadata is valid SemVer and must remain
comparable; returning `null` for it can suppress a version result rather than merely reject junk.

The correction remains contained to the parser inside `compareVersions`. No API surface, type
signature, or downstream caller changes.

---

## 3. The fix

Decompose `<core>-<prerelease>+<build>` before applying the strict numeric predicate:

```js
// Before
const [core, pre] = s.split('-')
const parts = core.split('.').map(n => Number.parseInt(n, 10))

// After
const buildIndex = s.indexOf('+')
const withoutBuild = buildIndex === -1 ? s : s.slice(0, buildIndex)
const prereleaseIndex = withoutBuild.indexOf('-')
const core = prereleaseIndex === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex)
const pre = prereleaseIndex === -1 ? null : withoutBuild.slice(prereleaseIndex + 1)
const parts = core.split('.').map(n => (/^\d+$/.test(n) ? Number(n) : NaN))
```

Build metadata is removed first because it never participates in precedence. The first hyphen
then separates the core from the complete prerelease string, including any later hyphens.
`/^\d+$/` still accepts only core components made entirely of decimal digits, so `'3garbage'`
continues to return `null` through the existing `NaN` guard.

---

## 4. Implementation

**Implementation and supporting records:**

| File | Change |
|---|---|
| `lib/version-check.js` | Decompose build and prerelease before strict core parsing |
| `test/version-check.test.js` | Cover strict core parsing, build metadata on either/both operands, and embedded prerelease hyphens |
| `CHANGELOG.md` | Describe the observable parser behavior without claiming downstream byte identity |
| `docs/features/COMP-SEMVER-STRICT/design.md` | Keep acceptance claims aligned with their tests and gate state |

### New test cases (added to `test/version-check.test.js`)

```js
import { ..., compareVersions } from '../lib/version-check.js'

// Trailing junk — the broken case this feature fixes
test('compareVersions: trailing junk returns null', () => {
  assert.strictEqual(compareVersions('1.2.3garbage', '1.2.4'), null)
})

// Already-correct inputs — regression guards
test('compareVersions: alpha component returns null', () => {
  assert.strictEqual(compareVersions('1.2.x', '1.2.3'), null)
})
test('compareVersions: v-prefixed string returns null', () => {
  assert.strictEqual(compareVersions('v1.2.3', '1.2.3'), null)
})
test('compareVersions: empty component returns null', () => {
  assert.strictEqual(compareVersions('1..3', '1.2.3'), null)
})
```

Follow-up regression cases cover build metadata on the left, on the right, and on both
operands; `1.2.3-alpha-1` versus `1.2.3-alpha-2`; and the combined prerelease-plus-build form.

---

## 5. Acceptance criteria

- [x] `compareVersions('1.2.3garbage', '1.2.4')` returns `null` (was `-1`) — `test/version-check.test.js`
- [x] `compareVersions('1.2.x', '1.2.3')` returns `null` (already correct; regression guard) — `test/version-check.test.js`
- [x] `compareVersions('v1.2.3', '1.2.3')` returns `null` (already correct; regression guard) — `test/version-check.test.js`
- [x] `compareVersions('1..3', '1.2.3')` returns `null` (already correct; regression guard) — `test/version-check.test.js`
- [x] Build metadata is ignored on the left, right, and both operands — `test/version-check.test.js`
- [x] Hyphens inside prerelease identifiers are preserved for comparison — `test/version-check.test.js`
- [x] Build metadata following a hyphenated prerelease is decomposed in the correct order — `test/version-check.test.js`
- [x] All 38 tests in `test/version-check.test.js` pass — `test/version-check.test.js`
- [x] `compose doctor --json` runs successfully and emits parseable dependency JSON with the expected field types — `test/comp-deps-package.test.js`
- [x] `CHANGELOG.md` entry added in the same commit as the code change
- [ ] Separate completion gate updates `docs/features/COMP-SEMVER-STRICT/feature.json` status to `COMPLETE`

Mutation-checked 2026-09-08: replacing the strict mapper with `Number.parseInt` makes the named
trailing-junk test fail. Restoring the old `s.split('-')` decomposition makes each of the five
new decomposition tests fail independently (0 pass / 1 fail); copy-back restoration is
byte-identical by `diff -q`.
