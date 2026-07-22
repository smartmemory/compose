# COMP-CANON-GUARD — The Write-Guard for Canonical Artifacts (design)

**Status:** EPIC — **S0 SHIPPED 2026-07-22**; S1–S6 deliberately un-specced pending log data (see *Scope verdict*)
**Date:** 2026-07-22 (rev 6 — five Codex gate rounds, eleven confirmed P1s. **Gate NOT clean at the cap — see Scope verdict.** Same-day owner rulings folded in: OQ1 resolved v1-agent-only; S3 substrate = provider records; S2b retirement now reflected in the sequencing table. `LEDGER.md` session 3.)
**Implements:** `TOOLS-OWN-WRITES`, `BLOCK-THE-BYPASS`, `MARKDOWN-EMITTED` (partial)

## Related Documents

- **Claims this implements:** [What To Build — The Judgment Layer §8k](../../product/2026-07-20-what-to-build-vision.md) — `UNGUARDED-WRITES` (the evidence), `TOOLS-OWN-WRITES`, `BLOCK-THE-BYPASS`, `CANON-IS-GATED` (the limit), `STRUCTURE-NOT-TRUTH` (the honest ceiling), `OVERRIDES-ARE-GOLD` (the override), `PROVIDER-SEAM` (the substrate ruling).
- **Operational surface being guarded:** [Judgment Layer — Process Manual](../../design/2026-07-20-judgment-layer-process-manual.md) — P1–P7 write `docs/judgment/**` by hand today.
- **The mechanism this extends (not duplicates):** `lib/mcp-enforcement.js` + `lib/build.js:3963` (COMP-MCP-MIGRATION-1) — ship-time enforcement, already built.
- **The validator pattern this copies:** `lib/feature-write-guard.js` (COMP-MCP-VALIDATE-1) — write-time validation as an acyclic leaf module.
- **Downstream:** COMP-PLAN-IDEA-UNIFY (the `PROVIDER-SEAM` pilot). This feature deliberately does **not** depend on it — see *Sequencing*.

---

## Problem

**The first version of this design was wrong about the premise, and the correction is the most useful thing in it.**

`UNGUARDED-WRITES` states that across three sessions the agent's primary write path to canon was direct file authoring and *"no guard was ever in the loop."* That is true as an observation. The inference everyone drew from it — that no guard exists — is false.

**A guard exists. It is fully implemented. It is switched off.**

`lib/mcp-enforcement.js` (COMP-MCP-MIGRATION-1) declares guarded files and the typed tools authorised to write them (`mcp-enforcement.js:15–26`), and `lib/build.js:3963` runs a pre-stage scan at ship: every dirty guarded path must carry a matching typed-tool audit row stamped with the build's `build_id`, with **code-level correlation** so a tool call for feature A cannot bless a hand-edit to feature B (`mcp-enforcement.js:122–142`). It supports three modes — `block` / `log` / `off` — read from `enforcement.mcpForFeatureMgmt`.

In this repository, `.compose/data/settings.json` is `{}`. The mode resolves to **`off`**.

So the real problem decomposes into four, only one of which is "build a guard":

| # | Gap | Cost |
|---|---|---|
| G1 | The existing guard is **disabled** | A settings flag |
| G2 | It covers `ROADMAP.md`, `CHANGELOG.md`, `feature.json` — **not `docs/judgment/**`**, where the worst failures happened | A new writer |
| G3 | It enforces at **ship time only**. A whole session can be spent writing canon wrongly and only discover it at commit | The write-time hook |
| G4 | It verifies **that a tool was used**, not **who wrote it**. Provenance is unenforced | The genuinely new part |

The six demonstrated failures map onto these:

| Date | Failure | Caught by |
|---|---|---|
| 2026-07-20 | Joint register duplicated into two unsynced files | G2 (judgment writer) |
| 2026-07-20 | An undecided question recorded as decided | G2 |
| 2026-07-20 | A mandated tool skipped | **G1 — already covered, if switched on** |
| 2026-07-20 | Process manual: five internal self-contradictions | **Nothing here.** Reasoning defect (`STRUCTURE-NOT-TRUTH`) |
| 2026-07-21 | An agent claim filed under the owner's `[ASSERT]` tag; blocked the stack's biggest question for a day | G4 |
| 2026-07-22 | Ten canonical doc findings hand-authored | G2 + G3 |

**`UNGUARDED-WRITES` survives as a claim but its diagnosis needs amending:** enforcement the agent can route around is not enforcement — and *enforcement that ships disabled by default is the purest form of routable-around*. The claim's own evidence is stronger than it knew.

## Goal

**Not "no direct writes" — "no unattributed, unvalidated canon."** Per §12 of the spine (*"provenance must be captured at write time by the tool, never assigned by the writer after the fact"*), provenance is the reason the tool must own the write at all, and it is the one thing no existing mechanism does.

**In scope:** enable and extend the existing enforcement, unify its hard-coded path sets into one registry, add the missing judgment writer, add write-time prevention, add provenance, add a real override protocol.
**Not in scope:** semantic review, the fluid-store provider. See *Explicitly out of scope*.

