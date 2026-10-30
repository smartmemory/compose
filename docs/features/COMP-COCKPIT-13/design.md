# COMP-COCKPIT-13 — Published status page + process-metrics view

**Status:** PLANNED · BLUEPRINT DONE 2026-10-30 (forge-main blueprint pass; every file:line below was read on compose main `635dae6e` and the ops tree on 2026-10-30). Filed 2026-10-15 (owner request relayed by s1-chat). Build order: the four units in "Blueprint → Units" below, after COMP-COCKPIT-12 (COMPLETE 2026-10-30).

**Decisions (record: `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/COMP-COCKPIT-13/decision.md`):**
- **Q1 embed or link → LINK to live data** (OWNER via s1-chat 2026-10-30 18:0x). **Publish is Mac-only** (OWNER via s1-chat 18:2x, option (a)): a private claude.ai page holds only the `127.0.0.1` cockpit link, the generated time and a static header. No frozen summary, no data off the Mac.
- **Q2 coverage gap → (a)** Compose ingests the `unit_stamps.py` stamp files (and their per-round review/fix/gate entries) through a new read-only reader; no ledger parsing (forge-main pick, s2-coord OK).
- **Q3 owner owes → the SmartMemory owner queue** through COMP-COCKPIT-12's existing path (forge-main pick). Blueprint correction: 12 has no Node owner-queue reader of its own; it passes through `sm_status.py --json`'s `queue` source. 13 reuses that (see "Owner owes" below).
- **Q4 publish target → claude.ai pointer page** published by the coordinator with the Artifact tool, never by Compose (owner delegated mechanics to forge-main; recorded under "Publish" below).
- **Q5 parity → per panel**; a builder panel is marked superseded at its origin only after that panel's parity is shown (forge-main pick). Per-panel parity is defined in "Panels" below.

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

## Acceptance (draft, refined at blueprint)
> **Superseded 2026-10-30 by the per-unit acceptance in "Blueprint → Units".** Rows 1, 2, 5 and 6 are killed by the Q1 decision (no static export, no phone link). Row 3 survives with a narrower time split (Panel P6). Row 4 survives as Panel P7. Row 7 survives: the hand-kept `owed.json` and `learning.json` are not read.

- [ ] `compose status export --project <id>` writes one self-contained `status.html` (no external assets) from Compose state only
- [ ] `compose status export --all` renders the master rollup from the workspace registry
- [ ] The process-metrics panel shows the seven buckets, first-pass CLEAN rate, review rounds per unit, gate minutes per land and waiting share, using the definitions above; unknown values render as unknown
- [ ] An "owner owes" list, distinct from the gate list
- [ ] A cockpit "Publish snapshot" button that runs the same export
- [ ] Readable on a phone (mobile viewport)
- [ ] No hand-kept input file: every number traces to a Compose store

## Blueprint (2026-10-30, forge-main blueprint pass)

Updated 2026-10-30 after a source review of compose main `635dae6e` and the ops tree. `C/` = `/Users/ruze/reg/my/forge/compose`, `OPS/` = `/Users/ruze/reg/my/SmartMemory/smart-memory-ops`. Report: `OPS/units/COMP-COCKPIT-13/report-blueprint.md`.

### Live shape
A read-only **Process** view in the cockpit, fed by one new route `GET /api/process` over one new stamps reader, plus the owner queue that `GET /api/fleet` already serves. "Publish" produces a loopback deep link (`http://127.0.0.1:<port>/?view=process`) and a pointer HTML file on disk; the coordinator publishes that pointer with the Artifact tool. No new store, no new writer, no snapshot.

