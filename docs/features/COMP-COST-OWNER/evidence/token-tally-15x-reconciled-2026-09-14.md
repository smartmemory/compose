# The ~15x token disagreement — RECONCILED. Both numbers are exact. Cost: $0, read-only.

**2026-09-14.** Open question raised in `build-3e95eb77-trace-2026-09-14.md`: compose records
**425,284** tokens for one dispatch inside flow `4122e695`, while stratum's own tally for the
whole 15-dispatch flow reads `flowSpent.tokens = 28279`. Traced by a Codex astra/medium
read-only pass across both repos; adjudicated by the controller against the persisted records
it cites.

## Verdict

**Both figures reconcile exactly from persisted data, and the mechanism is NOT cached-input
double-counting.** It is missing usage forwarding: at the commit that ran this build, compose
attached usage to fanout-item completions but NOT to ordinary step-completion envelopes, so
stratum's `BudgetLedger` only ever received four token reports out of fifteen dispatches.

## Expression behind 425,284 (compose's `tokens_total` on the `test_review` row)

The original Codex session survives outside both ledgers:
`~/.codex/sessions/2026/08/19/rollout-2026-08-19T00-09-26-01a015a2-….jsonl`. Identity is
established three ways — the `test_review` / `COMP-GUARD-CLAIM-1` prompt (line 9), the
compose cwd + commit (line 1), and completion at `16:11:11`, matching
`dispatch-ledger.jsonl:74`.

Nine model requests. Summing their `last_token_usage` reproduces the session's final
`total_token_usage` exactly:

```
Σ input  (9 requests)  = 421,938   ← 78,130 uncached + 343,808 cached, counted ONCE
Σ output (9 requests)  =   3,346
connector usage.tokens = 425,284
```

`codexUsageFields` accumulates input and output and returns `tokens: input + output`
(`stratum/ts/src/connectors/codex.ts:255`, `:626`); compose records `finiteOrNull(usage.tokens)`
unchanged (`lib/stratum-mcp-client.js:260`). The 343,808 cached-input tokens sit inside the
421,938 once. **Nothing adds them a second time.**

So: 425,284 is a real, provider-reported input+output count for ONE agent dispatch that made
NINE model requests, dominated by re-read context. Previous note's "do not quote 425,284 as a
token count" is lifted — quote it, with that meaning.

## Expression behind 28,279 (stratum's `flowSpent.tokens`)

```
execute.items[0].attempts[0].usage.tokens         8,490   flow:487
review_lenses.items[0].attempts[0].usage.tokens   7,536   flow:726
review_lenses.items[1].attempts[0].usage.tokens   8,564   flow:791
review_lenses.items[2].attempts[0].usage.tokens   3,689   flow:835
                                                 ──────
                                                 28,279
```

(`~/.stratum/ts/flows/4122e695-3b1b-45b2-86be-d446e0cae0f4.json`.) The four
`fanout_ledger_debit` events independently reproduce the same total and exactly reproduce the
flow's USD and milliseconds. `BudgetLedger` is `spent[key] = (spent[key] ?? 0) + amount[key]`
(`stratum/ts/src/engine/ledger.ts:33`, fed from `engine.ts:2658`) — **no cache subtraction,
no filtering.** It summed what it was given, and it was given four reports.

`test_review` and both `docs` attempts carry dispatch counts but NO token usage in the flow
file (`flow:1157`, `flow:1170`).

## Mechanism, one sentence

At compose commit `a48c40a9` (the checkout that ran this build), `lib/build.js:1046-1047`
attached usage to fanout-item completions while `:3744-3756` built ordinary step-completion
envelopes without it, and stratum reads `result.usage ?? {}` — so eleven of fifteen dispatches
debited nothing.

## What each number means now

| Figure | Meaning | Trustworthy for "tokens this work cost"? |
|---|---|---|
| 425,284 | provider-reported input+output for ONE codex dispatch, 9 requests, cache reads included once | yes, for that dispatch |
| 28,279 | exact subtotal of the 4 fanout reports stratum received | no — an incomplete subtotal, not a flow total |

**Neither is the flow's complete token cost.** That figure needs provider usage (with cache
fields) for every dispatch, joined to step/attempt; the persisted flow has neither the receipts
nor the splits for the eleven missing ones.

## Corrections to prior evidence

- `build-3e95eb77-trace-2026-09-14.md` § "OPEN QUESTION" — the cached-input candidate is
  refuted; the "never put the two tallies in one ratio" rule stands for a different reason
  (one is complete for one dispatch, the other is an incomplete subtotal).
- Same doc's claim that the Codex input/output split for that dispatch is unrecoverable is
  **disproved** — the raw session under `~/.codex/sessions/` has it. This does not make the
  ledger's historical rows repriceable in general; it means THIS one can be, by hand.
- Whether the envelope omission is still live on `main` is **not established here** — the
  finding is pinned to `a48c40a9`. Falsifier: read the current `lib/build.js` step-completion
  envelope builder and check whether `usage` is attached.

## Limits

- Read-only; the oracle command could not run in the sandbox (it creates a temp cache dir,
  `cost-oracle.mjs:390`). All reconciliation used the persisted files directly.
- One flow, one build. Same method should be applied before generalising.
