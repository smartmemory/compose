import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runProviderConformance } from './conformance.js';
import { GitHubProvider } from '../../lib/tracker/github-provider.js';
import { makeGitHubFixture } from './fixtures/github-server.js';

async function makeProvider() {
  process.env.CTP_TEST_TOKEN = 'tok';
  const cwd = mkdtempSync(join(tmpdir(), 'ctp-gh-'));
  const provider = await new GitHubProvider().init(cwd,
    { repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' }, _transport: makeGitHubFixture('o/r') });
  return { provider, cwd, cleanup: async () => rmSync(cwd, { recursive: true, force: true }) };
}
runProviderConformance('GitHubProvider', makeProvider);
