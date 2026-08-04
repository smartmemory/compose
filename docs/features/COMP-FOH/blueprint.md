# COMP-FOH — Implementation Blueprint (FOH-1)

**Slice:** FOH-1 — `SmartMemoryFluidProvider`, storage-only, kind `idea` only
**Status:** Proposed — pending gate approval
**Date:** 2026-08-04

## Related Documents

- Architecture: [architecture.md](architecture.md) — this blueprint grounds and corrects its Q1/Q2 sections.
- Design: [design.md](design.md)
- Seam it plugs into: [COMP-PLAN-IDEA-UNIFY](../COMP-PLAN-IDEA-UNIFY/design.md) — S1+S2+S3a shipped and pushed @5cfe013.
- S3a storage ruling this blueprint depends on: [s3-progress.md](../COMP-PLAN-IDEA-UNIFY/s3-progress.md) (D10, D12).

## Overlap check

Two other features reference this area: `COMP-SMARTMEMORY-INGEST` and
`COMP-SMARTMEMORY-RECALL`. Both are **shipped**, and both touch
`lib/smartmemory-client.js` — the file S01 extends. Neither has in-flight work,
so the only risk is regression, not collision: S01 must be **purely additive** to
that module and must not alter `health`/`ingest`/`search`, which the shipped
kitchen pipeline depends on.

No in-flight feature touches `lib/fluid/`. COMP-PLAN-IDEA-UNIFY S3b will, but it
works on `local-provider.js` and the CLI/API callers, not on this new file, and
`factory.js`'s `smartmemory` branch is untouched by it.

## Corrections table

Every row was verified against real code this session. `crud.py` paths are in the
SmartMemory repo (`smart-memory-service/memory_service/api/routes/crud.py`).

