# COMP-MODEL-ROUTE S1a — Dispatch 3 implementation

Implemented inline against `36dcf5d` (Dispatch 2), following Dispatch 1 `20883d5`. Tests/docs only; no production fixes or repository commits. **Historical (before the defect fixes): 63 tests, 61 passed, 2 failed.** Both failures exposed production defects, since FIXED — see "Defect fixes (D3-1, D3-2)" below (host: 112/112 over eight files). The two failures and retain the requested `// DEFECT: see reports/slice1a-d3-impl.md` comments. S1a is not all-green; the parent feature remains incomplete pending S1b/S2/S3.

## Files

- `test/helpers/build-wave-golden-fixture.js`: optional routing input declarations, `route_mode` and `traceRouting` driver options, complete serialized plan/model capture, immutable evidence snapshots, frozen-fixture reader, constrained call normalization, and journal assertions. Codex still uses the real connector and fake executable; Claude uses recorded inference.
- `test/integration/build-wave-golden.test.js`: frozen off carry oracle; shadow carry assertions through two waves and ordinary epochs; oracle sensitivity controls; existing checkpoint SIGKILL/resume golden now runs in both off and shadow with input/root/record retention checks.
- `test/build-team-fable-astra.test.js`: bundled validator and plan/execute-only opt-in assertions; actual default-shadow and explicit-off producers compare against the frozen bundled oracle while retaining the original model, read-only review, and squash-ship checks.
- **New** `test/integration/gsd-route-continuation-golden.test.js`: real-engine child drivers, real TaskResult worktree writes/merge, production halt/state writers, hard crashes, continuation chains, lost/ambiguous plan recovery, uncertain-call holds, and real Git merge-conflict revision with source/item fences.
- `README.md`: short “Model routing (shadow)” subsection beside team presets.
- `CHANGELOG.md`: one Dispatch 3 bullet under Unreleased, including the remaining failures and the S1a scope limit.
- `docs/features/COMP-MODEL-ROUTE/design.md`: only the off-mode completion-evidence box was ticked, with same-line test receipts.
- This report.

Frozen fixtures, the recorder, `test/pipeline-profiles.test.js`, production files, sibling Stratum, package files and the pre-existing untracked `docs/features/COMP-GUARD-CLAIM-1/audit.json` were not modified.

## Blueprint Dispatch 3 checkboxes → evidence

