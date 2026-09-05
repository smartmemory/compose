# COMP-LIFECYCLE-BACKFILL: Blueprint

**Date:** 2026-09-05
**Status:** BLUEPRINT — revised after gate rounds 1 and 2 (18 + 13 findings, all confirmed, all folded)
**Design:** `docs/features/COMP-LIFECYCLE-BACKFILL/design.md` — the "Revision 2026-09-05" section, the
three adjudication tables at its end, and the "Addendum 2026-09-05 (blueprint gate round 1)" are
authoritative; earlier prose is history.
**Review:** `docs/features/COMP-LIFECYCLE-BACKFILL/reviews/blueprint-r1-2026-09-05.md` and
`blueprint-r2-2026-09-05.md` (Codex gpt-6-astra/high). Round-1 findings are referenced below as
**BP-1** … **BP-18**, round-2 findings as **R2B-1** … **R2B-13**.

## Related Documents

- `docs/features/COMP-LIFECYCLE-BACKFILL/design.md` — decisions this blueprint implements
- `docs/features/COMP-LIFECYCLE-BACKFILL/reviews/blueprint-r1-2026-09-05.md`,
  `reviews/blueprint-r2-2026-09-05.md` — the two gates this revision answers
- `docs/features/COMP-LIFECYCLE-BACKFILL/explore-compose-2026-09-05.md` — compose grounding map
- `docs/features/COMP-LIFECYCLE-BACKFILL/explore-stratum-2026-09-05.md` — stratum grounding map
- `docs/features/COMP-COMPLETION-GATE/design.md` — the gate this feature adds an intent to
- `docs/features/COMP-MCP-ENFORCE/design.md` — the guard this feature completes
- stratum `ts/docs/features/STRAT-GUARD-DESCRIPTOR/design.md` — the signed-descriptor primitive
- stratum `STRAT-GUARD-DIGEST` (0.4.3) — the `guard digest` action BP-1 depends on
- stratum `STRAT-GUARD-EXPECTED-CHECKSUM` (0.4.4) — the atomic `expected_policy_checksum` R2B-7 depends on

---

## 1. Corrections

Rows C1–C20 were established in the first draft and re-verified for this revision. Rows C21–C28 come
out of the gate. "Design says" quotes the design doc; "Reality" is what the file holds today.

| # | Design says | Reality (file:line) | Consequence for the blueprint |
|---|---|---|---|
| C1 | S0 `STRAT-GUARD-CLI-APPLY` is a slice to build | **Already shipped**, and so is its successor. `apply-upgrade`, `policy` and now `digest` are live CLI actions: `stratum/ts/src/cli/guard.ts:21` (ACTIONS set), `:128-129` (apply-upgrade), `:183-184` (policy), `:204-224` (digest). `ts/package.json:3` reads **`0.4.3`** — `STRAT-GUARD-DIGEST` landed while this revision was being written, and the compiled action is present in the installed `dist/cli/guard.js` | S0 is DONE and BP-1's stratum dependency is **satisfied**, not pending. Compose consumes all three as-is |
| C2 | UI files are `src/components/ItemDetailPanel.jsx`, `ContextPipelineDots.jsx` | They are `src/components/vision/ItemDetailPanel.jsx` and `src/components/vision/ContextPipelineDots.jsx` | S3 paths corrected. The phase-label map the design never names is `LIFECYCLE_PHASE_LABELS` in `src/components/vision/constants.js:50-63` and must gain `complete_backfilled` or the UI prints the raw state name |
| C3 | Adding the node means changing `buildPhaseGraph` + `terminalOf` + `phaseToStatus` | There is a **fourth** terminal declaration: `export const TERMINAL = new Set(['complete','killed'])` at `server/lifecycle-guard.js:56`, imported by `server/vision-routes.js` and used for the terminal refusals on advance (`:400`), skip (`:441`) and kill (`:482`) | Leaving `TERMINAL` stale lets a route advance or kill **out of** `complete_backfilled`. It must gain the node in the same edit |
| C4 | `_registered` is a cache the `legacy` state can be stored in | `server/lifecycle-guard.js:236` is a `Set<resourceId>`; `:301` returns `{guard_id, status:'cached'}` on a hit | The cache becomes a `Map<resourceId, 'registered'\|'legacy'>`. `_testOnly_resetGuardCache()` (`:238`) keeps its signature |
| C5 | Fix mode's initial state is at `lib/lifecycle-modes.js:83` | `:83` is the `fix:` key. `genesis: 'reproduce'` is `:96`, and there is an exported accessor `genesisOf(mode)` at `:201` | Bootstrap uses `genesisOf(mode)`, never a literal |
| C6 | Registration seeds `initial` from the phase at first contact — `lifecycle-guard.js:290` | `:290-298` is the docstring; the code is `initial: currentPhase` at `:309` | Citation only |
| C7 | `currentGuardState` returns `null` for an unregistered resource at `completion-gate.js:178` | `:178` is the regex test; the `return { state: null }` is `:180` | Citation only |
| C8 | The gate emits the audit event only when the status flipped — `completion-gate.js:485` | The condition is `if (statusChanged) {` at `:486` | Citation only |
| C9 | `decision-event-emit.js:64-67` builds the fixed metadata object | The object literal is `:65-68` | Citation only |
| C10 | `vision-routes.js:317` writes the `explore_design` genesis | `:317` resolves the mode; `const genesis = 'explore_design'` is `:318`, the history write `:330` | Citation only |
| C11 | `reconciler.js:97` recreates a missing first live entry with the current time | `:97` is the `historyEmpty && currentPhase` test; the timestamp is `:108` | Citation only |
| C12 | `contracts/comp-obs-contract.schema.json` needs "a contract version bump" | Current `version` is `"0.2.6"` (`:5`) | The bump is **0.2.6 → 0.2.7** with a new `_changelog` entry |
| C13 | The stratum trust root "ships EMPTY" | Confirmed: 1892 bytes of comment, zero signer lines. **But** `node_modules/@smartmemory/stratum` is a **symlink to `/Users/ruze/reg/my/forge/stratum/ts`** | In this workspace the operator step is "edit `stratum/ts/contracts/guard-signers.allowed` and rebuild `dist`", not "npm install". Both forms go in the README |
| C14 | The override token "no longer exists" | True in stratum (`ts/src/cli/guard.ts:109-113` takes `authorization`). **Compose still ships the dead wrapper** `guardOverride` at `server/stratum-client.js:367-376` sending `override_token` | Out of scope. Flagged so nobody reads it as a working fallback |
| C15 | Recovery "re-issues the persisted envelope so stratum's replay check verifies the payload" | The payload digest **binds the policy checksum** (`ts/src/guard/transition.ts:131`, `:559`), compared in `_maybeReplay` (`:467`), which throws `IdempotencyConflict` (`:468`) | A descriptor applied between attempts turns replay into `idempotency_conflict` — and, since R3-2, on `policy_checksum_mismatch` too. **Superseded by C21** — the first draft's fix was itself rejected as BP-1 |
| C16 | Golden flow needs a test seam for guard history | None needed. `currentGuardState` lazily imports `guardHistory` (`lib/completion-gate.js:156`), which spawns through `flowGateBin()` → `resolveStratumBin('cli', …)`, honouring `COMPOSE_STRATUM_TS_CLI_BIN` first (`lib/stratum-engine.js:134`, `:218-221`) | One env var routes every guard verb to the isolated copy. The golden flow injects no fakes |
| C17 | The guard `_client` seam covers the guard calls | `server/lifecycle-guard.js:230` is `{ register, transition }` only | The new verbs are called through `server/stratum-client.js` directly, as `currentGuardState` already does. Existing `_client` tests keep working |
| C18 | `terminalOf('build')` gains `complete_backfilled` | `test/lifecycle-modes.test.js` and `test/lifecycle-modes-golden.test.js` pin build's `terminal`; **and (BP-17) `test/lifecycle-modes-golden.test.js:26-27` pins adjacency with `.filter(x => x !== 'killed')`, while `test/judgment-writer.test.js:449-467` pins the guard graph's surplus-edge list to exactly five entries** | Three suites break by design and are updated in the same commit. See S1-1 |
| C19 | The evidence containment pattern is `lib/canon-guard.js:46-95` | `stripFirmlink` is `:50-52`; the exported `realpathCanonicalize` is `:65-88`. `lib/feature-writer.js` `validateRepoPath` is `:610-641` and has **no** firmlink strip | The resolver composes both (§4.3) |
| C20 | Guard-off projects can backfill | `guardTestCommand` reads `guard.testCommand` (`server/lifecycle-guard.js:280-288`); **this repo configures none** | Every backfill here must carry `tests_pass: true`. Stated in the MCP tool description |
| **C21** | (first draft) recovery on `idempotency_conflict` may adopt a ledger entry that matches the operation id, `to_state` and `outcome` | **BP-1: that reintroduces R2-1.** An operation id learned from a leaked intent could be spent on another payload and then adopted | Recovery now requires the ledger entry's `payload_digest` to equal a digest **stratum computes** for the persisted envelope plus the policy checksum persisted in the intent, via the new read-only CLI action `guard digest` (`STRAT-GUARD-DIGEST`, stratum 0.4.3). Compose never reimplements `fingerprint.ts`/`canonical.ts`. See §5.9 |
| **C22** | (first draft) the terminal/policy checks run before the transition on every path | **BP-2:** a recovery attempt would be refused by the terminal check (the resource is already at `complete_backfilled`) before it ever reached the replay, and it re-derived `fromState` from live guard state rather than replaying the saved one | Bootstrap and recovery are **separate branches**. Recovery replays the persisted envelope unchanged, before any terminal or policy check (§5.4a) |
| **C23** | (first draft) recovery reads `occurrences`, `tests_attested` and `operation_id` from either the pending batch record or the intent | **BP-3:** the batch record schema never carried the request, the envelope, the checksum or the attestation, so half those reads were of fields that are never written | **One recovery DTO: the intent file.** The pending batch record is a marker only. A pending record with no intent **refuses** (§5.3) |
| **C24** | (first draft) `insertBackfilledPhases` runs at write step 6.0, after the guard transition | **BP-4:** a history refusal would then arrive after the guard had already moved to a terminal state | The prospective history is materialised and validated **before** register / upgrade / transition, and that exact validated result is what gets persisted (§5.5, §5.10) |
| **C25** | (first draft) the record flips to `finalized` after the writes, and the audit uses `safeAppendEvent` | **BP-5:** `safeAppendEvent` swallows failures (`lib/feature-writer.js:414-422`), so "the audit event reached disk" was never actually established; and the in-memory record was mutated before the save that could fail | Finalize only when the failure set is empty **and** a non-swallowing `provider.appendEvent` (`:417`) returned. Roll the in-memory record back on a save failure. Emit the backfill audit even when the status was already COMPLETE (§5.10) |
| **C26** | (first draft) the terminal occurrence is appended with `timestamp: now` on every attempt | **BP-6:** a re-drive appends a second terminal occurrence and re-stamps every `recordedAt` | All backfill timestamps are minted **once** and persisted in the intent. The terminal occurrence carries `operation_id`; the append is skipped when one with that id is already present (§5.10) |
| **C27** | (first draft) the MCP tool calls `completionGate` directly | **BP-10:** the MCP server is a **separate process** from the compose server, and the gate's history writes must go through the server's live in-memory store (`server/vision-store.js` has no lock, `explore-compose` §4) | The MCP tool delegates to the HTTP route through the existing `_postLifecycle` helper (`server/compose-mcp-tools.js:702-717`), exactly as `toolCompleteFeature` does (`:779-786`). The route passes the live store into the gate (§S3-2) |
| **C28** | (first draft) preflight and the write sequence are mode-independent | **BP-11/BP-12:** `fix`, `plan` and `judgment` all have `runner.tracksFeatureJson:false` (`lib/lifecycle-modes.js:104`, `:133`, `:175`) so `provider.getFeature` returns nothing and the existing preflight refuses them at `completion-gate.js:294`. And with `capabilities.guard:false` the first draft still called `guard policy` / `ensureGuard` | Preflight, steps 6.1–6.3 and the status projection are gated on `tracksFeatureJson`; every stratum call is inside `if (guarded)`, with local terminal legality when it is off (§5.3, §5.4b, §5.10) |
| **C29** | (first draft) consecutive occurrences are checked against `transitionsOf(mode)` | **R2B-1:** the forward graph does **not** contain `complete_backfilled` — only the augmented `buildPhaseGraph(mode)` does (S1-1). The final pair `<fromState> -> complete_backfilled` was therefore unreachable by construction | The merge takes **both** graphs: caller occurrences against the forward graph, any pair whose target is an adapter-added terminal against the augmented one (§4.1). Without this **every** backfill refuses at `history` |
| **C30** | (first draft) `originals := index(existing, '_tid')` is the untouched baseline | **R2B-5:** it indexes the same objects the closure loop then rewrites, so step 4d compares each object with itself and can never fire; and the `from == null` that identifies the genesis marker is destroyed before the marker test reads it | An independent `snapshot` clone is taken up front, marker identity is computed off it **before** any rewrite, and 4d compares against it (§4.1) |
| **C31** | (first draft) recovery replays through `guardedTransition` | **R2B-2:** that calls `ensureGuard` first (`server/lifecycle-guard.js:334-337`), and after a second descriptor the stored policy matches neither the new policy nor its legacy projection, so registration refuses before the replay is ever attempted | Recovery calls the raw transport `guardTransition` in `server/stratum-client.js:349-359` with the persisted envelope and no `ensureGuard` (§5.9a) |
| **C32** | (first draft) `if (g.applied)` accepts the transition | **R2B-6:** `:376` maps `replayed` to `applied:true`, so a replay — which returns the historical verdict and the registry's current state (`ts/src/guard/transition.ts:479-487`) — was accepted without checking whether anything moved the resource afterwards | `guardedTransition` surfaces `status` verbatim, and every recovery success requires all three of: the digest-matched applied ledger entry under this key, `current_state` still `complete_backfilled`, and no later mutating entry (§5.9b/§5.9c) |
| **C33** | (first draft) the persisted policy checksum is the one the transition hashes under | **R2B-7:** `guard policy` and `guard transition` are two processes taking the lock in turn, so a descriptor applied between them leaves compose holding P while stratum hashes Q — and a later recovery then computes a digest matching nothing | **Cross-repo:** `STRAT-GUARD-EXPECTED-CHECKSUM` (stratum 0.4.4) adds optional `expected_policy_checksum` to `guard transition`, refused atomically under the resource lock with `policy_checksum_mismatch`, writing nothing. Compose sends it on every fresh backfill transition and treats the mismatch as a retryable refusal (§5.6, §5.8) |
| **C34** | (first draft) `store.updateLifecycle` is the only durable write a fix/plan backfill needs | **R2B-9:** `updateLifecycle` (`server/vision-store.js:235-253`) does **not** touch `item.status`, so a `tracksFeatureJson:false` item finalized with its lifecycle reading `complete_backfilled` and its status still `in_progress` | Step 6.4's else-branch performs the durable `item.status = 'complete'` write the live unmanaged path already does (`server/vision-routes.js:615`), with rollback and failure collection (§5.10) |
| **C35** | (round 2) the new transition options are forwarded as `idempotency_key` / `expected_policy_checksum` | **R3-1:** `_client.transition` is `server/stratum-client.js`'s `guardTransition` (`:349`), which destructures **camelCase**. Snake_case properties are discarded silently — no throw, no warning — taking replay identity and checksum protection with them | camelCase across every JS boundary; snake_case only inside `runGuard`'s payload object. `guardTransition` gains `expectedPolicyChecksum`; the wire assertions at `test/stratum-client-guard.test.js:80-103` are extended to assert the absence of the camelCase keys (S1-2, §5.8) |
| **C36** | (round 2) a recovery replay sends no `expected_policy_checksum`, because the checksum is expected to have moved | **R3-2:** that covers only the post-transition crash. In the **pre-transition** window no ledger entry exists, so `_maybeReplay` returns null (`transition.ts:467-469`) and stratum **applies** under whatever policy is current (`:638-664`). The verification then checks against the persisted checksum, finds nothing, and refuses forever — with the guard already moved | The recovery sends the persisted checksum too, so it can never apply except under the policy the intent was written against. `policy_checksum_mismatch` routes to §5.9c, a **read-only** verification (`guard digest` + `guard history`); if the operation never applied, refuse at `recovery` with an operator-actionable message and keep the intent (§5.9a, §5.9c, §5.11) |
| **C37** | (round 2) `write_plan.history` is an array of `BackfilledOccurrence` | **R3-3:** live entries carry none of `origin`/`recordedAt`/`confidence`/`episode`/`evidence` (`server/lifecycle-phase-history.js:31-42`), including the genesis record every lifecycle starts with (`server/vision-routes.js:330`). No item that had ever run a lifecycle could produce a valid intent | Split the schema: `StoredHistoryEntry` (live/legacy, backfill fields optional) alongside `BackfilledOccurrence` (constructed, all required); `write_plan.history` items are `anyOf` the two. A contract test validates an intent carrying a real genesis record (§2) |
| **C38** | (round 2) recovery restores the write inputs it needs | **R3-4:** step 6.0 still read `probe.history` / `probe.written` / `probe.skipped`, which exist only on the fresh branch; it used a fresh `now` instead of `op.started_at`; and it never restored `notes`, a `recordCompletion` argument (`lib/completion-gate.js:425`) | One `writeContext` object, built by **both** branches, is the only thing §5.10 reads. Its field table names the source on each side and says which fields the intent persists; `notes`, `guard_initial`, `upgrade` and `policy_checksum` become **required** (nullable) so a missing one refuses instead of defaulting (§5.4a, §5.7, §5.10) |
| **C39** | (round 2) the divergence check re-merges the terminal occurrence safely | **R3-5:** the terminal's `origin` is `live` (§5.5), while the claim index covers only `origin === 'backfill'` (§4.1). Once step 6.0 persists it, the retry's terminal ties with its stored twin on the same instant and **every** post-6.0 recovery refuses at `history` | §4.1 gains a step 3a that dedups by `operation_id` **before** the claim index and before every step-4 refusal, verifying the stored entry's immutable fields first. Flow A gains step 6b: recovery after a successful 6.0 (§4.1, §5.4a) |
| **C40** | (round 2) the recovery suffix scan rejects later `transition`, `override` and `migrate` entries | **R3-6:** stratum writes exactly three kinds — `transition` (`transition.ts:653`), `deviation` (`:765`) and `graph_version` (`:838`, `:1050`, `:1130`). `override` and `migrate` are not kinds, so **an override passed the check silently** while a migration was rejected under a name never written | Reject later `transition` and `deviation`; allow `graph_version` only after verifying `from_state == to_state`; refuse an unrecognised kind. Flow A's condition-3 variant is rebuilt: an override needs a declared edge (`:757-759`), so a signed migrate adds `complete_backfilled ↔ killed` and two overrides round-trip the state (§5.9c, §7.3) |
| **C41** | (round 2) passing the persisted guard flag to the projector makes the projection honour it | **R3-7:** the route closure hardcodes `consultGuard: true` (`server/vision-routes.js:564`) and the verifier independently reads live config (`server/completion-projection.js:136`). false→true spawns stratum on an unguarded resume; true→false silently downgrades the verification tier | Thread the effective flag through the closure **and** add `guardEnabledOverride` to `verifiedCompleteProjection`/`applyVerifiedProjection`, read with `??` so a persisted `false` is honoured. Flow A step 9 asserts both flips through the real projection path, proving the guard-off half with a marker script (§5.10a, S3-1, S3-3) |
| **C42** | (round 2) `require.resolve('<dep>/package.json')`, falling back to the bare specifier, locates every dependency | **R3-8:** measured — `@openai/codex-sdk` fails **both** legs (`ERR_PACKAGE_PATH_NOT_EXPORTED`; its `exports` publishes an `import` condition only), and `@modelcontextprotocol/sdk`'s `"./*"` wildcard resolves `./package.json` to `dist/cjs/package.json`, a plausible wrong answer. `import.meta.resolve` takes no parent argument, so it cannot resolve from stratum's context either | Symlink stratum's whole `node_modules` into the copy — demonstrated end to end, exit 1 with the expected usage text and no `MODULE_NOT_FOUND` — and keep a directory-walk resolver (which `exports` cannot block) plus a package-`name` check on every resolved root as the partial-hoisting fallback, arbitrated by the smoke run (§7.1) |
| **C43** | (round 3) the intent schema allowed `expected_policy_checksum: null` and the payload table + schema description still said "not sent on a replay" | **R4-1:** stratum enforces the checksum only when the key is supplied (`ts/src/cli/guard.ts:104-106`, `transition.ts:566`), so the leftover omission re-opened the pre-transition window R3-2 closed | Schema field is `string`, required, equal to `policy_checksum`; payload table row corrected; §5.9a refuses at `recovery` on a null/mismatched checksum BEFORE the transport call and always sends `writeContext.policyChecksum` |
| **C44** | (round 3) §5.9a/§5.9c and S1-3 checked `.error` on raw transport results | **R4-2:** `runGuard` returns stratum's canonical `{status:'error', error_type, message}` unchanged on a non-zero exit (`server/stratum-client.js:235`; envelope at `ts/src/cli/guard.ts:42-46`) and wraps only spawn/parse failures as `{error}` — so `policy_checksum_mismatch` fell into the success branch and a history error reached `h.ledger.find` as a `TypeError` | Three helpers `isGuardError` / `guardErrorType` / `guardErrorMessage` exported from `server/lifecycle-guard.js`; every raw call site uses them; harness rows R25-R29 run under both shapes |

### Design points that were not implementable as written

1. **Atomicity of the checksum read (C33).** `guard policy` and `guard transition` cannot be made
   atomic from compose's side, so this one is closed in stratum: `STRAT-GUARD-EXPECTED-CHECKSUM`
   (0.4.4) is a **prerequisite for the fresh-transition path**, exactly as `guard digest` was for the
   recovery path — and, since R3-2, for the recovery path too. **It has landed and is installed:**
   `ts/package.json:3` reads `0.4.4`, `ts/src/cli/guard.ts:98` accepts `expected_policy_checksum`, and
   `ts/src/guard/transition.ts:566-570` / `:633-637` enforce it under both locks. Compose must still
   not send the key to an older CLI — an older stratum refuses an unknown payload key outright
   (`assertOnlyKeys`) — so the send stays gated on the installed CLI advertising it.
2. **Recovery across a policy change (C15 → C21).** Closed by the design addendum: stratum computes
   the digest, compose compares it. This is now a **cross-repo dependency**: `STRAT-GUARD-DIGEST` must
   have landed in stratum 0.4.3, which it now has — `guard digest` is live at
   `ts/src/cli/guard.ts:207-227` and compiled into the installed `dist`. Compose's side is the
   `guardDigest` wrapper (S1-2) and the verification branch (§5.9); nothing is blocked.
3. **The fourth terminal declaration (C3).** `TERMINAL` in `lifecycle-guard.js` is an independent
   source of truth consulted by three routes; the design's three-symbol change list would have shipped
   a state the guard treats as terminal and the routes do not.
4. **Three pinning suites, not one (C18/BP-17).** The golden adjacency assertions and the
   judgment-writer surplus-edge list are both change-detectors on exactly this graph.

---

## 2. Contract: `contracts/lifecycle-backfill.schema.json` (new)