| # | architecture.md assumed | Reality | Consequence |
|---|---|---|---|
| **C1** | "typed CRUD routes", "structured/typed-entity routes" (§Q2) | **There is no typed-entity CRUD API.** The routes are generic **MemoryItem** CRUD, typed only by the free-form string `memory_type`; arbitrary payload rides in a free-form `metadata` object (`crud.py:373-382`, `memory_item.py:54-68`) | Q2's *decision* survives — extend the client, don't use `ingest()` — but the record mapping is `record → MemoryItem{memory_type, metadata}`. That is structurally the same move the local floor makes with its own record file: one typed slot plus a payload blob. It is not schema-enforced storage, and the blueprint must not claim it is. |
| **C2** | Paths `POST /add`, `GET /{item_id}`, `PATCH /{item_id}`, `DELETE /{item_id}` | The CRUD router is mounted under `/memory` (`service.py:449-451`) | Every adapter path needs the `/memory` prefix: `/memory/add`, `/memory/{item_id}`, … |
| **C3** | `GET /entities` (:637) listed as part of the CRUD family | `GET /memory/entities` is a **read-only autocomplete** over graph nodes with `node_category="entity"` (`crud.py:637-696`). It is not a record read and has no create/update/delete siblings. The real enumeration route is `GET /memory/list` (`crud.py:742-775`) | `listRecords()` must use `/memory/list` or `/memory/search`. Also kills architecture.md's proposed method names — see C10. |
| **C4** | Q1: workspace "keyed by the already-shipped `resolveProjectTag()`… **zero new identity scheme**" | `X-Workspace-Id` is confirmed as the exact header (`scope.py:81-108`) — **but the supplied value is validated against the authenticated principal's memberships and tenant, and a mismatch is a 403** (`scope.py:145-198`). A locally-derived project tag is not a SmartMemory workspace id, and nothing provisions one. | **Material gap; changes FOH-1's scope.** See "Open decision" below. Q1's *decision* (isolation, not a shared pool) is unaffected — its stated *mechanism* is incomplete. |
| **C5** | — (not addressed) | `GET /memory/list` has **no `memory_type` query parameter**; it filters only by `metadata_key`/`metadata_value` (`crud.py:742-775`). `POST /memory/search` does accept `memory_type` (`request_models.py:58-79`) | `listRecords({kind})` filters via metadata, or uses search. Do not assume a type filter on list. |
| **C6** | — | `memory_type` is **immutable after create** — stripped if supplied on update (`scope_provider.py:51-76`) | Aligns with the seam for free: `kind` is already in the provider's `UNPATCHABLE` set. Assert it in a test rather than leaving it to luck. |
| **C7** | — | `PATCH` is a partial merge, and metadata is **deep-merged, not replaced** — the code's own words are *"Deep-merge with existing metadata to preserve unrelated keys"*. If `properties` is supplied it wins outright and `content`/`metadata` are ignored (`crud.py:1003-1054`) | The provider writes whole records, so merge is safe for changed fields — but **a field removed from a record can never be removed server-side by a write**, at any nesting depth. Every write must send explicit `null`s for absent optional fields. The seam's `_normalize()` already fills every optional field to its contract default, which is exactly the property needed — so it must be applied *before* send, not after. Deleting a key genuinely requires `properties` (replace) or a delete+recreate, which would burn the handle; prefer explicit nulls. |
| **C8** | — | API-key scopes are derived from the **HTTP method**: `POST`/`PATCH` → `write:memories` (`scope.py:201-260`). `POST /memory/search` is therefore a *write*-scoped call | Bites **FOH-2** (RECALL), not FOH-1: a read-only recall capability will still demand a write-scoped key. Flagged now so it is not discovered at FOH-2's gate. |
| **C9** | — | Create returns **200, not 201**, with `{id, status:'created', workspace_id, …}` (`crud.py:547-564`) | Client must not assert 201. |
| **C10** | Method names `createEntity`/`getEntity`/`updateEntity`/`deleteEntity` (§Q2) | Given C1 and C3, "Entity" is actively misleading — `/memory/entities` exists and means something else entirely | Rename to `createItem`/`getItem`/`listItems`/`updateItem`/`deleteItem`. A name that collides with a real, different endpoint is a trap for the next reader. |
| **C11** | "Independently testable… injected-store style" (§Sequencing) | That pattern was removed by S3a — `LocalFluidProvider`'s `config.store` injection existed at `8a6b687:201-202` and is gone | Already corrected in architecture.md this session. Test strategy below uses the pattern that actually exists. |

**Corrections that change a decision:** C4 only. C1/C3/C10 change how the work is
described and named; C2/C5/C7/C9 change wire details; C6 is a free alignment;
C8 is a warning aimed at the next slice.

## Open decision (gate)

**C4 has no answer in architecture.md, and FOH-1 cannot be built without one.**

The isolation model needs a real SmartMemory workspace id whose membership
includes the calling principal. `resolveProjectTag()` returns a locally derived
string (`compose`), which the service will reject with a 403 unless a workspace
with that id happens to exist and the principal belongs to it.

| Option | Cost | Notes |
|---|---|---|
| **(a) Configured workspace id, fail loud** — `fluid.smartmemory.workspaceId` in `.compose/compose.json`; absent ⇒ `FluidConfigError` naming the setting. Provisioning deferred and filed. | Smallest | **Recommended.** Matches what `factory.js:91` already does for the unimplemented provider: refuse clearly rather than silently downgrade. Keeps FOH-1 a storage adapter instead of a provisioning feature. Consistent with tenant-provisioning already being parked (`COMP-INSTINCT-HOOK-1`). |
| (b) Discover-or-provision at init | Larger | Needs a second wire-contract pass over SmartMemory's workspace/team API, which this research did not cover. Turns FOH-1 into two features. |
| (c) Re-open Q1 at architecture level | Largest | Not warranted — the *decision* is sound; only its mechanism was under-specified. |

