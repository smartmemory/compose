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

const SEMANTIC_CAP_VALUES = Object.freeze(new Set(Object.values(SEMANTIC_CAP)));
const STORAGE_CAP_VALUES = Object.freeze(new Set(Object.values(STORAGE_CAP)));

export function isSemanticCapability(cap) {
  return SEMANTIC_CAP_VALUES.has(cap);
}

export function isStorageCapability(cap) {
  return STORAGE_CAP_VALUES.has(cap);
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

  async getRecord(_handle) { return NI('getRecord'); }
  async listRecords(_filter) { return NI('listRecords'); }
  async createRecord(_input) { return NI('createRecord'); }
  async updateRecord(_handle, _patch) { return NI('updateRecord'); }
  async deleteRecord(_handle) { return NI('deleteRecord'); }

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

  /** @throws {FluidCapabilityUnavailable} unless the provider declares RECALL. */
  async recall(_query, _opts) { this.require(CAP.RECALL); return NI('recall'); }

  /** @throws {FluidCapabilityUnavailable} unless the provider declares CHALLENGE. */
  async challenge(_handle, _opts) { this.require(CAP.CHALLENGE); return NI('challenge'); }

  /** @throws {FluidCapabilityUnavailable} unless the provider declares CONVICTION. */
  async conviction(_handle) { this.require(CAP.CONVICTION); return NI('conviction'); }

  /** @throws {FluidCapabilityUnavailable} unless the provider declares CALIBRATION. */
  async calibration(_scope) { this.require(CAP.CALIBRATION); return NI('calibration'); }

  /** @throws {FluidCapabilityUnavailable} unless the provider declares CONTRADICTION. */
  async contradictions(_handle) { this.require(CAP.CONTRADICTION); return NI('contradictions'); }
}
