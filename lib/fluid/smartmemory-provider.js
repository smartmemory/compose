/**
 * lib/fluid/smartmemory-provider.js — the SmartMemory fluid provider (COMP-FOH FOH-1).
 *
 * Implements the fluid-store seam over SmartMemory's generic MemoryItem CRUD
 * routes, via `lib/smartmemory-client.js`. Storage only: this slice declares
 * RECORDS, EVENTS and LINKS and nothing else. Recall, challenge, conviction,
 * calibration and contradiction stay refused by the base class until FOH-2
 * implements and declares them together.
 *
 * Storage layout (blueprint D-FOH-2):
 *   - a record → one MemoryItem, `memory_type: fluid_<kind>`, the canonical
 *     record JSON-encoded into `metadata.fluid_record_json`
 *   - an event → one MemoryItem, `memory_type: fluid_event`, payload in
 *     `metadata.fluid_event_json`
 *
 * WHY THE RECORD IS AN OPAQUE STRING
 * ----------------------------------
 * SmartMemory treats `metadata` as an open bag of graph properties it owns and
 * rewrites. A structured record stored there does not survive the round trip:
 * nested dicts are exploded into `parent__child` properties, empty containers
 * are dropped, the server overwrites `created_at`, and merge-mode updates hoist
 * old metadata to the top level as a stale shadow copy.
 *
 * Worse, a field CANNOT BE CLEARED: null and empty-string values are filtered
 * out before the write and the SET simply omits them, so the previous value
 * survives behind a 200 (filed upstream as smart-memory-core#3). Under any
 * structured mapping, clearing a record's `priority` would silently no-op.
 *
 * One JSON string is inert to every one of those paths. It is never null and
 * never empty, so it is always written; the metadata merge is a one-level
 * spread, so one key replaces the whole record; and the backend codec
 * marker-escapes JSON-looking strings and returns them verbatim, making the
 * round trip byte-stable by construction rather than by hope.
 *
 * The cost is that record fields are not server-queryable. That costs nothing
 * here: `/memory/list` accepts a single filter pair, the floor already filters
 * client-side, and the seam exposes no field-query API. `handle`, `kind` and
 * `fluid_ns` stay flat beside the blob precisely so lookup still works.
 *
 * WHAT THIS PROVIDER OWNS THAT THE FLOOR DOES NOT
 * -----------------------------------------------
 * Nothing below it enforces the seam's invariants. `memory_type` is frozen at
 * creation server-side and the blob is opaque, so a `kind` change would diverge
 * permanently and silently keep the old embedding policy. Handle uniqueness has
 * no server constraint. Both are held here, and only here.
 */

import { randomUUID } from 'node:crypto';

import { createSmartmemoryClient } from '../smartmemory-client.js';
import {
  CAP,
  FluidConfigError,
  FluidProvider,
  FluidRecordNotFound,
  KIND,
  STORAGE_CAP,
  normalizeRecallLimit,
} from './provider.js';
import {
  HANDLE_PREFIX,
  HANDLE_RE,
  UNPATCHABLE,
  assertHandle,
  assertLink,
  assertPatchable,
  assertStatus,
  eventTypeForUpdate,
  normalizeRecord,
} from './record-shape.js';
import { assertValid } from './schema.js';

/** Namespace markers. The analogue of the floor's `fluid_ext` presence check:
 *  a MemoryItem without the marker is invisible to this provider, so a
 *  workspace shared with other SmartMemory content stays safe to read. */
const RECORD_NS = 'compose.fluid.v1';
const EVENT_NS = 'compose.fluid.events.v1';

/** Wire type prefix (blueprint D-FOH-3).
 *
 *  `decision` is ALREADY a registered SmartMemory memory_type with a different
 *  meaning, so a bare kind would merge two populations in one workspace — and,
 *  because the per-kind embedding config key is derived from `memory_type`,
 *  would make Compose's recallability policy rewrite embedding behaviour for
 *  native SmartMemory decisions deployment-wide. The prefix keeps the blast
 *  radius inside Compose's own namespace. */
