# COMP-ROADMAP-XREF-PUSH-2 — Implementation Blueprint

**Status:** IN_PROGRESS · derived from `design.md` (Codex/fallback-clean). Extends the shipped `lib/xref-push.js`.

## Corrections table (spec assumption vs reality)
| Design assumption | Reality on disk | Resolution |
|---|---|---|
| sibling write path has containment | `setFeatureStatus(cwd,…)` (`feature-writer.js:293`) trusts cwd, no guard | Extract guard from `xref-sync.js:77-87` into `lib/xref-local.js` `resolveSiblingRoot`; use in Push (and refactor Pull to share) |
| github labels are strings | `getIssueResult` body labels are objects; `github-provider.js:494` maps `l.name ?? l` | Normalize to names before present-check/union; compare case-sensitively |
| `updateIssueResult` exists for PATCH | added in -PUSH (`github-api.js:53`) | Reuse; PATCH `{state?, labels?}` combined |
| eligibility gates on `isGithubState(expect)` | `xref-push.js:148` skips `malformed expect` whenever expect≠open/closed | Reorder: malformed-skip only when `expect != null`; labels-only path stays eligible |
| writer preserves new fields | entry rebuild is a fixed allowlist (`feature-writer.js:919-926`) | Add `entry.expect_labels` + `validateExternalArgs` github-only |

## File Plan
| File | Action | Change |
|---|---|---|
| `lib/xref-local.js` | new | `resolveSiblingRoot(cwd, repo)` → `{root}` \| `{skipped, reason}` — lexical direct-sibling + realpath escape guard extracted from xref-sync. |
| `lib/xref-push.js` | modify | Add pure `planLabels`; provider dispatch (github/local handlers); github resolve returns `{state, labels}` (normalized, PR-reject); combined PATCH `{state?,labels?}`; local handler resolves via `resolveSiblingRoot` + reads sibling status, writes via `setFeatureStatus` (no force/derived); eligibility table; result rows carry `state?`/`labels?`/`summary`. |
| `lib/xref-sync.js` | modify | Refactor local branch to call shared `resolveSiblingRoot` for the **repo-token containment only**. `resolveSiblingRoot` covers `!repo` + lexical/realpath sibling guard; xref-sync MUST keep its own `!link.to_code` ('incomplete local ref') check and its features-dir resolution + `to_code` feature.json read (`xref-sync.js:88-93`) AFTER the helper returns `{root}`. Behavior-preserving = same reason strings, same ordering. |
| `contracts/feature-json.schema.json` | modify | Add `expect_labels` (array of `minLength:1` strings) to the github `if/then` branch only. |
| `lib/feature-writer.js` | modify | `validateExternalArgs` github branch: accept `expect_labels` (array of non-empty strings); reject `expect_labels` on non-github; entry rebuild: `if (args.expect_labels != null) entry.expect_labels = args.expect_labels;` |
| `bin/compose.js` | modify | xref-push summary: render per-row `summary` (state and/or labels and/or local status); no flag change. |
| `server/compose-mcp-tools.js` | modify | Add `toolRoadmapXrefPush({ project, apply })` (mirror `toolRoadmapGraph:463`); returns `{pushed, skipped, unchanged, scanned}`. |
| `server/compose-mcp.js` | modify | THREE sites: (a) import `toolRoadmapXrefPush` (~`:62`), (b) add the tool-list **array** entry `{name,description,inputSchema}` (~`:388-409`, next to `roadmap_graph`), (c) add dispatch `case 'roadmap_xref_push'` (~`:736`). |
| `test/xref-push.test.js` | modify | Add `planLabels` pure; github labels golden (dry/apply/idempotent/combined) via stubbed transport; eligibility table cases. |
| `test/xref-push-local.test.js` | new | local-push golden via real temp sibling + `setFeatureStatus`: drift→apply sets sibling status; idempotent; disallowed-transition→skip; containment-escape→skip. |
| `test/feature-linker.test.js` | modify | `expect_labels` carrier round-trip + reject on non-github. |
| `test/feature-json-schema-external.test.js` | modify | `expect_labels` accept on github, reject on local, reject non-string item. |
| `test/xref-local.test.js` | new | `resolveSiblingRoot` unit: valid sibling, slash/`.`/`..` token, escape via symlink, missing. |

## Key shapes

### `lib/xref-local.js`
```
export function resolveSiblingRoot(cwd, repo) {
  if (!repo) return { skipped: true, reason: 'incomplete local ref' };
  const parentDir = resolve(cwd, '..');
  const citedRoot = resolve(parentDir, String(repo));
  if (/[\\/]/.test(repo) || repo === '.' || repo === '..' || dirname(citedRoot) !== parentDir)
    return { skipped: true, reason: `local repo token "${repo}" is not a valid sibling` };
  try { if (dirname(realpathSync(citedRoot)) !== realpathSync(parentDir))
    return { skipped: true, reason: `local repo "${repo}" escapes the workspace parent` }; }
  catch { return { skipped: true, reason: `local target ${repo} not found` }; }
  return { root: citedRoot };
}
```