| Checkbox / required claim | Receipt and result |
| --- | --- |
| (a) Carry off digest, input, both-provider complete dispatch identity against frozen 0.5.1 | **PASS** — `test/integration/build-wave-golden.test.js:268`. Real two-wave producer; exact input/flow and all plan-option keys (only workspace substitution), frozen profile digest, complete normalized model calls, no routing directory/journal field/ignore-rule mutation. |
| (a) Shadow adds immutable root/admission/issuance/event records with unchanged calls over two carried waves and ordinary epochs | **ASSERTIONS IMPLEMENTED; BLOCKED BY DEFECT D3-1** — `test/integration/build-wave-golden.test.js:285`. Completion assertion at `:291` fails during wave 0. The subsequent 12-call comparison, five logical tasks, verify/review/assess epochs `[0,1]`, root/profile immutability and ship assertions remain in place, but are **not claimed passed**. |
| (a) Real Build crash/resume retains start/input/local records and does not rerun accepted work | **PASS** — `test/integration/build-wave-golden.test.js:226`. Actual child SIGKILL after checkpoint ref CAS, before journal acknowledgement; shadow resumes even when passed off. Same root/input/earlier records, five settled issuances, one worker execution, one checkpoint and one ship commit. |
| Concurrent-wave order tolerance without weakening prompt/options/step/wave checks | **PASS** — `test/integration/build-wave-golden.test.js:315`. An in-wave permutation compares equal; prompt mutation, sandbox change, a new option key, reordered ordinary steps and swapping workers across waves compare unequal. |
| (b) Bundled spec validates; only plan/execute opt in | **PASS** — `test/build-team-fable-astra.test.js:29`. Real Stratum validator; exact routing metadata and opt-in set. |
| (b) Default shadow records; original model/sandbox/ship behavior; explicit off reconstructs frozen digest, feature envelope and both providers' calls | **PASS** — `test/build-team-fable-astra.test.js:47`. Both modes run the complete bundled producer, five calls each. Default shadow pins journal/root/records; off has no routing storage. Existing review isolation, model IDs, worker-summary exclusion and ship ancestry assertions remain. |
| (c) GSD fresh and continuation off envelopes consume the separate frozen fixture | **PASS** — off case at `test/integration/gsd-route-continuation-golden.test.js:204`. Both actual plans compare exact input/flow and all plan-option keys after workspace substitution. The GSD fixture is input-only; no frozen GSD model-call or profile-digest claim. |
| (c) B 1→0, old→new run/graph links, root/admission bytes, distinct tokens/ids, completed A not rerun | **PASS** — shadow case at `test/integration/gsd-route-continuation-golden.test.js:204`. A's real validated TaskResult is merged; B's engine call is settled without a completed TaskResult. The production halt writer persists the full graph and completed A. Continuation retains the original root and admission bytes, removes dependency A, dispatches B alone, and recovers an injected lost continuation-plan acknowledgement without another plan. |
| (c) Three-run `[A,B,C]→[B,C]→[C]`, cumulative completion chain and C 2→1→0 | **PASS for crash→crash; FAIL for halt→crash (D3-2)** — variants at `test/integration/gsd-route-continuation-golden.test.js:239`. Both use real writers and real child deaths. Crash→crash retains the full three-record chain; halt→crash incorrectly branches from run 1 and retains C indices `[2,0]`. |
| (c) Crash and uncertain-call hold before any further plan/model | **PASS** — `test/integration/gsd-route-continuation-golden.test.js:271`. Both a real same-file stuck detector/halt and SIGKILL inside B's inference leave an unresolved launch. Resume returns `ROUTING_ISSUANCE_UNCERTAIN` with unchanged plan/model counts. |
| (c) Lost plan acknowledgement, crash before binding, unique recovery and ambiguous-match refusal | **PASS** — `test/integration/gsd-route-continuation-golden.test.js:286`, plus continuation lost-ack at `:204`. Actual engine runs persist before the lost response or SIGKILL. Unique recovery has one plan RPC total; ambiguity is created by a second real engine plan with the same recorded input, then recovery refuses without inference or another plan. |
| (c) Bundled GSD merge-revise, source epoch 0/execute epoch 1, preserved source token/digest/wave, redispatch and fences | **PASS** — `test/integration/gsd-route-continuation-golden.test.js:308`. A conflicting target add-file causes the real Git witness precompute to raise `MERGE_WITNESS_PRECOMPUTE_FAILED`; the actual handler revises execute. After removing that injected target conflict, both workers redispatch and complete. Source bytes/token/output digest and logical wave persist; source token/output and descriptor epoch/index/generation perturbations refuse before calls. |

The requested existing profile tests also passed, including manual fallback/item-tier provenance (`test/pipeline-profiles.test.js:111`) and legacy object/hash projection (`:92`); that file was not edited.

## Design completion-evidence ticks

Only `design.md:436` was ticked: **Off-mode golden pins 0.5.1 profile digest and legacy input/dispatch bytes; no routing writes.** Its same-line receipts are:

- `test/build-team-fable-astra.test.js:47`
- `test/integration/build-wave-golden.test.js:268`
- `test/integration/gsd-route-continuation-golden.test.js:204`

“Dispatch bytes” here means complete JSON-serializable calls after the documented incidental substitutions, not literal equality of independently minted filesystem paths or UUIDs. The other evidence boxes remain unchecked: partial passing subclaims do not certify a compound claim. In particular, GSD continuation is not marked complete while D3-2 loses the immediate predecessor, and shadow unseen-wave/ordinary-epoch evidence is blocked by D3-1. Receipt IDs, paid-call joins, ledger/report/learning/promotion and trial/exploration/floor claims remain outside S1a.

