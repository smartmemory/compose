import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runProviderConformance } from './conformance.js';
import { LocalFileProvider } from '../../lib/tracker/local-provider.js';

async function makeProvider() {
  const cwd = mkdtempSync(join(tmpdir(), 'ctp-local-'));
  const provider = await new LocalFileProvider().init(cwd, {});
  return { provider, cwd, cleanup: async () => rmSync(cwd, { recursive: true, force: true }) };
}
runProviderConformance('LocalFileProvider', makeProvider);

import { describe, it, expect } from 'vitest';

describe('LocalFileProvider putFeature null/empty status clobber guard', () => {
  it('rejects null status when it differs from current', async () => {
    const { provider, cleanup } = await makeProvider();
    try {
      await provider.createFeature('NULL-1', { code: 'NULL-1', description: 'd', status: 'PLANNED' });
      await expect(
        provider.putFeature('NULL-1', { code: 'NULL-1', description: 'd', status: null })
      ).rejects.toThrow(/status/);
    } finally { await cleanup(); }
  });

  it('rejects empty-string status when it differs from current', async () => {
    const { provider, cleanup } = await makeProvider();
    try {
      await provider.createFeature('EMPTY-1', { code: 'EMPTY-1', description: 'd', status: 'PLANNED' });
      await expect(
        provider.putFeature('EMPTY-1', { code: 'EMPTY-1', description: 'd', status: '' })
      ).rejects.toThrow(/status/);
    } finally { await cleanup(); }
  });
});
