/**
 * smartmemory-sync.js — COMP-SMARTMEMORY-INGEST S05
 *
 * Idempotent backfill/re-sync walker: `compose smartmemory sync`. Walks the
 * four persisted surfaces (feature-events, gate-log, journal entries,
 * per-feature artifacts), in order, and ingests each as one SmartMemory item.
 * Re-running is safe (Decision 4 dedupe regimes): events dedupe by content
 * hash, files dedupe by source_path.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { getSmartmemoryConfig, resolveProjectTag, sourcePathFor } from './smartmemory-config.js';
import { createSmartmemoryClient, SmartmemoryHttpError } from './smartmemory-client.js';
import {
  renderFeatureEventContent, renderGateLogContent,
  buildFeatureEventContext, buildGateLogContext,
} from './smartmemory-ingest.js';
import { readEvents } from './feature-events.js';
import { readGateLog } from '../server/gate-log-store.js';
import { parseJournalEntry } from './journal-writer.js';
import { listFeatures } from './feature-json.js';
import { loadFeaturesDir, resolveFeaturesPath, resolveJournalPath, relForDisplay } from './project-paths.js';

const ARTIFACT_FILES = [
  { file: 'design.md', kind: 'design' },
  { file: 'blueprint.md', kind: 'blueprint' },
  { file: 'plan.md', kind: 'plan' },
  { file: 'report.md', kind: 'report' },
  { file: 'audit.json', kind: 'audit' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gateLogPathFor(cwd) {
  return process.env.COMPOSE_GATE_LOG || join(cwd, '.compose', 'data', 'gate-log.jsonl');
}

/**
 * Surface 1: feature-events.jsonl — malformed lines are already skipped by
 * readEvents. May throw (naked fs read) — caller wraps per-surface.
 */
function collectFeatureEventItems(cwd, feature, tag) {
  const items = [];
  const events = readEvents(cwd);
  for (const row of events) {
    // OR semantics (blueprint.md ~line 176): a row carrying BOTH fields must
    // still match on `feature_code` even when `code` differs — nullish
    // coalescing (`code ?? feature_code`) would wrongly ignore `feature_code`
    // whenever `code` is present at all.
    if (feature && row.code !== feature && row.feature_code !== feature) continue;
    items.push({ content: renderFeatureEventContent(row, tag), context: buildFeatureEventContext(tag, row) });
  }
  return items;
}

/**
 * Surface 2: gate-log.jsonl. May throw (naked fs read) — caller wraps
 * per-surface.
 */
function collectGateLogItems(cwd, feature, tag) {
  const items = [];
  const gateEntries = readGateLog({ featureCode: feature ?? undefined, logPath: gateLogPathFor(cwd) });
  for (const entry of gateEntries) {
    items.push({ content: renderGateLogContent(entry, tag), context: buildGateLogContext(tag, entry) });
  }
  return items;
}

/**
 * Surface 3: journal entries — file regime (import:compose, source_path =
 * dedupe key). Direct directory walk, NOT getJournalEntries: that reader
 * hard-caps at MAX_LIMIT=500 (wrong for a backfill walker, which must walk
 * everything) and silently drops unreadable/unparseable files instead of
 * accounting for them, which would break this walker's skipped-count
 * contract.
 *
 * A journal entry is defined by filename shape AND parse success (the same
 * contract the canonical reader enforces) — not just "any *.md file". A
 * stray non-entry .md file is simply not a candidate: it is never ingested
 * and never counted as skipped. Per-file read/parse failures increment
 * `skipped` via the returned counter (not thrown) so one broken entry never
 * takes down the rest of the surface; a failure to even list the directory
 * (e.g. it's not a directory at all) DOES throw — the caller wraps that.
 */
function collectJournalItems(cwd, feature, tag) {
  const items = [];
  let skipped = 0;

  const journalDir = resolveJournalPath(cwd);
  if (!existsSync(journalDir)) return { items, skipped };

  // Exact filename pattern from lib/journal-writer.js:44 (FILENAME_RE, not
  // exported — replicated here rather than editing that module).
  const JOURNAL_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-session-(\d+)-([a-z0-9][a-z0-9-]*[a-z0-9])\.md$/;

  const candidates = [];
  for (const name of readdirSync(journalDir)) {
    const m = name.match(JOURNAL_FILENAME_RE);
    if (!m) continue; // not a candidate at all — not counted
    candidates.push({ name, date: m[1], session_number: parseInt(m[2], 10) });
  }

  // Newest-first, mirroring lib/journal-writer.js:920-923 exactly (date desc,
  // then session_number desc) — matters because runSync stops on quota 429,
  // so a partial sync must ingest the newest entries first.
  candidates.sort((a, b) => {
    if (b.date !== a.date) return b.date.localeCompare(a.date);
    return b.session_number - a.session_number;
  });

  for (const { name } of candidates) {
    const absPath = join(journalDir, name);
    let text;
    try {
      text = readFileSync(absPath, 'utf-8');
    } catch {
      skipped++;
      continue;
    }

    // Always parse — a candidate that fails to parse is skipped, not ingested.
    let parsed;
    try {
      parsed = parseJournalEntry(text);
    } catch {
      skipped++;
      continue;
    }
    if (feature && parsed.feature_code !== feature) continue;

    items.push({
      content: text,
      context: {
        origin: 'import:compose',
        project: tag,
        source_path: sourcePathFor(tag, relForDisplay(cwd, absPath)),
      },
    });
  }

  return { items, skipped };
}