Draft-07, `additionalProperties:false` at every level. `_source` and `_roadmap` are mandatory per the
documentation rule.

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://forge.local/contracts/lifecycle-backfill.schema.json",
  "title": "COMP-LIFECYCLE-BACKFILL — backfill request, occurrence, intent and batch record",
  "version": "1.0.0",
  "_source": "docs/features/COMP-LIFECYCLE-BACKFILL/design.md",
  "_roadmap": "COMP-LIFECYCLE-BACKFILL",
  "_changelog": { "1.0.0": "Initial: BackfillRequest, BackfilledOccurrence, BackfillIntent, BackfillRecord." },

  "definitions": {

    "EvidenceRef": {
      "type": "object",
      "required": ["kind", "ref"],
      "properties": {
        "kind": { "type": "string", "enum": ["commit", "path"] },
        "ref":  { "type": "string", "minLength": 1,
                  "description": "40-char lowercase hex SHA when kind=commit; repo-relative regular file path when kind=path." }
      },
      "additionalProperties": false
    },

    "ResolvedEvidence": {
      "description": "EvidenceRef after server resolution. verifiedAt and observedTime are server-written and MUST NOT be caller-supplied.",
      "type": "object",
      "required": ["kind", "ref", "verifiedAt", "observedTime", "observedEpochMs"],
      "properties": {
        "kind":            { "type": "string", "enum": ["commit", "path"] },
        "ref":             { "type": "string", "minLength": 1 },
        "verifiedAt":      { "type": "string", "format": "date-time" },
        "observedTime":    { "type": "string", "format": "date-time",
                             "description": "Commit AUTHOR date (git show -s --format=%aI, which carries the committer's UTC OFFSET) or file mtime." },
        "observedEpochMs": { "type": "integer",
                             "description": "BP-8: the epoch form, computed once at resolution. Every ordering and interval comparison uses THIS, never the string — %aI offsets make string comparison wrong across timezones." }
      },
      "additionalProperties": false
    },

    "BackfillRequest": {
      "type": "object",
      "required": ["feature_code", "commit_sha", "tests_pass", "files_changed", "reason", "occurrences"],
      "properties": {
        "feature_code":  { "type": "string", "minLength": 1 },
        "commit_sha":    { "type": "string", "pattern": "^[0-9a-f]{40}$" },
        "tests_pass":    { "type": "boolean",
                           "description": "Ignored when guard.testCommand is configured and exits 0; otherwise must be true. No silent default." },
        "files_changed": { "type": "array", "items": { "type": "string" } },
        "reason":        { "type": "string", "minLength": 1,
                           "description": "Mandatory prose. Why this work skipped the phase walk." },
        "notes":         { "type": "string" },
        "occurrences":   { "type": "array", "minItems": 0, "items": { "$ref": "#/definitions/RequestedOccurrence" } }
      },
      "additionalProperties": false
    },

    "RequestedOccurrence": {
      "type": "object",
      "required": ["phase", "evidence"],
      "properties": {
        "phase":    { "type": "string", "minLength": 1,
                      "description": "BP-9: MUST be a node of the item's mode graph. An unknown phase is refused, never accepted as out-of-graph." },
        "evidence": { "$ref": "#/definitions/EvidenceRef" }
      },
      "additionalProperties": false
    },

    "StoredHistoryEntry": {
      "description": "R3-3: an entry that is ALREADY on disk in lifecycle.phaseHistory[]. `appendPhaseHistory` (server/lifecycle-phase-history.js:23-44) writes exactly the eight fields below (:31-42) and nothing else, and every live entry ever written — including the lifecycle genesis record minted at server/vision-routes.js:330 — therefore carries no origin, recordedAt, confidence, episode or evidence. The merge preserves those records byte-for-byte (Decision: no migration), so the stored-history schema MUST accept them. The five backfill-only fields are optional here precisely so an entry this feature wrote validates under this branch too.",
      "type": "object",
      "required": ["phase", "step", "enteredAt", "exitedAt", "from", "to", "outcome", "timestamp"],
      "properties": {
        "phase":      { "type": "string" },
        "step":       { "type": "string" },
        "enteredAt":  { "type": "string", "format": "date-time" },
        "exitedAt":   { "type": ["string", "null"], "format": "date-time" },
        "from":       { "type": ["string", "null"] },
        "to":         { "type": "string" },
        "outcome":    { "type": ["string", "null"] },
        "timestamp":  { "type": "string", "format": "date-time" },
        "recordedAt": { "type": "string", "format": "date-time" },
        "origin":     { "type": "string", "enum": ["live", "backfill"] },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "episode":    { "type": "integer", "minimum": 1 },
        "operation_id": { "type": "string", "format": "uuid" },
        "evidence":   { "$ref": "#/definitions/ResolvedEvidence" }
      },
      "additionalProperties": false
    },

    "BackfilledOccurrence": {
      "description": "BP-9: the FULL entry this feature CONSTRUCTS and appends to lifecycle.phaseHistory[]. R3-3: this is the constructor's contract, not the store's — it governs `occurrences` and `terminal_occurrence`, which the gate builds field by field in §5.5, and never a record read off disk. Dual-shape: the legacy fields keep ItemDetailPanel/ContextPipelineDots/session-routes working; from/to/outcome/timestamp keep decision-events-snapshot working. Every field is constructed, none is left undefined.",
      "type": "object",
      "required": ["phase", "step", "enteredAt", "exitedAt", "from", "to", "outcome", "timestamp", "recordedAt", "origin", "confidence", "evidence", "episode"],
      "properties": {
        "phase":      { "type": "string" },
        "step":       { "type": "string", "description": "Equals phase, as appendPhaseHistory writes it (:34-35)." },
        "enteredAt":  { "type": "string", "format": "date-time", "description": "Valid-time start = evidence.observedTime." },
        "exitedAt":   { "type": ["string", "null"], "format": "date-time",
                        "description": "Recomputed by the merge from valid time: the next occurrence's enteredAt, or null when last." },
        "from":       { "type": ["string", "null"],
                        "description": "The phase of the preceding occurrence in the merged order, or null when first." },
        "to":         { "type": "string", "description": "Equals phase." },
        "outcome":    { "type": ["string", "null"], "description": "'backfilled' for a backfilled occurrence." },
        "timestamp":  { "type": "string", "format": "date-time", "description": "Equals enteredAt." },
        "recordedAt": { "type": "string", "format": "date-time",
                        "description": "Transaction time, minted ONCE and persisted in the intent (BP-6). Never re-stamped on a re-drive." },
        "origin":     { "type": "string", "enum": ["live", "backfill"] },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "episode":    { "type": "integer", "minimum": 1,
                        "description": "1 = pre-adoption (enteredAt < lifecycle.startedAt), 2 = at or after it." },
        "operation_id": { "type": "string", "format": "uuid",
                          "description": "Present on the TERMINAL occurrence only (BP-6), so a re-drive can detect it and skip the append." },
        "evidence":   { "$ref": "#/definitions/ResolvedEvidence" }
      },
      "additionalProperties": false
    },

    "BackfillIntent": {
      "description": "BP-3: the SINGLE recovery DTO, at .compose/data/completion-intents/<CODE>.json. Everything recovery needs is here; the batch record is a marker only. A superset of the live-completion intent, so readIntent's existing callers are unaffected.",
      "type": "object",
      "required": ["operation_id", "feature_code", "commit_sha", "files_changed", "notes",
                   "tests_attested", "started_at", "intent", "request_digest", "reason", "mode",
                   "occurrences", "terminal_occurrence", "write_plan", "envelope", "guarded",
                   "guard_initial", "upgrade", "policy_checksum"],
      "comment": "R3-4: notes, guard_initial, upgrade and policy_checksum are REQUIRED although all four are nullable. Every one of them is a write input §5.10 consumes; making presence mandatory means a resumed attempt can tell 'the operation had none' from 'the intent did not record it', and an intent that omits one fails validation instead of silently handing recovery an undefined.",
      "properties": {
        "operation_id":   { "type": "string", "format": "uuid" },
        "feature_code":   { "type": "string" },
        "commit_sha":     { "type": ["string", "null"] },
        "tests_attested": { "type": "boolean" },
        "started_at":     { "type": "string", "format": "date-time" },
        "intent":         { "type": "string", "const": "backfill" },
        "request_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "reason":         { "type": "string" },
        "mode":           { "type": "string" },
        "guarded":        { "type": "boolean", "description": "R2B-4: the EFFECTIVE guard flag for the WHOLE operation, captured once. A resumed attempt branches on this, never on live config — a flag flipped between the crash and the retry must not change how the operation completes." },
        "files_changed":  { "type": "array", "items": { "type": "string" },
                            "description": "R2B-3: a recordCompletion argument, so it must survive to a resume." },
        "notes":          { "type": ["string", "null"] },
        "guard_initial":  { "type": ["object", "null"], "description": "R2B-3: copied onto the batch record; recovery must not recompute it." },
        "upgrade":        { "type": ["object", "null"], "description": "R2B-3: the descriptor stamp for the batch record." },
        "write_plan": {
          "description": "R2B-3: the VALIDATED write plan from §5.5 — the exact array to persist and the key lists for the batch record. A resumed attempt reuses it rather than re-deriving it.",
          "type": "object",
          "required": ["history", "written", "skipped"],
          "properties": {
            "history": {
              "description": "R3-3: the MERGED array — stored entries the merge preserved PLUS the occurrences this operation adds. Its items are a union, not one shape: a live/legacy record has none of the backfill fields, so requiring them here would make the intent unvalidatable for every item that ever ran a lifecycle. anyOf, not oneOf: a backfilled entry satisfies BOTH branches by construction (StoredHistoryEntry's extra fields are optional), and oneOf would reject exactly the entries this feature writes.",
              "type": "array",
              "items": { "anyOf": [ { "$ref": "#/definitions/BackfilledOccurrence" },
                                    { "$ref": "#/definitions/StoredHistoryEntry" } ] }
            },
            "written": { "type": "array", "items": { "type": "string" } },
            "skipped": { "type": "array", "items": { "type": "string" } }
          },
          "additionalProperties": false
        },
        "occurrences":    { "type": "array", "items": { "$ref": "#/definitions/BackfilledOccurrence" },
                            "description": "BP-4/BP-6: the MATERIALISED, VALIDATED, stably-timestamped occurrences, persisted before the transition." },
        "terminal_occurrence": { "$ref": "#/definitions/BackfilledOccurrence" },
        "policy_checksum": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$",
                             "description": "BP-1: the checksum from `guard policy` AFTER any upgrade and BEFORE the transition. The digest recomputation depends on it. Null when guarded is false." },
        "envelope": {
          "type": "object",
          "required": ["from", "to", "artifacts", "resolved_by", "idempotency_key", "modified_files"],
          "properties": {
            "from":            { "type": "string" },
            "to":              { "type": "string", "const": "complete_backfilled" },
            "artifacts":       { "type": "object" },
            "modified_files":  { "type": "array", "items": { "type": "string" } },
            "resolved_by":     { "type": "string", "const": "agent" },
            "idempotency_key": { "type": "string", "format": "uuid" },
            "expected_policy_checksum": { "type": "string", "pattern": "^[0-9a-f]{64}$",
                                          "description": "R2B-7/R3-2/R4-1: ALWAYS present and non-null — equal to the intent's `policy_checksum`. Sent on the fresh transition AND on every recovery replay, so a pre-transition crash followed by a policy change can never apply under the new policy (stratum enforces only when the key is supplied, ts/src/cli/guard.ts:104-106; transition.ts:566). The contract test asserts an envelope without it, or with a value differing from `policy_checksum`, is REJECTED." }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },

    "BackfillRecord": {
      "description": "BP-3: one entry in lifecycle.backfills[], keyed by operation_id. A MARKER, not a recovery source — it says what happened, the intent says what to do next.",
      "type": "object",
      "required": ["operation_id", "request_digest", "state", "reason", "recordedAt", "completionEvidence", "actor"],
      "properties": {
        "operation_id":   { "type": "string", "format": "uuid" },
        "request_digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "state":          { "type": "string", "enum": ["pending", "finalized"] },
        "reason":         { "type": "string", "minLength": 1 },
        "recordedAt":     { "type": "string", "format": "date-time" },
        "finalizedAt":    { "type": ["string", "null"], "format": "date-time" },
        "completionEvidence": {
          "type": "object",
          "required": ["commit_sha", "tests_attested"],
          "properties": {
            "commit_sha":     { "type": ["string", "null"], "pattern": "^[0-9a-f]{40}$" },
            "tests_attested": { "type": "boolean" },
            "verified_at":    { "type": "string", "format": "date-time" }
          },
          "additionalProperties": false
        },
        "guardRef":       { "type": ["string", "null"] },
        "guard_initial":  {
          "type": ["object", "null"],
          "required": ["registered", "lifecycle_phase"],
          "properties": {
            "registered":      { "type": "string" },
            "lifecycle_phase": { "type": "string" }
          },
          "additionalProperties": false
        },
        "upgrade": {
          "type": ["object", "null"],
          "required": ["descriptor_id", "status"],
          "properties": {
            "descriptor_id": { "type": "string" },
            "status":        { "type": "string", "enum": ["applied", "unchanged"] },
            "ledger_ref":    { "type": ["string", "null"] }
          },
          "additionalProperties": false
        },
        "actor":          { "type": "string", "description": "resolved_by plus the transport, e.g. 'agent:rest'." },
        "occurrenceKeys": { "type": "array", "items": { "type": "string" },
                            "description": "phase + U+001F + evidence.ref for each occurrence this operation wrote. Uses UNIT SEPARATOR, never a NUL byte — a NUL in a JSON document breaks grep and every line-oriented tool." }
      },
      "additionalProperties": false
    }
  }
}
```

### Obs-contract additions (`contracts/comp-obs-contract.schema.json`, modify)

- `"version": "0.2.6"` → `"0.2.7"` (`:5`).
- New `_changelog` entry keyed `"0.2.7"` above `"0.2.6"` (`:9`): `"COMP-LIFECYCLE-BACKFILL
  (2026-09-05) — DecisionEvent kind=phase_transition metadata gains three OPTIONAL fields (origin,
  recorded_at, confidence). additionalProperties:false is kept; required stays [from_phase, to_phase],
  so every 0.2.6 event still validates."`
- The `phase_transition` branch (`:267-268`) becomes:

```jsonc
{
  "if":   { "properties": { "kind": { "const": "phase_transition" } } },
  "then": { "properties": { "metadata": {
    "type": "object",
    "required": ["from_phase", "to_phase"],
    "properties": {
      "from_phase":  { "type": "string" },
      "to_phase":    { "type": "string" },
      "origin":      { "type": "string", "enum": ["live", "backfill"],
                       "description": "ABSENT means live — stored records are not migrated and the emitter passes the field through unchanged (BP-16). Readers interpret absence; the emitter never defaults it." },
      "recorded_at": { "type": "string", "format": "date-time" },
      "confidence":  { "type": "number", "minimum": 0, "maximum": 1 }
    },
    "additionalProperties": false
  } } }
}
```

`BuildStreamEvent.schema_version` stays `const "0.2.5"`, exactly as the 0.2.6 bump note at `:9` records
for its own bump.

### Confidence values

`commit → 0.9`, `path → 0.6`, live → `1.0`, in a frozen `CONFIDENCE_BY_KIND` in
`lib/backfill-evidence.js`, asserted by a contract test so the numbers exist in one place.

### Contract tests (`test/lifecycle-backfill-contract.test.js`, new)

- **Test first — R3-3, the genesis record.** Build a `BackfillIntent` whose `write_plan.history[0]` is
  the **literal** record `appendPhaseHistory` produces for a lifecycle start — take it from a real
  store, or construct it with the same call the route makes
  (`appendPhaseHistory({lifecycle}, {from:null, to:'explore_design', outcome:null, timestamp})`,
  `server/vision-routes.js:330`), giving
  `{phase:'explore_design', step:'explore_design', enteredAt:T, exitedAt:null, from:null,
  to:'explore_design', outcome:null, timestamp:T}` and **no** origin, recordedAt, confidence, episode
  or evidence. Assert the intent **validates**. Written against the first draft's schema this test
  fails, which is the point: `write_plan.history` required `BackfilledOccurrence` of every entry, so
  no item that had ever run a lifecycle could produce a valid intent.
- The same array's later entries — a backfilled occurrence carrying all thirteen fields, and the
  terminal occurrence carrying `operation_id` — validate in the same document.
- An entry with an **unknown** property is rejected under both branches (`additionalProperties:false`
  on each), so the union widens the accepted shapes without widening the accepted fields.
- `occurrences` and `terminal_occurrence` still require the full `BackfilledOccurrence`: feed one a
  legacy-shaped entry and assert it is **rejected**. Those two arrays are constructed by §5.5, never
  read off disk, so the strictness that is wrong for `write_plan.history` is right for them.

---

## 3. Slice S1 — graph, transport, descriptors

Each unit names its test first (TDD): write the test, watch it fail, then the code.

### S1-1 — `complete_backfilled` in the mode registry

- **Test first (new):** `test/lifecycle-backfill-graph.test.js`
  - `terminalOf(m)` includes `complete_backfilled` for all four modes.
  - `buildPhaseGraph('build')['complete_backfilled']` is `[]`.
  - every non-terminal node lists `complete_backfilled`, and lists it **before** `killed`.
  - `phaseToStatus('complete_backfilled') === 'COMPLETE'`; `TERMINAL.has('complete_backfilled')`.
- **`lib/lifecycle-modes.js` (existing)** — add `'complete_backfilled'` to `terminal` on `build`
  (`:54`), `fix` (`:95`), `plan` (`:124`) and `judgment` (`:166`).
- **`server/lifecycle-guard.js` (existing)**
  - `:56` — `export const TERMINAL = new Set(['complete', 'killed', 'complete_backfilled']);` (C3).
  - `:65-89` `buildPhaseGraph` — after `graph[completable].push('complete')` (`:79`) and **before** the
    `killed` loop (`:82-86`):

    ```js
    // <every non-terminal> -> complete_backfilled. A DISTINCT terminal node, so
    // the edge key differs from <completable>->complete and carries its own
    // (empty) predicate list — the reshape that dissolved round-2 constraint 1.
    for (const s of nodes) {
      if (terminal.has(s)) continue;
      graph[s] = graph[s] || [];
      if (!graph[s].includes('complete_backfilled')) graph[s].push('complete_backfilled');
    }
    ```

    Mirrors the `killed` loop verbatim, including the re-entrancy check. **Order is load-bearing for
    the checksum**: adjacency arrays are hashed in array order
    (`stratum/ts/src/guard/fingerprint.ts:14`), so the node must be appended before `killed`, and the
    descriptor generator (S1-5) must reproduce that order.
  - `:143-147` `phaseToStatus` — `if (phase === 'complete_backfilled') return 'COMPLETE';` first in
    the body.
- **Three pinning suites break by design (C18/BP-17)** and are updated in the same commit. Change the
  expectations, never the assertions:
  - `test/lifecycle-modes.test.js` — build's expected `terminal` array.
  - `test/lifecycle-modes-golden.test.js:25-35` — the two adjacency assertions filter only `killed`
    (`:27`, `:28`); they must filter both auto-added terminals, e.g.
    `g.explore_design.filter(x => x !== 'killed' && x !== 'complete_backfilled')`. Add a positive
    assertion that `g.explore_design` **does** include `complete_backfilled`, so the filter cannot
    hide a regression. `g.complete_backfilled` must deep-equal `[]` alongside `g.complete` (`:31-32`).
  - `test/judgment-writer.test.js:449-467` — the surplus list grows from five to nine. Judgment's
    non-terminal nodes are `open, under_test, resolved, inconclusive` (`lib/lifecycle-modes.js:159-163`;
    `superseded`/`dissolved` are terminal, `:166`), so the four added entries are
    `inconclusive→complete_backfilled`, `open→complete_backfilled`, `resolved→complete_backfilled`,
    `under_test→complete_backfilled`, sorted into the existing list.

### S1-2 — `guardPolicy`, `guardApplyUpgrade`, `guardDigest`

- **Test first (existing file, new cases):** `test/stratum-client-guard.test.js`, following the
  `guardHistory` case already there.
  - `guardPolicy('rid')` spawns `['guard','policy']` with `{"resource_id":"rid"}` on stdin.
  - `guardPolicy` on a missing resource returns `{status:'error', error_type:'guard_not_found', …}`
    (the runner parses stdout on a non-zero exit, `server/stratum-client.js:232-239`).
  - `guardApplyUpgrade` spawns `['guard','apply-upgrade']` with **exactly**
    `{"resource_id":…,"descriptor_id":…}` and passes the descriptors path in the child **env**.
  - `guardDigest` spawns `['guard','digest']` with exactly the six documented keys.
  - **R3-1 wire shape, extending `test/stratum-client-guard.test.js:80-103`:** `guardTransition({…,
    idempotencyKey:'k1', expectedPolicyChecksum:'<64-hex>'})` pipes `idempotency_key` **and**
    `expected_policy_checksum` and pipes **no** camelCase key — assert
    `Object.keys(piped)` contains neither `idempotencyKey` nor `expectedPolicyChecksum`.
  - **R3-1 omission:** `guardTransition` called without `expectedPolicyChecksum` pipes a payload with
    no `expected_policy_checksum` key at all (`_compact` drops undefined), so a live-completion
    transition stays byte-identical to today's.
  - **R3-1 rejection:** `guardTransition({…, expectedPolicyChecksum:'NOTHEX'})` reaches stratum and
    comes back as the canonical error envelope — the 64-lowercase-hex check is stratum's
    (`ts/src/guard/transition.ts:552-553`), not compose's, and compose must not duplicate it.
- **`server/stratum-client.js` (existing)** — `spawnStratumStdin` (`:194-213`) passes only
  `{timeout}` today and must be able to extend the child env:
  - `spawnStratumStdin(args, inputJson, timeoutMs, bin, extraEnv)` — pass
    `{ timeout: timeoutMs, ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}) }`. Omitting
    the key entirely when `extraEnv` is absent keeps every existing call byte-identical.
  - `runGuard(action, kwargs, timeoutMs, extraEnv)` forwards it (`:222-245`).
  - New exports modelled on `guardHistory` (`:382-384`):

    ```js
    export async function guardPolicy(resourceId) {
      return runGuard('policy', { resource_id: resourceId }, QUERY_TIMEOUT_MS);
    }

    export async function guardApplyUpgrade({ resourceId, descriptorId, descriptorsPath }) {
      return runGuard('apply-upgrade',
        { resource_id: resourceId, descriptor_id: descriptorId },
        MUTATION_TIMEOUT_MS,
        { STRATUM_GUARD_UPGRADE_DESCRIPTORS: descriptorsPath });
    }

    /**
     * STRAT-GUARD-DIGEST (stratum 0.4.3, ts/src/cli/guard.ts:207-227). Read-only:
     * runs stratum's own payloadDigestForVersion (transition.ts:131) over a
     * transition envelope under a given policy checksum. Grants nothing and reads
     * no state — it exists so compose never reimplements fingerprint.ts /
     * canonical.ts (design addendum, BP-1).
     * @returns {Promise<{status:'ok', payload_digest:string, payload_digest_version:2}|ErrorResult>}
     */
    export async function guardDigest({ fromState, toState, artifacts, modifiedFiles, resolvedBy, policyChecksum }) {
      return runGuard('digest', {
        from_state: fromState,
        to_state: toState,
        artifacts,
        modified_files: modifiedFiles,
        resolved_by: resolvedBy,
        policy_checksum: policyChecksum,
      }, QUERY_TIMEOUT_MS);
    }
    ```

- **`guardTransition` gains one parameter (R3-1).** This is the ONLY place a camelCase argument
  becomes a snake_case wire key. `server/stratum-client.js:349-359` destructures **camelCase** today
  (`idempotencyKey`, `modifiedFiles`, `fromState`, …) and maps each into the snake_case stdin object,
  so a caller that passes `idempotency_key` or `expected_policy_checksum` has those properties
  silently dropped by the destructuring — the transport sees `undefined`, `_compact` removes the key,
  and both replay identity and checksum protection vanish with no error anywhere. Add
  `expectedPolicyChecksum` to the destructure and `expected_policy_checksum` to the piped object:

  ```js
  export async function guardTransition({ resourceId, fromState, toState, artifacts, modifiedFiles,
                                          idempotencyKey, expectedPolicyChecksum, resolvedBy }) {
    return runGuard('transition', _compact({
      resource_id: resourceId,
      from_state: fromState,
      to_state: toState,
      artifacts,
      modified_files: modifiedFiles,
      idempotency_key: idempotencyKey,
      expected_policy_checksum: expectedPolicyChecksum,   // R3-1, stratum 0.4.4
      resolved_by: resolvedBy,
    }));
  }
  ```

  `_compact` drops undefined values, so every existing caller pipes exactly what it pipes today.
  **The naming rule for the whole feature:** camelCase crosses every JS call boundary
  (`completionGate` → `guardedTransition` → `guardTransition`); snake_case exists only inside the
  object handed to `runGuard`. §5.7's persisted intent is the one deliberate exception — it is a JSON
  document modelled on the wire envelope, so its keys are snake_case, and §5.8/§5.9a translate them
  back to camelCase at the call.

**Exact stdin payloads compose sends** (each validated against `assertOnlyKeys` in
`stratum/ts/src/cli/guard.ts`):

| CLI action | stdin JSON | Extra child env |
|---|---|---|
| `guard policy` | `{"resource_id":"compose:<hash>:<CODE>"}` | none |
| `guard apply-upgrade` | `{"resource_id":"compose:<hash>:<CODE>","descriptor_id":"backfill-<mode>-<from_checksum[0..12]>"}` | `STRATUM_GUARD_UPGRADE_DESCRIPTORS=<abs>/.compose/guard-upgrades.json` |
| `guard digest` | `{"from_state":"<phase>","to_state":"complete_backfilled","artifacts":{…},"modified_files":[],"resolved_by":"agent","policy_checksum":"<64-hex>"}` | none |
| `guard transition` (fresh backfill) | the existing seven keys plus `"expected_policy_checksum":"<64-hex>"` (R2B-7, stratum 0.4.4) | none |
| `guard transition` (recovery replay) | the same eight keys — `expected_policy_checksum` is the **persisted** `writeContext.policyChecksum`, never omitted (R3-2/R4-1) | none |

Any extra key on any of the three is refused with
`{"status":"error","error_type":"TypeError","message":"unexpected guard argument \"…\""}` and exit 1.
`guard digest` shipped in stratum 0.4.3 (`ts/src/cli/guard.ts:207-227`) with exactly these six keys
asserted at `:209`, `policy_checksum` constrained to 64 lowercase hex at `:211-213`, and the response
`{status:'ok', payload_digest, payload_digest_version: 2}` built at `:214-226`. `modified_files`
defaults to `[]` and `resolved_by` to `'agent'`, so compose sends both explicitly rather than relying
on the defaults. Should the action ever be unavailable, `guardDigest` returns an error envelope and
§5.9 refuses — fail-closed.

### S1-3 — legacy-policy projection and `ensureGuard` compatibility

Without this, a cold `ensureGuard` on any of the 35 registered resources sends the new policy, stratum
refuses with `guard_already_registered` (`ts/src/guard/transition.ts:438-440`), and
advance/skip/kill/complete all fail closed on legacy features after a restart.

- **Test first (existing file, new cases):** `test/lifecycle-guard.test.js`
  - `register` fake returning `guard_already_registered` + `policy` fake returning the **old** policy
    ⇒ `{status:'legacy'}`, cache records `legacy`.
  - a stored policy differing in any of the four checksum fields beyond the projection ⇒ error,
    fail-closed.
  - a stored policy differing only in `initial` ⇒ still `legacy` (R2-3; registration seeds `initial`
    from the phase at first contact, `lifecycle-guard.js:309`).
  - `guardedTransition` on a `legacy`-cached resource proceeds normally.
- **`server/lifecycle-guard.js` (existing)**
  - `:236` — `const _registered = new Map();` (C4); `_testOnly_resetGuardCache()` unchanged.
  - `:301` — return `status: _registered.get(rid) === 'legacy' ? 'legacy' : 'cached'`.
  - New exports (the descriptor generator reverses them in S1-5):

    ```js
    /** The four fields stratum's checksum covers (fingerprint.ts:13-18) and ONLY those. */
    export function policyChecksumFields(p) {
      return { graph: p.graph, edge_predicates: p.edge_predicates, terminal: p.terminal, stakes: p.stakes };
    }
    /** Project a NEW policy back onto its pre-backfill shape. Inverse of buildPhaseGraph's backfill loop. */
    export function legacyPolicyProjection(policy) { … }
    /** Order-insensitive on object keys, order-SENSITIVE on adjacency arrays. */
    export function policiesEqual(a, b) { … }
    ```

    `policiesEqual` compares `terminal` **sorted** (stratum sorts it, `fingerprint.ts:16`) and every
    adjacency array **in order** (stratum does not, `fingerprint.ts:14`).
  - `ensureGuard` (`:299-323`) gains one branch after the register call:

    ```
    if res.error_type/code is 'guard_already_registered':
        stored := await guardPolicy(rid)
        if isGuardError(stored): return { error: { code: guardErrorType(stored), message: guardErrorMessage(stored) } }   # fail closed (R4-2: raw verb, canonical envelope)
        newProjected := legacyPolicyProjection(policyChecksumFields(newPolicy))
        if policiesEqual(newProjected, policyChecksumFields(stored)):
            _registered.set(rid, 'legacy')
            return { guard_id: rid, status: 'legacy', storedChecksum: stored.checksum }
        return { error: { code: 'GUARD_POLICY_DIVERGED', message: … } }   # fail closed
    ```

    Every other outcome keeps today's behaviour byte-for-byte.

### S1-4 — lazy `apply-upgrade`

- **Test first (new):** `test/lifecycle-backfill-upgrade.test.js` — `unchanged` proceeds; `applied`
  proceeds and records `upgrade` on the batch record; `upgrade_descriptor_unavailable`,
  `upgrade_descriptor_mismatch` and any other error refuse the whole backfill with
  `refusedAt:'upgrade'` and a message naming `compose guard descriptors` + re-sign; nothing written.
- **`server/lifecycle-guard.js` (existing)** — `export async function applyBackfillUpgrade({ featureCode, workspaceRoot, mode })`.
  Reads the stored policy, computes `descriptorIdFor(storedChecksum, mode)`, spawns `apply-upgrade`
  with `STRATUM_GUARD_UPGRADE_DESCRIPTORS = path.join(workspaceRoot, '.compose', 'guard-upgrades.json')`
  — absolute, because stratum refuses a relative path (`descriptors.ts:147`). Returns
  `{ok:true, status, ledgerRef, checksum}` or `{ok:false, reasons, error}`. Invoked **only** for a
  resource whose `ensureGuard` status was `legacy`.

### S1-5 — `compose guard descriptors`

- **Test first (new):** `test/guard-descriptors.test.js` (unit, no CLI spawn)
  - `deriveBackfillPolicy(storedPolicy, mode)` adds the node with `[]` adjacency, appends it to every
    non-terminal adjacency list **before** `killed`, adds it to `terminal`, touches nothing else.
  - **round trip:** `legacyPolicyProjection(deriveBackfillPolicy(p))` deep-equals `p` — which is what
    makes S1-3's comparison and this generator provably inverse.
  - `buildDescriptorFile` deduplicates by `from_checksum`, sorts by `id`, byte-stable on shuffled input.
  - a `to_policy` carrying a fifth key is refused before write (stratum refuses it at apply time,
    `descriptors.ts:41`; refusing here makes the failure legible).
- **`lib/guard-descriptors.js` (new)**

  ```js
  export function descriptorIdFor(fromChecksum, mode)   // `backfill-${mode}-${fromChecksum.slice(0,12)}`
  export function deriveBackfillPolicy(storedPolicy, mode)
  export function buildDescriptorFile(entries)
  export async function enumerateRegisteredResources(workspaceRoot)
  export async function writeDescriptorFile(workspaceRoot)
  ```

  **Enumeration.** There is no listing API, so compose derives candidate ids and probes each.
  1. List feature folders under `loadFeaturesDir(workspaceRoot)` (build) and under each non-build
     mode's `runner.artifactRoot` (`docs/bugs`, `docs/plans`, `docs/judgment/records/joints` —
     `lib/lifecycle-modes.js:102`, `:131`, `:173`).
  2. Compute `resourceId(code, workspaceRoot, mode)` (`server/lifecycle-guard.js:121-130`).
  3. `guardPolicy(rid)`. `guard_not_found` ⇒ **skip** (unregistered; registers fresh with the new
     graph). Any other error ⇒ abort the whole generation non-zero; a half-enumerated descriptor file
     is worse than none.
  4. Skip a resource whose `current_state` is in its stored `terminal`.
  5. Skip a resource whose stored `terminal` already contains `complete_backfilled`.
  - **Dedup by `from_checksum`** (round-3 finding 8): a checksum binds a *policy*, not a resource
    (`fingerprint.ts:13-18` excludes resource id and workspace root). Build features each get an entry
    because their predicates embed the folder; every fix-mode resource shares one because fix has no
    edge evidence (`lib/lifecycle-modes.js:99`). Authorization scope is policy-wide by construction —
    say so in the generated `rationale`.
  - **`to_policy` derives from the STORED policy**, never a fresh `buildPhaseGraph`, so the from/to
    pair is exact even if the mode registry drifted since registration.
  - **Byte stability:** descriptors sorted by `id`; keys in stratum's order (`id, rationale,
    from_checksum, to_policy`; policy `graph, edge_predicates, terminal, stakes`); two-space indent;
    trailing newline. A regeneration with no policy change is byte-identical, so an existing signature
    stays valid and no re-sign is needed.
  - **`chmod 0600`.** Stratum refuses a group- or world-**writable** file (`descriptors.ts:200-202`,
    mask `0o022`).
  - **Signing is a human act.** The command prints the exact next step and exits 0:

    ```
    ssh-keygen -Y sign -f ~/.stratum/guard-signing -n stratum-guard-descriptors \
      <workspace>/.compose/guard-upgrades.json
    ```

    The namespace literal is `DESCRIPTOR_NAMESPACE` (`stratum/ts/src/guard/descriptors.ts:35`). Commit
    both files.
- **`bin/compose.js` (existing)** — a `guard` command block following the `roadmap` block's shape
  (`:1221-1226`), resolving the root with `resolveCwdWithWorkspace(args)` as `roadmap generate` does
  (`:1234`). It imports `writeDescriptorFile` and prints; no logic lives in the bin.

---

## 4. Slice S2 — the valid-time merge

### 4.1 `insertBackfilledPhases` — precise algorithm

Implements Decision 5 as finally written (R2-4, R2-6, R3-2, R3-3, R3-4) with BP-7, BP-8, BP-9 and
round-2 **R2B-1** and **R2B-5** folded in.

Two graphs, not one (**R2B-1**). `transitionsOf(mode)` is the FORWARD graph and does not contain
`complete_backfilled` — that node exists only in the augmented `buildPhaseGraph(mode)` (S1-1). The
first draft validated every consecutive pair against the forward graph, so the final pair
`<fromState> -> complete_backfilled` was unreachable by construction and **every** backfill would have
been refused at `history`. The merge therefore takes both: caller occurrences are checked against the
forward graph (a caller may not cite a phase the lifecycle cannot walk), and any pair whose target is
a terminal added by the adapter is checked against the augmented graph.

```js
/**
 * Merge backfilled occurrences into a phase history by VALID TIME.
 *
 * PURE (BP-7): `item` is never mutated and no input object is ever aliased into
 * the result. R2B-5: the comparison baseline is an INDEPENDENT deep clone taken
 * before anything is rewritten — the first draft built `originals` by indexing
 * the same array the closure loop then mutated, so step 4d compared each object
 * with itself and could never fire.
 *
 * @param {object} item      vision item, read-only
 * @param {BackfilledOccurrence[]} incoming  already materialised (§5.5)
 * @returns {{ok:true, history:Array, written:string[], skipped:string[]}
 *         | {ok:false, reasons:string[]}}
 */