### Inventory (inventory-before-inventing)
**COCKPIT-12 readers and plumbing (reuse):**
| What | Where | Reuse in 13 |
|---|---|---|
| Single-flight cache, stale-while-revalidate, one warn per outage | `C/server/fleet-routes.js:233-271` `createSourceCache` (exported) | **Reuse as is** for the stamps reader cache (import it; do not copy) |
| Spawn helper (argv, no shell, timeout, SIGTERM then SIGKILL) | `C/server/fleet-routes.js:62-102` `runReader` | Not needed: the stamps reader reads files, it spawns nothing |
| Reader path resolution with env overrides | `C/server/fleet-routes.js:45-56` `resolveFleetReaders` | **Pattern** for `resolveProcessSources` (env override + default path) |
| `sm_status.py --json` panel subset, incl. `queue` (owner questions) | `C/server/fleet-routes.js:41` `SM_PANELS`, `:109-122` `readSmStatus` | **Reuse via `/api/fleet`** for owner owes (P7); no second spawn |
| Route mount, loopback vs remote | `C/server/index.js:230-231` (fleet, behind the remote auth gate), `:232-233` (wiki, absent in remote mode), `:32` `remoteMode` | Mount `/api/process` like wiki: **absent in remote mode** (Mac-only) |
| Shared poller hook, paused while the tab is hidden | `C/src/lib/fleetPoller.js:77` `useFleet` (visibility listener `:57`) | Owner-owes card uses `useFleet()` directly; the new `processPoller.js` copies its shape |
| Owner-question card | `C/src/components/cockpit/FleetPanels.jsx:93` (inline in `FleetPanels`; helpers `Card` `:44`, `Unavailable` `:54`, `panelOr` `:66`) | Extract the card to an exported `OwnerQueueCard` in the same file; Fleet and Process both render it |
| Route test table with fixture readers | `C/test/fleet-routes.test.js:57-135` (one row table) | Pattern for `test/process-routes.test.js` |

**Other Compose prior art checked:**
| What | Where | Fit |
|---|---|---|
| `compose metrics` over Compose's dispatch ledger | `C/bin/compose.js:4376`, `C/lib/dispatch-metrics.js:108` `collectDispatchMetrics` | Different input (Compose-run builds only, last row 2026-09-19 per Q2). Not reused. Do **not** reuse its `upperMiddle` (`:19-22`): it returns the upper middle, the builder's `median` averages the two middles, so reuse would break parity |
| One-file HTML report, atomic write | `C/lib/gsd-milestone-report.js:238` `renderReportHtml`, `:302` `writeGsdReport` | **Pattern** for the pointer page writer (U3) |
| Flat view keys, labels, gated views | `C/lib/view-keys.js:15-19` (20 keys), `:25` `PACKAGE_GATED_VIEWS`, `:27-48` `VIEW_LABELS` | Add `process` here (U2) |
| Default tabs and migration of stored tab lists | `C/src/components/cockpit/viewTabsState.js:20` `DEFAULT_MAIN_TABS`, `:101-126` `loadMainTabs` (a new default is inserted after `docs` for existing users) | Add `process` to the defaults (U2) |
| Tab metadata | `C/src/components/cockpit/ViewTabs.jsx:22-41` `TAB_META` (`usage` at `:41`) | Add a `process` entry |
| Initial active view, stored view | `C/src/App.jsx:545-553` (`resolveStoredView` of `compose:activeView`), `:682` persist; only `?popout=` is read from the URL today (`:224-229`) | Add a `?view=<key>` deep link (U2) |
| Server host and ports | `C/server/remote-utils.js:30-39` `resolveComposeHost` (default `127.0.0.1`); `C/server/index.js:107` `PORT` 4001; `C/server/supervisor.js:62` Vite 5195 in source checkouts; `C/server/index.js:243-245` packaged UI on 4001; `~/.ports` row `compose 4001,4002,5195` | Inputs to the publish URL (U3) |

