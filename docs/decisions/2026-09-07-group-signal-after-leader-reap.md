# Decision: keep signalling `-pid` after the leader is reaped (D-TERM-1)

**Date:** 2026-09-07
**Status:** DECIDED
**Context:** `lib/process-termination.js` — cancellation teardown of a spawned agent's process group
**Related:** COMP-GSD-6 D-C (`pidAlive`, EPERM = alive-but-not-ours), commit `14be1a7`,
[reproduction programs](2026-09-07-group-signal-after-leader-reap/)

---

## Question

Compose spawns the Claude Code CLI `detached: true` so a cancelled run tears down the whole tree, and
signals the group by negative pid. It keeps doing so *after* the leader has closed, on the stated
grounds that "the group outlives the leader".

But a reaped leader's pid is a freed pid. Should `-pid` be signalled at all once the leader is gone,
or is it a dangling reference that may name a stranger's group?

The question was left open by `14be1a7`, which added diagnostics instead of an answer, after a single
unreproduced `kill EPERM` in a full-suite run replaced a cancellation's abort reason.

## Decision

**Keep signalling the group after `close`. No control-flow change.**

For the entire window that matters, `-pid` provably names our own group.

## Rationale

POSIX 4.13: *"if there exists a process group whose process group ID is equal to that process ID, the
process ID shall not be reused until the process group lifetime ends"* — and a group's lifetime ends
only when its **last** member leaves.

So the pgid is unrecyclable for exactly as long as our group is non-empty, and a non-empty group is
precisely the condition teardown is waiting on. The dangling-reference concern only begins once the
group is already gone, which is the state teardown wants to reach.

Measured on this machine (Darwin 25.6.0) rather than taken on faith:

| Experiment | Setup | Result |
|---|---|---|
| `pgid_reuse.c` | leader reaped, one grandchild still in the group | 400,000 fork/exit cycles, pgid **never** handed out (pid space ~100k, so four wraps) |
| `pgid_free.c` | same, group then emptied | `kill(-pgid,0)` → ESRCH at once; pid handed back at iteration **98,102** (one wrap) |
| `eperm_probe.c` | `kill(-pgid, 0)` as uid 501 at root-owned groups | **EPERM**, not ESRCH. Control (own group): 0 |

**This retires the recycled-pgid hypothesis rather than confirming it.** The window is roughly 98,000
process creations wide, and it would have to fall inside a 2-second reap deadline. That is not a race.

## Consequences

1. **`14be1a7`'s reading was wrong and is corrected at the origin.** Its note said `not-ours` on the
   leader probe "names the recycled-pgid case outright", and its resume note said a recurrence would
   finish the diagnosis. Neither holds: after `close` the leader is reaped, so that probe reads `gone`
   in any realistic recurrence and discriminates nothing.

2. **EPERM from a group signal means one thing only** — a group with that pgid exists and *every*
   member refused our signal. Three causes, unranked except the last: a member on another uid; a
   MAC/sandbox policy refusing a member that shares our uid (so "same uid" rules nothing out); or,
   least likely, a recycled pgid.

3. **The instrument that actually discriminates is a group member listing**, added here: pid, ppid,
   uid, comm for every process in the group at failure time. Foreign uids point at the first two
   causes, unrelated processes at the third.

4. **`alive()` still throws on EPERM — the `pidAlive` ruling does not transfer.** For a *plain pid*,
   EPERM means "alive but not ours". For a *group*, it means "unreachable", and both readings above
   are terminal for us, so `CANCELLATION_UNCONFIRMED` is the honest label.

## Not measured

A **mixed** group (one member we may signal, one we may not) was not tested — it needs privileges this
machine's test run does not have. POSIX's "succeeds if at least one signal was delivered" implies `0`,
but that is an inference, not a measurement.

## Defect found on the way

Writing the first test this path has ever had exposed one: the opening `SIGTERM` was sent **outside**
`terminate`'s `try`, so a refused group signal escaped carrying Node's bare `EPERM` as its code. The
one failure the caller is told to expect from a group signal was the one code it could never receive.
Fixed — the send is now inside the try.
