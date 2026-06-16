# COMP-PARITY-1 — Implementation Report

**Status:** COMPLETE
**Date:** 2026-06-16

## Summary
Added CLI gate resolution so headless/CI runs can clear gates without the cockpit:
- `compose gate list [--item <id>] [--status pending|all|resolved] [--format text|json]`
- `compose gate resolve <gateId> (--approve|--revise|--kill) [--comment|--reason <text>]`

Pure client wrapper over the existing `GET /api/vision/gates` and
`POST /api/vision/gates/:id/resolve` endpoints — no server changes. `gate` and `gates` are
aliases, so `gates report` is unaffected.

## Delivered vs planned
| Planned | Delivered |
|---|---|
| `gate list` over GET /api/vision/gates | ✅ pending default, `--status`, `--item`, `--format` |
| `gate resolve` over POST .../resolve | ✅ approve/revise/kill, `--comment`/`--reason`, `resolvedBy: 'cli'` |
| `gate` ≡ `gates` alias, `report` untouched | ✅ |
| Tests | ✅ `test/cli-gate.test.js`, 16 cases (Express stub) |

## Key decisions
- **`--comment`/`--reason` both map to the endpoint's single `comment` field** (`--comment` wins if both).
- **`x-compose-token` sent on resolve when `COMPOSE_API_TOKEN` is set** — only consumed when
  `capabilities.guardAuth` is on (opt-in); no-op otherwise.
- **Record-per-gate text output, not a table** — real gate ids are long `<uuid>:<step>:<round>`
  strings; a fixed-width table smushed them (caught smoke-testing against the live `:4001`).

## Codex review fixes (round 1 → CLEAN)
1. **`--item` ignored for `--status all|resolved`** — the server only honors `itemId` on the
   pending path. Fixed with a client-side `itemId` filter so `--item` works uniformly. The test
   stub now mirrors the real server (itemId pending-only) so the contract is actually exercised.
2. **`--status`/`--format` accepted invalid values silently** — added enum validation
   (`pending|all|resolved`, `text|json`) with exit-1 + negative tests.

## Files changed
- `bin/compose.js` — `gate`/`gates` block: `list` + `resolve` branches, verb alias, help lines.
- `test/cli-gate.test.js` (new) — 16 cases.
- `docs/features/COMP-PARITY-1/{design,blueprint,report}.md`.

## Known limitations
- Wraps vision gates only; Stratum flow-step gates (`/api/stratum/gates/...`) are a separate surface.
- `gate resolve` requires the gate id as the first positional arg (id-before-flags).
