# COMP-JUDGMENT-PACKAGES — Resolution packages + transition coupling

**Status:** DRAFT r1 (seeded) — carved out of COMP-JUDGMENT-STORES at its gate round 5
(2026-07-23). This corner generated nearly every late finding across five sol/xhigh
review rounds; the owner ruled it gets its own design gate. The material below is the
parent's r6 state — every round-1–5 finding against packages is already folded in —
but this doc has NOT passed a gate of its own yet.
**Date:** 2026-07-23

## Related Documents

- Roadmap row: `ROADMAP.md` → Judgment Layer → COMP-JUDGMENT-PACKAGES
- Parent: [`COMP-JUDGMENT-STORES`](../COMP-JUDGMENT-STORES/design.md) — ships the
  person/situation/goal stores this feature builds beside; its design.md records the
  full five-round gate history and adjudications
- Sibling: [`COMP-JUDGMENT-GOAL-MIGRATE`](../COMP-JUDGMENT-GOAL-MIGRATE/design.md)
- Domain spec (BINDING): `docs/design/2026-07-20-judgment-layer-process-manual.md` —
  Resolutions box (seq 111), Writer box (seq 112)
- Code substrate: `lib/judgment-writer.js` (`judgment_transition`, intents,
  reconciler), `contracts/judgment-record.schema.json`, `lib/judgment/store/records.js`,
  `lib/judgment-gen.js`

## Problem

Seq 111 defines the resolution package — question/prediction/evidence/verdict with
sharpen-first, diagnosticity, the VOI cap, and sequential stopping — but none of it is
mechanical. Evidence can be gathered before a prediction exists, bars can move after
evidence arrives, dispositions can run unsharpened, and outcomes have no durable
artifact once a joint re-disposes. This feature makes the package real and couples it
to the ONE existing lifecycle authority.

## Scope

- `resolution_package` record kind (chain per joint, mutable-until-sealed)
- `judgment_package_write` MCP tool (`create` · `correct` · `evidence`)
- `judgment_transition` coupling: seal-in-intent, joint-state × op matrix, intent
  fencing, method binding, `JUDGMENT_NO_PACKAGE` dispose gate
- Prediction lifecycle closure (`open → graded | void`, both terminal; single
  spawner per context; CONSTRUCT `prediction_ref` binding)
- `docs/judgment/resolutions/<joint>.md` projection
- Canon-manifest rows for `records/resolutions/**` and prediction/intent surfaces

Non-goals: everything listed in the parent design's Non-Goals, plus the
person/situation/goal stores (parent) and the objective migration (sibling).

## Record kind

### Resolution package — `records/resolutions/<joint-slug>/p<N>.json` (chain per joint; each package mutable-until-sealed)

```jsonc
{
  "joint": "<joint-slug>", "package": 2,        // p2 = re-dispose after p1 sealed inconclusive
  "disposed_by": "EXT|INT|CONSTRUCT|ASSERT|STRADDLE",   // the method this package serves
  "method_trace": [ /* prior disposed_by values + correction provenance */ ],
  "question": { "restatement": "falsifiable form", "bar": "pre-written bar",
                "no_looks_like": "what NO looks like",
                "trace": [ /* pre-evidence corrections */ ] },
  "prediction": { "prediction_id": "p-7", "made_at": "…" },
                  // the TEXT lives in the prediction store — single canonical body;
                  // created atomically with the package
  "spend_ceiling": "hours|days|weeks|months",    // VOI cap in the EXISTING coarse buckets
  "evidence": [ { "id": "e1", "source": "…", "reliability": "…", "at": "…",
                  "points_at": "true|false|both",  // diagnosticity (ACH)
                  "weight_zero": true,             // WRITER-STAMPED iff points_at=both
                  "note": "…", "provenance": {} } ],
  "seal": { "at": "…", "edge_to": "resolved|inconclusive|superseded|dissolved|open",
            "artifact_kind": "resolution|dissolution",
            "artifact": { /* the FULL resolution or dissolution object, embedded
                             verbatim — the package is the DURABLE OWNER of
                             disposition history: the joint's copy is transient
                             (deleted on reopen/redispose), the package's survives */ },
            "adjudicated_by": "owner|agent",
            "provenance": { /* writer-stamped; carries intent_id — replay attribution */ } },
  "provenance": {}
}
```

- **The seal is written by `judgment_transition`, never by a package op.** A package
  without a `seal` is *open*; at most one open package per joint.