## Production defects — left unfixed

### D3-1 — Concurrent carry re-admits a settled token and aborts shadow

**Owner: Dispatch 2.** `lib/build.js:4524` passes the entire returned ready descriptor array to admission when enqueuing a new unseen token. `lib/build.js:1290` iterates every descriptor in that array, including already-seen siblings. `lib/build.js:1099` then requires each descriptor's token to equal the current item's live `dispatchToken`; a concurrently succeeded item has moved that token to `acceptedDispatchToken`, so `:1101` raises `ROUTING_BINDING_DRIFT: Issuance differs from recorded token/item`.

Reproduction: the owned shadow carry test (`test/integration/build-wave-golden.test.js:285`) runs the unchanged four-item carry scenario at concurrency 3, with only optional routing input declarations added and `route_mode:'shadow'`. The initial three real connector calls finish; their real stepDone responses include still-running siblings plus newly ready execute/3. While that response is processed, a sibling settles. Full-array re-admission rejects it. The run aborts before DEFAULT or the repair wave; off completes both waves and matches the frozen 12-call trace.

Final captured run `e0ef801d-9cdc-48f5-be07-61ff04f5908a`: execute/0's response listed execute/1, execute/2 and execute/3. By the fatal drain, items 0–2 were succeeded with only accepted tokens; execute/3 remained ready. The helper prints `ROUTING_GOLDEN_FAILURE` with the actual response descriptors and final item evidence. This reproduced in every full command invocation during implementation; it remains a scheduling-sensitive production path, not a promise of one connector arrival order.

The `assert.doesNotReject` at `test/integration/build-wave-golden.test.js:291` and its immediately preceding DEFECT comment remain. No descriptor filtering, changed concurrency, retry-to-green, production bypass or weakened completion assertion was added.

### D3-2 — Stale pause takes precedence over a newer crashed continuation

**Owner: Dispatch 2.** `lib/gsd.js:343` writes the new run identity to state.json. The old pause remains until the clean-completion branch (`lib/gsd.js:405`, `:411`). After the new driver dies, `loadResumeTaskGraph` unconditionally reads an existing pause at `lib/gsd.js:1277`; it reaches the newer state/crash bridge at `:1291` only when no pause exists. Thus the next routing continuation binds to the old pause owner instead of the immediately preceding run.

Reproduction: `test/integration/gsd-route-continuation-golden.test.js:239`, **halt then crash** variant. Run 1 settles A/B/C, merges only A's validated result and exits through the real budget halt writer. Run 2 resumes B/C, merges B's real result and receives SIGKILL after the real merge/gate RPC, before its acknowledgement is returned. Run 3 resumes C. The test never writes or removes pause.json, state.json or blackboard.json by hand.

Final evidence: state.json named run 2 `7b34c8bf-92d1-4768-b0da-83f58d520fef`, but pause.json still named run 1 `e50a0858-95a8-4876-afc1-aa9b03f7c603`. Run 3 `a3396617-bf86-4a15-8d61-208962d2b08a` recorded `previousRunId` = run 1. Its C issuance chain contained indices `[2,0]`, omitting run 2's C issuance at index 1. The run reports complete while losing that continuation lineage. The crash→crash control (no old pause) passes `[2,1,0]`.

The failing immediate-predecessor assertion at `test/integration/gsd-route-continuation-golden.test.js:184` carries the DEFECT comment. No pause cleanup or precedence fix was made in this dispatch.

## Oracle provenance and boundaries

All three fixtures remain byte-identical to HEAD, source revision `5fbf8e0bd5dae18eb92a08197b5a9a50743722dc`, with `captured:true`. Frozen profile digests: bundled `310f9698e97212f695ce2ca752d724f90c1f233ab5855dcb33a26bd3ad786205`; carry `247791ff900ad8b6e0bbcba7408591d1a74adbdce1ab9c8833ab6621589cc1cd`.

