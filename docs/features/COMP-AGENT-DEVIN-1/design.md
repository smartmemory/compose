# COMP-AGENT-DEVIN-1: Compose accepts Devin as an agent — Design

**Status:** DESIGN r2 (Codex design review r1: 1H 6M 1L, all upheld and folded in) · **Date:** 2026-09-26 · **Scope:** narrow v1 (owner, 2026-09-26)

## Related Documents

- Stratum side (shipped): `stratum/docs/features/STRAT-AGENT-DEVIN-1/design.md` (D1–D11) and `plan.md`
  — `devin` is a full stratum agent: `stratum_agent_run` foreground + background, `agent: devin` in
  flow IR, evaluator `route`. Stratum commit `faac451`, completion recorded.
- `docs/features/COMP-MODEL-ROUTE/design.md` — routing ladders; Q3 (repair-floor policy) still open.
  This feature does **not** add Devin to routing candidates (§Out of scope).
- `docs/features/COMP-AGENT-CAPS/plan.md` — `provider:template:tier` agent strings; templates bind
  through Claude SDK tool filters only.
- Research: a read-only Codex map of every Compose site that assumes `{claude, codex}` (2026-09-26,
  session scratchpad `codex-review-COMPDEVIN-research.log`). The load-bearing claims below were
  re-checked against the code by the controller; each carries its `file:line`.

## Why

Stratum now runs Devin (`swe-2-medium|high|max`, `usd: 0` estimated, OS sandbox on macOS). Compose,
which drives stratum for builds, still refuses it: its provider list is `{claude, codex}`
(`lib/agent-string.js:24`) and several paths are hard-wired to the pair. Stratum's own design recorded
this as the follow-up (`COMP-AGENT-DEVIN-1`: "Compose accepts devin, model tiers, routing ladder").

## Owner decisions (2026-09-26)

- **Q1 scope → narrow.** Devin works wherever it is **named explicitly** (`--implementer devin`,
  `--reviewer devin`, a pipeline step or profile sidecar that names it). Defaults, automatic routing,
  bug escalation, presets and the UI do not change.
- **Q2 tiers → `fast/standard/critical = swe-2-medium / swe-2-high / swe-2-max`**; `budget =
  swe-2-medium`; no Devin `coordinator` (stays Claude-only).
- **Q3 reviewer when roles collide → fixed fallback order**; Claude/Codex behaviour byte-identical.

## Prerequisite (not Compose code)

**P0 — the stratum runtime Compose resolves must know Devin.** Compose resolves stratum through
`node_modules/@smartmemory/stratum -> ../../../stratum/ts` and runs its compiled
`dist/mcp/main.js` (`lib/stratum-engine.js:181-227`). That `dist` is gitignored
(`stratum/ts/.gitignore:2`) and was built before Devin landed: `dist/connectors/runner.js` and
`dist/ir/schema.js` contain zero occurrences of `devin` (checked 2026-09-26). Until `npm run build`
runs in `stratum/ts` (or a stratum release ≥ the Devin commit is installed), every Devin dispatch fails
in stratum with its named "unknown agent" error. Compose adds **no** version gate for this: the
existing compatibility guard checks request property names, not agent values
(`lib/stratum-mcp-client.js:159,348`), and stratum's refusal is already a named, fail-closed error.

## Design

### D1 — One provider list, derived everywhere

`lib/agent-string.js` exports `PROVIDERS = ['claude', 'codex', 'devin']` (frozen) and
`KNOWN_PROVIDERS` derives from it. Every other admission site imports it instead of repeating a
literal: `lib/build.js:4159,4166` (programmatic implementer/reviewer checks) and
`lib/stratum-mcp-client.js:85,109,129` (runtime role references for steps and fan-out stages).
Error text lists the three from the same array. The CLI (`bin/compose.js:2782,2788`), experiments
(`lib/experiment.js:87-116`) and profile preflight (`lib/pipeline-profiles.js:35`) already delegate to
`validateAgentString` and inherit the change.

Contracts widened (enum `+ "devin"`, nothing else touched):
`contracts/routing-start.schema.json:274` and `contracts/routing-record.schema.json:1974`
(`Resolution.provider`), `contracts/review-result.json:71` (`meta.agent_type`, `judge` kept),
`contracts/comp-obs-contract.schema.json:301` (`agent_started.metadata.agent`). The
"TS accepts only Claude/Codex" comments (`lib/build.js:2218,3854`, the preset/sidecar headers) are
corrected to name the three.

### D2 — Devin model tiers

`server/model-tiers.js` gains a third table beside `MODEL_TIERS` / `CODEX_MODEL_TIERS`:

| tier | model | effort |
|---|---|---|
| critical | `swe-2-max` | `max` |
| standard | `swe-2-high` | `high` |
| fast | `swe-2-medium` | `medium` |
| budget | `swe-2-medium` | `medium` |
| coordinator | — (null: "not available for provider devin") | — |

The table stores the **full id plus the matching effort** because that is exactly what stratum reports
as the executed identity (`stratum/ts/src/connectors/devin-model.ts:61`,
`devin.ts:416` → `{ model: "swe-2-high", effort: "high" }`), and Compose attributes the executed tier by
matching provider + model + effort (`lib/routing-ledger.js:1154`). Stratum accepts a full id with a
matching effort (it rejects only a *conflicting* one, `devin-model.ts:79-95`).
`resolveTierModel` / `resolveTierThinking` (`server/model-tiers.js:82,94`) become an exhaustive
per-provider lookup over the three tables (unknown provider ⇒ null, as today). Devin gets no
`thinking` block — that stays Claude-only (`lib/agent-string.js:115`); stratum rejects `thinking` for
devin.

**Attribution collision, same as Codex today (review r1 M5).** `fast` and `budget` both resolve to
`swe-2-medium`/`medium`. `routingExecutedTier` matches a reported identity against every mapping in
the routing start and needs exactly one distinct tier (`lib/routing-ledger.js:1161-1163`), so a start
whose profiles name **both** `devin::fast` and `devin::budget` records a medium/medium Devin run as
`unknown` (`unmapped-or-conflicting-execution`), never as the wrong tier. Codex has the identical
overlap (`gpt-6-luna`/`medium` at both, `server/model-tiers.js:38-55`). v1 keeps the owner's map and
this semantics, and tests it; a start naming only one of them attributes normally.

A **bare** `devin` (no tier) sends no model and no effort, so stratum applies its own default
`swe-2-high` — the same "provider default" meaning a bare `codex` has today.

### D3 — Sandbox reaches Devin

`lib/result-normalizer.js:384` forwards `sandboxMode` for codex only, so a Devin implementer or
consumer worker asking for `workspace-write` (`lib/build.js:1899,5270,6268`) loses the boundary it
requested: stratum then resolves Devin's mode from its own config layers (built-in default
`read-only`, but a user or project `stratum.toml` can change it — `stratum/ts/src/connectors/runner.ts:109-120`,
`config/index.ts:108-133`), so the run gets whatever that config says rather than what Compose asked
for (review r1 L8). The rule becomes an exhaustive switch: `codex` and `devin` ⇒ `opts.sandboxMode ??
'read-only'`; `claude` ⇒ none (unchanged). Tool filters and `thinking` stay Claude-only
(`:389`); `local` execution stays Claude-only (`:472,640,663`) — Devin always goes through
`stratum.agentRun`.

**Templates are not portable, and v1 says so rather than pretending.** Compose templates are Claude
tool allow/deny lists (`server/agent-templates.js:12-35`); Devin, like Codex today, cannot enforce
them — its boundary is the OS sandbox (read-only vs workspace-write). v1 treats a Devin agent string
with a template exactly as Codex's is treated today (the template does not constrain the run), and the
README states it. Enforcing templates for sandbox agents is out of scope for both.

### D4 — A reported $0 is a known cost

Devin reports `usd: 0` with `usdSource: "estimated"` (`stratum/ts/src/connectors/devin.ts:399,412-416`).
Compose drops a zero at **three** points, and all three must change or the fix fails one layer later
(review r1 H1):

1. **Normalizer** — the fallback adoption at `lib/result-normalizer.js:788` and the per-dispatch
   record at `:817` require `> 0`, so the record loses `cost_usd`.
2. **Receipt conversion** — `lib/build.js:2346` keeps `usd` only when `> 0`; `reportUsageReceipts`
   (`:2417`) then attaches provenance only when USD survived (`:2452`).
3. **Spend verification** — `lib/flow-state.js:67-69` rejects a receipt with tokens or time but no
   `usd` as `Paid call cost missing`. This check is **kept as is**: it is correct once 1 and 2 stop
   dropping a known zero.

