# COMP-FOH — Implementation Blueprint (FOH-1)

**Slice:** FOH-1 — `SmartMemoryFluidProvider`, storage-only
**Status:** READY TO IMPLEMENT. r2's blocker was withdrawn on direct evidence (see "Review round 2").
**Date:** 2026-08-04
**Revision:** r3. r1 returned five P1 findings; r2 returned five more and stopped at a blocker that turned out to be false. See both review sections at the foot.

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
- **Absence is `null`, not a throw.** `getRecord` returns `null` on a miss
  (`local-provider.js:290-297`, which even treats a malformed handle as a miss).
  Only mutating paths — `updateRecord`, `deleteRecord`, `addLink`,
  `removeLink` — raise `FluidRecordNotFound` (`:411, :468, :498, :522, :539`).
  r2 had this backwards; see R2-3.

## Corrections table

Verified against real code this session. `crud.py`/`scope.py`/`codec.py` are in
the SmartMemory repo; the rest are in this one.

| # | architecture.md assumed | Reality | Consequence |
|---|---|---|---|
| **C1** | "typed CRUD routes", "structured/typed-entity routes" (§Q2) | **No typed-entity CRUD API exists.** Generic **MemoryItem** CRUD, typed by a free-form `memory_type` string (`crud.py:376` is a bare `Body("semantic")`), payload in a free-form `metadata` dict. `MEMORY_TYPES` is a registry set, but an unregistered value is a **warning** from a validator that is not on the write path (`memory_validator.py:96`), and storage is generic — `memory_type` becomes a graph label and property (`node_types.py:105, :126`), with no handler lookup | Q2's decision survives — extend the client, don't use `ingest()`. Kind-genericity is **free**, which C3b exploits. But storage is not schema-enforced and this blueprint must not claim it is. |
| **C2** | Paths `POST /add`, `GET /{item_id}`, … | Router mounted at `prefix="/memory"` (`service.py:451`) | Every path needs the `/memory` prefix. |
| **C3a** | `GET /entities` is part of the CRUD family | `GET /memory/entities` is **read-only autocomplete** over graph nodes (`crud.py:637`). The enumeration route is `GET /memory/list` (`crud.py:742`) | `listRecords()` uses `/memory/list`. Also kills the proposed method names (C10). |
| **C3b** | FOH-1 is "kind `idea` only" (§Sequencing) | **The pilot workload needs `cluster` too.** `import-ideabox.js` creates clusters *before* ideas ("clusters first: members reference them by handle"), and `render-ideabox.js:139` lists both kinds | `idea`-only would throw `FluidKindUnsupported` on the import's first cluster. Since C1 makes kinds free, FOH-1 supports **the floor's full set** — `idea, decision, thread, question, cluster`. |
| **C4** | Q1: "keyed by `resolveProjectTag()` … zero new identity scheme" | `X-Workspace-Id` is the right header (`scope.py:81`), but the value is validated against the principal's memberships and **403s on mismatch** (`validate_team_membership`, `scope.py:145`) | Ruled: configured id, fail loud. See the ruling below. |
| **C5** | — | `GET /memory/list` has **no `memory_type` filter**; only a **single** `metadata_key`/`metadata_value` pair, which must be supplied together (422 otherwise) and supports dotted nested keys (`crud.py:750-808`). It **defaults to `limit=50`** | `listRecords()` filters on one metadata key server-side, everything else client-side, and **must paginate**; r1 missed the default limit entirely. |
| **C6** | — | `memory_type` is server-controlled: it is in `PROTECTED_FIELDS` and stripped from any PATCH (`scope_provider.py:61-77`) | Matches the seam's `UNPATCHABLE` `kind`. **Not** free alignment while `kind` also lives inside mutable metadata — the two can diverge, so reads take the canonical record's `kind` and a test pins the derivation. |
| **C7** | — | `PATCH` metadata merge is a **one-level spread**: `{**existing_metadata, **update_request.metadata}` (`crud.py:1052`). The comment three lines above claims "Deep-merge" and **is wrong about its own code**. If `properties` is supplied it wins outright | A top-level metadata key omitted from a write **survives**; one that is sent is replaced wholesale. D-FOH-2 turns this from a hazard into the mechanism: one key, replaced whole, is exactly a full-record write. |
| **C8** | — | API-key scopes derive from the **HTTP method** (`scope.py:201`): `GET`→`read:memories`, `POST`/`PATCH`→`write:memories`, `DELETE`→**`delete:memories`** | **Bites FOH-1, not just FOH-2.** r1 said scopes were FOH-2's problem; `deleteRecord` needs `delete:memories`. The configured key needs all three. |
| **C9** | — | Create returns **200, not 201** (`crud.py:547-564`) | Client must not assert 201. |
| **C10** | Method names `createEntity`/`getEntity`/… | "Entity" collides with the real, different `/memory/entities` | Renamed `createItem`/`getItem`/`listItems`/`updateItem`/`deleteItem`. |
| **C11** | "testable … injected-store style" | Removed by S3a (`8a6b687:201-202`) | Corrected in architecture.md; test strategy below uses the pattern that exists. |
| **C12** | — | `_normalize()` is a **private method of `LocalFluidProvider`** (`local-provider.js:211`), not part of the seam | The new provider does not inherit it. Contract defaults defined twice in two providers is a drift generator, so S00 extracts it. C14 gives it a second, larger job. |
| **C13** | — | Embeddings are generated from `item.content` on add, and **`PATCH` does not refresh them** (`pipeline/stages/crud.py:123-127`) | Drives D-FOH-1, and leaves a disclosed limitation for FOH-2. |
| **C14** | — | **Structured metadata does not survive a round trip intact.** Graph storage runs `flatten_dict_safe(props, sep="__")` (`utils/__init__.py:10-38`): a nested dict whose keys are all safe identifiers is **exploded into `parent__child` graph properties**, and empty dicts are **dropped**. `update_memory_node` additionally **hoists the existing item's `metadata` keys to top level** in merge mode (`crud.py:469-474`), so repeated PATCHes accumulate a stale shadow copy alongside the live one | **This is the deep version of R2-2, and nesting alone does not fix it.** Drives **D-FOH-2**: the canonical record is stored as one opaque JSON string, not as structured metadata. |
| **C14b** | — | **A field cannot be cleared through the convenience PATCH surface.** `_is_valid_property` **skips** `None` **and empty-string** values before the write (`falkordb.py:2992-2999`), and the write emits one `SET n.key = $v` per surviving property — so a field sent as `null` or `""` is not deleted, it is **omitted, and the previous value survives**. Only `write_mode: "replace"` clears, by REMOVEing existing keys first (`falkordb.py:615-640`) — and via the convenience surface that would also wipe `content`, since replace rebuilds the node from the caller's dict alone (`crud.py:489-513`) | **Corrects r2 and r3-draft, both of which asserted "explicit `null`s clear a field."** They do not. **D-FOH-2 makes this moot for FOH-1**: a record is one non-empty string, always written, always replacing the previous one — clearing a field inside the record is just a different string. This is the strongest argument for the blob and the reason the mapping is not merely a fidelity preference. |
| **C16** | — | **Immutability is not on the seam.** `UNPATCHABLE` — `handle, kind, provenance, discussion, id, created_at, updated_at` — is a module-private const in `local-provider.js:83-85`, enforced only by that provider's `updateRecord` (`:417`). `provider.js` neither defines nor mentions it | **The same defect class as C12, with worse consequences.** A second provider inherits nothing: FOH-1 could silently accept a patch to `discussion` or `provenance` and erase the append-only evidence trail, which the floor's own comment calls "the dangerous half". S00 extracts the rule alongside `normalizeRecord`; FOH-1 must not re-implement it. |
| **C15** | — | `decision` is **already a registered SmartMemory memory_type** with its own meaning (`memory_item.py:23`, "Conclusions, inferences, choices with provenance") | A fluid `decision` would be indistinguishable from a native one, and the per-kind embedding key (`enable_decision`) would change behaviour for **native** decision items across the whole deployment. Drives **D-FOH-3**: namespace the wire type as `fluid_<kind>`. |

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
> gate.** Do not paper over it by deleting and recreating: that burns a handle,
> which the tombstone invariant forbids.

