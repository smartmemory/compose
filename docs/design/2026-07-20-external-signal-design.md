# External Signal — Acquisition Design (read half)

**Status:** DESIGN — owner-approved shape, unbuilt
**Date:** 2026-07-20
**Scope:** the **read** half only. The **poke** half is deliberately deferred and designed second (`READ-THEN-POKE`).

## Related Documents

- Source of the claims this implements: [What To Build — The Judgment Layer](../product/2026-07-20-what-to-build-vision.md) §5 (evidence), §6 (branching), §7 (generation)
- Operating procedures this amends: [Judgment Layer — Process Manual](2026-07-20-judgment-layer-process-manual.md) — P2 step 3 (`EXT` tagging) and P3 (`EXT` disposition) both gain preconditions from this doc
- Live joint state: [JOINT REGISTER](../judgment/REGISTER.md) · [LEDGER](../judgment/LEDGER.md)
- Context: [The Discovery Loop](../product/2026-07-20-discovery-loop-vision.md)

**Grounding key** as per the vision doc: `[EXT]` `[INT]` `[ASSERT]` `[DERIVED]` `[owner-locked]`

---

## 0. What this closes and what it does not

The vision says a great deal *about* external signal — `SIGNAL-NOT-IDEAS`, `INTERPRETATION-ASSET`,
`KEEP-THE-RAW`, `LOW-YIELD-BY-DESIGN`, `CONTINUOUS-INGEST`, `THE-WORLD-CAN-ARGUE`,
`JOINTS-ARE-WATCHLIST`. None of it says how anything gets in the door. Tagging evidence `EXT`
in a schema does not create acquisition.

**`INTERNET-IS-ALL`** `[owner-locked]` — There are no users to instrument and no market access.
The public web is the entire reachable surface today. Any design premised on telemetry, a user
panel, or a customer base is fiction at this date. This is a statement of current position, not
of permanent architecture.

**`READ-THEN-POKE`** `[owner-locked]` — The web is two instruments, not one.
*Reading* is observational: other people's exhaust, free, fast, already there. *Poking* is
interventional: publish something, contact someone, ship something and watch what returns.
Only poking can answer a question nobody has already answered in public. The read half is
designed now in full; the poke half is bolted on afterwards, and the design carries the seams
for it (`FOUND-OR-PROVOKED`).

---

## 1. Two machines

**`TWO-MACHINES`** `[owner-locked]` — Acquisition is two processes with **separate budgets**,
not one pipe with a relevance filter.

| | **The Answerer** | **The Wanderer** |
|---|---|---|
| Trigger | a register joint goes `UNDER TEST` tagged `EXT` | fixed schedule, independent of the register |
| Input | exactly one sharpened question | nothing |
| Output | a resolution package (§3) | a candidate joint, or a candidate idea |
| Judged on | joints actually settled | ever having produced a joint the owner had not asked |
| Yield | high precision by construction | near-zero by design (`LOW-YIELD-BY-DESIGN`) |
| Budget | per-question | fixed, standing, not reallocatable to the Answerer |

**`WALL-BETWEEN`** `[DERIVED]` — The Wanderer **may not conclude**. It cannot resolve a joint,
mark evidence against a position, or write to a position file. Its only permitted writes are a
proposed register entry or a candidate. The Answerer **may not add joints**; anything interesting
it trips over goes onto the Wanderer's pile and it carries on with its one question.

The wall exists because `OPPOSITE-FAILURE-MODES` is already settled: evaluation fails by being too
permissive, generation by being too narrow, and they cannot be one mechanism. Without an enforced
wall they merge under load — the Wanderer starts helpfully answering things, and the result is a
single machine that reads the world to confirm its own agenda.

### 1a. This dissolves `ingest-continuous`

The register carries `ingest-continuous` as an open `ASSERT` joint: *continuous or invoked?*
It is not one question, and answering it globally would have been wrong either way.

- The Answerer is **invoked** by nature. There is nothing to answer when nothing is asked.
  Invoked here is not the "degrades to on-demand research" failure `CONTINUOUS-INGEST` warns
  about, because the invocation is driven by a standing register, not by a person remembering
  to ask.
- The Wanderer is **continuous** or it is pointless. Signal arrives on the world's clock
  (`CONTINUOUS-INGEST`), and a wanderer you have to remember to run is a wanderer that stops.

Recorded in the register as **dissolved by decomposition**, not resolved by assertion.

### 1b. The collision this resolves

`JOINTS-ARE-WATCHLIST` makes open joints the ingestion filter. `OPPOSITE-FAILURE-MODES` says
generation fails by narrowness. Held together in a single pipe these contradict: a register-keyed
filter can only return answers to questions already asked, so the world loses the ability to tell
you that you are asking about the wrong thing — which is exactly `SIGNAL-NOT-IDEAS` inverted.

