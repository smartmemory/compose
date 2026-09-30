# COMP-PROVIDER-FALLBACK-1 — Single-subscription vendor fallback

**Status:** PLANNED — design, not approved for implementation · **Created:** 2026-09-30 · **Complexity:** L

**Review history:** round 1 (Codex `gpt-6-astra/medium`, 2026-09-30, [review-r1.md](review-r1.md)): NOT CLEAN, 7 findings, all accepted. Round 2 (Codex `gpt-6-astra/medium`, 2026-09-30, [review-r2.md](review-r2.md)): NOT CLEAN, 4 findings, all accepted. Round 3 (Codex `gpt-6-astra/medium`, fresh session, 2026-09-30, [review-r3.md](review-r3.md)): NOT CLEAN, 1 finding (Path B slot allocation on resume), accepted. Resolutions for all rounds are mapped in [revision-r1.md](revision-r1.md). Round 4 (Codex `gpt-6-astra/medium`, fresh session, narrow confirm, 2026-09-30, [review-r4.md](review-r4.md)): NOT CLEAN, 1 finding (auxiliary parent not resume-stable), resolved by a scope cut. Round 5 (Codex `gpt-6-astra/medium`, fresh session, final narrow confirm, 2026-09-30, [review-r5.md](review-r5.md)): **REVIEW CLEAN**.

## Related Documents

- Feature record: [feature.json](feature.json)
- Tier source: [STRAT-CONFIG-MODELS-1](../../../../stratum/docs/features/STRAT-CONFIG-MODELS-1/design.md) — shipped catalog `stratum/ts/src/config/models.default.toml`, compose client `lib/model-catalog.js`, tier adapters `server/model-tiers.js`. The fallback mapping is added to that catalog (D4).
- Recording rules: [COMP-MODEL-ROUTE](../COMP-MODEL-ROUTE/design.md) (PARTIAL) — immutable start record, root-bound journal, resume never re-resolves. It excludes provider switching; D7 here is how a swap coexists with it.
- Blocker for Codex-only users: [COMP-CODEX-PROVIDER-1](../COMP-CODEX-PROVIDER-1/design.md) (PLANNED, L). See D9.
- Evidence: [COMP-HOST-PORTABILITY-1 report](../COMP-HOST-PORTABILITY-1/report.md) (measured "Not logged in" rows, gaps G5 and G7); [connector-diff audit](../COMP-HOST-PORTABILITY-1/audit/connector-diff.md) (measured invalid-model texts).
- Prior art in code: `lib/codex-preflight.js` (COMP-CODEX-IMPL worktree probe); `providerFailureClass` in `lib/local-claude-connector.js:57-87`.

---

## Why

Compose assumes two vendors. `compose build` defaults to a Claude implementer and a Codex reviewer
(`lib/build.js:2251`, `:4170-4171`, `startFresh` `:7615-7616`). Some steps and presets name one
vendor outright. A user who pays for only one vendor hits a failure on the first step that needs
the other one. Today that failure ends the run. Nothing checks which vendors the user has, and
nothing tells "you are not logged in" apart from any other error.

Owner decisions (2026-09-30, binding):

1. **Detection is "try it, swap on failure".** There is no startup probe and no required setting.
   When a step fails *because the user lacks that vendor*, redo it on the other vendor.
2. **Single-vendor review uses the same vendor, a stronger model, and a fresh session.** The run's
   provenance and final summary say plainly that review was single-vendor, never cross-vendor.

A naive "swap on any failure" is ruled out by the 2026-09-30 incident. `gpt-6.1-sol` failed with
`400 invalid_request_error: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."`
The cause was an old codex CLI, not a missing subscription. A swap would have quietly moved the work
to Claude and hidden the real fix.

## Prior art checked (2026-09-30)

- `ls compose/docs/features | grep -iE 'provider|fallback|vendor|model|auth'` returns COMP-AGENT-VENDOR-1 (agent definition install, unrelated), COMP-CODEX-PROVIDER-1, COMP-MODEL-AB, COMP-MODEL-ROUTE(-1/-2), COMP-ROADMAP-PROVIDERS and COMP-TRACKER-PROVIDER. None of them covers vendor availability.
- **Error classification exists, but it does not cover auth.** `providerFailureClass` (`local-claude-connector.js:57-87`) sorts errors into `prompt-too-long`, `rate-limited` and `other`. `build.js:1874-1890` acts on those classes: it suppresses a retry after prompt-too-long and backs off after rate-limited. Stratum raises plain `Error(message)` with no code (`codex.ts:448`, `claude.ts:207`). Devin checks for credentials before it spawns (`devin.ts:86`, `"devin is not logged in (run \`devin auth\`)"`), but that result only reaches the user as text.
- **Existing availability checks.** `bin/compose.js:140-165` `detectAgents` looks for `which claude` / `~/.claude` and `which opencode` / `~/.codex`, and uses the answer only to pick skill install directories. `lib/codex-preflight.js` is a worktree-write probe that runs only when the implementer is Codex (`build.js:4549`). It caches only `ok: true` (`codex-preflight.js:97-98`), so a failed probe is not remembered from one run to the next.
- **Stratum already surfaces the codex exit-0 400.** `codexErrorMessage` (`codex.ts:526-546`) reads `{"type":"error"}` records and the `ERROR:` line on stderr, and `codex.ts:447-448` throws even when the exit code is 0. The raw-CLI problem "exits 0 after an API 400" is therefore already handled at the connector. It still matters for anyone running `codex exec` by hand.
- **Codex binary presence tells us nothing.** `bundledCodexCommand` (`codex.ts:675-686`) uses the SDK-bundled codex before the one on PATH. A Claude-only user therefore still has a codex binary, and their failure is a 401, not ENOENT.

### Signals probed for this design (2026-09-30, this machine)

| Vendor state | Probe | Observed |
|---|---|---|
| Codex logged out | `env -u OPENAI_API_KEY CODEX_HOME=<empty> codex exec --json --skip-git-repo-check "say hi" </dev/null`, codex-cli 0.159.0 | 5 WebSocket and 5 HTTPS reconnect `error` records, then `turn.failed` `"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses…"`, exit 1, after about 15 s |
| Claude logged out | `env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=<empty> claude -p "say hi" --output-format json`, Claude Code 2.1.285 | exit 1 after 250 ms; result `{"is_error":true,"subtype":"success","result":"Not logged in · Please run /login","terminal_reason":"api_error","api_error_status":null}` |
| Claude logged out, through Compose | measured in COMP-HOST-PORTABILITY-1 `report.md:56-59` | `Claude Code returned an error result: Not logged in · Please run /login` |
| Codex invalid model | `connector-diff.md:409` | `400 invalid_request_error "The 'audit-invalid-codex-model' model is not supported when using Codex with a ChatGPT account."`. The subscription-looking text also appears for a model that **does not exist**. |
| Claude invalid model | `connector-diff.md:406` | `There's an issue with the selected model (…). It may not exist or you may not have access to it.` |

Note: logged-out Claude reports `subtype: "success"` together with `is_error: true`. Both Claude connectors
check only `subtype !== 'success'` (`claude.ts:205`, `local-claude-connector.js:302`). Compose still
threw through the SDK in the portability run, but the implementation must confirm which layer throws.
A connector that returned "Not logged in · Please run /login" as agent *text* would be a silent bug.
**This is being investigated separately as its own bug** (connector correctness, independent of this
feature). This design **depends on `is_error` being honoured**: until both connectors throw on
`is_error: true`, the Claude-side `unavailable` signal is not reliable and the Claude to Codex
direction (S2) stays gated (acceptance criteria).