> **OWNER RULING 2026-08-04 — option (a).** FOH-1 takes an explicitly configured
> `fluid.smartmemory.workspaceId`. Absent ⇒ `FluidConfigError` naming the
> setting, raised **before any network call** (the `authHeader()` precedent at
> `smartmemory-client.js:64`). Workspace provisioning is filed, not built.
>
> Consequence for `architecture.md` §Q1: its "keyed by the already-shipped
> `resolveProjectTag()` … zero new identity scheme" clause is **superseded**.
> The isolation *decision* stands unchanged — one workspace per product, not a
> shared pool — but the id is supplied by configuration rather than derived, and
> the local-tag → workspace-id mapping is deferred along with provisioning.
> `resolveProjectTag()` is not used by FOH-1.

Everything below assumes **(a)**.

## Wire contract (as verified)

```
POST   /memory/add            {content, memory_type, metadata, use_pipeline:false} → 200 {id, status, workspace_id}
GET    /memory/{item_id}                                                            → 200 {item_id, content, memory_type, metadata, …} | 404
GET    /memory/list           ?limit&offset&order&metadata_key&metadata_value       → 200 {items, total, limit, offset}
PATCH  /memory/{item_id}      {content?, metadata?, properties?}                    → 200 {status, item_id} | 400 | 403 | 404
DELETE /memory/{item_id}      ?cleanup_orphans=true                                 → 200 {status, item_id, garbage_collection?}
```

Headers on every call: `Authorization: Bearer <key>` (existing `authHeader()`
convention) **plus** `X-Workspace-Id: <configured id>`.

`use_pipeline: false` on create is deliberate — the ingestion pipeline is for
unstructured content extraction. A fluid record is already structured, and
running it through extraction would invent entities from an idea's prose.

**Record mapping.** `content` ← `record.title` (the human-readable handle for
search); `memory_type` ← `record.kind`; `metadata` ← the whole normalized record.
The handle lives in `metadata.handle` and is the identity the seam cares about;
SmartMemory's `item_id` maps to the record's provider-assigned `id`, which the
contract already documents as provider-scoped and swap-unstable.

## File Plan

| File | Action | Change |
|---|---|---|
| lib/smartmemory-client.js | add | **Additive only.** Add `createItem`/`getItem`/`listItems`/`updateItem`/`deleteItem` + an `X-Workspace-Id` header option. Do not touch `health`/`ingest`/`search` — the shipped kitchen pipeline depends on them. |
| lib/fluid/smartmemory-provider.js | new | `SmartMemoryFluidProvider extends FluidProvider`; `STORAGE_CAP` only; `supportedKinds()` = `{idea}`. |
| lib/fluid/factory.js | edit | Replace the `smartmemory` hard-fail branch (`:91`) with construction; keep a `FluidConfigError` when `workspaceId` is unset. |
| test/fluid-smartmemory-provider.test.js | new | Provider suite against a real `node:http` stub. |
| test/smartmemory-client.test.js | edit | Extend the existing stub to cover the five new methods. |

`contracts/fluid-record.schema.json` is deliberately **not** in the plan: the
record contract is provider-agnostic by design, and a provider that needed to
change it would be evidence the seam was drawn wrong.

## Boundary Map

### S01: typed-record CRUD on the HTTP client
Produces:
  lib/smartmemory-client.js → createItem, getItem, listItems, updateItem, deleteItem (function)

Consumes: nothing (leaf node)

### S02: the SmartMemory fluid provider
Produces:
  lib/fluid/smartmemory-provider.js → SmartMemoryFluidProvider (class)

Consumes:
  from S01: lib/smartmemory-client.js → createItem, getItem, listItems, updateItem, deleteItem

## Test strategy

Mirrors `test/smartmemory-client.test.js:23` — a raw `node:http` stub the test
owns and closes, no express, no mocking library. That satisfies the real-backend
rule without requiring a live SmartMemory: the stub *is* the wire contract, and
every correction above becomes an assertion about what the adapter sends.

Load-bearing cases, chosen because each maps to a correction rather than to
coverage for its own sake:

- Every request carries `X-Workspace-Id`; missing config ⇒ `FluidConfigError` **before any fetch** (the `authHeader()` precedent at `smartmemory-client.js:64`).
- A 403 from the scope check surfaces as a named error, not a generic failure — this is C4's failure mode and the one a user will actually hit.
- `updateRecord` sends explicit `null`s so a cleared field is cleared (C7).
- `kind` cannot be changed, and the provider refuses before the wire (C6).
- `listRecords({kind})` does not rely on a `memory_type` list filter (C5).
- Capability absence still throws `FluidCapabilityUnavailable` — the seam's central invariant, inherited, asserted here so a future edit cannot quietly fake `recall`.

## Deferred / flagged

- **Workspace provisioning** (C4 option b) — filed, not built.
- **FOH-2 will need a write-scoped API key** for read-only recall (C8).
- **`position`/`joint` kind policy** — CONTESTED per S3a D12; irrelevant to FOH-1 (`idea` only), must be settled before any slice adds those kinds.
- **`decision` INDEXED vs FULL** — architecture.md's own flagged open item; not reached by FOH-1.
- Unrelated stray found while verifying: `lib/boundary-map.js:313` uses `\x00` as a dedup-key delimiter, which makes the whole file test as binary and invisible to `grep`. Deliberate, not a bug, but worth a follow-up since the Phase 5 verifier greps source files.

## Verification Table (Phase 5)

Every reference below was opened and read this session. SmartMemory-side rows
marked **direct** were verified by reading the service repo here, not accepted
from the research pass — the four that change adapter code, plus C4 which drives
the open decision.

| Ref | Claim | Result |
|---|---|---|
| `lib/fluid/factory.js:91` | `if (name === 'smartmemory')` hard-fail branch | ✅ exact |
| `lib/smartmemory-client.js:64` | `authHeader()` throws before any fetch | ✅ exact (`// throws BEFORE any fetch`) |
| `lib/smartmemory-client.js:138` | module returns only `{health, ingest, search}` | ✅ exact |
| `test/smartmemory-client.test.js:23` | `makeStub` — raw `node:http`, no express | ✅ exact |
| `8a6b687:201-202` | S1's `config.store` injection (now removed) | ✅ exact, via `git show` |
| `lib/boundary-map.js:313` | `\x00` dedup-key delimiter | ✅ exact |
| `service.py:451` | crud router mounted at `prefix="/memory"` | ✅ **direct** — C2 confirmed |
| `crud.py:742` | `@router.get("/list")` is the enumeration route | ✅ **direct** — C3 confirmed |
| `crud.py:637` | `@router.get("/entities")` takes `prefix`/`limit` — autocomplete, not a record read | ✅ **direct** — C3 confirmed |
| `crud.py:1003` | `update_memory` "(partial merge)"; `properties` wins; metadata **deep**-merged | ✅ **direct** — C7 confirmed *and corrected* (research said "top-level"; the code says deep-merge, which makes the consequence stronger) |
| `scope_provider.py:~72` | `memory_type` in the stripped/server-controlled field list | ✅ **direct** — C6 confirmed |
| `scope.py:81` | `extract_team_context` reads `X-Workspace-Id` | ✅ **direct** — C4 header name confirmed |
| `scope.py:145` | `validate_team_membership` raises `HTTPException(403)` on violation | ✅ **direct** — C4's gap confirmed; this is what makes option (a) necessary |
| `crud.py:373-382`, `crud.py:547-564`, `crud.py:1198-1264`, `request_models.py:58-79`, `memory_item.py:54-68`, `scope.py:201-260` | body/response/scope shapes | ⚠️ **second-hand** — from the grounded research pass, not re-read here. They inform request shaping, which the `node:http` stub pins at implementation time; a wrong field surfaces as a failing test, not a silent defect. |

**Boundary Map validation:** `validateBoundaryMap` → `ok: true`, 0 violations,
0 warnings.

**Stale references found and fixed:** 0 in this blueprint. Three were found in
`architecture.md` during the resume check and corrected there before this
blueprint was written (sibling-status, the removed injected-store test pattern,
and the S3-parallelism claim), plus one contested decision flagged (`position`/
`joint` vs S3a D12).
