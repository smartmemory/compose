/**
 * lib/fluid/record-shape.js — record rules that belong to the seam, not to a provider.
 *
 * Two rules lived as private members of `LocalFluidProvider` while it was the
 * only provider, and the moment a second one exists they are drift generators:
 *
 *   1. `normalizeRecord()` — the contract-default filling and defensive cloning
 *      that `_normalize` did (COMP-FOH C12).
 *   2. `assertPatchable()` — the `UNPATCHABLE` refusal that `updateRecord` did
 *      (COMP-FOH C16).
 *
 * WHY THESE ARE SHARED AND NOT COPIED
 * -----------------------------------
 * Both encode a promise the *seam* makes, not a choice a provider gets to make.
 * `getRecord` returning a record whose optional fields are filled to contract
 * defaults is what lets a caller read a record written before a field existed;
 * `updateRecord` refusing to patch `discussion` is what makes the deliberation
 * trail evidence rather than a mutable blob. A provider that implements either
 * one differently is not a slower or simpler provider — it is a provider with a
 * different contract, which defeats the point of the swap.
 *
 * The second copy is the dangerous one, because it is the one nobody re-reads.
 * `local-provider.js` enforces `UNPATCHABLE` and says why in a comment that a
 * new provider's author would never see.
 *
 * Pure functions only — no I/O, no store, no provider reference — so both
 * providers and the tests can call them directly.
 */

import { KIND } from './provider.js';

/** Handle prefix per record kind. Handles are quoted in docs and must be short
 *  and stable; the prefix set is fixed here so two providers allocate the same
 *  shape of handle for the same kind. */
export const HANDLE_PREFIX = Object.freeze({
  [KIND.IDEA]: 'IDEA',
  [KIND.POSITION]: 'POS',
  [KIND.JOINT]: 'JOINT',
  [KIND.DECISION]: 'DEC',
  [KIND.THREAD]: 'THREAD',
  [KIND.QUESTION]: 'Q',
  [KIND.CLUSTER]: 'CLUS',
});

/**
 * Handle grammar, with the suffix bounded to 9 digits.
 *
 * The bound is load-bearing, not cosmetic. Allocation reads the suffix as a
 * Number; past the exact-integer range `max + 1 === max`, so importing a
 * gigantic handle would make the allocator hand the same one out forever. The
 * contract carries the same bound.
 */
export const HANDLE_RE = /^([A-Z][A-Z0-9]*)-([1-9][0-9]{0,8})$/;

/** Canonical fluid lifecycle states, per the contract's `status` enum. */
export const FLUID_STATUSES = Object.freeze(new Set(['new', 'discussing', 'promoted', 'killed']));

/** Link types the contract defines. Validated so a typo becomes an error at the
 *  write rather than a silently unqueryable edge. */
export const LINK_TYPES = Object.freeze(new Set([
  'promoted_to', 'maps_to', 'informs', 'blocks',
  'supports', 'contradicts', 'supersedes', 'duplicate_of',
]));

export function assertStatus(status) {
  if (!FLUID_STATUSES.has(status)) {
    throw new Error(
      `fluid: invalid status "${status}" (expected one of: ${[...FLUID_STATUSES].join(', ')})`
    );
  }
  return status;
}

/** A caller-supplied handle must be well-formed AND belong to its kind — an
 *  `idea` carrying `DEC-4` would be invisible to idea handle allocation and
 *  would collide with a real decision later. */
export function assertHandle(handle, kind) {
  const m = HANDLE_RE.exec(handle ?? '');
  if (!m) {
    throw new Error(`fluid: malformed handle "${handle}" (expected PREFIX-N, N >= 1)`);
  }
  const expected = HANDLE_PREFIX[kind];
  if (m[1] !== expected) {
    throw new Error(
      `fluid: handle "${handle}" does not belong to kind "${kind}" (expected prefix ${expected})`
    );
  }
  return handle;
}

export function assertLink(link) {
  if (!link || !LINK_TYPES.has(link.type)) {
    throw new Error(
      `fluid: invalid link type "${link?.type}" (expected one of: ${[...LINK_TYPES].join(', ')})`
    );
  }
  if (typeof link.target !== 'string' || !link.target) {
    throw new Error('fluid: link requires a target');
  }
  return link;
}