/**
 * Surface 4: per-feature artifacts — file regime. Per-file read failures
 * increment `skipped` (not thrown); a failure to list features or the
 * features directory itself DOES throw — the caller wraps that.
 */
function collectArtifactItems(cwd, feature, tag) {
  const items = [];
  let skipped = 0;

  const allFeatures = listFeatures(cwd, loadFeaturesDir(cwd));
  const targetFeatures = feature ? allFeatures.filter((f) => f.code === feature) : allFeatures;
  const featuresAbsDir = resolveFeaturesPath(cwd);
  for (const f of targetFeatures) {
    const folder = join(featuresAbsDir, f.code);
    for (const { file, kind } of ARTIFACT_FILES) {
      const absPath = join(folder, file);
      if (!existsSync(absPath)) continue;
      let text;
      try {
        text = readFileSync(absPath, 'utf-8');
      } catch {
        skipped++;
        continue;
      }
      items.push({
        content: text,
        context: {
          origin: 'import:compose',
          project: tag,
          source_path: sourcePathFor(tag, relForDisplay(cwd, absPath)),
          artifact: { feature_code: f.code, kind },
        },
      });
    }
  }

  return { items, skipped };
}

/**
 * Walk the four surfaces and build the flat, ordered list of {content,
 * context} items to ingest, honoring the `--feature CODE` filter (Decision 5
 * semantics): entries with no feature association are excluded when `feature`
 * is set, included in a full sync.
 *
 * Each surface is collected independently, wrapped in its own try/catch: a
 * surface whose top-level read throws (e.g. a corrupted directory in its
 * path) is reported (one `skipped` increment + a console.warn naming the
 * surface and the error) and does NOT abort the other three surfaces.
 */
function collectItems(cwd, feature, tag) {
  const items = [];
  let skipped = 0;

  const surfaces = [
    { name: 'feature-events', collect: () => ({ items: collectFeatureEventItems(cwd, feature, tag), skipped: 0 }) },
    { name: 'gate-log', collect: () => ({ items: collectGateLogItems(cwd, feature, tag), skipped: 0 }) },
    { name: 'journal', collect: () => collectJournalItems(cwd, feature, tag) },
    { name: 'artifacts', collect: () => collectArtifactItems(cwd, feature, tag) },
  ];

  for (const surface of surfaces) {
    try {
      const result = surface.collect();
      items.push(...result.items);
      skipped += result.skipped;
    } catch (err) {
      skipped++;
      console.warn(`[smartmemory-sync] ${surface.name} surface read failed (skipping this surface): ${err.message}`);
    }
  }

  return { items, skipped };
}

/**
 * Walk the four persisted surfaces and ingest each item (idempotent).
 * @param {{ cwd: string, dryRun?: boolean, feature?: string|null }} opts
 * @returns {Promise<{ ingested:number, unchanged:number, skipped:number, failed:number, stoppedOnQuota:boolean }>}
 */
export async function runSync({ cwd, dryRun = false, feature = null }) {
  const cfg = getSmartmemoryConfig(cwd);
  if (cfg.enabled !== true && !dryRun) {
    throw new Error('smartmemory not enabled');
  }

  const tag = resolveProjectTag(cwd);
  const { items, skipped } = collectItems(cwd, feature, tag);

  let ingested = 0;
  let unchanged = 0;
  let failed = 0;
  let stoppedOnQuota = false;

  if (dryRun) {
    return { ingested: items.length, unchanged: 0, skipped, failed: 0, stoppedOnQuota: false };
  }

  const client = createSmartmemoryClient(cfg);

  for (const item of items) {
    let result;
    try {
      result = await client.ingest(item.content, item.context);
    } catch (err) {
      if (err instanceof SmartmemoryHttpError && err.status === 429) {
        await sleep(1000);
        try {
          result = await client.ingest(item.content, item.context);
        } catch (err2) {
          if (err2 instanceof SmartmemoryHttpError && err2.status === 429) {
            stoppedOnQuota = true;
            break;
          }
          failed++;
          continue;
        }
      } else {
        failed++;
        continue;
      }
    }
    if (result.unchanged) unchanged++;
    else ingested++;
  }

  return { ingested, unchanged, skipped, failed, stoppedOnQuota };
}
