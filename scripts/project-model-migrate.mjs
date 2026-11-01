#!/usr/bin/env node
/**
 * project-model-migrate.mjs — COMP-COCKPIT-PROJECT-MODEL-1 (design section 8).
 *
 * Writes the project model's config: `projects.roots` in the cockpit host's `.compose/compose.json`, and a `project`
 * key in each root's own `.compose/compose.json` (created, with a minimal skeleton, when the root has none: trader).
 * Never touches a store or `fleet.*`.
 *
 *   node scripts/project-model-migrate.mjs [--write | --rollback] [--host <dir>] [--backup-dir <dir>] [--seed <file>]
 *
 * Dry run by default: prints the plan (one JSON line). Idempotent: each target is built, deep-compared with the file,
 * and written only on a difference, so a second --write plans 0 files. Before the FIRST write to a file it is copied to
 * `<backup-dir>/<slug>.compose.json.<date>` (a file that did not exist is recorded as absent), listed in
 * `<backup-dir>/migrate-manifest.json`. --rollback restores those copies byte for byte and deletes files that were absent.
 *
 * Inputs: the host's `fleet.projects` (lane order inside a project, and project order by first lane), `fleet.roots`
 * and DEFAULT_FLEET_ROOTS (repo hints), and SEED below: the owner's lane lists (forge-main brief 2026-11-01; Q2: compose
 * and stratum are two lanes on ops lane `forge`; Q3: trader gets a config; Q4: only roots that own an ops lane).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { writeComposeJson } from '../lib/cli-remote.js';
import { DEFAULT_FLEET_ROOTS } from '../server/process-routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HOST = resolve(HERE, '..');
export const DEFAULT_BACKUP_DIR = join(homedir(), 'reg/my/SmartMemory/smart-memory-ops/units/COMP-COCKPIT-PROJECT-MODEL-1/backup');

export const SEED = [
  {
    root: '~/reg/my/SmartMemory',
    project: {
      name: 'smartmemory', label: 'SmartMemory',
      lanes: [
        { id: 'main' }, { id: 'sm20' }, { id: '2.0', repo: 'smart-memory-core' }, { id: 'web' }, { id: 'mcp' },
        { id: 'ops', repo: 'smart-memory-ops' }, { id: 'wiki' }, { id: 'maya', repo: 'maya' }, { id: 'hub' },
        { id: 'bench' }, { id: 'setup' },
      ],
      modules: [],
    },
  },
  {
    root: '~/reg/my/forge',
    project: {
      name: 'forge', label: 'Forge',
      lanes: [
        { id: 'compose', opsLane: 'forge', module: 'compose' },
        { id: 'stratum', opsLane: 'forge', module: 'stratum' },
        { id: 'cadence', module: 'cadence' },
        { id: 'choir', opsLane: 'codegen', module: 'choir' },
      ],
      modules: [
        { name: 'compose', path: 'compose' }, { name: 'stratum', path: 'stratum' },
        { name: 'cadence', path: 'cadence' }, { name: 'choir', path: 'choir' },
      ],
    },
  },
  {
    root: '~/reg/my/stock/trader',
    project: { name: 'trader', label: 'Trader', lanes: [{ id: 'trader' }], modules: [] },
    // Only used when the root has no compose.json yet: the same paths every Compose root carries.
    skeleton: {
      version: 2,
      capabilities: { stratum: false, lifecycle: true },
      paths: { docs: 'docs', features: 'docs/features', journal: 'docs/journal', context: 'docs/context', ideabox: 'docs/product/ideabox.md' },
    },
  },
];

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);
const cfgFile = (dir) => join(dir, '.compose', 'compose.json');
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

/** What writeComposeJson would leave on disk for `patch` (one level of object merge), without writing. */
function mergedPreview(existing, patch) {
  const merged = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    merged[k] = typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...((existing ?? {})[k] || {}), ...v } : v;
  }
  return merged;
}

