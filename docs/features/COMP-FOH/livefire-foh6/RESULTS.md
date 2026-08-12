# FOH-6 live-fire harness + retained evidence (2026-08-12)

Scripts and outputs from the FOH-6 live-fire and the same-day upstream-fix verification.
Narrative and adjudications live in [`../foh-6-progress.md`](../foh-6-progress.md); this folder
exists so the verdicts are reproducible and the evidence outlives the session (Codex post-review
P1: an ephemeral retest with no retained harness cannot support an unconditional "fixed").

All tenants were throwaway and are deleted — tokens in any script state are dead. Scripts assume
the local stack (smart-memory-service :9001, Maya :9005) and a `fluid-identity.json` produced by
`provision-fluid.mjs` (recipe deltas vs FOH-4: `X-Workspace-Id` header required on
`/memory/ontology/types`; declare ALL `fluid_*` record types, the migration imports clusters).

## Files

- `provision-fluid.mjs` — throwaway tenant + NDA (type declares in-script are stale; see above)
- `seed-contradiction.mjs` / `finish-seed.mjs` — seed IDEA-A/IDEA-B, deterministic CONTRADICTS
  edge via `resolveIdeaChallenge` (no LLM-detection gate)
- `turn1.json` — the exact colleague-turn response: prompt was "What datastore does this idea
  propose for gate-retry persistence, and does anything in the ideabox contradict it?…" focused
  on the Redis idea; reply named the Postgres idea as the contradiction. Retained verbatim so
  the reflection verdict is independently checkable (Codex methodology note).
- `verify-list-fix.mjs` — wire repro: add → PATCH metadata → direct GET vs `/memory/list`
- `verify-rmw-fix.mjs` — shipped-path consequence test: two `addDiscussion` appends must BOTH
  survive; `writebackReply` with a repeated messageId must return `deduped:true`, one marker

## Recorded outputs

Pre-fix (morning): list served the pre-update blob 7+ minutes after `updateItem` (never
converged); second append dropped the first (`last-write-only`); retry returned `ok` without
`deduped` and the entry timestamp proved an overwrite.

Post-fix (`smart-memory-common@5afef49`, svc-api restarted with the mount):

```
verify-list-fix:  [update] 200 · [direct GET] blob = v2 · [list] blob = v2 · VERIFIED FRESH
verify-rmw-fix:   [after two appends] ["probe-1","probe-2"]
                  [writeback 1] {"outcome":"ok"} [writeback 2] {"outcome":"ok","deduped":true}
                  [final] {"total":3,"mayaMarkers":1,"authors":["probe-1","probe-2","maya"]}
                  VERIFIED — appends survive, dedup fires
```
