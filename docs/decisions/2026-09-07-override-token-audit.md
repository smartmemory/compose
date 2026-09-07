# Audit: what compose's `STRATUM_GUARD_OVERRIDE_TOKEN` gate actually delivers

**Date:** 2026-09-07
**Trigger:** a project memory recorded the stratum-side override token as agent-mintable and
still open. Verifying it before letting it steer a decision found the opposite, and a second
instance of the same claim in compose's own code.

## Findings

**1. The stratum-side hole is CLOSED.** `STRAT-GUARD-AUTHZ` @3647b4c removed the env-var token
and replaced it with one-shot sshsig authorizations over a payload the verifier reconstructs,
bound to the resource's ledger head (`stratum/ts/src/guard/authorization.ts`). The name survives
in stratum only inside that file's docstring. The old "CLI is a weaker surface than MCP" argument
is dead.

**2. Compose kept its own, separate token gate**, unaffected by that change:
`server/compose-mcp-tools.js` (`_overrideOk`, `assertForceAuthorized`,
`assertTerminalStatusAuthorized`), covering `set_feature_status`, `add_roadmap_entry` and
`propose_followup`. It compares a tool argument against the SERVER process's environment.

**3. Its "not agent-mintable" claim did not hold, and has been corrected.** The comparison is
real at CALL time — a tool call cannot set the server's environment. It is not sealed at LAUNCH
time: `.mcp.json` carries the env block for each server (the smartmemory entry demonstrates the
mechanism), it is writable by anything that can write the repo, and compose's entry has no env
block. So the honest statement is "an out-of-band secret an agent cannot supply from a tool call,
and can arrange across a restart". The escalation was NOT performed: writability was verified
(`test -w`), the mechanism is evident, and running it would have edited the owner's MCP config.

**4. The gate is currently fail-closed for everyone.** `STRATUM_GUARD_OVERRIDE_TOKEN` is unset in
the shell and no env block sets it, so `_overrideOk` always returns false. The documented
"authorized escape" is not usable by the operator either.

**5. For `COMPLETE` the token buys nothing anyway.** `lib/feature-writer.js:471` refuses COMPLETE
unconditionally — "not with `force`, not with `derived`, not with an override token" — so that
half of the MCP assertion is a second lock on an already-closed door. What the token genuinely
still unlocks is `KILLED`, and `force` (skipping the roadmap transition table and the prose-loss
and duplicate-match refusals).

**6. No REST bypass.** `/api/features/scaffold` reaches `addRoadmapEntry` with only
`{code, description, phase}`; it cannot pass `status` or `force`.

## Decision

The false sentence is corrected in place and pinned by
`test/force-override-gate.test.js` ("the refusal does not claim the token is un-mintable"), shown
red by restoring the old wording. **The wrong claim was the liability, not the mechanism** — it is
what a later session would have quoted when deciding how much this gate is worth.

**DECIDED 2026-09-07 by the owner: the token path is REMOVED.** Not on threat-modelling taste, on
the three checks above — the hatch had no user and could not have one, both statuses it nominally
unlocked have first-class doors, and the only capability left to it was `force`, i.e. the exact
thing these gates exist to refuse. `assertForceAuthorized` and `assertTerminalStatusAuthorized` now
refuse unconditionally under `capabilities.guard`; nothing in `server/`, `lib/` or `bin/` reads
`STRATUM_GUARD_OVERRIDE_TOKEN` any more.

Pinned by `test/force-override-gate.test.js`, whose tests deliberately still SET the variable — the
strongest form of the assertion is that a caller holding what used to be the key is refused anyway.
Re-introducing the hatch reddens two of them.

**The trigger for building a real break-glass path** is a concrete incident where someone hits one
of these refusals with nowhere legitimate to go. Then the answer is stratum's signed one-shot
authorization (already built, and this machine is already enrolled via COMP-GUARD-ONE-TAP), never a
shared secret.

**THREE gates, not two — found by the full suite, not by the targeted runs.** Removing `_overrideOk`
left a third caller, `assertToolPhaseAllowed` (the COMP-MCP-ENFORCE-1 profile x phase tool gate),
referencing a deleted function. Every test that drives the MCP dispatcher hit a `ReferenceError`,
which is why two consecutive full runs failed 10 each with DIFFERENT-looking lists: one cause,
scheduled differently. The targeted runs covered the two functions edited, not the module. The
escape is now gone from that gate too, on the same evidence.

**Lesson, and it is the one this repo keeps relearning:** deleting a shared helper is a
whole-module change, not a change to the functions you happened to edit. `grep` for the symbol
before, and let the full suite be the gate — a targeted run cannot see a caller you did not know
about.

**Found while removing it:** `guardOverride` in `server/stratum-client.js` was still sending
`override_token` to a stratum that reads `authorization` (`ts/src/mcp/server.ts:270`), so every call
it could have made was destined to fail on a missing authorization. It has no production caller. The
field is corrected, and its test now asserts the wire field the OTHER side reads — the old test
asserted only what our own wrapper wrote, which is a wire-contract test that never consults the
contract.

## Related

- `.claude/rules/receipts.md` — same failure class: a claim of a kind that has no receipt behind it.
- `docs/decisions/2026-09-07-group-signal-after-leader-reap.md` — the other claim retired by
  measurement this day.
