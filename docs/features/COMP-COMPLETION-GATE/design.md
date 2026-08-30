# COMP-COMPLETION-GATE — one door for "this feature is done"

**Status:** IN_PROGRESS — slices 1, 2 and 3 SHIPPED (see §2.9, §2.9a, §2.9b); design revision 6 (post Codex review round 5) — **STOPPING CRITERION FIRED, see below**
**Date:** 2026-08-18
**Mode:** build

> **DECISION — 2026-08-18.** Presented the scope call to the user after round 3; they chose **keep
> going on the full gate**, accepting this as a multi-session job.
>
> **REVISION 5 — post round 4.** Round 4 held three of revision 4's fixes (field plumbing,
> terminal-status legality, tri-state direction) and broke four. Revision 5 resolves them:
>
> | round-4 finding | resolution |
> |---|---|
> | P0 derived identity can't identify the *applied* transition (commit A → crash → retry B) | §2.4a — **write-ahead intent record**; derivation scheme superseded |
> | P0 gate would complete *before* health can downgrade the build | §2.3c — health verdict is a **precondition** |
> | P0 cross-repo builds verify the wrong repo's HEAD | §2.6 — **two roots**, `workspaceRoot` + `evidenceRoot` |
> | P0 fix/plan modes have no `feature.json` → would be bricked | §2.3d — **v1 is build-mode only**, stated in shipped docs |
> | P1 5s no-heartbeat lock vs 10s+ stratum call | §2.4b — hardened `dir-lock`, long work outside the lock |
> | P1 legacy features + pre-listen startup can't use the endpoint | §2.3b — **server-local primitive**, four transports, legacy rule |
> | P1 non-git builds can never attest tests | §2.5a rule 4 — tests run **before** the git branch |
>
> **REVISION 6 — post round 5. THE PRE-REGISTERED STOPPING CRITERION HAS FIRED.**
>
> Revision 5 wrote down, in advance: *"if round 5 again surfaces P0s on new ground, the honest read
> is that the remaining scope should be carved again rather than reviewed harder."* Round 5 returned
> 7 findings, 3 of them P0, all on ground no earlier round had touched — resume losing
> `evidenceRoot`, null-SHA operations being mutually indistinguishable, and AC-10's refusal bricking
> fix/plan whenever a server is running.
>
> Findings by round: **8 → 8 → 7 → 7 → 7.** Flat across five rounds. Two fixes held outright in
> round 5 (tests-before-git-branch, health precondition); the rest were partial.
>
> Revision 6 applies every round-5 fix (below). It is a better design than revision 5. But the
> evidence does not support a claim that round 6 would come back clean, and continuing to review
> is no longer the highest-value move.
>
> | round-5 finding | revision-6 resolution |
> |---|---|
> | P0 AC-10 unconditional → bricks fix/plan with a server up | AC-10 + route replacement conditioned on `modeOf(item)==='build'` |
> | P0 `evidenceRoot` lost across resume → wrong repo's HEAD | §2.6 — persist normalized root in accumulator v2; AC-21b resume test |
> | P0 null-SHA attempts indistinguishable in the ledger | §2.4a — `operation_id` uuid bound into guard **artifacts** so digests differ |
> | P1 clearing intent makes partial projections non-retriable | §2.4a — `projections_pending`; intent cleared only on convergence |
> | P1 projection primitive has no startup/error contract | §2.3b — startup never consults the guard; only `guard_not_found` is legacy, all else fails closed |
> | P1 startup completion isn't always canonical | §2.3b — third tier `document-derived`; AC-16b tests all three |
> | P1 `dir-lock` stale-reclaim ABA race | §2.4b — fix in `dir-lock`; AC-26b tests two contenders on one stale lock |
>
> **Recommendation to the user:** the recurring shape across five rounds is that *completion* in
> compose has far more contexts than the chokepoint framing implies — cross-repo builds, three
> lifecycle modes, health downgrades, resume, pre-listen startup, legacy unguarded features,
> unmanaged folders. That is a system-shaped problem, not a spec-quality problem, and each round
> finds a context rather than a mistake. The design is now strong enough to build **the narrowest
> slice** from; what it is not is a plan that will survive being built all at once.
>
> **GATE STATUS — 2026-08-18, after Codex review round 3 (budget spent).**
> Rounds 1→2→3 found 8 → 8 → 7 findings. Round 3 confirmed **five** revision-2 fixes landed
> (strong-regime cut and all three findings it carried, combined `resolved_by` grammar, migration
> creation-path exemption) and left **three P0s open on new ground**:
>
> 1. **Recovery crash window.** The guard goes terminal *before* the completion record is written,
>    but recovery keys off that record. A crash in between leaves no identity, and AC-25 refuses an
>    absent one — permanently wedged. Compounding: completion records don't persist
>    `idempotency_key` today (`lib/completion-writer.js:338,419`), and normal build /
>    `complete_feature` callers supply no stable key at all.
> 2. **Test attestation at terminalization.** §2.3 solved the commit SHA but not the test result.
>    The accumulator has no attestation field, and the no-changes branch discards its computed test
>    result (`lib/build.js:5087`). Once `_UNPARSED` stops meaning `true` (AC-18), builds cannot
>    attest tests unless `guard.testCommand` happens to be configured.
> 3. **No REST transport for `completeItem`.** AC-10 forbids the only existing REST status mutation,
>    and re-pointing `/lifecycle/complete` at the gate makes reuse recursive. The server-side
>    projection authority is named but not designed.
>
> Plus four P1s: gate signature drops `notes`/`force`/`built_via` (breaking the build-quick
> validator exemption); raw writes bypass KILLED/SUPERSEDED terminal-status policy; AC-16 disables
> the reconciler's legitimate vision repair and the startup scanner's dynamic status writes; and the
> gate loses `recordCompletion`'s per-feature lock, so concurrent completions can clobber.
>
> **Read on the trend:** the finding count is not falling, and each round's P0s land on *new*
> ground — locking, projection repair, REST authority, attestation provenance. The pattern is that
> compose has no single write authority anywhere, so every seam the gate closes exposes another
> unowned one. This is a signal about the size of the job, not about review quality. **Decision
> pending with the user before any further design or implementation.**

## Related Documents

- Upstream finding: `docs/features/COMP-LIFECYCLE-BACKFILL/design.md`
- The claim this feature falsifies: `docs/features/COMP-MCP-ENFORCE/report.md:8,52`
- Guard adapter: `server/lifecycle-guard.js`
- Stratum-side authorization model: `../../../../stratum/docs/features/STRAT-GUARD-AUTHZ/design.md`
  (sibling repo at `/Users/ruze/reg/my/forge/stratum`)

---

## 1. The problem

The lifecycle guard has never guarded a real feature. Measured on this workspace (independently
re-verified during review):

| metric | value |
|---|---|
| managed feature codes | 321 |
| guard resources registered for this workspace | 31 |
| guard IDs matching a managed feature code | **0** |
| features with status COMPLETE | 230 |

All 31 registered guard resources are test fixtures that leaked into live state (`BUG-1`,
`BUG-TEST-001`, `PROOF-1`, `TS-BUILD-FAILED`, `FOO-1`, `PLAN-A`). Real coverage is zero and always
has been.

### 1.1 Why registration never happens

Two independent reasons — the first was the original diagnosis, the second is the one that actually
matters:

1. `server/feature-scan.js:505` stamps `lifecycle.featureCode` via `store.updateLifecycle` during the
   startup scan without calling `ensureGuard`. Once that field is set, `lib/vision-writer.js:174`
   returns early, so `POST /api/vision/items/:id/lifecycle/start` (`server/vision-routes.js:287`) is
   never reached for a scanned feature.
2. **More fundamentally:** `guardedTransition` calls `ensureGuard` lazily on every use
   (`server/lifecycle-guard.js:334`), so `/lifecycle/start` is *not* the only registration route.
   Registration is not categorically impossible — it simply never happens, because the writers that
   actually complete features (the CLI and the build runner) never call a guarded transition at all.

The fix therefore is not "make the scanner register." It is "make every completion go through a
guarded transition."

### 1.2 Why the guard is unreachable outside the server

`ensureGuard` / `guardedTransition` are called from exactly two places in non-test code:
`server/vision-routes.js` (287, 356, 398, 439, 500 — HTTP, needs a live `:4001`) and
`lib/judgment-writer.js:262` (a separate mode).

The CLI (`bin/compose.js`) and the build runner (`lib/build.js`) run in-process with no server, and
they are the paths that actually write COMPLETE.

**Verified:** `server/lifecycle-guard.js` has no live-server dependency — its only transport is
`server/stratum-client.js`, which spawns the stratum CLI. It is safe to call from a CLI process.
This is what makes a lib-level chokepoint possible. (Caveat: it resolves cwd through the
process-global `getTargetRoot()` — see §2.6.)

### 1.3 Every path that can mint a COMPLETE feature

Two sweeps were run: mine (nine paths) and the review's (five more). The union is **fourteen**.

