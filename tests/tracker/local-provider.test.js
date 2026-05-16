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
