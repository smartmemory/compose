# COMP-LIFECYCLE-BACKFILL — Compose-side code map (verified 2026-09-05)

Read-only exploration. Every line reference below was opened and read on
2026-09-05 against the working tree at `/Users/ruze/reg/my/forge/compose`.
Where the design doc's citation no longer matches, the drift is called out in
the last section.

---

## 1. `server/lifecycle-guard.js` (383 lines)

### Data the guard graph is built from

| Symbol | Line | Note |
|---|---|---|
| `BASE_TRANSITIONS` | `:39-50` | Legacy build graph, kept as an export for parity tests. Not what `buildPhaseGraph` reads. |
| `SKIPPABLE` | `:53` | `prd, architecture, report` |
| `TERMINAL` | `:56` | `complete, killed` — imported by `vision-routes.js:53` for the terminal checks on advance/skip/kill |
| `buildPhaseGraph(mode)` | `:65-89` | Reads `transitionsOf(mode)`, `completablePhaseOf(mode)`, `terminalOf(mode)` from `lib/lifecycle-modes.js` |
| `edgePredicates(featureRelDir, mode)` | `:100-113` | |
| `resourceId(featureCode, workspaceRoot, mode)` | `:121-130` | |
| `phaseToStatus(phase)` | `:143-147` | `complete→COMPLETE`, `killed→KILLED`, everything else `IN_PROGRESS` |
| `projectFeatureStatus(...)` | `:163-176` | Best-effort; never throws; writes `derived:true` |
| `verifyCompletionEvidence(...)` | `:199-224` | |
| `_client` guard-client seam | `:230-232` | `{ register, transition }` only — **no `history` on this seam** |
| `_registered` cache | `:236-238` | `Set<resourceId>`; `_testOnly_resetGuardCache()` clears it |
| `_featureRelDir(...)` | `:254-267` | mode-aware; build resolves `paths.features` from the served root's `.compose/compose.json` |
| `guardTestCommand(workspaceRoot)` | `:280-288` | reads `guard.testCommand` (array form) |
| `ensureGuard(...)` | `:299-323` | |
| `guardedTransition(...)` | `:333-382` | |

### `buildPhaseGraph` — exact assembly (`:65-89`)

1. Copy every `from -> [to]` from the mode's `transitions`, collecting all node
   names seen on either side (`:71-75`).
2. Append `complete` to the completable phase's out-edges (`:79`). For build
   that is `ship -> complete`.
3. Append `killed` to every non-terminal node's out-edges (`:82-86`).
4. Set every terminal node to `[]` (`:87`).

There is no `complete_backfilled` node and no backfill edge anywhere in the
module. Adding one is a change to steps 2–4 plus the terminal list produced by
`terminalOf(mode)` in `lib/lifecycle-modes.js`.

### The graph actually sent to the guard

Confirmed by reading a live registration
(`~/.stratum/guards/12295a91.../registry.json`,
`compose:85154ecf6cdb:COMP-PLAN-IDEA-UNIFY`). The persisted policy is exactly:

```
graph:
  explore_design: [prd, architecture, blueprint, killed]
  prd:            [architecture, blueprint, killed]
  architecture:   [blueprint, killed]
  blueprint:      [verification, killed]
  verification:   [plan, blueprint, killed]
  plan:           [execute, killed]
  execute:        [report, docs, killed]
  report:         [docs, killed]
  docs:           [ship, killed]
  ship:           [complete, killed]
  complete:       []
  killed:         []
terminal: [complete, killed]
edge_predicates:
  explore_design->blueprint: [{id: design_md,    type: deterministic,
                               statement: "server_file_exists('docs/features/COMP-PLAN-IDEA-UNIFY/design.md')"}]
  blueprint->verification:   [{id: blueprint_md, ... 'blueprint.md' ...}]
  plan->execute:             [{id: plan_md,      ... 'plan.md' ...}]
stakes: {}
initial: "ship"            # seeded from the item's CURRENT phase at first registration
graph_version: 1
workspace_root: /Users/ruze/reg/my/forge/compose
```

