# COMP-ROADMAP-ARCHIVE: Blueprint

**Date:** 2026-09-09
**Status:** BLUEPRINT — Phase 4. Grounded against the repo state read 2026-09-09.
**Design:** `docs/features/COMP-ROADMAP-ARCHIVE/design.md` — its Revision note (four decisions),
Behavior and invariants 1–7, Automatic integration, Paths and persistence, Read and validation
contract and Acceptance criteria are the contract. This blueprint does not re-open them.
**Plan:** `docs/features/COMP-ROADMAP-ARCHIVE/plan.md` — the five numbered steps map to slices
S01–S05 below.

## Related Documents

- `docs/features/COMP-ROADMAP-ARCHIVE/design.md` — the decisions this blueprint implements
- `docs/features/COMP-ROADMAP-ARCHIVE/plan.md` — step list this blueprint expands
- `docs/features/COMP-ROADMAP-SHARD/feature.json` — its "active + archived" shard shape is
  superseded here; it keeps size-triggered and per-phase placement policies on the ordered
  document-set loader S01 introduces
- `docs/features/COMP-LIFECYCLE-BACKFILL/blueprint.md` — format reference, and the owner of the
  backfill path this feature routes through the publication service
- `docs/features/COMP-COMPLETION-GATE/design.md` — the completion authority that stays unchanged
- `.claude/skills/compose/templates/boundary-map.md` — the grammar the Boundary Map below obeys
- **No Stratum change is involved in this feature.** Nothing here touches `stratum/`, the guard,
  the judge or any `stratum_*` MCP surface; the only cross-cutting primitive introduced
  (`lib/durable-write.js`) is extracted from compose's own `lib/consumer-fanout.js`.

---

## 1. Corrections

One row per correction from the two grounded seam surveys plus one row per controller
adjudication, merged where they describe the same fact. "Decision" carries the adjudication
letter (A..AB) where one applies; rows with no letter are grounding corrections that change a
citation or a line count rather than a decision. Every file:line below was re-read in the file
before this table was written.

| # | Spec assumption | Reality (file:line) | Decision |
|---|---|---|---|
| C1 | "the three `renderRoadmap()` call sites" (design.md:169-171, plan.md:73) | Four in-repo producer sites, not three: `lib/feature-writer.js:294` (create), `:510` (transition), `lib/completion-gate.js:494` (live), `:1316` (backfill). `lib/tracker/local-provider.js:100` is the implementation and `lib/tracker/github-provider.js:517` the remote one | S04's wiring checklist carries **four** line numbers plus the two provider implementations. The count "three" is retired |
| C2 | The writer "persists ordinary transitions … and calls `provider.renderRoadmap()`" (design.md:67-72), one projection-failure semantic | Asymmetric. `lib/feature-writer.js:509-517` **throws** `ROADMAP_PARTIAL_WRITE` (`partialWriteError`, `:339-341`), so the audit event (`:519-526`) and the vision projection (`:540`) are never reached — pinned by `test/feature-writer.test.js:356`. `lib/completion-gate.js:492-497` **collects** into `failures` | **K.** Both semantics preserved exactly as they are. `setFeatureStatus` keeps throwing; the gate keeps collecting. No test assertion is weakened |
| C3 | `reason` is "appended to a best-effort audit event after the status is already persisted" (design.md:26-29) | `args.reason` is used in exactly one place, `lib/feature-writer.js:526`, inside the object handed to `safeAppendEvent` (`:414-417`), which swallows on failure. And because `:517` throws first, a projection failure never even attempts it. `status_reason` exists nowhere in `lib`, `server`, `bin`, `contracts` or `test` | **K.** `status_reason` is written into feature.json in the **same `persistFeatureRaw` call as `status`** (`:508`), before the render. It survives the throw. The audit event stays best-effort |
| C4 | "no ordinary edge into SUPERSEDED; COMPLETE to SUPERSEDED is force-only" (design.md:70-72) | Stronger: no key in `TRANSITIONS` (`lib/feature-writer.js:49-58`) lists SUPERSEDED at all, so **every** edge into SUPERSEDED from any status is force-only. Separately `PARTIAL: ['IN_PROGRESS','COMPLETE','KILLED']` (`:52`) has **no** PARKED edge, so the acceptance criterion "an ordinary PARKED transition" is unavailable from PARTIAL | **L.** Add `PARKED` to the `PARTIAL` list at `lib/feature-writer.js:52`, pinned by a test. SUPERSEDED stays force-only from everywhere. **Flagged to the owner** as a transition-table gap this feature closes as a side effect |
| C5 | The gate clears its completion intent on a projection failure, therefore projection repair cannot depend on it (design.md:73-79) | True of the **live** path only: `clearIntent` at `lib/completion-gate.js:526` is unconditional. The **backfill** path gates it on `failures.length === 0 && auditOk` (`:1393`, clear at `:1415`), so a backfill whose roadmap write failed keeps its intent and returns `status:'pending'` (`:1419`) and *is* resumable | **Z.** State the asymmetry in the code comment. The service's own intent is independent of both, so the conclusion stands; the justification is narrowed to the live door |
| C6 | `compose roadmap generate` "compute[s] and write[s] … independently of the provider" (design.md:90-92) | Correct, and the mechanism matters: `bin/compose.js:1318` calls `generateRoadmapFromBase` **purely for the drift side effect** and discards the result; the bytes come from `checkRoundtrip(...).canonical` (`:1325`); two bare `writeFileSync` sites write them (`:1334` on `--protect`, `:1360` normally) | **P.** Replace both write sites with the service. `--protect` (`:1286`), `--accept-loss` (`:1285`), the marker guard (`:1293`) and the prose-loss refusal (`:1344`) become **pre-checks on the rendered set**, keeping their exit codes |
| C7 | `compose feature` "writes feature.json and edits ROADMAP.md directly" (design.md:92-93) | Worse. `bin/compose.js:1165` writes feature.json with **no `phase`, no `position`, no roundtrip guard, no audit event**; `:1201-1220` splices a row by regex against `/^(\| \d+ \|.*\| PLANNED \|)$/m` (`:1205`); there are **two** separate `writeFileSync` calls (`:1227`, `:1237`); and there is **no `isNarrativeOwned` guard anywhere in the handler** (`cmd === 'feature'` begins `:1067`, exits `:1244`) | **O.** Write feature.json **with `phase`** when `--phase` is given and let the service assign `position`; render through the service; delete both regex splices. Add the `isNarrativeOwned` guard: write feature.json, skip the roadmap edit, print `narrativeOwnedMessage` |
| C8 | build.js has two raw status writes, "start/teardown" (design.md:93-96, plan.md:22-23) | Four, all `persistFeatureRaw`, none rendering, all gated on `cfg.tracksFeatureJson`: `lib/build.js:2609` (start, IN_PROGRESS, comment `:2598`), `:2936` (preflight-abort rollback, PLANNED), `:4608` (killedByGate teardown, PLANNED), `:2102` (inside `writeFailedBuildTerminalState`, `:2073`, PLANNED) | **M.** All four route through the service |
| C9 | Only the start write is a placement hazard (design.md:172-175) | The teardown writes `status: 'PLANNED'` without reading the prior status (`lib/build.js:2102`, `:2936`, `:4608`), so a build started on a PARKED feature and then killed lands it PLANNED — losing the PARKED state and, under v1's rule, its reason | **M.** Pre-existing behavior, **not fixed here**. Teardown keeps writing PLANNED unconditionally; noted as a follow-up candidate so nobody reads the archive as the cause |
| C10 | "under the per-workspace lock" (design.md:206), "Per-workspace lock" (plan.md:57) | No per-workspace lock exists. `lib/dir-lock.js` is the primitive (`acquireDirLock` `:84`, `withDirLock` `:163`), but every lock path in the repo is per-feature: `.compose/data/locks/completion-<CODE>` (`lib/completion-gate.js:311`) and `.compose/data/locks/feature-<CODE>.lock` (`lib/completion-writer.js:65`). `withDirLock` is **not reentrant** (`lib/dir-lock.js:154`) | **I.** New `.compose/data/locks/roadmap-set.lock`, taken **inside** the service. Lock order is always feature lock → roadmap-set lock, never the reverse. `compose roadmap generate` takes only the set lock. The service must never call itself while holding the lock |
| C11 | The gate's intent file is an atomic-write precedent | It is not. `lib/completion-gate.js:135-137` writes a `.tmp` then copies it over the target; the comment at `:137` says "Rename" and the code does not rename | **J.** Do not cite it. The model is `durableWriteJson` (`lib/consumer-fanout.js:64-77`) with `fsyncDirectory` (`:54-62`) |
| C12 | The publication order hardens an existing guarded write (design.md:206-218) | `writeRoadmap` is one bare `writeFileSync` (`lib/roadmap-gen.js:525`) with no temp file, no rename, no lock and no hash check, and it **returns the path even when it no-ops** on a narrative-owned workspace (`:519-522`), so a caller cannot tell "wrote" from "skipped". There is no baseline anywhere in `lib` | **J.** Extract `durableWriteJson` + `fsyncDirectory` into `lib/durable-write.js` (consumer-fanout imports it); intent, baseline manifest and both staged documents all go through it. `publishRoadmapSet` returns an explicit `{written, skipped, reason}` |
| C13 | `roadmap.archive` path plus an enable flag exist to be read (design.md:199-203, plan.md:56) | Neither exists. `DEFAULT_PATHS` (`lib/paths-core.js:11`) has six keys and no archive; `compose init` writes exactly those six under `paths` and **no `roadmap` sub-object at all** (`bin/compose.js:423`, `:445`), so `roadmap.narrative` survives only through the `...existing` spread | **H.** Split them. Enable flag is `roadmap.archive: true\|false`, sibling of `roadmap.narrative`. PATH is `paths.archive` in `DEFAULT_PATHS`, default `ROADMAP-ARCHIVE.md`, so `resolvePathValue` (`lib/paths-core.js:28`) gives external-root and absolute-path handling for free. `compose init` writes both. Active and archive resolving to one path is a **load error** |
| C14 | "(schema field added)" is a prerequisite for `status_reason` (plan.md:31-33) | `contracts/feature-json.schema.json:7` is `"additionalProperties": true`, so the field validates today; `required` is `["code"]` only (`:8`) | **K.** Add `status_reason` to the schema **explicitly** anyway (self-documenting, and required by COMP-MCP-VALIDATE-SCHEMA-TIGHTEN), but it is not a blocking dependency |
| C15 | The producer inventory is complete | `setRoadmapRowStatus` (`lib/feature-writer.js:893`) is a **fifth** ROADMAP writer the inventory omits — a surgical single-cell edit used by the reconciler, deliberately avoiding `renderRoadmap`, with last-wins duplicate semantics (`:906`, `:947`) and the repo's only atomic ROADMAP write (`:958-960`) | **N.** Locate the row across the set. If the new status keeps it in the document that already holds it, keep the surgical edit. Otherwise delegate to the service render |
| C16 | `check` must report a pending intent as in-flight "without writing" (design.md:187-189) | `bin/compose.js:1509-1541` today: exit 0 in sync (`:1529`) or narrative-owned, exit **1** on missing file (`:1515`) and exit **1** on any drift (`:1533`). Reusing 1 conflates in-flight with drift | **Q.** Pending intent → **exit code 2**, message "in-flight, run `compose roadmap generate`". Drift and missing stay 1 |
| C17 | The read path's audit side effect is "generateRoadmap emits an audit event" (design.md:104-107) | Narrower. `lib/get-roadmap.js:65` calls `generateRoadmap(root, {})` with no `suppressDrift`; `lib/roadmap-gen.js:151` calls `emitDrift` **only** when a phase heading carries a status override diverging from the rollup; `lib/roadmap-drift.js:30` always warns to stderr and appends a `roadmap_drift` event (`:47`) under a 24h dedupe (`:18`, `:35`) | **S.** The no-mutation test must use a fixture **with a diverging phase override** or it passes vacuously, and it must assert on `.compose/data/feature-events.jsonl`, not on ROADMAP.md mtime (which is all `test/get-roadmap.test.js:57` checks today) |
| C18 | lane-gate "creates features through the provider" (design.md:95-96) | `lib/lane-gate.js:99` creates with `status:'PLANNED'` and **no `phase`**, emits no audit event, takes no lock and **never renders**, so a lane-gate-created feature has no roadmap row until some unrelated producer renders. `maybeEscalateLane` (`:133`) writes via `putFeature` (`:163`), which cannot change status (`lib/tracker/local-provider.js:67`) | **AA.** Route `applyFrontTriage` through the service so the row exists immediately. `maybeEscalateLane` is **not** a placement change and is left alone |
| C19 | (not in the spec) | `test/completion-write-allowlist.test.js` is a two-sided repo-wide scan of `lib`, `server`, `bin` (`SCAN_DIRS` `:27`) whose `WRITE_PATTERNS` (`:31`) include `/\bwriteFeature\(/` and `/persistFeatureRaw\(/`. Every hit needs an `ALLOWLIST` entry with a `why` (`:49`) **and every entry needs a hit** (`:17`) | **R.** The File Plan carries an ALLOWLIST entry with a `why` for every new module that calls `writeFeature` or `persistFeatureRaw`. v1's new modules call **neither** — the service renders documents only — so the expected diff to that file is the assertion in C61, not a new entry |
| C20 | Grepping `writeRoadmap` finds the producers | Four test files define a local helper of the same name that hand-writes a markdown table: `test/feature-validator.test.js:27`, `test/feature-writer-vision-projection.test.js:29`, `test/feature-write-guard.test.js:37`, `test/feature-reconciler.test.js:43` | Grep for `renderRoadmap(`/`writeRoadmap(` **in `lib` and `bin` only** when auditing S04 coverage |
| C21 | `roadmap-gen.js` renders and therefore owns `renderRoadmap` (design.md:82-89) | `lib/roadmap-gen.js` exports exactly `generateRoadmapFromBase` (`:56`), `generateRoadmap` (`:208`) and `writeRoadmap` (`:514`). `renderRoadmap` is a **provider** method (`lib/tracker/local-provider.js:100`) | The Boundary Map names the real symbols. `lib/canon-registry.js:112` declares `writer: 'lib/roadmap-gen.js'` for the ROADMAP canon path and keeps doing so |
| C22 | An anonymous preserved row's "own status column is its canonical status" is a field access (design.md:126, plan.md:44-45) | `readAnonymousRows` stores exactly `{ rawLine, predecessorCode }` (`lib/roadmap-preservers.js:178`); the status cell is never parsed. Its code-column detection is its own implementation (`:140-147`) and yields `codeColIdx === -1` for a 3-col `\| # \| Item \| Status \|` table — precisely the shape of compose's own Phase 0 block (`ROADMAP.md:28`), where **every** row is anonymous | **D.** New reader `readAnonymousRowStatus(rawLine, layout)` exported from `lib/roadmap-preservers.js`: the status is the **last cell** when `parseStatusToken` recognises it, for both 3-col and 4-col layouts. A row with no recognised token has no status, stays where it is and yields a diagnostic |
| C23 | Per-item rows are preserved source content (design.md:87-88) | They are rendered from feature.json `items[]` (`lib/roadmap-gen.js:373`, `:441`) and round-tripped against it (`lib/roadmap-roundtrip.js:92-99`). They never pass through the preservers | **V.** "Item rows travel with the parent" is therefore **free**: placement is per feature and rows render wherever the feature renders. No item-row placement code is written |
| C24 | Column layout is per feature | `hasSubItems` is `features.some(f => f.items && f.items.length > 0)` (`lib/roadmap-gen.js:354`, `:416`), so **one** item-bearing feature switches the whole phase table to `\| # \| Feature \| Item \| Status \|` (`:369`) instead of `\| # \| Feature \| Description \| Status \|` (`:387`) | **E.** Layout is decided **per rendered table**, i.e. per (document × phase). Deterministic given the partition, so the second pass is byte-stable. The **one-time header change on the first partition** is expected and is called out in the dogfood slice |
| C25 | A rowless source-only block's heading status is "already parsed by the preservers" (design.md:128-129) | Parsed, but stored as the **raw tail**: `readPhaseOverrides` (`lib/roadmap-preservers.js:39`, `:54`) keeps `SUPERSEDED by STRAT-1` verbatim (`ROADMAP.md:123`). And the generator lets the override **always win** over the computed rollup (`lib/roadmap-gen.js:151-152`), so a COMPLETE-looking heading over active rows is a live state here | Placement calls `parseStatusToken` (`lib/roadmap-heading.js:30`) on the tail itself. An unrecognised tail leaves the block where it is and emits a diagnostic |
| C26 | There is one roadmap parser (design.md treats "parsers" as a unit) | Four, and they disagree on phase identity: `parseRoadmap` (`lib/roadmap-parser.js:54`), `readAnonymousRows`' own detection (`lib/roadmap-preservers.js:140-147`), the validator's hand-rolled scan (`lib/feature-validator.js:172-237`) and `classifyLines` in the residue checker (`lib/roadmap-residue.js:85`). Only the first, second and fourth reach `splitPhaseHeading`; the validator uses `/^##\s+(.+?)(?:\s+—\s+.+)?$/` (`:181`), which splits on the **first** em-dash | **B.** Unify on `splitPhaseHeading` (`lib/roadmap-heading.js:76`, rightmost boundary, `:79`). Fixing `lib/feature-validator.js:181` is a **latent bug fix**, pinned by a test with a two-em-dash heading. Mixed-phase detection then keys on one identity across all four readers |
| C27 | `parseRoadmap` returns `{rows, phases, columns}` | It returns a flat array of `{code, description, status, phaseId, position}` (`lib/roadmap-parser.js:173-178`) with a **global** monotonic `position` and phase as a string; anonymous rows are renamed `_anon_${position}` (`:174`). Splitting one document into two renumbers `position` in both | **C.** Anonymous-row identity is **content-based**: `(phaseIdentity, normalizedRawLine, ordinalAmongIdentical)`. Global `position` is never an identity |
| C28 | Roundtrip "does not reject duplicate non-item rows" (design.md:108-110) | Precisely: for an `items`-bearing feature it **does** compare the full multiset including count (`lib/roadmap-roundtrip.js:92-99`); only the non-item branch ignores extras by taking `group[0]` (`:101`). Cross-document duplicates are invisible for a second reason — the signature takes one `baseText` (`:48`) | **G.** Roundtrip runs over the set; a multi-row non-item group becomes a reported finding, cross-document included |
| C29 | Duplicate phases persist until the validator reports them (design.md:145, Behavior 6) | The generator **self-heals** them: `const orderedPhaseIds = [...new Set(sourcePhaseOrder)]` (`lib/roadmap-gen.js:109`) collapses repeats on regen, which is exactly why `computeResidue` does not occurrence-count `##` headings (`lib/roadmap-residue.js:176`) | **X.** The dedupe stays. Validator rule: same phase identity in **both** documents = mixed (allowed); twice in **one** document = duplicate (reported, `DUPLICATE_PHASE_HEADING` at `lib/feature-validator.js:776`) |
| C30 | `compose validate` resolves archived dependencies (design.md:236-239) | The validator has no dependency resolution at all. Dependency edges live in the graph: `depsToEdges` (`lib/roadmap-graph/model.js:125`) over the vision store plus `deps.yaml` (`lib/roadmap-graph/index.js:22`), with ROADMAP.md only a degradable supplementary read (`server/roadmap-graph-vision.js:58`). `buildGraph` (`model.js:59`) already drops COMPLETE/SUPERSEDED/KILLED (`:65`) but keeps PARKED (`:19`), and throws `DanglingEdgeError` if an edge endpoint is missing from `knownCodes` (`:95`) | **T.** The graph is **unaffected**. Restate the criterion as a pin test: `buildGraph`'s `knownCodes` still includes archived features. `knownCodes` stays on canonical features, never on the active document |
| C31 | The read path's non-read-only behavior is pinned | It is not. The existing no-write test checks ROADMAP.md mtime only (`test/get-roadmap.test.js:57`), and `test/roadmap-drift.test.js:22` exercises `emitDrift` directly, never through a read | **S.** See C17: the no-mutation test is new, uses a diverging override and asserts on the event log |
| C32 | Anchors, redirects and link rewriting harden existing row identity (design.md:149-155) | All net-new. There are no `<a id>` anchors and no markdown links in rows anywhere: a row is four plain cells (`lib/roadmap-gen.js:393`), the only path-bearing output is a **backticked path, not a link** (`buildKeyDocs`, `:491`), `templates/ROADMAP.md` has neither, and the repo has no link-rewriting helper (`rewriteLinks`, `lib/feature-writer.js:838`, rewrites a feature.json `links[]` array) | **W.** Per-feature anchor `<a id="CODE"></a>` at the start of the code cell of every managed row, in whichever document holds it. The id grammar to mirror is `sectionSlug` (`lib/roadmap-residue.js:249`) plus `PRESERVED_OPEN_RE` (`lib/roadmap-preservers.js:26`) |
| C33 | Moving an anonymous row is presentation-only | An anonymous row classifies as `kind: 'other'` (`lib/roadmap-residue.js:142`) and is therefore **eligible residue**; `computeResidue` compares one base text to one candidate (`:169`). Relocating it reads as `ROADMAP_PROSE_LOSS` (`lib/roadmap-errors.js:16`). The design's Read contract names validators, roundtrip and losslessness but not the residue checker | **F.** `computeResidue` gains a **set form**: base = active + archive current bytes, candidate = both rendered, compared as one multiset of eligible lines |
| C34 | BLOCKED's handling is consistent (design.md:118 classifies it active) | Three different inactive sets exist. `SKIP_STATUSES` (`lib/roadmap-parser.js:18`) is the design's inactive set **plus BLOCKED**, and `filterBuildable` (`:241`) excludes BLOCKED; the graph's `DROP_STATUSES` (`lib/roadmap-graph/model.js:12`) is COMPLETE/SUPERSEDED/KILLED and **keeps** PARKED | **A.** The partition set is its own named const: `ARCHIVE_INACTIVE_STATUSES = {COMPLETE, PARKED, SUPERSEDED, KILLED}` exported from `lib/roadmap-archive.js`. Never reuse `SKIP_STATUSES` or `DROP_STATUSES`. BLOCKED is active |
| C35 | `get_roadmap`'s schema is updated and its docs amended (plan.md:94) | `get_roadmap` has **no HTTP surface** — it appears only at `server/mcp-tool-defs.js:326`, `server/compose-mcp-tools.js:186`, `server/compose-mcp.js:171` and the read-only allowlist `server/mcp-tool-policy.js:61`. And `docs/mcp.md` does not document it at all (the tool table lists `add_roadmap_entry` at `:22`). `format` has **no enum** (`mcp-tool-defs.js:334`). `BUCKET` (`lib/get-roadmap.js:28`) has no KILLED entry, so KILLED is silently uncounted and an archived count cannot be derived from the buckets | **S.** `docs/mcp.md` is an **ADD**, not an update. Add a `format` enum, a `scope` enum and `code`. The archived count comes from the service's partition result. Add a KILLED bucket while there |
| C36 | The dogfood fixture is a fresh trimmed copy (plan.md:36-37) | `test/roadmap-roundtrip.test.js` already runs against the **real** repo file: `COMPOSE_ROOT = join(__dirname, '..')` (`:27`), seven tests asserting `originalSections.size === 4` (`:35`), every anonymous `rawLine`, the Phase 7 intro prose and regen idempotence | **U.** The dogfood slice reframes that file against the document set **in the same commit** that enables archival on compose's own roadmap |
| C37 | `test/roadmap-gen*.test.js` exists (plan.md:101 "existing paths are verified to exist") | It does not. roadmap-gen behavior is covered indirectly by `roadmap-roundtrip`, `roadmap-preservers`, `roadmap-dup-phase-converge`, `roadmap-ungrouped-features-merge`, `roadmap-ranged-position-converge`. Every other existing path in plan.md's matrix does exist | The test matrix below names only paths confirmed on disk, plus new files marked `(new)` |
| C38 | Modules may be CommonJS | `package.json` is `"type": "module"`; every file surveyed uses `import`/`export` | **AB.** All four new modules are ESM: `lib/roadmap-archive.js`, `lib/roadmap-documents.js`, `lib/roadmap-publish.js`, `lib/durable-write.js`. The service entry point is `publishRoadmapSet(root, opts)` |
| C39 | An existing project's first partition needs a migration | `lib/migrate-roadmap.js:27` is a one-way feature.json seeding pass (`:112` return shape, `extractPhase` `:120`) with a named completion-write exemption at `:92`; it has nothing to do with document placement | **Y.** The initial partition for an existing project is just the **first service render after the flag is set**; no migration pass is needed for it. **Amended by R1-6:** `migrateRoadmap` is nonetheless a status-writing producer (`writeFeature` at `:102`) and is wired through the transaction like any other (S04-4). The earlier claim that it "is not modified" is withdrawn |
| C40 | There is a fixture corpus to start from | `test/fixtures/` holds only `cc-sessions/`, `judgment-canon/`, `mcp-fail-index-write.mjs`, `version-nudge-throwing-loader.mjs`. No roadmap fixture files exist; every roadmap fixture in the suite is an inline template string or the live repo file | S01 introduces `test/helpers/roadmap-set-fixture.js` as the single shared fixture builder, named by every slice's tests below |
| C41 | Redirects are stateful edits with a lifecycle to maintain (design.md:149-155) | Nothing stateful exists to build on (C32) | **W.** Redirects live in **one generated tail section per document**, `## Moved`, regenerated every pass. "One row and at most one redirect" is therefore a **rendering invariant**, not a stateful edit, and a park/restore/park cycle cannot accumulate either |
| C42 | A mixed phase needs a new heading form in the archive | Headings are plain `## ` text with an optional status tail (`PHASE_HEADING_TEXT_RE`, `lib/roadmap-heading.js:42`) | **X.** The archive renders the **same heading**, then one line `_Active rows: see [<Heading>](ROADMAP.md#<slug>)_`, then the inactive rows |

