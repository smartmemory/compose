---
date: 2026-08-05
session_number: 101
slug: reopening-the-ideabox-write-path
summary: "S3b-2: the API, cockpit and mobile write to the record store again — and a design review reversed the read path before it shipped"
feature_code: COMP-PLAN-IDEA-UNIFY
closing_line: The review did not find a bug in what we built. It found that what we were about to build was only true on one machine.
---

# Session 101 — COMP-PLAN-IDEA-UNIFY

**Date:** 2026-08-05
**Feature:** `COMP-PLAN-IDEA-UNIFY`

## What happened

We picked up S3b-2, the half of the ideabox cutover that S3b-1 had deliberately left closed. S3b-1 moved the CLI onto the record store and shut the cockpit's six mutating endpoints behind a 409, because those handlers rewrote `docs/product/ideabox.md` directly and that file had just become generated output. Failing closed was honest. It was also a promise to come back.

The first thing we found was worse than the ticket said. `effort` and `impact` — the two axes of the cockpit's 2x2 prioritization grid — had been filed as "a dormant feature regression, not data loss" because no idea in this repo carries either. That reasoning is right about this repo and wrong about everyone else's. `import-ideabox.js` is the first-use migration gate every upgrading install runs; it parses both fields through `parseIdeabox` and then drops them on the floor when it builds the record, and the render that follows rewrites the user's markdown without them. Compose ships on npm. For any project that used the grid, upgrading to S3b-1 silently deleted their assignments. "No idea on disk here" was never the relevant corpus.

The design decision we spent the most care on was where the routes should get their code. The obvious reading of the scope is "make the routes call the provider the way the CLI does." That is the S3b-1 mistake set to repeat: S3b-1 put the mutation lock and `reclaimAborted` into `local-provider.js` rather than the seam, and `smartmemory-provider.js` then satisfied the interface completely while silently having neither. Two call sites that must each remember to run the migration gate before writing and re-render after will drift in exactly that shape, and the failure is invisible — the route looks correct, passes review, and destroys an upgrading user's ideabox the first time it is used. So the mutations went into one shared `ideabox-ops.js` that owns both invariants, and the CLI was refactored onto it. A surface that does not implement an invariant cannot forget it.

Then we sent the blueprint to Codex before writing the routes, and it came back with changes requested and seven findings. All seven were confirmed. One of them was a plain factual error of ours: the blueprint asserted "zero tests touch mobile," measured by listing `test/` — which does not recurse, and misses ten `mobile-*` suites under `test/ui/` that run under vitest rather than `node --test`. The existing `mobile-ideabox.test.jsx` already pins the response envelope, including `result.featureCode` on promote. Our plan to write the first mobile test was really an obligation to keep serving a shape a suite already asserted.

The finding that mattered most killed our tidiest decision. We had planned to derive every API response by parsing the markdown the write had just rendered — one records-to-client mapping instead of two, reusing a proven parser, with hydrate and mutation responses unable to disagree by construction. Codex pointed out that this contradicts the feature's own acceptance criterion ("`/api/ideabox` serve from fluid records"), and, worse, that it is only correct on the local provider. The projection is a local file. Point the ideabox at SmartMemory — a store shared across machines — and a write on machine A never regenerates machine B's markdown, so B serves an indefinitely stale view of a store that is perfectly current. We had a test proving the projection was faithful. Fidelity says nothing about freshness.

Two more findings fell out of the same root: a promotion response parsed from markdown loses `featureCode` (the parser has no field for `Promoted to:`), and a committed record whose render failed would have been reported as an error — which both clients treat as "roll back your optimistic update," making a saved idea vanish from the UI and inviting the user to type it again. Three findings, one cause. We reversed the decision instead of patching it three times, added `ideabox-view.js` as the single records-to-client adapter, and deleted `server/ideabox-cache.js` along with the parse path rather than leaving live-looking dead code behind.

The last real finding was a race we had asserted away. We claimed a second local writer was safe because the floor provider serializes mutations. It does — but rendering is a separate read-then-publish that sits outside that lock, so writer A can read a snapshot, writer B can mutate and publish a newer projection, and A's rename lands last carrying older content. Canon stays correct; the file humans actually read goes wrong until the next write. Taking the provider's lock around read-and-publish closes it without needing reentrancy.

Every load-bearing behaviour was mutation-tested before we believed the green: the importer's carry, the renderer's emit, both projection ordering fixes, the broadcast, the killed-promote guard, the migration gate, cluster title resolution, the render lock, and the render-failure response. Each one fails its test when removed.

At the end we tried to flip the feature to COMPLETE and the lifecycle guard refused: COMPLETE is guard-owned under `capabilities.guard`. That is the guard doing its job. An agent declaring its own work complete is the exact move it exists to stop, so the status stays PARTIAL and the call is the owner's.

## What we built