| # | path | file:line | writes | verdict |
|---|---|---|---|---|
| 1 | `record_completion` MCP tool | `server/compose-mcp-tools.js:523` → `lib/completion-writer.js:286` | feature.json + status | **route through** |
| 2 | `compose record-completion` CLI | `bin/compose.js:1823` → same writer | feature.json + status | **route through** |
| 3 | build runner terminal write | `lib/build.js:4322` (`persistFeatureRaw` COMPLETE) | feature.json | **route through** (sole gate — §2.3) |
| 4 | build runner vision write | `lib/build.js:4311` (`updateItemStatus complete`) | vision item | **route through** (same site as #3) |
| 5 | `setFeatureStatus` / MCP `set_feature_status` | `lib/feature-writer.js:406`, `server/compose-mcp-tools.js:326` | feature.json | **narrow** — refuse `COMPLETE` |
| 6 | `persistFeatureRaw` | `lib/tracker/local-provider.js:76` | feature.json, no policy | **cannot guard** (it is the write primitive) — narrow caller set |
| 7 | `PATCH /api/vision/items/:id` | `server/vision-routes.js:148` | vision item | **refuse** `status: complete` |
| 8 | stratum audit ingestion | `server/stratum-sync.js:234` | vision item | **refuse** — an audit trace is not completion evidence |
| 9 | `lib/xref-push.js:136` | `setFeatureStatus(siblingRoot, …)` | **sibling repo** feature.json | **refuse** COMPLETE cross-repo |
| 10 | `lib/feature-reconciler.js:246` | `setFeatureStatus(…, derived:true)` | feature.json | **refuse** when target is COMPLETE |
| 11 ✚ | `addRoadmapEntry` / `compose roadmap add --status COMPLETE` | `lib/feature-writer.js:192`, `bin/compose.js:1324` | **creates** a COMPLETE feature | **refuse** at creation |
| 12 ✚ | `proposeFollowup` | `lib/followup-writer.js:385` → `addRoadmapEntry` | creates feature | covered by #11 (caller-controlled status) |
| 13 ✚ | `roadmap migrate --overwrite` | `lib/migrate-roadmap.js:58` | copies COMPLETE from ROADMAP → feature.json | **explicit migration exemption** (§2.7) |
| 14 ✚ | `VisionWriter.updateItemStatus` (direct mode) | `lib/vision-writer.js:310` | vision item, bypasses the PATCH route | **refuse** `complete` |
| 15 ✚ | `GitHubProvider.setStatus` | `lib/tracker/github-provider.js:165` | remote tracker, own policy-free impl | **refuse** COMPLETE (parity with #5) |

Path 11 is the worst of the new findings: `compose roadmap add --status COMPLETE` mints an
already-complete feature in one command, with no evidence and no lifecycle at all.

Out of scope, documented only: `lib/new.js:238` (`updateItemStatus complete`) writes the *kickoff*
item, not a feature.

**Lesson recorded:** this is the fourth time in recent work that a "strict contract" was specified
before every runtime writing that contract had been enumerated. Two independent sweeps found nine
and fourteen. AC-19 exists to make exhaustiveness a testable property rather than a claim.

### 1.4 The evidence check is itself compromised

Worse than the bypass paths: the evidence the gate would rely on is partly machine-fabricated.

- `lib/test-bootstrap.js:550` — when the test-output parser cannot read a framework's output
  (`ava`, `tap`, unknown), it returns `_UNPARSED` and the ship gate **degrades to `tests_pass:
  true`**. The comment calls this a safety valve. It means "attested" can mean "unreadable".
- `lib/build.js:4847` — the non-git path hard-codes `tests_pass: true` and records a **null-SHA**
  completion, deliberately, so a repo-less workspace can still complete.
- `bin/compose.js:1788` — the CLI defaults `tests_pass: true`.

So gating on `tests_pass` without fixing its provenance would gate on a value the machine invents.
§2.5 addresses this; it is the single most important part of this design.

### 1.5 The false claim on record

`docs/features/COMP-MCP-ENFORCE/report.md:8,52` states "lifecycle is authoritative, no caller can
effect an unverified transition". False, and always was. AC-14 corrects it.

---

## 2. Design

**One completion chokepoint.** A single lib-level function that is the only way a feature reaches
COMPLETE. Every legitimate path calls it; every other path refuses.

### 2.1 Where the door lives

`lib/completion-gate.js` **(new)** — a lib module, not an HTTP route, because the CLI and build
runner have no server.

`lib/completion-writer.js` `recordCompletion` **(existing)** becomes a caller of the gate rather
than a peer of it (paths 1, 2). The build runner calls it at terminalization only (paths 3, 4). The
HTTP `/lifecycle/complete` route is re-pointed at the gate so there is one implementation, not two.

**Import cycle — must be designed around.** `completion-gate → lifecycle-guard → feature-writer →
completion-gate` is a real cycle: `server/lifecycle-guard.js:24` statically imports
`lib/feature-writer.js`, and `completion-writer.js:386` already lazy-imports `setFeatureStatus`
specifically to dodge this. The gate uses the same lazy-import discipline, and AC-20 pins it.

(The review also cited a "lib must not import server" layering rule. That rule is stated in
`lib/lifecycle-modes.js:17` as a property of *that* module, and is violated by seven existing lib
files. It is an aspiration, not an enforced invariant, so this feature does not relocate
`lifecycle-guard.js` — that would be scope creep. The cycle is the real constraint.)

### 2.2 The legal-edge problem — and why the obvious answer is a brick

`ensureGuard` seeds `initial` from the item's current phase. A scanner-created item sits at
`explore_design`, and `ship → complete` is not a legal edge from there. So the naive "ensure, then
ship→complete" refuses everything.

The obvious fix — walk the graph forward evaluating each edge's predicate — **refuses 91% of
features**, measured (and independently re-verified):

| artifact required by an edge | features that have it (of 321) |
|---|---|
| `design.md` (`explore_design→blueprint`) | 118 |
| `blueprint.md` (`blueprint→verification`) | 58 |
| `plan.md` (`plan→execute`) | 45 |
| **all three — would survive the full walk** | **30 (9%)** |

A gate that refuses 91% of legitimate completions is not a gate, it is an obstacle, and obstacles
get `--force`d. That is precisely the dynamic that produced zero coverage. Designing in a refusal
rate that guarantees its own bypass would repeat the mistake this feature exists to fix.

**Resolution — one regime, one edge. (Revision 3: the two-regime model is cut.)**

The gate always registers at `completablePhaseOf(mode)` (build: `ship`) and takes the **single**
`→ complete` edge. The evidence check runs and refuses on its own terms.

Revision 2 proposed a second, "strong" regime: if the guard already held a real mid-lifecycle state,
walk the shortest legal path to `complete` with every edge evaluated. **Review round 2 proved that
regime never materialises.** Headless builds — the normal case — advance phases through
`VisionWriter.updateItemPhase` (`lib/vision-writer.js:319,410`), which edits vision state directly
and never calls the guard. With no server there is no guarded phase advancement at all, so every
feature arrives at completion unregistered, forever. The strong regime was speculative machinery for
a case that does not occur, and it carried three of round 2's findings on its own (multi-edge
idempotency conflicts, the AC-3/AC-8 contradiction, and the false growth claim).

Cutting it makes the design smaller **and** more honest: the weak regime was always going to be the
only regime. → follow-up **COMP-GUARD-PHASE-ADVANCE**, gated on guarded phase advancement existing
at all; the multi-edge walk is worth designing only after that lands.

**Correction carried from review round 1:** an earlier draft said "291 late-register". That
conflated two populations. 291 is the *artifact-deficient* count; the *unregistered* count is
**321** — zero features are registered today, and under this design every feature late-registers on
its first completion.

**Stamping the ledger.** The honesty mechanism must live in the tamper-evident ledger, not in a
mutable compose file. A ledger entry has no artifact or metadata field — `LedgerEntryFields`
(`stratum/ts/src/guard/store.ts:38-51`) carries only `payload_digest` (a hash), and `rationale` is
written solely by the override/migrate/upgrade paths, never by a normal transition. **An earlier
draft's AC-4 was therefore unimplementable as written.**

What *is* available and does land in the ledger: **`resolved_by`** (`transition.ts:546`,
caller-settable via `stratum-client.js` `resolvedBy`). This is a repurposing of a field meant for
actor identity — honest but not ideal. → follow-up **STRAT-GUARD-TRANSITION-RATIONALE** for a
first-class field.

Because there is exactly one `resolved_by` per transition, the stamps must **compose into a single
value**, not compete for the field (round 2 finding 6: an unregistered non-git feature is both
late-registered and repo-exempt). The value is a sorted, `+`-joined tag list under one `agent:`
prefix:

| situation | `resolved_by` |
|---|---|
| ordinary late registration | `agent:late-registration` |
| late registration, no git repo | `agent:late-registration+no-repo-exemption` |

AC-4 and AC-23 assert against this combined grammar, not two exclusive literals.

**Honest ceiling — must appear in the shipped docs, not only here.** The gate attests *evidence
present at completion*: the commit resolves, tests were attested, and the completion is in a
tamper-evident ledger. It does **not** attest lifecycle history — it does not know whether a design
doc existed when the work was done, and it cannot. The `late-registration` stamp is what keeps the
ledger from implying otherwise.

We do **not** pre-register all 321 features: 321 empty ledgers would assert a history nobody
observed.

### 2.3 The build runner gates once, at terminalization

Today `executeShipStep` (`lib/build.js:5137`) calls `recordCompletion`, **catches any failure, and
still returns a successful ship outcome**. The terminal block (`:4303-4322`) then independently
writes vision and feature status.

Naively applying the gate to both sites would gate twice — and if the first gate applied, the second
would hit an already-terminal guard; if the first refused, the build would still march on to the
second. Neither case was defined.

**Decision: exactly one authoritative gate, at terminalization.** The ship step *collects evidence*
(commit sha, files changed, test result) and stops completing the feature best-effort. Removing that
swallowed best-effort completion is a behaviour change and is in scope. The terminal write's
top-level `filesChanged` must survive — the gate signature carries it (AC-1).

**Where the commit SHA comes from at terminalization.** Round 2 finding 4 is correct that the
durable build accumulator (`lib/build.js:1383`) carries files and test counts but no SHA,
attestation, or operation identity, and that the "already committed" branch (`:5087`) returns
neither SHA nor test result. **We do not thread an evidence envelope through build resume** — that
is a large change to the resume contract for a small gain. Instead:

- If the accumulator has no SHA at terminalization, the gate resolves **`HEAD` server-side at that
  moment** and uses it. For the already-committed / no-changes branch, `HEAD` *is* the evidence —
  the commit the build produced or found is the one the feature completes against.
- If the workspace is not a git repo, the no-repo exemption applies instead (§2.5).

This keeps evidence resolution at the point of use, where it is verifiable, rather than carrying a
stale claim across a resume boundary.

### 2.5a Test attestation at terminalization (round 3, P0-2)

Round 3's third blocker: §2.3 solved the commit SHA but not the test result. The accumulator carries
`test_count`/`pass_rate` only when the output parsed (`lib/build.js:1383`, `:5182`), the no-changes
branch discards its computed test result entirely (`:5087`), and once `_UNPARSED` stops meaning
`true` (AC-18), a build cannot attest tests at all unless `guard.testCommand` happens to be set.

**Resolution — resolve attestation fresh where possible, persist a tri-state where not:**

1. **If `guard.testCommand` is configured**, the gate runs it at terminalization and that exit code
   is authoritative. `verifyCompletionEvidence` already does exactly this
   (`server/lifecycle-guard.js:209-218`). Nothing is carried, nothing can go stale. This is the
   recommended configuration and the failure message says so.
2. **Otherwise** the build must carry an explicit attestation, so the accumulator gains a
   `tests_attested` **tri-state** — `'passed' | 'failed' | 'no-signal'` — replacing the implicit
   boolean. `'no-signal'` is what `_UNPARSED` becomes: it is **not** an attestation, and the gate
   refuses on it, naming the framework and pointing at `guard.testCommand`.
3. **The no-changes branch must return its test result** rather than discarding it
   (`lib/build.js:5087`) — it currently computes one and drops it on the floor.

4. **Tests must run before the git branch (round 4, P1-7).** The non-git branch returns at
   `lib/build.js:4840`, while test execution only starts at `:4882` — so a non-git build never has a
   test result to attest. Combined with rule 2, *every* supported non-git build would produce
   `no-signal` and be refused: the commit exemption (§2.5) is not a test exemption, and treating it
   as one would recreate the "unreadable means passing" bug in a new place. **Decision:** move test
   execution ahead of the git-availability branch so both paths attest identically. The no-repo
   exemption stays scoped to the commit, which is the only thing genuinely unavailable without a
   repo.

This is a versioned accumulator schema change: `BUILD_ACCUMULATOR_VERSION` 1 → 2, adding
`tests_attested` to `BUILD_ACCUMULATOR_FIELDS` (`lib/build.js:1382-1394`). In-flight v1 builds
resuming across the upgrade have no `tests_attested` field; they are read as `'no-signal'` — refused
rather than assumed passing. That is the correct direction for an unknown, and it is the same
principle as AC-18: **absence of signal is never attestation.**

### 2.3c The gate runs AFTER the health verdict (round 4, P0-2)

Round 4 caught an ordering defect that would have shipped: the terminalization block writes vision,
feature status, and active-build state at `lib/build.js:4303`, but **health scoring runs afterward
and can downgrade the build to `failed`** (`lib/build.js:4432`).

Placing the gate at the current terminalization point would make the guard ledger and the feature
permanently COMPLETE *before* health rejects the build — and the ledger is append-only, so the
downgrade could not undo it. The first thing the guard would ever durably attest is a build the
system itself then judged failed.

**Decision:** the health verdict is a **precondition** of the gate, not a successor. The gate moves
after every terminal downgrade path. A completed flow whose health falls below threshold writes
nothing: no completion record, no COMPLETE status, no vision completion, no guard transition
(AC-8b).

### 2.3d v1 is scoped to build mode, and says so (round 4, P0-4)

Round 4 found that `fix` and `plan` modes do not track `feature.json` at all
(`lib/lifecycle-modes.js:83,117` — `tracksFeatureJson: false`), yet the *shared* terminal block
still completes their vision items (`lib/build.js:4309`). The self-verifying endpoint (§2.3b)
requires a COMPLETE `feature.json` as its canonical truth — which those modes never have. Once AC-16
forbids general vision completion, fix and plan modes would have **no legal completion path at
all**: the gate would brick two working workflows.

Designing per-mode canonical truth and per-mode endpoint predicates is a substantial piece of work,
and it is not what the coverage finding was about (all 321 affected items are build-mode features).

**Decision: v1 gates build mode only.** `fix` and `plan` modes keep their current completion path
unchanged, and AC-16's refusal is **conditioned on mode** so it cannot brick them. This is stated in
the shipped docs rather than left implicit, because "the guard covers completions" would otherwise
be the same kind of overclaim this feature exists to correct. → follow-up
**COMP-COMPLETION-GATE-MODES**.

### 2.3a The post-guard projection transaction (the authorized replacement)

Round 2's two hardest findings were not "the refusals are wrong" — they were "you refused the old
write paths without designing what replaces them":

- AC-10 blocks the REST `PATCH` and AC-16 blocks direct-mode `updateItemStatus`. Those are exactly
  the two branches `VisionWriter` uses (`lib/vision-writer.js:205` REST, `:310` direct), and the
  build runner's vision write (`lib/build.js:4311`) goes through them. Refusing both without a
  replacement leaves no way to mark a vision item complete at all.
- Decision 8 has the gate write status through `persistFeatureRaw`, but that primitive only touches
  `feature.json` (`lib/tracker/local-provider.js:74`). ROADMAP regeneration, event emission, and
  vision projection all live in `setFeatureStatus` (`lib/feature-writer.js:453`) — which AC-9 now
  forbids for COMPLETE. And once the gate has flipped status, `recordCompletion` sees an
  already-COMPLETE feature and skips its own flip (`lib/completion-writer.js:373`). ROADMAP and
  vision would silently go stale on every completion.

**Resolution: after the guard applies, the gate owns the entire write sequence.** It is the single
authorized COMPLETE writer, and it performs every projection `setFeatureStatus` would have:

| # | step | primitive | on failure |
|---|---|---|---|
| 1 | completion record | `persistFeatureRaw` (completions array) | abort; nothing else written |
| 2 | status → COMPLETE | `persistFeatureRaw` (status) | abort; record present, status not — recoverable |
| 3 | ROADMAP regen | shared roadmap writer | continue, collect; report `partial:true` |
| 4 | vision projection | **gate-owned seam** (below) | continue, collect; report `partial:true` |
| 5 | events / broadcast | existing emitters | continue, collect; never fails a completion |

Steps 1–2 are the durable truth. Steps 3–5 are projections: they are re-drivable, and a failure in
any of them returns `{ok:true, partial:true, failures:[…]}` rather than pretending success. Silent
best-effort is what produced the drift this feature exists to fix, so partial results are reported,
not swallowed.

**The vision projection seam.** The gate needs one entry point that covers *both* transports, since
it runs under the server (REST available, and direct file writes would race the server's in-memory
store) and under the CLI/build runner (direct only). `VisionWriter.updateItemStatus` already
branches on exactly this (`lib/vision-writer.js:403`).

### 2.3b The projection endpoint is self-verifying, not privileged (round 3, P0-3)

Round 3's blocking objection: `completeItem` must work over REST, but AC-10 forbids the only
existing REST status mutation (`PATCH`, `lib/vision-writer.js:205`), and re-pointing
`/lifecycle/complete` at the gate makes reusing *that* route recursive. No transport was specified.

**Resolution — a new endpoint that verifies rather than trusts:**

```
POST /api/vision/items/:id/completion-projection    { featureCode, commitSha, ledgerRef }
```

Before writing anything, the server **independently re-reads canonical state** and refuses unless:

1. `feature.json` for `featureCode` already has `status: COMPLETE` (written by §2.3a step 2, the
   durable truth), **and**
2. when the guard is enabled, the guard's `current_state` for that resource is `complete`
   (read via `guardHistory`), **and**
3. the item's `lifecycle.featureCode` matches `featureCode`.

This is the key property: **the endpoint carries no authority of its own.** It cannot be used to
complete anything — it only mirrors a completion that canonical state *already* records. There is no
token, no secret, no privileged caller, and nothing to forge. A caller who could satisfy its
preconditions could simply have read the same truth. That is why it does not reintroduce the bypass
AC-10 closes.

No recursion: `/lifecycle/complete` → gate → `/completion-projection` is strictly one-directional;
the projection endpoint never calls the gate.

`VisionWriter.completeItem(itemId, evidence)` **(new)** dispatches to this endpoint in REST mode and
to a direct write in direct mode (where no server is running, so no race exists). AC-10 and AC-16
refuse the *general* writers for `complete`; this narrow, self-verifying seam carries the legitimate
write.

**Repair tooling is a first-class user, not a carve-out.** The reconciler repairs vision from
canonical feature status (`lib/feature-reconciler.js:161,236`), and the startup scanner creates
items with dynamic status including `complete` (`server/feature-scan.js:491`). Both are *projections
of canonical truth* — exactly what this verifies.

**But the endpoint is the wrong shape for them (round 4, P1-6).** Startup seeding mutates the live
in-memory `VisionStore` *before the server is listening* (`server/index.js:217`), so REST is
impossible at that moment — and a direct file write would leave the live store stale. The reconciler
likewise uses a direct writer today (`lib/feature-reconciler.js:231`).

**Resolution: the verification lives in a server-local primitive, and the endpoint is one caller of
it.**

```
verifiedCompleteProjection(store, { itemId, featureCode, cwd })   // server-local, sync-capable
   ├── POST /api/vision/items/:id/completion-projection   (remote callers: the gate over REST)
   ├── startup scanner                                     (in-process, pre-listen)
   ├── feature-reconciler                                  (in-process repair)
   └── VisionWriter.completeItem direct mode               (no server running)
```

One implementation of the predicate, four transports. That is what makes AC-16's "only path" precise
rather than a slogan.

**The legacy rule, stated honestly (round 4, P1-6).** The predicate as first written required the
guard's `current_state` to be `complete` — but §3 deliberately leaves the 230 existing COMPLETE
features unguarded forever. Under that rule none of them could ever be repaired, contradicting
AC-16a. The predicate is therefore:

> feature.json reads COMPLETE **and** `lifecycle.featureCode` matches **and** *if a guard resource
> exists for this feature*, its `current_state` is `complete`.

A feature with **no** guard resource is legacy-unguarded: the projection mirrors feature.json and
nothing more, which is exactly as much as is actually known about it. What this must not do is
imply the guard vouched for it. Absence of a guard resource is recorded on the projection as
`verified_by: 'canonical-status-only'`, so a legacy repair is never mistaken for a guarded
completion.

**Only `guard_not_found` means legacy (round 5, P1).** Every other `guardHistory` outcome — timeout,
spawn failure, corrupt registry — must **fail closed**, not fall through to the legacy branch. An
unreachable guard that silently downgrades to "canonical status only" would be a bypass wearing the
legacy rule as a disguise, and it is the exact failure shape §2.8 already guards against elsewhere.

**Startup is synchronous; the predicate is not (round 5, P1).** `seedFeatures` and pre-listen
startup run synchronously (`server/feature-scan.js:476`, `server/index.js:217`), while `guardHistory`
is asynchronous subprocess work (`server/stratum-client.js:378`). "Sync-capable" was hand-waving.
**Decision:** startup seeding does **not** consult the guard. It projects on canonical feature.json
alone and stamps `verified_by: 'canonical-status-only'`, which is honest — at startup no completion
is being *authorized*, only mirrored. The guard-consulting branch applies to the gate and the
reconciler, both of which are already async. This avoids making server startup await a subprocess
per feature (321 of them).

**Startup completion is not always canonical (round 5, P1).** Contrary to the framing above, the
scanner can derive `complete` from document metadata or from the mere presence of `report.md`,
including folders with **no** `feature.json` at all (`server/feature-scan.js:172,294`). A predicate
demanding COMPLETE feature.json would reject states the cockpit shows today. **Decision:** preserve
document-derived completion for unmanaged folders, stamped `verified_by: 'document-derived'` — a
third, weakest tier, visibly distinct from both guarded and canonical-status projections. It is
display state for folders compose does not manage, and it must never be read as a completion the
system vouched for. AC-16b tests all three tiers.

### 2.4 Transactionality and recovery

An applied stratum transition appends the ledger and persists `current_state` immediately
(`transition.ts:522`). Everything compose writes afterwards can fail: `recordCompletion` can persist
the record and then fail the status flip (`completion-writer.js:358`), and vision projection is
best-effort by design (`feature-writer.js:477`).

So a crash between step 3 and step 4 leaves **the guard terminal and compose incomplete** — and a
retry then hits `stale_from_state`, permanently wedging the feature. There is no rollback: the
ledger is append-only by design.

**Protocol:**

1. **Preflight everything writable** before the guard transition — feature exists, provider
   reachable, ROADMAP parses, vision item resolvable. Fail before the irreversible step, not after.
   This is what keeps the §2.3a sequence from aborting past step 2 in practice.
2. **Recovery identity is compose-side, never a guard idempotency key.** This is a deliberate
   decision, not an omission. `guardedTransition` already refuses to send an `idempotency_key`
   (`server/lifecycle-guard.js:340-345`): a refuse → fix → retry is a *new* logical attempt that
   must re-evaluate evidence, but it carries an identical payload, so a key would make the guard
   replay the prior refusal. Round 2 finding 3 confirms the mechanism — refused transitions are
   ledgered with the key (`stratum/ts/src/guard/transition.ts:539`) and replay on retry. Keep the
   existing behaviour: **no guard-side key.**
3. The completion's operation identity lives in compose's own completion record
   (`idempotency_key`, already threaded through `recordCompletion`).
4. **Recovery is explicit:** guard already `complete` **and** a completion record with a matching
   identity → the gate treats the transition as satisfied and re-drives §2.3a steps 3–5 to
   convergence rather than refusing. A guard-complete / compose-incomplete state must be repairable
   by re-running the same command.
5. Guard already `complete` with a **mismatched or absent** identity → refuse. That is a second
   completion attempt, not a retry.

Because the walk is gone (§2.2), there is exactly one transition per completion, so no per-edge key
design is needed.

### 2.4a Recovery identity — write-ahead intent (round 4 supersedes round 3's derivation)

**Revision 5 replaces the derived-identity scheme below.** Round 4 found the hole: a derived id
identifies the *retry*, not the transition that actually reached the ledger.

> Commit A passes the guard → crash before the record is written → retry resolves commit B →
> no record exists for B, so the §2.4a table would authorise B as "crash recovery". B completes
> against a ledger entry that attested A.

The ledger cannot disambiguate this: `commit_sha` is bound into the transition's artifact digest
(`lifecycle-guard.js:340`, `transition.ts:118`) but history exposes only `payload_digest`, never the
original artifacts (`store.ts:37`). Round 4 also showed the null-SHA exception was internally
impossible — after the crash window there is no "existing record" for `--resume-completion` to
reuse.

**Resolution — a write-ahead completion intent.** Before the guard transition, the gate writes a
durable intent record inside the feature lock:

```jsonc
// .compose/data/completion-intents/<feature_code>.json  (new)
{ "operation_id": "uuid",              // the identity; also sent as a guard artifact
  "feature_code": "...", "commit_sha": "...", "tests_attested": "passed",
  "started_at": "...", "build_id": "...",
  "projections_pending": ["roadmap", "vision", "events"] }
```

Order becomes: **intent → guard transition → §2.3a writes → clear intent when projections converge.**

**`operation_id` is bound into the guard payload, not just the local file (round 5, P0).** Round 5
showed why matching on `commit_sha` alone is insufficient: a null SHA makes *every* no-repo attempt
match, so two distinct no-repo completions are indistinguishable. And the adapter currently sends no
artifact at all when there is no commit (`server/lifecycle-guard.js:339-340`), while stratum's digest
covers `from_state`, `to_state`, artifacts, modified files, and `resolved_by`
(`stratum/ts/src/guard/transition.ts:111`) — nothing that varies between two no-repo attempts.

**Decision:** the gate always sends `artifacts: { operation_id, ...(commit_sha && {commit_sha}) }`.
Because `operation_id` is a fresh uuid per completion attempt and artifacts feed the digest, distinct
attempts produce distinct `payload_digest`s even with no commit. The intent record stores the same
`operation_id`, so recovery compares a value that provably identifies *the applied transition*
rather than one that merely looks similar. This is a small adapter change (`guardedTransition` builds
the artifacts dict) and it is what makes §2.4a's table sound for the no-repo path.

| observed state | gate behaviour |
|---|---|
| no intent, guard not complete | normal path |
| intent present, guard complete, `operation_id` **matches** | **crash recovery** — re-drive §2.3a from `projections_pending`, then clear |
| intent present, guard complete, `operation_id` **differs** | **refuse** — the ledger attested a different operation; report both ids |
| intent present, guard **not** complete | stale intent (crash before transition) — clear and proceed normally |
| no intent, guard complete | refuse — an unrecoverable prior completion; requires explicit operator action |

This costs one small file write per completion and closes the window derivation could not. It also
retires AC-25a: the intent record *is* the durable identity, so no-repo completions recover on the
same rules and `--resume-completion` is unnecessary.

**Intent is cleared only when projections converge (round 5, P1).** An earlier draft cleared the
intent after the write sequence, which made a `partial:true` result non-retriable: the next attempt
would see "no intent + guard complete" and refuse — stranding exactly the case §2.3a promised was
re-drivable. The intent therefore carries `projections_pending`, is rewritten (not deleted) when
steps 3–5 partially fail, and is removed only when the list empties. A partial completion is
resolved by re-running the same command.

<details>
<summary>Superseded: revision 4's derived-identity scheme (retained for provenance)</summary>

#### 2.4a-old Recovery identity is DERIVED, not stored (round 3, P0-1)

Round 3's blocking objection: the guard goes terminal *before* the completion record is written, but
recovery keys off that record — so a crash in between leaves no identity, and "absent identity
refuses" wedges the feature permanently. Compounding it: completion records don't persist
`idempotency_key` today (`lib/completion-writer.js:338,419`), and normal build / `complete_feature`
callers supply no stable key at all.

The objection is correct **about a stored identity**. The resolution is that the identity must not
be stored at all — it is already **derivable**:

```
completion_id = `${feature_code}:${commit_sha}`        // lib/completion-writer.js:302
```

This is deterministic from the operation's own intent. Re-running the same completion (same feature,
same commit) recomputes the *same* id without reading anything. So identity is never "absent" — it
is recomputed from the inputs. That removes the crash window entirely, with no write-ahead log and
no new persistence:

