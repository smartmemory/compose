# Tracker Provider Model and Manager/Engineer Reconciliation

> Two-layer design. **Floor:** a principled tracker-provider abstraction (the substrate the
> GitHub-dogfood migration actually needs). **Layer above:** field-partitioned reconciliation of
> top-down (manager) and bottom-up (engineer) authorship, so a roadmap in Jira/Linear and work
> items in GitHub stay in step automatically. Captured from the 2026-07-19 design conversation.

**Status:** DESIGN / VISION (not scheduled). The floor is a prerequisite for the
[GitHub tracker migration](../../ROADMAP.md); the reconciliation layer is a separate, larger
product capability that deliberately reopens the "no bidirectional sync" decision under a new
discipline.

**Provenance:** Started as "migrate stratum + compose to the GitHub tracker provider to dogfood
it." Investigation (2026-07-19, codex read-only over `lib/tracker/`) showed the migration is a
real feature build, not a config flip. The design conversation that followed produced the model
below.

---

## 1. Why this exists

The GitHub tracker provider (`lib/tracker/github-provider.js`) can create and update issues, but
making a workspace *run on* it is a real build: no local→github importer, no remote hydration
(reads a local cache that `init` never populates), push-only `sync`, unpaginated issue search,
label clobbering. Digging into *why* those gaps exist surfaced that the provider abstraction
itself is shaped around the one implementation that predates it (`local`), and does not cleanly
generalize to github, let alone jira/linear/notion/miro. This doc fixes the abstraction first,
then builds the manager/engineer capability on top.

## 2. The current interface and its three weaknesses

`lib/tracker/provider.js` is a single `TrackerProvider` base with ~20 methods, each defaulting to
`NI('...')` (throw "not implemented"). `providerFor()` in `factory.js` dispatches on
`.compose/compose.json#tracker.provider` (`local | github`; unknown throws). Partial support is
handled two ways: a `capabilities()` Set of flags (`FEATURES/EVENTS/ROADMAP/CHANGELOG/JOURNAL/
VISION`), and a `withFallback()` Proxy that routes JOURNAL/VISION to a `local` provider when the
active provider lacks them.

**W1 — one fat interface with throwing defaults.** Interface-segregation failure. `github`
implements ~16 methods; `deleteFeature` and `addRoadmapEntry` are *unimplemented on both providers*
(inherit the throw). "Implements the interface" is not true for any non-local provider, and nothing
enforces completeness. The `capabilities()` Set is a runtime workaround for what should be
structural, and is only meaningful if every caller consults it before calling.

**W2 — the local-fallback Proxy is a leak; `local` is a mandatory substrate, not a peer.**
`providerFor()` always constructs `local` even for a github workspace, and `withFallback()`
hardcodes that JOURNAL/VISION delegate to it. So the architecture is "github *on top of* local,"
not "github *or* local." Composition is decided by the factory, not declared by the provider — a
jira provider cannot say "back my journal with X."

**W3 — capabilities encode presence, not fidelity (the deep one).** `github.capabilities()`
returns `FEATURES`, but `github.getFeature(code)` reads `this.cache.get(code)` — a local cache
`init` never hydrates — while `local.getFeature(code)` reads the file that is in git *right now*.
Same signature, categorically different guarantees: `local` is "the files are the truth"
(synchronous, always-present, single-writer, conflict-free), `github` is "a cache hoping to
converge with a remote" (empty on a fresh machine, push-only, stale-tolerant, multi-writer,
rate-limited). The interface abstracts the *operations* but not the *guarantees*.

## 3. Substrate design (the floor)

### 3.1 Role taxonomy — segment by *direction of truth*, not by capability

The extension points are not one "provider" enum. They are four roles:

| Role | Direction | Owns truth? | Examples |
|---|---|---|---|
| **Store** | read-write, source of truth | yes | `local`, `github`, plausibly `jira`/`linear` |
| **Projection** | derived (pure function of a Store) | no | roadmap render |
| **Publisher** | write-only sink | no | markdown, miro, notion page, a Jira/Linear board mirror |
| **Resolver** | read-only reference | no | any URL-class cite (`jira/linear/notion/obsidian` — already `URL_CLASS` in `feature-validator.js:809`) |

