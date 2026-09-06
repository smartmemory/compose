/**
 * lib/fluid/factory.js — configured fluid-store provider selection.
 *
 * Mirrors `lib/tracker/factory.js` in config handling (absent means default,
 * malformed means fail loud) and DELIBERATELY DIVERGES from it in one respect:
 * there is no `withFallback` proxy here.
 *
 * The tracker seam wraps its active provider so that an entity the provider
 * cannot store falls through to the local one. That is right for the tracker,
 * where the fallback is STORAGE and the substituted answer is equally true.
 * It is wrong here. `PROVIDER-SEAM` forbids it: "a provider without a
 * capability lacks it visibly; nothing fakes it." A fallback that answered
 * `recall()` or `challenge()` from the floor would return a real-looking result
 * produced by machinery that does not exist, which is worse than an error —
 * the caller cannot tell the difference, and neither can the user.
 *
 * So capability absence propagates as `FluidCapabilityUnavailable` from
 * `FluidProvider.require()`, and surfaces render it as a funnel ("challenge:
 * connect SmartMemory") rather than an empty state.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getSmartmemoryConfig } from '../smartmemory-config.js';

/**
 * Well under the substrate's own membership cap of 100
 * (`auth_repository.py:730`). A portfolio turn costs one round trip per member
 * with no server-side batching, so the practical ceiling is latency, not the
 * substrate.
 */
const MAX_PORTFOLIO_MEMBERS = 16;
import { FluidConfigError, MUTATION_SCOPE, mutationScopeAtLeast } from './provider.js';
import { LocalFluidProvider } from './local-provider.js';
import { SmartMemoryFluidProvider } from './smartmemory-provider.js';

/**
 * Read `.compose/compose.json` → `fluid`.
 * Absent file or absent key → local floor. That is a valid, supported
 * configuration (the zero-install default), not a misconfiguration.
 */
function loadFluidConfig(cwd) {
  const p = join(cwd, '.compose/compose.json');
  if (!existsSync(p)) return { provider: 'local' };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    // The file EXISTS but is malformed. Falling back silently here would mask a
    // typo in the user's config and quietly downgrade them to the floor —
    // meaning their configured semantic capabilities would vanish with no
    // signal. Fail loud.
    throw new FluidConfigError(
      `compose: fluid config at ${p} contains invalid JSON — ${e.message}`,
      { path: p }
    );
  }

  // Valid JSON is not a valid config. `[]`, `"smartmemory"` and `42` all parse,
  // and reading `.fluid` off them yields undefined — which would silently select
  // the floor, exactly the quiet downgrade this function exists to prevent.
  // `null` would throw a bare TypeError instead of a config error.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FluidConfigError(
      `compose: fluid config at ${p} must be a JSON object ` +
      `(got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`,
      { path: p }
    );
  }

  const fluid = parsed.fluid;
  if (fluid === undefined || fluid === null) return { provider: 'local' };
  if (typeof fluid !== 'object' || Array.isArray(fluid)) {
    throw new FluidConfigError(
      `compose: fluid config at ${p} has a "fluid" key but it is not an object ` +
      `(got ${Array.isArray(fluid) ? 'array' : typeof fluid})`,
      { path: p }
    );
  }
  return fluid;
}

/**
 * @typedef {object} PortfolioMember
 * @property {string} id    the label the user chose; unique within the portfolio
 * @property {string} root  absolute path to that member's Compose project
 */

/**
 * Parse and validate `fluid.portfolio` (FOH-7).
 *
 * Read HERE, in the authoritative validating reader, and deliberately not in
 * `lib/maya-config.js`: that one swallows a malformed config as `{}`, so a
 * portfolio with a typo in it would come back as "no portfolio declared" and the
 * turn would quietly answer for one product instead of refusing. A config with
 * two readers where only one validates is how a misconfiguration becomes a
 * silent downgrade.
 *
 * @param {string} cwd the declaring root
 * @returns {{members: PortfolioMember[]} | null} null when none is declared
 */
export function parsePortfolioConfig(cwd) {
  const fluid = loadFluidConfig(cwd);
  const portfolio = fluid.portfolio;
  if (portfolio === undefined || portfolio === null) return null;

  const where = join(cwd, '.compose/compose.json');
  if (typeof portfolio !== 'object' || Array.isArray(portfolio)) {
    throw new FluidConfigError(
      `compose: fluid.portfolio at ${where} must be an object`, { path: where },
    );
  }
  const declared = portfolio.members;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new FluidConfigError(
      `compose: fluid.portfolio.members at ${where} must be a non-empty array — ` +
      `a portfolio with no members is a portfolio that cannot answer anything`,
      { path: where },
    );
  }
  if (declared.length > MAX_PORTFOLIO_MEMBERS) {
    throw new FluidConfigError(
      `compose: fluid.portfolio.members at ${where} declares ${declared.length} members, ` +
      `over the limit of ${MAX_PORTFOLIO_MEMBERS}`,
      { path: where },
    );
  }

  const members = [];
  const seen = new Set();
  for (const entry of declared) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new FluidConfigError(
        `compose: every fluid.portfolio.members entry at ${where} must be an object`, { path: where },
      );
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const rawRoot = typeof entry.root === 'string' ? entry.root.trim() : '';
    if (!id || !rawRoot) {
      throw new FluidConfigError(
        `compose: every fluid.portfolio.members entry at ${where} needs a non-empty "id" and "root"`,
        { path: where },
      );
    }
    if (seen.has(id)) {
      throw new FluidConfigError(
        `compose: fluid.portfolio.members at ${where} declares "${id}" twice — ` +
        `ids label the source of every result, so a duplicate makes the answer ambiguous`,
        { path: where, id },
      );
    }
    seen.add(id);

    const root = resolve(cwd, rawRoot);
    // A member must be a Compose project, and `.compose/compose.json` is what
    // makes it one. Accepting a bare `.compose/` directory would fall through to
    // the local provider and contribute an empty corpus — indistinguishable, in
    // the answer, from a real product that happens to have no ideas.
    if (!existsSync(join(root, '.compose/compose.json'))) {
      throw new FluidConfigError(
        `compose: fluid.portfolio member "${id}" at ${where} points at ${root}, ` +
        `which is not a Compose project (no .compose/compose.json)`,
        { path: where, id, root },
      );
    }
    members.push({ id, root });
  }

  // Self-membership is never INFERRED — that would be the discovery D-FOH-7-2
  // forbids. But a portfolio that omits the corpus the user is looking at
  // silently answers without it, so its absence is refused by name rather than
  // producing a quietly smaller result.
  const declaringRoot = resolve(cwd);
  if (!members.some((m) => m.root === declaringRoot)) {
    throw new FluidConfigError(
      `compose: fluid.portfolio at ${where} does not list its own declaring root. ` +
      `Membership is never inferred, so this project would be excluded from its own ` +
      `portfolio — add an entry with "root": "." if that is not what you meant`,
      { path: where, declaringRoot },
    );
  }

  return { members };
}

