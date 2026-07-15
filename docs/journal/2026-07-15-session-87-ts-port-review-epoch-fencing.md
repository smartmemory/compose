# Session 87 — TS-port adversarial review; control-plane hardening; Phase-1 epoch fencing

**Date:** 2026-07-15
**Branch:** `develop` (compose-develop worktree) + stratum `develop`
**Feature:** STRAT-PY-RETIRE (Phase 2 hardening + fencing Phase 1)

## What happened

The session started as a resume-and-review: pick up after the COMP-TRIAGE-5 flush and
review everything on stratum's `develop`. We ran two independent Codex passes — one over
the branch diff (the Codex-SDK transport change), one over the whole TS port (~8.7k lines,
compared against the Python reference). The whole-port pass returned ten findings with a
blunt verdict: don't retire Python until the top four are closed.

We adjudicated every finding against the code instead of taking them on faith. Three
confirmed as real, fixable-now defects in the TS engine: `resume()` bypassed the
background-run ownership guard (handing in-flight work to a second executor), a cancelled
run could still be advanced through its waiting gate (an approval after `flow_cancel_bg`
would complete the "cancelled" run), and reverting to a checkpoint of a terminal run
violated the frozen MCP surface *after* persisting the revert. All three were fixed
RED-first in stratum (`047d692`), with a rehydrate golden proving the cancel refusal
survives restart. The review's "High" on the SDK transport (concatenating agent messages)
was downgraded after we verified all three transports — Python included — share that
semantic deliberately.

The fourth finding — `step_done` unfenced on the wire — was supposedly covered by the
consumer-fanout design. Reading that design end-to-end said otherwise: it explicitly kept
the dispatch token "optional/ignored" for ordinary steps, which would have *cemented* the
defect for everything compose's build loop does today. We amended the design (universal
fencing, two phases) and then landed Phase 1 immediately on both `develop` branches:
stratum declares an optional `epoch` on `stratum_step_done` (surface 7) and forwards it to
the engine's existing staleness check; compose echoes the engine-issued ready-entry epoch
from both live TS-path call sites.

Two sidebars worth remembering. First, the engine taught us its revise semantics: a revise
bumps the epoch of **every descendant** of the revision target, not just the re-issued
step — our golden's first expectation (finish@0) was wrong and the engine was right.
Second, mid-verification every codex dispatch on the machine started failing: CodeIsland's
"Always Allow" had written orphaned `[mcp_servers.stratum.tools.*]` blocks into
`~/.codex/config.toml`, which makes the codex binary reject the entire config. Removed the
blocks, kept a backup, saved a memory.

## What we built

- `lib/stratum-mcp-client.js` — `stepDone` gains an optional 4th `epoch` arg, transmitted
  as the wire `epoch` key only when an integer.
- `lib/build.js` — both live TS-path `stepDone` call sites (generic dispatch, ship
  interception) echo `readyStep?.epoch`.
- `test/ts-cutover-epoch-echo-golden.test.js` (new) — (a) full runBuild revise round over
  the real TS bin, recording echoes work@0 → work@1 → finish@1; (b) compose's own client
  proving stale-epoch rejection on the wire.
- stratum `develop` (companion commits): control-plane hardening (`047d692`), design
  amendment + surface 7 + epoch forwarding, ledger + CHANGELOG entries, issues #13–#15.

## What we learned

1. **A review is only as good as its adjudication.** Ten findings became three
   fix-now defects, one design amendment, and five tracked residuals — plus one "High"
   downgraded because the "divergence" was deliberate three-way parity. Every verdict
   needed a code probe.
2. **Designs can lock in the bug they were written to fix.** The fanout design contained
   the fencing mechanism AND an explicit carve-out that kept the current consumer unfenced.
   Reading the design end-to-end before implementation caught what the design-gate review
   round had not.
3. **Fix the cheap half of a two-phase fix immediately.** The full dispatchToken fence
   needs the fanout feature; the epoch echo needed ~20 lines across two repos and closes
   the live revision-staleness hole today.
4. **Ask the engine what its semantics are; don't guess in tests.** finish@1, not
   finish@0 — revise invalidates the whole downstream scope by design.
5. **Environment breakage mimics regression.** Two "suite failures" were a third-party
   tool corrupting codex's global config between runs. Check file mtimes before debugging
   your own diff.

## Open threads

- [ ] Phase-2 fencing: per-issuance `dispatchToken` required for ALL client-executed
      reports at the fanout flag-day (design amended; implementation with
      STRAT-TS-FANOUT-CONSUMER).
- [ ] Stratum issues #13 (SDK transport memory bound), #14 (worktree leak on restart
      redispatch), #15 (bg registry persist-after-spawn ordering).
- [ ] Remaining cutover work-list unchanged: ship-interception stepDone shape, consumer
      fanout, GSD path, v0→v1 specs, abort-cleanup store reads, final server flip.
