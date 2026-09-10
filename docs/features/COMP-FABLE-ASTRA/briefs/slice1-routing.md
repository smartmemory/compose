# Brief: COMP-FABLE-ASTRA slice 1 — routing

Repo: /Users/ruze/reg/my/forge/compose (Node ESM, `node --test`). Do NOT git commit. Do NOT run `npm install`.
Design: docs/features/COMP-FABLE-ASTRA/design.md — read "Revision note" item 1, "Roles, models and budget", and "Implementation slices" item 1. This brief is the implementation contract; the design is the why.

## Goal
Make the Claude side of tier routing current and fail-closed so a preset can route Fable (`claude-fable-5-1`) through the existing `claude` provider by tier, with no new connector.

## Changes (all MUST)

### 1. Claude tier table → Claude 5 family (`server/model-tiers.js`)
- `MODEL_TIERS`: `critical: 'claude-opus-5'`, `standard: 'claude-sonnet-5'`, `fast: 'claude-haiku-4-5-20251001'` (Haiku unchanged), and NEW `coordinator: 'claude-fable-5-1'`.
- `TIER_THINKING`: keep critical/standard/fast shapes; add `coordinator: { mode: 'adaptive', effort: 'high' }`. (Fable's thinking is always on; `{type:'adaptive'}` is the accepted form. Effort is the depth control.)
- `CODEX_MODEL_TIERS` / `CODEX_TIER_THINKING`: unchanged, EXCEPT add `coordinator` → resolves to `null` model (codex has no coordinator model). `resolveTierModel('coordinator','codex')` MUST return null, and a codex agent string with tier `coordinator` MUST be rejected by `validateAgentString` with a message naming the provider (see §2). Do not silently map coordinator to astra.
- Update the header comments: the table is the single source of truth; `coordinator` exists so exactly one preset role can name Fable while `critical` stays Opus 5 (no other preset silently moves to Fable).

### 2. Tier allow-list (`lib/agent-string.js`)
- `KNOWN_TIERS` must be DERIVED from the model table (`Object.keys(MODEL_TIERS)`), not a separate literal set — the design names the split as the defect. Export a `knownTiers(provider)` helper if you need one for the per-provider check.
- `validateAgentString`: unknown tier still throws; additionally `provider: 'codex'` + `tier: 'coordinator'` throws `Invalid agent string "...": tier "coordinator" is not available for provider "codex"`.
- Update the doc comment (`Tiers: critical | standard | fast | coordinator`).

### 3. Pricing tables
- `lib/model-pricing.js` MODEL_PRICING: add `'claude-fable-5-1': {10, 50}`, `'claude-opus-5': {5, 25}`, `'claude-sonnet-5': {2, 10}`. Keep the existing 4.x rows (receipts from old runs still price). Fix the "as of 2025" comment.
- `lib/experiment-pricing.js`: same three rows added, same rule.

### 4. Fail-closed sidecar + model preflight (`lib/build.js`)
Today `loadPipelineProfiles` (build.js:1227) returns `{}` on a parse error, and an unresolved model is omitted from the request so the connector picks a default. Close both, for every preset:
- `loadPipelineProfiles(specPath)`: a MISSING sidecar still returns `{}` (bare literals are legal). A sidecar that exists but fails to parse, or parses to a non-object, MUST throw `Error` with message `Profile sidecar <path> is invalid: <cause>` — no more swallow.
- NEW exported `preflightPipelineProfiles(stepProfiles, specYaml|parsedSpec)` (name yours; keep it a pure function, no I/O): for every step in the spec that has an `agent`, take its profile string (sidecar entry, else the bare agent literal), `validateAgentString` it, and `resolveAgentConfig` it. A profile with a tier whose model resolves to `null` is a failure. Sidecar keys that start with `_` (e.g. `_comment`, `_reduceSteps`) are metadata, not step profiles — skip them. A sidecar key naming a step that is not in the spec is a failure too (typo protection) — unless you find an existing preset relying on it; if so, say so in the report and warn instead. Return `{ ok: true, resolved: {stepId: {profile, provider, tier, modelID}} }` or throw one Error listing EVERY failing step (`Profile preflight failed for <spec>: step "x": ...; step "y": ...`).
- Call it in `build()` right after `loadPipelineProfiles` at build.js:2594 and BEFORE the flow is started with stratum (find the `stratum.plan`/flow start call and make sure the preflight precedes it — a failed preflight must start no flow and dispatch no agent). Also apply to `runtimeProfiles` (build.js:3184 `effectiveProfiles`) if the merge happens before the flow starts; if runtime profiles are applied later, preflight the merged map at that point and say which in the report.
- Emit the resolved map to the build stream as one event `{ type: 'profile_preflight', steps: resolved }` so the run record shows every step's model before dispatch (design completion-evidence item 3 reads it).
- A profile with NO tier (e.g. `claude:orchestrator`) is fine — modelID null means "connector default", which is the existing documented meaning; only a tier that resolves to null fails. Document that distinction in the function comment.

### 5. Tests (node --test, real modules, no mocks of the code under test)
- `test/model-tiers.test.js`: update expectations to the Claude 5 table; add coordinator cases (claude → fable, codex → null); thinking config for coordinator.
- `test/agent-string.test.js` (create if absent): KNOWN_TIERS derived (coordinator accepted for claude), codex+coordinator rejected with the provider-naming message, unknown tier message lists coordinator.
- `test/model-pricing.test.js` + experiment pricing: new rows price correctly, prefix match still works for dated variants.
- NEW `test/profile-preflight.test.js`: invalid-JSON sidecar throws with path; missing sidecar → {}; preflight passes every bundled preset in `presets/` and `templates/` (whatever dir holds *.stratum.yaml + *.profiles.json — find them: `find . -name '*.profiles.json' -not -path '*/node_modules/*'`) — this is the guard that the tightening breaks no shipped preset; unknown tier fails naming the step; codex coordinator fails; metadata keys skipped; stale key fails (or warns, per §4).
- A build-level test proving no flow starts on preflight failure: find the existing build golden that uses the fake stratum client (grep test/ for `fake-stratum` / `createFakeStratum` / `stratum-mcp-client` stubs) and add a case: sidecar with `claude::bogus` → build rejects with the preflight message and the fake client records zero `plan`/flow-start calls.
- Grep `test/` for hard-coded `claude-opus-4-7` / `claude-sonnet-4-6` expectations that encode the TIER table (not pricing of old receipts) and update those only. Leave settings-store/agent-workspace defaults (`claude-sonnet-4-6` interactive default) alone — out of scope, note it.

### 6. Docs, same change set
- `CHANGELOG.md`: one entry under Unreleased for COMP-FABLE-ASTRA slice 1 (tier table, coordinator tier, fail-closed sidecar, preflight event).
- `docs/cli.md` or wherever tiers/profiles sidecar are documented (grep `profiles.json` and `critical` in docs/): update the tier list and state the fail-closed rule.

## Gate
- `node --test --test-timeout=90000 test/model-tiers.test.js test/agent-string.test.js test/model-pricing.test.js test/profile-preflight.test.js <the build golden you touched> > /tmp/s1.log 2>&1; echo $?` must be 0. Paste the pass/fail counts in the report.
- Then run the full node suite once: `RESEND_API_KEY= STRIPE_API_KEY= npm test > /tmp/s1-full.log 2>&1; echo $?` — report the counts and every failure with its cause. (Baseline before you start: all green at e79cc2d — node 6606.) Note: the sandbox cannot bind ports or run `ps`; name any test that fails for that reason so the controller re-runs it on the host.

## Report
Write `docs/features/COMP-FABLE-ASTRA/reports/slice1-routing-impl.md`: files changed, the decision on stale sidecar keys, where the preflight sits relative to flow start (file:line), test counts, anything you could not do and why. Keep it under 80 lines.
