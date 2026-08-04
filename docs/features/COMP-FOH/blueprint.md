# COMP-FOH — Implementation Blueprint (FOH-1)

**Slice:** FOH-1 — `SmartMemoryFluidProvider`, storage-only
**Status:** Revised after review round 1 — pending gate approval
**Date:** 2026-08-04
**Revision:** r2. Round 1 returned five P1 findings; r1 was not implementable. See "Review round 1" at the foot.

## Related Documents

- Architecture: [architecture.md](architecture.md) — this blueprint grounds and corrects its Q1/Q2/Q3 sections.
- Design: [design.md](design.md)
- Seam it plugs into: [COMP-PLAN-IDEA-UNIFY](../COMP-PLAN-IDEA-UNIFY/design.md) — S1+S2+S3a shipped and pushed @5cfe013.
- S3a storage ruling this blueprint depends on: [s3-progress.md](../COMP-PLAN-IDEA-UNIFY/s3-progress.md) (D10, D12).

## Overlap check

`COMP-SMARTMEMORY-INGEST` and `COMP-SMARTMEMORY-RECALL` are **shipped** and both
use `lib/smartmemory-client.js` — the file S01 extends. No in-flight work, so the
risk is regression, not collision: S01 must be **purely additive** and must not
alter `health`/`ingest`/`search`.

`COMP-PLAN-IDEA-UNIFY` **S3b is in-flight in `lib/fluid/`**, on
`local-provider.js` and the CLI/API callers. S00 below extracts a shared helper
*out of* `local-provider.js`, which is the one place this blueprint and S3b touch
the same file. It is a small, mechanical extraction — do it first and land it
early to keep the window short.

## The seam this must satisfy

Re-read from `lib/fluid/provider.js` rather than assumed, because r1 got this
wrong:

- `STORAGE_CAP` is **three** capabilities — `RECORDS`, `EVENTS`, `LINKS`
  (`provider.js:35`). Declaring `STORAGE_CAP` and implementing only record CRUD
  declares capabilities the provider does not have, which is the one thing
  `PROVIDER-SEAM` forbids.
- Storage methods are **not** capability-gated the way semantic ones are — only
  semantic methods call `this.require()`. `appendEvent()` is therefore called
  internally by `createRecord()` regardless, so it must work, not merely be
  declared.
- Records are addressed by **handle** (`getRecord(handle)`, `provider.js:198`),
  never by provider id. The contract is explicit that `id` is provider-scoped
  and swap-unstable while `handle` survives a provider swap.
- A handle, once issued, is **never reused** — the tombstone invariant that the
  local floor implements with its append-only event log.

## Corrections table

Verified against real code this session. `crud.py`/`scope.py` are in the
SmartMemory repo; the rest are in this one.

