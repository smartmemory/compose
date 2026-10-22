/**
 * experiment-registry.js — the per-stage grading registry writer (COMP-STAGE-GRADING-4, G4).
 *
 * Spec: docs/features/COMP-MODEL-AB-DECISION/registry-contract.json (schema, `rules`, `semantic[]`, `#promotion`)
 * and stage-run-contract.json (the run records read here). Plan: plan.md `### G4`.
 *
 *   writeRegistry(results, runs, {registryPath, champion, fixtureId, seed, resamples})
 *       groups the stage run records into cells, applies the admission and measured/triaged rules, computes the
 *       signed uplift against the champion cell, and writes registry.json atomically.
 *   promoteRows / demoteRows (registry, args) -> new registry     (pure; #promotion)
 *   validateRegistrySemantics(registry, ctx) -> [{code, rowId}]    (S1..S8; an empty list is the only pass)
 *   selectRows(registry, opts)                                     (the selection helper A1 imports)
 *
 * Uplift is a pure function of persisted state (COMP-STAGE-GRADING-4-FU-1): every row keeps its admitted per-run
 * `accuracies` (parallel to `sourceRunIds`), and every uplift records the champion rowId and the sample revisions of
 * both arms. The writer, promoteRows and demoteRows all recompute every dependant from the persisted samples, so an
 * uplift can never outlive the samples or the champion row it was computed from (S9, S10).
 *
 * No model calls. Only registry.json is read and written.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const REGISTRY_VERSION = 1;
export const JUDGED_STAGES = new Set(['design', 'plan']);
export const STAGES = ['design', 'plan', 'implement', 'review', 'test-authoring', 'debug', 'end-to-end'];
export const DEFAULT_SEED = 7;
export const DEFAULT_RESAMPLES = 1000;

export class RegistryError extends Error {
  constructor(code, message, violations = []) {
    super(`${code}: ${message}`);
    this.name = 'RegistryError';
    this.code = code;
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON and keys (rules.canonicalJson, rules.compatKey, rules.cellKey)
// ---------------------------------------------------------------------------

/** Keys sorted at every depth, no whitespace. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

const sha256 = s => createHash('sha256').update(s).digest('hex');

export function compatKeyOf({ stage, archetypeVersion, fixtureDigest, oracleVersion }) {
  return sha256(canonicalJson({ stage, archetypeVersion, fixtureDigest, oracleVersion }));
}

export function cellKeyOf(stage, ing) {
  return `${stage}|${ing.provider}|${ing.modelID}|${ing.effort}|${ing.workflow}`;
}

function stableStringify(v) {
  const sort = x => Array.isArray(x) ? x.map(sort)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x;
  return JSON.stringify(sort(v), null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// generatedAt as an instant (S6: never string order, date-time allows offsets)
// ---------------------------------------------------------------------------

// [whole epoch seconds, fraction digits]; reads every RFC 3339 form ajv-formats accepts (t/space, z, +hh, +hhmm,
// +hh:mm, leap second :60 as the next second). Date.parse alone returns NaN for +hh and :60 and drops sub-ms digits.
function instant(t) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[t\s](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(z|([+-])(\d\d)(?::?(\d\d))?)$/i.exec(String(t));
  if (!m) throw new RegistryError('BAD_TIMESTAMP', `not an RFC 3339 date-time: ${t}`);
  const off = /z/i.test(m[8]) ? 0 : (m[9] === '-' ? -1 : 1) * (+m[10] * 60 + +(m[11] || 0));
  return [Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 - off * 60, m[7] || ''];
}

/** true iff instant a is strictly later than instant b. */
export function later(a, b) {
  const [x, f] = instant(a); const [y, g] = instant(b);
  return x !== y ? x > y : f.padEnd(g.length, '0') > g.padEnd(f.length, '0');
}

// ---------------------------------------------------------------------------
// Admission (rules.admission, $defs.admittedRun)
// ---------------------------------------------------------------------------

/** A run is admitted iff it completed, has no _error, is not skipped, its oracle ran, accuracy is a number in [0,1],
 *  and both controls held (canaryOk and mechanismEngaged are true, not merely truthy). */