---

## Design

### D1. Three failure classes. Only proven vendor-level signals swap.

The rule: **swap only when the failure proves the user has no working credential for the vendor at
all, before any model was considered.** If the request got far enough to judge the model, the user
has the vendor, so the failure belongs to that vendor's model or tooling.

| Class | Action | Signals (per vendor) | Status |
|---|---|---|---|
| `unavailable` | swap, sticky (D3) | **codex:** a vendor-response `turn.failed` or `error` record (`codex.ts:300`, `:361`, `:536-545`) whose message is the anchored shape `unexpected status 401 Unauthorized: … url: https://api.openai.com/…`. **claude:** a result record with `is_error: true` whose `result` begins `Not logged in` (local path reads the record fields directly; MCP path matches the anchored text). Nothing else | codex 401 and claude "Not logged in" **verified** (table above) |
| `exhausted` | swap **with a loud recorded warning**, sticky | plan usage limit or quota exhausted with a reset time, for example Codex "usage limit" (seen in `journal/2026-09-05-session-112…md:19`, exact text not captured) and the Claude subscription limit message | **unverified, staged to S2.** Verify by capturing the real texts from a dispatch ledger or a limited account. Until then, nothing classifies as `exhausted` |
| `broken` | fail loud, never swap, message names the likely fix | everything else, including: **installation and workspace failures** (spawn `ENOENT`, missing SDK package, `"Codex CLI unavailable"` `codex.ts:685`, spawn errors `codex.ts:444`, missing cwd); the codex `invalid_request_error` "model is not supported when using Codex with a ChatGPT account" (fix: check `codex --version` against the minimum, check the catalog's `retired` list); Claude "issue with the selected model"; logged-in Claude with no plan (until P2-7's gate, below); local catalog rejects (`codex.ts:658`, `:664`); transient 429 `rate-limited` (keeps today's backoff, `build.js:1883`); prompt-too-long; 5xx, overload, network, timeout; sandbox and contract failures | model texts verified (table above) |

Rationale:

- The ChatGPT-account 400 is `broken` **by construction.** It fires for a model that does not exist, for a retired model and for an old CLI. In each case authentication succeeded, so the user has Codex.
- Quota is `exhausted`, not `rate-limited`. A short 429 recovers inside the run, so we back off and retry, as today. A plan limit with a reset hours away makes the vendor unavailable for the rest of the run. Swapping keeps the progress already made, and the warning keeps the cause visible.
- If the `exhausted` signal cannot be told apart from a short 429 reliably, it stays unshipped and quota failures stay `rate-limited`. Fail-safe means no swap.
- **Missing tooling is `broken`, never `unavailable` (round 1, P2-6).** "Codex CLI unavailable" (`codex.ts:685`) is thrown when the SDK-bundled CLI cannot be resolved *and* PATH has none: an installation defect that says nothing about the subscription. Claude's spawn receives a working directory (`local-claude-connector.js:213-214`), so `ENOENT` alone cannot tell a missing executable from a missing cwd. Swapping on either would hide a broken install or workspace behind a quiet vendor change. The fail-loud message names the fix (reinstall, check `which codex`, check the cwd).
- **An auth-based swap needs source-specific evidence.** The signal must come from the vendor's own response channel (a Codex `turn.failed`/`error` record, a Claude result record), matched by an anchored per-source pattern, not by a substring anywhere in a thrown message. Spawn errors, `cause` chains and connector-local errors never match, whatever their text. The contract test pins negative fixtures for each (`ENOENT`, "Codex CLI unavailable", missing cwd). Limit: over MCP, Stratum raises a plain `Error(message)` (`codex.ts:448`), so Compose infers the source from the anchored shape (status line plus vendor URL for Codex). The STRAT typed-code follow-up below makes the source exact.
- **Claude "no subscription or no credit" (a logged-in account without a plan) is a known gap (round 1, P2-7).** Its error text has not been captured, and the connectors may not propagate it reliably (they branch on `subtype`, not `is_error`, note above). Until a captured no-plan fixture exists **and** both Claude connectors are shown to throw on `is_error: true`, this case classifies `broken` and fails loud with the hint "if you have no Claude plan, run `claude logout` so Compose can fall back". The swap for this case ships only when that acceptance gate passes. The hint is the interim workaround, not the delivered behavior. This only affects the Claude to Codex direction (S2). The Claude-only S1 never needs to detect a missing Claude plan.

**Where it lives:** one classifier module, `lib/vendor-availability.js` (new). It extends
`providerFailureClass` with the two new classes. It takes the failure's source (vendor response
record, spawn, connector-local) alongside the message, and only a vendor-response source can yield
`unavailable` or `exhausted`. Pattern strings are code, backed by recorded fixture messages in a
contract test. They are CLI text, not model data, so they do not belong in the catalog. Follow-up
(STRAT, out of scope): connectors emit typed codes such as `VENDOR_UNAUTHENTICATED`, so Compose
stops matching text.

### D2. The swap happens at Compose's dispatch seam. The engine's recorded agent never changes.

The engine's step dispatch keeps its recorded `agent` (for example `$.input.reviewer_agent` resolves
to `codex`), because recorded flow inputs are immutable. Compose substitutes the provider at dispatch
time, in two places:

- **In `runAndNormalize` (`result-normalizer.js:344`), before `resolveAgentConfig` (`:370`).** A substituted Claude to Codex call then leaves the local-Claude path by itself (`useLocalClaude` requires `cfg.provider === 'claude'`, `:480`) and goes through `stratum.agentRun` (`:675`) with the read-only sandbox for `read-only-reviewer` profiles.
- **In `StratumMcpClient.#dispatchAgentRun` (`stratum-mcp-client.js:288`),** for direct `agentRun` / `runAgentText` callers: `bug-escalation.js:126` (codex) and `:323`, `build.js:3282`, `new.js:218`, `gsd.js:665`, `codex-preflight.js:140`. A call already handled at the outer seam carries a marker, so the inner seam does not handle it again.

A swap-on-failure redo is a **new dispatch** with its own dispatch id, linked to the failed one.
The engine sees a single step result. The failed call keeps its dispatch-ledger error row and
its usage. In routing runs the substitute is also a **new linked observation** with its own
termination evidence and receipts (D7), never a second invocation on the failed call's binding.

Every substitute carries the failed call's effective capabilities (D10).

A redo is allowed only when the failed call **returned**. An uncertain completion is never redone
(COMP-MODEL-ROUTE D3). A returned failure alone is **not** sufficient for a call that could have
had effects: the seams redo in place only when D11 says the call is effect-free (no write capability, or never
launched). Everything else becomes a persisted `recovery-required` state
(D11) that survives resume and is never redispatched automatically. This matters for `exhausted`:
Codex once hit its usage limit after it had already edited files.

### D3. Stickiness is per run, persisted, and never global

A per-run registry `{vendor → {class, signal, firstStepId, dispatchId, at}}`. Once a vendor is in it,
every later dispatch to that vendor is substituted **before** it is sent, so no step pays for the
failure again. A logged-out codex costs about 15 s of reconnects per attempt (probe above).

