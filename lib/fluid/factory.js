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

import { FluidConfigError } from './provider.js';
import { LocalFluidProvider } from './local-provider.js';

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
    // Not implemented in S1. This is a deliberate hard failure rather than a
    // silent downgrade to the floor: a user who configured SmartMemory did so
    // to get the capabilities the floor does not have, and starting up on the
    // floor instead would present an intelligence-free system as a working one.
    throw new FluidConfigError(
      'compose: fluid provider "smartmemory" is configured but not yet implemented ' +
      '(COMP-PLAN-IDEA-UNIFY ships the local floor first). Set fluid.provider to ' +
      '"local", or remove the key, to use the zero-install floor.',
      { provider: name }
    );
  }

  throw new FluidConfigError(`compose: unknown fluid provider "${name}"`, { provider: name });
}

export { loadFluidConfig };
