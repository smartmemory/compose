# Slice 3 dispatch 1 implementation

Scope: reusable primitives only; no commit, direct dependency install, runner, CLI, preset, or sibling changes.
`lib/build.js` is unchanged from b62ec9b. Existing consumer golden tests are unchanged.
Pre-existing/concurrent progress.md, slice3-d2-wiring.md and COMP-GUARD-CLAIM-1/audit.json were left alone.

Files: new lib/pipeline-profiles.js, lib/output-gate.js, lib/wave-checkpoint.js; extended lib/consumer-fanout.js.
Tests: new test/{pipeline-profiles,output-gate,consumer-ownership,wave-checkpoint}.test.js and test/helpers/consumer-wave-fixture.js.
CHANGELOG.md has one Unreleased dispatch-1 entry, explicitly not yet wired.

Implementation decisions and journal contract:
- D4 reconstructs the RETAINED binary patch on its base in the shared temporary index, writes its tree, then uses `git diff --cached --name-only -z --no-renames <base> --`.
- Delete/add endpoints enforce rename ownership; NUL paths preserve whitespace; binary, mode, symlink, add and delete changes use Git entry identity. Worker files_changed is irrelevant.
- Capture pins base/tree/paths/diff digest; merge preparation, existing transactions and actual application recheck retained patch/binding identity. Failure retains patch/usage, journals OWNERSHIP_VIOLATION or OWNERSHIP_EVIDENCE_MISMATCH, and exposes a replayable failure envelope.
- Ownership activates with an explicit/durable item binding (or ownership option); legacy runner calls stay inert until dispatch 2 supplies it. Tier-only bindings do not imply ownership.
- Journal remains version 1. profilesDigest, waveAdmissions, dispatchBindings, pendingUsageReceipts, issuance.itemBinding/resolvedProfile/ownership/findings, and wave.checkpoints are additive and absent for legacy runs.
- Checkpoints retain prepared/published state, token/ordinal/epoch, parent/tree/commit/metadata/message and receipt/materialization/cleanup watermarks. All mutations reuse guarded reload + fsync/rename; no await was added inside mutations.
- Recovery matches old gate ordinals even when the same gate waits again, verifies commit objects and chain order, replays only in a temporary index, preserves later edits, and refuses ambiguous parent/ref drift or missing cleaned evidence.
- Git uses commit-tree + compare-and-swap update-ref; HEAD, real index and checked-out branches are protected, including linked worktrees. Ship helper returns the squashed tree without staging or committing.
- Skill/source correction: keep the existing synchronous journal/merge machinery and shared temporary-index helper; use this report for dispatch-specific implementation notes rather than changing the adjudicated blueprint.

