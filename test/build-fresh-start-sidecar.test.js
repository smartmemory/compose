/**
 * build-fresh-start-sidecar.test.js — I2 (real-path).
 *
 * The dirty-lenses sidecar (.compose/prior_dirty_lenses.json) is cleared on clean
 * completion but was NOT cleared at fresh-build start, so a killed dirty build's
 * sidecar would make an unrelated fresh build's review_triage take the RETRY PATH
 * on round one. This drives a REAL fresh runBuild over the TS bin with a stale
 * sidecar pre-seeded and asserts, via the actual dispatched step, that the sidecar
 * is gone before any step runs — i.e. triage would take the FIRST RUN PATH.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

const TS_MCP_BIN = '/Users/ruze/reg/my/forge/stratum/ts/src/mcp/bin.mjs';

const SPEC = `
version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${work.output}
      contract: Result
    steps:
      - id: work
        do: "build \${input.description}"
        out: Result
`;

describe('fresh build clears the dirty-lenses sidecar (I2)', () => {
  test('a stale prior_dirty_lenses.json is gone before the first step runs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fresh-sidecar-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'fresh-sidecar-state-'));
    const client = new StratumMcpClient();
    let sidecarSeenAtDispatch = null;
    try {
      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'FRESH-1'), { recursive: true });
      await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), SPEC);
      await writeFile(join(workspace, 'docs', 'features', 'FRESH-1', 'description.md'), '# fresh\n');
      // Simulate a prior KILLED dirty build that left its sidecar behind.
      await writeFile(join(workspace, '.compose', 'prior_dirty_lenses.json'), JSON.stringify(['security']));

      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN], env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });
      // The dispatched step records whether the sidecar still exists when it runs.
      installAgentHarness(client, function factory(_agent, { cwd }) {
        return {
          async *run() {
            sidecarSeenAtDispatch = existsSync(join(cwd, '.compose', 'prior_dirty_lenses.json'));
            yield { type: 'assistant', content: JSON.stringify({ value: 'built' }) };
            yield { type: 'system', subtype: 'complete', agent: 'stub' };
          },
          interrupt() {}, get isRunning() { return false; },
        };
      }, workspace);

      await runBuild('FRESH-1', {
        cwd: workspace, stratum: client, template: 'build', skipTriage: true, description: 'x',
      });

      assert.equal(sidecarSeenAtDispatch, false,
        'the fresh build must clear the stale sidecar BEFORE the first step dispatches (FIRST RUN PATH)');
      assert.ok(!existsSync(join(workspace, '.compose', 'prior_dirty_lenses.json')),
        'the stale sidecar must be gone on disk');
      const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
      assert.equal(active.status, 'complete');
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
