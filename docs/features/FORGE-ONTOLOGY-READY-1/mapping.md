# FORGE-ONTOLOGY-READY-1: forge stored shapes -> project ontology pack

Pack: `SmartMemory/contracts/project-ontology-bundle.v1.json` (draft, sha256 `45fa23a0106c…`), byte-identical to core's
`smartmemory/ontology/packs/project-ontology/1.0.0/pack.json` on branch `wk/ONTO-PROJECT-PACK-1` (commit `23cbc12d8`,
not on core main yet). Phase B (generated `.d.ts` / JSON Schemas) does not exist yet, so every seam is a stub rendered
from the pack JSON. Identity rule: `<project>:<Type>:<key>`. Stored shapes are NOT changed by this unit: every
disagreement is a gap below (G-n), and the gaps worth fixing are rows 320-324 in `ROADMAP.md` (COMP-PROJECT).

Paths: `C` = forge/compose, `ST` = forge/stratum, `K` = forge/cadence, `WK` = SmartMemory/smart-memory-wiki,
`OPS` = SmartMemory/smart-memory-ops. Lines are at the commits this unit branched from (C `816465d1`, ST `bfefbee`,
K `604827c`, WK `511c738`).

## Compose

### feature.json -> Feature (+ featureLink, ownedBy, touches)

Written by `C/lib/feature-json.js:68` (`writeFeature`, atomic write at :89) and `C/lib/feature-writer.js`; contract
`C/contracts/feature-json.schema.json` (owns the status enum, the pack defers to it).

| Stored (feature.json) | Pack | Note |
|---|---|---|
| folder `docs/features/<CODE>/` in a module's tree | Feature key `<code>`; `ownedBy` -> Module (derived: the module whose store holds the file) | `C/server/project-graph.js:84` stamps `module` and builds ids `<module>:<id>`, not pack ids (G4) |
| `code` | `code` | 377/377 match the key regex and their folder name |
| `description` (`name` on 1 legacy file) | `description` | |
| `status` | `status` | enum stays in `feature-json.schema.json` |
| `phase` | `phase` ? | **G1**: stored `phase` is the ROADMAP section heading (67 distinct values, e.g. `Phase 7: MCP Writers`); the pack says `phase` holds lifecycle values from `C/lib/lifecycle-modes.js:34`. Lifecycle phase lives in the vision store, not feature.json |
| `links[] {kind, to_code}` (`C/lib/feature-writer.js:741` `linkFeatures`) | `featureLink` with `link_kind` | `kind: external` is not an edge (pack agrees). Legacy top-level `depends_on` (2), `supersedes` (1), `surfaced_by` (2) bypass `links[]` (G13) |
| (none) | `touches` -> Repository | derived (314), no stored input today (G2) |
| `group` (47 files, e.g. `COMP-MCP`) | none | **G11**: an epic/family code, NOT the pack's Group (a module label). Same word, different thing |
| `commit_sha`, `completions[].commit_sha` (126) | Commit? | **G14**: the pack has no Feature -> Commit relation (`generatedBy` ranges over Unit, Gate, Session) |
| `created`, `updated`, `position`, `complexity`, `parent`, `profile`, `tags`, `impact`, `lane` (triage), `triage*`, `estimateSource`, `artifacts`, `promotedFrom`, `createdAt`, `priority`, `source` | none | Compose-only fields; `lane` is the triage lane, not Lane (pack notes agree). `promotedFrom` (4) is the reverse of `promotedTo` |

Hand-declared type: `C/lib/feature-json.js:26` `@typedef FeatureJson` declared code/description/status/phase itself;
now `Feature & FeatureJsonOwn` from the seam (see report, Duplicates replaced).

### `.compose/compose.json` `project` -> Project / Module / Lane (+ partOf, inGroup)

Read by `C/server/project-model.js:59` (`readProject`); no writer (hand-edited manifest); no contract file yet (312).

| Stored | Pack | Note |
|---|---|---|
| `project.name` | Project `name`, key | `smartmemory`, `forge` |
| `project.label` | Project `label` | |
| `project.modules[] {name, path}` (`project-model.js:77-95`) | Module `{name, path}` + `partOf` -> Project | pack `path` = realpath; stored `path` is root-relative, realpath is computed (`project-model.js:84`) |
| `project.lanes[] {id, opsLane?, label?, repo?, module?}` (`project-model.js:97-113`) | Lane `{id, label, ops_lane, repo, module}` + `partOf` -> Project | **G3**: `opsLane` (camelCase) vs pack `ops_lane`; validates either way because both are optional, so a naive copy silently drops it |
| `project.groups` | Group + `inGroup` | does not exist yet (312) |
| host `C/.compose/compose.json` | none | has `projects.roots`, no `project` block: a host config, not a project manifest (by design, `project-model.js:41-52`) |

### 313 dependency graph (PLANNED) -> dependsOn

