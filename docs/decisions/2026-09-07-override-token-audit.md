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

**Not yet decided (owner):** whether to adopt stratum's signed one-shot authorization on this
surface (transport-independent, already built and already enrolled on this machine via
COMP-GUARD-ONE-TAP), or to delete the token path outright and let the completion gate and the
guarded lifecycle be the only doors. Doing nothing is also coherent, since the gate is fail-closed
today — but then the escape hatch should be documented as unusable rather than as available.

## Related

- `.claude/rules/receipts.md` — same failure class: a claim of a kind that has no receipt behind it.
- `docs/decisions/2026-09-07-group-signal-after-leader-reap.md` — the other claim retired by
  measurement this day.