/** The `project` block for one seed entry, lanes ordered by the host's saved `fleet.projects`. */
export function buildProject(entry, { order = [], hints = {} } = {}) {
  const root = expandHome(entry.root);
  const pos = (lane) => { const i = order.indexOf(lane.opsLane ?? lane.id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const lanes = entry.project.lanes
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (pos(a.l) - pos(b.l)) || (a.i - b.i))
    .map(({ l }) => {
      const lane = { ...l };
      const hint = hints[lane.opsLane ?? lane.id];
      if (!lane.repo && !lane.module && typeof hint === 'string') {
        const abs = expandHome(hint);
        if (isAbsolute(abs) && abs !== root && abs.startsWith(root + sep)) lane.repo = abs.slice(root.length + 1);
      }
      return lane;
    });
  return { ...entry.project, lanes };
}

/** The plan: `[{file, slug, root, patch, create, changed}]`, host first. */
export function planMigration({ host = DEFAULT_HOST, seed = SEED } = {}) {
  const hostCfg = readJson(cfgFile(host)) ?? {};
  const order = Array.isArray(hostCfg?.fleet?.projects) ? hostCfg.fleet.projects : [];
  const hints = { ...DEFAULT_FLEET_ROOTS, ...(hostCfg?.fleet?.roots && typeof hostCfg.fleet.roots === 'object' ? hostCfg.fleet.roots : {}) };
  const firstLane = (e) => Math.min(...e.project.lanes.map((l) => { const i = order.indexOf(l.opsLane ?? l.id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
  const ordered = seed.map((e, i) => ({ e, i })).sort((a, b) => (firstLane(a.e) - firstLane(b.e)) || (a.i - b.i)).map(({ e }) => e);

  const steps = [];
  const hostPatch = { projects: { ...(hostCfg.projects ?? {}), roots: ordered.map((e) => e.root) } };
  steps.push({ file: cfgFile(host), slug: 'host', root: host, patch: hostPatch, create: false });
  for (const e of ordered) {
    const root = expandHome(e.root);
    const existing = readJson(cfgFile(root));
    const project = buildProject(e, { order, hints });
    const patch = existing ? { project } : { ...(e.skeleton ?? {}), project };
    steps.push({ file: cfgFile(root), slug: project.name, root, patch, create: !existing });
  }
  for (const s of steps) {
    const existing = readJson(s.file);
    s.changed = !isDeepStrictEqual(mergedPreview(existing, s.patch), existing);
  }
  return steps;
}

const manifestPath = (dir) => join(dir, 'migrate-manifest.json');

export function applyMigration({ host = DEFAULT_HOST, seed = SEED, backupDir = DEFAULT_BACKUP_DIR, date = new Date().toISOString().slice(0, 10) } = {}) {
  const steps = planMigration({ host, seed });
  const todo = steps.filter((s) => s.changed);
  if (!todo.length) return { written: [] };
  mkdirSync(backupDir, { recursive: true });
  const manifest = readJson(manifestPath(backupDir)) ?? { entries: [] };
  for (const s of todo) {
    if (!manifest.entries.some((m) => m.file === s.file)) {
      const backup = existsSync(s.file) ? join(backupDir, `${s.slug}.compose.json.${date}`) : null;
      if (backup) {
        if (existsSync(backup)) throw new Error(`backup ${backup} already exists and is not in the manifest: not overwriting it`);
        copyFileSync(s.file, backup);
      }
      manifest.entries.push({ file: s.file, backup, createdDir: !existsSync(dirname(s.file)) });
      writeFileSync(manifestPath(backupDir), JSON.stringify(manifest, null, 2) + '\n');
    }
    mkdirSync(dirname(s.file), { recursive: true });
    if (s.create) writeFileSync(s.file, '{}\n');
    writeComposeJson(s.root, s.patch);
  }
  return { written: todo.map((s) => s.file) };
}

export function rollbackMigration({ backupDir = DEFAULT_BACKUP_DIR } = {}) {
  const manifest = readJson(manifestPath(backupDir));
  if (!manifest) throw new Error(`no manifest in ${backupDir}: nothing to roll back`);
  const restored = [];
  for (const m of manifest.entries) {
    if (m.backup) copyFileSync(m.backup, m.file);
    else rmSync(m.file, { force: true });
    restored.push(m.file);
  }
  rmSync(manifestPath(backupDir));
  return { restored };
}

function main(argv) {
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const host = opt('--host') ? resolve(opt('--host')) : DEFAULT_HOST;
  const backupDir = opt('--backup-dir') ? resolve(opt('--backup-dir')) : DEFAULT_BACKUP_DIR;
  const seed = opt('--seed') ? JSON.parse(readFileSync(opt('--seed'), 'utf8')) : SEED;
  if (argv.includes('--rollback')) { console.log(JSON.stringify(rollbackMigration({ backupDir }))); return 0; }
  if (argv.includes('--write')) { console.log(JSON.stringify(applyMigration({ host, seed, backupDir }))); return 0; }
  const steps = planMigration({ host, seed });
  console.log(JSON.stringify({ dryRun: true, planned: steps.filter((s) => s.changed).length, steps: steps.map(({ file, changed, create, patch }) => ({ file, changed, create, patch })) }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