### Round 1 gate findings (C43–C54)

Codex round 1 on this blueprint returned 12 findings; all 12 were accepted and are folded in above.
They are referenced throughout as **R1-1** … **R1-12**.

| # | Blueprint said (first draft) | Reality (file:line) | Decision |
|---|---|---|---|
| C43 | Each producer calls the service once before its canonical write and once after | **R1-1:** the lock is released between the two calls, so a second producer can repair, mutate and publish inside the window; the first producer then renders from features it never saw, or republishes over the second's bytes. `withDirLock` (`lib/dir-lock.js:163`) scopes a lock to one call and nothing bridged them | The pre/post pattern is **withdrawn**. `withRoadmapSet(root, fn, opts)` holds `roadmap-set.lock` across repair, `fn` (the caller's canonical write) and publication. Every producer in S04 wraps its write in it; `fn` may not call the service (S02-3, S04) |
| C44 | Readers call the service with `dryRun: true` | **R1-2:** `dryRun` still took the workspace lock, still ran repair and the orphan sweep. A read would block up to `LOCK_ACQUIRE_TIMEOUT_MS` (`lib/dir-lock.js:57`, 30s) behind a publication and would mutate state on the way past — the exact property the no-mutation criterion exists to guarantee | `dryRun` is **removed**. Pure `loadRoadmapSet(root)` and `renderRoadmapSet(loaded, features)`: no lock, no repair, no sweep, no baseline write, no event. `get_roadmap`, `roadmap check`, the validator and the roundtrip use them; an intent on disk surfaces as `inFlight` (S02-3, S03-4, S05-1) |
| C45 | `## Moved` is regenerated in full every pass, so the lifecycle rule is a rendering invariant | **R1-3:** regenerating from the partition alone loses every redirect whose move happened on an *earlier* pass. A second pass with nothing moved emits an **empty** section, and the partition is identical so no partition test catches it. Worse, the section parses as a source-only phase block (`lib/roadmap-gen.js:129-143` re-emits such a block verbatim), so it would be both preserved and regenerated | `## Moved` is generated output **and** parsed input: `redirects(D) = priorRedirects(D) UNION movedOutOf(D) MINUS holdsAuthoritative(D)`. `parsePriorRedirects` is its only reader; every preserved-content reader excludes it by `MOVED_HEADING` (`lib/roadmap-preservers.js:312`, `:355`). The lifecycle rule follows from the algebra (§2.6, §2.7, S01-2) |
| C46 | The six preservers are run over both documents and merged | **R1-4:** `readPhaseOverrides` (`lib/roadmap-preservers.js:39`), `readPhaseBlocks` (`:272`, storing at `:288`) and `readPhaseOrder` (`:334`) key on phase title alone. A mixed phase has the same identity in both documents, so a flat merge silently lets the second read win and destroys the provenance mixed-phase ownership depends on | Run all six **once per document**; store `Map<documentId, …>`; key every partition entry by `(documentId, phaseIdentity)`. The active document's prose is authoritative for a mixed phase, and the archive's back-link line is generated every pass, never preserved (§2.6) |
| C47 | `setRoadmapRowStatus` keeps its surgical single-cell edit | **R1-5:** it renames its own temp file over ROADMAP.md (`lib/feature-writer.js:958-960`), and `lib/migrate-anon.js` writes the roadmap with two bare `writeFileSync` calls (`:174` forward, `:193` rollback). All three bypass the baseline and the intent, so the next publication refuses with `ROADMAP_SET_BASELINE_MISMATCH` on a file compose itself wrote | Both run **inside** `withRoadmapSet`. The surgical edit is applied to the holding document's **staged bytes** and published through the normal intent path, so the baseline updates; migrate-anon's rollback discards staged bytes instead of rewriting the target. The direct `renameSync` at `:959` is deleted (S04-1, S04-6) |
| C48 | The producer inventory is complete at fourteen sites | **R1-6:** three more create a `PLANNED` feature.json and never render — `compose triage` (`bin/compose.js:3257`, inside the `if (!existing)` at `:3256`), `promoteIdea` (`lib/fluid/ideabox-ops.js:439`, inside the `if (!existsSync(featurePath))` at `:435`) and `migrateRoadmap` (`lib/migrate-roadmap.js:102`) | All three route through `withRoadmapSet`. The blueprint's earlier line excluding `migrate-roadmap.js` is withdrawn (C39 amended); adjudication Y still holds for the initial partition, which needs no migration pass (S04-4, S04-6) |
| C49 | Repair renames any target whose hash differs from `post_sha256`; a malformed intent is treated as absent | **R1-7:** "differs from post" includes "was edited by a human mid-publication", so the repair would clobber that edit. And mapping a corrupt intent to `null` — copying `readIntent` (`lib/completion-gate.js:120-129`) — would publish **over** an interrupted publication and destroy the state the repair exists to finish | Fail closed. Rename only when the target hashes to `pre_sha256` (not yet written) or `post_sha256` (already done, nothing to do); anything else is `ARCHIVE_REPAIR_CONFLICT`, the intent is kept and nothing is renamed. A malformed `intent.json` or `baseline.json` is a hard error (`ROADMAP_SET_INTENT_CORRUPT` / `ROADMAP_SET_BASELINE_CORRUPT`); only ENOENT means absent (§2.4, §2.5, S02-3) |
| C50 | `computeResidueSet` returns one residue list for the set | **R1-8:** `protectResidue` (`lib/roadmap-residue.js:269`) rewrites a base text, and `--protect` (`bin/compose.js:1329`) needs to know **which** document a residue line came from in order to wrap it | Every residue carries `documentId`; `protectResidue` is applied per document to that document's own residue; `--protect` re-renders the **set** from the two protected bases (S03-3) |
| C51 | The flag alone decides whether the service is active | **R1-9:** v1 is local-provider-only (design Revision note 3), but a GitHub-backed workspace that sets `roadmap.archive: true` would get a half-applied two-document model against a provider that publishes one file (`lib/tracker/github-provider.js:517-544`) | The enable predicate is `isArchiveEnabled(cwd) && isLocalProvider(provider)` (`lib/feature-writer.js:352`), exported as `archiveActive` and named in every S04 row. False ⇒ today's single-document path, byte for byte, plus the one local-only log line (§2.2, S02-5) |
| C52 | Readers report `inFlight` alongside their normal findings | **R1-10:** mid-publication the bytes are a half-published set — one document new, one old — so a row can appear twice or not at all. Eight fabricated duplicate-row errors per publication window trains operators to ignore exactly the findings this feature adds | While `inFlight`, the validator suppresses missing, duplicate, dangling, lossy and orphan-phase findings and emits **one** `ROADMAP_SET_IN_FLIGHT` finding naming `compose roadmap generate`; `checkRoundtripSet` returns null verdicts and computes no diffs (S03-4, S03-5) |
| C53 | Four readers strip anchors via `stripAnchors` | **R1-11:** there are **six** code-cell readers, not four — `lib/feature-writer.js:927` (`setRoadmapRowStatus`) and `lib/feature-write-guard.js:121` (`scanRoadmapRows`, `:99`) were missed, and `knownFeatureCodes` (`:137`) scans one roadmap at `:154`, so every archived feature would drop out of the known set and `assertLinkTargetsExist` (`:183`) would refuse links to completed work. Separately, an item-bearing feature renders one row per item (`lib/roadmap-gen.js:437-443`, `:373-379`), so an anchor per row mints duplicate HTML ids | One `parseCodeCell(cell)` exported from `lib/roadmap-heading.js` (beside `splitPhaseHeading`, `:76`), used by all six; `knownFeatureCodes` scans both documents; the feature anchor goes on the **first** item row only (§2.7, S03-2, S03-6) |
| C54 | Staged documents live under `.compose/data/roadmap-set/staged/` | **R1-12:** the publication commits by `renameSync`, which fails `EXDEV` across filesystems, and `paths.roadmap` / `paths.archive` honour absolute and `../`-escaping values (`lib/paths-core.js:28`) — so an external document root can sit on another volume from `.compose/` | Stage each document **beside its target** as `.<basename>.staged-<opId>`; the intent records those paths; the orphan sweep scans both target directories for `.*.staged-*` (§2.3, §2.4, S02-3) |

### Round 2 gate findings (C55–C64)

Codex round 2 reviewed the round-1 fixes and returned 10 findings; all 10 accepted, referenced
inline as **R2-1** … **R2-10**.

| # | Blueprint said (round-1 revision) | Reality (file:line) | Decision |
|---|---|---|---|
| C55 | The transaction wraps `:501-517`, so the canonical write is inside the lock | **R2-1:** the *decisions* were still outside it. `provider.getFeature` (`lib/feature-writer.js:447`), the `from === to` early return (`:455`) and the transition-table check (`:482`) all read canonical state before the lock is taken, so a concurrent transition between `:447` and `:508` makes the writer validate against a `from` that no longer exists | The transaction wraps `:447-517`: the feature re-read, the no-op decision, the COMPLETE refusal, the transition validation and the construction of `updated` all move inside `fn`. A same-status call still **enters** the transaction (so repair runs) and returns `noop: true` from inside `fn` with no canonical write; the no-change short circuit keeps it byte-free (S04-1) |
| C56 | Both gate paths wrap their completion record and status write together | **R2-2: a real lock cycle.** `recordCompletion` runs inside `maybeIdempotent` (`lib/completion-writer.js:343`), which takes the idempotency lock (`lib/idempotency.js:138`), and then a feature lock — while an idempotency-keyed `setFeatureStatus` holds the idempotency lock (`lib/feature-writer.js:145`) *while waiting for the set lock*. That is `idempotency → set` against `set → idempotency` | Lock order is a declared three-level total order — idempotency → feature → roadmap-set (table in S02-3) — and `recordCompletion` and every idempotency-keyed unit of work stays **outside** `withRoadmapSet`. The transaction brackets only the feature-status persistence and the publication, in both gate paths. Pinned by a test that a backfill under an idempotency key completes without `DIR_LOCK_TIMEOUT` (S02-2, S02-3, S02-6) |
| C57 | Repair branches per target and renames as it goes; the commit renames what it staged | **R2-3:** a per-target loop renames the archive, then discovers the active document was hand-edited — leaving a third state that is neither the pre-state nor the post-state and that the next repair cannot classify. And the commit path re-verified nothing between staging and renaming, although the render, the baseline check and the staging all take real time under a lock that `LOCK_STALE_MS` (`lib/dir-lock.js:55`) can expire | A non-mutating **preflight** verifies EVERY target (bytes equal `pre` or `post`) and EVERY needed staged file (hash equals `post`) before ANY rename — in the repair path **and** immediately before the normal commit's renames. Any failure renames nothing, keeps the intent (repair) and returns a conflict diagnostic carrying its `phase` (S02-3 steps 1 and 7) |
| C58 | `setRoadmapRowStatus` and `migrate-anon` apply their surgical edits "to the staged bytes" | **R2-4:** the API had no way to say that. `withRoadmapSet` rendered and staged internally, so a caller wanting a one-cell patch had no seam and would fall back to writing the target — the exact baseline bypass R1-5 closed | New hook: `withRoadmapSet(root, fn, { transformDraft })`, where `transformDraft({active, archive, partition})` runs **after the render and before staging**, under the lock, and returns the bytes to stage. Pure and synchronous. `setRoadmapRowStatus` and `migrate-anon` express their edits through it; migrate-anon's two raw `writeFileSync` calls (`lib/migrate-anon.js:174`, `:193`) are both deleted (S02-3, S04-1, S04-6). **SUPERSEDED by C66 (R3-2):** the hook ran after the render, which is the wrong state for both callers; it is replaced by `patchSource`. The deletion of the two raw writes stands |
| C59 | `--protect` computes protection on the rendered set, then publishes | **R2-5:** it computed it on a **pre-lock** read. Residue found there can be stale by the time the publication renders, so `--protect` would wrap lines that no longer exist and miss lines that appeared | `--protect` recomputes `computeResidueSet` in-lock, applies `protectResidue` per document (R1-8), and hashes and preconditions are revalidated on the bytes actually committed. **SUPERSEDED in mechanism by C66 (R3-2):** it passes `protectBase`, which runs BEFORE the render, not a post-render hook. The in-lock requirement stands (S04-4) |
| C60 | Only the creating branches of triage and ideabox promotion need wiring | **R2-6:** the *retry* branches are where a pending projection is most likely to be waiting. `compose triage` on an existing feature takes the `updateFeature` else-branch (`bin/compose.js:3255` reads it), and `promoteIdea` on an already-promoted idea skips the `if` at `lib/fluid/ideabox-ops.js:435` and falls to `:449`. Neither writes canonical state, so neither would repair | Both retry branches run `withRoadmapSet` with an empty `fn`, so repair and re-render still happen (S04-4, S04-6) |
| C61 | `migrateRoadmap`'s loop becomes the `fn` of a transaction | **R2-7:** `migrateRoadmap` is **synchronous** (`lib/migrate-roadmap.js:27`) and consumed synchronously at `bin/compose.js:1493` and at six call sites in `test/migrate-roadmap.test.js` (`:31`, `:45`, `:79`, `:89`, `:90`, `:98`, two of them inside a synchronous `captureWarn` thunk). `withRoadmapSet` is async, so every caller would silently receive a Promise and print `undefined` counts. Separately, `--dry-run` writes nothing today (`:99-101`) | Make it `async` explicitly and update every caller and test in the same commit (table in S04-4). `--dry-run` returns its counts **before** any service call, so the one flag whose contract is "changes nothing" does not take the workspace lock and rewrite both documents |
| C62 | The orphan sweep scans both target directories for `.*.staged-*` | **R2-8:** `paths.roadmap` and `paths.archive` may resolve into a **shared** external directory (`lib/paths-core.js:28`), so a bare glob would delete another workspace's in-flight staged bytes and turn a crash there into an unrecoverable intent | The sweep matches only the two resolved basenames' escaped prefixes — `.ROADMAP.md.staged-*` and `.ROADMAP-ARCHIVE.md.staged-*` — with every regex metacharacter in the basename escaped (S02-3 step 9) |
| C63 | A lock-free reader is safe because it only reads | **R2-9:** a commit renames two files, so a reader can take the active document from after the commit and the archive from before it. The torn pair is indistinguishable from a duplicate or missing row, and no `inFlight` flag is set because the intent was already cleared | `loadRoadmapSet` reads intent + baseline generation, then both documents, then the generation again; if it moved it retries, at most three times, then returns `unstable: true`. While `inFlight` **or** `unstable`, the validator suppresses **every** roadmap-derived finding — including the two status-drift findings at `lib/feature-validator.js:469` and `:484` and the description drift at `:513` — and emits only `ROADMAP_SET_IN_FLIGHT` (S02-3, S03-5) |
| C64 | Only producers consult the enable predicate | **R2-10:** readers did not, so a GitHub-backed workspace with the flag set would see a two-document model on the read side while its producers wrote one document, and would report the archive as permanently missing. Separately, three reader sites were still told to use `stripAnchors` where `parseCodeCell` is required — including `readAnonymousRows`' code-cell read at `lib/roadmap-preservers.js:167` | `loadRoadmapSet` takes the effective `archiveActive` and returns a single-document set when it is false; `getRoadmap` collapses `scope` and omits the archive fields. The `stripAnchors`-only instructions are deleted: all six reader sites call `parseCodeCell`, and `stripAnchors` is the renderer's internal helper only (§2.2, §2.7, S01-3, S03-6, S05-1) |

### Round 3 gate findings (C65–C72)

Codex round 3 reviewed the round-2 fixes and returned 8 findings; all 8 accepted, referenced inline
as **R3-1** … **R3-8**. This was the final review round.

| # | Blueprint said (round-2 revision) | Reality (file:line) | Decision |
|---|---|---|---|
| C65 | `recordCompletion` stays wholly outside the transaction, which removes the lock cycle | **R3-1:** it also creates a lost update. `recordCompletion` reads the feature at `lib/completion-writer.js:351` and persists the merged object at `:397`; the transaction's `fn` independently reads at `lib/feature-writer.js:447`, builds `updated` at `:498` and persists at `:508`. Two read-modify-write cycles on one feature.json, interleaved — the second write silently drops the first's completion record or status flip | Split it. The **idempotency wrapper** (`:343`) stays outside; a new export `appendCompletionRecord(cwd, args)` carries the read-modify-write of `:351-403` and is invoked **inside** `withRoadmapSet`'s `fn`, under the feature lock. One cycle per completion. Lock order idempotency → feature → roadmap-set is preserved because the transaction is entered from inside the feature lock (S02-3, S04-2, S04-3) |
| C66 | `transformDraft` runs after the render and returns the bytes to stage | **R3-2: wrong state for both callers.** `--protect` must wrap residue in the **base** so the generator re-renders from the protected source — that is literally what `bin/compose.js:1327-1331` does (`protectResidue(base, residue)` then `checkRoundtrip(protectedBase, …)`); wrapping markers into rendered output leaves the next regeneration to strip them. And a surgical row patch must not be re-rendered **at all**: `lib/feature-writer.js:870-880` exists to say a full render is unsafe on a roadmap that is not already a fixed point | `transformDraft` is **deleted everywhere**. Two hooks, both pure and synchronous: `protectBase(source, residues) -> protectedSource` runs **before** the render and the service renders from its return; `patchSource(source) -> { docs, result }` runs **instead of** the render and the service publishes the patched current documents, still under the lock, baseline check, intent and preflight. `--protect` uses the first; `setRoadmapRowStatus` and `migrate-anon` use the second. Supplying both throws (S02-3, S04-1, S04-4, S04-6) |
| C67 | The reader snapshot compares the intent opId and the baseline's `updated_at` | **R3-3:** a wall-clock field is the wrong instrument — two publications inside one clock tick produce an identical value, a backwards clock inverts it, and it carries no ordering guarantee, so a torn read can pass the check | `baseline.json` gains `generation`, a monotonic integer incremented by one per successful publication, plus `last_operation_id`. The snapshot compares the pair `(intent operation_id, baseline generation)` and never `updated_at`. An absent manifest is generation 0 (§2.5, S02-3) |
| C68 | `withRoadmapSet` returns `{ result, publish }` | **R3-4:** a `patchSource` producer has no way to return its own verdict. `setRoadmapRowStatus` is contracted to return `{ code, changed, from?, to? }` (`lib/feature-writer.js:891`) and `lib/feature-reconciler.js:256-258` reads `r.changed !== false` — so a transaction that swallowed the hook's result would make every reconcile report a change it did not make | `withRoadmapSet` returns `{ result, patch, published, opId, diagnostics }`, where `patch` is `patchSource`'s own `result`. `setRoadmapRowStatus` maps `patch.result` onto its existing contract (S02-3, S04-1) |
| C69 | The triage existing-feature branch is wrapped with an empty `fn` | **R3-5:** that branch is not write-free. `updateFeature(trCwd, triageCode, {…})` at `bin/compose.js:3267-3271`, in the else at `:3266`, is a read-modify-write of feature.json — outside the transaction it reopens exactly the interleaving window R3-1 closes for completions | The `updateFeature` call goes **inside** `fn`. It changes no status, so placement does not move and the publication short-circuits, but the write belongs under the lock (S04-4) |
| C70 | `unstable` is treated like `inFlight` by every reader | **R3-6:** stated, but only wired in two places. `checkRoundtripSet` short-circuited on `inFlight` alone, and `compose roadmap check` exited 2 on `inFlight` alone — so a torn read produced fabricated diffs and an exit 0 or 1 | Both short-circuit on **either** flag. `compose roadmap check` exits 2 on `unstable` with its own message ("read was unstable; retry"), distinct from the in-flight message because the action is a retry, not `generate`. Tests for both (S03-4, S04-4, S02-6) |
| C71 | `archiveActive(cwd, provider)` is the reader predicate | **R3-7:** it needs a provider instance, and `providerFor` is **async** (`lib/tracker/factory.js:78`) while both reader entry points are synchronous — `getRoadmap` (`lib/get-roadmap.js:56`) and `loadValidationContext` (`lib/feature-validator.js:148`). Making either async is a caller-wide ripple for a predicate that only needs configuration | New synchronous `isLocalTrackerConfig(cwd)` **exported from `lib/tracker/factory.js` itself**, reusing the module-private `loadTrackerConfig` (`:6`) and the same provider-kind decision as `providerFor` (`:78-82`): local when the file is absent (`:9`), `tracker` is undefined or null (`:20-22`), or `provider` is falsy or `'local'` (`:81`); remote only on `'github'` (`:82`); a malformed file propagates `TrackerConfigError` (`:16`) rather than defaulting to local. **It is not mirrored in `roadmap-config.js`** — one source of truth for "is this workspace local", imported by `roadmap-config.js` (which exposes the conjunction `archiveActive(root)`), `roadmap-publish.js`, `get-roadmap.js`, `feature-validator.js` and `feature-write-guard.js`. `loadRoadmapSet(root)` calls `archiveActive` internally, and the guard's second roadmap scan is gated on it too (§2.2, S02-3, S03-6) |
| C72 | `captureWarn` must "become await-aware" | **R3-8:** under-specified, and the failure is silent. `captureWarn(fn)` (`test/migrate-roadmap.test.js:68`) returns `{ result: fn(), seen }` from inside a `try`/`finally` that restores `console.warn` (`:72`); with an async `fn` the `finally` runs before the promise settles, so every warning the migration emits lands after the restore and `seen` is empty — the two exemption assertions then pass vacuously | `async function captureWarn(fn)` with `await fn()` **inside** the try, so the restore happens after the awaited work. The File Plan row for that test says so explicitly (S04-4, File Plan) |

