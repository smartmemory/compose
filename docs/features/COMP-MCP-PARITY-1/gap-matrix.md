# COMP-MCP-PARITY-1 — CLI ↔ MCP gap matrix

**Compiled:** 2026-09-28 during UAT.
**Method:** `compose --help` surface compared against the live MCP tool list;
`grep -rl ideabox compose-mcp/` (zero matches); workspace reach probed live.

## Legend
✅ MCP has it · ❌ no MCP equivalent · ⚠️ present but hobbled

| CLI surface | MCP | Notes |
|---|---|---|
| `ideabox add/list/promote/kill/resurrect/pri/discuss/triage/render` | ❌ | **Highest value.** Zero matches for "ideabox" under `compose-mcp/`. See the correction below — a `/ideabox` skill exists but targets a different product. Tracked as `COMP-IDEABOX-MIGRATE-1`. |
| `new` (product kickoff) | ❌ | research → brainstorm → roadmap Stratum flow; empty dir to populated project |
| `build` | ❌ | UI can (`POST /api/build/start`), CLI can, MCP cannot |
| `fix` | ❌ | bug-fix lifecycle |
| `gsd` | ❌ | per-task fresh-context dispatch |
| `plan` | ❌ | prompt → structured roadmap |
| `triage` | ❌ | recommend a build profile |
| `qa-scope` | ❌ | affected routes from changed files |
| `pipeline` | ❌ | view/edit build pipeline |
| `experiment` | ❌ | A/B model experiment |
| `guard` | ❌ | canon guard + drift |
| `lineage` | ❌ | PROV-O artifact lineage |
| `metrics` | ❌ | dispatch/settlement/triage metrics |
| `tracker` | ❌ | provider status + op-log sync |
| `context` | ❌ | build decision log |
| `doctor` / `import` | ❌ | setup + existing-project analysis |
| `roadmap` | ✅ | `get_roadmap`, `add_roadmap_entry`, `roadmap_diff`, `roadmap_graph`, `roadmap_xref_push` |
| `feature` | ✅ | `scaffold_feature`, `set_feature_status`, `complete_feature`, `kill_feature` |
| `gates` | ✅ | `get_pending_gates`, `approve_gate` |
| `validate` | ✅ | `validate_feature`, `validate_project` |
| `judgment` | ✅ | full `judgment_*` surface |
| `loops` | ✅ | `start_iteration_loop`, `abort_iteration_loop`, `report_iteration_result` |
| `record-completion` | ✅ | `record_completion`, `backfill_completion` |
| journal | ⚠️ | `write_journal_entry` works but see ergonomics below |
| workspace | ⚠️ | `set_workspace` cannot reach un-anchored projects; see below |

## Two hobbled surfaces

### `write_journal_entry` — errors one at a time

Requires `date`, `slug`, `summary_for_index` and four exact sections
(`what_happened`, `what_we_built`, `what_we_learned`, `open_threads` —
`lib/journal-writer.js:49`). It validates them sequentially, so a caller gets
one missing field per round trip. **Five consecutive failed calls** during UAT
before it accepted input.

**Fix:** declare required fields in the tool schema, and validate all of them in
one pass so a single error names everything missing.

### `set_workspace` — cannot reach un-anchored projects

Discovery anchors on the directory the MCP **session started in**, walking up
for `.compose` / `.stratum.yaml` / `.git`, then scanning to depth 3
(`lib/discover-workspaces.js`).

Verified live: a session anchored in `forge` returned
`WorkspaceUnknown: Unknown workspaceId: testapp` for a sibling project outside
that tree — **even after `compose init` in it**. There is no way to add or
address a workspace after session start.

**Why it matters:** when the MCP and the running UI point at different projects,
writes land somewhere invisible and it presents as a crash. This is the same
class as `COMP-WS-ISOLATION-1`.

**Fix candidates:** an explicit `add_workspace`/`open_workspace` by absolute
path, or letting `set_workspace` accept a path rather than only a discovered id.

## Correction (2026-09-28) — the skills question

An earlier draft of this matrix said an agent "literally cannot capture an
idea". That overstated it, and the owner was right to push back: `/ideabox` and
`/roadmap` skills both exist. The corrected position:

**`/roadmap` is already MCP-backed.** `~/.claude/skills/roadmap/SKILL.md` says
*"Compose MCP (preferred when present) — call `get_roadmap` before reading any
file."* No gap. The ✅ above stands.

**`/ideabox` exists but is not a Compose client, and is worse than a gap.** It
declares its location as `smart-memory-docs/docs/product/ideabox.md` — a
hardcoded path to a **different product** (verified to exist at
`/Users/ruze/reg/my/SmartMemory/...`). It hand-edits that markdown with grep and
python and computes IDs by max+1, with two documented collision incidents.

It never calls `compose ideabox` or the compose MCP, so:
- invoked from a Compose project it still writes SmartMemory's file
- nothing appears in the Compose UI
- `compose ideabox render` is documented as *"the way back from any hand edit"*
  (`lib/ideabox-cli.js:314-322`), so hand edits to a Compose-managed ideabox are
  discarded by design

The two systems do not merely coexist — they undo each other. Tracked
separately as **`COMP-IDEABOX-MIGRATE-1`**.

## Preserve this — it already works

✅ **MCP writes reach the running UI live.** Confirmed 2026-09-28: a
`write_journal_entry` call rendered in the JOURNAL tab with **no page reload**,
via the file-watcher websocket.

Any new write tool inherits live UI feedback for free **provided it writes under
the watched docs tree** (`server/file-watcher.js` watches the resolved docs dir
recursively, plus features, pipelines and ideabox paths). Tools that write
outside it will work but stay invisible — which is the single most important
constraint for whoever implements this.

## Suggested order

1. **Ideabox tools** — unblocks `COMP-UX-ONRAMP-1` and the pipeline's front door
2. **`set_workspace` by path** — removes a silent wrong-project write
3. **Journal schema** — cheap, removes a sharp edge
4. **Build/fix execution** — the agent can scaffold but not build; closes the loop
5. Everything else by demand
