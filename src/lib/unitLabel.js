/**
 * unitLabel.js — a unit code's plain name from the unit index (COMP-COCKPIT-RULE-PLAIN-1). Pure.
 * `index` is the GET /api/units/index body (`{units: [{id, lane, title, titleSource}], glossary}`), or null while loading.
 */

/** Where a title came from, in the owner's words (titleSource values from lib/unit-index.js). */
export const SOURCE_TEXT = {
  stamp: "from the unit's stamp",
  goal: 'from its goal',
  glossary: 'from the lane glossary',
  brief: 'from its brief',
  unavailable: 'the unit names could not be read (unit index unavailable)',
};

/** Exact id first (preferring `lane` when several lanes share it), then a lane-qualified `lane/id`. */
function findUnit(units, id, lane) {
  const same = units.filter((u) => u.id === id);
  if (same.length) return same.find((u) => u.lane === lane) ?? same[0];
  const slash = id.indexOf('/');
  if (slash > 0) {
    const l = id.slice(0, slash);
    const bare = id.slice(slash + 1);
    return units.find((u) => u.lane === l && u.id === bare) ?? null;
  }
  return null;
}

/**
 * → `{title, code, source}`; source is a titleSource, 'none' (known hole or unknown unit), 'loading' (no response yet) or
 * 'unavailable' (COMP-COCKPIT-SOURCE-FAULTS-1, RULE-PLAIN M2: the index request finished and failed, `opts.error`).
 */
export function unitLabel(id, index, lane, { error = null } = {}) {
  const code = String(id ?? '');
  if (!index || !Array.isArray(index.units)) return { title: null, code, source: error ? 'unavailable' : 'loading' };
  const u = findUnit(index.units, code, lane);
  if (!u || !u.title) return { title: null, code, source: 'none' };
  return { title: u.title, code: u.id, source: u.titleSource ?? 'none' };
}