const WIRE_PREFIX = 'fluid_';
const EVENT_WIRE_TYPE = 'fluid_event';

/** The route's own default page size. Every enumeration here loops; see
 *  `_listAllItems`. */
const PAGE_SIZE = 50;

/**
 * Kinds `recall()` may return.
 *
 * `cluster` stays out: it is a hand-authored grouping label, not a fuzzy-recall
 * target. It remains stored and readable the moment you name its handle.
 *
 * `decision` is IN, by owner ruling 2026-08-04, reversing architecture.md §Q3's
 * provisional INDEXED default (which flagged itself as the one item worth a
 * second look). §Q3's stated fear was surfacing a superseded decision "as if it
 * were live" — and the word doing the work there is *as if*. A hit carries the
 * whole record, `status` and `killed` included, so a killed decision is
 * distinguishable by anything that looks. See the residual limitation below.
 *
 * THIS LIST IS THE ENFORCEMENT. The deployment-side embedding config
 * (`embeddings.enable_<memory_type>`) defaults to ON and Compose can neither set
 * nor verify it, so relying on it would leave excluded kinds recallable in any
 * unconfigured deployment. Filtering the OUTPUT holds regardless of how the
 * server is configured.
 *
 * RESIDUAL LIMITATION, disclosed rather than papered over: `status` covers
 * killed, but "superseded by a newer decision" is NOT visible on the record
 * itself. Supersession is a `supersedes` LINK on the newer record pointing at
 * the older one, so the older one carries no marker — detecting it would mean
 * scanning every record for links targeting this handle, which recall cannot do
 * per hit. A live-looking decision that something newer has since superseded
 * will therefore still be recalled as live. Fixing that needs a back-reference
 * on the superseded record, which is a storage change, not a recall change.
 */
export const RECALLABLE_KINDS = Object.freeze(
  new Set([KIND.IDEA, KIND.THREAD, KIND.QUESTION, KIND.DECISION]),
);

/**
 * Over-fetch factor, floor and ceiling for the single recall query.
 *
 * One unfiltered query is issued and filtered client-side, so the fetch has to
 * be wide enough to survive dropping every non-fluid and non-recallable hit. The
 * floor matters more than the factor: at `limit: 1` a bare factor would fetch 4,
 * which almost any workspace could fill with items that get filtered away.
 *
 * The ceiling is not decoration — `top_k` is unconstrained on the wire and the
 * route doubles it before searching, so an unbounded value here becomes an
 * unbounded fetch and a proportional ranking cost on the server.
 */
const OVERFETCH = 4;
const MIN_FETCH = 20;
const TOP_K_CAP = 200;

function nowIso() { return new Date().toISOString(); }

/** `memory_type` for a record kind. Never the bare kind. */
function wireTypeFor(kind) { return `${WIRE_PREFIX}${kind}`; }

export class SmartMemoryFluidProvider extends FluidProvider {
  name() { return 'smartmemory'; }

  /** Storage, plus RECALL as of FOH-2. Declaring a capability without
   *  implementing it is the one thing PROVIDER-SEAM forbids, so this line and
   *  `recall()` below move together — CHALLENGE, CONVICTION, CALIBRATION and
   *  CONTRADICTION stay undeclared and keep inheriting the base class's refusal. */
  capabilities() {
    return new Set([STORAGE_CAP.RECORDS, STORAGE_CAP.EVENTS, STORAGE_CAP.LINKS, CAP.RECALL]);
  }

  /**
   * The floor's full kind set, not `idea` alone.
   *
   * The pilot workload requires it: the ideabox import creates CLUSTERS before
   * ideas, because members reference them by handle, so an idea-only provider
   * throws on the import's first write. Kinds are free here because storage is
   * generic — `memory_type` is a free-form string with no typed schema behind
   * it — so matching the floor exactly makes a provider swap lossless rather
   * than parity-gapped.
   *
   * `position` and `joint` stay refused, matching the floor: the judgment layer
   * already owns both kinds with its own store and write tools, and accepting
   * them would give one kind two canons.
   */
  supportedKinds() {
    return new Set([KIND.IDEA, KIND.DECISION, KIND.THREAD, KIND.QUESTION, KIND.CLUSTER]);
  }

