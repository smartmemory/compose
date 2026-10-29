import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveStratumUiDir } from './lib/stratum-ui-link.js';

const stratumUi = resolveStratumUiDir();

export default defineConfig({
  plugins: [react()],
  define: { __STRATUM_UI__: JSON.stringify(Boolean(stratumUi)) },
  resolve: {
    dedupe: ['react', 'react-dom', '@dagrejs/dagre'],
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: '@stratum/ui/styles.css', replacement: stratumUi ? path.join(stratumUi, 'src/styles.css') : fileURLToPath(new URL('./src/lib/stratum-ui-stub.css', import.meta.url)) },
      { find: /^@stratum\/ui$/, replacement: stratumUi ? path.join(stratumUi, 'src/index.ts') : fileURLToPath(new URL('./src/lib/stratum-ui-stub.js', import.meta.url)) },
    ],
  },
  test: {
    environment: 'jsdom',
    // COMP-UITEST-ISOLATION-1: explicit (already the default) — guard against a
    // future default flip. A fresh per-file environment is what keeps these
    // global-mutating suites (globalThis.fetch/WebSocket/EventSource) from
    // leaking across files. The localStorage flake itself is handled defensively
    // in test/ui/setup.js (see the note there).
    isolate: true,
    globals: true,
    include: ['test/ui/**/*.test.{js,jsx}', 'src/**/*.test.{js,jsx}'],
    // COMPOSE-GOLDEN-LEAK-1: scrub inherited GIT_* redirection for this runner too.
    setupFiles: ['test/helpers/git-env-scrub.js', 'test/ui/setup.js'],
  },
});
