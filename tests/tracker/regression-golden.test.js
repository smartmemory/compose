import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalFileProvider } from '../../lib/tracker/local-provider.js';
import { addRoadmapEntry, setFeatureStatus } from '../../lib/feature-writer.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ctp-gold-')); }

describe('regression golden: LocalFileProvider == legacy direct calls', () => {
  it('scaffold->status produces identical ROADMAP.md and feature.json', async () => {
    const a = tmp(), b = tmp();
    try {
      // Path A: through LocalFileProvider
      const p = await new LocalFileProvider().init(a, {});
      await p.addRoadmapEntry({ code: 'GOLD-1', description: 'g', phase: 'P1', status: 'PLANNED' });
      await p.setStatus('GOLD-1', 'IN_PROGRESS', { reason: 'test' });

      // Path B: legacy direct calls
      await addRoadmapEntry(b, { code: 'GOLD-1', description: 'g', phase: 'P1', status: 'PLANNED' });
      await setFeatureStatus(b, { code: 'GOLD-1', status: 'IN_PROGRESS', reason: 'test' });

      // Compare feature.json (delete `updated` symmetrically — stamped by writeFeature on each write)
      const fa = JSON.parse(readFileSync(join(a, 'docs/features/GOLD-1/feature.json'), 'utf8'));
      const fb = JSON.parse(readFileSync(join(b, 'docs/features/GOLD-1/feature.json'), 'utf8'));
      delete fa.updated; delete fb.updated;
      expect(fa).toEqual(fb);

      // Compare ROADMAP.md (both fresh dirs generate identical preamble with same date string)
      const ra = readFileSync(join(a, 'ROADMAP.md'), 'utf8');
      const rb = readFileSync(join(b, 'ROADMAP.md'), 'utf8');
      expect(ra).toEqual(rb);
    } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
  });
});
