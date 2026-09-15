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
