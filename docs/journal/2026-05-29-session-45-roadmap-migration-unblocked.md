---
date: 2026-05-29
session_number: 45
slug: roadmap-migration-unblocked
summary: "Unblocked the migration: made the parser preserved-section-aware, wrapped Execution Sequencing, migrated ~149 rows to feature.json as a clean fixed point"
feature_code: COMP-ROADMAP-RT-GENFIX
closing_line: The migration didn't need a bigger hammer — it needed the parser to know what wasn't a feature.
---

# Session 45 — COMP-ROADMAP-RT-GENFIX

**Date:** 2026-05-29
**Feature:** `COMP-ROADMAP-RT-GENFIX`

## What happened

Picking up from the prior session's hand-off, the human said 'get on with it' — unblock the migration for real. We'd already established that GENFIX (the sort fixes) was correct but not the blocker; the blocker was that `migrate` parsed the curated `## Execution Sequencing` planning narrative (a non-standard `| Feature | Items | Effort | Rationale |` table) as feature rows, minting phantom bare-code features that collided with the real ones and grew duplicate struck rows on every regen.

We traced it to a consistency gap: `readPhaseBlocks` and `readPhaseOrder` already skipped `<!-- preserved-section -->` content, but `parseRoadmap`, `readPhaseOverrides`, and `readAnonymousRows` did not. So even a wrapped narrative got mis-parsed by migrate and double-emitted by generate. We made all three preserved-section-aware (TDD, red→green), exported the marker regexes as the single source of truth, and validated on a scratch copy: wrapping Execution Sequencing + the code fix produced a clean lossless fixed point with zero phantom feature.json.

Codex reviewed the parser change (it's load-bearing) and earned its keep again: it found the parser had no fence tracking (a marker inside a code fence could black-hole later rows), that `readAnonymousRows` nulled `currentPhaseId` on a preserved-open and dropped later same-phase anon rows, and that the parser matched markers on the trimmed line while the preservers used the raw line. We fixed all three (TDD), re-reviewed clean.

Then the real migration. Wrapped Execution Sequencing in the real ROADMAP, migrated 149 rows (42 STRAT-* skipped as external), generated, checked — clean fixed point. But the full suite caught one failure the roundtrip couldn't: 5 feature.json with statuses outside the schema enum. The roundtrip compares parse-to-parse so it's blind to schema validity. Root cause: 5 malformed *source* rows — SKILL-PD-1..4 had inline rationale in the status cell (`PARKED — needs Claude Code adoption`), and COMP-CAPS-ENFORCE-4 had an unescaped pipe (`"log" | "block"`) that shifted columns and ate the status. We fixed them honestly (folded the parking rationale into the description, restored the eaten description, set bare-token statuses), regenerated, and the suite went green. The two status drifts flagged for human decision turned out to be already-reconciled in the current ROADMAP — no decision needed.

## What we built

- `lib/roadmap-parser.js`: preserved-section + fence skipping, raw-line marker matching; imports `PRESERVED_OPEN_RE`/`PRESERVED_CLOSE_RE` from preservers.
- `lib/roadmap-preservers.js`: exported the marker regexes; `readPhaseOverrides` + `readAnonymousRows` skip preserved-section content; `readAnonymousRows` keeps `currentPhaseId` across a balanced block.
- Tests: 5 new cases across `test/roadmap-parser.test.js` and `test/roadmap-preservers.test.js` (preserved-section skipping, fenced-marker inertness, indented-marker parity, anon-after-block capture).
- `ROADMAP.md`: `## Execution Sequencing` wrapped as a preserved-section; regenerated from feature.json.
- ~149 new `docs/features/*/feature.json` from the migration; 5 corrected (SKILL-PD-1..4, COMP-CAPS-ENFORCE-4).
- Commits: code fix `6d8e538`, review-fix `83933e6`, migration `85becf6`.

## What we learned

1. **A permissive parser is the real hazard, not the data.** The curated narrative was legitimate content; the bug was that the parser had no concept of 'this isn't a feature table.' Preserved-section awareness — already present in half the readers — was the missing discipline. Fixing the reader beat trying to normalize every odd table.
2. **Consistency bugs hide in partial implementations.** Three of five preserver/parser functions honored preserved-sections; two didn't. The fix was less 'invent' and more 'make the laggards match the leaders.' Worth auditing for the same split whenever a cross-cutting concern is handled per-function.
3. **The roundtrip check and the schema validator catch different things.** `roadmap check` was a clean fixed point while 5 feature.json violated the status enum — because the roundtrip compares parse-to-parse, not against the schema. Run BOTH gates; a green fixed point is not a green schema.
4. **Malformed status cells and unescaped pipes are a source-authoring class, not a one-off.** A whole-corpus scan found exactly the rows the schema test flagged plus one external (STRAT-IMMUTABLE-3, harmlessly skipped). Scanning the class beat fixing the first instance and waiting for the next.
5. **Scratch-copy validation paid off twice.** We proved the whole migrate→generate→check chain converged on a copy before touching the real ROADMAP, so the real run was anticlimactic — exactly what you want from a migration.

## Open threads

- [ ] Consider hardening migrate/parser to tokenize status cells (extract the leading enum token) so inline rationale can't reproduce schema-invalid feature.json — deferred; the source-fix + schema test cover today's corpus.
- [ ] Cosmetic: the migrated roadmap still has an ugly lowercase `## implementation` phase and previously-doubled `## Features` (now collapsed by generate's dedup). Optional rename pass.
- [ ] STRAT-IMMUTABLE-3 source row has the same status-cell-rationale shape but is external (skipped); leave to stratum's owner.
- [ ] Three commits (6d8e538, 83933e6, 85becf6) landed directly on main rather than via a branch+merge --no-ff — note for next time; convention is to branch.

---

*The migration didn't need a bigger hammer — it needed the parser to know what wasn't a feature.*
