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
