import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { LocalFileProvider } from './local-provider.js';
import { TrackerConfigError } from './provider.js';

function loadTrackerConfig(cwd) {
  const p = join(cwd, '.compose/compose.json');
  // Absent file → local default (valid, not misconfig).
  if (!existsSync(p)) return { provider: 'local' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    // File EXISTS but JSON is malformed → fail fast (never silently fall back;
    // silent fallback would mask misconfig — design.md Error Handling).
    throw new TrackerConfigError(
      `compose: tracker config at ${p} contains invalid JSON — ${e.message}`
    );
  }
  // Absent tracker key → local default (valid).
  const tracker = parsed.tracker;
  if (tracker === undefined || tracker === null) return { provider: 'local' };
  // tracker key present but structurally invalid → fail fast.
  if (typeof tracker !== 'object' || Array.isArray(tracker)) {
    throw new TrackerConfigError(
      `compose: tracker config at ${p} has a "tracker" key but it is not an object (got ${Array.isArray(tracker) ? 'array' : typeof tracker})`
    );
  }
  return tracker;
}

const ENTITY_METHODS = {
  JOURNAL: ['readJournal', 'writeJournalEntry'],
  VISION: ['getVisionState', 'putVisionState'],
};

function withFallback(active, local) {
  const caps = active.capabilities();
  return new Proxy(active, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      for (const [cap, methods] of Object.entries(ENTITY_METHODS)) {
        if (methods.includes(prop) && !caps.has(cap)) {
          const fn = local[prop];
          return typeof fn === 'function' ? fn.bind(local) : fn;
        }
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// ---------------------------------------------------------------------------
// Test transport injection (TEST-ONLY — no production effect)
// ---------------------------------------------------------------------------
//
// Tests that drive PRODUCTION entry points (writers) through a GitHub-configured
// project need to inject a fixture transport WITHOUT modifying the on-disk config
// (which can't hold a function). Call `setTestTransport(transport)` before
// constructing the provider; call `clearTestTransport()` in afterEach.
//
// Production behavior: `_testTransport` is undefined by default → no effect.
//
let _testTransport = undefined;

/**
 * @param {object|null} transport - fixture transport for tests; null to clear.
 */
export function setTestTransport(transport) {
  _testTransport = transport ?? undefined;
}

export function clearTestTransport() {
  _testTransport = undefined;
}

export async function providerFor(cwd) {
  const cfg = loadTrackerConfig(cwd);
  const local = await new LocalFileProvider().init(cwd, {});
  if (!cfg.provider || cfg.provider === 'local') return local;
  if (cfg.provider === 'github') {
    const { GitHubProvider } = await import('./github-provider.js');
    // Merge in the test-only transport if one has been set via setTestTransport().
    // In production _testTransport is undefined and cfg.github is passed as-is.
    const ghCfg = _testTransport !== undefined
      ? { ...(cfg.github ?? {}), _transport: _testTransport }
      : (cfg.github ?? {});
    const gh = await new GitHubProvider().init(cwd, ghCfg);
    return withFallback(gh, local);
  }
  throw new TrackerConfigError(`unknown tracker provider "${cfg.provider}"`);
}