| # | architecture.md assumed | Reality | Consequence |
|---|---|---|---|
| **C1** | "typed CRUD routes", "structured/typed-entity routes" (§Q2) | **No typed-entity CRUD API exists.** Generic **MemoryItem** CRUD, typed by a free-form `memory_type` string, payload in a free-form `metadata` object (`crud.py:373-382`, `memory_item.py:54-68`) | Q2's decision survives — extend the client, don't use `ingest()`. But storage is not schema-enforced, and the blueprint must not claim it is. Kind-genericity is therefore **free**, which C3b exploits. |
| **C2** | Paths `POST /add`, `GET /{item_id}`, … | Router mounted at `prefix="/memory"` (`service.py:451`) | Every path needs the `/memory` prefix. |
| **C3a** | `GET /entities` is part of the CRUD family | `GET /memory/entities` is **read-only autocomplete** over graph nodes (`crud.py:637`). The enumeration route is `GET /memory/list` (`crud.py:742`) | `listRecords()` uses `/memory/list`. Also kills the proposed method names (C10). |
| **C3b** | FOH-1 is "kind `idea` only" (§Sequencing) | **The pilot workload needs `cluster` too.** `import-ideabox.js` creates clusters *before* ideas ("clusters first: members reference them by handle"), and `render-ideabox.js:139` lists both kinds | `idea`-only would throw `FluidKindUnsupported` on the import's first cluster. Since C1 makes kinds free, FOH-1 supports **the floor's full set** — `idea, decision, thread, question, cluster` — so a provider swap is lossless rather than parity-gapped. |
| **C4** | Q1: "keyed by `resolveProjectTag()` … zero new identity scheme" | `X-Workspace-Id` is the right header (`scope.py:81`), but the value is validated against the principal's memberships and **403s on mismatch** (`validate_team_membership`, `scope.py:145`) | Ruled: configured id, fail loud. See the ruling below. |
| **C5** | — | `GET /memory/list` has **no `memory_type` filter**; only `metadata_key`/`metadata_value` (`crud.py:742`). It also **defaults to `limit=50`** | `listRecords()` filters by metadata and **must paginate**; r1 missed the default limit entirely. |
| **C6** | — | `memory_type` is server-controlled and stripped on update (`scope_provider.py:~72`) | Matches the seam's `UNPATCHABLE` `kind`. **Not** free alignment while `kind` is also duplicated inside mutable metadata — the two can diverge, so reads take `metadata.kind` and a test pins them equal. |
| **C7** | — | `PATCH` metadata merge is a **one-level spread**: `{**existing_metadata, **update_request.metadata}` (`crud.py:1052`). The comment three lines above claims "Deep-merge" and **is wrong about its own code**. If `properties` is supplied it wins outright | A top-level key omitted from a write **survives**; a nested key removed inside a top-level key that *is* sent is removed with it. Because the provider always sends every top-level record field (see S00), the practical effect is a full replace of the record's own fields. Explicit `null`s are still required for optional fields. r1 claimed "at any nesting depth" — **that was wrong**, see review round 1. |
| **C8** | — | API-key scopes derive from the **HTTP method** (`scope.py:201`): `GET`→`read:memories`, `POST`/`PATCH`→`write:memories`, `DELETE`→**`delete:memories`** | **Bites FOH-1, not just FOH-2.** r1 said scopes were FOH-2's problem; `deleteRecord` needs `delete:memories`. The configured key needs all three. FOH-2 additionally needs `write:memories` for a *read-only* recall, because `POST /memory/search` is a POST. |
| **C9** | — | Create returns **200, not 201** (`crud.py:547-564`) | Client must not assert 201. |
| **C10** | Method names `createEntity`/`getEntity`/… | "Entity" collides with the real, different `/memory/entities` | Renamed `createItem`/`getItem`/`listItems`/`updateItem`/`deleteItem`. |
| **C11** | "testable … injected-store style" | Removed by S3a (`8a6b687:201-202`) | Corrected in architecture.md; test strategy below uses the pattern that exists. |
| **C12** | — | `_normalize()` is a **private method of `LocalFluidProvider`** (`local-provider.js:211`), not part of the seam | The new provider does not inherit it. Contract defaults defined twice in two providers is a drift generator, so S00 extracts it. |
| **C13** | — | Embeddings are generated from `item.content` on add, and **`PATCH` does not refresh them** (`pipeline/stages/crud.py:121`, `:537`) | Drives the serialization decision below, and leaves a disclosed limitation for FOH-2. |

## Rulings

> **OWNER RULING 2026-08-04 (C4) — configured workspace id.** FOH-1 takes
> `fluid.smartmemory.workspaceId`. Absent ⇒ `FluidConfigError` naming the
> setting, raised **before any network call**. Provisioning filed, not built.
> `architecture.md` §Q1's "keyed by `resolveProjectTag()` … zero new identity
> scheme" is superseded — the isolation *decision* stands, its mechanism is
> configuration. `resolveProjectTag()` is not used.

> **DECISION D-FOH-1 (C13) — `content` is a searchable projection; `metadata` is
> the record.** `content` is a rendered text serialization (title, body, and
> discussion text) so that recall can actually reach an idea's prose;
> `metadata` carries the canonical structured record and is the only thing read
> back. This is the same canon/projection split the rest of the system uses —
> `ideabox.md` over fluid records, `REGISTER.md` over judgment records — applied
> one layer down.
>
> r1 mapped `content` ← `title` alone. That would have left FOH-2 semantically
> unable to recall body text while `architecture.md:71` declares ideas FULL, and
> the failure would only have appeared *after* FOH-2 shipped, as empty results.
>
> **Disclosed limitation, not solved here:** `PATCH` does not reindex, so an
> edited record keeps its original embedding. FOH-1 is storage-only, so nothing
> reads embeddings yet and nothing is broken today. **This is FOH-2's entry
> gate** — the same shape as durability being S3's — and FOH-2 must open by
> answering it rather than discovering it mid-slice. Options to weigh then: a
> reindex endpoint, an explicit re-add, or accepting staleness with a documented
> bound. Do not paper over it by deleting and recreating: that burns a handle,
> which the tombstone invariant forbids.
>
> **Implication for `architecture.md` §Q3:** FULL vs INDEXED per kind is not a
> pure policy dial — it depends on what lands in `content`. Noted there.

