# COMP-MCP-MIGRATION-2-1-1-1: `/compose migrate-anon` interactive flow

**Status:** PLANNED (deferred follow-up)
**Date:** 2026-05-04

## Why

Surfaced by `COMP-MCP-MIGRATION-2-1-1` Decision 3. The parent ticket settles anonymous-numbered ROADMAP rows by preserving them verbatim as raw `tableRow` AST nodes — they round-trip losslessly without becoming typed features. That's the right default for ~10 rows in compose's Phase 0–4.5 history (shipped work, no further mutation expected).

This ticket exists for the case where a *specific* historical anonymous row deserves promotion to a typed feature — usually because someone wants to flip its status, link it from another feature, or query it via the typed-tool surface. Today the only path is: hand-author a `feature.json` that matches the row's phase + position, and the writer replaces the anonymous row on next regen. That works but has no UX.

`/compose migrate-anon` is the UX wrapper around that path.

## Goal

Interactive CLI flow that walks anonymous rows one at a time. For each row, surface the row's content (phase, status, title) and prompt: **(a)** assign a feature code (scaffold `feature.json`, replace anonymous row with typed row on next regen), **(b)** leave anonymous (skip, row stays verbatim), or **(c)** abort flow (resume later).

## Out of Scope

- Bulk auto-migration. Each row is a human decision.
- Code-synthesis from row content. The user types the code; we don't guess.
- ROADMAP.md backfill of arbitrary structure (preserved sections, custom tables, etc.). This flow only touches anonymous-row promotion.

## Open

Defer design depth until needed. Parent ticket's verbatim passthrough is sufficient until a real use case surfaces.