| observed state | gate behaviour |
|---|---|
| guard not complete | normal path |
| guard complete, no record with this `completion_id` | **crash recovery** — re-drive §2.3a steps 1–5 |
| guard complete, record exists with this `completion_id` | converged — re-drive projections only (steps 3–5) |
| guard complete, record exists with a **different** `completion_id` | **refuse** — a second completion against a different commit |

Caller-supplied `idempotency_key` keeps its existing meaning (dedup at the writer's outer layer,
`maybeIdempotent`) and is **not** the recovery identity. AC-25 changes accordingly.

**The one gap, stated rather than hidden.** Null-SHA completions (the no-repo path) deliberately use
a non-deterministic id — `${feature_code}:nocommit:${Date.now()}-${seq}`
(`lib/completion-writer.js:303`) — precisely so a re-completion does not idempotent-no-op. Recovery
by derivation is therefore **impossible** for that path: a crash after the guard transition leaves a
no-repo completion unrecoverable automatically. Decision: no-repo completions crash-recover via an
explicit `--resume-completion` flag that reuses the existing record when the guard is already
complete, rather than by silently minting a second id. This is a narrow, named exception, and AC-25a
tests it.

</details>

### 2.4b Concurrency: a hardened lock, and no long work inside it (round 4, P1-5)

