# COMP-ROADMAP-XREF-PUSH — Implementation Blueprint

**Status:** IN_PROGRESS · derived from `design.md` (decisions locked, Codex-clean). Mirrors `lib/xref-sync.js` (the shipped Pull).

## Corrections table (spec assumption vs reality)
| Design assumption | Reality on disk | Resolution |
|---|---|---|
| `updateIssue` can report write success/failure | `github-api.js:52` returns only `.body`, drops HTTP status | Add `updateIssueResult(n, patch)` (status-returning, mirrors `getIssueResult` at `github-api.js:51`) |
| `feature.json` external writer preserves arbitrary fields | `feature-writer.js:916` rebuilds the entry from a fixed list (`repo/issue/to_code/url/expect/note`), drops `push` | Add `push` to `validateExternalArgs` (~`feature-writer.js:840`) + entry reconstruction (`feature-writer.js:921`) |
| `push` is a recognized carrier field | schema `contracts/feature-json.schema.json:80` external branch defines only `provider/repo/issue/url/expect`; `feature-write-guard.js:68` delegates to it, so `"push":"true"` slips through | Add `"push": {"type":"boolean"}` to the schema + contract test |
| External-link writer coverage lives in `test/feature-writer-xref.test.js` | that file does not exist; real external-link writer coverage is `test/feature-linker.test.js:326` | Carrier-preservation test goes in `test/feature-linker.test.js` |
| Pull is agnostic to push-opted links | `xref-sync.js:133` scans every resolvable link with an `expect` | Add `|| link.push === true` to the skip guard at `xref-sync.js:133` |
| Resolver returns a bare state | `xref-sync.js:64` reads `r.body.state`, ignores `r.body.pull_request` | Push resolver must reject `body.pull_request` (decision 5) |

## File Plan
| File | Action | Change |
|---|---|---|
| `lib/xref-push.js` | new | Pure `planPush` + orchestrator `pushExternalRefs` + internal `defaultResolve`/`defaultWrite`/`isGithubState`. Mirrors `lib/xref-sync.js`. |
| `lib/tracker/github-api.js` | modify | Add `updateIssueResult(number, patch)` method after `updateIssue` (`:52`). |
| `lib/feature-writer.js` | modify | `validateExternalArgs` github branch (~`:840`): accept `push` (must be boolean) ; entry reconstruction (`:921`): `if (args.push != null) entry.push = args.push;` |
| `contracts/feature-json.schema.json` | modify | Add `"push": { "type": "boolean" }` to `links.items.properties` (`:80`, alongside `expect`) so a malformed `"push":"true"` is rejected by schema validation (`feature-write-guard.js:68` delegates here). |
| `lib/xref-sync.js` | modify | `:133` skip guard: also `continue` when `link.push === true` (push-managed ≠ pull-managed). |
| `bin/compose.js` | modify | New `subcmd === 'xref-push'` block after the `xref-sync` block (`:1138`–`:1156`); help line after `:122`. |
| `test/xref-push.test.js` | new | Pure `planPush` table + golden flow (dry-run/apply/idempotent) + safety (no-opt-in/no-token/404/PR/non-2xx) with injected `resolve`+`write`. |
| `test/xref-sync.test.js` | modify | Add cross-feature regression: a `push:true` link is left untouched by `syncExternalRefs`. |
| `test/feature-linker.test.js` | modify | Add carrier-preservation: `push:true` survives a typed external-link round-trip (existing external-link writer coverage lives here, `:326`). |
| `test/feature-json-schema-external.test.js` | modify | Add schema contract test: `push:true` valid, `push:"true"` rejected. |

## Detailed shape