Note `initial: "ship"` — that resource was registered late, by the completion
gate, at the completable phase (see §5, "late registration"), not at genesis.

### `ensureGuard` and the `_registered` cache (`:299-323`)

- Cache hit returns `{guard_id, status:'cached'}` with **no** subprocess (`:301`).
- Register kwargs: `resourceId, graph, edgePredicates, initial, terminal,
  stakes:{}, workspaceRoot` (`:305-313`).
- A thrown CLI failure is normalised to
  `{error:{code:'GUARD_UNREACHABLE'}}` — never rethrown (`:314-318`).
- Only `status === 'registered' | 'exists'` populates the cache (`:319-321`).

The design's lazy-migration hook ("driven off the same `_registered` cache
path") lands at `:301` — before the cache short-circuit returns.

### `guardedTransition` (`:333-382`)

- Calls `ensureGuard` first and fails closed on a registration error (`:334-337`).
- Artifacts = `{commit_sha?}` merged with a caller-supplied `artifacts` object
  (`:345-348`). The completion gate uses this to pass `operation_id` and
  `resolver_tags`.
- **Deliberately sends no `idempotency_key`** (`:349-353`) — the comment
  explains that a refuse→fix→retry carries an identical payload and an
  idempotency key would replay the refusal. Design decision #4 (whole-call
  idempotency joined on `guardRef`) has to work around this, or change it.
- `status: 'applied'` → `{applied:true, verdict, ledgerRef, currentState}` (`:371-373`).
- `status: 'replayed'` → `applied:true`; `refused` → `applied:false, refused:true` (`:375-381`).

### `verifyCompletionEvidence` (`:199-224`)

- `commit_sha` required and verified with `git rev-parse --verify --quiet
  <sha>^{commit}` in `cwd` (`:183-187`, `:202-206`).
- Tests: a configured `testCommand` array is run with `spawnSync` and must exit
  0 (`:209-218`); otherwise `testsPassClaim === true` is required (`:219-221`).
  No silent default.
- Returns `{ok, reasons[], testsAttested}`. **Backfill must reuse this
  unchanged** (design Decision 1).

### `completablePhaseOf`

Not defined here — imported from `lib/lifecycle-modes.js` (`:29`) and
re-exported implicitly through use. Build → `ship`.

---

## 2. `lib/lifecycle-modes.js` (256 lines)

Registry object `LIFECYCLE_MODES` at `:34`. Four modes.

| Mode | `transitions` | `phaseOrder` | `terminal` | `completablePhase` | `edgeEvidence` |
|---|---|---|---|---|---|
| `build` | `:41-52` | `:63` | `:54` | `:56` (`ship`) | `:58-62` |
| `fix` | `:84-93` | `:100` | `:95` | `:97` (`ship`) | `:99` (empty) |
| `plan` | `:118-122` | `:129` | `:124` | `:126` (`ship`) | `:128` |
| `judgment` | `:159-164` | `:171` | `:166` | `:168` (`resolved`) | `:170` (empty) |

`build.phaseOrder` (`:63`):
`explore_design, prd, architecture, blueprint, verification, plan, execute, report, docs, ship`

### The backward loops that make `phaseOrder` non-temporal (round-2 finding #3)

- **build**: `verification: ['plan', 'blueprint']` (`:46`) — `verification` can
  return to `blueprint`, which sits EARLIER in `phaseOrder`. So a single
  lifecycle can contain `blueprint, verification, blueprint, verification, …`.
- **fix**: `test: ['verify', 'fix']` (`:89`) — `test` returns to `fix`, earlier
  in `phaseOrder` (`:100`).

Both loops are live in the registered guard graph (see the persisted `graph`
above: `verification: [plan, blueprint, killed]`). **Design Decision 5's
"insert by `phaseOrder` position" is therefore not well-defined** — a phase can
legitimately occur more than once, and rank does not identify the occurrence.
Any insertion algorithm needs occurrence identity (valid time + a sequence
number), which is exactly what adjudication #3 says.

