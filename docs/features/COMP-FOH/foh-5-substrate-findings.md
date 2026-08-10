# FOH-5 substrate findings — CALIBRATION and CONTRADICTION are both blocked upstream

**Date:** 2026-08-10 (session 107, immediately after FOH-4 shipped @8a477bb)
**Status:** INVESTIGATION COMPLETE — no code written, no slice opened
**Trigger:** owner chose "continue the epic" after FOH-4; the two remaining
undeclared capabilities are `CAP.CALIBRATION` and `CAP.CONTRADICTION`.

**Related:** [`architecture.md`](architecture.md) §deferred, [`foh-4-progress.md`](foh-4-progress.md),
[`design-foh-4.md`](design-foh-4.md), seam stubs `lib/fluid/provider.js:649-652`.

## Verdict

Neither slice is implementable as a straight next slice. They are blocked for
**different** reasons, and neither reason was visible from the Compose side —
both required reading the SmartMemory service and core.

| Slice | Wire surface | Blocker |
|---|---|---|
| `CALIBRATION` | `GET /agents/{agent_id}/evaluation` (+ `/history`) — well-built: explicit 404 `AGENT_NOT_FOUND`, cold-start returns `{evaluation: null}` at 200, history split to its own route | **No subject.** Requires an `agent_id` that is an `AGENT`-type user row in the tenant, plus `(dimension, domain)`. Compose registers no SmartMemory agents and writes no evaluations. The read side is fine; there is nothing to read *about*. |
| `CONTRADICTION` | `GET /reasoning/conflicts` | **Substrate is fed only by the strategies v1 bans.** See below. |

## CONTRADICTION: the substrate is structurally empty for Compose

`GET /reasoning/conflicts` (`routes/reasoning.py:230`) reports items carrying
`needs_review` / `has_conflict` metadata markers. Those markers have exactly
four write sites in all of smart-memory-core (`reasoning/challenger.py:386-397`):

- `has_conflict` + `conflicting_assertion` ← written **only** by `KEEP_BOTH`
- `needs_review` + `review_reason` ← written **only** by `DEFER`

FOH-4's v1 allowlist is **`accept_new` ONLY**. `accept_new` writes *neither*
pair — it decays confidence and appends a confidence-history event, nothing more.

**Therefore `/conflicts` returns an empty list for any workspace Compose writes,
by construction, forever.** A `contradictions()` built on it would be a feature
that structurally cannot ever return a result.

### Correction to a shipped ruling

`foh-4-progress.md` and the `project_comp_foh_architecture` memory both state
that `keep_both`/`defer` "write markers nothing reads (dead paths)". **The
premise is false** — `GET /reasoning/conflicts` reads exactly those markers, and
it is the only reader. The *conclusion* (exclude them from the v1 allowlist)
still stands on its independent grounds: neither strategy decays confidence, so
neither achieves a resolution, and `classifyResolution`'s exact-value
postcondition cannot verify either one. But the "nothing reads them" reasoning
must not be carried forward, because it is precisely what makes this slice look
viable when it is not.

### Other substrates considered and rejected

- **`POST /decisions/{id}/contradict`, `POST /decisions/{id}/conflicts`** — the
  native-decision facade. Per **D-FOH-3** Compose's wire type is `fluid_<kind>`,
  never the bare `decision`, so these operate on a different population. Not
  applicable.
- **Enumeration quality, independently disqualifying.** Even if the markers were
  written, `/conflicts` enumerates via `smart_memory.search("", top_k=limit*2)`
  — a relevance query with an empty string, not a scan. Coverage is
  non-deterministic. It accepts no `memory_type` filter, so it also hits the
  exact-filter / per-kind fan-out trap that already deferred the
  `/low-confidence` stale-beliefs surface. Its `elif` additionally shadows
  `has_conflict` on any item that also carries `needs_review`.
- **`POST /reasoning/challenge` does not persist.** Confirmed at
  `routes/reasoning.py:102-156`: it computes conflicts and returns them. Nothing
  is written. This is consistent with FOH-3 shipping as detection-only and with
  FOH-4's finding that no durable challenge record exists.

## The one substrate that does work today

`contradictions(handle)` can be reconstructed **per-handle** from the
confidence-history read path that FOH-4 already built and live-fire verified:
each decay event carries `reason` and `conflicting_fact`. That yields "what
claims have contradicted this belief, when, and why" without any new SmartMemory
work.

Two disclosed limits, both inherent to the substrate:

1. **Text, not links.** History events carry the contradicting fact as rendered
   content truncated to 200 code points. There is no handle, so a result cannot
   be resolved back to the contradicting record. This is the same gap FOH-4
   deferred as "persisted challenge tokens" / `against` is trusted-not-proven.
2. **Lossy past 20 events.** Confidence history is at-cap-20 and rotates, so old
   contradictions fall off silently.

Scope-honestly, a v1 on this substrate is **"conviction, itemized"** — it adds
the per-event contradicting claim and timestamp that `conviction()` does not
return, but it reads the same underlying history. Real, but incremental.

## Leverage note

The upstream unblock for CONTRADICTION — a **durable challenge/conflict record**
(provider-issued or server-persisted challenge tokens) — is the *same* upstream
work already deferred in FOH-4 to let `against` be **bound** rather than
trusted. One SmartMemory feature closes both. That raises its priority above
what either item justified on its own.

Already-owed, unrelated SmartMemory errand still outstanding: server-side
idempotency ID on `/resolve` (covers non-Compose callers the workspace lease
cannot reach).