72 rows. Producers-survey corrections 1–20 are C1–C20, readers-survey corrections 1–19 are C21–C38
(its #12 merged into C12), C39–C42 are grounding facts the adjudications settled, C43–C54 are the
round-1 gate findings, C55–C64 round 2 and C65–C72 round 3. Every adjudication A–AB appears in the
Decision column of exactly one row.

### Design points that were not implementable as written

1. **"Under the per-workspace lock" had no lock to be under (C10).** Every lock in the repo is
   per-feature. The service introduces the first workspace-scoped one, and because `withDirLock` is
   not reentrant the nesting rule (feature lock → set lock, never the reverse, never self-nested)
   is a correctness constraint, not a style note.
2. **"Its own status column" was not a column the code had (C22).** The anonymous-row model carries
   no status at all, and compose's own corpus has tables with no Feature column whatsoever. A new
   reader is the minimum, and the no-token case has to be a diagnostic rather than a guess.
3. **Two of the three "inactive" sets in the repo disagree with the design's (C34).** Reusing
   either would have silently archived BLOCKED work or left PARKED active. The partition set is
   declared once and never shared.
4. **The residue checker was missing from the read contract (C33).** Without the set form, the very
   first archive publication of compose's own roadmap fails with prose loss on the Phase 0
   anonymous block — a refusal, not a corruption, but it blocks the feature outright.
5. **`PARTIAL → PARKED` did not exist (C4).** An acceptance criterion the design states as
   ordinary was unreachable from one active status. Closing it is a one-line table change, and it is
   flagged to the owner because it widens the transition table rather than only this feature.

---

## 2. Contract: shapes, paths and syntax

No new `contracts/*.schema.json` file. One existing contract gains a field; everything else here is
an internal on-disk shape under `.compose/data/`, which carries no schema in this repo today, so the
shapes are pinned by contract tests in `test/roadmap-archive-recovery.test.js` instead.

### 2.1 `contracts/feature-json.schema.json` (modify)

Add `status_reason` beside `status` (`:20-23`), leaving `additionalProperties: true` and
`required: ["code"]` untouched:

```jsonc
"status_reason": {
  "type": ["string", "null"],
  "description": "Why the feature is in its current status. REQUIRED by the typed writer for a transition into PARKED (COMP-ROADMAP-ARCHIVE); written in the same feature.json write as `status`, before the roadmap render, so it survives a ROADMAP_PARTIAL_WRITE throw. Existing PARKED features without one are never rewritten."
}
```

### 2.2 Config and paths

| Key | File | Value |
|---|---|---|
| `paths.archive` | `lib/paths-core.js:11` `DEFAULT_PATHS` | `'ROADMAP-ARCHIVE.md'` — resolved by `resolvePathValue` (`:28`), so absolute and `../`-escaping values work exactly as `paths.roadmap` does |
| `roadmap.archive` | `.compose/compose.json`, read by `lib/roadmap-config.js` | `true` or `false`. `compose init` writes `true`; absent is **false** for an existing project, matching `isNarrativeOwned`'s malformed-config conservatism (`:30`) |

`compose init` (`bin/compose.js:423-446`) gains `archive: 'ROADMAP-ARCHIVE.md'` inside `paths` and a
`roadmap: { archive: true, ...(existing.roadmap || {}) }` sub-object, spread so a hand-added
`roadmap.narrative` survives.

Load-time refusal (adjudication H): if `resolveRoadmapPath(cwd)` and `resolveArchivePath(cwd)`
resolve to the same absolute path, `loadRoadmapSetConfig` throws
`err.code = 'ROADMAP_ARCHIVE_PATH_COLLISION'`. Nothing is read and nothing is written.

**The enable predicate (R1-9), resolved from config and synchronous (R3-7).**
`roadmap.archive === true` is necessary but not sufficient: v1 is local-provider-only (design
Revision note 3), and a GitHub-backed workspace that sets the flag must not get a half-applied
two-document model.

**The "is this workspace local" question is answered in one place: `lib/tracker/factory.js`.** The
predicate is **not** reimplemented or mirrored anywhere. The factory already owns both halves of the
answer — the module-private `loadTrackerConfig` (`lib/tracker/factory.js:6`), which reads
`<cwd>/.compose/compose.json` and returns `{ provider: 'local' }` when the file is absent (`:9`) or
`parsed.tracker` is undefined or null (`:20-22`) and otherwise the `tracker` object itself (`:29`),
and the provider-kind decision in `providerFor` (`:78`), which treats a falsy or `'local'`
`cfg.provider` as local (`:80`) and only `'github'` as remote (`:82`). So the factory gains one new
synchronous export that reuses exactly those:

```js
// lib/tracker/factory.js — beside providerFor (:78), reusing loadTrackerConfig (:6) and the
// same provider-kind decision. Synchronous: it answers from config and constructs nothing.
export function isLocalTrackerConfig(cwd);    // -> boolean
```

`lib/roadmap-config.js` **imports** it rather than restating it, and exposes the conjunction:

```js
export function archiveActive(root);          // -> isArchiveEnabled(root) && isLocalTrackerConfig(root)
```

Every consumer — `lib/roadmap-publish.js`, `lib/get-roadmap.js`, `lib/feature-validator.js` and
`lib/feature-write-guard.js` — imports `isLocalTrackerConfig` from the factory, directly or through
`archiveActive`. A second implementation of the provider-kind rule is the defect this avoids: the
rule has four branches across two functions, and a copy drifts the first time either changes.

**It takes no provider instance**, because `providerFor` is async (`:78`) while both reader entry
points are synchronous — `getRoadmap` (`lib/get-roadmap.js:56`) and `loadValidationContext`
(`lib/feature-validator.js:148`) — and making either async is a caller-wide ripple for a predicate
that only needs the config. A malformed `compose.json` propagates the `TrackerConfigError`
`loadTrackerConfig` already throws (`:16`) rather than defaulting to local: silently treating a
misconfigured workspace as local is how a GitHub workspace would acquire an archive.

When the predicate is false **every producer takes today's single-document path, unchanged byte for
byte**, `GitHubProvider.renderRoadmap` logs the local-only line once (S02-5), and every reader gets
a single-document set (S02-3). `archiveActive(root)` is the condition named in every S04 row; no
producer and no reader open-codes the conjunction, and none reimplements the provider-kind rule.
`isLocalProvider` (`lib/feature-writer.js:352`) stays where it is and is not used for this — it needs
an instance.

### 2.3 State directory

```
.compose/data/roadmap-set/
  intent.json            durable write intent (ENOENT = no publication in flight)
  baseline.json          post-write hashes of the last successful publication
.compose/data/locks/roadmap-set.lock     withDirLock path (adjudication I)

<dir of paths.roadmap>/.ROADMAP.md.staged-<opId>            staged bytes, beside their target
<dir of paths.archive>/.ROADMAP-ARCHIVE.md.staged-<opId>
```

**Staging lives beside the target, never under the state directory (R1-12).** The publication
commits by `renameSync`, and `rename(2)` fails with `EXDEV` across filesystems. `paths.roadmap` and
`paths.archive` honour absolute and `../`-escaping values (`lib/paths-core.js:28`), so an external
document root can trivially sit on a different volume from `.compose/`. Staging in the target's own
directory makes the rename same-filesystem by construction. The names are dot-prefixed so they are
hidden from ordinary listings and cannot be mistaken for a document. The orphan sweep scans **both
target directories** for `.*.staged-*`, not the state directory.

### 2.4 Intent file — `intent.json`

```jsonc
{
  "version": 1,
  "operation_id": "<uuid v4>",
  "started_at": "<ISO 8601>",
  "producer": "set_feature_status",          // see the producer enum in S04
  "rename_order": ["archive", "active"],     // design.md:215 — archive first, always
  "baseline_path": "/abs/.compose/data/roadmap-set/baseline.json",
  "targets": [
    { "id": "active",  "path": "/abs/ROADMAP.md",
      "staged": "/abs/.ROADMAP.md.staged-<opId>",          // R1-12: beside the target
      "pre_sha256":  "<64 lowercase hex> or null",         // null = target did not exist
      "post_sha256": "<64 lowercase hex>" },
    { "id": "archive", "path": "/abs/ROADMAP-ARCHIVE.md",
      "staged": "/abs/.ROADMAP-ARCHIVE.md.staged-<opId>",
      "pre_sha256":  "<64 lowercase hex> or null",
      "post_sha256": "<64 lowercase hex>" }
  ]
}
```

Invariants pinned by contract test: `targets` is ordered `active` then `archive` while
`rename_order` is `archive` then `active`, so the file records the rename order explicitly rather
than relying on array position; every `post_sha256` is the sha256 of the corresponding staged file's
bytes; `operation_id` appears in both staged filenames; every `staged` path is in the same directory
as its `path`.

**A malformed intent is a hard error, never "absent" (R1-7).** `readPublishIntent` returns `null`
**only** on `ENOENT`. Any other read failure, a JSON parse failure, an unknown `version`, or a
record missing a required field throws `err.code = 'ROADMAP_SET_INTENT_CORRUPT'` and the service
writes nothing. This deliberately diverges from `readIntent` (`lib/completion-gate.js:120-129`),
which maps malformed to `null`: there, a lost intent costs a refused retry; here, treating a
corrupt intent as absent would publish **over** an interrupted publication and silently destroy the
half-written state that the repair exists to finish.

### 2.5 Baseline manifest — `baseline.json`

```jsonc
{
  "version": 1,
  "generation": 47,                     // R3-3: monotonic, +1 per successful publication
  "last_operation_id": "<uuid v4>",     // R3-3: the opId of the publication that wrote this
  "updated_at": "<ISO 8601>",
  "documents": {
    "active":  { "path": "/abs/ROADMAP.md",         "sha256": "<64 hex>", "bytes": 176421 },
    "archive": { "path": "/abs/ROADMAP-ARCHIVE.md", "sha256": "<64 hex>", "bytes": 42110 }
  }
}
```

**`generation` exists so the reader snapshot has something reliable to compare (R3-3).** A
wall-clock `updated_at` is the wrong instrument: two publications inside the same clock tick produce
an identical value, the clock can move backwards, and the field carries no ordering guarantee at all.
`generation` is a monotonic integer incremented by exactly one per successful publication, written in
the same `durableWriteJson` as the hashes, and `last_operation_id` ties it to the intent that
produced it. The reader compares the pair `(intent operation_id, baseline generation)` and nothing
else. An absent manifest is generation 0.

Semantics: the **post-write** hashes of the last successful publication. An **ENOENT** manifest
(first ever publication, or a project enabling the flag) means "no baseline" and the hash check is
skipped for that pass — the first render *is* the baseline. A present manifest whose recorded hash
differs from the on-disk bytes is a hand edit: refuse with `ROADMAP_SET_BASELINE_MISMATCH` and write
nothing.

A **malformed** manifest is a hard error (R1-7), symmetrically with the intent:
`readBaselineManifest` throws `ROADMAP_SET_BASELINE_CORRUPT` on anything but ENOENT. Treating an
unparseable baseline as "no baseline" would silently disable the hand-edit guard, which is the one
protection standing between an operator's edit and a clobber.

### 2.6 Partition result — the return of `partitionRoadmap`

```js
{
  placement: Map<string, 'active'|'archive'>,   // every partition key
  active:  { featureCodes: string[], anonRowIds: string[], phaseBlockIds: string[] },
  archive: { featureCodes: string[], anonRowIds: string[], phaseBlockIds: string[] },
  phaseOwnership: Map<string, { owner: 'active'|'archive', mixed: boolean }>,
  moved:   Array<{ kind: 'feature'|'phase', key: string, from: 'active'|'archive', to: 'active'|'archive' }>,
  redirects: { active: RedirectEntry[], archive: RedirectEntry[] },
  archivedFeatureCount: number,                  // features, not rows (design.md Behavior 1)
  diagnostics: Diagnostic[],
}
```

`RedirectEntry` is
`{ kind: 'feature'|'phase', id: string, label: string, targetDoc: 'active'|'archive', targetAnchor: string }`.

Partition keys: a managed feature is its `code`; an anonymous row is
`anon:` + documentId + SEP + phaseIdentity + SEP + normalizedRawLine + SEP + ordinal, where SEP is
the **unit separator U+001F** (adjudication C) — never a NUL byte, which breaks grep and every
line-oriented tool on any file a key is written into; a source-only phase block is
`phase:` + documentId + SEP + phaseIdentity.

**Preserved content is keyed by (documentId, phaseIdentity) and is never flat-merged (R1-4).**
`readPhaseOverrides` (`lib/roadmap-preservers.js:39`), `readPhaseBlocks` (`:272`, storing at `:288`)
and `readPhaseOrder` (`:334`) each return a Map or array keyed by phase title alone. Running them
over the concatenation of the two documents, or merging their two results with a plain spread,
destroys exactly the provenance a mixed phase depends on: the same identity legitimately appears in
both documents, and the second read would silently win. So the loader runs all six preservers
**once per document** and stores `Map<documentId, Map<phaseIdentity, ...>>`. For a mixed phase:

- the **active** document's phase block is authoritative for the heading and the prose;
- the **archive** document's phase block contributes its inactive rows only;
- the archive's `_Active rows: see ..._` back-link line is **generated every pass**, never read back
  as preserved prose, so it cannot accumulate, drift, or be mistaken for authored content.

**Redirect sets are computed by set algebra over parsed prior state (R1-3).** The `## Moved` section
is generated output **and** parsed input. For each document D on each pass:

```
redirects(D) = priorRedirects(D)          parsed from D's own `## Moved` section
             UNION movedOutOf(D)          features/phases whose row or heading left D this pass
             MINUS holdsAuthoritative(D)  features/phases whose row or heading now lives IN D
```

`priorRedirects` is why a pass in which nothing moves is byte-stable: with `movedOutOf` empty and
`holdsAuthoritative` unchanged, the set is its own prior value. Without parsing the prior section,
the second pass would emit an empty `## Moved` and every redirect would vanish — a silent regression
no partition test would catch, because the partition itself is identical.

The design's lifecycle rule (Behavior 5: exactly one document holds the row, the other holds at most
one redirect) is a **consequence** of this algebra rather than a stateful edit to maintain. The
`MINUS` term makes a redirect and an authoritative row mutually exclusive within a document, and set
union makes a repeated move idempotent, so a park, restore, park cycle cannot accumulate either —
and neither can an unchanged pass in between.

`Diagnostic` is `{ code, severity: 'error'|'warning'|'info', subject, message }`. Codes:

| Code | Severity | Raised when |
|---|---|---|
| `ARCHIVE_ANON_ROW_NO_STATUS` | warning | `readAnonymousRowStatus` finds no recognised token; the row stays where it is |
| `ARCHIVE_UNKNOWN_STATUS_TOKEN` | warning | a managed row or heading tail carries a token outside the 8-value enum |
| `ARCHIVE_PHASE_HEADING_NO_STATUS` | info | a rowless source-only block's heading has no status tail; it stays where it is |
| `ARCHIVE_DUPLICATE_AUTHORITATIVE_ROW` | error | the same code holds an authoritative row twice, within one document or across the two |
| `ARCHIVE_PUBLICATION_IN_FLIGHT` | info | a reader found an intent file; the set is reported as in-flight, never as missing or duplicated |
| `ARCHIVE_REPAIR_CONFLICT` | error | a pending intent's target matches neither its `pre_sha256` nor its `post_sha256`; the intent is kept and nothing is renamed (R1-7) |
| `ARCHIVE_REDIRECT_ORPHAN` | warning | a parsed prior redirect names a code that exists in neither document; it is dropped from the regenerated section |

### 2.7 Anchor and redirect syntax (adjudication W)

**Per-feature anchor**, at the start of the code cell of every managed row, in whichever document
holds it:

```
| 12 | <a id="COMP-ROADMAP-ARCHIVE"></a>COMP-ROADMAP-ARCHIVE | Automatic roadmap archival | PLANNED |
```

**Redirect tail section**, regenerated in full on every pass, last section of each document:

```markdown
## Moved

<a id="COMP-FOH-1"></a>COMP-FOH-1 → [ROADMAP-ARCHIVE.md#COMP-FOH-1](ROADMAP-ARCHIVE.md#COMP-FOH-1)
<a id="phase-5-standalone-app"></a>Phase 5: Standalone App → [ROADMAP-ARCHIVE.md#phase-5-standalone-app](ROADMAP-ARCHIVE.md#phase-5-standalone-app)
```

The archive's own `## Moved` points the other way, at `ROADMAP.md#…`. Phase slugs use the
`sectionSlug` grammar (`lib/roadmap-residue.js:249`: lowercase, letter-initial, `[a-z][a-z0-9-]*`,
collision-suffixed), which is also what `PRESERVED_OPEN_RE` (`lib/roadmap-preservers.js:26`)
accepts. The link text is computed from the two resolved paths, so an external document root
produces a working relative link rather than a bare filename.

**Mixed-phase archive heading** (adjudication X):

```markdown
## Backlog — PLANNED

_Active rows: see [Backlog](ROADMAP.md#backlog)_

| # | Feature | Description | Status |
| --- | --- | --- | --- |
| 1 | <a id="COMP-OLD-1"></a>COMP-OLD-1 | … | COMPLETE |
```

The heading and its prose block stay in the **active** document while any active row remains
(design Behavior 3); the archive carries the heading, the one back-link line and the inactive rows
only.

**One shared code-cell reader, used by six sites (R1-11).** Every place that turns a table cell
into a feature code must strip the anchor, and three of them already open-code the same `*` and
backtick stripping. They collapse onto one function:

```js
// lib/roadmap-heading.js - beside splitPhaseHeading (:76), the existing single source of
// truth for reading a heading. Placed here, not in roadmap-documents.js, because
// roadmap-parser.js already re-exports from this module (lib/roadmap-parser.js:14) and
// feature-write-guard.js must not depend on the document-set layer.
export function parseCodeCell(cell);   // strips the anchor tag, ** , ` , then trims
```

| Site | Line today | What it does today |
|---|---|---|
| `lib/roadmap-parser.js` | `:151` | `cells[columnLayout.codeCol] ?? '—'`, fed to `isFeatureCode` at `:171` |
| `lib/roadmap-preservers.js` | `:167-169` | `codeCell.toUpperCase()` fed to `FEATURE_CODE_RE_STRICT` |
| `lib/feature-validator.js` | `:219` | `cols[codeIdx].replace(/\*/g,'').replace(/`/g,'').trim()` |
| `lib/roadmap-residue.js` | `:139` | `isFeatureCode(cells[columnLayout.codeCol] ?? '')` |
| `lib/feature-writer.js` | `:927` | `setRoadmapRowStatus`'s own row scan, the same strip expression |
| `lib/feature-write-guard.js` | `:121` | `scanRoadmapRows` (`:99`), the same strip expression again |

`lib/feature-write-guard.js` needs a second change beyond the shared reader: `knownFeatureCodes`
(`:137`) unions feature folders, ROADMAP rows and vision-state items, and it scans **one** roadmap
(`for (const code of scanRoadmapRows(paths.roadmap))`, `:154`). Once rows live in two documents it
must scan **both**, or every archived feature drops out of the known set and
`assertLinkTargetsExist` (`:183`) starts refusing links to completed work. `stripAnchors` stays
exported from `lib/roadmap-documents.js` for the renderer's own use only; **`parseCodeCell` is what
all six readers call**, and no reader calls `stripAnchors` alone (R2-10).

**The feature anchor goes on the FIRST item row only (R1-11).** An item-bearing feature renders one
row per item, each repeating `f.code` in the code cell (`lib/roadmap-gen.js:437-443` in
`renderPhase`, and `:373-379` in `renderTableLines`). Emitting the anchor on every one produces a
duplicate HTML id, which makes the fragment link ambiguous and the anchor unusable. The renderer
emits `anchorCell(f.code)` for a feature's first row and the bare code for the rest.

**`## Moved` is excluded from every preserved-content reader (R1-3).** A new exported constant
`MOVED_HEADING = 'Moved'` in `lib/roadmap-documents.js` is checked by `readPhaseBlocks`
(the heading branch at `lib/roadmap-preservers.js:312`), `readPhaseOrder` (`:355`),
`readPhaseOverrides` and the anonymous-row scan, all of which key off
`PHASE_HEADING_TEXT_RE` (`lib/roadmap-heading.js:42`). Without the exclusion the generated section
is read back as a source-only phase block, re-emitted verbatim by
`lib/roadmap-gen.js:129-143` **and** regenerated by the renderer, so every pass doubles it. The
section is parsed by exactly one reader, `parsePriorRedirects` (S01-2).

---

## 3. Slice S01 — pure partition, document set, anchors and links

S01 is entirely pure plus one preserver reader. It writes no files, takes no lock and touches no
producer. Everything below is I/O-free and testable from string fixtures, which is what makes the
crash matrix in S02 cheap.

### S01-1 `lib/roadmap-archive.js` (new)

```js
export const ARCHIVE_ACTIVE_STATUSES   = Object.freeze(new Set(['PLANNED', 'IN_PROGRESS', 'PARTIAL', 'BLOCKED']));
export const ARCHIVE_INACTIVE_STATUSES = Object.freeze(new Set(['COMPLETE', 'PARKED', 'SUPERSEDED', 'KILLED']));
export const ARCHIVE_DIAGNOSTIC_CODES  = Object.freeze({ /* the five codes of §2.6 */ });
export const ANON_KEY_SEP = '\u001f';   // UNIT SEPARATOR - never a NUL byte

export function anonRowKey(documentId, phaseIdentity, rawLine, ordinal);   // → string (adjudication C, R1-4)
export function normalizeAnonRawLine(rawLine);                       // → string  (whitespace + anchors collapsed)
export function featureAnchorId(code);                               // → string  (the code, verbatim)
export function phaseAnchorId(phaseIdentity, used);                  // → string  (sectionSlug grammar)
export function placementForStatus(statusToken);                     // → 'active' | 'archive' | null
export function partitionRoadmap({ features, preservedByDocument, priorRedirects, previousPlacement, policy });  // → PartitionResult (§2.6)
export function nextRedirects({ priorRedirects, movedOutOf, holdsAuthoritative });   // → RedirectEntry[] (R1-3)
```

`ARCHIVE_INACTIVE_STATUSES` is its own const (adjudication A). A one-line comment names the two sets
it must not be confused with — `SKIP_STATUSES` (`lib/roadmap-parser.js:18`, which adds BLOCKED) and
`DROP_STATUSES` (`lib/roadmap-graph/model.js:12`, which omits PARKED).

`partitionRoadmap` inputs:

- `features` — canonical `feature.json` objects, exactly what `provider.listFeatures()` returns.
- `preservedByDocument` — `Map<documentId, { phaseOverrides, anonymousRows, phaseBlocks, phaseOrder,
  preservedSections, sectionAnchors }>`, the six preserver reads
  (`lib/roadmap-preservers.js:39`, `:83`, `:272`, `:334`, `:204`, `:378`) run **once per document**
  and never flat-merged (R1-4, §2.6). Phase order across the set is the active document's order
  followed by archive-only identities in their archive order.
- `priorRedirects` — `Map<documentId, RedirectEntry[]>` parsed from each document's own `## Moved`
  section by `parsePriorRedirects` (S01-2). Feeds the union/minus algebra of §2.6 (R1-3).
- `previousPlacement` — the placement map derived from the current bytes, used only to compute
  `moved` and therefore the redirect sets. Absent on a first partition, in which case `moved` is the
  full archive set (every archived row is "newly moved") and every active document redirect is
  emitted once.
- `policy` — `{ inactive: ARCHIVE_INACTIVE_STATUSES, documents: ['active', 'archive'] }`. This is the
  seam COMP-ROADMAP-SHARD later extends with size and per-phase policies; v1 passes the pair and
  nothing else.

Placement rules, in evaluation order, one authority per row kind (design Behavior 1):

1. **Managed feature** — placed by `feature.status`. All its rows travel with it, item rows included,
   for free (adjudication V: item rows are rendered from `items[]`, `lib/roadmap-gen.js:373`, not
   preserved). A PARTIAL parent with COMPLETE items stays active. A status outside the 8-value enum
   emits `ARCHIVE_UNKNOWN_STATUS_TOKEN` and leaves the feature active.
2. **Anonymous preserved row** — placed by `readAnonymousRowStatus(rawLine, layout)` (S01-3). No
   recognised token: stays where it is, `ARCHIVE_ANON_ROW_NO_STATUS`.
3. **Source-only phase block with rows** — moves whole when **every** row in it is inactive; one
   active row keeps the whole block active.
4. **Source-only phase block with no rows** — placed by `parseStatusToken` over the raw override
   tail from `readPhaseOverrides` (C25). No tail, or an unrecognised one: stays where it is,
   `ARCHIVE_PHASE_HEADING_NO_STATUS`.
5. **Body prose never classifies anything.** Prose is carried by the phase block that owns it.

Phase ownership (design Behavior 3): for each phase identity, if it has any active row the owner is
`active` and `mixed` is true when it also has an inactive row; if every row is inactive the whole
phase moves and `mixed` is false. `phaseOwnership` is what the renderer consults; the placement map
never decides a heading on its own.

Collision detection (design Behavior 6): if a code appears as an authoritative row more than once —
same document or across the two — the partition emits `ARCHIVE_DUPLICATE_AUTHORITATIVE_ROW` and
places the feature by its **canonical status**, so the next render repairs the document. The
partition never throws on it; the validator reports it (S03).

### S01-2 `lib/roadmap-documents.js` (new)

```js
export const DOCUMENT_IDS = Object.freeze(['active', 'archive']);
export const MOVED_HEADING = 'Moved';                         // phase identity, for reader exclusion
export const MOVED_SECTION_HEADING = '## Moved';

export function stripAnchors(cell);                           // → string
export function anchorCell(code);                             // → '<a id="CODE"></a>CODE'
export function readPreservedByDocument(documents);           // → Map<documentId, {six preserver reads}> (R1-4)
export function parsePriorRedirects(text);                    // → RedirectEntry[] (R1-3)
export function renderDocumentSet({ partition, documents, features, opts });  // → { active, archive, diagnostics }
export function renderMovedSection(entries, opts);            // → string ('' when entries is empty)
export function rewriteCrossDocumentLinks(text, { self, other, placement });   // → string
export function documentRelativeLink(fromPath, toPath);       // → string
```

`renderDocumentSet` is the ordered-document-set loader the design promises SHARD will extend
(Revision note 4). It composes rather than reimplements: for each document it selects the features
and preserved content the partition assigned to it, calls `generateRoadmapDocument` (S01-4), then
appends the `## Moved` section and applies `rewriteCrossDocumentLinks`. It is pure — `documents`
carries the two current texts and the two resolved paths, supplied by the caller.

`renderMovedSection` emits nothing when the entry set is empty, so a project with no archived work
has a byte-identical active document to today plus per-row anchors.

`parsePriorRedirects` is the **only** reader of `## Moved`. It matches the generated line shape of
§2.7 and returns those entries; anything else under that heading is dropped with
`ARCHIVE_REDIRECT_ORPHAN`. Every other preserved-content reader excludes the section by
`MOVED_HEADING` (§2.7, R1-3), so it is never both preserved and regenerated.

`loadDocumentSet` and the pure set renderer live in `lib/roadmap-publish.js` (S02-3), so a read
never touches the lock or the repair path (R1-2); `roadmap-documents.js` stays pure composition.

`rewriteCrossDocumentLinks` rewrites inline `[text](ROADMAP.md#ANCHOR)` and reference-style
`[text]: ROADMAP.md#ANCHOR` links **inside the two documents only** (design Behavior 5: no other
files are scanned or edited). A link whose anchor names a feature now in the other document is
repointed at that document; a link to an anchor in neither is left untouched.

`stripAnchors` is the renderer's own low-level helper — regex `/<a\s+id="[^"]*"\s*><\/a>/g`,
applied before trimming. It is **not** what the readers call: all six code-cell sites of §2.7 call
`parseCodeCell` (R1-11, R2-10), which composes the anchor strip with the `**` and backtick strip
those sites already perform. A reader that strips anchors but not the other two decorations still
mis-reads a bolded or backticked cell, which is a live shape in this corpus.

### S01-3 `lib/roadmap-preservers.js` (edit)

- New export `readAnonymousRowStatus(rawLine, layout)` (adjudication D): splits with
  `splitRoadmapCells` (`lib/roadmap-parser.js:38`), takes the **last** cell, strips `**` and
  anchors, and returns `parseStatusToken(cell)` or `null`. Works for both the 3-col
  `| # | Item | Status |` shape (`ROADMAP.md:28`) and the 4-col feature shape, because in both the
  status is the last column — the same assumption `detectColumnLayout` already makes
  (`lib/roadmap-parser.js:198-217`, `statusCol: lower.length - 1` in every branch).
- `readAnonymousRows` (`:83`) row objects gain two fields, additive:
  `{ rawLine, predecessorCode, status, ordinal }`, where `status` is the above and `ordinal` counts
  identical normalized raw lines within one phase (adjudication C). Existing consumers read only
  `rawLine` and `predecessorCode` (`lib/roadmap-gen.js:363`, `:399`, `:426`) and are unaffected.
- `readAnonymousRows`' code-column detection (`:140-147`) and the code-cell read at `:167`
  (`const codeCell = cells[codeColIdx] ?? '';`, fed to `FEATURE_CODE_RE_STRICT` at `:169`) use
  **`parseCodeCell`**, not `stripAnchors` (R2-10). This is one of the six sites of §2.7 and is the
  one most easily missed, because it lives in the preservers rather than in a parser.

### S01-4 `lib/roadmap-gen.js` (edit)

New export `generateRoadmapDocument(baseText, features, opts)` — `generateRoadmapFromBase` (`:56`)
with two additional `opts` fields and no behavior change when they are absent:

| opt | Meaning |
|---|---|
| `documentRole` | `'active'` or `'archive'`; drives the mixed-phase back-link line and suppresses the generated `## Key Documents` block (`:189-192`, `buildKeyDocs` `:491`) in the archive |
| `partition` | the `PartitionResult`; selects which features, anon rows and phase blocks this document renders, and which phases render a heading at all |

`generateRoadmapFromBase` keeps its current signature and delegates
(`generateRoadmapDocument(baseText, features, opts)` with no `partition` renders exactly today's
bytes plus anchors). The anchor is added in the two row renderers, `renderTableLines` (`:353`,
non-item row at `:393`, item rows at `:373-379`) and `renderPhase` (`:406`, item rows at
`:437-443`), by wrapping the code cell in `anchorCell`. **In both item loops the anchor is emitted
on the feature's first row only**, and the remaining item rows carry the bare code (R1-11);
otherwise a feature with N items mints N identical HTML ids. `escCell` (`:26`) is applied to the
description only, as today, so the anchor markup is never escaped.

Per-table column layout (adjudication E) is unchanged in mechanism — `hasSubItems` stays
`features.some(...)` (`:354`, `:416`) — but is now evaluated over **the features this document
renders for this phase**, which is what makes it "per rendered table". It is a pure function of the
partition, so the second pass is byte-stable.

The drift emit (`:151`) is untouched and still gated on `cwd && !opts.suppressDrift`.

### S01-5 Tests — `test/roadmap-archive.test.js` (new)

Fixture helper: `test/helpers/roadmap-set-fixture.js` (new), exporting
`makeRoadmapSet({ active, archive, features, config })` which returns
`{ root, activePath, archivePath, cleanup }` over `mkdtempSync(join(tmpdir(), 'roadmap-set-'))`,
writing `.compose/compose.json` with `paths` and `roadmap.archive`. It follows the shape of
`makeWorkspace` in `test/completion-gate.test.js:38` and `makeNarrative` in
`test/get-roadmap.test.js:36`. Every slice below reuses it **by that name**.

| Test name | Asserts |
|---|---|
| `partition places a managed feature by its canonical status, never by its row` | a COMPLETE feature whose row still reads PLANNED lands in `archive`; the reverse case lands in `active` |
| `BLOCKED is active and PARKED is archived` | pins `ARCHIVE_INACTIVE_STATUSES` against `SKIP_STATUSES` and `DROP_STATUSES` by importing all three and asserting the set differences |
| `item rows travel with a PARTIAL parent` | a PARTIAL feature with two COMPLETE items renders all three rows in `active`; flipping the parent to COMPLETE moves all three |
| `an anonymous row is placed by its own last cell` | the literal `\| — \| Discovery, requirements, PRD, UI-BRIEF \| COMPLETE \|` from `ROADMAP.md:30` archives out of a 3-col table |
| `an anonymous row with no recognised token stays put and warns` | `ARCHIVE_ANON_ROW_NO_STATUS`, placement unchanged |
| `identical anonymous rows in one phase get distinct keys` | two byte-identical rows yield ordinals 0 and 1 and both survive a round trip |
| `a rowless SUPERSEDED phase archives, a rowless PLANNED phase stays` | the two real headings, `ROADMAP.md:123` and `:411`, including the `SUPERSEDED by STRAT-1` tail through `parseStatusToken` |
| `a source-only block with one active row does not move` | whole-block rule |
| `a mixed phase keeps heading and prose active and renders a back-link in the archive` | the exact `_Active rows: see …_` line, and that the prose block appears **once** across the set |
| `when the last active row leaves, the whole phase moves and a redirect remains` | phase redirect line present in active, heading absent from active |
| `park, restore, park leaves one row and one redirect` | three successive partitions; asserts exactly one authoritative row and exactly one `## Moved` line for the code at each step |
| `duplicate authoritative rows are reported, not guessed` | same code twice in one document, and once in each document; `ARCHIVE_DUPLICATE_AUTHORITATIVE_ROW` in both cases; canonical status decides placement |
| `in-document links are rewritten, links elsewhere are not` | an inline and a reference-style link to a moved code repoint; a link to an unknown anchor is byte-identical |
| `anchors survive every code-cell reader` | the same anchored row parses to the same code through `parseRoadmap`, `readAnonymousRows`, the validator scan and `classifyLines` |
| `a set with nothing inactive renders no Moved section` | archive document is the empty-set render; active differs from today only by anchors |
| `park/restore/park with an unchanged pass in between keeps one redirect` | R1-3: four passes, the third changing nothing; after each, exactly one authoritative row and exactly one `## Moved` line for the code; pass 4 is byte-identical to pass 2 |
| `the Moved section is never read back as a phase block` | R1-3: two consecutive renders; neither `readPhaseBlocks` nor `readPhaseOrder` contains `Moved`; the section appears exactly once |
| `preserved content is keyed per document` | R1-4: the same phase identity with different prose in each document; the active prose survives and the archive back-link is regenerated, not preserved |
| `an item-bearing feature carries exactly one anchor` | R1-11: three items, one `<a id=` occurrence for the code |
| `parseCodeCell reads an anchored, bolded, backticked cell` | R1-11: one function, the six call sites' inputs |

**Acceptance criteria covered by S01** (design.md list):

- [ ] A mixed-status phase keeps heading and prose in the active document and renders inactive rows
      under the same heading in the archive with a link back; when its last active row leaves, the
      whole phase moves.
- [ ] A feature with item-level rows and a PARTIAL parent stays entirely active; when the parent
      completes, all its rows move together.
- [ ] Anonymous preserved rows and source-only phase blocks are placed by their own status column.
- [ ] A rowless SUPERSEDED phase block lands in the archive and a rowless PLANNED one stays active.
- [ ] A transition back to an active status restores the row, leaving one row and at most one
      redirect (the rendering half; the writer half is S04).

---

## 4. Slice S02 — durable publication

S02 turns S01's pure render into a crash-safe two-document publication. It is the only slice that
writes documents.

### S02-1 `lib/durable-write.js` (new) — adjudication J

Move `fsyncDirectory` (`lib/consumer-fanout.js:54-62`) and `durableWriteJson` (`:64-77`) verbatim
into a new module and export them, plus one addition:

```js
export function fsyncDirectory(path);
export function durableWriteJson(path, value);
export function durableWriteText(path, text);   // same open('wx',0o600) + fsync + rename + dir fsync, bytes not JSON
export function sha256OfFile(path);             // → 64 lowercase hex, or null when the file is absent
export function sha256OfString(text);           // → 64 lowercase hex
```

`lib/consumer-fanout.js` imports the two moved functions instead of defining them; its three call
sites (`:325`, `:353`, `:365`) are untouched. This is the strongest existing precedent in the repo
and the explicit non-model is the gate's tmp-then-**copy** (`lib/completion-gate.js:135-137`, C11).

### S02-2 Paths and config (edit)

- `lib/paths-core.js:11` — `DEFAULT_PATHS` gains `archive: 'ROADMAP-ARCHIVE.md'`. Frozen object,
  so the addition is a literal edit.
- `lib/project-paths.js` — new `resolveArchivePath = (cwd) => resolveKey(cwd, 'archive')` beside
  `resolveRoadmapPath` (`:30`) and `resolveArchivePathFromConfig` beside `:37`.
- `lib/roadmap-config.js` — new exports beside `isNarrativeOwned` (`:23`) and
  `narrativeOwnedMessage` (`:42`):

```js
export function isArchiveEnabled(cwd);            // roadmap.archive === true; false on malformed config
export function archiveActive(cwd);               // isArchiveEnabled(cwd) && isLocalTrackerConfig(cwd)
export function loadRoadmapSetConfig(cwd);        // → { enabled, activePath, archivePath, stateDir, lockPath }
```

`archiveActive` **imports** `isLocalTrackerConfig` from `lib/tracker/factory.js` (§2.2) and never
restates the provider-kind rule. This module is the only place the conjunction is formed, and the
factory is the only place the provider half is decided.

`loadRoadmapSetConfig` throws `ROADMAP_ARCHIVE_PATH_COLLISION` when the two resolve to one path
(§2.2). It is the single place either path is resolved, so no caller open-codes the pair.

- `bin/compose.js:423-446` — `compose init` writes `paths.archive` and the `roadmap` sub-object
  (§2.2), keeping the `...existing` (`:427`) and `...(existing.paths || {})` (`:445`) spreads.

### S02-3 `lib/roadmap-publish.js` (new) — the service

```js
export const PUBLISH_INTENT_VERSION = 1;
export const BASELINE_MANIFEST_VERSION = 1;

// --- the transaction API: the ONLY way canonical state is mutated (R1-1) ---
export async function withRoadmapSet(root, fn, opts = {});    // → { result, publish: PublishResult }

// --- pure reads: no lock, no repair, no sweep, no write, no event (R1-2) ---
export function loadRoadmapSet(root);                         // → LoadedSet
export function renderRoadmapSet(loaded, features, opts = {}); // → { active, archive, partition, diagnostics }

// --- state readers and the service internals ---
export function readPublishIntent(root);                      // → intent | null  (null ONLY on ENOENT)
export function readBaselineManifest(root);                   // → manifest | null (null ONLY on ENOENT)
export function roadmapSetLockPath(root);                     // → <root>/.compose/data/locks/roadmap-set.lock
export async function publishRoadmapSet(root, opts = {});     // → PublishResult  (used by `roadmap generate`)
export async function repairPendingPublication(root, opts);   // → { repaired, operationId, conflicts }
```

**The lock must span repair, canonical mutation and publication as one transaction (R1-1).** The
first draft had every producer call the service once before its canonical write and once after. That
leaves the lock **released between the two calls**, so a second producer can repair, mutate and
publish inside the window — and the first producer's post-call then renders from features it never
saw, or republishes over the second's bytes. The pre/post pattern is withdrawn. In its place:

```js
const { result, publish } = await withRoadmapSet(root, async (tx) => {
  // tx = { activePath, archivePath, features, intentRepaired, provider }
  await provider.persistFeatureRaw(code, updated);     // the caller's canonical write
  return updated;
}, { producer: 'set_feature_status' });
```

`withRoadmapSet`, in order, all under one `withDirLock(roadmapSetLockPath(root), …)`:

1. take the set lock;
2. repair any pending publication and sweep orphan staged files (steps 1 of the sequence below);
3. `await fn(tx)` — the caller's canonical mutation, and **only** that;
4. re-list features, render, baseline-check, stage, intent, rename, baseline, clear;
5. release.

So canon is never mutated on top of an unfinished publication, and no other writer can interleave
between the mutation and its projection. **`fn` must never call the service** — `withDirLock` is not
reentrant (`lib/dir-lock.js:154`) and a nested call deadlocks until the acquire timeout. `fn` is
also the only place a caller may write canonical state; anything it throws propagates with the lock
released and **no** publication attempted, which is what preserves `setFeatureStatus`'s existing
refusal semantics.

**Lock order is a three-level total order, and the idempotency lock is the outermost (R2-2).**

| Level | Lock | Path | Taken by |
|---|---|---|---|
| 1 (outermost) | idempotency | `lib/idempotency.js:138` (`acquireLock(cwd)` inside `checkOrInsert`) | `maybeIdempotent` (`lib/feature-writer.js:145`), `recordCompletion` (`lib/completion-writer.js:343`) |
| 2 | per-feature | `.compose/data/locks/completion-<CODE>` (`lib/completion-gate.js:311`), `.compose/data/locks/feature-<CODE>.lock` (`lib/completion-writer.js:65`) | the gate, the completion writer |
| 3 (innermost) | roadmap-set | `.compose/data/locks/roadmap-set.lock` | `withRoadmapSet`, `publishRoadmapSet` |

**Never acquire upward.** The first draft's wiring made that possible in both directions and could
deadlock: `recordCompletion` takes the idempotency lock (`lib/completion-writer.js:343`) and then a
feature lock, while an idempotency-keyed `setFeatureStatus` holds the idempotency lock
(`lib/feature-writer.js:145`) **while waiting for the set lock** — giving `idempotency → set` on one
side and `set → idempotency` on the other. The fix is a scoping rule, not a new lock:

> **The idempotency *wrapper* stays OUTSIDE `withRoadmapSet`; the completion *record* moves
> INSIDE it.** `maybeIdempotent` is never entered from within a transaction, and the transaction is
> always entered from within the feature lock.

So level 1 is never acquired from inside level 3, and the order holds on every path. Pinned by a test
that a backfill under an idempotency key completes without `DIR_LOCK_TIMEOUT` (S02-6).

**`recordCompletion` is split (R3-1).** Round 2 put the whole of `recordCompletion` outside the
transaction, which removed the deadlock and introduced a lost update: its read-modify-write of
feature.json reads the feature at `lib/completion-writer.js:351` and persists the merged object at
`:397`, while the transaction's `fn` independently reads at `lib/feature-writer.js:447`, builds
`updated` at `:498` and persists at `:508`. Two read-modify-write cycles on one file, interleaved,
and the second write wins — so a completion record or a status flip is silently dropped. The split:

| Part | Where it runs | What it is |
|---|---|---|
| idempotency wrapper | **outside** the transaction | `maybeIdempotent({ …args, cwd }, …)` (`lib/completion-writer.js:343`) plus the per-feature lock |
| `appendCompletionRecord(cwd, args)` | **inside** `withRoadmapSet`'s `fn`, under the feature lock | the read-modify-write at `:351-403`: read the feature, append to `completions`, `persistFeatureRaw` |

`appendCompletionRecord` is a **new named export** from `lib/completion-writer.js`. Both writes then
happen inside one `fn`, under one feature lock and one set lock, so there is exactly one
read-modify-write cycle per completion. The public `recordCompletion` keeps its signature, its
refusal semantics and its return shape; it is now the wrapper that opens the transaction and calls
the primitive inside it.

**Two in-lock source hooks, on opposite sides of the render (R3-2).** `transformDraft` is
**withdrawn**: it ran *after* the render, which is the wrong state for both of its intended callers.
`--protect` must wrap residue in the **base** so the generator re-renders from the protected source
(that is what `bin/compose.js:1327-1331` does today: `protectResidue(base, residue)` then
`checkRoundtrip(protectedBase, …)`), and a surgical row patch must **not be re-rendered at all**,
because `lib/feature-writer.js:870-880` exists precisely to say that a full render is unsafe on a
roadmap that is not already a fixed point. Two hooks, both pure and synchronous, both under the lock:

```js
// BEFORE the render: the service renders from what this returns.
protectBase(source: { active, archive }, residues) -> { active, archive }

// INSTEAD of the render: the service publishes what this returns, unrendered.
patchSource(source: { active, archive }) -> { docs: { active, archive }, result: any }
```

| Hook | Runs | Render | Used by |
|---|---|---|---|
| `protectBase` | before render | yes, from the returned base | `compose roadmap generate --protect` |
| `patchSource` | instead of render | **no** | `setRoadmapRowStatus`, `migrate-anon` |

When `patchSource` is present the service **skips the render entirely** and publishes the patched
current documents — still under the lock, still through the baseline check, the intent, the
preflight and the rename order. That is what makes a surgical edit durable without re-rendering a
document the generator would otherwise rewrite. Supplying both hooks is a programming error and
throws. Both receive strings and return strings, and neither may touch the filesystem or call the
service.

**The result channel (R3-4).** `withRoadmapSet` returns:

```js
{ result,        // whatever fn returned
  patch,         // whatever patchSource returned as its `result`, else null
  published,     // boolean: bytes were committed
  opId,          // the publication's operation id, or null
  diagnostics }  // partition + publication diagnostics
```

`patch` is how a `patchSource` producer gets its own verdict back out from under the lock.
`setRoadmapRowStatus` maps `patch.result` onto its existing contract
`{ code, changed, from?, to? }` (documented at `lib/feature-writer.js:891`), which
`lib/feature-reconciler.js:256-258` depends on — it reads `r.changed !== false`, so a
transaction that swallowed the verdict would make every reconcile report a change it did not make.

**Reads are pure and take no lock (R1-2).** `loadRoadmapSet` reads both documents' bytes, runs the
six preservers per document (R1-4), parses each `## Moved` section, and reads the intent — and does
**nothing else**: no lock, no repair, no orphan sweep, no baseline write, no drift event.
`renderRoadmapSet(loaded, features)` partitions and renders in memory. Together they are what
`get_roadmap`, `compose roadmap check`, the validator and the roundtrip use. `dryRun` is removed
from the service entirely: a "read" that takes a workspace-wide lock and repairs state on the way
past is not a read, and a reader that blocks for `LOCK_ACQUIRE_TIMEOUT_MS` (`lib/dir-lock.js:57`,
30s) behind a slow publication is a reader that times out.

**A lock-free read still needs a consistent snapshot (R2-9).** Taking no lock means a publication
can rename one document between the two `readFileSync` calls, handing the reader an active document
from after the commit and an archive from before it — a torn read that looks exactly like a
duplicate or a missing row. `loadRoadmapSet` therefore brackets its document reads with a
generation check:

```
read  (intent.operation_id, baseline.generation)   -> g0
read  active bytes, archive bytes
read  (intent.operation_id, baseline.generation)   -> g1
if (g0 !== g1) retry, at most 3 times; if still unequal, return { unstable: true }
```

The snapshot key is the pair `(intent operation_id or null, baseline generation or 0)` — **never
`updated_at`** (R3-3): two publications in one clock tick share a timestamp, and a backwards clock
makes the comparison meaningless. `generation` increments by one per publication (§2.5), so any
publication that lands between the two reads changes the pair. Three attempts is enough because a
publication's rename window is two `renameSync` calls; a reader that loses three times is contending
with a pathological write rate and should say so rather than guess. `unstable: true` is treated
exactly like `inFlight` by every reader (R1-10, R2-9, R3-6).

**Readers honour the same enable predicate as producers, and resolve it synchronously (R2-10,
R3-7).** `loadRoadmapSet(root)` calls `archiveActive(root)` **itself** and, when it is false, returns
a **single-document** set: the archive slot is empty, `priorRedirects` is empty, and every downstream
reader behaves exactly as it does today. Without the predicate, a GitHub-backed workspace that set
the flag would see a two-document model on the read side while its producers wrote one document, and
would report the archive as permanently missing.

The predicate cannot take a provider instance, because `providerFor` is **async**
(`lib/tracker/factory.js:78`) and both reader entry points are **synchronous**: `getRoadmap`
(`lib/get-roadmap.js:56`) and `loadValidationContext` (`lib/feature-validator.js:148`). Making either
async is a caller-wide ripple for a predicate that only needs the config. So the predicate is
resolved from configuration, synchronously, by `isLocalTrackerConfig` **exported from
`lib/tracker/factory.js`** — the module that already owns the provider-kind decision (§2.2).
`lib/roadmap-publish.js` imports it through `archiveActive`; it does not restate the rule.

`LoadedSet` is `{ documents: {active, archive}, preservedByDocument, priorRedirects, inFlight,
unstable, archiveActive }`, where `inFlight` is `null` or `{ opId, startedAt, producer, targets }`
read from the intent. Every reader surfaces `inFlight` and `unstable` rather than interpreting a
half-published or torn set (R1-10, R2-9).

`opts` for `withRoadmapSet` and `publishRoadmapSet`:
`{ producer, features, now, suppressDrift, protectBase, patchSource }` (R3-2).

`PublishResult`:

```js
{
  written: boolean,           // false when byte-stable, narrative-owned or archive-disabled
  skipped: 'narrative' | 'archive_disabled' | 'no_change' | null,
  operationId: string | null,
  activePath, archivePath,
  repaired: boolean,          // a pending publication was finished before this pass
  partition: PartitionResult, // includes archivedFeatureCount and diagnostics
  inFlight: boolean,          // an intent exists on return (only possible on a throw path)
  conflicts: Array<{ documentId, expected, actual, phase: 'repair'|'commit' }>,  // R1-7/R2-3, empty on success
}
```

`written`/`skipped` close C12: `writeRoadmap` returns the path whether it wrote or no-opped, so no
caller can tell today.

**Sequence**, all of it inside `withDirLock(roadmapSetLockPath(root), …)` (adjudication I):

```
0.  loadRoadmapSetConfig — throws on path collision.
    Narrative-owned (isNarrativeOwned, lib/roadmap-config.js:23) ⇒ return {written:false,
    skipped:'narrative'} without reading or writing anything.
    archiveActive(cwd, provider) false — flag off OR a non-local provider (R1-9, §2.2) ⇒ delegate to
    the single-document writeRoadmap path and return {written:…, skipped:'archive_disabled'}: the
    pre-flag behavior, byte for byte.
1.  REPAIR FIRST, AND FAIL CLOSED (R1-7, R2-3). readPublishIntent(root) — throws
    ROADMAP_SET_INTENT_CORRUPT on anything but ENOENT (§2.4). If an intent is present, run the
    NON-MUTATING PREFLIGHT below over EVERY target before renaming ANY of them; only if it passes
    for all of them, perform the renames in rename_order.

    PREFLIGHT(targets) — reads only, writes nothing:
      for each target: h = sha256OfFile(target.path)   (null when the file is absent)
        h === post_sha256 ⇒ already renamed; nothing needed for this target.
        h === pre_sha256  ⇒ needs renaming; its staged file must exist AND
                            sha256OfFile(target.staged) === post_sha256.
        anything else     ⇒ CONFLICT.
      Any conflict, or any needed staged file that is missing or hashes wrong ⇒ FAIL: rename
      NOTHING, KEEP the intent, emit ARCHIVE_REPAIR_CONFLICT (or
      ROADMAP_SET_INTENT_UNRECOVERABLE for a missing/mismatched staged file) naming the document
      and the two expected hashes, and throw.

    Verifying every target first is the whole point (R2-3): a per-target loop that renames as it
    goes will rename the archive and then discover the active document was hand-edited, leaving the
    set in a third state that is neither the pre-state nor the post-state and that the next repair
    cannot classify. Reading is free; renaming is not undoable.
    Only when the preflight passed and every rename succeeded: update the baseline from the intent's
    post hashes, clear the intent, sweep staged files. Set repaired = true.
    If no intent: sweep orphan staged files (step 9's rule) from BOTH target directories (R1-12).
2.  RENDER. Read both documents' current bytes; run the six preservers over each; partitionRoadmap;
    renderDocumentSet. Pure — no writes, no drift events (suppressDrift is honoured).
3.  BASELINE CHECK. readBaselineManifest. For each document with a recorded hash, compare against
    the current on-disk bytes. Mismatch ⇒ throw ROADMAP_SET_BASELINE_MISMATCH naming the document
    and the two hashes; nothing written. No manifest ⇒ skip the check (first publication).
4.  NO-CHANGE SHORT CIRCUIT. If both rendered documents equal the current bytes, update nothing and
    return {written:false, skipped:'no_change'}. This is the byte-stability guarantee
    (design Behavior 7); it must run BEFORE staging so a second pass writes zero bytes, including
    zero bytes of intent.
5.  STAGE. durableWriteText both rendered documents into `<dir of target>/.<basename>.staged-<opId>`
    — beside their targets, never under the state directory, so the commit rename is always
    same-filesystem and can never fail EXDEV (R1-12, §2.3).
6.  INTENT. durableWriteJson the §2.4 record. This is the commit point: after it, the publication is
    guaranteed to complete on some later call.
7.  PREFLIGHT AGAIN, THEN RENAME (R2-3). Re-run the same non-mutating preflight over both targets
    immediately before the first rename — the render, the baseline check and the staging all took
    real time under the lock, but the lock does not stop a process outside compose from editing a
    document, and `LOCK_STALE_MS` (`lib/dir-lock.js:55`) means even a compose process can lose the
    lock mid-pass. Pass ⇒ rename in rename_order: archive first (design.md:215), then active.
    Fail ⇒ emit the conflict with phase 'commit', rename nothing, clear the intent and the staged
    files (nothing was committed, so there is nothing to resume), and throw.
8.  BASELINE. durableWriteJson the §2.5 manifest from the post hashes.
9.  CLEAR. Remove the intent, then sweep the staged files from both target directories.
    The sweep matches ONLY the two resolved basenames' escaped prefixes — for `paths.roadmap`
    `ROADMAP.md` and `paths.archive` `ROADMAP-ARCHIVE.md`, that is `.ROADMAP.md.staged-*` and
    `.ROADMAP-ARCHIVE.md.staged-*`, with every regex metacharacter in the basename escaped. It is
    NEVER a bare `.*.staged-*` glob (R2-8): an external document root is a shared directory that may
    hold other projects' roadmaps, and a broad glob would delete another workspace's in-flight
    staged bytes — turning a crash there into an unrecoverable intent.
```

Steps 5–6 are the ordering the design fixes (design.md:212-216, round-2 finding): the staged bytes
exist before the intent names them, so an intent is never a promise about bytes that were never
written.

**Repair is the service's own concern** (design.md:176-182). It is step 1 of `withRoadmapSet`, so
it runs before the caller's `fn` performs any canonical write and under the same lock — canon is
never changed on top of an unfinished publication, and the repair cannot be raced by a second
producer between the two (R1-1). It is independent of the completion gate's intent, and of the
live/backfill asymmetry (C5).

**Lock nesting.** The gate holds `completion-<CODE>` (`lib/completion-gate.js:311`) across its
render (`:494`), so the set lock nests inside it — different paths, no deadlock (C10). `withDirLock`
is not reentrant, so neither `withRoadmapSet` nor `publishRoadmapSet` may be called from inside a
`fn`, and the internal helpers all take the already-rendered state as arguments. The heartbeat
caveat (`lib/dir-lock.js` header) applies: rendering compose's own 1598-line roadmap is synchronous,
so `LOCK_STALE_MS` (`:55`, 20000) is the budget the golden flow measures against, and it now covers
the caller's `fn` as well — which is why `fn` is restricted to the canonical write and nothing else.

### S02-4 `lib/tracker/local-provider.js` (edit)

```js
async renderRoadmap() {
  const { publishRoadmapSet } = await import('../roadmap-publish.js');
  const r = await publishRoadmapSet(this.cwd, { producer: this.producerTag ?? 'provider' });
  return r.activePath;
}
```

Returns the active path, preserving the existing contract (`:100-102` returns `writeRoadmap`'s
path). The dynamic import mirrors how `lib/completion-gate.js:318` imports `feature-writer.js` and
keeps `local-provider.js`'s module-load surface unchanged.

`renderRoadmap()` is the **compatibility** entry point, for callers this feature does not rewrite
and for the archive-disabled path. It publishes but does **not** bracket a canonical write, so it
takes and releases the lock on its own. Every producer S04 touches calls `withRoadmapSet` instead
and does not reach this method (R1-1). `archiveActive` is false for `GitHubProvider` by
construction (R1-9), so the remote provider never enters the set path at all.

### S02-5 `lib/tracker/github-provider.js` (edit) — one log line

`renderRoadmap` (`:517-544`) is otherwise **unchanged** (design Revision note 3). Immediately before
the `getContents` call (`:522`) it logs once per process:

```js
console.warn('[github-provider] roadmap archival is local-only until COMP-ROADMAP-ARCHIVE-GH; publishing a single ROADMAP.md');
```

Parity is deferred explicitly, not silently skipped.

### S02-6 Tests — `test/roadmap-archive-recovery.test.js` (new)

Reuses `makeRoadmapSet` from `test/helpers/roadmap-set-fixture.js`. Crash injection is by calling
the service's internal steps through an exported `_internals` object (the pattern
`lib/feature-writer.js:1243` and `lib/followup-writer.js:549` already use), never by killing a
process.