> **DECISION D-FOH-2 (C14, resolves R2-2) — the canonical record is one opaque
> JSON string.** `metadata.fluid_record_json` holds `JSON.stringify(record)`.
> Beside it sit exactly three flat string fields — `handle`, `kind`, `fluid_ns`
> — which exist only so the store can be *filtered*, never so it can be *read
> from*. The record is reconstructed by parsing the blob and nothing else.
>
> **Why opaque rather than nested.** r2 stored the record flat in `metadata` and
> promised a byte-for-byte round trip; R2-2 showed `created_at` alone breaks
> that. Nesting under `metadata.fluid_record` — R2-2's proposed fix — dodges the
> protected-field strip (it is one level deep only, `secure_smart_memory.py:1877`)
> but **not** C14: `flatten_dict_safe` recurses into any sub-dict whose keys are
> safe identifiers, so a nested record is exploded into graph properties anyway,
> empty containers vanish, and merge-mode hoisting leaves a stale shadow copy.
> A string is inert to every one of those paths.
>
> **And it is the only mapping in which a field can be cleared at all** (C14b).
> Nulls and empty strings are dropped before the write and the surviving
> properties are SET individually, so under any structured mapping a cleared
> field silently keeps its old value and the API still returns 200. The blob is
> never null and never empty, so it is always written and always replaces its
> predecessor whole. This is a correctness requirement, not a fidelity
> preference.
>
> The codec makes this exact case safe on purpose: a bare string that *looks*
> like JSON is marker-escaped on write and handed back **verbatim** on read
> (`codec.py:99-116, :148-159`) — the round trip is byte-stable by construction
> rather than by hope.
>
> With C7's one-level spread, a PATCH carrying only `fluid_record_json` replaces
> the whole record and leaves every server-owned metadata key untouched. One key,
> replaced whole, *is* a full-record write — the merge semantics stop being a
> hazard and become the mechanism.
>
> **Consequence for immutability — the provider becomes the sole enforcer.**
> Server-side, `memory_type` is in `PROTECTED_FIELDS` and stripped from every
> PATCH, so it is frozen at creation; the blob is opaque, so the server cannot
> see `kind` inside it. If `updateRecord` ever let `kind` change, the item would
> diverge permanently: `memory_type` stuck at `fluid_cluster` while the blob
> claims `idea`. Reads take `kind` from the blob, so the record would present as
> an idea while its **embedding policy still follows cluster's key** (Ruling Q3
> derives `enable_<memory_type>` from the frozen wire type) — a silent
> recallability bypass by relabeling. `kind` is already `UNPATCHABLE` (C16); the
> point is that nothing *below* the provider will catch a violation, so the
> shared rule and its test are load-bearing rather than belt-and-braces.
>
> **Cost, accepted:** the record's fields are opaque to SmartMemory's graph, so
> there is no server-side query on `priority` or `status`. This costs nothing
> today: `/memory/list` accepts a **single** filter pair (C5), the local floor
> already filters client-side (`local-provider.js:300-305`), and the seam
> exposes no field-query API. If a future slice needs server-side field queries,
> it promotes specific fields to flat siblings — additive, and the blob stays
> canonical.