export function isAdmitted(run) {
  if (!run || run._error !== undefined || run.skipped !== undefined) return false;
  const s = run.metrics?.stage;
  return run.metrics?.outcome?.completed === true
    && s?.oracleError === null
    && typeof s.accuracy === 'number' && Number.isFinite(s.accuracy) && s.accuracy >= 0 && s.accuracy <= 1
    && s.canaryOk === true
    && s.mechanismEngaged === true;
}

/** The measured/triaged decision (S2). Judged stages need a promotion. */
export function stateFor(stage, promotion, nAdmitted, nAttempted) {
  const promoted = !JUDGED_STAGES.has(stage) || promotion != null;
  if (promoted && nAdmitted >= 3 && nAdmitted * 3 >= nAttempted * 2) return { state: 'measured', triageReason: null };
  const triageReason = JUDGED_STAGES.has(stage) && promotion == null ? 'JUDGED_UNPROMOTED'
    : nAdmitted < 3 ? 'LOW_N' : 'LOW_ADMISSION';
  return { state: 'triaged', triageReason };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function medianOf(nums) {
  const s = [...nums].sort((a, b) => a - b); const n = s.length; const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function spreadOf(nums) {
  return { median: medianOf(nums), min: Math.min(...nums), max: Math.max(...nums) };
}

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Signed uplift of `source` over `champion`: delta of median accuracy (source minus champion) with a 95% percentile
 * bootstrap interval. Each resample draws, in order, source.length source values then champion.length champion values,
 * each index floor(rng() * length), from a mulberry32 stream seeded with `seed`. Inputs are ordered by runId by the caller.
 * ci95 = [sorted[floor(B*25/1000)], sorted[ceil(B*975/1000) - 1]] over the B resampled deltas.
 */
export function bootstrapUplift(source, champion, { seed = DEFAULT_SEED, resamples = DEFAULT_RESAMPLES } = {}) {
  const rng = mulberry32(seed);
  const draw = arr => { const out = new Array(arr.length); for (let i = 0; i < arr.length; i++) out[i] = arr[Math.floor(rng() * arr.length)]; return out; };
  const deltas = [];
  for (let b = 0; b < resamples; b++) { const s = draw(source); const c = draw(champion); deltas.push(medianOf(s) - medianOf(c)); }
  deltas.sort((a, b) => a - b);
  return {
    delta: medianOf(source) - medianOf(champion),
    ci95: [deltas[Math.floor(resamples * 25 / 1000)], deltas[Math.ceil(resamples * 975 / 1000) - 1]],
    method: 'bootstrap',
    resamples,
    seed,
  };
}

/** Revision of a row's samples: sha256 of the canonical {sourceRunIds, accuracies}. An uplift records it for both arms. */
export const sampleRevisionOf = row => sha256(canonicalJson({ sourceRunIds: row.sourceRunIds, accuracies: row.accuracies }));

/**
 * The champion row a source row's uplift is computed against (rules.uplift): among `measured` rows of the source's stage
 * and compatKey whose cellKey is `cell`, the one with the SAME catalogDigest first, else the newest generatedAt (parsed
 * instant), else the greater rowId (the tiebreak buildLatest uses). null when none exists.
 */
export function pickChampion(rows, source, cell) {
  let best = null;
  const beats = (a, b) => {
    const sa = a.catalogDigest === source.catalogDigest; const sb = b.catalogDigest === source.catalogDigest;
    if (sa !== sb) return sa;
    if (later(a.generatedAt, b.generatedAt)) return true;
    return !later(b.generatedAt, a.generatedAt) && a.rowId > b.rowId;
  };
  for (const r of rows) {
    if (r.state !== 'measured' || r.stage !== source.stage || r.compatKey !== source.compatKey || r.cellKey !== cell || r.rowId === source.rowId) continue;
    if (!best || beats(r, best)) best = r;
  }
  return best;
}

// reliability (contract names it, never defines it): per admitted run 1 / (1 + retries + escalations + gateFailures).
const reliabilityOf = run => {
  const p = run.metrics?.process ?? {};
  return 1 / (1 + (p.retries ?? 0) + (p.escalations ?? 0) + (p.gateFailures ?? 0));
};

function vectorOf(admitted) {
  if (admitted.length === 0) return { accuracy: null, tokensIn: null, tokensOut: null, usd: null, wallMs: null, reliability: null };
  const col = f => admitted.map(f);
  const usd = col(r => r.metrics?.cost?.usd);
  return {
    accuracy: spreadOf(col(r => r.metrics.stage.accuracy)),
    tokensIn: spreadOf(col(r => r.metrics?.cost?.tokensIn ?? 0)),
    tokensOut: spreadOf(col(r => r.metrics?.cost?.tokensOut ?? 0)),
    usd: usd.every(u => typeof u === 'number' && Number.isFinite(u)) ? spreadOf(usd) : null,
    wallMs: spreadOf(col(r => r.metrics?.cost?.wallMs ?? 0)),
    reliability: spreadOf(col(reliabilityOf)),
  };
}

// ---------------------------------------------------------------------------
// latest index (S5, S6)
// ---------------------------------------------------------------------------

/** latest[stage][compatKey][cellKey] = rowId of the newest `measured` row; complete; never a prior row. */
export function buildLatest(rows) {
  const best = new Map();
  for (const r of rows) {
    if (r.state !== 'measured') continue;
    const k = `${r.stage}\u0000${r.compatKey}\u0000${r.cellKey}`;
    const cur = best.get(k);
    if (!cur || later(r.generatedAt, cur.generatedAt) || (!later(cur.generatedAt, r.generatedAt) && r.rowId > cur.rowId)) best.set(k, r);
  }
  const latest = {};
  for (const r of best.values()) ((latest[r.stage] ??= {})[r.compatKey] ??= {})[r.cellKey] = r.rowId;
  return latest;
}

// ---------------------------------------------------------------------------
// Semantic validation (registry-contract $.semantic S1..S8) — ported from the G1 reference checker
// ---------------------------------------------------------------------------

export function validateRegistrySemantics(registry, ctx = {}) {
  const out = []; const add = (code, rowId) => out.push({ code, rowId });
  const rows = registry.rows ?? []; const latest = registry.latest ?? {};
  const byId = new Map(rows.map(r => [r.rowId, r]));
  const list = x => (Array.isArray(x) ? x : null);
  for (const r of rows) {
    if (r.state === 'prior') continue;
    if (r.nAdmitted > r.nAttempted) add('COUNT_ORDER', r.rowId);
    if (!['INCOMPATIBLE', 'JUDGE_DRIFT'].includes(r.triageReason)) {
      const eligible = (!JUDGED_STAGES.has(r.stage) || r.promotion !== null) && r.nAdmitted >= 3 && r.nAdmitted * 3 >= r.nAttempted * 2;
      if ((r.state === 'measured') !== eligible) add('MEASURED_RULE', r.rowId);
      else if (r.state === 'triaged') {
        const want = JUDGED_STAGES.has(r.stage) && r.promotion === null ? 'JUDGED_UNPROMOTED' : r.nAdmitted < 3 ? 'LOW_N' : 'LOW_ADMISSION';
        if (r.triageReason !== want) add('MEASURED_RULE', r.rowId);
      }
    }
    const at = list(r.attemptedRunIds); const sr = list(r.sourceRunIds);
    if (!at || !sr || at.length !== r.nAttempted || sr.length !== r.nAdmitted || new Set(at).size !== at.length
      || new Set(sr).size !== sr.length || !sr.every(x => at.includes(x))) add('RUN_ID_COUNTS', r.rowId);
    if (r.state !== 'measured' ? r.uplift !== null || r.upliftNullReason !== 'SOURCE_NOT_MEASURED'
      : r.uplift === null && r.upliftNullReason !== 'NO_COMPATIBLE_CHAMPION') add('UPLIFT_ARM_STATE', r.rowId);
  }
  for (const r of rows) {
    if (r.state !== 'prior' && r.uplift
      && !rows.some(x => x.state === 'measured' && x.cellKey === r.uplift.championCellKey && x.compatKey === r.compatKey)) add('CHAMPION_MEASURED', r.rowId);
  }
  for (const r of rows) {
    if (r.state === 'prior') continue;
    const acc = list(r.accuracies); const vec = r.vector?.accuracy;
    if (!acc || !Array.isArray(r.sourceRunIds) || acc.length !== r.sourceRunIds.length
      || !acc.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)
      || (acc.length === 0 ? vec !== null : !vec || canonicalJson(vec) !== canonicalJson(spreadOf(acc)))) add('SAMPLE_VECTOR', r.rowId);
  }
  for (const r of rows) {
    if (r.state === 'prior' || !r.uplift) continue;
    const ch = byId.get(r.uplift.championRowId);
    if (!ch || ch.state !== 'measured' || ch.stage !== r.stage || ch.compatKey !== r.compatKey || ch.cellKey !== r.uplift.championCellKey
      || pickChampion(rows, r, r.uplift.championCellKey)?.rowId !== ch.rowId
      || r.uplift.sourceSampleRevision !== sampleRevisionOf(r) || r.uplift.championSampleRevision !== sampleRevisionOf(ch)) add('UPLIFT_BINDING', r.rowId);
  }
  for (const [st, byCk] of Object.entries(latest)) for (const [k, byCell] of Object.entries(byCk)) for (const [cellKey, id] of Object.entries(byCell)) {
    const row = byId.get(id);
    if (!row) { add('LATEST_UNRESOLVED', id); continue; }
    if (row.state === 'prior') { add('PRIOR_EXCLUDED', id); continue; }
    const peers = rows.filter(x => x.state === 'measured' && x.stage === st && x.compatKey === k && x.cellKey === cellKey);
    if (row.state !== 'measured' || row.stage !== st || row.compatKey !== k || row.cellKey !== cellKey
      || peers.some(x => later(x.generatedAt, row.generatedAt))) add('LATEST_UNRESOLVED', id);
  }
  for (const r of rows) if (r.state === 'measured' && !Object.hasOwn(latest[r.stage]?.[r.compatKey] ?? {}, r.cellKey)) add('LATEST_UNRESOLVED', r.rowId);
  const target = ctx.explicitCatalogDigest ?? ctx.currentCatalogDigest;
  for (const id of ctx.selectedRowIds || []) {
    const row = byId.get(id);
    if (!row) { add('LATEST_UNRESOLVED', id); continue; }
    if (row.state === 'prior') add('PRIOR_EXCLUDED', id);
    else if (row.state !== 'measured' || row.catalogDigest !== target) add('STALE_CATALOG', id);
  }
  return out;
}

function assertSemantics(registry, what) {
  const v = validateRegistrySemantics(registry, {});
  if (v.length) throw new RegistryError('SEMANTIC_VIOLATION', `${what} would break ${[...new Set(v.map(x => x.code))].join(', ')}`, v);
}

// ---------------------------------------------------------------------------
// Row assembly from run records
// ---------------------------------------------------------------------------

const emptyRegistry = () => ({ version: REGISTRY_VERSION, rows: [], latest: {} });

export function readRegistry(registryPath) {
  if (!existsSync(registryPath)) return emptyRegistry();
  const reg = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!reg || !Array.isArray(reg.rows)) throw new RegistryError('BAD_REGISTRY', `${registryPath} is not a registry`);
  return { version: reg.version ?? REGISTRY_VERSION, rows: reg.rows, latest: reg.latest ?? {} };
}

