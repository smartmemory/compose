import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'
import { resolveStratumUi } from './lib/stratum-ui-link.js'
import { resolveCadenceUiDir } from './lib/cadence-ui-link.js'
import { resolveWikiComponentsDir } from './lib/wiki-components-link.js'

// COMPOSE-STRAT-TAB-1 / STRAT-COMPONENTS-PUBLISH-1: `@smartmemory/stratum-ui` is the sibling stratum/ui
// source on the Mac, else the installed npm package (CI, published npm); with neither, the alias points at
// a stub and the Stratum tab is hidden (`__STRATUM_UI__` false).
const stratumUi = resolveStratumUi()
// COMPOSE-WIKI-TAB-1: `@wiki/components` is the wiki checkout's components package, same rule (`__WIKI_COMPONENTS__`).
const wikiComponents = resolveWikiComponentsDir()
// COMPOSE-CADENCE-TAB-1: `@cadence/ui` is the Cadence checkout's ui package, same rule (`__CADENCE_UI__`).
const cadenceUi = resolveCadenceUiDir()

export default defineConfig({
  plugins: [react()],
  define: { __STRATUM_UI__: JSON.stringify(Boolean(stratumUi)), __CADENCE_UI__: JSON.stringify(Boolean(cadenceUi)), __WIKI_COMPONENTS__: JSON.stringify(Boolean(wikiComponents)) },
  resolve: {
    // One React copy: the sibling packages must use Compose's. The wiki package's bare imports would
    // otherwise resolve from the wiki checkout's own node_modules (React 18).
    dedupe: ['react', 'react-dom', '@dagrejs/dagre', 'lucide-react', 'date-fns'],
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: /^@smartmemory\/stratum-ui\/styles\.css$/, replacement: stratumUi ? stratumUi.styles : path.resolve(__dirname, './src/lib/stratum-ui-stub.css') },
      { find: /^@smartmemory\/stratum-ui$/, replacement: stratumUi ? stratumUi.entry : path.resolve(__dirname, './src/lib/stratum-ui-stub.js') },
      { find: '@cadence/ui/styles.css', replacement: cadenceUi ? path.join(cadenceUi, 'src/styles.css') : path.resolve(__dirname, './src/lib/cadence-ui-stub.css') },
      { find: /^@cadence\/ui$/, replacement: cadenceUi ? path.join(cadenceUi, 'src/index.ts') : path.resolve(__dirname, './src/lib/cadence-ui-stub.js') },
      { find: /^@wiki\/components$/, replacement: wikiComponents ? path.join(wikiComponents, 'src/index.js') : path.resolve(__dirname, './src/lib/wiki-components-stub.js') },
    ],
  },
  server: {
    // Loopback only: WIKI-FRAME-LOOSEN-1 allows exactly http://127.0.0.1:5195 as a frame origin.
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT) || 5195, // the supervisor and cockpit.sh already honour VITE_PORT
    strictPort: true,
    // Don't watch dependency, build, runtime-state or docs trees: watching them made vite the box's top fs-event producer.
    watch: { ignored: ['**/node_modules/**', '**/dist/**', '**/.compose/**', '**/docs/**'] },
    proxy: {
      '/api': 'http://127.0.0.1:4001',
      '/ops-status': 'http://127.0.0.1:4001',
      // Only proxy file-watcher and vision WS — agent connects directly to port 4002
      '/ws/files': { target: 'ws://127.0.0.1:4001', ws: true },
      '/ws/vision': { target: 'ws://127.0.0.1:4001', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Mobile app gets its own chunk so desktop never pulls it in.
          if (id.includes('/src/mobile/')) return 'mobile';
          // Cytoscape and graph stuff stays in 'graph' (desktop only)
          if (id.includes('cytoscape')) return 'graph';
          // Existing diagram libs already auto-chunked; let Vite continue handling them.
        },
      },
    },
  },
});
