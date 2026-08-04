---
date: 2026-08-05
session_number: 100
slug: ideabox-cutover-and-the-empty-field-tell
summary: S3b-1 cuts the ideabox over to the record store; five defects found by exercising paths no real data had ever taken, and a migration that would have wiped every other installation
feature_code: COMP-PLAN-IDEA-UNIFY
closing_line: The tests were green because the data was empty, and the plan was safe because it only imagined our own repo.
---

# Session 100 — COMP-PLAN-IDEA-UNIFY

**Date:** 2026-08-05
**Feature:** `COMP-PLAN-IDEA-UNIFY`

## What happened

We picked up with the fluid layer complete and entirely unreachable. `fluidProviderFor` had exactly one caller — `factory.js` itself. S1, S2, S3a and both COMP-FOH slices were all shipped, and not one line of them was on a path a user could reach. S3b was the only work that would change that.

The first thing we did was measure instead of predict. Rather than reason about what the cutover would do to `docs/product/ideabox.md`, we ran the import and the render end to end against the real file and diffed the result. That was the single best decision of the session. It turned a page of speculation into four facts: the projection differs from the hand-written file in exactly nineteen lines; the strict `real-ideabox fidelity` suite passes against the generated file **unmodified**, so the safety net never needed touching; the Tags convention line changes because it had always documented a `#ux` style the file never used; and IDEA-20 loses 1,273 bytes.

That last one was the story. IDEA-20 carried no `**Idea:**` field at all — its entire content lived in two lines the parser filed as unrecognised extras, and the fluid importer had no concept of extras. So it imported with `body: ""` and rendered as a title with nothing under it. The text being destroyed was the `PROVIDER-SEAM` re-ruling, which is to say the document that created this epic. We would have committed that.

The owner ruled that the two blocks become `discussion` entries, and migrating them is what cracked the session open. Putting a discussion entry on an idea was, as far as we can tell, the first time in the project's history anyone had done it. It threw immediately: the contract types every event date as `date-time`, the markdown has only ever carried `YYYY-MM-DD`, and nothing translated. Pulling that thread found the same defect in the renderer — it emitted a full ISO timestamp into a file whose grammar is a date, so a provider-written discussion entry degraded to an unparsed extra line and vanished on the next read. That one is the frightening shape: it would have surfaced only *after* cutover, on the first `compose ideabox discuss`, as silent loss.

Then the same signature kept appearing. The importer threw on any kill date, for the same reason, and nobody had noticed because the Killed Ideas section was empty. The renderer emitted `**Priority:** —` on a killed idea where the legacy serializer omits it, which broke the parse/serialize fixed point — the fixed point the entire cutover rests on — and would have broken the first time anyone killed anything. It omitted a grouping placeholder comment for a file with no headings, which is every brand-new ideabox. Five defects, all in shipped and fully-tested code, all sitting on branches the real corpus had never entered.

Codex reviewed the blueprint at `sol/xhigh` and returned six findings with a verdict of not-ready. We upheld all six, which is unusual, so we re-verified both P0s by hand before accepting them. One we had already fixed: we had scoped the lock to handle allocation, and Codex pointed out that `updateRecord`, `appendDiscussion`, `addLink` and `removeLink` are all read-modify-write against one file, so concurrent `pri` and `discuss` both report success while one silently reverts the other. We had widened it an hour earlier for the same reason.

The finding that mattered was F2, and it is the one we are most glad we did not ship. Our blueprint treated the import as a one-time operation on this repository. It is not. `@smartmemory/compose` is published on npm. Every other installation has its own populated `docs/product/ideabox.md` and no records — so the first `compose ideabox add` after upgrading would allocate IDEA-1 against an empty store and write a projection that replaced that project's entire idea list with the one idea they had just typed. Their work would have survived only in their git history. We had read our own plan a dozen times and never saw it, because we were only ever looking at our own repo.

We also managed to prove the lock the hard way. A same-process test passes against completely unlocked code — the allocator's critical section has an `await`, but the writes either side of it are synchronous. It takes real processes. Eight concurrent `compose ideabox add` processes against an unlocked store all allocate IDEA-1, and last-writer-wins destroys seven ideas. The docs had called this a narrow window.

One genuine mistake: a test of the upgrade path ran against the real repo, because `--cwd` is not a flag `compose` accepts and the workspace resolver quietly used the actual working directory. It imported 26 records into `docs/product/fluid/` and rewrote `docs/product/ideabox.md` with a junk idea in it. The groundwork commit was thirty minutes old and was exactly the rollback point the blueprint said it would be, so restoring took one `git checkout` and one `rm -rf`.

## What we built