---

## What already exists (do not rebuild)

| Canonical path | Validating writer | Ship-time guarded? | Write-time guarded? |
|---|---|---|---|
| `ROADMAP.md` | `lib/roadmap-gen.js` (generated) | **Yes** (when enabled) | No |
| `CHANGELOG.md` | `lib/changelog-writer.js` → `add_changelog_entry` | **Yes** (when enabled) | No |
| `docs/features/*/feature.json` | `lib/feature-writer.js` + `lib/feature-write-guard.js` | **Yes** (when enabled, code-correlated) | No |
| `docs/journal/**` | `lib/journal-writer.js` → `write_journal_entry` | No | No |
| `docs/product/ideabox.md` | `lib/ideabox.js` | No | No |
| `docs/judgment/**` | **none** | No | No |

Reusable, verified:
- `lib/mcp-enforcement.js:15–26,122–142` — guarded-file sets, path→tool maps, mode parsing, correlated scan. **The registry extracts from here.**
- `lib/feature-write-guard.js:1–202` — acyclic leaf validator. Template for `judgment-write-guard.js`.
- `server/mcp-tool-policy.js:1–112` — pure declarative policy, no I/O. Shape template for the registry.
- `contracts/*.schema.json` + `server/schema-validator.js` — Ajv infra.
- `server/compose-mcp.js:531,763` — two-site tool registration (declaration + dispatch).
- `lib/hooks-status.js:22–33` — marker + drift-detection pattern (for *git* hooks; the pattern transfers, the install path does not).

Gaps:
- **No PreToolUse hook exists anywhere.** `.claude/settings.json` registers only SessionStart / Stop / PostToolUseFailure, all pointing at `~/.stratum/hooks/*.sh`. `.claude/hooks/` does not exist.
- No `judgment_*` tools, no judgment schema, no writer.
- **No tool can update an existing feature's `description`, `phase`, `tags`, or `profile`** — see Decision 2.

---

## Decision 1: One registry, three enforcement points

The existing ship-time gate and the proposed hook must never disagree about what is canon. Two hard-coded lists that drift is worse than one list that is occasionally wrong.

`lib/canon-registry.js` becomes the single declaration — path pattern → writer → tools → **operations** — and is consumed by *both* `lib/mcp-enforcement.js` (which loses its literal sets) and the hook. **A contract test asserts both resolve identical path→operation mappings**; that test is the whole point of the extraction and is an S1 exit criterion.

The three points are complementary, not redundant — each matched to how the artifact is actually produced:

| | Write-time hook | Pre-commit git hook | Ship-time scan |
|---|---|---|---|
| Catches | `Write` / `Edit` / `NotebookEdit` | Any staged guarded path, however written | Dirty guarded paths **with no matching tool event at all** |
| Feedback | Immediate, at the mistake | At commit | At ship |
| Covers canon produced by | Agent tool calls | **Manual / by-hand work, humans, `Bash`** | Builds |
| Blind to | `Bash` (`sed -i`, heredoc, `git checkout`) | Uncommitted work | **Interleaved edits** (below); anything outside `featureFiles`; **anything written outside a build** |
| Role | **Prevention** | **Backstop for manual canon** | Backstop for build canon |

> **Three points, because canon is produced three different ways (rev 4).** rev 3 had two, and that left a hole the review found: **the judgment layer is run by hand.** The process manual is explicitly *"written to be run by hand, not built"* — so P1–P7 writes happen **outside any build**. But `feature-events.js:56` stamps `build_id: null` outside a build runner, and `scanGuarded` only considers `events.filter(e => e.build_id === buildId)`. **A perfectly legitimate `judgment_ledger_append` therefore produces an event that no future ship scan can ever accept**, and a direct `git commit` skips the ship scan entirely.
>
> That is a worse failure than a missing tool: the tool exists, is used correctly, and the gate still rejects it — which would make the anti-lockout acceptance criterion unsatisfiable the moment S5 registers judgment paths.
>
> **Root cause: `build_id` correlation encodes an assumption that canon is written during builds.** True for `feature.json`/`ROADMAP.md`/`CHANGELOG.md`; false for `docs/judgment/**`. So manual canon needs **build-independent attestation** — validity established by the S6 hash chain rather than by membership in a build. The natural enforcement point is **pre-commit**, and Compose already installs and drift-checks git hooks (`bin/git-hooks`, `lib/hooks-status.js:22–33`), so the install machinery exists.
>
> Required tests, named now: *manual typed write → later ship passes*; *manual raw write with no attestation → verification fails*.