**The status builders the process metrics come from today:**
| Builder | Where (verified) | What it computes | State |
|---|---|---|---|
| STATUS-MULTI-1/-2 | `OPS/status/` (`scratch/2026-10-15-status-multi` is a symlink to it), `build.py`, `parsers.py`, `configs/*.json`, `out/<name>/{status.html,summary.json}` | every project page and the master page | live: launchd `ai.smartmemory.status-build` runs `OPS/status/timer_run.sh` every 900 s (plist `StartInterval` 900); last run 2026-10-30 19:39 |
| 2.0 status (2026-10-14) | `scratch/2026-10-14-2.0-status/` | none: holds `glossary.json`, `learning.json`, `queue-units.json`, `README.md` only (no `build.py`) | data only |
| TIME-BUCKETS-1 | report `scratch/2026-10-14-time-buckets/REPORT.md`; script `.../work/time_buckets.py` **no longer exists** | the seven-bucket time split for the 2.0 build only, from `scratch/2026-10-10-2.0-build/*.job.json` and land logs | **dead**: `OPS/status/out/2.0/pre-steps.log` shows exit 2 (file not found); `metrics/time_buckets.json` last written 2026-10-23 15:08, so the 2.0 page's time split and waiting share are frozen at that date |
| `estimate.py` | `OPS/claude/scripts/estimate.py:38-41` imports `OPS/status/parsers.py` | pace estimates | **keeps `parsers.py` alive**: retiring the builder must never delete `parsers.py` |

Parser functions behind each metric (all `OPS/status/parsers.py`): `to_local` `:52-58`, `median` `:61-64`, `STAMP_FIELDS` `:271`, `stamped_units` `:274`, `TB_BUCKETS` `:463`, `time_buckets` `:473`, verdict regexes `:801-804`, `classify_verdict` `:807`, `first_verdict` `:816`, `_queue_rows` `:826`, `_queue_round1` `:836`, `review_scan` `:844`, `review_dirs` `:892`, `review_unassigned` `:917`, `lane_stamps` `:941`, `_share_from_stamps` `:983`, `summary` `:997`, `_no_data` `:1079`, `project_rows` `:1152`, `process_table` `:1237`. Builder runs under `/usr/bin/python3` 3.9.6 (launchd `PATH=/usr/bin:...`, `timer_run.sh`).

### Corrections to the filing-time design
| Design assumed | Actual | Correction |
|---|---|---|
| Stamps come from `jobs.py` / `stamp.py` | Unit stamps live in lane stamp files written by `unit_stamps.py` (`OPS/claude/scripts/unit_stamps.py:38-41` file shape, events `:74-82`); `jobs.py` is the in-flight job registry | Reader reads `OPS/queues/*-units.json` plus `~/reg/my/forge/status/units.json` |
| COCKPIT-12 has an owner-queue reader | 12 passes `sm_status.py`'s `queue` source through (`fleet-routes.js:41,109-122`); `sm_status.py:713-738` `parse_queue` returns rows `{id, by, text, age, error, red}`; the queue file is `OPS/coordination/owner-queue.jsonl` (`sm_status.py:84`), not the scratch path in COCKPIT-12's table | Owner owes = `/api/fleet` → `sources.sm_status.value.queue` |
| Scratch builders to retire | Builder is live ops tooling in `OPS/status/`; `estimate.py` imports its parsers | Supersede **panels**, not the builder; never delete `parsers.py` |
| Seven-bucket split from TIME-BUCKETS-1 | Script deleted, output frozen 2026-10-23, 2.0 only, input is job files | P6 is a new stamps-derived split; `escalation` and `other` are "not recorded" from stamps |
| Master rollup from the Compose workspace registry | The rollup the owner sees is the builder's master page over seven project configs (`OPS/status/configs/master.json` `projects`) | P8: one table, one row per stamp lane; no workspace registry |
| One HTML export, phone-readable | Killed by Q1 | Live view + loopback pointer |
| Medians: reuse Compose's helper | `dispatch-metrics.js:19-22` is upper-middle; builder `median` averages | New `median` with the builder's semantics |
| ISO stamps parse the same in JS | JS `new Date('2026-10-30')` is UTC midnight; Python 3.9 `fromisoformat` gives naive local midnight; `to_local` turns `Z` into `+00:00` first | Strict `toLocal` helper mirroring `to_local` (table rows below) |