This makes facts structural that are currently runtime guesses: "miro can only ever be a Publisher,"
"notion has no canonical status," "obsidian is resolve-only." A backend implements the role
interfaces it can actually honor, and a composer validates the wiring.

### 3.2 Segment the fat interface — but bind by *aggregate*, not a flat six

The six capabilities are not orthogonal stores. The test for "must co-bind" vs "separable" is three
couplings:

| | Referential integrity (keyed to a feature by identity?) | Atomicity (partial write = corruption or staleness?) | Derivable (regenerate from the Store?) |
|---|---|---|---|
| **events** | Yes — `appendEvent(code, event)` | **Corruption** — an event with no feature is a broken ref | No (primary data) |
| **roadmap** | via features | n/a (read-only) | **Yes** — projection of current status |
| **completion** | Yes — writes feature body + emits event | **Corruption** | No |
| **changelog** | **No** — `appendChangelog(entry)` takes no code | **Staleness** — a lagging changelog is just a doc that's behind | **No** — append-only immutable history, can't be re-derived |
| **journal** | No | Staleness | No — append-only authored log |
| **vision** | No (workspace-level) | Staleness | No |

Conclusions:

- **Feature aggregate = features + events + completion + roadmap-projection.** These share
  referential integrity and atomicity, so they **must bind to one Store**. Splitting features and
  events across backends turns `recordCompletion` into a distributed write with no transaction.
- **changelog, journal, vision are the same shape:** append-only authored logs, workspace-scoped,
  keyed to nothing, staleness-tolerant, non-derivable. They are **independently bindable** with no
  distributed-write risk. (Note: today `github` implements changelog but falls back journal to
  local — an *arbitrary* line, since they are the same shape. Evidence the current interface was
  drawn ad hoc around `local`.)
- **roadmap is not a Store.** It is a Projection of the aggregate plus a fan-out to Publishers
  (next section).

Segmenting fixes W1 (structural presence) and W2 (composition declared, `local` de-privileged). It
does **not** fix W3 (fidelity) — that still needs either narrowing each role interface to guarantees
all implementations honor, or attaching fidelity metadata (hydrates? bidirectional? lossless
labels?). Do not let the clean split hide the consistency problem.

### 3.3 Roadmap = Projection + Publishers (how notion/miro/linear/jira attach)

```
FeatureStore (github = source of truth)
      │  pure function: features -> roadmap model
      ▼
RoadmapProjection
      │  fan-out, one-way, idempotent
      ├──► Publisher: markdown (ROADMAP.md)
      ├──► Publisher: notion (page/db)
      ├──► Publisher: miro (visual board)
      ├──► Publisher: linear
      └──► Publisher: jira
```

Publishers are one-way and idempotent, so a failed publish is a re-publish, never a corruption —
categorically safer than binding a `RoadmapStore` peer (which would drag in cross-store atomicity).
Some targets also *own* fields the features do not (miro: layout; notion: prose; linear: sequence/
priority/cycle; jira: epic hierarchy/rank). That is fine **as long as field ownership is disjoint**:
the projection merges status-from-github with order-from-linear with layout-from-miro, and no two
owners claim the same field. **The trap:** never let a roadmap surface own feature *status* — that
is the bidirectional-sync nightmare. Truth stays one-directional *per field*.

## 4. Reconciliation layer (the vision) — manager vs engineer

The Publisher model above is one-directional (features flow down to surfaces). The next capability
is genuinely bidirectional **at the item level**: a manager works top-down (authors the plan in
Jira) and an engineer works bottom-up (creates/completes work items in code), and the two must
reconcile automatically.

### 4.1 Field ownership (the whole solution)

| | Manager (top-down, authors in Jira/Linear) | Engineer (bottom-up, authors in code/GitHub) |
|---|---|---|
| **Creates** | *planned* intent ("build X, then Y") | *discovered* work ("found a bug, filed it") |
| **Owns (authoritative)** | priority/rank, grouping/initiative, sequence, scope decisions (kill/defer), target milestone | real **status**, technical breakdown (X → X1/X2), completion evidence (commits, tests, artifacts) |
| **Flow** | down into work items | up into the roadmap view |