| Test name | Asserts |
|---|---|
| `intent shape is stable` (contract) | every §2.4 invariant: target order, rename order, post hashes equal the staged bytes, operation id in both staged names |
| `baseline manifest records post-write hashes` | §2.5 shape; hashes equal the files on disk after a successful publish |
| `a second pass with no state change writes no bytes` | mtime **and** sha256 of both documents unchanged; no intent written; `skipped === 'no_change'` |
| `crash after staging leaves orphans and no intent` | both documents unchanged, staged files present **in the target directories**, next call sweeps them and publishes cleanly (R1-12) |
| `staged files are written beside their targets` | R1-12: with `paths.archive` in a different directory, each staged path shares a directory with its target; no staged file under `.compose/data/roadmap-set/` |
| `a hand edit during an interrupted publication is a conflict` | R1-7: stop after the intent, edit the active document, next call throws with `ARCHIVE_REPAIR_CONFLICT`, renames nothing, keeps the intent, and leaves the hand edit intact |
| `a corrupt intent fails closed` | R1-7: truncated JSON and an unknown `version`; `ROADMAP_SET_INTENT_CORRUPT`; both documents and the intent byte-identical |
| `a corrupt baseline fails closed` | R1-7: `ROADMAP_SET_BASELINE_CORRUPT`; nothing written |
| `the transaction holds the lock across the canonical write` | R1-1: a second `withRoadmapSet` started while the first's `fn` is suspended does not acquire until the first completes; the second's render sees the first's write |
| `a throw inside fn publishes nothing` | R1-1: the caller rolls back as today, the lock is released, no intent and no staged file remain |
| `loadRoadmapSet takes no lock and writes nothing` | R1-2: called while another transaction holds the set lock, it returns immediately; event log, baseline, intent and both documents byte-identical |
| `a backfill under an idempotency key completes without DIR_LOCK_TIMEOUT` | R2-2: the lock-cycle regression test. `backfillGate` with an `idempotency_key`, concurrent with an idempotency-keyed `setFeatureStatus`; both resolve, neither throws `DIR_LOCK_TIMEOUT` |
| `the transaction never opens around the idempotency lock` | R2-2: a static assertion that no `withRoadmapSet` call site encloses `recordCompletion` or `maybeIdempotent`, plus a runtime assertion on lock-acquire order |
| `repair verifies every target before renaming any` | R2-3: two targets, the second hand-edited; the first is **not** renamed either; both documents and the intent unchanged |
| `a staged file whose hash is wrong blocks the whole repair` | R2-3: corrupt one staged file; nothing renamed, intent kept, `ROADMAP_SET_INTENT_UNRECOVERABLE` |
| `the commit re-verifies immediately before renaming` | R2-3: edit a target between staging and the rename; conflict with `phase: 'commit'`, nothing renamed, intent and staged files cleared |
| `the orphan sweep only matches this workspace's basenames` | R2-8: a foreign `.OTHER.md.staged-xyz` in a shared external document root survives every sweep |
| `a torn read is retried and then reported unstable` | R2-9: renames injected between the two document reads; `unstable: true` after three attempts, and no partial set is returned |
| `readers see one document when the predicate is false` | R2-10: flag on, `tracker.provider: 'github'` in config; `loadRoadmapSet` returns an empty archive slot and `get_roadmap` reports no archive path |
| `one read-modify-write per completion` | R3-1: a completion concurrent with a transition; both the completion record and the status flip survive, and feature.json was written once per cycle |
| `appendCompletionRecord refuses outside a transaction` | R3-1: called without the locks held, it throws rather than writing |
| `protectBase runs before the render` | R3-2: the protected markers are present in the rendered output and survive a second pass |
| `patchSource skips the render entirely` | R3-2: a document that is NOT a fixed point is published with only the patched cell changed; the generator did not rewrite it |
| `supplying both hooks throws` | R3-2 |
| `baseline generation increments once per publication` | R3-3: N publications yield generation N; two publications inside one clock tick are still distinguishable |
| `the snapshot compares generation, not updated_at` | R3-3: a forced identical `updated_at` across two publications is still detected |
| `withRoadmapSet returns the patch result` | R3-4: `patch.result` round-trips `{ code, changed, from, to }` |
| `checkRoundtripSet short-circuits on unstable` | R3-6: null verdicts, no diffs |
| `roadmap check exits 2 on unstable with a retry message` | R3-6: distinct message from the in-flight one; nothing written |
| `isLocalTrackerConfig is the factory's own export` | R3-7: absent file, absent `tracker`, `provider: 'local'`, `provider: 'github'`, and a malformed `compose.json` propagating `TrackerConfigError`. Plus a grep assertion that `lib/roadmap-config.js` reads no `tracker` key of its own, so the rule exists once |
| `archiveActive is synchronous` | R3-7: `getRoadmap` and `loadValidationContext` stay sync; neither returns a Promise |
| `crash after intent is repaired by the next call, exactly once` | both renames applied, baseline updated, intent gone, staged swept; a third call reports `no_change` |
| `crash after the archive rename is repaired` | archive already matches its post hash and is not re-renamed; active is |
| `crash after the active rename is repaired` | both match; only baseline + clear remain |
| `a hand edit fails the baseline check and writes nothing` | `ROADMAP_SET_BASELINE_MISMATCH`, both documents byte-identical to the hand-edited state |
| `two concurrent completions produce one consistent set` | two `publishRoadmapSet` promises raced; both resolve, exactly one row per code, no interleaved bytes, one baseline |
| `a refused completion retry is still followed by repair` | the live gate's refusal path (C5) leaves the service intent; the next `setFeatureStatus` on **another** feature repairs it |
| `path collision is refused at load` | `roadmap.archive` pointing at `paths.roadmap`; `ROADMAP_ARCHIVE_PATH_COLLISION`; nothing read |
| `narrative-owned workspace is untouched and creates no archive` | `skipped === 'narrative'`, archive file absent, active byte-identical |
| `archive disabled renders exactly today's single document` | byte-identical to `writeRoadmap` output on the same fixture |
| `an external document root resolves both paths and links relatively` | `paths.roadmap` and `paths.archive` outside the workspace; redirect links resolve |
| `durableWriteText survives a mid-write crash` | a partial temp file never replaces the target |

**Acceptance criteria covered by S02:**

- [ ] A crash injected after the intent write, after the archive write and after the active write is
      repaired by the next service call exactly once.
- [ ] Two concurrent completions through the per-workspace lock produce one consistent document set.
- [ ] A second pass changes no bytes.
- [ ] A narrative-owned workspace is untouched: the writer keeps refusing, and no archive is created.

---

## 5. Slice S03 — set-aware parse, roundtrip, residue, validator, phase identity

S03 makes the four readers that move with the writer (design.md:104-110) understand a set instead of
a file. Nothing here writes.

### S03-1 Phase identity unification (adjudication B) — `lib/feature-validator.js`

`lib/feature-validator.js:181` is today:

```js
const phaseMatch = rawLine.match(/^##\s+(.+?)(?:\s+—\s+.+)?$/);
```

which splits on the **first** em-dash, so `## Wave 6 — Situational Awareness — COMPLETE` yields the
phase id `Wave 6` here and `Wave 6 — Situational Awareness` from `splitPhaseHeading`
(`lib/roadmap-heading.js:76`, rightmost boundary at `:79`). It becomes:

```js
const headingMatch = rawLine.match(PHASE_HEADING_TEXT_RE);          // lib/roadmap-heading.js:42
const phaseId = headingMatch ? splitPhaseHeading(headingMatch[1]).title : phaseId;
```

This is a **latent bug fix**, independent of archival: the duplicate-phase detector
(`runDuplicatePhaseHeadingCheck`, `:776`) and `ORPHAN_PHASE` (`:1258-1272`, which already reads
`readPhaseOrder` and therefore `splitPhaseHeading`) currently key on two different identities in the
same function. Pinned by a test using a two-em-dash heading. After it, all four readers of C26 agree,
which is what makes "the same phase identity in both documents is the mixed case" implementable.

### S03-2 `lib/roadmap-parser.js` (edit)

- `:151` — `const code = parseCodeCell(cells[columnLayout.codeCol] ?? '—');` so the anchored cell
  resolves to the bare code before `isFeatureCode` at `:171`. `parseCodeCell` comes from
  `lib/roadmap-heading.js`, which this module already re-exports from (`:14`), so no new dependency
  edge is created (R1-11).
- No change to `SKIP_STATUSES` (`:18`), `detectColumnLayout` (`:195`) or `filterBuildable` (`:241`).
  The design's inactive set lives in `lib/roadmap-archive.js` and is never merged with this one
  (adjudication A).
- `position` stays a global per-document counter (`:174-178`). Cross-document anonymous identity is
  `anonRowKey`, not `_anon_${position}` (adjudication C); the parser is unchanged in that respect and
  the archive module never consumes `_anon_*` ids.

### S03-3 `lib/roadmap-residue.js` (edit) — adjudication F

New export beside `computeResidue` (`:169`):

```js
export function computeResidueSet(baseTexts, candidateTexts, opts = {});
// → Array<{ documentId, block, text, lineNo, kind }>
```

**Every residue carries its `documentId` (R1-8).** `--protect` wraps residue lines in
preserved-section markers and rewrites the base text (`protectResidue`, `:269`); with two documents
a caller that cannot tell which document a residue line came from cannot wrap it. So
`computeResidueSet` tags each residue with the document it was found in, `protectResidue` is applied
**per document** to that document's own residue, and `compose roadmap generate --protect`
(`bin/compose.js:1329`, the `residue.length > 0 && protect` branch) re-renders the **set** from the
two protected bases rather than writing one protected file.

`baseTexts` and `candidateTexts` are `{ active, archive }`. The implementation runs `classifyLines`
(`:85`) over all four texts, then compares **base-eligible lines as one multiset against
candidate-eligible lines as one multiset**, using the existing `keyOf(block, text)` occurrence
counting (`:151`, `:226-240`). A line that leaves the active document and appears in the archive is
therefore matched and is not residue. Heading membership (`:176-196`) is likewise checked across the
union, so the mixed-phase heading appearing in both documents is not a deficit.

`computeResidue` keeps its signature and delegates with an empty archive on both sides, so the
single-document callers (`bin/compose.js:1344` and the `--protect` path at `:1329`) are
byte-identical when the enable predicate is false. `:139` gains the `parseCodeCell` call so an
anchored row is still classified `featureRow`, not `other` — without this, **every managed row
becomes eligible residue** the moment anchors land, which is the loudest failure mode in this slice.

### S03-4 `lib/roadmap-roundtrip.js` (edit) — adjudication G

New export beside `checkRoundtrip` (`:48`):

```js
export function checkRoundtripSet(baseTexts, features, opts = {});
// → { fixedPoint, lossless, canonical: { active, archive }, passes, diffs }
```

Same `MAX_REGEN_PASSES` (`:12`) and the same purity guarantee — `genOpts` still forces
`{ cwd: undefined, suppressDrift: true }` (`:53`), so the set roundtrip provably emits no event. Its
input comes from `loadRoadmapSet`, which takes no lock and repairs nothing (R1-2).

**In-flight and unstable suppression (R1-10, R2-9, R3-6).** When `loadRoadmapSet(...).inFlight` is
non-null **or** `unstable` is true the bytes on disk are a half-published or torn set: one document
may be new and the other old, so a row can appear twice or not at all. `checkRoundtripSet` therefore
short-circuits on **either** flag and returns `{ fixedPoint: null, lossless: null, inFlight, unstable }`
computing no diffs — `unstable` propagates everywhere `inFlight` does, with no exception, and the validator (S03-5) suppresses its missing, duplicate and dangling
findings and emits a **single** `ROADMAP_SET_IN_FLIGHT` finding naming `compose roadmap generate` as
the action. Reporting eight fabricated duplicate-row errors during a two-second publication window
would train operators to ignore exactly the findings this feature adds.

The per-feature comparison at `:88-101` becomes set-wide, and the non-item branch changes:

```js
// today, lib/roadmap-roundtrip.js:101
const e = group[0];
```

`group` is now the rows for the code across **both** documents. When the feature has no `items[]`
and `group.length > 1`, push a `ROADMAP_DUPLICATE_ROW` diff naming both documents instead of
silently taking the first (C28). The item-bearing branch (`:92-99`) is unchanged — it already
compares the full multiset — except that its `group` is now the union, which is correct: an
item-bearing feature renders all its rows in one document by construction (adjudication V).

`LOSSY_LABELS` (`:19`) gains a `ROADMAP_DUPLICATE_ROW` entry so `describeLossyDiff` (`:26`) prints
it, and `lib/feature-validator.js:1249` surfaces it as a `ROADMAP_LOSSY` warning through the path
that already exists.

### S03-5 `lib/feature-validator.js` (edit) — the set, mixed phases, duplicates

- `loadValidationContext` (`:148`) reads **both** documents through `loadRoadmapSet` (R1-2), which
  is pure and takes no lock. `:173`'s single `fs.readFileSync(options.roadmapPath || paths.roadmap)`
  becomes a read of the loaded set's two texts, running the same hand-rolled scanner (`:196-232`)
  over each and tagging every row with its document id. The scanner's `codeRaw` (`:219`) uses
  `parseCodeCell` in place of its own `*` and backtick stripping (R1-11).
- **In-flight or unstable (R1-10, R2-9).** When the loaded set reports `inFlight` **or**
  `unstable: true` (the torn-read case, S02-3), `validateProject` suppresses **every finding derived
  from the roadmap documents**, not only the placement-derived ones, and emits a single
  `ROADMAP_SET_IN_FLIGHT` finding naming `compose roadmap generate`. The suppressed set is:
  `FEATURE_NOT_FOUND` (`:795`), `DUPLICATE_ROADMAP_ROW`, `DUPLICATE_PHASE_HEADING` (`:776`),
  `ROADMAP_ROW_WITHOUT_FOLDER` (`:540`/`:543`), `FOLDER_WITHOUT_ROADMAP_ROW` (`:548`),
  `DANGLING_ARTIFACT_LINK` (`:610`), `ROADMAP_LOSSY` (`:1249`), `ORPHAN_PHASE` (`:1258-1272`) and —
  added by R2-9 — the three status-drift findings and the description-drift finding, all of which
  read `rStatus`/`roadmap.description` off the same possibly-torn bytes:
  `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON` (`:469-473`),
  `STATUS_MISMATCH_ROADMAP_VS_VISION_STATE` (`:484-488`) and
  `COMPLEXITY_OR_DESCRIPTION_DRIFT` (`:513-521`).
  `STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE` (`:489-493`) and `CONTRADICTORY_PHASE_CLAIM`
  (`:508-511`) are **not** suppressed: neither reads a roadmap document. The rule is mechanical —
  a finding is suppressed exactly when its inputs include `roadmapByCode` or the parsed row text.
- `roadmapByCode` (`:237`) keeps its last-wins Map for every existing downstream check, but a new
  `roadmapRowsByCode: Map<code, row[]>` is built alongside it. A code with more than one
  authoritative row — in one document or across the two — produces a new finding
  `DUPLICATE_ROADMAP_ROW` (error), which is the design's Behavior 6 requirement and closes the
  "silently keeps the last row" gap.
- Duplicate phases (`runDuplicatePhaseHeadingCheck`, `:776`): `duplicatePhaseTitles` is computed
  **per document**. The same identity in both documents is the **mixed** case and is not reported
  (adjudication X); twice within one document is still `DUPLICATE_PHASE_HEADING`. The generator's
  `new Set(sourcePhaseOrder)` dedupe (`lib/roadmap-gen.js:109`) stays exactly as it is (C29).
- `ORPHAN_PHASE` (`:1258-1272`): a heading with no features and no body in the **active** document is
  not orphaned when the archive holds rows under the same identity, or when the active document
  carries a `## Moved` redirect for it. Without this, every whole-phase move produces a warning, and
  an active-status heading produces an **error** (`:1268`).
- `ROADMAP_ROW_WITHOUT_FOLDER` (`:540`/`:543`), `FOLDER_WITHOUT_ROADMAP_ROW` (`:548`),
  `FEATURE_NOT_FOUND` (`:795`) and `DANGLING_ARTIFACT_LINK` (`:610`) all read the set, so archival
  alone cannot produce a missing-feature finding (design Read contract). `effectiveStatus` (`:303`)
  is unchanged: feature.json first, parsed row as fallback.
- `applyNarrativeSuppression` (`:1298`) is untouched. The in-flight suppression is a separate,
  earlier filter and does not go through it.

### S03-6 `lib/feature-write-guard.js` (edit) — R1-11

`scanRoadmapRows(roadmapPath)` (`:99`) is a **seventh** roadmap row scanner, with its own copy of the
code-cell strip at `:121`. Two changes:

- `:121` uses `parseCodeCell`, so an anchored row still yields its code.
- `knownFeatureCodes` (`:137`) scans **both** documents: `for (const code of scanRoadmapRows(paths.roadmap))`
  (`:154`) becomes a loop over the active and archive paths. Without it every archived feature falls
  out of the known set and `assertLinkTargetsExist` (`:183`) starts refusing
  `DANGLING_LINK_FEATURES_TARGET` on links to completed work — a regression that fires on the first
  completion after the flag is set. The vision-state and feature-folder legs are unchanged, and a
  missing archive file is handled by `scanRoadmapRows`' existing `catch { return codes; }` (`:102`).
  **The second scan is gated on `archiveActive(cwd)` (R3-7)**, the same synchronous predicate every
  other reader uses, whose provider half is `isLocalTrackerConfig` imported from
  `lib/tracker/factory.js` (§2.2): on a workspace with the flag off, or a non-local tracker config,
  the guard reads one document exactly as it does today. `knownFeatureCodes` is synchronous and stays
  that way, which is why the predicate may not take a provider instance — and it imports the rule
  rather than restating it.

### S03-7 `lib/roadmap-graph` — pin, do not change (adjudication T)

No file under `lib/roadmap-graph/` is modified. `buildGraph` (`model.js:59`) takes `knownCodes` from
canonical features and drops COMPLETE/SUPERSEDED/KILLED at `:65` while keeping PARKED (`:19`);
narrowing `knownCodes` to the active document would make `:95` throw `DanglingEdgeError`.
`server/roadmap-graph-vision.js:58` reads ROADMAP.md as a degradable supplementary read inside a
try/return and continues to read the **active** document only, which is correct: it contributes
nothing the vision store does not already have.

The acceptance criterion "roadmap graph resolves archived dependencies" is restated as a **pin
test**: after archiving a feature that is an edge endpoint, `buildGraph`'s `knownCodes` still
contains it and no `DanglingEdgeError` is thrown.

### S03-8 Tests

| File | Test name | Asserts |
|---|---|---|
| `test/feature-validator.test.js` (extend) | `phase identity uses the rightmost em-dash` | `## Wave 6 — Situational Awareness — COMPLETE` yields `Wave 6 — Situational Awareness`, matching `splitPhaseHeading` |
| | `the same phase in both documents is mixed, not duplicate` | no `DUPLICATE_PHASE_HEADING` |
| | `the same phase twice in one document is still duplicate` | `DUPLICATE_PHASE_HEADING` |
| | `a duplicate authoritative row is reported` | `DUPLICATE_ROADMAP_ROW`, both same-document and cross-document |
| | `a whole-phase move is not an orphan phase` | no `ORPHAN_PHASE`, including for an active-status heading |
| | `archival alone produces no missing-feature finding` | archive a feature, run `validateProject`, assert the finding set is unchanged |
| `test/roadmap-roundtrip.test.js` (extend, and see U in S05) | `checkRoundtripSet is a fixed point over the pair` | `fixedPoint && lossless` on a mixed fixture |
| | `a duplicate non-item row is a reported diff` | `ROADMAP_DUPLICATE_ROW` naming both documents |
| | `checkRoundtripSet emits no drift event` | `.compose/data/feature-events.jsonl` unchanged with a diverging phase override present |
| `test/roadmap-residue.test.js` (extend) | `moving an anonymous row across the set is not prose loss` | the `ROADMAP.md:30` row; no `ROADMAP_PROSE_LOSS` |
| | `an anchored feature row is not eligible residue` | classification stays `featureRow` |
| | `computeResidue is byte-identical with archival off` | delegation check |
| `test/roadmap-parser.test.js` (extend) | `an anchored code cell parses to the bare code` | |
| `test/roadmap-graph.test.js` (extend) | `knownCodes still includes an archived feature` | no `DanglingEdgeError` |
| `test/feature-write-guard.test.js` (extend) | `knownFeatureCodes scans both documents` | R1-11: a link to an archived feature is not `DANGLING_LINK_FEATURES_TARGET` |
| | `scanRoadmapRows reads an anchored cell` | R1-11 |
| `test/feature-validator.test.js` (extend) | `an in-flight set reports one finding, not eight` | R1-10: intent present; exactly one `ROADMAP_SET_IN_FLIGHT`; no duplicate/missing/dangling findings |
| `test/roadmap-residue.test.js` (extend) | `residues carry a documentId and protect wraps per document` | R1-8 |

**Acceptance criteria covered by S03:**

- [ ] The validator reports no duplicate phase in either the mixed or the whole-move case.
- [ ] A duplicate authoritative row within one document is reported by the validator.
- [ ] `compose validate` and roadmap graph resolve archived dependencies (as the `knownCodes` pin).

---

## 6. Slice S04 — producer wiring

Every producer from the seam inventory, with the line number it is wired at. The rule from
design.md:176-182 is implemented as **one transaction per producer, not a pre-call and a post-call**
(R1-1): each producer wraps its canonical write in `withRoadmapSet(root, fn, { producer })`, which
holds `roadmap-set.lock` across repair, the write and the publication. A producer never calls the
service twice, and never touches `publishRoadmapSet` directly — the sole exception is
`compose roadmap generate`, which has no canonical write of its own.

```js
await withRoadmapSet(cwd, async () => { /* the canonical write, and nothing else */ },
                     { producer: '<tag>' });
```

`fn` must not call the service (`withDirLock` is not reentrant, `lib/dir-lock.js:154`). Anything
`fn` throws propagates with the lock released and no publication attempted, which is how each
producer keeps its existing refusal semantics unchanged.

**Every row below is gated on the enable predicate** `archiveActive(cwd, provider)` (R1-9, §2.2):
flag on **and** local provider. When it is false the producer takes today's single-document path,
byte for byte, and nothing in this slice is reachable.

Producer tags (the `producer` field of §2.4), one per site, so an intent names what left it behind:
`set_feature_status`, `add_roadmap_entry`, `set_roadmap_row_status`, `completion_gate`,
`backfill_gate`, `record_completion`, `build_start`, `build_abort`, `build_teardown`,
`build_failed_terminal`, `lane_gate`, `followup_recovery`, `compose_feature`, `compose_triage`,
`ideabox_promote`, `migrate_roadmap`, `migrate_anon`, `roadmap_generate`, `repair`.

### S04-1 `lib/feature-writer.js`

| Site | Line today | Change |
|---|---|---|
| `TRANSITIONS.PARTIAL` | `:52` | add `'PARKED'` (adjudication L). `SUPERSEDED` stays absent from every list, so it remains force-only from everywhere (C4) |
| `setFeatureStatus` PARKED reason | `:498-499` (the `updated` object) | when `to === 'PARKED'`, a missing or empty `args.reason` throws `err.code = 'PARKED_REASON_REQUIRED'` **before** `persistFeatureRaw`; `updated.status_reason = args.reason` is set in the same object, so `:508` writes status and reason in one call (adjudication K) |
| `setFeatureStatus` transaction | wraps `:447-517` | **R2-1.** `withRoadmapSet(cwd, fn, { producer: 'set_feature_status' })` where `fn` covers **the read as well as the write**: `provider.getFeature(args.code)` (`:447`), the same-status decision (`:455`), the COMPLETE refusal (`:471`), the transition-table check (`:482-493`), the construction of `updated` (`:498-499`), the roundtrip guard (`:501-506`) and `persistFeatureRaw` (`:508`). The publication replaces the `renderRoadmap()` at `:510`; a publication failure is still converted by `partialWriteError` (`:339`) into a thrown `ROADMAP_PARTIAL_WRITE` naming `compose roadmap generate`, with the message, the code and `err.cause` unchanged (R1-1) |
| `addRoadmapEntry` transaction | wraps `:291-301` (render at `:294`) | `fn` calls `createFeature` (`:291`); the publication replaces the render. Narrative refusal at `:181-183` stays first, outside the transaction |
| `setRoadmapRowStatus` | `:893`, scan at `:927`, write at `:958-960` | **R1-5.** Today it renames its own temp file over ROADMAP.md (`:958-960`), bypassing the baseline and the intent entirely, so the very next publication would see a hand-edit mismatch. It now runs **inside** `withRoadmapSet` with producer `set_roadmap_row_status` and an **empty `fn`** (it writes no canonical state), expressing the surgical edit through the **`patchSource`** hook (R3-2): the hook locates the row in the **current** documents with `parseCodeCell` (`:927`, R1-11), rewrites the one status cell, and returns `{ docs, result: { code, changed, from, to } }`. The service **skips the render** — `:870-880` documents exactly why a full render is unsafe here — and publishes the patched bytes through the baseline check, the intent, the preflight and the rename order, so the baseline updates. `setRoadmapRowStatus` returns `patch` from the transaction result (R3-4), preserving the `{ code, changed, from?, to? }` contract at `:891` that `lib/feature-reconciler.js:256-258` reads. Cross-document placement supplies no hook and takes the full render. Last-wins duplicate semantics (`:906`, `:947`) live inside the hook, and the direct `renameSync` at `:959` is deleted |

