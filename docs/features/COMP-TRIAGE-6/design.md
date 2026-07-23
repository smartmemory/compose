# COMP-TRIAGE-6 — Dispatch Scorekeeping

**Status:** DESIGN — GATE CLOSED (3 codex sol/high rounds 2026-07-23; rounds 1–2 applied in full, round-3 findings adjudicated + applied, budget-closed per review-loop policy)
**Date:** 2026-07-23
**Parent:** COMP-TRIAGE-5 (E3 front triage — COMPLETE)
**Origin:** Owner directive 2026-07-23: "we don't know till we have adequate measurement over time." Routing across model×effort is guess-based until per-dispatch outcomes are measured. This feature builds the measurement half TRIAGE-5 deferred (its report explicitly defers ACRR and review-gate signals).

## Problem

Compose dispatches agents constantly (build steps, consumer fanouts, review loops, GSD, gates, escalations) and throws the receipts away. Concretely (research pass, 2026-07-23, file:line anchors in blueprint):

- `runAndNormalize()` accumulates tokens/USD/model per dispatch, returns them to the caller — nothing persists per-dispatch; only aggregate per-feature counters survive (`budget-ledger.js`).
- **Effort is never recorded.** `resolveAgentConfig()` derives `{modelID, effort}` per profile/tier, but only `model` crosses the wire; no record anywhere says which effort tier a dispatch ran at. The model×effort cost curve is unmeasurable today.
- `runAgentText()` and the review-repair path discard usage entirely; GSD's stream writer is a no-op.
- Triage estimates persist `tier/lane/profile/estimateSource` but **not `confidence`** or rationale, and nothing links an estimate to realized outcomes — ACRR (estimate-vs-actual accuracy) has no data to run on.
- Actuals exist but are scattered: build history holds terminal test_count/pass_rate (success path only), review results hold clean/findings, retries are visible but undercounted for child flows (`experiment-metrics.js` documents this).

## Goals (v1)

1. **Dispatch ledger** — one append-only JSONL event per agent dispatch, captured at the connector seams every dispatch flows through, including intended AND executed effort.
2. **Estimate/actual pairing for ACRR** — persist triage confidence; write one estimate event when a build resolves its triage (fresh, cached, or escalated) and one actuals event at terminal build state (success AND failure paths), paired by a resume-durable build_id.
3. **Aggregation view** — a pure reader that renders the model×effort table (dispatch count, median tokens, median duration_ms, completion rate, acceptance rate, retry rate, USD) and per-feature estimate-vs-actual rows; CLI `compose metrics` with `--json`.

## Non-Goals (v1)

- **No routing changes.** Data first; the router keeps guessing until the curve is real.
- **No stratum wire changes.** Nothing new is SENT to stratum. Executed effort is captured from what stratum already RETURNS: the `stratum_agent_run`/`stratum_agent_poll` complete responses carry `telemetry: {durationMs, model, effort?}` (frozen surface, `contracts/mcp-surface.json`). Forwarding compose-resolved effort onto the wire so claude runs execute it remains a stratum follow-up.
- **No UI dashboard**, no backfill of historical `~/.stratum/ts/agent_runs`, no cross-repo ledger. Single repo, forward-looking only.
- **No new metric science.** ACRR v1 = was the estimated lane the realized lane, with the realized-lane function and its counter sources specified below — deterministic, documented, replaceable.

## Design

### D1 — `lib/dispatch-ledger.js` (new)