/**
 * Construct the configured provider.
 *
 * @param {string} cwd project root
 * @param {object} [opts] passed through to the provider's init (the floor takes
 *   `recordsRoot` to relocate its tracked record tree)
 * @returns {Promise<import('./provider.js').FluidProvider>}
 */
export async function fluidProviderFor(cwd, opts = {}) {
  return warnIfUnsafelyShared(await construct(cwd, opts));
}

/**
 * Warn when a provider's store is reachable from more machines than its
 * serialization is.
 *
 * DERIVED FROM THE PROVIDER'S OWN DECLARATIONS, never hardcoded per provider.
 * A hardcoded warning has to be remembered by whoever adds the third provider —
 * which is the same "the second implementation looked complete" failure this
 * whole feature exists to close — and it has to be remembered AGAIN, in the
 * other direction, on the day the gap is fixed, or it keeps crying wolf.
 *
 * Warns rather than refuses: storage and recall work, COMP-FOH shipped them
 * deliberately, and refusing would break a configuration that is fine for
 * everything except concurrent writes. Silence is the only wrong option, because
 * the failure is invisible until it has cost an idea.
 */
function warnIfUnsafelyShared(provider) {
  if (provider.isShared() && !mutationScopeAtLeast(provider.mutationScope(), MUTATION_SCOPE.CLUSTER)) {
    console.warn(
      `compose: fluid provider "${provider.name()}" is shared across machines but serializes `
      + `mutation only at "${provider.mutationScope()}" scope, so concurrent writes can allocate `
      + `the same handle and lose records. Prefer the local provider for the ideabox until its `
      + `store offers a cross-machine reservation primitive (SmartMemory SVC-LEASE-1).`
    );
  }
  return provider;
}

async function construct(cwd, opts = {}) {
  const cfg = loadFluidConfig(cwd);
  const name = cfg.provider ?? 'local';

  if (name === 'local') {
    return new LocalFluidProvider().init(cwd, { ...cfg.local, ...opts });
  }

  if (name === 'smartmemory') {
    // The warning that used to live here is gone, not deleted: it is now
    // `warnIfUnsafelyShared`, derived from this provider's own
    // `isShared()`/`mutationScope()` rather than hardcoded to its name
    // (COMP-FLUID-SEAM-GUARANTEES). BOTH gaps it named are now closed — the
    // restartable import first, then cross-machine serialization once
    // SmartMemory shipped SVC-ALLOC-1 and SVC-LEASE-1 (COMP-FLUID-SEAM-GUARANTEES) — so this
    // provider declares CLUSTER and the warning no longer fires for it. That is
    // exactly the "remember it AGAIN, in the other direction" the check below
    // was written to make automatic: nothing here had to be edited to stop the
    // warning, the declaration moving was enough.

    // The endpoint and credential come from the EXISTING top-level
    // `smartmemory` block, shared with the shipped kitchen pipeline, so there
    // is one source of truth for where SmartMemory lives. Only `workspaceId`
    // is new, and it lives under `fluid.smartmemory` because it scopes fluid
    // records specifically.
    //
    // A missing block is a config error, not a downgrade to the floor: a user
    // who configured SmartMemory did so to get capabilities the floor does not
    // have, and starting up on the floor instead would present an
    // intelligence-free system as a working one.
    const sm = getSmartmemoryConfig(cwd);
    if (!sm || Object.keys(sm).length === 0) {
      throw new FluidConfigError(
        'compose: fluid provider "smartmemory" requires a top-level "smartmemory" config ' +
        'block in .compose/compose.json (baseUrl + apiKeyEnv). It is shared with the ' +
        'SmartMemory ingest pipeline rather than duplicated under "fluid".',
        { provider: name, setting: 'smartmemory' }
      );
    }
    return new SmartMemoryFluidProvider().init(cwd, {
      baseUrl: sm.baseUrl,
      apiKeyEnv: sm.apiKeyEnv,
      timeoutMs: sm.timeoutMs,
      ...cfg.smartmemory,
      ...opts,
    });
  }

  throw new FluidConfigError(`compose: unknown fluid provider "${name}"`, { provider: name });
}

export { loadFluidConfig };