> **DECISION D-FOH-3 (C15) — the wire type is `fluid_<kind>`, never the bare
> kind.** `memory_type` is `fluid_idea`, `fluid_cluster`, `fluid_decision`,
> `fluid_thread`, `fluid_question`; events are `fluid_event`. The seam's `kind`
> stays bare inside the record and in the flat `kind` filter field.
>
> Two reasons, both load-bearing. **(1)** `decision` already means something
> else in SmartMemory (C15), so a bare kind silently merges two populations in
> one workspace. **(2)** The per-kind embedding key is derived from
> `memory_type` (`enable_<memory_type>`, `pipeline/stages/crud.py:188`), so a
> bare kind would make Compose's recallability policy for `decision` rewrite
> embedding behaviour for **native** SmartMemory decisions deployment-wide.
> Prefixing keeps the blast radius inside Compose's own namespace.
>
> A test pins `memory_type === 'fluid_' + record.kind` so the derivation cannot
> drift; reads take `kind` from the parsed blob (C6).

> **DECISION D-FOH-4 (resolves R2-4) — duplicate handles are repaired, never
> fatal.** Handle allocation has no lock, and SmartMemory has no uniqueness
> constraint on a metadata field, so two concurrent creates can produce two live
> items carrying one handle. r2's rule was "more than one ⇒ throw", which makes
> that state **permanently unreadable**. Replaced with:
>
> - **Read paths are deterministic and never write.** On >1 match, the record for
>   that handle is the one with the earliest server-stamped
>   `metadata.created_at`, ties broken by lexicographic `item_id` for a total
>   order. Warn; do not throw. (The server stamps `created_at` itself on every
>   add — `secure_smart_memory.py:343` — so the tie-break uses one clock, not
>   each client's. The write that broke r2's flat mapping is what makes this
>   sound.)
> - **Mutating paths repair first.** Before writing, a duplicate is resolved by
>   keeping the earliest and reassigning each later item a freshly allocated
>   handle, with a `reassigned` event appended so the trail is auditable.
>
> This is **strictly better than the local floor**, where two racing creates
> collide on one path and one idea is silently lost. r2's claim that the remote
> race "matches the floor's accepted limit" was wrong in the other direction too
> — it was worse than the floor, and is now better. Nothing is silently
> discarded, and no handle is ever reissued.

> **RULING Q3 (resolves R2-1) — per-kind recallability is expressible but not
> enforceable from Compose. FOH-1 discloses; FOH-2 enforces.** r2 blocked on
> "per-kind recallability is not controllable over HTTP." **That is false.**
> `_should_generate_embedding` does not stop at the hard-coded lists — six lines
> further on it falls through to configuration:
>
> ```python
> embedding_cfg = get_config("embeddings") or {}
> return embedding_cfg.get(f"enable_{memory_type}", True)   # crud.py:187-188
> ```
>
> `memory_type` is the fluid wire type (D-FOH-3), and `use_pipeline: false`
> reaches this path with no `_embed` or `_strategy` kwarg (`crud.py:539` →
> `add(memory_item)`), so §Q3's policy maps directly onto
> `enable_fluid_cluster=false`, `enable_fluid_decision=false`,
> `enable_fluid_event=false`, `enable_fluid_idea=true`.
>
> Three caveats keep this a **disclosure, not a guarantee**, and all three are
> the same shape — the dial is real but Compose does not hold it:
>
> - **It fails open.** The default is `True` (`.get(key, True)`), so an
>   unconfigured deployment embeds everything, including `fluid_event` items.
> - **It is global server config, not per-request.** Compose's kind policy has to
>   be mirrored in SmartMemory's deployment config across two repos, and
>   **nothing enforces agreement**; drift silently flips a kind's recallability.
>   It also cannot vary per workspace.
> - **The keys are latent.** `crud.py:187-188` is the only reader and nothing in
>   either repo sets them, so the path is effectively unexercised in production.
>
> FOH-1 is storage-only, so nothing reads embeddings yet: the cost of
> over-embedding today is wasted embedding calls, not wrong answers. **FOH-2
> owns enforcement**, alongside the reindexing gate it already owns — the two are
> the same question asked twice. FOH-1's obligations are to document the required
> deployment keys and to keep `fluid_event` out of the recall surface by name.
>
> The durable fix is upstream: expose `_embed` on `POST /memory/add`, which turns
> a global fail-open config into an explicit per-request flag. See "Upstream ask".