Accessors: `resolveMode` `:189`, `getMode` `:197`, `completablePhaseOf` `:205`,
`transitionsOf` `:209`, `skippableOf` `:213`, `terminalOf` `:217`,
`phaseOrderOf` `:221`, `edgeEvidenceOf` `:226`, `allKnownPhases` `:237`,
`artifactsOf` `:253`.

`resolveMode` (`:189-194`) falls back to `build` for anything unknown — adding
a mode is data-only; adding a *phase* to build is not, because
`test/lifecycle-modes.test.js` pins the build entry against the legacy exports.

---

## 3. `server/lifecycle-phase-history.js` (44 lines)

`appendPhaseHistory(item, {from, to, outcome, timestamp})` — `:23-44`. Sole
writer, per its own docstring (`:5`).

Behaviour:
1. Lazily creates the array (`:24-26`).
2. Takes `history[history.length - 1]` — the **last inserted** entry, not the
   latest by valid time — and if its `exitedAt` is null, sets it to the
   incoming `timestamp` (`:28-31`). This is the arrival-order closure the design
   flags: inserting a historical entry through this path can produce
   `exitedAt < enteredAt`.
3. Pushes a **dual-shape** entry (`:32-43`):
   - legacy: `phase`, `step`, `enteredAt`, `exitedAt: null`
   - new: `from`, `to`, `outcome`, `timestamp`
   `enteredAt === timestamp` always.

There is no `recordedAt`, `origin`, `confidence`, or `evidence` field today.

### Every reader of `lifecycle.phaseHistory`

| Reader | Line | What it reads |
|---|---|---|
| `server/decision-events-snapshot.js` | `:48-57` | `from, to, outcome, agent_id, timestamp` → phase_transition DecisionEvents |
| `server/drift-axes.js` `findPlanAnchor` | `:124-131` | last entry with `to === 'plan'`, uses `.timestamp` as the drift baseline |
| `server/session-routes.js` | `:248` | projects `{phase, enteredAt, exitedAt}` into the session payload |
| `lib/checkpoint/reconciler.js` | `:93-110` | only checks emptiness; emits a `phaseHistory.append` mutation descriptor |
| `server/session-routes.js` | `:156-159` | **applies** those descriptors by calling `appendPhaseHistory` — the second production caller |
| UI: `ItemDetailPanel.jsx`, `ContextPipelineDots.jsx` | (named in the module docstring `:8`) | legacy `phase/enteredAt/exitedAt` shape |

A backfilled entry that must be visibly marked has to reach at least the
snapshot reader and the two UI components.

---

## 4. `server/vision-routes.js` (1212 lines)

Auth wrapper `guardAuth` at `:98-99` — mutations require `x-compose-token` only
when `capabilities.guardAuth` is on. Every lifecycle POST is wrapped in it.
`guardEnabled()` is a closure over `capabilities.guard` at `:87`.
`modeOf(item)` = `item.lifecycle.mode ?? 'build'` (`:275`).

| Route | Line | Guard call | History call |
|---|---|---|---|
| `POST …/lifecycle/start` | `:303` | `ensureGuard` best-effort, swallows errors (`:336-338`) | `:330` (`from:null → genesis`) |
| `POST …/lifecycle/advance` | `:394` | `guardedTransition` fail-closed 422 (`:405-408`) | `:413` |
| `POST …/lifecycle/skip` | `:435` | `guardedTransition` (`:447-450`) | `:455` (`outcome:'skipped'`) |
| `POST …/lifecycle/kill` | `:476` | `guardedTransition` to `killed` (`:488-491`) | `:498` |
| `POST …/lifecycle/complete` | `:521` | two branches, below | `:580` / `:613` |

There is **no** transition route beyond advance/skip/kill/complete, and no
backfill route.

### `/lifecycle/complete` (`:521-633`)

- Item lookup: `store.items.get(req.params.id)` (`:523`), 404 on missing
  lifecycle (`:524`).
