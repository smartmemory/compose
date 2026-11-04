#!/usr/bin/env node
/**
 * lib/completions-cli.js — completions joined with feature class and launch time (COMP-DOGFOOD-ESTIMATES-1, row G).
 *
 *   node lib/completions-cli.js --root <workspace> [--since 30d]
 *   node lib/completions-cli.js --root <workspace> --launch-of <unit>
 *
 * Prints one JSON line per completion, newest first: `{feature_code, class, recorded_at, launched_at, completion_id}`.
 * `class` is the feature's own `class` or null (estimate.py then derives it). `launched_at` is the first `launch.requested`
 * row for the same unit in <workspace>/.compose/data/feature-events.jsonl, or null. Completions come from getCompletions
 * (never a second parser of feature.json). `--launch-of <unit>` prints the one line `{unit, class, launched_at}` for a unit that
 * may not be complete yet (the `due` lookup in estimate.py), with the same first-launch rule. Read-only. Bad usage exits 1; a read failure exits 2 with the reason on stderr.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCompletions } from './completion-writer.js';
import { readFeature } from './feature-json.js';
import { loadFeaturesDir } from './project-paths.js';
import { readLaunchEvents } from './launch-events.js';

const LIMIT = 500; // getCompletions' own maximum

function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** unit -> launched_at of its first `launch.requested` row. */
function firstLaunches(root) {
  const first = new Map();
  for (const e of readLaunchEvents(root)) {
    if (e.tool !== 'launch.requested' || !e.unit || !e.launched_at) continue;
    const prev = first.get(e.unit);
    if (prev === undefined || Date.parse(e.launched_at) < Date.parse(prev)) first.set(e.unit, e.launched_at);
  }
  return first;
}

export function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  const root = opt(argv, '--root');
  if (!root) {
    io.err.write('usage: node lib/completions-cli.js --root <workspace> [--since 30d]   (--root is required)\n');
    return 1;
  }
  const since = opt(argv, '--since');
  const launchOf = opt(argv, '--launch-of');
  try {
    if (launchOf !== undefined) {
      if (!launchOf) { io.err.write('completions-cli: --launch-of needs a unit code\n'); return 1; }
      io.out.write(JSON.stringify({
        unit: launchOf,
        class: readFeature(root, launchOf, loadFeaturesDir(root))?.class ?? null,
        launched_at: firstLaunches(root).get(launchOf) ?? null,
      }) + '\n');
      return 0;
    }
    const { completions } = getCompletions(root, { since, limit: LIMIT });
    if (completions.length >= LIMIT) {
      io.err.write(`WARNING completions-cli: ${LIMIT} completions returned, the reader's maximum; older ones in the window were not read\n`);
    }
    const firstLaunch = firstLaunches(root);
    const featuresDir = loadFeaturesDir(root);
    const classOf = new Map();
    for (const rec of completions) {
      const code = rec.feature_code;
      if (code && !classOf.has(code)) classOf.set(code, readFeature(root, code, featuresDir)?.class ?? null);
    }
    for (const rec of completions) {
      io.out.write(JSON.stringify({
        feature_code: rec.feature_code,
        class: classOf.get(rec.feature_code) ?? null,
        recorded_at: rec.recorded_at,
        launched_at: firstLaunch.get(rec.feature_code) ?? null,
        completion_id: rec.completion_id ?? null,
      }) + '\n');
    }
    return 0;
  } catch (err) {
    io.err.write(`completions-cli: ${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
