# <Feature Name>: Design


## Why

Ordering defect in lib/completion-gate.js. Step 2 (`verifyCompletionEvidence`, ~line 290) accepts any ref git can resolve, so a 7-char prefix passes; step 5 applies the guarded transition and writes the intent with that prefix; step 6 (`completion-writer.js` SHA_RE, Decision 9) then refuses it and keeps the intent for recovery. Every retry is now refused: the same prefix recovers into the same writer refusal, and the full SHA of the same commit is refused at `recovery` as "different evidence" (string comparison at ~line 360). Hit 2026-09-15 on COMP-TUI-4 / da060af316b7ef8e6b062a69593564c837e3e0d6; operator workaround was to hand-correct `.compose/data/completion-intents/COMP-TUI-4.json` to the full SHA and re-drive the same operation. Fix: enforce the 40-hex rule (or normalize the prefix to the full SHA via `git rev-parse`) in the evidence step before any guard write, and compare commits in recovery by resolved full SHA rather than raw string. Also note the MCP tool description already says "Short prefixes are rejected on write", so the contract is right and the gate order is wrong. Complexity S.

**Status:** DESIGN
**Date:** <date>

## Related Documents

<!-- Link to roadmap, dependencies, and related features -->

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->