**Why the read moves inside the lock (R2-1).** The first revision opened the transaction at `:501`,
leaving `getFeature` (`:447`), the `from === to` early return (`:455`) and the transition validation
(`:482`) outside it. Every one of those is a decision **derived from canonical state**, so deciding
them before taking the lock is the same read-then-act race the transaction exists to remove: a
concurrent transition can land between `:447` and `:508`, and the writer then validates against a
`from` that no longer exists and persists over the other write. Reading inside `fn` costs one extra
`getFeature` per call and removes the window entirely.

**A same-status call still enters the transaction.** It returns `{ …, noop: true }` from inside `fn`
(the `:455` shape is unchanged) **without any canonical write**, but the transaction has already run
its repair step by then — which is exactly what makes "a same-status retry repairs a pending
projection" (plan.md step 4) true rather than aspirational. Publication after a no-op `fn` renders
identical bytes and hits the no-change short circuit (step 4 of the sequence), so a same-status call
still writes **zero bytes** unless there was something to repair. The COMPLETE refusal (`:471`) and a
transition-table rejection (`:487`) throw from inside `fn`, so they publish nothing at all.

`status_reason` is **not** back-filled onto existing PARKED features (design Behavior 1).

Existing assertions that must still pass unchanged: `test/feature-writer.test.js:333` (the
`ROADMAP_PARTIAL_WRITE` message contains `PLANNED → IN_PROGRESS`, `:346` `err.cause instanceof
Error`, `:354` the committed status, `:356` `events.length === 0`).

### S04-2 `lib/completion-gate.js`

| Site | Line | Change |
|---|---|---|
| live transaction | wraps `:474-497` **only** | `withRoadmapSet(workspaceRoot, fn, { producer: 'completion_gate' })` where `fn` is the fresh `getFeature` (`:474`), `prepareCompleteStatus` (`:475`) and `persistCompleteStatus` — exactly the writes at `:474-490` and nothing before them. The publication replaces the render at `:494`, and a publication failure is still **collected** into `failures` with `recover: 'compose roadmap generate'` (C2), never thrown. **R3-1:** the completion record's **idempotency wrapper** stays outside the transaction (`lib/completion-writer.js:343` takes the idempotency lock, and holding the set lock across it inverts the order), but its **read-modify-write** moves inside `fn` as `appendCompletionRecord`. The gate's `recordCompletion(…, set_status:false)` call at `:447-467` therefore becomes: enter the idempotency wrapper, open the transaction, and call `appendCompletionRecord` plus `persistCompleteStatus` in the same `fn`, so feature.json is read and written exactly once |
| live `clearIntent` | `:526` | unchanged and still unconditional, and still outside the transaction |
| backfill transaction | wraps the status write and the render only | **R2-2, corrected.** The first revision wrapped `:1271-1320`, which spans the completion record — and the backfill record path reaches `recordCompletion` and therefore `maybeIdempotent` (`lib/completion-writer.js:343` → `lib/idempotency.js:138`). That gives `set → idempotency` here against `idempotency → set` in an idempotency-keyed `setFeatureStatus` (`lib/feature-writer.js:145`), a genuine lock cycle. So the **idempotency wrapper** opens first and the transaction inside it; `fn` then brackets the completion record's read-modify-write (`appendCompletionRecord`, R3-1) **and** the feature-status persistence inside `if (tracksJson)` (`:1271`) as one cycle; the publication replaces `:1316`, and the failure is collected |
| backfill intent | `:1393`, `:1415` | unchanged: backfill **keeps** its intent on a projection failure and returns `status:'pending'` (`:1419`). The asymmetry with the live path gets a comment citing adjudication Z |

`prepareCompleteStatus` (`:610`) and `persistCompleteStatus` (`:617-628`) are untouched, so the
evidence gate remains the only completion authority and a failed gate moves nothing.

### S04-3 `lib/completion-writer.js`

Two paths, and only one of them writes a document.

- **Delegating path** (`args.set_status !== false`, `:307-324`): hands off to `completionGate`
  (`:309`), which owns the transaction (S04-2). Nothing changes here, and the file must **not**
  wrap the call — that would nest a set lock around a call that takes one (R1-1).
- **Record-only path** (`set_status === false`): writes via `persistFeatureRaw` (`:397`) and never
  renders — verified, there is no `renderRoadmap` or `writeRoadmap` call anywhere in the file. That
  is exactly the required behavior ("record-only requests must not archive unfinished work"), so
  this path stays **unmodified** and its own per-feature lock (`:65`, `:72`) is untouched. The test
  asserts placement is unchanged after a record-only call.

The `record_completion` producer tag exists for the transaction the gate opens on this file's
behalf, so an intent left behind names the caller rather than the gate.

**The function is split, not merely moved (R3-1).** `recordCompletion`'s whole body runs inside
`maybeIdempotent` (`lib/completion-writer.js:343`), which takes the idempotency lock
(`lib/idempotency.js:138`), so wrapping the whole thing in `withRoadmapSet` would hold the set lock
across the idempotency lock and invert §S02-3's order against every idempotency-keyed
`setFeatureStatus` (`lib/feature-writer.js:145`). But leaving the whole thing outside is a lost
update: the record path reads the feature at `:351` and persists at `:397`, while the transaction's
`fn` reads at `lib/feature-writer.js:447` and persists at `:508` — two interleaved read-modify-write
cycles on one file, last writer wins.

So the file gains a **new export**:

```js
/** The read-modify-write half of recordCompletion: read the feature, append to
 *  `completions`, persistFeatureRaw. Caller MUST hold the per-feature lock and
 *  MUST be inside withRoadmapSet's fn. Performs no idempotency check and opens
 *  no transaction. (COMP-ROADMAP-ARCHIVE R3-1) */
export async function appendCompletionRecord(cwd, args);
```

It is the body at `:351-403` with the wrapper stripped off. `recordCompletion` keeps its signature,
its refusal semantics (`:307-324`) and its return shape, and becomes the wrapper that opens the
idempotency region, then the feature lock, then the transaction, and calls the primitive inside `fn`.
The transaction always opens **inside** the idempotency-keyed region, never around it.

### S04-4 `bin/compose.js`

| Command | Lines | Change |
|---|---|---|
| `compose feature` | `:1067-1244` | adjudication O. Add the `isNarrativeOwned` guard after the config check (`:1087`). `writeFeature` (`:1165`) gains `phase` when `--phase` is given; `position` is left to the service. Delete the regex splice (`:1196-1229`) and the roadmap write of the placeholder rewrite (`:1232-1239` keeps the substitution but routes the write through the service). The `writeFeature` call becomes the `fn` of one `withRoadmapSet(cwd, fn, { producer: 'compose_feature' })`, replacing both `writeFileSync` calls (`:1227`, `:1237`) |
| `compose triage` | `:3230-3275` | **R1-6.** A producer the inventory missed: on a feature with no `feature.json` it creates one with `status: 'PLANNED'` at `:3257` (guarded by the `if (!existing)` at `:3256`, whose `readFeature` is `:3255`), and never renders — so a triaged feature has no row until an unrelated producer publishes. The `writeFeature` becomes the `fn` of `withRoadmapSet(trCwd, fn, { producer: 'compose_triage' })`. **R2-6/R3-5: the else-branch at `:3266` is wrapped too, and its `updateFeature` call goes INSIDE `fn`** — not an empty `fn`. `updateFeature(trCwd, triageCode, {…})` (`:3267-3271`) is a read-modify-write of feature.json, so leaving it outside the transaction reopens the lost-update window R3-1 closes for completions: a concurrent transition's read-modify-write would interleave with it. It changes no status, so placement does not move and the publication short-circuits; but the write still belongs under the lock |
| `compose roadmap generate` | `:1268-1364` | adjudication P. Narrative exit (`:1279-1282`) unchanged. The marker guard (`:1293-1309`) and the prose-loss refusal (`:1344-1353`) are pre-checks on a **pure** `loadRoadmapSet` + `renderRoadmapSet` pass (R1-2), keeping their exit codes. `--protect` (`:1286`, applied at `:1329`) is **not** computed on that pre-lock read (R2-5): a read outside the lock can be stale by the time the publication runs, and protecting stale residue would wrap lines that no longer exist. Instead the command passes a **`protectBase`** hook (R3-2), which runs **before** the render and returns a protected **base** — mirroring what the code does today at `bin/compose.js:1327-1331`, where `protectResidue(base, residue)` feeds `checkRoundtrip(protectedBase, …)` so the generator re-renders from the protected source. A post-render hook could not do this: wrapping markers into already-rendered output leaves the next regeneration to strip them again. In-lock the hook recomputes `computeResidueSet` against the current source, applies `protectResidue` **per document** (R1-8), and the service then renders from what it returns; the `stillLost` re-check at `:1332` runs on that render. Both `writeFileSync` sites (`:1334`, `:1360`) become one `publishRoadmapSet(cwd, { producer: 'roadmap_generate', protectBase })` — this is the one producer with no canonical write of its own, so it calls the service directly rather than `withRoadmapSet`. The drift-only `generateRoadmapFromBase` call (`:1318`) stays, so the documented drift event still fires from `generate`. It remains the `recover` action the gate names, and performs the repair by construction (step 1) |
| `compose roadmap migrate` | `lib/migrate-roadmap.js:27`, write at `:102` | **R1-6.** `migrateRoadmap` transcribes ROADMAP rows into feature.json (`:75-102`) under a named completion exemption (`:92-98`) and never renders. Its `writeFeature` loop becomes the `fn` of one `withRoadmapSet(cwd, fn, { producer: 'migrate_roadmap' })` — one transaction for the whole migration, not one per feature. **This supersedes the blueprint's earlier line excluding it** (adjudication Y still holds for the *initial partition*, which needs no migration; migrate is a status-writing producer and must publish like any other). **R2-7: it becomes `async`, and every caller changes with it** — see below |
| `compose roadmap check` | `:1509-1541` | adjudication Q. **Stays read-only, and now provably so (R1-2):** it uses `loadRoadmapSet` + `renderRoadmapSet`, which take no lock and repair nothing. First check: a non-null `inFlight` ⇒ print "roadmap set publication in flight (operation `<id>`); run `compose roadmap generate`" and `process.exit(2)`. **`unstable: true` also exits 2 (R3-6)**, with its own message — "roadmap set read was unstable (a publication landed mid-read); retry `compose roadmap check`" — because the condition is transient and the action is a retry, not `generate`. Both are distinct from drift (1) and missing (1). Then `checkRoundtripSet` over the set instead of `checkRoundtrip` over one file (`:1528`). In sync ⇒ 0 (`:1529`), drift ⇒ 1 (`:1533`), missing ⇒ 1 (`:1515`) — all unchanged |
| `compose roadmap add` | `:1371-1483` | no change; it delegates to `addRoadmapEntry` (`:1476`) |
| `compose init` | `:423-446` | §2.2 config keys |

**`migrateRoadmap` becomes async (R2-7).** It is declared `export function migrateRoadmap(cwd, opts = {})`
(`lib/migrate-roadmap.js:27`) and is consumed synchronously everywhere. `withRoadmapSet` is async, so
the signature changes to `export async function migrateRoadmap(...)` and every caller must be
updated in the same commit, or each one silently receives a Promise where it expects
`{ created, skipped, updated, skippedExternal }` (`:112`) and prints `undefined` counts:

| Caller | Line | Change |
|---|---|---|
| `bin/compose.js` | `:1493` | `const result = await migrateRoadmap(cwd, {…})`. The enclosing block is already async (it uses `await import` at `:1487`), so no other change is needed |
| `test/migrate-roadmap.test.js` | `:31`, `:45` | `await migrateRoadmap(cwd, { dryRun: true, … })`; both tests become async |
| `test/migrate-roadmap.test.js` | `:68-72` | **R3-8:** `captureWarn(fn)` (`:68`) returns `{ result: fn(), seen }` from inside a `try`/`finally` that restores `console.warn` (`:72`). With an async `fn` the `finally` runs before the promise settles, so warnings emitted during the migration are never captured and the two assertions silently pass on an empty `seen`. The helper becomes `async function captureWarn(fn)` and `await fn()` inside the try, so the restore happens after the awaited work |
| `test/migrate-roadmap.test.js` | `:79`, `:90` | `await captureWarn(() => migrateRoadmap(cwd, …))`; both tests become async |
| `test/migrate-roadmap.test.js` | `:89`, `:98` | plain calls, awaited |

**`--dry-run` returns before any service call (R2-7).** Today the dry-run branch (`:99-101`) prints
and writes nothing at all. A migration that publishes on `--dry-run` would take the workspace lock,
run repair and rewrite both documents — turning the one flag whose entire contract is "changes
nothing" into the most invasive path in the command. So `migrateRoadmap` checks `opts.dryRun` first
and returns its counts **without entering the transaction**.

### S04-5 `lib/build.js` — all four raw status writes (adjudication M)

| # | Line | Producer tag | Change |
|---|---|---|---|
| 1 | `:2609` | `build_start` | the `persistFeatureRaw(… IN_PROGRESS)` becomes the `fn` of `withRoadmapSet(cwd, fn, { producer: 'build_start' })` (R1-1). A build started on a PARKED or COMPLETE feature is a **reactivation**, so there is no "both statuses are active" exemption |
| 2 | `:2936` | `build_abort` | same shape, wrapping the PLANNED rollback |
| 3 | `:4608` | `build_teardown` | same shape |
| 4 | `:2102` | `build_failed_terminal` | same shape, inside `writeFailedBuildTerminalState` (`:2073`) |

All four stay gated on `cfg.tracksFeatureJson` (`:2600`) and on the `getFeature` existence check,
and all four keep those checks **inside** `fn` so a skipped write publishes nothing.
The teardown continues to write PLANNED unconditionally: the pre-existing loss of a PARKED state
through a build (C9) is **not fixed here** and is recorded as a follow-up candidate.

### S04-6 `lib/lane-gate.js`, `lib/followup-writer.js`, `lib/migrate-anon.js`, ideabox promotion

- `applyFrontTriage` (`lib/lane-gate.js:50`): the `createFeature` branch (`:99-104`) becomes the `fn`
  of `withRoadmapSet(cwd, fn, { producer: 'lane_gate' })`, so the row exists immediately
  (adjudication AA). The `putFeature` branch and `maybeEscalateLane` (`:133`, write at `:163`) are
  **not** placement changes — `putFeature` refuses a status delta
  (`lib/tracker/local-provider.js:67`) — and are untouched.
- `lib/followup-writer.js`: both recovery `writeRoadmap(cwd)` calls (`:408` inside the
  `already exists` resume branch, `:439` in the `roadmap_committed_regen_failed` stage) become
  `withRoadmapSet(cwd, async () => {}, { producer: 'followup_recovery' })` — an **empty** `fn`,
  because in both branches feature.json is already committed and the only work left is repair plus
  re-render, which the transaction performs in steps 1 and 4 (R1-1). The happy path stays on
  `addRoadmapEntry` (`:386`), which brings its own transaction. The import at `:27` changes
  accordingly. Failure handling is unchanged: `:414` still becomes
  `partialFollowup('roadmap_regen', …)` and `:442` still re-raises. The parent lock (`:156`,
  acquired `:365`, released `:429-431`) nests outside the set lock, consistent with adjudication I.
- **`lib/migrate-anon.js` — R1-5, a producer that writes ROADMAP.md directly.** `promoteAnonRow`
  (`:166`) reads the roadmap (`:171`), strips the anonymous row and writes it back with a bare
  `writeFileSync` (`:174`), then calls `addRoadmapEntry`; on a pre-commit failure it restores the
  snapshot with a second bare write (`:193`). Both writes bypass the baseline and the intent, so the
  next publication would refuse with `ROADMAP_SET_BASELINE_MISMATCH` on a file compose itself wrote.
  The whole promote — strip, scaffold, rollback — runs inside one
  `withRoadmapSet(cwd, fn, { producer: 'migrate_anon', patchSource })`: `fn` performs the
  scaffold's canonical write (it must call the raw writer, not `addRoadmapEntry`, which would nest a
  transaction), and **`patchSource`** strips the anonymous row from the holding document's **current**
  bytes and returns them unrendered (R3-2) — the same reason as `setRoadmapRowStatus`, since the
  roadmap being migrated is by definition not yet a fixed point. The rollback is then simply a throw
  from `fn`: nothing was staged or renamed, so there is no target to rewrite and the `writeFileSync`
  at `:193` is deleted along with the one at `:174`. The `ROADMAP_PARTIAL_WRITE` re-throw at `:191`
  is preserved.
- **Ideabox promotion — R1-6.** `promoteIdea` (`lib/fluid/ideabox-ops.js:414`) creates a feature.json
  with `status: 'PLANNED'` at `:439`, inside the `if (!existsSync(featurePath))` branch at `:435`,
  and never renders, so a promoted idea has no roadmap row. That `writeFeature` becomes the `fn` of
  `withRoadmapSet(ctx.cwd, fn, { producer: 'ideabox_promote' })`. The `updateRecord` call that
  follows (`:449`) writes the ideabox store, not canonical feature state, and stays outside the
  transaction. **R2-6: the already-promoted path is wrapped too.** When `existsSync(featurePath)` is
  true the `if` at `:435` is skipped, `createdFeature` stays false, and execution falls straight to
  `:449` — so a re-promotion writes no feature.json and, unwrapped, would perform no repair either.
  That branch runs `withRoadmapSet` with an empty `fn`, for the same reason as the triage retry: a
  promotion repeated after a failed first attempt is exactly when a pending projection is waiting.

### S04-7 Allowlist (adjudication R)

`test/completion-write-allowlist.test.js` scans `lib`, `server`, `bin` (`SCAN_DIRS` `:27`) for
`/persistFeatureRaw\(/` and `/\bwriteFeature\(/` (`:31`), two-sided (`:17`). None of the four new
modules calls either — the service renders documents and never writes feature.json — so no new
`ALLOWLIST` entry is added. The test gains one assertion instead: that
`lib/roadmap-publish.js`, `lib/roadmap-archive.js`, `lib/roadmap-documents.js` and
`lib/durable-write.js` produce **zero** hits, so a future edit that makes the service write
feature.json fails loudly rather than silently earning an entry.

### S04-8 Tests — `test/roadmap-archive-producers.test.js` (new) plus extensions

Reuses `makeRoadmapSet`, and `sabotageRoadmap` from `test/completion-writer.test.js:44`
(`mkdirSync(join(cwd,'ROADMAP.md'))`, so the write throws EISDIR) as the projection-failure
injection, extended with an `sabotageArchive` twin.

| Test name | Asserts |
|---|---|
| `every producer routes through the transaction` | one table-driven case per tag: transition, create, row-status, live completion, backfill, four build sites, lane-gate, follow-up recovery, `compose feature`, `compose triage`, ideabox promote, `roadmap migrate`, `migrate-anon` promote, `roadmap generate`. Each asserts the row moved without a second command **and** that the set lock was held across the canonical write (R1-1, by racing a second transaction) |
| `compose triage creates a row for a new feature` | R1-6: triage a code with no feature.json; the row exists immediately |
| `promoting an idea creates a row` | R1-6: `promoteIdea` on a fresh code |
| `roadmap migrate publishes once for the whole pass` | R1-6: N features migrated, exactly one intent written and cleared |
| `migrate-anon promotion does not break the baseline` | R1-5: promote an anonymous row, then run any producer; no `ROADMAP_SET_BASELINE_MISMATCH` |
| `setRoadmapRowStatus updates the baseline and keeps its contract` | R1-5, R3-4: surgical edit then a publication, no mismatch; and `r.changed` is still what `lib/feature-reconciler.js:256-258` reads |
| `re-triage writes feature.json inside the transaction` | R3-5: a concurrent transition does not lose the triage profile |
| `a non-local provider takes the single-document path` | R1-9: flag on, GitHub provider; no archive file, one log line, ROADMAP.md byte-identical to today's render |
| `a same-status transition repairs but writes no bytes` | R2-1: pending intent + a `PLANNED to PLANNED` call; returns `noop: true`, the documents are repaired, and a second same-status call writes zero bytes |
| `the transition decision is made inside the lock` | R2-1: a concurrent transition landing between what used to be `:447` and `:508` is serialized, and the loser validates against the committed `from` |
| `a refused transition publishes nothing` | R2-1: `COMPLETE_VIA_GATE_ONLY` and a transition-table rejection each leave both documents and the baseline byte-identical |
| `re-triage and re-promotion repair a pending projection` | R2-6: the `updateFeature` and already-promoted branches, each with a pending intent |
| `roadmap migrate --dry-run enters no transaction` | R2-7: pending intent stays pending; no lock taken; nothing written |
| `roadmap migrate is awaited by every caller` | R2-7: the CLI prints real counts, not `undefined` |
| `a PARKED transition without a reason is refused` | `PARKED_REASON_REQUIRED`; feature.json unchanged |
| `status_reason survives a projection failure` | sabotage the archive, run a PARKED transition, assert the throw is `ROADMAP_PARTIAL_WRITE` **and** feature.json holds `status: 'PARKED'` with `status_reason` |
| `PARTIAL to PARKED is an ordinary transition` | no `force`; pins adjudication L |
| `SUPERSEDED is still force-only from every status` | the eight sources |
| `a failed evidence gate moves nothing` | placement identical before and after |
| `a record-only completion moves nothing` | `set_status: false` |
| `a build started on a PARKED feature reactivates its row` | row is active after start |
| `compose feature on a narrative-owned workspace writes feature.json and no roadmap` | `narrativeOwnedMessage` printed, ROADMAP.md byte-identical |
| `compose feature assigns a phase and a position through the service` | no regex splice residue; row rendered by the generator |
| `roadmap generate keeps its refusal exit codes on the set` | marker guard, `--protect`, prose-loss, each with its current exit code |
| `roadmap check exits 2 on a pending intent and writes nothing` | exit 2, both documents and the intent byte-identical |
| `setRoadmapRowStatus keeps the surgical edit within a document and delegates across` | two cases |
| Extensions to `test/feature-writer.test.js`, `test/feature-writer-mcp.test.js` | ordinary transitions, park/restore, same-status repair |
| Extensions to `test/completion-gate.test.js`, `test/completion-writer.test.js`, `test/build-completion-gate.test.js` | live/backfill completion, failed gate, record-only, projection failure — the existing assertions at `test/completion-gate.test.js:474-488` and `test/completion-writer.test.js:558` must pass unchanged |

**Acceptance criteria covered by S04:**

- [ ] A normal successful completion (live and backfill) moves the row and rewrites in-document
      links without a second command.
- [ ] An ordinary PARKED or KILLED transition archives the row; a force SUPERSEDED does the same.
- [ ] Failed evidence gates and record-only completion writes leave placement unchanged.
- [ ] A live completion whose document write is made to fail reports committed status plus pending
      projection; the next ordinary transition on any other feature repairs the documents; the
      gate's own retry still refuses.
- [ ] A build started on a PARKED feature, and `compose feature`, both go through the service; a
      PARKED transition persists its reason in feature.json even when the document write fails.
- [ ] `compose roadmap generate` and `compose roadmap check` operate on the set; `check` reports a
      pending intent as in-flight without writing.

---

## 7. Slice S05 — readers, MCP surface, docs, dogfood

### S05-1 `lib/get-roadmap.js` (edit)

`getRoadmap(root, opts)` (`:56`) destructuring (`:57`) becomes:

```js
const { status, phase, format = 'summary', check_drift = true, limit, scope = 'active', code } = opts ?? {};
```

- **Pure read (adjudication S, R1-2).** `:65` no longer calls `generateRoadmap(root, {})`. Generated
  mode goes through `loadRoadmapSet(root)` + `renderRoadmapSet(loaded, features, { suppressDrift:
  true })` — pure functions that take **no lock**, perform **no repair**, sweep nothing and emit no
  `roadmap_drift` event (`lib/roadmap-gen.js:151` is gated on `!opts.suppressDrift`). A read must
  never block for `LOCK_ACQUIRE_TIMEOUT_MS` (`lib/dir-lock.js:57`) behind a publication, and must
  never mutate state on the way past. The narrative branch (`:62-65`) is unchanged. `check_drift`
  (`:125-135`) still reports drift; it just no longer writes one.
- **`scope`** — `'active'` (default), `'archive'`, `'all'`. Selects which documents' rows are
  considered. Default reads describe the active document.
- **`code`** — looks one feature up across the **whole set regardless of `limit`**, so a historical
  lookup is a single call. Returned as `out.feature = { code, status, description, phase, document }`
  or `null`.
- **`format: 'markdown'`** is served for `scope: 'active'` only. `'archive'` or `'all'` with
  `markdown` throws `err.code = 'ARCHIVE_MARKDOWN_UNSUPPORTED'` — a runtime check, because `format`
  has no enum today (`server/mcp-tool-defs.js:334`) and the new enum is added alongside.
- **Archived count** comes from the service's `partition.archivedFeatureCount` (§2.6), **not** from
  the summary buckets, because `BUCKET` (`:28-36`) has no KILLED entry. Added to the return
  (`:106`) as `archivedCount`, alongside `archivePath`.
