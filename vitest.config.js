import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
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
    include: ['test/ui/**/*.test.{js,jsx}'],
    setupFiles: ['test/ui/setup.js'],
  },
});
