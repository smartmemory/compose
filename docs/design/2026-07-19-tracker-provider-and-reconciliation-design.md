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
below. **Revised same day** after a verification review (every load-bearing code claim checked
against `lib/tracker/` and its consumers; independent codex pass over the same ground): added the
Authority role (fixing a §3.3 self-contradiction), closed D1 with evidence, split vision into
authored + projected layers, added ideas as a third store shape and first dogfood workload,
reframed §4 around Compose's own pipeline streams, and tightened the §5 floor. **Audited same
day** (top-down vs the founding vision and taxonomy, bottom-up vs the code, peer-to-peer vs
sibling designs): added the data-plane decision (D7 — the floor's biggest), the ports/ladder
reconciliation (§3.4), Session attribution on reconciliation events, the dependency graph as the
third Projection, the taxonomy-invariant amendment (D9), and the ideation-duality question (D8).

---

## 1. Why this exists

The GitHub tracker provider (`lib/tracker/github-provider.js`) can create and update issues, but
making a workspace *run on* it is a real build: no local→github importer, no remote hydration
(reads a local cache that `init` never populates), push-only `sync`, unpaginated issue search,
label clobbering on the feature/status write paths (completion writes preserve labels). Digging
into *why* those gaps exist surfaced that the provider abstraction itself is shaped around the one
implementation that predates it (`local`), and does not cleanly generalize to github, let alone
jira/linear/notion/miro. This doc fixes the abstraction first, then builds the manager/engineer
capability on top.

## 2. The current interface and its three weaknesses

`lib/tracker/provider.js` is a single `TrackerProvider` base with ~20 methods, each defaulting to
`NI('...')` (throw "not implemented"). `providerFor()` in `factory.js` dispatches on
`.compose/compose.json#tracker.provider` (`local | github`; unknown throws). Partial support is
handled two ways: a `capabilities()` Set of flags (`FEATURES/EVENTS/ROADMAP/CHANGELOG/JOURNAL/
VISION`), and a `withFallback()` Proxy that routes JOURNAL/VISION to a `local` provider when the
active provider lacks them.

**W1 — one fat interface with throwing defaults, and nobody checks the flags (ACTIVE, not
latent).** Interface-segregation failure. `github` implements ~16 methods; `deleteFeature` is
*unimplemented on both providers* and `addRoadmapEntry` on `github` (local implements it,
`local-provider.js:96`). "Implements the interface" is not true for any non-local provider, and
nothing enforces completeness. The `capabilities()` Set was meant as the runtime mitigation, but
the audit (formerly D1, now closed) found **no consumer outside `lib/tracker` ever consults it**
— the factory's `withFallback` reads it to route JOURNAL/VISION, and the only other
`capabilities()` callers in the codebase belong to the separate checkpoint-store abstraction. Worse, callers have reinvented
capability detection as provider-identity sniffing: `isLocalProvider()` guards at
`feature-writer.js:240`, `feature-writer.js:438`, and `feature-reconciler.js:279` branch on
`provider.name() === 'local'` — the textbook symptom of an interface that does not carry its
guarantees.

**W2 — the local-fallback Proxy is a leak; `local` is a mandatory substrate, not a peer.**
`providerFor()` always constructs `local` even for a github workspace, and `withFallback()`
hardcodes that JOURNAL/VISION delegate to it. So the architecture is "github *on top of* local,"
not "github *or* local." Composition is decided by the factory, not declared by the provider — a
jira provider cannot say "back my journal with X."

**W3 — capabilities encode presence, not fidelity (the deep one).** `github.capabilities()`
returns `FEATURES`, but `github.getFeature(code)` reads `this.cache.get(code)` — a local cache
`init` never hydrates — while `local.getFeature(code)` reads the file that is in git *right now*.
Same signature, categorically different guarantees. `local` is "the files are the truth"
(synchronous, single-writer); `github` is "a cache hoping to converge with a remote" (empty on a
fresh machine, push-only, stale-tolerant, multi-writer, rate-limited). The interface abstracts the
*operations* but not the *guarantees*. (One honesty note: `local` is not perfectly atomic either —
completion persists before status, status before roadmap render, and audit events are explicitly
best-effort — so the real contrast is "small, ordered, recoverable partial-write windows" vs
"unbounded divergence." The dichotomy softens; the conclusion — guarantees differ per
implementation and the interface hides it — stands.)

## 3. Substrate design (the floor)

### 3.1 Role taxonomy — segment by *direction of truth*, not by capability

The extension points are not one "provider" enum. They are five roles:

| Role | Direction | Owns truth? | Examples |
|---|---|---|---|
| **Store** | read-write, source of truth | yes (whole records) | `local`, `github`, plausibly `jira`/`linear` |
| **Projection** | derived (pure function of Store + Authorities) | no | roadmap render, vision-status |
| **Publisher** | write-only sink | no | markdown, miro board mirror, notion page mirror |
| **Authority** | readable, but *only for its declared owned fields* | yes (declared fields only) | linear: sequence/priority; miro: layout; jira: epic hierarchy/rank |
| **Resolver** | read-only reference | no | any URL-class cite (`jira/linear/notion/obsidian` — already `URL_CLASS` in `feature-validator.js:809`) |

The Authority role exists because the original draft contradicted itself: it defined Publishers as
one-way sinks, then had the projection "merge order-from-linear with layout-from-miro" — which is a
*read*. The moment Compose reads a field back from an external surface, that surface is not a
Publisher; it is an Authority for exactly its declared fields and nothing else. Publishers stay
strictly downstream; the Projection explicitly consumes `Store + Authorities`.

This makes facts structural that are currently runtime guesses: "miro is a Publisher, and an
Authority only for layout," "notion has no canonical status," "obsidian is resolve-only." A
backend implements the role interfaces it can actually honor, and a composer validates the wiring.

(Scope note: the checkpoint store (`lib/checkpoint/store/`) has its own parallel
`capabilities()`-based provider pattern — in fact the only real `capabilities()` consumer in the
codebase. It stays out of scope here; whether it adopts the role model is a call for its own
design. The constraint this doc imposes is only: no *third* pattern.)

### 3.2 Segment the fat interface — but bind by *aggregate*, not a flat six

The capabilities are not orthogonal stores. The test for "must co-bind" vs "separable" is three
couplings — and it must be run on **workflows, not just schemas** (several append paths carry
feature-keyed side effects the data shape alone doesn't show):

| | Referential integrity (keyed to a feature by identity?) | Atomicity (partial write = corruption or staleness?) | Derivable (regenerate from the Store?) |
|---|---|---|---|
| **events** | Yes — `appendEvent(code, event)` | see D6 — corruption *iff* events are authoritative | No (primary data) |
| **roadmap** | via features | n/a (projection) | **Yes** — projection of current status |
| **completion** | Yes — writes feature body + emits event | **Corruption** | No |
| **changelog** | Weak — `addChangelogEntry` requires a feature `code` and emits a best-effort feature-keyed audit event (`safeAppendEvent`, error-swallowed) | **Staleness** — a lagging changelog is a doc that's behind; a missed audit event is a warning, not corruption | **No** — append-only immutable history |
| **journal** | Weak — entries may carry `feature_code` | Staleness | No — append-only authored log |
| **vision (authored)** | Weak — vision items carry `featureCode` (`server/vision-store.js`) | Staleness | No |
| **vision (status)** | **Yes** — projected from features on every `setFeatureStatus` write and validated against them on read (`status-projection.js`, COMP-MCP-VALIDATE-3) | n/a (projection) | **Yes** |
| **ideas** | Weak, outbound — `PROMOTED → feature-code`, dangling-tolerant | Staleness — a promotion whose feature doesn't exist yet is recoverable, not corrupt | No (primary data) |

Conclusions:

- **Feature aggregate = features + events + completion + the projections (roadmap,
  vision-status, dependency graph).** These share referential integrity, so they bind to one
  Store. Splitting features and events across backends turns `recordCompletion` into a
  distributed write.
- **D6 (must decide before hardening the aggregate boundary): are events authoritative history or
  best-effort audit?** Today the code says audit: `safeAppendEvent` swallows failures with a
  warning, and completion/status/roadmap persist in deliberate non-atomic order. If events are
  authoritative, the atomicity argument above holds and today's best-effort behavior is a bug to
  fix in the same slice. If they are audit, the aggregate boundary needs a different justification
  (referential integrity alone). They cannot be both.
- **Vision splits in two.** The authored narrative is an independently bindable append log — but
  the status layer is a *projection of the feature aggregate* (the traceability rail — every
  output links to the goal it serves — runs through exactly this coupling). Binding vision
  wholesale to a different store than features would turn every status write into a distributed
  write. Split it: narrative binds freely; vision-status joins roadmap in the Projection family.
  Pleasingly, this strengthens the Projection role: the aggregate now has **three projections** —
  roadmap render, vision-status, and the **roadmap dependency graph**, which the epic's Decision 3
  already decided is the *only* cross-product surface (COMP-ROADMAP-GRAPH-2/3). The graph's
  external-node gap (GRAPH-3) is precisely an Authority/Resolver question, so it lands inside this
  taxonomy for free.
- **changelog, journal, and the authored-vision narrative are the same shape:** append-only
  authored logs, workspace-scoped, staleness-tolerant, non-derivable, with at most weak/best-effort
  feature refs. Independently bindable. (Today `github` implements changelog but falls back
  journal to local — an *arbitrary* line, since they are the same shape. Evidence the current
  interface was drawn ad hoc around `local`.)
- **Ideas are a third shape the original draft missed entirely:** neither the feature aggregate
  nor an append-only log, but a **small independent Store with its own lifecycle**
  (NEW → PROMOTED→code / KILLED → resurrect, priority P0–P2) and weak outbound refs. Today the
  ideabox (`lib/ideabox.js`, `docs/product/ideabox.md`) bypasses the tracker layer completely —
  the migration as originally scoped would have silently left ideation behind on a local file.
  See §5: it is the best *first* dogfood workload, not an afterthought. One duality to resolve
  (**D8**): the vision store also ships a first-class `idea` item type (`server/vision-store.js`
  VALID_TYPES) even though the epic's Decision 4 gave ideation to the ideabox — so a promote can
  touch ideabox + feature + vision item, a three-store walk this table doesn't model. Decide which
  store is canonical for ideas and mark the other derived (or a migration target).
- **roadmap is not a Store.** It is a Projection of the aggregate plus a fan-out to Publishers.

Segmenting fixes W1 (structural presence) and W2 (composition declared, `local` de-privileged). It
does **not** fix W3 (fidelity) — that still needs either narrowing each role interface to
guarantees all implementations honor, or attaching fidelity metadata (hydrates? bidirectional?
lossless labels?). Do not let the clean split hide the consistency problem.

### 3.3 Roadmap = Projection over Store + Authorities, fanned out to Publishers

```
FeatureStore (github = source of truth)     Authorities (declared fields only)
      │                                       linear: sequence   miro: layout
      │  merge: status-from-store +──────────┘
      ▼         order-from-linear + layout-from-miro   (disjoint owners, enforced)
RoadmapProjection
      │  fan-out, one-way, idempotent
      ├──► Publisher: markdown (ROADMAP.md)
      ├──► Publisher: notion (page/db)
      ├──► Publisher: miro (visual board)
      ├──► Publisher: linear
      └──► Publisher: jira
```

Publishers are one-way and idempotent, so a failed publish is a re-publish, never a corruption —
categorically safer than binding a `RoadmapStore` peer (which would drag in cross-store
atomicity). Authorities are the only read-back channel, and only for their declared fields, with
disjoint ownership enforced by the composer. **The trap:** never let a roadmap surface own feature
*status* — that is the bidirectional-sync nightmare. Truth stays one-directional *per field*.

One shipped hazard to carry into the Publisher work: the markdown Publisher must respect
narrative-owned roadmap mode — the known `roadmap generate` prose-clobber failure is exactly what
a naive markdown Publisher would reintroduce.

### 3.4 Reconciling with the epic's ports & ladder model (do not fork vocabularies)

The COMP-ROADMAP epic anchor
([Decision 2](../plans/2026-06-21-roadmap-planning-model-design.md)) already defines a seam
model this doc must not silently compete with: **Ports** (TrackerPort, DocumentPort, DesignPort,
BuildTargetPort) and an **integration-depth ladder** (REFERENCE → DRIVE → SYNC → SUBSUME), with
COMP-ROADMAP-PROVIDERS reserved for "TrackerProvider v2." **This doc is that TrackerProvider v2
design.** The mapping:

| Ladder (epic, per-integration) | Role (this doc, per-field-capable) | Note |
|---|---|---|
| REFERENCE | Resolver | identical |
| DRIVE | Publisher | identical |
| SYNC | **Authority** (field-scoped) | the upgrade: coarse whole-record SYNC is exactly the bidirectional nightmare §3.3 forbids; Authority narrows it to declared fields with disjoint owners |
| SUBSUME | Store | identical |

Terms of coexistence: the **roles** are the normative model for the tracker seam — this doc
supersedes the ladder there, since per-field granularity is the whole point. The **ladder**
remains the epic's vocabulary for integration depth on the non-tracker ports
(Document/Design/BuildTarget), which are out of scope here but should adopt the same role split
when they are designed. Recorded so future sessions do not fork between the two vocabularies.

## 4. Reconciliation layer (the vision) — manager vs engineer

The Publisher model above is one-directional. The next capability is genuinely bidirectional **at
the item level**: a manager works top-down (authors the plan) and an engineer works bottom-up
(creates/completes work items in code), and the two must reconcile automatically.

**Reframe (from the review): this layer is Compose's own pipeline, externalized — not Jira
interop.** In the founding model (compose-one-pager), F4 Plan & Decompose emits planned intent
top-down and F5 Execute emits discovered work and real status bottom-up. Those *are* the manager
stream and the engineer stream — the "manager" is Compose itself plus the human at gates, before
it is ever a person in Jira. Design the event vocabulary and the reconciler against Compose's own
two internal streams first (dogfoodable immediately, no external transport); Jira/Linear become
later *bindings* of the manager stream. This also corrects the framing of §5: the core of the
reconciliation engine generalizes what the pipeline already does between planning and execution.

### 4.1 Field ownership (the discipline)

| | Manager (top-down: F4 / human gates / Jira, Linear) | Engineer (bottom-up: F5 / code, GitHub) |
|---|---|---|
| **Creates** | *planned* intent ("build X, then Y") | *discovered* work ("found a bug, filed it") |
| **Owns (authoritative)** | priority/rank, grouping/initiative, sequence, **disposition** (kill/defer/supersede requests), target milestone | **execution state** (in-progress/partial/complete), technical breakdown (X → X1/X2), completion evidence (commits, tests, artifacts) |
| **Flow** | down into work items | up into the roadmap view |

**Correction from the review — the original table hid a contested field.** It gave the manager
"scope decisions (kill/defer)" and the engineer "real status," but kill/defer *are* status values
in Compose's vocabulary (KILLED/PARKED/SUPERSEDED) — two owners, one field, exactly the violation
the discipline forbids. The fix is to split the status field along the ownership line:
**disposition** (should this exist / when: manager) vs **execution state** (what is actually true
of the work: engineer). A manager kill is a disposition *request* that the engineer stream folds
(normally auto-accepted; contested only if work is mid-flight); it is never a direct write to
execution state. The Jira card renders manager's priority *and* engineer's real status, each from
its rightful owner.

**This split amends a DECIDED invariant — say so out loud.** `taxonomy.md` declares one universal
Work-item status lifecycle (planned → ready → in_progress → review → complete, + blocked/parked)
as an invariant of the system. Disposition/execution-state is a change to that taxonomy, not a
private convention of the reconciler, and it must define its projection into the two status
vocabularies that already exist (roadmap UPPERCASE, vision lowercase — bridged by
`status-projection.js`) rather than becoming a third unmapped one. Filed as **D9**.

### 4.2 Why this is not the "unsolvable sync" the project rejected

The [roadmap-planning model](../plans/2026-06-21-roadmap-planning-model-design.md) / roadmap-model
decision rejected bidirectional reconciliation as an unsolvable failure mode and chose
references-not-sync. That ruling was correct for what it rejected: syncing *contested* state (two
authors, one field, last-writer-wins races, no canonical merge). Field-partitioned reconciliation
is a different problem wearing the same word: if every field has exactly one owner, there is no
contested field — only a deterministic merge of disjoint sources.

**Scoped honestly (review correction):** single-owner-per-field eliminates write/write races on
independent scalar fields, where disjoint-owner events genuinely commute. It does **not** make the
whole event vocabulary commutative: priority/rank is an *ordered relation*, not a scalar;
split/merge/reparent changes identity and topology; disposition interacts with execution state
across fields. The reconciler therefore still needs explicit causality/ordering rules, stable
event identities, and defined replay behavior for the non-commuting minority. The instinct is
sound exactly to the degree the field-ownership line holds — and the non-scalar operations are
where it must be defended deliberately.

### 4.3 What the automation must actually do (three problems)

1. **Identity reconciliation** — two creation sources. A manager-planned "X" and an engineer's
   already-in-flight work must resolve to *one* entity. Start from **durable external IDs plus an
   explicit claim/link handshake — never automatic semantic matching**, which silently conflates
   similarly-named planned and discovered work. This is the real work; it is tractable but not
   free. (It already exists in miniature: `promoteIdea` — an idea claiming a feature code — is the
   claim handshake at its smallest.)
2. **Per-field merge with ownership enforcement** — a status write from the manager side is not
   truth, it is a *request* ("please close this") the engineer side confirms/rejects; an engineer
   re-grouping is a *suggestion* to the manager's structure. Note (review): requests and
   suggestions are a third kind of state — a decision workflow with its own lifecycle, expiry, and
   audit trail — not merely "non-authoritative writes."
3. **Contested-set escalation — through the 3-mode dial, not a new mechanism.** The residual
   overlap surfaces as an explicit decision, never silent last-writer-wins. The product already
   has the Policy primitive for exactly this: **gate** (human decides) / **flag** (proceed,
   notify) / **skip** (autonomous), with self-escalation on uncertainty. A manager close-request
   folding into engineer-owned state is a decision point like any other: gate it at low trust,
   flag it at high trust. The approve/edit/reject/respond taxonomy (`idea_richer_gate_decisions`)
   enriches the gate's *response* vocabulary — it does not justify a second, parallel decision
   system outside the four primitives.

Mechanically this wants to be **event-sourced, not state-synced**: each side emits intent
("prioritize X above Y", "X merged", "spawned X1"); a reconciler folds both streams into the
merged view. **Every event carries Session-primitive attribution** — which actor authored it
(human at a gate, Compose's F4, an F5 agent, a person in Jira). This is not decoration: field
ownership is unenforceable without knowing the author, and the dial cannot calibrate trust per
actor without it. The manager/engineer streams are Session-attributed event logs, or they are
nothing.

**The seeds already exist — three of them:** `lib/tracker/sync-engine.js` implements intent
records with idempotency keys, CAS base-versions, a conflict ledger, and quarantine; and
`lib/xref-sync.js` (PULL: external truth reconciled into local `expect`, never writing outward) +
`lib/xref-push.js` are shipped one-directional, per-field, single-owner reconcilers — working
prototypes of the Authority read-back channel. The reconciliation layer is an extension of
existing write paths, not greenfield.

## 5. Scope boundary (do not conflate)

- **Near-term migration (the floor, schedulable now) — on the CURRENT interface.** The review's
  sharpest scope finding: the role/aggregate redesign is valuable architecture but **not a
  prerequisite** for making the github provider honest. The floor is: importer, remote hydration,
  pagination, label *preservation* on the clobbering paths, and an explicit read-consistency
  contract — done against the existing `TrackerProvider` surface, with the redesign landing as its
  own later slice (sequenced with COMP-ROADMAP-MODES, the epic's keystone that makes provider
  seams pluggable — the role segmentation does not jump that queue). Corrections that change the
  floor's shape:
  - **D7 comes first — the data-plane decision (the audit's critical finding).** Only four
    modules go through `providerFor()` (`build.js`, `feature-writer.js`, `changelog-writer.js`,
    `completion-writer.js`); roughly twenty read `docs/features/*/feature.json` and `ROADMAP.md`
    directly from disk (`feature-validator`, `roadmap-gen`, `get-roadmap`, `xref-sync`,
    `xref-push`, `deps`, `triage`, `sections`, `state-migrations`, `followup-writer`,
    `lane-gate`, …). That works today only because `local` writes the same files they read.
    `github` writes issues plus a private `tracker-cache/features.json` blob and **never**
    `feature.json` — so in a github workspace the entire direct-reader plane (validation,
    rendering, drift, deps) goes dark. Recommended resolution: **hydration materializes into the
    canonical files** — `docs/features/` *is* the cache, the github Store syncs it, every direct
    reader keeps working unmodified, and the private cache blob disappears. This also dissolves
    most of W3: the files remain the local truth; github is the remote being converged with. The
    alternative (routing all ~20 readers through the provider) is a refactor the floor cannot
    afford.
  - **Hydration is a write-correctness prerequisite, not read polish.** Consumers constantly do
    `getFeature → mutate → putFeature` (e.g. `feature-writer.js:620→645`); an unhydrated cache
    means writing from null/stale bases.
  - **Enumerate every canonical mutation producer, not just the importer and provider read path.**
    `build.js` mutates lifecycle via `persistFeatureRaw()` directly (e.g. `build.js:1892`,
    `build.js:3425`), deliberately skipping events and roadmap render — under github that path
    silently diverges cache from remote projection.
  - **Sequencing *(re-ruled 2026-07-21)*:** stratum (1 record) → compose (291 records). The
    ideabox **leaves the tracker seam entirely**: per the `PROVIDER-SEAM` substrate ruling
    ([what-to-build §8k](../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives)),
    ideas are fluid-layer records on the fluid-store provider, never tracker workloads —
    pre-commitment judgment material doesn't belong on the committed/execution plane.
    [IDEA-20](../product/ideabox.md) is re-aimed accordingly (GitHub dogfood starts at stratum).
    The field-ownership observations the original sequencing made about ideas (triage/promote as
    manager-owned fields) remain valid *inside the fluid seam* and carry over to §4's discipline
    when the reconciler is built.
- **Vision layer (larger, separate):** Projection + Authorities + Publishers
  (notion/miro/linear/jira), and the manager/engineer reconciliation engine — built against
  Compose's own F4/F5 streams first (see §4 reframe). This reopens the no-bidirectional-sync
  decision under the single-owner-per-field discipline. File as its own initiative when picked up.

## 6. Open questions / decisions

- **D1 — CLOSED (2026-07-19):** callers do NOT consult `capabilities()` — no production tracker
  consumer checks it, and three call sites sniff provider identity instead
  (`feature-writer.js:240,438`, `feature-reconciler.js:279`). W1/W3 are active. Evidence in §2.
- **D2:** Fidelity (W3) — narrow each role interface to universally-honorable guarantees, or
  attach fidelity metadata? Affects every consumer (validate, roadmap, drift).
- **D3:** Is `deleteFeature` a real requirement, or should it be removed from the interface?
  (Neither provider implements it.)
- **D4 — DECIDED (2026-07-19):** linear/jira are pure Publishers in v1. Authored-field ownership
  (sequence/priority) arrives only with the Authority role in the reconciliation initiative —
  because the moment any external surface owns an authored field, identity reconciliation
  (§4.3.1, the expensive part) comes with it.
- **D5:** Revisit the roadmap-model "references, not sync" ruling explicitly: does
  field-partitioned reconciliation supersede it, or coexist? **Mostly answered by the epic's own
  Decision 3:** cross-project = the dependency graph at REFERENCE depth; reconciliation = within a
  workspace. Confirm and close when the vision-layer initiative is filed.
- **D6 (new):** Are events authoritative history or best-effort audit? Decides the aggregate's
  atomicity claim and whether today's `safeAppendEvent` error-swallowing is a feature or a bug.
  See §3.2.
- **D7 (new — decides the floor's shape, decide before the importer is built):** where do
  hydrated features live? Materialized into canonical `docs/features/` files (recommended — keeps
  the ~20 direct readers working, deletes the private cache, dissolves most of W3), or a private
  cache with every reader routed through the provider (unaffordable)? See §5.
- **D8 — DECIDED (2026-07-21):** neither, as posed. Canon for ideas is the **fluid-store
  provider** (`PROVIDER-SEAM`,
  [what-to-build §8k](../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives)):
  a zero-install local floor expected to implement over the vision store's `idea` type, with
  SmartMemory as the capability-rich reference provider. The ideabox stays the funnel/UI and its
  markdown becomes a projection (COMP-PLAN-IDEA-UNIFY, the seam's pilot workload). The three-store
  walk collapses to provider-record + `feature.json` at promote.
- **D9 (new):** the disposition/execution-state split (§4.1) amends `taxonomy.md`'s
  single-status-lifecycle invariant. Define its projection into the existing roadmap/vision
  status vocabularies (extend `status-projection.js`, or a separate field) before the reconciler
  is designed.

## 7. Related documents

- `../../ROADMAP.md` (compose) line 7 — references the per-project-provider roadmap model; the
  full "Roadmap Model" decision (per-project provider, references-not-sync) lives in forge-top
  `ROADMAP.md`
- `../plans/2026-06-21-roadmap-planning-model-design.md` — the COMP-ROADMAP epic anchor this
  builds on: the ports & ladder model §3.4 reconciles with, the COMP-ROADMAP-PROVIDERS slice this
  doc *is*, the MODES keystone §5 sequences against, and Decisions 3 (graph) and 4 (ideabox) that
  D5/D8 lean on
- `../taxonomy.md` — the DECIDED Work-item invariants; §4.1's disposition split amends its status
  lifecycle (D9)
- `../compose-one-pager.md` — the founding vision this design must reflect: swappable connectors
  with markdown-in-git default (the floor is that promise executed), the four primitives (the
  3-mode dial governs §4.3.3), and the F4/F5 streams (§4's reframe)
- `lib/tracker/{provider,factory,github-provider,local-provider}.js` — the interface under redesign
- `lib/tracker/sync-engine.js` — oplog/CAS/quarantine: the event-sourced seed of §4.3
- `lib/xref-sync.js` + `lib/xref-push.js` — shipped per-field one-directional reconcilers; §4.3
  seeds and Authority-channel prototypes
- `server/vision-store.js` — vision items (feature-keyed, `idea` type — D8)
- `lib/checkpoint/store/` — the parallel `capabilities()` provider pattern (§3.1 scope note)
- `lib/tracker/github-api.js` — unpaginated search (floor work item)
- `lib/ideabox.js` + `docs/product/ideabox.md` — ideation store, currently outside the tracker
  layer entirely (§3.2 third shape; §5 first dogfood workload)
- `lib/status-projection.js` — the vision-status projection (COMP-MCP-VALIDATE-3) behind the §3.2
  vision split
- `lib/feature-validator.js:809` — `URL_CLASS` (the resolver-role seam that already exists)
- GitHub tracker migration scoping (2026-07-19 investigation) — the gap list that motivated the floor