**New**
- `lib/fluid/ideabox-ops.js` — the ideabox mutations, owned once. `addIdea`, `updateIdea`, `setPriority`, `killIdea`, `resurrectIdea`, `promoteIdea`, `addDiscussion`, plus `findIdea`/`resolveCluster`. Each runs the migration gate first and re-renders after, and returns `{record, markdown}` rather than a message. Typed failures (`IdeaboxNotFound`/`Invalid`/`Conflict`/`RenderFailed`) replace the old `err.message.includes('not found')` status dispatch.
- `lib/fluid/ideabox-view.js` — records to the client shape the cockpit and mobile have always consumed. `id` is the handle, `description` is the body, untriaged priority is an em dash, `cluster` is the umbrella's title rather than its handle.
- `test/ideabox-routes.test.js` — the REST ideabox's first test of any kind. Golden flow, a 13-case error harness, CLI/API interop, the migration gate on the API's first write, and the render-failure contract. Real Express, real provider, real temp project; every assertion checks both what the client was told and what reached disk.
- `docs/features/COMP-PLAN-IDEA-UNIFY/blueprint-s3b-2.md` — including the review round and its adjudications.

**Changed**
- `contracts/fluid-record.schema.json` (0.1.0 → 0.2.0) — `effort` and `impact` with their enums.
- `lib/fluid/import-ideabox.js` — carries both through the migration. This is the data-loss fix.
- `lib/fluid/render-ideabox.js` — emits both in the legacy serializer's slot; publishes under the provider's mutation lock; two ordering fixes that restore the `serialize(parse(projection))` fixed point for cases the real corpus has never had (a killed idea that was discussed, an idea carrying both a `maps_to` and a promotion).
- `lib/fluid/record-shape.js`, `local-provider.js`, `smartmemory-provider.js` — the two new fields, in the seam and in both providers.
- `lib/ideabox-cli.js` — refactored onto the ops; now argument parsing, presentation and exit codes only. Gains `resurrect`.
- `server/ideabox-routes.js` — six 409 handlers replaced with real ones; `ideaboxUpdated` broadcast restored.

**Deleted**
- `server/ideabox-cache.js` — it cached the markdown parse, which is no longer the API's read path.

Full suite: 5372 node + 581 ui + 100 tracker, zero failures.

## What we learned

1. **"No instance in this repo" is not "no instance."** `effort`/`impact` were classified as a dormant regression on the strength of a `grep -c` returning zero. The grep was correct and the conclusion was wrong, because the code in question is the migration gate every *other* install runs. When the affected path is an upgrade path, the local corpus is the one corpus that cannot tell you anything.

2. **A round-trip test proves fidelity, not freshness.** We had a strong test that the markdown projection preserved every field a client reads, and we used it to justify serving reads by parsing that markdown. The test was true. It just answered a different question than the one that mattered: whether the file a given machine holds reflects the store, which under a shared provider it does not.

3. **Three findings with one cause is a design signal, not three bugs.** Lost promotion envelope, wrong failure semantics on a committed write, and stale reads across machines all traced back to "responses are derived from the projection." Patching them individually would have shipped three plausible fixes and kept the mistake.

4. **Verify the shape of your own evidence.** `ls test/` does not recurse, and this repo's `.jsx` suites live under `test/ui/` and run on vitest rather than `node --test`. That single measurement error put a false row in the blueprint and would have had us writing a second, competing mobile test topology beside a suite that already pinned the contract.

5. **A lock on each mutation is not a lock on the operation.** The floor provider serializes every individual write, which is easy to mistake for "concurrent writers are safe." The render is a separate read-then-publish, and that is where the last-writer-wins lived — invisible in canon, visible only in the file humans read.

6. **The right response to a committed write that failed to render is a success.** Both clients roll optimistic updates back on any non-ok status. An honest-looking 500 would have erased a saved idea from the UI and invited the user to retype it, manufacturing the duplicate the record store exists to prevent. Correct HTTP semantics and correct user outcomes pointed in opposite directions, and the client behaviour decided it.

7. **A guard that blocks you is the guard working.** `set_feature_status COMPLETE` was refused because completion is lifecycle-owned. The temptation to pass `force: true` is exactly the pressure the guard was installed against.

## Open threads

- [ ] Flip `COMP-PLAN-IDEA-UNIFY` to COMPLETE — all eight acceptance criteria are met and tested, but the status is lifecycle-owned under `capabilities.guard` and is the owner's call.
- [ ] Verification is contract-level, not a live browser session: the route tests assert the real server's real responses and the UI suites assert the real components against that same shape, but nobody has driven the cockpit in a browser since the cutover.
- [ ] `IDEA-24` — a CLI ideabox write still does not refresh an open cockpit. The API broadcasts `ideaboxUpdated` on `/ws/vision`; the file watcher's `fileChanged` goes out on `/ws/files`, which neither ideabox client subscribes to.
- [ ] `COMP-FLUID-SEAM-GUARANTEES` — still blocked on the owner question: whether SmartMemory can offer a conditional create or a reservation primitive. A local mutex is definitionally wrong for a store shared across machines, and that answer decides whether the work is Compose-side or an upstream ask.
- [ ] The `smartmemory` fluid provider still warns rather than refuses, and now has one more asymmetry: it takes no lock, so its projection publishes unserialized.

---

*The review did not find a bug in what we built. It found that what we were about to build was only true on one machine.*