### `lib/xref-push.js` (additions)
```
export function planLabels(currentNames, expectLabels) {           // pure, additive, case-sensitive
  if (!Array.isArray(expectLabels) || expectLabels.length === 0) return { action: 'none' };
  const have = new Set(currentNames);
  const missing = [...new Set(expectLabels)].filter((l) => !have.has(l));
  if (missing.length === 0) return { action: 'none' };
  return { action: 'add', add: missing, to: [...new Set([...currentNames, ...expectLabels])] };
}
// github handler: resolve → {state, labels:body.labels.map(l=>l.name??l)} | PR-reject | degrade
//   The orchestrator builds a write-plan from the two planners:
//     stateTo  = planPush(...).action==='write' ? planPush(...).to : undefined
//     labelsTo = planLabels(...).action==='add'  ? planLabels(...).to : undefined   // .to = FULL UNION
//   write(stateTo, labelsTo) → updateIssueResult(issue, { ...(stateTo && {state: stateTo}),
//                                                          ...(labelsTo && {labels: labelsTo}) })
//   CRITICAL: labels: MUST be the full union (planLabels().to = currentNames ∪ expect_labels),
//   NEVER the missing-subset or expect_labels alone — a github PATCH replaces the whole label
//   set, so sending less would DELETE human-added labels (breaks additive-never-remove).
// local handler: resolve → resolveSiblingRoot + read sibling feature.json status (state aspect only)
//   write → setStatus(root, {code: to_code, status: expect})   (opts.setStatus default = setFeatureStatus)
// orchestrator: per link → handler.eligible? resolve → planPush(state) + planLabels(labels)
//   → if both none: unchanged++; elif !apply: pushed(dry); else handler.write → pushed|skipped
```
- `opts.setStatus` injectable (default real `setFeatureStatus`); `githubTransport`/`githubAuth` as in -PUSH.
- Result row: `{ code, provider, target, state?:{from,to}, labels?:{added:[]}, summary }`. **Back-compat:** keep flat `from`/`to` on the row when only the state aspect changed, so existing -PUSH row assertions don't break; the new `state`/`labels`/`summary` are additive. The **top-level** summary contract (`{pushed, skipped, unchanged, scanned}` arrays/counts) stays byte-stable — `toolRoadmapXrefPush` returns it verbatim (small payload). Existing -PUSH tests that assert `from`/`to` continue to pass; new rows add the structured aspects.

### MCP (`compose-mcp-tools.js`)
```
export async function toolRoadmapXrefPush({ project, apply } = {}) {
  const { pushExternalRefs } = await import('../lib/xref-push.js');
  return pushExternalRefs(project || getTargetRoot(), { apply: apply === true });
}
```
Schema entry mirrors `roadmap_graph`: `{ project?, apply?: boolean }`; description notes dry-run default + push:true opt-in. Dispatch: `case 'roadmap_xref_push': result = await toolRoadmapXrefPush(args); break;`

## Boundary Map

### S01: shared local resolver + pure planners
Produces:
  lib/xref-local.js → resolveSiblingRoot (function)
  lib/xref-push.js → planLabels (function)

Consumes: nothing (leaf node)

### S02: orchestrator + surfaces
Produces:
  lib/xref-push.js → pushExternalRefs (function)
  server/compose-mcp-tools.js → toolRoadmapXrefPush (function)

Consumes:
  from S01: lib/xref-local.js → resolveSiblingRoot
  from S01: lib/xref-push.js → planLabels

## Test plan
- **Pure**: `planLabels` (all-present→none, some-missing→add union deduped, empty→none, case-sensitive); `resolveSiblingRoot` (valid/slash/dot/escape/missing).
- **github labels**: dry-run reports add + 0 PATCH; `--apply` → 1 PATCH `labels:union`; idempotent (all present) → 0 PATCH; combined state+labels → 1 PATCH carrying both; labels-only link (no expect) reconciles (not mis-skipped).
- **local push**: real temp sibling; drift→apply flips sibling status (+ sibling ROADMAP regen); idempotent (already==expect) → noop; disallowed transition → skip with reason; containment-escape token → skip.
- **MCP**: `toolRoadmapXrefPush` dry-run returns summary; `apply:true` threads; default dry-run.
- **carrier/schema**: `expect_labels` round-trips on github, rejected on local, non-string item rejected.
- **regressions** from -PUSH hold (no opt-in→not scanned; PR-skip; non-2xx skip; cross-feature pull-skip).

## Verification Table (Phase 5)
| Reference | Claim | Verified |
|---|---|---|
| `feature-writer.js:293` | `setFeatureStatus(cwd, args)` — sibling-delegation target | ✅ |
| `xref-sync.js:77-87` | local containment guard to extract | ✅ |
| `github-provider.js:494` | labels are objects → `l.name ?? l` | ✅ |
| `github-api.js:53/59` | `updateIssueResult` PATCH primitive (from -PUSH) | ✅ |
| `xref-push.js:148` | `isGithubState(link.expect)` eligibility gate to reorder | ✅ |
| `feature-writer.js:919-926` | external entry rebuild allowlist | ✅ |
| `compose-mcp-tools.js:463` + `getTargetRoot` | MCP handler pattern to mirror; cwd resolver exists | ✅ |
| Boundary Map | validateBoundaryMap → ok, 0 violations, 0 warnings | ✅ |

All references exact. Boundary Map clean.
