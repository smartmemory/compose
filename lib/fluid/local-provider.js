/**
 * lib/fluid/local-provider.js — the zero-install floor provider.
 *
 * Implements the fluid-store seam over git-tracked record files
 * (`lib/fluid/record-store.js`). There is exactly one record store.
 *
 * Storage layout:
 *   - a record  → one tracked JSON file, `docs/product/fluid/records/<HANDLE>.json`
 *   - an event  → one line in `docs/product/fluid/events.jsonl` (append-only)
 *
 * WHY NOT VISION ITEMS (S3 entry-gate ruling, 2026-08-04 — supersedes S1)
 * -----------------------------------------------------------------------
 * S1 hosted records on vision-store items in an additive `fluid_ext` namespace,
 * reading `PROVIDER-SEAM` (§8k) as "the vision store's existing typed items are
 * the expected implementation substrate of the local floor provider."
 *
 * That could not survive the durability question S3 opens with.
 * `.compose/data/vision-state.json` is gitignored, so records hosted there are
 * untracked, single-machine, and absent from CI — while `ideabox.md`, which
 * this slice turns into a GENERATED projection of them, is tracked. Canon would
 * have moved from a tracked file to an ignored one at the moment of cutover.
 * Un-ignoring vision-state was not an option either: it is ~540KB of churning
 * runtime state, unreadable as a diff and conflict-prone per parallel session.
 *
 * The owner ruled: track the records, split them out of vision-state. So the
 * substrate clause of §8k no longer holds, and the direction of canon inverts —
 * the record file is canon, and a vision item (if S4 wants one for the
 * promotion edge) becomes a derived projection of it. The seam itself, its
 * capability model and every handle invariant are untouched.
 *
 * What this bought beyond durability: the two-write compensation dance is gone
 * (one file, one write), and so is the `_sync()` stale-snapshot hazard — there
 * is no cached state for a second writer to invalidate.
 *
 * This provider declares STORAGE capabilities ONLY. It has no recall, no
 * challenge, no conviction, no calibration, no contradiction — and per the
 * ruling it must not pretend otherwise. Those calls inherit the base class's
 * refusal and throw `FluidCapabilityUnavailable`. That is the intended,
 * correct behavior of the floor, not a gap to be filled in later: the floor is
 * the filing cabinet, and the intelligence is what a richer provider adds.
 */

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { withDirLock } from '../dir-lock.js';

import {
  CAP,
  FluidProvider,
  FluidRecordNotFound,
  KIND,
  STORAGE_CAP,
} from './provider.js';
import { FluidRecordStore } from './record-store.js';
// Seam-wide record rules, shared with every other provider so the two cannot
// drift apart (COMP-FOH C12/C16). Handle grammar, link and status vocabularies
// and the event-type derivation live there for the same reason: they define
// what a fluid record IS, which is a property of the seam, not of a store.
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

function nowIso() { return new Date().toISOString(); }

/** Validate at the seam so a bad status surfaces as a fluid-level error naming
 *  the legal values, rather than as a schema rejection quoting an enum the
 *  caller never sees. */
export class LocalFluidProvider extends FluidProvider {
  name() { return 'local'; }

  /** Storage only. Never a semantic capability — see the file header. */
  capabilities() {
    return new Set([STORAGE_CAP.RECORDS, STORAGE_CAP.EVENTS, STORAGE_CAP.LINKS]);
  }

  /**
   * The kinds this provider owns.
   *
   * `position` and `joint` are still refused, but the S1 reason for it is now
   * obsolete and the real one is stronger. S1 said they had no vision item type
   * to live in; records are their own files now, so that constraint is gone.
   * They stay out because THE JUDGMENT LAYER ALREADY OWNS THEM —
   * `docs/judgment/records/positions/` and `.../joints/`, written by
   * `judgment_position_create` and `judgment_joint_add`. Accepting them here
   * would give one kind two stores and two canons, which is the exact
   * fragmentation this epic exists to end.
   */
  supportedKinds() {
    return new Set([KIND.IDEA, KIND.DECISION, KIND.THREAD, KIND.QUESTION, KIND.CLUSTER]);
  }

