import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTrackerCli } from '../../lib/tracker/cli.js';

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
      const out = await runTrackerCli(cwd, ['status']);
      expect(out).toMatch(/provider[:=]?\s*local/i);
      expect(out).toMatch(/pending/i);
      expect(out).toMatch(/conflict/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('sync (local) is a no-op reporting drained 0', async () => {
    const cwd = proj(null);
    try {
      const out = await runTrackerCli(cwd, ['sync']);
      expect(out).toMatch(/drained[:=]?\s*0/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('unknown subcommand returns usage / non-fatal message', async () => {
    const cwd = proj(null);
    try {
      const out = await runTrackerCli(cwd, ['bogus']);
      expect(out).toMatch(/usage|status|sync/i);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
