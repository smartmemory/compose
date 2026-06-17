**Feature ID:** `COMP-PARITY-5`
**Status:** DESIGN (Phase 1 — not yet implemented)
**Date:** 2026-06-16
**Predecessor:** COMP-MCP-ENFORCE

# COMP-PARITY-5 — Surface recorded completion next to the status control

## Problem

The cockpit's free item status dropdown (`ItemDetailPanel.jsx`, PATCH `/api/vision/items/:id`)
and the CLI's commit-SHA-bound `record_completion` (which appends to
`docs/features/<CODE>/feature.json#completions[]`) write to two different stores.
They can silently diverge: an operator can flip a feature's status to `complete`
in the UI with no recorded completion behind it, or a feature can carry a real
recorded completion (commit SHA + tests-pass) while its visible status reads
something other than complete (e.g. a later manual downgrade, a partial reconcile,
or a stale projection). Today the operator sees only the dropdown — the recorded
evidence is invisible in the cockpit, so the divergence is undetectable from the UI.

The **enforcement** half of the original row already shipped under COMP-MCP-ENFORCE
(STRAT-GUARD verdict-gating, evidence-bound completion at `/lifecycle/complete`,
terminal-status ownership, loopback auth). The **only** remaining scope here is the
**read-only UI view**: surface the recorded completion beside the status control and
**flag** any divergence. No new gating, no new write path, no enforcement.

## Approach

Add a small presentational component, `CompletionBadge`, rendered directly beneath
the existing Status/Confidence row in `ItemDetailPanel.jsx`. It is self-fetching
(mirrors the existing `SessionHistory` sub-component: `wsFetch` + `AbortController`,
keyed on `item.lifecycle?.featureCode`). It reads the **latest** recorded completion
for the feature and shows: short commit SHA (`commit_sha_short`), a tests-pass / tests-failed
badge, and the relative timestamp (`recorded_at`). When the displayed `item.status`
disagrees with what the recorded completion implies, it shows a divergence chip.

Completions are **not** currently on the vision item object (no `completions`
reference exists anywhere in `src/`), and the vision store/`feature-scan.js` never
load `feature.json#completions[]` into items. So a **new read-only endpoint** is
required. It reuses the existing `getCompletions(cwd, {feature_code, limit})` logic
from `lib/completion-writer.js` — no new read logic, no new storage.

### Divergence rule (explicit)

Let `s = item.status` (vision-state, lowercase: `complete`, `in_progress`, `planned`, …)
and `latest` = the most recent record from `getCompletions` (sorted desc by `recorded_at`).

- **No completion** (`latest` absent): neutral. Show "No recorded completion." No flag.
- **Completion exists AND `s === 'complete'`**: aligned. Show the badge, no divergence flag.
- **Completion exists AND `s !== 'complete'`** (and not `killed`): **DIVERGENCE** —
  "Recorded complete (`<sha>`) but status is `<s>`." A recorded completion implies the
  feature shipped; a non-complete visible status contradicts it.
- **`s === 'complete'` AND no completion**: **DIVERGENCE** — "Status complete but no
  recorded completion (no commit-bound evidence)."
- `killed` status with a completion is treated as **aligned-terminal** (no flag): a
  kill after a recorded completion is a deliberate terminal action, not drift.

A completion whose `tests_pass === false` is still a recorded completion for alignment
purposes (status `complete` ↔ record present), but the tests badge renders red so the
weak evidence is visible.

## Options considered

1. **Push `completions` onto every vision item** (in `feature-scan.js` / store): rejected —
   widens a hot read path (every item, every broadcast) for data only one panel needs,
   and couples the store to `feature.json#completions[]`. Lazy per-item fetch is cheaper.
2. **Reuse `get_completions` MCP tool from the browser**: rejected — MCP tools are stdio,
   not reachable from the cockpit; the cockpit talks REST. A thin REST wrapper over the
   same `getCompletions` lib fn is the correct seam.
3. **Chosen — new read endpoint + self-fetching `CompletionBadge`**: smallest correct
   surface; `ItemDetailPanel.jsx` gets only an import + one mount line; divergence logic
   lives in a pure, separately-testable helper (mirrors `driftRibbonLogic.js`).

## Non-goals

No new gating/enforcement, no write path, no change to `record_completion`, no change
to the status dropdown's PATCH behavior. Read-only surfacing only.
