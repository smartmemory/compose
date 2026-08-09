/**
 * lib/fluid/provider.js — the fluid-store provider seam.
 *
 * Owner ruling: `PROVIDER-SEAM` (docs/product/2026-07-20-what-to-build-vision.md
 * §8k, owner-locked 2026-07-21). Canonical fluid records (ideas, positions,
 * joints, decisions, ledger entries) live behind THIS interface. The floor is a
 * zero-install local provider; SmartMemory is the reference, capability-rich
 * provider.
 *
 * The interface is drawn at exactly three things:
 *   1. typed record CRUD
 *   2. lifecycle events
 *   3. capability discovery
 *
 * and nothing else. Semantic machinery — recall, challenge, conviction/decay,
 * calibration, contradiction — is deliberately NOT part of the interface. Those
 * are capabilities that light up when the configured provider declares them.
 *
 * WHY THIS IS THE WHOLE POINT: abstracting semantics into the seam is the
 * lowest-common-denominator failure, and the ruling prohibits it. A provider
 * without a capability must LACK it visibly; nothing may fake it. Concretely,
 * `recall()` on a provider that never declared RECALL must throw — it must not
 * return `[]`. An empty array is indistinguishable from a real "nothing matched"
 * answer, so returning one silently converts a missing capability into a wrong
 * answer, which is the precise failure this seam exists to prevent.
 *
 * Contract: contracts/fluid-record.schema.json
 * Pattern precedent: lib/tracker/provider.js (the tracker seam).
 * Pattern REJECTED: lib/tracker/factory.js `withFallback` — see lib/fluid/factory.js.
 */

/**
 * Capabilities every provider must implement. These ARE the seam's contract.
 */
export const STORAGE_CAP = Object.freeze({
  RECORDS: 'RECORDS',
  EVENTS: 'EVENTS',
  LINKS: 'LINKS',
});

/**
 * Capabilities a provider may declare. These are the reason the seam exists.
 * Declared, never abstracted — the floor has none of them, and that is correct.
 */
export const SEMANTIC_CAP = Object.freeze({
  RECALL: 'RECALL',
  CHALLENGE: 'CHALLENGE',
  CONVICTION: 'CONVICTION',
  CALIBRATION: 'CALIBRATION',
  CONTRADICTION: 'CONTRADICTION',
});

export const CAP = Object.freeze({ ...STORAGE_CAP, ...SEMANTIC_CAP });

/**
 * Bounds for `recall(query, {limit})`. On the seam, not on a provider, so two
 * providers cannot disagree about what `limit: 0` or `limit: 5000` means.
 *
 * The clamp is load-bearing rather than decorative: a provider backed by an HTTP
 * search API typically forwards this as a result count, and an unbounded value
 * becomes an unbounded fetch plus a proportional ranking cost on the server.
 */
export const RECALL_LIMIT_DEFAULT = 10;
export const RECALL_LIMIT_MIN = 1;
export const RECALL_LIMIT_MAX = 100;

/**
 * Normalize a caller's `limit` to the seam's bounds. Never throws — recall is a
 * discovery call, and answering sanely beats failing on a sloppy argument.
 *
 * The two ends are deliberately NOT symmetric:
 *
 * - **Too large is clamped.** `limit: 5000` is a legible intent — "give me
 *   lots" — so it is honoured up to the ceiling.
 * - **Zero, negative and unusable take the DEFAULT, not the floor.** These carry
 *   no intent at all; they are almost always an uninitialised variable or a
 *   failed parse. Clamping `0` to `1` would answer a question nobody asked, and
 *   would do it silently — a single near-useless result looks like a real answer.
 *
 * @param {unknown} limit
 * @returns {number}
 */
export function normalizeRecallLimit(limit) {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : NaN;
  if (Number.isNaN(n) || n < RECALL_LIMIT_MIN) return RECALL_LIMIT_DEFAULT;
  return Math.min(n, RECALL_LIMIT_MAX);
}

