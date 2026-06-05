import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Silence the expected `emitDrift` WARN that several golden fixtures trip on
    // purpose (override-vs-rollup divergence). See the setup file for rationale.
    setupFiles: ['./test/suppress-expected-drift.js'],
  },
});