- It is persisted into `active-build.json` next to `implementerAgent`/`reviewerAgent` (written at `build.js:4446-4448` and `:7645-7648`). A resume inherits it as a recorded decision.
- **Reset:** a fresh run starts with an empty registry. **Staged to S1b, not in S1:** `compose build --recheck-vendors` (new) on resume clears it for *new* dispatches only. It never rewrites substitutions already recorded. In S1 the only reset is a fresh run.
- There is no cross-run or machine-wide cache. A user who logs in gets the vendor back on the next run. Caching failures is what `codex-preflight.js` deliberately avoids (it caches only `ok: true`).

### D4. The mapping is catalog data (same tier, other vendor)

A new `[fallback]` table goes in `models.default.toml`:

```toml
[fallback.to_claude]   # a codex tier, run on claude
critical = "critical"
standard = "standard"
fast     = "fast"
budget   = "fast"        # claude budget is "unavailable"; nearest cheaper rung
[fallback.to_codex]    # a claude tier, run on codex
critical    = "critical"
standard    = "standard"
fast        = "fast"
coordinator = "critical" # codex coordinator is "unavailable"; orchestration wants top judgment
[fallback.review.rank]     # D6: weakest → strongest, per provider; entries are tier names or "default"
codex  = ["budget", "fast", "default", "standard", "critical"]
claude = ["fast", "default", "standard", "critical", "coordinator"]
```

- An untiered dispatch (a bare `codex`) maps to the other vendor's catalog `default` **for the model only**. Its capabilities come from D10, never from the destination's defaults. A bare `codex` is read-only (`codex.ts:194`), and a bare `claude` would be write-capable (`claude.ts:85`, `:128`), so "bare to bare" would silently widen a review into an editor (round 1, P1-1).
- The agent-string template (`read-only-reviewer`, `implementer`, `orchestrator`) does **not** simply carry over. D10 derives the destination profile from the source's effective capability set, and fails closed when it cannot be expressed.
- The load-time check fails fast if a mapped target is `"unavailable"` on the target provider.
- **Rank rows are ordered by the owner, not inferred.** At load each rank entry resolves to its effective config `{model, effort, mode}`. Adjacent identical configs collapse into one rung (Codex `fast` and `budget` are both Luna/medium, `models.default.toml:31-32`; Codex `default` equals `standard`, `:3` vs `:29`). `"unavailable"` entries are dropped (Claude `budget`, `:40`). Load fails if the same effective config appears at two non-adjacent positions (a contradictory order). The rows shown are the proposed ordering. The owner confirms them at S0 review, and in particular whether the Claude `coordinator` (Fable, `:41`) ranks above `critical` (Opus xhigh, `:36`).
- The whole table is snapshotted per run before first use (D7). A catalog edit never changes a run already under way.
- **Cross-repo cost:** the stratum schema is `.strict()` (`models.ts:24-37`), and compose `validate()` (`model-catalog.js:13-34`) checks a fixed shape. S0 adds the table to both, and to `stratum models --json`.
- **Devin** is never a fallback *target*. It is opt-in, has different sandbox and auth semantics, and runs SWE-2 for free, which a user should not get silently. As a *source* it only appears through explicit flags (no bundled preset or profile names it; grep of `presets/`, `pipelines/*.json`), so D5 makes it fail loud.

### D5. Explicit user flags pin. Everything else is swappable.

`--implementer`, `--reviewer` and `--codex` mean the user asked for that vendor by name. A failure
on a pinned role fails loud, with the signal and "drop the flag to allow fallback". Defaults, spec
literals, sidecar profiles and presets are swappable. A pin covers only its role. `--codex` pins the
implementer, not the Claude-literal design steps.

For a swappable Codex implementer, `codex-preflight.js` treats an `unavailable` probe failure
(`build.js:4550-4560`) as a swap: the implementer moves to Claude and the probe is skipped. It does
not abort the run.

### D6. Single-vendor review: same vendor, stronger model, fresh session, stated plainly

**Trigger (no step list needed).** A dispatch **had cross-vendor intent** when its intended provider
differs from the run's intended implementer provider. D6 applies when a substitution collapses that
intent, meaning the effective providers are now equal. That covers `codex_review`
(`build.stratum.yaml:325-331`), `test_review` (`:341-343`), the `review` sub-flow (`:65-66`),
`build-quick.stratum.yaml:294-312`, `refactor.stratum.yaml:155`, the review-fix `review` profile
(`review-fix.profiles.json`, `review: codex:read-only-reviewer`) and `bug-escalation.js:126`.
`team-fable-astra` has Codex reviewing Codex by design (`execute` and `review` are both codex). It
had no cross-vendor intent, so D6 does not trigger and nothing is claimed.

**Stronger model (round 1, P1-3).** Escalation is over the implementer's **effective model**, the
`{model, effort}` it actually ran with (after any substitution), not its tier name. Tier names are
not a strength order: Codex `fast` and `budget` are the same config, and Claude `standard` and
`critical` are the same Opus model at different efforts (`models.default.toml:31-32`, `:36-37`).

1. Take the destination provider's collapsed rank (D4): distinct effective configs, weakest first.
   Model id plus effort is the unit, so Opus/xhigh is a distinct rung above Opus/medium. Aliases and
   identical configs are a single rung and are never counted as a step up.
2. Find the implementer's effective config on that rank. For a fanout implementer, use the highest
   rung across items. The coordinator is on the Claude rank, so a coordinator-tier implementer is
   handled like any other.
3. The reviewer runs the **lowest rung strictly above** it.
4. If no rung is strictly above (the implementer is at the top, for example Codex astra/high or the
   Claude coordinator), owner ruling #5 applies: the reviewer runs the **same top model in a fresh
   session**, labelled `single-vendor, same model` in provenance and in the summary.
5. If the implementer's effective config is **not on the rank**, it has no established ordering,
   and owner ruling #6 applies: the single-vendor review **fails loud**. There is no guessed
   reviewer (round 2, F4). Off-rank configs are reachable because Codex resolves a caller-supplied
   model and effort independently of any rank (`codex.ts:649-651`), for example via a `CODEX_MODEL`
   override or an explicit model on a profile. The message names the effective config and the rank
   list it was checked against, and gives the fix: "run the implementer on a ranked tier,
   or give `<model>/<effort>` a tier and place it in the `<provider>` row of `[fallback.review.rank]`
   in `models.default.toml`, or log in to `<other vendor>`". Like an explicit flag naming an unavailable vendor (D5), this
   stops the step rather than choosing on the user's behalf. Provenance records
   `rank: "implementer-off-rank"` on the failure.

Illustrative, with the proposed ranks: Claude implementer Opus/medium → reviewer Opus/xhigh.
Opus/xhigh → Fable/high. Fable → Fable, same model, fresh session. Codex implementer sol/high →
astra/high, and astra → astra, same model. Everything here is catalog data. No model ids appear in code.

**Fresh session.** Each reviewer dispatch is a new agent run. **Unverified:** that no Claude
`resume`/session id or Codex thread id carries over from the implementer. Grep both connectors and
the review prompt builder in implementation.

**`resolveRoleCollision` (`build.js:2355-2367`)** gains an input for known-unavailable vendors (the
inherited D3 registry). When the flip target is known unavailable, it returns the same-provider pair
tagged `singleVendorReview: true` instead of flipping, and it does not print the "both explicit"
warning. In a fresh run the set is empty, so the flip stays as it is today, and D2 produces the same
outcome at dispatch time.

**Provenance and wording.** Each review result records `review_independence: "single-vendor" | "single-vendor, same model" | "cross-vendor"`,
the implementer's and reviewer's effective configs, and the rank decision (`stronger | same-model-top`). An `implementer-off-rank` decision produces no review (rule 5).
The run summary prints, verbatim in shape:

> Review was single-vendor: Claude reviewed Claude's work (claude-opus-5-5, xhigh, fresh session) because Codex was unavailable (not logged in: 401). This was not a cross-vendor review.

and, when rule 4 applied:

> Review was single-vendor, same model: Claude reviewed Claude's work with the same model the implementer used (claude-fable-5-1, high, fresh session), because no stronger Claude model exists and Codex was unavailable (not logged in: 401). This was not a cross-vendor review.

The existing "both explicit" case (`build.js:2359`) is recorded with the same field.

### D7. Recording and resume: a swap is a new recorded decision, not a re-resolution

- **Non-routing runs:** each substitution is appended to `active-build.json` `vendorFallback.substitutions[]` as `{stepId, dispatchId, failedDispatchId|null, from, to, class, signal, capabilities, singleVendorReview, policyDigest}`. The dispatch-ledger row gains `substituted_from`.
- **Routing runs (COMP-MODEL-ROUTE), retry binding (round 1, P1-4):** a substitute is **never** a second invocation on the failed call's observation or issuance binding. That is rejected by design: `recordRoutingCallIntent` refuses a second call on an observation (`consumer-fanout.js:871`, "a new launch needs a distinct durable observation slot"), and auxiliary observers such as bug escalation (`bug-escalation.js:126-127`) bind one durable observation each (`routing-runtime.js:139-143`). A new dispatch UUID does not change that.
  - **Path A, returned failure (the call that discovers the vendor is unavailable).** The failed call's intent is first resolved as a returned failure, with its own termination evidence and receipt (`stratum-mcp-client.js:326`). Then the substitute obtains a **new linked observation** through the existing child mechanism, `bindRoutingCalls(...).child({ parentIntentId: <failed intent>, unsupportedReason: 'provider-substitution', callSite: '<callSite>/provider-substitution' })` (`routing-ledger.js:850-856`, reached via `runtimeObserver.child`, `routing-runtime.js:112-116`). That records a distinct `unsupported-observation` whose `parentIntentId` links it to the failed call. The substitute's call intent, resolution, termination evidence and receipts all bind to that observation.
  - **Path B, sticky pre-dispatch substitution (round 2, F3).** Once D3 marks a vendor unavailable, every later call to it is substituted **before** dispatch, so it has no failed intent of its own, and `child()` is not usable: the runtime refuses it without a connector-owned parent intent (`routing-runtime.js:113`), and the ledger requires that parent to belong to the current binding (`routing-ledger.js:852`). The first failure from another step does not qualify. Instead:
    1. Before dispatch, the seam records a **pre-dispatch substitution observation** directly, with `recordRoutingObservation({ unsupportedReason: 'provider-substitution', parentRecordId: <current binding's recordId>, parentIntentId: null, callSite: '<callSite>/provider-substitution/<logicalCallKey>', context: <current owner's context> })` (`consumer-fanout.js:903-929`, which already accepts `parentIntentId: null`). `<current binding>` is whatever the call would have bound: the primary issuance for a fanout item or ordinary step, or the auxiliary observation created by `callsForRouting` for calls such as bug escalation (`routing-runtime.js:119-143`). `<logicalCallKey>` is defined in step 5. It is **not** a count of stored observations (round 3).
    2. The substitute binds with `bindRoutingCalls({ artifacts, observationId })` (`routing-ledger.js:831`) and records its own intent, resolution, termination evidence and receipt there. The current binding records **no** call intent for the original vendor.
    3. The observation carries a **`substitutionReason`**, kept outside its identity digest: `{ vendor, class, signal, originStepId, originDispatchId, originIntentId | null, registryEntryAt }`, copied from the D3 registry entry. The original vendor failure is referenced as the reason. It is never re-bound or re-resolved.
    4. Termination needs no new rule: `routingCallsTerminated` already walks `unsupported-observation` records whose `parentRecordId` chains to the issuance and counts their call intents (`routing-runtime.js:318-328`). Both paths therefore satisfy the issuance's termination through the linked observation.
    5. **Durable logical-call identity and resume (round 3).** Counting prior observations, as `callsForRouting` does for auxiliary slots (`routing-runtime.js:124-136`), is unsafe here: once slot 0 is persisted, a resume counts it and allocates slot 1, a different observation id (the call site is part of the identity, `consumer-fanout.js:912`, `:925`), and so a second dispatch. The uncertainty check (`consumer-fanout.js:869`) only searches the new binding's record, so it would not catch that. The auxiliary precedent also refuses unresolved priors but never replays resolved ones.
       - **Identity.** `logicalCallKey` is a digest of the call's deterministic position: `{ scopedStep, stage, epoch, itemIndex, generation, dispatchToken, seamLabel, ordinal }`. `seamLabel` is the static label of the dispatch point (for example `codex_review`, `bug-escalation/tier1-review`). `ordinal` counts calls with that `seamLabel` in program order within the current step execution. It is an in-memory counter reset when the step starts, never derived from the journal. A resumed step re-executes its calls in the same order, so it recomputes the same key. A genuine retry has a new `dispatchToken` or `generation`, so it gets a new key. Because the key is inside `callSite`, it is inside the observation id digest.
       - **Look up before allocating.** The seam computes the observation id from that identity and reads the journal **before** writing anything:
         - *No observation:* record it, bind, record the intent, dispatch. The intent is written before launch (`stratum-mcp-client.js:292`, before the invoke at `:298`).
         - *Observation with no call intent* (interrupted after the observation was written): nothing was launched. **Primary parent only:** re-putting the identical observation is idempotent (`#routingPut` returns the existing record when the bytes match, `consumer-fanout.js:734-739`), because the primary parent, and so the stored `parentRecordId`, is the same on resume (scope below). Bind, record the intent, dispatch.
         - *Intent with no resolution, or `unresolved`* (interrupted after the intent): uncertain. Refuse (`ROUTING_ISSUANCE_UNCERTAIN`) and write a `recovery-required` entry (D11). Never redispatch.
         - *Resolved intent* (interrupted after resolution, before step completion): **replay**. Do not dispatch. The seam persists the substitute's returned payload, content-addressed under the run directory, **before** it writes the routing resolution, and the resolution's substitution entry carries that digest. Resume returns the persisted payload, or the recorded failure for a failed resolution, which then follows the normal failure path with no new substitution. A resolution whose payload cannot be read is treated as uncertain (refuse, `recovery-required`).
       - The `substitutionReason` is taken from the persisted D3 registry, so it is identical across resume.
       - **Scope of replay: primary parents only (round 4, controller scope cut; owner may override).** The lookup above is sound only when the parent binding itself is resume-stable.
         - *Primary parent (fanout item or ordinary step issuance): full lookup, replay and refuse, as written.* Its id is `routingRecordId({ runId, scopedStep, stage, epoch, itemIndex, generation, issuanceToken })` (`model-router.js:106-110`), a digest of the call's position with no counter in it, and the ledger refuses any issuance whose id differs from that tuple (`routing-ledger.js:77`). `callsForRouting` binds a primary call to that issuance without allocating a slot (the slot branch is guarded by `if (unsupportedReason || !issuance)`, `routing-runtime.js:123`; the primary bind is `:145`). A resumed run reaches the same issuance id, so the substitution's parent and call site are both stable.
         - *Auxiliary parent (for example bug escalation, `bug-escalation.js:126-127`): no replay.* `callsForRouting` allocates the auxiliary observation's slot as `prior.length` and appends it to the call site (`routing-runtime.js:124-136`). On resume the same call gets auxiliary parent 1, not parent 0. Re-putting the substitution observation under the new parent changes its stored `parentRecordId`, which is in the record but not its identity (`consumer-fanout.js:912`, `:929`), so `#routingPut` refuses with `ROUTING_CALL_EVIDENCE_CONFLICT` (`consumer-fanout.js:736-738`). So when resume finds any `provider-substitution` observation, intent or resolution left by an interrupted auxiliary substitution, it writes a `recovery-required` entry (D11) and stops that step. It never replays, never re-puts, and never dispatches. The same applies to a Path A child under an auxiliary parent: after resume the new auxiliary binding cannot name the original failed intent, so there is nothing to look up (same root cause).
         - Resume-stable auxiliary identity is split out as a follow-up (Out of scope). The base allocator already behaves this way for every auxiliary call today (an interrupted auxiliary call gets a new slot on resume), so this cut introduces no regression. It only declines to build replay on top of it.
    6. **Path A's child slot: yes, the same lookup-and-replay rule applies, but no new key is needed.** Path A's identity is already deterministic, because the child's identity includes `parentIntentId` (`consumer-fanout.js:912`), which is unique to the failed invocation and stable across resume. What Path A lacks is the lookup. On resume, `child()` would re-put the existing observation (idempotent) and then try a new intent, which `consumer-fanout.js:871` refuses ("already owns an invocation"). That does not double-dispatch, but it would refuse a completed substitution instead of replaying it. So Path A uses the same four-way lookup before calling `child()`. Nothing else in Path A changes.
  - Consequences: the admitted route's receipt comparison never sees the substitute's model, so no `CONSUMER_EVIDENCE_MISMATCH` (`routing-runtime.js:7`) arises from the model change. An unresolved failed intent blocks the substitute (`ROUTING_ISSUANCE_UNCERTAIN`, `routing-runtime.js:133`), which is the uncertain-completion rule enforced by the ledger itself.
  - Schema cost: `provider-substitution` is added to the `unsupportedReason` enum (`contracts/routing-join.schema.json:581`), and the `unsupported-observation` record gains an optional `substitutionReason` object (Path B, required when `parentIntentId` is null and the reason is `provider-substitution`). This was the round-1 draft's `provider_substitution` journal entry, now expressed as a real observation record rather than a side entry.
  - The start record and profiles digest are **not** touched. The resolver remains the only tier chooser. This feature maps the resolver's output, so ROUTE's "no provider switching" still holds for routing *policy*.