`recordCompletion` already holds a per-feature advisory lock across its whole read-modify-write
(`acquireFeatureLock`, `lib/completion-writer.js:311`), while `persistFeatureRaw` has none
(`lib/tracker/local-provider.js:74`). Moving the writes into the gate would drop that guarantee and
let concurrent completions clobber each other.

**Revision 4 proposed reusing `acquireFeatureLock` for the gate's whole sequence. Round 4 showed
that is unsafe for this operation.** That lock declares a holder stale after **5 seconds**
(`lib/completion-writer.js:59`), has no heartbeat, and on release blindly `rm -rf`s the lock
directory. But a single stratum mutation may take **10 seconds** (`server/stratum-client.js:24`),
and a configured `guard.testCommand` runs with **no timeout at all**
(`server/lifecycle-guard.js:209`, a synchronous `spawnSync`). A perfectly normal gate would exceed
the stale threshold, have its lock stolen, run concurrently with another completion, and then delete
the *replacement* owner's lock on the way out. A fast concurrency test would never catch it.

**Decision, two parts:**

1. **Use the hardened lock.** `lib/dir-lock.js` `acquireDirLock` already implements what this needs:
   an owner token, a heartbeat that refreshes while work is in progress, and a release that is a
   no-op unless the lock is *provably still ours* (`lib/dir-lock.js:84-100`). The gate uses it; the
   5-second advisory lock is not extended.
