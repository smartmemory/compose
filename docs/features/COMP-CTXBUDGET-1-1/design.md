# COMP-CTXBUDGET-1-1: Bound the test suite with `--test-timeout` — Design

**Status:** COMPLETE
**Date:** 2026-06-07
**Parent:** [COMP-CTXBUDGET-1](../COMP-CTXBUDGET-1/) (surfaced_by)

## Why

During COMP-CTXBUDGET-1 the full `npm test` hung for over an hour. Root cause (investigated):
`test/proof-run.test.js` runs a real ~25s stratum pipeline and is the suite's slowest test;
under full parallel load it can starve, and because the `test` script omitted `--test-timeout`
(node's `--test` has no default), a starved test hangs forever instead of failing. In isolation
proof-run passes; bounded with a per-test timeout the whole node suite is reliably green. The
unbounded hang also threatened the pre-push hook, which runs the same bare `npm test` as a hard gate.

## Decision: per-test timeout on every bare `node --test` script

Add `--test-timeout=120000` (2 min — ample headroom over proof-run's ~25s even under load, while
turning a true hang into a loud failure) to the node-suite portion of:

- `test` (the pre-push hard gate)
- `test:integration`
- `test:wave-6`

`test:ui` / `test:tracker` are vitest (already have their own timeouts) — unchanged.

Deliberately minimal: no test-file reorganization or proof-run isolation in this slice (that's a
larger, optional follow-up). A bounded timeout is the smallest change that removes the
hang-forever failure mode.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | modify | Add `--test-timeout=120000` to `test`, `test:integration`, `test:wave-6` |

## Verification

Full `npm test` runs to completion and stays green (node 3516 / ui 146 / tracker 100); a starved
integration test now fails at 120s instead of hanging indefinitely.

## Non-Goals

- Isolating real-pipeline integration tests (proof-run) into a separate non-parallel lane.
- Tuning per-test timeouts individually.
