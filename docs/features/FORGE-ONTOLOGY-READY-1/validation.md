# FORGE-ONTOLOGY-READY-1: validation of forge records against the project ontology pack

Run 2026-11-02 with `validate.py` (this folder), rerunnable:

```
PYTHONDONTWRITEBYTECODE=1 python3 -I docs/features/FORGE-ONTOLOGY-READY-1/validate.py --json <out.json>
```

Checker: core's own `smartmemory.record_schema.validate_item_fields` (`smart-memory-core/smartmemory/record_schema.py:182`)
against an `OntologyType` built from each pack entry (annotation keys dropped, every `properties_schema` passed through
`validate_properties_schema` first), imported read-only from the core checkout. Core has no `def record_schema`; the
module of that name is the validator. Generated JSON Schemas do not exist yet (phase B), so this is the pack's property
schemas as core reads them: types and required fields, unknown extra fields allowed, no enums or patterns.

Pack: `draft SmartMemory/contracts/project-ontology-bundle.v1.json` (byte-identical to core branch
`wk/ONTO-PROJECT-PACK-1` `pack.json`).

## Preconditions

All 6 held (a false one would have printed `VERDICT: INVALID <precondition>` and stopped):

- a Feature with no `code` is rejected
- a Feature with `code: 123` is rejected
- a Gate with `round: "1"` (string) is rejected
- a Unit with `repos: "core"` (string, not list) is rejected
- a minimal good Feature passes
- unknown extra fields pass (core parity)

## Inputs

- Compose: 425 feature folders, 377 with a `feature.json` (the other 48 hold docs only). All 377 parse.
- Manifests: `SmartMemory/.compose/compose.json` and `forge/.compose/compose.json` have a `project` block;
  `forge/compose/.compose/compose.json` has none (it is the host config with `projects.roots`, by design).
- Compose fluid ideas: 37 `kind: idea` records in `docs/product/fluid/records/`.
- ops queue unit rows (added: the declared input for Unit): 3,672 rows in `smart-memory-ops/queues/*-units.json`.
- Wiki: the fixture corpus `smart-memory-wiki/fixtures/corpus/records.json` only (17 wiki_doc, 6 wiki_feature,
  12 wiki_entry, 9 folder, 6 source, 4 proposal). The Mac wiki on 8791 has no unauthenticated GET export: `/identity`
  and `/sources` answer 401 without the local owner token, record queries are `POST /query/{name}`, and the token is a
  credential this unit does not read. Live wiki records are NOT validated.

## Per type

"As stored" validates the record under its own field names. "Mapped" renames fields per `mapping.md`, copying only
fields that are present (nothing invented).

| dataset | type | n | pass | fail |
|---|---|---|---|---|
| Compose feature.json (as stored) | Feature | 377 | 377 | 0 |
| Project manifests: project block (as stored) | Project | 2 | 2 | 0 |
| Project manifests: modules[] (as stored) | Module | 11 | 11 | 0 |
| Project manifests: lanes[] (as stored) | Lane | 15 | 15 | 0 |
| Project manifests: lanes[] (mapped opsLane->ops_lane) | Lane | 15 | 15 | 0 |
| Compose fluid ideas (as stored) | Idea | 37 | 37 | 0 |
| Compose fluid ideas (mapped handle->id) | Idea | 37 | 37 | 0 |
| ops queue unit rows (as stored) | Unit | 3672 | 3670 | 2 |
| wiki fixtures wiki_feature (as stored) | Feature | 6 | 0 | 6 |
| wiki fixtures wiki_feature (mapped) | Feature | 6 | 6 | 0 |
| wiki fixtures wiki_doc (as stored) | Artifact | 17 | 17 | 0 |
| wiki fixtures wiki_entry kind=decision (as stored) | ProjectDecision | 4 | 0 | 4 |
| wiki fixtures wiki_entry kind=decision (mapped) | ProjectDecision | 4 | 4 | 0 |
| wiki fixtures wiki_entry kind=idea (as stored) | Idea | 3 | 0 | 3 |
| wiki fixtures wiki_entry kind=idea (mapped) | Idea | 3 | 3 | 0 |

Feature key rule (`^[A-Z][A-Z0-9-]*[A-Z0-9]$`, from the pack's `_key`, which core's field spec cannot express): 0 of
377 fail, and every `code` equals its folder name.

## Failure reasons

| dataset | reason | count | example |
|---|---|---|---|
| wiki_feature (as stored) | `code: required property is missing` | 6 | `CORE-1` (the wiki calls it `feature_id`) |
| wiki_entry decision (as stored) | `id: required property is missing` | 4 | the wiki calls it `entry_id` (a content hash) |
| wiki_entry idea (as stored) | `id: required property is missing` | 3 | same |
| ops unit rows | `id: required property is missing` | 2 | two list rows in `main-units.json` with no `id` (Cadence skips them) |

## What a pass does not mean

The property schemas only check types and required fields, so several passes hide a real mismatch (all in
`mapping.md` Gaps):

- **Fluid ideas pass as stored because they have an `id`, but it is the provider's UUID**, not the ideabox id the pack
  keys on (`handle`, G5).
- **feature.json `phase` passes as a string, but it holds the ROADMAP section heading** (67 distinct values), not the
  lifecycle phase the pack documents (G1).
- **Lanes pass with or without the rename**: `ops_lane` is optional, so copying the manifest as is silently drops
  `opsLane` (G3).
- **0 of 3,672 unit rows carry `repos`** (59 carry a singular `repo`): Unit validates because `repos` is optional, but
  314's `touches` has no declared input (G2).
- Unmapped stored fields, top per dataset: feature.json `updated` 376, `created` 372, `position` 347, `complexity` 184,
  `completions`/`commit_sha` 126, `parent` 99, `links` 73; unit rows `landed_at` 3,629, `ready_at` 3,623, `reviews` 3,602.