- Substituted issuances are excluded from learned cells, the same way ROUTE treats `unsupported`, because the statistical key includes the provider (ROUTE D1).
- **Policy snapshot (round 1, P2-5).** Before the first use of fallback policy in a run, Compose freezes a snapshot: the `[fallback]` table, the collapsed review ranks, the resolved destination config `{model, effort, mode}` for every mapping and for each provider's `default`, the D10 capability mapping version, and the `catalogDigest` from `stratum models --json` (STRAT-CONFIG-MODELS-1 D4). Every substitution and every D6 reviewer choice reads the snapshot, never the live catalog, and records its `policyDigest`.
  - *Non-routing runs:* written into `active-build.json` `vendorFallback.policy` at run start. A run started before this feature acquires it on its first substitution, before the substitute is dispatched.
  - *Routing runs:* the start record is immutable (`routing-ledger.js:282`) and resume refuses any change to its `mappings` (`routing-ledger.js:278`, `:285`, validated at `:353`), so the snapshot is **not** added to `routingModelMappings`, which would drift every existing root. Instead it is a separate immutable sidecar, `fallback-policy.json`, in the routing start directory, written once with the same `immutable()` helper (`routing-ledger.js:191`). Every `provider-substitution` observation carries its digest. Existing roots acquire the sidecar on first need, without mutating the start record, the mappings or any earlier record. On resume the sidecar's digest must match the one recorded on prior observations, or resume refuses (`ROUTING_ROOT_DRIFT` family).
  - A catalog change after the snapshot has no effect on that run. It shows once as a note in the summary.
- **Resume** replays recorded substitutions byte-for-byte for issuances that already have them. It applies the inherited registry (D3) and the **snapshotted** policy to new issuances, and honours every `recovery-required` entry (D11). It never re-resolves a recorded choice.

### D8. Cost and visibility

- At the moment of a swap, one `progress.warn` line: `⚠ Codex unavailable (not logged in: 401). Review steps now run on Claude (claude-opus-5-5 xhigh) for the rest of this run. Fix: codex login.` For `exhausted` the line also gives the reset time and says "this is a quota limit, not a missing subscription".
- At the end of the run, a **Vendor fallback** block lists each swapped step as from → to model, the class, and the USD spent by substituted calls (from existing usage records). It includes the D6 sentence when D6 applied.
- Existing cost ceilings (`_costCeiling`, team-fable-astra: 150) meter actual usage and are unchanged. The mapping can raise cost (codex `coordinator` → astra), and the summary block shows it.
- This partly closes COMP-HOST-PORTABILITY-1 G7 (undisclosed provider expectations).

### D9. Relation to COMP-CODEX-PROVIDER-1: what a Codex-only user gets

- **Claude-only users are fully served.** Compose's host is Claude, and only Codex dispatches need to move.
- **Codex-only users** get every *Compose-dispatched pipeline agent call* swapped to Codex, including the Claude-literal build steps (`build.stratum.yaml:114-374`) and local-Claude controlled executions. They do **not** get: the `/compose` skill lifecycle hosted in Claude Code, Codex skill and agent install targets, host-neutral prompts (steps written for Claude affordances such as subagents and skills may run worse or fail on Codex), or gaps G1-G4. Those remain COMP-CODEX-PROVIDER-1 (G5).
- **Codex-only acceptance is a pilot, not a promise.** Run `build-quick` end-to-end with Claude logged out and record the evidence. Any step that fails is filed as a COMP-CODEX-PROVIDER-1 gap, not fixed here.

### D10. A substitute keeps the original call's effective capabilities (round 1, P1-1)

The unit carried across a swap is the original call's **effective capability set**, including the
connector's implicit defaults, not its profile string. Five axes, each checked on its own
(round 2, F1): filesystem **write scope** (none / workspace roots / unrestricted), filesystem
**read** scope, **shell** (none / sandboxed / full), **network** (off / on), and **tool surface**
(allowlist or preset). Shell prohibition is its own axis: "cannot write files" and "cannot run
commands" are different guarantees, and a read-only OS sandbox still runs commands.

Where the implicit defaults come from today:

| Source call | Effective capabilities | Evidence |
|---|---|---|
| Codex, no `sandboxMode` (includes bare `codex`, e.g. `bug-escalation.js:126`) | write none, shell sandboxed (commands run, read-only), network off | `codex.ts:194-195`; Compose passes `read-only` unless the caller asks (`result-normalizer.js:383-389`) |
| Codex, `workspace-write` | write scope cwd plus `writableRoots`, shell sandboxed, network off | `build.js:1899`, `codex.ts:194-196` |
| Claude, no template (bare `claude`, e.g. `bug-escalation.js:323`) | write unrestricted, shell full, network on, full `claude_code` preset under `acceptEdits` | `claude.ts:85`, `:128`; local path `local-claude-connector.js:204` |
| Claude, `implementer` | same as bare Claude: no tool restrictions | `server/agent-templates.js:22-26` |
| Claude, `read-only-reviewer` / `read-only-researcher` | write none, **shell none** (Bash denied), tools Read/Grep/Glob/Agent (researcher adds WebSearch/WebFetch, so network on) | `server/agent-templates.js:12-21` |
| Claude, `orchestrator` / `security-auditor` | Edit/Write denied, but Bash allowed, so effective write is unrestricted via the shell | `server/agent-templates.js:27-36` |