export function insertBackfilledPhases(item, incoming) { … }
```

**Pseudocode.**

```
lc        := item.lifecycle
mode      := lc.mode ?? 'build'
fwdGraph  := transitionsOf(mode)                       # lib/lifecycle-modes.js:209
fullGraph := buildPhaseGraph(mode)                     # server/lifecycle-guard.js:65-89
#   R2B-1: fwdGraph is what a lifecycle may WALK; fullGraph is what the guard
#   ACCEPTS, and only fullGraph contains complete_backfilled.
adapterTerminals := terminalOf(mode) minus the modes' walkable nodes
                    # = {complete, killed, complete_backfilled} for build/fix/plan

# ---- BP-8: EVERY comparison is numeric on epoch ms. `git show -s --format=%aI`
#      emits the committer's UTC OFFSET, so "2026-06-01T00:00:00+02:00" sorts
#      AFTER "2026-06-01T00:00:00Z" as a string and BEFORE it as an instant.
ms(x) := Date.parse(x)
startedMs := ms(lc.startedAt)
if not Number.isFinite(startedMs): REFUSE "lifecycle.startedAt is not a parseable instant"
for o in incoming:
    if not Number.isFinite(o.evidence.observedEpochMs): REFUSE "unparseable evidence time for " + keyOf(o)
for e in lc.phaseHistory ?? []:
    if not Number.isFinite(ms(e.enteredAt)): REFUSE "stored occurrence has an unparseable enteredAt"

# BP-7 / R2B-5: temp ids WE assign, on CLONES, and a SEPARATE immutable snapshot.
# `snapshot` is cloned independently of `existing` and is never touched again, so
# step 4d and the marker test below both read pre-rewrite values. Indexing
# `existing` here (the first draft) aliases the very objects the closure loop
# rewrites: 4d then compares an object with itself and the `from == null` that
# identifies the genesis marker has already been overwritten.
existing := (lc.phaseHistory ?? []).map((e, seq) => ({ ...deepClone(e), _tid: 'x' + seq, _seq: seq }))
snapshot := Map(existing.map(e => [e._tid, deepClone(e)]))   # independent clones, frozen
#   MARKER IDENTITY IS COMPUTED NOW, off the snapshot, before any rewrite (R2B-5).
markerTids := set of e._tid for e in existing where
                e._seq == 0 and e.origin != 'backfill'
                and snapshot[e._tid].from == null
                and not inGraph(fwdGraph, e.phase)

# ---- STEP 3 FIRST (R2-4): dedup by CLAIM. A retry after partial persistence is
#      a no-op, not a tie refusal.
claimOf(o) := { phase: o.phase, kind: o.evidence.kind, ref: o.evidence.ref,
                observedEpochMs: o.evidence.observedEpochMs }        # R3-2: these four ONLY
keyOf(o)   := o.phase + U+001F + o.evidence.ref

# ---- STEP 3a FIRST OF ALL (R3-5): dedup by operation_id, BEFORE the claim
#      index and before every step-4 refusal. The terminal occurrence carries
#      `origin: 'live'` (§5.5 step 4) — deliberately, because it happened now —
#      so the claim index below, which is filtered to `origin === 'backfill'`,
#      can never match it. Without this pass a recovery that re-runs the merge
#      after step 6.0 already persisted the terminal hits 4a: the stored
#      terminal's enteredAt and the incoming terminal's observedEpochMs are the
#      SAME instant by construction (both are `now`, minted once, BP-6), the tie
#      check counts two, and every ordinary recovery refuses at `history`.
#      Identity here is the operation id, not the claim: the terminal's
#      evidence.ref is the commit sha, which is null for a commit-less backfill
#      and shared by every occurrence when it is not.
opIdOf(x)    := x.operation_id                       # present on the TERMINAL only (BP-6)
immutableOf(x) := { phase: x.phase, enteredAt: x.enteredAt, timestamp: x.timestamp,
                    recordedAt: x.recordedAt, outcome: x.outcome, origin: x.origin,
                    evidenceKind: x.evidence.kind, evidenceRef: x.evidence.ref,
                    observedEpochMs: x.evidence.observedEpochMs }
byOpId := index(existing.filter(e => opIdOf(e) != null), opIdOf)
remaining := []; skipped := []
for o in incoming:
    if opIdOf(o) == null: remaining.push(o); continue
    prior := byOpId[opIdOf(o)]
    if prior is undefined: remaining.push(o); continue
    #  ALREADY PERSISTED BY THIS OPERATION. Verify it is byte-for-byte the entry
    #  we wrote before treating it as ours — a stored entry sharing our id but
    #  differing in any immutable field is corruption, not idempotence.
    if not deepEqual(immutableOf(prior), immutableOf(o)):
        REFUSE "an entry under operation " + opIdOf(o) + " is already stored with different "
             + "immutable fields — refusing to overwrite it"
    skipped.push(keyOf(o))                            # persisted entry KEPT, never re-stamped
incoming := remaining

# ---- STEP 3b: dedup by CLAIM, for everything that carries no operation id.
byKey := index(existing.filter(e => e.origin === 'backfill'), keyOf)
batch := []
for o in incoming:
    prior := byKey[keyOf(o)]
    if prior is undefined: batch.push({ ...deepClone(o), _tid: 'n' + index, _seq: +Infinity }); continue
    if deepEqual(claimOf(prior), claimOf(o)): skipped.push(keyOf(o)); continue   # persisted recordedAt KEPT
    REFUSE "occurrence already recorded with other evidence: " + keyOf(o)
if batch is empty:
    return { ok:true, history: lc.phaseHistory ?? [], written: [], skipped }     # pure no-op

# ---- STEP 4 refusals. Whole batch, nothing persisted.

# 4a. TIE — only an INCOMING backfilled occurrence triggers it (finding 7).
#     appendPhaseHistory legitimately produces zero-length live intervals when two
#     transitions share a timestamp (lifecycle-phase-history.js:28-31).
instants := multiset(existing.map(e => ms(e.enteredAt))) + multiset(batch.map(o => o.evidence.observedEpochMs))
for o in batch:
    if count(instants, o.evidence.observedEpochMs) > 1:
        REFUSE "two phases cannot start at the same instant — cite distinct evidence for " + keyOf(o)

# 4b. ADOPTION INSTANT — anchored to lc.startedAt, NOT to any occurrence: the
#     reconciler recreates a missing first live entry with the CURRENT time
#     (reconciler.js:97, :108), so no occurrence reliably carries startedAt (R3-4).
for o in batch:
    if o.evidence.observedEpochMs == startedMs:
        REFUSE "backfilled occurrence at the adoption instant is ambiguously placed"
episodeOf(x) := (msOf(x) < startedMs) ? 1 : 2

# 4c. CLOSED LIVE INTERVAL.
for o in batch:
    for e in existing where e.origin != 'backfill' and e.exitedAt != null:
        if ms(e.enteredAt) < o.evidence.observedEpochMs < ms(e.exitedAt):
            REFUSE "backfilled " + keyOf(o) + " falls inside the closed live interval "
                 + e.phase + " [" + e.enteredAt + ", " + e.exitedAt + ")"

# ---- STEP 2. Merge and recompute closure from valid time.
merged := sort(existing ++ batch, by: (enteredAt-epoch asc, _seq asc))
#   _seq is the STORED sequence, the secondary key — it preserves the order of
#   pre-existing live ties (finding 7). Incoming entries carry +Infinity, but 4a
#   has already made their instants unique.
for i in 0 .. merged.length-1:
    merged[i].exitedAt := (i+1 < merged.length) ? merged[i+1].enteredAt : null
    merged[i].from     := (i > 0) ? merged[i-1].phase : null          # BP-9: constructed, never left undefined
    merged[i].episode  := episodeOf(merged[i])
#   NOTE the `from` rewrite above is exactly why marker identity was captured
#   BEFORE this loop (R2B-5): after it, the genesis record's `from` is no longer
#   null whenever anything sorts ahead of it, which is the pre-adoption case.

# 4d. LIVE RECORDS ARE NEVER REWRITTEN. Compared against `snapshot`, the
#     INDEPENDENT pre-rewrite clones (R2B-5). Comparing against `existing`
#     entries — which the loop above just rewrote — compares an object with
#     itself and the check silently never fires.
for e in existing where e.origin != 'backfill':
    o := snapshot[e._tid]; m := merged.find(x => x._tid === e._tid)
    if m.enteredAt != o.enteredAt: REFUSE "…would move the live occurrence " + o.phase
    if o.exitedAt != null and m.exitedAt != o.exitedAt:
        REFUSE "…would re-close the live occurrence " + o.phase +
               " from " + o.exitedAt + " to " + m.exitedAt
    # An OPEN live occurrence may legitimately be closed by a later backfilled one.

# 4e. TRANSITIVE REACHABILITY within an episode.
#     BP-9: the marker exemption is NARROW. It applies ONLY to an EXISTING stored
#     occurrence that is the genesis record — origin 'live', from == null, and the
#     first entry in stored order — and only when its phase is not a node of this
#     mode's graph. Lifecycle start writes `explore_design` in EVERY mode
#     (vision-routes.js:318, :330), which is not a node of the fix graph
#     (lifecycle-modes.js:84-93). It is an adoption marker: never a reachability
#     source, never a target, preserved as written. NO incoming occurrence is ever
#     exempt — an unknown incoming phase was already refused in §5.5.
isMarker(x) := x._tid in markerTids                # computed off the SNAPSHOT (R2B-5)
pairs := consecutive(merged)
         minus any pair touching a marker
         minus the single pair straddling episode 1 -> episode 2
for (a, b) in pairs:
    # R2B-1: pick the graph by the TARGET. A pair ending in an adapter-added
    # terminal (complete_backfilled, complete, killed) is a guard edge and is
    # checked against fullGraph; every other pair is a lifecycle walk and is
    # checked against fwdGraph.
    g := (b.phase in adapterTerminals) ? fullGraph : fwdGraph
    if not reachable(g, a.phase, b.phase):        # transitive closure, BFS
        REFUSE a.phase + " -> " + b.phase + " is not reachable in " + mode
# The asymmetry Decision 7 requires: gaps are legal (explore_design -> execute is
# reachable), reversals are not (execute -> explore_design is not). Checked ACROSS a
# backfill->live boundary too, when both sides are episode 2 (R2-6).

# 4f. INTERVAL INVARIANT, last, numerically, over the whole merged list.
for m in merged:
    if m.exitedAt != null and ms(m.exitedAt) < ms(m.enteredAt):
        REFUSE "interval invariant violated at " + m.phase