/**
 * One recall result.
 *
 * @typedef {object} RecallHit
 * @property {string} handle
 *   The record's citation — and **the authority**. `record` below is a
 *   convenience payload; anything about to ACT on a result must re-read it with
 *   `getRecord(handle)`.
 * @property {number|null} score
 *   The provider's relevance score, passed through untouched. `null` when the
 *   provider did not supply one — deliberately not `0`, which would sort as a
 *   real and terrible score rather than as "unknown".
 * @property {object} record
 *   A hit-time snapshot of the record, valid against
 *   `#/definitions/record`. It is a SIBLING of `score`, never a carrier for it:
 *   the record contract is `additionalProperties: false`, so a score attached to
 *   the record object would produce something the contract rejects.
 *
 *   **Current, not "as indexed".** A provider whose index lags its store may
 *   match on stale text while returning the current record. What can be stale is
 *   *why a hit surfaced and where it ranked* — never what you receive.
 */

const SEMANTIC_CAP_VALUES = Object.freeze(new Set(Object.values(SEMANTIC_CAP)));
const STORAGE_CAP_VALUES = Object.freeze(new Set(Object.values(STORAGE_CAP)));

export function isSemanticCapability(cap) {
  return SEMANTIC_CAP_VALUES.has(cap);
}

export function isStorageCapability(cap) {
  return STORAGE_CAP_VALUES.has(cap);
}

/**
 * How far a provider's mutation serialization actually reaches.
 *
 * Declared rather than assumed, because "is this store safe for two writers" has
 * no single answer — it depends on the mechanism AND on how far the store is
 * reachable. A filesystem mutex genuinely serializes every process on one
 * machine and cannot serialize two machines; saying "locked" would be true and
 * misleading in the same breath.
 *
 * Ordered weakest to strongest, and comparable via {@link mutationScopeAtLeast}.
 */
export const MUTATION_SCOPE = Object.freeze({
  /** Nothing is serialized. Concurrent writers can destroy each other's records. */
  NONE: 'none',
  /** Serialized within one process only — no help against a second CLI or server. */
  PROCESS: 'process',
  /** Serialized across every process on one machine. The floor (`lib/dir-lock.js`). */
  MACHINE: 'machine',
  /** Serialized across every machine reaching the store. Required of a shared store. */
  CLUSTER: 'cluster',
});

const MUTATION_SCOPE_RANK = Object.freeze({
  [MUTATION_SCOPE.NONE]: 0,
  [MUTATION_SCOPE.PROCESS]: 1,
  [MUTATION_SCOPE.MACHINE]: 2,
  [MUTATION_SCOPE.CLUSTER]: 3,
});

/** True when `scope` is at least as strong as `required`. */
export function mutationScopeAtLeast(scope, required) {
  return (MUTATION_SCOPE_RANK[scope] ?? -1) >= (MUTATION_SCOPE_RANK[required] ?? Infinity);
}

/** Record kinds the contract defines. A provider implements a subset. */
export const KIND = Object.freeze({
  IDEA: 'idea',
  POSITION: 'position',
  JOINT: 'joint',
  DECISION: 'decision',
  THREAD: 'thread',
  QUESTION: 'question',
  // A grouping is a record, not a label on its members: an umbrella owns a
  // hand-authored Theme paragraph, and the only place that could live on a
  // member is duplicated across all of them.
  CLUSTER: 'cluster',
});

/**
 * The kinds `challenge()` accepts (COMP-FOH FOH-3). A seam-level contract, not a
 * provider detail: only assertion-shaped kinds (a decision, an idea) can
 * meaningfully contradict stored memory. The challenge endpoint runs its
 * detection cascade directly with no `should_challenge` gate, so a non-assertional
 * kind (thread/question/cluster) must be refused here rather than fed to it.
 */
export const CHALLENGEABLE_KINDS = Object.freeze(new Set([KIND.DECISION, KIND.IDEA]));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Configuration is present but wrong. Never swallowed — see factory.js. */
export class FluidConfigError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'FluidConfigError';
    this.detail = detail;
  }
}

/**
 * The configured provider does not offer the requested capability.
 *
 * This is the "visibly unavailable, never faked" mechanism in code form. It
 * names both the capability and the provider so the surface above can render a
 * funnel ("challenge: connect SmartMemory") rather than an empty state — the
 * distinction `COLLEAGUE-ALL-IN` turns on.
 */
export class FluidCapabilityUnavailable extends Error {
  constructor(capability, providerName, detail = {}) {
    super(
      `fluid: capability ${capability} is not available on provider "${providerName}". ` +
      `This capability is not emulated by design — connect a provider that declares it.`
    );
    this.name = 'FluidCapabilityUnavailable';
    this.capability = capability;
    this.provider = providerName;
    this.detail = detail;
  }
}

