import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Persisted work is shared by CLI, vision and SDK processes. Missing is idle;
 * unreadable state is uncertain and must never authorize eviction. */
export function hasPersistedWork(dataDir) {
  const read = file => {
    try { return JSON.parse(readFileSync(path.join(dataDir, file), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    const build = read('active-build.json');
    if (build && !['complete', 'completed', 'failed', 'aborted', 'cancelled'].includes(build.status)) return true;
    const agents = read('agents.json');
    const records = Array.isArray(agents) ? agents : Object.values(agents ?? {});
    return records.some(agent => agent?.status === 'running');
  } catch { return true; }
}