| Frozen file | SHA-256 |
| --- | --- |
| `test/fixtures/model-route-off-bundled-build-v0.5.1.json` | `dcb7be4001879664d347a12abec6106a458329f7e61ca320ba211e9c7e77bf3a` |
| `test/fixtures/model-route-off-carry-v0.5.1.json` | `f806519cb4d86317e4565e0eb9e8280c21e1129ff0c569ae033006f70e9d679c` |
| `test/fixtures/model-route-off-gsd-input-v0.5.1.json` | `1fa3aae48bb0d0d928e8b6554d6e499f40dfcf32566737f2e5630a3f194b8ae2` |

The recorder was read for its serialization boundary, never invoked or imported by tests. Actual producers generate prompts and model arguments; expected prompts never drive inference selection. Only function-valued properties and `signal` are omitted, matching the frozen recorder. All remaining options, including telemetry, flow identity, effort, thinking, tools and sandbox, are compared.

Normalization substitutes corresponding workspace/dispatch cwd strings, consistently renames UUIDs after wave ordering, and replaces numeric TAP `duration_ms` values. It does not remove prompt text, model/tier/effort values, input keys or unknown option keys. Contiguous execute calls are sorted within their concurrent wave; ordinary steps separate waves and retain order. This implements the r3 arrival-order caveat without rerunning to obtain a lucky ordered trace. JSON does not certify callback or AbortSignal object identity.

## Resolved ambiguities and scope

- The user's explicit documentation ownership takes precedence over the blueprint's broader list. README carries route shape, programmatic mode selection, bundled defaults, manual fallback, projection/custom declarations and Q1 refusal. `docs/team-presets.md`, the blueprint and progress.md remain untouched; actual APIs, commands, provenance and limitations are recorded here.
- The off carry fixture retains its original YAML. Only shadow fixtures add the five optional input declarations; no frozen expectation is regenerated from current code.
- GSD continuation records use `sourceGraph`/`sourceGraphDigest`, not the internal resume loader's `originalGraph` name.
- To reach a resumable halt with all engine issuances settled but selected tasks unfinished, the fixture returns a budget-exhausted response at the post-merge gate RPC boundary. **Budget exhaustion itself is injected, not an engine-budget enforcement claim.** The engine acceptance, actual worktree merge, production budget/pause/state writers, dead child PID and continuation reads are real. Separate uncertain tests use the real stuck detector and hard SIGKILL. No lifecycle state files are seeded.
- The merge revision is a real Git patch conflict, not a fabricated typed exception. The test removes only its injected external conflict before the revised workers run.
- No live model-service, S1b acceptance/cost/receipt, or complete shadow-sample claim is made.

## Validation and sandbox

Final command, also the exact host reproduction command:

```sh
STRATUM_STATE_ROOT="$(mktemp -d /tmp/model-route-d3-state.XXXXXX)" \
RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=900000 \
  test/integration/build-wave-golden.test.js \
  test/integration/gsd-route-continuation-golden.test.js \
  test/build-team-fable-astra.test.js \
  test/pipeline-profiles.test.js
```

**63 tests; 61 passed; 2 failed; 0 skipped/cancelled/todo; exit 1; 46.215 seconds.** Final log: `/tmp/model-route-d3-tests-final.log`. Failures are D3-1 and D3-2 above. Only the prescribed four files were run; fixture-internal unit tests and Stratum validation remain part of their existing real-engine checks. No full suite was run.

No sandbox blocks occurred. All engine/artifact roots and Git projects were disposable; no access to `~/.stratum`, GUI/browser launch, host escalation or installed-package mutation was needed. A host rerun is not needed to resolve an environmental block; the command reproduces the remaining production defects. `git diff --check` passed. Frozen files/recorder/profile test were verified unchanged. No commit or push.

