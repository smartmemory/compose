import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveStratumUi } from './lib/stratum-ui-link.js'
import { resolveCadenceUiDir } from './lib/cadence-ui-link.js'
import { resolveWikiComponentsDir } from './lib/wiki-components-link.js';

const stratumUi = resolveStratumUi();
const wikiComponents = resolveWikiComponentsDir();
const cadenceUi = resolveCadenceUiDir();

export default defineConfig({
  plugins: [react()],
  define: { __STRATUM_UI__: JSON.stringify(Boolean(stratumUi)), __CADENCE_UI__: JSON.stringify(Boolean(cadenceUi)), __WIKI_COMPONENTS__: JSON.stringify(Boolean(wikiComponents)) },
  resolve: {
    dedupe: ['react', 'react-dom', '@dagrejs/dagre', 'lucide-react', 'date-fns'],
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: /^@smartmemory\/stratum-ui\/styles\.css$/, replacement: stratumUi ? stratumUi.styles : fileURLToPath(new URL('./src/lib/stratum-ui-stub.css', import.meta.url)) },
      { find: /^@smartmemory\/stratum-ui$/, replacement: stratumUi ? stratumUi.entry : fileURLToPath(new URL('./src/lib/stratum-ui-stub.js', import.meta.url)) },
      { find: '@cadence/ui/styles.css', replacement: cadenceUi ? path.join(cadenceUi, 'src/styles.css') : fileURLToPath(new URL('./src/lib/cadence-ui-stub.css', import.meta.url)) },
      { find: /^@cadence\/ui$/, replacement: cadenceUi ? path.join(cadenceUi, 'src/index.ts') : fileURLToPath(new URL('./src/lib/cadence-ui-stub.js', import.meta.url)) },
      { find: /^@wiki\/components$/, replacement: wikiComponents ? path.join(wikiComponents, 'src/index.js') : fileURLToPath(new URL('./src/lib/wiki-components-stub.js', import.meta.url)) },
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