## Identity and storage scheme

| Fluid concept | SmartMemory representation |
|---|---|
| record identity (external) | `metadata.handle` — flat string, the only identity the seam uses, and the one filterable lookup key |
| the record itself | **`metadata.fluid_record_json`** — `JSON.stringify(record)`, opaque, canonical, the only thing parsed on read (D-FOH-2) |
| record `id` (contract-required) | **provider-assigned UUID inside the blob**, generated before the POST, exactly as the floor does. **Not** SmartMemory's `item_id` — r1 mapped them together, which is circular: the contract requires `id` on the object being written, and `item_id` only exists after the write returns |
| SmartMemory `item_id` | an addressing detail, resolved from the handle per operation; never surfaced through the seam |
| namespace marker | `metadata.fluid_ns = 'compose.fluid.v1'` on every item — the analogue of the floor's `fluid_ext` presence check, so non-fluid MemoryItems are invisible to this provider |
| record kind | `memory_type = 'fluid_' + kind` (server-controlled, D-FOH-3), `metadata.kind` flat for filtering, and `kind` inside the blob as the canonical read |
| lifecycle event | a **separate MemoryItem**, `memory_type = 'fluid_event'`, `metadata.fluid_ns = 'compose.fluid.events.v1'`, payload in `metadata.fluid_event_json` |

**Handle → `item_id` resolution.** `GET /memory/list?metadata_key=handle&metadata_value=<HANDLE>`,
then filtered client-side to the namespace marker — the route accepts only one
filter pair (C5), so the namespace check cannot ride along server-side. Zero
matches ⇒ `null` from `getRecord`, `FluidRecordNotFound` from mutating paths
(R2-3). More than one ⇒ D-FOH-4.

**Provenance has two layers, and they can disagree.**

| Layer | Where | Who writes it | Mutability |
|---|---|---|---|
| **client-asserted** | `provenance{origin, recorded_at, author}`, `id`, `created_at` — inside the blob | the provider | untouched by the server (the protected-field strip is one level deep), so it round-trips exactly — and is **not attested by anything** |
| **server-attested** | top-level `metadata.created_at`, `origin`, `created_by`, `workspace_id` | SmartMemory, unconditionally on add (`secure_smart_memory.py:343`) | in `PROTECTED_FIELDS` — **unwritable by any client, therefore immutable by policy** |

**Rule: when the two disagree, server-attested wins for ordering; client-asserted
is the record's own account of itself.** D-FOH-4's duplicate tie-break uses the
server-attested `created_at` deliberately — one clock, not each client's, and one
a racing writer cannot forge. The blob's `provenance.recorded_at` is evidence
about authorship, not a timestamp the system trusts for sequencing.

**Reads always re-normalize.** Every record parsed out of a blob goes through
S00's `normalizeRecord()` before it leaves the provider. This is not defensive
padding: it is what makes a record written by an older build, or by the floor and
imported, satisfy today's contract without a migration. C14's null-and-empty
erasure is neutralized by D-FOH-2, but normalization is the second line and costs
nothing.

**Pagination.** `/memory/list` defaults to `limit=50`. Every enumeration
(`listRecords`, handle allocation, the event scan) loops on `offset` until a
short page or `total` is reached. A provider that silently sees only the first 50
ideas would under-report the ideabox and, once the projection is generated from
it, **delete the rest from `ideabox.md`**.

**Events are separate items on purpose.** Storing events inside a record's
metadata would destroy its tombstone when the record is deleted, and handle
retirement is precisely what must outlive deletion. Events are written and never
updated or deleted.

**Handle allocation** mirrors the floor: the issued set is live records ∪ every
handle named in the event items, then `max + 1`, with a membership check on the
candidate. Tombstone-before-create still applies, so a lost race wastes a handle
rather than reissuing one, and a collision is repaired per D-FOH-4 rather than
becoming permanent.

## Wire contract (as verified)

```
POST   /memory/add     {content, memory_type, metadata, use_pipeline:false}  → 200 {id, status, workspace_id}
GET    /memory/{id}                                                          → 200 {item_id, content, memory_type, metadata, …} | 404
GET    /memory/list    ?limit&offset&order&metadata_key&metadata_value       → 200 {items, total, limit, offset}
PATCH  /memory/{id}    {content?, metadata?, properties?}                    → 200 {status, item_id} | 400 | 403 | 404
DELETE /memory/{id}    ?cleanup_orphans=true                                 → 200 {status, item_id, garbage_collection?}
```

Every call carries `Authorization: Bearer <key>` and `X-Workspace-Id: <configured id>`.

`use_pipeline: false` is deliberate, and now doubly so: the ingestion pipeline
extracts entities from unstructured prose — a fluid record is already structured,
and extraction would invent graph entities from an idea's body. It is also the
branch that reaches the plain `add()` path Q3's config dial lives on.

**PATCH sends `metadata: {fluid_record_json, handle, kind, fluid_ns}` and never
`properties`.** The `properties` surface bypasses the metadata merge entirely
(`crud.py:1037-1039`) and hands the caller the full node property dict, which is
the mass-assignment surface `PROTECTED_FIELDS` exists to guard. The convenience
surface is both safer and sufficient.

## Configuration contract