2. **Keep long work out of the lock.** The heartbeat cannot save a lock held across a synchronous
   `spawnSync` — a blocked event loop cannot fire a timer. So the **test command runs before the
   lock is taken**, and its result is carried into the locked section as the attestation value
   (§2.5a). The locked section holds only: intent write, guard transition, and the §2.3a writes.

`recordCompletion` does not re-acquire when called through the gate.

**Round 5's `dir-lock` ABA finding is a false positive — verified against source.** It reported an
"unconditional recursive removal" at `lib/dir-lock.js:123`. The code there does the opposite: stale
reclaim re-reads the owner token, re-stats the mtime, and removes **only if both still match** what
it saw when it judged the lock stale, with a comment explaining that exact ABA case. The release
side is likewise owner-token guarded, and the stale threshold is 20s (not 5s) with a heartbeat.
`dir-lock` needs no change. This is a reminder that review verdicts are high-recall, not
high-precision — the finding was checked rather than accepted, and AC-26b keeps only the
two-contender test as cheap insurance.

### 2.5 Fixing evidence at its source (§1.4)

Gating on a fabricated boolean gates on nothing.

- **`_UNPARSED` must stop meaning `true`.** `lib/test-bootstrap.js:550` changes to return an
  explicit "no signal" that the gate treats as **not attested**. This is a real behaviour change:
  projects on frameworks the parser can't read (`ava`, `tap`) will stop auto-attesting and must
  either configure `guard.testCommand` or pass an explicit attestation. That is the correct outcome
  — "unreadable" is not "passing" — but it is breaking, and the failure message must say exactly
  which framework was unreadable and what to configure.
- **The non-git path needs a named exemption, not a silent one.** `lib/build.js:4847` completes with
  a null SHA in a repo-less workspace. Requiring a commit unconditionally would break a supported
  workflow. The gate accepts a null-SHA completion **only** when the workspace is genuinely not a
  git repo (server-checked, not caller-claimed) and adds the `no-repo-exemption` tag under the §2.2
  combined `resolved_by` grammar so the ledger records the weaker basis.
- **The CLI default dies.** `bin/compose.js:1788` no longer defaults `tests_pass: true`. Missing
  attestation is an error naming the flag. **BREAKING.**

### 2.6 Workspace resolution is a confirmed defect, not a risk

`bin/compose.js:72` resolves `--workspace` to a root but never calls `switchProject`, while
`server/stratum-client.js:35,42` resolves the stratum engine, binary, and cwd through the
process-global `getTargetRoot()`. A gate invoked from the CLI with `--workspace` would therefore
register the guard against the wrong workspace root — and `resourceId` hashes that root
(`lifecycle-guard.js:121`), so it would silently create a *different* guard resource.

An explicit workspace root must be threaded through capability lookup, engine resolution, binary
resolution, evidence checks, and guard registration (AC-21). This is a requirement, not a
verification item.

**Two roots, not one (round 4, P0-3).** `runBuild` deliberately supports a project root and a
*different* agent working directory (`lib/build.js:2057`). Git operations, the test run, and the
commit SHA all happen in `agentCwd` (`lib/build.js:2847,5112`), while feature metadata is written in
the project `cwd`. `verifyCompletionEvidence` checks the commit in the single `cwd` it is handed
(`server/lifecycle-guard.js:199`).

Passing one root would therefore verify the **wrong repository's** HEAD on a cross-repo build —
silently, because a valid-looking SHA from the wrong repo either fails to resolve (confusing) or, in
the worst case, resolves to an unrelated commit. The gate takes two:

| parameter | derived from | used for |
|---|---|---|
| `workspaceRoot` | project root | provider, capability lookup, guard `resourceId`, feature.json writes |
| `evidenceRoot` | `agentCwd` | git commit verification, test command execution, HEAD resolution |

They are equal in the common single-repo case. AC-21a adds a cross-repo acceptance test, because a
defect here is invisible in the default configuration.

**`evidenceRoot` must survive resume (round 5, P0).** Passing the two roots at call time is not
enough: `runBuild` reconstructs `agentCwd` from the *current* invocation (`lib/build.js:2074`), and
neither the accumulator (`:1382`) nor active-build state (`:5229`) persists it, while the CLI only
forwards `workingDirectory` when `--cwd` is repeated (`bin/compose.js:2728`). So after a process
restart a cross-repo resume silently falls back to the project root and resolves the wrong `HEAD` —
the very defect the two-root split exists to prevent, reintroduced by the resume path.

**Decision:** persist the normalized `evidenceRoot` in the accumulator (part of the v2 schema bump
already required by §2.5a) and restore it on resume. AC-21b adds a cross-repo **resume** test, not
just a cross-repo fresh-build test.

### 2.7 Compatibility decisions

- **`recordCompletion(set_status: false)`** records evidence without completing
  (`completion-writer.js:369`). Gating it unconditionally would drive the guard to `complete`
  against the caller's explicit request. **Decision:** `set_status:false` runs the evidence check
  and records, but performs **no guard transition**. It is not a completion.
- **`tests_pass` remains a required boolean** in the writer (`completion-writer.js:182`). When a
  configured `guard.testCommand` attests, the gate returns a canonical attested value that the
  writer records, so the caller may omit the flag without the writer's contract changing.
- **`complete_feature` documents `commit_sha` as optional** (`server/compose-mcp.js:221`).
  Evidence-always semantics make it required except under the §2.5 no-repo exemption. This is a
  **tool-schema and documentation change**, in scope.
- **`roadmap migrate`** (`lib/migrate-roadmap.js:58`) legitimately copies historical COMPLETE rows
  into feature.json. Round 2 finding 7 corrects the boundary: `--overwrite` governs only *existing*
  files, while **missing** COMPLETE rows are created without it (`:68`). An exemption keyed on
  `--overwrite` would therefore leave the create-path bypass wide open. **Decision:** the exemption
  covers the migrate command as a whole (both branches), it is named and logged per write, and
  AC-17 includes a negative test for a *new* COMPLETE row created without `--overwrite`.

### 2.8 When the guard is disabled

- **Guard disabled** (`capabilities.guard !== true`) → the gate still runs the **evidence check**
  and skips registration/transition. Evidence verification is compose-local and needs no stratum. A
  bogus commit sha is refused either way. Result: `{ok, guarded:false}`.
- **Guard enabled but stratum unreachable** → **fail closed**, never degrade to the disabled path.
  Note a real defect here: a *returned* CLI spawn failure carries code `SPAWN`
  (`stratum-client.js:225`); only a *thrown* exception is normalised to `GUARD_UNREACHABLE`
  (`lifecycle-guard.js:314`). The gate must treat both as fail-closed (AC-6), not just the thrown
  one.

---

## 2.9 SLICE 1 — what is actually being built now

**User decision, 2026-08-18:** build the narrowest slice, prove it on a real feature, then widen.
The design above is the full target; this section is the contract for the first increment.

**Slice 1 principle: establish real coverage without taking ownership of the write path.** The gate
wraps the existing `recordCompletion` with evidence verification and a guarded transition, and
changes nothing about how writes happen. This is what makes it small: `setFeatureStatus` keeps doing
the ROADMAP regeneration and vision projection it already does correctly, so **none of §2.3a/§2.3b
is needed yet** — no projection transaction, no `completeItem`, no endpoint, no verification tiers.

| in slice 1 | why |
|---|---|
| `lib/completion-gate.js` — preflight → evidence → intent → guard transition → `recordCompletion` | the door itself |
| Gate wired at the **MCP tool and CLI entrypoints**, not inside `recordCompletion` | `executeShipStep` (`lib/build.js:5145`) is a third caller of `recordCompletion`; gating the writer itself would silently pull the build path — and all of slice 2's complexity — into slice 1 |
| Preflight source-status legality (AC-26a) | trivial, and prevents completing a KILLED feature |
| Write-ahead intent + recovery (§2.4a), `operation_id` in guard artifacts | correctness of the thing being built |
| Hardened `dir-lock` + `dir-lock` reclaim fix, test run outside the lock (§2.4b) | the gate is its highest-consequence caller |
| Route paths 1–2 (`record_completion` MCP + CLI) through the gate | the two paths a human actually completes with |
| CLI `tests_pass` default removed (AC-13) | `compose record-completion` currently attests tests the operator never ran — a human-facing lie on a path slice 1 gates |
| `addRoadmapEntry` refuses COMPLETE (AC-15) | closes `compose roadmap add --status COMPLETE`, the worst single hole |
| Guard-off = evidence-only; guard-unreachable = fail closed, both error shapes (AC-5, AC-6) | the gate must not silently degrade |

| deferred to slice 2+ | why it waits |
|---|---|
| Build-runner rewiring (paths 3–4, AC-8/8a/8b/8c) | drags in health ordering, `evidenceRoot` resume, accumulator v2 — the largest cluster |
| `_UNPARSED` → not-attested (AC-18) | **moved here from slice 1 during implementation.** `deriveTestsPass` (`lib/test-bootstrap.js:561`) has exactly one consumer — the build runner's ship gate. Changing it while the build path is ungated would break builds on unparseable frameworks (`ava`, `tap`) with no gate to justify it. It belongs with the path it feeds |
| Gate owning the projections (§2.3a) + `completeItem` + endpoint + tiers (§2.3b) | only needed once `setFeatureStatus` refuses COMPLETE |
| Refusals on paths 5, 7, 8, 14 (AC-9, 10, 11, 16) | each requires its authorized replacement to exist first |
| Migration exemption (AC-17), allowlist test (AC-19) | meaningful only once the refusals land |

**Honest statement of what slice 1 does and does not achieve.** After slice 1, completions made
through `record_completion` (MCP or CLI) are evidence-checked and ledgered — real guard coverage
where there is currently none, on the paths a person uses deliberately. **The other bypasses remain
open**, including the build runner, which is how most features actually complete. Slice 1 must not
be described as "completions are guarded"; that claim is what `COMP-MCP-ENFORCE/report.md` made
falsely, and repeating it one slice early would be the same error in a new place. AC-14's correction
is written against the slice-1 reality, and re-checked at each subsequent slice.

## 2.9a SLICE 2 — the build runner (SHIPPED)