/** Atomic write (temp file in the same directory, then rename). Validates S1..S8 first; skips the write when unchanged. */
export function saveRegistry(registryPath, registry) {
  assertSemantics(registry, 'registry.json');
  const text = stableStringify(registry);
  if (existsSync(registryPath) && readFileSync(registryPath, 'utf8') === text) return false;
  mkdirSync(dirname(registryPath), { recursive: true });
  const tmp = `${registryPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { writeFileSync(tmp, text); renameSync(tmp, registryPath); } finally { rmSync(tmp, { force: true }); }
  return true;
}

const byRunId = (a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);

/** Group executed stage runs into cells: (stage, cellKey, compatKey, catalogDigest). Runs without an identity are ignored. */
function groupRuns(runs) {
  const byId = new Map();
  for (const run of runs ?? []) if (run?.runId) byId.set(run.runId, run);
  const groups = new Map(); const ignored = [];
  for (const run of [...byId.values()].sort(byRunId)) {
    if (run.skipped !== undefined) continue; // skipped runs carry no identity and are not attempts
    const k = run.runKeyInputs; const stage = run.archetype?.id;
    if (!k?.ingredients || !k.fixtureDigest || !k.oracleVersion || !k.catalogDigest || !run.archetype?.version || !STAGES.includes(stage) || !run.metrics?.stage) {
      ignored.push(run.runId); continue;
    }
    const compatKey = compatKeyOf({ stage, archetypeVersion: run.archetype.version, fixtureDigest: k.fixtureDigest, oracleVersion: k.oracleVersion });
    const cellKey = cellKeyOf(stage, k.ingredients);
    const gk = `${stage}\u0000${cellKey}\u0000${compatKey}\u0000${k.catalogDigest}`;
    if (!groups.has(gk)) groups.set(gk, { stage, cellKey, compatKey, catalogDigest: k.catalogDigest, ingredients: { ...k.ingredients }, archetypeVersion: run.archetype.version, fixtureDigest: k.fixtureDigest, oracleVersion: k.oracleVersion, runs: [] });
    groups.get(gk).runs.push(run);
  }
  return { groups: [...groups.values()].sort((a, b) => (a.stage + a.cellKey + a.compatKey + a.catalogDigest < b.stage + b.cellKey + b.compatKey + b.catalogDigest ? -1 : 1)), ignored };
}

function championFor(champion, stage) {
  if (!champion) return null;
  return typeof champion === 'string' ? champion : champion[stage] ?? null;
}

/** rowId -> the champion cell, seed and resamples of every uplift now on a row; read BEFORE a mutation nulls them. */
function hintsOf(rows) {
  const hints = new Map();
  for (const r of rows) if (r.state !== 'prior' && r.uplift) hints.set(r.rowId, { cell: r.uplift.championCellKey, seed: r.uplift.seed, resamples: r.uplift.resamples });
  return hints;
}

/**
 * Recompute or null EVERY uplift in `rows` from the persisted samples (S4, S8, S9). A source row that is not `measured`
 * has none (SOURCE_NOT_MEASURED). A measured row keeps the champion cell its previous uplift named (`hints`), unless this
 * call names one for it (`opts.champion`, which wins for rows in `freshIds` and fills in rows with no recorded cell);
 * the champion row is then pickChampion's, so a replaced, promoted or demoted champion re-points or nulls its dependants.
 * No champion row, or no persisted samples to bootstrap from: null NO_COMPATIBLE_CHAMPION.
 */
function recomputeUplifts(rows, hints, { freshIds = new Set(), champion = null, seed = DEFAULT_SEED, resamples = DEFAULT_RESAMPLES } = {}) {
  for (const r of rows) {
    if (r.state === 'prior') continue;
    if (r.state !== 'measured') { r.uplift = null; r.upliftNullReason = 'SOURCE_NOT_MEASURED'; continue; }
    const hint = hints.get(r.rowId); const named = championFor(champion, r.stage); const fresh = freshIds.has(r.rowId);
    const cell = fresh ? (named ?? hint?.cell) : (hint?.cell ?? named);
    const champ = cell && cell !== r.cellKey ? pickChampion(rows, r, cell) : null;
    if (!champ || !Array.isArray(r.accuracies) || !Array.isArray(champ.accuracies)) { r.uplift = null; r.upliftNullReason = 'NO_COMPATIBLE_CHAMPION'; continue; }
    const o = fresh || !hint ? { seed, resamples } : { seed: hint.seed, resamples: hint.resamples };
    r.uplift = {
      championCellKey: cell, championRowId: champ.rowId,
      championSampleRevision: sampleRevisionOf(champ), sourceSampleRevision: sampleRevisionOf(r),
      ...bootstrapUplift(r.accuracies, champ.accuracies, o),
    };
    r.upliftNullReason = null;
  }
}

/**
 * Build the registry rows for `runs` and merge them into `existing`: a row with the same rowId is replaced in place
 * (keeping a recorded promotion and a JUDGE_DRIFT/INCOMPATIBLE decision), any other row is appended. A replacement is a
 * COMPLETE cell snapshot: it must list every attempt the row already records, else INCOMPLETE_SNAPSHOT and nothing merges.
 * Every uplift in the registry is then recomputed from the persisted samples (recomputeUplifts).
 * Returns {registry, ignoredRunIds, rowIds}.
 */
export function mergeRuns(existing, results, runs, opts = {}) {
  const { groups, ignored } = groupRuns(runs);
  const experimentId = results?.experimentId ?? 'experiment';
  const seed = opts.seed ?? DEFAULT_SEED; const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const rows = existing.rows.map(r => structuredClone(r));
  const hints = hintsOf(rows);
  const dropped = [];

  const fresh = groups.map(g => {
    const attempted = g.runs; const admitted = attempted.filter(isAdmitted);
    const rowId = `row-${g.stage}-${sha256(canonicalJson({ experimentId, cellKey: g.cellKey, compatKey: g.compatKey, catalogDigest: g.catalogDigest })).slice(0, 16)}`;
    const prev = rows.find(r => r.rowId === rowId);
    for (const id of prev?.attemptedRunIds ?? []) if (!attempted.some(r => r.runId === id)) dropped.push(`${rowId}:${id}`);
    const promotion = JUDGED_STAGES.has(g.stage) ? (prev?.promotion ?? null) : null;
    const keep = prev && ['JUDGE_DRIFT', 'INCOMPATIBLE'].includes(prev.triageReason);
    const decision = keep ? { state: 'triaged', triageReason: prev.triageReason } : stateFor(g.stage, promotion, admitted.length, attempted.length);
    let generatedAt = attempted[0].manifest?.endedAt;
    for (const r of attempted) if (r.manifest?.endedAt && (!generatedAt || later(r.manifest.endedAt, generatedAt))) generatedAt = r.manifest.endedAt;
    if (!generatedAt) throw new RegistryError('NO_TIMESTAMP', `cell ${g.cellKey} has no manifest.endedAt on any run`);
    const row = {
      rowId, stage: g.stage, cellKey: g.cellKey, compatKey: g.compatKey, ingredients: g.ingredients,
      catalogDigest: g.catalogDigest, fixtureId: opts.fixtureId ?? `${g.stage}-${g.fixtureDigest.slice(0, 12)}`,
      fixtureDigest: g.fixtureDigest, archetypeVersion: g.archetypeVersion, oracleVersion: g.oracleVersion,
      state: decision.state, triageReason: decision.triageReason,
      nAttempted: attempted.length, nAdmitted: admitted.length, vector: vectorOf(admitted),
      uplift: null, upliftNullReason: decision.state === 'measured' ? 'NO_COMPATIBLE_CHAMPION' : 'SOURCE_NOT_MEASURED',
      promotion, sourceRunIds: admitted.map(r => r.runId), accuracies: admitted.map(r => r.metrics.stage.accuracy), experimentId, generatedAt,
      attemptedRunIds: attempted.map(r => r.runId),
    };
    return row;
  });
  if (dropped.length) throw new RegistryError('INCOMPLETE_SNAPSHOT', `a replacement must list every attempt the row already records; missing ${dropped.join(', ')}`, dropped);

  for (const row of fresh) {
    const i = rows.findIndex(r => r.rowId === row.rowId);
    if (i >= 0) rows[i] = row; else rows.push(row);
  }
  recomputeUplifts(rows, hints, { freshIds: new Set(fresh.map(r => r.rowId)), champion: opts.champion, seed, resamples });
  return { registry: { version: existing.version ?? REGISTRY_VERSION, rows, latest: buildLatest(rows) }, ignoredRunIds: ignored, rowIds: fresh.map(r => r.rowId) };
}

/**
 * Append or replace the registry rows for this experiment's stage run records and write registry.json atomically.
 * opts: registryPath (required), champion (a cellKey, or {stage: cellKey}), fixtureId, seed, resamples.
 * Returns {registry, written, rowIds, ignoredRunIds}; writes nothing when no run carries a stage identity.
 */
export function writeRegistry(results, runs, opts = {}) {
  if (!opts.registryPath) throw new RegistryError('NO_PATH', 'registryPath is required');
  const existing = readRegistry(opts.registryPath);
  const { registry, ignoredRunIds, rowIds } = mergeRuns(existing, results, runs, opts);
  if (rowIds.length === 0) return { registry: existing, written: false, rowIds, ignoredRunIds };
  return { registry, written: saveRegistry(opts.registryPath, registry), rowIds, ignoredRunIds };
}

// ---------------------------------------------------------------------------
// Promotion and demotion (registry-contract $defs.promotionEvidence, promoteRowsArgs, demoteRowsArgs; rules.demoted)
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
function checkEvidence(e) {
  const bad = why => { throw new RegistryError('BAD_EVIDENCE', why); };
  if (!e || typeof e !== 'object') bad('evidence is required');
  if (e.gatePassed !== true) throw new RegistryError('GATE_NOT_PASSED', 'promotion needs evidence.gatePassed === true');
  if (typeof e.calibrationReport !== 'string' || !e.calibrationReport) bad('calibrationReport');
  if (!Array.isArray(e.panelModels) || e.panelModels.length === 0 || !e.panelModels.every(m => typeof m === 'string' && m)) bad('panelModels');
  if (!HEX64.test(e.judgeCatalogDigest ?? '')) bad('judgeCatalogDigest');
  if (typeof e.agreement !== 'number' || !(e.agreement >= 0 && e.agreement <= 1)) bad('agreement');
  const extra = Object.keys(e).filter(k => !['calibrationReport', 'panelModels', 'judgeCatalogDigest', 'gatePassed', 'agreement'].includes(k));
  if (extra.length) bad(`unknown evidence field ${extra[0]}`);
}

function finish(rows, what, hints) {
  recomputeUplifts(rows, hints);
  const registry = { version: REGISTRY_VERSION, rows, latest: buildLatest(rows) };
  assertSemantics(registry, what);
  return registry;
}

function pickRows(rows, rowIds) {
  if (!Array.isArray(rowIds) || rowIds.length === 0) throw new RegistryError('BAD_ARGS', 'rowIds must be a non-empty array');
  return rowIds.map(id => {
    const r = rows.find(x => x.rowId === id);
    if (!r) throw new RegistryError('UNKNOWN_ROW', id);
    if (r.state === 'prior') throw new RegistryError('PRIOR_ROW', `${id} is a prior row`);
    if (!JUDGED_STAGES.has(r.stage)) throw new RegistryError('NOT_JUDGED_STAGE', `${id} is stage ${r.stage}`);
    return r;
  });
}

/** Attach promotion evidence to judged-stage rows and re-decide measured/triaged (S2). Pure: returns a new registry. */
export function promoteRows(registry, { rowIds, evidence } = {}) {
  checkEvidence(evidence);
  const rows = registry.rows.map(r => structuredClone(r)); const hints = hintsOf(rows);
  for (const target of pickRows(rows, rowIds)) {
    target.promotion = structuredClone(evidence);
    if (target.triageReason === 'INCOMPATIBLE') continue;
    const d = stateFor(target.stage, target.promotion, target.nAdmitted, target.nAttempted);
    target.state = d.state; target.triageReason = d.triageReason;
  }
  // a newly measured row names no champion cell yet (null uplift until a write names one); a promoted champion re-binds its dependants
  return finish(rows, 'promoteRows', hints);
}

/** Judge drift: triaged JUDGE_DRIFT, promotion kept as the record, uplift nulled here and recomputed (or nulled) on every row that used it as champion. */
export function demoteRows(registry, { rowIds, reason } = {}) {
  if (reason !== 'JUDGE_DRIFT') throw new RegistryError('BAD_ARGS', 'reason must be JUDGE_DRIFT');
  const rows = registry.rows.map(r => structuredClone(r)); const hints = hintsOf(rows);
  for (const target of pickRows(rows, rowIds)) {
    if (target.promotion == null) throw new RegistryError('NOT_PROMOTED', `${target.rowId} has no promotion to demote`);
    target.state = 'triaged'; target.triageReason = 'JUDGE_DRIFT';
  }
  return finish(rows, 'demoteRows', hints);
}

// ---------------------------------------------------------------------------
// Selection helper (assembly, A1): what may be used to pick a model
// ---------------------------------------------------------------------------

/**
 * Rows assembly may select for a stage: the `latest` measured rows (never prior, triaged or an unpromoted judged row)
 * whose catalogDigest equals the target (explicitCatalogDigest, else currentCatalogDigest; S7). Rows of another
 * digest are returned in `refused` with STALE_CATALOG instead of being selected.
 */
export function selectRows(registry, { stage, compatKey = null, currentCatalogDigest, explicitCatalogDigest = null } = {}) {
  const target = explicitCatalogDigest ?? currentCatalogDigest;
  const byId = new Map(registry.rows.map(r => [r.rowId, r]));
  const rows = []; const refused = [];
  for (const [ck, byCell] of Object.entries(registry.latest?.[stage] ?? {})) {
    if (compatKey && ck !== compatKey) continue;
    for (const id of Object.values(byCell)) {
      const r = byId.get(id);
      if (!r || r.state !== 'measured' || (JUDGED_STAGES.has(r.stage) && r.promotion == null)) continue;
      if (r.catalogDigest === target) rows.push(r); else refused.push({ rowId: id, code: 'STALE_CATALOG' });
    }
  }
  return { rows, refused };
}
