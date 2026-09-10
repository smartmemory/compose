# Slice 1 routing — adversarial review r1

Reproductions use the retained [probe harness](/tmp/slice1-review-r1-probe.mjs): real `runBuild` and TS Stratum engine, disposable `makeFakeCodexProject` fixtures, stubbed inference except the fake Codex executable used to capture actual connector arguments. No production edits or commits.

## 1. P1 — Multi-stage runtime profiles overwrite an invalid earlier tier

Location: `lib/build.js:2928-2930`, `lib/build.js:1284-1285`; producer/lookup: `lib/stratum-mcp-client.js:131`, `lib/build.js:3468`.
Two consumer stages reference implementer and reviewer inputs. With `implementer: 'claude::bogus'`, `reviewer: 'codex::critical'`, both profiles collapse onto `fan`; the reviewer overwrites the invalid implementer before validation. The stage-indexed preflight entries do not preserve distinct invocation profiles.
Reproduce: `node /tmp/slice1-review-r1-probe.mjs multi-invalid`
Observed: `Build complete.`; `error:null`; preflight records **both** `fan/0` and `fan/1` as `codex::critical` / `gpt-6-astra`; actual fanout calls are `{"agent":"claude","model":"gpt-6-astra"}` then `{"agent":"codex","model":"gpt-6-astra"}`. The invalid tier never raises an error, and Claude receives a Codex model.
The valid-tier control (`node /tmp/slice1-review-r1-probe.mjs multi-valid`) likewise loses the requested Fable model to Astra.
Fix: Preserve and validate each stage's full runtime profile under a stage-specific key, and resolve that same key at invocation before falling back to the enclosing sidecar profile.

## 2. P1 — An implicit-agent fanout bypasses unavailable-tier validation

Location: `lib/build.js:1278-1285`.
A valid consumer fanout stage may omit `agent` and inherit Claude. An enclosing sidecar entry is then neither checked as an ordinary step nor checked in the stage loop, although invocation still consumes it.
Reproduce: `node /tmp/slice1-review-r1-probe.mjs implicit-fan`
Fixture: one `isolation: none` consumer stage with `do`/`out` but no `agent`; sidecar `{"fan":"codex:x:coordinator"}`.
Observed: `Build complete.`; `error:null`; the `profile_preflight` map omits `fan`; its actual invocation is `{"agent":"claude","model":null}`. An explicitly unavailable tier reaches dispatch with the model omitted.
Fix: Validate an enclosing sidecar profile for every fanout stage that consumes it, including stages without an explicit `agent`.

## 3. P1 — Engine fanout ignores the model certified by preflight

Location: `lib/build.js:1281-1285`, `lib/build.js:2930`, `lib/build.js:3240`.
Preflight accepts a tiered sidecar for `dispatch: engine`, but that fanout invokes its connector inside Stratum, bypassing Compose's `resolveStepProfile`/model binding.
Reproduce: `node /tmp/slice1-review-r1-probe.mjs engine-fan`
Fixture: Codex stage, `dispatch: engine`, `isolation: none`, sidecar `{"fan":"codex::critical"}`; the real connector launches the fixture's fake `codex`.
Observed: `error:null`; preflight records `fan.modelID:"gpt-6-astra"`; the fake executable's **fanout** argument receipt contains `"exec","--experimental-json","--model","gpt-5.6-terra"`. The actual model is the connector default, not the validated tier.
Fix: Reject tiered profiles on engine-dispatched fanouts until their resolved model is transported into engine-owned invocation, or require consumer dispatch for those profiles.

## 4. P2 — Resume validates the edited local spec instead of the persisted flow

Location: `lib/build.js:2928-2930`, `lib/build.js:2944`; the revision guard at `lib/build.js:3019` only protects runs with a consumer journal (`lib/consumer-fanout.js:1324`).
An ordinary flow planned with `work.agent: $.input.implementer_agent` and persisted `implementerAgent: 'claude::critical'` can resume after the local step is changed to bare `claude`. Refreshing from that edited file erases the runtime profile even though the engine resumes its original flow.
Reproduce: `node /tmp/slice1-review-r1-probe.mjs resume-spec-change`
Observed: `honoring the persisted role over the current invocation's flag.` followed by `Build complete.`; preflight reports `work.profile:"claude", tier:null, modelID:null`; the actual resumed call is `{"agent":"claude","model":null}`. Persisted critical routing silently becomes the connector default.
Fix: Persist the effective routing/spec with every flow and use it on resume, or reject ordinary-flow spec drift before rebuilding the profile map from local files.