  /**
   * @param {string} cwd project root
   * @param {object} [config]
   * @param {string} [config.recordsRoot] override (tests point this at a tmp dir)
   */
  async init(cwd, config = {}) {
    this.cwd = cwd;
    this.store = new FluidRecordStore(cwd, config);
    this.recordsDir = this.store.recordsDir;
    this.eventsPath = this.store.eventsPath;

    // Every mutating method serializes on this. It lives under `.compose/data/`
    // because that path is gitignored: the lock writes an owner token INSIDE
    // the lock dir, so siting it next to the records — which are tracked canon —
    // would put untracked noise in tracked territory on every idea write.
    // (`record-store.js` used to point at `.compose/locks/`, which is NOT
    // ignored; that comment is corrected.)
    //
    // Keyed by the records dir rather than by cwd so two stores under one
    // project — which in practice means two test fixtures — do not serialize
    // against each other, while two writers to the SAME store always do.
    const key = createHash('sha256').update(this.recordsDir).digest('hex').slice(0, 12);
    this.lockPath = join(cwd, '.compose', 'data', `fluid-records-${key}.lock`);
    return this;
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  /**
   * Normalize a record on the way out. Delegates to the shared seam rule
   * (`record-shape.js`) so every provider fills contract defaults and clones
   * identically — see that module for why this is not provider-private.
   */
  _normalize(record) {
    return normalizeRecord(record);
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
    const issued = new Set(this.store.liveHandles());
    for (const handle of this.store.issuedHandlesFromLog()) issued.add(handle);
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
  /**
   * Was this handle burned by a create that never finished?
   *
   * `createRecord` appends the tombstone BEFORE writing the record, so a crash
   * between the two leaves a handle that is issued but has no record and never
   * had one. The one-time import is exactly where that matters: it skips only
   * LIVE records (`import-ideabox.js`), so a rerun retries the handle and is
   * then refused by the issued-handle guard — leaving the migration permanently
   * unrestartable, on the single operation that moves a project's whole idea
   * corpus.
   *
   * WHAT THIS CAN AND CANNOT PROVE — stated precisely, because an earlier
   * version of this comment claimed more than the code delivers.
   *
   * It establishes only: no record file, and no `deleted` event. It does NOT
   * establish that the handle was never live. A record created normally whose
   * file later disappeared out-of-band — a bad merge, a stray `rm`, a partial
   * checkout — has exactly this shape, and no evidence in the log distinguishes
   * it from a create that crashed. Do not read the name as a proof of absence.
   *
   * What makes reclaiming acceptable is the CALLER, not the check.
   * `reclaimAborted` is opt-in and the one-time import is the only thing that
   * passes it. The import supplies handles read out of the markdown, so the most
   * a reclaim can do is restore a handle to the content the markdown already
   * says belongs to it: a lost `IDEA-12.json` comes back as the IDEA-12 the file
   * describes, never handed to an unrelated idea. Automatic allocation never
   * reaches this path, and nothing else should pass the flag.
   *
   * Conservative where it can be. Structured events are read rather than
   * `issuedHandlesFromLog`, whose regex matches a handle anywhere in the log
   * including as another record's link target; and ANY `deleted` event
   * disqualifies the handle, so a deliberately retired one stays retired.
   */
  _isAbortedAllocation(handle) {
    if (this.store.read(handle)) return false;
    for (const event of this.store.readEvents()) {
      if (event?.handle === handle && event.type === 'deleted') return false;
    }
    return true;
  }

  _handleWasIssued(handle) {
    return this._issuedHandles().has(handle);
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  async getRecord(handle) {
    // A malformed handle is a miss, not a crash: getRecord is the lookup a
    // caller makes with untrusted input (a CLI argument, a URL segment), and
    // the honest answer to "is there a record called ../../etc/passwd" is no.
    // Paths that ALLOCATE a handle validate it strictly instead.
    if (!HANDLE_RE.test(handle ?? '')) return null;
    const record = this.store.read(handle);
    return record ? this._normalize(record) : null;
  }

  async listRecords(filter = {}) {
    let records = this.store.list().map((r) => this._normalize(r));
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

  // -------------------------------------------------------------------------
  // Mutation — every path below serializes on one lock
  // -------------------------------------------------------------------------
  //
  // The lock covers TWO distinct races, and scoping it to only the first was
  // the original mistake:
  //
  //  1. HANDLE ALLOCATION. `_nextHandle` reads the records directory AND the
  //     raw events log (`_issuedHandles`), so two creates can agree on the same
  //     next handle. The pre-write tombstone narrows that window; it does not
  //     close it. Note the lock must therefore cover the LOG, not just the
  //     record file — guarding the directory alone still permits a stale log
  //     read.
  //
  //  2. LOST UPDATES on every other mutation. `updateRecord`, `appendDiscussion`,
  //     `addLink` and `removeLink` are all read-modify-write against one record
  //     file: both writers read, both merge onto their own snapshot, and the
  //     later write erases the earlier one. S3a accepted this while nothing was
  //     wired ("it can only lose an update to the one contended record"). The
  //     CLI cutover is what makes it reachable, so it is fixed here rather than
  //     inherited.
  //
  // One lock rather than per-record locks: idea writes are human-scale, the
  // critical sections are a few small-file operations, and a single lock also
  // orders allocation against mutation. Two granularities would buy nothing and
  // cost a deadlock ordering rule.
  //
  // Each public method is a thin wrapper over a `*Locked` body because
  // `withDirLock` is NOT reentrant and these paths call one another's helpers.
  // `appendEvent` deliberately stays unlocked: it is an O_APPEND write of a
  // single line to an append-only log, it is called from inside locked bodies,
  // and locking it would deadlock every one of them.

  /**
   * @param {object} input record fields; `handle` may be supplied by the
   *   one-time import to preserve existing IDEA-N citations, otherwise it is
   *   allocated.
   */
  async createRecord(input) {
    return withDirLock(this.lockPath, () => this._createRecordLocked(input));
  }

  async updateRecord(handle, patch) {
    return withDirLock(this.lockPath, () => this._updateRecordLocked(handle, patch));
  }

  async appendDiscussion(handle, entry) {
    return withDirLock(this.lockPath, () => this._appendDiscussionLocked(handle, entry));
  }

  async deleteRecord(handle) {
    return withDirLock(this.lockPath, () => this._deleteRecordLocked(handle));
  }

  async addLink(handle, link) {
    return withDirLock(this.lockPath, () => this._addLinkLocked(handle, link));
  }

  async removeLink(handle, link) {
    return withDirLock(this.lockPath, () => this._removeLinkLocked(handle, link));
  }

  async _createRecordLocked(input) {
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
      if (this._handleWasIssued(handle) && !(input.reclaimAborted && this._isAbortedAllocation(handle))) {
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
        recorded_at: input.provenance?.recorded_at ?? nowIso(),
        author: input.provenance?.author ?? null,
      },
    };

    // Validate against the published contract, not a hand-rolled subset. A
    // bespoke field check drifts from the schema silently, accepting what the
    // contract forbids while the contract keeps claiming otherwise.
    //
    // Validated in its FINAL persisted form — id and timestamps included —
    // rather than with an `id: 'pending'` stand-in, so what the contract
    // approved is byte-for-byte what reaches disk.
    const now = nowIso();
    const persisted = this._normalize({
      ...record,
      // Provider-assigned and provider-scoped, per the contract: `id` changes
      // when a record is imported into a different provider, while `handle`
      // survives the swap because it is quoted in docs and commits.
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    });
    assertValid('record', persisted, 'record');

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

    // One file, one write. The S1 version wrote a vision item and then its
    // namespace, and needed a compensating delete when the second failed or the
    // record would exist as an inert half. A record is a single file now, and
    // the atomic rename inside the store makes it appear whole or not at all.
    this.store.write(persisted);
    return this._normalize(persisted);
  }

  async _updateRecordLocked(handle, patch) {
    const existing = this.store.read(handle);
    if (!existing) throw new FluidRecordNotFound(handle, this.name());

    // Refuse an unpatchable field rather than silently dropping it — shared with
    // every provider, because a provider that allows one is not a simpler
    // provider, it is one with a different contract.
    assertPatchable(patch, this.name());

    const current = this._normalize(existing);
    const merged = {
      ...current,
      ...patch,
      ...Object.fromEntries(UNPATCHABLE.map((f) => [f, current[f]])),
      updated_at: nowIso(),
    };

    // Validate the RESULT against the contract before anything reaches disk —
    // the whole shape, not the two fields that were easy to check by hand.
    //
    // ORDER IS LOAD-BEARING: validate the RAW merge, then normalize. Normalizing
    // first would hand the schema an already-sanitized object, and the schema
    // would approve what the sanitizer had quietly repaired. Two silent
    // failures live in that gap, both of which report success:
    //   - `{ links: null }` becomes `[]`, erasing every link
    //   - `{ titel: 'x' }` is dropped, so a misspelled field writes nothing
    // The contract already rejects both (`links` is typed, and the record
    // definition is `additionalProperties: false`) — but only if it sees them.
    assertStatus(merged.status);
    assertValid('record', merged, 'record');
    for (const link of merged.links) assertLink(link);

    const next = this._normalize(merged);
    const eventType = eventTypeForUpdate(current, next, patch);

    this.store.write(next);

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
  async _appendDiscussionLocked(handle, entry) {
    const existing = this.store.read(handle);
    if (!existing) throw new FluidRecordNotFound(handle, this.name());
    if (!entry?.text) throw new Error('fluid: a discussion entry requires text');

    const record = this._normalize(existing);
    record.discussion.push({
      at: entry.at ?? nowIso(),
      text: entry.text,
      author: entry.author ?? null,
    });
    record.updated_at = nowIso();
    assertValid('record', record, 'record');
    this.store.write(record);
    await this.appendEvent({ handle, type: 'discussed', at: nowIso(), detail: {} });
    return record;
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
  async _deleteRecordLocked(handle) {
    const existing = this.store.read(handle);
    if (!existing) throw new FluidRecordNotFound(handle, this.name());
    const record = this._normalize(existing);

    await this.appendEvent({
      handle,
      type: 'deleted',
      at: nowIso(),
      detail: { kind: record.kind, title: record.title, discussion: record.discussion },
    });

    // rmSync throws on a failed unlink, so a delete that did not reach disk
    // surfaces instead of returning ok while the record is still there to
    // reappear on the next read.
    this.store.remove(handle);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  async _addLinkLocked(handle, link) {
    assertLink(link);
    const existing = this.store.read(handle);
    if (!existing) throw new FluidRecordNotFound(handle, this.name());
    const record = this._normalize(existing);
    const exists = record.links.some((l) => l.type === link.type && l.target === link.target);
    // Idempotent: re-adding an existing link is a no-op, and deliberately emits
    // no event. A `linked` event per repeat would inflate the lifecycle history
    // that a conviction or calibration layer reads as signal.
    if (!exists) {
      record.links.push({ ...link });
      record.updated_at = nowIso();
      this.store.write(record);
      await this.appendEvent({ handle, type: 'linked', at: nowIso(), detail: { ...link } });
    }
    return record;
  }

  async _removeLinkLocked(handle, link) {
    const existing = this.store.read(handle);
    if (!existing) throw new FluidRecordNotFound(handle, this.name());
    const record = this._normalize(existing);
    const before = record.links.length;
    record.links = record.links.filter((l) => !(l.type === link.type && l.target === link.target));
    // Matching addLink: only a real change touches the record or the timestamp.
    if (record.links.length !== before) {
      record.updated_at = nowIso();
      this.store.write(record);
    }
    return record;
  }

  // -------------------------------------------------------------------------
  // Lifecycle events
  // -------------------------------------------------------------------------

  async appendEvent(event) {
    const full = { at: nowIso(), ...event };
    // The log is append-only, so a malformed entry is permanent. Validate before
    // it lands rather than discovering it on a read that no longer has a caller
    // to blame.
    assertValid('lifecycle_event', full, 'lifecycle event');
    return this.store.appendEvent(full);
  }

  async readEvents(handle) {
    const all = this.store.readEvents();
    return handle ? all.filter((e) => e.handle === handle) : all;
  }
}

export { CAP };