**Rule.** A destination row is admitted only if it is **enforceable on every axis**, by a mechanism
the connector actually passes, and is never looser than the source on any axis. On the write axis it
may not drop a writing call to `none` (that would silently turn an implementer into a no-op), and the
only permitted narrowing is unrestricted to workspace rooted at the source call's cwd. A stricter
destination on read, shell, network or tool surface is allowed. Every narrowing is recorded in
provenance (`capabilities_narrowed: [...]`). Anything else **fails closed**: the failure is reported
as `broken` with the reason `capability-unexpressible`, naming both capability sets. A row whose
mechanism exists but is not yet plumbed or proven counts as not enforceable.

**Destination mapping (the explicit review policy for bare calls):**

| Source | Destination | Status |
|---|---|---|
| Codex read-only (includes bare `codex`) | Claude `read-only-reviewer`: write none, shell none, network none (no web tools), enforced by the SDK tool allowlist the connector already passes (`claude.ts:120-126`) | **admitted (S1)**. Stricter on shell and network, recorded. Subject to the `Agent`-inheritance gate below |
| Codex `workspace-write` | Claude with write scope confined to the same roots, no network, shell sandboxed | **fails closed** (S1 and until the gate below). See "Claude workspace confinement" |
| Claude `read-only-reviewer` / `read-only-researcher` | Codex with no shell, no write, and (reviewer) no network | **fails closed**. See "Codex no-shell mode" |
| Claude unrestricted (bare, `implementer`) | Codex `workspace-write` rooted at the source cwd, network off | **admitted (S2)**. Narrowed on write scope, shell and network, recorded (accepted in round 2) |
| Claude `orchestrator` / `security-auditor` | none | **fails closed**. Codex has no "shell but no edit tool" mode. `read-only` would silently break the step, and `workspace-write` widens the tool surface (accepted in round 2) |
| Codex `danger-full-access` or any unknown sandbox | none | **fails closed** |

So a bare Codex review never becomes a write-capable Claude call. It lands on `read-only-reviewer`
by capability, not by name. **Unverified:** whether Claude subagents started through the `Agent` tool
inherit the parent's tool allowlist. If they do not, `Agent` is removed from the destination
read-only policy, because otherwise a subagent could write. Check the SDK and pin it with a test
before S1 ships. **Also unverified:** that the Claude `Read`/`Grep`/`Glob` read scope is no wider than
Codex's read-only sandbox read scope. S1 pins it with a probe, or the row records read as narrowed or
fails closed.

**Claude workspace confinement (why Codex `workspace-write` → Claude fails closed).** The Claude Agent
SDK has a `sandbox` option (`sdk.d.ts:2098` in compose's installed 0.3.278; `:1817` in stratum's
0.3.206) with `filesystem.allowWrite/denyWrite/allowRead/denyRead` (`sdk.d.ts:3285-3288`),
`network.allowedDomains` (`:3269`), `enabled`, `failIfUnavailable` and `allowUnsandboxedCommands`
(`:3264-3267`). But the SDK documents that this sandbox governs **commands only**: "Filesystem and
network restrictions are configured via permission rules, not via these sandbox settings ... Use
`Read` and `Edit` permission rules ... Use `WebFetch` permission rules" (`sdk.d.ts:2063-2066`), and
"in-process tools such as WebFetch are not gated" (`:8272`). So workspace-write plus no network on
Claude needs all of: `sandbox` enabled with `failIfUnavailable: true` and `allowUnsandboxedCommands:
false`, `allowWrite` set to the source roots, no allowed domains, Edit/Write permission rules scoped to
the roots, and web tools removed. Neither Claude connector passes `sandbox` or path-scoped permission
rules today (`claude.ts` has no `sandbox` key in its SDK options, `:84-132`; the local connector
also pins `settingSources: []`, `local-claude-connector.js:209`, so settings-file rules do not apply).
Whether `acceptEdits` plus path-scoped rules really denies an Edit outside the roots is unverified. The
row is therefore **not enforceable today and fails closed**. It opens only through an S2 gate: the
connectors plumb those options, and a probe proves that a write outside the roots, a network call from
Bash and a WebFetch are each denied.

**Codex no-shell mode (why Claude reviewer → Codex fails closed).** `codex.ts` passes no tool or
feature switches (grep for `features` and `shell` finds only the headless-browser path, `codex.ts:94-125`).
codex-cli 0.159.0 lists `shell_tool` and `unified_exec` as stable and enabled (`codex features list`),
and `codex exec --disable <FEATURE>` exists (`codex exec --help`). It also enables `browser_use`,
`computer_use` and `apps` by default. Whether disabling `shell_tool` and `unified_exec` removes all
command execution, and what the other enabled tools can reach, is **unverified**. There is no proven
Codex configuration with no shell. The row fails closed. It opens only through an S2 probe that
proves a Codex config with no command execution, no write and no network, after which the connector
plumbs it.

S1 is Claude-only, so its only admitted row is Codex read-only → Claude `read-only-reviewer`. A Codex
`workspace-write` call that needs substituting in S1 (a Codex implementer from a preset or spec, since
`--codex` pins and fails loud under D5) fails closed with `capability-unexpressible` and the fix
("log in to Codex, or change the preset's implementer to Claude").

This table is code in `lib/vendor-substitution.js` (new), versioned, and its version is part of the
policy snapshot (D7). It is not catalog data, because it describes connector behavior, not models.

### D11. Recovery-required state: a returned failure is not enough to redo a call with effects (round 1, P1-2)

A swap redo is automatic **only** in these two cases:

1. **Effect-free by capability.** The failed call's effective write axis was `none` (D10). The OS
   sandbox (Codex) or the tool allowlist (Claude) prevented writes, so there is nothing to restore.
   In S1, where the failing vendor is Codex, this is nearly every case: Codex calls are review calls
   unless the user pinned `--codex` (D5, which fails loud).
2. **Never launched.** The failed call records `launched: false` (`stratum-mcp-client.js:309`, `:324-326`).
There is deliberately **no** automatic case for write-capable calls, not even after a successful
fanout witness restore (round 2, F2). The witness covers only tracked and untracked **non-ignored**
content (`snapshotWorkingTree`, `consumer-fanout.js:118-125`). Restore runs `git clean -fd`, which
leaves ignored files alone, and it already verifies tree equality against the witness
(`restoreWorkingTree`, `consumer-fanout.js:127-138`; `restoreToPreStageWitness`, `:1381-1393`). So a
write-capable call can change a gitignored file inside the worktree (a `.env`, a build cache, a local
config), fail part-way, and pass both the restore and the equality check with the change still in
place. The witness also says nothing about git refs. No destination capability can express "may
write the workspace except ignored files" (Codex `writableRoots` and the Claude `allowWrite` are path
lists, D10), so the alternative the review offered, a destination whose write scope cannot touch
ignored files, is not available. The witness restore stays as today's cleanup before the failure
report (`build.js:1987`), but it no longer authorizes a redo. A write-capable call that fails with
`unavailable` therefore goes to `recovery-required`. For write-capable calls the D2 seams raise a
typed `VendorSubstitutionRequired` carrying the capability set, and the caller that owns the side
effects (the fanout catch, or the build loop for non-fanout steps) records the entry.