- **KILLED bucket** added to `BUCKET` (`:28`) while there, so KILLED stops being silently uncounted.
  `ACTIVE_STATUSES` (`:25`) is left as `{IN_PROGRESS, PARTIAL}` — it drives the `active` list, not
  placement, and widening it would change existing output.
- **In-flight or unstable** — `loadRoadmapSet(...).inFlight` (S02-3) surfaces as
  `inFlight: { opId, startedAt, producer }` plus the `ARCHIVE_PUBLICATION_IN_FLIGHT` diagnostic, and
  a torn read surfaces as `unstable: true` with the same diagnostic (R2-9). Either way the reader
  reports the set as in-flight rather than as duplicate or missing features, and names
  `compose roadmap generate`. Reads never repair.
- **Predicate-aware (R2-10).** `getRoadmap` passes the effective `archiveActive` into
  `loadRoadmapSet`. When it is false — the flag is off, or the provider is not local — the loaded
  set is single-document, `scope` collapses to `active`, `archivePath` and `archivedCount` are
  omitted, and the response is shape-identical to today's.

### S05-2 MCP surface

- `server/mcp-tool-defs.js:325-341` — `get_roadmap`'s `inputSchema.properties` gains
  `scope: { type: 'string', enum: ['active','archive','all'], … }` and
  `code: { type: 'string', … }`, and `format` (`:334`) gains
  `enum: ['summary','markdown']`. `effect: 'read'` is unchanged and correct once S05-1 lands.
- `server/compose-mcp-tools.js:186-188` — `toolGetRoadmap` passes `args` straight through; no change
  beyond the description.
- `server/compose-mcp.js:171` — dispatch unchanged.
- `server/mcp-tool-policy.js:61` — `get_roadmap` stays on the reviewer read-only allowlist, which is
  now literally true.
- **No HTTP route** is added or changed: `get_roadmap` has none (C35).

### S05-3 Documentation

- `docs/mcp.md` — **ADD** a `get_roadmap` row to the tool table (it is absent today; the table lists
  `add_roadmap_entry` at `:22`) plus a short section documenting `scope`, `code`, the `format`
  restriction, `archivePath` and `archivedCount`.
- `CHANGELOG.md` — archival behavior, the `roadmap.archive` flag, `paths.archive`, the read scope,
  the `PARTIAL → PARKED` edge and `status_reason`, in the same commit as the code.
- `README.md` — `roadmap.archive`, `paths.archive`, and active/archive ownership.
- `templates/ROADMAP.md` — a one-line note that inactive rows move to `ROADMAP-ARCHIVE.md`
  automatically. The template stays link-free and anchor-free; anchors are generated, not authored.
- `docs/features/COMP-ROADMAP-SHARD/feature.json` — record that its "active + archived" shape is
  superseded here and that it keeps size-triggered and per-phase placement policies on the ordered
  document-set loader S01 introduces.
- Forge `CLAUDE.md` — **unchanged**. forge-top stays manual until COMP-ROADMAP-ARCHIVE-NARRATIVE.

### S05-4 Dogfood (adjudication U)

Two steps, in this order, in one commit:

1. **On a copy.** `test/roadmap-archive-dogfood.test.js` (new) copies the real `ROADMAP.md`
   (1598 lines, ~172KB, 374 features) into a `makeRoadmapSet` workspace together with the real
   `docs/features/*/feature.json` set, publishes, and asserts: no inactive row remains in the active
   document; every preserved section survives (the four `test/roadmap-roundtrip.test.js:35` asserts);
   every anonymous `rawLine` appears exactly once across the set, including the Phase 0 block
   (`ROADMAP.md:30-34`); the rowless `SUPERSEDED by STRAT-1` phase (`:123`) is in the archive and the
   rowless PLANNED phase (`:411`) is not; `## Backlog — PLANNED` (`:1245`, the real mixed phase,
   14+ rows mixing PLANNED and COMPLETE) is split with heading and prose active; a second pass writes
   zero bytes; `compose roadmap check` exits 0.
2. **Reframe the live-repo test.** `test/roadmap-roundtrip.test.js` runs against the real file
   (`COMPOSE_ROOT`, `:27`) in seven tests. Each is re-pointed at the document set via
   `checkRoundtripSet` / `generateRoadmapDocument`, with the assertions preserved and only their
   scope widened from one text to the union. **No assertion is weakened**; `originalSections.size ===
   4` (`:35`) becomes the union's count and is asserted to still be 4.
3. **Enable on the real roadmap** by setting `roadmap.archive: true` in compose's own
   `.compose/compose.json` and letting the next ordinary transition perform the initial partition
   (adjudication Y). Expected one-time diff, called out so it is not read as a defect: every managed
   row gains an anchor, and any phase whose rendered feature set changes shape flips its header
   between the 3-column and 4-column forms (adjudication E, `lib/roadmap-gen.js:369` vs `:387`).

### S05-5 Tests

| File | Test name | Asserts |
|---|---|---|
| `test/get-roadmap.test.js` (extend) | `a generated-mode read writes no event` | fixture **with a diverging phase override** (C17); `.compose/data/feature-events.jsonl` byte-identical before and after; supersedes the mtime-only check at `:57` |
| | `default scope shows no inactive rows and reports the archived count` | |
| | `scope all plus code finds an archived feature in one call` | with `limit: 1` set, to prove the row cap does not hide it |
| | `format markdown with scope archive is refused` | `ARCHIVE_MARKDOWN_UNSUPPORTED` |
| | `a pending intent is reported as in-flight` | `inFlight: true`, nothing written |
| | `KILLED is counted` | the new bucket |
| `test/roadmap-archive-dogfood.test.js` (new) | as S05-4 step 1 | |
| `test/roadmap-roundtrip.test.js` (modify) | seven existing tests, reframed | assertions preserved |
| `test/roadmap-narrative-owned.test.js` (extend) | `no archive is created on a narrative-owned workspace` | archive path absent |

**Acceptance criteria covered by S05:**

- [ ] `get_roadmap` default scope shows no inactive rows, reports the archived count and writes
      nothing (no audit event); `scope: all` plus `code` finds an archived feature in one call;
      `format: markdown` with `scope: archive` is refused.
- [ ] Compose's own roadmap dogfood ends with no inactive rows in the active document and no lost
      prose.
- [ ] Readers report in-flight while the intent exists.
- [ ] Dogfooded on a copy of compose's own generated roadmap before enabling on the real one.

---

## 8. Golden-flow test design

One golden flow per core capability, real filesystem, no mocked writer. Every flow runs against a
`makeRoadmapSet` workspace from `test/helpers/roadmap-set-fixture.js`, except the dogfood flow, which
copies the real corpus. There is no live dispatch, no network and no remote publication anywhere in
this feature, so nothing here can reach an external service.

### 8.1 Crash-injection matrix

The service exposes `_internals = { renderSet, stageDocuments, writeIntent, renameTargets,
updateBaseline, clearIntent, sweepStaged }` so a test can stop between steps. Crash injection is
"call the steps up to N and then return", never `process.kill` — the assertion is about what the
**next service call** does with the state on disk, and that is identical either way.

| # | Stop after | State on disk | Next call must | Assert |
|---|---|---|---|---|
| X1 | step 5 (staging) | staged files beside the targets, **no** intent, both documents original | sweep and publish normally | no `.*.staged-*` left in either target directory; both documents equal the fresh render; baseline updated; `repaired === false` |
| X2 | step 6 (intent) | staged files + intent, both documents original | both targets hash to `pre_sha256`, so rename both, update baseline, clear | both documents match `post_sha256`; intent gone; no staged files left; `repaired === true` |
| X3 | step 7a (archive renamed) | intent, archive new, active original | repair: rename **active only** | archive not rewritten (its mtime is unchanged), active matches; `repaired === true` |
| X4 | step 7b (active renamed) | intent, both new, baseline stale | repair: no rename, update baseline, clear | both documents unchanged; baseline matches; `repaired === true` |
| X5 | X2 then delete a staged file | intent naming a missing staged file whose target still needs renaming | throw `ROADMAP_SET_INTENT_UNRECOVERABLE` | nothing written; intent preserved for the operator |
| X6 | X2, then run **any** producer | intent pending | repair, then `fn`, then publish, all under one lock | the producer's own write lands **after** the repair, and no second writer interleaves (R1-1); one consistent set |
| X7 | X2, then hand-edit the active document | intent pending; active hashes to neither `pre` nor `post` | refuse | `ARCHIVE_REPAIR_CONFLICT`; nothing renamed; intent kept; the hand edit still on disk (R1-7) |
| X8 | X2, then truncate `intent.json` | corrupt intent | refuse | `ROADMAP_SET_INTENT_CORRUPT`; both documents and the staged files untouched (R1-7) |

Each of X1–X4 is asserted to be repaired **exactly once**: a third call reports
`skipped: 'no_change'` and `repaired === false`.

### 8.2 Concurrent completion

Two `completionGate` calls on two different features, started without awaiting the first, against one
workspace. Each takes its own `completion-<CODE>` lock (`lib/completion-gate.js:311`), so both reach
the service, which serializes them on `roadmap-set.lock`. Asserts: both return `ok: true` with
`partial: false`; the final active document contains exactly one row per code and the archive exactly
one row for each completed feature; exactly one baseline manifest whose hashes match the files; no
intent left; the second render's input includes the first's output (no lost update).

A second case races `publishRoadmapSet` directly against `compose roadmap generate`, which holds only
the set lock (adjudication I), to prove the two orderings both converge.

A third case is the one the transaction API exists for (R1-1): suspend producer A inside its `fn`,
after its canonical write and before its publication, and start producer B. B must **block on the
set lock** until A completes, and B's render must include A's write. Under the withdrawn pre/post
pattern B would repair, mutate and publish inside A's window, and A would then republish over it.

### 8.3 Refused retry, then repair

The sequence the design calls out (design.md:183-186) and the one most likely to be got wrong:

1. Complete `FEAT-A` through the live gate with the archive sabotaged (`sabotageArchive`), so the
   document write fails. Assert `ok: true`, `partial: true`, `failures[0].step === 'roadmap'`,
   `recover` names `compose roadmap generate`, `result.status_flip_partial === true`, feature.json is
   COMPLETE, and `readIntent(root, 'FEAT-A') === null` — the gate's own intent is cleared
   (`lib/completion-gate.js:526`), matching `test/completion-gate.test.js:483-488`.
2. Retry the completion. Assert it is **refused** at `recovery` (`:350-360`), because the completion
   is committed. This is correct and must not change.
3. Un-sabotage. Run an ordinary `setFeatureStatus` on an unrelated `FEAT-B`. Assert the documents are
   repaired: `FEAT-A`'s row is in the archive with a redirect in the active document, and `FEAT-B`'s
   transition is also reflected. One pass, one set.
4. Repeat with the **backfill** gate instead of the live one, asserting the asymmetry (adjudication
   Z): the backfill's own intent is **kept** (`:1393`, `:1419`) and `status: 'pending'` is returned,
   while the service's intent is independent of it and is still what performs the repair.

### 8.4 Park / restore / park cycle

`FEAT-C` PLANNED → PARKED (with a reason) → PLANNED → PARKED. After every step assert:

- exactly one authoritative row for `FEAT-C` across the set;
- exactly one `## Moved` line mentioning `FEAT-C`, in the document that does **not** hold the row,
  and none at all while it is active and never moved;
- `status_reason` present in feature.json after each PARKED and untouched by the restore;
- the redirect anchor id is stable across the cycle;
- the fourth state is byte-identical to the second.

This is design Behavior 5's "never two of either", made a rendering invariant by adjudication W.

### 8.5 Mixed phase to whole-phase move

A phase with three rows: two COMPLETE, one PLANNED.

1. Assert heading and prose in the active document, back-link line plus two rows in the archive, and
   no `DUPLICATE_PHASE_HEADING` from `validateProject`.
2. Complete the third. Assert the whole phase — heading, prose, all three rows — is in the archive,
   the active document holds only a phase redirect in `## Moved`, no `ORPHAN_PHASE` finding, and the
   prose appears exactly once across the set.
3. Reactivate one. Assert the phase returns to the mixed shape and the byte output equals step 1's.

### 8.5a Reads during a publication (R1-2, R1-10)

With an intent on disk and the set lock held by a suspended transaction: `get_roadmap`,
`compose roadmap check` and `validateProject` each return promptly (no lock wait), report
`inFlight`, write nothing — event log, baseline, intent and both documents byte-identical — and the
validator emits exactly one `ROADMAP_SET_IN_FLIGHT` finding rather than the duplicate, missing,
dangling **and status-drift** findings the half-published bytes would otherwise produce (R2-9).
`compose roadmap check` exits 2.

A second case covers the torn read (R2-9): a reader is suspended between its two document reads
while a commit renames both files. It must not return the mismatched pair — it retries, and if the
generation keeps moving it returns `unstable: true`, which every reader treats exactly as `inFlight`
(R3-6): `checkRoundtripSet` returns null verdicts with no diffs, the validator emits only
`ROADMAP_SET_IN_FLIGHT`, and `compose roadmap check` exits 2 with its own retry message. A third case runs all three readers with `archiveActive` false and asserts each returns
the single-document shape it returns today (R2-10).

### 8.6 Dogfood on a copy of ROADMAP.md

As S05-4 step 1. It is a golden flow, not a unit test: real corpus, real feature.json set, real
service, and the assertions are the design's dogfood criterion. It runs before the real roadmap is
ever touched, and the reframe of `test/roadmap-roundtrip.test.js` lands in the same commit.

### 8.7 Test-run discipline

Targeted runs per slice: `node --test test/roadmap-archive.test.js` for S01,
`test/roadmap-archive-recovery.test.js` for S02, the four extended reader suites for S03,
`test/roadmap-archive-producers.test.js` plus the gate and writer suites for S04, and
`test/get-roadmap.test.js` plus the dogfood file for S05. **One** full `npm test` at integration,
after S05. Compose's suite needs `--test-timeout=90000`, and that timeout caps whole-file wall time,
so the dogfood file is kept to the one flow.

---

## File Plan

| File | Action | Purpose |
|---|---|---|
| `lib/roadmap-archive.js` | new | pure partition: status sets, placement rules, anon/phase keys, diagnostics |
| `lib/roadmap-documents.js` | new | ordered document set: load, render, anchors, `## Moved`, in-document link rewriting |
| `lib/roadmap-publish.js` | new | `withRoadmapSet` transaction, pure `loadRoadmapSet`/`renderRoadmapSet`, repair, baseline check, stage, intent, rename, clear |
| `lib/durable-write.js` | new | `fsyncDirectory`, `durableWriteJson`, `durableWriteText`, sha256 helpers, extracted from consumer-fanout |
| `lib/consumer-fanout.js` | edit | import the two moved primitives instead of defining them |
| `lib/roadmap-gen.js` | edit | `generateRoadmapDocument`, per-document rendering, anchored code cells |
| `lib/roadmap-preservers.js` | edit | `readAnonymousRowStatus`; anon rows gain `status` and `ordinal`; anchor stripping |
| `lib/roadmap-parser.js` | edit | strip anchors from the code cell |
| `lib/roadmap-residue.js` | edit | `computeResidueSet`; anchor stripping in `classifyLines` |
| `lib/roadmap-roundtrip.js` | edit | `checkRoundtripSet`; duplicate non-item rows become a reported diff |
| `lib/feature-validator.js` | edit | phase identity on `splitPhaseHeading`; set-aware context; mixed vs duplicate; `DUPLICATE_ROADMAP_ROW`; orphan-phase exemption |
| `lib/tracker/factory.js` | edit | new synchronous `isLocalTrackerConfig` export, reusing `loadTrackerConfig` (`:6`) and `providerFor`'s provider-kind decision (`:78-82`) — the single source of truth for "is this workspace local" (R3-7) |
| `lib/roadmap-config.js` | edit | `isArchiveEnabled`, `archiveActive` (imports `isLocalTrackerConfig` from the factory, never restates it), `loadRoadmapSetConfig`, path-collision refusal |
| `lib/roadmap-heading.js` | edit | `parseCodeCell`, the one shared code-cell reader (R1-11) |
| `lib/feature-write-guard.js` | edit | `scanRoadmapRows` uses `parseCodeCell`; `knownFeatureCodes` scans both documents (R1-11) |
| `lib/migrate-anon.js` | edit | `promoteAnonRow`'s two raw ROADMAP writes run inside the transaction (R1-5) |
| `lib/migrate-roadmap.js` | edit | becomes `async`; the `writeFeature` loop runs inside one transaction; `--dry-run` returns before it (R1-6, R2-7) |
| `lib/fluid/ideabox-ops.js` | edit | `promoteIdea`'s feature creation runs inside the transaction (R1-6) |
| `lib/paths-core.js` | edit | `DEFAULT_PATHS.archive` |
| `lib/project-paths.js` | edit | `resolveArchivePath`, `resolveArchivePathFromConfig` |
| `lib/get-roadmap.js` | edit | pure read, `scope`, `code`, `archivedCount`, `archivePath`, KILLED bucket, in-flight |
| `lib/feature-writer.js` | edit | `PARTIAL → PARKED`; required PARKED reason as `status_reason`; repair-before-mutation; set-aware `setRoadmapRowStatus` |
| `lib/completion-gate.js` | edit | both paths open the transaction inside the idempotency region and call `appendCompletionRecord` plus the status write in one `fn`; comments recording the live/backfill intent asymmetry |
| `lib/completion-writer.js` | edit | new `appendCompletionRecord` export: the read-modify-write half, called inside the transaction (R3-1) |
| `lib/build.js` | edit | four raw status writes route through the service |
| `lib/lane-gate.js` | edit | creation renders through the service |
| `lib/followup-writer.js` | edit | both recovery `writeRoadmap` calls become service calls |
| `lib/tracker/local-provider.js` | edit | `renderRoadmap` publishes the set and reports written vs skipped |
| `lib/tracker/github-provider.js` | edit | one log line: archival is local-only until COMP-ROADMAP-ARCHIVE-GH |
| `bin/compose.js` | edit | `compose feature` narrative guard and service render; `roadmap generate` through the service; `roadmap check` exit 2 on a pending intent; `init` writes the config keys |
| `server/mcp-tool-defs.js` | edit | `get_roadmap` gains `scope`, `code` and a `format` enum |
| `server/compose-mcp-tools.js` | edit | `toolGetRoadmap` description |
| `contracts/feature-json.schema.json` | edit | `status_reason` |
| `docs/mcp.md` | edit | ADD the `get_roadmap` entry and the scope section |
| `CHANGELOG.md` | edit | same commit as the code |
| `README.md` | edit | `roadmap.archive`, `paths.archive`, active/archive ownership |
| `templates/ROADMAP.md` | edit | one-line note on automatic archival |
| `docs/features/COMP-ROADMAP-SHARD/feature.json` | edit | record that the active/archived shape is superseded here |
| `test/helpers/roadmap-set-fixture.js` | new | `makeRoadmapSet`, reused by every slice |
| `test/roadmap-archive.test.js` | new | partition, anchors, redirects, mixed phases, link rewriting, collisions |
| `test/roadmap-archive-recovery.test.js` | new | intent/baseline contract, crash matrix, concurrency, hand edit, path collision |
| `test/roadmap-archive-producers.test.js` | new | every producer, PARKED reason, exit codes, refusal semantics |
| `test/roadmap-archive-dogfood.test.js` | new | the real corpus on a copy |
| `test/feature-writer.test.js` | edit | park/restore, same-status repair, `PARTIAL → PARKED`, existing partial-write assertions unchanged |
| `test/feature-writer-mcp.test.js` | edit | transitions over MCP against the set |
| `test/completion-gate.test.js` | edit | live/backfill projection failure against the set |
| `test/completion-writer.test.js` | edit | record-only moves nothing |
| `test/build-completion-gate.test.js` | edit | build start on a PARKED feature |
| `test/get-roadmap.test.js` | edit | no-mutation with a diverging override, scope, code, markdown refusal, in-flight, KILLED |
| `test/roadmap-roundtrip.test.js` | edit | seven live-repo tests reframed on the set (adjudication U) |
| `test/roadmap-residue.test.js` | edit | set-aware residue, anchored rows |
| `test/roadmap-parser.test.js` | edit | anchored code cell |
| `test/feature-validator.test.js` | edit | phase identity, mixed vs duplicate, duplicate row, orphan exemption |
| `test/roadmap-narrative-owned.test.js` | edit | no archive created |
| `test/roadmap-graph.test.js` | edit | `knownCodes` pin |
| `test/feature-write-guard.test.js` | edit | both-document scan; anchored cells (R1-11) |
| `test/migrate-anon.test.js` | edit | promotion inside the transaction, baseline intact (R1-5) |
| `test/migrate-roadmap.test.js` | edit | one transaction for the whole pass (R1-6); six call sites awaited (R2-7); `captureWarn` (`:68-72`) becomes async and awaits `fn()` inside its try so the `console.warn` restore cannot precede the awaited work (R3-8) |
| `test/ideabox.test.js` | edit | `promoteIdea` creates a row (R1-6); its suite is at `test/ideabox.test.js:288` |
| `test/roadmap-heading.test.js` | edit | `parseCodeCell` (R1-11) |
| `test/tracker-factory-local.test.js` | new | `isLocalTrackerConfig`: absent file, absent `tracker`, `provider: 'local'`, `provider: 'github'`, malformed JSON propagating `TrackerConfigError` (R3-7). A new file — no existing suite covers `lib/tracker/factory.js` directly |
| `test/completion-write-allowlist.test.js` | edit | assert the four new modules produce zero write-pattern hits |

## Boundary Map

Slice ids map to the sections above: S01 = §3, S02 = §4, S03 = §5, S04 = §6, S05 = §7. File formats,
exit codes, on-disk JSON shapes, the anchor and redirect syntax, the diagnostics vocabulary and the
publication ordering are deliberately absent from the entries below — they are not grep-checkable
identifiers and live in the prose above, per the template's symbol-only restriction.

### S01: pure partition, document set, anchors
Produces:
  lib/roadmap-archive.js → partitionRoadmap, nextRedirects, anonRowKey, normalizeAnonRawLine, featureAnchorId, phaseAnchorId, placementForStatus (function)
  lib/roadmap-archive.js → ARCHIVE_ACTIVE_STATUSES, ARCHIVE_INACTIVE_STATUSES, ARCHIVE_DIAGNOSTIC_CODES, ANON_KEY_SEP (const)
  lib/roadmap-documents.js → renderDocumentSet, renderMovedSection, parsePriorRedirects, readPreservedByDocument, rewriteCrossDocumentLinks, stripAnchors, anchorCell, documentRelativeLink (function)
  lib/roadmap-documents.js → DOCUMENT_IDS, MOVED_HEADING, MOVED_SECTION_HEADING (const)
  lib/roadmap-gen.js → generateRoadmapDocument, generateRoadmapFromBase, generateRoadmap, writeRoadmap (function)
  lib/roadmap-heading.js → parseCodeCell, splitPhaseHeading, parseStatusToken (function)
  lib/roadmap-preservers.js → readAnonymousRowStatus, readAnonymousRows, readPhaseOverrides, readPhaseBlocks, readPhaseOrder (function)
  test/helpers/roadmap-set-fixture.js → makeRoadmapSet (function)

Consumes: nothing (leaf node)

### S02: durable publication
Produces:
  lib/durable-write.js → fsyncDirectory, durableWriteJson, durableWriteText, sha256OfFile, sha256OfString (function)
  lib/roadmap-publish.js → withRoadmapSet, loadRoadmapSet, renderRoadmapSet, publishRoadmapSet, readPublishIntent, readBaselineManifest, roadmapSetLockPath, repairPendingPublication, preflightTargets (function)
  lib/roadmap-publish.js → PUBLISH_INTENT_VERSION, BASELINE_MANIFEST_VERSION (const)
  lib/roadmap-config.js → isArchiveEnabled, archiveActive, loadRoadmapSetConfig, isNarrativeOwned, narrativeOwnedMessage (function)
  lib/tracker/factory.js → isLocalTrackerConfig, providerFor (function)
  lib/project-paths.js → resolveArchivePath, resolveArchivePathFromConfig (function)
  lib/paths-core.js → DEFAULT_PATHS (const)
  lib/tracker/local-provider.js → LocalFileProvider (class)

Consumes:
  from S01: lib/roadmap-archive.js → partitionRoadmap, nextRedirects
  from S01: lib/roadmap-documents.js → renderDocumentSet, parsePriorRedirects, readPreservedByDocument
  from S01: lib/roadmap-gen.js → generateRoadmapDocument

### S03: set-aware parse, roundtrip, residue, validator
Produces:
  lib/roadmap-parser.js → parseRoadmap, detectColumnLayout, splitRoadmapCells (function)
  lib/roadmap-residue.js → computeResidueSet, computeResidue, protectResidue (function)
  lib/roadmap-roundtrip.js → checkRoundtripSet, checkRoundtrip, describeLossyDiff (function)
  lib/roadmap-roundtrip.js → LOSSY_LABELS, MAX_REGEN_PASSES (const)
  lib/feature-validator.js → loadValidationContext, validateProject, validateFeature, effectiveStatus (function)
  lib/feature-write-guard.js → scanRoadmapRows, knownFeatureCodes, assertLinkTargetsExist (function)

Consumes:
  from S01: lib/roadmap-documents.js → DOCUMENT_IDS, MOVED_HEADING
  from S01: lib/roadmap-heading.js → parseCodeCell
  from S01: lib/roadmap-archive.js → ARCHIVE_INACTIVE_STATUSES
  from S02: lib/roadmap-publish.js → loadRoadmapSet, renderRoadmapSet
  from S02: lib/roadmap-config.js → archiveActive, isArchiveEnabled, loadRoadmapSetConfig
  from S02: lib/tracker/factory.js → isLocalTrackerConfig
  from S02: lib/project-paths.js → resolveArchivePath

