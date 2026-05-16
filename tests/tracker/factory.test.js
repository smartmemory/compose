import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { providerFor } from '../../lib/tracker/factory.js';
import { TrackerConfigError } from '../../lib/tracker/provider.js';

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
  it('malformed compose.json throws TrackerConfigError (fail-fast, never silent fallback)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ctp-fac-'));
    try {
      mkdirSync(join(cwd, '.compose'), { recursive: true });
      writeFileSync(join(cwd, '.compose/compose.json'), '{ NOT VALID JSON !!');
      await expect(providerFor(cwd)).rejects.toThrow(TrackerConfigError);
      await expect(providerFor(cwd)).rejects.toThrow(/invalid JSON/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('absent file → local default (not misconfig)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ctp-fac-nofile-'));
    try {
      // No .compose/compose.json at all — should silently default to local.
      const p = await providerFor(cwd);
      expect(p.name()).toBe('local');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('compose.json with no tracker key → local default (not misconfig)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ctp-fac-notracker-'));
    try {
      mkdirSync(join(cwd, '.compose'), { recursive: true });
      writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({ someOtherKey: 1 }));
      const p = await providerFor(cwd);
      expect(p.name()).toBe('local');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