### Panels (one table each)
Lanes = every `OPS/queues/<lane>-units.json` (14 today: 2.0, bench, cadence, codegen, hub, main, maya, mcp, ops, setup, sm20, trader, web, wiki) plus `forge` from `~/reg/my/forge/status/units.json`. The builder's seven pages map to lanes by `configs/<name>.json` `stamps.path` and `review_dirs.lane` (verified: 2.0, hub, trader, forge, maya, wiki, main). Parity always means: same input files, same numbers as `OPS/status/out/<name>/summary.json`, checked by `scripts/process-parity.mjs` (U4) only when every input file's mtime is older than that `summary.json` (else the run is INVALID and re-runs after the next builder tick).

**P1 Waiting share** (headline formula of record: queue wait before dispatch ÷ (wait + build), wait = `dispatched_at − ready_at`, build = `landed_at − dispatched_at`, over landed units with all three stamps and `landed_at > dispatched_at`; at least 3 units, else no data)
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| Waiting share per lane | stamp rows `ready_at`, `dispatched_at`, `landed_at` | new (`laneMetrics`, port of `parsers.py:983` `_share_from_stamps`) | `waiting_share.pct` equal to `summary.json` for hub, trader, forge, maya, wiki, main. **2.0 excluded**: its builder figure comes from the frozen `time_buckets.json` (`parsers.py:1013-1018`), so the parity report says "builder input frozen 2026-10-23" | `no data (n=<k>, needs ready_at, dispatched_at and landed_at stamps on 3+ units)` (wording of `parsers.py:1086`) |