**The rule: a zero is known only when the producer stated it with provenance.** Concretely, a USD
value of `0` survives 1 and 2 only when it arrived together with a `usdSource`/`usd_source` of
`reported` or `estimated` **set by the producer** (the connector result or the usage event itself),
and no step is unpriced (`usdUnknownSteps === 0`). Provenance that Compose **synthesizes** — the
`?? 'reported'` / `?? 'estimated'` defaults (`lib/result-normalizer.js:555-565` and `:817`'s
`primaryUsdSource ?? 'estimated'`) — never makes a zero known (review r1 M6). Exact regression
fixtures: a `step_usage` event `{input_tokens:10, output_tokens:1, cost_usd:0}` with **no**
`usd_source`, followed by a result with no authoritative USD ⇒ stays **unknown** (older servers
hardcode zero — `:779-780`); a stream where one step is unpriced ⇒ stays unknown; Devin's real
result shape (`usage.usd: 0`, `usdSource: "estimated"`) ⇒ known `0`, `usd_source: "estimated"`, and the
receipt carries `amount.usd: 0` with `usdSource: "estimated"` and passes `flow-state.js`.

**Stated exception to "Claude/Codex unchanged" (review r1 M7):** stratum's Claude connector already
emits a producer-stated `total_cost_usd: 0` with `"reported"` provenance
(`stratum/ts/src/connectors/claude.ts:182-196`). Under the rule that record changes from unknown to a
known zero — the correct outcome, and the only intended change for Claude or Codex. Codex omits
unpriced amounts (`codex.ts:565-589,732-734`), so its unknowns stay unknown. Every other Claude/Codex
record (positive, or no stated provenance) is byte-identical; a test pins both halves.

Consequence, stated: a dollar ceiling cannot limit zero-priced Devin work; token, time and action
limits still apply (no divide-by-price site exists — `lib/flow-state.js:71`, `lib/output-gate.js:55`,
`lib/budget-ledger.js:132`).

### D5 — Implementer/reviewer: fixed fallback, Claude/Codex unchanged

`lib/build.js:4152-4190` defaults to Claude implements / Codex reviews (`--codex` swaps), and when the
two resolve to the same provider and only one was given, flips the other with
`codex ? 'claude' : 'codex'` (`:4181`). With Devin:

- A Devin role can only collide if **both** roles are given explicitly as Devin (the defaulted role is
  always Claude or Codex) — that keeps today's warning and disables cross-model review for the run.
- The flip becomes an exhaustive map so no provider ever falls through silently: `claude → codex`,
  `codex → claude`, `devin → codex`. The Devin row is the owner's fixed fallback; it is unreachable
  from the CLI today and exists so a future default cannot land on an unmapped provider.
- `--codex`, routing replay (`:4191`) and the Fable/Astra preset's deliberate Codex/Codex pairing are
  unchanged.