- **The completable check is at `:527-530`**: `completablePhaseOf(modeOf(item))`
  and a 400 unless `currentPhase === completable`. This is the check the design
  cites — a backfill route must not reuse it as written, since backfill is
  reachable from any non-terminal phase.
- Branch A, MANAGED build item (`isManagedBuildItem(item, projectRoot)`, `:540`):
  delegates the whole completion to `completionGate` (`:550-568`) with an
  in-process `visionProjector` that calls `applyVerifiedProjection` against the
  live store (`:564-567`). On refusal → 422 with `refusedAt` (`:569-576`).
  Only after the gate returns ok does it mutate `currentPhase`/`completedAt`,
  append history and persist (`:577-581`).
- Branch B, unmanaged / fix / plan (`:594-616`): the pre-gate path —
  `verifyCompletionEvidence` then `guardedTransition` directly, then the same
  mutate/append/persist.
- Persistence failure is surfaced by reading `store.lastSaveOk === false` after
  the write (`:583-587`) and reported as a `partial` failure, not an error.

### Vision-state persistence — atomicity and locking

`server/vision-store.js`:
- `_save()` at `:131-143`: `mkdirSync` → write to
  `vision-state.json.tmp.<Date.now()>` → `renameSync`. **Atomic per write,
  returns a boolean rather than throwing** (`:138`, `:141`).
- `updateLifecycle(id, lifecycle)` at `:235-253`; sets
  `this.lastSaveOk = this._save()` at `:251`. `updateItem` does the same at `:229`.
- `updateLifecycleExt` at `:255-266` calls `_save()` and **discards the result**
  (`:264`) — a silent-failure path.
- **There is no lock and no read-modify-write protection.** Every save
  serialises the entire in-memory store (`getState()`, `:146-152`), so the
  single-process server is the only thing making concurrent writers safe. A
  backfill running out-of-process (CLI/MCP) against the same file is
  last-writer-wins. Compare `lib/completion-gate.js:283-284`, which does take a
  dir lock for the completion path.

---

## 5. `lib/completion-gate.js` (537 lines) — the single door

Header `:1-58` states the invariants; `:22-27` records that `setFeatureStatus`
refuses COMPLETE unconditionally, so the gate writes through
`persistFeatureRaw`, and the allowlist test
(`test/completion-write-allowlist.test.js`) is what keeps other modules out.

