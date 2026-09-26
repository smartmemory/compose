# COMP-AGENT-DEVIN-1: Compose accepts Devin as an agent — Design

**Status:** DESIGN · **Date:** 2026-09-26 · **Scope:** narrow v1 (owner, 2026-09-26)

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

A **bare** `devin` (no tier) sends no model and no effort, so stratum applies its own default
`swe-2-high` — the same "provider default" meaning a bare `codex` has today.

### D3 — Sandbox reaches Devin

`lib/result-normalizer.js:384` forwards `sandboxMode` for codex only, so a Devin implementer or
consumer worker asking for `workspace-write` (`lib/build.js:1899,5270,6268`) would silently run
read-only. The rule becomes an exhaustive switch: `codex` and `devin` ⇒ `opts.sandboxMode ??
'read-only'`; `claude` ⇒ none (unchanged). Tool filters and `thinking` stay Claude-only
(`:389`); `local` execution stays Claude-only (`:472,640,663`) — Devin always goes through
`stratum.agentRun`.

**Templates are not portable, and v1 says so rather than pretending.** Compose templates are Claude
tool allow/deny lists (`server/agent-templates.js:12-35`); Devin, like Codex today, cannot enforce
them — its boundary is the OS sandbox (read-only vs workspace-write). v1 treats a Devin agent string
with a template exactly as Codex's is treated today (the template does not constrain the run), and the
README states it. Enforcing templates for sandbox agents is out of scope for both.

### D4 — A reported $0 is a known cost

Devin reports `usd: 0` with `usdSource: "estimated"` (`stratum/ts/src/connectors/devin.ts:399`). Compose
treats only a **positive** total as known: the fallback adoption at `lib/result-normalizer.js:788` and
the per-dispatch record at `:817` both require `> 0`, so a Devin dispatch's record loses `cost_usd`,
counts as unknown spend, and can fail cost verification (`lib/build.js:2390,2417`). The rule becomes: a
total is known when it is a finite number **≥ 0 reported with provenance** (`reported`/`estimated`) and
no step is unpriced (`usdUnknownSteps === 0`). A zero that comes only from the absence of usage events
stays unknown — the guard's original purpose. Claude and Codex records must be byte-identical before
and after (their costs are positive, or genuinely unknown).

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
as for Claude. The GSD direct dispatch (`lib/gsd.js:673`) needs no change for an explicitly named
Devin step (it already forwards the agent string to `stratum.agentRun`).

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

- **Golden (live, controller-run, macOS, real devin `swe-2-medium`, requires P0):** a consumer-dispatch
  worktree fan-out whose stage is `devin::fast` runs through Compose's real consumer executor
  (`runConsumerIssuance` → `runAndNormalize` → `stratum_agent_run`), edits a file in its worktree
  (proves D3), and its dispatch record carries `model: "swe-2-medium"`, `effort: "medium"`,
  `cost_usd: 0`, `usd_source: "estimated"` (proves D2 and D4). Cleanup of worktrees, run dirs and the
  devin config check as in stratum's goldens.
- **Error harness (table-driven, no network):** `validateAgentString` accepts `devin`, `devin::fast`,
  `devin::critical`, rejects `devin::coordinator` ("not available for provider devin") and `gemini`
  (error lists all three); `build.js` programmatic role checks accept Devin; runtime role references
  resolve `devin:…` to `devin`.
- **Contract:** each widened schema accepts `devin` and still rejects an unknown provider.
- **Unit (replace several integration tests):** tier tables (`swe-2-*` + effort per tier, no
  thinking); sandbox forwarding table over the three providers; the cost rule — Devin `0` +
  `estimated` ⇒ `cost_usd: 0`; no usage events ⇒ still unknown; Claude/Codex records unchanged; the
  role map — every provider maps, `--implementer devin` alone ⇒ reviewer Codex, both explicit Devin ⇒
  warning.
- **Hermetic rule (stratum S2 landmine):** no non-live test may reach a real devin — every Devin
  dispatch in a unit or integration test uses a fake `stratum` client, and the suite is run once with a
  tripwire `devin` first on `PATH` under the real `HOME`.

## Slices

One slice: D1–D6 with their tests; the golden is controller-run after P0.