**P2 First-pass CLEAN rate**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| Clean ÷ reviewed per lane | first classifiable `VERDICT:` line of `OPS/units/<ID>/review-r1.md` (else a `review-r1-*.md` not named brief/ruling/verify/checklist), else round-1 verdict in the lane row's `reviews[]`; lane = the queue file listing the unit (prefix match wins, else first by name) | new (`reviewScan`, port of `parsers.py:801-889`) | `first_pass_clean.clean` and `.total` equal to `summary.json` for every page whose config has `review_dirs` (all seven) | `no data (n=0, needs units/<ID>/review-r1.md or a stamped round-1 verdict for this lane's units)`; files with no readable verdict are counted and shown, never dropped |

**P3 Review rounds per unit**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| median, max, n per lane | count of `review-rN*.md` files per unit (same exclusions), unioned with stamped `reviews[].round`; fallback `fix_rounds` when the lane has no review records (forge today) | new (`reviewScan` + `laneMetrics`) | `review_rounds.median/.max/.n` equal to `summary.json`, all seven pages | `no data (n=0, needs review round files or fix_rounds stamps)`; the basis string says which source was used |

**P4 Gate minutes per land**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| newest day with a passing gate: lands, median, max, last 5 | `gates[]` entries with `started_at`, `done_at`, `result == "pass"` | new (port of `parsers.py:941-980` `lane_stamps`) | `gate_minutes` equal to `summary.json` for hub, trader, forge, maya, wiki, main; 2.0 excluded as in P1 | `no data (n=<passes>, needs gates[] stamps with result pass)` |

**P5 Standard-process feeds** (does each lane have stamps, review files, gate runs)
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| stamps with/of, review files, gate runs, gate passes | same rows and review scan | new (`laneMetrics.standard`) | `standard.stamps.with/.of`, `.review_files`, `.gate_runs`, `.gate_passes` equal, six pages (2.0's `gate_runs` also counts time-bucket runs: excluded) | zeros shown as zeros: a zero here is a measured fact (the file was read) |

**P6 Time split** (new derivation; no builder oracle exists, see Inventory)
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| per-lane minutes in authoring, review, fix_rounds, gate, waiting; escalation and other | per unit: authoring = `author_done_at − dispatched_at`; review = Σ `reviews[].at − reviews[].dispatched_at`; fix_rounds = Σ `fix_runs[].done_at − .dispatched_at`; gate = Σ `gates[].done_at − .started_at`; waiting = the part of [`ready_at`, `landed_at`] covered by none of those intervals (so gate time is never waiting, REPORT choice 1) | new (`timeSplit`) | **hand-check**, not builder parity: the U4 report recomputes three named landed `main` units by hand from their rows and matches the reader to the minute. The builder's 2.0 time-split panel is marked superseded as **stale since 2026-10-23**, not as matched | `escalation` and `other` always `not recorded (stamps carry no such interval)`; any interval of a unit with a start and no end makes that unit's waiting `null` with a warning (unknown stays unknown); lane totals say `partial` and how many units were left out |

**P7 Owner owes**
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| open owner questions: id, asked by, text, age (red past the TUI's limit) | `GET /api/fleet` → `sources.sm_status.value.queue` (`sm_status.py:713-738`, file `OPS/coordination/owner-queue.jsonl`) | **existing** (COCKPIT-12 path; client reuses `useFleet`) | open ids equal to `python3 ~/.claude/scripts/owner_queue.py list` at the same moment (owner_queue `open_items`, `owner_queue.py:179-180`). The builder's hand-kept "owed" lists (`OPS/status/data/2.0/owed.json`, 2 items, last edited 2026-10-15) are superseded as hand-kept: no numeric parity, the queue is the source of record | `sm_status` reader down: card hidden (12's rule). Source error with no rows: `unavailable: <reason>`. Rows plus error: rows under `unknown: <reason> (rows shown are a lower bound)`. Empty and no error: "Nothing waiting on the owner" |

v1 shows one global list: `parse_queue` drops the record's `unit` field, so owner owes cannot be split per lane without a change to `sm_status.py --json` (owned by the TUI's owner). Not filed (no incident; FILING BAR).

**P8 Rollup** (the master page's process table, `parsers.py:1237` `process_table`)
| panel | data source | reader | parity check | empty/unknown state |
|---|---|---|---|---|
| lanes × {P1..P5} table, each cell with its basis | P1-P5 per lane | new (route assembles) | each cell of the master page's process table for the seven configured projects equals the Compose cell (same as P1-P5 parity, read from `out/master/status.html`'s data or the seven `summary.json`) | a lane with no data shows the `no data (n=<k>, needs <what>)` string, never a blank |

### Stamps reader contract (`C/lib/process-metrics.js`, `C/server/process-routes.js`)
- **Inputs (read-only, fixed roots, no request input ever reaches a path):** `COMPOSE_PROCESS_QUEUES_DIR` (default `~/reg/my/SmartMemory/smart-memory-ops/queues`): every `*-units.json` in it, lane = file name minus `-units.json`. `COMPOSE_PROCESS_UNITS_DIR` (default `.../smart-memory-ops/units`): `readdir` of each unit folder, then only the first classifiable `VERDICT:` line of the review files above. `COMPOSE_PROCESS_EXTRA` (default `forge=~/reg/my/forge/status/units.json`): extra `lane=path` stamp files, comma-separated. Nothing under `~/.claude` is read. A missing queues dir = reader outage (view hidden, one warn); a missing units dir = P2/P3 `no data` with a notice.
- **File shapes accepted** (`unit_stamps.py:38-41`, `parsers.py:826-833`): `{units: {id: row}}`, `{units: [row with id]}`, or a bare list of rows.
- **Fields used per row:** `ready_at`, `dispatched_at`, `author_done_at`, `landed_at`, `fix_rounds`, `reviews[] {round, verdict, at, dispatched_at}`, `fix_runs[] {round, dispatched_at, done_at}`, `gates[] {started_at, done_at, result}`. Everything else is ignored. Retired rows are counted as the builder counts them (it does not skip `state: retired`), so parity holds; this is noted, not changed.
- **Times:** `toLocal(text)` mirrors `to_local` + Python 3.9 `fromisoformat`: `Z` → UTC; `±HH:MM` → that offset; no offset → local wall time; date-only → local midnight; anything else → `null`. Day keys use local dates.
- **Malformed input is never silent:** a lane file that is not JSON makes that lane `{value: null, error: "<lane>: not JSON"}` while other lanes render; a row that is not an object, or a stamp that `toLocal` rejects, is skipped and counted in the lane's `warnings[]` in the payload. One `console.warn('[process] <lane>: <n> rows skipped ...')` per lane when that lane's warning count changes (0 → n, n → m); recovery logs one info line. Review files with no readable verdict are counted (`unclassified`) like `review_scan`.
- **Cache:** `createSourceCache('process', load, { ttlMs: 120_000 })` imported from `fleet-routes.js:233`. Single flight, stale-while-revalidate, one warn per outage. TTL 120 s because the review scan lists ~4,141 unit folders (799 review files today) and the builder itself refreshes every 900 s. The load runs with async `fs/promises`, never blocking the event loop on a sync walk.
- **Route:** `GET /api/process` → `{generated, sources: {process: {value: {lanes: {<lane>: {value, error, warnings, metrics: {waitingShare, firstPassClean, reviewRounds, gateMinutes, standard, timeSplit, noData}}}}, error, ts, stale}}}`, `cache-control: no-store`, same envelope style as `/api/fleet` (`fleet-routes.js:294-305`). Mounted in `C/server/index.js` after `:231`, inside `if (!remoteMode)` (Mac-only; the wiki precedent `:232-233`). No request parameters.

### Route and UI placement
- **Flat view key `process`** (label "Process", tip "Unit process metrics across lanes, live (read-only)"), the 21st entry in `lib/view-keys.js:15-19` and `VIEW_LABELS`, added to `DEFAULT_MAIN_TABS` after `usage` (`viewTabsState.js:20`; existing users get it via `loadMainTabs` `:101-126`), a `TAB_META` entry (`ViewTabs.jsx`, icon `Gauge`, already imported at `:20`), and a `case 'process'` beside `case 'usage'` (`App.jsx:408-409`). Not package-gated: when `/api/process` is down the view shows one "Process metrics unavailable: <reason>" card (it cannot hide a tab the user already sees).
- **Relation to Fleet:** Fleet (Sessions view pane) is *who is working now*; Process is *how the work has been flowing*. They share one fetch: Process mounts `useFleet()` only for the owner-owes card, so no extra `sm_status` spawn (`fleet-routes.js:34` 60 s window). The Ops strip gains nothing.
- **Relation to the AUDIT-17/18 Home page:** none in this feature. Home (`DashboardView.jsx`, `HomeSections.jsx`, `HomeFleetGlance.jsx`) is untouched. AUDIT-17 §2.6 keeps view keys flat and derives rooms from them, so slice 2 may move `process` into a room without changing the key.
- **Deep link:** `?view=<key>` on load sets the initial `activeView` when `isViewKey(key)` (pure `viewFromQuery(search)` in `lib/view-keys.js`); invalid keys are ignored with one console warning; `?popout=` keeps priority (`App.jsx:224-229`).
- **Layout:** top row the P8 rollup table (lanes as rows, P1-P5 as columns, each cell with a `title` basis); below it P6 per selected lane; right column P7 (`OwnerQueueCard`). Refresh: one shared poll every 60 s, paused while the tab is hidden (`processPoller.js`, same shape as `fleetPoller.js`).

### Publish (against the Artifact runtime)
- **What Compose does:** `compose process publish [--out <file>]` and a **Publish** button in the Process view header. Both compute the deep link `http://127.0.0.1:<port>/?view=process`, where port = `COMPOSE_COCKPIT_URL` when set, else 5195 in a source checkout (Vite, `supervisor.js:62`), else `PORT` or 4001 (packaged UI, `index.js:243-245`). Any URL whose host is not `127.0.0.1`, `localhost` or `[::1]` is refused (exit 2 / HTTP 409), so nothing but a loopback link can be produced. The CLI writes the pointer page atomically (`gsd-milestone-report.js:302` pattern) to `--out` (default `.compose/data/process-pointer.html`) and prints the URL, the generated time and the file path. The button calls `GET /api/process/publish` (returns `{url, generatedAt}`, writes nothing) and shows the URL with a copy control and the CLI line.
- **What the pointer page holds:** a static header ("Process metrics: open on this Mac"), the URL twice (one `<a href>` and the same URL as plain selectable text), the generated time. No script, no fetch, no lane name, no number. `renderPointerPage({url, generatedAt})` takes nothing else, so it cannot embed data.
- **What the coordinator does (not Compose):** copy the file to `OPS/artifacts/<seat>/` (brief-footer rule: HTML on disk first), publish it as a private claude.ai artifact with the Artifact tool, open the local file the same turn. Artifacts have been published from Team seats (`OPS/artifacts/seat1..4/`, ledger 2026-10-25 03:45).
- **Data leaving the Mac:** only the pointer page: a loopback URL, a timestamp and a fixed header. The Process data never leaves: the page cannot fetch loopback and has no script, and `/api/process` is not mounted in remote mode.
- **Unverified (checked live in U3, not assumed):** whether a click on the `<a href>` inside the claude.ai artifact frame opens the loopback URL in a new tab. If the frame blocks it, the plain-text URL is the fallback (copy, paste). U3's acceptance records which one happened.

