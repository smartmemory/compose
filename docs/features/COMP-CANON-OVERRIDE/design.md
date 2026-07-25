# COMP-CANON-OVERRIDE: The Canon Override — grant-then-write, ledger-first

**Status:** DESIGN
**Date:** 2026-07-25
**Was:** COMP-CANON-GUARD Decision 4 — specified in the epic, explicitly deferred at S4, never built

## Related Documents

- [COMP-CANON-GUARD design](../COMP-CANON-GUARD/design.md) — Decision 4 specifies this protocol; §170 states the honest limits it inherits
- [COMP-CANON-GUARD S1–S4 blueprint](../COMP-CANON-GUARD/blueprint-s1-s4.md) — lists this under *"Explicitly deferred (NOT built here)"*
- [COMP-CANON-ATTEST design](../COMP-CANON-ATTEST/design.md) — `depends_on` this feature; needs it as the reconcile path for a chain break

---

## Problem

The guard denies direct writes to registered canon and tells the caller which tool to use instead. There is deliberately no way to say "I know, do it anyway."

That is correct as a default and untenable as an absolute. Three situations need a governed escape:

1. **A registered path has no tool for a legal mutation.** The guard's own lockout invariant exists because of this — an unregistered path is never blocked precisely so a missing tool cannot wedge the workspace. A registered path with a missing operation has no such protection.
2. **Reconciling attested drift.** COMP-CANON-ATTEST refuses a write when a record changed out of band. Without a recovery path that refusal converts a detectable tamper into a wedged workspace, which is worse than the tamper.
3. **Genuine one-off repair** — a malformed record no tool can parse, therefore no tool can fix.

Today the shipped hook's denial message points at a door that was never built:

> *"To override deliberately, use the canon override path (not yet available this slice — remove the path from the registry hook set if you truly must hand-edit)."*

The stated workaround is to **edit the registry and reinstall the guard**. That is strictly worse than a governed override: it is unlogged, it is not path-scoped, it is not single-use, and it leaves the guard weakened until someone remembers to put the entry back.

## Goal

Make the override exist, and make it cost something visible. Per Decision 4: *"The override must cost something visible or it becomes the default path."*

**Non-goal.** Making the override a general permission system. Single-use and path-scoped are load-bearing; a session-wide or time-boxed grant decays into "turn the guard off."

---

## Protocol (from Decision 4, unchanged)

1. `canon_override_grant({ path, reason, operation })` — MCP tool. Rejects an empty or whitespace `reason`. `operation` is a caller-declared intent label, recorded for later analysis and **not** verified against the write, because nothing can verify it.
2. **Append the `bypass`-tagged ledger entry FIRST**, then mint a grant token: single-use, scoped to one exact path, short TTL.
3. The hook looks for a live token matching the exact path; if found it **consumes** it and allows the write. Matching is path-only, consistent with the hook's actual inputs.
4. If the write then fails, a bypass entry exists for a write that never happened.

**Ledger-first is the atomicity answer.** The failure mode is over-recording, never under-recording. A token cannot exist without its ledger entry.

---

## Decision 1: which ledger? — a separate one, and this is the important call

Decision 4 says "the ledger" without saying which. The answer is **not** the judgment ledger, for two independent reasons.

**It is a category error.** `docs/judgment/records/ledger.jsonl` is the judgment layer's record of judgment decisions — positions, joints, goals, kills. A canon-guard bypass is a governance event about the *writing machinery*, not a judgment about the product. Conflating them pollutes the judgment corpus with infrastructure noise and makes the judgment projections answer a question nobody asked.

**It is circular, and provably so.** COMP-CANON-ATTEST's gate established that a ledger-first authorization cannot recover ledger drift: writing the authorization into `ledger.jsonl` mutates the very file whose chain is broken, so the authorizing act is itself a chain break. Since reconciling attested drift is reason #2 for this feature existing, routing its authorization through the attested set defeats the primary use case.

