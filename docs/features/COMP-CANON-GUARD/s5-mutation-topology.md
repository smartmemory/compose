# COMP-CANON-GUARD S5 — record-mutation durability topology (Task 0 findings)

**Status:** DISCOVERY complete. Gates Task 3 (manifest stamping). No production code.
**Method:** Codex sol/high read-only trace of `lib/judgment-writer.js` (3363 lines) + `lib/judgment/store/records.js`, controller-verified at the load-bearing sites.
**Purpose:** enumerate every path that makes a judgment RECORD durable (a *stamp site*) and every regeneration/read path that must NEVER stamp, so Task 3 keeps `.attest.json` consistent without (a) false "drift" verdicts on legit ops or (b) laundering raw edits.

A "record" = any file under `docs/judgment/records/**` (INCLUDING `ledger.jsonl` and `intents/*.json`), EXCLUDING `.attest.json`. Projections (`docs/judgment/{LEDGER,OBJECTIVE,REGISTER,SITUATION,index}.md`, `people/*.md`, `positions/*.md`) are NOT records — they are covered by the projection-roundtrip tier, not the manifest.

---

## Key finding: there IS a single write chokepoint (but compensation bypasses it)

Every forward record write flows through one module-private primitive:

- **`atomicWrite(path, content)`** — `records.js:32-40` — temp-write (`${path}.tmp.${pid}`) + `renameSync`. All `RecordsStore` write methods (`persistIntent`, `writeJoint`, `_appendChainRecord`, `_replaceChainRecord`, `writeGoalState`, `writePersonAggregate`, `writeSituationAggregate`, ledger rewrite) call it. Atomic *visibility* only — no `fsync`.
- Intent deletion flows through **`RecordsStore.clearIntent(id)`** — `records.js:398-404` — plain idempotent `unlinkSync`.

**But two paths bypass the store primitive** and are the reason a naive "stamp inside `atomicWrite`" is NOT exhaustive:

1. **`UndoLog.restore`** (`judgment-writer.js:167-203`) — compensation. Restores an overwritten record's captured bytes through the writer's OWN temp-write/rename (not `store.atomicWrite`), and removes a newly-created record with a direct `unlinkSync`. Runs on any failure inside `commitWithProjections`, `persistAggregate`, or intent publication.
2. Publication-point deletes are also writer-level around the store (`appendIntentAttestation` then `clearIntent`; `dropIntentDurably`).

So the exhaustive boundary is NOT the store primitive alone — it is **the three mutation orchestrators that own the lock + compensation window.**

---

## STAMP_SITES (records that become durable)

All of the below run under the judgment lock (see LOCK) inside one of three orchestrators. Grouped by orchestrator; `file:line` is the write's origin.

### A. `commitWithProjections` window (`judgment-writer.js:207-220`) — mutation callback + compensation
- **Chain appends/replacements** via `_appendChainRecord` / `_replaceChainRecord` (`records.js:75-220`):
  - goal cut → `goal/v<N>.json` (`writer:2558`); goal correct → `goal/v<version>.json` overwrite (`writer:2597`)
  - position create/update/supersede/tombstone → `positions/<slug>/r<N>.json` (`writer:2800,2845`)
  - position amend → `positions/<slug>/r<N>.json` (`writer:2914`)
- **Joint add/import** → `joints/<slug>.json` (`writer:2964`, `records.js:294`)
- **Ledger append (+ prediction side effects)** → rewrites `ledger.jsonl`; may create/overwrite `predictions/<id>.json` (`writer:3276`, `records.js:320-361`). Separate per-file atomic renames inside ONE compensation window — not a single multi-file rename.
- **`UndoLog.restore`** restore/delete of any of the above on failure (`writer:167-203`).

### B. `persistAggregate` window (`writer:1591-1636` etc.) — aggregate overwrites
- **Person aggregate** `create/add_fact/correct/open_field/edge/load_link` → `people/<slug>.json` (`writer:1253…1897`, `records.js:239`)
- **Situation aggregate** `create/add_fact/correct/owed/load_link` → `situation/<slug>.json` (`writer:1939…2121`, `records.js:265`)
- **Goal state** `joint_link/load_link` create/retire → `goal/state.json` (`writer:2522,2650,2694`, `records.js:223`)

### C. `publishIntentWith` window (`writer:820-921`) — pending intents + publication payloads
- **Pending-intent create** (transient, but durable between ops): transition → `intents/<id>.json` (`writer:3141`); goal-migration → `intents/<id>.json` (`writer:2763`); via `persistIntent` (`records.js:378`).
- **Transition publication/replay** (`applyTransitionIntent`→`applyPayload`, `writer:240-403`): overwrite `joints/<slug>.json`, append `ledger.jsonl` events, create `predictions/<id>.json`. Idempotent (replay reuses it).
- **Goal-migration publication/replay** (`applyGoalMigrationIntent`, `writer:660-759`): may create `goal/v1.json`, append `positions/objective/r<N>.json`, create/overwrite `goal/state.json`, append migration note to `ledger.jsonl`.
- **Successful publication cleanup**: append `attest` event to `ledger.jsonl`, then **delete** `intents/<id>.json` (`writer:771-796, 853-875`; `clearIntent`).
- **Refused publication** (`dropIntentDurably`, `writer:265-285`): append dedup `note` to `ledger.jsonl`, then delete `intents/<id>.json`.

