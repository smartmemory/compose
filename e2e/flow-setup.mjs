/**
 * e2e/flow-setup.mjs — Playwright globalSetup for the cockpit flows (COMP-VERIFY-FLOW-1).
 * Builds the sandbox from scripts/flows/flow-env.mjs: a throwaway workspace seeded with one
 * builder-saved pipeline, this checkout's server and its cockpit (Vite, proxy pointed at that
 * server, never :4001/:4002). Hands the cockpit URL to the specs through FLOW_COCKPIT_URL and
 * returns the teardown. A setup failure exits 3 (`setup_exit_codes`), so Compose reports
 * FLOW_SETUP_ERROR instead of FLOW_FAILED.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { makeSandbox, setupFail, startCockpit, startServer, stopAll } from '../scripts/flows/flow-env.mjs';

export const SEED_NAME = 'flow-seed';
export const SEED_STEP = 'draft-step';
const MARKER = '# saved by Compose pipeline builder'; // server/stratum-spec-routes.js MARKER

export default async function setup() {
  try { return await build(); } catch (error) { return setupFail(error.message); }
}

async function build() {
  const sb = makeSandbox('cockpit');
  const taken = new Set();
  let server = null;
  let cockpit = null;
  const teardown = async () => { stopAll(cockpit?.child, server?.child); sb.remove(); };
  process.on('exit', () => { stopAll(cockpit?.child, server?.child); sb.remove(); });
  // One `set` step the engine accepts; its id is what the flow renames.
  const seed = {
    version: 1,
    contracts: { Result: { summary: 'string' } },
    flows: {
      entry: 'main',
      main: { input: {}, output: { from: `\${${SEED_STEP}.output}`, contract: 'Result' }, steps: [{ id: SEED_STEP, set: { summary: 'yes' }, out: 'Result' }] },
    },
  };
  writeFileSync(path.join(sb.ws, 'pipelines', `${SEED_NAME}.stratum.yaml`), `${MARKER}\n${YAML.stringify(seed)}`);
  server = await startServer(sb, taken);
  cockpit = await startCockpit(sb, server, taken);
  process.env.FLOW_COCKPIT_URL = cockpit.base;
  return teardown;
}