### `lib/xref-push.js`
```
const GITHUB_STATES = new Set(['open', 'closed']);
export function isGithubState(s) { return GITHUB_STATES.has(s); }

// Pure mirror of reconcileExpect (xref-sync.js:30): make external match expect.
export function planPush(ref, liveState) {
  if (!ref.expect) return { action: 'none' };
  if (liveState == null) return { action: 'none' };   // unresolved → leave
  if (ref.expect === liveState) return { action: 'none' };  // idempotent
  return { action: 'write', from: liveState, to: ref.expect };
}

async function defaultResolve(link) { /* getIssueResult → {state} | {skipped,reason}
   ; 404→skip, non-2xx→skip, body.pull_request→skip 'target is a pull request',
   state∉{open,closed}→skip; auth via GITHUB_TOKEN/GH_TOKEN (mirror xref-sync.js:47-69) */ }
async function defaultWrite(link, toState) { /* updateIssueResult(issue,{state:toState})
   ; non-2xx → {skipped, reason:`write HTTP ${status}`}; else {ok:true} */ }

export async function pushExternalRefs(cwd, opts = {}) {
  // mirror syncExternalRefs (xref-sync.js:109): scan feature dirs/feature.json links
  // eligibility: link.kind==='external' && link.provider==='github'
  //              && link.push===true && isGithubState(link.expect)
  // resolve → degrade-skip; planPush; if write & apply → defaultWrite (degrade-skip)
  // returns { pushed, skipped, unchanged, scanned }   ; never writes feature.json
}
```
- `apply` defaults false (dry-run). `resolve`/`write` injectable (golden flow never hits GitHub).
- Result rows: `pushed: [{code, target, from, to}]`, `skipped: [{code, target, reason}]`.

### `github-api.js` (after `:52`)
```
async updateIssueResult(number, patch) { return this._req('PATCH', `/repos/${this.repo}/issues/${number}`, patch); }
```

### CLI (`bin/compose.js`, after the `xref-sync` block)
```
if (subcmd === 'xref-push') {
  const { pushExternalRefs } = await import('../lib/xref-push.js')
  const { root: cwd } = resolveCwdWithWorkspace(args)
  const apply = args.includes('--apply')
  const res = await pushExternalRefs(cwd, { apply })
  // summarise pushed / unchanged / skipped with per-ref reasons; dry-run says "would push"
  process.exit(0)
}
```
Help line after `:122`: `  roadmap xref-push  Push-write GitHub trackers to match feature.json expect= (dry-run; --apply to write)`

## Boundary Map

> CLI dispatch, writer-field preservation, and the Pull skip-guard are prose edits to existing files — invariants, not Boundary Map symbols.

### S01: push primitives
Produces:
  lib/xref-push.js → planPush, isGithubState (function)
  lib/tracker/github-api.js → updateIssueResult (function)

Consumes: nothing (leaf node)

### S02: orchestrator
Produces:
  lib/xref-push.js → pushExternalRefs (function)

Consumes:
  from S01: lib/xref-push.js → planPush, isGithubState
  from S01: lib/tracker/github-api.js → updateIssueResult

## Test plan
- **Pure** `planPush`: idempotent / drift / no-expect / unresolved / (malformed handled by eligibility).
- **Golden** (`pushExternalRefs`, injected resolve+write): dry-run records intent + 0 writes; `--apply` → 1 write `{state:'closed'}`; second apply idempotent (resolver returns closed) → 0 writes.
- **Safety**: no `push:true` → not scanned; no-token/404/rate-limit → skip; `body.pull_request` → skip; write non-2xx → skip (not pushed).
- **Cross-feature**: `syncExternalRefs` leaves a `push:true` link's `expect` unchanged.
- **Carrier**: `feature-writer` round-trips `push:true` (in `feature-linker.test.js`); schema accepts `push:true`, rejects `push:"true"` (in `feature-json-schema-external.test.js`).

## Verification Table (Phase 5)
| Reference | Claim | Verified |
|---|---|---|
| `xref-sync.js:133` | `if (!RESOLVABLE.has(link.provider) \|\| !link.expect) continue;` — skip-guard insertion point | ✅ exact |
| `github-api.js:51` | `getIssueResult` = status-returning GET sibling to mirror | ✅ exact |
| `github-api.js:52` | `updateIssue` returns `.body` only (no status) | ✅ exact |
| `feature-writer.js:916` | `const entry = { kind: 'external', provider: args.provider };` | ✅ exact |
| `feature-writer.js:921-922` | `entry.expect`/`entry.note` field-list reconstruction (where `push` must be added) | ✅ exact |
| `feature-writer.js:841` | `validateExternalArgs` github `expect` validation (where `push` boolean check goes) | ✅ exact |
| `bin/compose.js:122` | `roadmap xref-sync` help line (sibling help insertion) | ✅ exact |
| `bin/compose.js:1138` | `if (subcmd === 'xref-sync')` dispatch (sibling block insertion) | ✅ exact |
| Boundary Map | `validateBoundaryMap` → ok, 0 violations, 0 warnings | ✅ passed |

All references exact. Zero stale entries. Boundary Map clean.