The two sides **never author the same field.** Manager owns priority/grouping, engineer owns
status/breakdown. The Jira card renders manager's priority *and* engineer's real status, each from
its rightful owner.

### 4.2 Why this is not the "unsolvable sync" the project rejected

The [roadmap-planning model](../plans/2026-06-21-roadmap-planning-model-design.md) / roadmap-model decision
rejected bidirectional reconciliation as an unsolvable failure mode and chose references-not-sync.
That ruling was correct for what it rejected: syncing *contested* state (two authors, one field,
last-writer-wins races, no canonical merge). Field-partitioned reconciliation is a different problem
wearing the same word: if every field has exactly one owner, there is no contested field, so no
race — only a deterministic **merge of disjoint sources**. Manager's priority-event and engineer's
status-event commute; fold them in any order, same result. The user's instinct is sound *exactly to
the degree the field-ownership line holds.*

### 4.3 What the automation must actually do (three problems)

1. **Identity reconciliation** — two creation sources. A manager-planned "X" and an engineer's
   already-in-flight work must resolve to *one* entity (matching key / claim handshake). This is the
   real work; it is tractable but not free.
2. **Per-field merge with ownership enforcement** — a status write from the manager side is not
   truth, it is a *request* ("please close this") the engineer side confirms/rejects; an engineer
   re-grouping is a *suggestion* to the manager's structure.
3. **Contested-set escalation** — the residual overlap is surfaced as an explicit **decision**
   (approve / edit / reject / respond — see `idea_richer_gate_decisions`), never silent
   last-writer-wins. Good field partitioning keeps this set small.

Mechanically this wants to be **event-sourced, not state-synced**: each side emits intent
("prioritize X above Y", "X merged", "spawned X1"); a reconciler folds both streams into the merged
view. Disjoint-owner events commute, so there is no ordering hazard.

## 5. Scope boundary (do not conflate)

- **Near-term migration (the floor, schedulable now):** importer + remote hydration + pagination +
  label provisioning, so stratum (1 record) then compose (291 records) can actually *run on* the
  github Store and dogfood it. This needs the role/aggregate split at most as far as it clarifies the
  provider interface — it does **not** need Publishers or reconciliation.
- **Vision layer (larger, separate):** Projection + Publishers (notion/miro/linear/jira), and the
  manager/engineer reconciliation engine. This reopens the no-bidirectional-sync decision under the
  single-owner-per-field discipline. File as its own initiative when picked up.

## 6. Open questions / decisions to make

- **D1:** Do callers actually consult `capabilities()` today, or call-and-pray? Determines whether
  W1 is latent or active. (Audit before designing the segmented interface.)
- **D2:** Fidelity (W3) — narrow each role interface to universally-honorable guarantees, or attach
  fidelity metadata? Affects every consumer (validate, roadmap, drift).
- **D3:** Is `deleteFeature` a real requirement, or should it be removed from the interface? (Neither
  provider implements it.)
- **D4:** For linear/jira as authored surfaces — do we let them own *sequence/priority* (disjoint
  from github's status) in v1, or keep them pure Publishers first and add authored-field ownership
  later?
- **D5:** Revisit the roadmap-model "references, not sync" ruling explicitly: does field-partitioned
  reconciliation supersede it, or coexist (references for cross-project, reconciliation within a
  project)?

## 7. Related documents

- `../../ROADMAP.md` (compose) line 7 — references the per-project-provider roadmap model; the
  full "Roadmap Model" decision (per-project provider, references-not-sync) lives in forge-top
  `ROADMAP.md`
- `../plans/2026-06-21-roadmap-planning-model-design.md` — the roadmap-planning model this builds on
- `lib/tracker/{provider,factory,github-provider,local-provider}.js` — the interface under redesign
- `lib/feature-validator.js:809` — `URL_CLASS` (the resolver-role seam that already exists)
- GitHub tracker migration scoping (2026-07-19 investigation) — the gap list that motivated the floor
