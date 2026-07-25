# COMP-CANON-ATTEST: Content Attestation for Judgment Canon — Design

**Status:** DESIGN
**Date:** 2026-07-25
**Was:** COMP-CANON-GUARD S6, carved out at epic close (2026-07-25)

## Related Documents

- [COMP-CANON-GUARD design](../COMP-CANON-GUARD/design.md) — the parent epic; S6 row and the Scope Verdict
- [COMP-CANON-GUARD S5 design](../COMP-CANON-GUARD/design-s5.md) — the honest reframe, tier table, and the residual this feature closes
- [S5 mutation topology](../COMP-CANON-GUARD/s5-mutation-topology.md) — Task 0 findings: the write chokepoint, STAMP_SITES, LOCK
- [COMP-JUDGMENT-WRITER design](../COMP-JUDGMENT-WRITER/design.md) — the writer whose durability boundaries do the stamping

---

## Problem

S5 shipped a record manifest: `.compose/judgment-attest.json`, a flat `{relPath: sha256}` snapshot. `verifyRecords` recomputes each record's hash and compares. That catches a careless edit — a `sed`, a Codex write, a Bash heredoc — because the editor does not also update the manifest.

It does not catch the same edit when a legitimate tool write lands on the same record afterwards. `stampRecord` overwrites `hashes[relPath]` with the post-write hash and never looks at what was there before, so the authorised amend blesses whatever the editor left behind.

**This is reproduced, not argued.** Against the real `lib/judgment-attest.js`:

```
1. baseline           -> GREEN
2. after hand-edit    -> DRIFT [{"path":".../probe.json","kind":"modified"}]
3. after tool amend   -> GREEN

record now claims : TAMPERED
LAUNDERED: verify is GREEN over content nobody authorised.
```

The tamper is visible for exactly as long as nobody touches the record through a tool. The next legitimate `judgment_position_amend` on that record erases the evidence permanently. Worse, the window is not a race: it can be hours, and the laundering op is performed in good faith by an agent that has no idea it is doing it.

S5's own design names this and defers it:

> **Interleaved edit-then-tool-amend of the same record** launders that record (the amend re-stamps it). S6 chain closes it.

## Goal

Make an out-of-band mutation of a judgment record permanently detectable, including after a subsequent authorised write to the same record.

**Non-goals.** Defeating a deliberate forger who edits the record *and* recomputes the attestation. That is an in-workspace ceiling and no in-workspace mechanism clears it — see *Honest limits*. This feature raises the cost and closes the accidental-laundering path, which is the realistic failure mode (the historical failure was 88% hand-written judgment canon, not adversarial forgery).

---

## Key finding: the preimage is already captured — for records, but not for intents or the ledger

The topology doc established that all forward record writes funnel through one orchestrator. Reading the code confirms it is tighter than the doc's "three orchestrators":

- `persistAggregate` (`judgment-writer.js:1291`) constructs an `UndoLog` and delegates straight to `commitWithProjections`.
- `publishIntentWith` and the `commitWithProjections` window are the other two entries, same shape.

So the single chokepoint is:

```js
function commitWithProjections(cwd, undo, mutate) {        // judgment-writer.js:234
  try {
    mutate();
    regenerateProjections(cwd);
    syncManifest(cwd, undo.touchedPaths());                //  <-- the blind stamp
  } catch (err) {
    undo.restore();
    ...
  }
}
```

And `UndoLog.capture` (`judgment-writer.js:206`) **already stores the exact preimage bytes** of every record before its first overwrite:

```js
this._entries.push({ path, prior: existsSync(path) ? readFileSync(path, 'utf8') : null });
```

That is the whole missing input. The prior hash S6 needs is `sha256(entry.prior)` — already in memory, at the exact site that does the stamping, under the judgment lock. `created()` pushes `prior: null`, which is the correct genesis marker.

This changes the cost estimate materially. For records, the chain check is a comparison at one site using data that is already there, not new plumbing across 13 call sites.