**Decision: `.compose/canon-overrides.jsonl`, append-only, git-tracked, outside the attested set.**

The location follows an established precedent in this repo rather than inventing one:

| State | Location | Tracked? | Why |
|---|---|---|---|
| Attestation manifest | `.compose/judgment-attest.json` | **yes** | S5 relocated it here so it is durable and reviewable, and out of the guarded tree |
| **Bypass ledger (new)** | `.compose/canon-overrides.jsonl` | **yes** | `OVERRIDES-ARE-GOLD` — a bypass that vanishes on a fresh clone is not an audit trail |
| **Live grant tokens (new)** | `.compose/data/canon-grants.json` | **no** | `.gitignore:3` ignores `data/`. Ephemeral, machine-local, short TTL |

The split is the point. **A committed live token would be a shared bypass** — anyone cloning the repo inherits a valid grant. Tokens must be un-committable by construction, which `.compose/data/` gives for free. The ledger has the opposite requirement: it must survive, and it must show up in review.

## Decision 2: how does the hook consume a token?

The hook is a **separate process** from the MCP server that mints, so the grant cannot live in memory. It is a file, and consumption must be atomic against concurrent hook invocations — two parallel `Write` calls to the same path must not both consume one token.

**The first draft got the primitive wrong** (gate round 1, finding 1). It proposed one JSON grant store written with temp-write-plus-rename, citing `initManifestExclusive` as precedent. That conflates *atomic publication* with *mutual exclusion*: rename makes each writer's result appear atomically, but two hooks can still read the same token, each remove it from its own in-memory snapshot, and each rename successfully — both return `true` and both writes are allowed. `initManifestExclusive` is safe only because it is a one-time exclusive **create**, never a shared read-modify-write. A `wx` lock is not a drop-in fix either, because Decision 3 fails open, so throwing on contention would *allow* the competing write.

**Decision: one file per token, claimed by atomic `rename`.**

```
.compose/data/canon-grants/<token-id>.json      ← minted here
.compose/data/canon-grants/consumed/<token-id>.json  ← claimed by rename
```

`rename` is the claim. Exactly one caller can rename a given path; every loser gets `ENOENT` and denies. The filesystem operation *is* the mutual exclusion, with no read-modify-write window to race in. Minting is likewise a per-file exclusive create, so mint and consume are both serialized without a shared store.

This also makes expiry trivial (stat the file, compare mtime) and makes the consumed-token record a natural artifact rather than a separate bookkeeping concern.

### Purity: the classification stays pure, the claim does not

The first draft also claimed injecting `consumeGrant` would keep `decideCanonGuard` pure. It would not — a destructive callback makes the function mutate shared state and return a different answer on a second evaluation, contradicting this design's own acceptance criterion (gate round 1, finding 4).

**Decision: split the two.** `decideCanonGuard` stays pure and answers *"does this path require a grant?"* — classification and deny-message construction, no I/O. The **wrapper** performs the atomic claim and selects the final decision. Purity is preserved where it is testable and valuable, and the effect lives in the layer that already owns I/O.

## Decision 2b: the bypass ledger needs protecting, not just tracking

Gate round 1, finding 2: **"git-tracked" is not an audit trail.** Verified — nothing under `.compose/` appears in `lib/canon-registry.js` at all, and the pre-push hook runs only `guard verify`, which covers judgment canon. So as first designed:

- the same Claude runtime that is denied a canon write can freely rewrite or delete `.compose/canon-overrides.jsonl`, because no registry entry guards it;
- the bypassed canon change can be committed **without** its ledger row, since ship staging does not include the file;
- a fresh clone then shows the canon edit with no record of the bypass.

An audit trail the audited party can edit is not one. Fixes, in order of cost:

1. **Register the ledger in the canon registry at the `hook` point**, with `canon_override_grant` as its only authorized writer. Raw `Write`/`Edit` to it is then denied by the same mechanism it exists to record. No circularity: the tool is the writer, and the tool is not itself hook-guarded.
2. **Integrity-check it as an append-only file** — `{length, prefix_hash}`, the identical primitive COMP-CANON-ATTEST needs for `ledger.jsonl`. Build it once, share it. A rewrite or in-place edit of an earlier row is then detectable; a legitimate append is not.
3. **Add it to ship staging** so a bypassed write cannot be committed while its row is left behind.

### Round 2: governance paths must not be grant-eligible, and the token directory is governance state too

Registering the ledger at the `hook` point while making *every* hook-registered path grant-eligible makes the ledger **recursively overrideable**: the agent grants an override for `.compose/canon-overrides.jsonl` itself, then rewrites it through a raw `Write`. `matchEntry` has no override-eligibility concept, so "registered at hook" and "grantable" are currently the same set.

**Fix: an explicit `overrideEligible: false` class in the registry** for governance state, checked separately from `matchEntry`. Governance paths are guarded *and* ungrantable.

The same reasoning extends to the tokens. `.compose/data/canon-grants/` is not registered at all, and the classifier allows every path with no hook entry (`canon-guard.js:121`) — so the runtime can simply `Write` a correctly shaped token and consume it, with no ledger row at all. That directly breaks the load-bearing claim that *a token cannot exist without its ledger entry*. **The grant directory joins the governance class: hook-registered, `overrideEligible: false`.**

### Root of trust for the append-only check

`{length, prefix_hash}` is meaningless without a previously trusted pair held **outside** the file it describes, plus a named verifier. The round-1 text specified neither. Filling both, following the `judgment-attest.json` precedent exactly:

- **Baseline:** `.compose/canon-overrides-attest.json` — `{length, prefix_hash}` for the bypass ledger. Tracked, governance class, `overrideEligible: false`.
- **Evolution:** the override tool updates the baseline in the same operation that appends the row, before minting the token. Ledger-first becomes ledger-and-baseline-first.
- **Enforcement:** `compose guard verify` checks it, and the pre-push gate calls it. Today that gate runs `guard verify` for judgment canon only (`pre-push.template:77`), so this is a real change to both, not a claim that existing machinery already covers it.

**Deliberately NOT claimed in v1: commit-coupling.** Guaranteeing that the ledger row travels *in the same commit* as the bypassed write needs commit-range verification, which is the same machinery COMP-CANON-GUARD's honest limits already flag as unbuilt (*"a committed bypass is invisible to a dirty-tree check"*). Items 1–3 stop the ledger being forged or silently dropped; they do not prove row and write shipped together. **State that residual rather than overclaiming durability.**

## Decision 3: what happens when grant lookup fails?

The hook's stated policy is **fail open** — *"a guard that wedges the session is worse than one that misses."* That policy has a sharp edge here: if reading the grant file throws, failing open allows a write to guarded canon with no token and no ledger entry.

**Proposed: keep fail-open, and state it as an honest limit rather than quietly relying on it.** Reversing it for this one path would make a corrupt local JSON file wedge every canon write in the workspace, which is exactly the failure the policy exists to prevent. The mitigation is that the ship-time and pre-push scans are runtime-independent and still see the resulting drift.

---

## The in-workspace ceiling — read this before trusting any of the above

Round 2 produced three High findings that look like separate holes and are one hole seen three times: **governance state protected by the runtime it governs is not protected.** Each fix moves the problem up a level rather than closing it.

- Protect the ledger → who protects the grant directory?
- Protect the grant directory → who protects the `overrideEligible: false` exclusion?
- Integrity-check the ledger against a baseline → who protects the baseline?

Every answer lives in the workspace, and `Bash` writes the workspace without touching the hook at all. `sed -i` on a token, a ledger row, and an attest baseline, all mutually consistent, defeats the whole structure. Cryptographic binding does not rescue it either: the hook and the agent share a trust domain, so any key the hook can read the agent can read.

**This is the same ceiling S5 already named and accepted** — *"a deliberate actor who recomputes the manifest passes. In-workspace ceiling; an out-of-workspace anchor would be the real fix."* This feature does not clear it and cannot.