### S04: producer wiring
Produces:
  lib/feature-writer.js → setFeatureStatus, addRoadmapEntry, setRoadmapRowStatus, roundtripGuard (function)
  lib/feature-writer.js → _internals (const)
  lib/completion-gate.js → completionGate, readIntent (function)
  lib/completion-writer.js → appendCompletionRecord, recordCompletion (function)
  lib/build.js → runBuild (function)
  lib/lane-gate.js → applyFrontTriage (function)
  lib/followup-writer.js → proposeFollowup (function)
  lib/migrate-anon.js → promoteAnonRow, runMigrateAnon (function)
  lib/migrate-roadmap.js → migrateRoadmap (function)
  lib/fluid/ideabox-ops.js → promoteIdea (function)
  lib/tracker/github-provider.js → GitHubProvider (class)

Consumes:
  from S01: lib/roadmap-archive.js → ARCHIVE_INACTIVE_STATUSES
  from S01: lib/roadmap-heading.js → parseCodeCell
  from S02: lib/roadmap-publish.js → withRoadmapSet, publishRoadmapSet, readPublishIntent
  from S02: lib/roadmap-config.js → archiveActive, isArchiveEnabled, isNarrativeOwned, narrativeOwnedMessage
  from S02: lib/tracker/factory.js → isLocalTrackerConfig
  from S03: lib/roadmap-roundtrip.js → checkRoundtripSet
  from S03: lib/roadmap-residue.js → computeResidueSet

### S05: readers, MCP surface, docs, dogfood
Produces:
  lib/get-roadmap.js → getRoadmap (function)
  server/compose-mcp-tools.js → toolGetRoadmap (function)

Consumes:
  from S02: lib/roadmap-publish.js → loadRoadmapSet, renderRoadmapSet, readPublishIntent
  from S02: lib/roadmap-config.js → archiveActive
  from S02: lib/tracker/factory.js → isLocalTrackerConfig
  from S03: lib/feature-validator.js → validateProject
  from S03: lib/roadmap-roundtrip.js → checkRoundtripSet
  from S04: lib/feature-writer.js → setFeatureStatus

## Review log

**Round 1, Codex, 2026-09-09.** Twelve findings on the first blueprint draft. All twelve accepted and
folded in, recorded as C43–C54 in the Corrections table and referenced inline as R1-1 … R1-12. What
changed, by finding:

| # | Finding | Sections rewritten |
|---|---|---|
| R1-1 | The lock has to span repair, canonical mutation and publication as one transaction; the pre-call/post-call pattern leaves a window between them | §2.6 intro, S02-3 (new `withRoadmapSet` API and sequence), S02-4, every S04 producer table, §8.2, Boundary Map S02/S04 |
| R1-2 | Reads must be pure: `dryRun` still locked, repaired and swept | S02-3 (new `loadRoadmapSet` / `renderRoadmapSet`, `dryRun` removed), S03-4, S03-5, S04-4 (`roadmap check`, `roadmap generate`), S05-1, §8.5a, Boundary Map S03/S05 |
| R1-3 | Redirects must survive a pass in which nothing moves; `## Moved` is output **and** input | §2.6 (set algebra), §2.7 (`MOVED_HEADING` exclusion), S01-1, S01-2 (`parsePriorRedirects`), S01-5 tests |
| R1-4 | Preserved content must be keyed per document, never flat-merged | §2.6, S01-1 (`preservedByDocument`), S01-2 (`readPreservedByDocument`), S01-5 tests |
| R1-5 | `setRoadmapRowStatus` and `migrate-anon` write the roadmap directly, bypassing baseline and intent | §1 C47, S04-1, S04-6, File Plan, S04-8 tests |
| R1-6 | Three producers missing: `compose triage`, ideabox promotion, `roadmap migrate` | §1 C39 amended + C48, S04-4, S04-6, File Plan, S04-8 tests |
| R1-7 | Repair must fail closed; a malformed intent or baseline is an error, not "absent" | §2.4, §2.5, §2.6 diagnostics, S02-3 step 1, S02-6 tests, §8.1 rows X5, X7, X8 |
| R1-8 | Residues need a `documentId` so `--protect` can wrap per document | S03-3, S04-4 (`roadmap generate`), S03-8 tests |
| R1-9 | Enforce local-only: the flag alone is not the enable predicate | §2.2 (`archiveActive`), S02-3 step 0, S02-4, S02-5, every S04 table, S04-8 tests |
| R1-10 | While in flight, suppress placement-derived findings and emit one `ROADMAP_SET_IN_FLIGHT` | S03-4, S03-5, S05-1, §8.5a, S03-8 tests |
| R1-11 | One shared `parseCodeCell` for six readers; the guard scans both documents; one anchor per feature, not per item row | §2.7, S01-4, S03-2, S03-5, new S03-6, Boundary Map S01/S03/S04, File Plan |
| R1-12 | Stage beside the target, not under the state directory, or the commit rename can fail EXDEV | §2.3, §2.4, S02-3 steps 1/5/9, S02-6 tests, §8.1 row X1 |

Two of the twelve changed a decision rather than adding detail, and are worth naming: R1-1 withdrew
the pre-call/post-call integration pattern entirely, and R1-2 removed `dryRun` from the service. Both
were load-bearing in the first draft, so any later reading of this blueprint should treat the
transaction API and the pure read pair as the contract, not as an addition to it.

Three of the twelve were defects that no test in the planned matrix would have caught, because the
planned assertions were satisfied by the broken behavior: the vanishing redirect on an unchanged pass
(R1-3), the flat-merged preservers losing mixed-phase prose (R1-4), and the repair clobbering a
concurrent hand edit (R1-7). Their tests are named in S01-5, S02-6 and §8.1 rather than left to the
verification phase.

**Round 2, Codex, 2026-09-09.** Ten findings on the round-1 fixes. All ten accepted and folded in,
recorded as C55–C64 and referenced inline as R2-1 … R2-10. What changed, by finding:

| # | Finding | Sections rewritten |
|---|---|---|
| R2-1 | The transaction window started after the canonical *reads*, so the decisions were still raceable | S04-1 (window moved to `:447-517`, same-status semantics stated), S04-8 tests |
| R2-2 | Lock cycle: idempotency → set on one side, set → idempotency on the other | S02-3 (three-level lock-order table and the scoping rule), S04-2, S04-3, S02-6 tests |
| R2-3 | Repair renamed as it went, and the commit re-verified nothing | S02-3 steps 1 and 7 (non-mutating preflight over every target and staged file), `PublishResult.conflicts` gains `phase`, S02-6 tests, §8.1 |
| R2-4 | No seam existed for a surgical edit, so "patch the staged bytes" was unimplementable | S02-3 (`transformDraft` hook — later replaced by `patchSource`, R3-2), S04-1, S04-6, S02-6 tests |
| R2-5 | `--protect` protected a pre-lock read | S04-4 (`roadmap generate` gets an in-lock hook — later `protectBase`, R3-2) |
| R2-6 | The retry branches of triage and ideabox promotion performed no repair | S04-4, S04-6, S04-8 tests |
| R2-7 | `migrateRoadmap` is synchronous and consumed synchronously; `--dry-run` would have started writing | S04-4 (async, caller table, dry-run early return), File Plan |
| R2-8 | A bare staged-file glob can delete another workspace's bytes in a shared document root | S02-3 step 9, S02-6 tests |
| R2-9 | A lock-free reader can tear across the two-file commit | S02-3 (generation-bracketed snapshot, `unstable`), S03-5 (suppression widened to status and description drift), S05-1, §8.5a, S02-6 tests |
| R2-10 | Readers ignored the enable predicate; three sites still said `stripAnchors` | §2.2, §2.7, S01-3, S03-6, S05-1, §8.5a, S02-6 tests |

Three of the ten were latent defects rather than gaps: the lock cycle (R2-2) would have deadlocked
any backfill carrying an idempotency key, the partial repair (R2-3) could leave a set in a state no
later repair can classify, and the torn read (R2-9) produces fabricated duplicate and drift findings
with no flag set to explain them. R2-7 is the cheapest and the easiest to ship broken: making one
function async without its six call sites prints `undefined` counts and fails nothing.

Two findings changed an API rather than a decision. `transformDraft` (R2-4) was new surface that
round 1's R1-5 assumed without providing — **superseded by R3-2 below, which replaced it with
`protectBase` and `patchSource`; `transformDraft` does not exist in the contract** — and the reader
snapshot contract (R2-9) means `loadRoadmapSet` is no longer a plain pair of file reads.

**Round 3, Codex, 2026-09-09.** Eight findings on the round-2 fixes. All eight accepted and folded
in, recorded as C65–C72 and referenced inline as R3-1 … R3-8. What changed, by finding:

| # | Finding | Sections rewritten |
|---|---|---|
| R3-1 | Moving `recordCompletion` wholly outside the transaction traded a deadlock for a lost update | S02-3 (lock table and the split), S04-2, S04-3 (`appendCompletionRecord`), File Plan, Boundary Map S04, S02-6 tests |
| R3-2 | `transformDraft` ran after the render, which is the wrong state for both its callers | S02-3 (hook replaced by `protectBase` and `patchSource`), S04-1, S04-4, S04-6, S02-6 tests |
| R3-3 | The snapshot key was a wall-clock timestamp | §2.5 (`generation`, `last_operation_id`), S02-3, S02-6 tests |
| R3-4 | A `patchSource` producer had no channel for its own verdict | S02-3 (result shape), S04-1, S04-8 tests |
| R3-5 | The triage retry branch does perform a read-modify-write | S04-4, S04-8 tests |
| R3-6 | `unstable` was declared equivalent to `inFlight` but wired in only two places | S03-4, S04-4, §8.5a, S02-6 tests |
| R3-7 | The reader predicate needed an async provider from two synchronous entry points | §2.2 and S02-2 (`isLocalTrackerConfig` exported from `lib/tracker/factory.js`, imported everywhere, never mirrored), S02-3, S03-6, File Plan, Boundary Map S02/S03/S04/S05, S02-6 tests |
| R3-8 | `captureWarn` restores `console.warn` before an awaited `fn` settles | S04-4 caller table, File Plan |

Two of the eight are regressions introduced by round 2's own fixes, which is the pattern to expect
when a fix round is reviewed: R3-1's lost update was created by R2-2's lock-order fix, and R3-2's
wrong-state hook was created by R2-4. Neither was reachable before those changes. Three more are
silent failures rather than crashes — the vacuous `captureWarn` assertions (R3-8), the fabricated
roundtrip diffs on a torn read (R3-6), and the swallowed `changed` verdict that would make every
reconcile claim a change (R3-4).

**Round-3 fixes were applied without a round-4 re-review**, by review budget: three rounds is the
cap, and the remaining risk is in implementation detail rather than in a contradiction between
sections. That makes these eight areas the least-reviewed text in the blueprint, so **the
implementer's first Codex pass should target them first**: the `recordCompletion` split and its lock
nesting, the two source hooks and which one each producer uses, the baseline `generation` and the
reader snapshot, the transaction result channel, the triage retry branch, `unstable` propagation
through the roundtrip and `roadmap check`, the synchronous tracker predicate and its single home in the
tracker factory, and the async `captureWarn`.

## Verification Table

Phase 5, 2026-09-09. Four verification passes (one per draft revision); this table is the final pass over the round-3 text: 144 unique `path:line` refs, all MATCH; Boundary Map validator ok with zero violations and zero warnings; File Plan existence check 62/62 (10 new files absent, 52 edit files present). Two slips found in earlier passes (`feature-validator.js:218`→`:219`, `roadmap-graph/index.js:4`→`:22`) and one prose slip (`factory.js:80`→`:81`) were corrected in place.

| Ref | Claim | Verdict |
|---|---|---|
| bin/compose.js:1165 | `writeFeature` call has no phase/position/roundtrip guard/audit event | MATCH |
| bin/compose.js:1318 | `generateRoadmapFromBase` called purely for drift side effect | MATCH |
| bin/compose.js:1327-1331 | `protectResidue(base,residue)` then `checkRoundtrip(protectedBase,…)` | MATCH |
| bin/compose.js:1329 | `--protect` branch guard | MATCH |
| bin/compose.js:1344 | prose-loss refusal → exit 1 | MATCH |
| bin/compose.js:1493 | `migrateRoadmap` consumed synchronously, no `await` | MATCH |
| bin/compose.js:1509-1541 | `check` subcommand exit codes (0/1/1) | MATCH |
| bin/compose.js:3255 | `readFeature` feeding `if (!existing)` | MATCH |
| bin/compose.js:3257 | `writeFeature(...status:'PLANNED')` inside `if (!existing)` | MATCH |
| bin/compose.js:3267-3271 | `updateFeature` in the `else` retry branch | MATCH |
| bin/compose.js:423 | start of init `config` object | MATCH |
| bin/compose.js:423-446 | init config: 6 `paths` keys, no archive/roadmap sub-object | MATCH |
| contracts/feature-json.schema.json:7 | `additionalProperties: true` | MATCH |
| lib/build.js:2102 | teardown `persistFeatureRaw(...,PLANNED)`, no prior-status read | MATCH |
| lib/build.js:2609 | start write `persistFeatureRaw(...,IN_PROGRESS)` | MATCH |
| lib/canon-registry.js:112 | `writer: 'lib/roadmap-gen.js'` for ROADMAP canon entry | MATCH |
| lib/completion-gate.js:120-129 | `readIntent` returns null on missing/malformed | MATCH |
| lib/completion-gate.js:135-137 | tmp-then-copy; "Rename" comment but no rename | MATCH |
| lib/completion-gate.js:311 | `completion-<CODE>` lock dir | MATCH |
| lib/completion-gate.js:318 | dynamic import of `feature-writer.js` | MATCH |
| lib/completion-gate.js:492-497 | ROADMAP regen try/catch collects into `failures` | MATCH |
| lib/completion-gate.js:494 | `provider.renderRoadmap()` (live path) | MATCH |
| lib/completion-gate.js:526 | `clearIntent` unconditional | MATCH |
| lib/completion-writer.js:343 | `maybeIdempotent` wraps `recordCompletion` | MATCH |
| lib/completion-writer.js:351 | `provider.getFeature` — read half of R-M-W | MATCH |
| lib/completion-writer.js:65 | `feature-<CODE>.lock` path | MATCH |
| lib/consumer-fanout.js:54-62 | `fsyncDirectory` defined here | MATCH |
| lib/consumer-fanout.js:64-77 | `durableWriteJson` defined here (unexported) | MATCH |
| lib/dir-lock.js:154 | "not reentrant" doc comment | MATCH |
| lib/dir-lock.js:163 | `withDirLock` export | MATCH |
| lib/dir-lock.js:55 | `LOCK_STALE_MS = 20000` | MATCH |
| lib/dir-lock.js:57 | `LOCK_ACQUIRE_TIMEOUT_MS = 30000` | MATCH |
| lib/feature-reconciler.js:256-258 | `set_roadmap_row_status` reads `r.changed !== false` | MATCH |
| lib/feature-validator.js:1249 | `ROADMAP_LOSSY` finding push | MATCH |
| lib/feature-validator.js:148 | `loadValidationContext` — sync entry point | MATCH |
| lib/feature-validator.js:172-237 | validator's hand-rolled ROADMAP scan | MATCH |
| lib/feature-validator.js:181 | phase regex splits on first em-dash | MATCH |
| lib/feature-validator.js:469 | `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON` check | MATCH |
| lib/feature-validator.js:776 | `DUPLICATE_PHASE_HEADING` finding | MATCH |
| lib/feature-write-guard.js:121 | `codeRaw` strip in `scanRoadmapRows` | MATCH |
| lib/feature-writer.js:1243 | `_internals` export | MATCH |
| lib/feature-writer.js:145 | `maybeIdempotent` takes idempotency lock | MATCH |
| lib/feature-writer.js:294 | `renderRoadmap()` throws `partialWriteError` (add path) | MATCH |
| lib/feature-writer.js:352 | `isLocalProvider` export | MATCH |
| lib/feature-writer.js:447 | `provider.getFeature` in `setFeatureStatus` | MATCH |
| lib/feature-writer.js:49-58 | `TRANSITIONS`: no SUPERSEDED target; PARTIAL no PARKED edge | MATCH |
| lib/feature-writer.js:509-517 | `persistFeatureRaw` then `renderRoadmap()` throws | MATCH |
| lib/feature-writer.js:52 | `PARTIAL` transition list | MATCH |
| lib/feature-writer.js:526 | `args.reason` used exactly once | MATCH |
| lib/feature-writer.js:838 | `rewriteLinks` export | MATCH |
| lib/feature-writer.js:870-880 | "full renderRoadmap() unsafe here" rationale | MATCH |
| lib/feature-writer.js:891 | `setRoadmapRowStatus` return-contract JSDoc | MATCH |
| lib/feature-writer.js:893 | `setRoadmapRowStatus` export | MATCH |
| lib/feature-writer.js:927 | `codeRaw` strip in `setRoadmapRowStatus` | MATCH |
| lib/feature-writer.js:958-960 | tmp-write + `renameSync` — only atomic ROADMAP write | MATCH |
| lib/fluid/ideabox-ops.js:414 | `promoteIdea` export | MATCH |
| lib/fluid/ideabox-ops.js:435 | creating-branch guard | MATCH |
| lib/fluid/ideabox-ops.js:439 | `writeFeature(...PLANNED)` inside creating branch | MATCH |
| lib/followup-writer.js:549 | `_internals` export | MATCH |
| lib/get-roadmap.js:28 | `BUCKET` map — no KILLED entry | MATCH |
| lib/get-roadmap.js:56 | `getRoadmap` — synchronous | MATCH |
| lib/get-roadmap.js:65 | `generateRoadmap(root,{})` — no `suppressDrift` | MATCH |
| lib/idempotency.js:138 | `acquireLock(cwd)` inside `checkOrInsert` | MATCH |
| lib/lane-gate.js:50 | `applyFrontTriage` export | MATCH |
| lib/lane-gate.js:99 | `createFeature(...PLANNED)` | MATCH |
| lib/migrate-anon.js:174 | raw `writeFileSync` (forward) | MATCH |
| lib/migrate-roadmap.js:102 | `writeFeature(cwd,feature,featuresDir)` | MATCH |
| lib/migrate-roadmap.js:27 | `migrateRoadmap` — synchronous (no `async`) | MATCH |
| lib/paths-core.js:11 | `DEFAULT_PATHS` — 6 keys, no archive | MATCH |
| lib/paths-core.js:28 | `resolvePathValue` export | MATCH |
| lib/roadmap-config.js:23 | `isNarrativeOwned` export | MATCH |
| lib/roadmap-drift.js:30 | `emitDrift` export | MATCH |
| lib/roadmap-errors.js:16 | `RoadmapProseLossError` class | MATCH |
| lib/roadmap-gen.js:109 | dedupe via `new Set(sourcePhaseOrder)` | MATCH |
| lib/roadmap-gen.js:129-143 | source-only phase block spliced verbatim | MATCH |
| lib/roadmap-gen.js:151 | `emitDrift` gated on override≠rollup + `!suppressDrift` | MATCH |
| lib/roadmap-gen.js:151-152 | override-diverges drift emission | MATCH |
| lib/roadmap-gen.js:354 | `hasSubItems` computed via `.some()` | MATCH |
| lib/roadmap-gen.js:363 | consumers read only `rawLine`/`predecessorCode` | MATCH |
| lib/roadmap-gen.js:369 | 4-col header when `hasSubItems` | MATCH |
| lib/roadmap-gen.js:373 | item rows rendered from `items[]` | MATCH |
| lib/roadmap-gen.js:393 | row is four plain cells | MATCH |
| lib/roadmap-gen.js:437-443 | `renderPhase` also emits one row/item | MATCH |
| lib/roadmap-gen.js:525 | `writeRoadmap` bare `writeFileSync` | MATCH |
| lib/roadmap-graph/index.js:22 | `deps.yaml` mention location | MATCH |
| lib/roadmap-graph/model.js:12 | `DROP_STATUSES` = COMPLETE/SUPERSEDED/KILLED | MATCH |
| lib/roadmap-graph/model.js:125 | `depsToEdges` export | MATCH |
| lib/roadmap-heading.js:30 | `parseStatusToken` export | MATCH |
| lib/roadmap-heading.js:42 | `PHASE_HEADING_TEXT_RE` regex | MATCH |
| lib/roadmap-heading.js:76 | `splitPhaseHeading` — rightmost boundary | MATCH |
| lib/roadmap-parser.js:14 | re-export from `roadmap-heading.js` | MATCH |
| lib/roadmap-parser.js:173-178 | anon rows renamed `_anon_${position}` | MATCH |
| lib/roadmap-parser.js:18 | `SKIP_STATUSES` = inactive set + BLOCKED | MATCH |
| lib/roadmap-parser.js:198-217 | `statusCol: lower.length-1` every branch | MATCH |
| lib/roadmap-parser.js:38 | `splitRoadmapCells` export | MATCH |
| lib/roadmap-parser.js:54 | `parseRoadmap` export | MATCH |
| lib/roadmap-preservers.js:140-147 | `readAnonymousRows`' own column detection | MATCH |
| lib/roadmap-preservers.js:167 | code-cell read | MATCH |
| lib/roadmap-preservers.js:178 | stores exactly `{rawLine,predecessorCode}` | MATCH |
| lib/roadmap-preservers.js:26 | `PRESERVED_OPEN_RE` grammar | MATCH |
| lib/roadmap-preservers.js:312 | `readPhaseBlocks`' heading-match branch | MATCH |
| lib/roadmap-preservers.js:39 | `readPhaseOverrides` export | MATCH |
| lib/roadmap-residue.js:142 | anon/curated row → `'other'` | MATCH |
| lib/roadmap-residue.js:176 | `##` dedupe vs `###` occurrence-count comment | MATCH |
| lib/roadmap-residue.js:249 | `sectionSlug` grammar | MATCH |
| lib/roadmap-residue.js:269 | `protectResidue` export | MATCH |
| lib/roadmap-residue.js:85 | `classifyLines` function | MATCH |
| lib/roadmap-roundtrip.js:101 | non-item branch takes `group[0]` | MATCH |
| lib/roadmap-roundtrip.js:92-99 | items-bearing: full multiset compare | MATCH |
| lib/tracker/factory.js:6 | `loadTrackerConfig` — module-private | MATCH |
| lib/tracker/factory.js:78 | `providerFor` export (async) | MATCH |
| lib/tracker/github-provider.js:517 | `renderRoadmap()` (GitHub provider) | MATCH |
| lib/tracker/github-provider.js:517-544 | fetch→merge→putContents, SHA-conflict retry | MATCH |
| lib/tracker/local-provider.js:100 | `renderRoadmap()` → `writeRoadmap` | MATCH |
| lib/tracker/local-provider.js:67 | `putFeature` throws on status delta | MATCH |
| ROADMAP.md:123 | `## Phase 5 ... SUPERSEDED by STRAT-1` | MATCH |
| ROADMAP.md:28 | 3-col Phase 0 header | MATCH |
| ROADMAP.md:30 | Discovery row literal | MATCH |
| ROADMAP.md:30-34 | Phase 0 anon-row block (5 rows) | MATCH |
| server/compose-mcp-tools.js:186 | `toolGetRoadmap` export | MATCH |
| server/compose-mcp-tools.js:186-188 | passes `args` straight through | MATCH |
| server/compose-mcp.js:171 | `get_roadmap` dispatch case | MATCH |
| server/mcp-tool-defs.js:325-341 | `get_roadmap` tool def block | MATCH |
| server/mcp-tool-defs.js:326 | `name: 'get_roadmap'` | MATCH |
| server/mcp-tool-defs.js:334 | `format` — no enum today | MATCH |
| server/mcp-tool-policy.js:61 | `get_roadmap` on `REVIEWER_ALLOW` | MATCH |
| server/roadmap-graph-vision.js:58 | `parseRoadmap` inside try/catch | MATCH |
| test/completion-gate.test.js:38 | `makeWorkspace` helper | MATCH |
| test/completion-gate.test.js:474-488 | `AC-4c` projection-failure test | MATCH |
| test/completion-gate.test.js:483-488 | specific partial/failures assertions | MATCH |
| test/completion-writer.test.js:44 | `sabotageRoadmap` helper | MATCH |
| test/completion-writer.test.js:558 | `#11b` regen-fails-after-flip test | MATCH |
| test/feature-reconciler.test.js:43 | local `writeRoadmap` helper | MATCH |
| test/feature-validator.test.js:27 | local `writeRoadmap` helper | MATCH |
| test/feature-write-guard.test.js:37 | local `writeRoadmap` helper | MATCH |
| test/feature-writer-vision-projection.test.js:29 | local `writeRoadmap` helper | MATCH |
| test/feature-writer.test.js:333 | `ROADMAP_PARTIAL_WRITE` test | MATCH |
| test/feature-writer.test.js:356 | audit-not-appended assertion | MATCH |
| test/get-roadmap.test.js:36 | `makeNarrative` helper | MATCH |
| test/get-roadmap.test.js:57 | mtime-only no-mutation test | MATCH |
| test/ideabox.test.js:288 | `describe('promoteIdea', ...)` | MATCH |
| test/migrate-roadmap.test.js:68 | `captureWarn` helper | MATCH |
| test/roadmap-drift.test.js:22 | `beforeEach` setup, `emitDrift` file | MATCH |
| test/roadmap-roundtrip.test.js:35 | 4 preserved-sections assertion | MATCH |
| **Boundary Map validator** | `validateBoundaryMap({...})` against current blueprint | **MATCH** — `{"ok":true,"violations":[],"warnings":[]}` |
| **File Plan existence check** | 62 entries (10 new / 52 edit); every `new` absent, every `edit` present on disk | **MATCH** — 0 violations |

### Counts

MATCH: 144 refs + 2 structural checks = **146/146**. OFF-BY: 0. STALE: 0. FILE-MISSING: 0.
