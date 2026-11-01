/**
 * decisionsPaneLogic.js — pure helpers for the Decisions pane (COMP-COCKPIT-DECISIONS-1).
 *
 * The pane reads GET /api/decisions with plain `fetch` (the route is loopback and global, never workspace-scoped), scoped
 * by the project the cockpit's project chip names. The project comes from the project model (GET /api/projects): the
 * project whose root or module is the cockpit's root.
 */

export const DECISIONS_URL = '/api/decisions';
export const DECIDER_LABELS = { owner: 'Owner', absent: 'Owner-absent', lane: 'Lane', queue: 'Owner queue' };
export const DECIDER_KEYS = Object.keys(DECIDER_LABELS);
export const SCOPES = ['this', 'fleet', 'all'];
export const STANDING_LEGEND = 'standing = no recorded reversal';

const trim = (p) => (typeof p === 'string' ? p.replace(/\/+$/, '') : '');
const moduleRoots = (p) => (Array.isArray(p?.modules) ? p.modules : []).map((m) => trim(typeof m === 'string' ? m : m?.realpath ?? m?.path)).filter(Boolean);

/**
 * The project the cockpit's root belongs to: a project whose root or a module of which is `root` exactly, else the
 * project whose root holds `root` (deepest root wins). Null when there is no model or no match.
 */
export function projectOfRoot(projects, root) {
  const r = trim(root);
  if (!r || !Array.isArray(projects)) return null;
  const exact = projects.find((p) => trim(p.root) === r || moduleRoots(p).includes(r));
  if (exact) return exact;
  const holders = projects.filter((p) => trim(p.root) && r.startsWith(`${trim(p.root)}/`));
  return holders.sort((a, b) => trim(b.root).length - trim(a.root).length)[0] ?? null;
}

/** The `project` query value: the named project for `this` (Fleet-wide when the cockpit's root has no project), else the scope. */
export function projectParam(scope, project) {
  if (scope === 'this') return project?.name ?? 'fleet';
  return scope === 'fleet' ? 'fleet' : 'all';
}

/** The request URL for a filter state. All deciders selected sends no `decider` (the server default). */
export function decisionsUrl({ scope = 'this', project = null, deciders = DECIDER_KEYS, standing = false, q = '', cursor = null, size = 50 } = {}) {
  const sp = new URLSearchParams({ project: projectParam(scope, project) });
  if (deciders.length && deciders.length < DECIDER_KEYS.length) sp.set('decider', deciders.join(','));
  sp.set('status', standing ? 'standing' : 'all');
  if (q.trim()) sp.set('q', q.trim());
  if (cursor) sp.set('cursor', cursor);
  sp.set('size', String(size));
  return `${DECISIONS_URL}?${sp}`;
}

/** Toggle one decider; the last one selected cannot be turned off (an empty filter would mean nothing to show). */
export function toggleDecider(deciders, key) {
  if (deciders.includes(key)) return deciders.length > 1 ? deciders.filter((d) => d !== key) : deciders;
  return DECIDER_KEYS.filter((d) => d === key || deciders.includes(d));
}

/** The small tags a row carries, in display order: `exact D-0001`, `inferred`, `multi`, `relay-only`. */
export function rowTags(row) {
  const out = [];
  if (row.exact) out.push(row.dId ? `exact ${row.dId}` : 'exact');
  else if (row.inferred) out.push('inferred');
  for (const t of row.tags ?? []) if (!out.includes(t)) out.push(t);
  return out;
}

/** Where a row points: its commit (short sha), "commit pending" with the ledger line, the ledger line alone, or the queue id. */
export function rowSource(row) {
  if (row.source === 'owner-queue') return { kind: 'queue', label: row.queueId ?? row.id };
  if (row.commit) return { kind: 'commit', label: row.commit.slice(0, 12), title: `ledger.md:${row.line} @ ${row.commit}` };
  if (row.commitPending) return { kind: 'pending', label: `ledger.md#L${row.line}`, title: 'commit pending: the ledger blame is still building' };
  return { kind: 'line', label: `ledger.md#L${row.line}` };
}

const pad = (n) => String(n).padStart(2, '0');
/** `2026-11-01 11:40` in the browser's local time from a row's `at` (UTC ISO), else its `day`. */
export function rowWhen(row) {
  const d = typeof row.at === 'string' ? new Date(row.at) : null;
  if (!d || Number.isNaN(d.getTime())) return row.day ?? '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The status chip text: `standing`, or `superseded`/`reversed`/`killed` with the line that set it. */
export function statusLabel(row) {
  if (!row.status || row.status === 'standing') return 'standing';
  return row.statusBy?.line ? `${row.status} by L${row.statusBy.line}` : row.status;
}
