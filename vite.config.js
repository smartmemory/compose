import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Loopback only: WIKI-FRAME-LOOSEN-1 allows exactly http://127.0.0.1:5195 as a frame origin.
    host: '127.0.0.1',
    port: 5195,
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