### But four stamp sites have no UndoLog

`syncManifest` is called at four places that never enter `commitWithProjections` and therefore capture no preimage:

| Site | Stamps | Preimage available? |
|---|---|---|
| `judgment-writer.js:311` | `ledger.jsonl` (intent refusal) | no |
| `judgment-writer.js:314` | `ledger.jsonl` + `intents/<id>.json` | no |
| `judgment-writer.js:2805` | `intents/<id>.json` (persist) | no |
| `judgment-writer.js:3194` | `intents/<id>.json` (replay persist) | no |

These are exactly as launderable as the record path, and the "preimage is free" finding does **not** cover them. They need an explicit read-and-hash immediately before the write, under the same lock. This is the part of the work that is genuinely new plumbing, and it is where the estimate should sit.

Note what these paths stamp: pending intents (created, overwritten on replay, deleted on publish) and `ledger.jsonl` (append-only, touched by nearly every op). Both are canonical per R4 — `intents/*.json` are records and `ledger.jsonl` is explicitly in the record set — so neither can be waved off.

### The check must run at capture time, not at stamp time

The first draft of this design put the comparison at the `syncManifest` call. **Gate round 1 established that this is too late in three separate ways** (findings 1, 2, 5 below). The check belongs at the moment a preimage is first observed, before any write:

- **Before the first write.** If the mutation or projection regen fails *before* a stamp-time check would have run, the existing `catch` calls `undo.restore()` and then `syncManifest` on the restored — tampered — bytes, permanently blessing them. Authenticating at capture makes the tamper impossible to carry into the error path.
- **Before an intent is applied.** `publishIntentWith` runs `applier()` (which mutates records) at `judgment-writer.js:870`, appends the attestation at `:892`, and only then calls `clearIntent` at `:900`. The intent file is captured by *neither* `UndoLog`. So a valid-JSON edit to a pending intent executes into records, gets attested into the ledger, and then deletes its own evidence. The intent's raw bytes must be verified against its manifest entry at the **top** of `publishIntentWith`, before dispatch, guard evaluation, refusal, or application.
- **Compensation must never sync an unauthenticated preimage.** This is the general form of the first point and applies to every `catch`-path `syncManifest` in the writer.

### The comparison

At capture time, for each observed path:

| Observed | Attested (`manifest[relPath]`) | Meaning |
|---|---|---|
| `sha256(prior)` | same | clean — the record is what we last attested |
| `prior === null` | absent | genesis — new record |
| `sha256(prior)` | **differs** | **the record changed out-of-band since our last write** |
| `prior === null` | present | record was deleted out-of-band, then recreated |

Row 3 is the launder, caught at the moment it would otherwise be erased.

---

## Approaches

### A. Full append-only chain log

Replace the flat map with a per-record append-only list of `{prior, op, post, at}`. Verify walks every link.

- **For:** complete forensic trail; answers "when did this diverge, and which op laundered it"; matches the S6 row's literal wording.
- **Against:** unbounded growth on a hot record (the ledger is appended constantly); needs a compaction story, which is itself a laundering lever; largest migration; verify cost grows with history.

### B. Prior-hash assertion, no stored chain

Keep `.attest.json` exactly as it is. Add the comparison at the stamp point and refuse the write when the observed prior does not match the attested hash.

- **For:** smallest correct change — one site, no format change, no migration; converts laundering into a hard error at the instant it would occur; a refusal is strictly more useful than a later report because the tool has not yet built on tampered content.
- **Against:** no audit trail; once refused, the operator needs a reconcile path, and that path is a laundering lever if it is careless.

### C. One-link chain (recommended)

Assert as in B, and widen the manifest value from a bare hash to `{hash, prior, op, at}` — one link back, not a log.

