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

describe('LocalFileProvider appendEvent / readEvents symmetry', () => {
  it('accepts normalized type on write and round-trips type on read', async () => {
    const { provider, cleanup } = await makeProvider();
    try {
      await provider.createFeature('EV-1', { code: 'EV-1', description: 'd', status: 'PLANNED' });
      await provider.appendEvent('EV-1', { type: 'status', from: 'PLANNED', to: 'IN_PROGRESS' });
      const ev = await provider.readEvents('EV-1');
      expect(ev.length).toBe(1);
      expect(ev[0].type).toBe('status');
    } finally { await cleanup(); }
  });

  it('rejects appendEvent with no tool and no known type', async () => {
    const { provider, cleanup } = await makeProvider();
    try {
      await provider.createFeature('EV-2', { code: 'EV-2', description: 'd', status: 'PLANNED' });
      await expect(
        provider.appendEvent('EV-2', { foo: 1 })
      ).rejects.toThrow(/resolve writer tool/);
    } finally { await cleanup(); }
  });
});

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