Planned contract `contracts/project-dep-graph.schema.json` (313 acceptance, `ROADMAP.md` COMP-PROJECT): nodes
(member, group, path) -> Repository / Module with `inGroup`; edges (from, to, kind, evidence `file:line`) -> `dependsOn`
with `evidence: [file:line]` and `derived: true`. The pack's `.md` says node `type` and edge `type` values are the pack
names, so the 313 schema should import names from `C/lib/ontology` (`TYPE_NAMES`, `RELATION_NAMES`) instead of an enum
of its own. Edge `kind` (pyproject, package.json, import, compose, ci, symlink) has no pack home (**G15**: keep it as an
edge property next to `evidence`; the pack has no slot).

### ideabox -> Idea (+ promotedTo)

Two stores: the fluid record store (`C/lib/fluid/record-store.js:66` `docs/product/fluid/records/<handle>.json`, 37 ideas
+ 8 clusters, contract `C/contracts/fluid-record.schema.json`) and the rendered markdown (`C/lib/ideabox.js:343` parse,
`:707` add).

| Stored | Pack | Note |
|---|---|---|
| `handle` (`IDEA-7`) | Idea `id` (key: ideabox id) | **G5**: the record's own `id` is a provider UUID; copying `id` passes the type check and is the wrong key |
| `title` | `title` | |
| `priority` (P0/P1/P2/—) | `attention`? | **G7**: no forge store has `attention`; whether it is `priority` is an open pack question |
| `status` `PROMOTED (→ CODE)` (`C/lib/ideabox.js:735`) / feature `promotedFrom` | `promotedTo` -> Feature | derivable from the status text and `promotedFrom`, no structured field |
| `kind: cluster` records | none (Group? no) | clusters are idea groupings, not project Groups |

### Compose gate records -> Gate (+ gatedBy)

`C/server/gate-log-store.js:78` (`appendGateLogEntry`, called from `C/server/vision-routes.js:1113`) writes
`.compose/data/gate-log.jsonl` rows `{id, gate_id, decision, operator, feature_code, timestamp, ...}`.

| Stored | Pack | Note |
|---|---|---|
| `gate_id` `<flowRunId>:<stepId>:<round>` | Gate `id`, `round` | **G6**: pack key for lifecycle gates is `<feature>:<phase>`; the round sits inside the id string, not a field |
| `decision` (approve/revise/kill) | `verdict` | rename |
| `feature_code` | `gatedBy` Feature -> Gate | |
| (none) | `tier` | review tier is an ops concept; Compose gates have none |

### Sessions

`C/server/session-manager.js:26` keeps cockpit agent sessions in memory (`featureCode`, phase at end). Not the pack's
Session (a long-lived named agent session on a seat): no `session_id`/role pair is stored (**G9**).

## Stratum

| Stored | Pack | Note |
|---|---|---|
| run document `~/.stratum/ts/flows/<id>.json` (`ST/ts/src/engine/state.ts:226` `PersistedRun`; projected by `ST/ui/server/project.mjs`, UI shape `ST/ui/src/data-client.ts:44` `RunSummary`) | no clean home | A flow run is an Activity, closest to Unit, but its key is a run UUID, not a unit folder. `input.featureCode` gives an `implementsFeature`-like link. Brief asked for Session: a run is not a session (no role name, no seat) (**G8**) |
| gate step waiting (`ST/ui/src/data-client.ts:150` `PendingGate {runId, stepId, round, ...}`), events `gate_waiting`/`gate_resolved` (`state.ts:203-211`) | Gate `{id, round, verdict}` + `gatedBy` | id would be `<runId>:<stepId>:r<round>` (G6); verdict from the `gate_resolved` event |
| session backend picks (`ST/ts/src/session/backend.ts:122` `PickSeat {id, state}`, `:137` jobs rows with `session`, `account`) | Seat `{id}`; `assignedSeat` Session -> Seat | wire shapes of ops scripts, read-only passthrough; Session ids are role names, not UUIDs (G9) |

No Stratum source declares a pack type (grep in report); `GateAction`/`GateResolution`/`PendingGate` are Stratum's
own gate protocol, not the pack Gate.

## Cadence