**Slice 2 principle: exactly one completion, at terminalization, after the health verdict.** Slice 1
gated the deliberate completion. Slice 2 gates the one that actually produces COMPLETE features.

| in slice 2 | what changed |
|---|---|
| `deriveTestsAttested` (`lib/test-bootstrap.js`) — AC-18 | tri-state `passed`/`failed`/`no-signal`. `deriveTestsPass` is UNCHANGED and still feeds the ungated lane-triage gate; the two diverge exactly on the unreadable case |
| Accumulator **v1 → v2** (`tests_attested`, `evidence_root`) + read-time migration | a v1 record migrates to `no-signal`, which the gate refuses — a build resumed across the upgrade re-attests rather than inheriting a pass it never recorded |
| Tests hoisted **above** the `isGitRepo` branch in `executeShipStep` | the non-git branch used to return before the test run and hard-code `tests_pass: true`. "No repo" is a reason to skip the commit, never the tests |
| Ship stops completing: both branches call `context.recordCompletionEvidence(...)` | it used to `recordCompletion`, swallow any failure, and return success anyway. `completionWarning` is gone |
| Terminal block defers to `pendingCompletion` | it used to write COMPLETE immediately, before the health gate that can fail the build |
| The gated completion runs **after** the health gate | AC-8/8a/8b/8c. Resolves HEAD from `evidence_root`, refuses `no-signal`, calls `completionGate`, and only then completes the vision item |

**The `no-signal` refusal is scoped to `capabilities.guard: true`** — found by the full suite, not by
review. Three integration builds with no ship step went from completing to refusing, because the
refusal sat OUTSIDE the guarded regime the gate itself already respects (AC-5). Enforcing attestation
on an opted-out project breaks every one of them, including non-git workspaces where the evidence can
never pass — the same reversal already made once in slice 1. An opted-out project keeps
`deriveTestsPass`'s degrade contract: `no-signal` reads as true there, and only an OBSERVED failure
is recorded as one.

**Non-`tracksFeatureJson` modes (fix, plan) are untouched** — they keep their old completion path,
per COMP-COMPLETION-GATE-MODES.

**Honest statement of what slice 2 does and does not achieve.** After slice 2 the build runner is
gated: a health-rejected build writes nothing (no completion record, no COMPLETE status, no vision
completion, no guard transition), and an unattested test run refuses instead of claiming a pass.
**Paths 5, 7, 8 and 14 (`setFeatureStatus`, the vision PATCH, stratum-sync, direct
`updateItemStatus`) remain open.** Do not describe completions as guarded — that is exactly the
claim `COMP-MCP-ENFORCE/report.md` made falsely. AC-14's correction is still outstanding and lands
with slice 3.

**Coverage.** `test/build-completion-gate.test.js` drives the real `runBuild` through a real ship
step against a stub engine — the defect is in the ORDER of finalization, so no unit of it can show
the behaviour. All five cases fail against pre-slice-2 `lib/build.js`. Ship-level evidence hand-off
is in `test/build-ship-fields.test.js`, the accumulator migration in `test/dispatch-build.test.js`,
the tri-state in `test/parse-test-summary.test.js`.

**Coverage gap, stated:** the cross-repo test exercises the *mechanism* (`evidence_root` persisted at
ship, read back at terminalization, HEAD resolved from the work repo via the sidecar fallback) but
NOT a genuine cross-process resume through `decideBuildStart`'s resume branch. A fresh start rotates
the accumulator (`rotateStaleAccumulatorForFreshStart`), so seeded evidence cannot stand in for a
real resume; driving one needs a resume harness that is out of slice-2 scope.

## 2.9b SLICE 3 — the projections and the refusals (SHIPPED 2026-08-30)

**Slice 3 principle: the gate owns every write, and every other door is refused or made
self-verifying.** Slices 1–2 gated the two paths that actually complete features but left the writes
themselves in `setFeatureStatus` — one of the doors. Slice 3 moves the writes into the gate (§2.3a),
closes paths 5/7/8/14, and replaces the closed doors with the seam of §2.3b.

| in slice 3 | what changed |
|---|---|
| `completionGate` step 6 (`lib/completion-gate.js`) — AC-4a/4c | record → status (`persistFeatureRaw`) → ROADMAP regen → vision projection → events, in that order. Steps 1–2 abort and KEEP the intent (a retry recovers); steps 3–5 are collected into `{ok:true, partial:true, failures:[…]}` |
| `recordCompletion` — AC-7 | the completing path (`set_status ≠ false`) delegates to the gate and throws `COMPLETION_REFUSED` on refusal, writing nothing. `set_status:false` is the record-only path the gate calls back into. `STATUS_FLIP_AFTER_COMPLETION_RECORDED` is gone: a KILLED feature is refused in preflight with no record left behind |
| `setFeatureStatus` — AC-9 | refuses `COMPLETE` unconditionally (`COMPLETE_VIA_GATE_ONLY`), including `force` and `derived`. Closes path 5, path 10 (reconciler `derived`), `projectFeatureStatus(phase:'complete')`, and — for free — the local half of path 9 (`xref-push` already degrade-skips a thrown refusal) |
| `server/completion-projection.js` (new) — AC-4d/16b | ONE predicate, `verifiedCompleteProjection`: feature.json reads COMPLETE **and** the item is bound to the code **and** *if a guard resource exists* its state is complete. Tiers stamped on the item as `completion_projection.verified_by`: `guarded` / `canonical-status-only` / `document-derived`. Only `not_found` means legacy; every other guard outcome fails closed |
| Four transports of that predicate | `POST /api/vision/items/:id/completion-projection` (the gate over REST); `applyVerifiedProjection(store, …)` in-process (the `/lifecycle/complete` route, the reconciler); `VisionWriter.completeItem` direct mode; and startup seeding (`seedFeatures`, synchronous — no guard consulted, per round 5) |
| `VisionWriter.completeItem` (new) — AC-4b | REST → the endpoint; direct → the predicate. `updateItemStatus(…, 'complete')` refuses a **managed build item** in both transports (AC-16) |
| `PATCH /api/vision/items/:id` — AC-10 | 422 `COMPLETE_VIA_GATE_ONLY` for a managed build item |
| `POST /api/stratum/audit/:itemId` — AC-11 | stores the trace, no longer flips status |
| `/lifecycle/complete` (§2.1) | for `tracksFeatureJson` modes the route calls the gate with an in-process projector against the live store. Under the guard a request with no `commit_sha` is now refused (422) — the evidence-free cockpit completion was path 7's quieter twin |
| `roadmap migrate` — AC-17 | named, logged exemption on BOTH branches; negative test for a new COMPLETE row created without `--overwrite` |
| `test/completion-write-allowlist.test.js` — AC-19 | repo-wide scan of every COMPLETE/complete write + every `persistFeatureRaw` callsite; two-sided allowlist justified in-file |

**"Managed build item" is the refusal key, not "build mode".** `modeOf(item)` defaults to build,
and the `compose new` kickoff item is a build-mode lifecycle item with no `feature.json`
(`lib/new.js:238`). A refusal keyed on mode alone would brick `compose new` — contrary to §1.3's
"documented, not changed". The refusals (AC-10, AC-16) therefore apply to an item that is bound to
a feature code, in build mode, **and** whose code has a `feature.json` in the workspace
(`isManagedBuildItem`). Everything else — fix/plan items, UI items with no lifecycle, the kickoff
item — keeps its path. The same reasoning as the `document-derived` tier: what compose does not
manage, compose does not vouch for, and does not police.

**A fail-open found by the slice-3 tests, fixed in the gate.** `currentGuardState` read a guard
error as "not found" when its *message* contained "not found". A `SPAWN` failure whose message is
`stratum-mcp: command not found` therefore read as a legacy, unregistered feature — the exact
disguise §2.3b warns about. The message fallback now applies only when no error code was returned.

**Codex review, round 1 (gpt-5.6-sol/high): 7 findings, 5 fixed, 1 deferred, 1 partially taken.**

| # | finding | resolution |
|---|---|---|
| 1 P1 | a present-but-malformed `feature.json` read as *unmanaged* → PATCH / `updateItemStatus` let `complete` through | `isManagedBuildItem` is existence-based (`canonicalFile`); the predicate refuses an unparseable file in every tier — broken canon is not absent canon |
| 2 P1 | `VisionStore._save` swallows disk failures; the endpoint returned 200 for a projection that only reached memory | `updateItem` records `lastSaveOk`; `applyVerifiedProjection` rolls the live item back and returns `ok:false`; the endpoint 422s |
| 3 P1 | the writer-shaped `result` (what MCP/CLI/`recordCompletion` return) only surfaced the ROADMAP half of a partial | `result.partial`, `result.failures[]`, `status_flip_partial` true for any projection failure; the CLI warns |
| 4 P1 | a managed feature with a status-less or malformed `feature.json` plus `report.md` seeded as `document-derived` complete | only a folder with NO `feature.json` gets the document tier; canon wins otherwise (`featureJsonUnreadable` → planned) |
| 5 P2 | items already complete before tiers existed never get stamped (status equality skipped them) | upgrade branch in `seedFeatures` stamps an unstamped complete item |
| 6 P2 | `VisionWriter` decides REST vs direct on one probe; a missed probe against a live-but-slow server writes the file under the server's in-memory state | **DEFERRED — pre-existing**, shared by every dual-dispatch op (`updateItemStatus`, `updateItemPhase`, gates); not introduced here. Belongs to a transport-level fix (probe retry / server-side lease), filed under COMP-SESSION-COORD's family |
| 7 P2 | AC-19 does not see generic sinks (`writeFeature(`, PATCH pass-through) | both sinks added to the scan with justified entries; AC-19 remains allowlist-shaped by design |

**Codex review, round 2 (reviewed the round-1 fixes): 3 findings, all fixed.**