/**
 * Which lifecycle fact an update represents.
 *
 * Status transitions win over field edits because they are the events other
 * rungs read (promotion and kill are the two outcomes a conviction or
 * calibration layer scores against). Checked in that order so a promote that
 * also retitles is still recorded as a promotion.
 *
 * Shared because the event stream is the thing a later semantic layer learns
 * from: two providers that classified the same edit differently would make that
 * history unreadable across a swap.
 */
export function eventTypeForUpdate(before, after, patch) {
  if (after.status !== before.status) {
    if (after.status === 'killed') return 'killed';
    if (after.status === 'promoted') return 'promoted';
  }
  if (patch.priority !== undefined && after.priority !== before.priority) return 'triaged';
  if (after.discussion.length > before.discussion.length) return 'discussed';
  return 'updated';
}

/**
 * Fields a caller may never patch through `updateRecord`.
 *
 * `handle`/`kind`/`id` are identity: `handle` is quoted in docs and commits, and
 * `kind` additionally decides a record's storage type on providers that key
 * behaviour off it — a provider whose backing store freezes the type at creation
 * would diverge permanently from a record claiming a new one.
 *
 * `provenance` is write-time-stamped and never retrofitted. `discussion` is
 * append-only evidence — a deliberation trail that can be replaced wholesale is
 * not evidence, so it moves only through `appendDiscussion()`. Timestamps are
 * provider-assigned.
 */
export const UNPATCHABLE = Object.freeze([
  'handle', 'kind', 'provenance', 'discussion', 'id', 'created_at', 'updated_at',
]);

/**
 * Refuse a patch that touches an unpatchable field.
 *
 * Refuses rather than silently dropping. Silently ignoring `discussion: []`
 * would look to the caller exactly like a successful erase of the deliberation
 * trail, and looking successful is the dangerous half.
 *
 * Keys are tested with `!== undefined`, so an explicit `null` is a violation
 * too: `{ provenance: null }` is an attempt to clear provenance, not an absent
 * field.
 *
 * @param {object} patch caller-supplied patch
 * @param {string} providerName for the error message
 * @throws {Error} naming every offending field at once, so a caller fixes one
 *   call rather than discovering the list one rejection at a time.
 */
export function assertPatchable(patch, providerName) {
  const forbidden = UNPATCHABLE.filter((f) => patch?.[f] !== undefined);
  if (forbidden.length) {
    throw new Error(
      `fluid: field(s) ${forbidden.join(', ')} cannot be changed through updateRecord ` +
      `(identity and append-only evidence are not patchable; use appendDiscussion for discussion)` +
      (providerName ? ` [${providerName}]` : '')
    );
  }
}

/**
 * Normalize a record on the way out.
 *
 * Every structured field is cloned. Returning stored objects by reference lets
 * a caller mutate what the provider considers canonical with no write, no
 * timestamp, no event and no save — a change that appeared to take effect and
 * then silently vanished. Nothing shares a reference with the store.
 *
 * Absent optional fields are filled to their contract defaults rather than left
 * `undefined`, so a record written before a field existed reads back the same
 * shape as one written after it. This is also what makes a record recovered
 * from a store that erases nulls and empty containers (COMP-FOH C14) read back
 * intact, without a migration.
 *
 * @param {object} record raw stored record
 * @returns {object} a fresh object sharing no references with `record`
 */
export function normalizeRecord(record) {
  return {
    id: record.id,
    handle: record.handle,
    kind: record.kind,
    title: record.title,
    body: record.body ?? '',
    status: record.status,
    status_label: record.status_label ?? null,
    priority: record.priority ?? null,
    // The 2x2 matrix's two axes. Filled to null here rather than left absent for
    // the reason stated above: every record written before COMP-PLAN-IDEA-UNIFY
    // S3b-2 predates both fields, and a caller that has to distinguish "absent"
    // from "unassigned" would be reading the migration's timeline out of the
    // record shape.
    effort: record.effort ?? null,
    impact: record.impact ?? null,
    cluster: record.cluster ?? null,
    cluster_order: record.cluster_order ?? null,
    tags: Array.isArray(record.tags) ? [...record.tags] : [],
    source: record.source ?? null,
    links: Array.isArray(record.links) ? record.links.map((l) => ({ ...l })) : [],
    killed: record.killed ? { ...record.killed } : null,
    discussion: Array.isArray(record.discussion) ? record.discussion.map((d) => ({ ...d })) : [],
    provenance: { ...record.provenance },
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
