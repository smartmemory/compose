import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { providerFor } from '../../lib/tracker/factory.js';

function projWith(trackerCfg) {
  const cwd = mkdtempSync(join(tmpdir(), 'ctp-fac-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose/compose.json'),
    JSON.stringify(trackerCfg ? { tracker: trackerCfg } : {}));
  return cwd;
}

describe('providerFor', () => {
  it('defaults to LocalFileProvider when tracker key absent', async () => {
    const cwd = projWith(null);
    try { const p = await providerFor(cwd); expect(p.name()).toBe('local'); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('returns local when provider explicitly "local"', async () => {
    const cwd = projWith({ provider: 'local' });
    try { const p = await providerFor(cwd); expect(p.name()).toBe('local'); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('unknown provider throws TrackerConfigError', async () => {
    const cwd = projWith({ provider: 'bogus' });
    try { await expect(providerFor(cwd)).rejects.toThrow(/bogus|unknown/i); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('passes provider methods through (local supports everything)', async () => {
    const cwd = projWith(null);
    try {
      const p = await providerFor(cwd);
      expect(typeof p.getVisionState).toBe('function');
      expect(typeof p.createFeature).toBe('function');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('malformed compose.json falls back to local without throwing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ctp-fac-'));
    try {
      mkdirSync(join(cwd, '.compose'), { recursive: true });
      writeFileSync(join(cwd, '.compose/compose.json'), '{ NOT VALID JSON !!');
      const p = await providerFor(cwd);
      expect(p.name()).toBe('local');
      // ensure the provider is not thenable (symbol guard defensive check)
      expect(p.then).toBeUndefined();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
