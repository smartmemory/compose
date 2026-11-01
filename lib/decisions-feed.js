/**
 * decisions-feed.js — COMP-COCKPIT-DECISIONS-1: decision rows -> one page of the Decisions pane.
 *
 * Project attribution (design section 4), in order: the unit-ID prefixes a row names, then the writing session's
 * lane, then the relay target (`-> forge-main`, `Sent to forge-main`). Lanes come from COMP-COCKPIT-PROJECT-MODEL-1's
 * `laneIndex`; the prefix map comes from data (the first token of each project's store featureCodes). A row with no
 * project is Fleet-wide. A row naming units of two projects shows in both. `projectsOf` is the one function to swap
 * when the source of projects changes.
 */

export const DECIDERS = ['owner', 'absent', 'lane', 'queue'];
export const PAGE_SIZE = 50;
export const PAGE_MAX = 200;
/** A prefix belongs to a project holding at least this share of its codes (COMP is 457 forge, 1 SmartMemory). */
export const PREFIX_SHARE = 0.2;
export const PREFIX_MIN = 2;

const PREFIX_RE = /^[A-Z][A-Z0-9]{1,}$/;

/** `[{project, codes}]` -> `Map(prefix -> [project])`, by share of each prefix's codes (design section 4: noise prefixes drop out). */
export function buildPrefixMap(stores, extra = []) {
  const counts = new Map(); // prefix -> Map(project -> n)
  for (const { project, codes } of stores) {
    for (const code of codes) {
      const p = String(code).split('-')[0];
      if (!PREFIX_RE.test(p)) continue;
      if (!counts.has(p)) counts.set(p, new Map());
      const m = counts.get(p);
      m.set(project, (m.get(project) ?? 0) + 1);
    }
  }
  const out = new Map();
  for (const [p, m] of counts) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const owners = [...m].filter(([, n]) => n >= PREFIX_MIN && n >= PREFIX_SHARE * total).map(([proj]) => proj);
    if (owners.length) out.set(p, owners);
  }
  for (const { prefix, project } of extra) {
    const p = String(prefix).replace(/-+$/, '');
    if (PREFIX_RE.test(p) && !out.get(p)?.includes(project)) out.set(p, [...(out.get(p) ?? []), project]);
  }
  return out;
}

const RELAY_TARGET_RE = /(?:->|→|\b[Ss]ent to|\b[Rr]elayed to|\b[Hh]anded to|\b[Rr]outed to)\s+([a-z][a-z0-9]*)-main\b/g;

/** The ops lane a session name belongs to (`forge-main` -> forge, `sm20-main` -> sm20), or null. */
export function laneOfSession(who, laneIndex) {
  for (const tok of String(who ?? '').split(/[-→]/)) if (Object.hasOwn(laneIndex, tok)) return tok;
  return null;
}

/** `(row) -> [project names]`; empty means Fleet-wide. */
export function makeProjectResolver({ laneIndex = {}, prefixMap = new Map() } = {}) {
  return function projectsOf(row) {
    const byUnit = new Set();
    for (const u of row.units ?? []) for (const p of prefixMap.get(u.split('-')[0]) ?? []) byUnit.add(p);
    if (byUnit.size) return [...byUnit];
    const lane = laneOfSession(row.by, laneIndex);
    if (lane) return [laneIndex[lane].project];
    const targets = new Set();
    for (const m of String(row.text ?? '').matchAll(RELAY_TARGET_RE)) if (Object.hasOwn(laneIndex, m[1])) targets.add(laneIndex[m[1]].project);
    return [...targets];
  };
}

/** Query string -> filters, or `{error}`. */
export function parseFilters(q = {}) {
  const project = typeof q.project === 'string' && q.project.trim() ? q.project.trim() : 'all';
  let decider = DECIDERS;
  if (typeof q.decider === 'string' && q.decider.trim()) {
    decider = q.decider.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = decider.filter((d) => !DECIDERS.includes(d));
    if (bad.length) return { error: `decider must be among ${DECIDERS.join(', ')} (got ${bad.join(', ')})` };
  }
  const status = q.status === 'standing' ? 'standing' : 'all';
  if (q.status !== undefined && !['standing', 'all'].includes(q.status)) return { error: 'status must be standing or all' };
  const text = typeof q.q === 'string' ? q.q.trim().toLowerCase().slice(0, 200) : '';
  const size = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(q.size, 10) || PAGE_SIZE));
  const cursor = Math.max(0, Number.parseInt(q.cursor, 10) || 0);
  return { project, decider, status, q: text, size, cursor };
}

const inProject = (row, project) => (project === 'all' ? true : project === 'fleet' ? row.projects.length === 0 : row.projects.includes(project));

/**
 * Rows (any order) + filters -> `{total, rows, nextCursor, counts}`, newest first. `counts.projects` counts rows per
 * project under the decider/status/text filters (so the project control can show them), `counts.decider` under the
 * project/status/text filters.
 */
export function pageDecisions(rows, filters, projectsOf) {
  const all = rows.map((r) => ({ ...r, projects: projectsOf(r) }));
  const textOk = (r) => !filters.q || `${r.id} ${r.summary} ${r.text} ${r.units.join(' ')} ${r.by ?? ''}`.toLowerCase().includes(filters.q);
  const statusOk = (r) => filters.status === 'all' || r.status === 'standing';
  const deciderOk = (r) => filters.decider.includes(r.decider);
  const counts = { projects: { all: 0, fleet: 0 }, decider: Object.fromEntries(DECIDERS.map((d) => [d, 0])) };
  for (const r of all) {
    if (!textOk(r) || !statusOk(r)) continue;
    if (deciderOk(r)) {
      counts.projects.all += 1;
      if (!r.projects.length) counts.projects.fleet += 1;
      for (const p of r.projects) counts.projects[p] = (counts.projects[p] ?? 0) + 1;
    }
    if (inProject(r, filters.project)) counts.decider[r.decider] += 1;
  }
  const kept = all.filter((r) => textOk(r) && statusOk(r) && deciderOk(r) && inProject(r, filters.project))
    .sort((a, b) => b.ts - a.ts || (b.line ?? 0) - (a.line ?? 0));
  const page = kept.slice(filters.cursor, filters.cursor + filters.size);
  const next = filters.cursor + filters.size;
  return { total: kept.length, rows: page, nextCursor: next < kept.length ? String(next) : null, counts };
}
