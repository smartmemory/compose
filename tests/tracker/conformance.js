import { describe, it, expect } from 'vitest';
import { CAP } from '../../lib/tracker/provider.js';

export function runProviderConformance(label, makeProvider) {
  describe(`TrackerProvider conformance: ${label}`, () => {
    it('createFeature is side-effect-free: persists record, NO event, NO roadmap regen', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-1', { code: 'CONF-1', description: 'd', status: 'PLANNED' });
        const f = await provider.getFeature('CONF-1');
        expect(f.status).toBe('PLANNED');
        expect(await provider.readEvents('CONF-1')).toEqual([]);
      } finally { await cleanup(); }
    });

    it('putFeature is metadata-only: rejects a status delta', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-2', { code: 'CONF-2', description: 'd', status: 'PLANNED' });
        await expect(provider.putFeature('CONF-2', { code: 'CONF-2', description: 'd', status: 'IN_PROGRESS' }))
          .rejects.toThrow(/status/i);
        await provider.putFeature('CONF-2', { code: 'CONF-2', description: 'd2', status: 'PLANNED' });
        expect((await provider.getFeature('CONF-2')).description).toBe('d2');
      } finally { await cleanup(); }
    });

    it('putFeature is idempotent (same payload twice = no-op)', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-3', { code: 'CONF-3', description: 'd', status: 'PLANNED' });
        const obj = { code: 'CONF-3', description: 'x', status: 'PLANNED' };
        await provider.putFeature('CONF-3', obj);
        await provider.putFeature('CONF-3', obj);
        expect((await provider.getFeature('CONF-3')).description).toBe('x');
      } finally { await cleanup(); }
    });

    it('setStatus enforces nothing itself but persists + emits one event', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-4', { code: 'CONF-4', description: 'd', status: 'PLANNED' });
        await provider.setStatus('CONF-4', 'IN_PROGRESS', { by: 'test' });
        expect((await provider.getFeature('CONF-4')).status).toBe('IN_PROGRESS');
        const ev = await provider.readEvents('CONF-4');
        expect(ev.filter(e => e.type === 'status').length).toBe(1);
      } finally { await cleanup(); }
    });

    it('concurrent same-feature completions never lose or duplicate', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await provider.createFeature('CONF-5', { code: 'CONF-5', description: 'd', status: 'IN_PROGRESS' });
        await Promise.all([
          provider.recordCompletion('CONF-5', { sha: 'a'.repeat(40), notes: 'x' }),
          provider.recordCompletion('CONF-5', { sha: 'b'.repeat(40), notes: 'y' }),
        ]);
        const f = await provider.getFeature('CONF-5');
        const shas = (f.completions ?? []).map(c => c.sha).sort();
        expect(shas).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
      } finally { await cleanup(); }
    });

    it('listFeatures returns a stable, collision-free order under concurrent creates in one phase', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        await Promise.all([
          provider.createFeature('CONF-A', { code: 'CONF-A', description: 'a', status: 'PLANNED', phase: 'P' }),
          provider.createFeature('CONF-B', { code: 'CONF-B', description: 'b', status: 'PLANNED', phase: 'P' }),
        ]);
        const list = await provider.listFeatures();
        const codes = list.map(f => f.code);
        expect(new Set(codes).size).toBe(codes.length);
        const again = (await provider.listFeatures()).map(f => f.code);
        expect(again).toEqual(codes);
      } finally { await cleanup(); }
    });

    it('capabilities() is a Set drawn only from CAP values', async () => {
      const { provider, cleanup } = await makeProvider();
      try {
        const caps = provider.capabilities();
        expect(caps instanceof Set).toBe(true);
        for (const c of caps) expect(Object.values(CAP)).toContain(c);
      } finally { await cleanup(); }
    });
  });
}