- `baseUrl` and `apiKeyEnv` are **reused from the existing top-level
  `smartmemory` config block** (`smartmemory-config.js:20`) — one source of
  truth for the endpoint, shared with the shipped kitchen pipeline. They are not
  duplicated under `fluid`.
- `fluid.smartmemory.workspaceId` is the only new setting.
- `factory.js` currently reads only the `fluid` block (`factory.js:63`), so it
  must also load the smartmemory block.
- **Pre-flight validation covers all four things, before any network call**
  (R2-5): the smartmemory block is present and enabled, `baseUrl` is set,
  `apiKeyEnv` is set, **and `process.env[apiKeyEnv]` is non-empty**, plus
  `workspaceId`. Each failure raises `FluidConfigError` naming the exact missing
  setting. Validating only the first two is what r2 specified, and it is not
  enough: the client interpolates `cfg.baseUrl` directly into the URL
  (`smartmemory-client.js:31`), so an unset endpoint currently fails as
  `fetch("undefined/memory/add")` — a network error blaming the server for a
  local misconfiguration. Precedent for the shape: `authHeader()` throwing
  pre-fetch (`smartmemory-client.js:64`).
- The configured API key needs **`read:memories`, `write:memories` and
  `delete:memories`** (C8). Document this; a key missing `delete` fails only on
  `deleteRecord`, long after setup appears to have worked.
- **Deployment-side, in SmartMemory, not Compose:** `embeddings.enable_fluid_event=false`
  and the per-kind keys from §Q3. Documented as a required deployment step with
  its fail-open default called out (Ruling Q3).

## File Plan

| File | Action | Change |
|---|---|---|
| lib/fluid/record-shape.js | new | Extract **two** provider-private rules that are actually seam-wide: `normalizeRecord()` (contract-default filling, C12 — now also the read-side normalizer for every record parsed out of a blob) and `assertPatchable()` over the shared `UNPATCHABLE` list (C16). Pure, no I/O. |
| lib/fluid/local-provider.js | refactor | Delegate `_normalize` and its `UNPATCHABLE` check to the shared helpers. Behaviour-preserving; the 74 existing fluid tests are the gate. |
| lib/smartmemory-client.js | add | `createItem`/`getItem`/`listItems`/`updateItem`/`deleteItem` + `X-Workspace-Id` support. Additive only. |
| lib/fluid/smartmemory-provider.js | new | `SmartMemoryFluidProvider`; `STORAGE_CAP` (records, events, links); floor's five kinds; blob mapping, handle resolution, pagination, event items, duplicate repair. |
| lib/fluid/factory.js | edit | Replace the `smartmemory` hard-fail (`:91`) with construction; load both config blocks; `FluidConfigError` on missing settings. |
| test/fluid-smartmemory-provider.test.js | new | Provider suite against a real `node:http` stub. |
| test/smartmemory-client.test.js | edit | Extend the existing stub for the five new methods. |

`contracts/fluid-record.schema.json` is deliberately **not** in the plan: the
record contract is provider-agnostic, and a provider needing to change it would
be evidence the seam was drawn wrong.

## Boundary Map

### S00: shared record normalization and patch rules
Produces:
  lib/fluid/record-shape.js → normalizeRecord, assertPatchable (function)

Consumes: nothing (leaf node)

### S01: typed-record CRUD on the HTTP client
Produces:
  lib/smartmemory-client.js → createItem, getItem, listItems, updateItem, deleteItem (function)

Consumes: nothing (leaf node)

### S02: the SmartMemory fluid provider
Produces:
  lib/fluid/smartmemory-provider.js → SmartMemoryFluidProvider (class)

Consumes:
  from S00: lib/fluid/record-shape.js → normalizeRecord, assertPatchable
  from S01: lib/smartmemory-client.js → createItem, getItem, listItems, updateItem, deleteItem

## Test strategy

Mirrors `test/smartmemory-client.test.js:23` — a raw `node:http` stub the test
owns and closes. No express, no mocking library. The stub *is* the wire
contract, so every correction above becomes an assertion about what the adapter
sends.

Each case maps to a correction, a ruling, or a seam invariant:

- Missing `workspaceId`, missing smartmemory block, missing `baseUrl`, missing
  `apiKeyEnv`, or an **empty env value** ⇒ `FluidConfigError` naming that
  setting, **before any request reaches the stub** (C4, R2-5).
- A 403 from the scope check surfaces as a named, actionable error — C4's real-world failure mode.
- Every request carries `X-Workspace-Id`.
- `getRecord` on an unknown handle returns **`null`**; `updateRecord`,
  `deleteRecord`, `addLink` and `removeLink` on one throw `FluidRecordNotFound` (R2-3).
- **Round-trip fidelity under D-FOH-2**, the test that would have caught R2-2 and
  C14: a record carrying `null` optional fields, an empty `tags` array, an empty
  `discussion`, a nested `provenance`, and a body whose text is literally
  `{"a": 1}` comes back **deep-equal**. The stub echoes stored metadata verbatim.
- The server stamping its own `metadata.created_at` does **not** alter the
  record's `created_at` (R2-2 directly).
- Two successive `updateRecord` calls leave no stale field: a value cleared in
  the second write reads back cleared, and an optional field set to `null` or
  `""` does **not** resurrect its previous value (C7/C14b — the assertion that
  would have caught the clearing bug had FOH-1 stored fields structurally).
