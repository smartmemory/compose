# COMP-PLAN-IDEA-UNIFY — Implementation Blueprint (S3b-2: API, cockpit, mobile)

**Feature:** COMP-PLAN-IDEA-UNIFY (PARTIAL)
**Slice:** S3b-2 — reopen the write path for every non-CLI client
**Status:** IMPLEMENTED (review round 1 adjudicated and applied)
**Date:** 2026-08-05

## Related Documents

- Design: `docs/features/COMP-PLAN-IDEA-UNIFY/design.md`
- Prior slice: `docs/features/COMP-PLAN-IDEA-UNIFY/blueprint-s3b-1.md` (CLI cutover, shipped `3ae6a65`)
- Ledger: `docs/features/COMP-PLAN-IDEA-UNIFY/s3-progress.md`
- Follow-up: `docs/features/COMP-FLUID-SEAM-GUARANTEES/design.md` (blocked on an owner question; not this slice)
- Contract: `contracts/fluid-record.schema.json`

## What this slice is, and what it is not

S3b-1 cut the CLI over to the record store and closed the cockpit's write path
with a 409 rather than let it overwrite generated output (`server/ideabox-routes.js:75-88`).
That was the honest interim state, not the destination. This slice makes the
record store reachable from the three clients that S3b-1 locked out:

1. the REST API (`server/ideabox-routes.js`)
2. the cockpit store (`src/components/vision/useIdeaboxStore.js`)
3. the mobile hook (`src/mobile/hooks/useIdeas.js`)

**It is not** the seam-guarantees work. The lock and `reclaimAborted` stay in
`local-provider.js` for this slice; moving them is `COMP-FLUID-SEAM-GUARANTEES`
and is gated on an unanswered owner question. This slice inherits the floor
provider's serialization exactly as the CLI does, which is what makes a second
concurrent writer safe **on the local provider only**. The `smartmemory`
provider's warning (`lib/fluid/factory.js:113-117`) covers the gap and is not
weakened here.

## Measured baseline

Measured at `b34f902`, before any of this slice landed. Four rows were wrong in
the first draft and are corrected here; see "Review round 1" for which and why.

| Fact | Evidence |
|---|---|
| Six mutating handlers return 409 | `server/ideabox-routes.js:83-88` |
| `broadcastMessage` is already wired in and dropped on the floor | passed at `server/vision-server.js:154`, not destructured at `server/ideabox-routes.js:24` |
| **Nothing emits `ideaboxUpdated` anywhere in the tree** | both clients subscribe (`useIdeaboxStore.js:48`, `useIdeas.js:84`); zero emitters outside those two files |
| **Zero tests touch the routes** | no assertion of `IDEABOX_WRITES_MOVED_TO_CLI` anywhere in `test/` |
| Mobile IS covered — 10 suites under `test/ui/`, including `mobile-ideabox.test.jsx` | run by `vitest`, not `node --test`; it mocks `fetch` and asserts the response ENVELOPE, including `result.featureCode` on promote (`test/ui/mobile-ideabox.test.jsx:37`) |
| `effort`/`impact` are absent from the record contract | `contracts/fluid-record.schema.json` record has 18 properties, `additionalProperties: false`, neither among them |
| The legacy parser AND serializer both handle them | `lib/ideabox.js:304-311` (parse), `:441-442`, `:466-467` (serialize) |
| The renderer drops them | `lib/fluid/render-ideabox.js:64-105` emits no Effort/Impact line |
| **The importer drops them** | `lib/fluid/import-ideabox.js:120-150` builds the record without either field |
| The full cockpit chain for them already exists | `IdeaboxMatrixView.jsx:120` → `IdeaboxView.jsx:692` → `useIdeaboxStore.updateIdea` → `PATCH` |
| No idea on disk carries either | `grep -c` over `docs/product/ideabox.md` = 0; over `docs/product/fluid/records/` = 0 files |

## Decisions

### D19 — `effort`/`impact` are an upgrade-path data loss, not a dormant regression