### D. Reached from BOTH writes and reads
- **`replayIntentsLocked`** (`writer:898-921`) feeds pending intents through the publication/refusal paths above. It runs at the head of every `runOp` AND at the head of `getJudgmentState` (`writer:3308`). **Therefore a nominal read (`getJudgmentState`) legitimately mutates records when pending intents exist** — and MUST stamp. (See correction to Task 3 below.)

---

## NO_STAMP_SITES (must NEVER stamp)

1. **`regenerateProjections`** (`judgment-gen.js:54-76, 615-668`) — reads records, renders in-memory, atomically writes ONLY projection files (`{REGISTER,LEDGER,OBJECTIVE,SITUATION,index}.md`, `people/*.md`, `positions/*.md`) and deletes stale Markdown from those two projection dirs. No path under `records/**`.
2. **`generateFromRecords` / `checkProjectionRoundtrip`** (`judgment-gen.js:610-690`) — in-memory build + compare; no writes.
3. **`getJudgmentState`'s own `regenerateProjections` + aggregation** (`writer:3303-3359`) — projection/read-only. (Its *preceding* `replayIntentsLocked` is the mutation, not this.)
4. **Already-complete goal migration** short-circuit (`writer:2717-2738`, comment "No new record.") — republishes projections only.
5. **Non-record filesystem writes**: lock owner token `.compose/data/judgment.lock/owner` (`writer:91-105`); post-commit audit append `.compose/data/feature-events.jsonl` (`feature-events.js:29-61`). Neither is under `docs/judgment/records/`.
6. **`.attest.json` itself** — the manifest must never stamp itself (infinite recursion / self-bless).

---

## LOCK (R6)

- Primitive: **`acquireJudgmentLock(cwd)`** — `judgment-writer.js:72-130`. Directory lock `.compose/data/judgment.lock` via atomic `mkdirSync`; random owner token; 1s heartbeat on mtime; 20s stale threshold; 30s acquire timeout @ 25ms retries. Returns a release closure that verifies the owner token before recursive-removing the dir (prevents an old owner deleting a replacement).
- Held via `try/finally` in `runOp` (`writer:948-955`), standalone replay (`writer:929-935`), and `getJudgmentState` (`writer:3308-3362`).
- **`acquireJudgmentLock` is currently module-private.** S5's `verifyJudgmentCanon` (Task 2, R6) cannot import it as-is. It must be **exported** (or a `withJudgmentLock(cwd, fn)` wrapper exported) from `judgment-writer.js`. This is a required small refactor, not in the plan's Task 2 interface — fold it in.

---

## Recommended stamping strategy (supersedes Task 3's "stamp at 18 sites")

The plan's Task 3 says "add `stampRecord` at each `STAMP_SITES` entry." Task 0 shows a cleaner, exhaustive-by-construction shape:

**Orchestrator-level, touched-set, final-state sync.** In each of the three orchestrators (`commitWithProjections`, `persistAggregate`, `publishIntentWith`), collect the set of record paths the op may touch (the mutation callback's targets + the `UndoLog`'s captured paths — the UndoLog already tracks exactly these). In the orchestrator's `finally` (under the lock, AFTER commit-or-compensate), for each touched path: **exists on disk → `stampRecord`; gone → `removeRecord`.**

Why this over per-write or store-level stamping:
- **Compensation is covered for free** — the manifest is synced to whatever the FINAL on-disk state is, so `UndoLog.restore` (which bypasses the store primitive) needs no special handling.
- **No laundering** — only this op's touched paths are (re)stamped; an unrelated record tampered mid-session is untouched and still flagged. (Whole-tree regen is what the plan rightly bans.)
- **Deletions handled** — intent publish/refuse and undo-delete all resolve to `removeRecord` via the same final-state check.
- **~3 edit sites, not 18** — one per orchestrator, plus the export of the lock.

## Required refinements to Tasks 1–3 (fold these into the briefs)

1. **Task 1 must add `removeRecord(cwd, relPath)`** — drops one key from the manifest (read-merge-write, mirror of `stampRecord`). Deletions are real and legitimate; without this, a published intent leaves a stale manifest entry → false "removed" drift. Not in the plan's Task 1 interface.
2. **Task 2 must export/consume a lock accessor** — `acquireJudgmentLock` (or a `withJudgmentLock` wrapper) has to be exported from `judgment-writer.js` for R6. Add that export as part of Task 2 (or a tiny pre-step).
3. **Task 3's `getJudgmentState` test is WRONG as written.** The plan asserts "`getJudgmentState` does NOT change `.attest.json`." That holds ONLY with no pending intents. Correct it to two cases: (a) **no pending intents → `getJudgmentState` leaves `.attest.json` byte-identical**; (b) **with a pending intent → `getJudgmentState` publishes it and legitimately updates the manifest, and `verifyJudgmentCanon` is GREEN afterward** (no false drift). Asserting flat "never mutates" would make a correct implementation fail.
4. **`intents/*.json` are canonical records** (durable between ops) and belong in `recordFileSet` — do NOT blanket-exclude them. Only `.attest.json` is excluded.

## Open edge (accept as S5 residual, note for S6)
- The touched-set sync happens in the orchestrator `finally`. A hard crash BETWEEN the record rename and the manifest write leaves the manifest one op stale → a false "drift" on next verify, self-healing on the next successful op touching that record. This is a careless-drift-detector false-positive-under-crash, not a security hole; acceptable for v1, the S6 chain narrows it.
