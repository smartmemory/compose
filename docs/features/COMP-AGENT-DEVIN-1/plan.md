# COMP-AGENT-DEVIN-1 — Implementation plan

**Status:** COMPLETE (implementation + review) · **Created:** 2026-09-26 · Design: `design.md` r3 (`edd702e`), gate passed.

**Trail (2026-09-27):** impl `355d498` (Codex astra/medium) → review r1 NOT CLEAN 2M (raw-path zero bypass; golden
timeout cleanup) → `810b28f` (sol/high) → r2 NOT CLEAN 2M+1L, all in the golden's abort path → `4daa305` → r3 CLEAN.
Controller: full node suite no regressions vs baseline `2106e32` (package-start 404 and two file-level timeouts are
pre-existing; run from a worktree needs a sibling `stratum` link — test helpers import `../../../stratum/ts/dist`),
test:ui 624/624, test:tracker 100/100, devin tripwire clean; live golden green incl. a real run through stratum's named
`empty model list` transient (first attempt failed, Compose retried, second succeeded).

**Follow-ups (tracked here):** `lib/routing-ledger.js:268,287` candidate ladders stay Claude/Codex (COMP-MODEL-ROUTE Q3);
GSD direct steps for Devin (and profile/provenance passthrough for all providers); `test/package-start.test.js` 404 on
`main` (pre-existing, unrelated).

## Related Documents

- `docs/features/COMP-AGENT-DEVIN-1/design.md` — D1–D7, §Tests, owner decisions Q1–Q3
- Stratum: `stratum/docs/features/STRAT-AGENT-DEVIN-1/design.md` (the agent this feature admits)

## Roles

Codex `gpt-6-astra/medium` implements and reviews. Claude briefs, verifies, adjudicates, commits and
runs the live golden. Nothing is dispatched to Devin except by the golden.

## Test-run rules (Compose-specific traps)

- Always `COMPOSE_PORT=19997` (a live :4001 server captures test gates and hangs the run).
- Any test driving a consumer fan-out build sets and asserts `process.env.NODE_ENV = 'test'`
  (otherwise the local Claude path calls the real SDK).
- Node suite with a bounded timeout:
  `node --import ./test/suppress-expected-drift.js --test --test-timeout=90000 <files>`;
  vitest trees via `npm run test:ui` and `npm run test:tracker`.
- Tripwire `devin` first on `PATH` under the real `HOME` for every non-live run; report `CALLED`
  absent. Known load flakes (rerun alone): proof-run, lifecycle-guard-e2e, cli-remote, auth-store,
  lifecycle-routes.

## Slice 1 — D1–D7

Files (all `existing` unless marked): `lib/agent-string.js`, `lib/build.js`,
`lib/stratum-mcp-client.js`, `server/model-tiers.js`, `lib/result-normalizer.js`, `lib/gsd.js`,
`contracts/routing-start.schema.json`, `contracts/routing-record.schema.json`,
`contracts/review-result.json`, `contracts/comp-obs-contract.schema.json`, preset/sidecar header
comments naming "Claude/Codex only", `README.md`, `CHANGELOG.md`, tests under `test/` (new files
`test/agent-devin.test.js` (new), `test/agent-devin-cost.test.js` (new),
`test/agent-devin-golden.live.test.js` (new, gated `COMPOSE_DEVIN_LIVE=1`); existing test files only
where a pinned pair assertion must change — each listed in the report).

**D1 provider list**
- [x] `PROVIDERS = ['claude','codex','devin']` exported (frozen) from `lib/agent-string.js`;
      `KNOWN_PROVIDERS` derives from it
- [x] `lib/build.js:4159,4166` and `lib/stratum-mcp-client.js:85,109,129` import it; error text lists
      the three from the array; no remaining `['claude', 'codex']` literal in admission code (grep in
      report)
- [x] four contract enums widened (`routing-start` `:274`, `routing-record` `:1974`, `review-result`
      `meta.agent_type` keeps `judge`, `comp-obs-contract` `agent_started.metadata.agent`); nothing else
      in those files changes
- [x] "Claude/Codex only" comments corrected (`lib/build.js:2218,3854`, preset/sidecar headers)

**D2 tiers**
- [x] `DEVIN_MODEL_TIERS` + `DEVIN_TIER_THINKING` in `server/model-tiers.js`: critical `swe-2-max`/`max`,
      standard `swe-2-high`/`high`, fast and budget `swe-2-medium`/`medium`, coordinator `null`