return { ok:true, history: merged stripped of _tid/_seq, written: batch.map(keyOf), skipped }
```

`appendPhaseHistory` (`server/lifecycle-phase-history.js:23-44`, existing) gains three fields on the
entry it pushes at `:32-43`:

```js
recordedAt: timestamp,   // transaction time == valid time for a live walk
origin: 'live',
confidence: 1.0,
```

No stored record migrates. `normaliseOrigin(e) => e.origin ?? 'live'` is exported from the same module
so every **reader** shares one definition — but the DecisionEvent **emitter** passes `entry.origin`
through unchanged (BP-16), so a pre-existing record produces an event with no `origin` key at all.

### 4.2 Six concrete test histories

`test/phase-history-merge.test.js` (new). All fixtures use **full ISO-8601 with an explicit `Z`**, and
every expected equality is asserted on the epoch value as well as the string (BP-8/BP-15).

**H1 — pre-adoption.** `startedAt = 2026-09-01T00:00:00.000Z`; live history is one open genesis entry
`explore_design @ 2026-09-01T00:00:00.000Z, exitedAt = null, from = null`. Incoming: `blueprint @
2026-06-01T00:00:00.000Z`, `execute @ 2026-07-01T00:00:00.000Z`, `ship @ 2026-08-01T00:00:00.000Z`,
all `kind: 'commit'`.
**Expected:** ok. Merged order `blueprint, execute, ship, explore_design`. Closures, asserted exactly
(BP-15): `blueprint.exitedAt === '2026-07-01T00:00:00.000Z'`,
`execute.exitedAt === '2026-08-01T00:00:00.000Z'`,
`ship.exitedAt === '2026-09-01T00:00:00.000Z'` — which is byte-equal to
`explore_design.enteredAt` and to `lc.startedAt`, so the assertion is written as
`assert.equal(ship.exitedAt, lc.startedAt)` rather than against a re-typed literal — and
`explore_design.exitedAt === null`. `from` chain: `null, blueprint, execute, ship`. Episodes
`1,1,1,2`. The `ship → explore_design` pair straddles the adoption boundary and is not
reachability-checked. Confidence `0.9` on all three.

**H2 — post-adoption, open live entry.** `startedAt = 2026-09-01T00:00:00.000Z`; live history is the
genesis `explore_design @ startedAt`. Incoming: `blueprint @ 2026-09-02T10:00:00.000Z`, `execute @
2026-09-03T10:00:00.000Z`, both commits.
**Expected:** ok. The open live entry is **closed** at `2026-09-02T10:00:00.000Z`. Both incoming are
episode 2, so `explore_design → blueprint` and `blueprint → execute` **are** checked and pass
(`lib/lifecycle-modes.js:42`, `:45`). `execute.exitedAt === null`.

**H3 — fix-mode genesis.** `mode:'fix'`, `startedAt = 2026-09-01T00:00:00.000Z`, live history is the
out-of-graph genesis `explore_design @ startedAt` with `from: null` at `_seq 0`. Incoming: `diagnose @
2026-09-02T00:00:00.000Z`, `fix @ 2026-09-03T00:00:00.000Z`.
**Expected:** ok. The genesis entry satisfies `isMarker`, so the pair `explore_design → diagnose` is
dropped and `diagnose → fix` is checked and passes (`lib/lifecycle-modes.js:86`). Without the marker
rule every fix-mode backfill would refuse. A **negative variant** asserts the exemption's narrowness
(BP-9): the same history with a *second* out-of-graph live entry at `_seq 1` refuses, because only
`_seq 0` is a marker.

**H4 — reconstructed resumed entry.** `startedAt = 2026-09-01T00:00:00.000Z`; the reconciler recreated
the only live entry as `{from:null, to:'ship', outcome:'resumed', timestamp:'2026-09-04T12:00:00.000Z'}`
(`lib/checkpoint/reconciler.js:104-110`), so its `enteredAt !== startedAt`. Incoming: `execute @
2026-09-05T09:00:00.000Z`.
**Expected:** REFUSE. Both are episode 2, so `ship → execute` **is** checked and `execute` is not
reachable from `ship` (build's `ship: []`, `lib/lifecycle-modes.js:51`). Note the entry is **not** a
marker despite `from === null`: `ship` *is* a node of the build graph, so `isMarker` is false. This is
R2-6 — anchoring adoption to the occurrence rather than the instant would have waved it through.

**H5 — live tie preserved, and no aliasing.** Live history contains `blueprint @
2026-09-02T10:00:00.000Z` (`_seq 1`) and `verification @ 2026-09-02T10:00:00.000Z` (`_seq 2`) — a real
zero-length interval. Incoming: `execute @ 2026-09-03T10:00:00.000Z`.
**Expected:** ok; the pre-existing tie is not refused and the two keep their stored order via `_seq`.
**BP-7 assertions in this same test:** the caller's `item.lifecycle.phaseHistory` array and every
object in it are **unchanged** after the call (deep-equal to a snapshot taken before), and no returned
element is reference-identical (`===`) to any input element. A second variant supplies an incoming
occurrence at `2026-09-02T10:00:00.000Z` and asserts REFUSE — the tie rule fires only when an incoming
backfilled occurrence is involved.

**H6 — retry after partial persistence.** Run H1, persist, re-issue the identical batch.
**Expected:** ok, `written: []`, `skipped` naming all three keys, and the returned history deep-equal
to the persisted one **including every `recordedAt`**. That equality is only sound because timestamps
are minted once and persisted in the intent (BP-6) and the claim comparison excludes them (R3-2). A
third run with one occurrence's `observedEpochMs` changed must REFUSE with "already recorded with
other evidence".

**H7 — future-dated commit (BP-8).** `startedAt = 2026-09-01T00:00:00.000Z`, live genesis open.
Incoming: `execute @ 2027-01-01T00:00:00.000Z` — an author date after `now`, which git accepts.
**Expected:** the merge itself succeeds (nothing forbids a future valid time), but the **final history
including the terminal occurrence** is validated: the terminal occurrence's `enteredAt` is `now`,
which is earlier than `execute`, so `execute` sorts last and the terminal occurrence's `exitedAt`
becomes `execute.enteredAt` while the terminal's own `enteredAt` is earlier — no invariant break — yet
the terminal state is no longer last in valid time. The gate therefore REFUSES at `history` with
"backfilled evidence is dated after the completion being recorded", checked in §5.5 against the
terminal occurrence's instant. Without this check a future-dated commit would leave the terminal
occurrence in the middle of the history.

### 4.3 The evidence resolver

**Test first (new):** `test/backfill-evidence.test.js` against a real tmp git repo (the `makeWorkspace`
fixture at `test/completion-gate.test.js:38-60`) plus a real symlink.

- **`lib/backfill-evidence.js` (new)**

  ```js
  export const CONFIDENCE_BY_KIND = Object.freeze({ commit: 0.9, path: 0.6 });
  export function deriveConfidence(kind)        // throws on an unknown kind
  export function resolveEvidenceRef(cwd, ref)  // -> ResolvedEvidence
  ```

  `kind: 'commit'` — `git rev-parse --verify --quiet <sha>^{commit}` for existence (the call
  `gitCommitExists` makes at `server/lifecycle-guard.js:183-187`), then
  `git show -s --format=%aI <sha>` for `observedTime` (the **author** date, Decision 3).
  `observedEpochMs = Date.parse(observedTime)`, asserted finite — `%aI` carries an offset, which is
  exactly why the epoch form is computed once here and used everywhere (BP-8).
  `kind: 'path'` — the eight steps of `validateRepoPath` (`lib/feature-writer.js:610-641`) verbatim,
  with **`realpathCanonicalize` (`lib/canon-guard.js:65`) substituted for the bare `realpathSync` calls
  at `:621` and `:633`** (C19). That is the macOS firmlink landmine: `/System/Volumes/Data` mirrors `/`
  and `realpath` does not collapse it (`lib/canon-guard.js:46-52`), so the **cwd** and the resolved
  path can carry different roots and the prefix check compares mismatched prefixes. Never `resolve()`
  before canonicalising (`lib/canon-guard.js:67-71`). `observedTime` is
  `statSync(real).mtime.toISOString()`.
  `confidence` is derived here and nowhere else; the request schema has no `confidence` field, so a
  caller-supplied value is rejected by `additionalProperties:false` before any code runs.

---

## 5. Slice S2 (continued) — `completionGate({intent:'backfill'})`

One door. Backfill is a parameterisation of `completionGate` (`lib/completion-gate.js:220-235`), not a
sibling.

### 5.1 Canonicalisation and `request_digest`

```
canonicalRequest := {
  feature_code, commit_sha, tests_pass, mode,
  files_changed: sorted(unique(files_changed)),
  reason: reason.trim(),
  occurrences: sorted(occurrences, by keyOf).map(o => ({phase: o.phase, kind: o.evidence.kind, ref: o.evidence.ref}))
}
request_digest := sha256(canonicalJson(canonicalRequest))
```

`notes` is excluded — prose that does not change what is claimed. `observedTime` is excluded because it
is server-derived; it is instead part of the per-occurrence claim inside `insertBackfilledPhases`.

### 5.2 Ordering (R2-5) and the async test runner (BP-13)

Live completion verifies evidence **before** the lock (`lib/completion-gate.js:246`, header note 3).
Backfill verifies **after** it, because a retry of a finished backfill must not be refused by a suite
that regressed later.

That inverts the reason note 3 exists: `spawnSync` blocks the event loop, a blocked loop cannot fire
the dir lock's heartbeat, and the lock gets declared stale and stolen from a live owner. So backfill
must not use the synchronous runner.

- **`server/lifecycle-guard.js` (existing)** — add
  `export async function verifyCompletionEvidenceAsync({commitSha, cwd, testCommand, testsPassClaim})`,
  a copy of `verifyCompletionEvidence` (`:199-224`) with both `spawnSync` calls (`:184`, `:211`)
  replaced by a promisified `execFile`, so the event loop keeps turning and the heartbeat keeps firing.
  Same return shape `{ok, reasons, testsAttested}`, same "no silent default" rule (`:219-221`).
  `verifyCompletionEvidence` itself is **unchanged**, so the live path stays byte-identical.
- **Test (new, in `test/lifecycle-backfill.test.js`) — R2B-12.** The first draft's "sleep 2 s and see
  that the lock survived" proves nothing: `LOCK_STALE_MS` is **20 s** and `LOCK_HEARTBEAT_MS` is **1 s**
  (`lib/dir-lock.js:55`, `:59`), so a 2-second block is far inside the stale window and a synchronous
  runner would pass it. Assert the mechanism instead, either way round:
  - **Heartbeat progress (cheap, preferred).** Configure a `guard.testCommand` that runs ~3 s. While
    the child is running, sample the lock directory's mtime (the heartbeat touches it every second,
    `:100-105`) at least three times and assert it strictly increases. Under `spawnSync` the event
    loop is blocked, `setInterval` never fires, and the mtime is frozen — so this fails on the
    synchronous version and passes on the async one, which is the whole point.
  - **Contention past the threshold (slow, optional).** Configure a command running longer than
    `LOCK_STALE_MS`, have a second locker contend for the same directory, and assert it never steals
    the lock (`:123` compares age against `LOCK_STALE_MS`). Tag it so it is not in the default run.

```
if intent == 'backfill':
    require reason non-empty and commit_sha        -> refusedAt 'request'
    request_digest := digest(§5.1)                 # no evidence verification yet
else:
    <existing :246-274 block, unchanged>
if intent == 'evidence-only': <existing :278-280 early return>

rid     := resourceId(featureCode, workspaceRoot, mode)     # :282
release := await acquireDirLock(.compose/data/locks/completion-<CODE>)   # :283-284
```

### 5.3 Lookup order under the lock; mode-aware preflight (BP-11)

```
tracksJson := getMode(mode).runner.tracksFeatureJson        # lib/lifecycle-modes.js:67, :104, :133, :175
guarded    := guardEnabled(workspaceRoot)                   # :89-98

# --- preflight, MODE-AWARE. fix/plan/judgment have no feature.json, so the
#     existing provider preflight (:290-304) would refuse every one of them.
if tracksJson:
    <existing :290-304 — provider, feature exists, TERMINAL_STATUSES refusal>
else:
    feature := null      # nothing canonical to check; the lifecycle IS the record

item := the live vision item (passed in by the route, §S3-1)
if item is null or item.lifecycle is null:
    REFUSE refusedAt 'preflight', 'ITEM_NOT_FOUND' naming scaffold_feature      # open question 1

# --- lookup order (R2-5): finalized -> pending/intent -> new.
records   := item.lifecycle.backfills ?? []
finalized := records.find(r => r.request_digest == request_digest and r.state == 'finalized')
if finalized: return { ok:true, guarded, backfill: finalized, status:'finalized', reasons: [] }

priorIntent := readIntent(workspaceRoot, featureCode)        # :307
pending     := records.find(r => r.request_digest == request_digest and r.state == 'pending')

# BP-3: the INTENT is the only recovery source. A pending record is a marker.
if pending and (priorIntent is null or priorIntent.request_digest != request_digest):
    REFUSE refusedAt 'recovery',
      'a pending backfill record exists for this request with no matching intent — ' +
      'the operation cannot be resumed automatically; operator action required'
if priorIntent and priorIntent.intent == 'backfill'
   and priorIntent.request_digest != request_digest:
    REFUSE refusedAt 'recovery', 'a different backfill operation is in flight for this feature'
if priorIntent and priorIntent.intent != 'backfill':
    clearIntent(...)                                        # a stale live-completion intent

recovering := priorIntent is not null and priorIntent.request_digest == request_digest
```

### 5.4 Two branches, never interleaved (BP-2)

**5.4a Recovery.** Replays the persisted envelope **unchanged**, before any terminal or policy check —
the resource is *expected* to be at `complete_backfilled`, so a terminal check here would refuse every
legitimate recovery.

**`writeContext` — the single object every write reads (R3-4).** Both branches end by producing one
`writeContext`, and §5.10 consumes **nothing else**: no `probe`, no `now`, no `request`, no live
config. `probe` exists only on the fresh branch, `now` is a fresh timestamp on a resumed attempt, and
`notes` is a `recordCompletion` argument (`lib/completion-gate.js:425`) that the first draft never
restored — three ways for a resume to write different bytes than the crash intended. The rule that
prevents all three is structural: if a value is not in `writeContext`, §5.10 cannot see it.

| `writeContext` field | Fresh branch | Recovery branch | Persisted in the intent? |
|---|---|---|---|
| `operationId` | minted §5.4b | `op.operation_id` | yes (`operation_id`) |
| `requestDigest` | §5.1 | `op.request_digest` | yes |
| `featureCode`, `mode` | request / item | `op.feature_code`, `op.mode` | yes |
| `reason` | request | `op.reason` | yes |
| `commitSha` | request | `op.commit_sha` | yes, nullable |
| `filesChanged` | request | `op.files_changed` | yes |
| `notes` | request | `op.notes` | **yes, nullable (R3-4 — was missing)** |
| `attested` | §5.5 evidence | `op.tests_attested` | yes |
| `startedAt` | `now`, minted once §5.4b | `op.started_at` | yes (`started_at`) |
| `occurrences`, `terminalOcc` | §5.5 | `op.occurrences`, `op.terminal_occurrence` | yes |
| `history` | `probe.history` | `op.write_plan.history`, subject to the divergence rule below | yes (`write_plan.history`) |
| `writtenKeys`, `skippedKeys` | `probe.written`, `probe.skipped` | `op.write_plan.written`, `.skipped` | yes |
| `guardInitial` | §5.4b | `op.guard_initial` | yes, nullable |
| `upgrade` | §5.6 | `op.upgrade` | yes, nullable |
| `guarded` | `guardEnabled` at §5.3 | `op.guarded` | yes |
| `policyChecksum` | §5.6 | `op.policy_checksum` | yes, nullable |
| `envelope` | §5.4b / §5.6 | `op.envelope` | yes |
| `ledgerRef` | set by §5.8 | set by §5.9c | **no** — it is an outcome, not an input |
| `tracksJson` | `getMode(mode).runner.tracksFeatureJson` | same, from `writeContext.mode` | no — a pure function of `mode` |

`startedAt` is the **only** timestamp §5.10 writes onto the batch record's `recordedAt` and the
completion evidence's `verified_at`. A resumed attempt therefore stamps the instant the operation
began, not the instant it resumed, which is what makes an identical retry deep-equal (Flow A step 5).

```
if recovering:
    op          := priorIntent                              # the single DTO (BP-3)

    # R2B-3 / R3-4: EVERY write input comes from the intent, none is recomputed
    # and none is defaulted. A missing field is a corrupt intent, not a zero.
    writeContext := { operationId: op.operation_id, requestDigest: op.request_digest,
                      featureCode: op.feature_code, mode: op.mode, reason: op.reason,
                      commitSha: op.commit_sha, filesChanged: op.files_changed,
                      notes: op.notes, attested: op.tests_attested,
                      startedAt: op.started_at,
                      occurrences: op.occurrences, terminalOcc: op.terminal_occurrence,
                      history: op.write_plan.history,
                      writtenKeys: op.write_plan.written, skippedKeys: op.write_plan.skipped,
                      guardInitial: op.guard_initial, upgrade: op.upgrade,
                      guarded: op.guarded, policyChecksum: op.policy_checksum,
                      envelope: op.envelope, ledgerRef: null }
    if any required field of writeContext is undefined:
        REFUSE refusedAt 'recovery', 'the persisted intent is missing <field> — clear it and re-run'

    # R2B-4: ONE effective guard flag, taken from the intent — NOT from live
    # config. If capabilities.guard was flipped off between the crash and the
    # retry, branching on the live value would skip the replay entirely and
    # re-drive the writes as if no guard transition had ever happened; flipped
    # ON, it would try to drive a guard that never saw this operation. The
    # persisted flag governs the transition, the projection's consultGuard, the
    # verifier's guard consultation (§S3-3, R3-7) and the guardRef expectation
    # alike, for the whole of the resumed attempt.

    # NO fresh evidence check, NO re-materialisation, NO re-stamping (BP-6),
    # NO ensureGuard, NO guard policy, NO apply-upgrade.
    if writeContext.guarded: goto §5.9a (raw replay) with writeContext.envelope
    else:                    goto §5.10 (re-drive the writes) with ledgerRef null
```

**History divergence on resume (R2-B3, R3-5).** The intent's `write_plan.history` was computed against
the item as it stood before the transition. If the stored history has changed since (a live
advance/skip/kill landed in the window), re-driving the plan verbatim would clobber it. So on resume
the gate re-runs `insertBackfilledPhases(item, writeContext.occurrences ++
[writeContext.terminalOcc])` and compares:

- **identical** to `write_plan.history` — nothing moved; keep `writeContext.history` as persisted;
- **a pure no-op** (`written` empty, every occurrence in `skipped`) — the history already reached disk,
  including the terminal occurrence, which §4.1 step 3a recognises by `operation_id` rather than by
  claim (R3-5). Set `writeContext.history := lc.phaseHistory` and skip the history write in §5.10;
- **anything else** — **refuse at `history`** with "the item's phase history changed while a backfill
  was in flight", because silently overwriting a live transition is exactly the class of damage this
  feature exists to avoid.

The step-3a dedup is what makes the second bullet reachable at all. The terminal occurrence's `origin`
is `live`, so the claim index cannot match it, and its `enteredAt` equals the stored terminal's to the
millisecond — before R3-5 the tie check fired and **every** post-6.0 recovery refused at `history`.

**5.4b Bootstrap — new operation only.** Ordering is load-bearing (**R2B-8**): registration is a
**durable write** that creates a guard resource and a ledger on disk, so it must not happen before the
request has been shown to be valid. The first draft registered, then validated evidence and history —
leaving a permanent registration behind for a request that was then refused. The order is therefore
**decide the initial state, validate everything, and only then register**.

```
operationId := randomUUID()
now         := new Date().toISOString()                     # minted ONCE (BP-6)

# --- BP-12: every stratum call lives inside `if (guarded)`.
guardInitial := null; fromState := null; policyChecksum := null; upgrade := null
needsRegistration := false; proposedInitial := null

if guarded:
    g := await currentGuardState(rid)                       # :310
    if g.error: REFUSE refusedAt 'guard', 'guard unreachable'   # :312-314, never degrade
    if g.state is null:
        # R2B-8: COMPUTE the initial, do NOT register yet.
        lp := item.lifecycle.currentPhase
        proposedInitial := inGraph(transitionsOf(mode), lp) ? lp : genesisOf(mode)
        # genesisOf, NOT a literal (C5). Fix-mode items start at the genesis
        # `explore_design` (vision-routes.js:318), absent from the fix graph, and
        # stratum refuses an `initial` that is not a node (transition.ts:352-354).
        needsRegistration := true
        fromState := proposedInitial       # what registration WILL seed current_state to
        guardInitial := { registered: proposedInitial, lifecycle_phase: lp }
    else:
        fromState := g.state
else:
    # Unguarded: the lifecycle IS the source of truth, and legality is local.
    fromState := item.lifecycle.currentPhase

if fromState in terminalOf(mode):
    REFUSE refusedAt 'guard', '<CODE> is already terminal at "' + fromState + '"'
```

Nothing durable has been written yet. §5.5 validates evidence and history against this `fromState`;
§5.6 performs the registration and the upgrade; §5.7 persists the intent; §5.8 transitions.

The item's phase history is **not** relabelled to match `proposedInitial`; the mapping lives only on
the batch record's `guard_initial`.

### 5.5 Materialise and validate the history BEFORE any guard mutation (BP-4)

```
# 1. fresh evidence (async runner, §5.2) — new operations only
ev := await verifyCompletionEvidenceAsync({ commitSha, cwd: evRoot,
        testCommand: guardTestCommand(workspaceRoot), testsPassClaim: testsPass })
if not ev.ok: REFUSE refusedAt 'evidence', ev.reasons
attested := ev.testsAttested ? true : (testsPass === true)

# 2. BP-9: reject unknown phases up front. No incoming occurrence is ever treated
#    as out-of-graph — that exemption belongs to the stored genesis record alone.
for o in request.occurrences:
    if not inGraph(transitionsOf(mode), o.phase):
        REFUSE refusedAt 'request', '"' + o.phase + '" is not a phase of mode ' + mode

# 3. resolve evidence and CONSTRUCT the full occurrence (BP-9: every field)
occurrences := request.occurrences.map(o => {
    const resolved = resolveEvidenceRef(evRoot, o.evidence)
    return { phase: o.phase, step: o.phase, to: o.phase, from: null,   // from is set by the merge
             enteredAt: resolved.observedTime, timestamp: resolved.observedTime, exitedAt: null,
             outcome: 'backfilled', recordedAt: now, origin: 'backfill',
             confidence: deriveConfidence(resolved.kind), episode: 1, evidence: resolved }
})

# 4. the terminal occurrence, also stably timestamped and carrying the op id (BP-6)
terminalOcc := { phase: 'complete_backfilled', step: 'complete_backfilled',
                 to: 'complete_backfilled', from: fromState,
                 enteredAt: now, timestamp: now, exitedAt: null,
                 outcome: 'backfilled', recordedAt: now, origin: 'live',
                 confidence: 1.0, episode: 2, operation_id: operationId,
                 evidence: { kind:'commit', ref: commitSha, verifiedAt: now,
                             observedTime: now, observedEpochMs: ms(now) } }
#  The terminal occurrence IS live — it happened now. The terminal STATE is the
#  provenance signal (Decision 11), not this field.

# 5. VALIDATE the whole prospective history, terminal included (BP-4, BP-8/H7)
probe := insertBackfilledPhases(item, occurrences ++ [terminalOcc])
if not probe.ok: REFUSE refusedAt 'history', probe.reasons     # BEFORE any guard mutation
if last(probe.history).phase != 'complete_backfilled':
    REFUSE refusedAt 'history',
      'backfilled evidence is dated after the completion being recorded'
```

Nothing has touched the guard at this point. A history refusal costs nothing and leaves no terminal
state behind — which is the whole of BP-4.

### 5.6 Register, legacy compatibility, and the lazy upgrade (guarded only)

This is the **first durable guard write** of the operation, and it happens only after §5.5 has proved
the request valid (R2B-8).

```
if guarded:
    # R2B-8: registration happens HERE, not in §5.4b. For an already-registered
    # resource this is the idempotent no-op it has always been (:301, :319-321).
    reg := await ensureGuard(featureCode, needsRegistration ? proposedInitial : fromState,
                             workspaceRoot, mode)
    if reg.error: REFUSE refusedAt 'guard'
    if needsRegistration:
        g := await currentGuardState(rid)
        if g.error or g.state is null: REFUSE refusedAt 'guard'
        if g.state != fromState:
            REFUSE refusedAt 'guard', 'registration seeded "' + g.state + '", not "' + fromState + '"'
    if reg.status == 'legacy':
        u := await applyBackfillUpgrade({ featureCode, workspaceRoot, mode })   # S1-4
        if not u.ok:
            REFUSE refusedAt 'upgrade', u.reasons +
              ['regenerate with `compose guard descriptors`, have the operator re-sign it, and commit both files']
        upgrade := { descriptor_id: u.descriptorId, status: u.status, ledger_ref: u.ledgerRef ?? null }
        _registered.set(rid, 'registered')
    # BP-1: read the checksum AFTER any upgrade and BEFORE the transition.
    pol := await guardPolicy(rid)
    if pol.error: REFUSE refusedAt 'guard'
    policyChecksum := pol.checksum
```

**The checksum read is not atomic with the transition (R2B-7).** `guard policy` and `guard transition`
are two separate CLI processes taking the resource lock in turn, so a descriptor applied in between
leaves compose holding checksum P while stratum hashes the payload under checksum Q. The persisted
checksum would then be wrong, and a later recovery would compute a digest that matches nothing —
turning a recoverable crash into a permanent refusal.

Nothing compose can do closes that window from outside the lock, so stratum closes it:
**`STRAT-GUARD-EXPECTED-CHECKSUM` (0.4.4)** adds an optional payload key `expected_policy_checksum`
(64 lowercase hex) to `guard transition`. Under the resource lock, before anything is written, stratum
compares it against the registry's current checksum and, on a difference, refuses **atomically** with
`error_type: "policy_checksum_mismatch"`, writing nothing — no ledger entry, no state change.

Compose sends the persisted checksum on **every fresh backfill transition** (§5.8). A
`policy_checksum_mismatch` is a **refusal, not a failure**: it means the policy moved under the
operation, so the gate returns `refusedAt: 'guard'` with a message saying the guard policy changed
during the operation and that the call is safe to retry. It is retryable precisely because nothing was
written: the next attempt re-reads `guard policy` (§5.6) and sends the new checksum. The intent is
cleared on this path, as on every other pre-transition refusal, so the retry is a clean new operation.

`ensureGuard`'s legacy branch is what keeps advance/skip/kill working on the 35 registered resources;
here it also says whether an upgrade is needed. Ordinary transitions on a `legacy` resource proceed on
the old policy — its edges are a subset — but `complete_backfilled` is not among them, so backfill
alone must upgrade.

### 5.7 Write-ahead intent — the complete validated write plan (BP-3, R2B-3)

The intent is not a hint that an operation started; it is **the whole of what the operation will
write**, computed and validated, persisted in one file before the transition. A resumed attempt
recomputes nothing. The first draft carried the request but not the plan, so a resume had no
`probe.history`, no written/skipped key lists, no `guard_initial`, no `upgrade` and no
`files_changed` — five write inputs it would have had to invent. R3-4 found a sixth, `notes`, and a
seventh input that was being *substituted* rather than restored: `started_at`. §5.4a's `writeContext`
table is the closed list; this section is where the fresh branch fills it in.

Every field, and where each comes from:

| Field | Source | Why recovery needs it |
|---|---|---|
| `operation_id` | minted in §5.4b | the idempotency key and the batch-record key |
| `feature_code`, `mode` | request / item | addressing |
| `request_digest` | §5.1 | proves the retry is the same request |
| `reason` | request | written onto the batch record |
| `commit_sha` | request | completion record, status write, audit event |
| `files_changed` | request | `recordCompletion` argument (R2B-3) |
| `notes` | request | `recordCompletion` argument |
| `tests_attested` | §5.5 evidence | the completion record's `tests_pass`; never re-verified on resume |
| `started_at`, and every timestamp inside the occurrences | minted once in §5.4b | BP-6: a resume must not re-stamp |
| `guarded` | `guardEnabled` at §5.3 | R2B-4: the single effective guard flag for the whole operation |
| `occurrences` | §5.5, materialised + validated | the history write |
| `terminal_occurrence` | §5.5 | the terminal append, carrying `operation_id` |
| `write_plan.history` | `probe.history` from §5.5 | the exact array to persist |
| `write_plan.written`, `write_plan.skipped` | `probe.written` / `probe.skipped` | `occurrenceKeys` on the batch record |
| `guard_initial` | §5.4b | the batch record's registration mapping (R2B-3) |
| `upgrade` | §5.6 | the batch record's descriptor stamp (R2B-3) |
| `policy_checksum` | §5.6, after any upgrade | BP-1: the digest recomputation basis |
| `envelope` | §5.4b / §5.6 | replayed verbatim by §5.9a |

**The fresh branch builds `writeContext` FIRST, then serialises the intent from it (R3-4).** The
intent is the on-disk projection of `writeContext`, not a second assembly of the same values from
scattered locals — if the two were built independently they could disagree, and the disagreement would
only surface on a crash. So: assemble, persist, and from here on §5.8 and §5.10 read `writeContext`
alone. Its keys are camelCase; the intent's are snake_case, because it is modelled on the wire
envelope (S1-2's naming rule).

```
writeContext := { operationId, requestDigest: request_digest, featureCode, mode, reason,
                  commitSha: commitSha ?? null, filesChanged, notes: notes ?? null,
                  attested,                       # §5.5 evidence
                  startedAt: now,                 # minted ONCE in §5.4b (BP-6)
                  occurrences, terminalOcc,       # MATERIALISED + VALIDATED (§5.5)
                  history: probe.history,         # the validated array itself
                  writtenKeys: probe.written, skippedKeys: probe.skipped,
                  guardInitial, upgrade,
                  guarded,                        # R2B-4: the EFFECTIVE flag, not live config
                  policyChecksum,                 # null when unguarded (BP-1)
                  envelope: { from: fromState, to: 'complete_backfilled',
                              artifacts: { operation_id: operationId, request_digest,
                                           resolver_tags: 'late-registration+backfill',
                                           ...(commitSha ? { commit_sha: commitSha } : {}) },
                              modified_files: [], resolved_by: 'agent',
                              idempotency_key: operationId,
                              expected_policy_checksum: policyChecksum },   # R2B-7, guarded only
                  ledgerRef: null }               # an OUTCOME, filled by §5.8