| Concern | Line |
|---|---|
| `guardEnabled(workspaceRoot)` — reads served root's `capabilities.guard` | `:89-98` |
| intent file path `.compose/data/completion-intents/<CODE>.json` | `:104-108` |
| `readIntent` / `writeIntent` / `clearIntent` | `:110-134` |
| `currentGuardState(rid)` — lazily imports `guardHistory` | `:155-185` |
| not-found detection (`error_type` is the REAL client's field) | `:173-181` |
| `completionGate({...})` entry | `:220-235` |
| 1. evidence, before the lock, guard-scoped | `:246-274` |
| `intent === 'evidence-only'` early return (never drives the guard terminal) | `:278-280` |
| dir lock `.compose/data/locks/completion-<CODE>` | `:283-284` |
| 2. preflight: provider, feature exists, terminal-status refusal | `:290-304` |
| 3. guard state + recovery decision | `:306-351` |
| unreachable guard refuses, never degrades | `:311-314` |
| guard complete + no intent → refuse (`refusedAt:'recovery'`) | `:322-332` |
| guard complete + different commit → refuse | `:337-347` |
| stale intent with no applied transition → cleared | `:348-351` |
| 4. write-ahead intent | `:353-362` |
| 5. `ensureGuard` at the **completable** phase then ONE `→ complete` edge | `:366-410` |
| `resolvedBy:'agent'` fixed; tags ride in `artifacts.resolver_tags` | `:382-396` |
| 6.1 `recordCompletion(… set_status:false)` | `:419-439` |
| 6.2 status → COMPLETE via `roundtripGuard` + `persistFeatureRaw` | `:441-465` |
| 6.3 ROADMAP regen (`provider.renderRoadmap()`), collected on failure | `:467-472` |
| 6.4 vision projection, collected on failure | `:474-483` |
| 6.5 `safeAppendEvent` audit event (`via:'completion_gate'`, `operation_id`, `ledger_ref`) | `:485-499` |
| `clearIntent` + result shape (`partial`, `failures`, `result`) | `:501-517` |
| `defaultVisionProjector` (VisionWriter.completeItem) | `:528-536` |

**Writes the gate owns:** the completion record (`completions[]` in the
feature's canon via `recordCompletion`), `feature.json.status = COMPLETE`
(raw), the ROADMAP re-render, the cockpit item projection, and the audit event.
A backfill terminal state must go through this same sequence or a sibling with
identical properties — in particular the write-ahead intent, the dir lock, and
the "steps 1–2 abort, steps 3–5 collect" split.

**Load-bearing detail for backfill:** the gate hardcodes `to: 'complete'`
(`:389`) and `from: completablePhaseOf(mode)` (`:367`, `:388`). A
`complete_backfilled` terminal would need both parameterised, and
`phaseToStatus` (`lifecycle-guard.js:143`) would need the new state mapped to
`COMPLETE`, otherwise it projects `IN_PROGRESS`.

---

## 6. `server/compose-mcp-tools.js` — the MCP surface

| Symbol | Line |
|---|---|
| `assertCompletionEvidence(args, capsOverride, cwd)` | `:39-61` |
| `LIFECYCLE_OWNED_STATUS = {COMPLETE, KILLED}` | `:64` |
| `_guardOn(capsOverride)` | `:66-69` |
| `_overrideOk(args)` — compares `args.override_token` to `process.env.STRATUM_GUARD_OVERRIDE_TOKEN` | `:71-75` |
| `assertForceAuthorized` | `:77-90` |
| `assertTerminalStatusAuthorized` | `:102-116` |
| `toolSetFeatureStatus` — calls both asserts | `:322-327` |
| `toolRecordCompletion` — routes to `completionGate`; `set_status:false` keeps the record-only path | `:523-…` |

Dispatch: `server/compose-mcp.js:168` (`set_feature_status`), `:180`
(`record_completion`).

**The env bypass.** `_overrideOk` at `:71-75` is the only escape from both
`force` and lifecycle-owned status. It reads `process.env` **in the compose
server process** and compares it to a caller-supplied argument. This is the
same shape as the stratum-side `_checkOverrideToken` defect the design records
on 2026-08-17: if the caller can set the environment of the process doing the
comparison, it can mint its own authorization. For the MCP server this is less
severe than for a spawned CLI (the compose server's env is set by whoever
launched the server, not by the MCP caller), but a backfill tool exposed over
MCP must not use `_overrideOk` as its authorization.

Backfill exposed as an MCP tool (design Files table) means: a new `tool*`
function here, a def in `server/mcp-tool-defs.js`, and a `case` in
`server/compose-mcp.js`'s dispatch.

---

## 7. Where phase-history fields get dropped

- `server/decision-events-snapshot.js:48-57` — the loop over `lc.phaseHistory`
  passes only `from, to, outcome, agent_id, timestamp` into
  `buildPhaseTransitionEvent`. `origin`/`recordedAt` are dropped here.
- `server/decision-event-emit.js:53-70` — `buildPhaseTransitionEvent` builds a
  fixed metadata object `{from_phase, to_phase}` (`:64-67`). It does not
  *reject* extra fields; it simply never carries them. Nothing else can be
  added without editing this builder.
- `contracts/comp-obs-contract.schema.json:267-268` — the `phase_transition`
  branch of the per-kind `allOf`: `required: [from_phase, to_phase]`,
  `properties: {from_phase, to_phase}`, `additionalProperties: false`. Closed.
  The version note at `:14` records that closing every per-kind metadata
  subschema was a deliberate Codex-review decision, and `:249` states the rule:
  extending a kind requires a schema version bump, not an ad-hoc field.

So carrying `origin`/`recordedAt` downstream is a three-file change with a
contract version bump. Under the `complete_backfilled` reshape the primary
signal is the state name, which travels in `to_phase` and needs no schema
change — that is what adjudication #5 means by "largely dissolved".

---

## 8. Repo-relative path containment to reuse

Two separate hardened patterns exist; the design cites the first.

**`lib/feature-writer.js` `validateRepoPath(cwd, path)` — `:610-641`:**
1. non-empty string (`:611-613`)
2. reject absolute and `~` (`:614-616`)
3. `normalize`, then reject any `..` segment **after** normalisation (`:617-620`)
4. `realpathSync(cwd)` FIRST, then `resolve(realCwd, normalized)` (`:621-622`)
5. prefix check against `realCwd + sep` (`:623-625`)
6. existence check (`:626-628`)
7. `realpathSync(resolved)` and re-check the prefix — this is the symlink-escape
   rejection (`:629-636`)
8. `statSync(...).isFile()` — directories and non-files refused (`:637-639`)

Note it does **not** do the macOS firmlink strip the design's landmine warns
about. That lives in `lib/canon-guard.js:46-95` (`stripFirmlink` +
`realpathCanonicalize`, which walks up to the longest existing ancestor,
`realpathSync.native`s it, and re-appends). An evidence resolver that must
accept a path under `/System/Volumes/Data` needs the canon-guard helper, not
just the feature-writer one.

`lib/judgment-verify.js:67-107` is a third variant using `lstatSync` to reject
symlinks without following them.

---

## 9. `server/stratum-client.js` (384 lines) — transport

Docstring `:4-6`: "the ONLY module in compose that spawns Stratum CLI processes."

| Symbol | Line |
|---|---|
| `flowGateBin()` | `:41-45` |
| `spawnStratumStdin(args, inputJson, timeoutMs, bin)` | `:194-213` |
| `runGuard(action, kwargs, timeoutMs)` | `:222-245` |
| `guardRegister` | `:332-342` |
| `guardTransition` | `:349-359` |
| `guardOverride` | `:367-376` |
| `guardHistory` | `:382-384` |

`runGuard` spawns `stratum guard <action>` via `execFile` and writes one JSON
kwargs object to the child's stdin (`:223`, `:206-211`). Timeouts: 10s for
mutations, 5s for `history` (`:24-25`, `:383`). Exit `-1` → `TIMEOUT`, `-2` →
`SPAWN`, non-zero → parse stdout as stratum's canonical error dict (`:225-239`).
A refusal is a normal exit-0 result (`:217-218`).

There is **no** `guardUpgrade`, `guardMigrate`, or `guardApplyUpgrade` wrapper
in this file.

### Correction to the design: compose DOES have an MCP client to stratum

The 2026-08-17 note says "it is MCP-only, and compose does not talk to stratum
over MCP." That is **no longer accurate as a statement about compose**:

- `lib/stratum-mcp-client.js` is a full MCP client (`Client` +
  `StdioClientTransport` from `@modelcontextprotocol/sdk`, `:18-19`), class
  `StratumMcpClient` at `:185`.
- It has a generic private `#callTool(toolName, args, opts)` at `:517` and a
  public `hasTool(name)` capability probe at `:490`. Adding
  `guardApplyUpgrade()` is a few lines, not a transport project.
- It is already used in production paths: `lib/build.js:17`, `lib/gsd.js:23`,
  `lib/new.js:9`, `lib/import.js:12`, `server/design-routes.js:17`.

**What is still true is the security argument, and it is unchanged.**
`resolveStratumMcpConnection` (`lib/stratum-engine.js:248-255`) returns
`{command: process.execPath, args:[<stratum mcp bin>], cwd}` — compose
**spawns the stratum MCP server as a local child process**, which inherits
compose's environment exactly as the CLI does. So switching guard calls to MCP
does not, by itself, create a trust boundary: option (i) in the design
("trusted transport") is cheaper than the design assumed but buys less than it
implies. Option (ii), signed descriptors, remains the one that actually creates
authorization the calling process cannot forge.

---

## 10. `lib/feature-validator.js` — COMPLETE without design.md

`MISSING_DESIGN_ARTIFACT` is raised in `runArtifactLinkChecks` at `:580-591`:

- `error` when status is `IN_PROGRESS | PARTIAL | BLOCKED` (`:583-586`)
- **`warning` when status is `COMPLETE`** (`:587-590`), with the message
  "legacy migration debt; current writers do not enforce this retroactively"
- no finding at all for `PLANNED | SUPERSEDED | KILLED | PARKED` (`:591`)

So COMPLETE-without-artifacts is still a tolerated *state*. The design's crux
holds.

---

## 11. Tests that constrain this work

| File | Lines | What it injects |
|---|---|---|
| `test/completion-gate.test.js` | 534 | `_testOnly_setGuardClient` (fake `{register,transition}`), `_testOnly_setHistoryClient` (fake guard-history), `_testOnly_resetGuardCache`. Uses a **real git repo** in a tmpdir — evidence is exercised, not mocked (`:35`). 21 tests: guard reached, bad commit refuses, non-true `tests_pass`, unreachable fails closed, guard-off opt-out, KILLED refused, crash-recovery same/different commit, no-intent refusal, stale-intent clear, refusal writes nothing, evidence-only, create-COMPLETE closed, migration exemption, real-client `guard_not_found` shape (`:382`), unreachable still refuses (`:403`), ROADMAP+vision freshness (`:435`), partial reporting (`:474`, `:492`), no-item skip (`:514`), no-import-cycle (`:526`). |
| `test/lifecycle-guard.test.js` | 262 | `_testOnly_setGuardClient` + `_testOnly_resetGuardCache` per test; asserts graph shape, resource ids, predicates, fail-closed behaviour. |
| `test/lifecycle-guard-e2e.test.js` | 124 | Real express app + tmp workspace; only resets the guard cache. |
| `test/lifecycle-guard-mode-rel-dir.test.js` | 107 | Mode-aware `_testOnly_featureRelDir` — pins `docs/bugs/BUG-3`, `docs/plans/PLAN-X`, and a `paths.features` override. |
| `test/lifecycle-guard-auth.test.js` | — | `guardAuth` token enforcement on lifecycle routes. |
| `test/lifecycle-routes.test.js` | 388 | REST-level lifecycle suites incl. mode stamping on start (`:369`). |
| `test/lifecycle-phase-history.test.js` | 118 | Pure unit tests on `appendPhaseHistory`: creation, append, dual-shape fields, `from:null`. **This is the file that pins the current closure semantics.** |
| `test/lifecycle-modes.test.js` / `test/lifecycle-modes-golden.test.js` | — | Pin the `build` entry against the legacy exports — any change to build's transitions/terminal/phaseOrder breaks these by design. |
| `test/stratum-client-guard.test.js` | 150 | `_testOnly_setExecFile` fake; 7 tests covering register kwargs on stdin, transition translation, refusal-as-normal, override token, history, canonical error dict, timeout-no-retry. A new guard verb needs a case here. |
| `test/decision-events-snapshot.test.js` | 301 | Fixture items with hand-written `phaseHistory`; asserts one event per entry and idempotent re-derivation. |
| `test/completion-evidence.test.js` | 100 | `assertCompletionEvidence` against a real tmp git repo. |
| `test/force-override-gate.test.js` | — | `assertForceAuthorized` / `assertTerminalStatusAuthorized` incl. override-token cases. |
| `test/completion-write-allowlist.test.js` | — | The allowlist that keeps modules other than the gate out of the COMPLETE write path. A backfill writer must be added here explicitly. |

---

## 12. Guard registry census (measured 2026-09-05)

`~/.stratum/guards` — 35 directories, all 35 have `registry.json`, and **all 35
are `compose:` resources** with `workspace_root =
/Users/ruze/reg/my/forge/compose`. Each dir holds `registry.json`,
`ledger.jsonl`, `.lock`.

| Dimension | Distribution |
|---|---|
| `graph_version` | `1` × 35 |
| `current_state` | `explore_design` × 31, `complete` × 3, `blueprint` × 1 |
| resource-id namespace | 34 build (`compose:<hash>:<CODE>`), 1 plan (`compose:85154ecf6cdb:plan:PLAN-A`) |
| distinct policy checksums | **35 — every resource has a unique checksum** |

The three `complete` resources are **real features, not fixtures**:
`COMP-COMPLETION-GATE`, `COMP-COVERAGE-GATE`, `COMP-PLAN-IDEA-UNIFY`. Each has a
single ledger entry, `ship → complete`, `outcome: applied`, `resolved_by:
agent`, `payload_digest_version: 2`. The remaining 32 are the test-fixture
codes (`BUG-*`, `FEAT-*`, `TS-BUILD-*`, `FOO-1`, `ERR-1`, `PROOF-1`, …).

**The checksum finding is load-bearing.** Because `edge_predicates` embed the
per-feature relative directory
(`server_file_exists('docs/features/<CODE>/design.md')`), **no two features can
ever share a policy checksum.** The design's compose-side plan — "enumerate the
distinct policies among registered guards and emit `{from_checksum, to_policy}`
for each" — therefore produces one descriptor per registered feature (35 today),
not a small fixed set, and every newly registered feature invalidates the
descriptor list. A signed-descriptor scheme keyed on `from_checksum` needs
either a per-resource descriptor generated and signed on demand, or a
predicate-template-aware descriptor form that stratum can expand per resource.

---

## 13. Where the design's citations are now stale

| Design says | Reality on 2026-09-05 |
|---|---|
| `server/vision-routes.js:471` — completable check | `:527-530` |
| `server/lifecycle-guard.js:79` — `buildPhaseGraph` | declared at `:65`; `:79` is the `graph[completable].push('complete')` line inside it |
| `server/lifecycle-guard.js:301` — "`ensureRegistered`" | the function is `ensureGuard` (`:299`); `:301` is correctly the `_registered` cache check |
| `server/lifecycle-guard.js:104` — `server_file_exists` | still `:104` (correct) |
| `lib/lifecycle-modes.js:58` — build edge evidence | still `:58` (correct) |
| `lib/lifecycle-modes.js:45,88` — backward loops | off by one: build's `verification` loop is `:46`, fix's `test` loop is `:89` |
| `lib/feature-validator.js:571` — COMPLETE warn | `:587-590` (the check block starts `:580`) |
| `lib/feature-writer.js:555` — path containment | `validateRepoPath` is `:610-641`; `:555` is now inside `setFeatureStatus`'s vision projection. Also: it has **no** firmlink strip — that is `lib/canon-guard.js:46-95` |
| `server/lifecycle-phase-history.js:27-31 / :32-43` | correct |
| `server/decision-events-snapshot.js:48` | correct |
| `server/decision-event-emit.js:52` "rejects them" | `:53-70`; it does not reject, it builds a fixed `{from_phase,to_phase}` metadata object at `:64-67` |
| `contracts/comp-obs-contract.schema.json:266` | the `phase_transition` branch is `:267-268` |
| `server/stratum-client.js:327` — register immutability docstring | `:327-331` (correct) |
| "compose does not talk to stratum over MCP" | **false today** — `lib/stratum-mcp-client.js` exists and is used by build/gsd/new/import/design-routes. The security argument survives (the MCP server is a compose-spawned child inheriting compose's env), the transport claim does not. |
| "31 registered guard resources … COMP-PLAN-IDEA-UNIFY is unregistered" | **35 now**, and `COMP-PLAN-IDEA-UNIFY` is registered AND `complete` |
| `lib/completion-gate.js:1-58` header: "every one of the 31 is a leaked test fixture" | no longer true — 3 real features have completed through the gate |