- [x] `resolveTierModel`/`resolveTierThinking` exhaustive over the three providers (unknown ⇒ null);
      Devin never gets a `thinking` block
- [x] bare `devin` sends no model and no effort

**D3 sandbox**
- [x] `lib/result-normalizer.js:384` exhaustive switch: codex and devin forward
      `opts.sandboxMode ?? 'read-only'`; claude none; tool filters/thinking stay Claude-only; local
      execution stays Claude-only

**D4 known zero**
- [x] normalizer (`:788`, `:817`) and receipt conversion (`lib/build.js:2346`, `:2452`) keep a `0` USD
      only when the producer stated `reported`/`estimated` provenance and no step is unpriced;
      synthesized defaults (`:555-565`, `primaryUsdSource ?? 'estimated'`) never make a zero known —
      the raw producer provenance is tracked separately from the defaulted value
- [x] `lib/flow-state.js:67-69` unchanged

**D5 roles**
- [x] the flip at `lib/build.js:4181` becomes an exhaustive map `claude→codex`, `codex→claude`,
      `devin→codex`; `--codex`, replay and presets unchanged

**D6 GSD**
- [x] a Devin **ordinary** GSD step is refused before routing issuance/dispatch (`lib/gsd.js:~665`)
      with `devin is not supported for GSD direct steps yet (COMP-AGENT-DEVIN-1); use a consumer
      fan-out stage`; GSD consumer items unaffected

**D7 authoring forms** — no code change; covered by tests below.

**Tests (non-live; fake `stratum` client everywhere; none reaches a real agent):**
- [x] error harness: `validateAgentString` rows (`devin`, `devin::fast`, `devin::critical` ok;
      `devin::coordinator` "not available for provider devin"; `gemini` lists all three);
      programmatic role checks; runtime role refs `devin:…` → `devin`
- [x] authoring table through planning: bare `agent: devin` + sidecar `devin::fast` plans; literal
      `agent: "devin::fast"` and a Devin sidecar on a Claude stage rejected with their existing errors
- [x] contracts: each widened schema accepts `devin`, rejects `gemini`
- [x] tiers table; sandbox table over three providers incl. explicit `workspace-write` reaching the
      request; D5 map rows (`--implementer devin` alone ⇒ reviewer codex; both explicit devin ⇒ warning)
- [x] D4 fixtures (`test/agent-devin-cost.test.js`): Devin real result shape ⇒ known `0` through
      normalizer AND receipt, and `flow-state` spend verification passes; legacy zero without
      `usd_source` ⇒ unknown; partially unpriced ⇒ unknown; Claude stated `0`/`reported` ⇒ known zero;
      positive Claude and positive Codex records byte-identical to `main`
- [x] attribution: start with both `devin::fast` and `devin::budget` ⇒ `unknown`; only `devin::fast`
      ⇒ `known` `fast`
- [x] GSD refusal: fake client records no `agentRun` call

**Golden 2-in-1 (live, controller-run, `test/agent-devin-golden.live.test.js`, gated
`COMPOSE_DEVIN_LIVE=1`, macOS, real devin `swe-2-medium`):**
- [x] authored spec, consumer-dispatch worktree fan-out, stage `agent: devin` + sidecar `devin::fast`,
      driven through the real build path (plan → consumer issuance → `runAndNormalize` →
      `stratum_agent_run` → `stratum_step_done`), `NODE_ENV=test` asserted, `COMPOSE_PORT=19997`
- [x] the stage edits a file in its worktree; dispatch record `swe-2-medium`/`medium`, `cost_usd: 0`,
      `usd_source: "estimated"`; receipt `amount.usd: 0`/`estimated`; spend verification passes;
      executed tier `fast`/`known`
- [x] cleanup in `finally`: temp repo, worktrees, stratum run dirs, flow state; real
      `~/.config/devin/config.json` unchanged; no devin process or credentials copy left

**Docs + gate:**
- [x] CHANGELOG + README (Devin supported where named; authoring forms; GSD direct refusal; $0 rule
      incl. the Claude stated-zero change; templates not enforced for sandbox agents)
- [x] targeted node tests + `test:ui` + `test:tracker` green with the tripwire (controller-run)
- [x] live golden green (controller-run)
- [x] Codex astra/medium implementation review, fixes-only rounds (budget ~3; M+ after round 3 ⇒ ask)

## Landing (owner, 2026-09-26)

When complete: merge `comp-agent-devin-1` into Compose `main`, record completion, delete the worktree
and branch, and remove other stale worktrees/branches (strict: merged, clean, unused; ask on doubt).