### Units
Order: U1 → U2 → U3 → U4 (U2 needs U1's route; U3 needs U2's deep link; U4 needs all three). Each author pastes `pytest`-free test commands per `test-run-discipline.md` (`node --test <file>`, `npx vitest run <file>`; workers ≤ 4).

**U1 COMP-COCKPIT-13-READER: stamps reader and `/api/process`** (Sonnet, BOUNDED spec; not security-tagged: read-only, fixed roots under `OPS/`, no request input, nothing under `~/.claude`, absent in remote mode)
- [ ] `C/lib/process-metrics.js` (new): pure `toLocal`, `median`, `classifyVerdict`, `laneRows(doc)`, `reviewScan({unitsDir, laneRows})` (async fs), `laneMetrics(rows, reviewRecords, {minUnits: 3})`, `timeSplit(row)`; ports of the `parsers.py` lines named in Panels; no network, no spawn
- [ ] `C/server/process-routes.js` (new): `resolveProcessSources(env)`, `attachProcessRoutes(app, {env, now, warn, info, ttlMs})`, `GET /api/process` with the envelope above; cache from `createSourceCache` (`fleet-routes.js:233`, imported)
- [ ] `C/server/index.js` (existing): mount after `:231` inside `if (!remoteMode)`
- [ ] Malformed lane file, malformed row, bad stamp: per-lane error or `warnings[]`, one warn per change, never a dropped row without a count
- [ ] `C/test/process-metrics.test.js` (new): one explicit row table per helper (`toLocal`: Z, +08:00, naive, date-only, garbage; `median`: odd, even, empty; `classifyVerdict`: CLEAN, CLEAN with follow-ups, NOT_CLEAN, `NOT CLEAN 2 HIGH`, CHANGES REQUIRED, junk; `laneRows`: dict, list, bare list, not-JSON; `laneMetrics`: under 3 units, mixed, gates pass/fail; `timeSplit`: full row, open review, no stamps). No stacked loops; ≤ 60 cases
- [ ] `C/test/fixtures/process/` (new): a small queues + units tree; its expected P1-P5 numbers are produced once by running the builder's own functions on it (`python3 -c` importing `OPS/status/parsers.py`, read-only; the command is pasted in the test file header) and pinned in the table: same input → same numbers
- [ ] `C/test/process-routes.test.js` (new): one row table like `test/fleet-routes.test.js:57-135`: fixture lanes, single flight under concurrent GETs, missing queues dir (outage, one warn, recovery info), not mounted in remote mode
- [ ] `C/CHANGELOG.md` (existing) entry, same commit

