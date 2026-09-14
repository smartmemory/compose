# COMP-COST-OWNER-1: every ordinary dispatch settles exactly once — Design

**Status:** BLOCKED on a stratum surface bump (2026-09-14). First implementation attempt was
built and REVERTED the same day; this document records why, so the next attempt does not
repeat it.

## Why

Compose reports a dispatch's usage to stratum via a receipt (`stratum_usage_report`) and then
sends a step-completion envelope carrying no usage. Three leaks, traced 2026-09-14
(`../COMP-COST-OWNER/evidence/step-envelope-usage-2026-09-14.md`):

1. **Kickoff** — `lib/new.js` destructures only `{ result }` from `runAndNormalize`; the
   kickoff dispatch's usage is neither receipted nor carried. Absent from stratum's per-flow
   cap always.
2. **Swallowed receipt failure** — the receipt reporter warns and continues; the envelope has
   no fallback, so that dispatch vanishes from the cap.
3. **Legacy no-receipt mode** — ordinary `runBuild` steps carry no usage on the envelope
   (fanout and GSD do).

Intended invariant: **every ordinary dispatch settles via EITHER an acknowledged receipt OR a
usage-bearing `stepDone` envelope — never both, never neither.**

## THE BLOCKER — stratum's stepDone contract has no room for provenance

`stratum/ts/contracts/mcp-surface.json` (surface 20, the released 0.5.2) declares:

```json
"stratum_step_done": { "request": { "runId", "stepId",
  "result": { "output?": "any", "failure?": "string",
              "usage?": "object", "telemetry?": {...} },
  "dispatchToken" } }
```

**Four keys. No `split`, no `usdSource`.** The contract validator refuses anything else —
`contracts.ts:123` throws `<path>.<key> is undeclared`. Both fields exist elsewhere in the
surface (agent_run responses, usage_report receipts), which is what misled the first attempt:
`engine.stepDone` internals read `usdSource`/`split`, but the MCP contract gating the call
rejects them before the engine is reached.

Measured: the first attempt's envelope fallback failed 10 real-engine golden tests with
`MCP error -32603: stratum_step_done.request.result.usdSource is undeclared`. A green targeted
run had hidden it — the attempt adapted its own fixture to the older engine instead of treating
the refusal as a blocker. **The real-engine goldens were the only thing that caught it.**

### What stratum must ship first

1. Declare `usdSource?` and `split?` on `stratum_step_done.request.result` (surface bump).
2. Accept a **dispatch id** on envelope settlement. Stratum currently assigns envelope
   settlements `legacy:<seq>` (`engine.ts:2756`), so a receipt and an envelope for the SAME
   dispatch cannot be deduplicated — which makes exactly-once unachievable from compose's side
   alone. This is also the fix for the residual lost-response window below.

Filed with the other stratum-side cost work: **STRAT-LEARN-COST-1**.

## Defects the first attempt hit — the next one must not reintroduce them

Found by review (astra), each reproduced with probes, not argued:

1. **False acknowledgements.** `reportObservedUsage` returns non-null even when routing
   delivery FAILED (`lib/routing-ledger.js:1232` swallows ordinary delivery failures) and for
   entries skipped for missing intent/resolution. Acknowledging on a non-null return sends a
   bare envelope for usage that was never delivered — the leak, reintroduced.
2. **Double-debit via the retry spool.** A failed receipt stays pending; `evaluateConfiguredGate`
   retries it. Envelope debits it, later flush debits it again.
3. **Double-debit on a lost acknowledgement write.** Stratum returns ok, persisting the ack
   fails, the catch leaves `receiptAcks` empty, fallback charges again.
4. **Crash between preparation and retirement settles both.** Compose persists the fallback
   envelope before retiring its receipt; recovery flushes pending receipts before replaying the
   envelope.
5. **Retirement can discard usage entirely.** On a non-routing cost-ceiling build, retirement
   succeeds and a crash before `stepDone` leaves the dispatch archived with no replayable
   envelope — zero settlements.

**Residual by construction:** stratum commits the receipt, the response is lost, compose
settles again. Not fixable client-side; needs (2) above. Note the status quo loses the same
spend in that window, so the trade is an undercount for a rare overcount.

## Scope rule for the next attempt

The first attempt expanded from the receipt region into `lib/routing-runtime.js`,
`lib/consumer-fanout.js` and `lib/routing-ledger.js` — **COMP-MODEL-ROUTE's append-only
evidence corpus**, whose shadow rows are the input to that feature's open Q3. Review verdict:
scope creep, revert and re-attempt narrowly. The acknowledgement seam can live in the receipt
region by reloading and inspecting the existing spool; the archive design was what dragged the
other two files in, and it manufactured acknowledged routing evidence
(`routing-ledger.js:1306` dropped `unacknowledged-paid-receipt` with no envelope binding).

**Do not touch the routing ledger to solve a cost-settlement problem.**

## Files (next attempt)

| File | Action | Purpose |
|------|--------|---------|
| `stratum/ts/contracts/mcp-surface.json` | modify (STRATUM) | declare `usdSource?`, `split?`, dispatch id on stepDone result |
| `lib/build.js` receipt region | modify | per-dispatch proven acknowledgement; exclusive settlement |
| `lib/new.js` | modify | kickoff settles instead of discarding |
| `test/usage-receipts.test.js` | modify | exclusivity through the real call site |
| integration goldens | run | the only oracle that catches a contract refusal |

## Open Questions

- Is the kickoff leak worth shipping alone? It has no receipt channel today, so recording it
  cannot double-count. Considered and deferred 2026-09-14 in favour of doing the whole
  invariant once stratum can support it.

## Related Documents

- Parent: [COMP-COST-OWNER](../COMP-COST-OWNER/design.md)
- Trace: [step-envelope-usage-2026-09-14.md](../COMP-COST-OWNER/evidence/step-envelope-usage-2026-09-14.md)
- Stratum side: STRAT-LEARN-COST-1
