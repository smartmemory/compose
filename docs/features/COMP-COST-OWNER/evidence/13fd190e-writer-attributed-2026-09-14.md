# `13fd190e`'s ledger-only row: `abortBuild` wrote it. Proven by the execution log. Cost: $0.

**2026-09-14.** Open since Part B (2026-09-13): two paths write a `build-actuals` ledger row
and no `build-history` row, and which one produced `13fd190e`'s `aborted` row was undetermined.
Traced by a Codex astra/medium read-only forensics pass; adjudicated by the controller.

## Verdict: `abortBuild`. And the counter-evidence against it was unsound.

The contemporaneous session transcript
(`~/.claude/projects/-Users-ruze-reg-my-forge/efe39976-….jsonl:326`, **2026-08-30 07:03:52.255Z**)
records one command sequence: a driver kill (`pkill -9`), then
`cost-census.mjs 13fd190e-… COMP-SEMVER-STRICT .`, then
`node bin/compose.js build COMP-SEMVER-STRICT --abort`. Its result (`:328`, **07:03:56.601Z**)
shows the census at 36,354 tokens, the flow `status running`, and then:

```
=== abort
Aborting build for COMP-SEMVER-STRICT...
Build aborted.
```

Between command and result, `dispatch-ledger.jsonl:103` records **07:03:56.455Z**,
`build_id 1db4350e…`, `aborted`, 36,354 tokens, $4.503714449999999. History (`:9`) holds only
the earlier `failed` segment.

**Historical value trace** at the checkout the log names (`44e54cf`, `lib/build.js` unmodified):
`abortBuild` reads `active` (`:5710`), reads the accumulator by `active.featureCode` (`:5749`),
passes it with literal `'aborted'` to `emitBuildActuals` (`:5751`), prints the observed
"Build aborted." (`:5753`). It never calls `appendBuildHistory`.

## Why `status: running` did NOT eliminate `abortBuild`

Part B reasoned: "`abortBuild` reaches its ledger write only after `cancelAbortFlow` reports
the flow settled, so a flow still `running` rules it out." **That guard did not exist on
2026-08-30.** The settlement requirement arrived in `d0a07c1` (2026-09-10). The August
`abortBuild` only called `stratum.audit` (`:5729`), logged the status, swallowed audit
failures, and proceeded to local cleanup — it never cancelled the flow. Applying September's
code to an August event was the error. (`active-build.json:87` also carries a 2026-09-09
completion timestamp, so it cannot independently date this abort.)

## Candidate 2 (`terminalizeThrownBuild` `!flowId` bail) eliminated for this row

The persisted `build_resume` event (`.compose/build-stream.jsonl:12`) carries `response.runId`,
written from `:2944` after assignment at `:2778` — the resume had the id, so the bail could
not have fired. Also, the historical throw path set `buildStatus = 'failed'` (`:4871`); the
cancellation override that would yield `aborted` came later.

## The three `finalizeBuildAttempt` exits — none produces actuals-without-history

| Exit | Verdict | Proof |
|---|---|---|
| `suspended` | No | set at `:6060`, then the waiting-gate return; `:3496` returns BEFORE actuals when uncancelled, and the exit is not taken when cancelled. Did not exist at `44e54cf`. |
| `alreadyEmitted` | No new row | computed from an existing ledger row + reuse flags (`:3528-3530`); `!alreadyEmitted` gates emission at `:3531-3532`. Says nothing about whether the earlier row has history. |
| `attemptFinalized` | No new row | init false `:3465`, set true after finalization `:3534` or on error `:6674`; read at `:3496` to return. Any gap belongs to the preceding execution. |

## Corrections to prior evidence

- `part-b-abort-path-2026-09-13.md` §"Two such paths exist… NOT determined" — determined.
  The `running` counter-evidence and the candidate-2 alternative applied post-`d0a07c1` code
  to a pre-`d0a07c1` event.
- `design.md` open question 0b repeats those claims — amended at origin, same date.

## Not established

- The writers of the other three ledger-only amounts ($4.0245686 `fbf89460`, $6.9341944
  `678e6a58`, $18.9300601 `f9309dc4`). Same method applies: find the contemporaneous
  transcript line, name the checkout, trace that checkout's code.
- Whether TODAY's `abortBuild` (post-`d0a07c1`) still emits actuals with no history row. By
  construction it still never calls `appendBuildHistory`, so yes in shape — but this doc proves
  the August event, not the September code. Falsifier: `grep -n appendBuildHistory lib/build.js`
  still returns two sites, neither in `abortBuild`.

No fix proposed, per the design's standing rule: a third history writer is the shape this
feature has deleted three times.
