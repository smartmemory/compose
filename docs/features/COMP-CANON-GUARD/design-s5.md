# COMP-CANON-GUARD S5 — judgment canon drift detection (design)

**Status:** DESIGN, gated — Codex sol/xhigh design review folded in (6 findings, all accepted). Not yet built.
**Date:** 2026-07-24
**Owner decisions (locked):** judgment-only scope; snapshot manifest now, (prior,op,post) hash chain deferred to S6.
**Supersedes** the S5 row assumptions in [design.md](design.md) (the epic), which were specced against the dead build-correlation model.

## Related Documents
- [design.md](design.md) — the epic; S5/S6 rows, honest limits, Scope Verdict.
- [blueprint-s1-s4.md](blueprint-s1-s4.md) — the shipped prevention slice (S1 registry + S4 write-time hook).
- Downstream: **S6** — upgrades the record manifest to a `(prior_hash, op, post_hash)` chain (closes the interleaved-launder residual below).

---

## The honest reframe (Codex F1 — read this first)

The write-time hook (S4) blocks **Claude's** raw edits to `docs/judgment/**`. It cannot touch Codex-dispatched or Bash (`sed`/heredoc) edits. S5 is the git/filesystem-level backstop for those. But the design review established a hard ceiling on what an *in-workspace* backstop can be:

- **Projection verification IS enforcement.** Projections (`LEDGER/OBJECTIVE/REGISTER/SITUATION/index.md`, `people/*.md`, `positions/*.md`) are **derived** from records. Regenerate from records and compare: a hand-edit to a projection is provable drift and **cannot be laundered without editing the source record.** This half is sound.
- **Record verification is careless-drift detection, NOT enforcement.** The record manifest (`.attest.json`) is an in-workspace file the guarded actor can also write. It catches an edit that does not *also* update the manifest — the common careless / `sed`-a-record / Codex mistake — but a deliberate actor who recomputes the hash passes. **No in-workspace baseline can be a hard boundary against an actor with workspace write access.** Real record enforcement needs an out-of-workspace anchor (a server; out of scope) or the S6 chain (which raises forge cost but whose baseline is itself workspace-resident — bounded, not absolute).

**So S5 is honestly positioned everywhere as "catch accidental/careless corruption of judgment canon," not "enforce it."** Naming, CLI help, and reports must say drift-detection, never enforcement. This is not a weakness to hide — careless corruption is the realistic failure mode (the historical 88%-hand-written failure was careless authoring, not adversarial forgery).

## What S5 delivers, by tier

| Tier | Mechanism | Strength | Catches |
|---|---|---|---|
| Projection integrity | regenerate-from-records + compare (`checkProjectionRoundtrip`, exists) | **Enforcement** (records-anchored) | any hand-edit to a readable projection |
| Tree inventory | exact-allowlist of the whole `docs/judgment/**` tree | **Enforcement** for the file SET | any added / removed / unexpected file, dir, or symlink |
| Record content | sha256 manifest, recompute + compare | **Careless-drift only** | a record content edit that does not also forge the manifest |

## Design requirements (the 6 review findings as spec)

- **R1 (F1 — honesty + no self-launder).** `compose guard verify --fix` regenerates **projections only**; it MUST NEVER re-stamp record hashes to bless a raw record edit (that is the laundering step). The manifest is re-stamped ONLY as part of a tool's own record write (R3). All naming/help/reports say "drift detection."
- **R2 (F2 — full-tree coverage).** Verify an **exact allowlist over all of `docs/judgment/**`**, not just the five projections. Reject any file/dir/symlink not in the expected set. The verifier's namespace must equal the hook's guarded namespace (the registry `docs/judgment/**` entry), or a Bash-added `docs/judgment/FAKE.md` is invisible.
- **R3 (F3 — real stamping topology).** There is NO single mutation/rollback wrapper. Record+manifest publication must be centralized across **every** record-durability boundary — the `commitWithProjections` path, the pending-intent persist path, intent publish/refuse/replay — enumerated as the plan's first task (Codex cited `judgment-writer.js:212, 836, 3144`). Projection-only regeneration (`regenerateProjections`, called by the **read-only** `getJudgmentState` at `judgment-writer.js:3303`) must NEVER stamp — else a read blesses a raw edit. A legit mutation path that fails to stamp = a false "forged" verdict, so this is a correctness requirement, not only a security one.
- **R4 (F4 — canonical set + fail-closed).** Specify and validate the exact record set before hashing. **Include `ledger.jsonl`** (the store is not `*.json`-only — `judgment/store/records.js:345`). **Exclude `.attest.json`.** A malformed/unparseable record must **fail closed** (drift), never silently vanish into a green projection (`readJson` returns null today — `records.js:43`).
- **R5 (F5 — hook rollout).** Changing `pre-push.template` does NOT upgrade installed hooks; `hooks status` calls an old S5-less copy "current" (marker/path/workspace only). Add a **template version/content hash** to `hooks-status.js` so an outdated pre-push reports stale, with reinstall as the migration.
- **R6 (F6 — verify under lock).** The writer holds a private judgment lock; verify does independent reads. Verify MUST acquire the same lock or read a provably consistent snapshot, or it can false-fail a legit in-flight write.