> **CORRECTION (rev 3). rev 2 claimed the ship scan closes the `Bash` bypass. It does not, and the error mattered enough to record rather than quietly fix.**
>
> `scanGuarded` (`mcp-enforcement.js:122–146`) matches on **tool name + `build_id`**, plus feature-code correlation for `feature.json`. It never compares content, patch, or hash. So it detects the **lazy bypass** — a guarded file dirtied with *no* tool call anywhere in the build — and misses the **interleaved bypass**: make a legitimate tool call, then also hand-edit the same file. The event blesses the manual edit. `test/mcp-enforcement.test.js:201` codifies this for `ROADMAP.md`, where any permitted project-scoped event suffices.
>
> **The interleaved case is not exotic — it is exactly the observed failure mode.** Every session in the Problem table involved real tool calls *and* hand-authoring. So the scan would have caught approximately none of them on content grounds.
>
> Closing it requires content attestation — but **a hash of the post-write file does not work**, and rev 3 originally proposed exactly that. Compose's writers are **read-modify-write**: `setFeatureStatus` spreads the on-disk object (`feature-writer.js:434`), and `roadmap-gen.js:56` / `changelog-writer.js:344` take current file content as input. So a hand-edit to `description`, followed by a legitimate status call, is *read back in, re-written, and then attested by the writer itself*. Snapshot hashing certifies the tampering.
>
> **What works is a hash chain.** Each writer records `(prior_hash, operation, post_hash)`. Ship walks the chain for every guarded path from the last known-good state; an unaccounted write shows up as a **broken link** — call N's `post_hash` ≠ call N+1's `prior_hash` — regardless of what the file looks like at the end. Requires every legitimate writer to participate, including regeneration paths. Scoped as S6 and **not claimed as covered until then.**

### The lockout invariant

The hook sees a raw `Write`/`Edit` to a path. It **cannot** know whether that write constitutes "update the description" or "update the status" — there is no trustworthy semantic operation in its input. rev 2's operation-sensitive invariant was therefore unenforceable, and directly contradicted its own acceptance criteria. Corrected:

> **A registered path always refuses raw direct writes. A path is registered only once every legitimate mutation of it has either a tool or an explicit `override_only` declaration.**

`operations` in the registry is *not* a conditional-allow input to the hook. It serves three purposes, all of which work with path-only matching: naming the correct tool in the denial message, marking a path `override_only`, and driving the S2 inventory. Lockout is prevented at **registration** time (Decision 2), not at match time.

## Decision 2: Register a path only after inventorying its legal operations

The review gate killed the weaker invariant with a concrete counterexample, and a second one was already in the self-adversary pass. Both are the same defect:

- **`feature.json`** — `add_roadmap_entry` is **create-only**: `feature-writer.js:208` throws `feature "X" already exists`. `set_feature_status` mutates `status` alone. So **no tool updates an existing feature's `description`, `phase`, `tags`, or `profile`.** Registering `feature.json` today would make those fields editable only by override.
- **`ROADMAP.md`** — `lib/roadmap-preservers.js:25–26,196` preserves hand-authored prose *only* when already wrapped in `<!-- preserved-section: id -->` markers. Adding the markers is itself a direct write to `ROADMAP.md`. Registering it today makes opening a new prose section impossible except by override.

In both cases a writer exists and the path still cannot be legally written. **The `operations` field does not solve this; it only names the gap.** So registration is gated on an inventory:

> **Before a path is registered, enumerate every legitimate mutation of it and confirm a tool covers each. Any uncovered mutation is either (a) built as a tool first, or (b) explicitly declared override-only in the registry entry, with a reason.**

Concretely, before their paths register: `update_feature_fields` (description/phase/tags/profile) and a roadmap `open_preserved_section` operation. **This is the bulk of the real work and it was invisible in rev 1**, which asserted "only `docs/judgment/**` needs a new writer." That was false.

*Live demonstration, recorded rather than hidden:* updating this very feature's `feature.json` description after this rewrite required a direct file edit, because no tool can do it. The feature's own first act was the thing it exists to prevent.

## Decision 3: Provenance is captured, never declared

G4, and the only part with no existing mechanism. The 2026-07-21 failure was an agent claim wearing the owner's tag; the fix is not a better tag vocabulary (`[AGENT]` now exists) but that **the writer stamps the actor and the tag is not a writable field.**

Every record written through `judgment-writer.js` carries, set by the writer, never by the caller:

- `actor` — `agent` | `owner`, from call context.
- `origin_session`, `written_at` — ambient.
- `grounding` — **constrained by `actor`**: a record with `actor: agent` cannot be persisted with `[ASSERT]` or `[owner-locked]`. `[owner-locked]` requires an owner-attributed call.

That rule makes the 2026-07-21 failure *unrepresentable* rather than discouraged. ~~It rests entirely on Open Question 1 (how a call proves `actor: owner`), which therefore gates S2.~~

**Amended 2026-07-22 (OQ1 resolved — v1 agent-only):** the writer stamps `actor: agent` unconditionally in v1. No call can carry `[ASSERT]` or `[owner-locked]` at all; owner-attributed claims enter only through the Decision 4 override path, which is ledgered. The grounding constraint above becomes trivially enforced (there is nothing to constrain), and the owner-proof mechanism is deferred until owner-write traffic actually exists to design against.

## Decision 4: The override — grant-then-write, ledger-first

rev 1 specified the override's semantics and none of its mechanism. A PreToolUse hook cannot prompt, so "requires a reason" needs an actual protocol, and "cannot succeed unledgered" needs an ordering guarantee.

