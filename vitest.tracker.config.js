import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Owner rule: at most 4 test workers (the default is every core; 11 workers drove the load to ~30 on 2026-11-03).
    maxWorkers: 4,
    include: ['tests/**/*.test.js'],
    // Silence the expected `emitDrift` WARN that several golden fixtures trip on
    // purpose (override-vs-rollup divergence). See the setup file for rationale.
    setupFiles: ['./test/suppress-expected-drift.js'],
  },
});