- **For:** delivers the `(prior_hash, op, post_hash)` triple the S6 row asked for; bounded size (one object per record, forever); mechanical migration (`{p: "abc"}` → `{p: {hash: "abc"}}`, prior absent = unknown); gives the refusal message something concrete to say ("last authorised write was `joint_add` at 14:02; the record has changed since").
- **Against:** one step of history only — a break tells you the last good op, not the full lineage.

**Recommendation: C.** B is the load-bearing half and C is B plus a bounded, cheap record of what B compared against. A's unbounded log buys forensics that the git history of `docs/judgment/**` already provides more reliably, since records are committed.

---

## Decisions to make at the gate

### Decision 1: refuse, or record and continue?

**Proposed: refuse, fail-closed.** Precedent is R4 — a malformed record already fails closed rather than silently passing. A chain break means the writer is about to build an amend on top of content nobody authorised; continuing bakes the tamper into the new record's content.

Because the check runs at capture time, the refusal happens **before** any mutation, so there is nothing to compensate and no restored-tampered-bytes hazard. That is the main reason for the placement.

**Error propagation (finding 5).** `commitWithProjections` wraps every caught error as `JUDGMENT_PARTIAL_WRITE` (`judgment-writer.js:243`), which would mask the chain break and make the acceptance criterion below untestable. `JUDGMENT_ATTEST_CHAIN_BREAK` must be special-cased and propagated unwrapped through compensation, not merely excluded from the catch-path stamp.

### Decision 1b: the manifest write must be atomic over the whole touched set

`syncManifest` loops over paths calling `stampRecord`, and each `stampRecord` does its own read-merge-write of the entire manifest (`judgment-attest.js:174`, `:224`). So a multi-record op that stamps path A and then fails on path B leaves A's postimage recorded in the manifest while compensation restores A's *pre*image on disk — a manifest that is internally inconsistent with the tree, which directly contradicts the no-half-written-chain criterion.

**Proposed:** check the complete touched set first, build all manifest changes in memory, and publish them with a single atomic write. `writeManifest` already does temp-write + rename, so this is a matter of calling it once rather than N times.

### Decision 2: what is the reconcile path? — REOPENED, the first answer was false

The first draft said: no new escape, revert with `git checkout` or re-attest through `canon_override_grant`, "already built in S4."

**That was wrong on the facts.** `canon_override_grant` does not exist. S4's blueprint lists it under *"Explicitly deferred (filed as follow-ups, NOT built here)"*, `grep` finds zero references anywhere in `lib/`, `server/`, or `bin/`, and the shipped hook's own denial message says the override path is *"not yet available this slice."* I asserted a load-bearing capability without checking it. Everything Decision 2 rested on is void.

The problem is also harder than the first draft assumed, in two ways the gate identified:

1. **`git checkout` is insufficient** when the last attested version was an uncommitted tool write. Reverting to HEAD then disagrees with the manifest, turning one break into another.
2. **Ledger-first authorization cannot recover a broken ledger.** Writing the authorization *into* `ledger.jsonl` mutates the very file whose chain is broken, so the act of authorizing is itself a chain break. The recovery protocol is circular for exactly the artifact most likely to need it.

**Proposed direction (needs a decision at the next gate):** the reconcile record must live **outside the attested set** — in `.compose/`, alongside the manifest, not in `docs/judgment/`. That breaks the circularity, at the cost of putting the authorization somewhere the hook does not guard. A bootstrap route for crash-stale manifests is needed regardless, since S5's accepted self-healing residual becomes a hard refusal under this feature.

What must NOT happen: a `guard verify --accept` that re-stamps on request. That is the laundering step R1 bans, wearing a flag.

**This is now the largest open risk in the feature, and it is a blocker, not a polish item.** A refusal mechanism with no sound recovery path is worse than no refusal — it converts a detectable tamper into a wedged workspace. Options: build a minimal governed reconcile inside this feature, or take a dependency on `canon_override_grant` being built first.

### Decision 3: how is `ledger.jsonl` attested?