- `getRecord` resolves by handle, not `item_id`; **two items with the same handle
  resolve deterministically to the earliest** and a mutating call **repairs**
  them, reassigning the later a fresh handle plus an event (D-FOH-4).
- Enumeration **paginates**: a stub holding 120 records returns all 120, not 50 (C5).
- A deleted record's handle is **not reissued** — the event item outlives the record.
- `memory_type` is `fluid_<kind>` on the wire for all five kinds, and the record's
  `kind` is read from the blob, not from `memory_type` (C6, D-FOH-3, C15).
- **Every `UNPATCHABLE` field is refused, by the shared rule** — patching
  `discussion` or `provenance` throws rather than erasing the evidence trail, and
  a `kind` change throws rather than creating a `memory_type`/blob divergence
  that would silently keep the old embedding policy (C16, D-FOH-2). The same
  assertion runs against both providers, so the two cannot drift.
- The record's own `provenance` and `created_at` survive a create-then-read
  unchanged, while the server's independently stamped `metadata.created_at` is
  present and used for ordering — the two layers coexist and do not overwrite
  each other.
- `createRecord` puts title, body and discussion text in `content` (D-FOH-1).
- Capability absence still throws `FluidCapabilityUnavailable` — inherited, asserted so a later edit cannot quietly fake `recall`.
- The ideabox import's clusters-first ordering succeeds against this provider (C3b).

## Deferred / flagged

- **Workspace provisioning** (C4 option b) — filed, not built.
- **Reindex-on-update** (C13/D-FOH-1) — **FOH-2's entry gate.**
- **Per-kind embedding enforcement** (Ruling Q3) — FOH-2, same gate.
- **Upstream `_embed` on the add route** — see below; optional, and FOH-1 ships without it.
- **`position`/`joint` kind policy** — CONTESTED per S3a D12; out of scope, must be settled before any slice adds those kinds. FOH-1 does not add them.
- **`decision` INDEXED vs FULL** — architecture.md's own open item; coupled to D-FOH-1's serialization choice.
- **No lock on handle allocation** — inherited from the floor, widened by the network round trip, mitigated (not removed) by D-FOH-4.
- **Server-side field queries on records** — foreclosed by D-FOH-2's opacity; reopened additively by promoting a field to a flat sibling if a slice needs it.
- Unrelated stray: `lib/boundary-map.js:313` uses `\x00` as a dedup-key delimiter, making the file test as binary and invisible to `grep`.

## Blast radius of C14/C14b (who else is affected)

Asked directly, and worth recording because the answer is asymmetric.

**D-FOH-2's opacity affects nobody today.** Fluid records do not exist in
SmartMemory yet, and every Compose reader of them goes through the seam, which
parses the blob — so `handle`, `kind` and `fluid_ns` stay filterable and nothing
else was ever queryable. Two consequences are inherited rather than caused:
**FOH-2** must parse `fluid_record_json` out of search hits instead of reading
metadata fields, and any SmartMemory UI that renders item metadata will show one
opaque string for fluid items. Neither blocks anything.