writeIntent(workspaceRoot, featureCode, {
  operation_id: writeContext.operationId, feature_code: writeContext.featureCode,
  mode: writeContext.mode, intent: 'backfill',
  request_digest: writeContext.requestDigest, reason: writeContext.reason,
  commit_sha: writeContext.commitSha, files_changed: writeContext.filesChanged,
  notes: writeContext.notes,                       # R3-4: REQUIRED, nullable
  tests_attested: writeContext.attested, started_at: writeContext.startedAt,
  guarded: writeContext.guarded,
  occurrences: writeContext.occurrences,
  terminal_occurrence: writeContext.terminalOcc,
  write_plan: { history: writeContext.history,
                written: writeContext.writtenKeys,
                skipped: writeContext.skippedKeys },
  guard_initial: writeContext.guardInitial,        # R3-4: REQUIRED, nullable
  upgrade: writeContext.upgrade,                   # R3-4: REQUIRED, nullable
  policy_checksum: writeContext.policyChecksum,    # R3-4: REQUIRED, nullable
  envelope: writeContext.envelope,
})
```

`ledgerRef` is deliberately **not** persisted: it is what the transition produced, not what the
operation intended, and a resume re-derives it from the ledger (§5.9c) rather than trusting a value
written before the transition returned.

The intent persists the full request and its exact envelope because the ledger holds only a payload
hash (`stratum/ts/src/guard/store.ts:38-53`) and cannot reconstruct one. An idempotency key is
correlation, not ownership.

### 5.8 The fresh guarded transition

Fresh operations only. A **recovery** never reaches this function — see §5.9a (R2B-2).

```
env := writeContext.envelope
if writeContext.guarded:
    #  CAMELCASE ACROSS THE JS SEAM (R3-1): the envelope's keys are snake_case
    #  because it is a wire document; the CALL is camelCase, and the translation
    #  back to snake_case happens once, inside stratum-client's guardTransition.
    g := await guardedTransition({ featureCode: writeContext.featureCode,
                                   from: env.from, to: env.to,
                                   workspaceRoot, commitSha: writeContext.commitSha,
                                   resolvedBy: 'agent', mode: writeContext.mode,
                                   artifacts: env.artifacts,
                                   modifiedFiles: env.modified_files,
                                   idempotencyKey: env.idempotency_key,
                                   expectedPolicyChecksum: env.expected_policy_checksum })
    if g.error?.error_type == 'policy_checksum_mismatch':
        # R2B-7: refused ATOMICALLY under stratum's resource lock; nothing written.
        clearIntent(workspaceRoot, featureCode)
        REFUSE refusedAt 'guard',
          'the guard policy for <CODE> changed while this backfill was in flight ' +
          '(expected ' + env.expected_policy_checksum + ') — nothing was written; retry'
    if g.status == 'applied': writeContext.ledgerRef := g.ledgerRef      # FRESH apply
    else if g.status == 'replayed' or g.error?.error_type == 'idempotency_conflict':
        <§5.9b/§5.9c — a fresh attempt that meets an existing entry is a recovery in disguise>
    else:
        REFUSE refusedAt 'guard', (g.refused ? 'refused by guard' : 'guard transition failed')