  /**
   * @param {string} cwd project root
   * @param {object} config merged fluid.smartmemory + top-level smartmemory config
   * @param {string} config.baseUrl SmartMemory endpoint
   * @param {string} config.apiKeyEnv env var holding the API key
   * @param {string} config.workspaceId configured workspace (owner ruling: never derived)
   * @param {object} [config.client] injected client, for tests
   */
  async init(cwd, config = {}) {
    this.cwd = cwd;
    this.config = config;

    // Fail loud, before any network call, naming the exact missing setting.
    //
    // All four are checked, not just the block's presence: the client
    // interpolates baseUrl straight into the URL, so an unset endpoint would
    // otherwise surface as a request failure against the literal string
    // "undefined" — blaming the server for a local misconfiguration.
    if (!config.baseUrl) {
      throw new FluidConfigError(
        'compose: fluid provider "smartmemory" requires smartmemory.baseUrl to be set',
        { provider: 'smartmemory', setting: 'smartmemory.baseUrl' }
      );
    }
    if (!config.apiKeyEnv) {
      throw new FluidConfigError(
        'compose: fluid provider "smartmemory" requires smartmemory.apiKeyEnv to be set',
        { provider: 'smartmemory', setting: 'smartmemory.apiKeyEnv' }
      );
    }
    if (!process.env[config.apiKeyEnv]) {
      throw new FluidConfigError(
        `compose: fluid provider "smartmemory" needs an API key in $${config.apiKeyEnv}, ` +
        'which is unset or empty. The key needs the read:memories, write:memories AND ' +
        'delete:memories scopes — a key missing delete fails only on deleteRecord, long ' +
        'after setup appears to have worked.',
        { provider: 'smartmemory', setting: config.apiKeyEnv }
      );
    }
    // Owner ruling (blueprint C4): the workspace id is CONFIGURED, never
    // derived. A locally derived project tag was never usable — the service
    // validates the header against the principal's memberships and 403s a
    // workspace they are not a member of.
    if (!config.workspaceId) {
      throw new FluidConfigError(
        'compose: fluid provider "smartmemory" requires fluid.smartmemory.workspaceId. ' +
        'It must be a workspace the configured API key is a member of; it is not derived ' +
        'from the project directory.',
        { provider: 'smartmemory', setting: 'fluid.smartmemory.workspaceId' }
      );
    }

    this.client = config.client ?? createSmartmemoryClient({
      baseUrl: config.baseUrl,
      apiKeyEnv: config.apiKeyEnv,
      workspaceId: config.workspaceId,
      timeoutMs: config.timeoutMs,
    });
    return this;
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  /**
   * The searchable projection (blueprint D-FOH-1).
   *
   * Title, body and discussion text, not the title alone. Embeddings are
   * generated from `content`, so a title-only projection would leave a later
   * recall slice unable to reach an idea's prose while the architecture
   * declares ideas fully recallable — a failure that would surface only after
   * that slice shipped, as empty results.
   *
   * DISCLOSED LIMITATION: PATCH does not reindex, so an edited record keeps its
   * original embedding. Nothing reads embeddings in FOH-1, so nothing is broken
   * today; this is FOH-2's entry gate. Do NOT work around it by delete +
   * recreate, which burns a handle the tombstone invariant forbids.
   */
  _renderContent(record) {
    const parts = [record.title];
    if (record.body) parts.push(record.body);
    for (const entry of record.discussion ?? []) {
      if (entry?.text) parts.push(entry.text);
    }
    return parts.join('\n\n');
  }

  /** Record → wire metadata. Three flat lookup fields, then the sealed blob. */
  _toMetadata(record) {
    return {
      fluid_ns: RECORD_NS,
      handle: record.handle,
      kind: record.kind,
      fluid_record_json: JSON.stringify(record),
    };
  }

  /**
   * Wire item → record, or null when the item is not one of ours / unreadable.
   *
   * A blob that fails to parse is treated as absent rather than thrown: these
   * items live in a shared workspace, and one corrupt row must not make every
   * enumeration fail. The `handle` is reported so it is findable.
   */
  _fromItem(item) {
    const meta = item?.metadata ?? {};
    if (meta.fluid_ns !== RECORD_NS) return null;
    let parsed;
    try {
      parsed = JSON.parse(meta.fluid_record_json);
    } catch {
      process.emitWarning(
        `fluid(smartmemory): record ${meta.handle ?? item?.item_id} has an unreadable ` +
        'fluid_record_json blob and was skipped',
      );
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    // Normalize on every read: a record written before a field existed, or
    // imported from the floor, reads back in today's shape without a migration.
    return normalizeRecord(parsed);
  }

  // -------------------------------------------------------------------------
  // Enumeration
  // -------------------------------------------------------------------------

  /**
   * Every matching item, following pagination to the end.
   *
   * The route defaults to `limit=50`. A provider that silently saw only the
   * first page would under-report the ideabox — and once the projection is
   * generated from it, DELETE the rest from `ideabox.md`.
   *
   * Only one metadata filter pair is supported server-side, so the namespace
   * check is applied client-side by the caller's mapper.
   */
  async _listAllItems({ metadataKey, metadataValue } = {}) {
    const out = [];
    let offset = 0;
    for (;;) {
      const page = await this.client.listItems({
        limit: PAGE_SIZE, offset, metadataKey, metadataValue,
      });
      const items = page.items ?? [];
      out.push(...items);
      // Stop on a short page OR on reaching `total`. Either alone is fragile:
      // a full last page with no `total` would loop forever without the first,
      // and a `total` that lags a concurrent write would truncate without the
      // second.
      if (items.length < PAGE_SIZE) break;
      if (typeof page.total === 'number' && out.length >= page.total) break;
      offset += items.length;
    }
    return out;
  }

  /** Every live record item, namespace-filtered. */
  async _allRecordItems() {
    const items = await this._listAllItems({
      metadataKey: 'fluid_ns', metadataValue: RECORD_NS,
    });
    return items.filter((it) => it?.metadata?.fluid_ns === RECORD_NS);
  }

  // -------------------------------------------------------------------------
  // Handle resolution and duplicate repair (blueprint D-FOH-4)
  // -------------------------------------------------------------------------

  /**
   * Every live item carrying this handle, in a deterministic total order.
   *
   * Ordered by the SERVER-stamped `metadata.created_at`, ties broken by
   * `item_id`. The server stamps that field itself on every add, so this is one
   * clock rather than each client's — and a racing writer cannot forge an
   * earlier one. The record's own `created_at`, inside the blob, is the
   * record's account of itself and is deliberately NOT used for ordering.
   */
  async _resolveItems(handle) {
    const items = await this._listAllItems({ metadataKey: 'handle', metadataValue: handle });
    return items
      .filter((it) => it?.metadata?.fluid_ns === RECORD_NS && it?.metadata?.handle === handle)
      .sort((a, b) => {
        const ca = a.metadata?.created_at ?? '';
        const cb = b.metadata?.created_at ?? '';
        if (ca !== cb) return ca < cb ? -1 : 1;
        return String(a.item_id) < String(b.item_id) ? -1 : 1;
      });
  }

  /**
   * Read resolution: deterministic, never writes, never throws on a duplicate.
   *
   * Handle allocation has no lock and SmartMemory has no uniqueness constraint
   * on a metadata field, so two concurrent creates can leave two live items on
   * one handle. Throwing there — the earlier design — makes that state
   * PERMANENTLY unreadable, which is strictly worse than the ambiguity it was
   * meant to flag. Earliest wins, loudly.
   */
  async _resolveOne(handle) {
    const items = await this._resolveItems(handle);
    if (items.length === 0) return null;
    if (items.length > 1) {
      process.emitWarning(
        `fluid(smartmemory): handle ${handle} resolves to ${items.length} live records; ` +
        'using the earliest. The duplicate is repaired on the next write to this handle.',
      );
    }
    return items[0];
  }

  /**
   * Write resolution: repairs a duplicate before proceeding.
   *
   * Keeps the earliest and reassigns every later item a freshly allocated
   * handle, appending a `reassigned` event so the trail is auditable. Nothing
   * is discarded and no handle is ever reissued — which makes this strictly
   * better than the local floor, where two racing creates collide on one path
   * and one idea is silently lost.
   */
  async _resolveForWrite(handle) {
    const items = await this._resolveItems(handle);
    if (items.length === 0) return null;
    if (items.length === 1) return items[0];

    const [keep, ...duplicates] = items;
    for (const dup of duplicates) {
      const record = this._fromItem(dup);
      if (!record) continue;
      const fresh = await this._nextHandle(record.kind);
      const moved = { ...record, handle: fresh, updated_at: nowIso() };
      await this.client.updateItem(dup.item_id, {
        content: this._renderContent(moved),
        metadata: this._toMetadata(moved),
      });
      await this.appendEvent({
        handle: fresh,
        type: 'created',
        at: nowIso(),
        detail: { kind: record.kind, reassigned_from: handle },
      });
      process.emitWarning(
        `fluid(smartmemory): duplicate handle ${handle} repaired — the later record ` +
        `was reassigned ${fresh}`,
      );
    }
    return keep;
  }

  // -------------------------------------------------------------------------
  // Handle allocation
  // -------------------------------------------------------------------------

  /** Every handle ever issued — live records UNION the append-only event log.
   *  Derived from live records alone it would reuse a deleted record's handle,
   *  and handles are quoted in docs, commits and conversation. */
  async _issuedHandles() {
    const issued = new Set();
    for (const item of await this._allRecordItems()) {
      const h = item?.metadata?.handle;
      if (h) issued.add(h);
    }
    for (const event of await this.readEvents()) {
      if (event?.handle) issued.add(event.handle);
    }
    return issued;
  }

  async _nextHandle(kind) {
    const prefix = HANDLE_PREFIX[kind];
    const issued = await this._issuedHandles();
    let max = 0;
    for (const handle of issued) {
      const m = HANDLE_RE.exec(handle);
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    }
    const candidate = `${prefix}-${max + 1}`;
    if (issued.has(candidate)) {
      throw new Error(`fluid: handle allocation failed — ${candidate} is already issued`);
    }
    return candidate;
  }

  async _handleWasIssued(handle) {
    return (await this._issuedHandles()).has(handle);
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  /** Absence is `null`, matching the floor. Only mutating paths throw. A
   *  malformed handle is a miss, not a crash — this is the lookup a caller
   *  makes with untrusted input. */
  async getRecord(handle) {
    if (!HANDLE_RE.test(handle ?? '')) return null;
    const item = await this._resolveOne(handle);
    return item ? this._fromItem(item) : null;
  }

  async listRecords(filter = {}) {
    const items = await this._allRecordItems();
    let records = items.map((it) => this._fromItem(it)).filter(Boolean);
    if (filter.kind) records = records.filter((r) => r.kind === filter.kind);
    if (filter.status) records = records.filter((r) => r.status === filter.status);
    if (filter.cluster !== undefined) records = records.filter((r) => r.cluster === filter.cluster);
    // Same stable order as the floor, so a projection regenerated after a
    // provider swap does not churn.
    return records.sort((a, b) => {
      const ca = a.cluster_order ?? Number.MAX_SAFE_INTEGER;
      const cb = b.cluster_order ?? Number.MAX_SAFE_INTEGER;
      if (ca !== cb) return ca - cb;
      return (Number(HANDLE_RE.exec(a.handle)?.[2] ?? 0)) - (Number(HANDLE_RE.exec(b.handle)?.[2] ?? 0));
    });
  }

  async createRecord(input) {
    const kind = input.kind ?? KIND.IDEA;
    this.requireKind(kind);
    if (!input.title) throw new Error('fluid: createRecord requires a title');

    let handle;
    if (input.handle === undefined) {
      handle = await this._nextHandle(kind);
    } else {
      handle = assertHandle(input.handle, kind);
      // Checked against every handle EVER issued, not just the live ones. A
      // retired handle is still spoken for: reissuing it would repoint existing
      // citations at a different record.
      if (await this._handleWasIssued(handle)) {
        throw new Error(
          `fluid: handle ${handle} has already been issued and cannot be reused ` +
          `(handles are external citations; retired ones stay retired)`
        );
      }
    }

    for (const link of input.links ?? []) assertLink(link);
    const status = assertStatus(input.status ?? 'new');
    const now = nowIso();
    const record = normalizeRecord({
      handle,
      kind,
      title: input.title,
      body: input.body ?? '',
      status,
      status_label: input.status_label ?? null,
      priority: input.priority ?? null,
      effort: input.effort ?? null,
      impact: input.impact ?? null,
      cluster: input.cluster ?? null,
      cluster_order: input.cluster_order ?? null,
      tags: input.tags ?? [],
      source: input.source ?? null,
      links: input.links ?? [],
      killed: input.killed ?? null,
      discussion: input.discussion ?? [],
      provenance: {
        origin: input.provenance?.origin ?? 'cli:ideabox',
        recorded_at: input.provenance?.recorded_at ?? now,
        author: input.provenance?.author ?? null,
      },
      // Provider-assigned and provider-scoped, per the contract: `id` changes
      // when a record moves providers, while `handle` survives the swap.
      // Deliberately NOT SmartMemory's item_id, which does not exist until the
      // write returns — the contract requires `id` on the object being written.
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    });
    assertValid('record', record, 'record');

    // The tombstone is written BEFORE the record exists. Persisting first and
    // appending after means a failed append leaves a discoverable record whose
    // handle was never burned — delete it and the handle is reissued, defeating
    // the invariant. Burning first can at worst waste a handle, and a wasted
    // handle is free while a reissued one is unrecoverable.
    await this.appendEvent({
      handle,
      type: input.provenance?.origin === 'import:ideabox' ? 'imported' : 'created',
      at: now,
      detail: { kind },
    });

    await this.client.createItem({
      content: this._renderContent(record),
      memoryType: wireTypeFor(kind),
      metadata: this._toMetadata(record),
    });

    return record;
  }

  async updateRecord(handle, patch) {
    const item = await this._resolveForWrite(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());

    assertPatchable(patch, this.name());

    const current = this._fromItem(item);
    if (!current) throw new FluidRecordNotFound(handle, this.name());

    const merged = {
      ...current,
      ...patch,
      ...Object.fromEntries(UNPATCHABLE.map((f) => [f, current[f]])),
      updated_at: nowIso(),
    };

    // Validate the RAW merge, then normalize — order is load-bearing.
    // Normalizing first would hand the schema an already-sanitized object and
    // the schema would approve what the sanitizer had quietly repaired.
    assertStatus(merged.status);
    assertValid('record', merged, 'record');
    for (const link of merged.links) assertLink(link);

    const next = normalizeRecord(merged);
    const eventType = eventTypeForUpdate(current, next, patch);

    // One metadata key carrying the whole record. The server's merge is a
    // one-level spread, so this replaces the record wholesale while leaving
    // every server-owned metadata key untouched. `properties` is deliberately
    // not used: it bypasses the merge and is the mass-assignment surface the
    // server's protected fields exist to guard.
    await this.client.updateItem(item.item_id, {
      content: this._renderContent(next),
      metadata: this._toMetadata(next),
    });

    await this.appendEvent({
      handle,
      type: eventType,
      at: nowIso(),
      detail: { fields: Object.keys(patch) },
    });

    return next;
  }

  /** The only way discussion grows. Append-only in the API, not merely by
   *  convention in the contract — a deliberation trail that can be rewritten is
   *  not evidence. */
  async appendDiscussion(handle, entry) {
    const item = await this._resolveForWrite(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());
    if (!entry?.text) throw new Error('fluid: a discussion entry requires text');

    const record = this._fromItem(item);
    if (!record) throw new FluidRecordNotFound(handle, this.name());

    record.discussion.push({
      at: entry.at ?? nowIso(),
      text: entry.text,
      author: entry.author ?? null,
    });
    record.updated_at = nowIso();
    assertValid('record', record, 'record');

    await this.client.updateItem(item.item_id, {
      content: this._renderContent(record),
      metadata: this._toMetadata(record),
    });
    await this.appendEvent({ handle, type: 'discussed', at: nowIso(), detail: {} });
    return record;
  }

  /**
   * Hard delete. NOT the lifecycle path — killing an idea is
   * `updateRecord(handle, {status: 'killed'})`, which keeps the record and its
   * reasoning.
   *
   * The discussion is carried into the append-only log before the record goes,
   * so "append-only" is not true of every path except the one that erases it.
   */
  async deleteRecord(handle) {
    const item = await this._resolveForWrite(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());
    const record = this._fromItem(item);

    await this.appendEvent({
      handle,
      type: 'deleted',
      at: nowIso(),
      detail: {
        kind: record?.kind,
        title: record?.title,
        discussion: record?.discussion ?? [],
      },
    });

    await this.client.deleteItem(item.item_id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  async addLink(handle, link) {
    assertLink(link);
    const item = await this._resolveForWrite(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());
    const record = this._fromItem(item);
    if (!record) throw new FluidRecordNotFound(handle, this.name());

    const exists = record.links.some((l) => l.type === link.type && l.target === link.target);
    // Idempotent, and deliberately emits no event on a repeat: a `linked` event
    // per repeat would inflate the lifecycle history a later semantic layer
    // reads as signal.
    if (!exists) {
      record.links.push({ ...link });
      record.updated_at = nowIso();
      await this.client.updateItem(item.item_id, {
        content: this._renderContent(record),
        metadata: this._toMetadata(record),
      });
      await this.appendEvent({ handle, type: 'linked', at: nowIso(), detail: { ...link } });
    }
    return record;
  }

  async removeLink(handle, link) {
    const item = await this._resolveForWrite(handle);
    if (!item) throw new FluidRecordNotFound(handle, this.name());
    const record = this._fromItem(item);
    if (!record) throw new FluidRecordNotFound(handle, this.name());

    const before = record.links.length;
    record.links = record.links.filter((l) => !(l.type === link.type && l.target === link.target));
    if (record.links.length !== before) {
      record.updated_at = nowIso();
      await this.client.updateItem(item.item_id, {
        content: this._renderContent(record),
        metadata: this._toMetadata(record),
      });
    }
    return record;
  }

  // -------------------------------------------------------------------------
  // Recall (CAP.RECALL)
  // -------------------------------------------------------------------------

  /**
   * Semantic recall over fluid records.
   *
   * One unfiltered, over-fetched query, then filtered client-side to this
   * provider's namespace and to `RECALLABLE_KINDS`. Filtering the OUTPUT rather
   * than scoping the REQUEST is deliberate: `memory_type` on the wire takes a
   * single value, so covering three recallable kinds would need three queries,
   * and scores from separate searches are not comparable — merging them would
   * fabricate a ranking.
   *
   * DISCLOSED BOUND: because filtering happens after ranking, recall can return
   * fewer than `limit` results even when more matching records exist, if enough
   * higher-scoring non-recallable items fill the over-fetch. The alternative is
   * unbounded fetching. Asserted in the tests so a future change is deliberate.
   *
   * DISCLOSED BOUND: an edited record keeps its original embedding, because
   * PATCH does not reindex and no per-item reindex exists over HTTP
   * (smart-memory-core#4). The record returned here is CURRENT — search hydrates
   * from the live graph node — so what lags is why a record matched and where it
   * ranked, not what you receive. The lexical channels still see current text.
   *
   * @param {string} query
   * @param {{limit?: number}} [opts]
   * @returns {Promise<import('./provider.js').RecallHit[]>}
   */
  async recall(query, opts = {}) {
    this.require(CAP.RECALL);

    const limit = normalizeRecallLimit(opts?.limit);
    const topK = Math.min(Math.max(limit * OVERFETCH, MIN_FETCH), TOP_K_CAP);

    const raw = await this.client.searchItems(query, { topK });

    const hits = [];
    const seen = new Map();
    for (const result of raw?.results ?? []) {
      const meta = result?.metadata ?? {};
      // Namespace first: a shared workspace holds items that are not ours at
      // all, and they must never reach a caller.
      if (meta.fluid_ns !== RECORD_NS) continue;

      const record = this._fromItem(result);
      // `_fromItem` warns and returns null on an unreadable blob. One corrupt
      // row must degrade to "that record is not in these results", never to a
      // failed recall.
      if (!record) continue;

      // THE ENFORCEMENT. Holds with the deployment's embedding config unset,
      // which is exactly the case the config dial cannot defend.
      if (!RECALLABLE_KINDS.has(record.kind)) continue;

      const score = typeof result?.score === 'number' ? result.score : null;
      const createdAt = meta.created_at ?? '';
      const itemId = String(result?.item_id ?? '');

      // Collapse duplicate handles using D-FOH-4's full order — earliest
      // server-stamped created_at, ties broken by item_id. Dropping the second
      // key would leave same-instant duplicates resolving nondeterministically,
      // and disagreeing with getRecord(). Both keys are already on the hit, so
      // this costs no extra request.
      const existing = seen.get(record.handle);
      if (existing) {
        const isEarlier = createdAt !== existing.createdAt
          ? createdAt < existing.createdAt
          : itemId < existing.itemId;
        if (isEarlier) {
          existing.hit.record = record;
          existing.createdAt = createdAt;
          existing.itemId = itemId;
        }
        // The surviving hit keeps its ORIGINAL rank and score: the duplicate is
        // a storage artifact, and letting it reshuffle the ranking would leak
        // that artifact into the answer.
        continue;
      }

      const hit = { handle: record.handle, score, record };
      seen.set(record.handle, { hit, createdAt, itemId });
      hits.push(hit);
    }

    // Server order is the ranking. Filtering removes entries; it never reorders
    // the survivors, and nothing here recomputes a score.
    return hits.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Lifecycle events
  // -------------------------------------------------------------------------

  /**
   * Events are SEPARATE items on purpose.
   *
   * Stored inside a record's metadata they would be destroyed with the record,
   * and handle retirement is precisely what must outlive deletion. They are
   * written and never updated or deleted.
   */
  async appendEvent(event) {
    const full = { at: nowIso(), ...event };
    // The log is append-only, so a malformed entry is permanent. Validate
    // before it lands rather than on a later read with no caller to blame.
    assertValid('lifecycle_event', full, 'lifecycle event');
    await this.client.createItem({
      content: `${full.type} ${full.handle}`,
      memoryType: EVENT_WIRE_TYPE,
      metadata: {
        fluid_ns: EVENT_NS,
        handle: full.handle,
        fluid_event_json: JSON.stringify(full),
      },
    });
    return full;
  }

  async readEvents(handle) {
    const items = await this._listAllItems({
      metadataKey: 'fluid_ns', metadataValue: EVENT_NS,
    });
    const events = [];
    for (const item of items) {
      const meta = item?.metadata ?? {};
      if (meta.fluid_ns !== EVENT_NS) continue;
      if (handle && meta.handle !== handle) continue;
      try {
        events.push(JSON.parse(meta.fluid_event_json));
      } catch {
        process.emitWarning(
          `fluid(smartmemory): event item ${item?.item_id} has an unreadable payload and was skipped`,
        );
      }
    }
    // Chronological, matching the floor's append-only file order. Handle
    // allocation reads this, so a stable order keeps allocation reproducible.
    return events.sort((a, b) => String(a?.at ?? '').localeCompare(String(b?.at ?? '')));
  }
}