In S1 this costs little: the failing vendor is Codex, whose calls are read-only reviews (case 1)
unless a preset or spec names a Codex implementer, and that row already fails closed under D10.
When S2 adds quota handling after edits, those failures always land in `recovery-required`.

Resume also writes one for an interrupted substitution under an auxiliary routing parent (D7 Path B scope). Everything else writes a **`recovery-required`** entry to `active-build.json`
`vendorFallback.recovery[]`, `{stepId, dispatchId, vendor, class, capabilities, owner, reason, at}`,
before the run stops. The entry:

- **survives resume.** Resume refuses to redispatch that step on any vendor while the entry is open,
  and says why, with what to check.
- **is never cleared by stopping and resuming**, since that undoes nothing.
- **never auto-redoes external effects.** A write-capable call can commit, push or publish. The bundled `ship` step says so outright ("commit and push",
  `build.stratum.yaml:372-379`). Build and fix mode intercept `ship` in-process (`build.js:5128-5134`),
  so it is not a vendor dispatch there, but other modes and specs fall through to the agent. Such
  steps are never redispatched automatically, whatever the class.

**Clearing it (staged to S1b):** `compose build --resume --reconciled <stepId>` records an explicit
user decision (who, when, what was checked) that the effects were reconciled, then allows the
substitute. In S1 the only way out is a fresh run. The message says so.

### Slices

Quota handling (`exhausted`), `--recheck-vendors` and `--reconciled` are **staged out of S1**, as the
round-1 review allowed. They enlarge the state machine without closing a core gap, so S1 stays small.

