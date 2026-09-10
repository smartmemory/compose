# S1a blueprint correctness review — r1

Reviewed against the current tree at `b45c59c371b78b9592a2865491d6867cea625e56`, including the working-tree blueprint and progress rulings. Q1's refusal is accepted; the GSD sidecar follow-up is not reopened. No test suite was run. Validation comprised source inspection and in-memory digest/input-contract probes.

1. **HIGH — Retained source-epoch equality rejects a supported GSD merge retry.**
   Blueprint: §1 C5; §5 GSD epoch mapping (`blueprint-slice1a.md:112`); §6 whole-list checks (`blueprint-slice1a.md:148–149`).
   The blueprint broadens admission to bare GSD while retaining the recorded-list checks, but `lib/build.js:845–849` requires the source step's epoch to equal the consumer epoch.
   Bundled GSD reads `${decompose_gsd.output.tasks}` (`pipelines/gsd.stratum.yaml:61`) and revises to **execute**, not decompose (`pipelines/gsd.stratum.yaml:78–83`). Merge errors actually select that revision in `lib/gsd.js:715–728`.
   Stratum resets only the target and forward descendants, incrementing their epochs (`../stratum/ts/src/engine/engine.ts:2790–2807,2821–2837`). After revision, decompose remains succeeded at epoch 0 and execute is epoch 1: the prescribed check produces `WAVE_INPUT_INVALID` before redispatch.
   This violates S1a's recorded epoch/recovery support (`design.md:195–206,410–414`). It affects bundled GSD when shadow is explicitly enabled; default-off GSD is unaffected.
   **Change:** bind source identity/token/output digest independently from consumer epoch; validate that the recorded source still supplies this wave without requiring equal counters. Keep the item epoch/index/generation fences. Add a real GSD merge-revise case to `test/gsd-model-route.test.js` or the continuation golden.

2. **HIGH — The graph-membership rule rejects a second legitimate continuation.**
   Blueprint: §2 detailed resume shape; §5 GSD graph rules (`blueprint-slice1a.md:109–113`).
   Detailed loading takes its original graph from the previous pause/crash state (`lib/gsd.js:1260–1264,1296–1310`). A continuation stores only its remaining graph in state and `lastTaskGraph` (`lib/gsd.js:220–233,599–602`).
   Completion bookkeeping remains cumulative across runs: `collectCompletedTaskIds` unions the blackboard and result files (`lib/gsd.js:1118–1129`). Both halt writers pair those cumulative IDs with the current, already-filtered graph (`lib/gsd.js:1160–1183,1410–1424`).
   Thus `[A,B,C]`, completed A, becomes `[B,C]`; after B completes and C halts with verified settlement, the next pause can contain graph `[B,C]` and completed IDs `[A,B]`. The requirement that every completed ID exist in this original graph rejects A, despite its validated earlier continuation link. The same mismatch can arise through the crash bridge.
   Design D3 retains completed outcomes across continuation runs (`design.md:180–193`); it does not limit a start to one continuation.
   **Change:** distinguish cumulative completed IDs from IDs removed on this transition. Validate earlier completions against the retained continuation chain, and intersect with the immediate source graph for filtering/index maps. Add a three-run continuation case to `test/gsd-model-route.test.js` and retain the existing state/blackboard shapes.

3. **MEDIUM — The pre-change capture does not freeze the bundled preset baseline.**
   Blueprint: §8 dispatch 1 (`blueprint-slice1a.md:166–167`), dispatch 3 (`:178–180`), Tests (`:196–197`).
   The only assigned pre-edit capture uses `runWaveGolden`. Its fixture supplies test-only profiles and a bug flow: verify uses coordinator, review uses `codex:reviewer:critical`, and input is `{task}` (`test/helpers/build-wave-golden-fixture.js:24–39,71–72,170–172`).
   The production preset instead uses standard verify, read-only-reviewer, and the feature input envelope (`presets/team-fable-astra.profiles.json:2–5`; `lib/build.js:6439–6444`). These produce different digest/input/prompt baselines.
   The production golden currently reads the current preset at module load and asserts selected behavior, without freezing its full prior digest/input/call bytes (`test/build-team-fable-astra.test.js:18–20,101–108,141–152`). Dispatch 3 therefore has no assigned pre-change bundled trace against which to prove its acceptance checkbox.
   **Change:** dispatch 1 must also capture the actual bundled preset's digest, feature envelope and both providers' call projections using the production golden before edits. Store separate named baselines for bundled Build, the carry fixture, and GSD input identity; dispatch 3 consumes them without regenerating expectations.

