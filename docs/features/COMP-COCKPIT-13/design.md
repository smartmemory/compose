# COMP-COCKPIT-13 — Published status page + process-metrics view

**Status:** COMPLETE 2026-10-30 (U0 ops 3e81292c3, U1 2c9aa113, U2 185ca47c, U3 9b4b6769+1dfaaa71+f5359707; polish U4 COMP-COCKPIT-13-POLISH 5e26f174 on 2026-10-31). Was: PLANNED · BLUEPRINT DONE 2026-10-30, plan-review fix round 1 the same day (metric source redesigned: P1-P5 read the status builder's output, no JS port; every file:line below was read on compose main `635dae6e` and the ops tree on 2026-10-30). Filed 2026-10-15 (owner request relayed by s1-chat). Build order: the four units in "Blueprint → Units" below (U0 in the ops lane, owned by ops-main), after COMP-COCKPIT-12 (COMPLETE 2026-10-30).

**Decisions (record: `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/COMP-COCKPIT-13/decision.md`):**
- **Q1 embed or link → LINK to live data** (OWNER via s1-chat 2026-10-30 18:0x). **Publish is Mac-only** (OWNER via s1-chat 18:2x, option (a)): a private claude.ai page holds only the `127.0.0.1` cockpit link, the generated time and a static header. No frozen summary, no data off the Mac.
- **Q2 coverage gap → (a)** Compose ingests the `unit_stamps.py` stamp files (and their per-round review/fix/gate entries) through a new read-only reader; no ledger parsing (forge-main pick, s2-coord OK).
- **Q3 owner owes → the SmartMemory owner queue** through COMP-COCKPIT-12's existing path (forge-main pick). Blueprint correction: 12 has no Node owner-queue reader of its own; it passes through `sm_status.py --json`'s `queue` source. 13 reuses that (see "Owner owes" below).
- **Q4 publish target → claude.ai pointer page** published by the coordinator with the Artifact tool, never by Compose (owner delegated mechanics to forge-main; recorded under "Publish" below).
- **Q5 parity → per panel**; a builder panel is marked superseded at its origin only after that panel's parity is shown (forge-main pick). Per-panel parity is defined in "Panels" below.
  **Amended 2026-10-30 (forge-main, plan-review fix round 1; forge-main's own pick, no owner yes needed):** "superseded" means the builder's HTML pages stop being the *viewing surface* for the process panels. The Python computation (`OPS/status/parsers.py`) stays and stays their one source; Compose reads its output (`summary.json`, `process.json`), so parity holds by construction.

## Related Documents
- Parent: `COMP-COCKPIT` (`/Users/ruze/reg/my/forge/compose/docs/features/COMP-COCKPIT/`)
- Sibling: `COMP-COCKPIT-12` (`/Users/ruze/reg/my/forge/compose/docs/features/COMP-COCKPIT-12/design.md`), the live multi-session view. Stays as is.
- Prior art inside Compose (checked 2026-10-15; reuse, do not rewrite):
  - `lib/gsd-milestone-report.js`: assembles a read-only data model from persisted run artifacts and renders ONE self-contained HTML file (inline CSS, no external assets, atomic write) that the cockpit DocsView auto-discovers. The export in this feature uses the same shape.
  - `server/graph-export.js`: the template-literal HTML export pattern `gsd-milestone-report.js` copies.
- Spike / reference implementation (read, do not copy blindly), all under `/Users/ruze/reg/my/SmartMemory/scratch/`:
  - `2026-10-15-status-multi/`: `build.py`, `parsers.py`, `configs/*.json`, `out/<proj>/status.html`, `test_status_multi.py` (per-project pages + master)
  - `2026-10-14-2.0-status/`: `build.py`, `learning.json` (hand-kept), the GATE-MINUTES-1 landing-gate panel
  - `2026-10-14-time-buckets/REPORT.md`: the metric definitions this feature adopts
  - Published example: 2.0 status page https://claude.ai/artifact/QgJoJVTfApv4zRnJZ6a7ce
- Forge unit state feeding the forge page today: `/Users/ruze/reg/my/forge/status/units.json` (forge-e0, 2026-10-15)

## Problem
s1-chat publishes per-project status pages (2.0, hub, trader, forge, maya, master) that do four things the cockpit does not:
1. **A published static snapshot:** one HTML file, no server, a shareable URL, readable on a phone.
2. **A process-metrics panel:** per-unit time split (authoring / review / fix / waiting / gate), first-pass CLEAN rate, review rounds per unit, gate minutes per land, and waiting share.
3. **A master rollup** across workspaces.
4. **An "owner owes" list:** decisions and inputs the human still has to give. This is separate from gates.

The pages are built by scratch scripts and are partly hand-kept (`learning.json`). That is the drift failure Compose's README argues against. The end state is Compose generating these pages, with no scratch builder.

## Shape
> **Superseded in part 2026-10-30 (Q1/Q4 decisions).** The live link replaces the static export: `compose status export`, the self-contained `status.html` and the `--all` workspace-registry rollup are **KILLED (2026-10-30): the owner picked a link to live data and no frozen copy.** "Readable on a phone" is moot because the link is loopback-only. "Compose state only" is widened by Q2(a) to the stamp files. The live shape is in "Blueprint" below; the text that follows is the filing-time shape, kept for history.

A **derived view**: no new store and no new writer.
- **Data source: Compose state only.** That covers `feature.json`, `.compose/data/gate-log.jsonl` (gate decisions with timestamps and `duration_to_decide_ms`), `.compose/data/feature-events.jsonl` (status transitions), `.compose/data/build-history.jsonl` and `dispatch-ledger.jsonl` (build actuals, review iterations, escalations), `docs/journal/`, `docs/judgment/` (judgment ledger) and sessions (`server/session-store.js`). **No ledger parsing:** the SmartMemory coordination ledger is free text and stays out.
- **CLI:** `compose status export [--project <id> | --all] [--out <file>]` writes `status.html`. It is one self-contained file in the `gsd-milestone-report.js` shape.
- **Cockpit:** a "Publish snapshot" button that runs the same export for the current workspace. Where the file is published (artifact, static host) is an open question below.
- **Master rollup:** `--all` reads a workspace list (the Compose workspace registry that `set_workspace` resolves against) and renders one page linking per-workspace sections.
- **Owner owes:** derived from pending gates that need a human *plus* open decision items. The source for decision items is an open question below.

## Metric definitions (adopted from `2026-10-14-time-buckets/REPORT.md`)
- Buckets per unit: `authoring`, `review`, `fix_rounds`, `escalation`, `gate`, `waiting`, `other`.
  - `other` holds coordinator verification, rebase, reconcile, landfix and similar jobs. They still count as jobs when measuring waiting gaps.
- **Waiting** = the gaps between one job's end and the next job's start, plus the gap from the last job to LANDED, **minus gate intervals**. That keeps the buckets from overlapping.
- Waiting is summed per unit (unit-minutes, not wall clock). A day can exceed 1440 minutes when units overlap.
- **Unknown stays unknown:** a job with no provable end gives `null` plus a warning, never a made-up zero. The report-mtime fallback is rejected when a later job rewrote the same report.
- **First-pass CLEAN rate** = units whose first review verdict is CLEAN ÷ units reviewed.
- **Review rounds per unit** counts review verdicts per unit.
- **Gate minutes per land** sums gate intervals per LANDED unit.
- **Waiting share** = waiting ÷ (waiting + authoring + review + fix_rounds + escalation + other), computed per unit and in aggregate. This matches `inefficiency-watch.md` (wait ÷ (wait + authoring)) when only authoring is counted. The design phase picks one formula and states it.

## Relation to COMP-COCKPIT-12
- **12** = a live session view inside the cockpit: busy/idle, context size, open jobs, owner question queue, disk, spend. It is read through the SmartMemory TUI readers.
- **13** = derived process metrics plus a static export. They share no data path. If 12 lands first, 13's "owner owes" may reuse 12's owner-queue reader rather than add one.

## Open questions (record, do not decide here)
All five are answered 2026-10-30; each answer sits under its question and points to `smart-memory-ops/units/COMP-COCKPIT-13/decision.md`.

1. **Embed or link?** Does the export embed a data snapshot (works offline and when shared, but goes stale) or link to live data (always current, but needs a reachable server)? The owner raised this.
   **ANSWERED 2026-10-30 (OWNER, decision.md): link to live data, Mac-only.** The pointer page carries the loopback link, the generated time and a static header, nothing else.
2. **Coverage gap (found while filing, verified 2026-10-15):** Compose state does NOT hold the unit-level stamps the metrics need for most current work. `build-history.jsonl` has 16 rows, the last on 2026-09-19. Units in SmartMemory 2.0, trader and forge run through `detach_job.py` / `jobs.py` / `stamp.py` outside `compose build`, so their authoring/review/fix/gate times live in job files, queue stamps and land logs, not in Compose. "Compose state only" therefore needs one of:
   - (a) Compose ingests those stamps as a recorded input (a new reader, not ledger parsing);
   - (b) units run through Compose so it records them natively;
   - (c) the page shows metrics only for Compose-run units and marks the rest "not recorded".
   Pick before blueprint. **Recommendation (s1-chat and forge-e0, 2026-10-15): (a), Compose ingests the `jobs.py` / `stamp.py`
   stamps as a recorded input.** The owner decides at blueprint.
   **ANSWERED 2026-10-30 (forge-main pick, s2-coord OK, decision.md): (a).** Blueprint correction: the stamps live in the lane stamp files written by `unit_stamps.py` (`smart-memory-ops/queues/<lane>-units.json`, plus forge's `forge/status/units.json`), not in `jobs.py` (that is the in-flight job registry). The reader contract is in "Blueprint → Stamps reader".
3. **Source for "owner owes" decision items:** Compose pending gates, the judgment ledger's open positions, or the SmartMemory owner queue (`owner-queue.jsonl`, which COMP-COCKPIT-12 already reads)?
   **ANSWERED 2026-10-30 (forge-main pick, decision.md): the owner queue, through COCKPIT-12's path** (`sm_status.py --json` source `queue`, cached by `/api/fleet`). Pending Compose gates stay on the Gates view; they are not "owner owes".
4. **Publish target** for the cockpit button: a claude.ai artifact (as s1-chat does today), a file under `docs/` that DocsView auto-discovers (as `gsd-milestone-report.js` does), or both.
   **ANSWERED 2026-10-30 (owner delegated, forge-main mechanics, decision.md): a private claude.ai pointer page**, published by the coordinator with the Artifact tool. Compose only produces the loopback URL and the pointer HTML on disk. No `docs/` snapshot (that would be a frozen copy).
5. **Retiring the scratch builders:** once 13 reaches parity, the `2026-10-15-status-multi` and `2026-10-14-2.0-status` builders are marked superseded at the origin. Define parity per panel first.
   **ANSWERED 2026-10-30 (forge-main pick, decision.md): per panel**, defined in "Blueprint → Panels". Blueprint correction: `2026-10-15-status-multi` is no longer scratch; it is a symlink to `smart-memory-ops/status/` (a live launchd builder), and `2026-10-14-2.0-status` holds data files only (no `build.py`). Only the process-metrics panels can be superseded; the builder's other panels (dependency graph, flips, glossary, commits, blockers, learning) are out of this feature and keep the builder alive.
   **AMENDED 2026-10-30 (forge-main, plan-review fix round 1, M2; recorded in decision.md):** "superseded" now means the builder's HTML pages stop being the viewing surface for the process panels (P1-P5, P8); the Python computation in `OPS/status/parsers.py` stays and stays the one source, and Compose renders its output (`out/<name>/summary.json`, `out/master/process.json`) with its freshness. No JS port, so the Ops tab and the Process tab show the same numbers by construction. The supersede line is written at the origin after U0-U3 land (U3 close-out).

## Acceptance (draft, refined at blueprint)
> **Superseded 2026-10-30 by the per-unit acceptance in "Blueprint → Units".** Rows 1, 2, 5 and 6 are killed by the Q1 decision (no static export, no phone link). Row 3 survives with a narrower time split (Panel P6). Row 4 survives as Panel P7. Row 7 survives: the hand-kept `owed.json` and `learning.json` are not read.

- [ ] `compose status export --project <id>` writes one self-contained `status.html` (no external assets) from Compose state only
- [ ] `compose status export --all` renders the master rollup from the workspace registry
- [ ] The process-metrics panel shows the seven buckets, first-pass CLEAN rate, review rounds per unit, gate minutes per land and waiting share, using the definitions above; unknown values render as unknown
- [ ] An "owner owes" list, distinct from the gate list
- [ ] A cockpit "Publish snapshot" button that runs the same export
- [ ] Readable on a phone (mobile viewport)
- [ ] No hand-kept input file: every number traces to a Compose store

## Blueprint (2026-10-30, forge-main blueprint pass; fix round 1 the same day)

Updated 2026-10-30 after a source review of compose main `635dae6e` and the ops tree. **Fix round 1 (2026-10-30, after plan review r1 `NOT CLEAN H0 M2 L9`) redesigned the metric source:** P1-P5 and P8 read the status builder's own output; nothing in `parsers.py` is ported to JS. `C/` = `/Users/ruze/reg/my/forge/compose`, `OPS/` = `/Users/ruze/reg/my/SmartMemory/smart-memory-ops`. Reports: `OPS/units/COMP-COCKPIT-13/report-blueprint.md`, `report-fix-r1.md`; review `plan-review-r1.md`.

### Live shape
A read-only **Process** view in the cockpit, fed by one new route `GET /api/process`. The route reads two inputs and computes only what no builder computes:
1. **The status builder's own output**, rendered as is with its freshness: `OPS/status/out/<name>/summary.json` for each of the seven project pages, and `OPS/status/out/master/process.json` (the master process table, added by U0).
2. **The lane stamp files**, for the one new derivation: the P6 time split.

The owner queue comes from `GET /api/fleet`, which already serves it. "Publish" produces a loopback deep link (`http://127.0.0.1:<port>/?view=process`) and a pointer HTML file on disk; the coordinator publishes that pointer with the Artifact tool. No new store, no new writer, no snapshot.

### Metric source: one implementation (fix round 1, M2)
- **P1-P5 and P8 are read, never recomputed.** The builder (`OPS/status/build.py` + `parsers.py`, launchd every 900 s) stays the one implementation of waiting share, first-pass CLEAN, review rounds, gate minutes and the standard-process feeds. Compose reads `summary.json` (written per page at `build.py:242-243` from `P.summary`, `parsers.py:999`) and renders its numbers, `basis` strings and `no_data` strings verbatim. Compose does no rounding, no median and no verdict parsing on any builder figure.
- **Why (the written reason `inventory-before-inventing.md` asks for):** the Ops tab (COMPOSE-OPS-TAB-1, `C/server/ops-status-routes.js:1-45`) already shows the builder's pages inside Compose. A second implementation of the same metrics would drift from the first after any `parsers.py` change (8 commits 2026-10-15..30), with nothing to catch it. Reading the builder's output makes the Ops tab and the Process tab show the same numbers by construction, so the blueprint's once-off parity script (old U4) is dropped.
- **What the Process tab adds over the Ops tab:** one table across the seven pages with each figure's freshness, the P6 time split (no builder computes one since TIME-BUCKETS-1 died), the live owner queue beside them, and the publish link.
- **Gaps are fixed in the builder, in Python:** a number a panel needs that `summary.json` lacks is a Python emit next to `parsers.py`, an ops-lane unit owned by ops-main (U0), never a Compose reader. The two gaps today, both in U0:
  - no JSON of the master process table: `build.py:99-106` embeds `process_table` only in `out/master/status.html`; `out/master/` holds `status.html` only (`ls`, 2026-10-30);
  - 2.0's `summary.json` still reports the frozen time-bucket waiting share as current (`waiting_share` `{pct: 53, basis: "... over 9 days (time-split data)"}`, no stale flag), although `configs/2.0.json:221` already carries `time_buckets.stale`. The same holds for 2.0's `gate_minutes`, which also comes from the time-bucket source (`parsers.py:534`; `lane_stamps` never overrides it, `build.py:79`).
- **New computation in Compose only where the builder has no number:** P6 (from stamps). P7 reuses `/api/fleet`. P8 has a builder source (U0's `process.json`), so nothing is computed for it.
- **Lanes:** P1-P5 and P8 cover the seven pages the builder has (`configs/master.json:12-20`: 2.0, hub, trader, forge, maya, wiki, main). The other stamp lanes (bench, cadence, codegen, mcp, ops, setup, sm20, web) get P6 only; under the P8 table they are listed as "no builder page (add `OPS/status/configs/<lane>.json`, ops lane)". Compose does not compute P1-P5 for them.

### Freshness (every builder figure)
- Each page shows `as of <as_of>`, the builder's own string (`YYYY-MM-DD HH:MM local`, `build.py:52`).
- **Stale** when `now − mtime(summary.json) > 1800 s` (two builder ticks; launchd `ai.smartmemory.status-build` `StartInterval` 900): the figures stay, greyed, with "stale: last built <age> ago". Same rule for `process.json`. Constant `BUILDER_TICK_S = 900` in `process-routes.js`, stale at 2 ticks; not an env knob (no incident asks for one).
- **Failed build:** `out/<name>/BUILD-FAILED.txt` (written by `mark_build_failed`, `build.py:192-198`: line 1 the time, line 2 the reason; removed by the next good build) shows "builder failed <time>: <reason>" beside the last good figures. Never silent.
- **Stale source inside a figure:** a figure the builder marks `stale` (U0: the time-bucket figures) renders as "stale: <text>", never as a current value.

### Inventory (inventory-before-inventing)
**COCKPIT-12 readers and plumbing (reuse):**
| What | Where | Reuse in 13 |
|---|---|---|
| Single-flight cache, stale-while-revalidate, one warn per outage | `C/server/fleet-routes.js:233-271` `createSourceCache` (exported); log prefix hard-coded `[fleet]` (`:249,:254`) | **Reuse** for both process sources (import it; do not copy). U1 adds an optional `logPrefix` (default `'[fleet]'`) so process lines read `[process] ...` (L5) |
| Spawn helper (argv, no shell, timeout, SIGTERM then SIGKILL) | `C/server/fleet-routes.js:62-102` `runReader` | Not needed: both process readers read files, nothing is spawned |
| Reader path resolution with env overrides | `C/server/fleet-routes.js:45-56` `resolveFleetReaders` | **Pattern** for `resolveProcessSources` (env override + default path) |
| `sm_status.py --json` panel subset, incl. `queue` (owner questions) | `C/server/fleet-routes.js:41` `SM_PANELS`, `:109-122` `readSmStatus`; 60 s window `:34` | **Reuse via `/api/fleet`** for owner owes (P7); no second spawn |
| Route mount, loopback vs remote | `C/server/index.js:229` `attachOpsStatusRoutes(app, { remote: remoteMode })`, `:231` `attachFleetRoutes(app)`, `:233` `attachWikiRoutes(app, { remote: remoteMode })`; `:32` `remoteMode` | Mount `attachProcessRoutes(app, { remote: remoteMode })`: mounts nothing in remote mode (Mac-only), the `{remote}` option precedent, not an `if` block (L6) |
| Shared poller hook, paused while the tab is hidden | `C/src/lib/fleetPoller.js:77` `useFleet` (visibility listener `:57`) | Owner-owes card uses `useFleet()` directly; the new `processPoller.js` copies its shape |
| Owner-question card | `C/src/components/cockpit/FleetPanels.jsx:93` (inline in `FleetPanels`; helpers `Card` `:44`, `Unavailable` `:54`, `panelOr` `:66`) | Extract the card to an exported `OwnerQueueCard` in the same file; Fleet and Process both render it |
| Route test table with fixture readers | `C/test/fleet-routes.test.js:57-135` (one row table) | Pattern for `test/process-routes.test.js` |

**Other Compose prior art checked:**
| What | Where | Fit |
|---|---|---|
| **Builder pages inside Compose (COMPOSE-OPS-TAB-1)** (missing from the blueprint, plan review M2) | `C/server/ops-status-routes.js:1-45`: `resolveOpsStatusDir` `:22-25` (env `COMPOSE_OPS_STATUS_DIR`, default `OPS/status/out`, `:18`), `NAME_RE` `:20`, `attachOpsStatusRoutes` `:36`; mounted `C/server/index.js:229`; `ops` in `DEFAULT_MAIN_TABS` (`viewTabsState.js:20`) | **Reuse `resolveOpsStatusDir` and `NAME_RE`** for the builder-output reader (same directory, same env override). The Ops tab keeps showing the full pages; Process shows the process figures across pages with freshness. This is the reason P1-P5 read `summary.json` (see "Metric source") |
| `compose metrics` over Compose's dispatch ledger | `C/bin/compose.js:4376`, `C/lib/dispatch-metrics.js:108` `collectDispatchMetrics` | Different input (Compose-run builds only, last row 2026-09-19 per Q2). Not reused. Its `upperMiddle` (`:19-22`) trap is moot after fix round 1: Compose computes no median |
| One-file HTML report, atomic write | `C/lib/gsd-milestone-report.js:238` `renderReportHtml`, `:302` `writeGsdReport` | **Pattern** for the pointer page writer (U3) |
| Flat view keys, labels, gated views | `C/lib/view-keys.js:15-19` (20 keys), `:25` `PACKAGE_GATED_VIEWS`, `:27-48` `VIEW_LABELS` | Add `process` here (U2) |
| Default tabs and migration of stored tab lists | `C/src/components/cockpit/viewTabsState.js:20` `DEFAULT_MAIN_TABS`, `:101-126` `loadMainTabs` (a missing default is inserted after `docs`, `:111-117`) | Add `process` to the defaults (U2); see placement for where existing users see it (L4) |
| Tab metadata | `C/src/components/cockpit/ViewTabs.jsx:22-41` `TAB_META` (`usage` at `:41`) | Add a `process` entry |
| Initial active view, stored view | `C/src/App.jsx:545-553` (`resolveStoredView` of `compose:activeView`), `:682` persist; only `?popout=` is read from the URL today (`:224-229`) | Add a `?view=<key>` deep link (U2) |
| Server host and ports | `C/server/remote-utils.js:30-39` `resolveComposeHost` (default `127.0.0.1`); `C/server/index.js:107` `PORT` 4001; `C/server/supervisor.js:62` `process.env.VITE_PORT \|\| 5195` in source checkouts; `C/server/index.js:243-245` packaged UI on 4001; `~/.ports` row `compose 4001,4002,5195` | Inputs to the publish URL (U3), `VITE_PORT` included (L7) |

**The status builder the process figures come from:**
| Builder | Where (verified) | What it computes | State |
|---|---|---|---|
| STATUS-MULTI-1/-2 | `OPS/status/` (`scratch/2026-10-15-status-multi` is a symlink to it), `build.py`, `parsers.py`, `configs/*.json`, `out/<name>/{status.html,summary.json}` | every project page and the master page | live: launchd `ai.smartmemory.status-build` runs `OPS/status/timer_run.sh` every 900 s (plist `StartInterval` 900) |
| Per-page `summary.json` | `build.py:242-243` (pages without `projects`), object from `parsers.py:999` `summary`: `as_of`, `waiting_share`, `waiting_units_stamped`, `first_pass_clean`, `review_rounds`, `gate_minutes`, `standard`, `no_data` | the P1-P5 figures, per page | live, seven files (2.0, forge, hub, main, maya, trader, wiki), all written 20:25 on 2026-10-30 |
| Master process table | `build.py:99-106` `data['process_table'] = {projects, rows: P.process_table(rows), note}`; rows from `parsers.py:1154` `project_rows` (reads the seven `summary.json`), cells `:1173-1198`, measures `:1200`, standard rows `:1213`, table `:1239` | the P8 table | **embedded in `out/master/status.html` only; no JSON file** (U0 adds `process.json`) |
| 2.0 status (2026-10-14) | `scratch/2026-10-14-2.0-status/` | none: holds `glossary.json`, `learning.json`, `queue-units.json`, `README.md` only (no `build.py`) | data only |
| TIME-BUCKETS-1 | report `scratch/2026-10-14-time-buckets/REPORT.md`; script `.../work/time_buckets.py` **no longer exists** | the seven-bucket time split for the 2.0 build only | **dead**: output frozen 2026-10-23 15:08; 2.0's config now carries `time_buckets.stale` (`configs/2.0.json:221`) and no `pre_steps` (ops-main, per the s2-coord ruling) |
| `estimate.py` | `OPS/claude/scripts/estimate.py:38-41` imports `OPS/status/parsers.py` | pace estimates | **keeps `parsers.py` alive**: nothing in this feature deletes or moves `parsers.py` |

Meaning of the figures Compose shows (read, not ported; all `OPS/status/parsers.py`): `_share_from_stamps` `:983`, `review_dirs` `:892`, `lane_stamps` `:941`, `summary` `:999`, `_no_data` `:1079`, `process_table` `:1239`. Builder runs under `/usr/bin/python3` 3.9.6 (launchd `PATH=/usr/bin:...`, `timer_run.sh`).

### Corrections to the filing-time design
| Design assumed | Actual | Correction |
|---|---|---|
| Stamps come from `jobs.py` / `stamp.py` | Unit stamps live in lane stamp files written by `unit_stamps.py` (`OPS/claude/scripts/unit_stamps.py:38-41` file shape, events `:26-33`); `jobs.py` is the in-flight job registry | Stamps reader (P6 only) reads `OPS/queues/*-units.json` plus `~/reg/my/forge/status/units.json` |
| COCKPIT-12 has an owner-queue reader | 12 passes `sm_status.py`'s `queue` source through (`fleet-routes.js:41,109-122`); `sm_status.py:713-738` `parse_queue` returns rows `{id, by, text, age, error, red}`; the queue file is `OPS/coordination/owner-queue.jsonl` (`sm_status.py:84`), not the scratch path in COCKPIT-12's table | Owner owes = `/api/fleet` → `sources.sm_status.value.queue` |
| Scratch builders to retire | Builder is live ops tooling in `OPS/status/`; `estimate.py` imports its parsers | Supersede the **viewing surface** of the process panels, not the builder (Q5 amended, fix round 1); never delete `parsers.py` |
| Seven-bucket split from TIME-BUCKETS-1 | Script deleted, output frozen 2026-10-23, 2.0 only, input is job files | P6 is a new stamps-derived split; `escalation` and `other` are "not recorded" from stamps |
| Master rollup from the Compose workspace registry | The rollup the owner sees is the builder's master page over seven project configs (`configs/master.json:12-20`) | P8 = the builder's master process table, read from U0's `process.json`; no workspace registry |
| One HTML export, phone-readable | Killed by Q1 | Live view + loopback pointer |
| (blueprint) P1-P5 recomputed in JS from stamps and review files, checked once against `summary.json` | The Ops tab already shows the builder inside Compose; a port drifts after the next `parsers.py` change | **Fix round 1:** P1-P5/P8 read `summary.json` / `process.json`; no port, no review-folder scan, no `median` or rounding helper in Compose |
| ISO stamps parse the same in JS | JS `new Date('2026-10-30')` is UTC midnight; Python 3.9 `fromisoformat` gives naive local midnight; `to_local` turns `Z` into `+00:00` first | Strict `toLocal` helper (P6 only) mirroring `to_local` (`parsers.py:52-58`; table rows in U1) |

### Panels (one table each)
**What "parity" means after fix round 1.** P1-P5 and P8 show the builder's figures from the builder's files, so they equal the builder by construction; one agreement test (U2) proves the Process tab renders a fixture `summary.json` / `process.json` without changing a figure. Parity input sets (L8): P1-P5 = the seven `OPS/status/out/<name>/summary.json`; P8 = `OPS/status/out/master/process.json`; P6 = the stamp files named under "Readers" (no builder oracle; hand-check); P7 = `sm_status.py --json`'s `queue` source.

**P1 Waiting share** (the builder's headline: queue wait before dispatch ÷ (wait + build), `parsers.py:983`; for 2.0 the frozen time-bucket figure, marked stale by U0)
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| Waiting share per page | `summary.json` `waiting_share {pct, basis, stale?}`, `waiting_units_stamped` | builder-output reader (no computation) | by construction; agreement-test row (U2) | `no_data.waiting_share` verbatim (`parsers.py:1086`); 2.0 shows "stale: frozen 2026-10-23 ..." once U0 lands (until then the builder's own basis "time-split data" is shown with its value) |

**P2 First-pass CLEAN rate**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| Clean of reviewed per page | `summary.json` `first_pass_clean {clean, total, basis}` | builder-output reader | by construction; agreement-test row | `no_data.first_pass_clean` verbatim |

**P3 Review rounds per unit**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| median, max, n per page | `summary.json` `review_rounds {median, max, n, basis}` (the builder picks its source and says so in `basis`) | builder-output reader | by construction; agreement-test row | `no_data.review_rounds` verbatim |

**P4 Gate minutes per land**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| newest day with a passing gate: lands, median, max, last 5 | `summary.json` `gate_minutes {day, lands, median, max, last5, basis, stale?}` | builder-output reader | by construction; agreement-test row | `no_data.gate_minutes` verbatim; 2.0 stale once U0 lands |

**P5 Standard-process feeds**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| units stamped (with of), units with a first-round verdict, gate runs, gate passes | `summary.json` `standard {stamps {with, of}, review_files, gate_runs, gate_passes}` | builder-output reader | by construction; agreement-test row | zeros shown as zeros (a measured fact). `review_files` is labelled **"units with a first-round verdict"**, the builder's own label (`parsers.py:1226`), not "review files" (L3) |

**P6 Time split** (new derivation in Compose; no builder computes it, see "The dead 2.0 time-split chart" below)
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| per-lane minutes in authoring, review, fix_rounds, gate, **waiting on owner**, waiting; escalation and other | landed rows with `ready_at` and `landed_at`: authoring = `author_done_at − dispatched_at`; review = Σ `reviews[].at − reviews[].dispatched_at`; fix_rounds = Σ `fix_runs[].done_at − .dispatched_at`; gate = Σ `gates[].done_at − .started_at`; **waiting on owner** = the part of the `owner_waits[] {qid, start, end}` intervals (`unit_stamps.py:33`) covered by no job interval; **waiting** = the part of [`ready_at`, `landed_at`] covered by no job interval and no owner-wait interval (gate time is never waiting, REPORT choice 1; owner wait is never queue wait) | new (`timeSplit`, `laneTimeSplit`) | **hand-check** in the U1 report: three named landed `main` units with every stamp, recomputed by hand from their rows, match `timeSplit` to the minute; one real unit per unknown rule below comes out `unknown` with that rule | unknown rules below; `escalation` and `other` always `not recorded (stamps carry no such interval)` |

**P6 unknown rules (M1).** Each rule makes that unit's whole split `unknown`: the unit adds nothing to any bucket, it is counted per lane and shown as "N units unknown" with the rule that fired, and it is never folded into waiting.
| rule | condition on a landed row with `ready_at` and `landed_at` | real rows today (15 stamp files, 2026-10-30) |
|---|---|---|
| U-a | an interval with an end and no start: a `reviews[]` entry with `at` and no `dispatched_at`; a `fix_runs[]` entry with `done_at` and no `dispatched_at`; a `gates[]` entry with `done_at` and no `started_at` | reviews: 470 of 1,620 entries, 116 of 507 landed units |
| U-b | an interval with a start and no end, including an `owner_waits[]` entry with `start` and no `end` | owner waits: 4 of 33 entries open |
| U-c | legacy `fixes[]` has entries and `fix_runs[]` has none | 83 landed units |
| U-d | `author_done_at` missing | (counted by U1) |
| U-e | any stamp on the row that `toLocal` rejects (already a lane warning) | (counted by U1) |
Rows that are not landed, or lack `ready_at` or `landed_at`, are outside the split and counted as "not in split: n". Retired rows are never landed (`unit_stamps.py:36`: a landed unit is refused), so they fall outside. Each job bucket sums its own intervals (two overlapping jobs count in both); only waiting and waiting on owner come from uncovered time, and the view says so ("job buckets can overlap; waiting cannot"). Lane totals sum known units only and read "M known, N unknown, K not in split". Minutes are rounded with `Math.round` at display only: P6 has no builder figure to match, so Python's half-even rounding is irrelevant (L1).

**P7 Owner owes**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| open owner questions: id, asked by, text, age (red past the TUI's limit) | `GET /api/fleet` → `sources.sm_status.value.queue` (`sm_status.py:713-738`, file `OPS/coordination/owner-queue.jsonl`) | **existing** (COCKPIT-12 path; client reuses `useFleet`) | live check in the U2 report (L8): run `python3 OPS/claude/scripts/sm_status.py --json` and read `/api/fleet` until its `sources.sm_status.ts` is within 1 s of that run (at most one 60 s cache window, `fleet-routes.js:34`); the open ids must be equal; `owner_queue.py list` (`open_items`, `owner_queue.py:179-180`) is a second reading. The builder's hand-kept "owed" lists (`OPS/status/data/2.0/owed.json`, last edited 2026-10-15) are superseded as hand-kept: the queue is the source of record | `sm_status` reader down: card hidden (12's rule). Source error with no rows: `unavailable: <reason>`. Rows plus error: rows under `unknown: <reason> (rows shown are a lower bound)`. Empty and no error: "Nothing waiting on the owner" |

v1 shows one global list: `parse_queue` drops the record's `unit` field, so owner owes cannot be split per lane without a change to `sm_status.py --json` (owned by the TUI's owner). Not filed (no incident; FILING BAR).

**P8 Rollup** (the master page's process table)
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| measures × the seven pages, each cell with its basis | `OPS/status/out/master/process.json` (U0): `{as_of, projects: [{name, label, as_of}], rows: [{measure, cells, covers, basis}], note}`, the same object `build.py:101-106` embeds in the master page | builder-output reader | by construction; agreement-test row (every cell equal to `process.json`); live check in the U2 report: same cells as `out/master/status.html` for the same `as_of` | `process.json` missing: one "Rollup unavailable: the builder has not written process.json (OPS-STATUS-PROCESS-JSON-1)" card, and the per-page P1-P5 detail still renders from `summary.json`; a cell the builder has no figure for already carries the builder's `no data (n=<k>, needs <what>)` string |

### Readers (`C/lib/process-metrics.js`, `C/server/process-routes.js`)
- **Builder-output reader** `readBuilderOutput(dir)`: `dir` from `resolveOpsStatusDir(env)` (`ops-status-routes.js:22-25`, imported). Reads `master/process.json`, then `<name>/summary.json` for each `process.json.projects[].name` (when `process.json` is missing: every subdir holding a `summary.json` whose name passes `NAME_RE`, `ops-status-routes.js:20`), each file's `mtimeMs`, and `<name>/BUILD-FAILED.txt` (first 300 characters). JSON parse only; no field is computed or renamed. A file that is not JSON gives that page `{value: null, error: "<name>: summary.json not JSON"}`; the other pages render. Status dir missing: the `builder` source errors (`status dir not found`) and the view shows one unavailable card for P1-P5 and P8; P6 and P7 still render (L6).
- **Stamps reader** (P6 only): `COMPOSE_PROCESS_QUEUES_DIR` (default `~/reg/my/SmartMemory/smart-memory-ops/queues`): every `*-units.json`, lane = file name minus `-units.json`. `COMPOSE_PROCESS_EXTRA` (default `forge=~/reg/my/forge/status/units.json`): extra `lane=path` stamp files, comma-separated. No review-folder scan (dropped with the port). Nothing under `~/.claude` is read. No request input ever reaches a path. A missing queues dir is a `stamps` outage (P6 unavailable card, one warn); P1-P5/P8 still render.
- **File shapes accepted** (`unit_stamps.py:38-41`): `{units: {id: row}}`, `{units: [row with id]}`, or a bare list of rows.
- **Fields used per row:** `ready_at`, `dispatched_at`, `author_done_at`, `landed_at`, `reviews[] {at, dispatched_at}`, `fix_runs[] {dispatched_at, done_at}`, `fixes[]` (count only), `gates[] {started_at, done_at}`, `owner_waits[] {start, end}`. Everything else is ignored.
- **Times:** `toLocal(text)` mirrors `to_local` + Python 3.9 `fromisoformat`: `Z` → UTC; `±HH:MM` → that offset; fractional seconds kept; seconds optional; no offset → local wall time; date-only → local midnight; anything else → `null`. Day keys use local dates.
- **Malformed input is never silent:** a lane file that is not JSON makes that lane `{value: null, error: "<lane>: not JSON"}` while other lanes render; a row that is not an object is skipped and counted in the lane's `warnings[]`; a rejected stamp makes the unit `unknown` (U-e) and is counted. One `console.warn('[process] <lane>: <n> rows skipped ...')` per lane when that lane's warning count changes (0 → n, n → m); recovery logs one info line.
- **Cache:** two `createSourceCache` entries imported from `fleet-routes.js:233`, both with `logPrefix: '[process]'`: `builder` (TTL 60 s; eight small files that change every 900 s) and `stamps` (TTL 120 s; 15 stamp files). Single flight, stale-while-revalidate, one warn per outage. Loads use async `fs/promises`.
- **Route:** `GET /api/process` → `{generated, sources: {builder: {value: {table, asOf, ageS, stale, failed, pages: {<name>: {value, error, asOf, ageS, stale, failed}}}, error, ts, stale}, stamps: {value: {lanes: {<lane>: {value, error, warnings, timeSplit}}}, error, ts, stale}}}`. `value` of a page is the parsed `summary.json` unchanged. `cache-control: no-store`, envelope style of `/api/fleet` (`fleet-routes.js:294-305`). Mounted by `attachProcessRoutes(app, { remote: remoteMode })` right after `attachFleetRoutes(app)` (`C/server/index.js:231`); returns false and mounts nothing when `remote` is true. No request parameters.

### Route and UI placement
- **Flat view key `process`** (label "Process", tip "Unit process metrics across lanes, live (read-only)"), the 21st entry in `lib/view-keys.js:15-19` and `VIEW_LABELS`, a `TAB_META` entry (`ViewTabs.jsx`, icon `Gauge`, already imported at `:20`), and a `case 'process'` beside `case 'usage'` (`App.jsx:408-409`).
- **Tab position (L4):** `DEFAULT_MAIN_TABS` gets `process` after `usage` (`viewTabsState.js:20`), so new users see it after Usage. Existing users get it from `loadMainTabs`, which inserts a missing default right after `docs` (`viewTabsState.js:111-117`), so for them Process sits after Docs. Accepted as is: changing `loadMainTabs` would move every future default too, and AUDIT-17 slice 2 re-derives order from rooms.
- **Never hidden, never package-gated (L6):** the route is always mounted on loopback; each source that is down shows its own "unavailable: <reason>" card (builder, stamps), and the owner card follows 12's rule. A tab the user already sees is never hidden.
- **Relation to Fleet:** Fleet (Sessions view pane) is *who is working now*; Process is *how the work has been flowing*. Process mounts `useFleet()` only for the owner-owes card, so no extra `sm_status` spawn (`fleet-routes.js:34` 60 s window). The Ops strip gains nothing.
- **Relation to the Ops tab:** Ops shows each builder page whole; Process shows the process figures of all seven pages side by side, with freshness, plus P6 and P7. Both read the same builder files.
- **Relation to the AUDIT-17/18 Home page:** none in this feature. Home (`DashboardView.jsx`, `HomeSections.jsx`, `HomeFleetGlance.jsx`) is untouched. AUDIT-17 §2.6 keeps view keys flat and derives rooms from them, so slice 2 may move `process` into a room without changing the key.
- **Deep link:** `?view=<key>` on load sets the initial `activeView` when `isViewKey(key)` (pure `viewFromQuery(search)` in `lib/view-keys.js`); invalid keys are ignored with one console warning; `?popout=` keeps priority (`App.jsx:224-229`).
- **Layout:** top: the P8 table (measures as rows, the seven pages as columns, cells verbatim, the page's `as of` and stale/failed marker in each column header); a click on a column opens that page's P1-P5 detail (fields, `basis`, `no_data`). Below: P6 per selected lane (all stamp lanes, incl. the eight with no builder page). Right column: P7 (`OwnerQueueCard`). Refresh: one shared poll every 60 s, paused while the tab is hidden (`processPoller.js`, same shape as `fleetPoller.js`).

### The dead 2.0 time-split chart (the blueprint's own question, answered)
**ANSWERED 2026-10-30 (s2-coord ruling ~20:2x, `decision.md` bottom, option (a)):** ops-main marks the 2.0 page's time-split chart stale and drops the dead TIME-BUCKETS-1 pre-step; the Process tab's P6 carries the time split, computed from the stamps. The 2.0 page is not a parity oracle for P6. At the origin as of this fix round: `configs/2.0.json:221` carries `time_buckets.stale` ("frozen 2026-10-23, the time split moves to the Compose Process tab.") and the 2.0 config has no `pre_steps` (`grep pre_steps configs/2.0.json`: no hit, 2026-10-30). What remains is the frozen figure inside 2.0's `summary.json` (waiting share 53%, gate minutes), which U0 marks stale so Compose never shows it as current.

### Publish (against the Artifact runtime)
- **What Compose does:** `compose process publish [--out <file>]` and a **Publish** button in the Process view header. Both compute the deep link `http://127.0.0.1:<port>/?view=process`, where the base = `COMPOSE_COCKPIT_URL` when set; else, in a source checkout, port `VITE_PORT` or 5195 (`supervisor.js:62` `process.env.VITE_PORT || 5195`, L7); else `PORT` or 4001 (packaged UI, `index.js:243-245`). Any URL whose host is not `127.0.0.1`, `localhost` or `[::1]` is refused (exit 2 / HTTP 409), so nothing but a loopback link can be produced. The CLI writes the pointer page atomically (`gsd-milestone-report.js:302` pattern) to `--out` (default `.compose/data/process-pointer.html`) and prints the URL, the generated time and the file path. The button calls `GET /api/process/publish` (returns `{url, generatedAt}`, writes nothing) and shows the URL with a copy control and the CLI line.
- **What the pointer page holds:** a static header ("Process metrics: open on this Mac"), the URL twice (one `<a href>` and the same URL as plain selectable text), the generated time. No script, no fetch, no lane name, no number. `renderPointerPage({url, generatedAt})` takes nothing else, so it cannot embed data.
- **What the coordinator does (not Compose):** copy the file to `OPS/artifacts/<seat>/` (brief-footer rule: HTML on disk first), publish it as a private claude.ai artifact with the Artifact tool, open the local file the same turn. Artifacts have been published from Team seats (`OPS/artifacts/seat1..4/`, ledger 2026-10-25 03:45).
- **Data leaving the Mac:** only the pointer page: a loopback URL, a timestamp and a fixed header. The Process data never leaves: the page cannot fetch loopback and has no script, and `/api/process` is not mounted in remote mode.
- **Unverified (checked live in U3, not assumed):** whether a click on the `<a href>` inside the claude.ai artifact frame opens the loopback URL in a new tab. If the frame blocks it, the plain-text URL is the fallback (copy, paste). U3's acceptance records which one happened.

### Units (re-cut in fix round 1: four units, one in the ops lane)
```
U0 OPS-STATUS-PROCESS-JSON-1 (ops lane) ──┐
U1 COMP-COCKPIT-13-READER ────────────────┴──> U2 COMP-COCKPIT-13-VIEW ──> U3 COMP-COCKPIT-13-PUBLISH (+ close-out)
```
U0 and U1 are independent (U1 tests on fixtures) and dispatch together. U2 needs U1's route, and U2's live checks need U0 landed. U3 needs U2's deep link. Compose authors paste `pytest`-free test commands per `test-run-discipline.md` (`node --test <file>`, `npx vitest run <file>`; workers ≤ 4).

**U0 OPS-STATUS-PROCESS-JSON-1: builder emits the master process table and marks stale time-bucket figures** (**ops lane, owned by ops-main**; Sonnet, **BOUNDED** (Python tooling in `OPS/status/`, no product code); not security-tagged: local files only, no new input)
- [ ] `OPS/status/build.py` (existing): the master build (`cfg['projects']`, `:99-106`) also writes `out/master/process.json` with `write_atomic` (`:182`): `{as_of, projects: [{name, label, as_of}], rows, note}`, where `rows` and `note` are the same objects the page embeds as `data['process_table']`; written only on a good build (a failed build keeps the last good file beside `BUILD-FAILED.txt`, as for `status.html`)
- [ ] `OPS/status/parsers.py` (existing) `summary` (`:999`): when `waiting_share` (`:1015-1030`) or `gate_minutes` (`:1059-1062`) comes from a `time_buckets` source whose config carries `stale` (`:525`; set for 2.0 at `configs/2.0.json:221`), the figure dict carries `stale: <that text>`, and the master cells (`_cell_wait` `:1178`, `_cell_gate` `:1183`) start with `STALE: `; figures from other sources are unchanged
- [ ] `OPS/status/test_status_multi.py` (existing): one explicit row table, no stacked parametrize: master fixture → `process.json` equals the page's embedded `process_table`; stale time-bucket config → `waiting_share.stale` and `gate_minutes.stale` set and both master cells start `STALE: `; no time-bucket config → no `stale` key; failed build → last good `process.json` kept
- [ ] `OPS/status/README.md` (existing): one line naming `out/master/process.json`, its shape and its reader (Compose Process view, COMP-COCKPIT-13)
- Test plan: the row table above, targeted (`-k process`), with the file's existing runner; no full builder run beyond one `build.py` pass to show `out/master/process.json` written.

**U1 COMP-COCKPIT-13-READER: builder-output and stamps readers, `/api/process`** (Compose; Sonnet, BOUNDED spec; not security-tagged: read-only, fixed roots, no request input, nothing under `~/.claude`, absent in remote mode)
- [ ] `C/lib/process-metrics.js` (new): pure `toLocal(text)`, `laneRows(doc)`, `timeSplit(row)` → `{status: 'known', minutes} | {status: 'unknown', rule} | {status: 'outside'}`, `laneTimeSplit(rows)`, `freshness({mtimeMs, now, failedText})` → `{ageS, stale, failed}`; no network, no spawn, nothing ported from `parsers.py`
- [ ] `C/server/process-routes.js` (new): `resolveProcessSources(env)` (status dir via the imported `resolveOpsStatusDir`, queues dir, extra files), `readBuilderOutput(dir)`, `readStamps(sources)`, `attachProcessRoutes(app, {remote, env, now, warn, info, ttlMs})`, `GET /api/process` with the envelope above
- [ ] `C/server/fleet-routes.js` (existing): `createSourceCache` takes an optional `logPrefix` (default `'[fleet]'`, used at `:249,:254`); existing fleet tests pass unchanged
- [ ] `C/server/index.js` (existing): `attachProcessRoutes(app, { remote: remoteMode })` after `attachFleetRoutes(app)`
- [ ] Malformed handling as in "Readers": never a dropped file, row or unit without a count
- [ ] `C/test/process-metrics.test.js` (new), one explicit row table per helper, no stacked loops, ≤ 40 cases:
  | helper | rows |
  |---|---|
  | `toLocal` | `...T10:00:00Z`; `+08:00`; naive; date-only; `YYYY-MM-DDTHH:MMZ`; `...:SS.ffffff+HH:MM`; `...THH:MM+HH:MM`; garbage → `null` |
  | `laneRows` | `{units: {id: row}}`; `{units: [row]}`; bare list; not-JSON |
  | `timeSplit` | full row (known, exact minutes per bucket); owner wait inside a gap (moves to waiting on owner); owner wait overlapping a review (job wins); U-a review `at` without `dispatched_at`; U-a fix_run `done_at` only; U-a gate `done_at` only; U-b open review; U-b open owner wait; U-c `fixes[]` without `fix_runs[]`; U-d no `author_done_at`; U-e bad stamp; not landed (outside); no `ready_at` (outside) |
  | `freshness` | 0 s fresh; 1800 s fresh; 1801 s stale; `BUILD-FAILED.txt` text → failed with time and reason |
- [ ] `C/test/fixtures/process/` (new): `out/master/process.json`, `out/hub/summary.json`, `out/main/summary.json` + `out/main/BUILD-FAILED.txt` (shapes copied from real builder output, values changed by hand, no live data), and a `queues/` tree with one row per `timeSplit` rule
- [ ] `C/test/process-routes.test.js` (new), one row table (pattern `test/fleet-routes.test.js:57-135`): fixture tree → envelope; each page `value` deep-equals its fixture `summary.json` (no transformation); stale page (mtime 1801 s old); failed page; status dir missing (builder card, stamps still served); queues dir missing (stamps outage, one `[process]` warn, recovery info); single flight under concurrent GETs; nothing mounted with `remote: true`
- [ ] P6 hand-check in the U1 report: three named landed `main` units with every stamp, minutes by hand from their rows vs `timeSplit`, equal to the minute; one real unit per rule U-a..U-d reported `unknown` with its rule
- [ ] `C/CHANGELOG.md` (existing) entry, same commit

**U2 COMP-COCKPIT-13-VIEW: Process view** (Compose; Sonnet, BOUNDED; not security-tagged)
- [ ] `C/lib/view-keys.js` (existing): `process` key and label, `viewFromQuery(search)`
- [ ] `C/src/components/cockpit/viewTabsState.js` (existing): `process` in `DEFAULT_MAIN_TABS` after `usage` (`loadMainTabs` unchanged, L4)
- [ ] `C/src/components/cockpit/ViewTabs.jsx` (existing): `TAB_META.process`
- [ ] `C/src/App.jsx` (existing): `case 'process'`; initial `activeView` honours `?view=` (after the popout check)
- [ ] `C/src/lib/processPoller.js` (new): shared 60 s poll of `/api/process`, paused while hidden (shape of `fleetPoller.js`)
- [ ] `C/src/components/cockpit/FleetPanels.jsx` (existing): extract `OwnerQueueCard` (export), Fleet renders it unchanged
- [ ] `C/src/components/cockpit/ProcessView.jsx` (new): P8 table with cells verbatim from `process.json` and per-column `as of` / stale / failed markers; per-page P1-P5 detail from `summary.json` (`basis` and `no_data` verbatim, `review_files` labelled "units with a first-round verdict", `stale` figures as "stale: <text>"); P6 per lane with "M known, N unknown (rule), K not in split"; P7 card; one unavailable card per down source; unknown never rendered as 0
- [ ] `C/test/view-keys.test.js` (existing): rows for `process` and `viewFromQuery`
- [ ] `C/test/ui/process-view.test.jsx` (new), one row table over the real route and the U1 fixture tree. **Row 1 is the agreement test that replaces the blueprint's U4 parity check:** for each fixture page, every P1-P5 figure the Process tab renders equals the matching field of that page's fixture `summary.json`, and every P8 cell equals the fixture `process.json` cell. Other rows: one page failed, one page stale, a `stale` figure, status dir missing (card), stamps outage, owner queue unknown
- [ ] Live checks in the U2 report, after U0 has landed: P8 cells on the Mac equal `out/master/status.html`'s table for the same `as_of`; P7 open ids equal `sm_status.py --json`'s `queue` ids with `/api/fleet`'s `sources.sm_status.ts` within 1 s of the CLI run (L8), cross-checked with `owner_queue.py list`
- [ ] `C/docs/cockpit.md` (existing) Zones row for Process; `C/CHANGELOG.md` entry

**U3 COMP-COCKPIT-13-PUBLISH: loopback link, pointer page, close-out** (Compose; Sonnet, BOUNDED; **security-tagged: export policy**, one pre-land review)
- [ ] `C/lib/process-publish.js` (new): `cockpitBaseUrl({env, hasSourceCheckout})` (`COMPOSE_COCKPIT_URL`, else `VITE_PORT` or 5195 in a source checkout, else `PORT` or 4001), `pointerUrl(base)` (refuses non-loopback hosts), `renderPointerPage({url, generatedAt})`, `writePointerPage(path, html)` (atomic)
- [ ] `C/bin/compose.js` (existing): `compose process publish [--out <file>]` beside `metrics` (`:4376`); exit 2 on a refused host
- [ ] `C/server/process-routes.js` (existing after U1): `GET /api/process/publish` → `{url, generatedAt}` or 409
- [ ] `C/src/components/cockpit/ProcessView.jsx` (existing after U2): Publish button, URL, copy, CLI line
- [ ] `C/test/process-publish.test.js` (new), one row table: hosts `127.0.0.1`, `localhost`, `[::1]` accepted; `0.0.0.0`, a LAN IP, a hostname, `https://claude.ai` refused; base URL rows: `COMPOSE_COCKPIT_URL` set, `VITE_PORT=5300` in a source checkout, neither (5195), packaged (`PORT`, else 4001); page has exactly one `<a>`, no `<script>`, contains the URL twice and the time, and none of the fixture page names
- [ ] Live check by the coordinator (recorded in the U3 report): pointer published from `OPS/artifacts/<seat>/`, link clicked on the Mac; result "link opens" or "blocked, plain-text URL used"
- [ ] Close-out, after U0-U3 have landed (Q5 as amended): one line at the origin `OPS/status/README.md` (committed by ops-main): "process figures (waiting share, first-pass clean, review rounds, gate minutes, standard feeds, master process table): viewing surface is the Compose Process view (COMP-COCKPIT-13) since <date>; this builder stays their one computation"; nothing in `OPS/status/` deleted; `C/docs/features/COMP-COCKPIT-13/design.md` and `feature.json` flipped to COMPLETE with the report paths

### Out of scope
Any write action; per-lane owner owes (needs `sm_status` to pass `unit`); the builder's non-process panels; computing P1-P5 in Compose (for any lane, including the eight with no builder page: a page is an ops-lane config); Compose-run build metrics (`compose metrics` already covers them); remote mode.