## Identity and storage scheme

r1 left this implicit and it was the largest hole. Stated explicitly:

| Fluid concept | SmartMemory representation |
|---|---|
| record identity (external) | `metadata.handle` — the only identity the seam uses |
| record `id` (contract-required) | **provider-assigned UUID in `metadata.id`**, generated before the POST, exactly as the floor does. **Not** SmartMemory's `item_id` — r1 mapped them together, which is circular: the contract requires `id` on the object being written, and `item_id` only exists after the write returns |
| SmartMemory `item_id` | an addressing detail, resolved from the handle per operation; never surfaced through the seam |
| namespace marker | `metadata.fluid_ns = 'compose.fluid.v1'` on every item — the analogue of the floor's `fluid_ext` presence check, so non-fluid MemoryItems are invisible to this provider |
| record kind | `memory_type` (server-controlled) **and** `metadata.kind` (canonical read) |
| lifecycle event | a **separate MemoryItem**, `memory_type = 'fluid_event'`, `metadata.fluid_ns = 'compose.fluid.events.v1'` |

**Handle → `item_id` resolution.** `GET /memory/list?metadata_key=handle&metadata_value=<HANDLE>`, filtered to the namespace marker, expecting exactly one. Zero ⇒ `FluidRecordNotFound`. **More than one ⇒ throw**, never pick the first: duplicate handles mean the store is corrupt, and silently choosing one would write to an arbitrary record — the same reasoning as S3a's filename↔handle identity check.

**Pagination.** `/memory/list` defaults to `limit=50`. Every enumeration (`listRecords`, handle allocation, the event scan) loops on `offset` until a short page or `total` is reached. A provider that silently sees only the first 50 ideas would under-report the ideabox and, once the projection is generated from it, **delete the rest from `ideabox.md`**.

**Events are separate items on purpose.** Storing events inside a record's metadata would destroy its tombstone when the record is deleted, and handle retirement is precisely what must outlive deletion. Events are written and never updated or deleted.

**Handle allocation** mirrors the floor: the issued set is live records ∪ every handle named in the event items, then `max + 1`, with a membership check on the candidate. **Known gap, inherited and disclosed:** no lock, so two concurrent creates can race the same handle — identical to the floor's accepted limit, and worse here because the check spans a network round trip. Tombstone-before-create still applies, so a lost race wastes a handle rather than reissuing one.

## Wire contract (as verified)

```
POST   /memory/add     {content, memory_type, metadata, use_pipeline:false}  → 200 {id, status, workspace_id}
GET    /memory/{id}                                                          → 200 {item_id, content, memory_type, metadata, …} | 404
GET    /memory/list    ?limit&offset&order&metadata_key&metadata_value       → 200 {items, total, limit, offset}
PATCH  /memory/{id}    {content?, metadata?, properties?}                    → 200 {status, item_id} | 400 | 403 | 404
DELETE /memory/{id}    ?cleanup_orphans=true                                 → 200 {status, item_id, garbage_collection?}
```

Every call carries `Authorization: Bearer <key>` and `X-Workspace-Id: <configured id>`.

`use_pipeline: false` is deliberate: the ingestion pipeline extracts entities
from unstructured prose. A fluid record is already structured, and extraction
would invent graph entities from an idea's body.

## Configuration contract

r1 specified only `workspaceId` and ignored where the endpoint comes from.

- `baseUrl` and `apiKeyEnv` are **reused from the existing top-level
  `smartmemory` config block** (`smartmemory-config.js:20`) — one source of
  truth for the endpoint, shared with the shipped kitchen pipeline. They are not
  duplicated under `fluid`.
- `fluid.smartmemory.workspaceId` is the only new setting.
- `factory.js` currently reads only the `fluid` block (`factory.js:63`), so it
  must also load the smartmemory block.
- **Fail loud, before any network call**, when the smartmemory block is absent
  or disabled, or `workspaceId` is unset — a `FluidConfigError` naming the exact
  missing setting. Precedent: `authHeader()` throwing pre-fetch
  (`smartmemory-client.js:64`) and the existing `smartmemory` stub at
  `factory.js:91`.
- The configured API key needs **`read:memories`, `write:memories` and
  `delete:memories`** (C8). Document this; a key missing `delete` fails only on
  `deleteRecord`, long after setup appears to have worked.

