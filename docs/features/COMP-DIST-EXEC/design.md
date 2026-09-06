# COMP-DIST-EXEC: Distributed execution: run a build's parallel agent tasks across multiple machines instead of one host

**Status:** PLANNED
**Created:** 2026-09-06

## Related Documents

- [ROADMAP.md](/ROADMAP.md) — phase "COMP-DIST-EXEC: Distributed Execution Across Machines", PLANNED
- [COMP-AGT-COORD design](/docs/features/COMP-AGT-COORD/design.md) — scoped itself to a single host; this feature lifts that non-goal and inherits its coordination model
- [COMP-PAR-MERGE-QUEUE](/docs/features/COMP-PAR-MERGE-QUEUE/) — the merge path that has to become the only door once two machines can finish concurrently

---

## Intent

Run a build's parallel agent tasks across multiple machines instead of one host.

Today every task in a parallel dispatch is a `child_process` on the orchestrator host, isolated by a
git worktree (`server/agent-spawn.js`, `lib/build.js`). A build's width is therefore capped by one
machine's cores and one machine's rate limits, and that machine is a single point of failure
mid-build.

## Known dependencies

1. **Coordination is in-process.** Parent-child messaging and the shared blackboard live in the
   orchestrator's memory. A remote executor needs that channel over a network, with AGT-7's ordering
   and delivery guarantees restated for a link that can partition.
2. **Merge is last-writer-wins.** Batch builds share one build-stream. That is a tolerable gap on one
   host and a correctness bug the moment two machines finish concurrently, so COMP-PAR-MERGE-QUEUE
   has to become the only door into the stream.
3. **Worktree isolation assumes a shared filesystem.** Dispatch must ship a content-addressed
   workspace and collect a diff back, rather than handing a remote executor a path.

## Open questions for design

- Executor discovery and enrolment: reuse the guard trust root, or a separate executor identity?
- Is a remote executor trusted to perform lifecycle writes at all, or does it only return diffs for
  the orchestrator to apply?
- What does a partial-host failure do to an in-flight batch?

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._
