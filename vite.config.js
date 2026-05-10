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
    port: 5195,
    proxy: {
      '/api': 'http://localhost:4001',
      // Only proxy file-watcher and vision WS — agent connects directly to port 4002
      '/ws/files': { target: 'ws://localhost:4001', ws: true },
      '/ws/vision': { target: 'ws://localhost:4001', ws: true },
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