**So the override must be positioned exactly as S5 positioned itself: audit and careless-drift tooling, not enforcement against a determined actor.** The `overrideEligible: false` class, the token/ledger registration and the attest baseline are all still worth building — they make the cooperative path logged and the accidental path hard, which is the realistic failure mode (the historical failure was silent hand-editing, not forgery). But the claim "a token cannot exist without its ledger entry" holds **only against the Claude `Write`/`Edit` route**, and must be written that way everywhere it appears.

Naming, help text and acceptance criteria must not say enforcement. Anything stronger needs an out-of-workspace anchor — a trust domain the agent cannot write — which remains out of scope here and is the only thing that would actually change the answer.

## Honest limits (inherited and new)

- **The override is self-service for the agent, and this is the thing most likely to be misread.** Nothing in Decision 4's protocol requires owner approval. An agent that hits a denial can call `canon_override_grant` itself, supply its own `reason`, and proceed. **The guard therefore changes from "agent cannot write canon" to "agent cannot write canon *unloggedly*."** That is a real and defensible property — `OVERRIDES-ARE-GOLD` is about visibility, and the historical failure was silent hand-editing, not malice. But anyone who reads "override" as "requires the owner" will overestimate the guarantee. State it in the tool description, not just here.

  A gated variant (grant requires an owner confirmation) is **not** proposed for v1: the MCP surface has no owner-proof mechanism, which is exactly why OQ1 resolved the writer to agent-only in the first place. Building one here would repeat a question the epic already deferred for lack of owner-write traffic to design against.

- **Consequence for COMP-CANON-ATTEST: a bare grant must not be sufficient to re-attest.** If ATTEST accepts "an override was granted" as authorization to re-stamp a drifted record, the agent can launder tampered content in two steps — grant, then re-attest — and the chain break this whole line of work exists to make permanent becomes erasable again. The grant may authorize *writing the file*; re-attestation has to remain its own deliberate operation with its own record. Flagged into ATTEST's Decision 2 rather than left implicit here.

- **Claude-runtime only.** The hook installs under `.claude/hooks` and intercepts Claude's `Write`/`Edit`. Compose also dispatches **Codex**, a separate CLI a Claude `PreToolUse` hook cannot touch. The override governs Claude writes; it is not a filesystem ACL. Runtime-scoped or the guarantee is false on arrival.
- **`Bash`-shaped writes bypass the hook entirely** — `sed -i`, heredocs, `git checkout`. They neither need nor consume a grant.
- **`operation` is unverifiable.** It is a declared label, useful for analysis, worthless as enforcement. Say so in the tool description so nobody later mistakes it for a constraint.
- **A grant records intent, not outcome.** If the write fails after the grant is consumed, the ledger over-records. This is deliberate — over-recording is the safe direction.
- **Fail-open on grant-read error** (Decision 3).
- **No commit-coupling in v1** (Decision 2b). The ledger cannot be forged or silently dropped, but nothing proves a bypass row shipped in the same commit as the write it authorizes. Closing that needs the durable commit-range baseline COMP-CANON-GUARD already lists as unbuilt.

---

## The payoff beyond unblocking ATTEST

Decision 4's last line is the part worth building for: *"the bypass log becomes the specification for v2 — bypasses concentrated on one path are a missing tool operation, stated in evidence rather than argued."*

This is the same move that made the guard epic's phase-1 forensics useful. COMP-CANON-INVENTORY currently has to *reason* about which canon paths lack a typed operation. A populated bypass ledger tells it, with counts. **The override is the instrument that turns INVENTORY from an argument into a measurement.** Worth noting in that feature's row once this ships.

---

## Acceptance criteria

