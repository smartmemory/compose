import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { LocalFileProvider } from './local-provider.js';
import { TrackerConfigError } from './provider.js';

function loadTrackerConfig(cwd) {
  const p = join(cwd, '.compose/compose.json');
  if (!existsSync(p)) return { provider: 'local' };
  try { return JSON.parse(readFileSync(p, 'utf8')).tracker ?? { provider: 'local' }; }
  catch { return { provider: 'local' }; }
}

const ENTITY_METHODS = {
  JOURNAL: ['readJournal', 'writeJournalEntry'],
  VISION: ['getVisionState', 'putVisionState'],
};

function withFallback(active, local) {
  const caps = active.capabilities();
  return new Proxy(active, {
    get(target, prop) {
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

export async function providerFor(cwd) {
  const cfg = loadTrackerConfig(cwd);
  const local = await new LocalFileProvider().init(cwd, {});
  if (!cfg.provider || cfg.provider === 'local') return local;
  if (cfg.provider === 'github') {
    const { GitHubProvider } = await import('./github-provider.js');
    const gh = await new GitHubProvider().init(cwd, cfg.github ?? {});
    return withFallback(gh, local);
  }
  throw new TrackerConfigError(`unknown tracker provider "${cfg.provider}"`);
}
