/**
 * S01: the agent-run version guard names the real floor from exported constants,
 * never a literal buried in the template string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  StratumMcpClient,
  REQUIRED_STRATUM_SURFACE,
  REQUIRED_STRATUM_RANGE,
} from '../lib/stratum-mcp-client.js';
import { runAndNormalize } from '../lib/result-normalizer.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('SURFACE-GUARD: a 0.4-era server refuses a requested-controls call, naming the real floor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compose-surface-guard-'));
  const serverPath = join(root, 'old-server.mjs');
  await writeFile(serverPath, `
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server = new Server({name:'old-stratum',version:'0.4.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{
  name:'stratum_agent_run',inputSchema:{type:'object',properties:Object.fromEntries(
    ['agent','prompt','cwd','model','sandboxMode'].map(k=>[k,{}])
  )}
}]}));
server.setRequestHandler(CallToolRequestSchema, async () => ({content:[{type:'text',text:'{"text":"should not run"}'}]}));
await server.connect(new StdioServerTransport());
`);
  const stratum = new StratumMcpClient();
  t.after(async () => { await stratum.close(); await rm(root, { recursive: true, force: true }); });
  await stratum.connect({ command: process.execPath, args: [serverPath], cwd: root });

  const surfaceRegex = new RegExp(
    `required execution surface: ${REQUIRED_STRATUM_SURFACE} \\(@smartmemory/stratum ${REQUIRED_STRATUM_RANGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`,
  );
  await assert.rejects(
    runAndNormalize(null, 'old server probe', { step_id: 'review', agent: 'claude' }, {
      stratum, profile: 'claude:read-only-reviewer:critical', cwd: root,
    }),
    error => {
      assert.match(error.message, /does not support.*allowedTools/);
      assert.match(error.message, surfaceRegex);
      return true;
    },
  );
});

test('SURFACE-GUARD: neither constant value appears as a version literal in test/review-fixes-runtime.test.js', () => {
  const source = readFileSync(join(REPO_ROOT, 'test', 'review-fixes-runtime.test.js'), 'utf8');
  assert.ok(!source.includes('surface: 17'), 'expected no hardcoded "surface: 17" literal');
  assert.equal(REQUIRED_STRATUM_SURFACE, 19);
  assert.equal(REQUIRED_STRATUM_RANGE, '>=0.5.0');
});
