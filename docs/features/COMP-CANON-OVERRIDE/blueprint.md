# COMP-CANON-OVERRIDE: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-07-25
**Design:** [design.md](design.md) — gate rounds 1 and 2 folded; positioning is **audit tooling, not enforcement**

## Related Documents

- [design.md](design.md) — decisions, the in-workspace ceiling, acceptance criteria
- [COMP-CANON-GUARD design](../COMP-CANON-GUARD/design.md) — Decision 4, the source protocol
- [COMP-CANON-ATTEST design](../COMP-CANON-ATTEST/design.md) — downstream consumer; shares `lib/append-integrity.js`

---

## Corrections table (blueprint assumption vs reality)

| # | Assumption | Reality | Consequence |
|---|---|---|---|
| 1 | New registry entries slot in without touching tests | `test/canon-registry-contract.test.js:61` asserts `guardedPatternIdsFor('hook')` **deepEquals `['judgment']`** exactly | The test must be updated in the same commit as the registry change. This is a deliberate contract change, not a break to work around |
| 2 | `CanonEntry` has somewhere to express override-eligibility | It does not — fields are `id`, `writer`, `tools`, `enforcedBy`, `matches` (`canon-registry.js:88-94`) | `overrideEligible` is a **new field**. Existing entries default to eligible; the three governance entries set it `false`. The typedef and any exhaustive entry-shape assertions need updating |
| 3 | The hook can consume a grant inside `decideCanonGuard` | `decideCanonGuard` is pure and injected-only (`canon-guard.js:103`); gate round 1 finding 4 established a destructive callback breaks that | Classification stays in `decideCanonGuard`; the claim happens in `.claude/hooks/canon-guard.mjs`, which already owns I/O |
| 4 | Registering a path at `hook` is enough to protect it | The hook is **Claude-runtime only** — Codex and `Bash` never invoke it (`COMP-CANON-GUARD/design.md:174`) | Every acceptance claim is runtime-scoped. Already binding per the design's positioning block |
| 5 | `.compose/judgment-attest.json` is guarded, so guarding our baseline is consistent | It is **not** registered — S5 deliberately relocated it out of the guarded tree and left it unguarded | Noted as a cross-feature observation, **out of scope here.** Guarding it is an S5/ATTEST question; raising it in this feature would widen scope without an owner decision |
| 6 | `.gitignore` `data/` reliably keeps tokens uncommitted | `.gitignore:3` is a bare `data/` pattern; ignored files can still be `git add -f`'d, and a previously tracked path stays tracked | Verification must **check** the property (criterion already folded), not assume it |

Nothing in the design was invalidated by this pass. Corrections 1, 2 and 6 change the work; 3 and 4 confirm decisions already folded; 5 is scoped out explicitly.

---

## Verification table (Phase 5)

Every reference above read at the cited line. Zero stale.

| Reference | Claim | Verified |
|---|---|---|
| `canon-registry.js:88` | `CanonEntry` typedef opens here | ✅ `* @typedef {object} CanonEntry` |
| `canon-registry.js:92` | `enforcedBy` is the point list; no eligibility field | ✅ `@property {Array<'ship'\|'hook'\|'pre-commit'>} enforcedBy` |
| `canon-guard.js:103` | `decideCanonGuard` signature, injected deps | ✅ `export function decideCanonGuard({ toolName, toolInput, cwd, projectRoot, featuresDir … })` |
| `canon-guard.js:121` | classifier resolves via `matchEntry(…, {point:'hook'})`, unregistered falls through to allow | ✅ `const entry = matchEntry(relPosix, { featuresDir, point: 'hook' })` (allow branch immediately follows) |
| `test/canon-registry-contract.test.js:61` | hook set asserted as exactly `['judgment']` | ✅ `assert.deepEqual(guardedPatternIdsFor('hook'), ['judgment'])` |
| `pre-push.template:77` | push gate covers judgment canon only | ✅ `# ── Judgment drift-detection gate (COMP-CANON-GUARD S5) ──` |
| `COMP-CANON-GUARD/design.md:174` | hook is Claude-runtime only | ✅ `- **The write-time hook is Claude-only.**` |
| `.gitignore:3` | bare `data/` pattern | ✅ `data/` |