- **Prediction: one canonical body, one spawner per context, full lifecycle.**
  Package `create` spawns the prediction record (context: `package`) and stores only
  its id — ONE feed, no second text to drift. Pre-evidence prediction `correct`
  mutates the prediction RECORD fix-in-place-with-trace (the record gains an optional
  `trace[]`), in the same locked commit. **CONSTRUCT-disposition spawning retires for
  joint dispositions:** a disposition ledger event on a packaged joint must carry
  `prediction_ref` to the package's prediction instead of an embedded `prediction`
  (rejected otherwise) — the spawn path survives only for commit-moment decides
  (context `commit`, no joint). Prediction `status` grows `open | graded | void`:
  a seal whose artifact is `failed_to_run`, `superseded`, or a dissolution flips the
  package's prediction to `void` in the same intent. **The prediction state machine
  is `open → graded | void`, both terminal**: postmortem grading rejects a non-`open`
  prediction (`JUDGMENT_CONFLICT`) — today's grading path overwrites unconditionally
  and gains this check. **Invalidating seals only void `open` predictions — an
  existing grade is PRESERVED**: the manual lets a prediction come due and be graded
  while its package is still open; the seal's prediction-status effect is
  `open → void`, no-op otherwise. A CONSTRUCT disposition's `prediction_ref` is
  **bound to its joint**: the event must anchor `joint:<slug>` and the ref must equal
  that joint's open package prediction — checked in `execute` under the lock.
- Verdict vocabulary is the EXISTING resolution enum (`resolved | inconclusive |
  failed_to_run | superseded`); dissolution is the separate artifact it already is.
  `learned` / `would_have_settled` / reasons live inside the embedded artifact —
  after the first re-dispose wipes the joint's transient copy, the sealed package
  still resolves them.

## Single lifecycle authority

The joint state machine (`judgment_transition`: guarded, intent-first, crash-safe)
remains the ONLY authority over dispositions and outcomes. Packages attach to it:

- `judgment_package_write` ops: `create` · `correct` (question/prediction/`disposed_by`,
  pre-evidence only, traced) · `evidence`. **There is no verdict op.**
- **Joint-state × package-op matrix** (every cell explicit):

  | Joint state | `create` | `correct` | `evidence` | Transition effect on open package |
  |---|---|---|---|---|
  | `open` | ✓ (if no open pkg) | ✓ pre-evidence | ✗ `JUDGMENT_JOINT_STATE` | `→ under_test`: requires open pkg (dispose); `→ superseded/dissolved`: SEALS open pkg (`edge_to` + artifact) |
  | `under_test` | ✗ (open pkg exists for post-rule dispositions) | ✓ pre-evidence | ✓ | every exit edge SEALS the open pkg in the same intent |
  | `inconclusive` | ✓ p<N+1> (prior pkg sealed) | ✓ on the new open pkg | ✗ | `→ under_test\|open` (re-dispose): requires a NEW open pkg |
  | `resolved` | ✗ `JUDGMENT_JOINT_STATE` | ✗ | ✗ | reopenable: `resolved → open` on shaken evidence (`SHAKE-GROUNDING`) — the only reopen edge that exists |
  | `superseded` / `dissolved` | ✗ `JUDGMENT_JOINT_STATE` | ✗ | ✗ | terminal — NO reopen edge exists and this feature adds none |

  Evidence only flows while the disposition is actually running (`under_test`);
  **every edge that permanently invalidates an open package seals it** — including
  `open → superseded|dissolved` on a sharpened-but-never-disposed joint.
- **Grandfather rule:** sealing and `evidence` apply to *an open package if one
  exists*. The one pre-rule `under_test` joint (`joint-is-non-obvious`) has none —
  its exit edges stay legal with NO seal written; its disposition artifact lives on
  the joint + ledger exactly as today. No backfill, no fabricated package.
  Package-required checks bind new dispositions only.
- **Sealing and package creation are intent-backed:** `UndoLog` compensates
  exceptions, not process death, so BOTH multi-file package operations ride the
  existing persist-intent → apply → clear pipeline — `create` (package + prediction
  record) and seal (package + joint edge + prediction status). The reconciler
  replays an interrupted write whole; `applyPayload` gains package/prediction-status
  entries.
- **Intent fencing:** while a pending transition intent references a joint, ALL
  `judgment_package_write` ops for that joint reject with `JUDGMENT_INTENT_PENDING`
  (checked in `execute` under the writer lock, where the reconciler has already
  run). A guard outage can therefore never interleave a package mutation between
  the persisted seal snapshot and its replay.
- **Method binding:** at every dispose edge the writer checks
  `openPackage.disposed_by === (redispose?.new_resolve_by ?? joint.resolve_by)` —
  `JUDGMENT_METHOD_MISMATCH`. A wrong `disposed_by` is fixable: pre-disposition
  `correct` (joint `open`/`inconclusive`) may rebind it, recorded in
  `method_trace[]`. The resolution package is the **single sharpening authority**:
  today's `ext_package` is either `{sharpened_question, bar, falsifier}` or
  `{judgment_dispatch, reason}` — on new dispositions the sharpening variant is
  superseded by the package (a supplied sharpening-variant ext payload is rejected),
  while the `judgment_dispatch/reason` **exception stamp stays on the joint's ext**,
  so the `BAR-OR-JUDGMENT` gate in `judgment-write-guard.js` keeps its stamp source;
  its bar-presence side reads the open package. Straddle keeps its signal fields
  (method legitimacy, not sharpening).