Follows the `feature-events.js` idiom (`appendEvent(cwd, event)` — the ledger, like feature-events, is addressed by an explicit project root, never ambient cwd): `appendEvent(projectCwd, event)` stamps the envelope and appends one JSON line to `<projectCwd>/.compose/data/dispatch-ledger.jsonl`; tolerant reader `readEvents(projectCwd, {kind, since, feature})` skips malformed lines. No rewrite-in-place (the idempotency cache's cap-and-rewrite is explicitly not the pattern).

**Envelope + discriminated union.** Every row is `{v: 1, kind, ts, _seq, ...payload}`. The envelope fields (`v`, `kind`, `ts`, `_seq`) are declared once and stamped by the writer; the per-kind payload shapes below are closed — at write time an unknown payload field is a validation error, while the reader skips unknown `kind`s and tolerates unknown fields (old readers must survive new writers).

**`kind: 'dispatch'`** — one per agent dispatch:

```
payload: { dispatch_id, build_id?, feature_code?, site,
  agent, model?, effort_intended?, effort_executed?,
  tokens_in?, tokens_out?, tokens_total?, usd?, duration_ms?,
  attempt?, outcome, step_id?, note? }
```

- `model` is nullable: connector failures before telemetry (MCP disconnect, empty response, parse error) can't identify the executed model, and `runAgentText()` callers may pass no override. Metrics bucket null-model rows under an explicit `(model: unknown)` row, never merged.

- `dispatch_id`: fresh uuid minted by the capture owner; carried into the settlement event (see carrier contract in D2).
- `site` enum: `build-step | consumer | review | review-repair | gsd | gate-qa | escalation | preflight | judge | design-chat | import | validation | new-project | unattributed`. `unattributed` is real and countable — a dispatch whose caller supplied no telemetry context; the metrics view surfaces the unattributed count so coverage gaps are visible, not silent.
- `outcome` enum: `ok | error | blocked` — **connector-level** outcome only (the run completed / errored / was blocked). Whether the work was ACCEPTED is the settlement event's job; the two are deliberately separate because `runAndNormalize()` returns before ownership/vocabulary checks and before `stepDone()` adjudicates.
- `effort_intended`: what `resolveAgentConfig()` resolved for the dispatch (a label — today it does not cross the wire on either route: `buildAgentRunRequest` drops it, `runLocalClaudeAgent` forwards only `thinking`).
- `effort_executed`: taken from the stratum response `telemetry.effort` when present (codex runs report it today); absent means honestly unknown, never copied from intended.
- **All usage fields are nullable for ANY outcome where the connector reported no usage** — an `error`/`blocked` dispatch that died before telemetry (MCP disconnect, tool error) still writes a valid record with null tokens. Metrics exclude null-token rows from token medians and report their count.

**`kind: 'settlement'`** — one per adjudicated dispatch in the build-loop step flow (GSD excluded in v1, see below):

```
payload: { dispatch_id, build_id?, step_id?, accepted, failure_class? }
```

- Written in build.js at the step-loop `stepDone()` seam, ONLY when the step's result came from an agent dispatch this attempt. `stepDone()` calls with no backing dispatch (intercepted ship, resumed/replayed steps) write no settlement.
- **GSD settlements are explicitly OUT of v1.** GSD's `stepDone()` calls are engine-adjudicated too (`gsd.js:568` sends both failure and output envelopes), but instrumenting its separate step loop is deferred: GSD dispatches get `dispatch` events (completion rate, tokens, effort) with no acceptance signal, and the metrics view labels GSD's acceptance column `n/a (not instrumented)` rather than showing a misleading blank. Filed as a follow-up.
- **`accepted` is decided from the (submitted envelope, stepDone response) pair, not the envelope alone:** a failure envelope → `accepted: false` with its class (`ownership | vocabulary | normalization | agent`); an output envelope answered by a fresh issuance of the same step (`previousFailure` reissue — contract/ensure rejection) → `accepted: false, failure_class: 'ensure-retry'`; an output envelope that advances the flow → `accepted: true`.
- When review-repair replaced the primary dispatch's output, TWO settlements are written: the primary settles `{accepted: false, failure_class: 'normalization'}`, and the repair dispatch settles from the stepDone outcome.

**`kind: 'triage-estimate'`** — one per build, written when `runBuild()` resolves the triage profile (all three resolution paths — see D3):

```
payload: { build_id, feature_code, tier, lane, profile, confidence?, estimate_source }
```

- `estimate_source` enum: `fresh | cached | escalated` — an escalated lane is a human/system correction, not an original prediction; ACRR reports it as its own row rather than crediting the estimator.
- `confidence` is null for cached features triaged before this feature shipped (the field didn't exist); never backfilled or guessed.

**`kind: 'build-actuals'`** — one per build reaching ANY terminal state:

```
payload: { build_id, feature_code, terminal_status,
  files_changed_count, test_count?, pass_rate?, review_iterations,
  escalations, tokens_total, usd }
```

- `terminal_status` enum: `complete | failed | aborted`. `test_count`/`pass_rate` stay null when the build died before tests.
- Counter sources are specified in D3 (they come from the persisted build accumulator, not ad-hoc reads).

### D2 — Capture seams: one owner, context threaded (modify, no behavior change)

**Single capture owner at the connector chokepoints every dispatch flows through:**

1. A shared private dispatch helper inside `StratumClient` that BOTH `agentRun()` and `runAgentText()` route through (today each calls `#callTool('stratum_agent_run', …)` independently — `stratum-mcp-client.js:510` and `:533`; the refactor makes the text path a thin wrapper over the same helper so gate-Q&A/preflight/escalation dispatches hit the owner). Covers every stratum-routed dispatch, including the experiment judge's direct `stratum.agentRun()` call (`experiment-judge.js:120-136`) that bypasses `runAndNormalize()` entirely.
2. `runLocalClaudeAgent()` (`lib/local-claude-connector.js`) — covers the local-Claude route (fullest telemetry today).

Because higher layers no longer write their own dispatch records, there is exactly one record per dispatch by construction — no deduplication protocol needed.

**Correlation context is threaded, not inferred.** Both seams accept an optional `telemetry: {site, project_cwd, build_id, feature_code, step_id, attempt, effort_intended}` field in their existing options bag:

- **`project_cwd` addresses the ledger** — the compose project root (`runBuild()`'s `cwd`), never the connector's `opts.cwd`, which for consumer/worktree dispatches is an isolated `agentCwd` where a ledger line would be lost (build.js distinguishes the two around `:1612`). A dispatch with no `project_cwd` writes to `process.cwd()` and is marked `unattributed`.
- `runAndNormalize()` threads its full context (it already holds step id, attempt, profile, the resolved config with effort, and receives the project cwd from its caller).
- The named `runAgentText()` call sites — gate Q&A (`build.js:1394`), preflight (`codex-preflight.js:113`), escalation (`bug-escalation.js:103`) — and the judge (`experiment-judge.js`) are updated to pass their site + whatever correlation they have.
- **GSD passes context at its dispatch call sites** — the direct `agentRun()` call (`gsd.js:568`) and the fanout's `runAndNormalize()` invocation (`gsd.js:1414`) supply `site: 'gsd'` in the options bag. (`recordTsAgentUsage()` runs only AFTER dispatch and receives only usage — it cannot be the context carrier; it stays untouched.)
- A dispatch arriving with no context is recorded as `site: 'unattributed'` rather than dropped — visible in metrics, fixable by instrumenting the missed caller.

**`dispatch_id` carrier contract (capture → settlement):** the capture owner mints `dispatch_id` and attaches it to what it returns — on success, a non-enumerable `dispatchId` property on the result object; on failure, the same property on the thrown error. **The id must survive every wrapper:** `runAndNormalize()` copies `dispatchId` onto each error it wraps or synthesizes (the timeout/abort/agent errors it constructs around `:462` currently replace the connector error wholesale) AND onto synthetic failure results, so failure envelopes reaching `stepDone()` still settle. On its normalized return it propagates `dispatchIds: {primary, repair?}` (repair present when the internal review-repair dispatch produced the surviving output). build.js settles per the settlement rules in D1 using those ids.

Capture must never throw into the dispatch path (wrap in try/catch, drop on error — a lost receipt must not fail a build).

### D3 — ACRR events

**Resume-durable `build_id` + build accumulator.** `runBuild()` currently mints a fresh id per invocation, so a resumed build would split its estimate and actuals across ids. Instead: the build_id and its counters live in a per-feature sidecar (`.compose/data/build-accumulator/<feature>.json`, same sync discipline as the stepHistory sidecar).

**Build-identity lifecycle (resume-safe, append-only):**

- **Init:** a build with no accumulator sidecar (or one whose last terminal was `complete`/`aborted`) initializes fresh — new `build_id`, zeroed counters, and emits the `triage-estimate` event. A resume of a `failed` build reads and reuses the sidecar — same `build_id`, counters continue, **no second estimate is emitted** (the reader pairs one estimate with terminals by build_id).
- **Terminal events are append-only observations; the LAST one wins.** A `failed` build that is later resumed to completion legitimately produces a `failed` actuals row and then a `complete` one under the same build_id. The pairing rule is deterministic: per build_id, the terminal event with the highest `_seq` is authoritative for ACRR; earlier `failed` rows are the build's attempt history and feed the attrition count as failed ATTEMPTS. Duplicate terminal writes are therefore harmless by construction — no dedup flag needed.
- **Finalization:** only `complete` clears the accumulator; `failed` preserves it for resume. `abortBuild()` (`build.js:3458`) bypasses `runBuild()`'s finalization entirely, so the abort seam itself appends the `aborted` actuals from the persisted sidecar and clears it — abort is final, never resumed into.

- **Estimate emission and terminal accounting share one finalization boundary.** Estimate emission moves OUT of `applyFrontTriage()` and into `runBuild()` at accumulator init — the reuse branch (`build.js:1745`, cached profile), the escalated branch (`estimateSource === 'escalated'`), and the fresh-triage branch all converge there, so cached and escalated builds emit estimates too. From that point on, ALL `runBuild()` exits (including early failures like missing lifecycle spec, which today error before the terminal try/catch) pass through one outer try/finally that writes the actuals event with the appropriate `terminal_status` — an estimate can never be left permanently unpaired by an early error.
- `applyFrontTriage()` still gains the `triageConfidence` persistence to feature.json (schema + `validateFeatureFields` extension) so confidence survives the cache round-trip.
- `lib/dispatch-metrics.js` pairs estimate/actuals by `build_id` and computes ACRR.

**Counter definitions (deterministic sources, persisted in the accumulator):**

- `review_iterations` — incremented once per review-gate revise cycle (the seam that stashes `lastReviewMergeResult` and routes a dirty verdict back to the fixer). Not inferred from dispatch counts.
- `escalations` — incremented once per lane-escalation applied during this build_id (including the ship-time escalation result, which today is computed but not retained in any accumulator).
- `files_changed_count` — unique paths from the ship-time authoritative changed-file list when ship ran; otherwise (failed/aborted builds) unique paths accumulated in `context.filesChanged`. The source used is recorded in the event (`files_source: 'ship' | 'accumulated'`) so consumers know the fidelity.

**Realized-lane function (v1, deterministic, replaceable).** Lanes use the existing triage vocabulary (`trivial | standard | complex`, `lib/triage.js`). First matching rule wins:

1. `complex` — if `escalations ≥ 1` OR `review_iterations ≥ 3` OR `files_changed_count ≥ 6`
2. `trivial` — if `files_changed_count ≤ 2` AND `review_iterations ≤ 1` AND `escalations = 0`
3. `standard` — otherwise

**ACRR eligibility:** only builds with `terminal_status: 'complete'` enter ACRR (a build that died before review/tests has censored actuals — zero review iterations from failure is not the same signal as zero from a clean run). `failed`/`aborted` builds are reported as an attrition count alongside ACRR, never folded into it. Rows with `estimate_source: 'escalated'` are reported separately (accuracy of the correction, not the estimator).

### D4 — `lib/dispatch-metrics.js` (new) + CLI

Pure reader over the ledger (no writes). `compose metrics [--json] [--since <date>] [--feature <code>]` in `bin/compose.js`, following the existing subcommand pattern. Renders:

- **model×effort table** keyed on `(model, effort_executed)` — rows where `effort_executed` is absent aggregate under an explicit `(intended: X, executed: unknown)` bucket, never merged into executed rows. The curve the router will eventually consume is the executed-effort curve only.
- Per-site totals, including the `unattributed` count and the null-usage count (coverage gauges).
- **Completion rate** (connector `outcome: ok`) and **acceptance rate** (settlements with `accepted: true` / settled) as separate columns — never a single "success rate".
- ACRR summary + attrition count + escalated-row breakout per D3.
- Known-incomplete signals render with an explicit marker (retry undercount for child flows) rather than silently wrong numbers.

## Risks / constraints honored

- **Feature-writer fixed-point guard**: the new feature.json field goes through `validateFeatureFields` + schema, not ad-hoc writes.
- **GSD no-op stream writer**: untouched; GSD context rides the dispatch options bag at its call sites.
- **Token caps on MCP returns**: `compose metrics` is CLI/JSON only; no MCP tool in v1 (avoids the add_roadmap_entry oversized-return class).
- **Ledger growth**: append-only JSONL, one line per event (~300 bytes); thousands of dispatches ≈ single-digit MB. Rotation is a non-problem at current scale; revisit if it ever isn't.

## Acceptance criteria

- [ ] Every dispatch through the shared StratumClient helper (`agentRun()` AND `runAgentText()` routes) or `runLocalClaudeAgent()` leaves exactly one `dispatch` event — including the judge's direct `agentRun()` path and review-repair (today: both dropped)
- [ ] `dispatch` events record `effort_intended` (when the caller resolved one) and `effort_executed` (from response telemetry when reported); the two are never conflated
- [ ] Error/blocked dispatches with no reported usage still write valid events (null usage fields); metrics count them separately
- [ ] Ledger lines land in the PROJECT root's `.compose/data/` even for worktree/consumer dispatches (test: agentCwd ≠ project_cwd)
- [ ] Uncontextualized dispatches surface as `site: 'unattributed'`, not dropped; metrics show the count
- [ ] `settlement` written only for dispatch-backed `stepDone()` calls; an ensure-retry reissue settles `accepted: false`; a repair-replaced primary settles separately from the repair
- [ ] `build_id` survives resume (test: estimate before kill, `failed` actuals, resume, `complete` actuals — ACRR pairs the estimate with the LAST terminal; the failed row counts as a failed attempt); accumulator counters persist with it; abort writes its own terminal via the abort seam
- [ ] `triageConfidence` persisted; estimate events emitted on ALL three triage-resolution paths (fresh, cached, escalated) with `estimate_source`; actuals events written on success AND failure/abort terminals with `terminal_status` — including failures before the lifecycle spec loads
- [ ] `compose metrics` renders the model×effort_executed table, completion vs acceptance columns, and ACRR (with attrition + escalated breakout) from a seeded ledger fixture; `--json` output is schema-stable
- [ ] Writer validates events against the closed per-kind shapes; reader tolerates torn/malformed lines and unknown kinds (test: corrupt fixture)
- [ ] Capture failure (e.g. unwritable ledger) never fails a build (test: EACCES injection)

## Follow-ups filed, not built

- GSD settlements: instrument GSD's own `stepDone()` loop so its dispatches gain acceptance outcomes (v1 shows `n/a (not instrumented)` for GSD acceptance).
- Stratum: forward `effort` on the `stratum_agent_run` wire so claude-route dispatches EXECUTE the resolved effort (today only codex runs report executed effort via response telemetry).
- Compose: pass `effort` through the local-Claude SDK options (the SDK supports it for Opus/Sonnet) — a behavior change deliberately excluded from v1's data-only scope.
- Backfill from `~/.stratum/ts/agent_runs/*/meta.json`.
- Routing integration: feed the measured curve back into `resolveAgentConfig` defaults (the actual "optimize" step — needs data volume first).
