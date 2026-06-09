/**
 * COMP-MIGRATE-ON-UPGRADE — versioned, eager feature.json state migration.
 *
 * `compose upgrade` refreshes code but historically ran no state migration:
 * vision-state is migrated lazily on every load, but feature.json cold data
 * (e.g. legacy `complexity: null` that fails the schema oneOf) is never touched
 * unless the file happens to be rewritten. This runner walks every feature.json
 * eagerly, applies an ordered registry of pure transforms, and records progress
 * in a durable, dedicated state file.
 *
 * Design: docs/features/COMP-MIGRATE-ON-UPGRADE/design.md (rev 2).
 *
 * Invariants:
 *   - migrateFeature transforms are PURE and TOTAL: no I/O, never throw on
 *     valid-JSON input. (A throw means a migration-code bug → fail-fast.)
 *   - The runner owns all I/O, atomicity (temp+rename), and reporting.
 *   - The stamp lives in .compose/data/migration-state.json — NOT compose.json
 *     (runInit rewrites compose.json from a fixed shape and would drop it; and a
 *     torn write to tracker config would break workspace resolution).
 *   - Convergent: corrupt/unparseable feature.json is REPORTED, not a permanent
 *     block — the stamp still advances, so one bad file can't re-run the whole
 *     stack forever.
 *   - local-provider only; narrative-safe (never regenerates ROADMAP.md).
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  renameSync, unlinkSync, readdirSync,
} from 'fs';
import { join } from 'path';
import { loadFeaturesDir } from './project-paths.js';
import { writeFeature } from './feature-json.js';

/**
 * Ordered, append-only migration registry. Each `migrateFeature` is pure/total.
 * @type {{version:number, id:string, describe:string,
 *         migrateFeature:(f:object)=>{changed:boolean, feature:object}}[]}
 */
// Legacy free-text complexity → schema enum (S/M/L/XL), preserving ordinal intent.
const COMPLEXITY_SYNONYMS = {
  xs: 'S', s: 'S', small: 'S', low: 'S', trivial: 'S',
  m: 'M', medium: 'M', med: 'M', moderate: 'M',
  l: 'L', large: 'L', high: 'L',
  xl: 'XL', 'extra-large': 'XL', 'extra large': 'XL', 'very-high': 'XL', 'very high': 'XL',
};
const VALID_COMPLEXITY = new Set(['S', 'M', 'L', 'XL']);

export const MIGRATIONS = [
  {
    version: 1,
    id: 'normalize-complexity',
    describe: 'Normalize legacy free-text complexity to the S/M/L/XL enum; drop null/unmappable (fails the string|number oneOf)',
    migrateFeature(f) {
      // Total on any parseable JSON value: a non-object (scalar/array/null)
      // feature.json is malformed data, not a migration target — never throw.
      if (!f || typeof f !== 'object' || Array.isArray(f)) return { changed: false, feature: f };
      if (!('complexity' in f)) return { changed: false, feature: f };
      const c = f.complexity;
      // Already schema-valid: a number or an enum member — leave untouched.
      if (typeof c === 'number') return { changed: false, feature: f };
      if (typeof c === 'string' && VALID_COMPLEXITY.has(c)) return { changed: false, feature: f };
      // Mappable legacy free-text → enum.
      if (typeof c === 'string') {
        const mapped = COMPLEXITY_SYNONYMS[c.trim().toLowerCase()];
        if (mapped) return { changed: true, feature: { ...f, complexity: mapped } };
      }
      // null or unmappable (object/garbage string) → drop the optional key.
      const { complexity, ...rest } = f;
      return { changed: true, feature: rest };
    },
  },
];

function stateFilePath(cwd) {
  return join(cwd, '.compose', 'data', 'migration-state.json');
}

/** Read the durable stamp. Absent or corrupt ⇒ {stateVersion:0, applied:[]}. */
export function readMigrationState(cwd) {
  const p = stateFilePath(cwd);
  if (!existsSync(p)) return { stateVersion: 0, applied: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return {
      stateVersion: Number.isInteger(parsed?.stateVersion) ? parsed.stateVersion : 0,
      applied: Array.isArray(parsed?.applied) ? parsed.applied : [],
    };
  } catch {
    // A corrupt state file is treated as version 0; re-running is idempotent.
    return { stateVersion: 0, applied: [] };
  }
}

