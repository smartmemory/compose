# Slice 3 dispatch 1 — independent correctness review r1

1. **P1 — Exact-ref recovery reports success without restoring a known missing materialization.**
   Location: `lib/consumer-fanout.js:833-843` (`recoverCheckpoint`).
   `MARK_PUBLISHED` / `ALREADY_PUBLISHED` skip materialization entirely; the parent can remain at the recorded pre-merge witness while recovery claims success, allowing subsequent verification/ship to see missing wave changes.
   Reproduction: create/apply an owned-file wave in a disposable Git repo, record/publish its checkpoint, restore `owned.txt` to the exact transaction baseline, then call `recoverAdvancedConsumerArtifacts`. The script also exercises the prepared-record/ref-published crash window and published recovery after acknowledged cleanup.
   Command: `node /tmp/slice3-d1-review-checkpoints.mjs`
   Observed (`recover/prepared-exact-ref-known-baseline`): `{"atKnownBaseline":true,"result":true,"content":"base\n","checkpointState":"published"}`; the checkpoint contains `wave one\n`.
   Observed after publication/cleanup: `{"atKnownBaseline":true,"result":true,"content":"base\n","tipContent":"wave one"}`.
   Fix: reconcile materialization on exact-tip recovery too, restoring known prior witnesses through the temporary-index tree delta while preserving legitimate post-checkpoint edits.

2. **P1 — Omitting the gate state bypasses the epoch/token fence and permits stale approval.**
   Location: `lib/output-gate.js:53-55` (`decideGateFromOutput`).
   The freshness check is conditional on a supplied gate object; missing gate state is treated as permission to resolve instead of missing evidence.
   Reproduction: succeeded assess/review states at epoch 1, a valid complete decision, and a waiting gate at epoch 2/token `current`; evaluate, remove only `stepOutputs.gate`, and evaluate again with the same gate ID/token.
   Command: `node /tmp/slice3-d1-review-probes.mjs`
   Observed (`gate/stale-with-state`): `{"outcome":null,"reason":"GATE_SOURCE_STALE"}`.
   Observed (`gate/stale-without-state`): `outcome:"approve", source.epoch:1, source.gateToken:"current"`.
   Fix: require the recorded waiting gate, matching token, and sufficient epoch evidence before resolving; hold when any is absent.

3. **P1 — A caller-supplied review override can defeat the recorded blocking review.**
   Location: `lib/output-gate.js:62-65` (`decideGateFromOutput`).
   `reviewOutput` wins over the configured review step's actual output, so `WaveDecision` can approve completion despite a current recorded review with `blocking:true`.
   Reproduction: current epoch/token, succeeded review `{blocking:true}`, complete decision with `blocking:false`; compare omitted `reviewOutput` with `{blocking:false}`.
   Command: `node /tmp/slice3-d1-review-gates.mjs`
   Observed without override: `outcome:null, reason:"GATE_VALIDATION_FAILED", findings:["WAVE_BLOCKING_MISMATCH"]`.
   Observed with override: `{"recordedBlocking":true,"override":{"blocking":false},"outcome":"approve"}`.
   Fix: validate against the configured succeeded review state's output; reject any supplied override that lacks matching recorded provenance or contradicts that output.

4. **P2 — WaveDecision admission validates the hardcoded Codex profile instead of the execute stage.**
   Location: `lib/output-gate.js:30-31,43` (`validateDecision`, `decideGateFromOutput`).
   The API has no execute-profile/provider input: absent item tiers always validate as Codex critical, even for a configured Claude fast stage. This certifies the wrong provider/default resolution before routing repair/implementation work.
   Reproduction: admit a task with no tier under `{default:'claude:implementer:fast',tier_from:'item.tier'}`, then evaluate its implement decision; use a Node inspector breakpoint in the unmodified admission function to observe the gate's actual arguments/result (no mocks).
   Command: `node /tmp/slice3-d1-review-gates.mjs`
   Observed configured admission: `profile:"claude:implementer:fast", modelID:"claude-haiku-4-5-20251001"`.
   Observed gate admission: `entry:{default:"codex:implementer:critical",tier_from:"item.tier"}, provider:"codex", profile:"codex:implementer:critical", modelID:"gpt-6-astra"`; gate returns `revise`.
   Fix: extend `decideGateFromOutput(config, stepOutputs, {gateStepId,gateToken,reviewOutput,ceiling,executeProfile,executeProvider})` and `validateDecision(decision,review,validator,{executeProfile,executeProvider})`, requiring and forwarding the configured execute entry/provider to `validateWaveAdmission`.