Promoted from an open question once the four bare stamp sites surfaced — two of them stamp the ledger, so this is load-bearing, not incidental.

`ledger.jsonl` is append-only and rewritten by nearly every op. Whole-file hashing means its chain entry churns constantly, and a one-link chain over it degrades to "the last op changed it", which carries no signal.

**Proposed: attest append-only files by `{length, prefix_hash}`**, where `prefix_hash` is sha256 over bytes `[0, length)`. An append is clean iff the new file is at least as long **and** `sha256(new_bytes[0, old_length])` equals the stored `prefix_hash`. That is what actually proves the prefix is intact.

**Rejected: `{length, tail_hash}`** — this was the first proposal here and it does not work. Length plus a hash of the last N bytes says nothing about the prefix, so an in-place rewrite of an early line that preserves total byte length is entirely invisible. Demonstrated:

```
original  : {"length":162,"tail_hash":"c6417a826bf840c0"}
tampered  : {"length":162,"tail_hash":"c6417a826bf840c0"}   <- "park the other" -> "ship the other"
same length: true    same tail_hash: true
DETECTION FAILS

prefix_hash before: a5f6b4e1f6fb1ef1
prefix_hash after : c54252b34bd423f9              <- catches it
```

Editing a decision from `park` to `ship` in the judgment ledger while keeping the byte count is not an exotic attack; it is the shape a careless `sed -i 's/park/ship/'` takes. The tail-hash variant must not ship.

Cost: `prefix_hash` is O(prefix) per verify rather than O(1). For a ledger this is fine, and if it ever stops being fine the bounded upgrade is a per-line hash chain, not a return to tail hashing.

### Decision 4: does a chain break block unrelated records?

Proposed: **no.** The check is per-path over the touched set. An op touching a clean record proceeds even if some other record is broken. Anything else makes one careless edit a workspace-wide denial of service.

---

## Honest limits (state these in help text, per R1)

- **A deliberate forger still passes.** `.compose/judgment-attest.json` lives outside `docs/judgment/**`, so it is not even hook-guarded — an agent can write it directly. Editing a record and recomputing its chain entry defeats this. In-workspace ceiling; the real fix is an out-of-workspace anchor, still out of scope.
- **Crash-stale manifests become louder.** S5 accepted a residual: a hard crash between the record rename and the manifest write leaves the manifest one op stale, self-healing on the next successful op. Under this feature that stale entry produces a **refusal** rather than a self-healing false-positive. This is the main regression risk and needs an explicit test.
- **This is still drift detection, not enforcement**, for records. Only the projection tier is records-anchored enforcement. Naming and help text must keep saying so.

---

## Acceptance criteria

- [ ] The reproduction above fails at step 3: hand-edit then tool-amend raises `JUDGMENT_ATTEST_CHAIN_BREAK` instead of returning GREEN
- [ ] After that refusal, `verify` reports the record as drifted (the manifest was not updated through the error path)
- [ ] Genesis is clean: creating a brand-new record with no manifest entry is not a break
- [ ] Out-of-band delete then tool-recreate is detected
- [ ] Every legitimate judgment op (create/amend/joint/transition/pending-intent/publish/replay/person/situation/goal) leaves verify GREEN — no false break, the R3 topology test extended
- [ ] A chain break on record X does not block a legitimate op on record Y
- [ ] Compensation still works: a mid-op failure restores and does not leave a half-written chain
- [ ] A tampered **pending intent** is refused at the top of `publishIntentWith` — before `applier()` mutates any record, before the attestation append, and before `clearIntent` erases it
- [ ] A tamper captured before a mutation that then fails for an unrelated reason is **not** stamped by the compensation path
- [ ] A multi-record op that fails partway leaves the manifest and the tree agreeing (single atomic manifest publication)
- [ ] `JUDGMENT_ATTEST_CHAIN_BREAK` reaches the caller unwrapped, not masked as `JUDGMENT_PARTIAL_WRITE`
- [ ] A crash-stale manifest entry produces a refusal with a message naming the reconcile options, not a stack trace
- [ ] Migration: an existing flat `{path: hash}` manifest loads, verifies, and upgrades in place without a re-baseline
- [ ] `compose guard verify` help text still says drift detection, never enforcement
- [ ] The launder is closed on the intent and ledger paths too, not just records — an out-of-band edit to a pending intent followed by a replay-persist is detected
- [ ] An append to `ledger.jsonl` is clean; an in-place edit of an earlier ledger line is detected **even when it preserves total byte length** (the tail-hash trap above, as an explicit regression test)