## File Plan

| File | Action | Change |
|---|---|---|
| lib/fluid/record-shape.js | new | Extract `normalizeRecord()` — the contract-default filling currently private to `LocalFluidProvider._normalize` (C12). Pure, no I/O. |
| lib/fluid/local-provider.js | refactor | Delegate `_normalize` to the shared helper. Behaviour-preserving; the 74 existing fluid tests are the gate. |
| lib/smartmemory-client.js | add | `createItem`/`getItem`/`listItems`/`updateItem`/`deleteItem` + `X-Workspace-Id` support. Additive only. |
| lib/fluid/smartmemory-provider.js | new | `SmartMemoryFluidProvider`; `STORAGE_CAP` (records, events, links); floor's five kinds; handle resolution, pagination, event items. |
| lib/fluid/factory.js | edit | Replace the `smartmemory` hard-fail (`:91`) with construction; load both config blocks; `FluidConfigError` on missing settings. |
| test/fluid-smartmemory-provider.test.js | new | Provider suite against a real `node:http` stub. |
| test/smartmemory-client.test.js | edit | Extend the existing stub for the five new methods. |

`contracts/fluid-record.schema.json` is deliberately **not** in the plan: the
record contract is provider-agnostic, and a provider needing to change it would
be evidence the seam was drawn wrong.

## Boundary Map

### S00: shared record normalization
Produces:
  lib/fluid/record-shape.js → normalizeRecord (function)

Consumes: nothing (leaf node)

### S01: typed-record CRUD on the HTTP client
Produces:
  lib/smartmemory-client.js → createItem, getItem, listItems, updateItem, deleteItem (function)

Consumes: nothing (leaf node)

### S02: the SmartMemory fluid provider
Produces:
  lib/fluid/smartmemory-provider.js → SmartMemoryFluidProvider (class)

Consumes:
  from S00: lib/fluid/record-shape.js → normalizeRecord
  from S01: lib/smartmemory-client.js → createItem, getItem, listItems, updateItem, deleteItem

## Test strategy

Mirrors `test/smartmemory-client.test.js:23` — a raw `node:http` stub the test
owns and closes. No express, no mocking library. The stub *is* the wire
contract, so every correction above becomes an assertion about what the adapter
sends.

Each case maps to a correction or a seam invariant, not to coverage for its own sake:

- Missing `workspaceId`, missing smartmemory block, or missing key ⇒ `FluidConfigError` **before any request reaches the stub** (C4, config contract).
- A 403 from the scope check surfaces as a named, actionable error — C4's real-world failure mode.
- Every request carries `X-Workspace-Id`.
- `getRecord` resolves by handle, not by `item_id`; **two items with the same handle ⇒ throws**, never picks one.
- Enumeration **paginates**: a stub holding 120 records returns all 120, not 50 (C5).
- A deleted record's handle is **not reissued** — the event item outlives the record (tombstone invariant).
- `updateRecord` sends explicit `null`s so a cleared field is cleared (C7).
- `kind` cannot be patched, and `memory_type` and `metadata.kind` agree (C6).
- `createRecord` round-trips a record through `metadata` byte-for-byte, and `content` contains the body text (D-FOH-1).
- Capability absence still throws `FluidCapabilityUnavailable` — inherited, asserted so a later edit cannot quietly fake `recall`.
- The five floor kinds are all accepted (C3b), and the ideabox import's clusters-first ordering succeeds against this provider.

## Deferred / flagged

- **Workspace provisioning** (C4 option b) — filed, not built.
- **Reindex-on-update** (C13/D-FOH-1) — **FOH-2's entry gate.**
- **`position`/`joint` kind policy** — CONTESTED per S3a D12; out of scope, must be settled before any slice adds those kinds.
- **`decision` INDEXED vs FULL** — architecture.md's own open item; now coupled to D-FOH-1's serialization choice.
- **No lock on handle allocation** — inherited from the floor, widened by the network round trip.
- Unrelated stray: `lib/boundary-map.js:313` uses `\x00` as a dedup-key delimiter, making the file test as binary and invisible to `grep`.

## Review round 1

Codex (sol/xhigh) against r1. **Five P1 findings, all upheld**; r1 was not
implementable. Recorded because three of them would otherwise have been
rediscovered during implementation, and one only after FOH-2 shipped.

