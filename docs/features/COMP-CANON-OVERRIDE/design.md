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

`lib/canon-guard.js` keeps its pure/tested core; `decideCanonGuard` already takes an injected `canonicalize`. **Proposed: inject a `consumeGrant(path) → boolean` the same way**, so the decision function stays pure and the wrapper owns the I/O. Same shape as the existing seam, no new architectural idea.

Atomicity primitive: the same one `initManifestExclusive` already relies on — an exclusive create (`wx`) or a temp-write-plus-rename, where the *filesystem operation itself* is the mutual exclusion rather than a check that a race can slip past.

## Decision 3: what happens when grant lookup fails?

The hook's stated policy is **fail open** — *"a guard that wedges the session is worse than one that misses."* That policy has a sharp edge here: if reading the grant file throws, failing open allows a write to guarded canon with no token and no ledger entry.

**Proposed: keep fail-open, and state it as an honest limit rather than quietly relying on it.** Reversing it for this one path would make a corrupt local JSON file wedge every canon write in the workspace, which is exactly the failure the policy exists to prevent. The mitigation is that the ship-time and pre-push scans are runtime-independent and still see the resulting drift.

---

## Honest limits (inherited and new)

- **The override is self-service for the agent, and this is the thing most likely to be misread.** Nothing in Decision 4's protocol requires owner approval. An agent that hits a denial can call `canon_override_grant` itself, supply its own `reason`, and proceed. **The guard therefore changes from "agent cannot write canon" to "agent cannot write canon *unloggedly*."** That is a real and defensible property — `OVERRIDES-ARE-GOLD` is about visibility, and the historical failure was silent hand-editing, not malice. But anyone who reads "override" as "requires the owner" will overestimate the guarantee. State it in the tool description, not just here.

  A gated variant (grant requires an owner confirmation) is **not** proposed for v1: the MCP surface has no owner-proof mechanism, which is exactly why OQ1 resolved the writer to agent-only in the first place. Building one here would repeat a question the epic already deferred for lack of owner-write traffic to design against.

- **Consequence for COMP-CANON-ATTEST: a bare grant must not be sufficient to re-attest.** If ATTEST accepts "an override was granted" as authorization to re-stamp a drifted record, the agent can launder tampered content in two steps — grant, then re-attest — and the chain break this whole line of work exists to make permanent becomes erasable again. The grant may authorize *writing the file*; re-attestation has to remain its own deliberate operation with its own record. Flagged into ATTEST's Decision 2 rather than left implicit here.

- **Claude-runtime only.** The hook installs under `.claude/hooks` and intercepts Claude's `Write`/`Edit`. Compose also dispatches **Codex**, a separate CLI a Claude `PreToolUse` hook cannot touch. The override governs Claude writes; it is not a filesystem ACL. Runtime-scoped or the guarantee is false on arrival.
- **`Bash`-shaped writes bypass the hook entirely** — `sed -i`, heredocs, `git checkout`. They neither need nor consume a grant.
- **`operation` is unverifiable.** It is a declared label, useful for analysis, worthless as enforcement. Say so in the tool description so nobody later mistakes it for a constraint.
- **A grant records intent, not outcome.** If the write fails after the grant is consumed, the ledger over-records. This is deliberate — over-recording is the safe direction.
- **Fail-open on grant-read error** (Decision 3).

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
- [ ] Live tokens are un-committable — `.compose/data/canon-grants.json` is gitignored; a test asserts `git check-ignore` succeeds for it
- [ ] `.compose/canon-overrides.jsonl` is tracked and append-only; no code path rewrites or truncates it
- [ ] Granting for an **unregistered** path is rejected — the lockout invariant means such a path is never blocked, so a grant for it is meaningless and its ledger entry would be misleading
- [ ] A grant-read error fails open, and the fail-open path is covered by a test that asserts the write proceeds
- [ ] The shipped hook's denial message is updated to name the real override path instead of telling the reader to edit the registry
- [ ] `decideCanonGuard` remains pure — grant consumption is injected, not imported

## Open questions

1. **TTL value.** "Short" is unspecified. Long enough to survive a grant-then-write round trip through the agent, short enough that a forgotten grant is not a standing hole. 60s? 5min?
2. **Does a consumed grant get a second ledger entry** recording the consumption, or is the mint entry sufficient? A consumption entry would close the "grant recorded, write never happened" ambiguity in limit #4, at the cost of two writes per override.
3. Does `canon_override_grant` need to be reachable from the CLI (`compose guard override …`) as well as MCP, for the human-in-an-editor case? Decision 4 specifies the MCP tool only.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/canon-override.js` | new | Pure grant lifecycle: mint, validate, consume, expire. Ledger append. No I/O policy decisions |
| `lib/canon-guard.js` | modify | `decideCanonGuard` accepts an injected `consumeGrant`; allow-with-consume branch before the deny branch; update the denial message |
| `.claude/hooks/canon-guard.mjs` | modify | Wire the real `consumeGrant` I/O into the injected seam |
| `server/compose-mcp.js` | modify | Declare + dispatch `canon_override_grant` |
| `.gitignore` | verify | Confirm `.compose/data/` covers the grant file; add an explicit rule if the current `data/` rule is too broad to rely on |
| `test/canon-override.test.js` | new | The criteria above, including fault injection and the concurrency case |