Validation:
- Final targeted primitives: 93/93 passed, 0 failed/cancelled/skipped (real Git fixtures), after all production edits.
- First targeted invocation including the unchanged consumer golden: 120 passed, 0 failed, 1 file timeout at 90s; no assertions failed before cancellation. Full suite uses its configured 900s timeout.
- Full Node suite run ONCE (`RESEND_API_KEY= STRIPE_API_KEY= npm test > /tmp/d1-full.log 2>&1; echo $?`): exit 1; 6,731 tests, 5,815 passed, 455 failed, 453 cancelled, 8 skipped, 925.6s. This run started before the final hardening edits; final affected paths were retested afterward.
- UI: 624/624 passed; tracker: 100/100 passed, run separately because Node failures prevent npm test's && continuations.
- Logs: /tmp/d1.log, /tmp/d1-final-targeted.log, /tmp/d1-full.log, /tmp/d1-pipeline-golden.log, /tmp/d1-ui.log, /tmp/d1-tracker.log; per-test failure details: /tmp/d1-full-failures.json.
- Corrected implementation failures: the full run saw 2 GSD golden failures while ownership still auto-bound descriptor items. Final explicit-binding correction preserves opt-in behavior; unchanged test/ts-cutover-pipeline-fanout-golden.test.js then passed 27/27. Unchanged test/ts-cutover-consumer-fanout-golden.test.js passed in the full run.
- Unresolved assertion, NOT claimed environmental: test/build.test.js:156 (`abort of an unknown flow is refused and writes nothing`) returns transport instead of flow_not_found; reproduced separately. No fix made outside the brief scope.
- Environmental failures/cancellations (host rerun required; names below are files, full individual names/errors are in the JSON inventory):
- Port bind EPERM, test/{activity-routes,artifact-manager,auth-routes,budget-ledger,budget-route,build-all-gsd-routes,build-routes,build-stream-smoke,cli-gate,cli-remote,cli-resolve-workspace,completion-projection}.test.js.
- Port bind EPERM, test/{completions-route,compose-mcp-tools-http,config-paths,design-routes,feature-scaffold-route,fluid-provider-conformance,fluid-smartmemory-coordination,fluid-smartmemory-provider,gate-log-emit,gate-routes,graph-export-routes,graph-layout-routes}.test.js.
- Port bind EPERM, test/{ideabox-routes,iteration-emitter,iteration-routes,journal-routes,launch-routes,lifecycle-backfill-routes,lifecycle-guard-auth,lifecycle-guard-infra-status,lifecycle-routes,loops-cli,maya-client,maya-routes}.test.js.
- Port bind EPERM, test/{migration-cockpit,open-loops-routes,phase-transition-emitter,pipeline-routes-security,pipeline-routes,pipeline-save-specwide-fix,pipeline-save-wave2,pipeline-save,qa-scope-routes,remote-gate,session-binding,settings-routes}.test.js.
- Port bind EPERM, test/{smartmemory-client,smartmemory-hooks,smartmemory-ingest,smartmemory-recall-route,smartmemory-scope-error,smartmemory-sync,status-route,stratum-api,validate-routes,vision-routes-plan-mode,vision-routes-projection-gate,wave-6-integration}.test.js.
- Port bind EPERM, test/{workspace-routes,workspace-switch-runtime}.test.js.
- Port bind EPERM, test/comp-obs-branch/branch-lineage-route.test.js, test/golden/http-middleware-multi-workspace.test.js, test/integration/health-repair.test.js, test/integration/health-routes.test.js, test/integration/validate-routes.test.js.
- Port-listener timeout: test/settings-e2e.test.js (900s; its before hook waits for listen on 127.0.0.1).
- ps/process identity: test/lifecycle-backfill.test.js (10 assertions downstream of unverifiable guard identity); test/review-fixes-runtime.test.js:213 (`a refused group signal is stamped with who is actually in the group`, spawnSync ps EPERM).
- Denied filesystem writes: test/{build-quick,hooks-status-cli}.test.js (init copies to ~/.claude/skills; reproduced); test/compose-mcp-package.test.js (~/.npm); test/{gsd-budget-terminal-golden,gsd-stuck-resume-golden}.test.js (~/.stratum); test/integration/hook-read-cache.test.js (~/.claude/read-cache).
- File-watch delivery/resource limits: test/build-stream-bridge.test.js and test/integration/agent-lanes-pipeline.test.js (unchanged bridge probe received 0 callbacks); test/{ideabox-projection-watch,pipeline-specwatch}.test.js (EMFILE/watch).
- Registry/network: test/package-start.test.js hit 900s timeout; its own temporary npm-install debug log repeatedly reports registry.npmjs.org EPERM. The test was allowed to time out; no dependency install was run directly.