| # | finding | resolution |
|---|---|---|
| 1 High | adding `completion_projection` to the store's update allowlist made the tier stamp writable through the generic PATCH — a legacy item could be relabelled `guarded` with a fake ledger ref | PATCH refuses any body carrying `completion_projection` (`PROJECTION_STAMP_READONLY`); the stamp is server-owned, written only by the predicate's transports |
| 2 Med | an item stamped while canon was valid stayed complete after `feature.json` was corrupted or lost its status (the r1 #4 fix only covered new/unstamped items) | `seedFeatures` re-derives the tier on every scan for a complete item: downgrades and clears the stamp when canon no longer yields complete, re-stamps when the tier changed |
| 3 Med | `/lifecycle/complete` returned `partial:false` when the projection persisted but the subsequent `updateLifecycle` save failed | `updateLifecycle` records `lastSaveOk`; the route reports a `lifecycle-persist` failure as partial |

**Codex review, round 3 (reviewed the round-2 fixes): 1 medium, fixed by the controller (no round 4).**
A canonical downgrade to a recognized non-complete status (COMPLETE → IN_PROGRESS) left the old
stamp attached; `seedFeatures` now clears `completion_projection` whenever an item leaves `complete`.
PATCH rejection and lifecycle-persist reporting were confirmed clean.

**Honest statement of what slice 3 does and does not achieve.** After slice 3, a build-mode
feature with a `feature.json` reaches COMPLETE — in feature.json, ROADMAP, and the cockpit — only
through the gate, and every general writer that used to reach it refuses. The invariant is
allowlist-shaped (Decision 7): `persistFeatureRaw` and `writeFeature` stay public, so the guarantee
is "no write appears without an entry in the allowlist test", enforced by review plus AC-19, not by
the type system. Still open, by design: paths 9 (GitHub half) and 15 → COMP-COMPLETION-GATE-REMOTE;
fix/plan modes → COMP-COMPLETION-GATE-MODES; the 230 legacy COMPLETE features stay
`canonical-status-only` forever. The correct sentence is now: *build-mode completions of managed
features are evidence-checked, ledgered, and single-doored* — not "lifecycle-enforced".

## 3. Scope

### In scope

- `lib/completion-gate.js` (new); route paths 1–4 through it
- The post-guard projection transaction (§2.3a), the self-verifying projection endpoint (§2.3b), and
  the `VisionWriter.completeItem` seam
- Write-ahead intent recovery + hardened per-feature locking (§2.4a, §2.4b)
- Accumulator schema v2 with `tests_attested` tri-state (§2.5a)
- Refuse COMPLETE on paths 5, 7, 8, 10, 11, 12, 14; migration exemption for 13; document 6
- Fix evidence provenance (§2.5): `_UNPARSED`, non-git exemption, CLI default
- One gate at terminalization; ship step stops best-effort completing (§2.3)
- Recovery protocol (§2.4)
- Explicit workspace root threading (§2.6)
- Compatibility changes in §2.7, including the `complete_feature` schema
- Correct `COMP-MCP-ENFORCE/report.md`

### Out of scope (filed, not fixed)

- **31 leaked test guards** → **COMP-GUARD-FIXTURE-PURGE**. Live-state pollution from a suite that
  reached `:4001`; cleanup must not ride along with a behaviour change.
- **Scan-time registration** → **COMP-GUARD-SCAN-REGISTER**. A different fix, and §2.2 rejects the
  321 empty ledgers it would create.
- **Backfilling the 230 existing COMPLETE features.** They completed without a guard. Retroactive
  registration would manufacture history. They stay honestly unguarded.
- **First-class ledger rationale on transitions** → **STRAT-GUARD-TRANSITION-RATIONALE** (§2.2).
- **Fix and plan mode completions** → **COMP-COMPLETION-GATE-MODES** (§2.3d). Those modes do not
  track `feature.json`, so they have no canonical truth for the projection predicate to verify.
  Gating them needs per-mode canonical state, which is its own design. v1 leaves their completion
  path untouched rather than bricking two working workflows.
- **Guarded phase advancement + the multi-edge walk** → **COMP-GUARD-PHASE-ADVANCE**. Headless
  builds advance phases through `VisionWriter.updateItemPhase` with no guard involvement (§2.2), so
  the "strong regime" cannot exist until that is closed. Designing the walk first would be building
  machinery for a state that never occurs.
- **Remote / cross-repo completion refusals** (paths 9 `xref-push`, 15 `GitHubProvider.setStatus`)
  → **COMP-COMPLETION-GATE-REMOTE**. Real bypasses, but neither is how features actually complete,
  and both cross a repo or transport boundary that deserves its own design.
- `lib/new.js:238` — kickoff item, documented not changed.
- **Stratum's two load-only flakes** (`tests/parity/p6.test.ts`, `tests/mcp/agent-run.test.ts`) —
  pre-existing and unrelated, but they undermine the full-suite gate this feature will be held to.
  → **STRAT-FLAKE-ISOLATION**

---

## 4. Design decisions

1. **The gate is a lib function, not an HTTP route** — the CLI and build runner have no server, and
   they are the paths that actually complete features.
2. **`recordCompletion` calls the gate; it does not become the gate** — the HTTP route and build
   runner need the gate without the completion-record write.
3. **Late registration, not pre-registration** — 321 empty ledgers would assert unobserved history.
4. **One regime, one edge** — a full-walk rule would refuse 91% of features (§2.2) and be bypassed
   within a week; and the "strong regime" that would have justified the walk never occurs, because
   headless builds advance phases without the guard. `resolved_by` stamping is what keeps the single
   regime honest.
5. **Guard-off degrades to evidence-only; guard-unreachable fails closed** (both error shapes).
6. **Refuse rather than route through, for the bypass paths** — they have no evidence to offer.
7. **`persistFeatureRaw` stays unguarded** — it is the primitive the gate writes through. Its
   contract narrows to "callers must have passed the gate", enforced by review, not code. Stated as
   a known soft spot rather than hidden.
8. **One module owns the authorized raw write — no pseudo-secret marker.** An earlier draft proposed
   a "module-private symbol" to let the gate through `setFeatureStatus`'s new COMPLETE refusal. That
   is unsound: to import it, it must be exported, and any caller can import the same symbol. Instead
   `setFeatureStatus` refuses COMPLETE **unconditionally** (including `derived` and `force`), and the
   gate performs the COMPLETE write itself through `persistFeatureRaw` — the one place authorized to
   do so, reachable only after the guard has applied. No secret, no lookalike to test against.
9. **Exactly one gate per completion, at terminalization** (§2.3).
10. **Recovery over rollback** — the ledger is append-only, so a wedged completion must be
    re-drivable by identity, not undone (§2.4).
11. **The gate owns the projections, not just the status write** (§2.3a). Refusing the old write
    paths without an authorized replacement would have left ROADMAP and vision stale on every
    completion — trading a bypass for a drift bug.
12. **Recovery identity is compose-side; no guard idempotency key.** Preserves the existing
    deliberate behaviour at `lifecycle-guard.js:340-345`; a guard-side key would replay refusals
    instead of re-evaluating evidence (§2.4).
13. **Recovery identity is a write-ahead intent record** (§2.4a, revised in rev 5). Revision 4's
    derived id (`feature:sha`) identified the *retry*, not the transition that reached the ledger —
    so commit A applying, then a crash, then a retry on commit B would have been read as recovery.
    The intent record is written before the transition and carries an explicit `operation_id`.
14. **The projection endpoint verifies instead of being trusted** (§2.3b). It re-reads canonical
    state and refuses unless the completion is *already* recorded there, so it holds no authority
    to grant and nothing to forge — which is why it can be public and still not be a bypass. This
    is the same instinct as STRAT-GUARD-AUTHZ's "authorization is a signature, never an env value":
    do not invent a secret when the truth is independently checkable.
15. **Absence of signal is never attestation** (§2.5a). Unparseable test output, a missing
    accumulator field, and a resumed pre-upgrade build all resolve to "not attested" and refuse.
    The old `_UNPARSED → true` safety valve is exactly the failure this feature exists to end.

---

## 5. Acceptance criteria

- [ ] **AC-1** `lib/completion-gate.js` (new) exports `completionGate({featureCode, visionItemId, commitSha, testsAttested, filesChanged, notes, force, builtVia, idempotencyKey, workspaceRoot, mode, intent})` → `{ok, guarded, partial?, failures[], refusedAt?, reasons[], ledgerRef?, completionId, attestedTestsPass}`. `intent` is `'complete'` (default) or `'evidence-only'` (AC-22). **The gate now owns the completion record, so it must carry every field that record has today**: `notes` and `force` (CLI, `bin/compose.js:1812`), `built_via` (builds, `lib/build.js:5145`) — dropping `built_via` would break the build-quick validator exemption at `lib/feature-validator.js:575`. `visionItemId` is optional; when absent the gate resolves it via `findFeatureItem(featureCode)` and treats "no item" as a skipped projection, not a failure (paths 1–2 have no item id today)
- [ ] **AC-2** Evidence verified via the existing `verifyCompletionEvidence` — no reimplementation
- [ ] **AC-3** **One regime, one edge:** the gate always registers at `completablePhaseOf(mode)` and takes a single `→ complete` transition; a test asserts exactly one guard transition per completion. (The multi-edge walk is cut — see §2.2 and follow-up COMP-GUARD-PHASE-ADVANCE)
- [ ] **AC-4** Late registration stamped `resolved_by: 'agent:late-registration'`, combining with the no-repo tag per the §2.2 grammar (`agent:late-registration+no-repo-exemption`); a test asserts the value in the ledger entry (NOT an artifact field — none exists)
- [x] **AC-4a** §2.3a projection transaction: after the guard applies, the gate performs completion record → status → ROADMAP regen → vision projection → events, in that order; a test asserts ROADMAP and vision are **not** stale after a gated completion (the round-2 P0)
- [x] **AC-4b** `VisionWriter.completeItem(itemId, evidence)` (new) is the only path that writes `status: complete` to a vision item, in **both** modes: REST dispatches to `POST /api/vision/items/:id/completion-projection`, direct writes the file. The build runner uses it
- [x] **AC-4d** The verification lives in a **server-local primitive** `verifiedCompleteProjection(store, …)` (§2.3b) with four callers: the REST endpoint, the startup scanner (pre-listen, in-process), the reconciler, and `completeItem` direct mode. One predicate, four transports. It refuses unless feature.json reads COMPLETE, `lifecycle.featureCode` matches, and — **only if a guard resource exists** — its `current_state` is `complete`. Tests: refuses a non-complete feature (proving it grants no authority); succeeds for a legacy unguarded feature and stamps `verified_by: 'canonical-status-only'`; works during startup seeding before the server listens
- [x] **AC-4c** A failure in projection steps 3–5 returns `{ok:true, partial:true, failures:[…]}` — never a silent success
- [ ] **AC-5** Guard disabled → evidence check runs, guard steps skipped, `{ok, guarded:false}`
- [ ] **AC-6** Guard enabled + stratum unreachable → fail closed for **both** error shapes: thrown (`GUARD_UNREACHABLE`) and returned (`SPAWN`)
- [x] **AC-7** `recordCompletion` (paths 1, 2) calls the gate before any write; a refusal writes nothing
- [ ] **AC-8** Build runner gates **exactly once**, at terminalization; `executeShipStep` no longer completes best-effort; a test asserts a single guard transition per build and that top-level `filesChanged` survives
- [ ] **AC-8a** When the terminal accumulator carries no commit SHA, the gate resolves `HEAD` in `evidenceRoot` at terminalization; the already-committed / no-changes branch completes against `HEAD` (§2.3). No evidence envelope is threaded through resume
- [ ] **AC-8b** The gate runs **after** the health verdict and every terminal downgrade path (§2.3c). Test: a flow that completes but scores sub-threshold health writes **no** completion record, **no** COMPLETE status, **no** vision completion, and **no** guard transition
- [ ] **AC-8c** Test execution moves ahead of the git-availability branch (`lib/build.js:4840` vs `:4882`) so non-git builds attest tests identically; the no-repo exemption covers the **commit only**, never the test result (§2.5a)
- [x] **AC-9** `setFeatureStatus` refuses `COMPLETE` unconditionally — including `derived:true` and `force:true` — with a message naming the gate (paths 5, 10); the gate's own write does not go through it (Decision 8)
- [x] **AC-10** `PATCH /api/vision/items/:id` refuses `status: 'complete'` with 422 — **only when `modeOf(item) === 'build'`** (§2.3d). Round 5 caught that an unconditional refusal bricks fix/plan whenever a server is running, because all modes share the terminal call (`lib/build.js:4309`) and `VisionWriter` dispatches it to this PATCH (`lib/vision-writer.js:403`). The same condition applies to re-pointing `/lifecycle/complete` at the gate (§2.1). Tests must run **with the server up** for fix and plan
- [x] **AC-11** `POST /api/stratum/audit/:itemId` no longer flips item status to complete (path 8)
- [ ] **AC-12** *(DEFERRED to follow-up COMP-COMPLETION-GATE-REMOTE — see §3)* `lib/xref-push.js` and `GitHubProvider.setStatus` refuse COMPLETE (paths 9, 15)
- [ ] **AC-13** CLI `record-completion` no longer defaults `tests_pass`; missing attestation errors naming the flag (**BREAKING**)
- [x] **AC-14** `COMP-MCP-ENFORCE/report.md:8,52` corrected with a dated note; the original claim preserved, not deleted; the correction describes the **new** guarantee accurately (evidence-checked + ledgered, not lifecycle-enforced) rather than swapping one overclaim for another
- [ ] **AC-15** `addRoadmapEntry` refuses `status: 'COMPLETE'` at creation, closing `compose roadmap add --status COMPLETE` and `proposeFollowup` (paths 11, 12)
- [x] **AC-16** `VisionWriter.updateItemStatus` refuses `complete` in **both** transports (path 14) — but **only for build mode** (§2.3d); `fix` and `plan` items are unaffected, and a test asserts both still complete normally. The legitimate build-mode write goes through `completeItem` (AC-4b)
- [x] **AC-16b** Three verification tiers are distinguishable on the projection and tested: `guarded` (guard resource exists and is `complete`), `canonical-status-only` (no guard resource — legacy features and startup seeding), `document-derived` (unmanaged folders with no feature.json, `server/feature-scan.js:172,294`). A `guardHistory` error **other than** `guard_not_found` fails closed rather than downgrading a tier (§2.3b)
- [x] **AC-16a** Projection **repair** tooling routes through the same self-verifying seam rather than being carved out: `lib/feature-reconciler.js:161,236` (vision repair from canonical status) and `server/feature-scan.js:491` (startup scan creating items with dynamic status incl. `complete`). Tests assert both still repair correctly after AC-16 lands — this is the regression round 3 predicted (P1-6)
- [x] **AC-17** `roadmap migrate` retains its COMPLETE write under a named, logged exemption covering **both** branches (path 13); a **negative test** asserts a *new* COMPLETE row created without `--overwrite` is still covered by the exemption and logged, not silently bypassing (§2.7)
- [ ] **AC-18** `lib/test-bootstrap.js` `_UNPARSED` no longer degrades to `true`; the gate treats it as not attested; the error names the unreadable framework and the remedy (**BREAKING**)
- [x] **AC-19** An **allowlist test**: a repo-wide scan of every COMPLETE/complete status write — including dynamic status values (e.g. migrate's `entry.status`) and every `persistFeatureRaw` callsite — asserting each is either the gate or an entry on an explicit allowlist justified in-file. Because `persistFeatureRaw` stays public and policy-free (Decision 7), the invariant is **allowlist-shaped, not absolute**, and the test and the shipped docs must say so. This is what makes §1.3 a property instead of a claim
- [x] **AC-20** No import cycle: `completion-gate` ↔ `feature-writer` ↔ `lifecycle-guard` load cleanly in both orders (test imports each entrypoint first)
- [ ] **AC-21** An explicit workspace root is threaded through capability lookup, engine + binary resolution, evidence checks, and guard registration; a test runs the gate under `--workspace` against a non-cwd root and asserts the guard registers under that root's `resourceId`
- [ ] **AC-21a** The gate takes **two** roots: `workspaceRoot` (provider, capabilities, `resourceId`, feature.json) and `evidenceRoot` (git verification, test execution, HEAD resolution), derived from `agentCwd` (§2.6). Both appear in the AC-1 signature. A **cross-repo acceptance test** asserts the commit is verified in the agent's repo, not the project root's — this defect is invisible in the single-repo default
- [ ] **AC-21b** `evidenceRoot` is persisted (normalized) in the v2 accumulator and restored on resume; a **cross-repo resume** test asserts a restarted build still verifies against the agent's repo rather than falling back to the project root (§2.6)
- [ ] **AC-22** `set_status:false` maps to `intent: 'evidence-only'` (AC-1): the gate runs the evidence check and records, and performs **no** guard transition and no status write (§2.7)
- [ ] **AC-23** Non-git workspace: null-SHA completion accepted only when the workspace is server-checked as not a git repo, stamped with the `no-repo-exemption` tag per the §2.2 combined grammar
- [ ] **AC-24** `complete_feature` tool schema + docs updated: `commit_sha` required except under AC-23
- [ ] **AC-25** Recovery keys off a **write-ahead intent record** written before the guard transition (§2.4a), not a derived id. Tests cover all five rows of the §2.4a table — in particular **commit A applies → crash → retry with commit B → REFUSE** (the round-4 P0), and stale-intent-with-no-transition → clear and proceed. No guard-side idempotency key is sent; a test pins that `guardedTransition` still omits it
- [ ] **AC-25a** *(RETIRED — the intent record gives null-SHA completions a durable identity, so `--resume-completion` is unnecessary. See §2.4a.)*
- [ ] **AC-25b** Accumulator schema v1 → v2 adds `tests_attested` (`'passed'|'failed'|'no-signal'`); a resumed v1 build with no such field reads as `'no-signal'` and is **refused**, not assumed passing (§2.5a). The no-changes ship branch returns its computed test result instead of discarding it (`lib/build.js:5087`)
- [ ] **AC-26** Preflight: all compose-side writes validated before the guard transition; a test asserts a preflight failure leaves the ledger untouched
- [ ] **AC-26a** Preflight checks **source-status legality**: a feature currently `KILLED` or `SUPERSEDED` is refused, preserving the terminal-status policy at `lib/feature-writer.js:49` that `recordCompletion` deliberately honours (`lib/completion-writer.js:373`). Without this, the gate's policy-free `persistFeatureRaw` write would let a killed feature be late-registered at `ship` and raw-written to COMPLETE. Tests cover both terminal states
- [ ] **AC-26b** The gate uses the **hardened** `acquireDirLock` (`lib/dir-lock.js:84` — owner token, heartbeat, provably-ours release), not the 5s no-heartbeat `acquireFeatureLock`. The test command runs **outside** the lock (a synchronous `spawnSync` blocks the heartbeat); the locked section holds only intent write → guard transition → §2.3a writes. `recordCompletion` does not re-acquire when called through the gate. **The concurrency test must exceed the old 5s stale threshold** — a fast test cannot detect lock theft (§2.4b)
- [ ] **AC-27** Golden flow: a real feature completes end-to-end through the gate against a real stratum binary; `~/.stratum/guards/<rid>/ledger.jsonl` shows the transition
- [ ] **AC-28** Golden flow (negative): completion with a nonexistent commit sha refuses, and nothing is written to feature.json, the vision item, or the ledger
- [ ] **AC-29** The honest-ceiling statement (§2.2) appears in the shipped report

## 6. Risks

- **Late registration is the only regime, not a fallback.** Every feature late-registers, so the
  guarantee is "evidence checked + ledgered", never "lifecycle enforced". A genuine improvement over
  zero, but materially weaker than the COMP-MCP-ENFORCE report claimed — AC-14 must not swap one
  overclaim for another.
- **Latency is now bounded** — one transition per completion, one subprocess. The multi-edge concern
  from revision 2 is gone with the walk.
- **Breaking changes land together.** AC-13 (CLI default) and AC-18 (`_UNPARSED`) both remove
  auto-attestation. Projects on unparseable frameworks will start failing completions on upgrade.
  Needs a CHANGELOG entry and a migration note in the same commit.
- **AC-19 is the hardest AC** and the one most likely to be quietly dropped. Without it, the
  fourteen-path list decays the moment someone adds a fifteenth. Do not ship without it.
- **Refusing paths 5, 10, 11 may break existing callers.** `feature-reconciler` uses `derived:true`
  deliberately; `proposeFollowup` forwards caller status. Confirm no legitimate flow needs to write
  COMPLETE before AC-9/AC-15 land, or reconciliation will start failing on drift it used to fix.
