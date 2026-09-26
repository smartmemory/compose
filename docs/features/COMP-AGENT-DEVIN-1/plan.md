# COMP-AGENT-DEVIN-1 — Implementation plan

**Status:** IN_PROGRESS · **Created:** 2026-09-26 · Design: `design.md` r3 (`edd702e`), gate passed.

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
- [ ] `PROVIDERS = ['claude','codex','devin']` exported (frozen) from `lib/agent-string.js`;
      `KNOWN_PROVIDERS` derives from it
- [ ] `lib/build.js:4159,4166` and `lib/stratum-mcp-client.js:85,109,129` import it; error text lists
      the three from the array; no remaining `['claude', 'codex']` literal in admission code (grep in
      report)
- [ ] four contract enums widened (`routing-start` `:274`, `routing-record` `:1974`, `review-result`
      `meta.agent_type` keeps `judge`, `comp-obs-contract` `agent_started.metadata.agent`); nothing else
      in those files changes
- [ ] "Claude/Codex only" comments corrected (`lib/build.js:2218,3854`, preset/sidecar headers)

**D2 tiers**
- [ ] `DEVIN_MODEL_TIERS` + `DEVIN_TIER_THINKING` in `server/model-tiers.js`: critical `swe-2-max`/`max`,
      standard `swe-2-high`/`high`, fast and budget `swe-2-medium`/`medium`, coordinator `null`
- [ ] `resolveTierModel`/`resolveTierThinking` exhaustive over the three providers (unknown ⇒ null);
      Devin never gets a `thinking` block
- [ ] bare `devin` sends no model and no effort

**D3 sandbox**
- [ ] `lib/result-normalizer.js:384` exhaustive switch: codex and devin forward
      `opts.sandboxMode ?? 'read-only'`; claude none; tool filters/thinking stay Claude-only; local
      execution stays Claude-only

**D4 known zero**
- [ ] normalizer (`:788`, `:817`) and receipt conversion (`lib/build.js:2346`, `:2452`) keep a `0` USD
      only when the producer stated `reported`/`estimated` provenance and no step is unpriced;
      synthesized defaults (`:555-565`, `primaryUsdSource ?? 'estimated'`) never make a zero known —
      the raw producer provenance is tracked separately from the defaulted value
- [ ] `lib/flow-state.js:67-69` unchanged

**D5 roles**
- [ ] the flip at `lib/build.js:4181` becomes an exhaustive map `claude→codex`, `codex→claude`,
      `devin→codex`; `--codex`, replay and presets unchanged

**D6 GSD**
- [ ] a Devin **ordinary** GSD step is refused before routing issuance/dispatch (`lib/gsd.js:~665`)
      with `devin is not supported for GSD direct steps yet (COMP-AGENT-DEVIN-1); use a consumer
      fan-out stage`; GSD consumer items unaffected

**D7 authoring forms** — no code change; covered by tests below.

**Tests (non-live; fake `stratum` client everywhere; none reaches a real agent):**
- [ ] error harness: `validateAgentString` rows (`devin`, `devin::fast`, `devin::critical` ok;
      `devin::coordinator` "not available for provider devin"; `gemini` lists all three);
      programmatic role checks; runtime role refs `devin:…` → `devin`
- [ ] authoring table through planning: bare `agent: devin` + sidecar `devin::fast` plans; literal
      `agent: "devin::fast"` and a Devin sidecar on a Claude stage rejected with their existing errors
- [ ] contracts: each widened schema accepts `devin`, rejects `gemini`
- [ ] tiers table; sandbox table over three providers incl. explicit `workspace-write` reaching the
      request; D5 map rows (`--implementer devin` alone ⇒ reviewer codex; both explicit devin ⇒ warning)
- [ ] D4 fixtures (`test/agent-devin-cost.test.js`): Devin real result shape ⇒ known `0` through
      normalizer AND receipt, and `flow-state` spend verification passes; legacy zero without
      `usd_source` ⇒ unknown; partially unpriced ⇒ unknown; Claude stated `0`/`reported` ⇒ known zero;
      positive Claude and positive Codex records byte-identical to `main`
- [ ] attribution: start with both `devin::fast` and `devin::budget` ⇒ `unknown`; only `devin::fast`
      ⇒ `known` `fast`
- [ ] GSD refusal: fake client records no `agentRun` call

**Golden 2-in-1 (live, controller-run, `test/agent-devin-golden.live.test.js`, gated
`COMPOSE_DEVIN_LIVE=1`, macOS, real devin `swe-2-medium`):**
- [ ] authored spec, consumer-dispatch worktree fan-out, stage `agent: devin` + sidecar `devin::fast`,
      driven through the real build path (plan → consumer issuance → `runAndNormalize` →
      `stratum_agent_run` → `stratum_step_done`), `NODE_ENV=test` asserted, `COMPOSE_PORT=19997`
- [ ] the stage edits a file in its worktree; dispatch record `swe-2-medium`/`medium`, `cost_usd: 0`,
      `usd_source: "estimated"`; receipt `amount.usd: 0`/`estimated`; spend verification passes;
      executed tier `fast`/`known`
- [ ] cleanup in `finally`: temp repo, worktrees, stratum run dirs, flow state; real
      `~/.config/devin/config.json` unchanged; no devin process or credentials copy left

**Docs + gate:**
- [ ] CHANGELOG + README (Devin supported where named; authoring forms; GSD direct refusal; $0 rule
      incl. the Claude stated-zero change; templates not enforced for sandbox agents)
- [ ] targeted node tests + `test:ui` + `test:tracker` green with the tripwire (controller-run)
- [ ] live golden green (controller-run)
- [ ] Codex astra/medium implementation review, fixes-only rounds (budget ~3; M+ after round 3 ⇒ ask)

## Landing (owner, 2026-09-26)

When complete: merge `comp-agent-devin-1` into Compose `main`, record completion, delete the worktree
and branch, and remove other stale worktrees/branches (strict: merged, clean, unused; ask on doubt).