Dispatch 2 call surface (all synchronous except existing applyMerge):
- `normalizePipelineProfiles(raw, spec)`; spec is parsed or YAML, with runtime input references already resolved.
- `mergeRuntimeProfiles(normalized, runtime={})`; replaces agent defaults while retaining tier_from; re-preflight against the effective spec.
- `preflightPipelineProfiles(raw, spec, runtime={}) -> {ok,normalized,resolved,profilesDigest}`; includes all possible item-tier model resolutions in the digest.
- `resolveConsumerProfile(entry, item, provider) -> {provider,template,tier,modelID,effort,profile,...}`.
- `validateWaveAdmission(entry, items, opts={provider,ownership,independent}) -> {ok,findings,profiles}`; pass the WHOLE recorded list before dispatch, once per stage.
- `profilesDigest(normalized)` computes canonical JSON SHA-256; exclude operational ceiling overrides from its input.
- `decideGateFromOutput({decide_from,validators}, stepOutputs, {gateStepId,gateToken,reviewOutput,ceiling})`.
- Gate stepOutputs are current recorded states `{status,output,epoch,acceptedDispatchToken}` plus the waiting gate state; ceiling is `{spent,ceiling}`. Result is approve/revise/kill + source evidence, or null + reason/findings/breach. Caller owns audit freshness, durable proposed/accepted receipts and real suspension.
- `prepareCheckpoint({cwd,ref,parentCommit,tree,workingTree,message,commitMetadata}) -> {ref,parentCommit,tree,commit,message,commitMetadata}`; choose tree OR workingTree:true.
- `publishCheckpoint({cwd,ref,expected,commit})`; expected:null creates a ref with zero-OID CAS.
- `readCheckpointRef({cwd,ref}) -> commit|null`; `worktreeBaseFor({journal,ref}) -> commit|null`, where ref is the actual tip value, not the ref name.
- `squashOntoBase({cwd,ref,base}) -> tree`; `removeCheckpointRef({cwd,ref,expected})`.
- `reconcileCheckpoint({journalEntry,refValue}) -> named action` implements the resume-table classification; artifact recovery performs Git/evidence verification.
- `ConsumerFanoutArtifacts({...existingOptions,profilesDigest})`; `bindRunRevision({revisionDigest,specDigest,profilesDigest})`.
- `recordWaveAdmission({fanoutStepId,epoch,inputDigest,sourceProvenance,baseCommit,items,validatedAt?})`; pin full indexed item evidence using blueprint §2 shape.
- `recordDispatchBinding({dispatchToken,itemBinding,resolvedProfile})` before invocation; itemBinding includes `{item,itemDigest,epoch,sourceProvenance}` and resolvedProfile carries the pinned profilesDigest.
- `recordPendingUsageReceipt({dispatchId,receipt})`; `acknowledgeUsageReceipt({dispatchId,seq})` support strict external evidence writes without cached-journal mutation.
- `initializeWave({ref,profilesDigest})`; `recordPreparedCheckpoint(checkpoint)`; `markCheckpointPublished({gateToken,commit,evidenceReceiptId})`.
- `prepareIssuance(descriptor,envelope,{finalStage,itemBinding?,resolvedProfile?,ownership?})`; report the RETURNED envelope, including failure, and emit its findings.
- Existing `prepareMerge({gateStepId,gateToken,fanoutStepId,audit})` captures checkpoint ordinal/parent/epoch when enabled; `applyMerge(transaction)` retains the existing transaction/cancel fences.
- `recoverCheckpoint(transaction)` ONLY after confirmed durable gate approval; it prepares/publishes or reconciles that obligation without another task/gate invocation.
- `cleanupWorktrees(reason,{dispatchTokens?}={})`; configured checkpoint artifacts remain until publication AND evidenceReceiptId acknowledgement.
- `verifyConsumerRunRevision({...existingOptions,profilesDigest})`; `recoverAdvancedConsumerArtifacts({runId,targetCwd,artifactRoot,audit})` before resume dispatch/cleanup.

Skipped by scope: build/GSD/CLI wiring, full recorded-input resolution, external usageReport calls, human ceiling suspension, live provider calls, and preset/contracts remain dispatch 2+ work. No flow-state.js change is needed: helpers consume the supplied recorded snapshot. No dependency installation was requested or run directly; package-start.test.js itself invokes npm install into a disposable directory by design.

## Fixes r1
- #1: Exact-tip recovery restores only recorded prior witnesses through the temporary-index tree delta; preserves post-checkpoint edits, HEAD, branch and real index, including after payload cleanup. Test: `test/wave-checkpoint.test.js`, `r1 #1`.
- #2: Require a recorded waiting gate, matching nonempty token and current epoch evidence; missing/stale evidence holds. Test: `test/output-gate.test.js`, `r1 #2`.
- #3: Ignore `reviewOutput`; validate only the configured succeeded review state's recorded output. JSDoc updated. Test: `test/output-gate.test.js`, `r1 #3`.
- #4: Forward the configured execute entry/provider into admission; either absent holds `GATE_CONFIG_INVALID`. Test: `test/output-gate.test.js`, `r1 #4` (stage default, provider mismatch and missing options).
- Updated API: `decideGateFromOutput(config, stepOutputs, {gateStepId, gateToken, reviewOutput, ceiling, executeProfile, executeProvider})`; executeProfile/executeProvider are required, reviewOutput is ignored.
- All four new regressions failed before the fixes and passed afterward (4/4).
- Re-ran all three original reviewer probes (exit 0); legacy gate calls now correctly hold `GATE_CONFIG_INVALID` for missing execute options.
- Also ran `/tmp/slice3-d1-review-{probes,gates}-required-options.mjs` copies supplying required options (exit 0): every reproduction corrected; inspector confirmed Claude fast/Haiku admission; original probe scripts preserved.
- Probe evidence: `/tmp/d1-after-checkpoints.log`, `/tmp/d1-after-probes-required-options.log`, `/tmp/d1-after-gates-required-options.log`; all non-gate general probe results unchanged.
- No full-suite run, lib/build.js edit, or git commit.
- Requested five-file command: exit 0; 140 tests passed, 0 failed/cancelled/skipped, 3 suites, 95.415s. Log: `/tmp/d1-fix.log`.