The flush note from S3b-1 classified these as "a dormant feature regression, not
data loss" because no idea in **this** repo carries either. That is true here and
false in general. `import-ideabox.js` is the first-use migration gate that every
upgrading install runs, it reads `**Effort:**`/`**Impact:**` through
`parseIdeabox` (which populates them), and it drops both on the floor when it
builds the record. The next `render` then rewrites the markdown without them.

So for any install that used the 2x2 matrix, upgrading to S3b-1 silently deletes
their effort/impact assignments. Compose ships on npm, so "no idea on disk here"
is not the relevant corpus. This is fixed as part of this slice rather than filed.

### D20 — one shared operations module, not routes that mirror the CLI

The natural reading of the S3b-2 scope is "make the routes call the provider the
way `lib/ideabox-cli.js` does." That is the S3b-1 mistake repeated: the lock and
`reclaimAborted` went into one provider while satisfying the interface, and the
second implementation lacked both while looking complete. Two call sites that
must independently remember to run the migration gate first and re-render second
will diverge the same way, and the failure is silent in exactly the same manner.

Every mutation therefore moves into `lib/fluid/ideabox-ops.js`, which owns the
two invariants documented at `lib/ideabox-cli.js:21-30`:

1. `ensureIdeaboxMigrated` runs FIRST, before any write.
2. The projection is rewritten AFTER the record is durable, never before.

The CLI is refactored onto it. Neither surface can forget an invariant it no
longer implements. The ops return `{ record, markdown }` — the caller decides
what to print or serialize, and never re-derives the write.

### D21 — REVERSED. The API reads records through one adapter, never the markdown

**Original decision (superseded):** derive both `GET /api/ideabox` and every
mutation response by parsing the markdown the op had just rendered, reusing
`parseIdeabox` so exactly one records → client-shape mapping existed and the
mutation responses could not disagree with the hydrate.

**Reversed by review round 1, findings 5 and 6.** Two things outrank the tidiness:

1. **It contradicts the feature's own acceptance criterion**, which reads
   "`useIdeaboxStore` / `/api/ideabox` serve from fluid records" (`design.md`).
   Serving a rendering of the records is a different claim.
2. **It is only correct on the local provider.** The projection is a LOCAL file.
   Under the SmartMemory provider — a store shared across machines — a write on
   machine A never regenerates machine B's markdown, so B's REST and UI serve an
   indefinitely stale view of a store that is perfectly current. Fidelity of the
   projection says nothing about its freshness, and the round-trip test proves
   only fidelity.

Replaced by `lib/fluid/ideabox-view.js`: records → the client shape the cockpit
and mobile have always consumed (`id` is the handle, `description` is the body,
untriaged priority is an em dash, `cluster` is the umbrella's TITLE not its
handle). The markdown stops being a read dependency of the API entirely, and
`server/ideabox-cache.js` — which existed only to cache the parse — is deleted
rather than left as live-looking dead code.

The accepted cost is the one the original decision was avoiding: this adapter is
a second place where record fields become client fields, so a field added to the
contract and not here is invisible to the cockpit. Bounded by a test asserting
the API and the file agree field-by-field (`test/ideabox-routes.test.js`).

### D21a — a committed write whose render failed is a SUCCESS response

Follows from the reversal, and from review finding 5. The record is durable
before the projection is written, so "saved but not rendered" is reachable. Both
clients roll their optimistic update back on any non-ok status, so an error here
would erase a committed idea from the UI and invite the user to retype it —
manufacturing the duplicate the record store exists to prevent.

The route answers `200`/`201` with the idea plus `projectionStale: true` and a
warning naming `compose ideabox render`. Machine-readable, and a client that
ignores unknown fields still behaves correctly.

### D21b (original text, retained for provenance) — parsed responses