/** The provider does not implement this record kind. */
export class FluidKindUnsupported extends Error {
  constructor(kind, providerName, supported = []) {
    super(
      `fluid: record kind "${kind}" is not supported by provider "${providerName}" ` +
      `(supported: ${supported.length ? supported.join(', ') : 'none'})`
    );
    this.name = 'FluidKindUnsupported';
    this.kind = kind;
    this.provider = providerName;
    this.supported = supported;
  }
}

/**
 * A find-or-create matched more than one record.
 *
 * Distinct from "not found" because the caller's options are opposite: a miss is
 * resolved by creating, an ambiguity can only be resolved by naming a handle.
 * Auto-picking one would silently attach work to whichever duplicate sorted
 * first.
 */
export class FluidAmbiguousMatch extends Error {
  constructor(kind, title, handles) {
    super(
      `fluid: "${title}" matches ${handles.length} ${kind} records ` +
      `(${handles.join(', ')}). Name the handle instead.`
    );
    this.name = 'FluidAmbiguousMatch';
    this.kind = kind;
    this.title = title;
    this.handles = handles;
  }
}

/** A record was addressed that does not exist. */
export class FluidRecordNotFound extends Error {
  constructor(handle, providerName) {
    super(`fluid: no record with handle "${handle}" on provider "${providerName}"`);
    this.name = 'FluidRecordNotFound';
    this.handle = handle;
    this.provider = providerName;
  }
}

