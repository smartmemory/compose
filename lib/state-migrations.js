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
import { resolveFeaturesPath } from './project-paths.js';
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
    target: 'feature',
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
  {
    version: 2,
    id: 'normalize-vision-legacy',
    target: 'vision',
    describe: 'Vision-state: legacy `featureCode: "feature:X"` → `lifecycle.featureCode` + normalize legacy gate outcomes to the imperative enum',
    migrateState(state) { return migrateVisionState(state); },
  },
];

// ---------------------------------------------------------------------------
// COMP-MIGRATE-UNIFY-VISION — shared vision-state transforms.
//
// These two transforms were historically inlined AND duplicated in
// server/vision-store.js and lib/vision-writer.js, run lazily on every
// vision-state load. They are folded here as the single implementation, reused
// by both:
//   - the load-time paths (vision-store._load / vision-writer._load), and
//   - the eager runner below — so cold vision-state the server never loads
//     (e.g. a frozen forge-top store) is migrated by `compose migrate-state`.
//
// Scope is EXACTLY these two transforms. Each file's other load-time work —
// gate/pending dedup, slug/files/group derivation — is deliberately NOT folded
// here (it differs per call site and is out of this consolidation's scope).
//
// They MUTATE their argument in place (and report `changed`) by design: the
// on-disk byte image must stay identical to the previous inline behavior, which
// mutated in place, so key-insertion order is preserved exactly. They are
// otherwise pure (no I/O) and idempotent.
// ---------------------------------------------------------------------------

const GATE_OUTCOME_MAP = { approved: 'approve', killed: 'kill', revised: 'revise' };

/** Normalize a legacy past-tense gate outcome to the imperative enum. Pure/total/idempotent. */
export function normalizeGateOutcome(outcome) {
  return GATE_OUTCOME_MAP[outcome] || outcome;
}

/**
 * Migrate one vision item's legacy `featureCode: "feature:X"` to
 * `lifecycle.featureCode: "X"`. Mutates `item` in place (for byte-identity with
 * the prior inline code) and reports whether anything changed. No-op when the
 * binding is already in lifecycle form or the field is absent.
 *
 * PURE + TOTAL (the registry invariant): never throws on parseable JSON. The
 * `typeof === 'string'` guard is deliberate — the prior inline loaders called
 * `.startsWith` unguarded and would THROW on a malformed truthy non-string
 * `featureCode` (a load-path crash → fresh-state fallback). On real corpora every
 * `featureCode` is a string-or-absent, so the on-disk output is byte-identical;
 * the only divergence is that pathological non-string values now no-op instead of
 * crashing, which is required so the eager runner (no per-item try/catch) stays
 * total. Out of scope to "fix" such malformed data here — this only consolidates.
 * @param {object} item
 * @returns {{changed: boolean}}
 */
export function migrateVisionItemFeatureCode(item) {
  if (!item || typeof item !== 'object') return { changed: false };
  if (item.featureCode && typeof item.featureCode === 'string'
      && item.featureCode.startsWith('feature:') && !item.lifecycle?.featureCode) {
    const bare = item.featureCode.replace(/^feature:/, '');
    item.lifecycle = item.lifecycle || {};
    item.lifecycle.featureCode = bare;
    delete item.featureCode;
    return { changed: true };
  }
  return { changed: false };
}

/**
 * Apply the legacy vision-state transforms across a whole parsed vision-state
 * object: `featureCode→lifecycle.featureCode` over `items[]` and gate-outcome
 * normalization over `gates[]`. Mutates in place and also returns the object so
 * either the return value or the original reference may be used. Total on any
 * parseable shape (missing/non-array items/gates are skipped).
 * @param {object} state
 * @returns {{changed: boolean, state: object}}
 */
export function migrateVisionState(state) {
  let changed = false;
  if (state && Array.isArray(state.items)) {
    for (const item of state.items) {
      if (migrateVisionItemFeatureCode(item).changed) changed = true;
    }
  }
  if (state && Array.isArray(state.gates)) {
    for (const gate of state.gates) {
      if (gate && gate.outcome) {
        const normalized = normalizeGateOutcome(gate.outcome);
        if (normalized !== gate.outcome) { gate.outcome = normalized; changed = true; }
      }
    }
  }
  return { changed, state };
}

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
 * Atomically rewrite `.compose/data/vision-state.json`, byte-for-byte matching
 * VisionWriter._atomicWrite (2-space JSON + trailing newline, temp + rename).
 */