| # | Finding | Resolution in r2 |
|---|---|---|
| F1 | Declared `STORAGE_CAP` but designed only record CRUD — no events, no links | "The seam this must satisfy" + events as separate items + links ride in the record |
| F2 | Handle-addressed seam vs `item_id`-addressed service, with no scheme; `metadata ← normalized record` circular because the contract requires `id` before the POST assigns one | "Identity and storage scheme" — provider-assigned `id`, handle resolution, namespace marker, pagination, allocation |
| F3 | `idea`-only cannot serve the pilot: the import creates clusters first | C3b — full floor kind set, which C1 makes free |
| F4 | Config/credential contract incomplete; `DELETE` needs `delete:memories` | "Configuration contract" + C8 corrected |
| F5 | `content ← title` defeats FOH-2's recall; `PATCH` does not reindex | **D-FOH-1**, with reindexing named as FOH-2's entry gate |
| F6 (P2) | C7's "deep merge" was wrong — the code is a one-level spread and its own comment lies; `_normalize` is not on the seam | C7 rewritten; C12 added; S00 extracts the helper |

**On F6:** r1 "corrected" the research pass from a code *comment* that
contradicts the code three lines below it (`crud.py:1046` vs `:1052`). The
original research was right and the correction was wrong. Verified directly this
round.

## Verification Table (Phase 5)

Every reference below was opened and read this session. Rows marked **direct**
were verified by reading the SmartMemory repo here rather than accepted from the
research pass — the ones that change adapter code, plus C4 which drives a ruling.

| Ref | Claim | Result |
|---|---|---|
| `lib/fluid/provider.js:35` | `STORAGE_CAP` = RECORDS, EVENTS, LINKS | ✅ |
| `lib/fluid/provider.js:198` | records addressed by handle | ✅ |
| `lib/fluid/local-provider.js:211` | `_normalize` is provider-private | ✅ |
| `lib/fluid/factory.js:91` | `smartmemory` hard-fail branch | ✅ exact |
| `lib/fluid/factory.js:63` | factory reads only the `fluid` block | ✅ |
| `lib/smartmemory-client.js:64` | `authHeader()` throws before any fetch | ✅ exact |
| `lib/smartmemory-client.js:138` | exports only `{health, ingest, search}` | ✅ exact |
| `lib/smartmemory-config.js:20` | top-level `smartmemory` block holds baseUrl/apiKeyEnv | ✅ |
| `lib/fluid/import-ideabox.js:~73` | clusters created before ideas | ✅ **direct** — C3b |
| `lib/fluid/render-ideabox.js:139` | renderer lists ideas **and** clusters | ✅ **direct** — C3b |
| `test/smartmemory-client.test.js:23` | `makeStub`, raw `node:http` | ✅ exact |
| `8a6b687:201-202` | S1's removed `config.store` injection | ✅ via `git show` |
| `service.py:451` | crud router mounted at `/memory` | ✅ **direct** — C2 |
| `crud.py:742` | `/list` is enumeration; `limit` defaults to 50 | ✅ **direct** — C5 |
| `crud.py:637` | `/entities` is autocomplete | ✅ **direct** — C3a |
| `crud.py:1046` vs `crud.py:1052` | comment claims deep-merge; code is `{**existing, **new}` | ✅ **direct** — C7, corrects r1 |
| `scope_provider.py:~72` | `memory_type` server-controlled | ✅ **direct** — C6 |
| `scope.py:81` | `extract_team_context` reads `X-Workspace-Id` | ✅ **direct** — C4 |
| `scope.py:145` | `validate_team_membership` raises 403 | ✅ **direct** — C4 |
| `scope.py:201` | method→scope mapping incl. `delete:memories` | ✅ **direct** — C8 |
| `pipeline/stages/crud.py:121`, `:537` | embedding from `content`; PATCH does not reindex | ⚠️ **second-hand** — from review round 1's citations, not re-read. Load-bearing for D-FOH-1's disclosed limitation, **not** for FOH-1 code. Re-verify at FOH-2's entry gate, where it becomes decisive. |
| `crud.py:373-382`, `:547-564`, `request_models.py:58-79`, `memory_item.py:54-68` | body/response shapes | ⚠️ **second-hand** — informs request shaping, which the stub pins at implementation time; a wrong field fails a test rather than passing silently. |

**Boundary Map validation:** run below.

**Stale references found and fixed:** 0 in r2. Three were fixed in
`architecture.md` during the resume check; §Q1's mechanism and §Q3's coupling
are corrected there.
