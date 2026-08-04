/**
 * lib/fluid/local-provider.js — the zero-install floor provider.
 *
 * Implements the fluid-store seam over the EXISTING vision store (`server/
 * vision-store.js`), per `PROVIDER-SEAM`: "the vision store is not a competing
 * canon — its existing typed items are the expected implementation substrate of
 * the local floor provider." There is no second record store.
 *
 * Storage layout:
 *   - a record  → one vision item of the matching type, with the record-specific
 *                 payload in the item's additive `fluid_ext` namespace
 *   - an event  → one line in `<dataDir>/fluid-events.jsonl` (append-only)
 *
 * This provider declares STORAGE capabilities ONLY. It has no recall, no
 * challenge, no conviction, no calibration, no contradiction — and per the
 * ruling it must not pretend otherwise. Those calls inherit the base class's
 * refusal and throw `FluidCapabilityUnavailable`. That is the intended,
 * correct behavior of the floor, not a gap to be filled in later: the floor is
 * the filing cabinet, and the intelligence is what a richer provider adds.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VisionStore } from '../../server/vision-store.js';
import {
  CAP,
  FluidProvider,
  FluidRecordNotFound,
  KIND,
  STORAGE_CAP,
} from './provider.js';
import { assertValid } from './schema.js';

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
});

/** Record kind → vision item type. Only kinds with a real vision type can be
 *  hosted by this provider; the rest are refused by requireKind(). */
const KIND_TO_VISION_TYPE = Object.freeze({
  [KIND.IDEA]: 'idea',
  [KIND.DECISION]: 'decision',
  [KIND.THREAD]: 'thread',
  [KIND.QUESTION]: 'question',
});

/**
 * Canonical fluid status → vision status.
 *
 * One-way by design: the canonical value is persisted in `fluid_ext.status`, and
 * the vision item's own `status` is a PROJECTION written alongside it purely so
 * the graph and dashboard render the item sensibly. Reads always take the
 * canonical value, so this mapping being lossy (two fluid states could map onto
 * one vision state) can never lose information.
 *
 * `promoted → superseded` is deliberate: a promoted idea has been crystallized
 * into a committed feature, and the graph edge to that feature (`promoted_to`)
 * is what carries the provenance. The idea is not "complete" — it was replaced.
 */
const FLUID_TO_VISION_STATUS = Object.freeze({
  new: 'planned',
  discussing: 'review',
  promoted: 'superseded',
  killed: 'killed',
});

const FLUID_STATUSES = Object.freeze(new Set(Object.keys(FLUID_TO_VISION_STATUS)));

/** Link types the contract defines. Validated here so a typo becomes an error
 *  at the write rather than a silently unqueryable edge. */
const LINK_TYPES = Object.freeze(new Set([
  'promoted_to', 'maps_to', 'informs', 'blocks',
  'supports', 'contradicts', 'supersedes', 'duplicate_of',
]));

/** Fields a caller may never patch through updateRecord.
 *  `handle`/`kind` are identity. `provenance` is write-time-stamped and never
 *  retrofitted. `discussion` is append-only evidence — a deliberation trail that
 *  can be replaced wholesale is not evidence, so it moves only through
 *  appendDiscussion(). */
const UNPATCHABLE = Object.freeze(['handle', 'kind', 'provenance', 'discussion', 'id', 'created_at']);

const EVENTS_FILE = 'fluid-events.jsonl';

/**
 * Handle grammar, with the suffix bounded to 9 digits.
 *
 * The bound is load-bearing, not cosmetic. Allocation reads the suffix as a
 * Number; past the exact-integer range `max + 1 === max`, so importing a
 * gigantic handle would make the allocator hand the same one out forever. The
 * contract carries the same bound.
 */
const HANDLE_RE = /^([A-Z][A-Z0-9]*)-([1-9][0-9]{0,8})$/;

