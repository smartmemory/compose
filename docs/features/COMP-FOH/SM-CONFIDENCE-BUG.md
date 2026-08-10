# SmartMemory bug — confidence decay never reaches the first-class field (blocks COMP-FOH FOH-4)

> **RESOLVED (2026-08-10):** fixed as CONFIDENCE-DECAY-FIELD-1 — `smart-memory-core@2841909` (apply_decay reads/sets the first-class field via `_effective_confidence`; SQLite datetime codec fixed the False-return; both-backends parity test) + `smart-memory-service@3c79ddc` (routes read the field via `_item_confidence`). Both on `main`, pushed, unreleased at time of writing. No GH issue was filed: the fix landed before filing, so provenance lives in the commits + CHANGELOGs + this report. Kept as the FOH-4 design-gate provenance document.

**Found:** 2026-08-09, during Compose COMP-FOH / FOH-4 (CONVICTION) design gate.
**Repos:** `smart-memory/smart-memory-core` (logic) + `smart-memory/smart-memory-service` (routes). Both `main`, clean at discovery.
**Filing:** file as **smartmem-dev** (active gh account was `ruze00` this session — switch before `gh issue create`). This file is the ready-to-paste report.
**Severity:** the belief-strength (`confidence`) decay is observably broken end-to-end; a whole class of "conviction" reads report stale values.

## Summary

`ConfidenceManager` (`smart-memory-core/smartmemory/reasoning/confidence.py`) reads and writes `item.metadata["confidence"]`, but post-CORE-PROPS-1 `confidence` is a **first-class `MemoryItem` field** (`models/memory_item.py:74`) that is **popped out of metadata on load** (`from_vector_store: metadata.pop("confidence", 1.0)`, :416) and **excluded from the metadata merge on save** (`to_dict` `_FIRST_CLASS`, :371; and `metadata["confidence"] = self.confidence` at :347). The reasoning layer never updates the first-class field, so decay never reaches the canonical value.

## Empirical repro (lite/sqlite backend, no FalkorDB needed)

Script (reproduced): add a `semantic` item with `confidence=1.0` → `ConfidenceManager(sm).apply_decay(item_id, 0.5)` → `sm.get(item_id)`.

Observed:
- Fresh `get`: `field .confidence=1.0`, `metadata.confidence=None` (popped on load).
- `apply_decay` **returns `False`** — raises `"Object of type datetime is not JSON serializable"` inside `sm.update(item)` (partial write; may be lite-specific — verify on FalkorDB).
- After decay: `field .confidence=1.0` (**never updated**), `metadata.confidence=0.5`, `challenge_count=1`, history len 1. Second decay → `metadata.confidence=0.0` (cumulative via metadata only). **Field and metadata permanently disagree.**

Net effects:
1. The canonical first-class `confidence` field never decays → recall/search and any field reader see `1.0` forever.
2. `apply_decay` reports `False` even when metadata moved → callers that check success (the correct thing to do) treat every decay as failed.
3. `GET /memory/reasoning/confidence-history/{item_id}` reports `current_confidence` from `item.metadata.get('confidence')` (`service reasoning.py:333`) → after a fresh load it's the popped default `1.0`.

## Affected sites

- `smart-memory-core/smartmemory/reasoning/confidence.py`: `apply_decay` read (:36) + write (:59) use metadata, never set `item.confidence`; `get_low_confidence_items` filters `item.metadata.get('confidence')` (:98-99).
- `smart-memory-service/memory_service/api/routes/reasoning.py`: `current_confidence` (:333), `/conflicts` (:295), `/low-confidence` (:244,252) all read `metadata.get('confidence')`.
- Datetime-JSON-serialization failure in the `apply_decay → sm.update` path (root cause TBD; investigate `crud.py:292 update` / `smart_memory.py:2712 update` serialization of item datetime fields).

## Not affected (do not touch)

`models/decision.py` and `models/opinion.py` set `self.confidence` (the field) directly in their own `reinforce`/`contradict` (:193/:202, :105/:114) — those subsystems are correct and independent of `ConfidenceManager`.

## Fix direction

1. `apply_decay`: read current from `item.confidence` (fallback to metadata for legacy), compute new, and **SET `item.confidence = new_confidence`** as the source of truth (keep writing metadata mirror only if the storage path needs it; verify against `node_types.py:191` which forwards field→metadata only when metadata lacks `confidence`).
2. `get_low_confidence_items` and the service routes (`current_confidence`, `/conflicts`, `/low-confidence`): read `item.confidence`.
3. Fix the datetime-JSON-serialization error so `apply_decay` returns `True` on success (and returns `False` only on real failure).
4. **Add a parity test** (`params=["falkor","sqlite"]`) pinning the full round-trip: add → decay → get → assert `item.confidence` dropped AND `confidence-history.current_confidence` reflects it AND a second decay is cumulative. The absence of this test is why the regression shipped (no test enters this branch).

## Downstream

Unblocks Compose COMP-FOH FOH-4 (CONVICTION), which wires `GET /confidence-history` (read) + `POST /resolve` (gated decay). See `docs/features/COMP-FOH/design-foh-4.md` (BLOCKED) and `foh-4-progress.md`. After this lands, FOH-4 design is revised for findings #2/#3/#4/#6 and built.