## Open questions

1. **Op label granularity.** Is `op` the MCP tool name (`judgment_position_amend`), or the orchestrator (`commitWithProjections`)? Tool name is more useful in the refusal message but is not currently threaded down to the writer.
2. Does the importer cutover path (`bin/judgment-import.js`, one-time) need genesis entries written, or does `guard init` cover it?
3. The four bare stamp sites run under the judgment lock via `runOp`/replay — confirm during blueprint that *all four* do, since the read-and-hash is only sound if nothing can interleave between the read and the write.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/judgment-attest.js` | modify | Widen manifest value to `{hash, prior, op, at}`; `{length, prefix_hash}` for append-only files; migration-on-read from the flat form; `checkChain(cwd, observed)`; **atomic whole-set publication** replacing the per-path read-merge-write loop; keep `verifyRecords` shape |
| `lib/judgment-writer.js` | modify | `commitWithProjections` — derive observed priors from `undo._entries` (add an accessor; do not reach into the private field), check before stamping, skip the catch-path stamp on a chain break. Plus explicit read-and-hash at the four bare stamp sites (`:311`, `:314`, `:2805`, `:3194`) |
| `bin/compose.js` | modify | `guard verify` reporting for the new drift kind; help text |
| `test/canon-attest-chain.test.js` | new | The reproduction as a regression test, plus the criteria above |
| `test/judgment-writer.test.js` | modify | Extend the R3 all-ops topology test to assert no false breaks |

---

## Gate round 1 — Codex `sol/xhigh`, 2026-07-25

Five findings, all confirmed against the code and folded above. Two were verified independently before folding, since a review verdict is high-recall rather than precise:

| # | Finding | Verdict | Where folded |
|---|---|---|---|
| 1 | Pending-intent tampering executes before any check — `applier()` at `:870`, attestation at `:892`, `clearIntent` at `:900`, intent captured by neither `UndoLog` | **CONFIRMED** — ordering read directly | Check moves to top of `publishIntentWith` |
| 2 | Checking at the stamp point leaves an error-path launder: a failure before the check restores and stamps tampered bytes | **CONFIRMED** | Check moved to capture time |
| 3 | Per-path read-merge-write means a partial failure leaves manifest and tree disagreeing | **CONFIRMED** — `judgment-attest.js:174`, `:224` | New Decision 1b, atomic publication |
| 4 | `canon_override_grant` does not exist; the stated reconcile path is fiction, and ledger-first authorization is circular for ledger drift | **CONFIRMED — my error.** Zero grep hits; S4 blueprint lists it deferred; hook says "not yet available this slice" | Decision 2 reopened as a blocker |
| 5 | `JUDGMENT_ATTEST_CHAIN_BREAK` masked by the `JUDGMENT_PARTIAL_WRITE` wrapper at `:243` | **CONFIRMED** | Decision 1, error propagation |

Two further errors were caught by self-review before this gate ran and are recorded in place above: the claim that one chokepoint covers everything (four stamp sites have no `UndoLog`), and the `{length, tail_hash}` scheme for append-only files (demonstrated not to detect a length-preserving edit to an early line).

**Gate status: NOT CLEAN.** Decision 2 has no sound answer yet, and it is a blocker — a refusal mechanism without a recovery path converts a detectable tamper into a wedged workspace.