/** Scans RAW log text for handle tokens, independent of JSON parseability.
 *  The watermark must survive a corrupt or partially-written line: if the only
 *  tombstone for a retired handle were lost to a parse failure, that handle
 *  would be reissued, which is the one outcome the tombstone exists to prevent.
 *  Line-level JSON tolerance and handle durability are therefore separate
 *  mechanisms rather than one. */
const HANDLE_TOKEN_RE = /"handle"\s*:\s*"([A-Z][A-Z0-9]*-[1-9][0-9]{0,8})"/g;

function nowIso() { return new Date().toISOString(); }

/** Validate at the seam so a bad status surfaces as a fluid-level error naming
 *  the legal values, rather than as the vision store's `Invalid status:
 *  undefined` from a failed projection lookup two layers down. */
function assertStatus(status) {
  if (!FLUID_STATUSES.has(status)) {
    throw new Error(
      `fluid: invalid status "${status}" (expected one of: ${[...FLUID_STATUSES].join(', ')})`
    );
  }
  return status;
}

/**
 * Which lifecycle fact an update represents.
 *
 * Status transitions win over field edits because they are the events other
 * rungs read (promotion and kill are the two outcomes a conviction or
 * calibration layer scores against). Checked in that order so a promote that
 * also retitles is still recorded as a promotion.
 */
/** A caller-supplied handle must be well-formed AND belong to its kind — an
 *  `idea` carrying `DEC-4` would be invisible to idea handle allocation and
 *  would collide with a real decision later. */