`TWO-MACHINES` is the resolution. `JOINTS-ARE-WATCHLIST` is **scoped to the Answerer** and is
correct there. The Wanderer is explicitly *not* watchlist-filtered, and its low precision is the
price of the surprise.

---

## 2. The sharpening gate (precondition on `EXT`)

**`SHARPEN-FIRST`** `[owner-locked]` — A joint may not be dispatched to the Answerer until three
things are written down, **before** anything is fetched:

1. **A restatement a fact can settle.** Not *"are we differentiated from Productboard?"* but
   *"none of the top five charge for X"* — a proposition the world can falsify.
2. **The bar.** What counts as enough. Enough for what, measured how.
3. **What result would mean NO.** If no obtainable finding could have changed the answer, the
   lookup is theatre and does not count as a resolution.

This is P3's `CONSTRUCTION-TRAP` rule (*no prediction, no build*) applied to looking. The manual
currently has that discipline for `CONSTRUCT` and nothing equivalent for `EXT`, which is an
asymmetry with no justification: reading is at least as prone to motivated conclusion as building,
and considerably cheaper to do carelessly.

**`BAR-OR-JUDGMENT`** `[owner-locked]` — Some joints genuinely cannot be sharpened without
pretending. Those still dispatch, but the bar is written anyway and the result returns stamped
**`JUDGMENT-NOT-EVIDENCE`**. The stamp is permanent and propagates: anywhere the finding is cited,
downstream, the stamp is visible. The ledger must never record an opinion as a finding.

### 2a. Why this, and not a bias check on the machine

Recorded because the first framing was wrong and the correction is the useful part.

The initial claim was that the Answerer is a flattery engine. **It is not.** Fetching and
extraction are factual and there is no wanting involved. The defect is upstream and structural:

- **The question is not factual.** *"Different enough"* has no fact-shaped answer. The machine
  must supply a threshold nobody wrote down, or it cannot answer at all. That supplied threshold
  is the entire defect, and it is invisible in the output.
- **The sample is asymmetric even when every step is honest.** What it reads *about us* is our
  own position document, which argues our case. What it reads about a competitor is their
  marketing surface. Best case against public face.
- **The sample is self-selected.** Three competitors or eight? Nobody specified. The answer moves
  with the sample, and the sample is chosen by the thing answering.
- **Silence reads as support.** Nothing found contradicting a position is not evidence for it
  (§3, `THREE-SILENCES`).

`SHARPEN-FIRST` attacks the first. §3 attacks the rest.

---

## 3. The resolution package

**`PACKAGE-NOT-ANSWER`** `[DERIVED]` — The Answerer never returns a conclusion alone. Three parts,
always:

1. **The finding, with the bar attached.** The bar travels with the finding permanently, so a
   later reader can see what *enough* meant at the time rather than what it means to them now.
   (`BAR-TRAVELS`.)
2. **The raw sources as fetched.** Not summaries (`KEEP-THE-RAW`). Storage is trivial and it is
   the only mechanism by which any reading is ever checkable.
3. **The search record**, including negative space: what was searched, what was consulted, and
   what was deliberately or accidentally not.

**`THREE-SILENCES`** `[owner-locked]` — Three outcomes that currently all present as *"looks
fine"* are separate facts and get separate names. Collapsing them is the main way reading
misleads without anyone lying:

| Outcome | Meaning | Weight |
|---|---|---|
| `CONTRARY` | evidence found against the position | real evidence |
| `SILENT` | named places searched, nothing there | **not** support; absence of publication |
| `UNREACHABLE` | blocked, paywalled, source does not exist, search failed | no information at all |

This mirrors P3's existing distinction between **Inconclusive** and **Failed to run** — a test
that answered nothing and a test that never ran are different facts. Reading needs the same
three-way split and currently has none.

**`SILENCE-NOT-SUPPORT`** `[DERIVED]` — `SILENT` may never be aggregated into a positive finding.
A joint resolved on `SILENT` alone is recorded as **Inconclusive**, per P3, and the queue slot is
freed.

---

## 4. Provenance, added now for the poke half

**`FOUND-OR-PROVOKED`** `[owner-locked]` — Every evidence item carries how it came to exist:

- `FOUND` — it was already there; we observed it
- `PROVOKED` — it exists because we did something; we caused it

Today every item is `FOUND`. The field is added anyway. Provenance is never retrofitted
successfully — the intention survives, the backfill does not, and the result is a year of records
with an empty column and no way to reconstruct it.

This is a refinement of `EVIDENCE-BY-SOURCE`, not a replacement: source type (`EXT`/`INT`/`ASSERT`)
and provocation are orthogonal axes, and per the vision's amendment neither one *is* reliability.