**U2 COMP-COCKPIT-13-VIEW: Process view** (Sonnet, BOUNDED; not security-tagged)
- [ ] `C/lib/view-keys.js` (existing): `process` key and label, `viewFromQuery(search)`
- [ ] `C/src/components/cockpit/viewTabsState.js` (existing): `process` in `DEFAULT_MAIN_TABS` after `usage`
- [ ] `C/src/components/cockpit/ViewTabs.jsx` (existing): `TAB_META.process`
- [ ] `C/src/App.jsx` (existing): `case 'process'`; initial `activeView` honours `?view=` (after the popout check)
- [ ] `C/src/lib/processPoller.js` (new): shared 60 s poll of `/api/process`, paused while hidden (shape of `fleetPoller.js`)
- [ ] `C/src/components/cockpit/FleetPanels.jsx` (existing): extract `OwnerQueueCard` (export), Fleet renders it unchanged
- [ ] `C/src/components/cockpit/ProcessView.jsx` (new): P8 table, P6 per lane, P7 card; `no data (...)` strings verbatim; unknown rendered as unknown, never 0
- [ ] `C/test/view-keys.test.js` (existing): rows for `process` and `viewFromQuery`; `C/test/ui/process-view.test.jsx` (new): real route over the U1 fixture tree (as `test/ui/fleet-view.test.jsx` does), one row table: all lanes, one lane erroring, reader down, owner queue unknown
- [ ] `C/docs/cockpit.md` (existing) Zones row for Process; CHANGELOG entry