function assertHandle(handle, kind) {
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

function assertLink(link) {
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

function eventTypeForUpdate(before, after, patch) {
  if (after.status !== before.status) {
    if (after.status === 'killed') return 'killed';
    if (after.status === 'promoted') return 'promoted';
  }
  if (patch.priority !== undefined && after.priority !== before.priority) return 'triaged';
  if (after.discussion.length > before.discussion.length) return 'discussed';
  return 'updated';
}

export class LocalFluidProvider extends FluidProvider {
  name() { return 'local'; }

  /** Storage only. Never a semantic capability — see the file header. */
  capabilities() {
    return new Set([STORAGE_CAP.RECORDS, STORAGE_CAP.EVENTS, STORAGE_CAP.LINKS]);
  }

  /** S1 pilot ships `idea`; the other three have a vision type ready for the
   *  kinds that adopt the seam next. `position` and `joint` have no vision type
   *  and are refused loudly rather than coerced into a lookalike. */
  supportedKinds() {
    return new Set(Object.keys(KIND_TO_VISION_TYPE));
  }

  /**
   * @param {string} cwd project root
   * @param {object} [config]
   * @param {string} [config.dataDir] override (tests point this at a tmp dir)
   */
  async init(cwd, config = {}) {
    this.cwd = cwd;
    this.dataDir = config.dataDir ?? join(cwd, '.compose', 'data');
    this.eventsPath = join(this.dataDir, EVENTS_FILE);
    // An injected store belongs to the caller (the server holds a long-lived
    // one shared with other subsystems), so this provider never reloads it —
    // reloading someone else's store is a side effect on shared state. A store
    // this provider created is its own and IS refreshed per operation.
    this._ownsStore = config.store === undefined;
    this.store = config.store ?? new VisionStore(this.dataDir);
    return this;
  }

  /**
   * Re-read the substrate before touching it.
   *
   * VisionStore loads once at construction and every mutation rewrites the whole
   * state file from that in-memory snapshot, so a provider holding a stale
   * snapshot silently erases records another process wrote. The CLI and the
   * server are exactly that pair. The tracker's local provider avoids the same
   * hazard by reading per operation; this is that discipline.
   *
   * NOTE (residual, accepted for the floor): this closes the stale-snapshot
   * window, not the interleaving one — two processes can still read-modify-write
   * across each other between reload and save. Serializing that needs a lock and
   * is tracked as an S3 concern, when concurrent callers actually exist.
   */
  _sync() {
    if (this._ownsStore) this.store.reloadFrom(this.dataDir);
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  /** A vision item is a fluid record iff it carries the `fluid_ext` namespace.
   *  Items without it are ordinary vision items (features, bugs, hand-created
   *  idea nodes) and are invisible to this provider — which also means a record
   *  whose creation crashed between the two writes is inert, not half-real. */
  _isRecordItem(item) {
    return Boolean(item?.fluid_ext?.handle && item?.fluid_ext?.kind);
  }

  _toRecord(item) {
    const ext = item.fluid_ext;
    return {
      id: item.id,
      handle: ext.handle,
      kind: ext.kind,
      title: item.title,
      body: item.description ?? '',
      status: ext.status,
      priority: item.priority ?? null,
      cluster: ext.cluster ?? null,
      cluster_order: ext.cluster_order ?? null,
      tags: Array.isArray(ext.tags) ? [...ext.tags] : [],
      source: ext.source ?? null,
      links: Array.isArray(ext.links) ? ext.links.map((l) => ({ ...l })) : [],
      // Cloned like every other structured field. Returning it by reference let
      // a caller mutate the provider's canonical in-memory state with no write,
      // no timestamp, no event and no save — a change that exists until restart
      // and then silently disappears.
      killed: ext.killed ? { ...ext.killed } : null,
      discussion: Array.isArray(ext.discussion) ? ext.discussion.map((d) => ({ ...d })) : [],
      provenance: { ...ext.provenance },
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    };
  }

  /** The half of the record that has no native vision-item field. */
  _toExt(record) {
    return {
      handle: record.handle,
      kind: record.kind,
      status: record.status,
      cluster: record.cluster ?? null,
      cluster_order: record.cluster_order ?? null,
      tags: Array.isArray(record.tags) ? [...record.tags] : [],
      source: record.source ?? null,
      links: Array.isArray(record.links) ? record.links.map((l) => ({ ...l })) : [],
      // Cloned on the way IN as well as out. Storing the caller's object by
      // reference lets them keep mutating canonical state after the write
      // returns — invisible on the reloading path, permanent on the injected-
      // store path where _sync() is deliberately off.
      killed: record.killed ? { ...record.killed } : null,
      discussion: Array.isArray(record.discussion) ? record.discussion.map((d) => ({ ...d })) : [],
      provenance: { ...record.provenance },
    };
  }

  _itemsWithRecords() {
    return [...this.store.items.values()].filter((i) => this._isRecordItem(i));
  }

  _findItem(handle) {
    return this._itemsWithRecords().find((i) => i.fluid_ext.handle === handle) ?? null;
  }

  // -------------------------------------------------------------------------
  // Handle allocation
  // -------------------------------------------------------------------------

  /**
   * Next handle for a kind: one past the highest number EVER issued for that
   * prefix.
   *
   * The watermark is the max over live records AND the append-only event log —
   * not over live records alone. Deriving it from live records only would reuse
   * the handle of a deleted record, and handles are quoted in docs, commits and
   * conversation, so reuse silently repoints an external citation at a different
   * idea. The event log is never pruned, so a `created` event is a permanent
   * tombstone for its handle.
   */
  /** Every handle ever issued — live records UNION the append-only log. */
  _issuedHandles() {
    const issued = new Set();
    for (const item of this._itemsWithRecords()) issued.add(item.fluid_ext.handle);
    for (const handle of this._issuedHandlesFromLog()) issued.add(handle);
    return issued;
  }

  _nextHandle(kind) {
    const prefix = HANDLE_PREFIX[kind];
    const issued = this._issuedHandles();
    let max = 0;
    for (const handle of issued) {
      const m = HANDLE_RE.exec(handle);
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    }
    const candidate = `${prefix}-${max + 1}`;
    // Belt and braces: the arithmetic above is only as trustworthy as the digit
    // bound, so the automatic path makes the same membership check the
    // caller-supplied path makes rather than trusting max + 1 to be fresh.
    if (issued.has(candidate)) {
      throw new Error(`fluid: handle allocation failed — ${candidate} is already issued`);
    }
    return candidate;
  }

  /**
   * True when this exact handle has EVER been issued — live or retired.
   *
   * Membership, deliberately not `n <= highest`. The import supplies its own
   * handles to preserve existing IDEA-N citations, and it may encounter them in
   * any order; a watermark comparison would reject IDEA-3 merely because IDEA-20
   * had already been imported. Only a handle genuinely seen before is refused.
   */
  _handleWasIssued(handle) {
    return this._issuedHandles().has(handle);
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  async getRecord(handle) {
    this._sync();
    const item = this._findItem(handle);
    return item ? this._toRecord(item) : null;
  }

  async listRecords(filter = {}) {
    this._sync();
    let records = this._itemsWithRecords().map((i) => this._toRecord(i));
    if (filter.kind) records = records.filter((r) => r.kind === filter.kind);
    if (filter.status) records = records.filter((r) => r.status === filter.status);
    if (filter.cluster !== undefined) records = records.filter((r) => r.cluster === filter.cluster);
    // Stable order: cluster order, then handle number. Presentation layers rely
    // on this being deterministic so a regenerated projection does not churn.
    return records.sort((a, b) => {
      const ca = a.cluster_order ?? Number.MAX_SAFE_INTEGER;
      const cb = b.cluster_order ?? Number.MAX_SAFE_INTEGER;
      if (ca !== cb) return ca - cb;
      return (Number(HANDLE_RE.exec(a.handle)?.[2] ?? 0)) - (Number(HANDLE_RE.exec(b.handle)?.[2] ?? 0));
    });
  }

  /**
   * @param {object} input record fields; `handle` may be supplied by the
   *   one-time import to preserve existing IDEA-N citations, otherwise it is
   *   allocated.
   */
  async createRecord(input) {
    this._sync();
    const kind = input.kind ?? KIND.IDEA;
    this.requireKind(kind);
    if (!input.title) throw new Error('fluid: createRecord requires a title');

    let handle;
    if (input.handle === undefined) {
      handle = this._nextHandle(kind);
    } else {
      handle = assertHandle(input.handle, kind);
      // Checked against every handle EVER issued, not just the live ones. A
      // retired handle is still spoken for: reissuing it would repoint existing
      // citations at a different record, which is precisely the outcome the
      // tombstones exist to prevent, and the caller-supplied path is the one
      // that can request it explicitly.
      if (this._handleWasIssued(handle)) {
        throw new Error(
          `fluid: handle ${handle} has already been issued and cannot be reused ` +
          `(handles are external citations; retired ones stay retired)`
        );
      }
    }

    for (const link of input.links ?? []) assertLink(link);
    const status = assertStatus(input.status ?? 'new');
    const record = {
      handle,
      kind,
      title: input.title,
      body: input.body ?? '',
      status,
      priority: input.priority ?? null,
      cluster: input.cluster ?? null,
      cluster_order: input.cluster_order ?? null,
      tags: input.tags ?? [],
      source: input.source ?? null,
      links: input.links ?? [],
      killed: input.killed ?? null,
      discussion: input.discussion ?? [],
      provenance: {
        origin: input.provenance?.origin ?? 'cli:ideabox',
        recorded_at: input.provenance?.recorded_at ?? nowIso(),
        author: input.provenance?.author ?? null,
      },
    };

    // Validate against the published contract, not a hand-rolled subset. A
    // bespoke field check drifts from the schema silently, accepting what the
    // contract forbids while the contract keeps claiming otherwise.
    const now = nowIso();
    assertValid('record', { ...record, id: 'pending', created_at: now, updated_at: now }, 'record');

    // The tombstone is written BEFORE the record exists.
    //
    // Ordering matters and this is the only safe direction. Persisting the
    // record first and appending the tombstone after means a failed append
    // leaves a discoverable record whose handle was never burned — delete it
    // and the handle is reissued, defeating the invariant. Burning first can
    // at worst waste a handle if creation then fails, and a wasted handle is
    // free while a reissued one is unrecoverable.
    await this.appendEvent({
      handle,
      type: input.provenance?.origin === 'import:ideabox' ? 'imported' : 'created',
      at: now,
      detail: { kind },
    });

    const item = this.store.createItem({
      type: KIND_TO_VISION_TYPE[kind],
      title: record.title,
      description: record.body,
      status: FLUID_TO_VISION_STATUS[status],
      priority: record.priority,
    });

    try {
      // touch:false so created_at and updated_at agree on a freshly written
      // record — the ext write is part of creation, not a subsequent edit.
      this.store.setFluidExt(item.id, this._toExt(record), { touch: false });
    } catch (err) {
      // Compensate: an item without its namespace would be an inert orphan in
      // the vision store, invisible to this provider but visible in the graph.
      try { this.store.deleteItem(item.id); } catch { /* best effort */ }
      throw err;
    }

    return this._toRecord(this.store.items.get(item.id));
  }

  async updateRecord(handle, patch) {
    this._sync();
    const item = this._findItem(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());

    // Refuse an unpatchable field rather than silently dropping it. Silently
    // ignoring `discussion: []` would look to the caller exactly like a
    // successful erase of the deliberation trail, and looking successful is the
    // dangerous half.
    const forbidden = UNPATCHABLE.filter((f) => patch[f] !== undefined);
    if (forbidden.length) {
      throw new Error(
        `fluid: field(s) ${forbidden.join(', ')} cannot be changed through updateRecord ` +
        `(identity and append-only evidence are not patchable; use appendDiscussion for discussion)`
      );
    }

    const current = this._toRecord(item);
    const next = { ...current, ...patch, ...Object.fromEntries(UNPATCHABLE.map((f) => [f, current[f]])) };

    // Validate the RESULT against the contract before anything reaches disk —
    // the whole shape, not the two fields that were easy to check by hand.
    assertStatus(next.status);
    for (const link of next.links) assertLink(link);
    assertValid('record', next, 'record');
    const eventType = eventTypeForUpdate(current, next, patch);

    const visionPatch = {
      title: next.title,
      description: next.body,
      priority: next.priority,
      status: FLUID_TO_VISION_STATUS[next.status],
    };

    // The update spans two saves (native fields, then the namespace). If the
    // second fails, restoring only the namespace would leave the first one
    // committed — a record whose title and rendered status had moved while its
    // canonical state had not. Both are restored, or neither.
    const beforeNative = {
      title: current.title,
      description: current.body,
      priority: current.priority,
      status: FLUID_TO_VISION_STATUS[current.status],
    };
    this.store.updateItem(item.id, visionPatch);
    try {
      this.store.setFluidExt(item.id, this._toExt(next));
    } catch (err) {
      try { this.store.updateItem(item.id, beforeNative); } catch { /* best effort */ }
      throw err;
    }

    await this.appendEvent({
      handle,
      type: eventType,
      at: nowIso(),
      detail: { fields: Object.keys(patch) },
    });

    return this._toRecord(this.store.items.get(item.id));
  }

  /** The only way discussion grows. Append-only in the API, not merely by
   *  convention in the contract — a deliberation trail that can be rewritten is
   *  not evidence. */
  async appendDiscussion(handle, entry) {
    this._sync();
    const item = this._findItem(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());
    if (!entry?.text) throw new Error('fluid: a discussion entry requires text');

    const record = this._toRecord(item);
    record.discussion.push({
      at: entry.at ?? nowIso(),
      text: entry.text,
      author: entry.author ?? null,
    });
    this.store.setFluidExt(item.id, this._toExt(record));
    await this.appendEvent({ handle, type: 'discussed', at: nowIso(), detail: {} });
    return this._toRecord(this.store.items.get(item.id));
  }

  /**
   * Hard delete. NOT the lifecycle path — killing an idea is
   * `updateRecord(handle, {status: 'killed'})`, which keeps the record and its
   * reasoning. This removes the record entirely and exists for administrative
   * correction.
   *
   * Because it destroys a record that may carry deliberation evidence, and the
   * contract calls that evidence append-only, the discussion is carried into the
   * append-only log before the record goes. Otherwise "append-only" would be
   * true of every path except the one that actually erases it, and the surviving
   * `discussed` events carry no text.
   */
  async deleteRecord(handle) {
    this._sync();
    const item = this._findItem(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());
    const record = this._toRecord(item);

    await this.appendEvent({
      handle,
      type: 'deleted',
      at: nowIso(),
      detail: { kind: record.kind, title: record.title, discussion: record.discussion },
    });

    // deleteItem throws when the state does not reach disk, so a failed delete
    // surfaces instead of returning ok while the record is still on disk to
    // reappear after restart.
    this.store.deleteItem(item.id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  async addLink(handle, link) {
    this._sync();
    assertLink(link);
    const item = this._findItem(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());
    const record = this._toRecord(item);
    const exists = record.links.some((l) => l.type === link.type && l.target === link.target);
    if (!exists) {
      record.links.push({ ...link });
      this.store.setFluidExt(item.id, this._toExt(record));
      await this.appendEvent({ handle, type: 'linked', at: nowIso(), detail: { ...link } });
    }
    return this._toRecord(this.store.items.get(item.id));
  }

  async removeLink(handle, link) {
    this._sync();
    const item = this._findItem(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());
    const record = this._toRecord(item);
    record.links = record.links.filter((l) => !(l.type === link.type && l.target === link.target));
    this.store.setFluidExt(item.id, this._toExt(record));
    return this._toRecord(this.store.items.get(item.id));
  }

  // -------------------------------------------------------------------------
  // Lifecycle events
  // -------------------------------------------------------------------------

  _rawLog() {
    return existsSync(this.eventsPath) ? readFileSync(this.eventsPath, 'utf8') : '';
  }

  /**
   * Handles named anywhere in the raw log, including on lines that fail to
   * parse.
   *
   * Deliberately NOT derived from _readAllEvents(): that skips corrupt lines,
   * and if the only tombstone for a retired handle sat on a skipped line the
   * handle would be quietly reissued. Reading history tolerantly and keeping
   * handles retired are different jobs, so they read the log differently.
   */
  _issuedHandlesFromLog() {
    const handles = new Set();
    const text = this._rawLog();
    HANDLE_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = HANDLE_TOKEN_RE.exec(text)) !== null) handles.add(m[1]);
    return handles;
  }

  _readAllEvents() {
    const out = [];
    for (const line of this._rawLog().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // A corrupt line must not take the readable history with it. Handle
      // retirement does not depend on this path — see _issuedHandlesFromLog.
      try { out.push(JSON.parse(trimmed)); } catch { /* skip */ }
    }
    return out;
  }

  async appendEvent(event) {
    const full = { at: nowIso(), ...event };
    // The log is append-only, so a malformed entry is permanent. Validate before
    // it lands rather than discovering it on a read that no longer has a caller
    // to blame.
    assertValid('lifecycle_event', full, 'lifecycle event');
    mkdirSync(this.dataDir, { recursive: true });
    appendFileSync(this.eventsPath, JSON.stringify(full) + '\n', 'utf8');
    return { ok: true };
  }

  async readEvents(handle) {
    const all = this._readAllEvents();
    return handle ? all.filter((e) => e.handle === handle) : all;
  }
}

export { CAP };
