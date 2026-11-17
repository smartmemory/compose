// Playwright config for Compose's own user flows (COMP-VERIFY-FLOW-1). Run by `compose verify`
// through the `builder-save-blur` flow in .compose/compose.json; the sandbox (throwaway workspace,
// this checkout's server and cockpit on test-range ports) is made by e2e/flow-setup.mjs.
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  // Traces and failure snapshots go outside the checkout, never into the repo tree.
  outputDir: path.join(process.env.SM_SCRATCH_ROOT || tmpdir(), 'compose-flow-results'),
  globalSetup: './flow-setup.mjs',
  use: { headless: true, channel: 'chromium-headless-shell' },
});