- [ ] `canon_override_grant` rejects an empty or whitespace-only `reason`
- [ ] The ledger entry is appended **before** the token is minted — verified by a fault-injection test that fails the mint and asserts the entry exists
- [ ] A token is single-use: the second `Write` to the same path is denied
- [ ] A token is path-scoped: a grant for path A does not permit a write to path B
- [ ] A token expires: a write after TTL is denied and the expired token is not consumable
- [ ] Concurrent hook invocations cannot both consume one token (atomic consumption)
- [ ] TTL uses an **immutable `issued_at` / `expires_at` recorded inside the token**, never file mtime. A checkout gives a file a fresh mtime, so an mtime clock would let a mistakenly committed token become live again on clone
- [ ] Verification **rejects a tracked live-token path** — gitignored is not un-committable (`git add -f` exists, and a previously tracked path stays tracked), so the property has to be checked, not assumed
- [ ] The bypass row schema is defined, and `actor` is stamped by the tool per Decision 3, never caller-supplied — carried over from Decision 4 and dropped by the first draft of this design
- [ ] `.compose/canon-overrides.jsonl` is tracked and append-only; no code path rewrites or truncates it
- [ ] Grant eligibility uses `matchEntry(path, { point: 'hook' })`, **not** mere registration. The registry partitions by enforcement point — today `hook: ['judgment']` and `ship: ['roadmap', 'changelog', 'feature-json']` — so a grant for `ROADMAP.md`, `CHANGELOG.md`, or `feature.json` is meaningless (the hook already allows them) and its ledger row would be actively misleading. Covered by a registered-but-not-hook-enforced rejection test, distinct from the unregistered-path rejection test
- [ ] A grant-read error fails open, and the fail-open path is covered by a test that asserts the write proceeds
- [ ] The shipped hook's denial message is updated to name the real override path instead of telling the reader to edit the registry
- [ ] `decideCanonGuard` remains pure and side-effect-free: evaluating it twice returns the same answer and consumes nothing. The atomic claim lives in the wrapper
- [ ] The bypass ledger is hook-registered, so a raw `Write` to `.compose/canon-overrides.jsonl` is denied
- [ ] Governance paths (bypass ledger, its attest baseline, the grant directory) are `overrideEligible: false` — a grant **for** them is rejected, so the ledger cannot authorize rewriting itself
- [ ] A hand-written token file in `.compose/data/canon-grants/` with no corresponding ledger row is not consumable
- [ ] An in-place edit of an earlier ledger row is detected by the append-only integrity check; a legitimate append is not
- [ ] Two concurrent consumers of one token: exactly one write is allowed and one is denied (the `rename` claim, tested with real concurrency rather than a mocked lock)

## Open questions