```

`guardedTransition` (`server/lifecycle-guard.js:333-382`) gains three optional parameters,
`modifiedFiles`, `idempotencyKey` and `expectedPolicyChecksum`, forwarded to `_client.transition`
(`:356-362`) **under those exact camelCase names** — `_client.transition` is
`server/stratum-client.js`'s `guardTransition` (imported as `_guardTransition` at
`server/lifecycle-guard.js:22` and bound into `_client` at `:230`; defined at
`server/stratum-client.js:349`), which destructures camelCase and does
the snake_case translation itself (R3-1, S1-2). Forwarding `idempotency_key` or
`expected_policy_checksum` from here would be silently discarded by that destructuring: no throw, no
warning, and the transition would apply with neither replay identity nor checksum protection. The
wrapper's own signature therefore reads:

```js
export async function guardedTransition({ featureCode, from, to, workspaceRoot, commitSha,
                                          resolvedBy = 'agent', mode = 'build',
                                          artifacts: extraArtifacts,
                                          modifiedFiles, idempotencyKey, expectedPolicyChecksum }) {
  …
  res = await _client.transition({
    resourceId: rid, fromState: from, toState: to, artifacts, resolvedBy,
    modifiedFiles, idempotencyKey, expectedPolicyChecksum,   // camelCase, all the way down
  });
```

All three are `undefined` for every live caller, `_compact` drops them in the transport, and the
piped JSON stays byte-identical to today's. It must also **surface the guard status verbatim** rather than collapsing
it: today `:376` maps `replayed` to `applied: true` with no way to tell the two apart, which is R2B-6.
Add `status: res.status` to both return shapes (`:371-373`, `:375-381`); existing callers read only
`applied` and are unaffected. The comment at `:349-353` explains why live completion
sends no idempotency key — a refuse-fix-retry carries an identical payload and a key would replay the
refusal. That reasoning does not apply to backfill, whose retry is *defined* as "the same request".

The edge carries **no predicate**, exactly like `<completable> → complete`
(`server/lifecycle-guard.js:100-113` binds predicates only to the three `edgeEvidence` edges). Stratum
predicates are static statements and cannot reference per-call artifacts, so reality evidence is the
gate's job and the guard contributes legality plus the tamper-evident ledger. Nobody should read the
ledger entry as a stratum-verified commit.

### 5.9 Recovery: raw replay, then ledger verification (BP-1, R2B-2, R2B-6)

#### 5.9a The replay uses the RAW transport, not `guardedTransition` (R2B-2)

`guardedTransition` calls `ensureGuard` before every transition
(`server/lifecycle-guard.js:334-337`) and fails closed on a registration error. On a recovery that is
fatal: if a second descriptor was applied while the operation was in flight, the stored policy matches
neither the policy `buildPhaseGraph` now produces nor its legacy projection, `ensureGuard` returns
`GUARD_POLICY_DIVERGED`, and the replay that would have succeeded is never attempted. The registration
step is pointless here anyway — the resource demonstrably exists, since a transition against it
already applied.

So recovery goes **straight to the transport** — and it carries the persisted checksum:

```
# server/stratum-client.js guardTransition (:349-359) — the raw CLI verb.
# NO ensureGuard, NO guard policy, NO buildPhaseGraph.
env := writeContext.envelope
# R4-1: the checksum comes from the intent's own field, and its absence is a
# refusal BEFORE any transport call — stratum only enforces the checksum when
# the key is supplied (ts/src/cli/guard.ts:104-106), so an omitted value would
# silently re-open the pre-transition window this whole section exists to close.
if writeContext.policyChecksum is null or not /^[0-9a-f]{64}$/:
    REFUSE refusedAt 'recovery', 'intent has no policy checksum; clear it or re-run'
if env.expected_policy_checksum != writeContext.policyChecksum:
    REFUSE refusedAt 'recovery', 'intent envelope checksum disagrees with intent policy_checksum'
g := await guardTransition({ resourceId: rid,
                             fromState: env.from,
                             toState:   env.to,
                             artifacts: env.artifacts,
                             modifiedFiles: env.modified_files,
                             idempotencyKey: env.idempotency_key,
                             resolvedBy: env.resolved_by,
                             expectedPolicyChecksum: writeContext.policyChecksum })  # R3-2/R4-1
if guardErrorType(g) == 'policy_checksum_mismatch':
    goto §5.9c — READ-ONLY verification. Nothing was written.
if isGuardError(g):
    REFUSE refusedAt 'recovery', 'guard transition failed: ' + guardErrorMessage(g)
```

**Raw-transport error shape (R4-2).** `guardedTransition` normalises both shapes
(`server/lifecycle-guard.js:368-370`: `res.error || res.status === 'error'` → `{error}`), but the raw
verbs in `server/stratum-client.js` do NOT: on a non-zero exit `runGuard` returns stratum's canonical
envelope **unchanged** (`:235`, `JSON.parse(result.stdout)`), i.e. top-level
`{status:'error', error_type, message}` (`ts/src/cli/guard.ts:42-46`), and wraps only spawn/parse
failures as `{error:{code,message}}` (`:230`, `:237`). A check on `.error` alone therefore misses every
stratum-side refusal — `policy_checksum_mismatch` would fall through to the success branch. Every raw
call in this blueprint (`guardTransition`, `guardDigest`, `guardHistory`, `guardPolicy`) goes through
three helpers, exported from `server/lifecycle-guard.js` next to `guardedTransition`:

```js
export const isGuardError      = r => !r || Boolean(r.error) || r.status === 'error';
export const guardErrorType    = r => (r && (r.error?.code ?? r.error_type)) ?? null;
export const guardErrorMessage = r => (r && (r.error?.message ?? r.message)) ?? 'no guard response';
```

Test (existing file, new cases): `test/lifecycle-guard.test.js` — each helper against a canonical
envelope, a `{error:{code}}` envelope, `null`, and a success envelope. §5.9c's harness rows R25-R29
each run twice, once per error shape, so a regression in either branch fails a named test.

**Why the checksum must be sent on a recovery too (R3-2).** The first draft omitted it, reasoning that
a replay is expected to meet a moved policy. That reasoning covers only the crash window *after* the
transition applied. The dangerous window is the other one: **the intent is persisted, then the process
dies before the transition runs at all.** No ledger entry exists under the key, so
`_maybeReplay` returns null (`stratum/ts/src/guard/transition.ts:572-573`, `:467-469`) and, with no expected
checksum, stratum evaluates and **applies the transition under whatever policy is current now**
(`:638-664`). The guard moves to `complete_backfilled` under policy Q. §5.9c then recomputes the
digest under the persisted policy P, finds no matching entry, and refuses — **permanently**, with the
guard already moved and no path that can ever satisfy the check. A crash window turned into an
unrecoverable resource.

Sending the checksum makes that impossible by construction: **a recovery can never apply a transition
except under exactly the policy the intent was written against.** Stratum checks it under the resource
lock before evaluating anything (`:566-570`) and again under the commit lock before appending
(`:633-637`), so either the policy still is P and the call is safe to apply, or the call is refused
atomically with nothing written.

The cost is that a recovery under a moved policy can no longer reach stratum's replay path at all —
the checksum check runs **before** `_maybeReplay` in both phases — so `policy_checksum_mismatch` is now
the *expected* outcome of the after-the-fact scenario as well as the before-the-fact one. §5.9c is
where both land, and it needs no transition to resolve either.

This is the one place outside `server/lifecycle-guard.js` that reaches the guard transport directly,
and it is deliberate: the recovery path must not re-derive policy. **Test it with the guard cache
cleared and again in a fresh process**, so the code path that would have called `ensureGuard` is
genuinely exercised rather than short-circuited by a warm `_registered` entry.

#### 5.9b Which outcomes route to verification (R2B-6)

`replayed` is **not** the same as `applied`, and the first draft accepted both through one
`if (g.applied)`. A replay returns the *historical* verdict together with the registry's *current*
state (`stratum/ts/src/guard/transition.ts:479-487`), so it says nothing about what happened
afterwards: a kill, an override or a migrate could have moved the resource on and the gate would still
have written COMPLETE. The ledger is therefore read on **every** recovery success, not only on
`idempotency_conflict` — and, since R3-2, on `policy_checksum_mismatch` too.

```
if g.status == 'applied' and not recovering:
    writeContext.ledgerRef := g.ledgerRef         # fresh apply — no ledger read needed
else:
    # g.status == 'replayed', OR error_type == 'idempotency_conflict'. The policy
    # checksum is bound into the payload digest (transition.ts:122-131, :571), so a
    # SECOND descriptor applied between attempts makes the conflict the EXPECTED
    # outcome rather than an error.
    goto §5.9c — the same read-only verification, on the same three conditions.
```

#### 5.9c Read-only verification (R3-2, R3-6)

**No transition is issued here.** Everything is decided from `guard digest` (a pure function) and one
`guard history` read. This is the sole resolution path for `replayed`, for `idempotency_conflict`, and
— new in R3-2 — for `policy_checksum_mismatch` on a recovery, which is what a policy change now
produces in both crash windows.

```
if writeContext.policyChecksum is null: REFUSE refusedAt 'recovery', 'no policy checksum on record'
env := writeContext.envelope
d := await guardDigest({ fromState: env.from, toState: env.to,
                         artifacts: env.artifacts,
                         modifiedFiles: env.modified_files,
                         resolvedBy: env.resolved_by,
                         policyChecksum: writeContext.policyChecksum })
if isGuardError(d): REFUSE refusedAt 'recovery', 'payload digest could not be computed: ' + guardErrorMessage(d)

# ONE ledger read, from server/stratum-client.js guardHistory (:382-384), which
# returns resource_id, current_state, graph_version and the full ledger
# (transition.ts:1152-1166). All three conditions below are evaluated against THIS
# snapshot, so they describe one consistent moment.
h := await guardHistory(rid)
if isGuardError(h): REFUSE refusedAt 'recovery', 'guard history unreadable: ' + guardErrorMessage(h)

# (1) THE ENTRY EXISTS AND IS OURS. An applied transition into
#     complete_backfilled, under THIS operation's key, whose payload digest is
#     the one stratum computes for the persisted envelope under the persisted
#     checksum. Matching on id + to_state + outcome alone is exactly R2-1,
#     which BP-1 rejected.
entry := h.ledger.find(e => e.kind == 'transition'
                        and e.idempotency_key == writeContext.operationId
                        and e.outcome == 'applied'
                        and e.to_state == 'complete_backfilled'
                        and e.payload_digest == d.payload_digest)
if entry is null:
    # R3-2: the operation NEVER applied. On a policy_checksum_mismatch this is the
    # pre-transition crash window, and it is where the design deliberately stops:
    # the intent stays, the guard is untouched, and a HUMAN decides. Re-running it
    # under the new policy would silently complete a feature against a policy
    # nobody checked it against.
    REFUSE refusedAt 'recovery',
      'this backfill never reached the guard, and the policy for <CODE> has changed since the ' +
      'intent was written (recorded ' + writeContext.policyChecksum + ', now ' + <live checksum> + '). ' +
      'Nothing has been written. Either clear the intent at ' +
      '.compose/data/completion-intents/<CODE>.json and re-run the backfill under the current ' +
      'policy, or restore the policy the intent was written against.'
    #   On `replayed` / `idempotency_conflict` the same refusal fires with the
    #   plainer message: 'no applied ledger entry under this operation id matches
    #   the persisted envelope'.

# (2) THE RESOURCE IS STILL WHERE THAT ENTRY LEFT IT.
if h.current_state != 'complete_backfilled': REFUSE refusedAt 'recovery',
    'the guard has moved to "' + h.current_state + '" since this operation applied'

# (3) NOTHING MUTATED IT AFTERWARDS. The ledger is append-only and ordered, so
#     this is a suffix scan from `entry`. R3-6: the kinds are the ones stratum
#     ACTUALLY writes — there is no 'override' kind and no 'migrate' kind.
for e in h.ledger AFTER `entry`:
    if e.kind == 'transition' or e.kind == 'deviation':
        REFUSE refusedAt 'recovery',
          'the guard was mutated after this operation applied (a ' + e.kind + ' entry ' +
          e.from_state + ' -> ' + e.to_state + ')'
    if e.kind == 'graph_version':
        # State-preserving BY CONSTRUCTION: both apply-upgrade (:1047-1048) and
        # migrate (:835-836) write from_state == to_state == current_state. VERIFY
        # it rather than assume it — a future stratum that moved state in a policy
        # entry must break this check loudly, not slip past it.
        if e.from_state != e.to_state:
            REFUSE refusedAt 'recovery',
              'a policy entry moved the guard state after this operation applied'
        continue                                  # policy changed, state did not — allowed
    REFUSE refusedAt 'recovery', 'unrecognised ledger entry kind "' + e.kind + '" after this operation'

writeContext.ledgerRef := entry.entry_digest
```

**The kinds are exactly three (R3-6).** `stratum/ts/src/guard/transition.ts` writes `kind:'transition'`
(`:653`), `kind:'deviation'` (`:765`, what `guard override` produces — the *status* is `deviation` and
so is the kind; nothing anywhere writes `kind:'override'`) and `kind:'graph_version'` (`:838` for
`guard migrate`, `:1050` for `apply-upgrade`, `:1130` for the signed-descriptor path — nothing writes
`kind:'migrate'`). The first draft scanned for `{transition, override, migrate}`: two of those three
names do not exist, so **an override — the one mutation an operator performs by hand, and the only one
that bypasses predicate verification — passed the check silently**, while a policy migration was
rejected under a name it is never written with. The unknown-kind branch above is there so the next
kind stratum adds fails closed instead of being waved through.

Condition 3 is what makes 2 meaningful: `current_state` alone can be moved away and back. With the
kinds corrected that round trip is now caught, because moving away and back requires two `deviation`
or `transition` entries and either one refuses. A `graph_version` entry is deliberately **not**
disqualifying — it changes the policy without changing the state, and the entry we matched in
condition 1 carries the payload digest it was written with, which no later policy change can alter.
Missing material — no persisted checksum, no digest action, no readable history — refuses.

### 5.10 The write sequence

Extends `lib/completion-gate.js:412-499`. Steps 6.1–6.2 are durable truth and abort with the intent
kept; 6.3–6.4 are re-drivable projections whose failures are **collected**.

**Every value below comes from `writeContext` (R3-4).** No `probe`, no `now`, no `request`, no
`guardEnabled(cwd)`. `wc` abbreviates `writeContext` in the pseudocode; `tracksJson` is
`getMode(wc.mode).runner.tracksFeatureJson`.

```
wc := writeContext                            # fresh (§5.7) or restored (§5.4a) — identical shape

# 6.0 — history + PENDING marker, one store write, through the LIVE store the
#       server passes in (BP-10). vision-store has no lock and serialises the
#       whole file on every save (server/vision-store.js:131-143), so a
#       second process writing here is last-writer-wins.
#       wc.history is the ALREADY-VALIDATED array (BP-4): probe.history on a
#       fresh operation, and on a resume the persisted plan or lc.phaseHistory,
#       whichever §5.4a's divergence rule selected. R3-5 is what lets the resume
#       reach that rule instead of refusing on the terminal occurrence's tie.
snapshot := deepClone(item.lifecycle)         # BP-5: for rollback
item.lifecycle.phaseHistory := wc.history
item.lifecycle.currentPhase := 'complete_backfilled'
item.lifecycle.completedAt  := wc.terminalOcc.enteredAt              # stable (BP-6)
upsert into item.lifecycle.backfills[] keyed by wc.operationId:
    { operation_id: wc.operationId, request_digest: wc.requestDigest, state:'pending',
      reason: wc.reason,
      recordedAt: wc.startedAt,               # R3-4: the OPERATION's instant, not the retry's
      completionEvidence: { commit_sha: wc.commitSha, tests_attested: wc.attested,
                            verified_at: wc.startedAt },
      guardRef: wc.ledgerRef, guard_initial: wc.guardInitial, upgrade: wc.upgrade,
      actor: 'agent:rest',
      occurrenceKeys: wc.writtenKeys ++ wc.skippedKeys }
store.updateLifecycle(item.id, item.lifecycle)
if store.lastSaveOk === false:                # _save returns a BOOLEAN (:131-143, :251)
    item.lifecycle := snapshot                # BP-5: roll the in-memory item back so
    store.items.set(item.id, item)            #        memory and disk agree
    REFUSE refusedAt 'write', 'vision-state could not be persisted'   # intent KEPT

# 6.1 completion record — BP-11: only for modes that track feature.json
failures := []
rec := null
if tracksJson:
    <existing :419-439, with EVERY argument taken from wc>
    #   R3-4: recordCompletion reads `notes` (:425), `files_changed` (:424),
    #   `tests_pass` (:423) and `commit_sha` (:422). `notes` was the one the
    #   first draft neither persisted nor restored, so a resumed backfill wrote
    #   a completion record with the notes field silently dropped.
    rec := await recordCompletion(workspaceRoot, {
             feature_code: wc.featureCode,
             ...(wc.commitSha ? { commit_sha: wc.commitSha } : {}),
             tests_pass: wc.attested, files_changed: wc.filesChanged,
             ...(wc.notes ? { notes: wc.notes } : {}),
             idempotency_key: wc.operationId, set_status: false })

# 6.2 status -> COMPLETE, raw — BP-11: guarded on tracksJson
statusChanged := null
if tracksJson:
    <existing :441-465, with wc.commitSha in place of commitSha>
    # phaseToStatus('complete_backfilled') === 'COMPLETE' (S1-1), so the roadmap reads COMPLETE

# 6.3 ROADMAP regen — BP-11: guarded on tracksJson; collected
if tracksJson: <existing :467-472>

# 6.4 vision projection — collected. verifiedCompleteProjection must accept the
#     new terminal (S3-3). R2B-4/R3-7: the projection consults the guard iff
#     wc.guarded, and the VERIFIER is told so explicitly — passing the flag to
#     the projector is not enough, because both the route callback and the
#     verifier make their own decision today (see below).
if tracksJson:
    <existing :474-483, passing consultGuard := wc.guarded
                        and guardEnabledOverride := wc.guarded>
else:
    # R2B-9: modes without feature.json have no projector — and updateLifecycle
    # (server/vision-store.js:235-253) does NOT touch item.status, so without this
    # the item finalizes still reading its old status while its lifecycle says
    # complete_backfilled. The live unmanaged path already does exactly this write
    # (server/vision-routes.js:615). It is DURABLE, not a projection: a failure is
    # rolled back and collected, never swallowed.
    priorStatus := item.status
    store.updateItem(item.id, { status: 'complete' })       # :229 sets lastSaveOk
    if store.lastSaveOk === false:
        store.updateItem(item.id, { status: priorStatus })  # roll back
        failures.push({ step: 'item-status',
                        message: 'vision item status could not be persisted',
                        recover: 'retry the backfill' })

# 6.5 audit — BP-5: NON-SWALLOWING, and emitted regardless of statusChanged.
#     safeAppendEvent (lib/feature-writer.js:414-422) swallows and warns, so it can
#     never establish that the event reached disk. Call the provider primitive it
#     wraps (:417) and collect a failure instead.
auditOk := false
try {
    const provider = await getProvider(workspaceRoot)
    await provider.appendEvent(wc.featureCode, {
      tool: 'backfill_completion', code: wc.featureCode,
      from: statusChanged?.from ?? null, to: 'COMPLETE',
      reason: 'backfill', via: 'completion_gate',
      operation_id: wc.operationId, backfill_request_digest: wc.requestDigest,
      ...(wc.commitSha ? { commit_sha: wc.commitSha } : {}),
      ...(wc.ledgerRef ? { ledger_ref: wc.ledgerRef } : {}),
    })
    auditOk = true
} catch (e) { failures.push({ step: 'audit', message: e.message, recover: 'retry the backfill' }) }

# 6.6 finalize — BP-5: ONLY with an empty failure set AND a confirmed audit write.
if failures.length == 0 and auditOk:
    snapshot2 := deepClone(item.lifecycle)
    #   `finalizedAt` is the ONLY timestamp in this section minted at write time,
    #   deliberately: it records when the operation finished, which on a resume
    #   really is now. Everything else comes from wc.startedAt (R3-4).
    record.state := 'finalized'; record.finalizedAt := new Date().toISOString()
    store.updateLifecycle(item.id, item.lifecycle)
    if store.lastSaveOk === false:
        item.lifecycle := snapshot2; store.items.set(item.id, item)     # roll back
        return { ok:true, partial:true, failures: [...],
                 guarded: wc.guarded, operationId: wc.operationId, ledgerRef: wc.ledgerRef }
    clearIntent(workspaceRoot, wc.featureCode)                          # :501, LAST
    return { ok:true, guarded: wc.guarded, operationId: wc.operationId,
             ledgerRef: wc.ledgerRef, recovered: recovering, ... }
    #   `wc.guarded` here and everywhere in this section is the EFFECTIVE flag
    #   (R2B-4): live config on a fresh operation, the intent's persisted value on
    #   a resumed one.
else:
    # The record stays `pending`, the intent stays. A retry resumes.
    return { ok:true, partial:true, failures,
             guarded: wc.guarded, operationId: wc.operationId, ledgerRef: wc.ledgerRef, ... }
```

The invariant: a record is `finalized` only if every write reached disk **and** the audit event was
positively confirmed, so the `finalized → return` shortcut in §5.3 can never return a half-written
batch. Anything else is `pending` and resumes.

#### 5.10a The effective guard flag has to reach the verifier, not just the projector (R3-7)

Passing `guarded` into step 6.4 changes nothing on its own, because **two independent places decide
the same question and neither is asked**:

1. The route's projector callback hardcodes it. `server/vision-routes.js:564` builds the
   `visionProjector` closure with a literal `consultGuard: true`. The gate calls that closure with the
   payload at `lib/completion-gate.js:478-479`, and the closure ignores whatever the payload says about
   the guard. So an operation that ran with the guard **off** — Flow C, or a resume of a guard-off
   operation after the flag was flipped on — would still spawn a stratum process to read a resource
   that was never registered.
2. The verifier re-decides from live config. `server/completion-projection.js:136` short-circuits on
   `!consultGuard || !guardEnabled(cwd)`. So an operation that ran with the guard **on**, resumed after
   the flag was flipped off, downgrades from `verified_by: GUARDED` to `CANONICAL` and stamps a weaker
   verification than the operation actually earned — the persisted flag says otherwise and is ignored.

Both directions are wrong, and each is wrong in the opposite direction, so one fix cannot cover both.
The change is to thread the flag through both:

- **`lib/completion-gate.js:477-480`** — add `guarded: wc.guarded` to the projector payload. Existing
  callers of `completionGate` are unaffected: the live path passes its own effective flag, which is
  what it already computes.
- **`server/vision-routes.js:564`** — the closure takes the payload's flag:
  `({ visionItemId, commitSha, ledgerRef, guarded }) => applyVerifiedProjection(store, { …,
  consultGuard: guarded ?? true, guardEnabledOverride: guarded })`. The `?? true` keeps the live
  `/lifecycle/complete` path byte-identical for any caller that does not send the field.
- **`server/completion-projection.js:93-94`, `:136`** — `verifiedCompleteProjection` gains
  `guardEnabledOverride` (default `undefined`), and `:136` becomes
  `const guardOn = guardEnabledOverride ?? guardEnabled(cwd); if (!consultGuard || !guardOn) …`. This
  is an **operation-level override of a workspace-level config read**, and it is the narrowest thing
  that works: the config answers "is the guard on in this workspace *now*", and a resume needs "was the
  guard on for *this operation*". `applyVerifiedProjection` (`:180-184`) forwards it unchanged.
- `undefined` is not `false`. The override must be read with `??`, never `||`, or a persisted `false`
  would fall through to live config — the exact bug in the other direction.

- **Tests (Flow A step 9, both flips, through the REAL projection path — no fake projector):**
  - guard **on** at crash, `capabilities.guard` flipped to `false`, resume: the replay still happens,
    `guardRef` is still stamped, and the projection stamp still reads `verified_by: 'guarded'`.
  - guard **off** at crash, flipped to `true`, resume: `COMPOSE_STRATUM_TS_CLI_BIN` points at the
    marker script from Flow C, and the marker file does **not** exist afterwards — proving the verifier
    consulted no guard, which asserting on `verified_by` alone cannot prove.

### 5.11 Refusal taxonomy

`refusedAt` values, all returning `{ok:false}` with nothing written: `request` (no reason, no
commit_sha, unknown phase), `preflight` (feature or item missing, terminal status), `evidence` (bad
SHA, tests not attested), `history` (any merge refusal, future-dated evidence, **or a stored history
that changed while a backfill was in flight**, R2B-3), `guard` (unreachable, registration failed,
refused, already terminal, **or `policy_checksum_mismatch`**, R2B-7), `upgrade` (descriptor
unavailable or mismatched), `recovery` (pending record with no intent, an intent missing a
required field, conflicting in-flight operation, no persisted policy checksum, digest mismatch, guard
moved after the entry, guard mutated after the entry by a `transition` or `deviation`, an
unrecognised ledger kind after the entry, **or the pre-transition crash window under a changed
policy**, R3-2), `write` (a durable write failed; the intent is kept).

Two refusals are about the same stratum error and mean opposite things, so keep them apart:

- **`guard` / `policy_checksum_mismatch` on a FRESH transition (R2B-7)** is the only refusal that is
  **retryable without operator action**: stratum refused it under its own lock having written nothing,
  the intent is cleared, and the next attempt re-reads the policy and sends the new checksum. Say so in
  the message.
- **`recovery` / `policy_checksum_mismatch` on a RESUME whose operation never applied (R3-2)** is
  **not** self-retryable and must not pretend to be. Nothing was written, and nothing this process can
  do makes the persisted plan valid again: the plan was validated against a policy that no longer
  exists. The intent stays, the guard is untouched, and the message names the recorded checksum, the
  current one, and the two things a human can do — clear
  `.compose/data/completion-intents/<CODE>.json` and re-run under the current policy, or restore the
  policy the intent was written against. A retry loop here would spin forever; an automatic re-plan
  would complete a feature against a policy nobody checked it against.

---

## 6. Slice S3 — surfaces and readers

### S3-1 — `POST /api/vision/items/:id/lifecycle/backfill`

The backfill route's `visionProjector` closure follows the R3-7 rule from §5.10a: it reads `guarded`
off the payload the gate passes and forwards it as **both** `consultGuard` and `guardEnabledOverride`.
The existing `/lifecycle/complete` closure at `server/vision-routes.js:564` is changed in the same
edit, with `?? true` so its behaviour is unchanged for callers that send no flag.

- **Test first (new):** `test/lifecycle-backfill-routes.test.js`, following `test/lifecycle-routes.test.js`.
  - 404 on a missing item or missing lifecycle (`server/vision-routes.js:398`).
  - **Not** gated on `currentPhase === completablePhaseOf(mode)` — the `:527-530` check belongs to the
    live path; backfill is reachable from any non-terminal phase.
  - 400 when `reason` is missing or blank.
  - 422 on a gate refusal, echoing `refusedAt` and `reasons` (the `:569-576` shape).
  - `guardAuth` applied (`:98-99`), like every other lifecycle POST.
- **`server/vision-routes.js` (existing)** — a handler after `/lifecycle/complete` (`:521-633`). It
  passes the **live store and item** into the gate (BP-10) alongside `intent:'backfill'`, `reason`,
  `occurrences`, `visionItemId: req.params.id`, and reuses the MANAGED branch's in-process
  `visionProjector` (`:564-567`) so the projection runs against the live store rather than a REST call
  back into the server.
  **The route does not mutate `currentPhase`/`completedAt`/`phaseHistory` itself.** Unlike
  `/lifecycle/complete` (`:577-581`), those writes are inside the gate (§5.10 step 6.0) because they
  are part of the pending/finalized transaction.
  Side effects on success mirror `:618-626` with `to: 'complete_backfilled'`.

### S3-2 — MCP tool `backfill_completion` (BP-10)

The MCP server is a **separate process** from the compose server, so the tool must not call the gate
in-process — its history writes would go to a different `VisionStore` instance and be clobbered.

- `server/compose-mcp-tools.js` — modelled on `toolCompleteFeature` (`:779-786`), not on
  `toolRecordCompletion`:

  ```js
  export async function toolBackfillCompletion({ id, commit_sha, tests_pass, files_changed, notes, reason, occurrences }) {
    const body = {};
    if (commit_sha !== undefined) body.commit_sha = commit_sha;
    if (tests_pass !== undefined) body.tests_pass = tests_pass;
    if (files_changed !== undefined) body.files_changed = files_changed;
    if (notes !== undefined) body.notes = notes;
    body.reason = reason;
    body.occurrences = occurrences ?? [];
    return _postLifecycle(id, 'backfill', body);   // :702-717
  }
  ```

  **It must not call `_overrideOk` (`:71-75`) or `assertTerminalStatusAuthorized` (`:102-116`).** The
  backfill edge *is* the authorization; the override token is what this feature replaces, and
  `set_feature_status` stays untouched.
- `server/mcp-tool-defs.js` — a def next to `record_completion` (`:620-638`), `effect:'mutating'`,
  `writes:["feature-json"]`, `required: ['id','commit_sha','tests_pass','files_changed','reason']`.
  The description states (C20) that with no configured `guard.testCommand` an explicit
  `tests_pass: true` is required, that occurrence evidence must be a commit SHA or a repo-relative file
  already inside the repo, and that the tool needs the compose server running (it is an HTTP
  delegation, like `complete_feature`).
- `server/compose-mcp.js` — one `case 'backfill_completion':` next to `:180`.
- **`test/completion-write-allowlist.test.js` (existing)** — the gate remains the only COMPLETE writer,
  so no new allowlist entry is needed; add a test asserting exactly that.

### S3-3 — projection and readers

- `server/completion-projection.js:152-155` accepts only `complete`. Widen to a guarded-terminal set
  `GUARDED_TERMINAL_STATES = new Set(['complete', 'complete_backfilled'])`, stamping `guardState` with
  the **actual** state rather than the literal at `:155`.
- **`server/completion-projection.js:93-94`, `:136`, `:180-184` — `guardEnabledOverride` (R3-7).** See
  §5.10a for why: the verifier currently re-reads live config at `:136` and so ignores the operation's
  persisted guard flag in both directions. `verifiedCompleteProjection` takes the new optional
  parameter, `:136` reads `guardEnabledOverride ?? guardEnabled(cwd)`, and `applyVerifiedProjection`
  forwards it. Absent, behaviour is byte-identical to today's.
- **Test (new):** `verifiedCompleteProjection({…, guardEnabledOverride: false})` in a workspace with
  `capabilities.guard: true` returns `verified_by: 'canonical'` and spawns nothing;
  `{…, guardEnabledOverride: true}` in a guard-off workspace does consult the guard. Assert the
  spawn/no-spawn with the marker-script binary, not by inspecting the return value alone.
- `server/decision-events-snapshot.js:48-57` — pass `origin: entry.origin`, `recorded_at:
  entry.recordedAt`, `confidence: entry.confidence` **unchanged** (BP-16). No `?? 'live'` default: the
  reader interprets absence, the emitter does not manufacture a value.
- `server/decision-event-emit.js:53-71` — accept the three params and add each to the metadata object
  at `:65-68` **only when not undefined**, so a live event is byte-identical to today's.
- `contracts/comp-obs-contract.schema.json` — §2.
- **Test (existing, extend):** `test/decision-events-snapshot.test.js` — a fixture with
  `origin:'backfill'` produces an event carrying it; a fixture with **no** `origin` produces metadata
  with no `origin` key at all. Both assertions, so BP-16 cannot regress.
- **Contract test (new):** validate a backfilled and a live `phase_transition` event against the bumped
  schema; assert `version === '0.2.7'` with a matching `_changelog` key.

### S3-4 — UI

- `src/components/vision/constants.js:50-63` — add `complete_backfilled: 'Complete (backfilled)'`.
  Without it the panel renders the raw state (`ItemDetailPanel.jsx:574` falls through to
  `?? lc.currentPhase`).
- `src/components/vision/ItemDetailPanel.jsx:586-597` — render a badge when
  `(entry.origin ?? 'live') === 'backfill'`, alongside the outcome span at `:592-594`.
- `src/components/vision/ContextPipelineDots.jsx:23-37` — `getStepStatus` matches on
  `p.phase === stepId || p.step === stepId`; render a backfilled step's dot muted and surface
  `origin`/`confidence` in `StepDetail` (`:116-118`).
- `server/session-routes.js:248` — the session projection maps to `{phase, enteredAt, exitedAt}`; add
  `origin` so the session payload is not the one surface that erases the distinction.
- `lib/checkpoint/reconciler.js` and its application point (`server/session-routes.js:156-159`) are
  **unchanged** — the reconciler appends live occurrences and always should.

---

## 7. Golden-flow test design

`test/lifecycle-backfill.test.js` (new). Golden flows against the **real** stratum CLI, plus a
table-driven refusal harness. No guard client is faked anywhere in this file — that is the seam a fake
client hid on 2026-09-05.

### 7.1 The isolated runnable stratum copy (BP-14)

Built once in a `before` hook:

1. `pkgRoot := dirname(createRequire(import.meta.url).resolve('@smartmemory/stratum/package.json'))`;
   `realDist := join(pkgRoot, 'dist')`.
2. `copy := mkdtempSync(...)`. Copy **`package.json` and the complete `dist` tree** recursively. A bare
   `dist` copy cannot run: the CLI imports `yaml` eagerly (`stratum/ts/src/cli/stratum.ts:6`).
3. Overwrite **`<copy>/dist/contracts/guard-signers.allowed`** with `operator <publicKeyLine>` plus a
   newline. It must be `dist/contracts`: `prepare-dist.mjs:29-37` rewrites `trust.ts:23`'s
   `../../contracts/` to `../contracts/` in the compiled `dist/guard/trust.js`, and `:39-45` copies the
   contracts under `dist`. The published package ships only `dist` (`ts/package.json:19-21`).
4. **`node_modules` — mirror the real one, then prove it runs (BP-14, R2B-11, R3-8).** Three rules
   have now failed, and the third failed for a reason worth stating: **`require.resolve` is not a
   package-location API.** It answers "what file does this specifier load", and modern `exports` maps
   are entitled to answer "nothing" for both `<dep>/package.json` and the bare `<dep>`. Measured from
   `stratum/ts` on node v22.22.3, `createRequire(<pkgRoot>/package.json)`:

   | Dependency | `resolve('<dep>/package.json')` | `resolve('<dep>')` |
   |---|---|---|
   | `@openai/codex-sdk` | `ERR_PACKAGE_PATH_NOT_EXPORTED` | `ERR_PACKAGE_PATH_NOT_EXPORTED` |
   | `@anthropic-ai/claude-agent-sdk` | `ERR_PACKAGE_PATH_NOT_EXPORTED` | `…/sdk.mjs` |
   | `js-tiktoken` | `ERR_PACKAGE_PATH_NOT_EXPORTED` | `…/dist/index.cjs` |
   | `@modelcontextprotocol/sdk` | `…/dist/cjs/package.json` — **not the package root** | `MODULE_NOT_FOUND` |
   | the other five | package root | main entry |

   `@openai/codex-sdk` fails **both** legs, so the round-2 fallback ("resolve the bare specifier and
   walk up") cannot rescue it: its `exports` publishes an `import` condition only, and CommonJS
   resolution has nothing to return (`stratum/ts/node_modules/@openai/codex-sdk/package.json:24-29`).
   `@modelcontextprotocol/sdk` fails differently and more quietly — its `"./*"` wildcard
   (`stratum/ts/node_modules/@modelcontextprotocol/sdk/package.json:62-66`) makes `./package.json` resolve to `dist/cjs/package.json`, so
   `dirname()` yields `dist/cjs` and a symlink built from it points at a subdirectory. That one
   produces a *plausible* path, which is why the name check below is not optional.
   `import.meta.resolve` is not the answer either: node's stable form takes no parent argument, so a
   helper living in `compose/test/` cannot resolve from stratum's context with it.

   **The rule that works, and that was run:** mirror stratum's own `node_modules` and let node resolve
   exactly as it does in place.

   ```js
   const pkgNm = join(pkgRoot, 'node_modules');
   if (existsSync(pkgNm)) symlinkSync(pkgNm, join(copy, 'node_modules'), 'dir');
   ```

   Demonstrated end to end: `package.json` + `dist` copied to a temp dir, `node_modules` symlinked to
   `/Users/ruze/reg/my/forge/stratum/ts/node_modules`, then `node <copy>/dist/cli/stratum.js guard` →
   **exit 1**, stderr `Unknown guard action: (none). Expected one of: apply-upgrade, authorize,
   descriptors, digest, history, migrate, override, policy, register, transition, upgrade.`, and no
   `MODULE_NOT_FOUND` anywhere. Node resolves symlinked directories through their real path, so the
   pnpm layout under `.pnpm/` — where each dependency sits beside its own transitive deps — keeps
   working unchanged. All nine declared dependencies are present as entries in that directory.

   **The fallback, for a partially hoisted install**, where `pkgRoot/node_modules` holds only some
   dependencies and the rest live in a hoisted ancestor. Resolve each dependency by **directory walk**,
   never by `require.resolve` — this is node's own lookup at the directory level, and `exports` has no
   say in it:

   ```js
   function resolveDepRoot(fromDir, dep) {            // returns the package ROOT, or null
     for (let d = fromDir; ; d = dirname(d)) {
       const cand = join(d, 'node_modules', dep);
       const pj = join(cand, 'package.json');
       if (existsSync(pj)) {
         try { if (JSON.parse(readFileSync(pj, 'utf8')).name === dep) return realpathSync(cand); }
         catch { /* unreadable manifest: keep walking */ }
       }
       if (dirname(d) === d) return null;
     }
   }
   ```

   **Verify the name on every resolved root, including the ones that resolved cleanly** — that is what
   catches the `dist/cjs` case, where the path exists, the manifest parses, and the package is the
   wrong one. Run against `stratum/ts` this returns a correct root for all nine, `@openai/codex-sdk`
   included. Build `<copy>/node_modules/<dep>` as one symlink per dependency (creating `@scope`
   parents), and fail the test loudly on a `null` rather than proceeding to a smoke run that will fail
   more obscurely.

   The order is: symlink the whole directory, smoke-run (step 5), and fall back to the per-dependency
   farm only if the smoke run reports `MODULE_NOT_FOUND` — a second smoke run then confirms the farm.
   The smoke run is the arbiter for both, which is why step 5 is not optional.

5. **Smoke-run the copy before using it (BP-14, R2B-10).** `--help` is not a valid probe: a healthy
   stratum CLI exits **2** on an unknown argument, so `execFileSync` throws and the check reports a
   broken copy that is in fact fine. Use the documented failure instead, and capture all three
   channels rather than relying on an exception:

   ```js
   const r = spawnSync(process.execPath, [cliPath, 'guard'], { encoding: 'utf8' });
   assert.equal(r.status, 1, `stratum copy is not runnable: ${r.stderr || r.stdout}`);
   assert.match(r.stderr, /Unknown guard action/);
   assert.doesNotMatch(`${r.stdout}${r.stderr}`, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/);
   ```

   `guard` with no action hits `!action || !ACTIONS.has(action)` and writes
   `Unknown guard action: (none). Expected one of: …` to stderr before returning 1
   (`ts/src/cli/guard.ts:235-237`). A dependency-resolution mistake surfaces here with the real module
   name, not later as an unexplained guard error inside a flow.
6. `process.env.HOME = mkdtempSync(...)` — stratum's guard store is
   `join(homedir(), '.stratum', 'guards')` (`ts/src/guard/store.ts:58`) with no env override, so `$HOME`
   is the isolation primitive. The flow asserts the **real** `~/.stratum/guards` entry count is
   unchanged before and after, so isolation is proven rather than assumed.
7. `process.env.COMPOSE_STRATUM_TS_CLI_BIN = join(copy, 'dist', 'cli', 'stratum.js')`
   (`lib/stratum-engine.js:134`, `:218-221`). One variable routes register, transition, history, policy,
   apply-upgrade and digest to the copy (C16).

Stratum's `setGuardTrustRootForTests` seam is **not** used and must not be: an env- or
`NODE_ENV`-selected trust root lets a CLI caller point at its own key (round-3 finding 1,
`ts/src/guard/trust.ts:39-41`).

### 7.2 The in-test sshsig signer

`test/helpers/sshsig-sign.js` (new), a JavaScript port of `stratum/ts/tests/helpers/sshsig-sign.ts`.
What must be reproduced exactly, or `verifySshsig` rejects the signature:

| Element | Requirement |
|---|---|
| Key type | Ed25519, `generateKeyPairSync('ed25519')`. The raw 32-byte public key is the **tail of the SPKI DER export**: `publicKey.export({format:'der',type:'spki'}).subarray(-32)` |
| SSH string encoding | 4-byte big-endian length prefix, then the bytes. Used for every field |
| Public-key blob | `sshString("ssh-ed25519")` then `sshString(raw32)`; the allowed-signers line is `ssh-ed25519 <base64(blob)>` |
| Signed pre-image | `"SSHSIG"`, `sshString(namespace)`, `sshString("")`, `sshString(hashAlg)`, `sshString(hash(message))`. The empty reserved field must be present |
| Hash algorithm | `sha512`, named in the blob and used for the digest; both must agree |
| Signature | `crypto.sign(null, preImage, privateKey)` — `null` algorithm is required for Ed25519 |
| Armored blob | `"SSHSIG"`, `uint32(1)`, `sshString(pubKeyBlob)`, `sshString(namespace)`, `sshString("")`, `sshString(hashAlg)`, `sshString(sshString("ssh-ed25519") + sshString(sig))` |
| Armor | base64 wrapped every 70 chars between `-----BEGIN SSH SIGNATURE-----` and `-----END SSH SIGNATURE-----`, trailing newline |
| Namespace | `stratum-guard-descriptors` (`ts/src/guard/descriptors.ts:35`). A different namespace verifies as a rejection |
| Signed bytes | the descriptor file's **exact bytes**, not a re-serialisation |

This is an independent implementation of the signing side; the verifying side is exercised against a
real `ssh-keygen` golden artifact in `stratum/ts/tests/guard/sshsig.test.ts`, so a shared
misunderstanding between the two cannot pass unnoticed.

### 7.3 Flow A — build mode, registered legacy resource

Against a real git repo fixture (`test/completion-gate.test.js:38-60`), a real vision store,
`capabilities.guard: true`, no `guard.testCommand` (so `tests_pass: true` is required):

1. **Register a LEGACY resource (BP-15).** Build the **full policy object**, not a graph, then project
   it:

   ```js
   const policy = {
     graph: buildPhaseGraph('build'),
     edge_predicates: edgePredicates('docs/features/BF-1', 'build'),
     terminal: terminalOf('build'),
     stakes: {},
   };
   const legacy = legacyPolicyProjection(policy);   // takes a POLICY, not a graph
   await guardRegister({ resourceId: rid, graph: legacy.graph,
     edgePredicates: legacy.edge_predicates, initial: 'explore_design',
     terminal: legacy.terminal, stakes: legacy.stakes, workspaceRoot });
   ```

   The first draft passed `legacyPolicyProjection(buildPhaseGraph(mode))` — a graph where a policy is
   required, which would have thrown or silently produced a wrong checksum. Assert
   `status: 'registered'` and capture `checksum`.
2. **Generate and sign the descriptor.** `writeDescriptorFile(workspaceRoot)` → exactly one entry whose
   `from_checksum` equals the captured checksum and whose `to_policy` differs only by the node. Sign
   the exact bytes into `.compose/guard-upgrades.json.sig`. Assert mode `0600`.
3. **Assert `ensureGuard` reports `legacy`** for this resource with the new graph — the C3/finding-2
   rule proved against the real CLI, not a fake.
4. **Backfill.** `completionGate({intent:'backfill', …})` with H1's three occurrences. Assert:
   - the ledger holds a `kind:'graph_version'` entry, `resolved_by:'human'`, rationale naming the
     descriptor id, signer principal and file sha256 (`ts/src/guard/transition.ts:1136-1137`);
   - a `transition` entry `to_state:'complete_backfilled'`, `outcome:'applied'`,
     `idempotency_key === operationId`;
   - `guard policy` reports `graph_version: 2` and `terminal` containing `complete_backfilled`;
   - `feature.json` status is `COMPLETE`;
   - `lifecycle.currentPhase === 'complete_backfilled'` and `backfills[0].state === 'finalized'`;
   - `phaseHistory` matches H1's order and closures, plus the terminal occurrence carrying
     `operation_id`;
   - the audit event is present in the feature's event log (BP-5: it is *asserted*, not assumed).
5. **Identical retry.** Re-issue byte-identically: `status:'finalized'`, same `operation_id`, **no** new
   ledger entry, `phaseHistory` deep-equal including every `recordedAt`, and **exactly one** occurrence
   with `operation_id` (BP-6).
6. **Crash simulation.** Fresh workspace; drive the same request and interrupt after the transition
   applies but before finalize (inject a one-shot ROADMAP render failure). Assert the record is
   `pending`, the intent still exists, and its `occurrences`, `terminal_occurrence`, `envelope` and
   `policy_checksum` are all present. Re-issue: the guard returns `replayed` (no second `applied`
   entry), no duplicate terminal occurrence, no re-stamped `recordedAt`, the record flips to
   `finalized`, the audit event is emitted **on this attempt even though `statusChanged` is null**
   (BP-5/R3-1), and the intent is cleared last.
6b. **Recovery after a successful step 6.0 (R3-5).** Interrupt *later* than step 6: let the history
   write and the pending marker reach disk, then fail before the completion record (inject a one-shot
   `recordCompletion` throw). The stored `phaseHistory` now already contains the terminal occurrence.
   Re-issue and assert the operation **resumes** — `refusedAt` is absent — and that the merge treated
   the terminal as already written: `written` is empty, the terminal's key is in `skipped`, and
   `phaseHistory` has **exactly one** entry carrying `operation_id`. Written against the first draft
   this test refuses at `history`: the terminal's `origin` is `live`, so the claim index cannot match
   it, its stored `enteredAt` and the incoming `observedEpochMs` are the same instant by construction,
   and the tie check fires on every ordinary recovery.

7. **Digest-verified recovery (BP-1, R2B-2, R2B-6, R3-2).** From the pending state of step 6, apply a
   **second** signed descriptor so the policy checksum changes, then re-issue **after
   `_testOnly_resetGuardCache()` and again in a fresh process** — so the path that would call
   `ensureGuard` is genuinely exercised (R2B-2). The recovery call goes through the raw
   `guardTransition` transport **carrying the persisted `expected_policy_checksum`** (R3-2), so stratum
   refuses it with `policy_checksum_mismatch` under its own lock; §5.9c then recomputes the digest under
   the **persisted** checksum via `guard digest`, finds the ledger entry, and the operation resumes.
   Assert the ledger gained **no** entry from this attempt. Four negative variants, one per §5.9c
   condition:
   - mutate an artifact in the persisted envelope (condition 1 — the digest no longer matches);
   - drive a `killed` transition after the entry so `current_state` moves (condition 2);
   - **an override after the entry that leaves the state where it was (condition 3, R3-6).** An
     override cannot be a self-transition: `guard override` requires a declared edge
     (`ts/src/guard/transition.ts:757-759`) and `from_state == current_state` (`:754-756`), and the
     build graph declares nothing out of `complete_backfilled`. So the setup is a signed
     `guard migrate` adding the edges `complete_backfilled → killed` and `killed → complete_backfilled`,
     then **two** signed overrides, out and back. Assert the ledger holds two `kind:'deviation'` entries
     after ours and that `current_state` is `complete_backfilled` again — the state round trip is
     invisible to condition 2 and is exactly what condition 3 exists to catch. Written against the
     first draft this variant **passes recovery**, because that scan looked for `kind:'override'`, a
     kind stratum never writes.
   - a `graph_version` entry after ours (the second descriptor of this very step) is **not**
     disqualifying: assert the resume succeeds with it present, so the allowance is tested and not
     merely asserted in prose.

7b. **The pre-transition crash window (R3-2).** Fresh workspace. Drive a backfill and interrupt
   **after `writeIntent` returns and before the transition is issued** — inject the failure into the
   `guardTransition` call itself so nothing reaches stratum. Assert the intent exists, the ledger has
   **no** entry for the resource, and `guard policy` still reports the original checksum. Then:
   - **policy unchanged:** re-issue. The recovery sends the persisted checksum, stratum matches it,
     no replay exists, the transition applies **under the policy the intent was written against**, and
     the operation completes. Assert exactly one `applied` transition entry.
   - **policy moved:** apply a second signed descriptor first, then re-issue. Assert
     `refusedAt: 'recovery'`, that the ledger still holds **no** transition entry, that `feature.json`
     is untouched, that `guard policy` reports the *new* checksum with `current_state` **unmoved**, and
     that the intent is still on disk. Assert the message names the recorded checksum, the current one,
     and both operator actions (clear the intent and re-run, or restore the policy). Written against
     the first draft this is the unrecoverable case: with no expected checksum the transition applies
     under the new policy, moving the guard to `complete_backfilled`, and every subsequent attempt
     refuses at condition 1 forever.
8. **Checksum raced under the lock (R2B-7).** Drive a fresh backfill whose `guard policy` read is
   followed by a descriptor apply before the transition. Assert the transition is refused with
   `policy_checksum_mismatch`, that the ledger gained **no** transition entry, that `feature.json` is
   untouched, and that an immediate retry succeeds because it re-reads the policy.
9. **Guard flag flipped mid-operation (R2B-4, R3-7).** From the pending state of step 6, flip
   `capabilities.guard` to `false` in `.compose/compose.json` and re-issue. Assert the resume still
   replays the guard transition, still stamps `guardRef`, **and still stamps
   `verified_by: 'guarded'`** — the last of those is what proves the flag reached the *verifier*
   (`server/completion-projection.js:136`) and not merely the projector. Repeat with the flag flipped
   the other way from a guard-off pending operation: point `COMPOSE_STRATUM_TS_CLI_BIN` at Flow C's
   marker script and assert the marker file does **not** exist afterwards, so "no stratum process was
   spawned" is proven by the filesystem rather than inferred. Both halves go through the real route
   closure (`server/vision-routes.js:564`) — a fake projector in this test would hide exactly the
   hardcoded `consultGuard: true` that R3-7 is about.

### 7.4 Flow B — fix mode, no feature.json (BP-11)

A `mode:'fix'` item under `docs/bugs/BUG-BF-1` with **no** feature.json, `capabilities.guard: true`.
Drive H3's occurrences. Assert: the gate does **not** refuse at preflight; no `recordCompletion`,
feature.json status write or ROADMAP render is attempted (`tracksFeatureJson:false`); the guard
transition and the lifecycle writes both happen; **`item.status === 'complete'` on disk** (R2B-9 — the
assertion that catches the missing durable write, since `updateLifecycle` never touches it);
`backfills[0].state === 'finalized'`; the audit event is emitted. This is the flow the first draft
could not have passed.

### 7.5 Flow C — guard off (BP-12)

`capabilities.guard: false`, and `COMPOSE_STRATUM_TS_CLI_BIN` pointed at a script that **fails if
invoked** (writes a marker file and exits 1). Drive a build-mode backfill. Assert: it succeeds; the
marker file does **not** exist, proving no stratum process was spawned; `fromState` came from
`item.lifecycle.currentPhase`; `guardRef` is null and `policy_checksum` is null on the intent; terminal
legality was still enforced locally (a second backfill on the now-terminal item refuses).

### 7.6 Table-driven refusal harness

One `test` per row, each asserting `refusedAt` and that **nothing** was written (feature status
unchanged, no new ledger entry, no new `phaseHistory` entry, no `backfills[]` entry):

| # | Case | Expected `refusedAt` |
|---|---|---|
| R1 | no `reason` | `request` |
| R2 | no `commit_sha` | `request` |
| R3 | an occurrence phase that is not a node of the mode graph (BP-9) | `request` |
| R4 | `commit_sha` that is not a commit in the repo | `evidence` |
| R5 | `tests_pass` omitted with no configured test command | `evidence` |
| R6 | occurrence evidence path escaping the repo (`../../etc/passwd`) | `history` |
| R7 | occurrence evidence path that is a repo-internal symlink to outside | `history` |
| R8 | **workspace root reached through the macOS firmlink** (`/System/Volumes/Data/<repo>`), with an ordinary repo-relative evidence path — must **succeed**, proving the strip | — (ok) |
| R9 | two incoming occurrences sharing an instant | `history` |
| R10 | an incoming occurrence at exactly `lifecycle.startedAt` | `history` |
| R11 | an incoming occurrence strictly inside a closed live interval | `history` |
| R12 | an unreachable consecutive pair within one episode (H4) | `history` |
| R13 | evidence dated after the completion being recorded (H7) | `history` |
| R14 | descriptor file present but **unsigned** | `upgrade` |
| R15 | descriptor signed by a key not in the trust root | `upgrade` |
| R16 | descriptor whose `from_checksum` does not match the stored policy | `upgrade` |
| R17 | descriptor file **group-writable**, `chmod 0o660` | `upgrade` |
| R18 | registered resource, no descriptor file at all | `upgrade` |
| R19 | **unregistered** resource, no descriptor file — must **succeed** (registers fresh with the new graph) | — (ok) |
| R20 | feature already `KILLED` (build mode) | `preflight` |
| R21 | guard already at a terminal state | `guard` |
| R22 | vision item missing or has no lifecycle | `preflight` |
| R23 | a pending batch record with no matching intent (BP-3) | `recovery` |
| R24 | a different backfill operation in flight for the same feature | `recovery` |
| R25 | an intent on disk with `notes` (or `guard_initial`, `upgrade`, `policy_checksum`) **absent** — a corrupt DTO, not a defaultable one (R3-4) | `recovery` |
| R26 | a stored `phaseHistory` entry carrying this `operation_id` but a different `enteredAt` (R3-5) | `history` |
| R27 | a `deviation` ledger entry after ours, state round-tripped back to `complete_backfilled` (R3-6) | `recovery` |
| R28 | a ledger entry after ours with an unrecognised `kind` (R3-6, fail-closed) | `recovery` |
| R29 | pre-transition crash window plus a changed policy (R3-2) — assert the intent is **kept**, unlike every other row | `recovery` |
| R25 | `idempotency_conflict` with a ledger digest that does not match the persisted envelope | `recovery` |
| R26 | **guard unreachable**: `COMPOSE_STRATUM_TS_CLI_BIN` pointed at an existing file that is not a working CLI | `guard` |

Two fixture corrections from the gate (BP-15) are load-bearing:

- **R17 must be `0o660`, not `0640`.** Stratum tests `stats.mode & 0o022` (`ts/src/guard/descriptors.ts:160`,
  refused at `:200-202`) — that is group-**write** and other-write. `0640` is group-*read* and would
  not be refused, so the first draft's fixture asserted a refusal that never happens.
- **R26 must point at an EXISTING file.** `resolveStratumBin` only takes the env candidate
  `if (envCandidate && existsSync(envCandidate))` (`lib/stratum-engine.js:221`), so a nonexistent path
  silently falls back to the installed binary and the guard is perfectly reachable. Use an existing
  executable that exits non-zero, or a plain text file, to actually produce the SPAWN/error path.
- **R8 replaces the first draft's R7.** An *absolute* `/System/Volumes/Data/...` evidence ref is
  refused by `validateRepoPath` step 2 (`lib/feature-writer.js:614-616`) as non-repo-relative, which is
  correct behaviour, so the old fixture could never have proved the firmlink strip. The strip matters
  on the **cwd** side, which is what R8 exercises.

R14–R18 all surface as `upgrade_descriptor_unavailable` or `upgrade_descriptor_mismatch`
(`descriptors.ts:187-192` collapses every load failure to the former, deliberately, so the error is not
an oracle); the harness asserts the compose-side `refusedAt` and that the message names
`compose guard descriptors`.

---

## File Plan

| File | Action | Purpose |
|---|---|---|
| `lib/lifecycle-modes.js` | modify | `complete_backfilled` in `terminal` for all four modes |
| `server/lifecycle-guard.js` | modify | `TERMINAL`, backfill edges, `phaseToStatus`, `Map` cache, legacy projection, `applyBackfillUpgrade`, async evidence runner, `idempotencyKey` + `expectedPolicyChecksum` + verbatim `status` on `guardedTransition` |
| `server/stratum-client.js` | modify | `guardPolicy`, `guardApplyUpgrade`, `guardDigest`, child-env support; `guardTransition` gains `expectedPolicyChecksum` and is the recovery transport (R2B-2/R2B-7) |
| `lib/guard-descriptors.js` | new | descriptor derivation, enumeration, byte-stable write |
| `lib/backfill-evidence.js` | new | evidence resolution, containment, confidence derivation |
| `server/lifecycle-phase-history.js` | modify | `recordedAt`/`origin`/`confidence`, `insertBackfilledPhases`, `normaliseOrigin` |
| `lib/completion-gate.js` | modify | `intent:'backfill'`, digest, lookup order, bootstrap/recovery split, upgrade, digest-verified replay, pending/finalized |
| `server/completion-projection.js` | modify | accept `complete_backfilled` as a guarded terminal |
| `server/vision-routes.js` | modify | `POST …/lifecycle/backfill`, live store into the gate |
| `server/compose-mcp-tools.js` | modify | `toolBackfillCompletion` delegating over HTTP |
| `server/mcp-tool-defs.js` | modify | `backfill_completion` tool def |
| `server/compose-mcp.js` | modify | dispatch case |
| `server/decision-events-snapshot.js` | modify | carry origin / recorded_at / confidence unchanged |
| `server/decision-event-emit.js` | modify | optional metadata fields |
| `server/session-routes.js` | modify | carry `origin` in the session lifecycle projection |
| `bin/compose.js` | modify | `compose guard descriptors` dispatch |
| `contracts/lifecycle-backfill.schema.json` | new | request, occurrence, intent, batch record |
| `contracts/comp-obs-contract.schema.json` | modify | version 0.2.7, phase_transition metadata |
| `src/components/vision/constants.js` | modify | `complete_backfilled` label |
| `src/components/vision/ItemDetailPanel.jsx` | modify | backfill badge in the history strip |
| `src/components/vision/ContextPipelineDots.jsx` | modify | muted dot, origin in StepDetail |
| `test/lifecycle-backfill.test.js` | new | flows A/B/C + refusal harness + the heartbeat-progress assertion (R2B-12) |
| `test/phase-history-merge.test.js` | new | the seven histories |
| `test/lifecycle-backfill-graph.test.js` | new | graph, terminal, status projection |
| `test/lifecycle-backfill-upgrade.test.js` | new | lazy apply-upgrade outcomes |
| `test/lifecycle-backfill-routes.test.js` | new | REST surface |
| `test/backfill-evidence.test.js` | new | resolver, containment, firmlink |
| `test/guard-descriptors.test.js` | new | derivation, dedup, byte stability, round trip |
| `test/helpers/sshsig-sign.js` | new | in-test sshsig signer |
| `test/lifecycle-guard.test.js` | modify | legacy-policy compatibility cases |
| `test/stratum-client-guard.test.js` | modify | `guardPolicy` / `guardApplyUpgrade` / `guardDigest` wire shapes |
| `test/lifecycle-modes.test.js` | modify | expected `terminal` gains the node |
| `test/lifecycle-modes-golden.test.js` | modify | adjacency filters cover both auto-added terminals; positive assertion added (BP-17) |
| `test/judgment-writer.test.js` | modify | surplus-edge list grows from five to nine (BP-17) |
| `test/decision-events-snapshot.test.js` | modify | origin carried; absence preserved |
| `test/completion-write-allowlist.test.js` | modify | assert backfill routes through the gate |
| `CHANGELOG.md` | modify | same commit as the code |
| `README.md` | modify | operator steps: key, trust root, descriptors, signing |

## Boundary Map

Slice ids map to the design's Slices table: S01 = S1 (graph + descriptors), S02 = S2 (gate intent +
history), S03 = S3 (surfaces + readers). Endpoint, payload and invariant details deliberately live in
the prose above rather than in entries: the backfill REST route, the three `stratum guard` stdin
payloads, the `contracts/lifecycle-backfill.schema.json` shapes, the obs-contract 0.2.7 bump and the
pending/finalized invariant are not grep-checkable identifiers and are out of scope for the validator.

### S01: graph, transport, descriptors
Produces:
  server/lifecycle-guard.js → buildPhaseGraph, phaseToStatus, ensureGuard, legacyPolicyProjection, policyChecksumFields, policiesEqual, applyBackfillUpgrade, guardedTransition, verifyCompletionEvidenceAsync (function)
  server/lifecycle-guard.js → TERMINAL (const)
  server/lifecycle-guard.js → isGuardError, guardErrorType, guardErrorMessage (function)
  server/stratum-client.js → guardPolicy, guardApplyUpgrade, guardDigest, guardHistory, guardTransition (function)
  lib/lifecycle-modes.js → terminalOf, genesisOf, transitionsOf (function)
  lib/guard-descriptors.js → descriptorIdFor, deriveBackfillPolicy, buildDescriptorFile, enumerateRegisteredResources, writeDescriptorFile (function)

Consumes: nothing (leaf node)

### S02: gate intent and valid-time history
Produces:
  server/lifecycle-phase-history.js → appendPhaseHistory, insertBackfilledPhases, normaliseOrigin (function)
  lib/backfill-evidence.js → resolveEvidenceRef, deriveConfidence (function)
  lib/backfill-evidence.js → CONFIDENCE_BY_KIND (const)
  lib/completion-gate.js → completionGate, currentGuardState, readIntent (function)

Consumes:
  from S01: server/lifecycle-guard.js → ensureGuard, guardedTransition, applyBackfillUpgrade, phaseToStatus, verifyCompletionEvidenceAsync
  from S01: server/stratum-client.js → guardPolicy, guardApplyUpgrade, guardDigest, guardHistory, guardTransition
  from S01: lib/lifecycle-modes.js → terminalOf, genesisOf, transitionsOf

### S03: surfaces and readers
Produces:
  server/compose-mcp-tools.js → toolBackfillCompletion (function)
  server/completion-projection.js → verifiedCompleteProjection, applyVerifiedProjection (function)
  server/decision-events-snapshot.js → deriveDecisionEvents (function)
  server/decision-event-emit.js → buildPhaseTransitionEvent (function)
  src/components/vision/constants.js → LIFECYCLE_PHASE_LABELS (const)
  server/vision-routes.js → attachVisionRoutes (function)

Consumes:
  from S01: server/lifecycle-guard.js → phaseToStatus, TERMINAL
  from S02: lib/completion-gate.js → completionGate
  from S02: server/lifecycle-phase-history.js → appendPhaseHistory, normaliseOrigin

## Verification Table

Phase 5. Every row below was re-opened with `sed -n '<n>p'` on 2026-09-05 for **this revision**; rows
carried over from the first draft were re-checked, not assumed.

### Compose references

| Reference | Claim | Verified |
|---|---|---|
| `server/lifecycle-guard.js:56` | `export const TERMINAL = new Set(['complete','killed'])` | OK |
| `server/lifecycle-guard.js:65-89` | `buildPhaseGraph` body | OK |
| `server/lifecycle-guard.js:79` | `graph[completable].push('complete')` | OK |
| `server/lifecycle-guard.js:82-86` | the `killed` loop this blueprint mirrors | OK |
| `server/lifecycle-guard.js:100-113` | `edgePredicates` binds only the `edgeEvidence` edges | OK |
| `server/lifecycle-guard.js:121-130` | `resourceId` | OK |
| `server/lifecycle-guard.js:143-147` | `phaseToStatus` | OK |
| `server/lifecycle-guard.js:183-187` | `gitCommitExists` | OK |
| `server/lifecycle-guard.js:184` | the `spawnSync` the async runner replaces | OK |
| `server/lifecycle-guard.js:199-224` | `verifyCompletionEvidence` | OK |
| `server/lifecycle-guard.js:211` | the test-command `spawnSync` (BP-13) | OK |
| `server/lifecycle-guard.js:219-221` | explicit `tests_pass` required with no test command | OK |
| `server/lifecycle-guard.js:230` | `_client` is `{register, transition}` only | OK |
| `server/lifecycle-guard.js:236` | `_registered` is a `Set` | OK |
| `server/lifecycle-guard.js:238` | `_testOnly_resetGuardCache` | OK |
| `server/lifecycle-guard.js:280-288` | `guardTestCommand` reads `guard.testCommand` | OK |
| `server/lifecycle-guard.js:299-323` | `ensureGuard` | OK |
| `server/lifecycle-guard.js:301` | cache short-circuit | OK |
| `server/lifecycle-guard.js:309` | `initial: currentPhase` | OK |
| `server/lifecycle-guard.js:333-382` | `guardedTransition` | OK |
| `server/lifecycle-guard.js:349-353` | the deliberate no-`idempotency_key` comment | OK |
| `server/lifecycle-guard.js:356-362` | `_client.transition` call site | OK |
| `server/lifecycle-guard.js:371-373` | `applied` return shape (gains verbatim `status`, R2B-6) | OK |
| `server/lifecycle-guard.js:375-381` | refused/replayed return shape | OK |
| `server/lifecycle-guard.js:376` | `replayed` maps to `applied:true`, indistinguishable (R2B-6) | OK |
| `server/lifecycle-guard.js:334-337` | `guardedTransition` calls `ensureGuard` first (R2B-2) | OK |
| `lib/lifecycle-modes.js:42` | `explore_design: ['prd','architecture','blueprint']` | OK |
| `lib/lifecycle-modes.js:45` | `blueprint: ['verification']` | OK |
| `lib/lifecycle-modes.js:51` | `ship: []` | OK |
| `lib/lifecycle-modes.js:54` | build `terminal` | OK |
| `lib/lifecycle-modes.js:67` | build `tracksFeatureJson: true` | OK |
| `lib/lifecycle-modes.js:86` | `diagnose: ['scope_check','fix']` | OK |
| `lib/lifecycle-modes.js:95` | fix `terminal` | OK |
| `lib/lifecycle-modes.js:96` | `genesis: 'reproduce'` | OK |
| `lib/lifecycle-modes.js:99` | fix `edgeEvidence: {}` | OK |
| `lib/lifecycle-modes.js:102` | fix `artifactRoot: 'docs/bugs'` | OK |
| `lib/lifecycle-modes.js:104` | fix `tracksFeatureJson: false` | OK |
| `lib/lifecycle-modes.js:124` | plan `terminal` | OK |
| `lib/lifecycle-modes.js:133` | plan `tracksFeatureJson: false` | OK |
| `lib/lifecycle-modes.js:159-163` | judgment transitions | OK |
| `lib/lifecycle-modes.js:166` | judgment `terminal` | OK |
| `lib/lifecycle-modes.js:173` | judgment `artifactRoot` | OK |
| `lib/lifecycle-modes.js:175` | judgment `tracksFeatureJson: false` | OK |
| `lib/lifecycle-modes.js:201` | `genesisOf` export | OK |
| `lib/lifecycle-modes.js:209` | `transitionsOf` | OK |
| `lib/lifecycle-modes.js:217` | `terminalOf` | OK |
| `server/lifecycle-phase-history.js:23-44` | `appendPhaseHistory` | OK |
| `server/lifecycle-phase-history.js:28-31` | arrival-order closure, zero-length ties | OK |
| `server/lifecycle-phase-history.js:32-43` | dual-shape push | OK |
| `server/lifecycle-phase-history.js:34-35` | `phase`/`step` both set to `to` | OK |
| `lib/completion-gate.js:89-98` | `guardEnabled` reads the served root | OK |
| `lib/completion-gate.js:156` | lazy `guardHistory` import | OK |
| `lib/completion-gate.js:180` | `return {state:null}` for not-found | OK |
| `lib/completion-gate.js:220-235` | `completionGate` signature; `intent` at `:232` | OK |
| `lib/completion-gate.js:246` | evidence before the lock | OK |
| `lib/completion-gate.js:278-280` | `evidence-only` early return | OK |
| `lib/completion-gate.js:282-284` | resourceId + dir lock | OK |
| `lib/completion-gate.js:290-304` | preflight | OK |
| `lib/completion-gate.js:294` | the "feature not found" refusal BP-11 hits | OK |
| `lib/completion-gate.js:307` | `readIntent` | OK |
| `lib/completion-gate.js:310`, `:312-314` | guard state; unreachable refusal | OK |
| `lib/completion-gate.js:353-362` | write-ahead intent | OK |
| `lib/completion-gate.js:412-499` | the write sequence | OK |
| `lib/completion-gate.js:419-439` | 6.1 completion record | OK |
| `lib/completion-gate.js:441-465` | 6.2 status write | OK |
| `lib/completion-gate.js:467-472` | 6.3 ROADMAP | OK |
| `lib/completion-gate.js:474-483` | 6.4 vision projection | OK |
| `lib/completion-gate.js:486-499` | 6.5 audit, guarded by `statusChanged` | OK |
| `lib/completion-gate.js:501` | `clearIntent` last | OK |
| `lib/dir-lock.js:55` | `LOCK_STALE_MS = 20000` (R2B-12) | OK |
| `lib/dir-lock.js:59` | `LOCK_HEARTBEAT_MS = 1000` (R2B-12) | OK |
| `lib/dir-lock.js:100-105` | the heartbeat interval that touches the lock dir (R2B-12) | OK |
| `lib/dir-lock.js:123` | staleness compared against `LOCK_STALE_MS` (R2B-12) | OK |
| `lib/feature-writer.js:414-422` | `safeAppendEvent` swallows (BP-5) | OK |
| `lib/feature-writer.js:417` | `provider.appendEvent`, the non-swallowing primitive | OK |
| `lib/feature-writer.js:610-641` | `validateRepoPath`; `:614-616` absolute rejected; `:621`/`:633` realpath | OK |
| `server/vision-routes.js:98-99` | `guardAuth` | OK |
| `server/vision-routes.js:318` | `const genesis = 'explore_design'` | OK |
| `server/vision-routes.js:330` | genesis history write | OK |
| `server/vision-routes.js:398`, `:400`, `:441`, `:482` | 404 + `TERMINAL` refusals | OK |
| `server/vision-routes.js:521-633` | `/lifecycle/complete` | OK |
| `server/vision-routes.js:527-530` | the completable check backfill must not reuse | OK |
| `server/vision-routes.js:564-567` | in-process `visionProjector` | OK |
| `server/vision-routes.js:569-576` | 422 refusal shape | OK |
| `server/vision-routes.js:577-581` | route-side phase mutation | OK |
| `server/vision-routes.js:615` | the live unmanaged `item.status = 'complete'` write (R2B-9) | OK |
| `server/vision-routes.js:618-626` | the five side effects | OK |
| `server/vision-store.js:131-143` | `_save()` returns a boolean | OK |
| `server/vision-store.js:229` | `lastSaveOk` set by `updateItem` (R2B-9) | OK |
| `server/vision-store.js:235-253` | `updateLifecycle` never touches `item.status` (R2B-9) | OK |
| `server/vision-store.js:251` | `lastSaveOk` set by `updateLifecycle` | OK |
| `server/completion-projection.js:152-155` | accepts only `complete` | OK |
| `server/decision-events-snapshot.js:48-57` | drops origin/recordedAt | OK |
| `server/decision-event-emit.js:53-71` | builder; metadata object at `:65-68` | OK |
| `server/session-routes.js:156-159` | reconciler mutation application | OK |
| `server/session-routes.js:248` | session lifecycle projection | OK |
| `lib/checkpoint/reconciler.js:97` | `historyEmpty && currentPhase` | OK |
| `lib/checkpoint/reconciler.js:104-110` | the `resumed` descriptor; `:108` current time | OK |
| `lib/canon-guard.js:46-52` | `stripFirmlink` | OK |
| `lib/canon-guard.js:65-88` | `realpathCanonicalize`; `:67-71` the no-resolve-first rule | OK |
| `lib/stratum-engine.js:134` | `COMPOSE_STRATUM_TS_CLI_BIN` | OK |
| `lib/stratum-engine.js:218-221` | env candidate wins **only if it exists** (`:221`, BP-15/R26) | OK |
| `server/stratum-client.js:194-213` | `spawnStratumStdin`; options are `{timeout}` only | OK |
| `server/stratum-client.js:222-245` | `runGuard` | OK |
| `server/stratum-client.js:232-239` | non-zero exit parses stdout as the canonical error dict | OK |
| `server/stratum-client.js:332-342` | `guardRegister` | OK |
| `server/stratum-client.js:367-376` | `guardOverride` still sends `override_token` (dead) | OK |
| `server/stratum-client.js:235` | non-zero exit returns the canonical envelope unchanged (R4-2) | OK |
| `server/stratum-client.js:230`, `:237` | only spawn/parse failures are wrapped as `{error:{code,message}}` (R4-2) | OK |
| `server/lifecycle-guard.js:368-370` | wrapper normalises `res.error || res.status === 'error'` (R4-2) | OK |
| `server/stratum-client.js:349-359` | `guardTransition`, the raw recovery transport (R2B-2) | OK |
| `server/stratum-client.js:382-384` | `guardHistory` | OK |
| `server/lifecycle-guard.js:22` | `guardTransition as _guardTransition` import (R3-1) | OK |
| `server/stratum-client.js:349` | `guardTransition` destructures **camelCase** only (R3-1) | OK |
| `server/completion-projection.js:93-94` | `verifiedCompleteProjection` signature; `consultGuard = true` default (R3-7) | OK |
| `server/completion-projection.js:136` | `if (!consultGuard \|\| !guardEnabled(cwd))` — the live-config read R3-7 overrides | OK |
| `server/completion-projection.js:180-184` | `applyVerifiedProjection` forwards `consultGuard` (R3-7) | OK |
| `server/vision-routes.js:564` | the projector closure hardcodes `consultGuard: true` (R3-7) | OK |
| `lib/completion-gate.js:425` | `recordCompletion` reads `notes` (R3-4 — the unrestored input; the call opens at `:421`) | OK |
| `lib/completion-gate.js:477-480` | the `visionProjector` payload, which gains `guarded` (R3-7) | OK |
| `lib/completion-gate.js:528-536` | `defaultVisionProjector`, the other consumer of that payload | OK |
| `test/stratum-client-guard.test.js:80-103` | the `guardTransition` wire-shape case R3-1 extends | OK |
| `server/compose-mcp-tools.js:71-75` | `_overrideOk` | OK |
| `server/compose-mcp-tools.js:102-116` | `assertTerminalStatusAuthorized` | OK |
| `server/compose-mcp-tools.js:702-717` | `_postLifecycle` (BP-10) | OK |
| `server/compose-mcp-tools.js:779-786` | `toolCompleteFeature`, the pattern to follow | OK |
| `server/compose-mcp.js:180` | `record_completion` dispatch | OK |
| `server/mcp-tool-defs.js:620-638` | `record_completion` def | OK |
| `contracts/comp-obs-contract.schema.json:5` | `"version": "0.2.6"` | OK |
| `contracts/comp-obs-contract.schema.json:8-17` | `_changelog` | OK |
| `contracts/comp-obs-contract.schema.json:267-268` | closed `phase_transition` metadata | OK |
| `src/components/vision/constants.js:50-63` | `LIFECYCLE_PHASE_LABELS` | OK |
| `src/components/vision/ItemDetailPanel.jsx:574` | `?? lc.currentPhase` fallback | OK |
| `src/components/vision/ItemDetailPanel.jsx:586-597` | history strip; outcome span `:592-594` | OK |
| `src/components/vision/ContextPipelineDots.jsx:23-37` | `getStepStatus` | OK |
| `src/components/vision/ContextPipelineDots.jsx:116-118` | `StepDetail` | OK |
| `test/completion-gate.test.js:38-60` | real-git `makeWorkspace` fixture | OK |
| `test/lifecycle-modes-golden.test.js:25-35` | build adjacency pins (BP-17) | OK |
| `test/judgment-writer.test.js:449-467` | surplus-edge list, five entries (BP-17) | OK |
| `bin/compose.js:1221-1226` | `roadmap` subcommand block pattern | OK |
| `bin/compose.js:1234` | `resolveCwdWithWorkspace(args)` | OK |

### Stratum references

| Reference | Claim | Verified |
|---|---|---|
| `ts/src/cli/guard.ts:42-46` | `errorEnvelope` → top-level `{status:'error', error_type, message}` (R4-2) | OK |
| `ts/src/cli/guard.ts:104-106` | `expected_policy_checksum` forwarded only when supplied and non-null (R4-1) | OK |
| `ts/package.json:3` | version **`0.4.4`** (0.4.2 at first draft, 0.4.3 at round 2) | OK |
| `ts/package.json:19-21` | `files: ["dist"]` | OK |
| `ts/src/cli/guard.ts:21` | ACTIONS includes `apply-upgrade`, `policy` and `digest` | OK |
| `ts/src/cli/guard.ts:109-113` | `override` takes `authorization` (was `:107`; drifted when `expected_policy_checksum` landed in the `transition` case) | OK |
| `ts/src/cli/guard.ts:131-132` | `apply-upgrade` accepts exactly two keys (was `:128-129`) | OK |
| `ts/src/cli/guard.ts:186-187` | `policy` accepts exactly `resource_id` (was `:183-184`, which is now the `history` case) | OK |
| `ts/src/cli/guard.ts:235-237` | unknown action prints usage and exits 1 (BP-14 smoke run; was `:231-234`) | OK |
| `ts/src/cli/guard.ts:207-227` | the `digest` action (was `:204-224`) | OK |
| `ts/src/cli/guard.ts:209` | `digest` accepts exactly the six keys compose sends (was `:206`) | OK |
| `ts/src/cli/guard.ts:211-213` | `policy_checksum` must be 64 lowercase hex (was `:208-210`) | OK |
| `ts/src/cli/guard.ts:214-226` | response `{status:'ok', payload_digest, payload_digest_version:2}` (was `:211-223`) | OK |
| `ts/src/guard/transition.ts:122-130` | `_payloadDigest` binds the policy checksum (was `:131`, which is the closing brace) | OK |
| `ts/src/guard/transition.ts:352-354` | `initial` must be a graph node or terminal (was `:349`) | OK |
| `ts/src/guard/transition.ts:396-458` | `registerGuard`; a fresh registration may carry any terminal set (was `:393-455`) | OK |
| `ts/src/guard/transition.ts:438-440` | `GuardAlreadyRegistered` "use migrate" (was `:435-437`) | OK |
| `ts/src/guard/transition.ts:462-487` | `_maybeReplay`; returns null when no prior entry carries the key (`:467-469`; was `:459-483`) | OK |
| `ts/src/guard/transition.ts:470-471` | digest mismatch throws `IdempotencyConflict` (was `:467-468`) | OK |
| `ts/src/guard/transition.ts:571` | payload digest call site, hashing `registry.checksum` (was `:559`) | OK |
| `ts/src/guard/transition.ts:572-573` | replay checked **before** the `from_state` check (was `:560-562`) | OK |
| `ts/src/guard/transition.ts:1087-1150` | `guardApplyUpgrade` (was `:1070-1133`) | OK |
| `ts/src/guard/transition.ts:1136-1137` | ledger rationale names descriptor, principal, digest (was `:1117-1119`) | OK |
| `ts/src/guard/transition.ts:479-487` | a replay returns the HISTORICAL verdict + CURRENT state (R2B-6; was `:474-483`) | OK |
| `ts/src/guard/transition.ts:1152-1166` | `guardHistory` returns resource_id, current_state, graph_version and the full ledger (was `:1135-1149`) | OK |
| `ts/src/cli/guard.ts:98` | `transition` `assertOnlyKeys` includes `expected_policy_checksum` (0.4.4) | OK |
| `ts/src/cli/guard.ts:104-105` | the CLI maps it to `expectedPolicyChecksum` | OK |
| `ts/src/guard/transition.ts:552-553` | `expectedPolicyChecksum` must be 64 lowercase hex, else `TypeError` | OK |
| `ts/src/guard/transition.ts:566-570` | `PolicyChecksumMismatch` thrown under the FIRST lock, **before** `_maybeReplay` at `:572` (R3-2) | OK |
| `ts/src/guard/transition.ts:633-637` | the same check again under the commit lock, still before `_maybeReplay` at `:638` (R3-2) | OK |
| `ts/src/guard/transition.ts:638-664` | with no expected checksum and no replay, the transition is evaluated and applied under the CURRENT policy — `appendLedger` at `:660`, `current_state = toState` at `:662` (R3-2) | OK |
| `ts/src/guard/errors.ts:80` | `PolicyChecksumMismatch` → `error_type: 'policy_checksum_mismatch'` | OK |
| `ts/src/guard/transition.ts:653` | `kind: 'transition'` (R3-6) | OK |
| `ts/src/guard/transition.ts:765` | `kind: 'deviation'` — what `guard override` writes; **no `override` kind exists** (R3-6) | OK |
| `ts/src/guard/transition.ts:838` | `kind: 'graph_version'` for `guard migrate`; **no `migrate` kind exists** (R3-6) | OK |
| `ts/src/guard/transition.ts:835-836` | migrate writes `from_state == to_state == current_state` (R3-6) | OK |
| `ts/src/guard/transition.ts:1050` | `kind: 'graph_version'` for `apply-upgrade` (R3-6) | OK |
| `ts/src/guard/transition.ts:1047-1048` | apply-upgrade writes `from_state == to_state == current_state` (R3-6) | OK |
| `ts/src/guard/transition.ts:1130` | `kind: 'graph_version'` for the signed-descriptor path (R3-6) | OK |
| `ts/src/guard/transition.ts:754-756` | `guard override` requires `from_state == current_state` (R3-6, Flow A step 7) | OK |
| `ts/src/guard/transition.ts:757-759` | `guard override` requires a **declared edge** — a terminal self-override is impossible (R3-6) | OK |
| `ts/src/guard/transition.ts:299-394` | `_validatePolicy` — no prohibition on outgoing edges from a terminal state, so Flow A's migrate adding `complete_backfilled → killed` is legal | OK |
| `stratum/ts/node_modules/@openai/codex-sdk/package.json:24-29` | `exports` publishes an `import` condition only — both `require.resolve` legs fail (R3-8) | OK |
| `stratum/ts/node_modules/@modelcontextprotocol/sdk/package.json:62-66` | the `"./*"` wildcard makes `./package.json` resolve to `dist/cjs/package.json` (R3-8) | OK |
| `ts/src/guard/store.ts:38-53` | `LedgerEntryFields`; `idempotency_key` at `:45` | OK |
| `ts/src/guard/store.ts:58` | `GUARDS_DIR = join(homedir(),'.stratum','guards')` | OK |
| `ts/src/guard/fingerprint.ts:13-18` | the four checksum fields | OK |
| `ts/src/guard/fingerprint.ts:14` | adjacency arrays copied, NOT sorted | OK |
| `ts/src/guard/fingerprint.ts:16` | `terminal` IS sorted | OK |
| `ts/src/guard/descriptors.ts:35` | namespace `stratum-guard-descriptors` | OK |
| `ts/src/guard/descriptors.ts:41` | `to_policy` has exactly four keys | OK |
| `ts/src/guard/descriptors.ts:147` | descriptor path must be absolute | OK |
| `ts/src/guard/descriptors.ts:160` | the `0o022` group/other-write mask (BP-15/R17) | OK |
| `ts/src/guard/descriptors.ts:187-192` | every load failure collapses to `unavailable` | OK |
| `ts/src/guard/descriptors.ts:200-202` | group/world-writable refused | OK |
| `ts/src/guard/trust.ts:23` | trust root resolved from the module URL | OK |
| `ts/src/guard/trust.ts:39-41` | `setGuardTrustRootForTests` gated on `NODE_ENV=test` | OK |
| `ts/scripts/prepare-dist.mjs:29-37` | rewrites `../../contracts/` to `../contracts/` | OK |
| `ts/scripts/prepare-dist.mjs:39-43` | copies contracts into `dist/contracts` | OK |
| `ts/src/cli/stratum.ts:6` | eager `yaml` import | OK |
| `ts/tests/helpers/sshsig-sign.ts` | signer recipe reproduced in §7.2 | |
| `ts/tests/guard/compose-wire.test.ts` | signed-descriptor apply + `policy` envelope over the CLI | |

### Measured facts

| Fact | Measurement |
|---|---|
| Installed stratum | `node_modules/@smartmemory/stratum` is a **symlink** to `/Users/ruze/reg/my/forge/stratum/ts` (C13) |
| `apply-upgrade` in the installed dist | present (`dist/cli/guard.js`) |
| `guard digest` in the installed dist | **present** — `dist/cli/guard.js` carries the action and `payload_digest_version`. Stratum moved 0.4.2 → 0.4.3 between this blueprint's first draft and this revision |
| stratum package's own `node_modules` | present at `stratum/ts/node_modules`, holding all nine declared dependencies as entries (pnpm symlink farm into `node_modules/.pnpm/`), so BP-14's whole-directory symlink is the branch that fires |
| BP-14 step 4, run end to end (R3-8) | `package.json` + `dist` copied to a temp dir, `node_modules` symlinked to `stratum/ts/node_modules`, `node <copy>/dist/cli/stratum.js guard` → exit **1**, stderr `Unknown guard action: (none). Expected one of: apply-upgrade, authorize, descriptors, digest, history, migrate, override, policy, register, transition, upgrade.`, no `MODULE_NOT_FOUND` |
| `require.resolve('@openai/codex-sdk')` from `stratum/ts` | **fails both legs** — `ERR_PACKAGE_PATH_NOT_EXPORTED` for `'@openai/codex-sdk/package.json'` and for the bare specifier (node v22.22.3) |
| `require.resolve('@modelcontextprotocol/sdk/package.json')` | resolves to `dist/cjs/package.json`, **not** the package root — a plausible-looking wrong answer, which is why BP-14 verifies the resolved manifest's `name` |
| Trust root signer lines | **0** — 1892 bytes, all comment |
| `.compose/compose.json` | `capabilities.guard: true`, **no** `guard.testCommand` (C20) |

### Boundary Map validator

Run: `node -e "import('./lib/boundary-map.js').then(async m => { const fs = await import('node:fs'); const p = 'docs/features/COMP-LIFECYCLE-BACKFILL/blueprint.md'; console.log(JSON.stringify(m.validateBoundaryMap({ blueprintText: fs.readFileSync(p,'utf8'), blueprintPath: p, repoRoot: process.cwd() }), null, 2)); })"`

**Result (re-run for round 3, 2026-09-05):** `{ "ok": true, "violations": [], "warnings": [] }` — zero
violations, zero warnings. The map is **unchanged** by the round-3 fixes: they add parameters
(`expectedPolicyChecksum` on `guardTransition`, `guardEnabledOverride` on
`verifiedCompleteProjection`/`applyVerifiedProjection`, `guarded` on the projector payload) and a
schema definition, none of which is a new exported symbol or a new cross-slice edge. Round 2 was the
revision that gained one, `guardTransition` on `server/stratum-client.js`, because R2B-2 makes the raw
transport a real dependency of S02.

Two authoring traps are recorded so the next blueprint avoids them: `parseFilePlan` matches the
heading by exact string (`lib/boundary-map.js:33`, `:228`), so a numbered `## 8. File Plan` is
invisible to it; and any indented line between the last Consumes entry and the next `##` heading is
parsed as a malformed Consumes entry, so the map's explanatory prose belongs above the first `### S##`
heading.

### Reference sweep (BP-18, re-run for round 3)

**No blanket claim.** All **198** `file:line` rows in the two tables above were re-opened with
`sed -n` and each printed line was compared against its claim; the `OK` column records that
comparison, not an assumption.

| Outcome | Count |
|---|---|
| Rows in the two tables | 198 |
| Rows added this revision (round 3) | 29 |
| Rows **corrected** this revision — stratum line drift, 0.4.3 → 0.4.4 | 21 |
| Rows carried over unchanged | 148 |
| Rows whose target file was missing, or whose line was empty | 0 |

**The twenty-one round-3 corrections are all one cause.** `STRAT-GUARD-EXPECTED-CHECKSUM` landed in
stratum between round 2 and round 3, adding `expected_policy_checksum` to `guard transition` in both
`ts/src/cli/guard.ts` and `ts/src/guard/transition.ts`. Every citation below the insertion point moved:
the CLI's `override`, `apply-upgrade`, `policy`, `digest` and unknown-action cases (+2 to +3 lines
each), and in `transition.ts` `registerGuard`, `GuardAlreadyRegistered`, `_maybeReplay`, the
`IdempotencyConflict` throw, the payload-digest call site, the replay-ordering claim, `guardApplyUpgrade`,
its rationale, and `guardHistory` (+3 to +17). Four more were wrong independently of the bump:
`transition.ts:131` pointed at a closing brace rather than `_payloadDigest`'s body (`:122-130`), `:349`
at a throw rather than the `initial`-node check (`:352-354`), and two prose citations repeated the same
two errors. Both prose and table are corrected; five prose citations were fixed in this pass, which is
R2B-13's lesson applied again.

