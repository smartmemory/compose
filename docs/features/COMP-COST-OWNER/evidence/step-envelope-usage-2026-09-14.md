# Does compose still under-report step usage to stratum? MODE-DEPENDENT. Cost: $0, read-only.

**2026-09-14.** Follow-up to `token-tally-15x-reconciled-2026-09-14.md`, which found that at
`a48c40a9` (2026-08-19) ordinary step-completion envelopes carried no `usage`, so stratum's
`BudgetLedger` saw 4 of 15 dispatches on flow `4122e695`. Question: is that live on `main`?
Traced by a Codex sol/high read-only pass across `compose@583b14f` and `stratum@e1074aa`.

## Verdict

**The envelope omission is still in the code. It no longer loses spend in the normal mode,
because a different channel carries it.** Since `44e54cf` (2026-08-30, "receipt per model
call via stratum_usage_report"), `recordBuildUsage` (`lib/build.js:5483` → `:4561` →
`:2329-2355`) sends each dispatch's `{usage, telemetry, split, usdSource}` as a receipt BEFORE
the bare `stepDone`. Stratum's `usageReport` (`engine.ts:895`) settles it through the same
`settleReceipt → debit` path (`engine.ts:2688`, `:2658`, `ledger.ts:33`) that a usage-bearing
envelope would take. Receipt mode is selected by `hasTool('stratum_usage_report')`
(`build.js:3797`).

Empirical: real build `d99082ba` — `explore_design.attempts[]` carry **no** `usage`
(`flow:434`), yet `flowSpent` = 3,632 tokens / $0.5737263 (`flow:427`), which is exactly the
two receipts 3,124 + 508 / $0.4270683 + $0.146658 (`flow:707`) with splits and
`usdSource: "reported"`. Same shape on `64f8c243`. **Absence from `attempts[].usage` is no
longer evidence of a zero debit** — the authoritative evidence moved to `receipts[]`,
`usage_debit` events, step `spent`, and `flowSpent`.

So `4122e695`'s under-count was a pre-receipt artefact: `a48c40a9` (08-19) predates `44e54cf`
(08-30).

## What still leaks, by site

| Site | Envelope | Verdict |
|---|---|---|
| Ordinary `runBuild` step, `build.js:5466` → `:5493` | `{failure}` / `{output}` / `{}` — never `usage` | Accounted by receipt; **leaks if the receipt fails** — receipt failures are warned and swallowed at `:2360`, and the envelope has no fallback |
| Kickoff / new flow, `lib/new.js:139` → `:166` | destructures only `{ result }` from `runAndNormalize`; `{ output: … }` | **Usage discarded outright.** No receipt, no envelope. Live leak, small (one dispatch per new flow) |
| Consumer fanout, `build.js:1935-1943` | `envelope.usage = engineUsage` only in legacy mode | Accounted by receipt in receipt mode |
| Ordinary fatal build, `build.js:5204` | `{ failure }` | `recordBuildUsage` at `:5192` first — accounted by receipt |
| GSD ordinary step, `gsd.js:742` / `:730` | carries `usage` in legacy mode | connector/parse failures at `:694`, `:718` are bare `{failure}` — leak in legacy mode |
| Stratum-owned background dispatch | n/a — stratum's own connector result feeds `stepDoneOwned` (`engine.ts:1435`, `:3646`) | Accounted directly |

`stratum_agent_run` on its own is not a flow debit: it returns usage to compose, which must
then receipt it or carry it in `stepDone`.

## Consequence

On current receipt-capable runs, stratum's per-flow cap is enforced against engine-reserved
dispatches + acknowledged receipts + engine-owned usage — i.e. the real number. Without the
receipt surface, or after a swallowed receipt failure, ordinary compose-run usage is absent
from the cap. `lib/new.js` kickoff usage is absent from it always.

## Smallest correct change (stated, not designed)

Every ordinary dispatch settles through EITHER an acknowledged receipt OR a usage-bearing
`stepDone` — never a bare completion after usage was consumed but not acknowledged. Plus:
`lib/new.js` stops discarding the kickoff usage.

## Falsifiers

- Receipt mode: `grep -n "hasTool('stratum_usage_report')" lib/build.js` still selects it.
- Kickoff leak: `lib/new.js` still destructures only `{ result }` from `runAndNormalize`.
- Swallowed receipt failure: `lib/build.js` still `warn`s and continues at the receipt
  reporter's catch, and `stepDoneResult` still carries no `usage`.