const NI = (m) => { throw new Error(`FluidProvider.${m}: not implemented`); };

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export class FluidProvider {
  /** Stable provider name, used in errors and diagnostics. */
  name() { return NI('name'); }

  /**
   * The capabilities this provider actually offers.
   * A provider MUST NOT declare a semantic capability it emulates.
   * @returns {Set<string>}
   */
  capabilities() { return new Set(); }

  /**
   * Record kinds this provider implements.
   * @returns {Set<string>}
   */
  supportedKinds() { return new Set(); }

  /**
   * How far this provider's mutation serialization reaches.
   *
   * **Defaults to `NONE`, deliberately.** A provider that has not thought about
   * concurrency has not solved it, and the default that assumes the best is the
   * one that produced this whole feature: S3b-1's second implementation looked
   * complete precisely because nothing ever asked it this question.
   *
   * @returns {string} one of {@link MUTATION_SCOPE}
   */
  mutationScope() { return MUTATION_SCOPE.NONE; }

  /**
   * True when this provider's store can be reached from more than one machine.
   *
   * Paired with `mutationScope()` because neither answers the safety question
   * alone: `MACHINE` scope is complete for a local directory and useless for a
   * shared workspace. A provider that is `shared` and below `CLUSTER` scope has
   * a real, silent data-loss hole, and that is the pair the factory warns on.
   */
  isShared() { return false; }

  async init(_cwd, _config) { return this; }

  async health() {
    return {
      ok: true,
      provider: this.name?.() ?? 'base',
      capabilities: [...this.capabilities()],
      kinds: [...this.supportedKinds()],
    };
  }

  // -- capability + kind guards ---------------------------------------------

  /** True when the capability is declared. Callers use this to decide whether
   *  to OFFER a semantic affordance at all. */
  has(cap) { return this.capabilities().has(cap); }

  /**
   * Assert a capability, or throw. Every semantic entry point calls this FIRST,
   * before any work, so that a missing capability surfaces identically whether
   * or not the underlying store happens to hold matching data.
   */
  require(cap) {
    if (!this.has(cap)) throw new FluidCapabilityUnavailable(cap, this.name());
    return true;
  }

  /** Assert this provider implements a record kind, or throw. */
  requireKind(kind) {
    if (!this.supportedKinds().has(kind)) {
      throw new FluidKindUnsupported(kind, this.name(), [...this.supportedKinds()]);
    }
    return true;
  }

  // -- records (STORAGE_CAP.RECORDS) ----------------------------------------
  //
  // TWO OBLIGATIONS EVERY PROVIDER OWES, STATED HERE BECAUSE THEY ARE THE SEAM'S
  // PROMISE AND NOT A PROVIDER'S CHOICE (COMP-FLUID-SEAM-GUARANTEES).
  //
  // Both were built in S3b-1 and both were built in ONE provider. The second
  // implementation then satisfied this interface completely while having
  // neither, and nothing failed — which is the whole argument for writing them
  // down where a third implementation must read them. `record-shape.js` holds
  // the same line for `normalizeRecord` and `UNPATCHABLE`.
  //
  //  1. **SERIALIZED MUTATION.** Every mutating method is atomic with respect to
  //     concurrent callers, INCLUDING callers in other processes and — for a
  //     store reachable from more than one machine — on other machines. Two
  //     failure modes ride on this, and the first is the loud one:
  //
  //       - Handle allocation reads the maximum issued handle and adds one.
  //         Unserialized, N concurrent creates all allocate the same handle and
  //         last-writer-wins destroys N-1 records. Measured, not theorised.
  //       - `updateRecord`, `appendDiscussion`, `addLink` and `removeLink` are
  //         read-modify-write against one record. Unserialized, the later write
  //         erases the earlier one.
  //
  //     The mechanism is the provider's to choose and MUST match its reach: the
  //     floor uses a filesystem mutex (`lib/dir-lock.js`), which is correct for
  //     a local directory and definitionally wrong for a store shared across
  //     machines — being shared is the entire reason to use such a store.
  //
  //     A provider that cannot serialize must SAY SO rather than approximate
  //     it — see `mutationScope()`. Declared, never faked, exactly as with the
  //     semantic capabilities: a silent approximation of atomicity is worse
  //     than its absence, because the caller believes it is safe.
  //
  //  2. **`reclaimAborted` ON `createRecord`.** Creation burns a handle before
  //     the record exists (the tombstone ordering, which is the only safe
  //     direction — see the floor's `_createRecordLocked`). A crash between the
  //     two steps therefore leaves a handle that is issued, has no record, and
  //     is permanently un-creatable.
  //
  //     `createRecord({ handle, reclaimAborted: true })` MUST reclaim exactly
  //     that state: a handle that was issued, never became live, and was never
  //     `deleted`. It MUST NOT reclaim a handle whose record exists or was
  //     deleted — a retired handle stays retired, because handles are external
  //     citations and reissuing one repoints them at a different record.
  //
  //     This exists so the one-time import is RESTARTABLE. A migration of a
  //     project's entire corpus that cannot be re-run after a partial failure
  //     is a migration that fails permanently on its most likely failure.
  //
  // `test/fluid-provider-conformance.test.js` asserts both against every
  // provider, so a new implementation cannot satisfy this interface while
  // missing them the way the second one did.

  async getRecord(_handle) { return NI('getRecord'); }
  async listRecords(_filter) { return NI('listRecords'); }
  async createRecord(_input) { return NI('createRecord'); }
  async updateRecord(_handle, _patch) { return NI('updateRecord'); }
  async deleteRecord(_handle) { return NI('deleteRecord'); }

  /**
   * Find a record of `kind` whose title matches (case-insensitively), or create
   * it. **One operation, not two calls a caller sequences.**
   *
   * COMP-FLUID-SEAM-GUARANTEES F6-1. `compose ideabox add --cluster "Umbrella A"`
   * looked the cluster up and then created it, and the per-mutation lock covers
   * each of those but not the pair — so two concurrent adds both miss and both
   * create, leaving two clusters with the same name and the ideas split across
   * them. The lookup is the half that is not a mutation, which is exactly why
   * per-mutation locking could never cover it.
   *
   * On the seam rather than in the caller because the fix is a critical section
   * only the provider can open, and because every future caller of "get me the
   * thing called X" has the same race. Its atomicity is the provider's
   * `mutationScope()` — genuinely atomic on the floor, and on a provider
   * declaring `NONE` no better than the two calls it replaces, which is what
   * that declaration is for.
   *
   * @returns {Promise<{record: object, created: boolean}>}
   * @throws {FluidAmbiguousMatch} when more than one record already matches.
   */
  async findOrCreateRecord({ kind, title }, input = {}) {
    // Base implementation: correct, and only as atomic as the provider is. A
    // provider that can do better overrides this; the floor does.
    const matches = (await this.listRecords({ kind }))
      .filter((r) => r.title.toLowerCase() === String(title).toLowerCase());
    if (matches.length > 1) {
      throw new FluidAmbiguousMatch(kind, title, matches.map((m) => m.handle));
    }
    if (matches.length === 1) return { record: matches[0], created: false };
    return { record: await this.createRecord({ ...input, kind, title }), created: true };
  }

  // -- links (STORAGE_CAP.LINKS) --------------------------------------------

  async addLink(_handle, _link) { return NI('addLink'); }
  async removeLink(_handle, _link) { return NI('removeLink'); }

  // -- lifecycle events (STORAGE_CAP.EVENTS) --------------------------------

  async appendEvent(_event) { return NI('appendEvent'); }
  async readEvents(_handle) { return NI('readEvents'); }

  // -- semantic capabilities ------------------------------------------------
  //
  // These are declared here ONLY so that the failure mode is uniform and
  // typed: the base implementation's entire job is to refuse. It is deliberate
  // that there is no fallback, no heuristic, and no degraded path. A provider
  // that offers one of these overrides the method AND declares the capability;
  // the two must move together, which is what makes `has()` trustworthy.
  //
  // See {@link RecallHit} above `recall()` for the one return shape that IS
  // specified here rather than left to a provider.

  /**
   * Semantic recall over records. Declared here, implemented by any provider
   * that has the machinery for it.
   *
   * THE SHAPE IS PART OF THE SEAM, not of whichever provider gets there first.
   * A second provider that returned bare records, or glued a score onto one,
   * would be a different contract wearing the same method name — the exact
   * drift that put `normalizeRecord` and `UNPATCHABLE` in `record-shape.js`.
   *
   * @param {string} _query free text
   * @param {{limit?: number}} [_opts] `limit` defaults to {@link RECALL_LIMIT_DEFAULT}
   *   and is clamped to [{@link RECALL_LIMIT_MIN}, {@link RECALL_LIMIT_MAX}]. A
   *   missing or unusable value takes the default rather than throwing: recall
   *   is a discovery call, usually driven by a UI or an agent, and failing hard
   *   on a sloppy limit is worse than answering sanely.
   * @returns {Promise<RecallHit[]>} ranked best-first
   * @throws {FluidCapabilityUnavailable} unless the provider declares RECALL.
   */
  async recall(_query, _opts) { this.require(CAP.RECALL); return NI('recall'); }

  /**
   * Contradiction detection: surface stored records that contradict the record
   * at `handle`. THE SHAPE IS PART OF THE SEAM (like {@link RecallHit}), not of
   * whichever provider implements it first.
   *
   * @typedef {object} Conflict
   * @property {string} handle a fluid record that contradicts the challenged one
   * @property {string} existingText the contradicting record's asserted text
   * @property {string} conflictType e.g. direct_contradiction, temporal_conflict
   * @property {number} confidence 0..1
   * @property {string} explanation why it conflicts
   * @property {string} suggestedResolution e.g. keep_existing, accept_new, merge
   *
   * @typedef {object} ChallengeResult
   * @property {string} assertion the challenged record's text
   * @property {boolean} hasConflicts DERIVED from the returned conflicts, never a
   *   provider's upstream pre-filter value
   * @property {number} confidence DERIVED from the returned conflicts (1.0 when none)
   * @property {Conflict[]} conflicts best-first
   *
   * @param {string} _handle
   * @param {{useLlm?: boolean, timeoutMs?: number}} [_opts]
   * @returns {Promise<ChallengeResult>}
   * @throws {FluidCapabilityUnavailable} unless the provider declares CHALLENGE.
   */
  async challenge(_handle, _opts) { this.require(CAP.CHALLENGE); return NI('challenge'); }

  /** @throws {FluidCapabilityUnavailable} unless the provider declares CONVICTION. */
  async conviction(_handle) { this.require(CAP.CONVICTION); return NI('conviction'); }

  /** @throws {FluidCapabilityUnavailable} unless the provider declares CALIBRATION. */
  async calibration(_scope) { this.require(CAP.CALIBRATION); return NI('calibration'); }

  /** @throws {FluidCapabilityUnavailable} unless the provider declares CONTRADICTION. */
  async contradictions(_handle) { this.require(CAP.CONTRADICTION); return NI('contradictions'); }
}
