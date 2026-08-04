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
import { join } from 'node:path';

import { getSmartmemoryConfig } from '../smartmemory-config.js';
import { FluidConfigError } from './provider.js';
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
 * Construct the configured provider.
 *
 * @param {string} cwd project root
 * @param {object} [opts] passed through to the provider's init (the floor takes
 *   `recordsRoot` to relocate its tracked record tree)
 * @returns {Promise<import('./provider.js').FluidProvider>}
 */
export async function fluidProviderFor(cwd, opts = {}) {
  const cfg = loadFluidConfig(cwd);
  const name = cfg.provider ?? 'local';

  if (name === 'local') {
    return new LocalFluidProvider().init(cwd, { ...cfg.local, ...opts });
  }

  if (name === 'smartmemory') {
    // INTERIM GUARD — remove when COMP-FLUID-SEAM-GUARANTEES lands.
    //
    // This provider satisfies the seam interface completely and is missing two
    // guarantees the floor has, because COMP-PLAN-IDEA-UNIFY S3b-1 built both
    // into `local-provider.js` rather than into the seam:
    //
    //   - it takes NO lock, so concurrent creates can allocate the same handle
    //     and last-writer-wins destroys the losers. `lib/dir-lock.js` would not
    //     help even if wired in: it is a local filesystem mutex and this store
    //     is shared across machines.
    //   - it ignores `reclaimAborted`, so an import interrupted between its
    //     tombstone and its record burns that handle permanently and can never
    //     be re-run — over a network call, which is a wide window.
    //
    // Warn rather than refuse: the storage and recall paths work, COMP-FOH
    // shipped them deliberately, and refusing would break a configuration that
    // is fine for everything except concurrent writes and a resumable import.
    // Silence is the one option that is wrong, because both failures are
    // invisible until they cost an idea.
    console.warn(
      'compose: fluid provider "smartmemory" has unserialized handle allocation and a '
      + 'non-restartable import (COMP-FLUID-SEAM-GUARANTEES). Concurrent writes can lose '
      + 'records. Prefer the local provider for the ideabox until that lands.'
    );

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