1. **`canon_override_grant({ path, reason, operation })`** — an MCP tool. Rejects an empty or whitespace `reason`. `operation` is a **declared intent label supplied by the caller**, recorded in the ledger for later analysis — it is *not* verified against the write, because nothing can verify it (see the lockout invariant).
2. **It appends the `bypass`-tagged ledger entry FIRST**, then mints a grant token: single-use, scoped to **one exact path**, short TTL, recorded with `actor` per Decision 3.
3. The hook looks for a live token matching the exact path; if found it **consumes** it and allows the write. **Matching is path-only** — consistent with the hook's actual inputs.
4. If the write then fails, a bypass entry exists for a write that never happened.

**Ledger-first is the atomicity answer.** The failure mode is over-recording, never under-recording: a token cannot exist without its ledger entry, so an allowed bypass is unledgered only if the ledger write itself succeeded and the token mint failed — in which case no write is allowed either. `OVERRIDES-ARE-GOLD` applied one level down, and the bypass log becomes the specification for v2: bypasses concentrated on one path are a missing tool operation, stated in evidence rather than argued.

**The override must cost something visible or it becomes the default path** — single-use and path-scoped are what make it cost something. A session-wide or time-boxed grant would decay into "turn the guard off."

## Honest limits — stated so they are not later assumed

- **`STRUCTURE-NOT-TRUTH` still binds.** This catches duplicates, unattributed claims, schema violations, skipped tools. It does **not** catch a well-formed, correctly-attributed, internally-contradictory document — one of the six demonstrated failures. That needs the review gate.
- **The hook governs agent tool calls only.** A human in an editor is unaffected, which is correct (`CANON-IS-GATED` gates the agent, not the owner) — but it means the guard is not a filesystem ACL.
- **The write-time hook is Claude-only.** It installs under `.claude/hooks` and intercepts Claude's `Write`/`Edit`. **Compose also dispatches Codex**, which runs as a separate `codex` CLI (`docs/agents.md:19,29`) that a Claude `PreToolUse` hook cannot touch. This session used Codex five times. Enforcement point 1 is therefore **a Claude-runtime convenience, not a guarantee** — its acceptance criterion must say so. Runtime-neutral coverage comes only from points 2 and 3, which operate on the filesystem and git rather than on tool calls. **State the guarantee as runtime-scoped or it is false on arrival.**
- **A committed bypass is invisible to a dirty-tree check.** `git commit --no-verify` skips the pre-commit hook; afterwards the tree is clean, ship gathers `git diff … HEAD` (`build.js:3933`) and returns early when no eligible files remain (`build.js:3954`). No writer follows, so no broken chain link is ever observed. **Closing this needs a durable verified baseline** — verification across all registered canon or a commit range, not only what is currently dirty — plus a regression for *raw edit → `--no-verify` commit → later clean build*.
- **`Bash`-shaped writes remain uncovered until S6.** `sed -i`, heredocs and `git checkout` bypass the hook, and the ship scan only catches them when *no* tool event exists for that path in the build (see the rev 3 correction in Decision 1). Until content attestation lands, an interleaved tool-call-plus-hand-edit is undetected.
- **The ship scan does not see `docs/judgment/**` at all.** `lib/build.js:3942–3950` filters dirty files to `featureDir` plus `CHANGELOG.md` / `ROADMAP.md` / `README.md` / `CLAUDE.md` and `context.filesChanged`, then passes only that set to `scanGuarded` (`build.js:3990`). Judgment canon matches none of those, so it is neither scanned **nor staged** by a normal feature ship. The code already warns about analogous uncovered paths at `build.js:3985`. **Judgment paths must not be registered before S5 adds a non-feature-scoped guard scan** — registering them earlier would produce a guard that looks enabled and enforces nothing.
- **Authored docs are not canon.** `design.md`, `blueprint.md`, `plan.md`, `docs/design/**`, `docs/product/**` are hand-authored artifacts, not generated projections, and must never be registered. `CANON-IS-GATED` draws exactly this line. Registering them would block the design phase.
- **Wide coverage puts the guard in daily flows.** `feature.json` is edited constantly; `CHANGELOG.md` is required in the same commit as code changes. This is the cost the wide-coverage scope buys, and it is only acceptable *because* the override exists and *because* Decision 2 forces the operation inventory first.

---

## Sequencing

~~`TOOLS-OWN-WRITES` says the judgment tools front the fluid-store provider (`PROVIDER-SEAM`), pilot COMP-PLAN-IDEA-UNIFY. That is not a blocking dependency: the ruling designates a **zero-install local floor**, and manual mode already runs on markdown-in-git, which *is* that floor. `MARKDOWN-EMITTED` makes markdown a projection later; writing it now through **one writer** is exactly what makes that a one-time import rather than a rewrite.~~

