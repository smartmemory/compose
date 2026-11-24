# Routing and Devin

Reference for Compose's model routing (shadow mode) and for explicit Devin agents. The README links here so the first page stays short.

## Model routing (shadow)

`fable-astra` defaults to shadow routing, only `plan` and `execute` opt into
future learning with `route: { learn: true }` on their profile entries. Bundled
GSD defaults to off. Programmatic `runBuild` / `runGsd` callers select
`route_mode: 'off'` or `'shadow'`, and the CLI takes `--route-mode=off|shadow`.

Shadow retains an immutable start, admissions and issuance journal while keeping
static model options and prompts. GSD continuation shares that start across new
engine runs, unresolved calls hold before redispatch. Manual overrides replace
the fallback, an item's explicit tier still wins. Off preserves legacy input and
dispatch identity and makes no routing writes. A participating resume keeps its
recorded mode even if the caller requests off.

Custom sidecars use `{ default: 'claude::critical', route: { learn: true } }` and
optional `_routing: { mode: 'shadow' }`. A route-only wrapper projects to the
legacy string for hashing, entries with `tier_from` retain object form, as do
existing objects without `route`. Custom flow inputs must declare
`route_mode`, `routing_start`, `routing_root`, `routing_plan_intent`, and
`routing_continuation` as optional strings (`string?`), without defaults or
model-facing interpolation. Shadow GSD refuses customized ordinary profiles
that differ from its bare dispatch (`ROUTING_STATIC_DISPATCH_MISMATCH`).

Shadow now joins each supported issuance to connector-owned primary and repair
calls, preserves pre-reset gate evidence, and records acceptance outcomes in
`.compose/routing/ledger.jsonl`. Late receipts stay with their original run,
including across GSD continuation. The append-only ledger retains revisions,
`readRoutingLedger({ cwd })` returns the latest validated row per record.
Unsupported calls retain separate excluded observations, their cost may also
appear in a parent row, so reconcile spend by unique paid receipt, not row sums.
Missing cost, attribution, acknowledgement or outcome evidence stays explicit
and incomplete or censored, it is not a zero-cost success.

Deterministic engine tests do not certify provider execution. Live-fire shadow
completion evidence remains **outstanding**. There is no routing report,
calibration prompt or feedback, learned/active selection, trial or exploration
implementation yet, the parent feature remains incomplete pending S2/S3.

Pick the mode for one run with `--route-mode=off|shadow` (for example `compose build FEAT-1 --route-mode=off`). The project default lives in `.compose/compose.json` under `routing.mode`. Programmatic `runBuild` and `runGsd` callers pass `route_mode: 'off'` or `'shadow'`.

## Explicit Devin agents

Use `--implementer=devin::fast` or `--reviewer=devin::standard` (the flag takes an equals sign, not a space), or author a
bare `agent: devin` stage with a matching profile sidecar (`"execute": "devin::fast"`).
Literal `agent: "devin::fast"` in YAML is unsupported, a sidecar must match the stage's provider.
Devin tiers are critical (`swe-2-max`/max), standard (`swe-2-high`/high), and
fast/budget (`swe-2-medium`/medium). Bare `devin` leaves model and effort to Stratum,
coordinator is unavailable. Defaults, automatic routing, and preset assignments are unchanged.
A Devin-capable Stratum runtime and authenticated Devin CLI on macOS are required.

Consumer fan-out stages support Devin, ordinary GSD direct steps refuse it with a
named error. Claude tool templates are not enforced for Codex or Devin: their
boundary is the requested OS sandbox (`read-only` or `workspace-write`). Devin
currently supplies final message/usage events, without per-tool observability.

A zero USD cost is known only with producer-stated `reported` or `estimated`
provenance and no unpriced steps. This includes Devin's estimated $0 and Claude's
explicit reported $0. Legacy unlabeled zeros remain unknown. A dollar ceiling
cannot limit zero-priced work, token, time, and action limits still apply.
