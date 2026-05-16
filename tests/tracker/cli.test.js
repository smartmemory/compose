import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTrackerCli } from '../../lib/tracker/cli.js';
import { OpLog, Cache, Reconciler } from '../../lib/tracker/sync-engine.js';

function proj(trackerCfg) {
  const cwd = mkdtempSync(join(tmpdir(), 'ctp-cli-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify(trackerCfg ? { tracker: trackerCfg } : {}));
  return cwd;
}

describe('runTrackerCli', () => {
  it('status (local default) reports provider local + zero pending/conflicts', async () => {
    const cwd = proj(null);
    try {
      const result = await runTrackerCli(cwd, ['status']);
      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/provider[:=]?\s*local/i);
      expect(result.output).toMatch(/pending/i);
      expect(result.output).toMatch(/conflict/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('sync (local) is a no-op reporting drained 0', async () => {
    const cwd = proj(null);
    try {
      const result = await runTrackerCli(cwd, ['sync']);
      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/drained[:=]?\s*0/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('unknown subcommand returns usage / non-fatal message with exitCode 1', async () => {
    const cwd = proj(null);
    try {
      const result = await runTrackerCli(cwd, ['bogus']);
      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/usage|status|sync/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('missing subcommand returns usage with exitCode 1', async () => {
    const cwd = proj(null);
    try {
      const result = await runTrackerCli(cwd, []);
      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/usage|status|sync/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('unknown subcommand does NOT call providerFor (no I/O on bad input)', async () => {
    // Deliberately pass a non-existent cwd — if providerFor ran it would throw on missing .compose
    const fakeCwd = join(tmpdir(), 'does-not-exist-' + Date.now());
    const result = await runTrackerCli(fakeCwd, ['oops']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/usage/i);
  });
});

describe('GitHubProvider.sync() drained metric — quarantined ops excluded', () => {
  it('drained counts only truly-resolved ops, not quarantined ones', async () => {
    // Construct a minimal Reconciler scenario without the full GitHubProvider stack.
    // Two pending ops: one resolves cleanly, one triggers an immediate casMismatch quarantine.
    // Expected: drained=1, quarantined=1, pending=0 after flush.
    const dataDir = mkdtempSync(join(tmpdir(), 'ctp-sync-metric-'));
    try {
      const log = new OpLog(dataDir);
      const cache = new Cache(dataDir);

      // Append two ops
      const op1 = await log.append({ op: 'putFeature', code: 'AA-1', payload: { status: 'IN_PROGRESS' }, baseVersion: 'v1' });
      const op2 = await log.append({ op: 'putFeature', code: 'BB-2', payload: { status: 'COMPLETE' }, baseVersion: 'v2' });

      let callCount = 0;
      const reconciler = new Reconciler({
        log,
        cache,
        dir: dataDir,
        maxAttempts: 5,
        apply: async (op) => {
          callCount++;
          if (op.id === op1.id) {
            // op1: resolves cleanly
            return { version: 'v2' };
          }
          // op2: casMismatch → immediate quarantine
          const err = new Error('stale');
          err.casMismatch = { remoteVersion: 'v3' };
          throw err;
        },
      });

      const beforePending = (await log.pending()).length;
      const beforeQuarantined = (await log.quarantined()).length;
      expect(beforePending).toBe(2);
      expect(beforeQuarantined).toBe(0);

      await reconciler.flush();

      const afterPending = (await log.pending()).length;
      const afterQuarantined = (await log.quarantined()).length;
      const newlyQuarantined = afterQuarantined - beforeQuarantined;
      const drained = (beforePending - afterPending) - newlyQuarantined;

      expect(afterPending).toBe(0);
      expect(afterQuarantined).toBe(1);
      expect(newlyQuarantined).toBe(1);
      expect(drained).toBe(1); // only op1 truly resolved; op2 quarantined — NOT counted as drained
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