**C14b's clearing bug affects existing SmartMemory consumers, and is not ours.**
Any caller that PATCHes `metadata: {field: null}` or `{field: ""}` expecting a
clear gets a 200 and no change. Compose is **not exposed today**: both shipped
consumers (`lib/smartmemory-sync.js`, `smartmemory-client.js`) are POST-only —
`ingest` and `search`, no update path (`smartmemory-client.js:68, :106`). FOH-1
would be Compose's first PATCH caller, and D-FOH-2 immunizes it. The exposure
belongs to whichever other SmartMemory consumers do issue metadata updates, which
is why it is worth reporting upstream rather than only routing around.
**Filed 2026-08-04: [smart-memory-core#3](https://github.com/smart-memory/smart-memory-core/issues/3)**
(core, not the service — the filter is in the FalkorDB backend). The report
includes the one-way `valid_end_time` consequence below.

**Provenance and immutability are the parts C14b does *not* touch**, and the
asymmetry is worth stating because it looks alarming and is not:

- **Provenance cannot be erased by this bug, because it cannot be written at
  all.** `created_at`, `origin`, `created_by`, `workspace_id`, `memory_type` are
  in `PROTECTED_FIELDS` and stripped from every PATCH. No write path, therefore
  no clearing path. Server-attested provenance is immutable by policy, not by
  luck.
- **The append-only structures are immune by construction.** Fluid events are
  written once and never updated or deleted, so tombstones — and therefore handle
  retirement — cannot be affected. `discussion` and `provenance` are
  `UNPATCHABLE` (C16) and never reach a write.
- **The casualties are exactly the mutable optional fields** — `priority`,
  `status_label`, `cluster`, `killed` — which is precisely what D-FOH-2 fixes.
- **One genuine one-way door upstream, which is ours to report and not to
  route around:** `valid_end_time` is *not* protected, so a caller can set a
  bi-temporal expiry and never unset it. Immutability-by-accident is not the same
  as immutability-by-design, and this is the case where the accident bites.

## Upstream ask (SmartMemory)

**Filed 2026-08-04: [smart-memory-service#3](https://github.com/smart-memory/smart-memory-service/issues/3).** Optional, not a blocker. Expose `_embed` on `POST /memory/add`.

It belongs to **smart-memory-service** (the route), *not* core: `_embed` already
exists in core as a handler-level override (`pipeline/stages/crud.py:100`, and
`:158` records a past bug where a caller's `_embed=false` was ignored), and the
non-pipeline branch calls `add(memory_item)` with no kwargs (`crud.py:539`), so
it is a small thread-through of one optional body field.

Value: removes the cross-repo config coupling in Ruling Q3, converting a global
fail-open deployment setting into an explicit per-request flag that Compose
controls. **Zero required SmartMemory core features** — FOH-1 ships against the
API exactly as it stands today.

## Review round 1

Codex (sol/xhigh) against r1. **Five P1 findings, all upheld**; r1 was not
implementable.

| # | Finding | Resolution |
|---|---|---|
| F1 | Declared `STORAGE_CAP` but designed only record CRUD — no events, no links | "The seam this must satisfy" + events as separate items + links ride in the record |
| F2 | Handle-addressed seam vs `item_id`-addressed service, with no scheme; `metadata ← normalized record` circular because the contract requires `id` before the POST assigns one | "Identity and storage scheme" — provider-assigned `id`, handle resolution, namespace marker, pagination, allocation |
| F3 | `idea`-only cannot serve the pilot: the import creates clusters first | C3b — full floor kind set, which C1 makes free |
| F4 | Config/credential contract incomplete; `DELETE` needs `delete:memories` | "Configuration contract" + C8 corrected |
| F5 | `content ← title` defeats FOH-2's recall; `PATCH` does not reindex | **D-FOH-1**, with reindexing named as FOH-2's entry gate |
| F6 (P2) | C7's "deep merge" was wrong — the code is a one-level spread and its own comment lies; `_normalize` is not on the seam | C7 rewritten; C12 added; S00 extracts the helper |

**On F6:** r1 "corrected" the research pass from a code *comment* that
contradicts the code three lines below it (`crud.py:1046` vs `:1052`). The
original research was right and the correction was wrong.

## Review round 2 — four findings upheld, blocker WITHDRAWN

Codex (sol/xhigh) against r2, pointed at the round-1 fixes. **Three of the five
were introduced or worsened by the round-1 fixes themselves**, which is the
expected pattern (`feedback_review_round2_targets_fixes`). r2 then stopped at a
self-declared blocker and escalated to the architecture gate. **The blocker does
not survive contact with the code, and the escalation is withdrawn.**

| # | Finding | Verdict after r3's verification |
|---|---|---|
| R2-1 | Widening kinds (F3) + bodies in `content` (F5) break the INDEXED contract; per-kind recallability is not controllable over HTTP | **PARTLY UPHELD — blocker WITHDRAWN.** The mechanism exists (`enable_<memory_type>`, `crud.py:187-188`); r2's own reading stopped six lines short of it. The real problem is weaker and different: the dial fails open, is global, and is latent. **Ruling Q3** — FOH-1 discloses, FOH-2 enforces. D-FOH-3 additionally stops the dial from leaking onto native `decision` items (C15). |
| R2-2 | The flat metadata mapping cannot round-trip — the server overwrites `metadata.created_at` on add and strips it from PATCH | **UPHELD, and understated.** Its proposed fix (nest under `metadata.fluid_record`) dodges the strip but not `flatten_dict_safe` (C14), which explodes nested dicts into graph properties and erases nulls and empty containers. Resolved by **D-FOH-2** — one opaque JSON string. |
| R2-3 | `getRecord` miss semantics are backwards — the seam returns `null` on absence and throws only from mutating paths | **UPHELD.** Corrected in "The seam this must satisfy" and pinned by a test. |
| R2-4 | The allocation race corrupts the remote store rather than wasting a handle, and r2's "more than one ⇒ throw" makes it permanent | **UPHELD.** Resolved by **D-FOH-4** — deterministic earliest-wins on read, repair on write. r2 was wrong in both directions: the remote race is worse than the floor's, and r2's handling made it unrecoverable. |
| R2-5 | Endpoint validation still incomplete — `baseUrl`, `apiKeyEnv` and the env value are not validated pre-flight | **UPHELD.** P2, mechanical. Folded into the configuration contract. |

**On the withdrawn blocker.** Both of its legs failed the same way. Leg 1
("per-kind recallability is uncontrollable") stopped reading
`_should_generate_embedding` at the never-embed list and missed the config
fallthrough immediately below — the *same* mistake, in the *same function*, that
produced F6 in round 1. Leg 2 ("handle uniqueness cannot be enforced remotely")
is true as stated but is not a blocker: uniqueness was never enforced by the
floor either, and the seam needs handles to be *unambiguous*, which D-FOH-4
delivers without a uniqueness constraint. Escalating to the architecture gate
would have spent an owner decision on a question the code already answers.

## Verification Table (Phase 5)

Every reference below was opened and read. Rows marked **direct** were verified
by reading the SmartMemory repo here rather than accepted from a research pass.

| Ref | Claim | Result |
|---|---|---|
| `lib/fluid/provider.js:35` | `STORAGE_CAP` = RECORDS, EVENTS, LINKS | ✅ |
| `lib/fluid/provider.js:198` | records addressed by handle | ✅ |
| `lib/fluid/local-provider.js:290-297` | `getRecord` returns `null` on a miss | ✅ **direct** — R2-3 |
| `lib/fluid/local-provider.js:411,468,498,522,539` | mutating paths throw `FluidRecordNotFound` | ✅ **direct** — R2-3 |
| `lib/fluid/local-provider.js:211` | `_normalize` is provider-private | ✅ |
| `lib/fluid/local-provider.js:300-305` | floor filters `listRecords` client-side | ✅ **direct** — D-FOH-2 cost |
| `lib/fluid/factory.js:91` | `smartmemory` hard-fail branch | ✅ exact |
| `lib/fluid/factory.js:63` | factory reads only the `fluid` block | ✅ |
| `lib/smartmemory-client.js:31` | `baseUrl` interpolated directly, unvalidated | ✅ **direct** — R2-5 |
| `lib/smartmemory-client.js:64` | `authHeader()` throws before any fetch | ✅ exact |
| `lib/smartmemory-client.js:138` | exports only `{health, ingest, search}` | ✅ exact |
| `lib/smartmemory-config.js:20` | top-level `smartmemory` block holds baseUrl/apiKeyEnv | ✅ |
| `lib/fluid/import-ideabox.js:~73` | clusters created before ideas | ✅ **direct** — C3b |
| `lib/fluid/render-ideabox.js:139` | renderer lists ideas **and** clusters | ✅ **direct** — C3b |
| `test/smartmemory-client.test.js:23` | `makeStub`, raw `node:http` | ✅ exact |
| `8a6b687:201-202` | S1's removed `config.store` injection | ✅ via `git show` |
| `service.py:451` | crud router mounted at `/memory` | ✅ **direct** — C2 |
| `crud.py:376` | `memory_type` is a bare `Body("semantic")`, no enum | ✅ **direct** — C1 |
| `crud.py:529-539` | `use_pipeline:false` → `add(memory_item)`, no kwargs | ✅ **direct** — Ruling Q3 |
| `crud.py:742-808` | `/list` is enumeration; single filter pair; dotted keys; `limit` defaults to 50 | ✅ **direct** — C5 |
| `crud.py:637` | `/entities` is autocomplete | ✅ **direct** — C3a |
| `crud.py:1037-1052` | `properties` bypasses the merge; metadata merge is `{**existing, **new}` | ✅ **direct** — C7 |
| `pipeline/stages/crud.py:140-190` | `_should_generate_embedding` falls through to `enable_<memory_type>` | ✅ **direct** — Ruling Q3, kills the r2 blocker |
| `pipeline/stages/crud.py:100,123-127` | `_embed` exists in core; embedding generated from `content` on add | ✅ **direct** — C13, upstream ask |
| `pipeline/stages/crud.py:469-474` | merge mode hoists existing `metadata` keys to top level | ✅ **direct** — C14 |
| `utils/__init__.py:10-38` | `flatten_dict_safe` explodes safe-keyed sub-dicts; drops empty dicts | ✅ **direct** — C14 |
| `falkordb.py:2992-2999` | `_is_valid_property` skips `None` **and** `""` before the write | ✅ **direct** — C14b |
| `falkordb.py:578-590` | write emits one `SET n.key = $v` per surviving property — omitted keys are untouched, not cleared | ✅ **direct** — C14b |
| `falkordb.py:615-640` | only `write_mode: "replace"` REMOVEs existing keys | ✅ **direct** — C14b |
| `lib/smartmemory-client.js:68,106` | shipped Compose consumers are POST-only; no update path | ✅ **direct** — blast radius |
| `graph/backends/codec.py:99-116,148-159` | JSON-looking strings are marker-escaped and returned verbatim | ✅ **direct** — D-FOH-2 |
| `scope_provider.py:61-77` | `PROTECTED_FIELDS` incl. `memory_type`, `created_at` | ✅ **direct** — C6 |
| `secure_smart_memory.py:343` | server stamps `metadata.created_at` on every add | ✅ **direct** — R2-2, D-FOH-4 tie-break |
| `secure_smart_memory.py:1877-1883` | protected-field strip is one level deep inside `metadata` | ✅ **direct** — D-FOH-2 |
| `memory_item.py:15-42` | `MEMORY_TYPES` registry already contains `decision` | ✅ **direct** — C15 |
| `memory_validator.py:96` | unknown `memory_type` is a **warning**, off the write path | ✅ **direct** — C1 |
| `node_types.py:105,126` | `memory_type` stored as label + property; no handler lookup | ✅ **direct** — C1 |
| `scope.py:81,145,201` | `X-Workspace-Id`; 403 on non-membership; method→scope incl. `delete:memories` | ✅ **direct** — C4, C8 |
| `crud.py:547-564`, `request_models.py:58-79`, `memory_item.py:54-68` | body/response shapes | ⚠️ **partly second-hand** — informs request shaping, which the stub pins at implementation time; a wrong field fails a test rather than passing silently. |

**Boundary Map validation:** `ok: true, violations: 0, warnings: 0`.

**Stale references found and fixed:** 1 — `architecture.md` §Q3's "FOH-1 is
`idea`-only" (superseded by C3b; its conclusion that `position`/`joint` do not
block FOH-1 still holds, for a different reason). Fixed in place.
