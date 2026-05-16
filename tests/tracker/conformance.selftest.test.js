import { it, expect } from 'vitest';
it('conformance module exports runProviderConformance', async () => {
  const m = await import('./conformance.js');
  expect(typeof m.runProviderConformance).toBe('function');
});