| Stored | Pack | Note |
|---|---|---|
| `OPS/queues/<lane>-units.json` rows (read by `K/ui/server/handler.mjs:114-121`, projected by `K/ui/server/sources.mjs:66-100` to `K/ui/src/data-client.ts:43` `BeltUnit`) | Unit `{id, repos}` + `inLane` -> Lane (file name = ops lane) | **G2**: 0 of 3,672 rows carry `repos`; 59 carry a singular `repo`. The pack's declared input for 314's `touches` does not exist. 2 rows in `main-units.json` have no `id` (Cadence skips them, `sources.mjs` `laneRows`) |
| unit row `landed_sha` / `pushed_sha` (`sources.mjs:99`) | Commit + `generatedBy` Unit | Commit needs `repo`, which the row does not hold (G2) |
| diary landing-gate events (`K/ui/src/data-client.ts:71` `UnitGate {stage, at, sha}`) | none | landing stages (gate_started/pushed/landed), not review Gates |
| `usage_watch.py status` accounts + `~/.cadence/snapshot.json` `accounts` (`sources.mjs:293`, `:321`) -> `Seat` (`data-client.ts:113`) | Seat `{id}` | **G10**: 2 of 6 account ids (`codex`, `max`) do not fit the pack key `seat<N>` |
| sessions scan -> `SessionRow {name, seat, ...}` (`data-client.ts:416`) | Session `{name}` + `assignedSeat` | no `session_id` (G9) |
| lane of a unit (`BeltUnit.lane`, from the file name) | Lane via `ops_lane` | ops lane names (`2.0`, `cadence`, `codegen`) join to `project.lanes[].opsLane` |

## Wiki

Record kinds: `WK/wiki/contracts/record_types.py:47-114` (core field-spec format, the same one the pack uses).
WIKI-PROJECT-1 (316) owns the record packs; this is today's mapping.

| Stored | Pack | Note |
|---|---|---|
| `wiki_feature` (`record_types.py:67`) `{feature_id, title, roadmap_status, owner, current_decision_ref, repos, ...}` | Feature `{code <- feature_id, description <- title, status <- roadmap_status}`; `decidedBy` <- `current_decision_ref`; `touches` <- `repos` | **G12**: field names differ; as stored 0/6 fixtures validate, mapped 6/6. `repos` here is copied from the SmartMemory features index, the one place a feature already carries repos |
| `wiki_doc` (`record_types.py:48`) `{doc_id, path, feature_ids, ...}` | Artifact `{path}` | `path` is repo-relative; the pack key wants `<repository key>/<path>` (needs `source_id` -> repository) |
| `wiki_entry` kind `decision` (`record_types.py:79`, kinds at `:41`) | ProjectDecision `{id <- entry_id, statement <- text}` | **G12**: `entry_id` is a content hash; the pack key is `D-NNNN` (in `text`/`refs`, not a field) |
| `wiki_entry` kind `idea` | Idea `{id, title <- text}` | same: hash id, not `IDEA-N` |
| `wiki_entry` kinds `ledger`, `call`; `wiki_folder`, `wiki_source`, `wiki_proposal` | none | wiki-internal |
| `WK/ui/packages/wiki-components/src/data-client.d.ts:49` `FeatureItem` | Feature (view) | the query contract's item (`query.schema.json` `$defs/feature_item`), same names as `wiki_feature`; not a pack duplicate |

## Gaps

### Stored fields with no home in the pack

| Gap | Where | What |
|---|---|---|
| G1 | `C/docs/features/*/feature.json` `phase`; `C/lib/feature-json.js:31` | roadmap section heading stored under the name the pack gives to lifecycle phase |
| G11 | feature.json `group` (47) | epic code; collides by name with pack Group |
| G13 | feature.json `depends_on`, `supersedes`, `surfaced_by` (legacy top-level) | links outside `links[]`; a `featureLink` export from `links[]` misses them |
| G14 | feature.json `commit_sha`, `completions[]` (126) | no Feature -> Commit relation in the pack |
| G15 | 313 planned edge `kind` | no pack slot for the extractor kind on `dependsOn` |
| G6 | `gate-log.jsonl` `gate_id`, `operator`, `duration_to_decide_ms` | round inside the id; operator and timing have no home |
| G3 | manifest lanes `opsLane` | camelCase vs pack `ops_lane` |
| - | Compose-only feature fields (created, position, complexity, profile, triage*, tags, impact) | intentionally out of the pack (pack `.md`: only fields Compose/ops/wiki read or 312-314 need) |
| - | Cadence view fields (quota windows, jobs, blockers) | view state, not ontology |

### Pack types and relations no forge app produces

| Pack | Status |
|---|---|
| Group, `inGroup` | 312 (PLANNED) |
| Repository, `dependsOn` | 313 (PLANNED) |
| `touches`, Unit `repos` | 314 (PLANNED); input missing (G2) |
| Release, `hasRelease` | no producer, no forge need found |
| Commit | sha only (unit rows, feature.json), never with `repo` |
| Session `session_id` | no store keeps the UUID with the role (G9) |
| Seat key `seat<N>` | 2/6 accounts do not fit (G10) |
| Idea `attention` | no producer (G7) |
| ProjectDecision `D-NNNN`, `decidedBy`, `reverses` | ops ledger only; wiki stores hashes (G12) |
| `implementsFeature` | derivable from unit id vs feature code; no producer |
| `memberOf` | none (pack says: none yet) |
| pack ids `<project>:<Type>:<key>` | no forge app emits them (G4); `project-graph.js:84` uses `<module>:<id>` |