## Slices

Ordered so each lands independently green. **S1 and S2 are the substance; S3 is wiring; S4 is the honesty pass.**

### S1 — `lib/append-integrity.js` + registry governance class

The shared primitive first, because ATTEST needs it too and it has no dependencies.

- `lib/append-integrity.js` (new). `baselineFor(bytes) → {length, prefix_hash}`; `verifyAppend(bytes, baseline) → {ok, kind}` where `kind ∈ {clean, shrunk, prefix_changed}`. Pure, no I/O. `prefix_hash` is sha256 over `bytes[0, baseline.length)`.
- `lib/canon-registry.js` — add `overrideEligible?: boolean` to the typedef (default `true` when absent) and three governance entries, all `enforcedBy: ['hook']`, `overrideEligible: false`:
  - `override-ledger` → `.compose/canon-overrides.jsonl`
  - `override-attest` → `.compose/canon-overrides-attest.json`
  - `override-grants` → `.compose/data/canon-grants/**`
- New export `isOverrideEligible(path, opts)` — `matchEntry(…) !== null && entry.overrideEligible !== false`.
- `test/canon-registry-contract.test.js:61` — update the hook-set assertion (correction 1) and add a governance-not-eligible case.

**Gate:** the length-preserving early-row edit from the ATTEST probe is caught by `verifyAppend`; a legitimate append is not. Contract test green with the new partition.

### S2 — `lib/canon-override.js`, the grant lifecycle

- `mintGrant(cwd, {path, reason, operation})`:
  1. reject empty/whitespace `reason`; reject a path that is not `isOverrideEligible`
  2. append the bypass row **and** update `.compose/canon-overrides-attest.json` — ledger-and-baseline-first
  3. write `.compose/data/canon-grants/<id>.json` with exclusive create (`wx`), carrying immutable `issued_at` / `expires_at` and tool-stamped `actor` (never caller-supplied)
- `claimGrant(cwd, path)` — find a live token for the exact path, claim it by `renameSync` into `consumed/`. `ENOENT` on the rename means another process won: deny. Expiry read from `expires_at` inside the file, **never** mtime.
- Bypass row schema: `{ts, actor, path, reason, operation, token_id}`.

**Gate:** two concurrent claimants of one token — exactly one allowed, one denied, asserted with real processes rather than a mocked lock.

### S3 — wiring

- `lib/canon-guard.js` — `decideCanonGuard` gains a pure `requiresGrant` classification; denial message names the real override path instead of "edit the registry".
- `.claude/hooks/canon-guard.mjs` — attempt the claim, select the final decision. Fail open on any error (existing policy, now explicitly tested).
- `server/compose-mcp.js` — declare + dispatch `canon_override_grant`.
- `lib/build.js` — ship staging includes the bypass ledger and its baseline.
- `bin/git-hooks/pre-push.template` + `bin/compose.js` — `guard verify` checks the override ledger against its baseline; pre-push calls it. Today that gate covers judgment canon only (`pre-push.template:77`).

**Gate:** end-to-end — denied write → grant → allowed write → second write denied (single-use) → ledger row present → `guard verify` green.

### S4 — the honesty pass

Sweep every user-facing string (tool description, denial text, `guard` help, verify report) for enforcement language or unqualified guarantees. This is an acceptance criterion, not a nicety.

---

## Open items carried into implementation

1. **TTL value** (design OQ1) — proposed **5 minutes**: long enough for a grant-then-write round trip through an agent turn, short enough that a forgotten grant is not a standing hole. Settle at S2.
2. **Consumption row** (design OQ2) — proposed **no second row in v1**. The mint row plus the consumed-token file already distinguishes granted-and-used from granted-and-abandoned, at no extra write.
3. **CLI surface** (design OQ3) — proposed **not in v1**. Decision 4 specifies the MCP tool; a human in an editor is outside the hook's scope anyway (correction 4), so a CLI grant would be theatre.