function writeVisionStateAtomic(cwd, state) {
  const dir = join(cwd, '.compose', 'data');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'vision-state.json');
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
 * Run pending state migrations for the workspace at `cwd`. Feature-target
 * migrations walk every feature.json; vision-target migrations walk the single
 * `.compose/data/vision-state.json` (COMP-MIGRATE-UNIFY-VISION) using the same
 * pure transforms the server's load-time path uses. One shared `stateVersion`
 * stamp covers both.
 *
 * @param {string} cwd - workspace root
 * @param {{dryRun?: boolean}} [opts]
 * @returns {object} report — one of:
 *   {skipped:'no-workspace'|'non-local-tracker'|'unreadable-config'}
 *   {from, to, dryRun, noop:true, perMigration:[], parseErrors:[]}
 *   {from, to, dryRun, perMigration:[{id,version,target,touched:[]}], parseErrors:[{path,message}]}
 * @throws if a migrate transform throws (migration-code bug) — aborts WITHOUT
 *         advancing the stamp.
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

  // Migrations dispatch by `target` (default 'feature'): feature-target ones
  // walk every feature.json; vision-target ones walk the single vision-state.json.
  const featurePending = pending.filter((m) => (m.target || 'feature') === 'feature');
  const visionPending = pending.filter((m) => m.target === 'vision');

  const perMigration = pending.map((m) => ({
    id: m.id, version: m.version, target: m.target || 'feature', touched: [],
  }));
  const perMigrationByVersion = new Map(perMigration.map((p) => [p.version, p]));
  const parseErrors = [];

  // --- feature.json walk -----------------------------------------------------
  if (featurePending.length > 0) {
    const featuresDir = resolveFeaturesPath(cwd); // absolute; honors paths.features override
    const featuresRoot = featuresDir;
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
      for (const m of featurePending) {
        const res = m.migrateFeature(feature); // pure/total; a throw = migration-code bug → fail-fast
        if (res.changed) {
          feature = res.feature;
          changedAny = true;
          perMigrationByVersion.get(m.version).touched.push(feature.code || code);
        }
      }
      if (changedAny && !dryRun) {
        writeFeature(cwd, feature, featuresDir, { validate: false });
      }
    }
  }

  // --- vision-state.json walk (COMP-MIGRATE-UNIFY-VISION) ---------------------
  // Eagerly migrate cold vision-state the running server never loaded. Same pure
  // transforms the load-time paths use, so the result is byte-identical.
  if (visionPending.length > 0) {
    const vpath = join(cwd, '.compose', 'data', 'vision-state.json');
    if (existsSync(vpath)) {
      let state = null;
      try {
        state = JSON.parse(readFileSync(vpath, 'utf-8'));
      } catch (err) {
        parseErrors.push({ path: vpath, message: err.message }); // reported, never blocks the stamp
      }
      if (state) {
        let changedAny = false;
        for (const m of visionPending) {
          const res = m.migrateState(state); // mutates in place; throw = migration-code bug → fail-fast
          if (res.changed) {
            changedAny = true;
            perMigrationByVersion.get(m.version).touched.push('vision-state.json');
          }
        }
        if (changedAny && !dryRun) {
          writeVisionStateAtomic(cwd, state);
        }
      }
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
  const dry = report.dryRun ? ' (dry-run)' : '';
  const errs = report.parseErrors.length;
  const errClause = errs ? `, ${errs} unparseable (reported)` : '';

  // Feature migrations report touched feature.json files; vision migrations
  // touch the single vision-state.json. Absent `target` ⇒ 'feature' (back-compat
  // with the COMP-MIGRATE-ON-UPGRADE report shape).
  const feature = report.perMigration.filter((m) => (m.target || 'feature') === 'feature');
  const vision = report.perMigration.filter((m) => m.target === 'vision');
  const parts = [];
  if (feature.length) {
    const touched = feature.reduce((n, m) => n + m.touched.length, 0);
    parts.push(`migrated ${touched} feature.json across ${feature.length} migration(s)`);
  }
  if (vision.length) {
    const touched = vision.reduce((n, m) => n + m.touched.length, 0);
    parts.push(`vision-state ${touched ? 'migrated' : 'up to date'} across ${vision.length} migration(s)`);
  }
  if (parts.length === 0) parts.push('no migrations applied');
  return `${parts.join('; ')} → stateVersion ${report.to}${errClause}${dry}`;
}