- **S0 (stratum and compose catalog):** add the `[fallback]` table and `[fallback.review.rank]` to the schema, `models --json` and compose `validate()`, including alias collapse and the contradictory-order load failure. Owner confirms the rank order.
- **S1 (Claude-only):** D1 classifier (verified `unavailable` signals only, source-anchored), D2 seams, D3 registry (fresh-run reset only), D5, D6 (effective-model escalation, rulings #5 and #6), D7 (returned-failure and sticky pre-dispatch observations, resume replay for primary parents only, auxiliary interruptions to `recovery-required`, policy snapshot), D8, D10 (only the Codex read-only → Claude `read-only-reviewer` row is admitted) and D11 (automatic cases 1-2 plus persisted `recovery-required`). Ship narrow first.
- **S1b:** `--recheck-vendors` and `--reconciled <stepId>`.
- **S2 (Codex-only pilot):** Claude to Codex substitution plus the `build-quick` pilot evidence, gated on the Claude `is_error` propagation fix and the no-plan fixture (D1). Also the `exhausted` class, once its signals are verified, and the two D10 rows that fail closed today (Codex `workspace-write` → Claude, Claude reviewer/researcher → Codex), each once its probe gate passes.

## Acceptance criteria

- [ ] `stratum/ts/src/config/models.default.toml` (existing) has the `[fallback]` table and `[fallback.review.rank]`. `stratum/ts/src/config/models.ts` (existing) validates it: a mapped target that is `"unavailable"` fails load, identical adjacent rank entries collapse, and the same effective config at two non-adjacent rank positions fails load. `compose/lib/model-catalog.js` (existing) validates the emitted shape.
- [ ] `compose/lib/vendor-availability.js` (new) classifies into `unavailable | exhausted | broken` using the failure's source plus an anchored per-source pattern. `compose/test/vendor-availability.test.js` (new) pins the recorded fixtures: codex 401 `turn.failed`, Claude "Not logged in · Please run /login", the ChatGPT-account 400 (→ `broken`), Claude invalid model (→ `broken`), a short 429 (→ `rate-limited`, no swap), and negative fixtures that must be `broken`: spawn `ENOENT`, missing cwd, missing SDK package, "Codex CLI unavailable" (`stratum/ts/src/connectors/codex.ts:685`).
- [ ] **(S2)** Before `exhausted` ships, the real usage-limit texts for both vendors are captured in the implementation report. Until then `exhausted` matches nothing.
- [ ] **Known dependency:** logged-out Claude CLI can return `subtype:"success"` with `is_error:true`, and both connectors branch on `subtype` only (`stratum/ts/src/connectors/claude.ts:205`, `compose/lib/local-claude-connector.js:302`). This is being investigated separately as its own bug. This design depends on `is_error` being honoured. Before S1 ships, the implementation report records whether each connector throws or returns text for that result. Before S2 ships, both connectors throw on `is_error:true`, pinned by a connector test.
- [ ] **Gate for the Claude no-plan swap (S2):** a captured fixture from a logged-in Claude account with no plan is recorded in the implementation report and pinned in `compose/test/vendor-availability.test.js`, and the `is_error` propagation above is in place. Until both hold, that case is `broken`, fails loud with the `claude logout` hint, and is listed as a known gap in the implementation report.
- [ ] Substitution runs in `compose/lib/result-normalizer.js` (existing) before `resolveAgentConfig`, and in `compose/lib/stratum-mcp-client.js` (existing) `#dispatchAgentRun`. A test shows no call is handled twice.
- [ ] `compose/lib/vendor-substitution.js` (new) derives the effective capability set on five axes (write scope, read scope, shell, network, tool surface), including implicit connector defaults, and maps it per D10. Tests: a bare `codex` review substitutes to Claude `read-only-reviewer`, never the full preset; a Codex `workspace-write` source fails closed to Claude with `capability-unexpressible`; a Claude `read-only-reviewer` or `read-only-researcher` source fails closed to Codex (shell axis); a Claude `orchestrator` source fails closed to Codex. No admitted mapping is looser than its source on any axis.
- [ ] **(S2 gates for the two closed rows)** Codex `workspace-write` → Claude opens only when both Claude connectors pass the SDK `sandbox` option (`failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `allowWrite` = source roots, no allowed domains), Edit/Write permission rules scoped to the roots, and no web tools, and a probe shows a write outside the roots, a network call from Bash and a WebFetch are each denied. Claude reviewer/researcher → Codex opens only when a probe shows a Codex configuration with no command execution (candidates: `--disable shell_tool --disable unified_exec`, plus the browser, computer-use and apps tools off), no write and no network. Until then both rows fail closed.
- [ ] Before S1 ships, whether Claude `Agent`-tool subagents inherit the parent's tool allowlist is established and pinned by a test. If they do not, `Agent` is dropped from the read-only destination policy.
- [ ] A returned `unavailable` failure is redone automatically only in D11's two cases (write axis `none`, or `launched:false`). An uncertain completion is never redone. A successful fanout witness restore does **not** authorize a redo.
- [ ] Any other failure writes a `recovery-required` entry to `active-build.json`. Tests: the entry survives stop and resume; resume refuses to redispatch the step; a step whose capabilities allow writes outside a witness worktree is never auto-redispatched.
- [ ] **Ignored-file mutation case:** a write-capable call in a fanout worktree modifies a gitignored file, then fails with `unavailable`. The witness restore and its tree-equality check both pass (the ignored change survives), and the step is **not** redispatched: a `recovery-required` entry is written, and a resume refuses to redispatch it.
- [ ] The registry persists in `active-build.json` and is inherited on resume. A fresh run starts empty. **(S1b)** `--recheck-vendors` (new flag, `compose/bin/compose.js`, existing) clears it for new dispatches only. **(S1b)** `--reconciled <stepId>` clears one `recovery-required` entry and records the user decision.
- [ ] An explicit `--implementer/--reviewer/--codex` role fails loud on `unavailable` and names the flag.
- [ ] `resolveRoleCollision` (`compose/lib/build.js`, existing) returns `singleVendorReview: true` instead of flipping when the flip target is known unavailable. Today's behavior is otherwise byte-identical (existing tests unchanged).
- [ ] D6 selects the reviewer from the snapshotted collapsed rank over the implementer's **effective** `{model, effort}`, with no model literal in code. Tests: Codex `fast` → `budget` is never treated as a step up; Claude Opus/medium → Opus/xhigh; a top-rung implementer (including the Claude coordinator) gets the same model in a fresh session, labelled `single-vendor, same model` in provenance and in the summary; an off-rank implementer (e.g. a `CODEX_MODEL` override) fails loud with a message naming the effective config and the rank list, and no review is dispatched.
- [ ] The fallback policy snapshot is written before first use and read by every later substitution. Tests: editing the `[fallback]` table mid-run does not change a later substitution in that run. A routing root started before this feature acquires `fallback-policy.json` without its start record, `mappings` or earlier records changing, and resume refuses a sidecar whose digest differs from the recorded one.
- [ ] Routing runs: the failed intent is resolved first, then the substitute binds a new `provider-substitution` child observation linked by `parentIntentId` (`compose/lib/routing-ledger.js:850-856`), with its own intent, termination evidence and receipt. `compose/contracts/routing-join.schema.json` (existing) admits `provider-substitution`. Tests: a substituted bug-escalation review (auxiliary observer) and a substituted fanout item (primary issuance) both pass routing integrity; neither triggers `ROUTING_CALL_EVIDENCE_CONFLICT` or `CONSUMER_EVIDENCE_MISMATCH`; an unresolved failed intent blocks the substitute. The start record and profiles digest are unchanged.
- [ ] Routing runs, sticky path (D7 Path B): after the registry marks a vendor unavailable, a later primary call (fanout item or ordinary step) and a later auxiliary call (bug escalation) each record a pre-dispatch `provider-substitution` observation whose `parentRecordId` is their own current binding, with `parentIntentId: null` and a `substitutionReason` naming the original failure, and no `child()` call. Tests: the original binding records no call intent for the unavailable vendor; `routingCallsTerminated` reports the issuance terminated through the observation; a resume replays a resolved substitution, refuses an unresolved one, and records the same `substitutionReason`; `compose/contracts/routing-join.schema.json` admits `substitutionReason`.
- [ ] **Path B resume identity (round 3):** the substitution observation's call site carries `logicalCallKey` (step, stage, epoch, item, generation, dispatch token, seam label, in-step ordinal), never a count of stored observations. Interruption tests through the **real primary-binding path** (a fanout item or ordinary step issuance), each resumed once, with the connector call counted: **(a)** after the observation is written, before the intent: resume reuses the same observation id and dispatches exactly once in total; **(b)** after the intent is written, before resolution: resume refuses with `ROUTING_ISSUANCE_UNCERTAIN`, writes `recovery-required`, and makes zero further dispatches; **(c)** after resolution, before step completion: resume replays the persisted payload, makes zero further dispatches, and the step completes with the replayed result. A fourth test shows a real retry (new `dispatchToken`) gets a new key. The same (b) and (c) tests run for Path A's child observation under a primary parent.
- [ ] **Auxiliary-parent substitutions do not replay (round 4 scope cut):** the same interruptions run through the **real auxiliary-binding path** (`callsForRouting` with a reason, e.g. bug escalation). **(a)** after the observation, **(b)** after the intent, **(c)** after resolution before step completion: in each case resume writes a `recovery-required` entry (D11), makes zero further dispatches, re-puts no routing record, and raises no `ROUTING_CALL_EVIDENCE_CONFLICT`. A Path A child under an auxiliary parent behaves the same.
- [ ] **Golden flow (Claude-only):** `compose build` on a scratch feature with `CODEX_HOME` pointed at an empty dir. It completes. Codex fails exactly once (sticky afterwards), review runs single-vendor on Claude, and the summary block and sentence are present. The same run with the ChatGPT-account 400 injected fails loud with the CLI-version hint and does **not** swap.
- [ ] **Pilot (Codex-only, S2):** `build-quick` with `CLAUDE_CONFIG_DIR` pointed at an empty dir. The evidence goes in the implementation report, and failures are filed against COMP-CODEX-PROVIDER-1.
- [ ] Scratch `CODEX_HOME`/`CLAUDE_CONFIG_DIR` dirs and scratch features are removed by the tests that create them (fixture teardown).

## Out of scope

- A startup probe or a required "which vendors do I have" setting (owner decision 1).
- Same-vendor model downgrade when a plan lacks one model. That failure is model-level and `broken`, and it is a possible follow-up.
- A cross-run or machine-wide availability cache.
- Devin as a fallback target. API-key billing paths (the connectors scrub `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`: `claude.ts:44`, `local-claude-connector.js:29`).
- The Codex-hosted Compose lifecycle (COMP-CODEX-PROVIDER-1). Typed vendor error codes in stratum connectors (STRAT follow-up).
- Changing team-fable-astra's same-vendor execute and review.
- **Follow-up: Resume-stable auxiliary identity (split out, round 4).** Give auxiliary routing observations a durable logical-call identity instead of `prior.length` slots (`routing-runtime.js:124-136`), so an interrupted auxiliary call, and a provider substitution under one, can be found and replayed on resume. The base allocator already lacks this property for every auxiliary call, so it is not a regression introduced by this feature. Until the follow-up lands, interrupted auxiliary substitutions go to `recovery-required` (D7 Path B scope).

## Owner rulings (2026-09-30, closed)

Rulings 1-4 were asked as the four open questions of the first draft; all four confirmed as designed. Ruling 5 was added after the round-1 review, and ruling 6 (a controller call the owner may override) after round 2. Do not re-litigate.

1. **Quota:** plan-quota exhaustion swaps to the other vendor **with a loud warning** (D1's ambiguous class). Stays inert until the real quota error text is captured.
2. **Pins:** an explicit `--implementer` / `--reviewer` / `--codex` naming an unavailable vendor **fails loud** with the fix (log in, or drop the flag). Only defaults, specs and presets swap (D5).
3. **Coordinator:** Claude `coordinator` falls back to Codex **`critical`** (the strongest model); cost accepted because the coordinator steers the whole team (D4).
4. **Rollout:** **Claude-only first** (S1); the Codex-only `build-quick` pilot (S2) follows, gated on COMP-CODEX-PROVIDER-1 for the lifecycle host (D9).
5. **No stronger model available (added after round 1):** when the available vendor has no model strictly stronger than the implementer's effective model, the reviewer uses the **same top model in a fresh session**, labelled `single-vendor, same model` in provenance and in the run summary (D6 rule 4). This is the owner exception round 1 (P1-3) asked for.
6. **Off-rank implementer (controller call 2026-09-30, after round 2; the owner may override):** when the implementer's effective model and effort are not on the destination provider's rank list, there is no established ordering. The single-vendor review **fails loud** with a hint that names the rank list and how to add the config to it. No reviewer is guessed (D6 rule 5). Ruling #5 is unchanged.
