/**
 * contextSources.js — COMP-SUBAPP-CONTEXT-1: the pure picking logic behind the context panel's "sources" block.
 *
 * For the selected feature code the panel shows what three sub-apps hold about it: the Wiki hub, the last Stratum run and
 * the Cadence unit(s). Each function here takes a data client's answer and returns the picked value, `null` when the read
 * succeeded and nothing matched, or throws `SourceShapeError` when the answer is not the contract's shape (the caller draws
 * that as "unavailable", never as empty).
 */

export const SOURCES = {
  roadmap: 'Roadmap',
  wiki: 'Wiki',
  stratum: 'Stratum',
  cadence: 'Cadence',
};

/** The answer is not the shape its contract names (a misrouted proxy, an older server). */
export class SourceShapeError extends Error {
  constructor(source, expected) {
    super(`${source} answer is not ${expected}`);
    this.name = 'SourceShapeError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Time of an ISO string, or NaN. */
const at = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);

/**
 * The last run of `code`: among the runs whose `featureCode` is exactly `code`, the one with the latest `updatedAt`; a run
 * with no `updatedAt` is ranked by its `startedAt` instead. `basis` says which clock decided for the chosen run.
 * Contract: `RunSummary` (`stratum/ui/src/data-client.ts`, `featureCode` / `startedAt` / `updatedAt`).
 * @returns {{run: object, basis: 'updatedAt'|'startedAt'|null}|null} null when no run carries the code.
 */
export function pickLastRun(runs, code) {
  if (!Array.isArray(runs)) throw new SourceShapeError('Stratum', 'a runs list');
  let best = null;
  let bestKey = -Infinity;
  let bestBasis = null;
  for (const run of runs) {
    if (!isObj(run) || run.featureCode !== code) continue;
    const updated = at(run.updatedAt);
    const started = at(run.startedAt);
    const basis = !Number.isNaN(updated) ? 'updatedAt' : !Number.isNaN(started) ? 'startedAt' : null;
    const key = basis === 'updatedAt' ? updated : basis === 'startedAt' ? started : -Infinity;
    if (best === null || key > bestKey) { best = run; bestKey = key; bestBasis = basis; }
  }
  return best ? { run: best, basis: bestBasis } : null;
}

/**
 * Whether `unit` carries `code`. The one feature-match rule, as `inHostSelection` states it (`cadence/ui/src/model.ts`,
 * COMP-SUBAPP-HOST-1): an exact, case-sensitive code in the unit's stamped `features`; never by id, title or substring, and a
 * unit with no `features` never matches.
 */
export function unitCarriesFeature(unit, code) {
  return isObj(unit) && Array.isArray(unit.features) && unit.features.includes(code);
}

/**
 * The belt's units that carry `code`, in belt order. Contract: `Belt.units` (`cadence/ui/src/data-client.ts`).
 * @returns {object[]|null} null when the belt holds none for the code.
 */
export function pickUnits(belt, code) {
  if (!isObj(belt) || !Array.isArray(belt.units)) throw new SourceShapeError('Cadence', 'a belt with a units list');
  const units = belt.units.filter((u) => unitCarriesFeature(u, code));
  return units.length ? units : null;
}

/**
 * The feature hub's card. Contract: `FeatureHubResult` (`wiki-components/src/data-client.d.ts`): `items` are the feature's docs,
 * `feature` the roadmap feature as the wiki holds it (null when it is not on the wiki's roadmap).
 * @returns {{feature: object|null, docCount: number, docs: object[]}|null} null when the hub has neither a feature nor a doc.
 */
export function pickHub(result) {
  if (!isObj(result) || !Array.isArray(result.items)) throw new SourceShapeError('Wiki', 'a feature hub with an items list');
  const feature = isObj(result.feature) ? result.feature : null;
  if (!feature && result.items.length === 0) return null;
  const docCount = typeof result.total === 'number' ? result.total : result.items.length;
  return { feature, docCount, docs: result.items };
}

/** The Roadmap card's content from the store item (no fetch). */
export function roadmapOf(item, code) {
  if (!item || !code) return null;
  return { code, title: item.title || null, status: item.status || null };
}

/**
 * The state of one source, before any read: a source whose availability is `no` is "not connected" and is not called.
 * @returns {'notConnected'|'ready'}
 */
export function sourceGate(availability) {
  return availability === 'no' ? 'notConnected' : 'ready';
}

/** The one line each non-data state says, naming its source. */
export function stateLine(source, state, code) {
  const name = SOURCES[source];
  switch (state) {
    case 'loading': return `Loading ${name}…`;
    case 'empty': return `No ${name} data for ${code}`;
    case 'unavailable': return `${name} unavailable`;
    case 'notConnected': return `${name} not connected`;
    default: return `${name}: unknown state`;
  }
}