This is the third consecutive revision in which stratum line numbers drifted under a blueprint nobody
in the session had edited. **Treat every `stratum/ts` citation as perishable and re-open it per
revision** — the table exists because the alternative is a blueprint that reads as verified and points
at the wrong lines.

The nine round-1 corrections were seven stratum line drifts caused by `STRAT-GUARD-DIGEST` landing in
`ts/src/cli/guard.ts` between drafts (`package.json:3` 0.4.2 to 0.4.3; `guard.ts:20` to `:21`, `:90`
to `:107`, `:111-113` to `:128-129`, `:166-186` to `:183-184`, `:194-196` to `:231-234`;
`prepare-dist.mjs:39-45` to `:39-43`) plus two compose drifts (`lifecycle-modes.js:137` to `:133`,
`ContextPipelineDots.jsx:23-38` to `:23-37`). **R2B-13** found that two of those nine had been fixed
in the tables but left stale in the prose; both are now fixed in prose as well, and the sweep script
reads the tables only, so prose citations are checked by hand — the twelve new rows this revision were
added precisely so the claims that matter most live in the swept set.

That drift is the standing argument against a blanket claim: rows verified as correct in the morning
were wrong by the afternoon, in a sibling repo nobody in this session edited.

### Boundary Map validator (re-run after round 4, 2026-09-06)