---

## 5. Storage

**`FILES-ARE-CANON`** — Markdown in git is the authoritative copy: fetched sources, findings,
bars, search records. SmartMemory receives a derived index for retrieval, **import-only, one
direction, never written back**.

**`SPLIT-BY-PROVENANCE`** `[DERIVED]` — The two-writer anti-pattern was removed twice in the
2026-07-20 session and this is precisely where it re-enters, because the tempting move is to let
the graph enrich the record. The split is by *who authored it*:

| Lives in files (authored) | Lives in the graph (computed) |
|---|---|
| fetched sources, findings, bars, search records, stamps | staleness, source reliability history, calibration, decay |

Neither half overwrites the other's. Note this is a **proposal consistent with the open storage
direction**, not a closed decision — see the vision's open items on OKF round-tripping.

---

## 6. The Wanderer's kill criterion

**`WANDERER-KILL`** `[owner-locked]` — Written before the machine exists, per `KILL-CRITERIA-FIRST`.
Nothing gets killed after it exists.

- **Single success measure:** has it ever produced a joint or candidate the owner had not asked
  for and agreed was worth having? Not volume, not a self-assigned relevance score.
- **Adjudicator:** the owner. The agent may not score this — same rule the manual applies to
  `joint-is-non-obvious`, for the same reason (`calibrate: self-grading-ran-generous`).
- **Bar:** twenty runs or six weeks, whichever comes first.
- **Failure action: kill, not tune.** *"Adjust the prompt and try again"* is the mechanism by
  which useless machinery survives indefinitely.

This makes the Wanderer itself a `CONSTRUCT` resolution of `candidates-generatable`, with a
criterion stated in advance — which is the standard the manual's own honesty table demands.

---

## 7. The reading ceiling — what this can never do

**`READING-CEILING`** `[owner-locked]` — Stated explicitly so it is not later misremembered as
covered. Reading the public web cannot reach these joints **at any level of quality**:

| Joint | Why unreachable by reading |
|---|---|
| `already-knew` | Nobody publishes an honest account of building something they knew was unfounded. What is publishable is a tidy retrospective — which is worse than silence, because it is confidently wrong in a consistent direction. |
| `joint-is-non-obvious` | Requires a person, in a conversation, confirming at the time that a surfaced joint was new to them. There is no artifact of this anywhere in the world. |

Both remain open in the register, marked `EXT-UNREACHABLE`, waiting on the poke half. Neither may
be resolved by proxy. `already-knew` is the deepest premise in the whole stack
(`KNOWN-OR-UNEXAMINED`), and the read half — the entirety of what is reachable today — cannot
touch it.

**`differentiated`**, the joint currently `UNDER TEST`, *is* reachable, but only after
`SHARPEN-FIRST` converts it. In its present wording it is not an `EXT` question at all.

---

## 8. Amendments this makes to the process manual

Recorded here rather than silently edited into the manual, so the provenance of each change is
visible.

| Manual location | Amendment |
|---|---|
| P2 step 3 (`EXT` tagging) | A joint may not be tagged `EXT` until it passes `SHARPEN-FIRST`, or is explicitly accepted as `BAR-OR-JUDGMENT`. |
| P3, `EXT` row | Return a `PACKAGE-NOT-ANSWER`, not a finding. Record the `THREE-SILENCES` outcome explicitly. |
| P3, Outcomes | A joint resolved on `SILENT` alone is **Inconclusive**, never Resolved. |
| §"Explicitly not in manual mode" | World ingestion remains out of manual mode. The Answerer, however, is manual-runnable today for a single sharpened joint, and running it once by hand is the cheapest available test of `external-reachable`. |

---

## 9. Open

- **`external-reachable` is not closed by this document.** This is a design for acquisition; the
  joint asks whether acquisition yields *useful quality*. It closes by running the Answerer once
  against a sharpened `differentiated`, not by specifying it.
- **The poke half is undesigned.** It carries the questions this cannot reach, and it is the half
  that requires the owner to expose something publicly. That is a decision, not a build.
- **Wanderer source selection is unspecified.** Deliberately. Choosing sources before the wall and
  the kill criterion exist is how a feed reader gets built by accident (`SIGNAL-NOT-IDEAS`).

## Provenance

Designed 2026-07-20 in conversation. The `TWO-MACHINES` split originated as a resolution to a
collision between two previously settled claims (§1b). §2a records a framing the agent got wrong
(*"the reader is biased"*) and the owner's correction (*"isn't it doing a purely factual
analysis?"*), which produced the actual defect and therefore the actual fix — logged in the
ledger as `correct: not-bias-but-threshold`.
