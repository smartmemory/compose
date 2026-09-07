<!-- wasGeneratedBy: explore_design -->
# COMP-SEMVER-STRICT — Strict semver parsing in `compareVersions`

**Status:** DESIGN — 2026-08-30
**Complexity:** S (single function, one source line + tests)
**Phase:** Distribution

## Related Documents

- Defective function: `lib/version-check.js:75–95` (`compareVersions`, bug at line 79)
- Existing tests: `test/version-check.test.js` (18 tests; `compareVersions` not yet directly imported)
- Doctor golden test: `test/comp-deps-package.test.js:263` (must pass unchanged)
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

### Inputs already handled correctly (no regression risk)

| Input | `parseInt` result | Guard fires? | Returns |
|---|---|---|---|
| `'1.2.x'` | `NaN` on `'x'` | yes | `null` ✓ |
| `'v1.2.3'` | `NaN` on `'v1'` | yes | `null` ✓ |
| `''` (empty component) | `NaN` | yes | `null` ✓ |

### Input that is broken

| Input | `parseInt` result | Guard fires? | Returns |
|---|---|---|---|
| `'1.2.3garbage'` | `3` (junk stripped) | no | wrong numeric result ✗ |

---

## 2. Scope and blast radius

`compareVersions` is called internally by `checkPackageVersion` (lines 109 and 128), which
feeds every `compose doctor` / version-nudge path. All callers already null-guard the return
value, so changing `'1.2.3garbage'` from "wrong number" to `null` changes no real code path:
npm registry strings and `package.json` version fields are well-formed in practice.

The fix is contained to one inner expression at line 79. No API surface, no type signature,
no downstream caller needs to change.

---

## 3. The fix

Replace the `parseInt`-based mapper with a strict numeric predicate:

```js
// Before (line 79)
const parts = core.split('.').map(n => Number.parseInt(n, 10))

// After
const parts = core.split('.').map(n => (/^\d+$/.test(n) ? Number(n) : NaN))
```

`/^\d+$/` accepts only strings that are entirely decimal digits. `'3garbage'` fails the
test; the mapper returns `NaN`; the existing guard on line 80 (`parts.some(n => Number.isNaN(n))`)
catches it and returns `null`. No other lines change.

The prerelease-tag path (lines 78, 91–94) is unaffected: the tag is split off before
component parsing and is never passed through the strict predicate.

---

## 4. Implementation

**One file changes, one file gains tests:**

| File | Change |
|---|---|
| `lib/version-check.js` (existing) | Line 79: swap `parseInt` for `/^\d+$/` predicate |
| `test/version-check.test.js` (existing) | Add `compareVersions` to import; add 4 direct test cases |

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

---

## 5. Acceptance criteria

- [ ] `compareVersions('1.2.3garbage', '1.2.4')` returns `null` (was `-1`)
- [ ] `compareVersions('1.2.x', '1.2.3')` returns `null` (already correct; regression guard)
- [ ] `compareVersions('v1.2.3', '1.2.3')` returns `null` (already correct; regression guard)
- [ ] `compareVersions('1..3', '1.2.3')` returns `null` (already correct; regression guard)
- [ ] All 18 existing tests in `test/version-check.test.js` continue to pass
- [ ] `compose doctor --json` output is byte-identical before and after the fix
  (verified by `test/comp-deps-package.test.js:263`)
- [ ] `CHANGELOG.md` entry added in the same commit as the code change
- [ ] `docs/features/COMP-SEMVER-STRICT/feature.json` status updated to `COMPLETE`