The two-bucket cross-model result (`contracts/cross-model-review-result.json`, `claude_only` /
`codex_only`) is **not** reached by a Devin reviewer: its synthesizer `normalizeCrossModelResult`
(`lib/review-normalize.js:260`) has no caller in `lib/`, `server/` or `bin/` (grep 2026-09-26; only
tests and `shouldRunCrossModel`'s size predicate reference the family). Left as is.

### D6 — Preflight and platform

The detached-worktree write probe is Codex-specific (`lib/build.js:4541`, `lib/codex-preflight.js:140`)
and is not extended. Stratum already refuses a sandboxed Devin run off macOS, a missing login, and a
worktree grant overlapping `~/.stratum`, each with a named error before spawn; Compose surfaces those
as the step's failure. Transport reporting (`lib/stratum-mcp-client.js:180`) reports `null` for Devin,
as for Claude.

**GSD ordinary steps refuse Devin in v1 (review r1 M2, M3).** GSD's direct dispatch
(`lib/gsd.js:673`) passes only the agent string, cwd and telemetry — no sidecar profile, model, effort
or sandbox (the MCP client strips the string to its provider, `lib/stratum-mcp-client.js:185-196`) —
and copies only `usage.usd_source`, dropping the top-level `usdSource` stratum returns
(`lib/gsd.js:698-710`). A Devin step there would run the default model, read-only, and lose its
cost provenance. The profile gap is pre-existing for every provider; the provenance gap bites only a
producer that reports provenance at the top level, which Devin does. v1 therefore refuses a Devin
**ordinary** GSD step before dispatch with a named error (`devin is not supported for GSD direct
steps yet (COMP-AGENT-DEVIN-1); use a consumer fan-out stage`). GSD consumer fan-out items go through
the consumer executor (`runAndNormalize`) and are supported. Fixing GSD's direct path for all
providers is a follow-up.

### D7 — Supported authoring forms (review r1 M4)

Stratum's IR accepts only a bare agent name (`stratum/ts/src/ir/schema.ts:42,66`), and Compose strips
`provider:template:tier` down to the provider **only** for runtime role references
(`lib/stratum-mcp-client.js:105-113,125-135`). So, exactly as for Codex today:

- **Supported:** a spec step or stage with bare `agent: devin`, optionally tiered through a matching
  profile sidecar entry (`"devin::fast"`); and the role references `$.input.implementer_agent` /
  `$.input.reviewer_agent` fed `devin` or `devin::<tier>` via `--implementer` / `--reviewer`.
- **Not supported (unchanged behaviour, named error from planning):** a literal tiered agent in the
  spec (`agent: "devin::fast"`), and a sidecar naming Devin for a stage whose agent is omitted or names
  another provider — the existing provider-equality check (`lib/pipeline-profiles.js:37,98`) rejects it.
  The design widens the provider list; it does not change these rules.

## Out of scope (follow-ups)

- Devin in routing **candidate** ladders and pinned candidate mappings (`lib/routing-ledger.js:268,287`)
  — entangled with COMP-MODEL-ROUTE Q3. An explicitly chosen Devin profile still reaches the routing
  record through `preflight.resolved` (`routingModelMappings`, `:285`), so its executed tier is
  attributed.
- Defaults, presets, profile sidecars and shipped pipelines naming a provider; bug escalation's fixed
  Codex→Claude pair; `--devin` shortcut; setup detection; questionnaire; UI/TUI agent lists, colours
  and avatars.
- Cross-model result format with more than two named participants.
- Template enforcement for sandbox agents (Codex and Devin alike).
- Per-tool observability: Devin's connector emits `agent_started` then the final message and usage,
  not per-tool events, so tool-based stuck detection and the post-step capability audit see nothing
  for a Devin step (`lib/gsd-stuck.js:105`, `lib/build.js:5584`). Documented, not fixed.

## Tests (testing.md hierarchy)

- **Golden (live, controller-run, macOS, real devin `swe-2-medium`, requires P0):** an authored spec
  whose consumer-dispatch worktree fan-out stage is bare `agent: devin` with a sidecar entry
  `devin::fast` goes through the **whole** Compose path — plan (`resolvePlanSpecValues`, profile
  preflight) → `runConsumerIssuance` → `runAndNormalize` → `stratum_agent_run` → `stratum_step_done`
  (not a direct call into the executor). It edits a file in its worktree (D3); its dispatch record
  carries `model: "swe-2-medium"`, `effort: "medium"`, `cost_usd: 0`, `usd_source: "estimated"`; its
  **receipt** carries `amount.usd: 0`, `usdSource: "estimated"` and the flow's spend verification
  (`lib/flow-state.js`) passes (D4); the routing record's executed tier is `fast`, status `known`
  (D2). Cleanup of worktrees, run dirs and the devin config check as in stratum's goldens.
- **Error harness (table-driven, no network):** `validateAgentString` accepts `devin`, `devin::fast`,
  `devin::critical`, rejects `devin::coordinator` ("not available for provider devin") and `gemini`
  (error lists all three); `build.js` programmatic role checks accept Devin; runtime role references
  resolve `devin:…` to `devin`; the authoring table of D7 through planning — bare `agent: devin` +
  sidecar plans, literal `agent: "devin::fast"` and a Devin sidecar on a Claude stage are rejected with
  their existing named errors; a Devin ordinary GSD step is refused with D6's named error before any
  dispatch (fake client records no `agentRun` call).
- **Contract:** each widened schema accepts `devin` and still rejects an unknown provider.
- **Unit (replace several integration tests):** tier tables (`swe-2-*` + effort per tier, no
  thinking); sandbox forwarding table over the three providers, including explicit `workspace-write`
  forwarded when a (fake) stratum config would say `read-only`; the D4 fixtures — Devin's real result
  shape ⇒ known `0` through normalizer **and** receipt conversion; legacy zero without `usd_source` ⇒
  unknown; partially unpriced stream ⇒ unknown; Claude stated `0`/`reported` ⇒ known zero (the stated
  exception); a positive Claude and a positive Codex record byte-identical to today's; the attribution
  collision — a start naming both `devin::fast` and `devin::budget` ⇒ `unknown`, only one ⇒ `known`;
  the role map — every provider maps, `--implementer devin` alone ⇒ reviewer Codex, both explicit
  Devin ⇒ warning.
- **Hermetic rule (stratum S2 landmine):** no non-live test may reach a real devin — every Devin
  dispatch in a unit or integration test uses a fake `stratum` client, and the suite is run once with a
  tripwire `devin` first on `PATH` under the real `HOME`.

## Slices

One slice: D1–D7 with their tests; the golden is controller-run (P0 done 2026-09-26: `stratum/ts/dist` rebuilt from `6103f5e`, contains devin).