Clients key on the parsed-markdown shape: `id` is `IDEA-42` (the record's
`handle`; the record's own `id` is a provider UUID), `description` is the
record's `body`, `status` is `NEW`/`PROMOTED` uppercase, `priority` is `—` when
untriaged. Returning a raw record would break every consumer.

That leaves two ways to produce a response: a second records → client-shape
adapter, or reuse `parseIdeabox`. This slice reuses the parser, on the markdown
string `writeIdeaboxProjection` already returns (`render-ideabox.js:215`). One
mapping exists, GET and the mutation responses cannot disagree, and there is no
mtime race against `IdeaboxCache` (which compares `mtimeMs` and would, on a
coarse-timestamp filesystem, serve a same-millisecond stale parse).

The known cost is stated plainly: **a field the renderer does not emit is
invisible to the API even when canon holds it.** That is precisely the defect
class D19 describes. It is bounded by a round-trip fidelity test (T4 below)
rather than by an argument.

GET keeps its cache and its markdown source. Moving reads onto the provider is a
larger change with its own invalidation design, and the projection is proven
faithful by the cutover suite. Deferred, not forgotten — recorded under
"Deferred" below.

### D22 — promoting a killed idea is refused, with 409 rather than 404

The old API searched only `parsed.ideas`, so promoting a killed idea 404'd
(`ideabox-routes.js` pre-`3ae6a65`, `:163-166`). The CLI's `findIdea` searches
all records, so `compose ideabox promote` on a killed idea silently resurrects it
into `promoted`. No test covers either. The op refuses, which makes both surfaces
agree and stops a kill from being undone by a command that never mentions it.
This is a deliberate, tested change to CLI behaviour.

The status is **409, not the old 404**: the old 404 was an artifact of searching
the wrong array, and telling a caller the idea does not exist when it plainly
does sends them looking for the wrong problem. A conflict naming `resurrect` is
the answer that lets them act.

### D22a — failures are typed, not string-matched

The old routes chose their status code with `err.message.includes('not found')`.
That makes every error message load-bearing: rewording one silently turns a 404
into a 500. The ops throw `IdeaboxNotFound` / `IdeaboxInvalid` / `IdeaboxConflict`
/ `IdeaboxRenderFailed`, and each surface maps them once.

### D22b — the projection is published under the provider's mutation lock

Review finding 4. Each mutation is locked inside the provider, but rendering is a
separate read-then-publish. With two writers, writer A can read a snapshot,
writer B can mutate AND publish a newer projection, and A's rename lands last
carrying older content — canon stays correct while the file humans read is wrong
until the next write.

`writeIdeaboxProjection` now takes `provider.lockPath` around read-and-publish.
No reentrancy is needed: the mutation has already released by then, and whichever
render acquires last re-reads current records, so the file that lands last is
correct. A provider with no lock (SmartMemory) renders unserialized, which is its
documented state rather than a new gap.

### D23 — `resurrect` becomes a CLI subcommand too

The API has `POST /:id/resurrect`; the CLI has no equivalent. Once the op exists
the subcommand is three lines, and leaving the asymmetry in place recreates the
"second surface with a different feature set" problem this slice exists to end.

### D24 — a CLI write still does not refresh an open cockpit

`ideaboxUpdated` is restored on API writes only. The file watcher broadcasts
`fileChanged` on `/ws/files` (`server/file-watcher.js:206-216`), a different
socket from `/ws/vision`, and neither ideabox client listens to it. Bridging them
is cross-server wiring with no home in this slice. **Filed as `IDEA-24`, not
built.** (The first draft claimed it was filed when it was not — review finding 3.)

## File Plan

| File | New/Existing | Change |
|---|---|---|
| `lib/fluid/ideabox-ops.js` | **new** | The shared operations: `addIdea`, `updateIdea`, `setPriority`, `killIdea`, `resurrectIdea`, `promoteIdea`, `addDiscussion`, plus `findIdea`/`resolveCluster`. Each runs the gate, mutates, renders, returns `{record, markdown}`. Typed failures (D22a). |
| `lib/fluid/ideabox-view.js` | **new** | Records → the client shape, for GET and every mutation response (D21 reversed). |
| `lib/ideabox-cli.js` | existing | Refactored onto the ops. Printing, flag parsing and exit codes unchanged. Gains `resurrect` (D23). |
| `server/ideabox-routes.js` | existing | Six 409 handlers replaced with real ones on the ops; reads via the view. Destructures `broadcastMessage`; restores `broadcastUpdate()` on every success. |
| `server/ideabox-cache.js` | existing | **Deleted.** It cached the markdown parse, which is no longer the API's read path. |
| `lib/dir-lock.js` | existing | Unchanged; now also used by the renderer (D22b). |
| `lib/fluid/record-shape.js` | existing | `normalizeRecord` fills `effort`/`impact` to `null`. |
| `contracts/fluid-record.schema.json` | existing | Adds both properties with their enums (`S|M|L|null`, `low|medium|high|null`). |
| `lib/fluid/render-ideabox.js` | existing | Emits `**Effort:**`/`**Impact:**` in the legacy serializer's field order. |
| `lib/fluid/import-ideabox.js` | existing | Carries both through the migration (D19). |
| `src/components/vision/useIdeaboxStore.js` | existing | Verify only — expected zero changes. |
| `src/mobile/hooks/useIdeas.js` | existing | Verify only — expected zero changes. |
| `test/ideabox-routes.test.js` | **new** | Route golden flow + error harness. |
| `test/fluid-cutover.test.js` | existing | Adds the round-trip fidelity test and the CLI/API interop test. |

## Boundary Map

### S20: the record contract gains two fields
  contracts/fluid-record.schema.json → effort, impact (const)
  lib/fluid/record-shape.js → normalizeRecord (function)

### S21: the projection and the migration carry them
  from S20: contracts/fluid-record.schema.json → effort, impact (const)
  lib/fluid/render-ideabox.js → renderIdea (function)
  lib/fluid/import-ideabox.js → importIdeabox (function)

### S22: the shared operations
  from S21: lib/fluid/render-ideabox.js → renderIdea (function)
  lib/fluid/ideabox-ops.js → addIdea, updateIdea, setPriority, killIdea, resurrectIdea, promoteIdea, addDiscussion, findIdea, resolveCluster (function)

### S23: the client-facing projection of a record
  from S20: contracts/fluid-record.schema.json → effort, impact (const)
  lib/fluid/ideabox-view.js → toClientIdea, ideaboxView, toClientIdeaWith, clusterTitleMap, handleNumber (function)

### S24: both surfaces consume the operations
  from S22: lib/fluid/ideabox-ops.js → addIdea, updateIdea, setPriority, killIdea, resurrectIdea, promoteIdea, addDiscussion, findIdea, resolveCluster (function)
  from S23: lib/fluid/ideabox-view.js → toClientIdea, ideaboxView, toClientIdeaWith, clusterTitleMap, handleNumber (function)
  lib/ideabox-cli.js → runIdeaboxCommand (function)
  server/ideabox-routes.js → attachIdeaboxRoutes (function)

## Order, and the reversible checkpoint

1. **S20 + S21** — contract, normalize, render, import. Self-contained and
   independently valuable: it stops the upgrade-path data loss (D19) whether or
   not the rest of the slice lands. **Commit here.**
2. **S22** — extract the ops, refactor the CLI onto them. Behaviour-neutral by
   construction; `test/fluid-cutover.test.js` is the gate. **Commit here.**
3. **S23** — the routes, the broadcast, the route tests. **Commit here.**
4. Client verification, then the ledger and status update.

Step 2 is the reversible checkpoint: if the routes turn out to need a shape the
ops cannot serve, the CLI is already better off and step 3 is re-plannable.

## Test strategy

- **T1 — route golden flow.** `add → list → pri → discuss → promote → kill →
  resurrect`, driven against a real Express app over a temp project, asserting
  user-visible response shape AND the persisted record on disk. This is the first
  test the routes have ever had.
- **T2 — error harness.** Table-driven: missing title 400, unknown id 404,
  `status` in PATCH 400, bad `effort` 400, bad `impact` 400, DELETE 405, killed
  idea promote 404 (D22).
- **T3 — CLI/API interop.** Write through the API, read through the CLI, and the
  reverse. This is what proves there is one store and not two.
- **T4 — round-trip fidelity.** For every field a client consumes, assert
  `parse(render(record))` preserves it. This is the standing guard for D21's
  known cost, and it must fail if `renderIdea` drops a field.
- **T5 — migration carries effort/impact.** A markdown fixture with both set,
  imported, rendered, re-parsed, both intact. The regression test for D19.
- **T6 — mobile.** NOT a new suite: `test/ui/mobile-ideabox.test.jsx` already
  exists and mocks the response envelope. The obligation is therefore the
  reverse of what the first draft assumed — the API must keep serving the shape
  that suite already pins (notably `result.featureCode` on promote), and the
  real API's extra fields must be additive.
- **T7 — the render-failure contract** (D21a): a record pointing at a missing
  cluster makes the renderer refuse; the route must still answer 200 with
  `projectionStale: true` and the idea, not an error.
- **T8 — the projection lock** (D22b): while another holder owns the provider
  lock, a render must not publish; it completes once released.

**Mutation-test before trusting green** (S3b-1 standing rule): T4 must fail with
the Effort line removed from `renderIdea`; T5 must fail with the importer's
carry removed; T2's promote case must fail with the D22 guard removed.

## Traps

- **`--cwd` is not a flag.** `resolveCwdWithWorkspace` resolves from the real
  cwd, so a CLI fixture driven with `--cwd /tmp/x` mutates this repo. Drive
  in-process via `runIdeaboxCommand(cwd, args)` or a real subshell `cd`.
- **Never assert a hard-coded idea count against the live ideabox.** Derive from
  the file; the invariant is conservation.
- **Do not enlarge the cross-process fan-out in `test/fluid-cutover.test.js`.**
  N=3 already destabilised the suite at 8 and failed the pre-push gate twice.
- **`test/ideabox.test.js` is untouched.** It passes against the generated
  projection. Pressure to edit it means the change is wrong.
- **The record is durable before the render runs.** If `renderIdea` throws (the
  orphan-cluster guard, `render-ideabox.js:165-173`), the write already happened.
  Routes must return an error that says so and names `compose ideabox render`,
  not a bare 500 that reads as "nothing happened". Clusters are resolved before
  the write, so this is near-unreachable from the API — near, not un.
- **`docs/.DS_Store` is perpetually dirty. Never stage it.**
- **`lib/boundary-map.js` is invisible to grep** (two `\x00` bytes near `:313`).
  Read it with Read, not grep. The producer slice must appear earlier in the doc.

## Review round 1 (Codex `sol/xhigh`, against this blueprint at draft)

Verdict: **changes requested.** Seven findings, all adjudicated against the repo.

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | "Zero tests touch mobile" is false — 10 `mobile-*` suites exist under `test/ui/`, including `mobile-ideabox.test.jsx` | **CONFIRMED. My error** — I listed `test/` non-recursively and `.jsx` suites run under vitest, not `node --test`. | Baseline row corrected; T6 rewritten as an obligation to the existing suite rather than a new one |
| 2 | Three baseline rows no longer true in the worktree | **CONFIRMED, artifact.** S20/S21 landed while the review ran. | Baseline dated to `b34f902` |
| 3 | D24 claims the follow-up was filed; nothing is filed | **CONFIRMED.** | Filed as `IDEA-24` |
| 4 | The provider lock does not cover the render, so a stale projection can overwrite a newer one | **CONFIRMED.** Mutations lock; `writeIdeaboxProjection` read and renamed outside. | D22b — the render takes `provider.lockPath` |
| 5 | A committed record + failed render is incompatible with both clients' rollback-on-error | **CONFIRMED.** Prose in `error` is not enough. | D21a — success + `projectionStale` |
| 6 | Keeping GET on local markdown breaks canonical reads under SmartMemory, and contradicts the feature's acceptance criterion | **CONFIRMED.** The criterion says records; a shared store makes the local file permanently stale on other machines. | D21 reversed; `ideabox-view.js` added |
| 7 | Parsed responses drop the promotion envelope mobile reads (`featureCode`) | **CONFIRMED.** The legacy parser has no field for `Promoted to:`. | Promote returns an explicit envelope |

Findings 5, 6 and 7 shared a root cause — deriving API responses from the
markdown — and were fixed by one reversal rather than three patches.

## Deferred

- **CLI writes pushing to an open cockpit** — `IDEA-24` (D24). Cross-server
  socket bridging.
- **The seam guarantees** — `COMP-FLUID-SEAM-GUARANTEES`, blocked on the owner
  question about a cross-machine reservation primitive.
