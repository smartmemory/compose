/**
 * init-progress.js — landed-of-planned for one status page (COMP-COCKPIT-INIT-DATA-1). Pure: the builder's `data.json`
 * says what is PLANNED, the lane stamps (via lib/unit-index.js) say what has LANDED. The builder's own `status` lags the
 * stamps (forge's COMP-AUDIT-17-18 reads `planned` with a note "landed 10-30 22:31"), so it is never the count.
 * A unit with no stamp row is `notRecorded`, never counted as landed and never as not-landed-for-sure.
 */

// The builder writes a landing into the note as "LANDED <sha>" or "...; landed 10-30 22:31"; "after X landed" is not one.
const NOTE_LANDED_RE = /(^|;)\s*landed\b/i;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** True when the builder itself calls the unit landed (its status, or a note that starts a clause with "landed"). */
export function builderSaysLanded(unit) {
  return unit?.status === 'landed' || NOTE_LANDED_RE.test(String(unit?.note ?? ''));
}

/**
 * `builderData` is the page's `data.json`; `unitIndex` is the units of the SAME lane (an array, or `{units}` as
 * `buildUnitIndex` returns), matched by id. Returns
 * `{planned, landed, builderOnly, notRecorded, nodes: [{id, title, titleSource, landedAt, builderStatus, deps}]}`:
 * `builderOnly` = the builder says landed and no stamp has a landing time, `notRecorded` = no stamp row at all.
 */
export function initProgress(builderData, unitIndex) {
  const rows = Array.isArray(unitIndex) ? unitIndex : (unitIndex?.units ?? []);
  const stamp = new Map(rows.map((u) => [u.id, u]));
  const units = Array.isArray(builderData?.units) ? builderData.units : [];
  const nodes = units.map((b) => {
    const s = stamp.get(String(b.id));
    const title = str(s?.title) ?? str(b.goal) ?? str(b.what);
    return {
      id: String(b.id),
      title,
      titleSource: str(s?.title) ? (s.titleSource ?? 'stamp') : (title ? 'builder' : 'none'),
      landedAt: s?.landedAt ?? null,
      builderStatus: b.status ?? null,
      deps: Array.isArray(b.deps) ? b.deps.map(String) : [],
      builderLanded: builderSaysLanded(b),
      recorded: s !== undefined,
    };
  });
  const landed = nodes.filter((n) => n.landedAt).length;
  const builderOnly = nodes.filter((n) => n.builderLanded && !n.landedAt).length;
  const notRecorded = nodes.filter((n) => !n.recorded).length;
  return {
    planned: nodes.length, landed, builderOnly, notRecorded,
    nodes: nodes.map(({ builderLanded, recorded, ...n }) => n),
  };
}

/** The landed nodes, newest first (ISO times compare as text; a bad time sorts last). */
export function landedList(nodes) {
  const t = (n) => { const ms = Date.parse(n.landedAt); return Number.isNaN(ms) ? -Infinity : ms; };
  return (nodes ?? []).filter((n) => n.landedAt).sort((a, b) => t(b) - t(a));
}

/** How many warnings the builder printed ("unknown stage" and the like); a page without the key has none. */
export function noticeCount(builderData) {
  return Array.isArray(builderData?.notices) ? builderData.notices.length : 0;
}