`{"ok":true,"violations":[],"warnings":[]}` — S01 gains the three error-shape helpers (R4-2); no other Boundary Map change.

### Boundary Map validator

Run: `node -e "import('./lib/boundary-map.js').then(async m => { const fs = await import('node:fs'); const p = 'docs/features/COMP-LIFECYCLE-BACKFILL/blueprint.md'; console.log(JSON.stringify(m.validateBoundaryMap({ blueprintText: fs.readFileSync(p,'utf8'), blueprintPath: p, repoRoot: process.cwd() }), null, 2)); })"`

**Result:** `{ "ok": true, "violations": [], "warnings": [] }` — zero violations, zero warnings.

Two authoring traps are recorded so the next blueprint avoids them: `parseFilePlan` matches the
heading by exact string (`lib/boundary-map.js:33`, `:228`), so a numbered `## 8. File Plan` is
invisible to it; and any indented line between the last Consumes entry and the next `##` heading is
parsed as a malformed Consumes entry, so the map's explanatory prose belongs above the first `### S##`
heading.

### Reference sweep (BP-18)

**No blanket claim.** All **155** `file:line` rows in the two tables above were re-opened
programmatically for this revision and each printed line was compared against its claim; the `OK`
column records that comparison, not an assumption. Findings:

| Outcome | Count |
|---|---|
| Rows re-opened and matching | 155 |
| Rows corrected this revision | 9 |
| Rows whose target file was missing | 0 |

**The nine corrections.** Seven are line drift in stratum, caused by `STRAT-GUARD-DIGEST` landing in
`ts/src/cli/guard.ts` between this blueprint's first draft and this revision — the file grew a
`digest` case and every action below it moved:

| Was | Now | What moved |
|---|---|---|
| `ts/package.json:3` "0.4.2" | same line, **"0.4.3"** | the version itself changed |
| `ts/src/cli/guard.ts:20` | `:21` | ACTIONS gained `digest` |
| `ts/src/cli/guard.ts:90` | `:107` | `override` |
| `ts/src/cli/guard.ts:111-113` | `:128-129` | `apply-upgrade` |
| `ts/src/cli/guard.ts:166-186` | `:183-184` | `policy` |
| `ts/src/cli/guard.ts:194-196` | `:231-234` | the unknown-action guard |
| `ts/scripts/prepare-dist.mjs:39-45` | `:39-43` | the file is 43 lines |
| `lib/lifecycle-modes.js:137` | `:133` | plan's `tracksFeatureJson` (`:137` is a closing brace) |
| `src/components/vision/ContextPipelineDots.jsx:23-38` | `:23-37` | `getStepStatus` ends at `:37` |

That drift is itself the argument against a blanket claim: two of these rows were verified as correct
eight hours earlier and were wrong by the time this revision ran.