## Components

- `lib/judgment-attest.js` (new) — `computeRecordHashes(cwd)` over the **specified** record set (R4), `writeManifest`, `stampRecord(cwd, recordRelPath)` (per-record update, not whole-tree regen), `verifyRecords(cwd)` → `{ok, drift:[{path, kind}]}`. Excludes `.attest.json`; includes `ledger.jsonl`; fail-closed on malformed.
- `lib/judgment-verify.js` (new) — `verifyJudgmentCanon(cwd)`: tree inventory (R2) + `checkProjectionRoundtrip` + `verifyRecords`, all under the judgment lock (R6) → combined `{ok, treeDrift, projectionDrift, recordDrift}`.
- `lib/judgment-writer.js` (edit) — stamp the manifest at **every** record-durability boundary (R3); never in projection-only regen.
- `lib/hooks-status.js` + `bin/git-hooks/pre-push.template` (edit) — template version detection (R5) + the verify gate.
- `compose guard verify [--fix]` (extend the S4 guard CLI) — runs `verifyJudgmentCanon`; exit 1 on drift; `--fix` regenerates projections only (R1).

## Call sites
- **Pre-push hook** — hard-fail a push whose working tree has judgment drift. `--no-verify` bypass = accepted residual.
- **Ship (`build.js`)** — `verifyJudgmentCanon` before the commit; fail the build on drift. New build-independent check; does NOT touch `scanGuarded`'s dead `build_id` predicate.
- **Standalone** `compose guard verify` — humans / CI.

## Deliberate non-changes
- Registry judgment entry stays `enforcedBy: ['hook']`. NOT adding `'ship'` (that routes judgment through the dead `scanGuarded`). Ship coverage is the separate `verifyJudgmentCanon`; the registry's `'ship'` point means "scanGuarded-style".
- Staging: v1 relies on verify-before-commit failing on drift, not re-plumbing `featureFiles` staging (a pre-staged judgment edit is caught by verify, not by staging changes).

## Honest limits (accepted residuals — do not treat as unshipped work)
- **Deliberate record forge** (edit record + recompute manifest, or `--fix` misuse) passes. In-workspace ceiling; S6 raises the cost, an out-of-workspace anchor would be the real fix (future, out of scope).
- **Interleaved edit-then-tool-amend of the same record** launders that record (the amend re-stamps it). S6 chain closes it.
- **`--no-verify`** push and non-working-tree pushed ranges bypass the pre-push gate.
- **Codex/Bash bypass the write-time hook** — that is the point; they are caught here at commit/push instead (for careless edits).

## Acceptance criteria
- [ ] A Bash edit to a readable projection (`LEDGER.md`) fails `compose guard verify`, pre-push, and ship.
- [ ] A Bash-added `docs/judgment/FAKE.md` (or `people/fake.txt`, or a symlink) fails verify (full-tree inventory, R2).
- [ ] A `sed` content-edit to a record that does not update the manifest fails verify (careless-drift, R4); a malformed record fails closed.
- [ ] A byte-only edit to `ledger.jsonl` is detected (R4).
- [ ] Every legitimate judgment tool op (create/amend/joint/transition/pending-intent/publish/replay/person/situation/goal) leaves verify GREEN — no false "forged" verdict (R3 topology complete).
- [ ] `getJudgmentState` (read-only) never mutates the manifest (R3).
- [ ] `compose guard verify --fix` regenerates projections but never blesses a raw record edit (R1).
- [ ] An installed pre-push hook predating S5 reports `stale` via `compose hooks status` (R5).
- [ ] Verify run concurrently with a writer does not false-fail (R6 lock).
- [ ] All S5 naming/help/report text says drift-detection, never enforcement (R1 honesty).