**U3 COMP-COCKPIT-13-PUBLISH: loopback link and pointer page** (Sonnet, BOUNDED; **security-tagged: export policy**, one pre-land review)
- [ ] `C/lib/process-publish.js` (new): `cockpitBaseUrl({env, hasSourceCheckout})`, `pointerUrl(base)` (refuses non-loopback hosts), `renderPointerPage({url, generatedAt})`, `writePointerPage(path, html)` (atomic)
- [ ] `C/bin/compose.js` (existing): `compose process publish [--out <file>]` beside `metrics` (`:4376`); exit 2 on a refused host
- [ ] `C/server/process-routes.js` (existing after U1): `GET /api/process/publish` → `{url, generatedAt}` or 409
- [ ] `C/src/components/cockpit/ProcessView.jsx` (existing after U2): Publish button, URL, copy, CLI line
- [ ] `C/test/process-publish.test.js` (new): one row table: hosts `127.0.0.1`, `localhost`, `[::1]` accepted; `0.0.0.0`, a LAN IP, a hostname, `https://claude.ai` refused; page has exactly one `<a>`, no `<script>`, contains the URL twice and the time, and none of the fixture lane names
- [ ] Live check by the coordinator (recorded in the U3 report): pointer published from `OPS/artifacts/<seat>/`, link clicked on the Mac; result "link opens" or "blocked, plain-text URL used"

**U4 COMP-COCKPIT-13-PARITY: per-panel parity and supersede notes** (Sonnet, BOUNDED; not security-tagged)
- [ ] `C/scripts/process-parity.mjs` (new): for each of the seven builder pages, compare `summary.json` P1-P5 fields with the U1 reader on the same files; `## Preconditions` row "every input mtime older than summary.json" or `VERDICT: INVALID`; prints `lane | field | builder | compose | match`
- [ ] Report `OPS/units/COMP-COCKPIT-13/report-parity.md`: the table, the 2.0 exclusions (frozen time buckets), the P6 hand-check of three landed `main` units, the P7 id comparison with `owner_queue.py list`
- [ ] Per matched panel only: a "superseded by Compose Process view (COMP-COCKPIT-13), parity <date>" line at the origin, `OPS/status/README.md` (committed by ops-main); `parsers.py` and the builder stay (other panels, `estimate.py`)
- [ ] `C/docs/features/COMP-COCKPIT-13/design.md` and `feature.json` flipped to COMPLETE with the report path

### Out of scope
Any write action; per-lane owner owes (needs `sm_status` to pass `unit`); the builder's non-process panels; Compose-run build metrics (`compose metrics` already covers them); remote mode.