function writeMigrationStateAtomic(cwd, state) {
  const dir = join(cwd, '.compose', 'data');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'migration-state.json');
  const tmp = `${p}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

/**
 * Tracker classification from `.compose/compose.json`:
 *   'local'      — tracker absent/null or provider==='local'
 *   'non-local'  — an explicit non-local provider (e.g. github)
 *   'unreadable' — config present but not parseable (mirrors factory.js failing
 *                  fast rather than silently assuming local)
 */
function trackerKind(cwd) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
  } catch {
    return 'unreadable';
  }
  const t = cfg.tracker;
  if (t === undefined || t === null || !t.provider || t.provider === 'local') return 'local';
  return 'non-local';
}

/**
 * Run pending feature.json state migrations for the workspace at `cwd`.
 *
 * @param {string} cwd - workspace root
 * @param {{dryRun?: boolean}} [opts]
 * @returns {object} report — one of:
 *   {skipped:'no-workspace'|'non-local-tracker'}
 *   {from, to, dryRun, noop:true, perMigration:[], parseErrors:[]}
 *   {from, to, dryRun, perMigration:[{id,version,touched:[]}], parseErrors:[{path,message}]}
 * @throws if a migrateFeature transform throws (migration-code bug) — aborts
 *         WITHOUT advancing the stamp.
 */
export function runStateMigrations(cwd, opts = {}) {
  const dryRun = !!opts.dryRun;

  // Guard: never write stray state into a non-workspace cwd (e.g. when runUpdate
  // → runInit lands on a process.cwd() that isn't the resolved workspace root).
  if (!existsSync(join(cwd, '.compose', 'compose.json'))) {
    return { skipped: 'no-workspace' };
  }
  const kind = trackerKind(cwd);
  if (kind === 'non-local') return { skipped: 'non-local-tracker' };
  if (kind === 'unreadable') return { skipped: 'unreadable-config' };

  const { stateVersion: from, applied } = readMigrationState(cwd);
  const pending = MIGRATIONS
    .filter((m) => m.version > from)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) {
    return { from, to: from, dryRun, noop: true, perMigration: [], parseErrors: [] };
  }

  const featuresDir = loadFeaturesDir(cwd); // honors paths.features override
  const featuresRoot = join(cwd, featuresDir);
  const perMigration = pending.map((m) => ({ id: m.id, version: m.version, touched: [] }));
  const parseErrors = [];

  // Own directory walk — do NOT use listFeatures(): it silently skips unreadable
  // files, which would hide exactly the cold-data corruption we must surface.
  let dirs = [];
  try {
    dirs = readdirSync(featuresRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    dirs = []; // features dir may not exist yet
  }

  for (const code of dirs) {
    const fpath = join(featuresRoot, code, 'feature.json');
    if (!existsSync(fpath)) continue;
    let feature;
    try {
      feature = JSON.parse(readFileSync(fpath, 'utf-8'));
    } catch (err) {
      parseErrors.push({ path: fpath, message: err.message });
      continue;
    }
    let changedAny = false;
    pending.forEach((m, i) => {
      const res = m.migrateFeature(feature); // pure/total; a throw = migration-code bug → fail-fast
      if (res.changed) {
        feature = res.feature;
        changedAny = true;
        perMigration[i].touched.push(feature.code || code);
      }
    });
    if (changedAny && !dryRun) {
      writeFeature(cwd, feature, featuresDir, { validate: false });
    }
  }

  const to = pending[pending.length - 1].version;
  if (!dryRun) {
    writeMigrationStateAtomic(cwd, {
      stateVersion: to,
      applied: applied.concat(pending.map((m) => ({ version: m.version, id: m.id }))),
    });
  }
  return { from, to, dryRun, perMigration, parseErrors };
}

/** One-line human summary for the upgrade/init narration. */
export function summarizeMigrationReport(report) {
  if (!report || report.skipped) return null;
  if (report.noop) return `state up to date (v${report.to})`;
  const touched = report.perMigration.reduce((n, m) => n + m.touched.length, 0);
  const errs = report.parseErrors.length;
  const dry = report.dryRun ? ' (dry-run)' : '';
  return `migrated ${touched} feature.json across ${report.perMigration.length} migration(s) `
    + `→ stateVersion ${report.to}${errs ? `, ${errs} unparseable (reported)` : ''}${dry}`;
}
