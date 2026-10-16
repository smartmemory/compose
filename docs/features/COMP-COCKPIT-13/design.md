# COMP-COCKPIT-13 — Published status page + process-metrics view

**Status:** PLANNED · filed 2026-10-15 (owner request relayed by s1-chat). Filing only, not a build order.

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
1. **Embed or link?** Does the export embed a data snapshot (works offline and when shared, but goes stale) or link to live data (always current, but needs a reachable server)? The owner raised this.
2. **Coverage gap (found while filing, verified 2026-10-15):** Compose state does NOT hold the unit-level stamps the metrics need for most current work. `build-history.jsonl` has 16 rows, the last on 2026-09-19. Units in SmartMemory 2.0, trader and forge run through `detach_job.py` / `jobs.py` / `stamp.py` outside `compose build`, so their authoring/review/fix/gate times live in job files, queue stamps and land logs, not in Compose. "Compose state only" therefore needs one of:
   - (a) Compose ingests those stamps as a recorded input (a new reader, not ledger parsing);
   - (b) units run through Compose so it records them natively;
   - (c) the page shows metrics only for Compose-run units and marks the rest "not recorded".
   Pick before blueprint. **Recommendation (s1-chat and forge-e0, 2026-10-15): (a), Compose ingests the `jobs.py` / `stamp.py`
   stamps as a recorded input.** The owner decides at blueprint.
3. **Source for "owner owes" decision items:** Compose pending gates, the judgment ledger's open positions, or the SmartMemory owner queue (`owner-queue.jsonl`, which COMP-COCKPIT-12 already reads)?
4. **Publish target** for the cockpit button: a claude.ai artifact (as s1-chat does today), a file under `docs/` that DocsView auto-discovers (as `gsd-milestone-report.js` does), or both.
5. **Retiring the scratch builders:** once 13 reaches parity, the `2026-10-15-status-multi` and `2026-10-14-2.0-status` builders are marked superseded at the origin. Define parity per panel first.

## Acceptance (draft, refined at blueprint)
- [ ] `compose status export --project <id>` writes one self-contained `status.html` (no external assets) from Compose state only
- [ ] `compose status export --all` renders the master rollup from the workspace registry
- [ ] The process-metrics panel shows the seven buckets, first-pass CLEAN rate, review rounds per unit, gate minutes per land and waiting share, using the definitions above; unknown values render as unknown
- [ ] An "owner owes" list, distinct from the gate list
- [ ] A cockpit "Publish snapshot" button that runs the same export
- [ ] Readable on a phone (mobile viewport)
- [ ] No hand-kept input file: every number traces to a Compose store
