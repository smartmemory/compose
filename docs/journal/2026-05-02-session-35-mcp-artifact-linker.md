# 2026-05-02 — Session 35: Artifact linker ships (COMP-MCP-ARTIFACT-LINKER)

## What happened

Second writer in the COMP-MCP-FEATURE-MGMT family. The first ticket established the framework (idempotency keys, audit log, transition policy, the `lib/feature-writer.js` module); this one extended that surface with four new tools and hit ship the same day.

The tools are `link_artifact`, `link_features`, `get_feature_artifacts`, `get_feature_links`. The first two write; the last two read. They cover two classes of feature-management state that have lived only in prose so far: non-canonical artifacts (snapshots like the one we kept from COMP-DOCS-SLIM, journal entries that live outside the feature folder, findings files from architectural reviews) and typed cross-feature relationships (`COMP-NEW-PIPELINE-MISSING was filed from COMP-DOCS-FACTS Codex review` — the link existed only as English in the ROADMAP row).

The interesting design question was whether to merge canonical artifact assessment with linked artifacts in `get_feature_artifacts`, or keep them separate. The first cut kept them separate — felt cleaner, smaller surface. Codex caught it on review iteration 1: the design and acceptance criteria explicitly said `canonical + linked`, the implementation only returned linked. That's the kind of drift between design and code that normally gets caught months later when somebody actually tries to use the surface and it doesn't match. Codex caught it in 30 seconds.

Three review iterations:
- **Iteration 1**: three findings — missing canonical merge, accepting directories as paths, silent empty result on bad `direction`. All real, all fixable in single-line changes.
- **Iteration 2**: one finding — the new path validation correctly blocked `..` and absolutes, but accepted in-repo symlinks pointing at `/etc/passwd`. The fix mirrors a pattern that already exists in `server/artifact-manager.js`: `realpathSync` after the existence check, reject if the real target escapes `realCwd`. The repo had already solved this problem; the writer just hadn't inherited the solution. Wrote a self-skipping test that creates an actual symlink to `/etc/passwd` and asserts rejection.
- **Iteration 3**: REVIEW CLEAN.

The design called for a closed enum on link kinds: `surfaced_by`, `blocks`, `depends_on`, `follow_up`, `supersedes`, `related`. Closed because the cockpit graph needs to render edges with consistent semantics, and `validate_feature` (later sub-ticket) will check things like "no cycles in `depends_on`". Open enums are a pain to validate and a pain to render. The cost of adding a new kind to the enum later is zero; the cost of regretting an open enum is real.

We deliberately rejected bidirectional auto-mirroring. A link from A → B is stored on A only. Inverse queries iterate `listFeatures` and filter. At compose's scale (~55 features), the iteration is trivial. If it ever becomes a hotspot we build an index. Mirroring would mean every link is two writes, every delete is two deletes, and any inconsistency between the directions becomes a reconciliation problem we don't have today.

The `to_code` validation also got a deliberate weakening: target features need not exist at link time. This matches reality. We file `surfaced_by` links for follow-ups before the follow-up's code is even allocated. If the writer enforced existence, every follow-up filing would need to scaffold the target first, which inverts the natural flow.

Total session: 27 new tests, full suite 2095/2095 (was 2044), zero regressions. The framework is starting to compound — sub-ticket 1 took several hours; sub-ticket 2 took maybe 45 minutes of focused work because all the plumbing was already in place. The remaining sub-tickets should be smaller still.

## What we built

**Added:**
- `compose/lib/feature-writer.js` — extended with `linkArtifact`, `linkFeatures`, `getFeatureArtifacts`, `getFeatureLinks`. New `validateRepoPath` helper enforces: repo-relative, no `..`, must resolve under cwd, symlink target must also live under cwd, must point at a file (not directory). Mirrors the path-hardening pattern in `server/artifact-manager.js`.
- `compose/server/compose-mcp.js`, `server/compose-mcp-tools.js` — four new tools registered with thin handlers. Token budget: ~280 added, total ~1040, still under 2000 cap.
- `compose/test/feature-linker.test.js` (24 tests, unit), `compose/test/feature-linker-mcp.test.js` (3 tests, end-to-end via spawned MCP child). Includes a self-skipping symlink-escape regression test.

**Changed:**
- `compose/docs/mcp.md` — four new tool rows + an "Artifact + feature links" section documenting storage shape, path validation, link kinds, dedup semantics, and the no-auto-mirroring choice.
- `compose/CHANGELOG.md` — entry under 2026-05-02.
- `/Users/ruze/reg/my/forge/ROADMAP.md` — `COMP-MCP-ARTIFACT-LINKER` flipped to COMPLETE.

## What we learned

1. **Designs drift from code in seconds.** I left `canonical` out of `get_feature_artifacts` because keeping the surface narrow felt cleaner. The design said merge them. Codex spotted the divergence on iteration 1. The lesson isn't "be more careful"; it's that any surface with two sources of truth (design doc + code) needs the second source to be the test, not the prose.

2. **Reuse is real now.** Sub-ticket 2 took a fraction of sub-ticket 1's time because idempotency, events, validation helpers, the test harness, and the MCP plumbing were all already in place. The framework's value is multiplicative across writers.

3. **Symlink hardening lives in `server/artifact-manager.js` for a reason.** When I added new path validation to `lib/feature-writer.js`, I duplicated the lexical-containment check but missed the realpath check. The repo had already solved this exact class of bug; my writer just hadn't inherited the solution. There's an unfactored "validate-repo-path" utility somewhere in this codebase's future — Track A of `COMP-ARCH-CLEANUP` ("centralize duplicated primitives") would catch this naturally.

4. **Closed enums beat open enums.** I went with `kind: 'surfaced_by' | 'blocks' | …` and resisted the temptation to allow free-form. Reasons compounded: cockpit graph rendering, future cycle detection, validator-friendly errors, fewer ways for two callers to mean the same thing two different ways. The cost is one PR per new kind. That's a feature, not a bug.

## Open threads

- [ ] Six writer sub-tickets remain in the family: CHANGELOG-WRITER, JOURNAL-WRITER, FOLLOWUP, COMPLETION, VALIDATE, MIGRATION.
- [ ] When `validate_feature` (later sub-ticket) lands, add cycle detection on `depends_on` links — the writer doesn't enforce it today (deliberate; validation is the validator's job).
- [ ] Path validation logic is now duplicated across `lib/feature-writer.js` and `server/artifact-manager.js`. When Track A of `COMP-ARCH-CLEANUP` extracts shared primitives, this is a candidate.

A typed link is a queryable link.