## Defect fixes (D3-1, D3-2)

Both defects above are now fixed. The historical failure evidence and dispatch-3 results above remain unchanged.

- **D3-1 — `lib/build.js:4524–4534`:** participating single-stage consumer routing waves pass only unseen dispatch tokens to admission. Repeated siblings retain their original admission/issuance links even after concurrent success moves their live token to `acceptedDispatchToken`. The descriptor being enqueued still undergoes the unchanged token/item/generation/epoch fence in `prepareRoutingIssuance` (`lib/build.js:1093–1102`). Whole-wave recorded input validation remains intact. Legacy and deferred multi-stage waves retain full-batch admission, including invalid-descriptor refusals. Concurrency selection and launch scheduling are unchanged. Pin: `test/integration/build-wave-golden.test.js:285` (assertion at `:290`) completes the concurrency-3 carry and repair waves with the frozen full-call oracle, immutable admissions and ordinary epochs.
- **D3-2 — `lib/gsd.js:1274–1319`:** resume reads the current persisted state run identity and checks its durable feature routing index. When that participating run differs from the pause owner, its state/crash bridge takes precedence; an ineligible current state refuses instead of falling back to the stale pause. A pause belonging to the same run retains precedence. This uses recorded run identity/participation, not file timestamps or current routing flags. Pin: `test/integration/gsd-route-continuation-golden.test.js:238`, halt→crash variant, with immediate-predecessor assertion at `:183` and issuance-index assertion at `:189`. Run 3 now binds to run 2 and retains C indices `[2,1,0]`, cumulative A/B completions and prior record bytes. Crash→crash and halt-only controls also pass.
- **Off-mode GSD resume behavior did not change for legacy non-participating runs.** Runs absent from the durable routing index still use pause-first precedence and the existing crash bridge when no pause exists. Recorded participating continuations use their persisted routing lineage even if the invocation supplies `route_mode: 'off'`, as before. The off halt/resume frozen oracle and `test/gsd-stuck-resume-golden.test.js` pass. Other `test/gsd-*.test.js` files outside the prescribed command were not run.
- Removed only the two `// DEFECT:` comments from the golden tests after their assertions passed; no assertions, fixtures or helpers were changed by this fix. Production edits are confined to `lib/build.js` and `lib/gsd.js`; routing ledger and consumer-fanout code are unchanged.

Validation used disposable state roots and empty service keys:

```sh
task_state=$(mktemp -d /tmp/model-route-d3-fixed.XXXXXX)
RESEND_API_KEY= STRIPE_API_KEY= STRATUM_STATE_ROOT="$task_state" \
node --test --test-timeout=900000 \
  test/integration/build-wave-golden.test.js \
  test/integration/gsd-route-continuation-golden.test.js \
  test/build-team-fable-astra.test.js \
  test/build-model-route.test.js \
  test/gsd-model-route.test.js \
  test/gsd-stuck-resume-golden.test.js \
  test/build-wave-routing.test.js \
  test/gsd-wave-routing.test.js
```

**112 tests; 112 passed; 0 failed/skipped/cancelled/todo; exit 0; 97.327 seconds.** Log: `/tmp/model-route-d3-fixed.log`. This eight-file set differs from the historical four-file, 63-test reproduction above. It includes ordinary retry/new-epoch identity (`test/build-model-route.test.js:61`), descriptor fences, legacy whole-batch refusal and both continuation controls.

The explicit missing-link regression (`test/routing-journal.test.js:126`) was additionally run with `--test-name-pattern='journal reopening detects a missing dispatch routing link'`, the same timeout/empty keys and a separate disposable state root: **1 test; 1 passed; 0 failed; exit 0**. Log: `/tmp/model-route-d3-link.log`. Before editing production code, the two targeted defect goldens both failed with their diagnosed errors (`/tmp/model-route-d3-before.log`). No full suite, commit or push. `git diff --check` passed.