1. **TTL value.** "Short" is unspecified. Long enough to survive a grant-then-write round trip through the agent, short enough that a forgotten grant is not a standing hole. 60s? 5min?
2. **Does a consumed grant get a second ledger entry** recording the consumption, or is the mint entry sufficient? A consumption entry would close the "grant recorded, write never happened" ambiguity in limit #4, at the cost of two writes per override.
3. Does `canon_override_grant` need to be reachable from the CLI (`compose guard override …`) as well as MCP, for the human-in-an-editor case? Decision 4 specifies the MCP tool only.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/canon-override.js` | new | Grant lifecycle: mint (exclusive create), claim (atomic `rename`), expire, eligibility via `matchEntry(…, {point:'hook'})`. Ledger append |
| `lib/canon-guard.js` | modify | `decideCanonGuard` gains a *pure* "requires a grant" classification; denial message updated. No consumption here |
| `.claude/hooks/canon-guard.mjs` | modify | Perform the atomic claim and select the final decision |
| `lib/canon-registry.js` | modify | Register `.compose/canon-overrides.jsonl` at the `hook` point, writer = `canon_override_grant` |
| `lib/append-integrity.js` | new | `{length, prefix_hash}` for append-only files — shared with COMP-CANON-ATTEST's `ledger.jsonl` handling |
| `lib/build.js` | modify | Ship staging includes the bypass ledger |
| `server/compose-mcp.js` | modify | Declare + dispatch `canon_override_grant` |
| `.gitignore` | verify | Confirm `.compose/data/` covers the grant file; add an explicit rule if the current `data/` rule is too broad to rely on |
| `test/canon-override.test.js` | new | The criteria above, including fault injection and the concurrency case |

---

## Gate round 1 — Codex `sol/xhigh`, 2026-07-25

Four findings, all confirmed against the code and folded above.

| # | Finding | Verdict | Where folded |
|---|---|---|---|
| 1 | **[High]** Temp-write-plus-rename is atomic *publication*, not mutual exclusion — two hooks can read the same token, each drop it from its own snapshot, and both succeed. `initManifestExclusive` is safe only as a one-time exclusive create | **CONFIRMED** — the design conflated two different guarantees | Decision 2 rewritten: one file per token, claimed by atomic `rename` |
| 2 | **[High]** "Git-tracked" does not protect the bypass ledger: not in the registry, not in ship staging, pre-push covers only judgment canon — so the audited runtime can rewrite it or commit the write without its row | **CONFIRMED** — zero `.compose/` entries in `canon-registry.js`; pre-push runs `guard verify` only | New Decision 2b; commit-coupling explicitly *not* claimed |
| 3 | **[Medium]** Eligibility must use the registry's enforcement-point partition, not mere registration — `hook: ['judgment']` vs `ship: [...]`, so a grant for `ROADMAP.md` is meaningless | **CONFIRMED** — matches the partition probed directly | Criterion rewritten around `matchEntry(…, {point:'hook'})` |
| 4 | **[Medium]** An injected destructive `consumeGrant` does not preserve purity; it contradicts this design's own purity criterion | **CONFIRMED** | Decision 2: pure classification in the core, claim in the wrapper |

One further error was caught by self-review before this gate and is recorded in place above: the omission of the override's self-service property, and its consequence for COMP-CANON-ATTEST (a bare grant must not authorize re-attestation).

**Gate status: round 1 folded.** All four findings had concrete fixes and none reopened a scope question.

## Gate round 2 — Codex `sol/xhigh`, 2026-07-25

Round-1 verification: the rename-claim fix **holds**, the purity split **holds**, the enforcement-point partition **holds** for excluding ship-only paths but newly made the ledger recursively grantable, and the ledger-durability fix **does not yet hold**.

| # | Finding | Verdict | Where folded |
|---|---|---|---|
| 1 | **[High]** Tokens are unregistered ordinary files; the classifier allows any path with no hook entry (`canon-guard.js:121`), so the runtime can write a token and consume it with no ledger row — breaking "a token cannot exist without its ledger entry" | **CONFIRMED** | Grant directory joins the governance class; ceiling section |
| 2 | **[High]** The ledger can grant an override for itself — `matchEntry` has no override-eligibility concept, so hook-registered and grantable are the same set | **CONFIRMED** | `overrideEligible: false` governance class |
| 3 | **[High]** `{length, prefix_hash}` has no named root of trust and no enforcement point; pre-push checks judgment canon only | **CONFIRMED** — a real spec gap, not a ceiling issue | Baseline at `.compose/canon-overrides-attest.json`, evolution protocol, `guard verify` + pre-push changes named |
| 4 | **[Medium]** Gitignored ≠ un-committable, and mtime TTL revives a committed token on clone; one criterion still named the abandoned singular grant file | **CONFIRMED** | Immutable `issued_at`/`expires_at`; tracked-token rejection; criterion corrected |
| 5 | **[Medium]** Decision 4 requires writer-stamped `actor` provenance; this design dropped it | **CONFIRMED** | Row schema + `actor` criterion restored |

**Gate status: NOT CLEAN, and the reason is structural rather than a missing patch.** Findings 1–3 are one problem seen three times — governance state protected by the runtime it governs. Each fix relocates it upward. See *The in-workspace ceiling*: the fixes are worth building, but the guarantee they support is Claude-runtime-scoped, and no further round of patching changes that. **This needs a scope decision, not a round 3.**