**New:**
- `lib/dir-lock.js` — the hardened mkdir advisory lock, lifted from `judgment-writer.js` so there is one implementation instead of the six divergent copies in `lib/`. Owner token, heartbeat, stale reclaim, ABA-safe release.
- `lib/fluid/ideabox-dates.js` — `toRecordTimestamp` / `toMarkdownDate`. Both directions in one module deliberately: they are a single round-trip contract and their drifting apart was the bug.
- `lib/fluid/ideabox-migrate.js` — the first-use migration gate. Imports an existing markdown ideabox into an empty store, and refuses a partial one.
- `lib/ideabox-cli.js` — `runIdeaboxCommand`, extracted from ~300 inline lines in `bin/compose.js` and repointed onto the provider. Adds `compose ideabox render`.
- `test/fluid-cutover.test.js` — 28 tests, mutation-verified.
- `docs/features/COMP-PLAN-IDEA-UNIFY/blueprint-s3b-1.md` — decisions D13/D13a/D14–D18 and the round-1 adjudication.
- `docs/product/fluid/` — 26 tracked records plus `events.jsonl`.

**Changed:**
- `lib/fluid/local-provider.js` — all six mutating methods serialize on one lock; `_isAbortedAllocation` makes the import restartable.
- `lib/fluid/render-ideabox.js` — date narrowing, the orphan-cluster refusal, the killed-idea status line, the grouping placeholder, an honest banner, and a temp file that cleans up after itself.
- `lib/fluid/import-ideabox.js` — date widening, and `reclaimAborted` on the import path only.
- `server/ideabox-routes.js` — the six mutating handlers fail closed with a 409; their bodies removed rather than parked behind the guard.
- `bin/compose.js`, `docs/cli.md`, `pipelines/plan.stratum.yaml`, `docs/product/ideabox.md`, `CHANGELOG.md`.

Commits: `72d79f5` (groundwork), `3ae6a65` (cutover), `20c3557` (ledger + status).

## What we learned

1. **A green suite proves nothing about a branch your real data has never entered.** Five shipped defects, one signature. The cheap way to find them: take the real corpus and ask which optional fields are empty *everywhere*. Each is an untested branch, and `grep -c` finds them in seconds. The same trick exposed a whole dormant feature — the cockpit's effort/impact matrix validates and renders two fields that no idea on disk carries.

2. **Measure the migration, do not predict it.** Running the import and diffing the result took ten minutes and replaced every guess in the blueprint with a number. It also killed a claim we had inherited — that a strict fidelity test would block the slice — which would have shaped the whole design around a problem that did not exist.

3. **Both directions of a round-trip are one contract, and separating them is what lets them drift.** Import and render lived in sibling modules and disagreed about dates for two slices without anyone noticing. Putting the conversion in one module is not indirection; the split *was* the defect.

4. **"One-time migration" is a lie whenever the tool is published.** It runs once per installation, on whatever that installation happens to contain. We wrote a plan that was correct for our repo and catastrophic for everyone else's, and no amount of re-reading it would have shown us, because the plan and the reader shared the same blind spot. This is the strongest argument for the outside reviewer we have hit yet.

5. **Concurrency tests have to spawn processes.** A `Promise.all` test of the allocator passes against entirely unlocked code, because the critical section's writes are synchronous. It would have been worse than no test: a green assertion that the lock works, over a lock that does not exist.

6. **The cheap checkpoint commit paid for itself within the hour.** The blueprint's ordering put every zero-risk change in one commit before anything was cut over. When a test accidentally mutated the real repo, recovery was two commands, and we never had to reason about what state the working tree was in.

7. **Codex round 2 targets the fixes, not the plan** — and round 1's own instruction that a design artifact is not shipped code kept it from reporting missing implementation for the third slice running.

## Open threads

- [ ] **S3b-2** — the API routes, `useIdeaboxStore`, `src/mobile/hooks/useIdeas.js` (a second, independent client nothing on the desktop imports), and the `effort`/`impact` contract fields the matrix view needs. Until it lands the cockpit's ideabox is read-only.
- [ ] **Push.** Three commits sit on main unpushed.
- [ ] **Canon-guard registration for `docs/product/fluid/**`** — still blocked on there being zero fluid MCP tools, so registering for `hook` would lock out every legal write. Records are tracked canon with no write-time protection; the filename-versus-handle check from S3a is the only guard.
- [ ] **S4 — promotion as an edge.** `promote` now writes a real `promoted_to` link, so the data is there. The 20 imported records still carry their promotion as prose in `status_label`, though, so a backfill is needed.
- [ ] `runInit` still scaffolds the old hand-written template. Harmless — the migration gate imports whatever is in it — but the file it creates carries no GENERATED banner and looks editable.
- [ ] Compose tooling hard-codes `<feature>/blueprint.md`, so `blueprint-s3b-1.md` is not staleness-tracked. Multi-slice blueprint naming is still unresolved.
- [ ] `lib/boundary-map.js` remains invisible to `grep` thanks to two NUL bytes at ~line 313.
- [ ] The `lifecycle-guard-e2e` pre-push flake is still unaddressed.

---

*The tests were green because the data was empty, and the plan was safe because it only imagined our own repo.*
