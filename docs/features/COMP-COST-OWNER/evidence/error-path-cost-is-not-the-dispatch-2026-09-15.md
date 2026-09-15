# CORRECTED: the cost IS this dispatch's. The real defect is a SCOPE MISMATCH between cost and tokens.

> **CORRECTION 2026-09-15 (same day, before any fix was written).** The headline below —
> "the cost is not this dispatch's" — is **WRONG** and was refuted by a read-only astra trace
> against the SDK distribution and the dispatch's own transcript. The original text is kept
> verbatim underneath, because the reasoning error is the lesson.
>
> **What is actually true:**
>
> | SDK field | Scope |
> |---|---|
> | `total_cost_usd` | this call's cost **including its subagents** (whole agent tree) |
> | `usage` | **main agent only, excluding subagents** |
> | `modelUsage` | usage + cost across the tree, grouped by model |
>
> The $4.3736 is real spend for that dispatch. The dispatch spawned **three subagents on
> `claude-opus-4-8`** and burned **57,551 cache-creation + 129,394 cache-read** tokens. Pricing
> the transcript reproduces **$4.33262295** of the recorded $4.37359795 (~$0.041 unexplained —
> substantial reconciliation, not exact verification).
>
> The `2370` is also exactly reproducible: 8 uncached input + 2,362 output across four
> main-agent requests. `tokens_in=8` is coherent — it is *uncached* input, not a truncation.
>
> **My error was the comparison itself:** I divided whole-tree DOLLARS by main-agent
> non-cache TOKENS and read the ratio as an anomaly. It is a unit mismatch, not a defect in
> the number. This is the roll-up error this feature has now made three times — see the
> method note in `build-3e95eb77-trace-2026-09-14.md`.
>
> **The real defect, which is worse and affects BOTH paths:** `lib/local-claude-connector.js`
> records `total_cost_usd` (whole tree) beside only `raw.usage.input_tokens/output_tokens`
> (main agent, no cache, no `modelUsage`). So **every dispatch row pairs whole-tree cost with
> partial main-agent tokens**, and any $/token computed from a ledger row is meaningless.
> `583b14f` did not cause this — it changed neither path's source field — but by adding
> `usd_source: 'reported'` it attached provenance to the dollars while the tokens beside them
> stayed silently incomplete.
>
> **Smallest correct change (stated, not designed):** report dispatch-wide tokens from
> `modelUsage`, preserving cache categories and per-model attribution, on both paths; keep
> attributable SDK cost with producer-stated provenance; leave unknown unknown.
>
> **Undetermined:** the transcript records runtime 2.1.206 while the inspected distribution is
> 2.1.114 (corroboration, not proof of the historical executable); ~$0.041 unreconciled. The
> settling artifact is the original terminal SDK result with `modelUsage` per-model `costUSD`.
>
> Evidence: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2878`;
> `lib/local-claude-connector.js:241`, `:257`, `:278`; `lib/result-normalizer.js:313`;
> transcript `~/.claude/projects/-Users-ruze-reg-my-forge-compose/7465ecdf-*.jsonl:14,21,31,41`.

---

## ORIGINAL (2026-09-15, superseded above) — retained for the reasoning error

# The SDK failure path reports a cost that is NOT this dispatch's — and we now label it 'reported'

**2026-09-15.** Found by the first real `compose build` run after `583b14f`. This is a live-fire
finding: no unit test in the suite could have produced it, because the fake SDK client returns
whatever the fixture says.

## The observation

`compose build COMP-TUI-4` died in its first step when the Claude session limit was hit. The
dispatch row it wrote:

```
2026-09-14T16:18:18Z  dispatch  claude  claude-sonnet-4-6  step=explore_design
  tokens_total=2370  tokens_in=8  usd=4.373597950000001  usd_source=reported  outcome=error
```

**$4.3736 for 2,370 tokens is $1.845 per 1k.** Every other `claude-sonnet-4-6` row in this
ledger sits between **$0.0443 and $0.3348 per 1k** (n=40, all `outcome=ok`). At Sonnet's list
output rate (~$15/Mtok), $4.3736 would require roughly **290,000 output tokens** — 122x the
2,370 recorded. **The dollar figure cannot be this dispatch's cost.**

`tokens_in=8` alongside `tokens_total=2370` is independently incoherent, so BOTH the split and
the total are suspect on this path, not just the dollars.

Most likely mechanism (candidate, NOT verified): on an `SDKResultError` the Claude Agent SDK's
`total_cost_usd` carries the **session-cumulative** spend rather than the failed turn's, so a
session that had already spent ~$4.37 reports that whole figure as one dispatch's cost. That
matches the failure being a *session limit* — the number looks like an exhausted session's
total.

## Why this matters more after today than before

`583b14f` changed the failure path in `lib/local-claude-connector.js` from
`nonneg(raw.total_cost_usd)` to `reportedNumber(...)` and added `usd_source: 'reported'`. The
intent was right — stop coercing an unknown cost to `$0`, and label a provider-reported number.
The consequence, unforeseen, is that **a wrong number is now stamped with provenance that says
"the provider told us this"**, which is exactly the authority `usd_source` exists to confer.

Before: an unlabelled, uncoerced number that downstream could refuse.
After: a labelled number that downstream is designed to trust.

This is the S2 defect class inverted — not "unknown silently becomes free", but "wrong silently
becomes authoritative". The accumulator (v5, `5b9ffd1`) folded this row in and the
`build-actuals` row carries `usd=4.373597950000001` as the build's cost.

## Not yet established

- **Whether `total_cost_usd` is genuinely cumulative on the error path.** The mechanism above is
  a candidate. It needs the SDK's own contract read, or a second failure observed at a known
  session spend. Do not write the fix until it is established — per this feature's method rule,
  trace the value from its set-site, never assert from the shape.
- Whether the SUCCESS path shares the problem. All 40 in-range rows are `outcome=ok`, which is
  evidence that it does not, but they predate `583b14f`.
- Whether `tokens_total=2370`/`tokens_in=8` are wrong by the same mechanism or a different one.

## Falsifier

```sh
python3 - <<'PY'
import json
for l in open('.compose/data/dispatch-ledger.jsonl'):
    r=json.loads(l)
    if r.get('kind')=='dispatch' and r.get('agent')=='claude' and r.get('outcome')=='error' and r.get('usd') and r.get('tokens_total'):
        print(r['ts'], r['usd']/r['tokens_total']*1000, '$/1k')
PY
```
Resolved when error-path rows sit in the same $/1k band as ok rows, or when the connector stops
labelling a cost it cannot attribute to the dispatch.

## Related

- The two fixes this run WAS meant to confirm: see
  `token-tally-15x-reconciled-2026-09-14.md` and design.md open question 0b.
- Partial confirmation achieved: `tokens_in` IS populated and `usd_source` IS stamped on a real
  row, so `e849aa1`'s split capture and `583b14f`'s provenance both fire live. Stratum's codex
  cost estimate (`00ff4db`) remains unconfirmed — the build died before `codex_review`.