- **Sharpen-first made mechanical** (seq 111): both dispose edges
  (`open → under_test`, `inconclusive → under_test`) REQUIRE an open package
  (question + prediction + bar pre-written) — `JUDGMENT_NO_PACKAGE`.

## Invariants

| # | Rule (source) | Enforcement | Error code |
|---|---|---|---|
| P1 | Evidence before prediction — CONSTRUCTION-TRAP (111/112) | structural: `create` requires question+prediction, empty evidence; `evidence` re-checks | `JUDGMENT_EVIDENCE_BEFORE_PREDICTION` |
| P2 | Moved bar = outcome switching (111) | `correct` on question/prediction rejected once ANY evidence exists; seal makes the package immutable | `JUDGMENT_BAR_FROZEN` |
| P3 | Both-branch evidence weighs zero (111) | writer stamps `weight_zero: true` on `points_at: "both"` (recorded, not rejected) | — |
| P4 | Sharpen-first gates every disposition (111) | both dispose edges require an open package | `JUDGMENT_NO_PACKAGE` |
| P5 | Real joint; one open package per joint | `create` resolves joint + chain | `JUDGMENT_NOT_FOUND` / `JUDGMENT_CONFLICT` |
| P6 | Joint-state matrix (`evidence` only under_test; no ops on terminal joints) | prechecks per matrix | `JUDGMENT_JOINT_STATE` |
| P7 | Intent fencing | precheck after reconciler | `JUDGMENT_INTENT_PENDING` |
| P8 | Method binding + no duplicate sharpening in ext/straddle | precheck in transition | `JUDGMENT_METHOD_MISMATCH` |
| P9 | Seal only via transition; seal + edge + prediction status atomic in one intent | structural | — |
| P10 | Prediction machine `open → graded|void`, terminal; grading non-open rejects | precheck in grading path | `JUDGMENT_CONFLICT` |

## Projection

`docs/judgment/resolutions/<joint>.md` — source: package chain **+ referenced
prediction records** (prediction text lives only in the prediction store, so the
generator snapshot loads them; a missing/mismatched ref renders an explicit
integrity-warning line, never silently omits). Question/prediction/bar first,
evidence table with weight-zero column, seal; linked from REGISTER.md joint rows.
Orphan scan extends to `resolutions/`.

## Canon-manifest rows (merge into the parent's manifest)

| Path | Legitimate mutations | Physical mutation surfaces |
|---|---|---|
| `records/resolutions/**` | create/correct/evidence; seal | `judgment_package_write`; `judgment_transition`; reconciler replay (every writer op AND `get_judgment_state`) |
| `records/predictions/**` | + spawn (package create); trace-correct; void-on-seal | `judgment_package_write`, `judgment_transition` (seal), reconciler replay |
| `records/intents/**` | + persist/clear (package create/seal) | `judgment_package_write`, `judgment_transition`, reconciler |
| `resolutions/*.md` | regeneration only | `regenerateProjections` |

Replay attribution: seals stamp `provenance.intent_id` of the originating transition
intent (schema field ships with the parent feature).

## Decisions (carried from the parent gate, still binding here)

1. **Seal via transition, not a verdict op.** One lifecycle authority; packages and
   joints can never disagree. *Rejected:* independent package verdict.
2. **The package is the durable owner of disposition history.** Seal embeds the full
   artifact. *Rejected:* seal-by-reference (dangles after re-dispose); a new
   transition-identity scheme.
3. **Prediction text lives only in the prediction store.** *Rejected:* dual copies;
   package-local text with sweep special-casing.
4. **Bar freeze over bar-edit-with-trace.** Freeze on first evidence; traced
   corrections before that. *Rejected:* full immutability at create.
5. **`points_at: both` records rather than rejects.** Zeroed-but-visible IS the
   confirmation-by-pile measure.
6. **Mutable-until-sealed chain.** Chain across dispositions (p<N>), each package
   mutable until its seal.

## Acceptance criteria

- [ ] Every invariant row P1–P10 has a rejection/property test (code + message asserted)
- [ ] Matrix: every ✗ cell has a rejection test; `open → superseded|dissolved` with an open package seals it
- [ ] Package golden flow: create (spawns prediction) → evidence (incl. one `both`, weight-zero stamped) → transition seals + resolves atomically; evidence-before-prediction, bar-edit-after-evidence, dispose-without-package, second-open-package all reject
- [ ] Crash-window: interrupted seal replays package + joint edge + prediction status together; interrupted create replays package + prediction together
- [ ] Intent fencing rejection test; grandfathered joint exits legally with no package
- [ ] Sealing with a `graded` prediction preserves the grade; grading `void`/`graded` rejects; CONSTRUCT with embedded `prediction` on a packaged joint rejects
- [ ] Projection renders prediction text from the store; missing ref renders integrity warning; hand-edit overwritten on regen
- [ ] Full suite green; MCP e2e exercises `judgment_package_write`; policy test asserts reviewer denial

## Open questions

Needs its own Codex design gate (sol/xhigh) before blueprint — seeded material has
survived five parent rounds but this scope has not been reviewed standalone.