4. **MEDIUM — S1a pulls pending metadata receipt delivery forward from S1b.**
   Blueprint: §6 (`blueprint-slice1a.md:137,151,153–154`) and §8 goldens (`:179`).
   Design explicitly assigns pending metadata receipt intents to S1b (`design.md:200–203`), consistent with the S1b slice's receipt intents/recovery (`design.md:416–419`). The blueprint instead requires atomic issuance-plus-receipt spooling and acknowledged delivery before every launch in S1a.
   This changes the runtime dependency: existing `flushWaveReceipts` refuses absent `usageReport`, cancellation or missing acknowledgement (`lib/build.js:785–799`), while `recordPendingUsageReceipt` creates durable delivery state (`lib/consumer-fanout.js:710–722`). It is executable extra scope, not merely a reserved record field.
   **Change:** keep S1a's immutable local admission/issuance/events and shadow-record assertions, but move the new routing metadata spool, prelaunch delivery requirement and receipt assertions to S1b as already assigned by the design. Existing wave receipts retain their current behavior.

5. **LOW — C3 cites unconditional preflight as a conditional persistence pin.**
   Blueprint: §1 C3 (`blueprint-slice1a.md:14`).
   `lib/build.js:3312–3326` computes runtime profiles, preflight and the effective map; it neither persists a pin nor checks `waveProfilesEnabled`. It is invoked unconditionally at `lib/build.js:3328`.
   **Change:** cite the actual conditional persistence/validation sites: `lib/build.js:3361–3363,3433–3439,3812–3823`. Keep `3312–3326` as the refresh insertion point in §5. No other materially false insertion/evidence anchor was found.

Other requested checks:

- **Off identity:** the proposed route projection works for the bundled representation. Reading and calling the current hash path (`lib/pipeline-profiles.js:173–199`) gives legacy/projected digest `310f9698e97212f695ce2ca752d724f90c1f233ab5855dcb33a26bd3ad786205`; leaving plan wrapped gives `29c060da1374fa433e436e98082e4ea3c7af07247b6364a1b8e08a775b6b794c`. Added input declarations leave the projected profile digest unchanged. The input compiler uses `.optional()` without defaults (`../stratum/ts/src/ir/validate.ts:171–188`); probes through the available compiled validator preserved serialized envelopes for both YAML specs. The prescribed off branch retains the existing call seams (`lib/build.js:4307,6439–6444`; `lib/gsd.js:294–298,610–619`). Full dispatch-byte proof remains the missing bundled capture in finding 3, not an executed golden result.
- **Specified refusals/default fixtures:** no unintended missing-root, binding-drift, Q1 mismatch or slice-unavailable refusal was identified for current fixture defaults. The wave fixtures have no routing metadata (`test/helpers/build-wave-fixture.js:9–14`; `test/helpers/build-wave-golden-fixture.js:24–29`), and the seeded legacy GSD resume stays off (`test/gsd-stuck-resume-golden.test.js:26–28`). The production preset golden (`test/build-team-fable-astra.test.js:43–45,121–123`) becomes a fresh participating Build with the updated bundled declarations, not an unbound resume. These are source-derived conclusions; passing status was not rerun.
- **Dispatch ownership:** production file/function assignments are disjoint. Dispatch 1 can be built and unit-tested with explicit inputs without runner wiring; its baseline capture uses the existing runner. Keep the capture wrapper temporary as specified so dispatch 3 retains ownership of persistent golden-harness edits.
- **Test mapping:** implementation acceptance checkboxes name test files; documentation checkboxes are documentation tasks. The golden plan explicitly includes off identity, shadow record presence and real GSD continuation. Findings 1–3 identify missing scenarios/baseline provenance within that otherwise named coverage.

Verdict: 2 HIGH / 2 MEDIUM / 1 LOW