**OVERRULED 2026-07-22 (owner, `LEDGER.md` → `decide: judgment-writer-provider-records`).** The markdown-as-floor argument above lost to `REGISTER.md`'s banner ("do not build tooling against these files" — tooling against disposable scaffolding is the ideabox failure). **S3's writer fronts the local-floor provider directly from v1** (records over the vision store's existing types: joint → `question`, decision/kill → `decision`, deliberation → `thread`); `docs/judgment/**` markdown becomes a generated projection per `MARKDOWN-EMITTED`. Consequence: S3 now depends on at least the minimal record-write slice of the local floor existing — either COMP-PLAN-IDEA-UNIFY's seam lands first, or S3 carves that slice itself, making the judgment writer (not ideabox) the seam's first real consumer. That sequencing call is flagged in the ledger entry, not yet made. The position-type modelling question (new vision-store type vs `idea` with joints) remains open and must not be answered by drift.

| Slice | Content | Gate |
|---|---|---|
| **S0** | Set `enforcement.mcpForFeatureMgmt: **'log'**`. **No code. `'block'` is NOT part of S0** — see below. | Ship-time scan emits decisions; a hand-edited `ROADMAP.md` is flagged in the log |
| S1 | `canon-registry.js` (path → writer → tools → operations); `mcp-enforcement.js` refactored to consume it | **Contract test: hook and ship enforcement resolve identical mappings.** Lockout invariant unit-tested with a synthetic unwritten path |
| S2 | **Full write-surface inventory** (Decision 2) — not just the two missing operations but *every existing path that mutates canon*: CLI (`compose feature`, `compose roadmap generate`), server routes, migration scripts. Each is routed through a typed tool, retired, or declared `override_only`. Plus `update_feature_fields` and roadmap `open_preserved_section` | Every registered path has a tool for every legal mutation, or an explicit override-only declaration; no known CLI/server/migration surface writes canon unaccounted |
| **S2b** | ~~**Promote to `'block'`.** Gated on S2 complete **and** the override existing (S4)~~ **RETIRED 2026-07-22** — see *Two findings that change the plan*, finding A: all 777 real events carry `build_id: null`, so the gate as built has never been satisfiable; the build-correlation model must change before any `'block'` promotion can be re-specced | — |
| S3 | **Carved out as its own feature: [COMP-JUDGMENT-WRITER](../COMP-JUDGMENT-WRITER/design.md) (2026-07-22).** `judgment-record` schema, write guard, writer, projections, 4 `judgment_*` tools + read tool; provenance per Decision 3 (**v1 agent-only** — OQ1 resolved 2026-07-22); writer fronts the tracked-records floor, markdown is a projection (substrate ruling 2026-07-22, see Sequencing) | A record carrying `[ASSERT]` or `[owner-locked]` cannot be written through any tool; markdown projections regenerate byte-stable from records |
| S4 | `.claude/hooks/canon-guard.mjs`; `compose guard install\|status\|uninstall`; `canon_override_grant` + ledger-first token protocol | Direct `Write` to every registered path denied, denial names the tool; empty reason refused; token single-use and path-scoped; no unledgered bypass |
| S5 | **Non-feature-scoped guard scan** in `lib/build.js` covering `docs/judgment/**` (and any registered path outside `featureFiles`), plus staging; **and the pre-commit git hook + build-independent attestation for manually-produced canon** (Decision 1) | A Bash edit to judgment canon with no attestation fails commit; *manual typed write → later ship passes*; *manual raw write, no attestation → verification fails*. **Judgment paths register only now** |
| S6 | **Content attestation** — writers record a hash of what they produced; ship compares each dirty guarded path against the last attested hash | An interleaved tool-call-plus-hand-edit is detected. Only at this point is the `Bash` bypass genuinely closed |

**S0 costs one settings key — but only in `'log'` mode.** rev 3 originally folded the promotion to `'block'` into S0 and called it nearly free. That was wrong and would have broken normal workflows on day one:

- `compose feature` writes `feature.json` **and** `ROADMAP.md` directly (`bin/compose.js:1066,1131`); `compose roadmap generate` writes `ROADMAP.md` directly (`bin/compose.js:1154,1178`). Neither emits a typed-tool event.
- Worse, events emitted **outside a build runner carry `build_id: null`** (`lib/feature-events.js:56` — *"Null outside of a build (manual CLI/MCP invocations)"*), while `scanGuarded` only considers `events.filter(e => e.build_id === buildId)`. **So even a properly typed MCP write made outside a build never satisfies the gate.** Most of this design session's own canonical writes are in that category.

`'log'` is therefore the genuinely free step and is deliberately first, so the rest is built against **observed** enforcement behaviour rather than assumed. `'block'` is a *later, gated* step (S2b) that lands only once every real write surface is accounted for and the override exists.

> *Note for S3/G4:* the event log already stamps an `actor` (`feature-events.js`). That is provenance of the **tool call**, not of the **claim**, so it does not satisfy Decision 3 — but it is prior art worth reusing for how actor is resolved.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `.compose/data/settings.json` | modify | S0 — enable the existing enforcement |
| `lib/canon-registry.js` | new | Single source of truth: path → writer → tools → operations |
| `lib/mcp-enforcement.js` | modify | Drop literal sets; consume the registry; content attestation (S6) |
| `lib/build.js` | modify | S5 — non-feature-scoped guard scan + staging for registered paths outside `featureFiles` (currently filtered out at `3942–3950`) |
| `lib/judgment-write-guard.js` | new | Pure leaf validator for judgment records |
| `lib/judgment-writer.js` | new | The missing writer; stamps provenance; fronts the local-floor provider (records, not markdown — 2026-07-22 ruling), emits `docs/judgment/**` as projections |
| `contracts/judgment-record.schema.json` | new | Record shapes (claim, joint, position, ledger entry) |
| `.claude/hooks/canon-guard.mjs` | new | PreToolUse refusal; set derived from registry |
| `server/compose-mcp.js` | modify | Declare + dispatch `judgment_*`, `update_feature_fields`, `canon_override_grant` |
| `bin/compose.js` | modify | `compose guard install\|status\|uninstall\|verify` |
| `bin/git-hooks` | modify | S5 — pre-commit guard hook for manually-produced canon (existing install + drift machinery) |
| `test/canon-registry-contract.test.js` | new | Hook and ship enforcement resolve identically |

## Acceptance criteria

- [ ] `enforcement.mcpForFeatureMgmt` is `log` (S0), then `block` (S2b), and a hand-edited guarded file fails ship
- [ ] With `block` on, a full `compose build` completes using only normal workflows — no CLI/server/migration surface writes canon unaccounted
- [ ] `lib/canon-registry.js` is the only place a canonical path is declared; `mcp-enforcement.js` has no literal path set
- [ ] Contract test proves hook and ship enforcement resolve identical path→operation mappings
- [ ] An **unregistered** path is never blocked (lockout invariant, unit-tested with a synthetic path)
- [ ] Every registered path has a tool for every legal mutation, or an explicit `override_only` declaration with a reason — verified at registration, not at match time
- [ ] A Bash edit to `docs/judgment/**` with no tool event fails ship (S5)
- [ ] An interleaved tool-call-plus-hand-edit to a guarded path is detected (S6); **until S6 this is a known, documented gap**
- [ ] `update_feature_fields` can change description/phase/tags/profile on an existing feature
- [ ] `judgment_*` tools stamp `actor`/`origin_session`/`written_at`; none is caller-writable
- [ ] No tool call can persist a record carrying `[ASSERT]` or `[owner-locked]` (v1 agent-only, OQ1 ruling 2026-07-22); the only path to an owner-attributed record is the ledgered override
- [ ] Direct `Write`/`Edit` to a guarded path is denied, and the denial names the tool to use
- [ ] `canon_override_grant` refuses an empty reason; the token is single-use and path-scoped; the ledger entry is written before the token is minted
- [ ] `compose guard status` reports installed/missing/drifted, mirroring `compose hooks status`
- [ ] Manual mode P1–P7 remain runnable end-to-end with the guard installed (the anti-lockout test)
- [ ] A manual typed judgment write, made outside any build, passes a later ship
- [ ] A manual raw write to judgment canon with no attestation fails verification at commit

## Open Questions

1. ~~**Owner-attributed calls.** How does a tool call prove `actor: owner`? A distinct MCP surface, a session flag set at bind time, or explicit confirmation. **Gates S3** — without it Decision 3 degrades to honour-system tagging, the exact failure it exists to fix.~~ **RESOLVED 2026-07-22 (owner, `LEDGER.md` → `decide: oq1-agent-only-v1`): v1 is agent-only.** Every tool write stamps `actor: agent`; `[ASSERT]`/`[owner-locked]` are unrepresentable through the tools — owner-attributed claims land only via the logged override path. Chosen against the data: all 777 recorded events are agent writes; there is no owner traffic to design a proof mechanism for. S3 is no longer gated on this question.
2. **Guard scope: this repo or every compose workspace?** If the hook ships to users the registry must be workspace-relative. Likely yes; changes the install story.
3. **`positions/*.md` granularity.** Whole-file upsert, or field-level? Field-level is required before `SHAKE-GROUNDING` can downgrade grounding without touching conviction.
4. **Append-only enforcement for the ledger** — filesystem-level, or writer convention? An override holder can still rewrite history.
5. **Should `docs/journal/**` and `ideabox.md` register at all?** Both have writers but neither is currently ship-guarded; adding them widens daily friction for lower stakes. Decide at S2 with the inventory.

## Explicitly out of scope

- Semantic/contradiction review (`STRUCTURE-NOT-TRUTH` — the review gate's job).
- The fluid-store provider itself (COMP-PLAN-IDEA-UNIFY owns it).
- Teaching Stratum about joints or convictions (`STRATUM-AGNOSTIC` forbids it; this layer sits above).

---

## Review history

**rev 1 → rev 2 (2026-07-22), Codex read-only design gate, three P1 findings, all confirmed against code and all accepted:**

1. *The registry would not be the single source of truth* — `lib/mcp-enforcement.js` already hard-codes guarded paths and authorised tools, enforced at `lib/build.js:3963`. **Confirmed.** This overturned the design's premise: the guard exists and is disabled. Produced G1/G3, slice S0, and the two-enforcement-point model in Decision 1.
2. *"Only `docs/judgment/**` needs a new writer" is not established* — no tool updates an existing feature's description/phase/tags/profile. **Confirmed** at `feature-writer.js:208` (create-only). Produced Decision 2 and slice S2, the largest scope change in the rewrite.
3. *The override has no executable protocol or atomicity plan* — **Confirmed** as underspecified. Produced Decision 4's grant-then-write, ledger-first protocol.

A prior self-adversary pass had independently found the `ROADMAP.md` preserved-section circularity, which finding 2 generalised; both now live in Decision 2.

**rev 2 → rev 3 (2026-07-22), second Codex gate, three further P1 findings, all confirmed against code and all accepted:**

1. *`docs/judgment/**` never reaches the ship-time backstop* — `lib/build.js:3942–3950` filters dirty files to the feature dir plus four root files before passing them to `scanGuarded` (`build.js:3990`). **Confirmed.** Judgment canon is neither scanned nor staged. Produced slice S5 and a hard ordering constraint: judgment paths must not register before it.
2. *The ship gate proves event-presence, not content provenance* — `scanGuarded` matches tool name + `build_id` (+ code for `feature.json`) and never compares content; `test/mcp-enforcement.test.js:201` codifies this. **Confirmed, and it retracts a rev 2 claim.** rev 2 asserted the ship scan closed the `Bash` bypass; it closes only the *lazy* bypass, not the *interleaved* one — which is the observed failure mode. Produced the correction in Decision 1 and slice S6.
3. *The hook cannot enforce an operation-sensitive invariant* — a `PreToolUse` hook sees a raw write to a path, not a semantic operation, so rev 2's invariant was unenforceable and contradicted its own acceptance criteria. **Confirmed by inspection.** Produced the corrected always-deny invariant and path-only override matching.

**rev 3 → rev 4 (2026-07-22), third Codex gate, two further P1 findings, both confirmed against code and both accepted:**

1. *S0's promotion to `block` would lock out existing workflows* — `compose feature` and `compose roadmap generate` write canon directly without typed events (`bin/compose.js:1066,1131,1154,1178`), and events emitted outside a build runner carry `build_id: null` (`feature-events.js:56`) which `scanGuarded` can never match. **Confirmed.** Split S0 into `log` (free, first) and S2b (`block`, gated on a full write-surface inventory plus the override). Widened S2 from "two missing operations" to *every* existing surface that mutates canon.
2. *S6's post-write content hash cannot detect the interleaved bypass* — Compose's writers are read-modify-write (`feature-writer.js:434` spreads the on-disk object; `roadmap-gen.js:56`, `changelog-writer.js:344` consume current file content), so a hand-edit is read back in and **attested by the writer itself**. **Confirmed.** Replaced snapshot hashing with a `(prior_hash, operation, post_hash)` **chain**, where an unaccounted write appears as a broken link.

**rev 4 → rev 5 (2026-07-22), fourth Codex gate, one further P1, confirmed and accepted:**

1. *Manual judgment writes have no valid path through the ship gate* — the judgment layer is run **by hand, outside any build**, so its tool events carry `build_id: null` (`feature-events.js:56`) and `scanGuarded` can never accept them; a direct `git commit` skips the ship scan entirely. **Confirmed.** The tool would exist, be used correctly, and still be rejected — making the anti-lockout criterion unsatisfiable once S5 registers judgment paths. Root cause: `build_id` correlation assumes canon is written during builds, which is false for `docs/judgment/**`. Produced the **third enforcement point** (pre-commit git hook, reusing `bin/git-hooks` + `lib/hooks-status.js`) and build-independent attestation in S5.

**rev 5 → rev 6 (2026-07-22), fifth Codex gate — did NOT clear. Two further P1s, both confirmed, both folded in as scoped limits rather than solved:**

1. *The write-time guard is Claude-only* — Compose dispatches Codex as a separate CLI (`docs/agents.md:19,29`) that a Claude `PreToolUse` hook cannot intercept. **Confirmed.** The prevention guarantee is runtime-scoped, not absolute.
2. *S6 does not close a persisted Bash bypass* — `--no-verify` commits leave a clean tree, and ship returns early on no eligible dirty files (`build.js:3933,3954`), so the broken chain link is never observed. **Confirmed.** Needs a durable verified baseline over all registered canon.

**Note on the review loop itself:** eleven confirmed P1s across five rounds, and four of them overturned claims the design was actively asserting — the guard exists; the scan closes the Bash gap; S0 is nearly free; a content hash detects tampering. Every one failed the same way: *asserting a property of the enforcement path without reading that path end to end*. That is the `feedback_verify_before_claims` failure four times, inside the very feature meant to stop unverified writes. **The correct read is not "the reviewer was useful" but "design-by-assertion about an existing subsystem is unreliable at a rate of roughly one error per claim."** Build slices should carry the same suspicion: verify the mechanism, then state the coverage.

---

## Scope verdict — this is an epic, not a feature

**Finding count per round: 3, 3, 2, 1, 2.** It converged for four rounds and then turned back up at the cap. The last findings are not defects in the argument; they are the **tail of an unbounded adversarial space** — *what if a different runtime writes it, what if the commit skips the hook, what if the baseline itself is forged*. Each is true, each is cheap to state, and there is no visible end to the sequence. That is the signature of a scope problem, not a quality problem.

What began as *"add a PreToolUse hook"* is now: three enforcement points, a registry extraction from a live subsystem, a full inventory of every write surface in the CLI/server/migration paths, a new writer plus four MCP tools, a provenance model, an override protocol with token semantics, a hash chain, a durable verified baseline, and multi-runtime coverage. **That is an epic.**

**Recommendation: split, and ship the narrow thing first.** `COMP-CANON-GUARD` becomes the umbrella. The first feature is S0 alone — set `enforcement.mcpForFeatureMgmt: 'log'`, change no code, and **collect a week of real data on what actually writes canon unaccounted.** Every remaining slice is currently specified against assumptions about that traffic; four of the eleven findings were exactly such assumptions being wrong. The log is the cheapest instrument that replaces guesses with observations, and it costs one settings key.

**Do not build S1–S6 against the current assumptions.** Re-spec them from the log.

### S0 — SHIPPED 2026-07-22

`enforcement.mcpForFeatureMgmt: 'log'` is set and live; `readEnforcementMode()` returns `log`. No code changed.

**New finding, from doing it:** `.compose/data/` is **gitignored** (`.gitignore:3`), so `settings.json` — the only file `readEnforcementMode` reads — is **machine-local and cannot be committed**. Enabling enforcement is therefore a per-machine act, not a project default that others inherit. A project-wide default would need a tracked home (`.compose/compose.json` is tracked; `readEnforcementMode` does not consult it). **Add this to the S2 inventory** — it is the same class of defect as the rest: an enforcement property assumed rather than checked.

**Empirical probes against the live scan** (`scanGuarded`), run rather than argued:

| Case | Result | Confirms |
|---|---|---|
| `ROADMAP.md` dirty, no tool event | **violation** | the existing guard does work when enabled |
| `ROADMAP.md` dirty, matching in-build event | pass | correct behaviour |
| `ROADMAP.md` dirty, event with `build_id: null` (manual CLI/MCP write) | **violation** | the rev-4 finding, reproduced — legitimate manual typed writes are rejected, which is why `'block'` would break workflows |
| `docs/judgment/LEDGER.md` dirty | **no violation, silently skipped** | the rev-3 finding, reproduced — judgment canon is not a guarded shape, so the guard is blind to exactly the paths that matter most |

The last two rows are the two most consequential findings of the whole review, now demonstrated rather than reasoned. **This is the standard the remaining slices should be re-specced to.**

**Correction, same day: `'log'` mode does not collect this.** Three defects in the instrument, found by reading its path instead of assuming it — the exact failure this document keeps recording:
1. It fires **only at ship inside a build**, so writes made outside builds are never sampled.
2. It only sees `featureFiles`, so `docs/judgment/**` is skipped (probe D above).
3. **Its output is discarded.** `build.js:3999` calls `emitDecisionEvent(() => {}, …)` — the first argument is the broadcast sink, and it is a **no-op**. The only durable trace is a `console.warn` in build output. There is no queryable log.

**The data did not need collecting — it already existed.** `.compose/data/feature-events.jsonl` holds **777 durable typed-tool events spanning 2026-05-02 → 2026-07-22**, each with `ts`, `actor`, `build_id`, `tool`, `code`. Correlated against `git log` over guarded paths (±15 min window):

| Path | Commits | With a typed event nearby | **Unaccounted** |
|---|---|---|---|
| `ROADMAP.md` | 112 | 96 | 16 (14%) |
| `CHANGELOG.md` | 101 | 67 | 34 (34%) |
| `docs/features/**` | 204 | 142 | 62 (30%) |
| **`docs/judgment/**`** | 8 | 1 | **7 (88%)** |

*The ±15 min proximity heuristic proves only that a tool ran near a commit, not that it produced the content — the interleaved-bypass problem again. So these are **lower bounds** on the unaccounted rate.*

### Two findings that change the plan

**A. `'block'` is not gated on an inventory — it is impossible as currently designed.** `by build correlation: {"OUTSIDE-build": 777}` — **every one of the 777 events carries `build_id: null`.** Not most: all, across 2.5 months. Since `scanGuarded` only considers `events.filter(e => e.build_id === buildId)`, **the ship gate has never once been satisfiable by real traffic**, and `'block'` would fail 100% of ships. S2b cannot proceed by inventorying write surfaces; the build-correlation model itself has to change. **This retires S2b as written.**

**B. `actor` is `mcp:agent` for all 777 events — there is no owner-write traffic at all.** Decision 3's `actor: owner` path (OQ1) has zero precedent and zero usage to design against. Either owner attribution is genuinely new surface, or the distinction should be reconsidered before it is built.

**And the thesis is confirmed where it matters most:** `docs/judgment/**` is ~88% hand-written, the highest unaccounted rate by a wide margin, on the smallest volume (8 commits). **The judgment writer is the highest-value, lowest-risk slice** — which is the opposite of the ordering the original design implied.
